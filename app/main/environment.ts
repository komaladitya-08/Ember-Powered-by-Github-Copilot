/**
 * What machine are we on, and can Ember work here? Pure function over
 * injected inputs so it is unit-testable; main.ts passes the real ones (the
 * platform's system.environment()). Linux keeps its v1 checks exactly; Windows
 * and macOS have their own (design §9.8), read from the facts their platform
 * gathers, never from the wording of an error.
 */

import type { FixId } from "./platform/types";
import { SHORTCUTS, type ShortcutTable } from "../shared/shortcuts";

export type { FixId };

/** What macOS answers for a privacy permission (Electron's systemPreferences.getMediaAccessStatus). */
export type MediaAccess = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

/** What the Windows platform finds out about this machine and Ember's process. */
export interface WindowsEnvInputs {
  /** The Windows build ("10.0.22631" → 22631); 0 when it couldn't be read. */
  build: number;
  /** Ember runs elevated (as administrator); null when the token couldn't be read (no row; commands fail closed on it). */
  elevated: boolean | null;
  /** At the computer, over Remote Desktop, or in session 0 (as a service). */
  session: "console" | "rdp" | "service";
  /**
   * Can Ember's accessibility helper (Windows PowerShell 5.1) run: "full" it answered; "constrained" Constrained
   * Language Mode; "policy" an execution policy allows only signed scripts; "blocked-download" the helper carries the
   * mark of the web under RemoteSigned; "missing" it ran and said it can't read apps; "unknown" not asked yet.
   */
  powershell: "full" | "constrained" | "policy" | "blocked-download" | "missing" | "unknown";
  /** The helper's threads and Ember's process report different DPI awareness (mixed scaling may put clicks off). */
  dpiMixed: boolean;
  /** Why the helper couldn't read apps (its own words), for "missing". */
  helperDetail?: string;
}

/** What the macOS platform finds out about this machine and Ember's permissions. */
export interface MacEnvInputs {
  /** process.getSystemVersion() ("14.6.1"). */
  version: string;
  /** AXIsProcessTrusted (systemPreferences.isTrustedAccessibilityClient(false)). */
  accessibility: boolean;
  screen: MediaAccess;
  microphone: MediaAccess;
  /** CGPreflightListenEventAccess; null when it can't be asked (the check is left out). */
  inputMonitoring: boolean | null;
  /** app.isInApplicationsFolder(): permissions and the login item are tied to where Ember is. */
  inApplications: boolean;
  /** Ember runs as root. */
  root: boolean;
}

export interface EnvInputs {
  env: Record<string, string | undefined>;
  osRelease: string | null;      // contents of /etc/os-release
  glibc: string | null;          // e.g. "2.28"
  versions: { electron?: string; chrome?: string; node: string };
  platform: string;
  arch: string;
  /** Accessibility (screen reading). Omitted when not probed. */
  accessibility?: { enabled: boolean | null; pyatspi: boolean };
  /** Could Ember open the X display? (Xvfb, xrdp, ssh -X and su leave XDG_SESSION_TYPE unset or "tty".) Omitted when not probed. */
  x11?: boolean;
  /** Ember's keyboard shortcuts another app already holds (Electron accelerators). Omitted when not known yet. */
  shortcutsTaken?: string[];
  /** This OS's shortcut table (default: Linux's), for the shortcuts check's words. */
  shortcuts?: ShortcutTable;
  /** Windows only. */
  windows?: WindowsEnvInputs;
  /** macOS only. */
  mac?: MacEnvInputs;
  /**
   * The setup-check fixes the user applied (pressed) while this Ember runs (afterFix): a row whose fix was used says
   * what comes next, such as restarting apps that were already open (review #98).
   */
  applied?: readonly FixId[];
  /** false: Ember tried to speak and no voice started (the speaking page's watch, review #101); else no row. */
  speech?: boolean | null;
}

export type CheckStatus = "ok" | "warn" | "fail";

/** A fix the targets runtime applies (§8.8): toolkit accessibility turned on in a running WSL distro. */
export type TargetFixId = `wsl-a11y:${string}`;

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** A fix Ember can apply itself (shown as a button): this OS's own, or one of the targets runtime's. */
  fix?: FixId | TargetFixId;
  /** A second button, for when `fix` was used and didn't take (macOS: Reset Ember's permissions, review #99). */
  alt?: FixId;
}

export interface EnvReport {
  os: string;
  sessionType: string;
  desktop: string;
  display: string;
  glibc: string;
  versions: EnvInputs["versions"];
  checks: Check[];
}

export function parseOsRelease(text: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text ?? "").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const versionAtLeast = (v: string, min: string) => {
  const a = v.split(".").map(Number), b = min.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return true;
};

/** The keyboard shortcuts check: the table's labels for those Ember holds, or which ones another app took. */
function shortcutsCheck(taken: string[], sc: ShortcutTable): Check {
  // An accelerator as the copy writes it (on Linux the table's label is exactly "Control" → "Ctrl").
  const label = (accel: string) => Object.values(sc).find(d => d.accel === accel)?.label ?? accel.replace(/Control/g, "Ctrl");
  const named = taken.map(label);
  return named.length
    ? { id: "shortcuts", label: "Keyboard shortcuts", status: "warn", detail: `Another app already uses ${named.join(", ")}. Use Ember's handle in the bottom-right corner instead (it has Ask, Stop everything and Settings); Ember keeps trying to get them.` }
    : { id: "shortcuts", label: "Keyboard shortcuts", status: "ok", detail: `${sc.ask.label} ask · ${sc.stop.label} stop · ${sc.settings.label} settings · ${sc.mute.label} microphone` };
}

/** Each OS's way to get a voice, for the Speaking row Ember adds once it found none (review #101). */
const NO_VOICE: Record<"linux" | "win32" | "darwin", string> = {
  linux: "Ember couldn't speak: this computer has no speech voice. Install one with sudo dnf install speech-dispatcher speech-dispatcher-espeak-ng, then restart Ember.",
  win32: "Ember couldn't speak: Windows has no voice it can use. Add one in Settings › Time & language › Speech, then restart Ember.",
  darwin: "Ember couldn't speak: macOS has no voice it can use. Choose one in System Settings › Accessibility › Spoken Content, then restart Ember.",
};

/** The Speaking row, once Ember tried to speak and no voice started; nothing until then. */
function speechCheck(i: EnvInputs, os: keyof typeof NO_VOICE): Check[] {
  return i.speech === false ? [{ id: "speech", label: "Speaking", status: "warn", detail: NO_VOICE[os] }] : [];
}

/** What GNOME's accessibility switch needs after it is turned on, in the setup check and in `ember doctor` alike. */
export const LINUX_A11Y_RESTART = "restart apps that were already open, or log out and in";

/**
 * The macOS fixes "Reset Ember's permissions" undoes: it takes Ember off the Accessibility, Screen Recording and Input
 * Monitoring lists, so each of their buttons has to be pressed again.
 */
const RESET_UNDOES: readonly FixId[] = ["open-accessibility-settings", "open-screen-recording-settings", "open-input-monitoring-settings"];

/** The fixes applied so far (EnvInputs.applied) once `fix` has been applied too. */
export function afterFix(applied: readonly FixId[], fix: FixId): FixId[] {
  const kept = fix === "reset-permissions" ? applied.filter(f => !RESET_UNDOES.includes(f)) : [...applied];
  return kept.includes(fix) ? kept : [...kept, fix];
}

export function inspectEnvironment(i: EnvInputs): EnvReport {
  if (i.platform === "win32") return inspectWindows(i);
  if (i.platform === "darwin") return inspectMac(i);
  const os = parseOsRelease(i.osRelease);
  const sessionType = i.env.XDG_SESSION_TYPE ?? "unknown";
  const desktop = i.env.XDG_CURRENT_DESKTOP ?? "unknown";
  const display = i.env.DISPLAY ?? "";
  const checks: Check[] = [];

  checks.push(i.platform === "linux" && i.arch === "x64"
    ? { id: "platform", label: "Platform", status: "ok", detail: "Linux x86-64" }
    : { id: "platform", label: "Platform", status: "fail", detail: `${i.platform}/${i.arch} is not supported in v1` });

  const isRhel8 = /^(rhel|rocky|almalinux|ol|centos)$/.test(os.ID ?? "") && (os.VERSION_ID ?? "").startsWith("8");
  checks.push({
    id: "os",
    label: "Operating system",
    status: isRhel8 ? "ok" : "warn",
    // Another Linux says why it is only a warning (review #105).
    detail: isRhel8 ? os.PRETTY_NAME ?? "unknown"
      : `${os.PRETTY_NAME ?? "This Linux"}. Ember is tested on RHEL 8 and its family (Rocky, Alma and Oracle Linux 8): it may work here, but it isn't supported.`,
  });

  if (sessionType === "wayland" || (!!i.env.WAYLAND_DISPLAY && sessionType !== "x11")) {
    checks.push({
      id: "session", label: "Desktop session", status: "fail",
      detail: "Wayland session. Ember v1 needs “GNOME on Xorg”: log out, click the gear on the login screen, choose it, and log in again.",
    });
  } else if (display && (sessionType === "x11" || i.x11 !== false)) {
    // An X display Ember can use is what matters (the session type is often unset on Xvfb, xrdp or ssh -X).
    checks.push({ id: "session", label: "Desktop session", status: "ok", detail: `X11 on ${display}` });
  } else if (display) {
    checks.push({ id: "session", label: "Desktop session", status: "fail", detail: `Ember can't connect to the X display ${display}. Start Ember from inside your desktop session.` });
  } else {
    checks.push({ id: "session", label: "Desktop session", status: "fail", detail: "No X display. Start Ember from inside your desktop session (not over SSH without -X)." });
  }

  checks.push(/GNOME/i.test(desktop)
    ? { id: "desktop", label: "Desktop", status: "ok", detail: desktop }
    : { id: "desktop", label: "Desktop", status: "warn", detail: `${desktop} (Ember is tested on GNOME)` });

  if (i.glibc) {
    checks.push(versionAtLeast(i.glibc, "2.28")
      ? { id: "glibc", label: "glibc", status: "ok", detail: i.glibc }
      : { id: "glibc", label: "glibc", status: "fail", detail: `${i.glibc} (needs 2.28 or newer)` });
  }

  if (i.accessibility) {
    const a = i.accessibility;
    if (!a.pyatspi) {
      checks.push({ id: "accessibility", label: "Screen reading", status: "warn", detail: "Python accessibility bindings are missing: sudo dnf install python3-pyatspi" });
    } else if (a.enabled === false) {
      checks.push({ id: "accessibility", label: "Screen reading", status: "warn", detail: `Accessibility is off, so Ember can only see screenshots. Turn it on, then ${LINUX_A11Y_RESTART}.`, fix: "enable-accessibility" });
    } else if (a.enabled && i.applied?.includes("enable-accessibility")) {
      // Turned on from this setup check: apps opened before still can't be read until they restart (Qt, Chromium, Firefox).
      checks.push({ id: "accessibility", label: "Screen reading", status: "ok", detail: "On. Restart apps that were already open, or log out and in, so Ember can read them." });
    } else {
      checks.push({ id: "accessibility", label: "Screen reading", status: "ok", detail: a.enabled ? "Accessibility is on" : "Accessibility bus available" });
    }
  }

  if (i.shortcutsTaken) checks.push(shortcutsCheck(i.shortcutsTaken, i.shortcuts ?? SHORTCUTS.linux));
  checks.push(...speechCheck(i, "linux"));

  return {
    os: os.PRETTY_NAME ?? "unknown",
    sessionType,
    desktop,
    display,
    glibc: i.glibc ?? "unknown",
    versions: i.versions,
    checks,
  };
}

/** The Windows name of a build: 11 from build 22000, 10 from 10240. */
function windowsName(build: number): string {
  if (!(build > 0)) return "Windows";
  return build >= 22000 ? `Windows 11 (build ${build})` : build >= 10240 ? `Windows 10 (build ${build})` : `Windows (build ${build})`;
}

/** Windows 10 22H2 is the oldest Windows Ember is tested on; 1809 (17763) the oldest it may work on. */
const WINDOWS_TESTED = 19045, WINDOWS_OLDEST = 17763;

function inspectWindows(i: EnvInputs): EnvReport {
  const w = i.windows;
  const checks: Check[] = [];
  checks.push(i.arch === "x64" ? { id: "platform", label: "Platform", status: "ok", detail: "Windows x64" }
    : i.arch === "arm64" ? { id: "platform", label: "Platform", status: "ok", detail: "Windows on Arm (best effort)" }
      : { id: "platform", label: "Platform", status: "fail", detail: `Windows on ${i.arch} is not supported` });
  const osName = windowsName(w?.build ?? 0);
  if (w) {
    const b = w.build;
    checks.push(!(b > 0) ? { id: "os", label: "Operating system", status: "warn", detail: "Windows (Ember couldn't read its build number)" }
      : b >= WINDOWS_TESTED ? { id: "os", label: "Operating system", status: "ok", detail: osName }
        : b >= WINDOWS_OLDEST ? { id: "os", label: "Operating system", status: "warn", detail: `${osName}. Ember is tested on Windows 10 22H2 and Windows 11.` }
          : { id: "os", label: "Operating system", status: "fail", detail: `${osName}. Ember needs Windows 10 version 1809 or newer.` });

    checks.push(w.session === "service"
      ? { id: "session", label: "Desktop session", status: "fail", detail: "Start Ember from your desktop, not as a service." }
      : { id: "session", label: "Desktop session", status: "ok", detail: w.session === "rdp" ? "Remote Desktop" : "Signed in at this computer" });

    const screen = (status: CheckStatus, detail: string, fix?: FixId): Check => ({ id: "accessibility", label: "Screen reading", status, detail, ...(fix ? { fix } : {}) });
    switch (w.powershell) {
      case "full": checks.push(screen("ok", "Windows UI Automation")); break;
      case "constrained":
        checks.push(screen("warn", "Windows PowerShell is restricted on this computer (Constrained Language Mode), so Ember can't read apps. Ask your administrator to allow Ember's accessibility helper."));
        break;
      case "policy":
        checks.push(screen("warn", "Your organisation allows only signed PowerShell scripts, and Ember's accessibility helper isn't signed, so Ember can't read apps. Ask your administrator to allow it."));
        break;
      case "blocked-download":
        checks.push(screen("warn", "Windows blocked Ember's accessibility helper because it came from the internet.", "unblock-helper"));
        break;
      case "missing":
        checks.push(screen("warn", w.helperDetail ? `Ember's accessibility helper didn't start: ${w.helperDetail}` : "Ember's accessibility helper didn't start."));
        break;
      case "unknown": break;
    }

    if (w.dpiMixed) {
      checks.push({ id: "display-scaling", label: "Display scaling", status: "warn",
        detail: "Windows reports mixed display scaling to Ember's accessibility helper, so it may click in the wrong place on some monitors. Tell the Ember team." });
    }
    if (w.elevated) {
      checks.push({ id: "elevated", label: "Administrator", status: "warn", detail: "Ember is running as administrator: start it normally so it can't act with administrator rights by mistake." });
    }
  }
  if (i.shortcutsTaken) checks.push(shortcutsCheck(i.shortcutsTaken, i.shortcuts ?? SHORTCUTS.win32));
  checks.push(...speechCheck(i, "win32"));
  return { os: osName, sessionType: w?.session ?? "unknown", desktop: "Windows", display: "", glibc: "unknown", versions: i.versions, checks };
}

/**
 * An ad-hoc signed Ember gets a new code identity with every build, so macOS can show it switched on while the
 * permission no longer applies (design R9). The way out is said once the row's own button has been pressed and the
 * permission is still off (review #99): Reset Ember's permissions for the three it covers, this sentence for the
 * microphone (and once in `ember doctor`, where there are no buttons).
 */
export const MAC_REGRANT = "If Ember is already listed and switched on, remove it with − and add it again: macOS ties the permission to this exact copy of Ember.";
/** A row's note once its System Settings button was pressed and the permission is still off: the Reset button beside it. */
export const MAC_RESET_NOTE = "Already switched on? macOS ties the permission to this exact copy of Ember: reset Ember's permissions, then switch it on again.";

function inspectMac(i: EnvInputs): EnvReport {
  const m = i.mac;
  const checks: Check[] = [];
  /** A permission still off after its button was pressed: the detail gets the way out, and the Reset button where it helps. */
  const stillOff = (fix: FixId, detail: string, reset: boolean): Pick<Check, "detail" | "fix" | "alt"> => (!i.applied?.includes(fix) ? { detail, fix }
    : reset ? { detail: `${detail} ${MAC_RESET_NOTE}`, fix, alt: "reset-permissions" } : { detail: `${detail} ${MAC_REGRANT}`, fix });
  checks.push(i.arch === "arm64" ? { id: "platform", label: "Platform", status: "ok", detail: "macOS on Apple silicon" }
    : i.arch === "x64" ? { id: "platform", label: "Platform", status: "ok", detail: "macOS on Intel" }
      : { id: "platform", label: "Platform", status: "fail", detail: `macOS on ${i.arch} is not supported` });
  if (m) {
    checks.push(!m.version ? { id: "os", label: "Operating system", status: "warn", detail: "macOS (Ember couldn't read its version)" }
      : versionAtLeast(m.version, "13.0") ? { id: "os", label: "Operating system", status: "ok", detail: `macOS ${m.version}` }
        : { id: "os", label: "Operating system", status: "fail", detail: `macOS ${m.version}. Ember needs macOS 13 or newer.` });

    checks.push(m.accessibility
      ? { id: "accessibility", label: "Reading and using apps", status: "ok", detail: "Accessibility is allowed" }
      : { id: "accessibility", label: "Reading and using apps", status: "fail", ...stillOff("open-accessibility-settings", "Ember needs the Accessibility permission to read and use apps.", true) });

    checks.push(m.screen === "granted"
      ? { id: "screen-recording", label: "Screen Recording", status: "ok", detail: "Allowed. macOS asks again about once a month; choose Allow." }
      : { id: "screen-recording", label: "Screen Recording", status: "warn",
        ...stillOff("open-screen-recording-settings", "Without Screen Recording, Ember can't take screenshots or see other apps' window titles. After you allow it, quit and reopen Ember.", true) });

    if (m.inputMonitoring !== null) {
      checks.push(m.inputMonitoring
        ? { id: "input-monitoring", label: "Input Monitoring", status: "ok", detail: "Allowed" }
        : { id: "input-monitoring", label: "Input Monitoring", status: "warn",
          ...stillOff("open-input-monitoring-settings", "Without Input Monitoring, Ember won't use the keyboard for you, because it couldn't notice you taking over.", true) });
    }

    // Not asked yet is fine: macOS asks when the user turns on “Hey Ember”.
    if (m.microphone === "denied" || m.microphone === "restricted") {
      checks.push({ id: "microphone", label: "Microphone", status: "warn", ...stillOff("open-microphone-settings", "Microphone access is off for Ember, so “Hey Ember” can't hear you.", false) });
    }

    checks.push(m.inApplications
      ? { id: "location", label: "Applications folder", status: "ok", detail: "Ember is in the Applications folder" }
      : { id: "location", label: "Applications folder", status: "warn", detail: "Ember isn't in the Applications folder, so its permissions and login item may not stick.", fix: "move-to-applications" });

    if (m.root) checks.push({ id: "elevated", label: "Root", status: "warn", detail: "Ember is running as root. Start it as yourself." });
  }
  if (i.shortcutsTaken) checks.push(shortcutsCheck(i.shortcutsTaken, i.shortcuts ?? SHORTCUTS.darwin));
  checks.push(...speechCheck(i, "darwin"));
  return { os: m?.version ? `macOS ${m.version}` : "macOS", sessionType: "macos", desktop: "macOS", display: "", glibc: "unknown", versions: i.versions, checks };
}
