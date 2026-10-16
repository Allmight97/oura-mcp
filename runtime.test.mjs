import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

async function readWhenReady(path) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return JSON.parse(await readFile(path, "utf8")); } catch { await delay(25); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function runtime(t, { failMcp = false, missingTunnel = false, missingKey = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "oura-runtime-"));
  // The unprivileged tunnel writes only dummy fixture markers in this directory.
  await chmod(directory, 0o777);
  const bin = join(directory, "bin");
  await mkdir(bin);
  await mkdir(join(directory, "dist"));
  if (process.getuid() === 0) {
    execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'fixture-owner-token', {mode:0o600})", join(directory, "owner-credential")], { uid: 1000, gid: 1000 });
  } else {
    await writeFile(join(directory, "owner-credential"), "fixture-owner-token", { mode: 0o600 });
  }
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  for (const name of ["mcp", "tunnel"]) {
    if (name === "tunnel" && missingTunnel) continue;
    const source = `#!${process.execPath}
const fs = require("node:fs");
const path = ${JSON.stringify(directory)};
const name = ${JSON.stringify(name)};
if (name === "mcp" && process.env.FAIL_MCP === "yes") process.exit(17);
function record(suffix, value) { fs.writeFileSync(path + "/" + name + suffix, JSON.stringify(value)); }
process.on("SIGTERM", () => {
  if (name === "mcp") record(".shutdown-order", !fs.existsSync(path + "/tunnel.started") || fs.existsSync(path + "/tunnel.stopped"));
  record(".stopped", true);
  process.exit(0);
});
setInterval(() => { if (fs.existsSync(path + "/exit-" + name)) process.exit(23); }, 25);
let canReadCredential = false;
try { fs.readFileSync(path + "/owner-credential"); canReadCredential = true; } catch (error) { if (error.code !== "EACCES") throw error; }
const details = { args: process.argv.slice(2), uid: process.getuid(), canReadCredential, hasOuraSecret: Boolean(process.env.OURA_CLIENT_SECRET), hasControlKey: Boolean(process.env.CONTROL_PLANE_API_KEY), hasMcpToken: Boolean(process.env.MCP_ACCESS_TOKEN) };
if (name === "mcp") {
  require("node:http").createServer((req, res) => res.end("ready")).listen(Number(process.env.PORT), "127.0.0.1", () => record(".started", details));
} else {
  if (!fs.existsSync(path + "/mcp.started")) process.exit(19);
  record(".started", details);
}
`;
    const path = name === "mcp" ? join(directory, "dist/index.js") : join(bin, "tunnel-client");
    await writeFile(path, source);
    await chmod(path, 0o755);
  }
  const env = {
    ...process.env,
    PATH: bin,
    PORT: String(port),
    OURA_CLIENT_SECRET: "fixture-oura-secret",
    MCP_ACCESS_TOKEN: "fixture-mcp-token",
    CONTROL_PLANE_API_KEY: "fixture-control-key",
    OPENAI_TUNNEL_ID: "tunnel_fixture",
    FAIL_MCP: failMcp ? "yes" : "no"
  };
  if (missingKey) delete env.CONTROL_PLANE_API_KEY;
  const child = spawn(process.execPath, [fileURLToPath(new URL("dist/run.js", import.meta.url))], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    await rm(directory, { recursive: true });
  });
  return { child, exited, directory, output: () => output };
}

test("runtime waits for MCP readiness, separates child credentials, and stops both on SIGTERM", { timeout: 10000 }, async t => {
  const app = await runtime(t);
  const mcp = await readWhenReady(join(app.directory, "mcp.started"));
  const tunnel = await readWhenReady(join(app.directory, "tunnel.started"));
  assert.equal(mcp.hasOuraSecret, true);
  assert.equal(mcp.uid, process.getuid() === 0 ? 1000 : process.getuid());
  assert.equal(mcp.hasControlKey, false);
  assert.equal(tunnel.hasOuraSecret, false);
  assert.equal(tunnel.hasMcpToken, false);
  assert.equal(tunnel.hasControlKey, true);
  assert.equal(tunnel.uid, process.getuid() === 0 ? 10001 : process.getuid());
  assert.equal(mcp.canReadCredential, true);
  assert.equal(tunnel.canReadCredential, process.getuid() !== 0);
  assert.ok(tunnel.args.includes("tunnel_fixture"));
  app.child.kill("SIGTERM");
  assert.equal((await app.exited)[0], 0);
  assert.equal(await readWhenReady(join(app.directory, "mcp.stopped")), true);
  assert.equal(await readWhenReady(join(app.directory, "tunnel.stopped")), true);
  assert.equal(await readWhenReady(join(app.directory, "mcp.shutdown-order")), true);
});

for (const name of ["mcp", "tunnel"]) {
  test(`runtime fails and stops its sibling when ${name} exits`, { timeout: 10000 }, async t => {
    const app = await runtime(t);
    await readWhenReady(join(app.directory, "tunnel.started"));
    await writeFile(join(app.directory, "exit-" + name), "");
    assert.equal((await app.exited)[0], 1);
    assert.equal(await readWhenReady(join(app.directory, name === "mcp" ? "tunnel.stopped" : "mcp.stopped")), true);
  });
}

test("MCP startup failure does not launch the tunnel", { timeout: 10000 }, async t => {
  const app = await runtime(t, { failMcp: true });
  assert.equal((await app.exited)[0], 1);
  await assert.rejects(readFile(join(app.directory, "tunnel.started")), { code: "ENOENT" });
});

test("a missing tunnel executable stops the MCP server", { timeout: 10000 }, async t => {
  const app = await runtime(t, { missingTunnel: true });
  assert.equal((await app.exited)[0], 1);
  assert.equal(await readWhenReady(join(app.directory, "mcp.stopped")), true);
});

test("missing tunnel credentials fail before either child starts", { timeout: 10000 }, async t => {
  const app = await runtime(t, { missingKey: true });
  assert.equal((await app.exited)[0], 1);
  assert.match(app.output(), /CONTROL_PLANE_API_KEY is required/);
  await assert.rejects(readFile(join(app.directory, "mcp.started")), { code: "ENOENT" });
});
