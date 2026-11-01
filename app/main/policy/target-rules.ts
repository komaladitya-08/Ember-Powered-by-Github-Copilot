/**
 * Never-rules for actions in other targets' windows, called at the top of decideBase's never-rules (§4.5, L7; owned by
 * package WB). Today one rule: no borrowed mouse or keyboard (tier 3) in a WSLg app's window. All of a distro's Linux
 * windows are one msrdc.exe process to Windows, so the borrow's same-process pointer check would take a click on
 * another Linux app for the target, and Weston may drop the characters Windows types; until the window system checks a
 * RAIL window's owner chain and types by scancode there, Ember works in Linux apps through their controls (tier 1)
 * only. This module only refuses: it never allows or asks anything (the seam runs it before every never-rule), and it
 * refuses nothing off Windows, where no window is ever named "wsl:…".
 */

import { KEYS, type OS } from "../../shared/shortcuts";
import { plainQuestion, type ActionKind, type ActionRequest, type Decision } from "./policy";

/** The borrowed mouse and keyboard (tier 3). */
const BORROWED: ReadonlySet<ActionKind> = new Set<ActionKind>(["cursor_click", "cursor_text", "keys", "scroll"]);

/** What the worker hears ("Not allowed: <reason>."). */
export const WSL_TIER3_REASON = "Ember can't use the mouse or keyboard in Linux apps yet; it uses their controls instead";

/** Is `app` (a window's app, as the policy is given it) an identified WSLg window's ("wsl:<distro>:<app>")? */
export function isWslApp(app: string | undefined | null): boolean {
  return typeof app === "string" && /^wsl:[^:\s]+:\S/i.test(app.trim());
}

/** A refusal for this request on a WSL or remote window (the wsl: tier-3 rule), or null to decide as usual. */
export function targetRules(r: ActionRequest, os: OS): Decision | null {
  if (os !== "win32" || !r || !BORROWED.has(r.kind) || !isWslApp(r.app)) return null;
  // (plainQuestion is read when a decision is made, long after policy.ts, which imports this module, has loaded.)
  return { tier: "never", verdict: "deny", reason: WSL_TIER3_REASON, prompt: plainQuestion(r, KEYS[os]) };
}
