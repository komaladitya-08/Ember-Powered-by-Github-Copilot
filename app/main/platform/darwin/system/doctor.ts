/**
 * What `ember --doctor` checks on a Mac beyond the shared rows (design §9.9): each permission Ember needs, with the
 * System Settings path to fix it and the "remove and add again" advice an updated ad-hoc-signed copy needs; secure
 * keyboard entry, naming the app that holds it (a stuck Secure Keyboard Entry otherwise turns Ember's keyboard off
 * with no visible reason); where Ember.app is; and root. Run from Terminal, macOS judges Terminal's permissions, not
 * Ember's: DOC gives the LaunchServices form that judges Ember itself. Microphones aren't listed here (that needs a
 * renderer; the settings window tests it), and speech uses the system's voices, so those probes are fixed answers.
 */

import type { PlatformDoctorProbes, PlatformDoctorRow } from "../../types";
import { REGRANT, readPermissions, secureInputState, type PermissionDeps } from "./permissions";

const PRIVACY = "System Settings › Privacy & Security";

/** The macOS rows, from what the permission reads answer now. */
export function darwinDoctorRows(d: PermissionDeps): PlatformDoctorRow[] {
  const p = readPermissions(d);
  const rows: PlatformDoctorRow[] = [];
  rows.push(p.accessibility
    ? { id: "accessibility-permission", status: "ok", label: "Accessibility", detail: "Allowed: Ember can read and use apps." }
    : { id: "accessibility-permission", status: "fail", label: "Accessibility", detail: "Not allowed, so Ember can't read or use apps.", fix: `${PRIVACY} › Accessibility: switch Ember on. ${REGRANT}` });
  rows.push(p.screen === "granted"
    ? { id: "screen-recording", status: "ok", label: "Screen Recording", detail: "Allowed. macOS asks again about once a month; choose Allow." }
    : { id: "screen-recording", status: "warn", label: "Screen Recording", detail: "Not allowed, so Ember can't take screenshots or see other apps' window titles.", fix: `${PRIVACY} › Screen Recording: switch Ember on, then quit and reopen Ember. ${REGRANT}` });
  if (p.inputMonitoring !== null) {
    rows.push(p.inputMonitoring
      ? { id: "input-monitoring", status: "ok", label: "Input Monitoring", detail: "Allowed: Ember notices when you take over the keyboard." }
      : { id: "input-monitoring", status: "warn", label: "Input Monitoring", detail: "Not allowed, so Ember won't use the keyboard for you: it couldn't notice you taking over.", fix: `${PRIVACY} › Input Monitoring: switch Ember on. ${REGRANT}` });
  }
  rows.push(p.microphone === "denied" || p.microphone === "restricted"
    ? { id: "microphone-permission", status: "warn", label: "Microphone access", detail: "Off for Ember, so “Hey Ember” can't hear you.", fix: `${PRIVACY} › Microphone: switch Ember on. ${REGRANT}` }
    : { id: "microphone-permission", status: "ok", label: "Microphone access", detail: p.microphone === "granted" ? "Allowed." : "Not asked yet: Ember asks when you turn on “Hey Ember”." });
  const secure = secureInputState(d);
  if (secure.on === true) {
    const where = secure.holder ? ` in ${secure.holder}` : "";
    rows.push({ id: "secure-input", status: "warn", label: "Secure input", detail: `Secure keyboard entry is on${where}, so Ember won't look at the screen or use the mouse or keyboard until it's off.`,
      fix: `Close the password field${where}, or turn off Secure Keyboard Entry there (Terminal: Terminal menu › Secure Keyboard Entry).` });
  } else if (secure.on === false) {
    rows.push({ id: "secure-input", status: "ok", label: "Secure input", detail: "Off." });
  } else if (d.windows()) {
    rows.push({ id: "secure-input", status: "warn", label: "Secure input", detail: "Ember can't tell whether a password is being typed, so it won't look at the screen or use the mouse or keyboard." });
  }
  rows.push(p.inApplications
    ? { id: "location", status: "ok", label: "Location", detail: "In the Applications folder." }
    : { id: "location", status: "warn", label: "Location", detail: "Not in the Applications folder, so its permissions and login item may not stick.", fix: "Quit Ember, drag it into Applications and open it from there." });
  if (p.root) rows.push({ id: "root", status: "warn", label: "Root", detail: "Ember is running as root.", fix: "Start it as yourself." });
  return rows;
}

/** The macOS doctor probes (design §9.9). */
export function darwinDoctorProbes(d: PermissionDeps): Promise<PlatformDoctorProbes> {
  return Promise.resolve({
    microphones: null,
    speechDispatcher: true,
    sandbox: null,
    fileWatchers: null,
    desk: null,
    extra: darwinDoctorRows(d),
  });
}
