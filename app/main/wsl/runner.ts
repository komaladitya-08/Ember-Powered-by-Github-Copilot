/**
 * Commands inside a WSL distro (§3.3's two WSL rows, §4.2, §3.13's WSL ladder): one CommandRunner per distro, run by
 * Ember's job host holding `wsl.exe` (and every interop child it starts) in a kill-on-close job.
 *
 * The constraints behind it:
 * - The command text is never on any argv: it travels as `EMBER_CMD_B64` (base64 of its UTF-8 bytes, because only
 *   plain ASCII crosses wsl.exe's environment safely) beside the fixed launcher `EMBER_INNER`, both through a `WSLENV`
 *   that **replaces** the user's, so nothing else of the PC's environment crosses into the distro (X11). wsl.exe's own
 *   -c text is `WSL_EVAL`, which holds no quote or backslash for Windows' argument quoting to change (critique wsl-18).
 * - A PTY through util-linux `script` when the distro has it (BusyBox's has no `-e`), else pipes with stdin closed.
 * - Every fixed script (facts, inspect, git facts, sweeps, boot ids) goes to `/bin/sh -s` on stdin, never on argv,
 *   and ends in `exit` (the job host ends its job when its stdin closes, so stdin stays open for the script's life).
 *   Data a script reads (inspect's paths) travels inside a quoted here-document with a random delimiter: dash, Ubuntu's
 *   /bin/sh, reads a script from a pipe in blocks, so data written after the script on stdin would be parsed as
 *   commands (checked: `printf 'while read p; do …; done\necho INJECTED\n' | dash -s` runs `echo INJECTED`).
 * - The start marker the launcher prints decides whether the command started: output that ends without it is a
 *   failed start whose reason is wsl.exe's (or the launcher's) own error text, decoded (critique wsl-17).
 * - Stop: `\x03` through the job host's stdin (PTY) or the in-distro sweep with INT (pipes), then sweeps with TERM and
 *   KILL, and only then the job host (killing wsl.exe first would orphan the Linux tree; critique wsl-16).
 * - A distro whose first-run set-up is pending, a hidden tool distro and a name discovery doesn't list are refused.
 *
 * Paths here are the distro's (POSIX: node:path/posix only). Plain Node; no koffi, no Electron.
 */

import { randomBytes } from "node:crypto";
import pathPosix from "node:path/posix";
import type { Logger } from "../logger";
import type { TargetId } from "../../shared/targets";
import type {
  CommandRunner, GitFacts, JobHostRef, PathFact, RunExit, RunningCommand, RunSpec, RunnerFacts, ShellId, WindowsContext,
} from "../commands/types";
import { commandEnv } from "../commands/run/env";
import { LaunchError, launchArgv } from "../commands/run/local";
import { sweepArgs, sweepScript, sweptNames } from "../commands/run/sweep";
import { trackSecretPrompts, type SecretTracker } from "../commands/prompts";
import type { WslDistro } from "./types";
import { decodeMessage, decodeWsl } from "./decode";
import { BOOT_TIMEOUT_MS, WSL_SPAWN_OPTIONS, envSet, type WslChild, type WslExec, type WslSpawn } from "./discover";

// ---------------------------------------------------------------------------------------------------------------
// Fixed scripts (stdin only)
// ---------------------------------------------------------------------------------------------------------------

/** §4.2's facts script, exactly: one `key=value` line per fact, read once per distro (it may start the distro). */
export const FACTS_SCRIPT = [
  'echo "uid=$(id -u)"; echo "user=$(id -un)"; echo "home=$HOME"',
  'for s in /bin/bash /usr/bin/bash /bin/zsh /usr/bin/zsh /bin/sh; do [ -x "$s" ] && echo "shell=$s"; done',
  's=$(command -v script 2>/dev/null) && "$s" --version 2>/dev/null | grep -q util-linux && echo "script=$s"',
  'for f in /proc/sys/fs/binfmt_misc/WSLInterop*; do [ -e "$f" ] && { echo interop=1; break; }; done',
  '[ -n "$WSL_INTEROP" ] && echo interop=1',
  'm=$(findmnt -rn -t 9p,drvfs -o TARGET 2>/dev/null | head -n1) && echo "mount=$m"',
  "c=$(wslpath -u 'C:\\' 2>/dev/null) && echo \"mountc=$c\"",
  "command -v python3 >/dev/null 2>&1 && echo python3=1",
  "command -v base64 >/dev/null 2>&1 && echo base64=1",
].join("\n");

/** §4.2's inspect script, exactly: for each path line, whether it exists (lstat) and its real path (`realpath -m`). */
export const INSPECT_SCRIPT =
  "while IFS= read -r p; do if [ -e \"$p\" ] || [ -L \"$p\" ]; then e=1; else e=0; fi; r=$(realpath -m -- \"$p\" 2>/dev/null); printf '%s\\t%s\\n' \"$e\" \"$r\"; done";

/** §4.2's git facts, read-only, each line prefixed and empty on failure (git's prompts and optional locks off). */
export const GIT_SCRIPT = [
  "export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0",
  "b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); printf 'branch=%s\\n' \"$b\"",
  "d=$(git config --get push.default 2>/dev/null); printf 'push=%s\\n' \"$d\"",
  "u=$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null); printf 'upstream=%s\\n' \"$u\"",
].join("\n");

/** The in-distro sweep (§3.13): RUN's, which also names what it found (`<pid> <comm>` lines) for the status line. */
export const SWEEP_SCRIPT = sweepScript;

/** The boot id of the distro's kernel (SA's same-machine rule, §5.1.14): read only from a running WSL2 distro. */
export const BOOT_ID_SCRIPT = "cat /proc/sys/kernel/random/boot_id";

/** A line a here-document can carry as data: no line break, no NUL. */
function carriable(line: string): boolean {
  return !/[\r\n\0]/.test(line);
}

/**
 * The text Ember writes to `/bin/sh -s`: the fixed `script`, then `exit` (stdin stays open: see the module comment).
 * `lines` reach the script as its stdin through a quoted here-document (`<<'EMBER_DATA_<random>'`), so the shell never
 * parses them: they are data whatever they hold. Throws when a line can't be carried (a line break or NUL in it).
 */
export function scriptInput(script: string, lines?: readonly string[], delimiter = `EMBER_DATA_${randomBytes(8).toString("hex")}`): string {
  if (!lines) return `${script}\nexit\n`;
  if (!/^[A-Za-z0-9_]+$/.test(delimiter)) throw new Error("bad here-document delimiter");
  for (const l of lines) if (!carriable(l) || l === delimiter) throw new Error("a line can't be passed to WSL");
  const body = lines.length ? `${lines.join("\n")}\n` : "";
  return `{\n${script}\n} <<'${delimiter}'\n${body}${delimiter}\nexit\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------------------------------------------

/** What the facts script printed, checked. */
export interface FactsLines {
  uid: number;
  user: string;
  home: string;
  /** The first executable path found per shell. */
  shells: Partial<Record<"bash" | "zsh" | "sh", string>>;
  /** util-linux `script`'s path, or null. */
  script: string | null;
  interop: boolean;
  /** findmnt's first 9p/drvfs mount target, and `wslpath -u 'C:\'`. */
  mount: string | null;
  mountc: string | null;
  python3: boolean;
  base64: boolean;
}

/** A path Ember may put on wsl.exe's argv: absolute, made only of [A-Za-z0-9/._-] (§3.1 RunnerFacts.shellPaths). */
export const SAFE_PATH = /^\/[A-Za-z0-9/._-]*$/;
/** Characters a distro-reported text may not hold (control characters). */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * The facts script's output parsed and checked (fail closed: a distro that reports no uid, a non-numeric uid or no
 * absolute home gives null). Unknown keys are ignored; a shell or `script` path that isn't SAFE_PATH is ignored.
 */
export function parseFacts(text: string): FactsLines | null {
  const out: FactsLines = { uid: -1, user: "", home: "", shells: {}, script: null, interop: false, mount: null, mountc: null, python3: false, base64: false };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq), value = line.slice(eq + 1);
    if (CONTROL.test(value)) continue;
    switch (key) {
      case "uid":
        if (/^\d{1,10}$/.test(value) && Number(value) <= 0xffffffff) out.uid = Number(value);
        break;
      case "user":
        if (value.length <= 256) out.user = value;
        break;
      case "home":
        if (value.startsWith("/") && value.length <= 4096) out.home = value;
        break;
      case "shell": {
        if (!SAFE_PATH.test(value)) break;
        const kind = pathPosix.basename(value);
        if ((kind === "bash" || kind === "zsh" || kind === "sh") && !out.shells[kind]) out.shells[kind] = value;
        break;
      }
      case "script":
        if (SAFE_PATH.test(value)) out.script = value;
        break;
      case "interop":
        if (value === "1") out.interop = true;
        break;
      case "mount":
        if (value.startsWith("/")) out.mount = value;
        break;
      case "mountc":
        if (value.startsWith("/")) out.mountc = value;
        break;
      case "python3":
        out.python3 = value === "1";
        break;
      case "base64":
        out.base64 = value === "1";
        break;
    }
  }
  return out.uid >= 0 && out.home ? out : null;
}

/**
 * The drive mounts' root (§4.2): the parent of `wslpath -u 'C:\'` (`/mnt/c/` → `/mnt/`), else of findmnt's first
 * 9p/drvfs mount when that is a drive letter's folder (WSL2 also mounts its GPU drivers as 9p, which isn't one), else
 * `/mnt/`. Always ends in `/`.
 */
export function mountRootOf(mountc: string | null, mount: string | null): string {
  const parent = (p: string) => {
    const dir = pathPosix.dirname(pathPosix.normalize(p).replace(/\/+$/, "") || "/");
    return dir.endsWith("/") ? dir : `${dir}/`;
  };
  if (mountc && /\/[A-Za-z]\/?$/.test(mountc)) return parent(mountc);
  if (mount && /\/[A-Za-z]$/.test(mount)) return parent(mount);
  return "/mnt/";
}

/** A Windows path under the drive mounts (`C:\Users\ana\x` → `/mnt/c/Users/ana/x`); null for UNC and relative paths. */
export function toWslPath(win: string, mountRoot: string): string | null {
  const m = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(win);
  if (!m) return null;
  const rest = (m[2] ?? "").split(/[\\/]+/).filter(Boolean).join("/");
  return pathPosix.normalize(`${mountRoot}${m[1].toLowerCase()}/${rest}`).replace(/(.)\/$/, "$1");
}

/** Ember's own process names as a distro could reach them (interop: `taskkill.exe /im Ember.exe`). */
export const WSL_EMBER_NAMES = /^ember(\.exe)?$/i;

/** RunnerFacts for a distro from its checked facts lines (§4.2). */
export function runnerFacts(f: FactsLines, o: { winPaths: readonly string[]; windows: WindowsContext | null }): RunnerFacts {
  const order: ("bash" | "zsh" | "sh")[] = ["bash", "zsh", "sh"];
  const found = order.filter(s => f.shells[s]);
  // Linux and WSL: bash, else sh, by default (§3.3); the others follow.
  const first = found.includes("bash") ? "bash" : found.includes("sh") ? "sh" : found[0];
  const shells: ShellId[] = first ? [first, ...found.filter(s => s !== first)] : [];
  const shellPaths: Partial<Record<ShellId, string>> = {};
  for (const s of found) shellPaths[s] = f.shells[s];
  const mountRoot = mountRootOf(f.mountc, f.mount);
  const paths = o.winPaths.map(p => toWslPath(p, mountRoot)).filter((p): p is string => p !== null);
  return {
    os: "linux",
    shells,
    shellPaths,
    script: f.script ? { path: f.script, kind: "util-linux" } : null,
    home: f.home,
    user: f.user,
    privileged: f.uid === 0,
    pty: f.script !== null,
    ember: { paths, pids: [], names: WSL_EMBER_NAMES },
    extraPath: [],
    wsl: { mountRoot, interop: f.interop, windows: o.windows },
  };
}

/** inspect's output: one `exists\treal` line per path sent (null facts for anything else). */
export function parseInspect(text: string, count: number): PathFact[] | null {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== count) return null;
  return lines.map(line => {
    const tab = line.indexOf("\t");
    if (tab < 0) return { exists: null, real: null };
    const e = line.slice(0, tab), r = line.slice(tab + 1);
    return { exists: e === "1" ? true : e === "0" ? false : null, real: r.startsWith("/") ? r : null };
  });
}

/** The git facts script's output; null outside a work tree (no branch) or on failure. */
export function parseGitFacts(text: string): GitFacts | null {
  const v: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^(branch|push|upstream)=(.*)$/.exec(line.replace(/\r$/, ""));
    if (m && !CONTROL.test(m[2])) v[m[1]] = m[2];
  }
  if (!v.branch) return null;
  return { branch: v.branch === "HEAD" ? null : v.branch, pushDefault: v.push || null, upstream: v.upstream || null };
}

// ---------------------------------------------------------------------------------------------------------------
// The run's environment and argv (§3.3, §3.3.1)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The Windows side's environment of a WSL run: RUN's `commandEnv` (§3.3.1) for Windows (`os: "win32"`, names compared
 * without regard to case), not a remote, no extra PATH: Ember's, Electron's, Node's and Copilot's variables and the
 * sign-in tokens removed, no start-up code variables, appEnv's repairs, TERM and EMBER_RUN_ID, and on pipe runs the
 * non-interactive defaults with SUDO_ASKPASS/SSH_ASKPASS removed. Only what WSLENV lists reaches the distro; the rest is
 * what wsl.exe and interop's Windows programs see.
 */
export function windowsRunEnv(base: NodeJS.ProcessEnv, o: { pty: boolean; runId: string }): Record<string, string> {
  return commandEnv(base, { os: "win32", pty: o.pty, remote: false, extraPath: [], runId: o.runId });
}

/** The longest value Windows keeps in one environment variable (32,767 characters with its NUL). */
const ENV_VALUE_MAX = 32_766;

/** Everything a WSL run's launch is made of (pure; exported for tests). */
export interface WslLaunch { command: string; args: string[]; env: Record<string, string>; pty: boolean }

/**
 * The exact argv and environment of a WSL run (§3.3's two WSL rows): the job host, then
 * `wsl.exe -d <distro> --cd <cwd> --exec /usr/bin/env SHELL=/bin/sh <script> -q -e -f -c WSL_EVAL /dev/null` (PTY) or
 * `wsl.exe -d <distro> --cd <cwd> --exec <shell> <no-rc flags> -c WSL_EVAL` (pipes). Throws a plain-words Error when the
 * run can't be passed to WSL (the caller ends it as failed-to-start).
 */
export function wslLaunch(spec: RunSpec, facts: RunnerFacts, o: { exe: string; distro: string; jobHost: JobHostRef; env: NodeJS.ProcessEnv }): WslLaunch {
  const shell = spec.shell;
  if (shell !== "bash" && shell !== "zsh" && shell !== "sh") throw new Error(`${shell} isn't installed on ${o.distro}`);
  const shellPath = facts.shellPaths[shell];
  if (!shellPath) throw new Error(`${shell} isn't installed on ${o.distro}`);
  if (!SAFE_PATH.test(shellPath) || (facts.script && !SAFE_PATH.test(facts.script.path))) throw new Error(`${o.distro}'s shell has a path Ember can't pass to WSL`);
  if (!spec.cwd.startsWith("/") || /["\\]/.test(spec.cwd) || CONTROL.test(spec.cwd)) throw new Error("Ember can't pass that folder to WSL");
  if (!/^[0-9a-f]{16}$/.test(spec.runId)) throw new Error("the run had no proper id");
  if (spec.command.includes("\0")) throw new Error("the command holds a NUL character");
  const b64 = Buffer.from(spec.command, "utf8").toString("base64");
  if (b64.length > ENV_VALUE_MAX) throw new Error("the command is too long to pass to WSL");
  // RUN's launcher (§3.3's two WSL rows): the job host, wsl.exe and WSL_EVAL, the command only in EMBER_CMD_B64, and a
  // WSLENV that replaces the user's (on pipes it carries the non-interactive defaults too).
  let launch: ReturnType<typeof launchArgv>;
  try {
    launch = launchArgv(spec, facts, { jobHost: o.jobHost, wsl: { exe: o.exe, distro: o.distro } });
  } catch (err) {
    throw new Error(err instanceof LaunchError ? err.message.replace(/\.$/, "") : "Ember couldn't prepare the command for WSL", { cause: err });
  }
  const pty = facts.script?.kind === "util-linux";
  // The Windows side's environment (§3.3.1), with the launcher's variables laid over it (names compared as Windows does).
  const env = windowsRunEnv(o.env, { pty, runId: spec.runId });
  for (const [k, v] of Object.entries(launch.env)) envSet(env, k, v);
  return { command: launch.command, args: launch.args, env, pty };
}

// ---------------------------------------------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------------------------------------------

/** What the runner needs from the WSL service (and, in tests, fakes). */
export interface WslRunnerDeps {
  log: Logger;
  distro: string;
  /** The PC's environment (the Windows side of a run). */
  env: NodeJS.ProcessEnv;
  jobHost: JobHostRef | null;
  spawn: WslSpawn;
  /** Ember's own probes and fixed scripts. */
  exec: WslExec;
  /** wsl.exe now, or null. */
  exe: () => string | null;
  /** The distro as discovery lists it now (null: hidden, gone or never there). */
  listed: () => Promise<WslDistro | null>;
  /** From the service's cached running set (cheap; never starts anything). */
  isRunning: () => boolean;
  /** The running set read now. */
  runningNow: () => Promise<Set<string>>;
  windows: () => WindowsContext;
  /** Ember's own Windows paths (§3.6.2), translated under the mount root for the classifier. */
  winPaths: readonly string[];
  /** Tells the service the uid the distro itself reported (WslDistro.defaultUid). */
  learnedUid: (uid: number) => void;
  /** The secret tracker per run (default CL's trackSecretPrompts, §3.11 step 2; tests may pass their own). */
  trackSecrets?: (o: { interactive: boolean }) => SecretTracker;
  now?: () => number;
}

/** A fixed script's result. */
export interface ScriptResult { code: number | null; stdout: Buffer; stderr: string }

/** A WSL run beyond RunningCommand: what the secret tracker found and what outlived the run (for the status line). */
export interface WslRunningCommand extends RunningCommand {
  /** The secret prompts' spans so far (ShapeOptions.secretSpans). */
  secretSpans(): { from: number; to: number }[];
  /**
   * Programs carrying the run's marker that were still there at the last sweep ("1 program it started is still running:
   * <name>"), as RUN's runs report them (KeptRun.stragglers): known after the ladder's last sweep, or after the look a run
   * that ended by itself gets; [] when nothing was looked for.
   */
  readonly stragglers: Promise<string[]>;
}

/** The WSL runner beyond CommandRunner (extension: the targets runtime and WB use it). */
export interface WslRunner extends CommandRunner {
  readonly distro: string;
  start(spec: RunSpec): WslRunningCommand;
  /** The facts last read (CommandService.shells() without waiting); null before the first read. */
  lastFacts(): RunnerFacts | null;
  /** Forgets the facts (the distro stopped: its default user may have changed). */
  invalidate(): void;
  /** "Starting Ubuntu…" while a call that may start the distro waits for it; null otherwise. */
  status(): string | null;
  onStatus(fn: (text: string | null) => void): () => void;
  /**
   * Runs one of Ember's own fixed POSIX scripts in the distro (stdin to `/bin/sh -s`; `lines` reach it as data through
   * a quoted here-document, never as code): WB's wslpath translation and its `wsl-a11y` fix use it. Never starts a
   * stopped distro unless `mayBoot`. Null when it couldn't run (not listed, set-up pending, stopped, timed out).
   */
  runScript(script: string, o?: { lines?: readonly string[]; cwd?: string; timeoutMs?: number; mayBoot?: boolean }): Promise<ScriptResult | null>;
}

/** Facts read within this long are reused (one tool call's facts, inspect, git facts and start). */
export const FACTS_TTL_MS = 10_000;
/** The WSL ladder (§3.13): TERM sweep, KILL sweep then the job host, last sweep. */
export const LADDER_MS = { term: 300, kill: 1_000, last: 1_500 } as const;
/** A sweep's own time limit (a wsl.exe start each, ~0.2-0.5 s). */
export const SWEEP_TIMEOUT_MS = 2_000;
/** How long the job host waits for the KILL sweep before it is terminated anyway. */
const KILL_SWEEP_WAIT_MS = 450;
/** Output kept per run for late subscribers (§3.10: head 64 KiB + rolling tail, 4 MiB in all). */
const KEEP_HEAD = 64 * 1024, KEEP_ALL = 4 * 1024 * 1024;
/** Output held before the start marker (errors only, normally). */
const HOLD_MAX = 256 * 1024;
/** The launcher's start marker (POSIX_PRELUDE's `printf "\033]777;ember-start\007"`). */
export const START_MARKER = Buffer.from("\x1b]777;ember-start\x07", "latin1");
/**
 * A Stop that comes after wsl.exe was started but before the command started waits this long for it to start (the
 * ladder then runs at once), then ends wsl.exe: killing it earlier could leave a launcher that is about to run the
 * command orphaned inside the distro (critique wsl-16). Meanwhile a KILL sweep runs at once and every
 * PRESTART_SWEEP_MS: a launcher already in the distro carries the run's marker and dies before it reaches the command.
 */
export const PRESTART_STOP_MS = 5_000;
/** How often a Stop that came before the command started sweeps for its launcher while it waits. */
export const PRESTART_SWEEP_MS = 1_000;
/** How long after the last sweep a stopped run whose job host is somehow still there ends anyway. */
const UNKILLABLE_MS = 2_000;
/** The job host's exit code when it couldn't make or join its job (run/job-host.ts's JOB_FAILED). */
const JOB_FAILED = 125;
/** The most typed text kept per run (lines the user typed, cut from the model's text: L2). */
const TYPED_MAX = 64 * 1024;

const ENDED: Record<"user" | "task" | "killswitch" | "timeout", RunExit["ended"]> = {
  user: "stopped-user", task: "stopped-task", killswitch: "killswitch", timeout: "timeout",
};

/** Creates the CommandRunner of one distro. */
export function createWslRunner(d: WslRunnerDeps): WslRunner {
  const now = d.now ?? Date.now;
  const name = d.distro;
  const target = `wsl:${name}` as TargetId;
  const runs = new Set<Run>();
  const statusFns = new Set<(t: string | null) => void>();
  let statusText: string | null = null;
  let cache: { facts: RunnerFacts; lines: FactsLines; at: number } | null = null;
  let inflight: Promise<{ facts: RunnerFacts; lines: FactsLines }> | null = null;
  let booting = 0;

  const setStatus = (t: string | null) => {
    if (t === statusText) return;
    statusText = t;
    for (const fn of statusFns) {
      try {
        fn(t);
      } catch (err) {
        d.log.warn("wsl.status_listener_failed", { err });
      }
    }
  };

  /** Wraps a call that may start the distro in "Starting <distro>…" while it isn't known to run. */
  const mayStart = async <T>(fn: () => Promise<T>): Promise<T> => {
    const starting = !d.isRunning();
    if (starting) {
      booting++;
      setStatus(`Starting ${name}…`);
    }
    try {
      return await fn();
    } finally {
      if (starting && --booting === 0) setStatus(null);
    }
  };

  /** The distro if Ember may run anything in it; else a plain-words Error. */
  const usable = async (): Promise<WslDistro> => {
    const listed = await d.listed();
    if (!listed) throw new Error(`${name} isn't a WSL distro Ember can use`);
    if (listed.needsSetup) throw new Error(`Set up ${name} first: open it from the Start menu once`);
    return listed;
  };

  const readFacts = async (): Promise<{ facts: RunnerFacts; lines: FactsLines }> => {
    await usable();
    const r = await mayStart(() => d.exec.run(["-d", name, "--cd", "~", "--exec", "/bin/sh", "-s"], { stdin: scriptInput(FACTS_SCRIPT), timeoutMs: BOOT_TIMEOUT_MS, inDistro: true }));
    if (r.error) throw new Error(r.error);
    if (r.timedOut) throw new Error(`${name} took too long to start`);
    const lines = parseFacts(r.stdout.toString("utf8"));
    if (!lines) {
      const why = decodeMessage(r.stderr);
      d.log.warn("wsl.facts_unreadable", { distro: name, code: r.code, why });
      throw new Error(why ? `Ember couldn't read ${name}'s set-up: ${why}` : `Ember couldn't read ${name}'s set-up`);
    }
    d.learnedUid(lines.uid);
    const facts = runnerFacts(lines, { winPaths: d.winPaths, windows: d.windows() });
    cache = { facts, lines, at: now() };
    return { facts, lines };
  };

  const factsAndLines = (): Promise<{ facts: RunnerFacts; lines: FactsLines }> => {
    if (cache && now() - cache.at < FACTS_TTL_MS) return Promise.resolve(cache);
    if (!inflight) inflight = readFacts().finally(() => { inflight = null; });
    return inflight;
  };

  const runScript: WslRunner["runScript"] = async (script, o = {}) => {
    try {
      await usable();
      if (!o.mayBoot && !(await d.runningNow()).has(name)) return null;
      const cwd = o.cwd ?? "~";
      if (cwd !== "~" && (!cwd.startsWith("/") || /["\\]/.test(cwd) || CONTROL.test(cwd))) return null;
      const input = scriptInput(script, o.lines);
      const call = () => d.exec.run(["-d", name, "--cd", cwd, "--exec", "/bin/sh", "-s"], { stdin: input, timeoutMs: o.timeoutMs ?? BOOT_TIMEOUT_MS, inDistro: true });
      const r = o.mayBoot ? await mayStart(call) : await call();
      if (r.error || r.timedOut) return null;
      return { code: r.code, stdout: r.stdout, stderr: decodeMessage(r.stderr) };
    } catch (err) {
      d.log.warn("wsl.script_failed", { distro: name, err });
      return null;
    }
  };

  const boot = async (): Promise<boolean> => {
    const r = await mayStart(() => d.exec.run(["-d", name, "--cd", "~", "--exec", "/bin/sh", "-s"], { stdin: scriptInput("true"), timeoutMs: BOOT_TIMEOUT_MS, inDistro: true }));
    return !r.error && !r.timedOut && r.code === 0;
  };

  const sweep = async (signal: "INT" | "TERM" | "KILL" | "0", runId: string): Promise<string[]> => {
    let args: [string, string];
    try {
      // RUN's two words for the script: the signal (0: only look) and the run id, each checked.
      args = sweepArgs(signal === "0" ? null : `SIG${signal}`, runId);
    } catch {
      return []; // not a run id Ember made: nothing of it can be in the distro
    }
    const r = await d.exec.run(["-d", name, "--exec", "/bin/sh", "-s", "--", ...args], { stdin: scriptInput(SWEEP_SCRIPT), timeoutMs: SWEEP_TIMEOUT_MS, inDistro: true });
    return sweptNames(r.stdout.toString("utf8"));
  };

  const runner: WslRunner = {
    target,
    distro: name,
    facts: async () => (await factsAndLines()).facts,
    lastFacts: () => cache?.facts ?? null,
    invalidate() {
      cache = null;
    },
    status: () => statusText,
    onStatus(fn) {
      statusFns.add(fn);
      return () => statusFns.delete(fn);
    },
    async inspect(paths, cwd) {
      const unknown = (): PathFact[] => paths.map(() => ({ exists: null, real: null }));
      try {
        if (paths.length === 0) return [];
        const sendable = paths.slice(0, 64).map(p => typeof p === "string" && p !== "" && p.length <= 4096 && carriable(p));
        const sent = paths.slice(0, 64).filter((_, i) => sendable[i]);
        if (sent.length === 0) return unknown();
        const r = await runScript(INSPECT_SCRIPT, { lines: sent, cwd, mayBoot: true });
        const got = r && r.code === 0 ? parseInspect(r.stdout.toString("utf8"), sent.length) : null;
        if (!got) return unknown();
        let k = 0;
        return paths.map((_, i) => (i < 64 && sendable[i] ? got[k++] : { exists: null, real: null }));
      } catch (err) {
        d.log.warn("wsl.inspect_failed", { distro: name, err });
        return unknown();
      }
    },
    async gitFacts(cwd) {
      const r = await runScript(GIT_SCRIPT, { cwd, mayBoot: true });
      return r ? parseGitFacts(r.stdout.toString("utf8")) : null;
    },
    start(spec) {
      const run = new Run(spec, d, { factsAndLines, usable, sweep, boot, now, lastFacts: () => cache?.facts ?? null });
      runs.add(run);
      void run.done.then(() => runs.delete(run));
      run.begin();
      return run.handle;
    },
    async stopAll(why) {
      for (const run of [...runs]) run.stop(why === "killswitch" ? "killswitch" : "task");
    },
    get running() {
      return runs.size;
    },
    runScript,
  };
  return runner;
}

/** What a run needs from its runner. */
interface RunnerParts {
  factsAndLines: () => Promise<{ facts: RunnerFacts; lines: FactsLines }>;
  usable: () => Promise<WslDistro>;
  sweep: (signal: "INT" | "TERM" | "KILL" | "0", runId: string) => Promise<string[]>;
  /** Starts the stopped distro with a no-op ("Starting <distro>…" meanwhile); false when it didn't start. */
  boot: () => Promise<boolean>;
  now: () => number;
  lastFacts: () => RunnerFacts | null;
}

/** One command in a distro, from its checks to its end. */
class Run {
  readonly done: Promise<RunExit>;
  readonly handle: WslRunningCommand;
  private resolveDone!: (e: RunExit) => void;
  private child: WslChild | null = null;
  private pty: boolean;
  private stopWhy: "user" | "task" | "killswitch" | "timeout" | null = null;
  private ended = false;
  private started = false;
  private exited: { code: number | null; signal: string | null } | null = null;
  private readonly t0: number;
  private readonly held: { out: Buffer[]; err: Buffer[]; outBytes: number; errBytes: number } = { out: [], err: [], outBytes: 0, errBytes: 0 };
  private keptHead: Buffer[] = [];
  private keptTail: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private outBytes = 0;
  private readonly subscribers = new Set<(chunk: Uint8Array) => void>();
  private readonly decoder = new TextDecoder("utf-8");
  private tracker: SecretTracker;
  private typed: string[] = [];
  private typing = "";
  private typedBytes = 0;
  private readonly stragglers: Promise<string[]>;
  private setStragglers!: (names: string[]) => void;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private ladder: Promise<void> | null = null;

  constructor(private readonly spec: RunSpec, private readonly d: WslRunnerDeps, private readonly r: RunnerParts) {
    this.t0 = r.now();
    this.pty = r.lastFacts()?.pty ?? false;
    this.tracker = (d.trackSecrets ?? trackSecretPrompts)({ interactive: this.pty });
    this.done = new Promise<RunExit>(resolve => { this.resolveDone = resolve; });
    this.stragglers = new Promise<string[]>(resolve => { this.setStragglers = resolve; });
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the handle's methods close over the run
    const run = this;
    this.handle = {
      runId: spec.runId,
      get interactive() {
        return run.pty && !run.ended;
      },
      onOutput: fn => run.subscribe(fn),
      input: bytes => run.input(bytes),
      typedLines: () => run.typedLines(),
      forgetTyped: () => {
        run.typed = [];
        run.typing = "";
        run.typedBytes = 0;
      },
      stop: why => run.stop(why),
      done: this.done,
      secretSpans: () => run.tracker.spans(),
      stragglers: this.stragglers,
    };
  }

  /** Checks, reads the facts (which may start the distro) and spawns. Never throws. */
  begin(): void {
    void this.prepare().catch(err => this.end({ ended: "failed-to-start", error: plain(err) }));
  }

  private async prepare(): Promise<void> {
    const { spec, d } = this;
    if (!/^[0-9a-f]{16}$/.test(spec.runId)) throw new Error("the run had no proper id");
    await this.r.usable();
    if (this.stopWhy) return;
    const exe = d.exe();
    if (!exe) throw new Error("WSL isn't installed");
    // Fail closed: without the job host nothing could stop wsl.exe's interop children or survive Ember's crash.
    if (!d.jobHost) throw new Error("Ember's job host is missing from this install, so it can't run commands in WSL");
    const { facts, lines } = await this.r.factsAndLines();
    if (this.stopWhy || this.ended) return;
    if (!lines.base64) throw new Error(`Ember needs base64 (coreutils) in ${d.distro} to pass commands to it`);
    const launch = wslLaunch(spec, facts, { exe, distro: d.distro, jobHost: d.jobHost, env: d.env });
    if (launch.pty !== this.pty) {
      this.pty = launch.pty;
      this.tracker = (d.trackSecrets ?? trackSecretPrompts)({ interactive: this.pty });
    }
    // A stopped distro is started first with a no-op, so a Stop while it boots ends the run before the command is
    // handed to wsl.exe at all ("Starting Ubuntu…" meanwhile).
    if (!d.isRunning() && !(await d.runningNow()).has(d.distro)) {
      if (this.stopWhy || this.ended) return;
      const boot = await this.r.boot();
      if (this.stopWhy || this.ended) return;
      if (!boot) throw new Error(`${d.distro} didn't start`);
    }
    // A Stop or the kill switch while the running set was read (the distro already ran) has ended this run: the
    // command must never be handed to wsl.exe after that, where nothing could stop it any more.
    if (this.stopWhy || this.ended) return;
    const child = d.spawn(launch.command, launch.args, { ...WSL_SPAWN_OPTIONS, env: launch.env });
    this.child = child;
    d.log.info("wsl.run_started", { distro: d.distro, runId: spec.runId, pty: launch.pty });
    child.stdin?.on("error", () => undefined); // EPIPE after wsl.exe ended: the exit says what happened
    child.stdout?.on("data", b => this.data("out", b));
    child.stderr?.on("data", b => this.data("err", b));
    child.on("error", err => {
      if (!this.exited) this.end({ ended: "failed-to-start", error: `couldn't start WSL (${err.message})` });
    });
    child.on("exit", (code, signal) => {
      this.exited = { code, signal };
      this.timers.push(setTimeout(() => this.finish(), 1_000));
    });
    child.on("close", (code, signal) => {
      if (!this.exited) this.exited = { code, signal };
      this.finish();
    });
    if (spec.timeoutMs > 0) this.timers.push(setTimeout(() => this.stop("timeout"), spec.timeoutMs));
  }

  private data(stream: "out" | "err", chunk: Buffer): void {
    if (this.ended) return;
    if (this.started) {
      this.emit(chunk);
      return;
    }
    const h = this.held;
    if (stream === "err") {
      if (h.errBytes < HOLD_MAX) h.err.push(chunk);
      h.errBytes += chunk.length;
      return;
    }
    // Only the latest HOLD_MAX bytes are held: the marker is found even after unusual output before it.
    h.out.push(chunk);
    h.outBytes += chunk.length;
    while (h.outBytes > HOLD_MAX && h.out.length > 1) h.outBytes -= h.out.shift()!.length;
    const out = Buffer.concat(h.out);
    if (out.indexOf(START_MARKER) < 0) return;
    this.started = true;
    // wsl.exe's own warnings before the start (UTF-16LE from an inbox wsl.exe) are shown decoded, then the output.
    const warnings = decodeMessage(Buffer.concat(h.err), 2_000);
    h.out = [];
    h.err = [];
    if (warnings) this.emit(Buffer.from(`${warnings}\r\n`, "utf8"));
    this.emit(out);
    // A Stop that came while the command was starting: the ladder begins now that there is something to stop.
    if (this.stopWhy && !this.ladder && !this.exited) this.climb();
  }

  private emit(chunk: Buffer): void {
    this.outBytes += chunk.length;
    if (this.headBytes < KEEP_HEAD) {
      this.keptHead.push(chunk);
      this.headBytes += chunk.length;
    } else {
      this.keptTail.push(chunk);
      this.tailBytes += chunk.length;
      while (this.tailBytes > KEEP_ALL - KEEP_HEAD && this.keptTail.length > 1) this.tailBytes -= this.keptTail.shift()!.length;
    }
    this.tracker.output(this.decoder.decode(chunk, { stream: true }));
    for (const fn of this.subscribers) {
      try {
        fn(chunk);
      } catch (err) {
        this.d.log.warn("wsl.output_listener_failed", { err });
      }
    }
  }

  private subscribe(fn: (chunk: Uint8Array) => void): () => void {
    for (const c of [...this.keptHead, ...this.keptTail]) fn(c);
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** The user's typing (the command window's own page only): to the PTY, and remembered in memory only (L2). */
  private input(bytes: Uint8Array): void {
    if (!this.pty || this.ended || !this.child?.stdin || this.exited) return;
    try {
      this.child.stdin.write(bytes);
    } catch {
      return; // wsl.exe is ending: the typing has nowhere to go
    }
    const text = new TextDecoder("utf-8").decode(bytes);
    // eslint-disable-next-line no-control-regex -- terminal answers (cursor reports, device attributes) aren't typing
    const plainText = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]?/g, "");
    for (const c of plainText) {
      if (c === "\r" || c === "\n") {
        if (this.typing) this.typed.push(this.typing);
        this.typing = "";
        this.tracker.enter();
      } else if (c === "\x7f" || c === "\b") {
        this.typing = this.typing.slice(0, -1);
      } else if (c >= " " && this.typedBytes < TYPED_MAX) {
        this.typing += c;
        this.typedBytes += c.length;
      }
    }
  }

  private typedLines(): string[] {
    return this.typing ? [...this.typed, this.typing] : [...this.typed];
  }

  /** Stop, the kill switch or the time limit: the WSL ladder once the command runs (step 1 synchronously). */
  stop(why: "user" | "task" | "killswitch" | "timeout"): void {
    if (this.ended || this.stopWhy) return;
    this.stopWhy = why;
    if (!this.child) {
      // Still checking, reading facts or starting the distro: it never spawns.
      this.end({ ended: ENDED[why] });
      return;
    }
    this.d.log.info("wsl.run_stopping", { distro: this.d.distro, runId: this.spec.runId, why, started: this.started });
    if (!this.started && !this.exited) {
      // Nothing to interrupt yet, and wsl.exe is held; a launcher that is already there is killed before it can run
      // the command (it carries EMBER_RUN_ID from its start), now and again until the command starts or time is up.
      const runId = this.spec.runId;
      const early = () => {
        if (!this.started && !this.exited && !this.ended) void this.r.sweep("KILL", runId);
      };
      early();
      for (let t = PRESTART_SWEEP_MS; t < PRESTART_STOP_MS; t += PRESTART_SWEEP_MS) this.timers.push(setTimeout(early, t));
      this.timers.push(setTimeout(() => this.neverStarted(), PRESTART_STOP_MS));
      return;
    }
    this.climb();
  }

  /** A stopped run whose command never started: wsl.exe ends, and sweeps catch a launcher that starts late. */
  private neverStarted(): void {
    if (this.started || this.exited || !this.child) return;
    const runId = this.spec.runId;
    void this.r.sweep("KILL", runId);
    try {
      this.child.kill();
    } catch {
      // it ended by itself in the meantime
    }
    this.timers.push(setTimeout(() => void this.r.sweep("KILL", runId), LADDER_MS.last));
    this.timers.push(setTimeout(() => {
      if (this.exited || !this.stopWhy) return;
      this.d.log.error("wsl.run_unkillable", { distro: this.d.distro, runId });
      this.end({ ended: ENDED[this.stopWhy] });
    }, LADDER_MS.last + UNKILLABLE_MS));
  }

  /** The WSL ladder (§3.13). Step 1 is sent synchronously (the kill switch's 300 ms budget). */
  private climb(): void {
    const child = this.child, why = this.stopWhy;
    if (!child || !why || this.ladder) return;
    const runId = this.spec.runId;
    if (this.pty && !this.exited) {
      try {
        child.stdin?.write("\x03");
      } catch {
        // wsl.exe is ending anyway: the sweeps below still run
      }
    } else {
      void this.r.sweep("INT", runId);
    }
    this.ladder = new Promise<void>(resolve => {
      this.timers.push(setTimeout(() => void this.r.sweep("TERM", runId), LADDER_MS.term));
      this.timers.push(setTimeout(() => {
        const killSweep = this.r.sweep("KILL", runId);
        // wsl.exe is never killed before the KILL sweep has run (critique wsl-16), nor held up by a slow one.
        void Promise.race([killSweep, new Promise(r => setTimeout(r, KILL_SWEEP_WAIT_MS))]).then(() => {
          if (!this.exited) {
            try {
              child.kill();
            } catch {
              // it ended by itself in the meantime
            }
          }
        });
      }, LADDER_MS.kill));
      this.timers.push(setTimeout(() => {
        void this.r.sweep("KILL", runId).then(names => {
          this.setStragglers(names);
          if (names.length) this.d.log.warn("commands.straggler", { distro: this.d.distro, runId, count: names.length });
          resolve();
          // A job host that outlives TerminateProcess can't hold the run open: it ends as stopped all the same.
          this.timers.push(setTimeout(() => {
            if (this.exited) return;
            this.d.log.error("wsl.run_unkillable", { distro: this.d.distro, runId });
            this.end({ ended: ENDED[why] });
          }, UNKILLABLE_MS));
        });
      }, LADDER_MS.last));
    });
  }

  /** wsl.exe ended (its output read): the run's exit. */
  private finish(): void {
    if (this.ended || !this.exited) return;
    const { code, signal } = this.exited;
    if (!this.started && this.stopWhy && !this.ladder) {
      // Stopped before its command started: nothing ran; a last sweep catches a launcher that started late.
      this.end({ ended: ENDED[this.stopWhy], code, signal });
      void this.r.sweep("KILL", this.spec.runId);
      return;
    }
    if (!this.started && !this.stopWhy) {
      const err = Buffer.concat(this.held.err), out = Buffer.concat(this.held.out);
      let why = decodeMessage(err) || decodeMessage(out);
      if (code === JOB_FAILED && /^job\b/.test(decodeWsl(err).trim())) why = "Ember couldn't put the command in its job object, so it didn't run it";
      this.end({ ended: "failed-to-start", code, signal, error: why || `WSL ended (code ${code ?? "none"}) before the command started` });
      return;
    }
    const exit: Partial<RunExit> & { ended: RunExit["ended"] } = { ended: this.stopWhy ? ENDED[this.stopWhy] : "exit", code, signal };
    if (this.ladder) {
      // Done once the last sweep has named what outlived the run (at most its own time limit later).
      void this.ladder.then(() => this.end(exit));
      this.exitedQuietly();
      return;
    }
    this.end(exit);
    // A natural end: report (without waiting) anything still carrying the run's marker; nothing is killed. Only while
    // the distro still runs: a command that shut it down (`poweroff`, `wsl.exe --terminate` through interop) leaves
    // nothing behind, and a sweep would start it again.
    void (async () => {
      if (!(await this.d.runningNow()).has(this.d.distro)) return this.setStragglers([]);
      const names = await this.r.sweep("0", this.spec.runId);
      this.setStragglers(names);
      if (names.length) this.d.log.warn("commands.straggler", { distro: this.d.distro, runId: this.spec.runId, count: names.length });
    })().catch(err => {
      this.setStragglers([]);
      this.d.log.warn("wsl.straggler_check_failed", { distro: this.d.distro, err });
    });
  }

  /** The process is gone: stop holding its stdin (the job host then ends its job; the ladder's sweeps go on). */
  private exitedQuietly(): void {
    try {
      this.child?.stdin?.end();
    } catch {
      // already closed
    }
  }

  private end(e: Partial<RunExit> & { ended: RunExit["ended"] }): void {
    if (this.ended) return;
    this.ended = true;
    // Nothing more is looked for unless a natural end's look is under way (it says). A ladder has said by now when it
    // ended the run; one cut short (wsl.exe failed meanwhile) loses its timers below, so it would never say.
    if (this.ladder || e.ended !== "exit") this.setStragglers([]);
    for (const t of this.timers) clearTimeout(t);
    this.exitedQuietly();
    const exit: RunExit = { code: e.code ?? null, signal: e.signal ?? null, ended: e.ended, ms: Math.max(0, this.r.now() - this.t0), ...(e.error ? { error: e.error } : {}) };
    this.d.log.info("wsl.run_ended", { distro: this.d.distro, runId: this.spec.runId, ended: exit.ended, code: exit.code, ms: exit.ms, outBytes: this.outBytes });
    this.resolveDone(exit);
  }
}

/** An error as plain words (the message of one Ember made; a generic sentence otherwise). */
function plain(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "WSL couldn't start the command";
}
