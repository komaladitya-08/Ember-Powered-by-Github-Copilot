/**
 * The launcher for an extension's stdio MCP server (bundled as dist/app/mcp-launch.cjs, run by the Copilot runtime as
 * plain Node with ELECTRON_RUN_AS_NODE). The runtime would start the server with its own whole environment, Ember's
 * GitHub sign-in and every key in it (the spike saw GH_TOKEN and cloud keys reach the server), and a server config's
 * `env` only adds to that. So the runtime starts this instead, and this starts the server with exactly the
 * environment Ember built (`EMBER_MCP_SPEC`: appEnv()'s allowlist plus the plugin's own values), no shell, its
 * stdio passed straight through. It records its server's process id in Ember's run folder, so the kill switch can
 * end it, and ends it when it is told to stop.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** What the launcher is told (JSON in EMBER_MCP_SPEC). */
export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Ember's run folder (0700): `<launcher pid>.pid` holds the server's process id while it runs. */
  runDir: string;
}

/** The spec in `raw`, or null when it isn't one (the launcher then starts nothing). */
export function parseLaunchSpec(raw: string | undefined): LaunchSpec | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<LaunchSpec>;
    if (typeof s.command !== "string" || !s.command || !Array.isArray(s.args) || s.args.some(a => typeof a !== "string")) return null;
    if (!s.env || typeof s.env !== "object" || Object.values(s.env).some(v => typeof v !== "string")) return null;
    if (typeof s.cwd !== "string" || typeof s.runDir !== "string") return null;
    return s as LaunchSpec;
  } catch {
    return null;
  }
}

function main(): void {
  const spec = parseLaunchSpec(process.env.EMBER_MCP_SPEC);
  if (!spec) { process.stderr.write("ember: no server to start\n"); process.exit(2); }
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: "inherit", shell: false, windowsHide: true });
  const pidFile = path.join(spec.runDir, `${process.pid}.pid`);
  child.on("spawn", () => {
    try { fs.writeFileSync(pidFile, String(child.pid ?? ""), { mode: 0o600 }); } catch { /* the kill switch then ends the launcher only, which ends the server */ }
  });
  const end = (code: number) => { try { fs.rmSync(pidFile, { force: true }); } catch { /* already gone */ } process.exit(code); };
  child.on("error", err => { process.stderr.write(`ember: the server didn't start (${(err as NodeJS.ErrnoException).code ?? "error"})\n`); end(127); });
  child.on("exit", (code, signal) => end(code ?? (signal ? 1 : 0)));
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => { try { child.kill("SIGTERM"); } catch { /* gone */ } setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } end(1); }, 2000).unref(); });
}

// Run only as the bundled launcher (tests import parseLaunchSpec).
if (process.env.EMBER_MCP_SPEC !== undefined && require.main === module) main();
