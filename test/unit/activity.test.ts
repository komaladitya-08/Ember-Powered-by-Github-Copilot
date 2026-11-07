/**
 * A task's activity (app/main/agent/activity.ts, app/shared/activity.ts): what its card says it is doing and has done,
 * in Ember's own words, built from its worker's tool calls and Ember's own signals (UI audit #2: a card that said only
 * "Working…"). Never the model's arguments or reasoning; only the worker's own note is its words, and marked so.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ActivityLog } from "../../app/main/agent/activity";
import {
  cardApp, CARD_APP_MAX, ACTIVITY_LIMIT, STATUS_WORDS, activityRows, clockText, doingWords, elapsedText, planStepText, retryWords, stepsWords,
  summarizeActivity, telemetryItems, type ActivityItem,
} from "../../app/shared/activity";
import { stepOf } from "../../app/main/agent/presenter";

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

const T0 = 1_000_000;

/** A log that started at T0, with a step helper: a tool call from start to end at `at` ms. */
function log() {
  const l = new ActivityLog(T0);
  let n = 0;
  const step = (tool: string, at: number, o: { ok?: boolean; app?: string } = {}) => {
    const id = `call_${++n}`;
    l.add({ type: "tool-start", id, tool, step: stepOf(tool), ...(o.app ? { app: o.app } : {}) }, T0 + at);
    l.add({ type: "tool-end", id, ok: o.ok ?? true }, T0 + at + 100);
  };
  return { l, step };
}

describe("a task's live line", () => {
  it("says what Ember is doing now and where, in its own words, not just “Working…” (audit #2)", () => {
    const { l } = log();
    expect(l.card().live).toBe("Starting…");
    l.add({ type: "turn" }, T0 + 10);
    expect(l.card().live).toBe("Thinking…");
    l.add({ type: "tool-start", id: "c1", tool: "click", step: stepOf("click"), app: "Text Editor" }, T0 + 500);
    expect(l.card().live).toBe("Clicking in Text Editor…");
    l.add({ type: "tool-end", id: "c1", ok: true }, T0 + 700);
    expect(l.card().live).toBe("Thinking…");
  });

  it("drops “(your keyboard)” from a step: the hand line already says whose keyboard it is", () => {
    expect(doingWords(stepOf("press_keys"), "Files")).toBe("Pressing keys in Files…");
    expect(doingWords(undefined)).toBe("Working…");
  });

  it("says “Waiting for you” while a question is up, never that it is working, then goes back (T3 Code's rule)", () => {
    const { l } = log();
    l.add({ type: "tool-start", id: "c1", tool: "click", step: stepOf("click"), app: "Mail" }, T0 + 100);
    l.add({ type: "question" }, T0 + 200);
    expect(l.asking).toBe(true);
    expect(l.card().live).toBe(STATUS_WORDS.waiting);
    l.add({ type: "answer", answer: "allowed" }, T0 + 4000);
    expect(l.asking).toBe(false);
    expect(l.card().live).toBe("Clicking in Mail…");
    expect(l.card().approvals).toBe(1);
    expect(l.get().items.find(i => i.kind === "question")).toMatchObject({ state: "done", words: "Asked you: you allowed it" });
  });

  it("says a “Not now” and an unanswered question plainly, and counts neither as an approval", () => {
    const { l } = log();
    l.add({ type: "question" }, T0);
    l.add({ type: "answer", answer: "declined" }, T0 + 10);
    l.add({ type: "question" }, T0 + 20);
    l.add({ type: "answer", answer: "expired" }, T0 + 30);
    expect(l.get().items.map(i => i.words)).toEqual(["Asked you: you said not now", "Asked you: no answer"]);
    expect(l.card().approvals).toBe(0);
  });

  it("shows a retry with its count, and lets it go once Copilot answers", () => {
    const { l } = log();
    l.add({ type: "turn" }, T0);
    l.add({ type: "retry" }, T0 + 100);
    expect(l.card().live).toBe("Retrying…");
    l.add({ type: "retry" }, T0 + 200);
    expect(l.card().live).toBe("Retrying (try 3)…");
    l.add({ type: "heard" }, T0 + 300);
    expect(l.card().live).toBe("Thinking…");
    expect(retryWords(1)).toBe("Retrying…");
  });

  it("says when Copilot has been quiet a while, and stops saying it", () => {
    const { l } = log();
    l.add({ type: "turn" }, T0);
    l.add({ type: "slow", on: true }, T0 + 30_000);
    expect(l.card().live).toBe("Still waiting for Copilot…");
    l.add({ type: "slow", on: false }, T0 + 31_000);
    expect(l.card().live).toBe("Thinking…");
  });

  it("ends with the state's word from the one table, and takes nothing after", () => {
    const { l, step } = log();
    step("click", 0);
    l.add({ type: "end", status: "failed" }, T0 + 5000);
    expect(l.card()).toMatchObject({ live: "Didn't finish", endedAt: T0 + 5000 });
    expect(l.add({ type: "turn" }, T0 + 6000)).toBe(false);
    expect(STATUS_WORDS).toEqual({ running: "Working", waiting: "Waiting for you", queued: "Waiting its turn", retrying: "Retrying", done: "Done", failed: "Didn't finish", stopped: "Stopped" });
  });
});

describe("the steps' summary", () => {
  it("names what changed things before what only looked, at most two kinds, then how many others", () => {
    expect(summarizeActivity({ read: 2, click: 3 })).toBe("Clicked 3 times and read the window 2 times");
    expect(summarizeActivity({ read: 1, setting: 1, open: 2, keys: 1 })).toBe("Changed a setting, opened 2 apps and 2 other steps");
    expect(summarizeActivity({ read: 1, setting: 1, open: 1 })).toBe("Changed a setting, opened an app and 1 other step");
    expect(summarizeActivity({})).toBeNull();
  });

  it("says how many steps didn't work, and counts every step, also those no longer kept", () => {
    const { l, step } = log();
    step("click", 0, { ok: false });
    step("click", 1000);
    for (let i = 0; i < ACTIVITY_LIMIT + 10; i++) step("perceive_window", 2000 + i * 200);
    expect(l.card().summary).toBe(`Clicked 2 times and read the window ${ACTIVITY_LIMIT + 10} times (1 didn't work)`);
    const a = l.get();
    expect(a.items.length).toBe(ACTIVITY_LIMIT);
    expect(a.dropped).toBe(12);
    expect(a.steps).toBe(ACTIVITY_LIMIT + 12);
  });

  it("makes no step of the task's own talking (report_progress, finish_task)", () => {
    const { l } = log();
    l.add({ type: "tool-start", id: "p", tool: "report_progress", step: stepOf("report_progress") }, T0);
    l.add({ type: "tool-end", id: "p", ok: true }, T0 + 10);
    expect(l.get().items).toEqual([]);
    expect(l.card().summary).toBeUndefined();
  });

  it("pairs a step's end with its own start by the call's id, whatever ends first", () => {
    const { l } = log();
    l.add({ type: "tool-start", id: "a", tool: "click", step: stepOf("click") }, T0);
    l.add({ type: "tool-start", id: "b", tool: "type_text", step: stepOf("type_text") }, T0 + 1);
    l.add({ type: "tool-end", id: "b", ok: false }, T0 + 2);
    l.add({ type: "tool-end", id: "a", ok: true }, T0 + 3);
    expect(l.get().items.map(i => [i.group, i.state])).toEqual([["click", "done"], ["type", "failed"]]);
  });
});

describe("the details' rows", () => {
  it("fold steps of one kind in a row into one line, naming the app when they all worked in it", () => {
    const { l, step } = log();
    step("perceive_window", 0, { app: "Settings" });
    step("perceive_window", 1000, { app: "Settings" });
    step("perceive_window", 2000, { app: "Settings" });
    step("click", 3000, { app: "Settings" });
    step("click", 4000, { app: "Files" });
    expect(l.card().rows.map(r => r.words)).toEqual(["Read the window 3 times in Settings", "Clicked 2 times"]);
  });

  it("keep the latest six, a step under way on its own, and the worker's note marked as its words", () => {
    const items: ActivityItem[] = [
      ...["click", "type", "read", "setting", "open", "keys", "scroll"].map((g, i) => ({ id: `s${i}`, kind: "step" as const, at: i * 1000, state: "done" as const, words: "x", group: g as ActivityItem["group"] })),
      { id: "n", kind: "note", at: 8000, state: "done", words: "Looking for the Display page", model: true },
      { id: "r", kind: "step", at: 9000, state: "running", words: "Clicking…", group: "click" },
    ];
    const rows = activityRows(items);
    expect(rows.length).toBe(6);
    expect(rows.at(-2)).toEqual({ at: 8000, state: "done", words: "Looking for the Display page", model: true });
    expect(rows.at(-1)).toMatchObject({ state: "running", words: "Clicking…" });
  });

  it("say what a step that didn't work tried, never a red mark beside “Opened an app”", () => {
    const { l, step } = log();
    step("open_app", 0, { ok: false });
    step("click", 1000, { ok: false, app: "Files" });
    step("click", 2000, { ok: false, app: "Files" });
    expect(l.card().rows.map(r => [r.state, r.words])).toEqual([["failed", "Tried to open an app"], ["failed", "Tried to click 2 times in Files"]]);
  });

  it("make a refused step one row with the refusal, not a failed step beside it, and don't count it as a step", () => {
    const { l } = log();
    l.add({ type: "tool-start", id: "c1", tool: "open_app", step: stepOf("open_app") }, T0);
    l.add({ type: "refused", reason: "Ember doesn't run terminals" }, T0 + 5);
    l.add({ type: "tool-end", id: "c1", ok: false }, T0 + 10);
    expect(l.card().rows).toEqual([{ at: 0, state: "stopped", words: "Not allowed: Ember doesn't run terminals" }]);
    expect(l.card().summary).toBeUndefined();
    expect(l.card().live).toBe("Thinking…");
  });

  it("show a step the user said “Not now” to as stopped, not as one that didn't work, and don't count it (UI audit)", () => {
    const { l } = log();
    l.add({ type: "tool-start", id: "c1", tool: "click", step: stepOf("click"), app: "Files" }, T0);
    l.add({ type: "question" }, T0 + 5);
    l.add({ type: "answer", answer: "declined" }, T0 + 10);
    l.add({ type: "denied" }, T0 + 11);
    l.add({ type: "tool-end", id: "c1", ok: false }, T0 + 12);
    const card = l.card();
    expect(card.rows.find(r => r.words.startsWith("Tried to click"))?.state).toBe("stopped");
    expect(card.rows.some(r => r.state === "failed")).toBe(false);
    expect(card.summary ?? "").not.toMatch(/didn't work/);
  });

  it("keep an app's name short, and quote one another computer named over SSH (UI audit)", () => {
    expect(cardApp("Text Editor")).toBe("Text Editor");
    const long = cardApp("A window title that some app put in its WM_CLASS to look official");
    expect(long.length).toBe(CARD_APP_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(cardApp("Files", true)).toBe("“Files”");
    expect(doingWords("Clicking", cardApp("Files", true))).toBe("Clicking in “Files”…");
    expect(read("app/main/agent/worker.ts")).toContain('app: cardApp(friendlyApp(this.window.app), this.d.target?.kind === "ssh")');
  });

  it("say a refusal with Ember's (policy's) reason, and a change of hand", () => {
    const { l } = log();
    l.add({ type: "refused", reason: "password fields are for the user only" }, T0);
    l.add({ type: "hand", hand: "cursor" }, T0 + 10);
    expect(l.card().rows.map(r => [r.state, r.words])).toEqual([["stopped", "Not allowed: password fields are for the user only"], ["done", "Used your mouse and keyboard"]]);
  });
});

describe("the worker's note", () => {
  it("shows its intent when it gives one, else its text, and keeps the text in the details as its own words", () => {
    const { l } = log();
    l.add({ type: "note", text: "Opening Display settings to find Night Light.", intent: "Finding Night Light" }, T0);
    expect(l.card().note).toBe("Finding Night Light");
    expect(l.card().rows).toEqual([{ at: 0, state: "done", words: "Opening Display settings to find Night Light.", model: true }]);
    l.add({ type: "note", text: "Turning it on" }, T0 + 1000);
    expect(l.card().note).toBe("Turning it on");
  });
});

describe("the telemetry row (HUD direction: three items at most, readable in a glance)", () => {
  it("says how long it has worked, in tabular words, and how long it took once it ended", () => {
    expect(elapsedText(12_400)).toBe("12s");
    expect(elapsedText(102_000)).toBe("1:42");
    expect(elapsedText(3_725_000)).toBe("1:02:05");
    expect(clockText({ startedAt: 0 }, 4000)).toBe("Just started");
    expect(clockText({ startedAt: 0 }, 42_000)).toBe("42s");
    expect(clockText({ startedAt: 0, endedAt: 72_000 }, 99_999)).toBe("Took 1:12");
    expect(clockText({ startedAt: 0, endedAt: 400 }, 99_999)).toBe("Took a moment");
  });

  it("gives the plan's step, then “Close to my limit” past 80% of the limits, else the approvals", () => {
    const plan = [{ text: "a", state: "done" as const }, { text: "b", state: "now" as const }, { text: "c", state: "todo" as const }];
    expect(planStepText(plan)).toBe("Step 2 of 3");
    expect(planStepText(plan.map(p => ({ ...p, state: "done" as const })))).toBeNull();
    expect(telemetryItems({ approvals: 2, nearLimit: false }, plan)).toEqual({ step: "Step 2 of 3", extra: "2 approvals" });
    expect(telemetryItems({ approvals: 1, nearLimit: true }, plan)).toEqual({ step: "Step 2 of 3", extra: "Close to my limit" });
    expect(telemetryItems({ approvals: 1, nearLimit: true }, plan, true)).toEqual({ step: null, extra: "1 approval" });
  });

  it("says the task is close to its limit once", () => {
    const { l } = log();
    expect(l.add({ type: "near-limit" }, T0)).toBe(true);
    expect(l.add({ type: "near-limit" }, T0 + 1)).toBe(false);
    expect(l.card().nearLimit).toBe(true);
  });

  it("says a step waits for the minute's limit in its live line, a pause and never a refusal (tasks-approvals-2)", () => {
    const { l } = log();
    l.add({ type: "tool-start", id: "c1", tool: "click", step: "Clicking", app: "Text Editor" }, T0);
    expect(l.add({ type: "paced", perMinute: 40 }, T0 + 1)).toBe(true);
    expect(l.card().live).toBe("Pausing to keep to 40 steps a minute…");
    expect(l.card().rows.map(r => r.words)).toEqual(["Clicking in Text Editor…"]);
    l.add({ type: "tool-end", id: "c1", ok: true }, T0 + 2);
    expect(l.card().live).toBe("Thinking…");
  });
});

describe("step words", () => {
  it("count one and many steps of each kind", () => {
    expect(stepsWords("click", 1)).toBe("Clicked once");
    expect(stepsWords("choose", 4, "Firefox")).toBe("Chose 4 options in Firefox");
    expect(stepsWords("command", 2)).toBe("Ran 2 commands");
  });
});
