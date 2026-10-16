import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const { CONTROL_PLANE_API_KEY, OPENAI_TUNNEL_ID, ...mcpEnvironment } = process.env;
for (const [name, value] of Object.entries({ CONTROL_PLANE_API_KEY, OPENAI_TUNNEL_ID })) {
  if (!value) throw new Error(`${name} is required.`);
}

const children: ChildProcess[] = [];
let stopping = false;

function stop(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  void (async () => {
    for (const child of [...children].reverse()) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.kill("SIGTERM");
      await closed;
    }
  })();
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 30000).unref();
}

function start(name: string, command: string, args: string[], env: NodeJS.ProcessEnv, uid?: number) {
  const child = spawn(command, args, { env, uid, gid: uid, stdio: "inherit" });
  children.push(child);
  child.once("error", (error) => {
    console.error(`${name} could not start: ${error.message}`);
    stop(1);
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`${name} exited unexpectedly (${signal ?? code}).`);
      stop(1);
    }
  });
}

process.once("SIGTERM", () => stop(0));
process.once("SIGINT", () => stop(0));

start("MCP server", process.execPath, ["dist/index.js"], mcpEnvironment, process.getuid?.() === 0 ? 1000 : undefined);

try {
  const port = process.env.PORT ?? "8787";
  const deadline = Date.now() + 30000;
  let ready = false;
  while (!stopping && Date.now() < deadline) {
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch { /* The MCP listener may not have bound yet. */ }
    if (ready) break;
    await delay(100);
  }
  if (!stopping) {
    if (!ready) throw new Error("MCP server did not become ready within 30 seconds.");
    start("OpenAI tunnel", "tunnel-client", [
      "run",
      "--control-plane.tunnel-id", OPENAI_TUNNEL_ID!,
      "--mcp.server-url", `http://oura-mcp:${port}/mcp`,
      "--health.listen-addr", "127.0.0.1:8080"
    ], { PATH: process.env.PATH, HOME: "/home/tunnel", CONTROL_PLANE_API_KEY }, process.getuid?.() === 0 ? 10001 : undefined);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  stop(1);
}
