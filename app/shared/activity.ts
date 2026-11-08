/**
 * What a task is doing, as Ember shows it (docs/DESIGN.md "Two bodies"): the types of a task's activity and the pure
 * words built from them, shared by main (app/main/agent/activity.ts builds the activity), the task cards and Home's
 * "Task activity". Every word here is Ember's own, built from what Ember's tools and the Copilot SDK's events say
 * happened, never from the model's text. The one exception is a note (`model: true`): the worker's own short
 * report_progress words, which a page draws as plain text in a secondary label and never as Ember's voice. Raw
 * reasoning, tool arguments, screen text and error messages never reach these words.
 */

import type { PlanStep, TaskHand, ViewDoc } from "./view";

/** A task's state in words, one table for every surface, so a state reads the same wherever it is seen or heard. */
export const STATUS_WORDS = {
  running: "Working",
  waiting: "Waiting for you",
  queued: "Waiting its turn",
  retrying: "Retrying",
  done: "Done",
  failed: "Didn't finish",
  stopped: "Stopped",
  /** A stopped task whose question went unanswered: the user stopped nothing (tasks-approvals-r1). */
  unanswered: "No answer in time",
} as const;
export type StatusWord = keyof typeof STATUS_WORDS;

/** What an activity item is. */
export type ActivityKind =
  | "step" // one tool call, in Ember's words for its tool and the app it worked in
  | "note" // the worker's own short note (report_progress): model text
  | "announce" // a step Ember took without asking (Work without asking), in Ember's own words from policy, never model text
  | "question" // Ember asked the user, and how they answered
  | "refused" // a step policy (or Ember itself) didn't allow
  | "hand" // how the task works changed: the background, Ember's desk, the user's mouse and keyboard
  | "retry" // a call to the model failed and is being tried again
  | "problem" // something went wrong, in Ember's words
  | "result"; // how the task ended

/** An item's state, shown as a symbol beside its words. */
export type ActivityState = "running" | "done" | "failed" | "waiting" | "stopped";

/** Kinds of step, so steps of one kind fold into one line ("Clicked 3 times"). */
export type StepGroup =
  | "read" | "windows" | "switch" | "click" | "toggle" | "type" | "choose" | "setting" | "open" | "keys" | "scroll"
  | "command" | "point" | "wait" | "other";

export interface ActivityItem {
  /** The tool call's id for a step, otherwise made up. */
  id: string;
  kind: ActivityKind;
  /** When it began, in ms after the task started. */
  at: number;
  /** When it ended, in ms after the task started. */
  endedAt?: number;
  state: ActivityState;
  /** What happened, in plain words ("Clicked in Text Editor"): Ember's own, except a note's. */
  words: string;
  /** A step's kind. */
  group?: StepGroup;
  /** The app a step worked in, as people name it (friendlyApp). */
  app?: string;
  /** The words are the worker's own (a note): drawn as plain secondary text, never spoken as Ember's. */
  model?: true;
  /**
   * What a question asked, in Ember's words from the step's kind and app only (agent/activity.ts askedWords: never the
   * text it would type or names from the screen): Home's Task activity shows it under the row. The cards never do.
   */
  asked?: string;
  /** Where a question is answered: Ember's bubble, its command window, or a card in its own window. */
  askedIn?: AskedIn;
}

/** Where the user answers a question: the bubble (and the keys), the command window's card, or a consent card's window. */
export type AskedIn = "bubble" | "command" | "card";

/**
 * A task as Home's "Task activity" shows it (TaskManager.activities): its activity, and what its card showed (its
 * state, plan, where it works and how it ended). Kept in memory only, for the tasks with a card and the twenty newest
 * finished ones besides, and gone when Ember quits. `summary`, the plan's and the view's words are the worker's own.
 */
export type TaskControlAction = "stop" | "retry" | "window";

export interface TaskEntry {
  id: string;
  title: string;
  status: "queued" | "running" | "waiting" | "done" | "failed" | "stopped";
  /** Where it acts when not on this computer ("on build-01"). */
  where?: string;
  /** How it works now, while it works. */
  hand?: TaskHand;
  plan?: PlanStep[];
  /** How it ended, in the worker's words (finish_task's summary), and what it found or made. */
  summary?: string;
  /** What it shows: its live view while it works (show_view), what it found or made once it ended. */
  view?: ViewDoc;
  /** Main's current capabilities; every activation rechecks the exact task ID. Historical rows have none. */
  controls?: { stop: boolean; retry: boolean; window: boolean };
  /** It stopped because its question went unanswered (StopCause "expired"): its state's word is STATUS_WORDS.unanswered. */
  unanswered?: true;
  activity: TaskActivity;
}

/** A task's whole activity, kept in main while Ember runs (the cards get a summary; Home will show it whole). */
export interface TaskActivity {
  /** When the task began to run (epoch ms). */
  startedAt: number;
  /** When it ended (epoch ms). */
  endedAt?: number;
  /** The latest items, oldest first (at most ACTIVITY_LIMIT; older ones are counted in `dropped`). */
  items: ActivityItem[];
  dropped: number;
  /** Steps it took, and how many of them didn't work. */
  steps: number;
  failedSteps: number;
  /** Steps of each kind (all of them, not just the items kept). */
  counts: Partial<Record<StepGroup, number>>;
  /** Questions it asked, and those the user allowed. */
  questions: number;
  approvals: number;
  /** A question waits for the user now. */
  asking: boolean;
  /** Calls to the model that failed in a row just now (0: none). */
  retry: number;
  /** Copilot has been quiet for a while (TurnWatch). */
  slow: boolean;
  /** Past 80% of its step or time limit (150 steps, 20 minutes). */
  nearLimit: boolean;
  /** What it is doing now, in Ember's words. */
  live: string;
  /** The worker's latest note (model text). */
  note?: string;
}

/** One line of the card's details: an item, or several steps of one kind folded together. */
export interface ActivityRow {
  /** ms after the task started. */
  at: number;
  state: ActivityState;
  words: string;
  /** The worker's own words (a note). */
  model?: true;
}

/** What a task's card gets of its activity on every change: small, so the overlay's updates stay cheap. */
export interface CardActivity {
  startedAt: number;
  endedAt?: number;
  /** What it is doing now, in Ember's words ("Clicking in Text Editor…", "Waiting for you"). */
  live: string;
  /** The worker's latest note (model text, drawn as such). */
  note?: string;
  /** The steps so far in one sentence ("Clicked 3 times and read the window 2 times"). */
  summary?: string;
  approvals: number;
  nearLimit: boolean;
  /** The details' rows: the latest DETAIL_ROWS. */
  rows: ActivityRow[];
}

/** Items kept per task (older ones are only counted), and rows a card's details show. */
export const ACTIVITY_LIMIT = 40;
export const DETAIL_ROWS = 6;

/** Each tool's kind of step (tools not listed are "other"; report_progress, the view tools and finish_task make no step). */
export const STEP_GROUP: Readonly<Record<string, StepGroup>> = {
  perceive_window: "read", describe_screen: "read",
  list_windows: "windows", switch_window: "switch",
  click: "click", toggle: "toggle",
  type_text: "type", fill_cells: "type",
  choose_option: "choose", set_value: "choose",
  change_setting: "setting",
  open_app: "open", open_on_desk: "open",
  press_keys: "keys", scroll: "scroll",
  run_command: "command",
  point_at: "point", wait_for_click: "wait",
};

/** Tools that are the task talking, not working: no step row for them (its views are on its card already). */
export const NOT_STEPS: ReadonlySet<string> = new Set(["report_progress", "show_view", "update_view", "finish_task"]);

/** A step kind's words once done: one step, and several. */
const DONE_WORDS: Readonly<Record<StepGroup, { one: string; many: (n: number) => string }>> = {
  read: { one: "Read the window", many: n => `Read the window ${n} times` },
  windows: { one: "Looked at your windows", many: n => `Looked at your windows ${n} times` },
  switch: { one: "Switched windows", many: n => `Switched windows ${n} times` },
  click: { one: "Clicked once", many: n => `Clicked ${n} times` },
  toggle: { one: "Flipped a switch", many: n => `Flipped ${n} switches` },
  type: { one: "Typed text", many: n => `Typed text ${n} times` },
  choose: { one: "Chose an option", many: n => `Chose ${n} options` },
  setting: { one: "Changed a setting", many: n => `Changed ${n} settings` },
  open: { one: "Opened an app", many: n => `Opened ${n} apps` },
  keys: { one: "Pressed keys", many: n => `Pressed keys ${n} times` },
  scroll: { one: "Scrolled", many: n => `Scrolled ${n} times` },
  command: { one: "Ran a command", many: n => `Ran ${n} commands` },
  point: { one: "Pointed at a step", many: n => `Pointed at ${n} steps` },
  wait: { one: "Waited for your click", many: n => `Waited for ${n} clicks` },
  other: { one: "Took a step", many: n => `Took ${n} steps` },
};

/** A step kind's words when it didn't work: what it tried (a red mark beside "Opened an app" would contradict itself). */
const TRIED_WORDS: Readonly<Record<StepGroup, string>> = {
  read: "Tried to read the window", windows: "Tried to look at your windows", switch: "Tried to switch windows",
  click: "Tried to click", toggle: "Tried to flip a switch", type: "Tried to type text", choose: "Tried to choose an option",
  setting: "Tried to change a setting", open: "Tried to open an app", keys: "Tried to press keys", scroll: "Tried to scroll",
  command: "Tried to run a command", point: "Tried to point at a step", wait: "Tried to wait for your click", other: "Tried a step",
};

/** Steps of one kind that didn't work: "Tried to click", "Tried to click 2 times in Files". */
export function triedWords(group: StepGroup, n: number, app?: string): string {
  return `${TRIED_WORDS[group]}${n > 1 ? ` ${n} times` : ""}${app ? ` in ${app}` : ""}`;
}

/** Which kinds a summary names first: what changed things before what only looked (T3 Code's rule). */
const PRIORITY: readonly StepGroup[] = ["setting", "command", "type", "choose", "click", "toggle", "open", "keys", "scroll", "switch", "point", "wait", "windows", "read", "other"];

/** Steps of one kind as words: "Clicked 3 times", with " in Text Editor" when they all worked in one app. */
export function stepsWords(group: StepGroup, n: number, app?: string): string {
  const w = DONE_WORDS[group];
  return `${n === 1 ? w.one : w.many(n)}${app ? ` in ${app}` : ""}`;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The steps so far in one sentence: the two kinds that matter most, then how many others ("Changed a setting, read the
 * window 2 times and 3 other steps"), and how many didn't work. Null before the first step.
 */
export function summarizeActivity(counts: Partial<Record<StepGroup, number>>, failed = 0): string | null {
  const kinds = PRIORITY.filter(g => (counts[g] ?? 0) > 0);
  if (!kinds.length) return null;
  const named = kinds.slice(0, 2);
  const rest = kinds.slice(2).reduce((n, g) => n + (counts[g] ?? 0), 0);
  const parts = named.map((g, i) => (i === 0 ? stepsWords(g, counts[g]!) : lower(stepsWords(g, counts[g]!))));
  const others = rest === 1 ? "1 other step" : `${rest} other steps`;
  const said = rest ? `${parts.join(", ")} and ${others}` : parts.join(" and ");
  return failed > 0 ? `${said} (${failed === 1 ? "1 didn't work" : `${failed} didn't work`})` : said;
}

/** The longest app name a card's words keep (a window's app name can be anything another computer says). */
export const CARD_APP_MAX = 40;

/**
 * An app's name as a card's words carry it ("in Text Editor"): cut to CARD_APP_MAX characters, and on a computer reached
 * over SSH quoted (“…”), since that name is whatever the other computer says, never Ember's own words.
 */
export function cardApp(name: string, remote = false): string {
  const t = name.replace(/\s+/g, " ").trim();
  const cut = t.length > CARD_APP_MAX ? `${t.slice(0, CARD_APP_MAX - 1).trimEnd()}…` : t;
  return remote ? `“${cut}”` : cut;
}

/** A step under way, as the card's live line says it: "Clicking in Text Editor…" (the hand line says whose mouse). */
export function doingWords(step: string | undefined, app?: string): string {
  if (!step) return "Working…";
  const plain = step.replace(/ \(your (keyboard|mouse)\)$/, "");
  return `${plain}${app ? ` in ${app}` : ""}…`;
}

/**
 * The live line while a step waits for the limit on actions a minute to free a slot: "Pausing to keep to 40 steps a
 * minute…" (tasks-approvals-2: a pause, never a refusal).
 */
export function pacedWords(perMinute: number): string {
  return `Pausing to keep to ${perMinute} steps a minute…`;
}

/** The live line while Copilot is tried again after a failed call: "Retrying…", then "Retrying (try 3)…". */
export function retryWords(failures: number): string {
  return failures <= 1 ? `${STATUS_WORDS.retrying}…` : `${STATUS_WORDS.retrying} (try ${failures + 1})…`;
}

/** A question's row once answered. */
export const ANSWER_WORDS = {
  waiting: "Asked you",
  allowed: "Asked you: you allowed it",
  declined: "Asked you: you said not now",
  answered: "Asked you: you answered",
  expired: "Asked you: no answer",
  stopped: "Asked you: the task stopped",
} as const;
export type Answer = Exclude<keyof typeof ANSWER_WORDS, "waiting">;

/** A change of hand, as a row says it. */
export const HAND_ROW: Readonly<Record<TaskHand, string>> = {
  background: "Back in the background",
  desk: "Moved to my desk",
  cursor: "Used your mouse and keyboard",
};

/** A time span as the card says it: "12s", "1:42", "1:02:05" (tabular figures). */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The card's clock: how long it has worked ("Just started" for the first 10 s), or how long it took once it ended. */
export function clockText(a: Pick<CardActivity, "startedAt" | "endedAt">, now: number): string {
  if (a.endedAt !== undefined) return a.endedAt - a.startedAt < 1000 ? "Took a moment" : `Took ${elapsedText(a.endedAt - a.startedAt)}`;
  const ms = now - a.startedAt;
  return ms < 10_000 ? "Just started" : elapsedText(ms);
}

/** "Step 3 of 7" from a plan under way (none once every step is done, or without a plan). */
export function planStepText(plan: readonly PlanStep[] | undefined): string | null {
  if (!plan?.length) return null;
  const now = plan.findIndex(p => p.state === "now");
  return now < 0 ? null : `Step ${now + 1} of ${plan.length}`;
}

/**
 * The card's telemetry row beside its clock, at most two more items so the row reads in a glance: the plan's step, and
 * "Close to my limit" past 80% of the task's limits (else how many steps the user allowed).
 */
export function telemetryItems(a: Pick<CardActivity, "approvals" | "nearLimit">, plan?: readonly PlanStep[], ended = false): { step: string | null; extra: string | null } {
  const step = ended ? null : planStepText(plan);
  const extra = !ended && a.nearLimit ? "Close to my limit" : a.approvals > 0 ? (a.approvals === 1 ? "1 approval" : `${a.approvals} approvals`) : null;
  return { step, extra };
}

/**
 * The card's details: the items as rows, steps of one kind in a row folded into one ("Read the window 3 times in
 * Settings"), the latest `max` of them. A step still under way is a row of its own.
 */
export function activityRows(items: readonly ActivityItem[], max = DETAIL_ROWS): ActivityRow[] {
  const rows: (ActivityRow & { group?: StepGroup; app?: string; n?: number; apps?: Set<string> })[] = [];
  for (const it of items) {
    const last = rows.at(-1);
    if (last && it.kind === "step" && it.state !== "running" && it.group && last.group === it.group && last.state === it.state) {
      last.n = (last.n ?? 1) + 1;
      if (it.app) last.apps!.add(it.app);
      const one = last.apps!.size === 1 ? [...last.apps!][0] : undefined;
      // (A step that was stopped, a "Not now", is one it tried too, as is one that failed.)
      last.words = it.state === "done" ? stepsWords(it.group, last.n, one) : triedWords(it.group, last.n, one);
      continue;
    }
    rows.push({
      at: it.at, state: it.state, words: it.words, ...(it.model ? { model: true as const } : {}),
      ...(it.kind === "step" && it.state !== "running" ? { group: it.group, apps: new Set(it.app ? [it.app] : []) } : {}),
    });
  }
  return rows.slice(-max).map(r => ({ at: r.at, state: r.state, words: r.words, ...(r.model ? { model: true as const } : {}) }));
}

/** A row's state for screen readers, before its words. */
export const ROW_WORD: Readonly<Record<ActivityState, string>> = {
  running: "Now: ", done: "Done: ", failed: "Didn't work: ", waiting: "Waiting: ", stopped: "Stopped: ",
};
