import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const image = process.argv[2];
assert.ok(image, "Pass the image to verify");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const inspected = JSON.parse(docker("image", "inspect", image))[0];
assert.equal(inspected.Config.User, "node", "Default image must run non-root");
assert.ok(!inspected.Config.Env.some(v => /^(OURA_|MCP_|SETUP_KEY|CONTROL_PLANE_API_KEY|OPENAI_TUNNEL_ID)/.test(v)));
const files = docker("run", "--rm", "--entrypoint", "sh", image, "-c", "find /app -maxdepth 2 -type f; ls -A /data");
assert.ok(!files.includes(".env") && !files.includes("credential.json"));
assert.ok(!files.includes("test.mjs") && !files.includes("DESIGN.md"));
const token = "synthetic-image-smoke-".padEnd(64, "x");
const id = docker("run", "-d", "--rm", "--init", "--read-only", "--cap-drop=ALL",
  "--security-opt=no-new-privileges:true", "--tmpfs", "/tmp", "-p", "127.0.0.1::8787",
  "-e", "OURA_CLIENT_ID=synthetic", "-e", "OURA_CLIENT_SECRET=synthetic",
  "-e", "OURA_REDIRECT_URI=https://public.example/oauth/oura/callback",
  "-e", "SETUP_KEY=synthetic", "-e", "MCP_PUBLIC_HOSTNAME=public.example",
  "-e", `MCP_ACCESS_TOKEN=${token}`, image);
try {
  const port = docker("port", id, "8787/tcp").split(":").at(-1);
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(`${url}/healthz`)).ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, "Image listener must start");
  function request(path, headers, body) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(`${url}${path}`, { method: "POST", headers }, response => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { text += chunk; });
        response.on("end", () => resolve(new Response(text, { status: response.statusCode })));
      });
      req.on("error", reject);
      req.end(body);
    });
  }
  async function call(host, credential, method, params = {}) {
    const headers = { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (credential) headers.Authorization = `Bearer ${credential}`;
    const response = await request("/mcp", headers, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    let body = await response.text();
    if (body.startsWith("event:")) body = body.split("\n").find(line => line.startsWith("data: ")).slice(6);
    return { status: response.status, body: JSON.parse(body) };
  }
  assert.equal((await call("public.example", undefined, "tools/list")).status, 401);
  assert.equal((await call("public.example", "wrong", "tools/list")).status, 401);
  const rejectedHost = await request("/mcp", { Host: "untrusted.example" }, "{}");
  assert.equal(rejectedHost.status, 403);
  const listed = await call("public.example", token, "tools/list");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.result.tools.map(t => t.name).sort(), ["oura_catalog", "oura_query"]);
  const catalog = await call("public.example", token, "tools/call", { name: "oura_catalog", arguments: {} });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.result.structuredContent.oura_authorized, false);
  const setup = await fetch(`${url}/admin/oura/authorize`, { method: "POST", headers: { "X-Setup-Key": "synthetic" } });
  assert.equal(setup.status, 200, "Non-root app must persist authorization state");
  const grant = JSON.parse(docker("exec", id, "node", "-e", "const fs=require('node:fs');const p='/data/oura-credential.json';const s=fs.statSync(p);console.log(JSON.stringify({mode:s.mode&511,uid:s.uid,paired:Boolean(JSON.parse(fs.readFileSync(p)).token)}))"));
  assert.deepEqual(grant, { mode: 0o600, uid: 1000, paired: false });
  const output = docker("logs", id);
  assert.ok(!output.includes(token));
  console.log("Image starts non-root with an empty grant volume; private state persistence, authentication and both tools verified with synthetic configuration.");
} finally {
  docker("stop", "--time", "10", id);
}
