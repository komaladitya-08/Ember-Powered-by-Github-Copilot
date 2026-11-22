/**
 * The Linux setup-check inputs (SystemPlatform.environment): main.ts's readEnvironment and probeAccessibility,
 * gathered off the main thread: a status read never waits for Python or the session bus (rp-1, reliability-c7-1).
 * A pending look is shown as checking, never as missing or ready; Check again and the doctor can await it.
 */

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import type { EnvInputs } from "../../environment";
import type { EnvContext } from "../types";
import { pickPython } from "../../perception/sidecar";

/** execFileSync as these probes call it (injected in tests). */
export type ExecSync = (cmd: string, args: string[], opts: { encoding?: "utf8"; timeout: number; stdio?: "ignore" }) => string;

/** The real execFileSync, as text. */
export const execSync: ExecSync = (cmd, args, opts) => String(execFileSync(cmd, args, opts));

/** A command run off the main thread: resolves when it exits with 0, rejects otherwise (injected in tests). */
export type ExecAsync = (cmd: string, args: string[], opts: { timeout: number }) => Promise<string | void>;

/** The real execFile, returning stdout for the GNOME switch and discarding it for the Python import. */
export const execAsync: ExecAsync = (cmd, args, opts) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: opts.timeout, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/** What the setup-check inputs are read from (tests pass fakes; Ember passes this process's environment). */
export interface LinuxEnvironmentDeps {
  env: NodeJS.ProcessEnv;
  /** Defaults: this process's. */
  platform?: string;
  arch?: string;
  versions?: EnvInputs["versions"];
  exec?: ExecSync;
  /** Runs the accessibility checks off the main thread; defaults to execAsync. */
  run?: ExecAsync;
  readFile?: (file: string) => string;
  /** process.report.getReport() (glibc's version). */
  report?: () => { header?: { glibcVersionRuntime?: string } } | undefined;
  now?: () => number;
}

/** The cached setup-check inputs, and an awaitable fresh look for Check again and the doctor. */
export interface AccessibilityProbe {
  (fresh?: boolean): { enabled: boolean | null; pyatspi: boolean | null; checking?: boolean };
  /** Joins an outstanding look, or starts a fresh one, without blocking the main event loop. */
  again(): Promise<void>;
}

/**
 * GNOME's accessibility switch and Python's bindings, checked on start and at most every 30 seconds thereafter.
 * Known bindings need no repeat import. Reads only return cached facts; a look still under way is explicitly checking.
 */
export function accessibilityProbe(d: { env: NodeJS.ProcessEnv; exec?: ExecSync; run?: ExecAsync; now?: () => number }): AccessibilityProbe {
  const run = d.run ?? execAsync;
  const now = d.now ?? (() => performance.now());
  let pyatspiPresent: boolean | null = null;
  let enabled: boolean | null = null;
  let checkedAt = 0;
  let looking: Promise<void> | null = null;
  const look = (): Promise<void> => {
    if (looking) return looking;
    checkedAt = now();
    // Defer even an injected runner: synchronous spawn failures are a failed check, never an exception from a read.
    const switchLook = Promise.resolve().then(() => run("gsettings", ["get", "org.gnome.desktop.interface", "toolkit-accessibility"], { timeout: 2000 }))
      .then(out => { enabled = typeof out === "string" && /^(true|false)$/.test(out.trim()) ? out.trim() === "true" : null; }, () => { enabled = null; });
    const pythonLook = pyatspiPresent === true ? Promise.resolve() : Promise.resolve()
      .then(() => run(pickPython(d.env), ["-c", "import pyatspi"], { timeout: 5000 }))
      .then(() => { pyatspiPresent = true; }, () => { pyatspiPresent = false; });
    looking = Promise.all([switchLook, pythonLook]).then(() => { looking = null; });
    return looking;
  };
  void look();
  const read = () => {
    if (!looking && now() - checkedAt > 30_000) void look();
    return { enabled, pyatspi: pyatspiPresent, ...(looking ? { checking: true } : {}) };
  };
  return Object.assign(read, { again: look });
}

/**
 * SystemPlatform.environment on Linux: today's readEnvironment inputs, with the X display's state from `ctx.windows`;
 * `again` is SystemPlatform.lookAgain (Check again's background look).
 */
export function linuxEnvironment(d: LinuxEnvironmentDeps): ((ctx: EnvContext) => EnvInputs) & { again(): Promise<void> } {
  const platform = d.platform ?? process.platform;
  const probeAccessibility = accessibilityProbe(d);
  const readFile = d.readFile ?? (f => fs.readFileSync(f, "utf8"));
  const report = d.report ?? (() => process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined);
  const read = (ctx: EnvContext): EnvInputs => {
    let osRelease: string | null = null;
    try { osRelease = readFile("/etc/os-release"); } catch { /* not Linux */ }
    const header = report()?.header;
    return {
      env: d.env,
      osRelease,
      glibc: header?.glibcVersionRuntime ?? null,
      versions: d.versions ?? { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      platform,
      arch: d.arch ?? process.arch,
      accessibility: platform === "linux" ? probeAccessibility(ctx.fresh === true) : undefined,
      // Set once Ember has tried the X display: whether it could open it (unknown without $DISPLAY, as before).
      x11: ctx.windows === undefined ? undefined : d.env.DISPLAY ? !!ctx.windows : undefined,
      shortcutsTaken: ctx.shortcutsTaken,
    };
  };
  return Object.assign(read, { again: () => (platform === "linux" ? probeAccessibility.again() : Promise.resolve()) });
}
