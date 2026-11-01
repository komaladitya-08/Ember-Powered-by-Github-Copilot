/**
 * `ember doctor` (M9.3): checks everything Ember needs on this machine and
 * explains every problem with what to do about it. The probes are gathered by
 * main.ts (through the platform's doctorProbes); turning them into advice is plain
 * code, so it is tested on its own. Which advice applies is decided by `os` alone,
 * never by the wording of a check (Linux's fixes are dnf, gsettings and GNOME's).
 */

import { LINUX_A11Y_RESTART, MIXED_SCALING_FIX, type EnvReport } from "./environment";
import { ADMIN_POLICY_FILE, type LoadedAdminPolicy } from "./admin";
import type { HelperStatus, PlatformDoctorRow } from "./platform/types";
import { FALLBACK_SHORTCUTS, SHORTCUTS, type OS, type ShortcutTable } from "../shared/shortcuts";
import { PLATFORM_WORDS, type PlatformWords } from "../shared/words";
import { LISTENING_MODELS, VOICE_MODELS, modelsBytes, type ModelId } from "../voice/models";
import { cliSteps, type SignInWith } from "./agent/github-app";

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
  /** Which OS's advice applies (default "linux"): the one discriminator, never a check's text. */
  os?: OS;
  env: EnvReport;
  /** null when there is no X display to ask (off Linux: the window system didn't load). */
  compositor: boolean | null;
  /** Ember can post input (Linux XTest; Windows SendInput; macOS CGEvent with Accessibility); null without a window system. */
  xtest: boolean | null;
  speechDispatcher: boolean;
  /** Microphone sources (null: pactl isn't installed; off Linux they aren't listed here). */
  microphones: string[] | null;
  /** Where listening's models (wake word, voice activity, speech recognition) come from, or that they're missing. */
  voiceModels: "bundled" | "downloaded" | "missing";
  /** The models in none of Ember's folders (default: all of them while `voiceModels` is "missing", else none). */
  voiceModelsMissing?: ModelId[];
  runtime: boolean;
  /** How Ember will reach a model: an organisation endpoint, a GitHub sign-in, or nothing yet. */
  auth: { kind: "provider"; host: string } | { kind: "github"; source: string } | null;
  /**
   * How this build signs in (github-app.ts), and whether the GitHub CLI is installed: without Ember's own GitHub App the
   * fix says sign-in needs a GitHub account with Copilot and the GitHub CLI. Absent: the fix offers "Sign in with GitHub".
   */
  signIn?: { with: SignInWith; ghInstalled: boolean };
  admin: LoadedAdminPolicy;
  /** Ember's desk (Linux); null where there is none (the row is left out). */
  desk: { ok: boolean; missing: string[] } | null;
  /** Chromium's sandbox (Linux); null where the OS provides it (the row is left out). appImage: running as an AppImage. */
  sandbox: { userNamespaces: boolean; suidHelper: boolean; appImage?: boolean } | null;
  /** This user's file watchers (inotify instances) in use and the limit; null when they can't be counted. */
  fileWatchers?: { used: number; max: number } | null;
  /** Windows and macOS: the shared accessibility helper's status answer (null: it didn't answer); its own row. */
  helper?: HelperStatus | null;
  /** Rows the platform adds in doctor wording (permissions, PowerShell, elevation…), before the Copilot row. */
  extra?: PlatformDoctorRow[];
  /** This OS's shortcut table (default: Linux's), for the hints that name a shortcut. */
  shortcuts?: ShortcutTable;
  /** This OS's words (default: Linux's): how to reinstall. */
  words?: Pick<PlatformWords, "reinstall">;
  /** Where the organisation policy would be (default: /etc/ember/policy.json). */
  policyLocation?: string;
}

/** Each OS's own name and wording for the rows that differ off Linux. */
const OFF_LINUX: Record<"win32" | "darwin", { name: string; input: { ok: string; no: string; fix?: string }; voices: string; helperFix: string; sessionFix: string }> = {
  win32: {
    name: "Windows",
    input: { ok: "SendInput is available (Ember can borrow the mouse, with your OK).", no: "Windows didn't give Ember its input functions, so Ember can only act through accessibility." },
    voices: "Uses Windows' voices.",
    helperFix: "Check the PowerShell row below; if it is fine, reinstall Ember.",
    sessionFix: "Sign in to Windows and start Ember from the Start menu.",
  },
  darwin: {
    name: "macOS",
    input: { ok: "Ember may post mouse and keyboard events (it borrows them only with your OK).",
      no: "macOS isn't letting Ember borrow the mouse and keyboard (it needs the Accessibility permission, and no app may be holding secure input).",
      fix: "Allow Ember in System Settings › Privacy & Security › Accessibility." },
    voices: "Uses macOS voices.",
    helperFix: "Allow Ember in System Settings › Privacy & Security › Accessibility, then run this again.",
    sessionFix: "Log in to your Mac and start Ember from the Applications folder.",
  },
};

/**
 * The platform's rows that are the same check as a row of the settings window's setup check, by that row's id: the
 * doctor calls them what the window calls them (review #229), whatever the window's words are.
 */
const WINDOW_ROW: Readonly<Record<string, string>> = {
  "accessibility-permission": "accessibility", "microphone-permission": "microphone", "microphone-privacy": "microphone", location: "location", root: "elevated",
};
/** The platform's microphone permission rows: where one is, the general "Not checked here" Microphone row isn't. */
const MIC_ROWS = new Set(["microphone-permission", "microphone-privacy"]);

/** The "Accessibility helper" row (Windows and macOS: the shared host and its provider, started once by the doctor). */
function helperRow(h: HelperStatus | null, fix: string, reinstall: string): DoctorCheck {
  const label = "Accessibility helper";
  if (!h) return { id: "accessibility-helper", status: "fail", label, detail: "Ember's accessibility helper didn't answer, so Ember can't read apps.", fix: `If this keeps happening: ${reinstall}` };
  const facts = [h.languageMode && `PowerShell ${h.languageMode}`, h.dpi && `DPI awareness ${h.dpi}`,
    h.processDpi && h.processDpi !== h.dpi && `Ember's DPI awareness ${h.processDpi}`].filter(Boolean).join(", ");
  // One sentence, with what the helper reported in brackets before its full stop.
  const withFacts = (text: string) => {
    const bare = text.replace(/[.\s]+$/, "");
    return facts ? `${bare} (${facts}).` : `${bare}.`;
  };
  if (h.toolkitAccessibility === false) {
    return { id: "accessibility-helper", status: "fail", label, detail: withFacts(`Ember's accessibility helper can't read apps${h.detail ? `: ${h.detail}` : ""}`), fix };
  }
  if (h.toolkitAccessibility === null) return { id: "accessibility-helper", status: "warn", label, detail: withFacts("The accessibility helper answered but couldn't tell whether it can read apps"), fix };
  if (h.dpi && h.processDpi && h.dpi !== h.processDpi) {
    return { id: "accessibility-helper", status: "warn", label,
      detail: withFacts("Running, but its display scaling differs from Ember's, so it may click in the wrong place on some monitors"), fix: MIXED_SCALING_FIX };
  }
  return { id: "accessibility-helper", status: "ok", label, detail: withFacts("Running: Ember can read apps") };
}

export function doctorChecks(p: DoctorProbes): DoctorCheck[] {
  const os = p.os ?? "linux";
  const linux = os === "linux";
  const off = linux ? null : OFF_LINUX[os];
  const sc = p.shortcuts ?? SHORTCUTS.linux;
  // The doctor registers no shortcut, so it can't tell which chord Ember holds (D-45b): the default, and the fallback
  // Ember takes while another app has that, as the setup check names it then.
  const chord = (id: "ask" | "settings") => `${sc[id].label}, or ${FALLBACK_SHORTCUTS[os][id].label} when another app has that`;
  const reinstall = p.words?.reinstall ?? PLATFORM_WORDS.linux.reinstall;
  const out: DoctorCheck[] = [];
  const env = (id: string) => p.env.checks.find(c => c.id === id);
  for (const id of ["platform", "os", "glibc", "session", "desktop"]) {
    const c = env(id);
    if (!c) continue;
    // Each session problem has its own way out: only Wayland needs another session.
    const fix = id !== "session" || c.status === "ok" ? undefined
      : off ? off.sessionFix
        : /wayland/i.test(c.detail) ? "Log out, click the gear on the login screen and choose “GNOME on Xorg”."
          : /can't connect/i.test(c.detail) ? "Start Ember from a terminal inside your desktop session (DISPLAY and XAUTHORITY come from it)."
            : "Run Ember inside your desktop session (or over ssh -X).";
    out.push({ id, status: c.status, label: c.label, detail: c.detail, ...(fix ? { fix } : {}) });
  }

  if (off) {
    out.push(p.compositor === null
      ? { id: "compositor", status: "fail", label: "Transparent windows", detail: `${off.name}'s window functions didn't load, so Ember can't see or use the screen.`, fix: reinstall }
      : { id: "compositor", status: "ok", label: "Transparent windows", detail: `${off.name} always composites: Ember appears beside your cursor.` });
  } else {
    out.push(p.compositor === null
      ? { id: "compositor", status: "warn", label: "Transparent windows", detail: "No X display to check.", fix: "Run ember doctor inside your desktop session." }
      : p.compositor
        ? { id: "compositor", status: "ok", label: "Transparent windows", detail: "They work: Ember appears beside your cursor." }
        : { id: "compositor", status: "warn", label: "Transparent windows", detail: "No compositing manager, so Ember waits in a small card in the corner instead of beside the cursor.", fix: "Use GNOME on Xorg (its compositor is built in)." });
  }

  const a11y = linux ? env("accessibility") : undefined;
  if (a11y) {
    const pyFix = /bindings are missing/i.test(a11y.detail) ? "sudo dnf install python3-pyatspi python3-gobject" : undefined;
    const onFix = /is off/i.test(a11y.detail) ? `gsettings set org.gnome.desktop.interface toolkit-accessibility true   (then ${LINUX_A11Y_RESTART})` : undefined;
    // The fix line carries the command, so the detail doesn't repeat it.
    const detail = a11y.detail.replace(/:\s*sudo dnf install.*$/, ".");
    out.push({ id: "accessibility", status: a11y.status, label: a11y.label, detail, ...(pyFix || onFix ? { fix: pyFix ?? onFix } : {}) });
  }
  // Off Linux the shared host stands where the Python sidecar's accessibility check stands on Linux.
  if (off && p.helper !== undefined) out.push(helperRow(p.helper, off.helperFix, reinstall));

  if (off) {
    out.push(p.xtest === null
      ? { id: "xtest", status: "warn", label: "Mouse and keyboard", detail: "No window system to check." }
      : p.xtest
        ? { id: "xtest", status: "ok", label: "Mouse and keyboard", detail: off.input.ok }
        : { id: "xtest", status: "warn", label: "Mouse and keyboard", detail: off.input.no, ...(off.input.fix ? { fix: off.input.fix } : {}) });
  } else {
    out.push(p.xtest === null
      ? { id: "xtest", status: "warn", label: "Mouse and keyboard", detail: "No X display to check." }
      : p.xtest
        ? { id: "xtest", status: "ok", label: "Mouse and keyboard", detail: "XTest is available (Ember can borrow the mouse, with your OK)." }
        : { id: "xtest", status: "warn", label: "Mouse and keyboard", detail: "XTest isn't available, so Ember can only act through accessibility.", fix: "sudo dnf install libXtst" });
  }

  for (const r of p.extra ?? []) {
    const same = WINDOW_ROW[r.id] !== undefined ? env(WINDOW_ROW[r.id])?.label : undefined;
    const label = same ?? (MIC_ROWS.has(r.id) ? "Microphone" : r.label);
    out.push({ id: r.id, status: r.status, label, detail: r.detail, ...(r.fix ? { fix: r.fix } : {}) });
  }

  const copilot: DoctorCheck = !p.runtime
    ? { id: "copilot", status: "fail", label: "Copilot", detail: "Ember's Copilot runtime is missing from the installation.", fix: reinstall }
    : p.auth?.kind === "provider"
      ? { id: "copilot", status: "ok", label: "Model service", detail: `Your organisation's model service (${p.auth.host}).` }
      : p.auth?.kind === "github"
        ? { id: "copilot", status: "ok", label: "Copilot", detail: `Signed in (${p.auth.source === "stored" ? "Ember's saved sign-in" : p.auth.source === "github-cli" ? "GitHub CLI sign-in" : "token from the environment"}).` }
        : { id: "copilot", status: "warn", label: "Copilot", detail: "Not signed in to GitHub yet.", fix: p.signIn?.with === "github-cli"
          ? `${cliSteps(os, p.signIn.ghInstalled)} Then open Ember's settings (${chord("settings")}) and press Check again.`
          : `Open Ember's settings (${chord("settings")}) and choose “Sign in with GitHub”, or run “gh auth login”.` };
  out.push(copilot);

  if (p.admin.error) out.push({ id: "policy", status: "fail", label: "Organisation policy", detail: `Ember is locked down: ${p.admin.error}`, fix: `Ask your administrator to fix ${p.admin.source}.` });
  else if (p.admin.source) out.push({ id: "policy", status: "ok", label: "Organisation policy", detail: `In force from ${p.admin.source}.` });
  else out.push({ id: "policy", status: "ok", label: "Organisation policy", detail: `None (optional: ${p.policyLocation ?? ADMIN_POLICY_FILE}).` });

  const micOk = !!p.microphones?.length;
  // The platform's own microphone row says what the OS allows: a second "Microphone" saying nothing is left out.
  const micRow = (p.extra ?? []).some(r => MIC_ROWS.has(r.id));
  if (!(micRow && p.microphones === null)) out.push(p.microphones === null
    ? off
      ? { id: "microphone", status: "ok", label: "Microphone", detail: "Not checked here; the settings window tests it when you turn on “Hey Ember”." }
      : { id: "microphone", status: "warn", label: "Microphone", detail: "Can't list microphones (pactl is missing). Only needed for “Hey Ember”.", fix: "sudo dnf install pulseaudio-utils" }
    : micOk
      ? { id: "microphone", status: "ok", label: "Microphone", detail: p.microphones!.slice(0, 2).join(", ") }
      : { id: "microphone", status: "warn", label: "Microphone", detail: `No microphone found. Only needed for “Hey Ember”; typing (${chord("ask")}) always works.` });
  // Missing only from a build packaged without them (Ember's own packages carry them): where they come from offline is
  // the release's Ember-voice-models zip, unzipped where Ember looks (README: Computers without internet access).
  // Listening needs only the wake word, voice activity and speech recognition; Ember's voice and Voice Match are
  // optional (the system's voice speaks meanwhile, and Voice Match is off), so their absence is said, not warned of.
  const missing = VOICE_MODELS.filter(m => (p.voiceModelsMissing ?? (p.voiceModels === "missing" ? VOICE_MODELS.map(x => x.id) : [])).includes(m.id));
  const mb = (n: number) => `${Math.max(1, Math.round(n / 1e6))} MB`;
  const optional = missing.filter(m => !LISTENING_MODELS.includes(m.id));
  const without = optional.map(m => m.id === "tts" ? "Ember's own voice (replies use the system's voice)" : "Voice Match (Ember answers anyone)").join(" and ");
  out.push(p.voiceModels === "missing"
    ? { id: "voice-models", status: "warn", label: "Speech models", detail: "Not downloaded yet. Only needed for “Hey Ember”.", fix: `Turn on “Hey Ember” in Ember's settings and download them (${mb(modelsBytes(missing.length ? missing : VOICE_MODELS))}, once)${linux ? ", or unzip the release's Ember-voice-models zip into /usr/share/ember" : ""}.` }
    : { id: "voice-models", status: "ok", label: "Speech models", detail: `${p.voiceModels === "bundled" ? "Installed with Ember." : "Downloaded."}${optional.length ? ` Without ${without} until ${optional.length > 1 ? "they're" : "it's"} downloaded in Ember's settings (${mb(modelsBytes(optional))}).` : ""}` });
  out.push(off
    ? p.speechDispatcher
      ? { id: "speech", status: "ok", label: "Speaking", detail: off.voices }
      : { id: "speech", status: "warn", label: "Speaking", detail: `${off.name} has no voice Ember can use, so Ember can't read replies aloud.` }
    : p.speechDispatcher
      ? { id: "speech", status: "ok", label: "Speaking", detail: "speech-dispatcher is installed." }
      : { id: "speech", status: "warn", label: "Speaking", detail: "speech-dispatcher is missing, so Ember can't read replies aloud.", fix: "sudo dnf install speech-dispatcher speech-dispatcher-espeak-ng" });

  if (p.desk) {
    out.push(p.desk.ok
      ? { id: "desk", status: "ok", label: "Ember's desk", detail: "Xvfb, xauth and dbus-daemon are installed." }
      : { id: "desk", status: "warn", label: "Ember's desk", detail: `Missing ${p.desk.missing.join(", ")}, so Ember works on your screen only.`, fix: "sudo dnf install xorg-x11-server-Xvfb xorg-x11-xauth dbus-daemon" });
  }

  if (p.sandbox) {
    out.push(p.sandbox.userNamespaces || p.sandbox.suidHelper
      ? { id: "sandbox", status: "ok", label: "Window sandbox", detail: p.sandbox.userNamespaces ? "User namespaces are available." : "Using the setuid sandbox helper (user namespaces are off, as on STIG hosts)." }
      // The AppImage's AppRun runs Ember without the sandbox here on purpose (it can't carry the setuid helper).
      : p.sandbox.appImage
        ? { id: "sandbox", status: "warn", label: "Window sandbox", detail: "Ember runs without Chromium's sandbox here: user namespaces are off, and an AppImage can't carry the sandbox helper. Ember's windows show only its own pages.", fix: "On a hardened computer like this one, install Ember's RPM instead: it sets up the sandbox helper." }
        : { id: "sandbox", status: "fail", label: "Window sandbox", detail: "User namespaces are off and chrome-sandbox isn't setuid root, so Ember's windows can't be sandboxed.", fix: "sudo chown root:root /opt/ember/chrome-sandbox && sudo chmod 4755 /opt/ember/chrome-sandbox (the RPM does this)" });
  }
  // The Copilot runtime needs a free file watcher for each conversation and task; with none left it takes requests
  // and never answers them.
  const w = p.fileWatchers;
  const watchersFix = "sudo sysctl -w fs.inotify.max_user_instances=512, and put fs.inotify.max_user_instances=512 in /etc/sysctl.d/90-ember.conf to keep it";
  if (w) out.push(w.max - w.used >= 8
    ? { id: "file-watchers", status: "ok", label: "Copilot's file watchers", detail: `${w.used} of ${w.max} in use.` }
    : w.used >= w.max
      ? { id: "file-watchers", status: "fail", label: "Copilot's file watchers", detail: `All ${w.max} are in use, so Copilot can't answer: it needs a free one for each conversation and task.`, fix: watchersFix }
      : { id: "file-watchers", status: "warn", label: "Copilot's file watchers", detail: `${w.used} of ${w.max} in use: Copilot needs a free one for each conversation and task, and stops answering without.`, fix: watchersFix });
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
