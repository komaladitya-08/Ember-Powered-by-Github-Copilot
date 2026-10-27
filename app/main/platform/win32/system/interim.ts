/**
 * The functions and data the Windows composition takes from the rest of the port, in one place: Phase 1's compose.ts
 * (withSystemDialog, cleanEnv, hostEnv, hoverShaper), which.ts, hands/system.ts (parseOnOff, appEnv, findApp,
 * programsOf, isTerminalApp and hasBuiltInShell with their `os`), hands/terminals.ts (LAUNCHERS), admin.ts
 * (parseAdminPolicy, lockedDown), never-look.ts, clipboard-formats.ts, policy/vocabulary.ts and policy.ts (the
 * Windows security vocabulary) and port/host's TEST_SWITCHES. This file held provisional copies while those packages
 * were written; it now only passes on theirs, so win32/'s modules keep their single import site and nothing else in
 * win32/ moves. What is still written here is small and says why: the case-insensitive environment lookup the Windows
 * modules share, a window-class test over SECURITY_CLASS.win32, and the catalogue's `programs` judged as well by the
 * terminal and shell checks (as the provisional checks did; hands/system.ts reads only id, name, argv and class).
 *
 * Plain Node: no Electron, no native code.
 */

import { hasBuiltInShell as hasShell, isTerminalApp as isTerminal } from "../../../hands/system";
import { REFUSED } from "../../../hands/terminals";
import { NEVER_LOOK_DEFAULTS } from "../../../../shared/never-look";
import { CLIPBOARD_FORMATS } from "../../../agent/clipboard-formats";
import { SECURITY_CLASS } from "../../../policy/vocabulary";
import type { OS } from "../../../../shared/shortcuts";
import type { AppIdentity, ClipboardFormats } from "../../types";

export { cleanEnv, hostEnv, hoverShaper, withSystemDialog } from "../../compose";
export { which } from "../../which";
export { appEnv, findApp, parseOnOff, programsOf } from "../../../hands/system";
export { LAUNCHERS } from "../../../hands/terminals";
export { lockedDown, parseAdminPolicy } from "../../../admin";
export { isSecurityWindow } from "../../../policy/policy";
/** port/host's TEST_SWITCHES (app/sidecar-host/launch.ts): kept for a development host only (hostEnv). */
export { TEST_SWITCHES as HOST_TEST_SWITCHES } from "../../../../sidecar-host/launch";

/** NEVER_LOOK_DEFAULTS.win32 (app/shared/never-look.ts). */
export const NEVER_LOOK_DEFAULTS_WIN32: readonly string[] = NEVER_LOOK_DEFAULTS.win32;

/** CLIPBOARD_FORMATS.win32 (agent/clipboard-formats.ts). */
export const CLIPBOARD_FORMATS_WIN32: ClipboardFormats = CLIPBOARD_FORMATS.win32;

/**
 * A variable's value, its name compared case-insensitively on Windows (Node keeps the stored spelling, "Path"), the
 * first such name in the environment's order. which.ts has the same rule inside; this one serves the Windows modules.
 */
export function envValue(env: NodeJS.ProcessEnv, name: string, os: OS = "win32"): string | undefined {
  if (os !== "win32") return env[name];
  const upper = name.toUpperCase();
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === upper && v !== undefined) return v;
  return undefined;
}

/** A credential or consent dialog's window class (SECURITY_CLASS.win32, stored lower case), any case. */
export function isSecurityClass(className: string): boolean {
  return SECURITY_CLASS.win32.includes(className.trim().toLowerCase());
}

/** Does any of the catalogue's `programs` for this app (what its windows report) pass `check` on its own? */
const anyProgram = (app: AppIdentity, check: (program: AppIdentity) => boolean) =>
  ((app as { programs?: readonly string[] }).programs ?? []).some(p => check({ id: p, name: p }));

/**
 * hands/system.ts isTerminalApp(app, os), or one of the app's programs is itself a terminal, a shell, an app with one
 * built in, or a program Ember never starts (REFUSED). Judged by name only, so a program that is an interpreter (a
 * pythonw-started app) isn't taken for an interactive one.
 */
export function isTerminalApp(app: AppIdentity, os: OS): boolean {
  return isTerminal(app, os) || anyProgram(app, p => isTerminal(p, os) || REFUSED[os].test(p.id));
}

/** hands/system.ts hasBuiltInShell(app, os), or one of the app's programs has a shell built in. */
export function hasBuiltInShell(app: AppIdentity, os: OS): boolean {
  return hasShell(app, os) || anyProgram(app, p => hasShell(p, os));
}
