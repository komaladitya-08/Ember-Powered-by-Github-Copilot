/** Pure presentation of selected project metadata; file contents are never read by the renderer. */

/** Said over a project command's controls while commands are off on this computer (integrations-12), before any is typed. */
export const PROJECT_COMMANDS_OFF = "Commands are off on this computer. Turn them on in Commands to run one here.";
export const PROJECT_COMMANDS_OPEN = "Open Commands";
/** Said instead where the organisation's policy turned commands off here: no switch to send the person to (integrations-12). */
export const PROJECT_COMMANDS_MANAGED = "Your organisation has turned off commands on this computer.";
/** Whether commands may run on this computer, as the settings say (the organisation's policy already applied). */
export const projectCommandsOn = (s: { commands?: Partial<Record<string, { on?: boolean }>> } | null | undefined): boolean => s?.commands?.local?.on === true;
/** Commands on this computer: on, off by the person's switch, or off by the organisation (`admin`: its local mode). */
export function projectCommandsState(s: Parameters<typeof projectCommandsOn>[0], admin: "off" | "ask" | "on" | undefined): "on" | "off" | "managed" {
  if (admin === "off") return "managed";
  return projectCommandsOn(s) ? "on" : "off";
}
/**
 * Said in Projects where the organisation's policy turned off Ember acting in apps (`features.actions: false`): Projects
 * goes with it, for good, so the pane says so and holds its controls rather than failing at each press, and main
 * answers a stray request with the same words (integrations-r7-1).
 */
export const PROJECT_ACTIONS_MANAGED = "Your organisation has turned off Ember acting in apps, so Projects is off here.";
/**
 * Whether that is the case, from the policy as Home hears it. A lockdown (`error`) turns actions off too, but has its
 * own notice at the top of the window and takes Ember off Ready: not this.
 */
export function projectManagedOff(admin: { features?: { actions?: boolean } | null; error?: string | null } | null | undefined): boolean {
  return admin?.features?.actions === false && !admin.error;
}
/**
 * What main answers when a Projects action can't run now (integrations-r7-1, -i6): the organisation turned it off
 * (`managed`), another project step is still under way (`busy`), or, for the rest (no consent, the screen locked, the
 * settings window out of view, not connected: each said where it is seen), that it can't for now.
 */
export function projectUnavailable(o: { managed: boolean; busy: boolean }): string {
  if (o.managed) return PROJECT_ACTIONS_MANAGED;
  if (o.busy) return "Ember is still on the last project step. Wait for it to finish, or cancel it.";
  return "Project work is unavailable right now.";
}
/**
 * Projects' status line as Ember connects, or can't for now (integrations-r1): only sending waits, and what the person
 * chose and wrote stays. `files`: files are chosen; `work`: anything is (files, a request, an answer, a command).
 */
export function projectConnectionText(connected: boolean, kept: { files: boolean; work: boolean }): string {
  if (connected) return kept.files ? "Review the selection before sending." : "Choose the files for this request.";
  return kept.work ? "Ember isn't connected right now. Your work here stays, and you can send once it connects." : "Connect a model to work with project files.";
}
/**
 * Projects' status line once an answer is in (integrations-c4-1): a patch to review, a draft whose exact patch Ember
 * withholds because the patched file looks like it holds a secret (`withheld`: which file, and the line), a draft with no
 * exact patch, or an answer; and, when the answer itself looks like it holds one, that it won't go with the next send.
 */
export function projectAnswerText(o: { mode: string; patch: boolean; withheld: { name: string; line: number | null } | null; canContinue: boolean }): string {
  const where = o.withheld && (o.withheld.line ? `line ${o.withheld.line} of the patched ${o.withheld.name}` : `the patched ${o.withheld.name}`);
  const ready = o.patch ? "Patch ready to review."
    : where ? `Draft ready. Ember won't offer to apply it: ${where} appears to contain a password, token or key.`
      : o.mode === "patch" ? "Draft ready. Ember could not verify an exact patch to apply." : "Project answer ready.";
  if (o.canContinue) return ready;
  return `${ready} ${where ? "Ember won't include this answer on the next send either." : "Ember won't include this answer on the next send, as it appears to contain a password, token or key."}`;
}
export function projectBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

export function projectSelectionText(names: readonly string[], sizes: readonly (number | null)[] = []): string {
  const known = names.length === sizes.length && sizes.every(size => size !== null);
  const total = known ? sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0) : null;
  const limit = sizes.some(size => size !== null && size > 24 * 1024) || (total !== null && total > 64 * 1024);
  return `${names.length} of 6 files${total !== null ? ` · ${projectBytes(total)} total` : " · Size checked on Send"}. ${limit ? "Selection exceeds the limit. " : ""}24 KiB per file, 64 KiB per request.`;
}

export type ProjectAnswerPart = { kind: "text"; text: string } | { kind: "code"; text: string; language: string };

/** Recognise complete fenced code only. Everything else, including HTML, stays literal untrusted text. */
export function projectAnswerParts(answer: string): ProjectAnswerPart[] {
  const parts: ProjectAnswerPart[] = [];
  const fences = /^```([a-z0-9_+-]{0,30})\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n|$)/gim;
  let at = 0;
  for (const match of answer.matchAll(fences)) {
    if (match.index > at) parts.push({ kind: "text", text: answer.slice(at, match.index) });
    parts.push({ kind: "code", language: match[1], text: match[2] });
    at = match.index + match[0].length;
  }
  if (at < answer.length) parts.push({ kind: "text", text: answer.slice(at) });
  return parts;
}
