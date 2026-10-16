import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

async function startServer(t, settings) {
  const directory = await mkdtemp(join(tmpdir(), "oura-auth-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = { ...process.env, OURA_CLIENT_ID: "test", OURA_CLIENT_SECRET: "test", OURA_REDIRECT_URI: "https://public.example/oauth/oura/callback", SETUP_KEY: "test", OURA_CREDENTIAL_FILE: join(directory, "credential.json"), PORT: String(port), ...settings };
  if (settings.MCP_ACCESS_TOKEN === undefined) delete env.MCP_ACCESS_TOKEN;
  const child = spawn(process.execPath, ["dist/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "exit");
  let output = "";
  child.stdout.on("data", b => { output += b; });
  child.stderr.on("data", b => { output += b; });
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed; await rm(directory, {recursive:true}); });
  await Promise.race([once(child.stdout, "data"), closed.then(() => { throw new Error(output); })]);
  async function request(host, token, origin, message = {jsonrpc:"2.0",id:1,method:"tools/list",params:{}}) {
    const headers = { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (origin) headers.Origin = origin;
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
  return {request, output: () => output, stop: () => child.kill("SIGTERM"), exited: closed};
}

for (const token of [undefined, ""]) {
  test(`public hostname stays closed with ${token === undefined ? "unset" : "empty"} token`, async t => {
    const server = await startServer(t, {MCP_PUBLIC_HOSTNAME:"public.example",MCP_ACCESS_TOKEN:token});
    assert.equal((await server.request("public.example")).status, 403);
    assert.equal((await server.request("oura-mcp")).status, 200);
  });
}

test("nonempty short tokens refuse startup", async t => {
  await assert.rejects(startServer(t, {MCP_PUBLIC_HOSTNAME:"public.example",MCP_ACCESS_TOKEN:"too-short"}), /MCP_ACCESS_TOKEN must be at least 32 characters/);
});

test("public access requires bearer, while tunnel keeps access", async t => {
  const token = "a".repeat(64);
  const server = await startServer(t, {MCP_PUBLIC_HOSTNAME:"public.example",MCP_ACCESS_TOKEN:token});
  assert.equal((await server.request("public.example")).status, 401);
  assert.equal((await server.request("public.example", "wrong")).status, 401);
  const accepted = await server.request("public.example", token);
  assert.equal(accepted.status, 200);
  const body = await accepted.text();
  const result = JSON.parse(body.startsWith("event:") ? body.split("\n").find(line => line.startsWith("data: ")).slice(6) : body);
  assert.deepEqual(result.result.tools.map(x => x.name).sort(), ["oura_catalog","oura_query"]);
  assert.equal((await server.request("oura-mcp")).status, 200);
  assert.equal((await server.request("unknown.example", token)).status, 403);
  assert.equal((await server.request("public.example", token, "https://unknown.example")).status, 403);
  assert.equal(server.output().includes(token), false);
});

test("shutdown lets an in-flight refresh persist its replacement token", async t => {
  const directory = await mkdtemp(join(tmpdir(), "oura-refresh-"));
  t.after(() => rm(directory, { recursive: true }));
  const credentialFile = join(directory, "credential.json");
  const marker = join(directory, "refresh-started");
  const preload = join(directory, "upstream.mjs");
  await writeFile(credentialFile, JSON.stringify({ token: { access_token: "expired", refresh_token: "previous-refresh", expires_at: 0 } }));
  await writeFile(preload, `
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
globalThis.fetch = async url => {
  if (String(url) === "https://api.ouraring.com/oauth/token") {
    await writeFile(${JSON.stringify(marker)}, "started");
    await delay(250);
    return Response.json({ access_token: "replacement-access", refresh_token: "replacement-refresh", expires_in: 3600 });
  }
  if (String(url).startsWith("https://api.ouraring.com/v2/usercollection/")) return Response.json({ data: [] });
  throw new Error("Unexpected upstream URL");
};
`);
  const server = await startServer(t, { OURA_CREDENTIAL_FILE: credentialFile, NODE_OPTIONS: `--import=${preload}` });
  const response = server.request("oura-mcp", undefined, undefined, {
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
});
