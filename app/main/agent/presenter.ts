/**
 * Turns Copilot session events into what Ember shows: mood, bubble text,
 * current step and talking. Pure apart from timers, so it is unit-tested with
 * scripted events.
 */

import type { BubbleState, EmberState } from "../../shared/overlay";
import type { Emotion, Gesture } from "@ember/characters";
import { IDLE_BUBBLE } from "../../shared/overlay";
import { SHORTCUTS, type ShortcutTable } from "../../shared/shortcuts";
import { WHOLE_KEY_HINT, WHOLE_KEY_SAY, WHOLE_UNREAD_SAID, plainMarkdown } from "@ember/bubble";
import { ANNOUNCE_MS } from "../commands/flow";
import { announcement, firstPerson, keyboardRoute } from "../../renderer/overlay/target-copy";

export interface PresenterEvent { type: string; data?: Record<string, unknown> }

const KEEP_CHARS = 600;
/** The user's request as "Thinking…" quotes it: its first 120 characters, marked when cut short. */
const quoted = (text: string) => `“${text.length > 120 ? `${text.slice(0, 119).trimEnd()}…` : text}”`;
const clip = (s: string) => (s.length > KEEP_CHARS ? s.slice(0, KEEP_CHARS - 1).trimEnd() + "…" : s);
/** Answers longer than this don't fit the bubble: it offers "Read all". */
export const LONG_ANSWER = 260;
/**
 * About as many characters as one of the bubble's lines holds (300 px wide, 14 px Ember Sans), a little on the short side;
 * fewer at a larger text size (answerLines' scale).
 */
const LINE_CHARS = 36;
/** The lines a finished answer shows before it is cut off (BUBBLE_CSS's .eb-thought). */
const ANSWER_LINES = 6;

/**
 * How many of the bubble's lines `text` takes: each of its lines (the bubble keeps line breaks, so an empty one is a
 * line too) wraps onto as many as its length needs. `scale`: the user's text size (page-prefs' textScale: 1.15 at
 * Large, 1.3 at Larger): the bubble keeps its width while its type grows, so a line holds that many times fewer
 * characters (cross-review X2). A scale that makes no sense counts as 1.
 */
export function answerLines(text: string, scale = 1): number {
  const s = Number.isFinite(scale) && scale > 1 ? Math.min(scale, 3) : 1;
  const chars = Math.max(1, Math.floor(LINE_CHARS / s));
  return text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.trim().length / chars)), 0);
}

/** A finished answer the bubble shows only the start of (at the user's text size, `scale`): it offers "Read all". */
export function cutShort(text: string, scale = 1): boolean {
  return text.length > LONG_ANSWER || answerLines(text, scale) > ANSWER_LINES;
}

/**
 * Markdown the model may use anyway, removed so the bubble and speech read naturally. The bubble's rules
 * (its plainStream shows the answer while it streams), so the words don't change once the answer is done.
 */
export function plainText(s: string): string {
  return plainMarkdown(s);
}

/** friendlyError's sentence for a sign-in Copilot refused (the host then asks Copilot whether the sign-in still holds). */
export const SIGN_IN_REFUSED = "Copilot didn't accept the sign-in. Open settings to sign in again.";

/**
 * One plain sentence for an error from Copilot, instead of the raw SDK or HTTP text.
 * `raw` is kept for the log by the caller. `provider`: the organisation's own model service
 * is configured (there is no GitHub sign-in to blame then). `settingsKey`: the settings
 * shortcut as this OS writes it (default Linux's "Ctrl+Alt+E"); null while another app holds
 * it: the sentence names none (cross-review X5).
 */
export function friendlyError(raw: string, errorType?: string, ctx: { statusCode?: number; provider?: boolean; settingsKey?: string | null } = {}): string {
  const key = ctx.settingsKey === undefined ? SHORTCUTS.linux.settings.label : ctx.settingsKey;
  /** "in settings (Ctrl+Alt+E)", or where to go without a shortcut. */
  const inSettings = (own: boolean) => (key ? `in ${own ? "Ember's " : ""}settings (${key})` : "in Ember's settings");
  const m = `${errorType ?? ""} ${raw}`;
  const status = ctx.statusCode ?? Number(/\b(?:HTTP|status|code)?\s*\(?(40[1-4]|429)\b/i.exec(raw)?.[1] ?? 0);
  const service = ctx.provider ? "your organisation's model service" : "Copilot";
  // Before the policy rule: a filtered prompt mentions a "content management policy", not the user's seat.
  if (/content.?(management|filter)|content_filter|filtered due to|responsible ?ai/i.test(m)) return `${ctx.provider ? "The model service's" : "Copilot's"} content filter blocked that request. Try asking in other words.`;
  if (ctx.provider && (errorType === "authentication" || status === 401 || status === 403 || /authenticat|unauthori[sz]ed|forbidden/i.test(m))) {
    return "Your organisation's model service refused the request. Ask your administrator to check Ember's model service settings.";
  }
  const refused = "Copilot refused this for your account (an organisation policy or a missing Copilot seat).";
  if (status === 403) return refused;
  if (errorType === "authentication" || status === 401 || /authenticat|unauthori[sz]ed|bad credentials|not signed in/i.test(m)) return SIGN_IN_REFUSED;
  if (errorType === "rate_limit" || status === 429 || /quota|rate.?limit|\b402\b|credits/i.test(m)) return `${ctx.provider ? "The model service's" : "Copilot's"} usage limit was reached for now. Try again a bit later.`;
  if (/model_not_supported|model.{0,20}(not (available|supported|found))|unknown model|model_not_found/i.test(m) || (ctx.provider && status === 404)) return `The model I'm set to use isn't available. Pick another one ${inSettings(false)}.`;
  if (/policy|\b403\b|forbidden|\bseat\b|subscription/i.test(m)) return refused;
  // The whole conversation (not this request) went over the model's limit: a new conversation starts when Ember restarts.
  if (/prompt token count|exceeds the limit|token_?limit|max_prompt_tokens/i.test(m)) return "That's more than the model can take in at once: this conversation may have got too long. Try a shorter request, or quit and reopen Ember to start a new conversation.";
  if (/context.?(length|limit|window)|too (long|large)|max.?tokens/i.test(m)) return "That was too much for me to handle at once. Try a shorter request.";
  // The runtime's own connection went away ("Pending response rejected since connection got disposed").
  if (/ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|fetch failed|socket|could not connect|connection (is |got |was )?(disposed|closed|lost|refused)|pending response rejected|disconnected/i.test(m)) return `I can't reach ${service} right now. Check the network, then ask again.`;
  if (/\b50[0234]\b|bad gateway|service unavailable|gateway time-?out|internal server error|overloaded/i.test(m)) return `${ctx.provider ? "Your organisation's model service" : "Copilot"} had a problem on its side. Try again in a moment.`;
  // A request that timed out (not the network's ETIMEDOUT, which is above).
  if (/timed? ?out|timeout|took too long/i.test(m)) return `${ctx.provider ? "The model service" : "Copilot"} took too long to answer. Try again in a moment.`;
  const short = raw.replace(/\{[\s\S]*\}/g, "").replace(/^\w*Error:\s*/, "").trim();
  const who = ctx.provider ? "The model service" : "Copilot";
  // Only a status code is left (a JSON body said nothing more): a refused request.
  if (/^\(?4\d\d\)?$/.test(short)) return `${who} refused that request (${short.replace(/[()]/g, "")}). Try asking in other words.`;
  // Anything else: no raw text (it reads as a code error, and is spoken when speech is on); the caller logs it.
  return `${who} reported a problem. Try again; if it keeps happening, check ${ctx.provider ? "the model service" : "Copilot"} ${inSettings(true)}.`;
}

/**
 * The question keys' words while a question's whole text waits to be read (review #116): the approve key's "allow"
 * becomes what it does then ("Ctrl+Alt+Y shows the next part", "Control Alt Y to show the next part"), named by the chord
 * Ember holds; the others as they are. An approve key whose words don't end so is left out: never said to allow.
 */
export function readKeyWords(keys: readonly { which: "primary" | "deny"; hint: string; say: string }[]): { hint: string; say: string }[] {
  return keys.flatMap(k => {
    if (k.which !== "primary") return [{ hint: k.hint, say: k.say }];
    const hint = /^(.+) allow$/.exec(k.hint)?.[1];
    const say = /^(.+) to allow$/.exec(k.say)?.[1];
    return hint && say ? [{ hint: `${hint} ${WHOLE_KEY_HINT}`, say: `${say} ${WHOLE_KEY_SAY}` }] : [];
  });
}

/**
 * A question as Ember says it aloud and puts it in a notification, naming where it comes from when that isn't this
 * computer (§2.4): "Ember asks, on build-01: Click Save in gedit? Press …". `spoken` makes the prompt fit for speech;
 * `keys` are the held keys that answer it, as they are said. A question with a whole text to read (`detail`, review #116)
 * says that Allow waits for all of it to have been shown (its keys then say the approve key shows the next part).
 */
export function questionAloud(q: { prompt: string; where?: string; detail?: string }, o: { keys?: readonly string[]; spoken?: (s: string) => string } = {}): { say: string; notify: string } {
  const where = q.where?.replace(/\s+/g, " ").trim();
  const keys = o.keys ?? [];
  return {
    say: `Ember asks${where ? `, ${where}` : ""}: ${(o.spoken ?? (s => s))(q.prompt)}${q.detail ? ` ${WHOLE_UNREAD_SAID}` : ""}${keys.length ? ` Press ${keys.join(", or ")}.` : ""}`,
    notify: where ? `${where.charAt(0).toUpperCase()}${where.slice(1)}: ${q.prompt}` : q.prompt,
  };
}

/**
 * Whether Ember's settings can fix the problem `said` (friendlyError's sentence): a sign-in, the model, the account's
 * access or the organisation's endpoint settings. Not the network, a limit, a filter or a hiccup on Copilot's side: an
 * "Open settings" there would lead nowhere.
 */
export function settingsHelps(said: string): boolean {
  return /\bsettings?\b|sign(?:-| )?in|for your account|Copilot seat|isn't available to this account/i.test(said);
}

/**
 * A problem's title: what failed, in a few words ("I can't reach Copilot"), from its sentence (friendlyError's, or one
 * of Ember's own); "Copilot had a problem" when it says nothing more particular. `provider`: the organisation's own
 * model service is configured (a problem on its side is said as its).
 */
export function problemTitle(said: string, provider = false): string {
  const service = provider ? "The model service" : "Copilot";
  if (/content filter/i.test(said)) return "Request blocked";
  if (/didn't accept the sign-in/i.test(said)) return "Copilot didn't accept the sign-in";
  if (/\brefused\b/i.test(said)) return `${service} refused it`;
  if (/usage limit/i.test(said)) return "Usage limit reached";
  if (/model I'm set to use/i.test(said)) return "That model isn't available";
  if (/too much for me/i.test(said)) return "Too much at once";
  if (/can't reach|\bnetwork\b/i.test(said)) return provider ? "I can't reach the model service" : "I can't reach Copilot";
  if (/isn't answering|didn't answer|not answering/i.test(said)) return "Copilot isn't answering";
  if (/stopped unexpectedly/i.test(said)) return "Copilot stopped";
  if (/file watchers/i.test(said)) return "Copilot can't work right now";
  return `${service} had a problem`;
}

/**
 * A sentence written for the settings window, as the bubble says it: in Ember's own voice (firstPerson), and since the
 * bubble has no "Check again" button (its "Open settings" leads there) and runs no commands, those are said as where to
 * go instead.
 */
export function forBubble(text: string): string {
  return firstPerson(text)
    .replace(/,? or run “gh auth login” in a terminal and press Check again\./g, " in settings.")
    .replace(/\bPress Check again to retry\b/g, "Open settings to try again")
    .replace(/\bPress Check again\./g, "Open settings to try again.");
}

/** How long a question's answer ("Okay, I won't.") stays before what waited behind the question shows. */
const ACK_MS = 1500;
/** A task whose work is in the bubble keeps it while it writes; this long without a word, another task's work may show. */
const QUIET_MS = 15_000;

/**
 * How a write claims the shared bubble.
 * - "progress": a task at work. It shows only while nobody holds the bubble and no other task's work is
 *   in it (the task's card shows it meanwhile).
 * - "reply": something to read (the conversation's turn and answer, a task's result, a guide between its
 *   steps). It shows when nobody else holds the bubble, then holds it until it goes.
 * - "step": a guide step. Like a reply, and it also replaces an answer that has finished.
 * - "take": the user asked, or Ember itself has to say something: it shows now.
 * Main's own bubble ("Listening…") holds off all but "take"; a question with buttons holds off everything.
 */
export type Claim = "progress" | "reply" | "step" | "take";

/**
 * The bubble every presenter shares (the conversation and each task). `current` wrote it last: a
 * presenter's timer only hides the bubble it still owns. `holder` holds it: an answer being read, a
 * task's result, a guide step, or main's own bubble. A write it holds off waits; when the bubble is
 * free again, the latest one waiting shows (an answer or a result before a task's progress).
 * One task's work is in the bubble at a time: it stays there until that task's bubble goes (it
 * finished, or stopped) or it goes quiet; the other tasks' work shows on their cards meanwhile.
 */
export class BubbleOwner {
  /** The shared bubble for `o`: a plain `{ current }` object (as older tests share) gets one of its own. */
  static of(o: BubbleOwner | { current: object | null }): BubbleOwner {
    if (o instanceof BubbleOwner) return o;
    let b = plainOwners.get(o);
    if (!b) plainOwners.set(o, b = new BubbleOwner());
    return b;
  }

  current: object | null = null;
  holder: object | null = null;
  /** Presenters with something to show, the latest last. */
  private showing: Presenter[] = [];
  /** A question was answered just now: its answer stays a moment before anything replaces it. */
  private acking = false;
  private waitingForAnswer = false;
  /** The task whose work the bubble shows, and when it last wrote. */
  private stage: { p: Presenter; at: number } | null = null;
  /** The presenter whose bubble was on screen when main took the bubble: main's own covers it until main's hold ends. */
  private covered: Presenter | null = null;
  /** A guide step waits behind an answer that has finished: it shows when this fires. */
  private stepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    /** A question with buttons is up (main shows nothing else meanwhile); `answered` resolves once none is. */
    private question?: { up: () => boolean; answered: () => Promise<void> },
    private timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
    private now: () => number = Date.now,
  ) {}

  /**
   * Main writes the bubble itself now ("Listening…", the kill switch's message). The bubble it covers keeps
   * its reading time for when it shows again: under main's, it isn't being read (and main may put it back).
   */
  claim(by: object): void {
    if (this.holder !== by) this.covered = this.current instanceof Presenter ? this.current : null;
    this.covered?.letGo();
    this.current = by;
    this.holder = by;
  }

  /**
   * Main's hold is over: the bubble it covered stays (to show again, its reading time starting over) if `keep`
   * says so; otherwise main replaced it for good. Returns the one kept.
   */
  uncover(keep: (p: Presenter) => boolean): Presenter | null {
    const c = this.covered;
    this.covered = null;
    if (!c || keep(c)) return c;
    c.drop();
    return null;
  }

  /** May `p` write the bubble now? */
  allows(p: Presenter, claim: Claim): boolean {
    if (this.questionUp()) return false;
    const h = this.holder;
    // Another task's work is in the bubble and still going: this task's work shows on its card.
    const s = this.stage;
    if (claim === "progress" && s && s.p !== p && s.p.visible && this.now() - s.at < QUIET_MS) return false;
    if (h === null || h === p || claim === "take") return true;
    // A guide step replaces an answer that has finished (not one still coming, nor main's bubble).
    return claim === "step" && h instanceof Presenter && !h.busy;
  }

  /** `p` wrote its bubble: on screen, or waiting to show when the bubble is free. */
  wrote(p: Presenter, claim: Claim, onScreen: boolean): void {
    this.showing = this.showing.filter(x => x !== p);
    if (p.visible) this.showing.push(p);
    if (claim === "take") {
      // Taken from main's own bubble (the user asked meanwhile): what main covered is over, unless it's still at work.
      if (this.holder !== null && !(this.holder instanceof Presenter)) this.uncover(c => c === p || c.atWork || c.waiting);
      this.holder = p;
    }
    // The task on stage is still at work even while something else covers its bubble.
    if (claim === "progress" && (onScreen || this.stage?.p === p)) this.stage = { p, at: this.now() };
    if (!onScreen) return;
    this.current = p;
    if (claim !== "progress") this.holder = p;
    else if (this.holder === p) this.holder = null;
  }

  /**
   * `p`'s bubble on screen is complete (its answer finished streaming). A guide step that came while it streamed, and
   * hasn't shown yet, replaces it ACK_MS later rather than after its whole reading time: the user is to act on the
   * step (the answer stays in the transcript, and "Read the last answer" has it).
   */
  finished(p: Presenter): void {
    if (this.stepTimer || this.holder !== p || !this.showing.some(x => x !== p && x.stepWaiting)) return;
    this.stepTimer = this.timers.set(() => {
      this.stepTimer = null;
      const h = this.holder;
      // Something else took the bubble meanwhile: the step waits for that one to finish instead.
      if (h !== p) { if (h instanceof Presenter && !h.busy) this.finished(h); return; }
      if (p.busy) return;
      [...this.showing].reverse().find(x => x !== p && x.stepWaiting)?.reshow("step");
    }, ACK_MS);
  }

  /** `p` has nothing to show any more (and holds nothing). */
  forget(p: Presenter): void {
    this.showing = this.showing.filter(x => x !== p);
    if (this.holder === p) this.holder = null;
    if (this.stage?.p === p) this.stage = null;
  }

  /** `p`'s bubble went: if it was on screen, the latest one waiting shows instead. Returns whether one did. */
  gone(p: Presenter): boolean {
    const had = this.holder === p || this.current === p;
    this.forget(p);
    return had && this.free();
  }

  /**
   * Nobody holds the bubble (or a question went): the holder's bubble shows again, else the latest
   * answer or result waiting, else the latest task's work. Returns whether something showed.
   */
  free(): boolean {
    if (this.questionUp()) return false;
    const h = this.holder;
    if (h !== null && !(h instanceof Presenter)) return false;
    const latest = [...this.showing].reverse();
    return [...(h ? [h] : []), ...latest.filter(p => p.kind !== "progress"), ...latest].some(p => p.reshow());
  }

  /** A question is up, or was answered just now. What it holds off shows after it (free()). */
  private questionUp(): boolean {
    if (this.acking) return true;
    if (!this.question?.up()) return false;
    if (this.waitingForAnswer) return true;
    this.waitingForAnswer = true;
    void this.question.answered().then(() => {
      this.waitingForAnswer = false;
      this.acking = true;
      this.timers.set(() => { this.acking = false; this.free(); }, ACK_MS);
    });
    return true;
  }
}

const plainOwners = new WeakMap<object, BubbleOwner>();

export interface PresenterOptions {
  /**
   * A task's presenter: its work shows in the bubble only while nobody holds it (its card shows the step anyway).
   * Given as the task's id, its bubbles carry it (the corner card pairs them with that task's row).
   */
  task?: boolean | string;
  /** Every event of the session it shows, before it's shown (the host follows which request's turn is running). */
  onEvent?: (e: PresenterEvent) => void;
  /** Something went wrong and the bubble says so (the conversation section keeps it). */
  onProblem?: (text: string) => void;
  /** Ember's shortcuts on this OS, for the settings shortcut errors name (default Linux's). */
  shortcuts?: ShortcutTable;
  /**
   * The settings shortcut as Ember holds it now (main asks hasKey), or null while another app holds it: Read all's route
   * and the errors that send the user to settings name it only then (cross-review X5). Asked at each bubble. Absent: the
   * table's (`shortcuts`); a check that fails names none.
   */
  settingsKey?: () => string | null;
  /** The stop chord as Ember holds it now, or null: an announcement names it only then (cross-review X0). As settingsKey. */
  stopKey?: () => string | null;
  /**
   * Where the task acts when it isn't this computer ("on build-01", "in Ubuntu (WSL)", §2.4): every bubble of this
   * presenter carries it as its badge. Absent: no badge, as before targets existed.
   */
  where?: string;
  /** An announcement went up (D4.4): main speaks it when replies are spoken. */
  onAnnounce?: (text: string) => void;
  /** The clock for when a bubble reached the screen (shownAt; default Date.now). */
  now?: () => number;
  /** How many times its usual time each bubble stays (the user's "More time to read and answer"; default 1). */
  readTime?: () => number;
  /**
   * How much the bubble's type is scaled (the user's text size, page-prefs' textScale; default 1): a finished answer
   * that needs more than the bubble's six lines at that size offers Read all (cross-review X2). Asked at each answer.
   */
  textScale?: () => number;
}

/**
 * How many times its usual time each bubble stays, and a question waits: the user's "More time to read and answer".
 * Ten times, as WCAG 2.2.1 asks of a time limit the user can adjust (a question waits 20 minutes instead of 2).
 */
export function readTimeOf(moreTime: boolean): number {
  return moreTime ? 10 : 1;
}

/** A bubble of Ember's own that is no turn's or task's (the targets runtime's: a connection, an offer, a loss). */
export type NoticeBubble = Pick<BubbleState, "title" | "thought" | "actions" | "mood"> & Partial<Pick<BubbleState, "step">>;

/** How a NoticeBubble claims the shared bubble (Presenter.post). */
export interface NoticeOptions {
  /**
   * "take" (the default): it shows now, over the conversation's and the tasks' bubbles, which wait behind it as they
   * do behind a question. "reply": only once nobody else holds the bubble (an offer nobody asked for, or an update to
   * a bubble something else has covered since).
   */
  claim?: "take" | "reply";
  /** It goes this long after it reaches the screen. Absent: it stays until it is cleared or replaced. */
  ms?: number;
  /** Ember's face meanwhile (default neutral). */
  emotion?: Emotion;
}

/**
 * The shared bubble's writer for bubbles of Ember's own (AgentHost.notices; the targets runtime posts through it):
 * one at a time, each replacing the last. Writing through the shared bubble keeps what the conversation and the tasks
 * show from wiping its buttons, and keeps any presenter's timer (its own too) from hiding a bubble it didn't write.
 */
export interface NoticeBoard {
  post(b: NoticeBubble, o?: NoticeOptions): void;
  /** Its bubble goes (on screen or waiting); what waited behind it shows. Nothing happens when it has none. */
  clear(): void;
  /** It has a bubble up, or waiting to show. */
  readonly visible: boolean;
  /** When its bubble last reached the screen (the clock's ms), or null while it hasn't since it was posted. */
  readonly shownAt: number | null;
  /** How long its bubble has been on screen (since shownAt), or null while it hasn't shown. */
  readonly shownFor: number | null;
}

export const TOOL_STEPS: Record<string, string> = {
  set_appearance: "Changing how I look",
  describe_screen: "Looking at your screen",
  start_task: "Starting a task",
  perceive_window: "Reading the window",
  // Not "Showing you": that is the guiding chip's word beside it.
  point_at: "Pointing at it",
  wait_for_click: "Waiting for your click",
  list_windows: "Looking at your windows",
  switch_window: "Switching windows",
  click: "Clicking",
  toggle: "Flipping a switch",
  type_text: "Typing",
  fill_cells: "Filling cells (your keyboard)",
  choose_option: "Choosing an option",
  set_value: "Setting a value",
  change_setting: "Changing a setting",
  open_app: "Opening an app",
  open_on_desk: "Opening an app on my desk",
  show_me: "Showing you",
  list_tasks: "Checking on my tasks",
  cancel_task: "Stopping a task",
  steer_task: "Updating a task",
  press_keys: "Pressing keys (your keyboard)",
  scroll: "Scrolling (your mouse)",
  report_progress: "Updating you",
  finish_task: "Wrapping up",
  run_command: "Running a command",
  list_computers: "Checking which computers I can use",
  offer_connect: "Offering to connect",
};

/** What a borrowed hand does, as the card says it while it does it (its tool's step may have named another thing). */
export const HAND_STEPS = {
  click: "Clicking (your mouse)",
  keys: "Pressing keys (your keyboard)",
  type: "Typing (your keyboard)",
  scroll: "Scrolling (your mouse)",
} as const;
export type HandStep = keyof typeof HAND_STEPS;

/** A hand's step; on Ember's desk the keyboard and the mouse are the desk's own. */
export function handStep(what: HandStep, onDesk = false): string {
  const step = HAND_STEPS[what];
  return onDesk ? step.replace(/ \(your (keyboard|mouse)\)$/, "") : step;
}

/** A tool's step as the bubble and the card say it: on Ember's desk the keyboard and the mouse are the desk's own, not the user's. */
export function stepOf(tool: string, onDesk = false): string | undefined {
  const step = TOOL_STEPS[tool];
  return step && onDesk ? step.replace(/ \(your (keyboard|mouse)\)$/, "") : step;
}

/**
 * The bubble once "Read all" is pressed on an answer cut short: all of `full` (it scrolls inside the bubble if it must),
 * with a way to the conversation in settings and one to close it.
 */
export function expandedBubble(b: BubbleState, full: string): BubbleState {
  return {
    ...b, visible: true, mood: "idle", title: b.title || "Ember", thought: full, step: null, streaming: false, expanded: true,
    actions: [{ id: "ui:close", label: "Close" }, { id: "ui:conversation", label: "Open in settings" }],
  };
}

/** What the conversation says when a turn of it ended without an answer or a step. */
export const NO_REPLY = "Copilot ended that turn without an answer. Please ask me again.";

/** The bubble's title while a turn under way hears nothing from Copilot (see TurnWatch). */
export const STILL_WAITING = "Still waiting for Copilot…";

/** What Ember's body does during each tool. */
export const TOOL_GESTURES: Record<string, Gesture> = {
  describe_screen: "chin", perceive_window: "chin", list_windows: "chin",
  click: "tap", toggle: "tap", choose_option: "tap", set_value: "tap", change_setting: "tap", open_app: "tap", scroll: "tap",
  type_text: "type", fill_cells: "type", press_keys: "type", run_command: "type",
  point_at: "point", wait_for_click: "point",
  set_appearance: "wave", start_task: "thumbsUp", show_me: "point",
};

export class Presenter {
  private answering = false;
  private answer = "";
  /** A tool ran since the last reasoning text: the next reasoning starts a new thought. */
  private thoughtBreak = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  /** How long the armed hide waits (armed again when main gives the bubble back). */
  private hideMs = 0;
  /** A hide asked for while the bubble wasn't on screen: its time starts once it shows. */
  private pendingHide: number | null = null;
  /** The latest bubble hasn't reached the screen (someone else held it, or a question was up). */
  private unseen = false;
  /** Stopped by the kill switch: nothing more is shown until the next request. */
  private silent = false;
  /** A guide step is up: the guide holds the bubble until its next step or its outcome (not just while pointing). */
  private guiding = false;
  /** The latest guide step hasn't been on screen yet. */
  private newStep = false;
  private state: EmberState = { emotion: "neutral", talking: false, bubble: IDLE_BUBBLE, tasks: [], status: null };
  /** How the bubble this presenter shows claimed it (see Claim). */
  kind: Claim = "progress";
  /** Its task works on Ember's desk now: its steps don't say "your keyboard" or "your mouse" (stepOf). */
  onDesk = false;
  /** How this presenter's own work claims the bubble. */
  private readonly work: Claim;
  /** Shared by every presenter writing the same bubble. */
  private readonly owner: BubbleOwner;
  private readonly onEvent?: (e: PresenterEvent) => void;
  private readonly onProblem?: (text: string) => void;
  /** The task whose bubbles these are (BubbleState.task). */
  private readonly taskId?: string;
  /** Where that task acts (BubbleState.where), when not on this computer. */
  private readonly where?: string;
  private readonly onAnnounce?: (text: string) => void;
  /** The settings shortcut as Ember holds it now (PresenterOptions.settingsKey), for the bubbles that send the user there. */
  private readonly heldSettingsKey: () => string | null;
  /** The stop chord as Ember holds it now ("Ctrl+Alt+X"; PresenterOptions.stopKey), named by an announcement. */
  private readonly heldStopKey: () => string | null;
  /** The title "Still waiting for Copilot…" replaced (see stalled). */
  private stalledTitle = "";
  /** The words of the latest request asked (userPrompt), until its turn begins (its user.message). */
  private asked: string | null = null;
  /** That request was asked while the answer before it was still coming (see userPrompt). */
  private askedOverAnswer = false;
  /** The turn under way has shown words or run a step (one that has neither by its end says so). */
  private produced = false;
  /** An announcement is up (announce): its Stop's id and the bubble it replaced, put back by endAnnouncement. */
  private beforeAnnounce: { stopId: string; bubble: BubbleState } | null = null;
  /** A notice (post) that stays until it is answered or cleared: it waits its turn again when something covers it. */
  private held = false;
  /** When the latest bubble reached the screen (shownAt). */
  private since: number | null = null;
  private readonly now: () => number;
  private readonly readTime: () => number;
  private readonly textScale: () => number;

  constructor(
    private push: (patch: Partial<EmberState>) => void,
    private timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
    /** The character's name, shown as the speaker of answers. */
    private name: () => string = () => "Ember",
    owner: BubbleOwner | { current: object | null } = new BubbleOwner(),
    /** A finished answer, in full (the bubble shows only the start of a long one). */
    private onFinalAnswer?: (text: string) => void,
    /** The organisation's own endpoint is configured: errors don't mention a GitHub sign-in. */
    private provider = false,
    opts: PresenterOptions = {},
  ) {
    this.work = opts.task ? "progress" : "reply";
    this.owner = BubbleOwner.of(owner);
    this.onEvent = opts.onEvent;
    this.onProblem = opts.onProblem;
    const table = opts.shortcuts ?? SHORTCUTS.linux;
    this.heldSettingsKey = opts.settingsKey ?? (() => table.settings.label);
    this.heldStopKey = opts.stopKey ?? (() => table.stop.label);
    if (typeof opts.task === "string") this.taskId = opts.task;
    if (opts.where) this.where = opts.where;
    this.onAnnounce = opts.onAnnounce;
    this.now = opts.now ?? Date.now;
    this.readTime = opts.readTime ?? (() => 1);
    this.textScale = opts.textScale ?? (() => 1);
  }

  /** The settings shortcut Ember holds now, or null (taken, or the check failed: naming one that may not work is worse). */
  private get settingsKey(): string | null {
    try { return this.heldSettingsKey() || null; } catch { return null; }
  }

  /** The stop chord Ember holds now, or null (as settingsKey). */
  private get stopKey(): string | null {
    try { return this.heldStopKey() || null; } catch { return null; }
  }

  /** Updates what this presenter shows; it reaches the screen only if the bubble is its to write. Returns whether it did. */
  private apply(patch: Partial<EmberState>, claim: Claim = this.guiding ? "reply" : this.work): boolean {
    this.state = { ...this.state, ...patch, bubble: { ...this.state.bubble, ...(patch.bubble ?? {}), ...(this.taskId ? { task: this.taskId } : {}), ...(this.where ? { where: this.where } : {}) } };
    if (this.silent) return false;
    if (!patch.bubble) {
      // Just the face (talking stops): only while this presenter's bubble is the one on screen.
      if (this.owner.current === this && !this.unseen) this.push(patch);
      return false;
    }
    this.kind = claim;
    const ok = this.owner.allows(this, claim);
    const was = this.owner.current === this && !this.unseen;
    this.unseen = !ok;
    if (ok) this.newStep = false;
    if (ok && (!was || this.since === null)) this.since = this.now();
    this.owner.wrote(this, claim, ok);
    if (ok) this.push({ ...patch, bubble: this.state.bubble });
    // Its answer is complete on screen: a guide step waiting behind it may show soon.
    if (ok && claim !== "progress" && !this.busy) this.owner.finished(this);
    return ok;
  }

  private cancelHide(): void {
    if (this.hideTimer) { this.timers.clear(this.hideTimer); this.hideTimer = null; }
    this.pendingHide = null;
  }

  /** Thinking, streaming or working: a turn is under way. */
  get busy(): boolean {
    return this.state.bubble.streaming || this.state.emotion === "thinking" || this.state.emotion === "focused";
  }

  /**
   * Its turn or task is under way, or it waits for the user's click: busy, a guide step, or a notice that stays until
   * it is answered (what covers it for a while doesn't end it).
   */
  get atWork(): boolean {
    return this.busy || this.guiding || (this.held && this.visible);
  }

  /** When its latest bubble reached the screen (NoticeBoard.shownAt). */
  get shownAt(): number | null {
    return this.since;
  }

  /** How long its latest bubble has been on screen (NoticeBoard.shownFor). */
  get shownFor(): number | null {
    return this.since === null ? null : this.now() - this.since;
  }

  /** It has a bubble to show (on screen or waiting). */
  get visible(): boolean {
    return !this.silent && this.state.bubble.visible;
  }

  /** Its latest bubble is waiting to show (it hasn't been on screen). */
  get waiting(): boolean {
    return this.unseen && this.visible;
  }

  /** A guide step that hasn't been on screen yet is waiting to show. */
  get stepWaiting(): boolean {
    return this.guiding && this.newStep && this.waiting;
  }

  /** Its latest bubble (on screen or waiting), or the idle one when it has nothing to show. */
  get bubble(): Readonly<BubbleState> {
    return this.visible ? this.state.bubble : IDLE_BUBBLE;
  }

  /** Is `b` this presenter's bubble (main showing it again)? */
  isShowing(b: BubbleState): boolean {
    const s = this.state.bubble;
    return this.visible && b.visible && s.title === b.title && s.thought === b.thought;
  }

  /** Someone else (main's own bubble) has the bubble now: no timer of this presenter hides it. */
  letGo(): void {
    const ms = this.hideTimer ? this.hideMs : this.pendingHide;
    this.cancelHide();
    // Its time starts over if it shows again (reshow).
    this.pendingHide = ms;
  }

  /**
   * Shows this presenter's bubble again after it waited or was covered; its hide starts now. False if there's nothing
   * to show. `as`: how it claims the bubble ("step": a guide step replacing a finished answer).
   */
  reshow(as?: Claim): boolean {
    if (!this.visible) return false;
    const claim = as ?? (this.kind === "progress" ? "progress" : "reply");
    if (!this.owner.allows(this, claim)) return false;
    this.unseen = false;
    this.newStep = false;
    // Its buttons are where they are only from now (NoticeBoard.shownAt).
    this.since = this.now();
    this.owner.wrote(this, claim, true);
    this.push({ emotion: this.state.emotion, talking: this.state.talking, bubble: this.state.bubble });
    // (Its time was scaled by the user's setting when it was asked for: armed as it is, not scaled again.)
    if (this.pendingHide !== null) this.armHide(this.pendingHide);
    // A complete answer back on screen (it finished under main's "Listening…" or a question): a guide step waiting
    // behind it shows a moment later, as when it finishes on screen.
    if (claim !== "progress" && !this.busy) this.owner.finished(this);
    return true;
  }

  /** Its bubble was replaced for good (main showed something else): it isn't shown again. */
  drop(): void {
    this.cancelHide();
    this.guiding = false;
    this.held = false;
    this.unseen = false;
    this.state = { ...this.state, bubble: { ...IDLE_BUBBLE } };
    this.owner.forget(this);
  }

  /** The kill switch's message is up: this turn (or task) shows nothing more. The next request speaks again. */
  quiet(): void {
    this.cancelHide();
    this.guiding = false;
    this.held = false;
    this.answering = false;
    this.asked = null;
    this.silent = true;
    this.owner.forget(this);
  }

  /** This presenter's bubble goes `base` ms after it reaches the screen, times the user's "More time to read and answer". */
  private hideLater(base: number): void {
    // As long as the user needs to read it (their setting), never shorter than usual.
    let scale = 1;
    try { scale = Math.max(1, Math.min(10, Number(this.readTime()) || 1)); } catch { /* the usual time */ }
    this.armHide(base * scale);
  }

  /**
   * This presenter's bubble goes `ms` after it reaches the screen, as given (hideLater scaled it once already): what
   * letGo and reshow keep and arm again is that time, so a bubble that waited or was covered isn't scaled twice.
   */
  private armHide(ms: number): void {
    this.cancelHide();
    // Not on screen yet: its time starts when it shows.
    if (this.unseen) { this.pendingHide = ms; return; }
    this.hideMs = ms;
    this.hideTimer = this.timers.set(() => { this.hideTimer = null; this.hide(); }, ms);
  }

  /** This presenter's bubble goes. If it was on screen, the latest one waiting shows instead, or the bubble empties. */
  private hide(): void {
    this.cancelHide();
    this.guiding = false;
    this.held = false;
    const onScreen = this.owner.current === this && !this.unseen;
    this.unseen = false;
    this.state = { ...this.state, emotion: "neutral", talking: false, bubble: { ...IDLE_BUBBLE } };
    if (this.owner.gone(this) || !onScreen || this.silent) return;
    this.push({ emotion: "neutral", talking: false, bubble: this.state.bubble });
  }

  /**
   * Something went wrong outside the session's own events (the runtime died, a send failed). "Open settings" only when
   * settings can fix it (settingsHelps): a runtime that reconnects by itself needs nothing from there.
   */
  fail(message: string): void {
    this.cancelHide();
    this.guiding = false;
    this.answering = false;
    this.asked = null;
    this.silent = false;
    const said = forBubble(message);
    this.apply({
      emotion: "sad", talking: false, gesture: "facepalm",
      bubble: { visible: true, mood: "error", title: problemTitle(said, this.provider), thought: said, step: null, streaming: false, actions: settingsHelps(said) ? [{ id: "ui:settings", label: "Open settings" }] : [] },
    }, "take");
    this.onProblem?.(message);
    this.hideLater(12000);
  }

  /**
   * A short message from Ember itself (not the model), with optional buttons; it goes away on its own. `mood`: "error"
   * (a problem, the default), or "attention" when its button is what the user has to do next (sign in first).
   */
  notice(n: { title: string; text: string; actions?: { id: string; label: string }[]; ms?: number; mood?: "error" | "attention" }): void {
    this.cancelHide();
    this.guiding = false;
    this.answering = false;
    this.asked = null;
    this.silent = false;
    const mood = n.mood ?? "error";
    this.apply({
      emotion: mood === "attention" ? "curious" : "confused", talking: false,
      bubble: { visible: true, mood, title: n.title, thought: forBubble(n.text), step: null, streaming: false, actions: n.actions ?? [] },
    }, "take");
    this.hideLater(n.ms ?? 12000);
  }

  /**
   * A bubble of Ember's own (NoticeBoard.post): it replaces this presenter's last one and claims the shared bubble as
   * `o.claim` says. With `o.ms` it goes that long after it reaches the screen; without, it stays until it is cleared
   * (its buttons answered, what it said no longer holds), and comes back after anything that covers it meanwhile.
   */
  post(b: NoticeBubble, o: NoticeOptions = {}): void {
    // The same buttons still up (a connection's progress rewrites its words): they keep the time they reached the
    // screen, so a press on Cancel isn't ignored for ever while a download reports every few milliseconds.
    const sameButtons = this.visible && !this.unseen && JSON.stringify(this.state.bubble.actions) === JSON.stringify(b.actions);
    this.cancelHide();
    this.guiding = false;
    this.answering = false;
    this.asked = null;
    this.silent = false;
    this.held = !o.ms;
    if (!sameButtons) this.since = null;
    this.apply({
      emotion: o.emotion ?? "neutral", talking: false,
      bubble: { ...IDLE_BUBBLE, visible: true, step: b.step ?? null, title: b.title, thought: b.thought, actions: b.actions, mood: b.mood },
    }, o.claim ?? "take");
    if (o.ms) this.hideLater(o.ms);
  }

  /** Its bubble goes (NoticeBoard.clear): on screen, the one waiting behind it shows; nothing happens when it has none. */
  clear(): void {
    this.held = false;
    if (this.visible) this.hide();
  }

  /**
   * A notice still up that says `text` goes (what it said no longer holds: Copilot is back, the user signed in). It is
   * matched as notice() put it on screen (in Ember's voice, and "Needs you" when signing in is what to do next).
   * Anything else stays.
   */
  withdraw(text: string): void {
    const b = this.state.bubble;
    if (b.visible && (b.mood === "error" || b.mood === "attention") && b.thought === forBubble(text) && !this.busy) this.hide();
  }

  /** The session went away mid-turn (restart, sign-out): nothing is left streaming or "thinking". */
  reset(): void {
    const wasBusy = this.busy;
    this.answering = false;
    this.answer = "";
    this.asked = null;
    // Only a bubble mid-turn is cleared; a notice or an answer keeps its own hide timer.
    if (wasBusy) this.hide();
  }

  /**
   * The turn under way has heard nothing from Copilot for a while (`on`), or hears from it again: the bubble's title
   * says Ember is still waiting, and then what it said before. Nothing else changes (Stop works as always).
   */
  stalled(on: boolean): void {
    const b = this.state.bubble;
    if (on && this.busy && !this.silent && b.title !== STILL_WAITING) {
      this.stalledTitle = b.title;
      this.apply({ bubble: { ...b, title: STILL_WAITING } });
    } else if (!on && b.title === STILL_WAITING) {
      this.apply({ bubble: { ...b, title: this.stalledTitle } });
    }
  }

  /** The user asked something (voice or text). */
  userPrompt(text: string): void {
    this.cancelHide();
    // Asked while the turn before was answering: that answer's own message may still come, after this "Thinking…".
    this.askedOverAnswer = this.answering || this.answer.length > 0;
    this.answering = false;
    this.produced = false;
    this.answer = "";
    this.silent = false;
    this.asked = text;
    this.apply({
      emotion: "thinking", talking: false,
      bubble: { visible: true, mood: "thinking", title: "Thinking…", thought: quoted(text), step: null, streaming: true, actions: [] },
    }, "take");
  }

  /** Guide mode: Ember points at something and says what to do; it stays until the next step. */
  guide(say: string, step: string): void {
    this.cancelHide();
    this.answering = false;
    this.silent = false;
    this.guiding = true;
    this.newStep = true;
    this.apply({
      emotion: "happy", talking: true, gesture: "point",
      bubble: { visible: true, mood: "guiding", title: this.name(), thought: say, step, streaming: false, actions: [] },
    }, "step");
    this.timers.set(() => this.apply({ talking: false }), 1200);
  }

  /** A worker started on a task: its bubble is titled with the task (this presenter's name). */
  taskStarted(): void {
    this.cancelHide();
    this.guiding = false;
    this.answering = false;
    this.answer = "";
    this.silent = false;
    this.apply({
      emotion: "focused", talking: false,
      bubble: { visible: true, mood: "acting", title: this.name(), thought: "", step: "Getting started", streaming: true, actions: [] },
    });
  }

  /**
   * A task's own note on how it's going (report_progress): what its bubble says while it works, in place of its model's
   * thinking. `more`: its buttons and its step line instead of the ones it has (a command waiting for the user's typing
   * offers Show, with the keyboard's way to the command window under it: review #263); absent, they stay. With
   * `needsYou`, the note is a finished line the user has to act on ("Needs you", not streaming), which the bubble's live
   * region reads out with its step, as it reads a question; without it the note is running commentary, never read out.
   */
  progress(text: string, more?: { actions?: BubbleState["actions"]; step?: string | null; needsYou?: boolean }): void {
    const note = text.replace(/\s+/g, " ");
    if (!note.trim()) return;
    const needsYou = more?.needsYou === true;
    this.apply({ emotion: "focused", bubble: { ...this.state.bubble, visible: true, mood: needsYou ? "attention" : "acting", thought: clip(note), streaming: !needsYou,
      ...(more?.actions ? { actions: more.actions } : {}), ...(more && "step" in more ? { step: more.step ?? null } : {}) } });
  }

  /**
   * A command the user's own words asked for is about to run (D4.4, §3.9.2): the announcement ("Pushing feature-x to
   * origin, as you asked.") shows now with one action, Stop (`stopId`, `ui:cmdstop:<runId>`), which stops only this
   * announcement. The command window's countdown is the authoritative Stop: this copy may wait behind a question.
   */
  announce(text: string, stopId: string, ms: number = ANNOUNCE_MS): void {
    this.beforeAnnounce = { stopId, bubble: this.state.bubble };
    this.cancelHide();
    this.guiding = false;
    this.answering = false;
    this.silent = false;
    const w = announcement(text, this.where, Math.round(ms / 1000), this.stopKey);
    this.apply({
      emotion: "focused", talking: false,
      // The time it is given (longer while a screen reader runs) and the stop chord, also read by the live region (review #46).
      bubble: { visible: true, mood: "attention", title: w.title, thought: w.text, step: null, streaming: false, actions: [{ id: stopId, label: w.actions[0].label }] },
    }, "take");
    this.onAnnounce?.(text);
  }

  /**
   * The announcement with `stopId` is over (the command runs now, or was stopped): the task's bubble goes back to what
   * it showed before, without the Stop.
   */
  endAnnouncement(stopId: string): void {
    const before = this.beforeAnnounce;
    if (!before || before.stopId !== stopId) return;
    this.beforeAnnounce = null;
    if (!this.state.bubble.actions.some(a => a.id === stopId)) return;
    const b = before.bubble.visible ? before.bubble : { ...IDLE_BUBBLE, visible: true, title: this.name() };
    this.apply({ emotion: "focused", bubble: { ...b, visible: true, mood: "acting", streaming: true, actions: b.actions.filter(a => a.id !== stopId) } }, "progress");
  }

  /** A task finished: how it went. It shows once nobody else holds the bubble, and goes after a while. */
  outcome(o: { title: string; text: string; emotion: Emotion; gesture: Gesture; mood: BubbleState["mood"]; actions?: BubbleState["actions"] }): void {
    if (this.silent) return;
    this.cancelHide();
    this.answering = false;
    this.guiding = false;
    this.apply({
      emotion: o.emotion, talking: false, gesture: o.gesture,
      bubble: { visible: true, mood: o.mood, title: o.title, thought: o.text, step: null, streaming: false, actions: o.actions ?? [] },
    }, "reply");
    this.hideLater(Math.min(30000, (o.mood === "error" ? 12000 : 6000) + o.text.length * 50));
  }

  event(e: PresenterEvent): void {
    this.onEvent?.(e);
    const d = e.data ?? {};
    switch (e.type) {
      case "assistant.intent":
        if (!this.answering && this.work !== "progress" && typeof d.intent === "string") this.apply({ bubble: { ...this.state.bubble, title: d.intent } });
        break;
      case "user.message": {
        // A request's turn begins while one asked is still owed its turn. Asked while the turn before was still
        // ending, it lost its "Thinking…" to that turn's end (session.idle): it is thinking again. The latest one's
        // own message (it ends with the user's words) settles it.
        const asked = this.asked;
        if (asked !== null) {
          if (!this.busy && !this.silent) {
            this.cancelHide();
            this.apply({
              emotion: "thinking", talking: false,
              bubble: { visible: true, mood: "thinking", title: "Thinking…", thought: quoted(asked), step: null, streaming: true, actions: [] },
            });
          }
          const said = typeof d.content === "string" ? d.content.trimEnd() : null;
          if (said === null || said.endsWith(asked.trim())) { this.asked = null; this.askedOverAnswer = false; }
        }
        this.answering = false;
        this.answer = "";
        this.produced = false;
        break;
      }
      case "assistant.turn_start":
        // A new turn (a queued question, or the next step after a tool): its answer starts fresh.
        this.answering = false;
        this.answer = "";
        break;
      case "assistant.reasoning_delta": {
        // A task's model thinks aloud in its own words ("…going to use the command to open the app…"): its bubble and
        // card show only its steps and its notes (report_progress), never that.
        if (this.answering || this.work === "progress") break;
        // After a tool ran, the next reasoning is a new thought: it replaces the last one instead of running on.
        const prev = this.state.bubble.thought.startsWith("“") || this.thoughtBreak ? "" : this.state.bubble.thought;
        this.thoughtBreak = false;
        this.apply({ emotion: "thinking", bubble: { ...this.state.bubble, mood: "thinking", thought: (prev + String(d.deltaContent ?? "")).slice(-KEEP_CHARS), streaming: true } });
        break;
      }
      case "assistant.message_delta": {
        // The answer before goes on after a newer question was asked (its turn hasn't begun): its words replace that
        // question's "Thinking…" from mid-sentence, so its message, when it comes, shows it whole (with "Read all").
        // Nothing to read yet (an empty or blank first delta): the bubble stays as it is rather than show an empty answer.
        const delta = String(d.deltaContent ?? "");
        // A task speaks through its summary (finish_task), not its model's chat.
        if (this.work === "progress") break;
        if (!this.answering && !delta.trim()) break;
        if (this.asked !== null) this.askedOverAnswer = false;
        if (!this.answering) { this.answering = true; this.answer = ""; }
        this.produced = true;
        this.answer += delta;
        this.apply({
          emotion: "happy", talking: true,
          bubble: { ...this.state.bubble, visible: true, mood: "idle", title: this.name(), thought: this.answer.slice(-KEEP_CHARS), step: null, streaming: true },
        });
        break;
      }
      case "tool.execution_start": {
        const name = String(d.toolName ?? "");
        this.answering = false;
        this.produced = true;
        this.thoughtBreak = true;
        // While guiding, the instruction stays up (Ember is waiting for the user, not working).
        const guiding = name === "wait_for_click" || name === "point_at";
        this.apply({
          emotion: guiding ? "happy" : "focused", talking: false, gesture: TOOL_GESTURES[name] ?? "rest",
          bubble: { ...this.state.bubble, visible: true, mood: guiding ? "guiding" : "acting", step: stepOf(name, this.onDesk) ?? name, streaming: !guiding },
        });
        break;
      }
      case "tool.execution_complete":
        if (d.success === false) this.apply({ emotion: "confused", gesture: "scratch", bubble: { ...this.state.bubble, step: null } });
        else this.apply({ bubble: { ...this.state.bubble, step: null } });
        break;
      case "assistant.message": {
        // The whole answer, from its start (the bubble shows the tail only while it streams). The message's own
        // text is complete even when a second question reset the streamed buffer half-way.
        const content = typeof d.content === "string" ? d.content.trim() : "";
        const toolCall = Array.isArray(d.toolRequests) && d.toolRequests.length > 0;
        if (this.work === "progress") break;
        if (this.answering || (content && !toolCall)) {
          const full = plainText(content || this.answer.trim());
          // No words after all (only a tool call came, or a blank answer): nothing is shown or kept as an answer.
          if (!full.trim()) { this.answering = false; this.answer = ""; break; }
          this.produced = true;
          this.onFinalAnswer?.(full);
          // A newer question is owed its turn (asked after this answer's words came, before this message): its
          // "Thinking…" stays, the earlier answer isn't put back under it (it is kept for "Read the last answer").
          if (this.asked !== null && this.askedOverAnswer) break;
          // By the lines it takes, not its characters: a short list or a few paragraphs fill the bubble's six lines too.
          // "Read all" takes only the mouse (the overlay never takes the keyboard): under it, where the keyboard finds
          // the whole answer.
          let scale = 1;
          try { scale = Number(this.textScale()); } catch { /* the usual size */ }
          const more = cutShort(full, scale);
          this.apply({ talking: false, bubble: { ...this.state.bubble, thought: clip(full), streaming: false,
            step: more ? keyboardRoute(this.settingsKey, "Conversation") : null,
            actions: more ? [{ id: "ui:more", label: "Read all" }] : [] } });
        }
        break;
      }
      case "session.error": {
        this.answering = false;
        this.produced = true;
        const said = friendlyError(String(d.message ?? ""), typeof d.errorType === "string" ? d.errorType : undefined,
          { statusCode: typeof d.statusCode === "number" ? d.statusCode : undefined, provider: this.provider, settingsKey: this.settingsKey });
        // "Open settings" where settings can fix it (a sign-in, the model, access), never for the network or a hiccup.
        this.apply({
          emotion: "sad", talking: false,
          bubble: { visible: true, mood: "error", title: problemTitle(said, this.provider), thought: said, step: null, streaming: false, actions: settingsHelps(said) ? [{ id: "ui:settings", label: "Open settings" }] : [] },
        });
        this.onProblem?.(said);
        this.hideLater(12000);
        break;
      }
      case "session.idle": {
        const aborted = d.aborted === true;
        // The conversation's turn ended with neither words nor a step while "Thinking…" was up: it says so instead of
        // leaving an empty or stale bubble that just fades.
        // (Not the end of the turn before a request still owed its own: that one's "Thinking…" stays.)
        if (!aborted && this.work === "reply" && !this.produced && this.asked === null && !this.silent && this.state.bubble.visible && this.state.emotion === "thinking") {
          this.answering = false;
          this.apply({ emotion: "confused", talking: false, bubble: { visible: true, mood: "error", title: "No answer", thought: NO_REPLY, step: null, streaming: false, actions: [] } });
          this.onProblem?.(NO_REPLY);
          this.hideLater(8000);
          break;
        }
        // Nothing runs any more: not "thinking" or "working". (Held off meanwhile, it shows once the bubble is free.)
        const face = aborted ? "neutral" : this.answering ? "happy" : this.state.emotion === "thinking" || this.state.emotion === "focused" ? "neutral" : this.state.emotion;
        this.apply({ talking: false, emotion: face, bubble: { ...this.state.bubble, streaming: false, ...(aborted ? { title: "Stopped", mood: "idle" as const, step: null } : {}) } });
        // Long answers stay up longer (they also have "Read all", and the settings window keeps them).
        const chars = this.answer.length;
        this.hideLater(Math.min(30000, 6000 + chars * 50));
        this.answering = false;
        break;
      }
    }
  }
}
