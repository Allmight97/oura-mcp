import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const setupKey = "s".repeat(32);

async function startServer(t, settings) {
  const directory = await mkdtemp(join(tmpdir(), "oura-auth-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = { ...process.env, OURA_CLIENT_ID: "test", OURA_CLIENT_SECRET: "test", OURA_REDIRECT_URI: "https://public.example/oauth/oura/callback", SETUP_KEY: setupKey, OURA_CREDENTIAL_FILE: join(directory, "credential.json"), PORT: String(port), ...settings };
  for (const name of ["MCP_ACCESS_TOKEN", "OPENAI_TUNNEL_ID"]) if (settings[name] === undefined) delete env[name];
  const child = spawn(process.execPath, ["dist/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "exit");
  let output = "";
  child.stdout.on("data", b => { output += b; });
  child.stderr.on("data", b => { output += b; });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await Promise.race([closed, delay(5000).then(() => child.kill("SIGKILL"))]);
    await closed;
    await rm(directory, {recursive:true});
  });
  await Promise.race([once(child.stdout, "data"), closed.then(() => { throw new Error(output); })]);
  async function request(host, token, origin, message = {jsonrpc:"2.0",id:1,method:"tools/list",params:{}}, extraHeaders = {}) {
    const headers = { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (origin) headers.Origin = origin;
    Object.assign(headers, extraHeaders);
    return new Promise((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers }, response => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { body += chunk; });
        response.on("end", () => resolve({status:response.statusCode,text:async () => body}));
      });
      request.on("error", reject);
      request.end(JSON.stringify(message));
    });
  }
  async function callTool(name, args = {}) {
    const response = await request("localhost", undefined, undefined, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    assert.equal(response.status, 200);
    return parse(await response.text()).result;
  }
  async function authorizationState() {
    const response = await fetch(`http://127.0.0.1:${port}/admin/oura/authorize`, { method: "POST", headers: { "X-Setup-Key": setupKey } });
    assert.equal(response.status, 200);
    return new URL((await response.json()).authorization_url).searchParams.get("state");
  }
  const callback = (code, state, extra = "") => fetch(`http://127.0.0.1:${port}/oauth/oura/callback?code=${code}&state=${state}${extra}`);
  return {request, callTool, authorizationState, callback, output: () => output, stop: () => child.kill("SIGTERM"), exited: closed};
}

function parse(body) {
  return JSON.parse(body.startsWith("event:") ? body.split("\n").find(line => line.startsWith("data: ")).slice(6) : body);
}

// Replaces fetch in the server process; `handler` is the source of an async function from a recorded call and the fetch init to a Response.
async function stubOura(directory, handler, { shortDeadlines = false } = {}) {
  const log = join(directory, "upstream-calls.jsonl");
  const preload = join(directory, "upstream.mjs");
  await writeFile(preload, `
import { appendFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const handle = ${handler};
${shortDeadlines ? "const timeout = AbortSignal.timeout.bind(AbortSignal); AbortSignal.timeout = () => timeout(100);" : ""}
globalThis.fetch = async (url, init = {}) => {
  const call = { url: String(url), authorization: init.headers?.authorization ?? null, form: init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null };
  await appendFile(${JSON.stringify(log)}, JSON.stringify(call) + "\\n");
  return handle(call, init);
};
`);
  return {
    NODE_OPTIONS: `--import=${preload}`,
    calls: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line))
  };
}

for (const token of [undefined, ""]) {
  test(`public hostname stays closed with ${token === undefined ? "unset" : "empty"} token`, async t => {
    const server = await startServer(t, {MCP_PUBLIC_HOSTNAME:"public.example",MCP_ACCESS_TOKEN:token});
    assert.equal((await server.request("public.example")).status, 403);
    assert.equal((await server.request("oura-mcp")).status, 403);
    assert.equal((await server.request("localhost")).status, 200);
  });
}

for (const name of ["MCP_ACCESS_TOKEN", "SETUP_KEY"]) {
  test(`nonempty short ${name} refuses startup`, async t => {
    await assert.rejects(startServer(t, {MCP_PUBLIC_HOSTNAME:"public.example",[name]:"too-short"}), new RegExp(`${name} must be at least 32 characters`));
  });
}

test("public access requires bearer, while tunnel mode keeps tunnel access", async t => {
  const token = "a".repeat(64);
  const server = await startServer(t, {MCP_PUBLIC_HOSTNAME:"public.example",MCP_ACCESS_TOKEN:token,OPENAI_TUNNEL_ID:"tunnel_fixture"});
  assert.equal((await server.request("public.example")).status, 401);
  assert.equal((await server.request("public.example", "wrong")).status, 401);
  const accepted = await server.request("public.example", token);
  assert.equal(accepted.status, 200);
  const result = parse(await accepted.text());
  assert.deepEqual(result.result.tools.map(x => x.name).sort(), ["oura_catalog","oura_query"]);
  assert.equal((await server.request("oura-mcp")).status, 200);
  assert.equal((await server.request("unknown.example", token)).status, 403);
  assert.equal((await server.request("public.example", token, "https://unknown.example")).status, 403);
  assert.equal(server.output().includes(token), false);
});

test("without tunnel mode the tunnel hostname needs the bearer like any other host", async t => {
  const token = "a".repeat(64);
  const server = await startServer(t, {MCP_PUBLIC_HOSTNAME:"public.example",MCP_ACCESS_TOKEN:token});
  assert.equal((await server.request("oura-mcp:8787")).status, 403);
  assert.equal((await server.request("localhost")).status, 401);
  assert.equal((await server.request("localhost", token)).status, 200);
});

test("MCP rejects oversized bodies and excessive argument elements without breaking normal calls", async t => {
  const token = "a".repeat(64);
  const server = await startServer(t, { MCP_PUBLIC_HOSTNAME: "public.example", MCP_ACCESS_TOKEN: token });
  const oversized = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {}, padding: "x".repeat(65536) };
  assert.equal((await server.request("public.example", undefined, undefined, oversized)).status, 401);
  for (const headers of [
    { "Content-Length": String(Buffer.byteLength(JSON.stringify(oversized))) },
    { "Transfer-Encoding": "chunked" },
    { "Content-Length": String(Buffer.byteLength(JSON.stringify(oversized))), "MCP-Protocol-Version": "2026-07-28" },
    { "Transfer-Encoding": "chunked", "MCP-Protocol-Version": "2026-07-28" }
  ]) {
    assert.equal((await server.request("public.example", token, undefined, oversized, headers)).status, 413);
  }
  for (const args of [Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`key${i}`, i])), { nested: Array(65).fill(0) }]) {
    const response = await server.request("public.example", token, undefined, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "oura_catalog", arguments: args } });
    assert.equal(response.status, 200);
    assert.equal(parse(await response.text()).result.isError, true);
  }
  const accepted = await server.request("public.example", token);
  assert.equal(accepted.status, 200);
  assert.deepEqual(parse(await accepted.text()).result.tools.map(tool => tool.name).sort(), ["oura_catalog", "oura_query"]);
});

test("a query maps bounds and cursor, retries once after 401 with a refreshed token, and returns Oura data unchanged", async t => {
  const directory = await mkdtemp(join(tmpdir(), "oura-query-"));
  t.after(() => rm(directory, { recursive: true }));
  const credentialFile = join(directory, "credential.json");
  await writeFile(credentialFile, JSON.stringify({ token: { access_token: "revoked-access", refresh_token: "previous-refresh", expires_at: 4102444800 } }));
  const upstream = await stubOura(directory, `async call => {
    if (call.url === "https://api.ouraring.com/oauth/token") return Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 });
    if (call.authorization !== "Bearer fresh-access") return new Response("expired", { status: 401 });
    return Response.json({ data: [{ id: "night-1", score: 81 }], next_token: "page-2" });
  }`);
  const server = await startServer(t, { OURA_CREDENTIAL_FILE: credentialFile, NODE_OPTIONS: upstream.NODE_OPTIONS });

  const result = await server.callTool("oura_query", { collection: "daily_sleep", start: "2026-10-14", end: "2026-10-15", cursor: "page-1" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.oura_response, { data: [{ id: "night-1", score: 81 }], next_token: "page-2" });
  assert.equal(result.structuredContent.next_cursor, "page-2");
  const [rejected, refresh, retried] = await upstream.calls();
  assert.equal(rejected.authorization, "Bearer revoked-access");
  assert.equal(refresh.form.grant_type, "refresh_token");
  assert.equal(refresh.form.refresh_token, "previous-refresh");
  const query = new URL(retried.url);
  assert.equal(query.pathname, "/v2/usercollection/daily_sleep");
  assert.deepEqual(Object.fromEntries(query.searchParams), { start_date: "2026-10-14", end_date: "2026-10-15", next_token: "page-1" });
  assert.equal(retried.authorization, "Bearer fresh-access");
  assert.equal(JSON.parse(await readFile(credentialFile, "utf8")).token.refresh_token, "fresh-refresh");

  await server.callTool("oura_query", { collection: "heartrate", latest: true });
  const latest = new URL((await upstream.calls()).at(-1).url);
  assert.deepEqual(Object.fromEntries(latest.searchParams), { latest: "true" });

  const before = (await upstream.calls()).length;
  for (const args of [
    { collection: "daily_sleep", start: "2026-02-30", end: "2026-03-05" },
    { collection: "daily_sleep", start: "2026-03-01Z", end: "2026-03-02" },
    { collection: "heartrate", start: "2026-10-14T00:00:00", end: "2026-10-14T06:00:00Z" }
  ]) {
    assert.equal((await server.callTool("oura_query", args)).isError, true, JSON.stringify(args));
  }
  assert.equal((await upstream.calls()).length, before, "invalid bounds must not reach Oura");
});

test("a stalled Oura collection request fails at its deadline", { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "oura-stall-"));
  t.after(() => rm(directory, { recursive: true }));
  const credentialFile = join(directory, "credential.json");
  await writeFile(credentialFile, JSON.stringify({ token: { access_token: "valid-access", refresh_token: "valid-refresh", expires_at: 4102444800 } }));
  const upstream = await stubOura(directory, `(call, init) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason)))`, { shortDeadlines: true });
  const server = await startServer(t, { OURA_CREDENTIAL_FILE: credentialFile, NODE_OPTIONS: upstream.NODE_OPTIONS });
  const result = await server.callTool("oura_query", { collection: "daily_sleep", start: "2026-10-14", end: "2026-10-15" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /timeout/i);
});

test("a forged callback leaves the owner's pending authorization usable", async t => {
  const directory = await mkdtemp(join(tmpdir(), "oura-callback-"));
  t.after(() => rm(directory, { recursive: true }));
  const upstream = await stubOura(directory, `async () => Response.json({ access_token: "owner-access", refresh_token: "owner-refresh", expires_in: 3600 })`);
  const server = await startServer(t, { OURA_CREDENTIAL_FILE: join(directory, "credential.json"), NODE_OPTIONS: upstream.NODE_OPTIONS });
  const state = await server.authorizationState();
  assert.equal((await server.callback("forged", "wrong-state")).status, 400);
  assert.equal((await server.callback("owner-code", state, "&scope=daily%20personal")).status, 200);
  assert.equal((await server.callback("owner-code", state)).status, 400, "state is single-use");
  assert.equal((await upstream.calls()).filter(call => call.form?.code).map(call => call.form.code).join(), "owner-code");
  const catalog = (await server.callTool("oura_catalog")).structuredContent;
  assert.equal(catalog.oura_authorized, true);
  assert.equal(catalog.granted_scopes, null, "the deprecated callback scope is not evidence of a grant");
});

test("a refresh that finishes after a new authorization keeps the new grant", async t => {
  const directory = await mkdtemp(join(tmpdir(), "oura-reauthorize-"));
  t.after(() => rm(directory, { recursive: true }));
  const credentialFile = join(directory, "credential.json");
  const marker = join(directory, "refresh-started");
  await writeFile(credentialFile, JSON.stringify({ token: { access_token: "old-access", refresh_token: "old-refresh", expires_at: 0 } }));
  const upstream = await stubOura(directory, `async call => {
    if (call.form?.grant_type === "refresh_token") {
      await writeFile(${JSON.stringify(marker)}, "started");
      await delay(400);
      return Response.json({ access_token: "old-grant-access", refresh_token: "old-grant-refresh", expires_in: 3600 });
    }
    if (call.form?.grant_type === "authorization_code") return Response.json({ access_token: "new-access", refresh_token: "new-grant-refresh", expires_in: 3600 });
    return Response.json({ data: [] });
  }`);
  const server = await startServer(t, { OURA_CREDENTIAL_FILE: credentialFile, NODE_OPTIONS: upstream.NODE_OPTIONS });
  const query = server.callTool("oura_query", { collection: "daily_sleep", start: "2026-10-14", end: "2026-10-15" });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(marker); break; } catch { await delay(10); }
  }
  assert.equal((await server.callback("new-code", await server.authorizationState())).status, 200);
  await query;
  assert.equal(JSON.parse(await readFile(credentialFile, "utf8")).token.refresh_token, "new-grant-refresh");
});

test("shutdown lets an in-flight refresh persist its replacement token", async t => {
  const directory = await mkdtemp(join(tmpdir(), "oura-refresh-"));
  t.after(() => rm(directory, { recursive: true }));
  const credentialFile = join(directory, "credential.json");
  const marker = join(directory, "refresh-started");
  await writeFile(credentialFile, JSON.stringify({ token: { access_token: "expired", refresh_token: "previous-refresh", expires_at: 0 } }));
  const upstream = await stubOura(directory, `async call => {
    if (call.url === "https://api.ouraring.com/oauth/token") {
      await writeFile(${JSON.stringify(marker)}, "started");
      await delay(250);
      return Response.json({ access_token: "replacement-access", refresh_token: "replacement-refresh", expires_in: 3600 });
    }
    return Response.json({ data: [] });
  }`);
  const server = await startServer(t, { OURA_CREDENTIAL_FILE: credentialFile, NODE_OPTIONS: upstream.NODE_OPTIONS });
  const response = server.request("localhost", undefined, undefined, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "oura_query", arguments: { collection: "daily_sleep", start: "2026-10-14", end: "2026-10-15" } }
  }).catch(error => ({ status: 0, error: error.message }));
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(marker); started = true; break; } catch { await delay(10); }
  }
  assert.equal(started, true, "the query must have begun refreshing before SIGTERM");
  server.stop();
  assert.equal((await response).status, 200);
  assert.equal((await server.exited)[0], 0);
  assert.equal(JSON.parse(await readFile(credentialFile, "utf8")).token.refresh_token, "replacement-refresh");
  assert.equal((await stat(credentialFile)).mode & 0o777, 0o600);
});
