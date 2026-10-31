/**
 * What the settings window says while the administrator's policy locks Ember down (Status.admin.error set): a policy
 * that can't be used, or one that changed while Ember ran (`held`, until a restart reads it). Locked down, Ember sends
 * nothing to a model service and deletes no record of its actions (admin.ts modelServiceRefusal, auditRetentionDays), so
 * the data list says that instead of where requests go and how long records are kept. Pure, so it is tested without a DOM.
 */

import type { Status } from "../../shared/ipc";

type Lockdown = Pick<Status["admin"], "error" | "held" | "retentionDays">;

/** The notice at the top of the window while Ember is locked down, or null while the policy is in force. */
export function lockdownNotice(a: Lockdown): string | null {
  if (a.error === null) return null;
  if (a.held) return "Your organisation changed Ember's policy. Restart Ember to use it.";
  return `Your organisation's Ember policy has a problem, so Ember is locked down until it's fixed (${a.error}).`;
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

/** How long the record of every action is kept, as the data list says it ("kept 30 days"). */
export function keptWords(a: Lockdown): string {
  return a.retentionDays === null ? `none deleted ${until(a)}` : `kept ${a.retentionDays} days`;
}
