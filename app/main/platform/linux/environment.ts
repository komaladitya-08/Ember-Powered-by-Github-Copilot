/**
 * The Linux setup-check inputs (SystemPlatform.environment): main.ts's readEnvironment and probeAccessibility,
 * moved here unchanged, so environment.ts sees exactly the inputs it always did. It runs on every settings-window
 * status request, so the slow probe (importing pyatspi) is asked again at most every 30 s while it is missing, and
 * then in the background (rp-1: a hung import froze every status read, the kill switch included, for 5 s).
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
export type ExecAsync = (cmd: string, args: string[], opts: { timeout: number }) => Promise<void>;

/** The real execFile, its output ignored. */
export const execAsync: ExecAsync = (cmd, args, opts) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: opts.timeout }, err => (err ? reject(err) : resolve()));
});

/** What the setup-check inputs are read from (tests pass fakes; Ember passes this process's environment). */
export interface LinuxEnvironmentDeps {
  env: NodeJS.ProcessEnv;
  /** Defaults: this process's. */
  platform?: string;
  arch?: string;
  versions?: EnvInputs["versions"];
  exec?: ExecSync;
  /** Looks for pyatspi in the background (accessibilityProbe); without one, every look waits, as before. */
  run?: ExecAsync;
  readFile?: (file: string) => string;
  /** process.report.getReport() (glibc's version). */
  report?: () => { header?: { glibcVersionRuntime?: string } } | undefined;
  now?: () => number;
}

/**
 * Is the GNOME accessibility switch on, and can the sidecar's Python import pyatspi? (One instance remembers pyatspi.)
 * With `run`, pyatspi is looked for in the background (rp-1): once as the probe is made (Ember starting, so the first
 * read usually has the answer), and again every 30 s while it is missing, a read returning what is known meanwhile.
 * Only a first read that comes before that answer imports it itself, as before, so the setup check (and `ember
 * doctor`) never shows a guess. `fresh`: the user asked to check again, so a missing pyatspi is looked for now, and
 * waited for, not only every 30 s.
 */
export function accessibilityProbe(d: { env: NodeJS.ProcessEnv; exec?: ExecSync; run?: ExecAsync; now?: () => number }): (fresh?: boolean) => { enabled: boolean | null; pyatspi: boolean } {
  const exec = d.exec ?? execSync;
  const now = d.now ?? Date.now;
  let pyatspiPresent: boolean | null = null;
  let pyatspiProbed = 0;
  let looking = false;
  const lookLater = (run: ExecAsync) => {
    looking = true;
    pyatspiProbed = now();
    void run(pickPython(d.env), ["-c", "import pyatspi"], { timeout: 5000 }).then(() => true, () => false).then(found => {
      looking = false;
      // A first read's own import may have found it meanwhile: a background look that timed out doesn't undo that.
      if (found || pyatspiPresent !== true) pyatspiPresent = found;
    });
  };
  if (d.run) lookLater(d.run);
  return (fresh = false) => {
    let enabled: boolean | null = null;
    try {
      const out = exec("gsettings", ["get", "org.gnome.desktop.interface", "toolkit-accessibility"], { encoding: "utf8", timeout: 2000 });
      enabled = out.trim() === "true";
    } catch { /* no gsettings (not GNOME) */ }
    // Asked again (at most every 30 s) while it is missing: the user may have just installed it.
    if (d.run && pyatspiPresent === false && !fresh && !looking && now() - pyatspiProbed > 30_000) lookLater(d.run);
    else if (pyatspiPresent === null || (!pyatspiPresent && (fresh || (!d.run && now() - pyatspiProbed > 30_000)))) {
      pyatspiProbed = now();
      try {
        exec(pickPython(d.env), ["-c", "import pyatspi"], { stdio: "ignore", timeout: 5000 });
        pyatspiPresent = true;
      } catch {
        pyatspiPresent = false;
      }
    }
    return { enabled, pyatspi: pyatspiPresent };
  };
}

/** SystemPlatform.environment on Linux: today's readEnvironment inputs, with the X display's state from `ctx.windows`. */
export function linuxEnvironment(d: LinuxEnvironmentDeps): (ctx: EnvContext) => EnvInputs {
  const platform = d.platform ?? process.platform;
  const probeAccessibility = accessibilityProbe(d);
  const readFile = d.readFile ?? (f => fs.readFileSync(f, "utf8"));
  const report = d.report ?? (() => process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined);
  return ctx => {
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
}
