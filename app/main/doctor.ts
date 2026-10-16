/**
 * `ember doctor` (M9.3): checks everything Ember needs on this machine and
 * explains every problem with what to do about it. The probes are gathered by
 * main.ts; turning them into advice is plain code, so it is tested on its own.
 */

import type { EnvReport } from "./environment";
import type { LoadedAdminPolicy } from "./admin";
import { VOICE_MODELS_BYTES } from "../voice/models";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  label: string;
  detail: string;
  /** What to do about it (only for warn/fail). */
  fix?: string;
}

export interface DoctorProbes {
  env: EnvReport;
  /** null when there is no X display to ask. */
  compositor: boolean | null;
  xtest: boolean | null;
  speechDispatcher: boolean;
  /** Microphone sources (null: pactl isn't installed). */
  microphones: string[] | null;
  voiceModels: "bundled" | "downloaded" | "missing";
  runtime: boolean;
  /** How Ember will reach a model: an organisation endpoint, a GitHub sign-in, or nothing yet. */
  auth: { kind: "provider"; host: string } | { kind: "github"; source: string } | null;
  admin: LoadedAdminPolicy;
  desk: { ok: boolean; missing: string[] };
  sandbox: { userNamespaces: boolean; suidHelper: boolean };
  /** This user's file watchers (inotify instances) in use and the limit; null when they can't be counted. */
  fileWatchers?: { used: number; max: number } | null;
}

export function doctorChecks(p: DoctorProbes): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const env = (id: string) => p.env.checks.find(c => c.id === id);
  for (const id of ["platform", "os", "glibc", "session", "desktop"]) {
    const c = env(id);
    if (!c) continue;
    // Each session problem has its own way out: only Wayland needs another session.
    const fix = id !== "session" || c.status === "ok" ? undefined
      : /wayland/i.test(c.detail) ? "Log out, click the gear on the login screen and choose “GNOME on Xorg”."
        : /can't connect/i.test(c.detail) ? "Start Ember from a terminal inside your desktop session (DISPLAY and XAUTHORITY come from it)."
          : "Run Ember inside your desktop session (or over ssh -X).";
    out.push({ id, status: c.status, label: c.label, detail: c.detail, ...(fix ? { fix } : {}) });
  }

  out.push(p.compositor === null
    ? { id: "compositor", status: "warn", label: "Compositor", detail: "No X display to check.", fix: "Run ember doctor inside your desktop session." }
    : p.compositor
      ? { id: "compositor", status: "ok", label: "Compositor", detail: "Transparent windows work: Ember appears beside your cursor." }
      : { id: "compositor", status: "warn", label: "Compositor", detail: "No compositing manager, so Ember waits in a small card in the corner instead of beside the cursor.", fix: "Use GNOME on Xorg (its compositor is built in)." });

  const a11y = env("accessibility");
  if (a11y) {
    const pyFix = /bindings are missing/i.test(a11y.detail) ? "sudo dnf install python3-pyatspi python3-gobject" : undefined;
    const onFix = /is off/i.test(a11y.detail) ? "gsettings set org.gnome.desktop.interface toolkit-accessibility true   (then log out and in)" : undefined;
    // The fix line carries the command, so the detail doesn't repeat it.
    const detail = a11y.detail.replace(/:\s*sudo dnf install.*$/, ".");
    out.push({ id: "accessibility", status: a11y.status, label: "Reading apps", detail, ...(pyFix || onFix ? { fix: pyFix ?? onFix } : {}) });
  }

  out.push(p.xtest === null
    ? { id: "xtest", status: "warn", label: "Mouse and keyboard", detail: "No X display to check." }
    : p.xtest
      ? { id: "xtest", status: "ok", label: "Mouse and keyboard", detail: "XTest is available (Ember can borrow the mouse, with your OK)." }
      : { id: "xtest", status: "warn", label: "Mouse and keyboard", detail: "XTest isn't available, so Ember can only act through accessibility.", fix: "sudo dnf install libXtst" });

  const copilot: DoctorCheck = !p.runtime
    ? { id: "copilot", status: "fail", label: "Copilot", detail: "Ember's Copilot runtime is missing from the installation.", fix: "Reinstall Ember (sudo dnf reinstall ember)." }
    : p.auth?.kind === "provider"
      ? { id: "copilot", status: "ok", label: "Model service", detail: `Your organisation's endpoint (${p.auth.host}).` }
      : p.auth?.kind === "github"
        ? { id: "copilot", status: "ok", label: "Copilot", detail: `Signed in (${p.auth.source === "stored" ? "Ember's saved sign-in" : p.auth.source === "github-cli" ? "GitHub CLI sign-in" : "token from the environment"}).` }
        : { id: "copilot", status: "warn", label: "Copilot", detail: "Not signed in to GitHub yet.", fix: "Open Ember's settings (Ctrl+Alt+E) and choose “Sign in with GitHub”, or run “gh auth login”." };
  out.push(copilot);

  if (p.admin.error) out.push({ id: "policy", status: "fail", label: "Organisation policy", detail: `Ember is locked down: ${p.admin.error}`, fix: `Ask your administrator to fix ${p.admin.source}.` });
  else if (p.admin.source) out.push({ id: "policy", status: "ok", label: "Organisation policy", detail: `In force from ${p.admin.source}.` });
  else out.push({ id: "policy", status: "ok", label: "Organisation policy", detail: "None (optional: /etc/ember/policy.json)." });

  const micOk = !!p.microphones?.length;
  out.push(p.microphones === null
    ? { id: "microphone", status: "warn", label: "Microphone", detail: "Can't list microphones (pactl is missing). Only needed for “Hey Ember”.", fix: "sudo dnf install pulseaudio-utils" }
    : micOk
      ? { id: "microphone", status: "ok", label: "Microphone", detail: p.microphones!.slice(0, 2).join(", ") }
      : { id: "microphone", status: "warn", label: "Microphone", detail: "No microphone found. Only needed for “Hey Ember”; typing (Ctrl+Alt+Space) always works." });
  out.push(p.voiceModels === "missing"
    ? { id: "voice-models", status: "warn", label: "Speech models", detail: "Not downloaded yet. Only needed for “Hey Ember”.", fix: `Turn on “Hey Ember” in Ember's settings and download them (${Math.round(VOICE_MODELS_BYTES / 1e6)} MB, once), or install ember-voice-models.` }
    : { id: "voice-models", status: "ok", label: "Speech models", detail: p.voiceModels === "bundled" ? "Installed with Ember." : "Downloaded." });
  out.push(p.speechDispatcher
    ? { id: "speech", status: "ok", label: "Speaking", detail: "speech-dispatcher is installed." }
    : { id: "speech", status: "warn", label: "Speaking", detail: "speech-dispatcher is missing, so Ember can't read replies aloud.", fix: "sudo dnf install speech-dispatcher speech-dispatcher-espeak-ng" });

  out.push(p.desk.ok
    ? { id: "desk", status: "ok", label: "Ember's desk", detail: "Xvfb, xauth and dbus-daemon are installed." }
    : { id: "desk", status: "warn", label: "Ember's desk", detail: `Missing ${p.desk.missing.join(", ")}, so Ember works on your screen only.`, fix: "sudo dnf install xorg-x11-server-Xvfb xorg-x11-xauth dbus-daemon" });

  out.push(p.sandbox.userNamespaces || p.sandbox.suidHelper
    ? { id: "sandbox", status: "ok", label: "Sandbox", detail: p.sandbox.userNamespaces ? "User namespaces are available." : "Using the setuid sandbox helper (user namespaces are off, as on STIG hosts)." }
    : { id: "sandbox", status: "fail", label: "Sandbox", detail: "User namespaces are off and chrome-sandbox isn't setuid root, so Ember's windows can't be sandboxed.", fix: "sudo chown root:root /opt/ember/chrome-sandbox && sudo chmod 4755 /opt/ember/chrome-sandbox (the RPM does this)" });
  // The Copilot runtime needs a free file watcher for each conversation and task; with none left it takes requests
  // and never answers them.
  const w = p.fileWatchers;
  if (w) out.push(w.max - w.used >= 8
    ? { id: "file-watchers", status: "ok", label: "File watchers", detail: `${w.used} of ${w.max} in use.` }
    : { id: "file-watchers", status: "warn", label: "File watchers", detail: `${w.used} of ${w.max} in use: Copilot needs a free one for each conversation and task, and stops answering without.`, fix: "sudo sysctl -w fs.inotify.max_user_instances=512, and put fs.inotify.max_user_instances=512 in /etc/sysctl.d/90-ember.conf to keep it" });
  return out;
}

const MARK: Record<DoctorStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

export function formatDoctor(checks: DoctorCheck[]): string {
  const width = Math.max(...checks.map(c => c.label.length));
  const lines = checks.flatMap(c => [
    `${MARK[c.status]}  ${c.label.padEnd(width)}  ${c.detail}`,
    ...(c.fix && c.status !== "ok" ? [`${" ".repeat(width + 8)}→ ${c.fix}`] : []),
  ]);
  const fails = checks.filter(c => c.status === "fail").length, warns = checks.filter(c => c.status === "warn").length;
  lines.push("", fails ? `${fails} problem${fails > 1 ? "s" : ""} to fix before Ember can work${warns ? `, and ${warns} thing${warns > 1 ? "s" : ""} worth a look` : ""}.`
    : warns ? `Ember can work. ${warns} thing${warns > 1 ? "s" : ""} worth a look.` : "Everything Ember needs is in place.");
  return lines.join("\n");
}
