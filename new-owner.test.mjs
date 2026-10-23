import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("scripts/new-owner.sh", import.meta.url).pathname;
const onboard = new URL("scripts/onboard.sh", import.meta.url).pathname;
const dockerCompose = spawnSync("docker", ["compose", "version"]).status === 0;

async function readEnv(directory) {
  return Object.fromEntries((await readFile(join(directory, ".env"), "utf8")).split("\n").filter(line => /^[A-Z_]+=/.test(line)).map(line => line.split(/=(.*)/s).slice(0, 2)));
}

test("two owners get separate projects, ports and secrets, and nothing is overwritten", async t => {
  const parent = await mkdtemp(join(tmpdir(), "oura-owners-"));
  t.after(() => rm(parent, { recursive: true }));
  const first = join(parent, "Owner One");
  const second = join(parent, "owner-two");
  execFileSync(script, [first, "8790"]);
  execFileSync(script, [second, "8791"]);
  const [one, two] = [await readEnv(first), await readEnv(second)];

  assert.equal(one.COMPOSE_PROJECT_NAME, "oura-owner-one");
  assert.equal(two.COMPOSE_PROJECT_NAME, "oura-owner-two");
  assert.deepEqual([one.HOST_PORT, two.HOST_PORT], ["8790", "8791"]);
  for (const name of ["SETUP_KEY", "MCP_ACCESS_TOKEN"]) {
    assert.match(one[name], /^[0-9a-f]{64}$/);
    assert.notEqual(one[name], two[name]);
  }
  assert.notEqual(one.SETUP_KEY, one.MCP_ACCESS_TOKEN);
  assert.equal(one.OURA_REDIRECT_URI, "", "per-owner addresses must be filled in, not inherited from the example");
  assert.equal(one.MCP_PUBLIC_HOSTNAME, "");
  assert.equal((await stat(join(first, ".env"))).mode & 0o777, 0o600);
  assert.equal((await stat(first)).mode & 0o777, 0o700);

  const before = await readFile(join(first, ".env"), "utf8");
  assert.notEqual(spawnSync(script, [first, "8792"]).status, 0);
  assert.equal(await readFile(join(first, ".env"), "utf8"), before);
  for (const port of ["80", "70000", "eighty"]) assert.notEqual(spawnSync(script, [join(parent, `bad-${port}`), port]).status, 0);

  if (!dockerCompose) return t.diagnostic("docker compose unavailable; Compose rendering not checked");
  for (const [directory, port, project] of [[first, "8790", "oura-owner-one"], [second, "8791", "oura-owner-two"]]) {
    const env = { ...process.env, OURA_CLIENT_ID: "x", OURA_CLIENT_SECRET: "x", OURA_REDIRECT_URI: "https://x.example/cb", MCP_PUBLIC_HOSTNAME: "x.example" };
    const config = JSON.parse(execFileSync("docker", ["compose", "--project-directory", directory, "config", "--format", "json"], { env, encoding: "utf8" }));
    assert.equal(config.name, project);
    assert.equal(config.services["oura-mcp"].ports[0].published, port);
    assert.equal(config.volumes["oura-credential"].name, `${project}_oura-credential`);
  }
});

test("answers from the guided setup land in the new owner's private .env", async t => {
  const parent = await mkdtemp(join(tmpdir(), "oura-owner-"));
  t.after(() => rm(parent, { recursive: true }));
  const directory = join(parent, "kb");
  const answers = { MCP_PUBLIC_HOSTNAME: "oura-kb.example.com", OURA_CLIENT_ID: "client-id", OURA_CLIENT_SECRET: "client-secret", OPENAI_TUNNEL_ID: "tunnel_kb", CONTROL_PLANE_API_KEY: "runtime-key" };
  execFileSync(script, [directory, "8788"], { env: { ...process.env, ...answers } });
  const env = await readEnv(directory);
  for (const [name, value] of Object.entries(answers)) assert.equal(env[name], value);
  assert.equal(env.OURA_REDIRECT_URI, "https://oura-kb.example.com/oauth/oura/callback");
  assert.notEqual(spawnSync(script, [join(parent, "bad"), "8789"], { env: { ...process.env, OURA_CLIENT_SECRET: "two\nlines" } }).status, 0);
});

test("the guided setup refuses to run without a person at a terminal", () => {
  const result = spawnSync(onboard, [], { input: "kb\n", encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Run this in a terminal/);
});
