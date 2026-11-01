/**
 * Whether Windows PowerShell may run Ember's accessibility helper (the UI Automation bridge, sidecar/uia), from
 * facts, never from the wording of an error: an administrator's Constrained Language Mode (__PSLockdownPolicy, or the
 * helper's own report), a Group Policy execution policy (HKLM, then HKCU, SOFTWARE\Policies\Microsoft\Windows\
 * PowerShell: EnableScripts and ExecutionPolicy, which override the bridge's `-ExecutionPolicy Bypass`), and whether
 * Ember's two helper files carry the Mark-of-the-Web (a Zone.Identifier stream, which a RemoteSigned policy refuses).
 * Ember never bypasses any of these. The one fix it offers, "Unblock it", removes the mark from exactly those two files
 * (what Unblock-File does), only when the user presses it, and only in the RemoteSigned case: under AllSigned,
 * Restricted or Constrained Language Mode unblocking can't help, so it refuses.
 */

import fs from "node:fs";
import path from "node:path";
import type { HelperStatus } from "../../types";
import type { Win32SysApi } from "./ffi";
import { envValue } from "./interim";
import { HKEY, readDword, readString } from "./registry";

export const POWERSHELL_POLICY_KEY = "SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell";
/** Ember's accessibility helper: the PowerShell bootstrap and the C# it compiles. */
export const HELPER_FILES = ["ember_uia.ps1", "ember_uia.cs"] as const;
/** How long the registry and file facts are kept (readEnvironment runs on every settings-window status request). */
export const FACTS_MS = 60_000;

/** The PowerShell state the environment check reports (EnvInputs.windows.powershell). */
export type PowerShellState = "full" | "constrained" | "policy" | "blocked-download" | "missing" | "unknown";

/** A Group Policy execution policy, when one applies (machine policy wins over user policy). */
export interface ExecutionPolicyGpo { scope: "machine" | "user"; enableScripts: number; executionPolicy: string | null }

/** What decides the state, read from the system. */
export interface PowerShellFacts {
  /** __PSLockdownPolicy is set in Ember's environment (it is inherited by the bridge). */
  lockdown: boolean;
  /** The Group Policy execution policy, null when none is set or it can't be read. */
  gpo: ExecutionPolicyGpo | null;
  /** Ember's helper files that carry a Zone.Identifier stream. */
  marked: string[];
}

/** The Group Policy "Turn on Script Execution" setting: HKLM first, then HKCU; null when neither sets it. */
export function readExecutionPolicy(api: Win32SysApi | null): ExecutionPolicyGpo | null {
  if (!api) return null;
  for (const [hive, scope] of [[HKEY.LOCAL_MACHINE, "machine"], [HKEY.CURRENT_USER, "user"]] as const) {
    const enable = readDword(api, hive, POWERSHELL_POLICY_KEY, "EnableScripts");
    if (!enable.ok) continue;
    const policy = readString(api, hive, POWERSHELL_POLICY_KEY, "ExecutionPolicy", { maxBytes: 1024 });
    return { scope, enableScripts: enable.value, executionPolicy: policy.ok ? policy.value.trim() : null };
  }
  return null;
}

/** Does this policy refuse every unsigned script (scripts off, AllSigned or Restricted)? */
export function signedOnly(gpo: ExecutionPolicyGpo | null): boolean {
  if (!gpo) return false;
  if (gpo.enableScripts === 0) return true;
  return /^(allsigned|restricted)$/i.test(gpo.executionPolicy ?? "");
}

/** Does this policy refuse scripts that came from the internet (RemoteSigned)? */
export function remoteSignedOnly(gpo: ExecutionPolicyGpo | null): boolean {
  return !!gpo && gpo.enableScripts !== 0 && /^remotesigned$/i.test(gpo.executionPolicy ?? "");
}

/**
 * The state, first match wins (§9.8): Constrained Language Mode; a signed-only policy; RemoteSigned with a marked
 * helper file; then what the helper itself said (no answer yet → "unknown"; toolkitAccessibility false → "missing";
 * true → "full").
 */
export function powershellState(facts: PowerShellFacts, helper: HelperStatus | null | undefined): PowerShellState {
  if (facts.lockdown || helper?.languageMode === "ConstrainedLanguage") return "constrained";
  if (signedOnly(facts.gpo)) return "policy";
  if (remoteSignedOnly(facts.gpo) && facts.marked.length) return "blocked-download";
  if (!helper || helper.toolkitAccessibility === null) return "unknown";
  return helper.toolkitAccessibility ? "full" : "missing";
}

/** The folder holding Ember's helper files: resources\sidecar\uia packaged, <repo>\sidecar\uia in development. */
export function helperDir(o: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return path.win32.join(o.packaged ? o.resourcesPath : o.appPath, "sidecar", "uia");
}

/** The PowerShell facts, kept for FACTS_MS (fresh: read again now). */
export function powershellFacts(o: {
  api: () => Win32SysApi | null; env: NodeJS.ProcessEnv; dir: string; exists?: (p: string) => boolean; now?: () => number;
}): { get(fresh?: boolean): PowerShellFacts; forget(): void } {
  const exists = o.exists ?? fs.existsSync;
  const now = o.now ?? Date.now;
  let cached: { at: number; facts: PowerShellFacts } | null = null;
  const read = (): PowerShellFacts => {
    let gpo: ExecutionPolicyGpo | null;
    try {
      gpo = readExecutionPolicy(o.api());
    } catch {
      gpo = null; // unreadable: treated as no policy (the bridge then reports what really happened)
    }
    const marked = HELPER_FILES.map(f => path.win32.join(o.dir, f)).filter(p => {
      try { return exists(`${p}:Zone.Identifier`); } catch { return false; }
    });
    return { lockdown: !!envValue(o.env, "__PSLockdownPolicy"), gpo, marked };
  };
  return {
    get(fresh = false) {
      if (fresh || !cached || now() - cached.at >= FACTS_MS) cached = { at: now(), facts: read() };
      return cached.facts;
    },
    forget() {
      cached = null;
    },
  };
}

/**
 * The "Unblock it" fix: removes the Zone.Identifier stream of exactly Ember's two helper files, only while the state
 * really is "blocked-download" (read again now). Throws in plain words otherwise.
 */
export function unblockHelper(facts: PowerShellFacts, rm: (p: string) => void = p => fs.rmSync(p, { force: true })): void {
  if (facts.lockdown) throw new Error("Windows PowerShell is restricted on this computer, so unblocking Ember's accessibility helper wouldn't help. Ask your administrator.");
  if (signedOnly(facts.gpo)) throw new Error("Your organisation allows only signed PowerShell scripts, so unblocking Ember's accessibility helper wouldn't help. Ask your administrator.");
  if (!remoteSignedOnly(facts.gpo) || !facts.marked.length) throw new Error("Windows isn't blocking Ember's accessibility helper, so there is nothing to unblock.");
  for (const file of facts.marked) rm(`${file}:Zone.Identifier`);
}

/** PowerShell's own logging, set by Group Policy (the bridge's start-up is logged there; never what is on screen). */
export function powershellLogging(api: Win32SysApi | null): { module: boolean; transcription: boolean } {
  const on = (sub: string, value: string) => [HKEY.LOCAL_MACHINE, HKEY.CURRENT_USER].some(hive => {
    if (!api) return false;
    const r = readDword(api, hive, `${POWERSHELL_POLICY_KEY}\\${sub}`, value);
    return r.ok && r.value === 1;
  });
  return { module: on("ModuleLogging", "EnableModuleLogging"), transcription: on("Transcription", "EnableTranscripting") };
}
