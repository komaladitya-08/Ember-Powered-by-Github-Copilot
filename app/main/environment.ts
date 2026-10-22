/**
 * What machine are we on, and can Ember v1 work here? Pure function over
 * injected inputs so it is unit-testable; main.ts passes the real ones.
 */

import type { FixId } from "./platform/types";

export type { FixId };

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
  /** Ember's keyboard shortcuts another app already holds. Omitted when not known yet. */
  shortcutsTaken?: string[];
}

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** A fix Ember can apply itself (shown as a button). */
  fix?: FixId;
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

export function inspectEnvironment(i: EnvInputs): EnvReport {
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
    detail: os.PRETTY_NAME ?? "unknown",
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
      checks.push({ id: "accessibility", label: "Screen reading", status: "warn", detail: "Accessibility is off, so Ember can only see screenshots. Turn it on, then restart open apps.", fix: "enable-accessibility" });
    } else {
      checks.push({ id: "accessibility", label: "Screen reading", status: "ok", detail: a.enabled ? "Accessibility is on" : "Accessibility bus available" });
    }
  }

  if (i.shortcutsTaken) {
    const taken = i.shortcutsTaken.map(a => a.replace(/Control/g, "Ctrl"));
    checks.push(taken.length
      ? { id: "shortcuts", label: "Keyboard shortcuts", status: "warn", detail: `Another app already uses ${taken.join(", ")}. Use Ember's handle in the bottom-right corner instead (it has Ask, Stop everything and Settings); Ember keeps trying to get them.` }
      : { id: "shortcuts", label: "Keyboard shortcuts", status: "ok", detail: "Ctrl+Alt+Space ask · Ctrl+Alt+X stop · Ctrl+Alt+E settings · Ctrl+Alt+M microphone" });
  }

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
