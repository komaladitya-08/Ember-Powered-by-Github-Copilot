/**
 * Ember's own answer to "Ember?", "status?" or "what are you doing?" (docs/ASSISTANT.md phase 6, the J1 "bare-name
 * status" of the Jarvis research): said at once from what TaskManager already knows, with no Copilot turn, so it works
 * offline and takes no premium request. FRIDAY's grammar: what's under way, how far it has got, what happens next.
 *
 * Every word is built here from task state, never from model prose: the plan steps and titles are the worker's and the
 * user's words, shown as they already are on the task's card. Pure, so it is unit-tested without Electron.
 */

import type { Task } from "./tasks";

/** Recent enough to be "the last thing I did" (a finished task's card has usually gone by then). */
export const RECENT_MS = 10 * 60_000;

/** What may come before the question: the name, "hey Ember", "so", "ok". */
const LEAD = String.raw`(?:(?:hey|ok|okay|so)[,\s]+)?(?:ember[,\s]+)?`;
/** What may come after: "now", "right now", "at the moment", the name again. */
const TAIL = String.raw`(?:[,\s]+(?:now|right now|at the moment|so far|then|ember))*`;

/** The questions answered here, whole: anything longer or different is the conductor's. */
const QUESTIONS = [
  String.raw`status(?: update| report)?`,
  String.raw`progress(?: report)?`,
  String.raw`what(?:'s| is) (?:the )?(?:status|progress|happening|going on)`,
  String.raw`what are you (?:doing|working on|up to)`,
  String.raw`how(?:'s| is) it going`,
  String.raw`how(?:'s| is) (?:that|the task|it) (?:going|coming along)`,
  String.raw`how are you getting on`,
  String.raw`how far (?:have you got|along are you)`,
  String.raw`are you (?:done|finished)(?: yet)?`,
  String.raw`(?:is|are) (?:it|that|they|the tasks?) (?:done|finished)(?: yet)?`,
];

const STATUS_RE = new RegExp(String.raw`^${LEAD}(?:${QUESTIONS.join("|")})${TAIL}$`, "i");
/** The name alone: "Ember?", "Hey Ember". */
const NAME_RE = /^(?:hey[,\s]+)?ember$/i;

/** Lower case, curly apostrophes made straight, and the end's punctuation gone. */
const norm = (text: string) => text.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[\s?!.…]+$/u, "").replace(/\s+/g, " ");

/** What kind of status question `text` is: the name alone, a status question, or neither (null: the conductor's). */
export function statusQuestion(text: string): "name" | "status" | null {
  const t = norm(text);
  if (!t || t.length > 60) return null;
  if (NAME_RE.test(t)) return "name";
  return STATUS_RE.test(t) ? "status" : null;
}

/** A whole number of minutes or seconds, as said ("about 3 minutes", "a few seconds"). */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return "a few seconds";
  if (s < 60) return `${s} seconds`;
  const m = Math.round(s / 60);
  return m === 1 ? "about a minute" : `about ${m} minutes`;
}

/** A task's title as said in a sentence: in curly quotes, as the bubble names things. */
const named = (t: Pick<Task, "title">) => `“${t.title}”`;

/** One running task's line: "Working on “Tidy the desktop”: step 2 of 4, Move the screenshots." */
function runningLine(t: Task, now: number): string {
  const verb = t.mode === "guide" ? "Showing you" : "Working on";
  const plan = t.plan ?? [];
  const at = plan.findIndex(s => s.state === "now");
  const where = t.where ? ` ${t.where}` : "";
  if (plan.length && at >= 0) return `${verb} ${named(t)}${where}: step ${at + 1} of ${plan.length}, ${plan[at].text.replace(/[.\s]+$/, "")}.`;
  // No plan yet: how long it has been at it, rather than a guess at how far it has got.
  return `${verb} ${named(t)}${where}, ${durationWords(now - t.started)} in.`;
}

/** The most recently finished task, if it finished within RECENT_MS. */
function lastFinished(tasks: readonly Task[], now: number): Task | null {
  let last: Task | null = null;
  for (const t of tasks) {
    if (t.finished === null || now - t.finished > RECENT_MS) continue;
    if (!last || t.finished > (last.finished ?? 0)) last = t;
  }
  return last;
}

/** How a finished task went, in a few words. */
const OUTCOME: Record<"done" | "failed" | "cancelled", string> = { done: "done", failed: "it didn't finish", cancelled: "you stopped it" };

/**
 * Ember's answer to a status question (or its name alone), from the tasks TaskManager holds. `kind` is what
 * statusQuestion() said. At most three sentences, and never more than the two running tasks plus the queue's size.
 */
export function statusReply(kind: "name" | "status", tasks: readonly Task[], now: number): string {
  const running = tasks.filter(t => t.status === "running");
  const queued = tasks.filter(t => t.status === "queued").length;
  const lines = running.map(t => runningLine(t, now));
  if (queued) lines.push(queued === 1 ? "One more is waiting to start." : `${queued} more are waiting to start.`);
  if (lines.length) return lines.join(" ");
  // Nothing under way.
  const last = lastFinished(tasks, now);
  const idle = kind === "name" ? "Yes? What can I do for you?" : "Nothing's running right now.";
  if (!last) return idle;
  const how = OUTCOME[last.status as keyof typeof OUTCOME] ?? "done";
  return `${idle} The last thing was ${named(last)}: ${how}.`;
}

/** Asking to keep results on screen only: "just show me", "stop telling me", "leave it on the screen". */
const QUIET_RE = new RegExp(String.raw`^${LEAD}(?:(?:just|only) show (?:me|it|them)|stop telling me|(?:just )?leave (?:it|them) on (?:the )?screen|stop reading (?:them|it|the results?|results)(?: out| aloud)?|don't read (?:them|it|the results?|results) (?:out|aloud))${TAIL}$`, "i");
/** Asking for them to be read out again: "read them out again", "tell me when it's done". */
const LOUD_RE = new RegExp(String.raw`^${LEAD}(?:read (?:them|it|the results?|results) (?:out|aloud)(?: again)?|tell me (?:again|when (?:it's|it is|they're|they are) (?:done|finished))|you can (?:talk|tell me) again)${TAIL}$`, "i");

/** Whether `text` asks Ember to keep task results on screen only ("quiet") or to read them out again ("loud"). */
export function resultsRequest(text: string): "quiet" | "loud" | null {
  const t = norm(text);
  if (!t || t.length > 60) return null;
  return QUIET_RE.test(t) ? "quiet" : LOUD_RE.test(t) ? "loud" : null;
}

/** Ember's answer once the switch is set (Settings › Voice shows the same switch). */
export const RESULTS_REPLY = {
  quiet: "Okay, I'll keep results on screen and won't read them out.",
  loud: "Okay, I'll read results out again.",
} as const;
