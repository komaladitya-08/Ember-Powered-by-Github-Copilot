/**
 * Starting the accessibility helper inside a WSL distro (§4.3), and the doctor rows about it (§8.8). The helper is the
 * Linux sidecar itself (sidecar/atspi/ember_atspi.py, shipped in every install), run by the distro's own python3 with
 * EMBER_ATSPI_FIND_BUS=1, which makes it find the session bus the distro's Linux apps use before it reads anything.
 * Every child here is wsl.exe under Ember's job host (§3.3: it dies with Ember), started with a fixed argv; fixed
 * scripts go to /bin/sh on stdin, never on wsl.exe's argv (critique wsl-18), and nothing here ever boots a distro: the
 * router only asks this of a distro WSL says is running. Plain Node, no koffi.
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import wpath from "node:path/win32";
import ppath from "node:path/posix";
import type { OS } from "../../shared/shortcuts";
import type { CommandRunner, JobHostRef } from "../commands/types";
import type { Logger } from "../logger";
import { cleanEnv } from "../platform/compose";
import type { PlatformDoctorRow } from "../platform/types";
import { AtspiSidecar, type SidecarLaunch } from "../perception/sidecar";

/** What the router uses of a distro's sidecar (an AtspiSidecar; faked in tests). */
export type DistroSidecar = Pick<AtspiSidecar, "request" | "listWindows" | "readWindow" | "atPoint" | "secretFields" | "markSecret" | "readElement"
  | "canDo" | "doAction" | "setText" | "setValue" | "selectOption" | "listOptions" | "ownsId" | "stop"> & { readonly pid: number | null };

/** How a request to a new helper may wait: python3 and pyatspi starting cold (verify: ~1-2 s). */
export const HELPER_FIRST_REQUEST_MS = 15_000;
/** How long a fixed script (the path translation, the doctor's look) may take in a running distro. */
const SCRIPT_MS = 10_000;

/** Names (any case, as Windows keeps them) replaced in `env` by `vars`: no second spelling of WSLENV survives. */
function withVars(env: NodeJS.ProcessEnv, vars: Record<string, string>): NodeJS.ProcessEnv {
  const names = new Set(Object.keys(vars).map(k => k.toUpperCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!names.has(k.toUpperCase())) out[k] = v;
  return { ...out, ...vars };
}

/** wsl.exe with `args`, under the job host when there is one (its stdin relayed: the helper talks over it). */
function underJobHost(wslExe: string, args: string[], env: NodeJS.ProcessEnv, jobHost: JobHostRef | null): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (!jobHost) return { command: wslExe, args, env };
  return { command: jobHost.execPath, args: [jobHost.script, "--interactive", "--", wslExe, ...args], env: withVars(env, { ELECTRON_RUN_AS_NODE: "1" }) };
}

/** The environment wsl.exe gets: Ember's minus its secrets, UTF-8 messages, and only the id base crossing into Linux. */
export function helperEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return withVars(cleanEnv(env, { os: "win32" }), { WSL_UTF8: "1", WSLENV: "EMBER_ATSPI_ID_BASE/u" });
}

/**
 * The SidecarLaunch for `distro`'s helper (§4.3), exactly: wsl.exe -d <distro> --cd / --exec /usr/bin/env
 * EMBER_ATSPI_FIND_BUS=1 python3 -I <script>, under the job host, never a shell, never booting a distro (`mayStart`),
 * never revived on its own (`noRevive`, critique wsl-20). `python3 -I` keeps the script's folder and user
 * site-packages off sys.path and every PYTHON* variable out.
 */
export function helperLaunch(o: { wslExe: string; distro: string; scriptLinuxPath: string; env: NodeJS.ProcessEnv; jobHost: JobHostRef | null; mayStart: () => boolean }): SidecarLaunch {
  // Started in /: the inbox wsl.exe can't take --cd ~ (CI's WSL 1 runner), and the helper needs no folder.
  const args = ["-d", o.distro, "--cd", "/", "--exec", "/usr/bin/env", "EMBER_ATSPI_FIND_BUS=1", "python3", "-I", o.scriptLinuxPath];
  const run = underJobHost(o.wslExe, args, helperEnv(o.env), o.jobHost);
  return { command: run.command, args: run.args, env: run.env, firstRequestMs: HELPER_FIRST_REQUEST_MS, windowsHide: true, mayStart: o.mayStart, noRevive: true };
}

/** A spawn as this module uses it (node's; faked in tests). */
export type SpawnLike = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr" | "on" | "kill">;

/** Where a fixed script's input lines end (a line a Windows path, which has no line break, can never be). */
const INPUT_END = "EMBER_INPUT_END";

/**
 * What goes to `/bin/sh -s`: the script, with its `input` lines as a quoted here-document on its stdin (literal text:
 * never read as code, whatever they hold), then `exit`. Not as lines after the script: dash (Debian's and Ubuntu's
 * /bin/sh) reads its input ahead, so a `read` in the script would find nothing and the shell would run the line as a
 * command. `exit` ends the shell without waiting for the end of its input, which the job host holds open (its stdin
 * closing ends the job). null when a line can't be passed that way.
 */
export function fixedScriptStdin(script: string, input: readonly string[] = []): string | null {
  if (input.some(l => /[\r\n\0]/.test(l) || l === INPUT_END)) return null;
  const body = input.length ? `${script} <<'${INPUT_END}'\n${input.join("\n")}\n${INPUT_END}` : script;
  return `${body}\nexit\n`;
}

/**
 * A fixed script run by `/bin/sh -s` in a running distro, its text and `input` lines on stdin (fixedScriptStdin):
 * stdout's text, or null when it failed, timed out or wrote nothing. stdin stays open until the shell has finished.
 */
export function runFixedScript(o: { wslExe: string; distro: string; script: string; input?: string[]; env: NodeJS.ProcessEnv; jobHost: JobHostRef | null; spawn?: SpawnLike; timeoutMs?: number }): Promise<string | null> {
  // In the user's home, as §4.1's fixed scripts: never Ember's Windows folder translated (it may not be mounted).
  // wsl.exe starts the shell in / and the script goes home itself (runner.ts cdLine: --cd ~ fails on the inbox wsl.exe).
  const run = underJobHost(o.wslExe, ["-d", o.distro, "--cd", "/", "--exec", "/bin/sh", "-s"], helperEnv(o.env), o.jobHost);
  const text = fixedScriptStdin(`cd || exit 97\n${o.script}`, o.input);
  if (text === null) return Promise.resolve(null);
  return new Promise(resolve => {
    let child: ReturnType<SpawnLike>;
    try {
      child = (o.spawn ?? (nodeSpawn as unknown as SpawnLike))(run.command, run.args, { env: run.env, windowsHide: true, stdio: "pipe" } as SpawnOptionsWithoutStdio);
    } catch {
      resolve(null);
      return;
    }
    const out: Buffer[] = [];
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* already closed */ }
      resolve(v);
    };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(null); }, o.timeoutMs ?? SCRIPT_MS);
    child.stdout.on("data", (b: Buffer) => { if (out.reduce((n, x) => n + x.length, 0) < 65_536) out.push(b); });
    child.stderr.on("data", () => undefined);
    child.on("error", () => finish(null));
    // "close", not "exit": every byte of stdout has been read by then.
    child.on("close", (code: number | null) => finish(code === 0 && out.length ? Buffer.concat(out).toString("utf8") : null));
    child.stdin.on("error", () => undefined);
    child.stdin.write(text);
  });
}

/**
 * The fixed script translating the Windows path it is given as its one input line (never on argv, never a hard-coded
 * /mnt/c). §4.3's `IFS= read -r p; wslpath -a -u "$p"`, reading the line from its here-document (fixedScriptStdin).
 */
export const WSLPATH_SCRIPT = "{ IFS= read -r p; wslpath -a -u \"$p\"; }";

/** The script's path inside the distro: one absolute line of plain characters, else null (automount off, a failure). */
export function parseLinuxPath(out: string | null): string | null {
  const line = (out ?? "").replace(/\r?\n$/, "");
  return line.startsWith("/") && !/\p{Cc}/u.test(line) && ppath.isAbsolute(line) ? line : null;
}

/**
 * Where this install's ember_atspi.py is on the PC: the packaged resources' copy, else the source tree's (unpackaged
 * runs, beside dist/app), or null when neither is there (the doctor then says it is missing from this install).
 */
export function helperScriptPath(o: { resourcesPath?: string | null; appDir?: string | null; exists?: (p: string) => boolean }): string | null {
  const exists = o.exists ?? ((p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const tail = ["sidecar", "atspi", "ember_atspi.py"];
  const candidates = [o.resourcesPath ? wpath.join(o.resourcesPath, ...tail) : null, o.appDir ? wpath.resolve(o.appDir, "..", "..", ...tail) : null];
  return candidates.find((p): p is string => !!p && exists(p)) ?? null;
}

/** What each distro's helper can't do, as the doctor says it (§8.7, §8.8). */
export type HelperProblem = "missing" | "path" | "start" | "python3" | "pyatspi" | "bus" | "root" | "nowslg";

/** What `status` says inside a distro (the FIND_BUS additions of §4.3). */
export interface HelperStatusInfo {
  uid: number | null;
  wslg: boolean | null;
  bus: "env" | "proc" | "runtime" | "x11" | "none" | null;
  pyatspi: boolean | null;
  toolkitAccessibility: boolean | null;
}

/** The helper's `status` answer, read defensively (anything else is unknown, never "fine"). */
export function parseHelperStatus(v: unknown): HelperStatusInfo {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const bool = (x: unknown) => (typeof x === "boolean" ? x : null);
  const bus = typeof o.bus === "string" && ["env", "proc", "runtime", "x11", "none"].includes(o.bus) ? o.bus as HelperStatusInfo["bus"] : null;
  return { uid: Number.isSafeInteger(o.uid) && (o.uid as number) >= 0 ? o.uid as number : null, wslg: bool(o.wslg), bus, pyatspi: bool(o.pyatspi), toolkitAccessibility: bool(o.toolkitAccessibility) };
}

/** The doctor's look inside a running distro: fixed, read-only, on stdin. */
export const DIAG_SCRIPT = [
  "echo uid=$(id -u)",
  "[ -d /mnt/wslg ] && echo wslg=1 || echo wslg=0",
  "for m in apt-get dnf zypper pacman; do command -v $m >/dev/null 2>&1 && { echo pm=$m; break; }; done",
  "command -v python3 >/dev/null 2>&1 && echo python3=1 || { echo python3=0; exit 0; }",
  "python3 -I -c 'import importlib.util as u,sys; sys.exit(0 if u.find_spec(\"pyatspi\") else 1)' >/dev/null 2>&1 && echo pyatspi=1 || echo pyatspi=0",
  "command -v gsettings >/dev/null 2>&1 && echo a11y=$(gsettings get org.gnome.desktop.interface toolkit-accessibility 2>/dev/null)",
  // (A distro without gsettings is a finding, not a failed look.)
  "exit 0",
].join("\n");

/** What DIAG_SCRIPT found. */
export interface HelperDiag { uid: number | null; wslg: boolean | null; python3: boolean | null; pyatspi: boolean | null; a11y: boolean | null; pm: "apt-get" | "dnf" | "zypper" | "pacman" | null }

export function parseDiag(out: string | null): HelperDiag | null {
  if (out === null) return null;
  const kv = new Map(out.split(/\r?\n/).map(l => /^([a-z0-9]+)=(.*)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m).map(m => [m[1], m[2].trim()]));
  const flag = (k: string) => (kv.get(k) === "1" ? true : kv.get(k) === "0" ? false : null);
  const uid = kv.has("uid") && /^\d+$/.test(kv.get("uid")!) ? Number(kv.get("uid")) : null;
  const a11y = kv.get("a11y") === "true" ? true : kv.get("a11y") === "false" ? false : null;
  const pm = kv.get("pm");
  return { uid, wslg: flag("wslg"), python3: flag("python3"), pyatspi: flag("pyatspi"), a11y, pm: pm === "apt-get" || pm === "dnf" || pm === "zypper" || pm === "pacman" ? pm : null };
}

/** The install command for the accessibility packages, by the distro's package manager (Debian/Ubuntu's by default). */
function a11yPackages(pm: HelperDiag["pm"]): string {
  switch (pm) {
    case "dnf": return "sudo dnf install python3-pyatspi at-spi2-core";
    case "zypper": return "sudo zypper install python3-pyatspi at-spi2-core";
    case "pacman": return "sudo pacman -S python-atspi at-spi2-core";
    default: return "sudo apt install python3-pyatspi at-spi2-core";
  }
}

/** The command that installs Python 3, by package manager. */
function pythonPackage(pm: HelperDiag["pm"]): string {
  switch (pm) {
    case "dnf": return "sudo dnf install python3";
    case "zypper": return "sudo zypper install python3";
    case "pacman": return "sudo pacman -S python";
    default: return "sudo apt install python3";
  }
}

/** The plain words for a problem in `distro` (§8.7). */
export function problemWords(p: HelperProblem, distro: string, pm: HelperDiag["pm"] = null): string {
  switch (p) {
    case "missing": return "Missing from this install: reinstall Ember.";
    case "path": return `Ember can't reach its helper from ${distro}: Windows drives aren't mounted there, so Linux apps in ${distro} can't be read.`;
    case "start": return `Ember's helper couldn't start in ${distro}, so Ember can't read Linux apps there.`;
    case "python3": return `To read Linux apps in ${distro}, install Python 3 there (\`${pythonPackage(pm)}\`), then reopen your Linux apps.`;
    case "pyatspi": return `To read Linux apps in ${distro}, install the accessibility packages there: \`${a11yPackages(pm)}\`, then reopen your Linux apps.`;
    case "bus": return `Ember can't find the session bus your Linux apps use in ${distro}, so it can't read them. Commands in ${distro} still work.`;
    case "root": return "Ember doesn't use Linux apps of a distro that runs as root.";
    case "nowslg": return "Update WSL to use Linux apps with Ember: run `wsl --update` in PowerShell.";
  }
}

/**
 * The doctor's rows for one running distro (§8.8): `wsl-helper:<distro>` (can its Linux apps be read, else why) and,
 * where gsettings answers, `wsl-a11y:<distro>` (toolkit accessibility, with its fix). `diag` is the doctor's own look
 * inside (null: it couldn't run); `known` what the router's helper last found there.
 */
export function helperDoctorRows(distro: string, o: { missing: boolean; diag: HelperDiag | null; known: { problem: HelperProblem | null; status: HelperStatusInfo | null } | null }): PlatformDoctorRow[] {
  const label = `Linux apps in ${distro}`;
  const helper = (status: PlatformDoctorRow["status"], detail: string): PlatformDoctorRow => ({ id: `wsl-helper:${distro}`, status, label, detail });
  const d = o.diag, pm = d?.pm ?? null;
  const rows: PlatformDoctorRow[] = [];
  const problem: HelperProblem | null = o.missing ? "missing"
    : d?.uid === 0 || o.known?.status?.uid === 0 || o.known?.problem === "root" ? "root"
      : d?.wslg === false ? "nowslg"
        : d?.python3 === false ? "python3"
          : d?.pyatspi === false || o.known?.status?.pyatspi === false ? "pyatspi"
            : o.known?.problem ?? (o.known?.status?.bus === "none" ? "bus" : null);
  if (problem) rows.push(helper(problem === "missing" ? "fail" : "warn", problemWords(problem, distro, pm)));
  else if (!d && !o.known?.status) rows.push(helper("warn", `Ember couldn't look inside ${distro} just now.`));
  else rows.push(helper("ok", `Ember can read Linux apps in ${distro}`));
  const a11y = o.known?.status?.toolkitAccessibility ?? d?.a11y ?? null;
  if (a11y !== null && problem !== "missing" && problem !== "root") {
    rows.push(a11y
      ? { id: `wsl-a11y:${distro}`, status: "ok", label: `Accessibility in ${distro}`, detail: `Linux apps in ${distro} share their controls` }
      : { id: `wsl-a11y:${distro}`, status: "warn", label: `Accessibility in ${distro}`, detail: `Linux apps in ${distro} don't share their controls (toolkit accessibility is off)`, fix: `Turn on accessibility for Linux apps in ${distro}` });
  }
  return rows;
}

/**
 * The `wsl-a11y` fix: Ember's own fixed command through the distro's command runner (§4.3), only where gsettings and a
 * dconf backend that keeps the value exist (it is read back in a new process: GSettings' memory backend would forget
 * it). Never a command the model wrote; asked for by the user's click on the doctor's fix button.
 */
export const A11Y_FIX_COMMAND = "command -v gsettings >/dev/null 2>&1 || exit 3; "
  + "gsettings set org.gnome.desktop.interface toolkit-accessibility true || exit 4; "
  + "[ \"$(gsettings get org.gnome.desktop.interface toolkit-accessibility)\" = true ] || exit 5";

/** Runs the fix in `distro` and says what came of it. */
export async function turnOnLinuxAccessibility(runner: CommandRunner, distro: string): Promise<{ ok: boolean; message: string }> {
  try {
    const facts = await runner.facts();
    const shell = facts.shells.includes("sh") ? "sh" : facts.shells[0];
    if (!shell) return { ok: false, message: `Ember can't run its fix in ${distro}: it has no shell Ember can use.` };
    const taskId = "doctor";
    const sha256 = createHash("sha256").update(`${runner.target}\0${shell}\0${facts.home}\0${A11Y_FIX_COMMAND}`).digest("hex");
    const run = runner.start({
      runId: randomBytes(8).toString("hex"), taskId, shell, command: A11Y_FIX_COMMAND, cwd: facts.home, timeoutMs: 20_000, cols: 120, rows: 30,
      stamp: { taskId, sha256, verdict: "run", classes: [], rules: [], approval: null },
    });
    const exit = await run.done;
    if (exit.ended === "exit" && exit.code === 0) return { ok: true, message: "Restart your Linux apps." };
    if (exit.code === 3) return { ok: false, message: `Ember can't turn it on: ${distro} has no gsettings.` };
    if (exit.code === 4 || exit.code === 5) return { ok: false, message: `Ember can't turn it on: ${distro} doesn't keep settings (no dconf).` };
    return { ok: false, message: exit.error ?? `Ember couldn't turn on accessibility in ${distro}.` };
  } catch (err) {
    return { ok: false, message: `Ember couldn't turn on accessibility in ${distro} (${err instanceof Error ? err.message : String(err)}).` };
  }
}

/** Everything the router needs to start helpers (defaults: this process's; tests pass their own). */
export interface HelperFactoryDeps {
  os: OS;
  log: Logger;
  /** ember_atspi.py on the PC, or null when this install hasn't got it. */
  script: () => string | null;
  jobHost: JobHostRef | null;
  env: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  /** Makes the sidecar for a launch (default: an AtspiSidecar). */
  sidecar?: (launch: SidecarLaunch, log: Logger) => DistroSidecar;
}

/** Starts helpers: the path translation once per distro, then a sidecar with the exact launch. */
export interface HelperFactory {
  /** A new sidecar for `distro` (not started: its first request starts it, if `mayStart` says so), or why not. */
  create(distro: string, wslExe: string, mayStart: () => boolean): Promise<DistroSidecar | { problem: HelperProblem }>;
  /** The doctor's look inside a running distro. */
  diag(distro: string, wslExe: string): Promise<HelperDiag | null>;
  /** Is ember_atspi.py in this install? */
  present(): boolean;
}

export function helperFactory(d: HelperFactoryDeps): HelperFactory {
  const linuxPaths = new Map<string, string>();
  return {
    present: () => d.script() !== null,
    async create(distro, wslExe, mayStart) {
      const script = d.script();
      if (!script) return { problem: "missing" };
      let linux = linuxPaths.get(distro);
      if (!linux) {
        const out = await runFixedScript({ wslExe, distro, script: WSLPATH_SCRIPT, input: [script], env: d.env, jobHost: d.jobHost, spawn: d.spawn });
        const p = parseLinuxPath(out);
        if (!p) return { problem: "path" };
        linux = p;
        linuxPaths.set(distro, p);
      }
      const launch = helperLaunch({ wslExe, distro, scriptLinuxPath: linux, env: d.env, jobHost: d.jobHost, mayStart });
      const log = d.log.child(`helper-${distro}`);
      return d.sidecar ? d.sidecar(launch, log) : new AtspiSidecar("", log, undefined, undefined, launch);
    },
    async diag(distro, wslExe) {
      return parseDiag(await runFixedScript({ wslExe, distro, script: DIAG_SCRIPT, env: d.env, jobHost: d.jobHost, spawn: d.spawn }));
    },
  };
}
