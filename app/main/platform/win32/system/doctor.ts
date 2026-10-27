/**
 * The Windows rows of `ember --doctor` (§9.9): microphone privacy, running as administrator, whether PowerShell may
 * run Ember's accessibility helper, PowerShell's own logging (the helper's start-up is logged there, never what is on
 * screen; G2), and the helper's exact command line, script and compiled DLL with its SHA-256, so an administrator can
 * allow-list them in an EDR product (R8). Microphones aren't listed (that needs a renderer: the settings window tests
 * the microphone), Chromium speaks through Windows' own voices, and the Linux-only rows (sandbox, inotify, the desk)
 * are left out.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { powershellPath } from "../../../../sidecar-host/providers/uia";
import { WINDOWS_MIC_PATH } from "../../../environment";
import type { AppLike, PlatformDoctorProbes, PlatformDoctorRow, SystemPreferencesLike } from "../../types";
import type { Win32SysApi } from "./ffi";
import { HELPER_FILES, powershellLogging, powershellState, type PowerShellFacts } from "./powershell";

/** The bridge's arguments, as port/host's UiaProvider passes them (app/sidecar-host/providers/uia.ts). */
export const BRIDGE_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"] as const;

/** What the setup check and the doctor say about PowerShell (§9.8). */
export const POWERSHELL_TEXT = {
  constrained: "Windows PowerShell is restricted on this computer (Constrained Language Mode), so Ember can't read apps. Ask your administrator to allow Ember's accessibility helper.",
  policy: "Your organisation allows only signed PowerShell scripts, and Ember's accessibility helper isn't signed, so Ember can't read apps. Ask your administrator to allow it.",
  "blocked-download": "Windows blocked Ember's accessibility helper because it came from the internet.",
} as const;

export const ELEVATED_TEXT = "Ember is running as administrator: start it normally so it can't act with administrator rights by mistake.";

/** What the doctor's Windows probes need. */
export interface Win32DoctorDeps {
  env: NodeJS.ProcessEnv;
  api: () => Win32SysApi | null;
  powershell: { get(fresh?: boolean): PowerShellFacts };
  /** resources\sidecar\uia (packaged) or <repo>\sidecar\uia. */
  helperDir: string;
  app: Pick<AppLike, "getPath">;
  systemPreferences: Pick<SystemPreferencesLike, "getMediaAccessStatus">;
  readFile?: (p: string) => Buffer | null;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

/** The compiled helper the bridge loads: <userData>\uia-cache\ember_uia-<SHA-256 of ember_uia.cs>.dll, and its SHA-256. */
export function cachedHelper(o: { helperDir: string; userData: string; readFile: (p: string) => Buffer | null }): { dll: string; sha256: string | null } | null {
  const source = o.readFile(path.win32.join(o.helperDir, "ember_uia.cs"));
  if (!source) return null;
  const dll = path.win32.join(o.userData, "uia-cache", `ember_uia-${sha256(source)}.dll`);
  const bytes = o.readFile(dll);
  return { dll, sha256: bytes ? sha256(bytes) : null };
}

/** The helper's command line, script and DLL, for an administrator's allow-list. */
export function helperCommandRow(o: { env: NodeJS.ProcessEnv; helperDir: string; userData: string | null; readFile: (p: string) => Buffer | null }): PlatformDoctorRow {
  const script = path.win32.join(o.helperDir, HELPER_FILES[0]);
  const command = [quote(powershellPath(o.env)), ...BRIDGE_ARGS, quote(script)].join(" ");
  const cached = o.userData ? cachedHelper({ helperDir: o.helperDir, userData: o.userData, readFile: o.readFile }) : null;
  const dll = !cached ? "compiled helper: unknown (ember_uia.cs couldn't be read)"
    : cached.sha256 ? `compiled helper ${cached.dll} (SHA-256 ${cached.sha256})`
      : `compiled helper ${cached.dll} (not compiled yet: it is built the first time Ember reads an app)`;
  return { id: "helper-command", status: "ok", label: "Helper command line", detail: `${command} · script ${script} · ${dll}` };
}

/** The Windows doctor probes. */
export async function win32DoctorProbes(d: Win32DoctorDeps): Promise<PlatformDoctorProbes> {
  const readFile = d.readFile ?? ((p: string) => { try { return fs.readFileSync(p); } catch { return null; } });
  const api = d.api();
  const extra: PlatformDoctorRow[] = [];

  let mic: string | undefined;
  try {
    mic = d.systemPreferences.getMediaAccessStatus?.("microphone");
  } catch {
    mic = undefined;
  }
  extra.push(mic === "denied" || mic === "restricted"
    ? { id: "microphone-privacy", status: "warn", label: "Microphone privacy", detail: "Windows doesn't let Ember use the microphone, so “Hey Ember” can't hear you.", fix: `${WINDOWS_MIC_PATH} › Let desktop apps access your microphone` }
    : { id: "microphone-privacy", status: "ok", label: "Microphone privacy", detail: mic === "granted" ? "Desktop apps may use the microphone" : "Windows asks the first time Ember listens" });

  let elevated: boolean | null;
  try {
    elevated = api ? api.elevated() : null;
  } catch {
    elevated = null;
  }
  extra.push(elevated === true ? { id: "elevated", status: "warn", label: "Administrator", detail: ELEVATED_TEXT, fix: "Start Ember from the Start menu, not with “Run as administrator”." }
    : elevated === false ? { id: "elevated", status: "ok", label: "Administrator", detail: "Not running as administrator" }
      : { id: "elevated", status: "warn", label: "Administrator", detail: "Ember couldn't tell whether it runs as administrator." });

  // The helper's own answer is the separate "Accessibility helper" row: here only what the system says.
  const state = powershellState(d.powershell.get(true), undefined);
  extra.push(state === "constrained" || state === "policy" || state === "blocked-download"
    ? { id: "powershell", status: "warn", label: "PowerShell", detail: POWERSHELL_TEXT[state], ...(state === "blocked-download" ? { fix: "Press “Unblock it” in Ember's setup check (settings)." } : {}) }
    : { id: "powershell", status: "ok", label: "PowerShell", detail: "No policy stops Windows PowerShell from running Ember's accessibility helper" });

  const logging = powershellLogging(api);
  if (logging.module || logging.transcription) {
    extra.push({ id: "powershell-logging", status: "ok", label: "PowerShell logging", detail: "PowerShell logging is on: the accessibility helper's start-up is logged (never what is on screen)" });
  }

  let userData: string | null;
  try {
    userData = d.app.getPath("userData");
  } catch {
    userData = null;
  }
  extra.push(helperCommandRow({ env: d.env, helperDir: d.helperDir, userData, readFile }));

  return { microphones: null, speechDispatcher: true, sandbox: null, fileWatchers: null, desk: null, extra };
}
