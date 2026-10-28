/**
 * What machine are we on, and can Ember work here? Pure function over
 * injected inputs so it is unit-testable; main.ts passes the real ones (the
 * platform's system.environment()). Linux keeps its v1 checks exactly; Windows
 * and macOS have their own (design §9.8), read from the facts their platform
 * gathers, never from the wording of an error.
 */

import type { FixId } from "./platform/types";
import { SHORTCUTS, type ShortcutTable } from "../shared/shortcuts";
import { ISSUES_URL } from "../shared/support";

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
  /**
   * "Let desktop apps access your microphone" as Electron's getMediaAccessStatus("microphone") reads it ("denied" when
   * it is off). Omitted when it can't be asked (no row).
   */
  microphone?: MediaAccess;
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
  /**
   * Secure keyboard entry (a password field, Terminal's “Secure Keyboard Entry”) and the app holding it ("" when
   * unnamed); `on` null when it can't be told. Omitted without a window system to ask (no row).
   */
  secureInput?: { on: boolean | null; app: string };
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

/**
 * A Wayland session (GNOME's default login on RHEL 8): Ember's launcher forces X11, so it runs through XWayland, which
 * shows it only X11 apps' windows, pixels, pointer and keys. WAYLAND_DISPLAY counts unless the session says x11.
 */
export function isWaylandSession(env: Record<string, string | undefined>): boolean {
  const type = env.XDG_SESSION_TYPE ?? "unknown";
  return type === "wayland" || (!!env.WAYLAND_DISPLAY && type !== "x11");
}

/**
 * Why Ember takes no screenshots and doesn't borrow the mouse in a Wayland session (the window system's
 * systemDialogReason there, so the model and the user read it in each refusal), as a clause.
 */
export const WAYLAND_REASON = "this is a Wayland session, so Ember can't take screenshots or use the mouse and keyboard here: log out and choose “GNOME on Xorg” on the login screen";

/**
 * What Ember's greeting says when the desktop session check fails (a Wayland session, no X display, a Windows service
 * session), in place of "I'll stay by your cursor": nothing else at start-up says why nothing works. In Ember's own
 * voice, one line for each case (the setup check's row has the details). null otherwise.
 */
export function sessionGreeting(report: EnvReport): string | null {
  const c = report.checks.find(x => x.id === "session");
  if (!c || c.status !== "fail") return null;
  if (/wayland/i.test(c.detail)) {
    return "This is a Wayland session, so I can't see your screen or use your mouse here. Log out, click the gear on the login screen, choose “GNOME on Xorg”, and log in again.";
  }
  if (report.sessionType === "service") return "I can't work in this session: start me from your desktop, not as a service.";
  // Linux without an X display, or with one Ember can't connect to.
  return "I can't reach your desktop's display: start me from inside your desktop session.";
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
    : { id: "platform", label: "Platform", status: "fail", detail: `${i.platform}/${i.arch} isn't supported` });

  const isRhel8 = /^(rhel|rocky|almalinux|ol|centos)$/.test(os.ID ?? "") && (os.VERSION_ID ?? "").startsWith("8");
  checks.push({
    id: "os",
    label: "Operating system",
    status: isRhel8 ? "ok" : "warn",
    detail: os.PRETTY_NAME ?? "unknown",
  });

  if (isWaylandSession(i.env)) {
    checks.push({
      id: "session", label: "Desktop session", status: "fail",
      detail: "Wayland session. Ember needs “GNOME on Xorg”: log out, click the gear on the login screen, choose it, and log in again.",
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
      checks.push({ id: "accessibility", label: "Screen reading", status: "warn", detail: "Accessibility is off, so Ember can only see screenshots. Turn it on, then restart open apps.", fix: "enable-accessibility" });
    } else {
      checks.push({ id: "accessibility", label: "Screen reading", status: "ok", detail: a.enabled ? "Accessibility is on" : "Accessibility bus available" });
    }
  }

  if (i.shortcutsTaken) checks.push(shortcutsCheck(i.shortcutsTaken, i.shortcuts ?? SHORTCUTS.linux));

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

/**
 * The way out of mixed display scaling (the helper and Ember disagree on DPI awareness): with every monitor at the same
 * scale the two agree on every coordinate. The note itself stays after that (it compares the helper's thread with its
 * process, which no scale changes), so the words ask for a report only if clicks still miss. The same words in the
 * setup check and the doctor.
 */
export const MIXED_SCALING_FIX = `Set every monitor to the same scale in Settings › System › Display, then restart Ember. If it still clicks in the wrong place, report it at ${ISSUES_URL}.`;

/**
 * How to turn the microphone's privacy switch on, with its whole path on both supported Windows (Windows 10 22H2 calls
 * the page "Privacy" and the switch "Allow desktop apps to access your microphone"). The same words in the setup check
 * and the doctor.
 */
export const WINDOWS_MIC_FIX = "Turn on desktop apps' access to the microphone: Settings › Privacy & security › Microphone › Let desktop apps access your microphone "
  + "(on Windows 10: Settings › Privacy › Microphone › Allow desktop apps to access your microphone).";

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

    // Not asked yet is fine (Windows asks, or it is on); off, “Hey Ember” hears nothing, and the voice line points here.
    if (w.microphone === "denied" || w.microphone === "restricted") {
      checks.push({ id: "microphone", label: "Microphone", status: "warn", fix: "open-microphone-settings",
        detail: `Windows doesn't let desktop apps use the microphone, so “Hey Ember” can't hear you. ${WINDOWS_MIC_FIX}` });
    }

    if (w.dpiMixed) {
      checks.push({ id: "display-scaling", label: "Display scaling", status: "warn",
        detail: `Windows reports mixed display scaling to Ember's accessibility helper, so it may click in the wrong place on some monitors. ${MIXED_SCALING_FIX}` });
    }
    if (w.elevated) {
      checks.push({ id: "elevated", label: "Administrator", status: "warn", detail: "Ember is running as administrator: start it normally so it can't act with administrator rights by mistake." });
    }
  }
  if (i.shortcutsTaken) checks.push(shortcutsCheck(i.shortcutsTaken, i.shortcuts ?? SHORTCUTS.win32));
  return { os: osName, sessionType: w?.session ?? "unknown", desktop: "Windows", display: "", glibc: "unknown", versions: i.versions, checks };
}

/**
 * An ad-hoc signed Ember gets a new code identity with every build, so macOS can show it switched on while the
 * permission no longer applies: every macOS permission check ends with the way out (design R9).
 */
export const MAC_REGRANT = "If Ember is already listed and switched on, remove it with − and add it again: macOS ties the permission to this exact copy of Ember.";

function inspectMac(i: EnvInputs): EnvReport {
  const m = i.mac;
  const checks: Check[] = [];
  checks.push(i.arch === "arm64" ? { id: "platform", label: "Platform", status: "ok", detail: "macOS on Apple silicon" }
    : i.arch === "x64" ? { id: "platform", label: "Platform", status: "ok", detail: "macOS on Intel" }
      : { id: "platform", label: "Platform", status: "fail", detail: `macOS on ${i.arch} is not supported` });
  if (m) {
    checks.push(!m.version ? { id: "os", label: "Operating system", status: "warn", detail: "macOS (Ember couldn't read its version)" }
      : versionAtLeast(m.version, "13.0") ? { id: "os", label: "Operating system", status: "ok", detail: `macOS ${m.version}` }
        : { id: "os", label: "Operating system", status: "fail", detail: `macOS ${m.version}. Ember needs macOS 13 or newer.` });

    checks.push(m.accessibility
      ? { id: "accessibility", label: "Reading and using apps", status: "ok", detail: "Accessibility is allowed" }
      : { id: "accessibility", label: "Reading and using apps", status: "fail", detail: `Ember needs the Accessibility permission to read and use apps. ${MAC_REGRANT}`, fix: "open-accessibility-settings" });

    checks.push(m.screen === "granted"
      ? { id: "screen-recording", label: "Screen Recording", status: "ok", detail: "Allowed. macOS asks again about once a month; choose Allow." }
      : { id: "screen-recording", label: "Screen Recording", status: "warn",
        detail: `Without Screen Recording, Ember can't take screenshots or see other apps' window titles. After you allow it, quit and reopen Ember. ${MAC_REGRANT}`, fix: "open-screen-recording-settings" });

    if (m.inputMonitoring !== null) {
      checks.push(m.inputMonitoring
        ? { id: "input-monitoring", label: "Input Monitoring", status: "ok", detail: "Allowed" }
        : { id: "input-monitoring", label: "Input Monitoring", status: "warn",
          detail: `Without Input Monitoring, Ember won't use the keyboard for you, because it couldn't notice you taking over. ${MAC_REGRANT}`, fix: "open-input-monitoring-settings" });
    }

    // Not asked yet is fine: macOS asks when the user turns on “Hey Ember”.
    if (m.microphone === "denied" || m.microphone === "restricted") {
      checks.push({ id: "microphone", label: "Microphone", status: "warn", detail: `Microphone access is off for Ember, so “Hey Ember” can't hear you. ${MAC_REGRANT}`, fix: "open-microphone-settings" });
    }

    // While it is on Ember neither looks nor acts (the window system's system-dialog check), so the reason is shown here
    // too, with the app that holds it: a stuck Secure Keyboard Entry otherwise turns Ember off without a word.
    const secure = m.secureInput;
    if (secure?.on === true) {
      const where = secure.app ? ` in ${secure.app}` : "";
      checks.push({ id: "secure-input", label: "Secure input", status: "warn",
        detail: `Secure keyboard entry is on${where}, so Ember won't look at the screen or use the mouse or keyboard until it's off. Close the password field${where}, or turn off Secure Keyboard Entry there (Terminal: Terminal menu › Secure Keyboard Entry).` });
    } else if (secure && secure.on === null) {
      checks.push({ id: "secure-input", label: "Secure input", status: "warn", detail: "Ember can't tell whether a password is being typed, so it won't look at the screen or use the mouse or keyboard." });
    }

    checks.push(m.inApplications
      ? { id: "location", label: "Applications folder", status: "ok", detail: "Ember is in the Applications folder" }
      : { id: "location", label: "Applications folder", status: "warn", detail: "Ember isn't in the Applications folder, so its permissions and login item may not stick.", fix: "move-to-applications" });

    if (m.root) checks.push({ id: "elevated", label: "Root", status: "warn", detail: "Ember is running as root. Start it as yourself." });
  }
  if (i.shortcutsTaken) checks.push(shortcutsCheck(i.shortcutsTaken, i.shortcuts ?? SHORTCUTS.darwin));
  return { os: m?.version ? `macOS ${m.version}` : "macOS", sessionType: "macos", desktop: "macOS", display: "", glibc: "unknown", versions: i.versions, checks };
}
