/**
 * What Ember is allowed to do on this Mac, read the same way for the setup checks, their fixes and the doctor:
 * Accessibility (reading and using apps), Screen Recording (screenshots and other apps' window titles), Input
 * Monitoring (noticing the user take over the keyboard), the microphone, where Ember.app is, and whether it runs as
 * root. Every read is cheap (the settings window asks on each status request) and answers "not allowed" or "can't
 * tell" when it can't ask: the checks fail closed. Because an ad-hoc signature changes with every build, macOS keeps
 * showing an updated Ember switched on while it isn't trusted, so every permission's advice ends with REGRANT.
 */

import os from "node:os";
import type { AppLike, SystemPreferencesLike, WindowSystem } from "../../types";

/** The last sentence of every permission's advice (R9: macOS ties a permission to one exact copy of Ember): the setup checks' own. */
export { MAC_REGRANT as REGRANT } from "../../../environment";

/** System Settings panes, by the fix that opens them (`x-apple.systempreferences` URLs; verified on macOS 15 by I). */
export const PANES = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  inputMonitoring: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
} as const;

/** A media permission as Electron's getMediaAccessStatus answers it. */
export type MediaAccess = ReturnType<NonNullable<SystemPreferencesLike["getMediaAccessStatus"]>>;

/**
 * What MS reads from port/darwin's window system beyond the WindowSystem contract. accessibilityTrusted and
 * screenRecording are on the merged DarwinWindowSystem; the rest are FX-PD's additions, optional until it merges.
 */
export interface DarwinWindowExtras {
  accessibilityTrusted?(): boolean;
  screenRecording?(): boolean;
  /** FX-PD: CGPreflightListenEventAccess(); null while closed or where the symbol is missing. */
  inputMonitoring?(): boolean | null;
  /** FX-PD: CGRequestListenEventAccess(), which puts Ember in the Input Monitoring list. */
  requestInputMonitoring?(): unknown;
  /** FX-PD: secure keyboard entry (`on` null when it can't be told) and the app holding it ("" when unnamed). */
  secureInput?(): { on: boolean | null; pid: number | null; app: string };
}

/** port/darwin's window system with its extras, or null for any other (or none). */
export function darwinExtras(ws: WindowSystem | null | undefined): (WindowSystem & DarwinWindowExtras) | null {
  return ws && ws.kind === "darwin" ? ws as WindowSystem & DarwinWindowExtras : null;
}

/** What the permission reads need. */
export interface PermissionDeps {
  app: Pick<AppLike, "isInApplicationsFolder">;
  systemPreferences: Pick<SystemPreferencesLike, "getMediaAccessStatus" | "isTrustedAccessibilityClient">;
  /** The window system darwinPlatform opened (undefined before, null when it couldn't). */
  windows: () => WindowSystem | null | undefined;
  /** process.getuid (seam). */
  uid?: () => number | undefined;
  /** Electron's process.getSystemVersion (seam; Node's os.release() maps to it when absent). */
  systemVersion?: () => string | undefined;
}

/** Everything the checks and the doctor read, at one moment. */
export interface Permissions {
  version: string;
  accessibility: boolean;
  screen: MediaAccess;
  microphone: MediaAccess;
  inputMonitoring: boolean | null;
  inApplications: boolean;
  root: boolean;
}

/** The macOS version from the Darwin kernel's (22 → 13, 23 → 14, 24 → 15, 25 → 26), for when Electron can't say. */
export function macVersionFromDarwin(release: string): string {
  const major = Number(release.split(".")[0]);
  if (!Number.isInteger(major) || major < 20) return "0";
  return `${major >= 25 ? major + 1 : major - 9}.0`;
}

const media = (sp: PermissionDeps["systemPreferences"], kind: "screen" | "microphone"): MediaAccess => {
  try {
    return sp.getMediaAccessStatus?.(kind) ?? "unknown";
  } catch {
    return "unknown";
  }
};

/** Reads every permission now (see the module comment). */
export function readPermissions(d: PermissionDeps): Permissions {
  const ws = darwinExtras(d.windows());
  const ask = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback; // can't tell: the fail-closed answer
    }
  };
  const electronVersion = (process as { getSystemVersion?: () => string }).getSystemVersion;
  const version = ask(() => (d.systemVersion ? d.systemVersion() : electronVersion?.call(process)), undefined) || macVersionFromDarwin(os.release());
  return {
    version,
    accessibility: ask(() => (ws?.accessibilityTrusted ? ws.accessibilityTrusted() : d.systemPreferences.isTrustedAccessibilityClient?.(false) ?? false), false),
    screen: media(d.systemPreferences, "screen"),
    microphone: media(d.systemPreferences, "microphone"),
    inputMonitoring: ask(() => ws?.inputMonitoring?.() ?? null, null),
    // Unknown (no Electron answer) counts as in Applications: no warning Ember can't back up.
    inApplications: ask(() => d.app.isInApplicationsFolder?.() ?? true, true),
    root: ask(() => (d.uid ? d.uid() : process.getuid?.()) === 0, false),
  };
}

/** Secure keyboard entry now: "off", on (with the holding app's name, "" when unnamed), or "unknown". */
export function secureInputState(d: PermissionDeps): { on: false } | { on: true; holder: string } | { on: null } {
  const ws = darwinExtras(d.windows());
  try {
    if (ws?.secureInput) {
      const state = ws.secureInput();
      return state.on === null ? { on: null } : state.on ? { on: true, holder: state.app } : { on: false };
    }
  } catch {
    return { on: null };
  }
  return { on: null };
}
