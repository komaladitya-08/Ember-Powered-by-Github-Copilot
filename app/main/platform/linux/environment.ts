/**
 * The Linux setup-check inputs (SystemPlatform.environment): main.ts's readEnvironment and probeAccessibility,
 * moved here unchanged, so environment.ts sees exactly the inputs it always did. It runs on every settings-window
 * status request, so the slow probe (importing pyatspi) is asked again at most every 30 s while it is missing.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { EnvInputs } from "../../environment";
import type { EnvContext } from "../types";
import { pickPython } from "../../perception/sidecar";

/** execFileSync as these probes call it (injected in tests). */
export type ExecSync = (cmd: string, args: string[], opts: { encoding?: "utf8"; timeout: number; stdio?: "ignore" }) => string;

/** The real execFileSync, as text. */
export const execSync: ExecSync = (cmd, args, opts) => String(execFileSync(cmd, args, opts));

/** What the setup-check inputs are read from (tests pass fakes; Ember passes this process's environment). */
export interface LinuxEnvironmentDeps {
  env: NodeJS.ProcessEnv;
  /** Defaults: this process's. */
  platform?: string;
  arch?: string;
  versions?: EnvInputs["versions"];
  exec?: ExecSync;
  readFile?: (file: string) => string;
  /** process.report.getReport() (glibc's version). */
  report?: () => { header?: { glibcVersionRuntime?: string } } | undefined;
  now?: () => number;
}

/** Is the GNOME accessibility switch on, and can the sidecar's Python import pyatspi? (One instance remembers pyatspi.) */
export function accessibilityProbe(d: { env: NodeJS.ProcessEnv; exec?: ExecSync; now?: () => number }): () => { enabled: boolean | null; pyatspi: boolean } {
  const exec = d.exec ?? execSync;
  const now = d.now ?? Date.now;
  let pyatspiPresent: boolean | null = null;
  let pyatspiProbed = 0;
  return () => {
    let enabled: boolean | null = null;
    try {
      const out = exec("gsettings", ["get", "org.gnome.desktop.interface", "toolkit-accessibility"], { encoding: "utf8", timeout: 2000 });
      enabled = out.trim() === "true";
    } catch { /* no gsettings (not GNOME) */ }
    // Asked again (at most every 30 s) while it is missing: the user may have just installed it.
    if (pyatspiPresent === null || (!pyatspiPresent && now() - pyatspiProbed > 30_000)) {
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
      accessibility: platform === "linux" ? probeAccessibility() : undefined,
      // Set once Ember has tried the X display: whether it could open it (unknown without $DISPLAY, as before).
      x11: ctx.windows === undefined ? undefined : d.env.DISPLAY ? !!ctx.windows : undefined,
      shortcutsTaken: ctx.shortcutsTaken,
    };
  };
}
