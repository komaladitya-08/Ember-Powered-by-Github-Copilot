/** Fixed Windows-to-WSL helper launch. Ordinary WSL command execution is never used as a coding runner. */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path/win32";
import posix from "node:path/posix";
import type { JobHostRef } from "../commands/types";
import type { WslDistro } from "../wsl/types";
import { jobHostArgv, probeEnv } from "../wsl/discover";
import { runFixedScript, WSLPATH_SCRIPT, type SpawnLike } from "../wsl/launch-sidecar";
import { WslCodingConnection } from "./wsl-coding-connection";
import { ScopedCodingFileError } from "./coding-platform";
import { WslCodingCleanupError } from "./wsl-coding-workspace";

const unavailable = () => new ScopedCodingFileError("unavailable");
const retainedConnections = new Set<WslCodingConnection>(), retainedProbes = new Set<ReturnType<SpawnLike>>();
export interface WslCodingLaunchInput {
  wslExe: string; distro: WslDistro; scriptLinuxPath: string; jobHost: JobHostRef; env: NodeJS.ProcessEnv;
}
/** Discovery and project selection supply these values; no model argument chooses an executable or distro. */
export function wslCodingLaunch(input: WslCodingLaunchInput): { command: string; args: string[]; env: Record<string, string> } {
  const { distro, jobHost, scriptLinuxPath } = input;
  if (!distro || distro.version !== 2 || distro.needsSetup || distro.tool || !Number.isSafeInteger(distro.defaultUid) || distro.defaultUid! <= 0 ||
      !distro.name || distro.name.length > 128 || /[\p{Cc}\p{Cf}"\\/]/u.test(distro.name) ||
      !jobHost || !path.isAbsolute(jobHost.execPath) || !path.isAbsolute(jobHost.script) ||
      !path.isAbsolute(input.wslExe) || path.basename(input.wslExe).toLowerCase() !== "wsl.exe" ||
      !scriptLinuxPath || !posix.isAbsolute(scriptLinuxPath) || posix.normalize(scriptLinuxPath) !== scriptLinuxPath ||
      /[\p{Cc}\p{Cf}\\]/u.test(scriptLinuxPath) || !scriptLinuxPath.endsWith("/wsl-coding.cjs")) throw unavailable();
  const args = ["-d", distro.name, "--cd", "/", "--exec", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "HOME=/tmp", "LC_ALL=C", "/usr/bin/node", "--", scriptLinuxPath];
  const launch = jobHostArgv(jobHost, input.wslExe, args, true);
  return { command: launch[0], args: launch.slice(1), env: probeEnv(input.env, { jobHost: true }) };
}

export interface WslCodingTransportOptions extends WslCodingLaunchInput {
  /** Captured settings/admin/distro/project capability; false is final for this accepted session. */
  current(): boolean;
  spawn?: typeof nodeSpawn;
}
function captureLaunch(input: WslCodingLaunchInput): WslCodingLaunchInput {
  if (!input.distro || !input.jobHost) throw unavailable();
  return { wslExe: input.wslExe, scriptLinuxPath: input.scriptLinuxPath, distro: Object.freeze({ ...input.distro }),
    jobHost: Object.freeze({ ...input.jobHost }), env: { ...input.env } };
}
/** Read-only install-path translation, never a coding command or a claim that a WSL shell is isolated. */
export async function resolveWslCodingHelperPath(options: Omit<WslCodingTransportOptions, "scriptLinuxPath" | "spawn"> & {
  scriptWindowsPath: string; spawn?: SpawnLike;
}): Promise<string> {
  const script = options.scriptWindowsPath;
  if (!path.isAbsolute(script) || path.basename(script) !== "wsl-coding.cjs" || /[\p{Cc}\p{Cf}]/u.test(script)) throw unavailable();
  const captured = captureLaunch({ ...options, scriptLinuxPath: "/wsl-coding.cjs" }), checkCurrent = options.current.bind(options);
  const spawnProbe = options.spawn ?? nodeSpawn as unknown as SpawnLike;
  // Reuse exactly the discovery/identity validation of the real launch before touching the selected distro.
  wslCodingLaunch(captured);
  let admitted = false; try { admitted = checkCurrent() === true; } catch { /* Closed capability. */ }
  if (!admitted) throw unavailable();
  let child: ReturnType<SpawnLike> | undefined, observedClose = false;
  const spawn: SpawnLike = (...args) => {
    child = spawnProbe(...args);
    child.on("close", () => { observedClose = true; }); return child;
  };
  const out = await runFixedScript({ wslExe: captured.wslExe, distro: captured.distro.name, jobHost: captured.jobHost,
    env: probeEnv(captured.env, { jobHost: true }), spawn,
    script: WSLPATH_SCRIPT.replace("wslpath -a", "/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/wslpath -a"), input: [script] });
  // The trusted read-only probe has no project capability. A timed-out/error job still needs an owned ledger.
  if (child && !observedClose) { retainedProbes.add(child); throw new WslCodingCleanupError(); }
  const found = (out ?? "").replace(/\r?\n$/, "");
  try { admitted = checkCurrent() === true; } catch { admitted = false; }
  if (!admitted) throw unavailable();
  wslCodingLaunch({ ...captured, scriptLinuxPath: found });
  return found;
}
/** The caller retains this owned connection on uncertainty; a process exit alone is never a stop receipt. */
export async function connectWslCodingHelper(options: WslCodingTransportOptions): Promise<WslCodingConnection> {
  const captured = captureLaunch(options), expectedUid = captured.distro.defaultUid, checkCurrent = options.current.bind(options);
  const spawnHelper = options.spawn ?? nodeSpawn;
  let live = true;
  const current = () => { if (!live) return false; try { live = checkCurrent() === true; } catch { live = false; } return live; };
  if (!current()) throw unavailable(); const launch = wslCodingLaunch(captured);
  if (!current()) throw unavailable();
  const child = spawnHelper(launch.command, launch.args, { env: launch.env, windowsHide: true, detached: false,
    stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  const connection = new WslCodingConnection(child);
  try {
    const value = await connection.call("hello");
    const uid = value && typeof value === "object" ? (value as { uid?: unknown }).uid : undefined;
    if (!current() || !value || typeof value !== "object" || (value as { protocol?: unknown }).protocol !== 1 ||
        (value as { kind?: unknown }).kind !== "linux-helper" || (value as { provisioned?: unknown }).provisioned !== false ||
        (value as { opened?: unknown }).opened !== false || (value as { retired?: unknown }).retired !== false ||
        typeof uid !== "number" || !Number.isInteger(uid) || uid <= 0 || uid !== expectedUid) throw unavailable();
    return connection;
  } catch {
    try { await connection.close(); }
    catch { retainedConnections.add(connection); throw new WslCodingCleanupError(); }
    throw unavailable();
  }
}
