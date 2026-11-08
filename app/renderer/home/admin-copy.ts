/**
 * What the settings window says while the administrator's policy locks Ember down (Status.admin.error set): a policy
 * that can't be used, or one that changed while Ember ran (`held`, until a restart reads it). Locked down, Ember sends
 * nothing to a model service and deletes no record of its actions (admin.ts modelServiceRefusal, auditRetentionDays), so
 * the data list says that instead of where requests go and how long records are kept. Pure, so it is tested without a DOM.
 */

import type { Status } from "../../shared/ipc";
import type { OS } from "../../shared/shortcuts";
import { TARGET_FEATURE_TEXT, targetFeatureApplies } from "./computers-copy";

type Lockdown = Pick<Status["admin"], "error" | "held" | "retentionDays">;

/**
 * The notice at the top of the window while Ember is locked down, or null while the policy is in force. It never quotes
 * the policy's error (a file path and a parser's message, safety-privacy-4): `ember doctor` and the log name it for
 * whoever manages the computer.
 */
export function lockdownNotice(a: Lockdown): string | null {
  if (a.error === null) return null;
  if (a.held) return "Your organisation changed Ember's policy. Restart Ember to use it.";
  return "Your organisation's Ember policy has a problem, so Ember is locked down until it's fixed. Ask whoever manages this computer to fix it.";
}

/** Until when the lockdown lasts, in the data list's words. */
const until = (a: Lockdown) => (a.held ? "until you restart Ember" : "until your organisation fixes its policy");

/**
 * The data list's "When you ask something" line after its bold words while Ember is locked down, or null to keep the
 * page's own (which names the model service requests go to).
 */
export function lockdownSendLine(a: Lockdown): string | null {
  return a.error === null ? null : `, nothing is sent to a model service ${until(a)}, so Ember can't answer or act.`;
}

/**
 * The data list's microphone line while Ember is locked down (safety-privacy-r4): the text around its recipient
 * (`before` and `after` the "goes to …" span) with the sentence on what a conversation sends said as nothing sent
 * anywhere, instead of "goes to no model service (…) as text". Null when not locked down, or for words it doesn't know.
 */
export function lockdownMicWords(a: Lockdown, before: string, after: string): [string, string] | null {
  if (a.error === null) return null;
  const start = before.lastIndexOf("Once you call Ember");
  const end = after.indexOf("seconds.");
  if (start < 0 || end < 0) return null;
  return [`${before.slice(0, start)}Nothing it hears is sent anywhere ${until(a)}.`, after.slice(end + "seconds.".length)];
}

/** How long the record of every action is kept, as the data list says it ("kept 30 days"). */
export function keptWords(a: Lockdown): string {
  return a.retentionDays === null ? `none deleted ${until(a)}` : `kept ${a.retentionDays} days`;
}

/**
 * What each switch the administrator can turn off (admin.ts AdminPolicySchema `features`) is called in the notice at the
 * top of the window: every key has words, so the notice never shows a raw key such as "routines" or "aiReview".
 */
export const FEATURE_TEXT: Readonly<Record<string, string>> = {
  voice: "listening for “Hey Ember”", speak: "speaking out loud", actions: "acting in apps (Ember can still answer and show you how)",
  cursor: "borrowing your mouse", desk: "Ember's own desk", screenImages: "sending screenshots", memory: "remembering between runs",
  routines: "keeping routines and reminders", updates: "checking for new versions", aiReview: "Copilot's review of commands", extensions: "adding extensions",
  autonomy: "working without asking", userProvider: "using your own model provider", ...TARGET_FEATURE_TEXT,
};

/** The switches the administrator turned off that mean something on `os`, in the notice's words. */
export function turnedOffWords(features: Status["admin"]["features"], os?: OS): string[] {
  return Object.entries(features).filter(([k, v]) => v === false && targetFeatureApplies(k, os)).map(([k]) => FEATURE_TEXT[k] ?? k);
}
