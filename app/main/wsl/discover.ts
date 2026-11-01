/**
 * WSL discovery (§4.1): which wsl.exe Ember runs, which distros exist and which run, WSL's and WSLg's versions, and
 * whether the user turned WSLg off, without ever starting a distro. Also the one way Ember spawns wsl.exe for its own
 * probes and fixed scripts: under Ember's job host (§3.3) when it has one, hidden, with the cleaned environment plus
 * `WSL_UTF8=1` and an empty `WSLENV` (nothing of the PC's environment crosses into a distro for Ember's own scripts).
 *
 * Listing never boots anything: the registry first (lxss.ts), `wsl.exe --list --verbose` only when it can't be read,
 * `--list --running --quiet` filtered to known names (a localised "nothing is running" sentence is ignored), and
 * `--version` (the inbox wsl.exe prints its usage instead: no WSLg there). Docker's and Rancher's distros are never
 * listed (R3, critique wsl-22) and Podman's machines are commands-only tool distros.
 *
 * Windows only at run time; plain Node, every OS imports it (tests pass fakes for spawn, the registry and files).
 */

import pathWin32 from "node:path/win32";
import type { Logger } from "../logger";
import { cleanEnv } from "../platform/compose";
import type { JobHostRef } from "../commands/types";
import { DISTRO_NAME } from "../../shared/targets";
import type { WslDistro, WslFacts } from "./types";
import { decodeLines, decodeMessage } from "./decode";
import { readLxss, type RegistryReader } from "./lxss";

/** Anything that can't start a distro (`--list`, `--version`): 5 s (§4.1). */
export const LIST_TIMEOUT_MS = 5_000;
/** Anything that may start a distro (its facts, the first command, inspect and git facts): 30 s (critique wsl-19e). */
export const BOOT_TIMEOUT_MS = 30_000;
/** What a probe keeps of each output stream (Ember's fixed scripts print little). */
const PROBE_OUTPUT_CAP = 1024 * 1024;
/** After a probe's process exits, how long its output pipes may take to close before the probe ends anyway. */
const CLOSE_GRACE_MS = 1_000;

/** Distros of tools that must never be acted on (they are never listed). */
export const HIDDEN_DISTRO = /^(docker-desktop|rancher-desktop)(-data)?$/i;
/** Podman's machines: listed, commands only, every command asks (§2.2). */
export const PODMAN_DISTRO = /^podman-machine/i;

/** A child process as the WSL code drives it (node's ChildProcess fits; tests pass fakes). */
export interface WslChild {
  readonly stdin: { write(chunk: Uint8Array | string): boolean; end(): void; on(event: "error", fn: (err: Error) => void): unknown } | null;
  readonly stdout: { on(event: "data", fn: (chunk: Buffer) => void): unknown } | null;
  readonly stderr: { on(event: "data", fn: (chunk: Buffer) => void): unknown } | null;
  on(event: "exit" | "close", fn: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
  /** TerminateProcess on Windows: for the job host, its job closes and every process in it ends. */
  kill(): boolean;
}

/** The spawn options every Windows child of Ember's command code gets (§3.3 "Spawn options", critique integration-8). */
export interface WslSpawnOptions {
  env: Record<string, string>;
  detached: false;
  windowsHide: true;
  stdio: ["pipe", "pipe", "pipe"];
}

/** child_process.spawn as the WSL code uses it. */
export type WslSpawn = (command: string, args: string[], options: WslSpawnOptions) => WslChild;

/** The spawn options of §3.3 for every wsl.exe (or job host) Ember starts. */
export const WSL_SPAWN_OPTIONS: Omit<WslSpawnOptions, "env"> = { detached: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] };

/**
 * The job host's argv (§3.3): `[execPath, script, "--interactive" | "--batch", "--", program, …args]`, never any
 * command text. Written here from §3.3 directly (RUN's run/job-host.ts exports the same function; this one goes when
 * both have merged).
 */
export function jobHostArgv(ref: JobHostRef, program: string, args: string[], interactive: boolean): string[] {
  return [ref.execPath, ref.script, interactive ? "--interactive" : "--batch", "--", program, ...args];
}

/** A variable's value, its name compared without regard to case (Windows' rule). */
export function envGet(env: NodeJS.ProcessEnv | Record<string, string>, name: string): string | undefined {
  const want = name.toUpperCase();
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === want && v !== undefined) return v;
  return undefined;
}

/** Sets `name` in a Windows environment, removing any other spelling of it first (`WslEnv` and `WSLENV` are one). */
export function envSet(env: Record<string, string>, name: string, value: string): void {
  const want = name.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === want) delete env[k];
  env[name] = value;
}

/** Removes `name` from a Windows environment, whatever its spelling. */
export function envDelete(env: Record<string, string>, name: string): void {
  const want = name.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === want) delete env[k];
}

/**
 * The environment of Ember's own probes and fixed scripts (§4.1 "Spawning"): `cleanEnv(env, { os: "win32" })`, plus
 * `WSL_UTF8=1` (wsl.exe's own messages in UTF-8 where it can), `WSLENV` empty (no variable of the PC crosses into the
 * distro), and `ELECTRON_RUN_AS_NODE=1` when the job host (Ember's own binary as Node) runs it.
 */
export function probeEnv(env: NodeJS.ProcessEnv, o: { jobHost: boolean }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cleanEnv(env, { os: "win32" }))) if (v !== undefined) out[k] = v;
  envSet(out, "WSL_UTF8", "1");
  envSet(out, "WSLENV", "");
  if (o.jobHost) envSet(out, "ELECTRON_RUN_AS_NODE", "1");
  else envDelete(out, "ELECTRON_RUN_AS_NODE");
  return out;
}

/** What one probe gave. */
export interface ExecResult {
  /** The exit code (null: killed, timed out or never started). */
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  /** Why it couldn't run at all (no wsl.exe, no job host, spawn failed); null when it ran. */
  error: string | null;
}

/** Runs wsl.exe for Ember's own probes and fixed scripts. */
export interface WslExec {
  /**
   * wsl.exe with `args`. `stdin` (a fixed script ending in `exit`) is written and the pipe kept open until the process
   * ends: the job host ends its job when its stdin closes (§3.3). `inDistro` work (anything that runs inside a distro)
   * needs the job host and relays stdin through it; listing probes run under it in batch mode when there is one.
   */
  run(args: string[], o: { stdin?: string; timeoutMs: number; inDistro: boolean }): Promise<ExecResult>;
}

/** A WslExec over `spawn`, the PC's environment and the job host (the service makes one; tests pass a fake spawn). */
export function createWslExec(o: { exe: () => string | null; env: NodeJS.ProcessEnv; jobHost: JobHostRef | null; spawn: WslSpawn; log: Logger }): WslExec {
  return {
    run(args, r) {
      const empty = Buffer.alloc(0);
      const exe = o.exe();
      const refuse = (error: string): Promise<ExecResult> => Promise.resolve({ code: null, stdout: empty, stderr: empty, timedOut: false, error });
      if (!exe) return refuse("WSL isn't installed");
      if (r.inDistro && !o.jobHost) return refuse("Part of Ember's install is missing (reinstall Ember)");
      const argv = o.jobHost ? jobHostArgv(o.jobHost, exe, args, r.stdin !== undefined) : [exe, ...args];
      return new Promise<ExecResult>(resolve => {
        let child: WslChild;
        try {
          child = o.spawn(argv[0], argv.slice(1), { ...WSL_SPAWN_OPTIONS, env: probeEnv(o.env, { jobHost: o.jobHost !== null }) });
        } catch (err) {
          resolve({ code: null, stdout: empty, stderr: empty, timedOut: false, error: `couldn't start wsl.exe (${(err as Error).message})` });
          return;
        }
        const out: Buffer[] = [], err: Buffer[] = [];
        let outBytes = 0, errBytes = 0, timedOut = false, settled = false, exitCode: number | null = null;
        let graceTimer: ReturnType<typeof setTimeout> | null = null;
        const finish = (error: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (graceTimer) clearTimeout(graceTimer);
          try {
            child.stdin?.end();
          } catch {
            // already closed: the process has gone
          }
          // Debug only (off by default): why a step in a distro failed, for a CI log or a user's support report.
          if (r.inDistro && (error || timedOut || exitCode !== 0)) {
            // wsl.exe writes its own errors to stdout: a failed step's stdout is its message.
            o.log.debug("wsl.exec_failed", { code: exitCode, timedOut, error, stderr: decodeMessage(Buffer.concat(err)), stdout: exitCode !== 0 ? decodeMessage(Buffer.concat(out)) : "", outBytes });
          }
          resolve({ code: timedOut ? null : exitCode, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut, error });
        };
        const timer = setTimeout(() => {
          timedOut = true;
          o.log.warn("wsl.probe_timeout", { args: args.slice(0, 2), ms: r.timeoutMs }); // never a folder or a script
          try {
            child.kill();
          } catch {
            // it has just exited by itself
          }
          finish(null);
        }, r.timeoutMs);
        child.stdout?.on("data", b => {
          if (outBytes < PROBE_OUTPUT_CAP) out.push(b);
          outBytes += b.length;
        });
        child.stderr?.on("data", b => {
          if (errBytes < PROBE_OUTPUT_CAP) err.push(b);
          errBytes += b.length;
        });
        child.on("error", e => finish(`couldn't start wsl.exe (${e.message})`));
        child.on("exit", code => {
          exitCode = code;
          // Output still in the pipes arrives before "close"; a grandchild holding them open can't hold the probe.
          graceTimer = setTimeout(() => finish(null), CLOSE_GRACE_MS);
        });
        child.on("close", code => {
          if (exitCode === null) exitCode = code;
          finish(null);
        });
        child.stdin?.on("error", () => undefined); // EPIPE after the process ended: its result says what happened
        if (r.stdin !== undefined) child.stdin?.write(r.stdin);
      });
    },
  };
}

/** wsl.exe: the Store/MSI WSL's (`%ProgramFiles%\WSL\wsl.exe`) when it exists, else the inbox one, else null. */
export function locateWslExe(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | null {
  const pf = envGet(env, "ProgramFiles");
  const sr = envGet(env, "SystemRoot") ?? envGet(env, "windir");
  const candidates = [pf && pathWin32.join(pf, "WSL", "wsl.exe"), sr && pathWin32.join(sr, "System32", "wsl.exe")];
  for (const c of candidates) if (c && pathWin32.isAbsolute(c) && exists(c)) return c;
  return null;
}

/** A distro name Ember may list: valid as WSL allows it, and not a hidden tool distro. */
export function listable(name: string): boolean {
  return DISTRO_NAME.test(name) && !HIDDEN_DISTRO.test(name);
}

/** One line of `wsl --list --verbose` as parsed. */
export interface ListedDistro { name: string; version: 1 | 2; isDefault: boolean }

/**
 * `wsl.exe --list --verbose` (decoded lines): the first line is the localised header and is skipped by position; each
 * other line is an optional `*` (the default), the name (the first word) and the WSL version (the last word); the
 * localised state words between them are ignored. Lines that don't fit (a message) are ignored.
 */
export function parseListVerbose(lines: string[]): ListedDistro[] {
  const out: ListedDistro[] = [];
  for (const line of lines.slice(1)) {
    const isDefault = line.startsWith("*");
    const words = (isDefault ? line.slice(1) : line).trim().split(/\s+/);
    if (words.length < 3) continue;
    const name = words[0], version = words[words.length - 1];
    if (!DISTRO_NAME.test(name) || (version !== "1" && version !== "2")) continue;
    out.push({ name, version: version === "1" ? 1 : 2, isDefault });
  }
  return out;
}

/**
 * `wsl.exe --list --running --quiet` (decoded lines) as the known names it lists: a line counts only when it is
 * exactly a known distro's name (WSL compares names without regard to case), so the localised sentence printed when
 * nothing runs never counts (critique wsl-19g).
 */
export function parseRunning(lines: string[], known: readonly string[]): Set<string> {
  const byFold = new Map(known.map(n => [n.toLowerCase(), n]));
  const out = new Set<string>();
  for (const line of lines) {
    const name = byFold.get(line.trim().toLowerCase());
    if (name) out.add(name);
  }
  return out;
}

/** The last dotted number in a line ("2.3.26.0", "5.15.167.4"), or null. */
function dotted(line: string): string | null {
  const all = line.match(/\d+(?:\.\d+)+/g);
  return all ? all[all.length - 1] : null;
}

/**
 * `wsl.exe --version` (decoded lines, exit code 0): the Store/MSI WSL prints one localised line per component in a
 * fixed order (WSL, kernel, WSLg, MSRDC, …), so versions are read by line order. The inbox wsl.exe prints its usage
 * and exits non-zero: no version.
 */
export function parseVersion(lines: string[], code: number | null): { wsl: string | null; wslg: string | null } {
  if (code !== 0 || lines.length === 0) return { wsl: null, wslg: null };
  const wsl = dotted(lines[0]);
  if (!wsl || wsl.split(".").length < 3) return { wsl: null, wslg: null };
  return { wsl, wslg: lines.length >= 3 ? dotted(lines[2]) : null };
}

/** `%USERPROFILE%\.wslconfig` says `[wsl2] guiApplications=false` (comments, spacing and case ignored). */
export function guiDisabled(wslconfig: string | null): boolean {
  if (!wslconfig) return false;
  let section = "";
  let off = false;
  for (const raw of wslconfig.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").trim();
    const head = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (head) {
      section = head[1].toLowerCase();
      continue;
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (section === "wsl2" && kv && kv[1].toLowerCase() === "guiapplications") off = kv[2].replace(/^["']|["']$/g, "").trim().toLowerCase() === "false";
  }
  return off;
}

/** What discovery needs (the service passes the real ones; tests pass fakes). */
export interface DiscoverInput {
  exe: string | null;
  exec: WslExec;
  /** The registry reader (null: unavailable, so wsl.exe lists instead). */
  registry: () => RegistryReader | null;
  /** A file's text, or null when it can't be read. */
  readFile: (path: string) => string | null;
  env: NodeJS.ProcessEnv;
  /** Each distro's uid as the distro itself reported it since Ember started (critique wsl-7). */
  uids: ReadonlyMap<string, number>;
  log: Logger;
}

/** WSL's facts with nothing installed. */
export function noWsl(disabledByUser = false): WslFacts {
  return { installed: false, wslExe: null, distros: [], wslg: { available: false, disabledByUser, version: null }, wslVersion: null };
}

/** Lists the distros: the registry first, `wsl --list --verbose` when it can't be read. Never starts one. */
async function listDistros(i: DiscoverInput): Promise<{ name: string; version: 1 | 2; isDefault: boolean; needsSetup: boolean }[]> {
  let lxss = null;
  try {
    const reg = i.registry();
    lxss = reg ? readLxss(reg) : null;
  } catch (err) {
    i.log.warn("wsl.registry_failed", { err });
  }
  if (lxss) {
    const { defaultGuid } = lxss;
    return lxss.distros.map(d => ({ name: d.name, version: d.version, isDefault: defaultGuid !== null && d.guid.toLowerCase() === defaultGuid.toLowerCase(), needsSetup: d.needsSetup }));
  }
  const r = await i.exec.run(["--list", "--verbose"], { timeoutMs: LIST_TIMEOUT_MS, inDistro: false });
  if (r.error || r.timedOut) i.log.warn("wsl.list_failed", { error: r.error, timedOut: r.timedOut });
  // A non-zero exit whose output names no distro means none is installed; WSL's OOBE state isn't in this output.
  return parseListVerbose(decodeLines(r.stdout)).map(d => ({ ...d, needsSetup: false }));
}

/** The running set of `known` names, read now (`wsl --list --running --quiet`); empty when it can't be read. */
export async function readRunning(exec: WslExec, known: readonly string[]): Promise<Set<string>> {
  if (known.length === 0) return new Set();
  const r = await exec.run(["--list", "--running", "--quiet"], { timeoutMs: LIST_TIMEOUT_MS, inDistro: false });
  // Unknown counts as stopped: nothing is then started or revived on the strength of a guess.
  return parseRunning(decodeLines(r.stdout), known);
}

/** Reads WSL's facts now (§4.1). Never starts a distro. */
export async function discoverWsl(i: DiscoverInput): Promise<WslFacts> {
  const profile = envGet(i.env, "USERPROFILE");
  const disabledByUser = guiDisabled(profile ? i.readFile(pathWin32.join(profile, ".wslconfig")) : null);
  if (!i.exe) return noWsl(disabledByUser);
  const [listed, version] = await Promise.all([
    listDistros(i),
    i.exec.run(["--version"], { timeoutMs: LIST_TIMEOUT_MS, inDistro: false }),
  ]);
  const visible = listed.filter(d => listable(d.name));
  const running = await readRunning(i.exec, visible.map(d => d.name));
  const v = parseVersion(decodeLines(version.stdout), version.code);
  const distros: WslDistro[] = visible.map(d => ({
    name: d.name,
    version: d.version,
    isDefault: d.isDefault,
    defaultUid: i.uids.get(d.name) ?? null,
    running: running.has(d.name),
    needsSetup: d.needsSetup,
    ...(PODMAN_DISTRO.test(d.name) ? { tool: "podman" as const } : {}),
  }));
  return {
    installed: true,
    wslExe: i.exe,
    distros,
    // The inbox WSL never has WSLg; a WSL1-only PC has none either (critique wsl-21).
    wslg: { available: v.wsl !== null && distros.some(d => d.version === 2) && !disabledByUser, disabledByUser, version: v.wslg },
    wslVersion: v.wsl,
  };
}
