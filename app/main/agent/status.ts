/**
 * Ember's own answer to "Ember?", "status?" or "what are you doing?" (docs/ASSISTANT.md phase 6, the J1 "bare-name
 * status" of the Jarvis research): said at once from what TaskManager already knows, with no Copilot turn, so it works
 * offline and takes no premium request. FRIDAY's grammar: what's under way, how far it has got, what happens next.
 *
 * Every word is built here from task state, never from model prose: the plan steps and titles are the worker's and the
 * user's words, shown as they already are on the task's card. Pure, so it is unit-tested without Electron.
 */

import type { Task } from "./tasks";
import { plainText } from "./presenter";

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

/** What holds a running task up (TaskManager.holdUp): its question waits for the user, or it is stopping. */
export type HoldUp = (id: string) => "answer" | "stopping" | null | undefined;

/** One running task's line: "Working on “Tidy the desktop”: step 2 of 4, Move the screenshots." */
function runningLine(t: Task, now: number, holdUp?: HoldUp): string {
  const verb = t.mode === "guide" ? "Showing you" : "Working on";
  const plan = t.plan ?? [];
  const at = plan.findIndex(s => s.state === "now");
  const where = t.where ? ` ${t.where}` : "";
  // Its question is up, or a Stop is winding it down: not "Working on…".
  const held = holdUp?.(t.id);
  if (held === "answer") return `${named(t)}${where} is waiting for your answer.`;
  if (held === "stopping") return `${named(t)}${where} is stopping.`;
  if (plan.length && at >= 0) return `${verb} ${named(t)}${where}: step ${at + 1} of ${plan.length}, ${plan[at].text.replace(/[.\s]+$/, "")}.`;
  // No plan yet: how long it has been at it, rather than a guess at how far it has got.
  // (From when it began to run, not when it was asked for: it may have waited in the queue.)
  return `${verb} ${named(t)}${where}, ${durationWords(now - (t.ranAt ?? t.started))} in.`;
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

/** How `t` went: "you stopped it" only when the user did (else why it stopped: its computer went). */
function outcomeOf(t: Task): string {
  if (t.status === "cancelled" && t.stopReason) return brief(t.stopReason).replace(/[.!?…]+$/u, "");
  return OUTCOME[t.status as keyof typeof OUTCOME] ?? "done";
}

/**
 * Ember's answer to a status question (or its name alone), from the tasks TaskManager holds. `kind` is what
 * statusQuestion() said. At most three sentences, and never more than the two running tasks plus the queue's size.
 */
export function statusReply(kind: "name" | "status", tasks: readonly Task[], now: number, holdUp?: HoldUp): string {
  const running = tasks.filter(t => t.status === "running");
  const queued = tasks.filter(t => t.status === "queued").length;
  const lines = running.map(t => runningLine(t, now, holdUp));
  if (queued) lines.push(queued === 1 ? "One more is waiting to start." : `${queued} more are waiting to start.`);
  if (lines.length) return lines.join(" ");
  // Nothing under way.
  const last = lastFinished(tasks, now);
  const idle = kind === "name" ? "Yes? What can I do for you?" : "Nothing's running right now.";
  if (!last) return idle;
  return `${idle} The last thing was ${named(last)}: ${outcomeOf(last)}.`;
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
  /** Turned on, but Ember isn't speaking replies now (speaking off, a screen reader's absence, the organisation). */
  loudSilent: "Okay, but I'm not speaking replies right now, so results stay on screen. Speaking is under Voice in settings.",
  /** The organisation keeps results on screen (speakResults off by its policy). */
  managed: "Your organisation keeps results on screen, so I can't read them out.",
  failed: "I couldn't change that just now. It's under Voice in settings.",
} as const;

/**
 * Ember's answer to "just show me" or "read them out again", from what happens now: whether the switch was saved,
 * whether results are read out (`on`: the settings as applied, the organisation's policy too) and whether Ember speaks
 * replies at all now (`speaks`). It never promises results read aloud that won't be.
 */
export function resultsReply(asked: "quiet" | "loud", o: { saved: boolean; on: boolean; speaks: boolean }): string {
  if (!o.saved) return RESULTS_REPLY.failed;
  if (asked === "quiet") return RESULTS_REPLY.quiet;
  if (!o.on) return RESULTS_REPLY.managed;
  return o.speaks ? RESULTS_REPLY.loud : RESULTS_REPLY.loudSilent;
}

/** How far back "what did I miss?" looks. */
export const CATCH_UP_MS = 2 * 60 * 60_000;
/** At most this many tasks are named in a catch-up; the rest are counted. */
const CATCH_UP_TASKS = 3;

/** "What did I miss?", "catch me up", "anything new?". */
const CATCH_UP_RE = new RegExp(String.raw`^${LEAD}(?:what did i miss|what have i missed|catch me up|fill me in|anything (?:new|happen(?:ed)?)|what happened(?: while i was (?:away|gone|out))?|what(?:'s| is) new|what did you (?:do|get done))${TAIL}$`, "i");

/** Whether `text` asks what happened while the user was away. */
export function catchUpQuestion(text: string): boolean {
  const t = norm(text);
  return !!t && t.length <= 60 && CATCH_UP_RE.test(t);
}

/** A finished task's summary, cut to one short sentence for speech and the bubble (markdown gone: plainText). */
function brief(s: string): string {
  const one = plainText(s).trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return one.length > 120 ? `${one.slice(0, 119).trimEnd()}…` : one;
}

/**
 * Ember's catch-up (the Jarvis research's J4 "what did I miss" brief), from its own record only: the tasks that finished
 * in the last CATCH_UP_MS, newest first, with how each went, and what is still under way. Nothing is read from the
 * screen or sent anywhere.
 */
export function catchUpReply(tasks: readonly Task[], now: number): string {
  const finished = tasks.filter(t => t.finished !== null && now - t.finished <= CATCH_UP_MS).sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0));
  const running = tasks.filter(t => t.status === "running" || t.status === "queued").length;
  const still = running ? ` ${running === 1 ? "One task is" : `${running} tasks are`} still under way.` : "";
  if (!finished.length) return `Nothing new: no tasks finished in the last two hours.${still}`;
  const lines = finished.slice(0, CATCH_UP_TASKS).map(t => {
    const said = t.status === "done" && t.result?.summary ? ` ${brief(t.result.summary)}` : "";
    return `${named(t)}: ${outcomeOf(t)}.${said}`;
  });
  const more = finished.length - lines.length;
  const head = finished.length === 1 ? "One task finished." : `${finished.length} tasks finished.`;
  return `${head} ${lines.join(" ")}${more ? ` And ${more} more.` : ""}${still}`;
}

/** "Systems check", "are you working?", "is everything OK?": Ember reports on itself. */
const HEALTH_RE = new RegExp(String.raw`^${LEAD}(?:(?:run (?:a )?)?(?:systems? check|diagnostics?|self[- ]check)|system status|are you (?:ok|okay|alright|all right|working(?: properly)?)|is everything (?:ok|okay|alright|all right|working))${TAIL}$`, "i");

/** Whether `text` asks Ember how it is doing as a system. */
export function healthQuestion(text: string): boolean {
  const t = norm(text);
  return !!t && t.length <= 60 && HEALTH_RE.test(t);
}

/** What Ember knows of itself for a systems check (AgentStatus and main's voice). */
export interface Health {
  /** The agent's phase, and the plain sentence it has for a problem (AgentStatus.detail). */
  phase: "signed-out" | "starting" | "ready" | "error";
  detail?: string;
  /** The microphone, as VoiceService says it ("off" also when listening is turned off). */
  mic: "off" | "needs-models" | "downloading" | "starting" | "waiting" | "active" | "muted" | "error";
  /** Replies are spoken now. */
  speaks: boolean;
  /** Tasks running or waiting. */
  tasks: number;
}

/**
 * Ember's report on itself (the Jarvis research's J1: JARVIS saying "I may be malfunctioning" rather than failing
 * silently), from its own state only: whether Copilot is reachable, whether it listens and speaks, and what is under way.
 */
export function healthReply(h: Health): string {
  const brain = h.phase === "ready" ? "Copilot is connected."
    : h.phase === "starting" ? "I'm still connecting to Copilot."
      : h.phase === "signed-out" ? "I'm not signed in to GitHub yet, so I can't reach Copilot."
        : `I can't reach Copilot right now.${h.detail ? ` ${h.detail.trim().replace(/([^.!?])$/, "$1.")}` : ""}`;
  const ears: Record<Health["mic"], string> = {
    active: "I'm listening for “Hey Ember”.", waiting: "I'm listening for “Hey Ember”.", starting: "Listening is starting.",
    muted: "The microphone is off.", off: "Listening for “Hey Ember” is off.", "needs-models": "Listening needs its speech models, in settings.",
    downloading: "The speech models are downloading.", error: "Listening has a problem: settings says what.",
  };
  const mouth = h.speaks ? "" : " Replies show on screen only.";
  const work = h.tasks ? ` ${h.tasks === 1 ? "One task is" : `${h.tasks} tasks are`} under way.` : "";
  const fine = h.phase === "ready" && h.mic !== "error";
  return `${fine ? "All working." : "Something needs attention."} ${brain} ${ears[h.mic]}${mouth}${work}`;
}
