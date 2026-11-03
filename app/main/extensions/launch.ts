/**
 * Starts an extension's stdio server with only Ember's allowlisted environment, never the runtime's credentials.
 * A private, per-launch lease is checked before spawn and every 25 ms. Removing or disabling an extension, Stop,
 * or Ember's next start revokes it. No process id read from a file is ever signalled: this launcher owns its child.
 * On Windows a kill-on-close job contains the whole tree, including when the runtime kills the launcher itself.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadJobApi, type JobApi } from "../commands/run/win32-job";

/** What the launcher is told (JSON in EMBER_MCP_SPEC). */
export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  runDir: string;
  /** Unique private lease made by Ember for this launch, never recreated after revocation. */
  leaseFile: string;
  /** Linux and macOS use a process group; Windows uses a kill-on-close job. */
  group: boolean;
}

/** The spec in `raw`, or null when it isn't one (the launcher then starts nothing). */
export function parseLaunchSpec(raw: string | undefined): LaunchSpec | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<LaunchSpec>;
    if (typeof s.command !== "string" || !s.command || !Array.isArray(s.args) || s.args.some(a => typeof a !== "string")) return null;
    if (!s.env || typeof s.env !== "object" || Object.values(s.env).some(v => typeof v !== "string")) return null;
    if (typeof s.cwd !== "string" || typeof s.runDir !== "string" || typeof s.group !== "boolean") return null;
    if (typeof s.leaseFile !== "string" || !path.isAbsolute(s.leaseFile) || path.dirname(s.leaseFile) !== path.resolve(s.runDir) || !/^[a-f0-9-]{36}\.lease$/.test(path.basename(s.leaseFile))) return null;
    return s as LaunchSpec;
  } catch {
    return null;
  }
}

/** Never use a direct process-group signal after Node has observed its child ending (its pid may be reused). */
export function childIsLive(child: { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null }): boolean {
  return child.pid !== undefined && child.pid > 1 && child.exitCode === null && child.signalCode === null;
}

/** Windows joins its own job before spawning, so no descendant can escape the kill-on-close lifetime. */
export function launcherJob(api: JobApi | null): () => void {
  if (!api) throw new Error("no job objects");
  const job = api.createKillOnCloseJob();
  api.assignSelf(job);
  return () => { api.terminate(job, 1); };
}

function main(): void {
  const spec = parseLaunchSpec(process.env.EMBER_MCP_SPEC);
  if (!spec || !fs.existsSync(spec.leaseFile)) { process.stderr.write("ember: no server to start\n"); process.exit(2); }
  let stopJob: (() => void) | undefined;
  if (!spec.group) {
    try { stopJob = launcherJob(loadJobApi()); } catch { process.stderr.write("ember: the server could not be contained\n"); process.exit(2); }
  }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: "inherit", shell: false, windowsHide: true, detached: spec.group });
  } catch {
    process.stderr.write("ember: the server didn't start (Ember starts programs only, never scripts through a shell)\n");
    process.exit(127);
  }
  const kill = (signal: NodeJS.Signals) => {
    if (!childIsLive(child)) return;
    if (stopJob) { stopJob(); return; }
    try { process.kill(-child.pid!, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
  };
  const end = (code: number) => {
    clearInterval(watch);
    try { fs.rmSync(spec.leaseFile, { force: true }); } catch { /* already revoked */ }
    process.exit(code);
  };
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    kill("SIGTERM");
    // A non-cooperative live child is killed; a child that ended is never signalled by its old pid.
    setTimeout(() => { kill("SIGKILL"); end(1); }, 200).unref();
  };
  const watch = setInterval(() => { if (!fs.existsSync(spec.leaseFile)) stop(); }, 25);
  watch.unref();
  // Revocation can race the spawn. It is checked again once Node has a child to stop.
  child.on("spawn", () => { if (!fs.existsSync(spec.leaseFile)) stop(); });
  child.on("error", err => { process.stderr.write(`ember: the server didn't start (${(err as NodeJS.ErrnoException).code ?? "error"})\n`); end(127); });
  child.on("exit", (code, signal) => end(code ?? (signal ? 1 : 0)));
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, stop);
}

if (process.env.EMBER_MCP_SPEC !== undefined && require.main === module) main();
