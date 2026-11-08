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
 * Projects' status line as Ember connects, or can't for now (integrations-r1): only sending waits, and what the person
 * chose and wrote stays. `files`: files are chosen; `work`: anything is (files, a request, an answer, a command).
 */
export function projectConnectionText(connected: boolean, kept: { files: boolean; work: boolean }): string {
  if (connected) return kept.files ? "Review the selection before sending." : "Choose the files for this request.";
  return kept.work ? "Ember isn't connected right now. Your work here stays, and you can send once it connects." : "Connect a model to work with project files.";
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
