import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import {
  catalogPayload,
  collectionNames,
  collectionSpec,
  type CollectionSpec
} from "./catalog.js";

type OuraToken = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope?: string;
  [key: string]: unknown;
};

type StoredCredential = {
  oauth_state?: { state: string; issued_at: number };
  token?: OuraToken;
};

type Query = {
  collection: string;
  start?: string;
  end?: string;
  cursor?: string;
  latest?: boolean;
};

const config = {
  clientId: requiredEnv("OURA_CLIENT_ID"),
  clientSecret: requiredEnv("OURA_CLIENT_SECRET"),
  redirectUri: requiredEnv("OURA_REDIRECT_URI"),
  setupKey: requiredEnv("SETUP_KEY"),
  mcpAccessToken: optionalSecret("MCP_ACCESS_TOKEN"),
  mcpPublicHostname: process.env.MCP_PUBLIC_HOSTNAME,
  credentialFile: process.env.OURA_CREDENTIAL_FILE ?? "/data/oura-credential.json",
  port: Number(process.env.PORT ?? "8787")
};

process.umask(0o077);

class OuraCredential {
  private refreshInFlight?: Promise<OuraToken>;

  async catalog(): Promise<Record<string, unknown>> {
    const stored = await this.read();
    return {
      ...catalogPayload(),
      oura_authorized: Boolean(stored.token),
      granted_scopes: stored.token?.scope?.split(/\s+/).filter(Boolean) ?? []
    };
  }

  async authorizationUrl(): Promise<string> {
    const stored = await this.read();
    const state = randomUUID();
    stored.oauth_state = { state, issued_at: Date.now() };
    await this.write(stored);

    const url = new URL("https://cloud.ouraring.com/oauth/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      state
    }).toString();
    return url.toString();
  }

  async completeAuthorization(code: string, state: string, grantedScope?: string): Promise<void> {
    const stored = await this.read();
    const saved = stored.oauth_state;
    delete stored.oauth_state;
    if (!saved || saved.state !== state || Date.now() - saved.issued_at > 10 * 60 * 1000) {
      await this.write(stored);
      throw new Error("Oura authorization state is invalid or expired.");
    }

    const token = await this.exchangeToken({
      grant_type: "authorization_code",
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri
    });
    if (grantedScope) token.scope = grantedScope;
    stored.token = token;
    await this.write(stored);
  }

  async query(input: Query): Promise<Record<string, unknown>> {
    const spec = collectionSpec(input.collection);
    validateQuery(spec, input);
    let accessToken = await this.accessToken();
    let response = await this.fetchCollection(spec, input, accessToken);
    if (response.status === 401) {
      accessToken = await this.accessToken(true);
      response = await this.fetchCollection(spec, input, accessToken);
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Oura ${response.status} for ${spec.name}: ${detail.slice(0, 300)}`);
    }

    const body = (await response.json()) as Record<string, unknown>;
    return {
      collection: spec.name,
      provenance: {
        provider: "oura",
        api_version: "v2",
        endpoint: `/v2/usercollection/${spec.path}`,
        retrieved_at: new Date().toISOString()
      },
      request: input,
      next_cursor: body.next_token ?? null,
      oura_response: body
    };
  }

  private async accessToken(forceRefresh = false): Promise<string> {
    const stored = await this.read();
    if (!stored.token) throw new Error("Oura is not authorized yet.");
    if (!forceRefresh && stored.token.expires_at > Date.now() / 1000 + 60) {
      return stored.token.access_token;
    }

    this.refreshInFlight ??= this.refresh(stored.token).finally(() => {
      this.refreshInFlight = undefined;
    });
    return (await this.refreshInFlight).access_token;
  }

  private async refresh(previous: OuraToken): Promise<OuraToken> {
    const token = await this.exchangeToken(
      {
        grant_type: "refresh_token",
        refresh_token: previous.refresh_token,
        client_id: config.clientId,
        client_secret: config.clientSecret
      },
      previous.refresh_token
    );
    const stored = await this.read();
    stored.token = token;
    await this.write(stored);
    return token;
  }

  private async exchangeToken(
    values: Record<string, string>,
    priorRefreshToken?: string
  ): Promise<OuraToken> {
    const response = await fetch("https://api.ouraring.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values)
    });
    if (!response.ok) throw new Error(`Oura token exchange failed with ${response.status}.`);

    const raw = (await response.json()) as Record<string, unknown>;
    const accessToken = raw.access_token;
    const refreshToken = raw.refresh_token ?? priorRefreshToken;
    const expiresIn = raw.expires_in;
    if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresIn !== "number") {
      throw new Error("Oura returned an invalid token response.");
    }
    return {
      ...raw,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn
    };
  }

  private fetchCollection(spec: CollectionSpec, input: Query, accessToken: string) {
    const url = new URL(`https://api.ouraring.com/v2/usercollection/${spec.path}`);
    if (spec.rangeKind === "date") {
      url.searchParams.set("start_date", input.start!);
      url.searchParams.set("end_date", input.end!);
    } else if (spec.rangeKind === "datetime" && !input.latest) {
      url.searchParams.set("start_datetime", input.start!);
      url.searchParams.set("end_datetime", input.end!);
    }
    if (input.cursor) url.searchParams.set("next_token", input.cursor);
    if (input.latest) url.searchParams.set("latest", "true");
    return fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  }

  private async read(): Promise<StoredCredential> {
    try {
      return JSON.parse(await readFile(config.credentialFile, "utf8")) as StoredCredential;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async write(value: StoredCredential): Promise<void> {
    await mkdir(dirname(config.credentialFile), { recursive: true, mode: 0o700 });
    const temporary = `${config.credentialFile}.new`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, config.credentialFile);
  }
}

const credential = new OuraCredential();

function createMcpServer() {
  const server = new McpServer({ name: "oura-private-data", version: "1.1.0" });

  server.registerTool(
    "oura_catalog",
    {
      description: "List every mapped Oura API v2 collection and its native query shape.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => toolResult(await credential.catalog())
  );

  server.registerTool(
    "oura_query",
    {
      description: "Retrieve live Oura API v2 data without summarizing or interpreting it.",
      inputSchema: {
        collection: z.enum(collectionNames),
        start: z.string().optional(),
        end: z.string().optional(),
        cursor: z.string().optional(),
        latest: z.boolean().optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (input) => toolResult(await credential.query(input))
  );

  return server;
}

const mcpHandler = toNodeHandler(
  createMcpHandler(() => createMcpServer(), {
    legacy: "stateless",
    responseMode: "json"
  })
);
const TUNNEL_HOSTNAME = "oura-mcp";
const validateMcpHost = hostHeaderValidation(
  [TUNNEL_HOSTNAME, "localhost", "127.0.0.1", config.mcpAccessToken ? config.mcpPublicHostname : undefined].filter(
    (value): value is string => Boolean(value)
  )
);
const validateMcpOrigin = originValidation([
  "localhost",
  "127.0.0.1",
  "chatgpt.com",
  "chat.openai.com"
]);

const server = createHttpServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz" && request.method === "GET") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname === "/admin/oura/authorize" && request.method === "POST") {
      if (!setupKeyMatches(request)) {
        sendJson(response, 403, { error: "Forbidden" });
        return;
      }
      sendJson(response, 200, { authorization_url: await credential.authorizationUrl() });
      return;
    }

    if (url.pathname === "/oauth/oura/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        sendText(response, 400, "Oura authorization was not completed.");
        return;
      }
      await credential.completeAuthorization(code, state, url.searchParams.get("scope") ?? undefined);
      sendText(response, 200, "Oura authorization complete. You may close this tab.");
      return;
    }

    if (url.pathname === "/mcp") {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        sendText(response, 405, "Method Not Allowed");
        return;
      }
      if (!validateMcpHost(request, response) || !validateMcpOrigin(request, response)) return;
      if (!accessTokenMatches(request)) {
        response.setHeader("www-authenticate", "Bearer");
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      await mcpHandler(request, response);
      return;
    }

    sendText(response, 404, "Not Found");
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendJson(response, 500, { error: "Internal Server Error" });
    else response.end();
  }
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`Oura MCP listening on port ${config.port}`);
});

// Let active Oura requests persist rotating credentials before the process exits.
process.once("SIGTERM", () => server.close());
process.once("SIGINT", () => server.close());

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function validateQuery(spec: CollectionSpec, input: Query) {
  if (input.cursor && !spec.supportsCursor) throw new Error(`${spec.name} does not accept a cursor.`);
  if (input.latest && !spec.supportsLatest) throw new Error(`${spec.name} does not accept latest=true.`);
  if (input.latest && (input.start || input.end)) throw new Error("latest cannot be combined with bounds.");
  if (spec.rangeKind === "none") {
    if (input.start || input.end || input.latest) throw new Error(`${spec.name} does not accept bounds.`);
    return;
  }
  if (input.latest) return;
  if (!input.start || !input.end) throw new Error(`${spec.name} requires start and end.`);
  const start = parseBoundary(input.start, spec.rangeKind);
  const end = parseBoundary(input.end, spec.rangeKind);
  if (start > end) throw new Error("start must not be after end.");
}

function parseBoundary(value: string, kind: "date" | "datetime") {
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const hasTimezone = /(Z|[+-]\d{2}:\d{2})$/.test(value);
  if (kind === "date" && !isDate && !hasTimezone) {
    throw new Error("Date bounds must use YYYY-MM-DD or an RFC 3339 timestamp.");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Invalid date or datetime bound.");
  if (kind === "datetime" && !hasTimezone) {
    throw new Error("Datetime bounds require a timezone.");
  }
  return parsed;
}

function setupKeyMatches(request: IncomingMessage) {
  const supplied = request.headers["x-setup-key"];
  const value = Array.isArray(supplied) ? supplied[0] : (supplied ?? "");
  return secretMatches(value, config.setupKey);
}

// The tunnel client reaches the container by its service name and is already
// authenticated by OpenAI. Every other host needs the bearer token once one is set.
function accessTokenMatches(request: IncomingMessage) {
  if (!config.mcpAccessToken) return true;
  const hostname = (request.headers.host ?? "").split(":")[0];
  if (hostname === TUNNEL_HOSTNAME) return true;
  const supplied = request.headers.authorization ?? "";
  const token = supplied.startsWith("Bearer ") ? supplied.slice("Bearer ".length) : "";
  return secretMatches(token, config.mcpAccessToken);
}

function secretMatches(supplied: string, expected: string) {
  const left = createHash("sha256").update(supplied).digest();
  const right = createHash("sha256").update(expected).digest();
  return supplied.length > 0 && timingSafeEqual(left, right);
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sendText(response: ServerResponse, status: number, value: string) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(value);
}

function optionalSecret(name: string) {
  const value = process.env[name];
  if (value && value.length < 32) throw new Error(`${name} must be at least 32 characters.`);
  return value || undefined;
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
