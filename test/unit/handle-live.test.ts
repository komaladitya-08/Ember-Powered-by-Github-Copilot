/**
 * What the no-compositor corner card says in its live region of the bubble's words: each question, answer and problem
 * once, a question worded like the last one too, and nothing left there once it has gone (handle/live.ts).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { WHOLE_READ_SAID, type BubbleView } from "@ember/bubble";
import { HandleLive, micOpen, questionOf } from "../../app/renderer/handle/live";
import type { TaskCard } from "../../app/shared/overlay";

const STEP = "Ctrl+Alt+Y allow · Ctrl+Alt+N not now";
/** A command question as the card showed it twice in one task (elevated Ember: every command asks). */
const ask = (extra: Partial<BubbleView> = {}): BubbleView => ({
  visible: true, mood: "attention", title: "May I run a command?", streaming: false, step: STEP, risky: true,
  thought: "On this computer: Commands here run as root (the administrator), so each one asks first.\nYour task: Print two lines with two commands",
  ...extra,
});
/** What the Confirmer shows after an Allow: at work, so nothing to say. */
const carryingOn: BubbleView = { visible: true, mood: "acting", title: "Working…", thought: "Thanks! Carrying on.", streaming: false };
const hidden: BubbleView = { visible: false, mood: "idle", title: "", thought: "", streaming: false };
const answer: BubbleView = { visible: true, mood: "idle", title: "Ember", thought: "12 GB free.", streaming: false };
const thinking: BubbleView = { visible: true, mood: "thinking", title: "Thinking…", thought: "“How much room is left?”", streaming: true };

describe("the corner card's live region", () => {
  it("says a question worded like the one before it again, once Ember worked in between (accessibility-c8-1)", () => {
    const live = new HandleLive();
    const first = live.bubble(ask(), 1);
    expect(first).toMatch(/^Ember needs you: Risky step\. May I run a command\?/);
    // "Thanks! Carrying on.": nothing to say, and the question's words leave the region.
    expect(live.bubble(carryingOn, null)).toBe("");
    expect(live.bubble(ask(), 2)).toBe(first);
  });

  it("says another question in the same words when the card showed no bubble in between (accessibility-c8-1)", () => {
    const live = new HandleLive();
    const first = live.bubble(ask(), 1);
    expect(live.bubble(hidden, null)).toBe("");
    expect(live.bubble(ask(), 2)).toBe(first);
    // Straight after it, with nothing between: a third question is news too.
    expect(live.bubble(ask(), 3)).toBe(first);
  });

  it("doesn't say the same question again when the card shows it again, nor empty the region twice", () => {
    const live = new HandleLive();
    expect(live.bubble(ask(), 1)).not.toBeNull();
    expect(live.bubble(ask(), 1)).toBeNull();
    expect(live.bubble(hidden, null)).toBe("");
    expect(live.bubble(hidden, null)).toBeNull();
    expect(live.bubble(ask(), 1)).toBeNull();
  });

  it("says a question covered and shown again only once: one event main tells twice is said once (accessibility-c8-1)", () => {
    const live = new HandleLive();
    const listening: BubbleView = { visible: true, mood: "listening", title: "Listening…", thought: "", streaming: false };
    expect(live.bubble(ask(), 1)).not.toBeNull();
    // "Ember, …" to answer it by voice: "Listening…" covers it, then it shows again, unanswered.
    expect(live.bubble(listening, null)).toBe("");
    expect(live.bubble(ask(), 1)).toBeNull();
    // Its whole text read meanwhile: only that news, after the cover too.
    const text = "Dear team, the figures are attached. Bye";
    expect(live.bubble(ask({ whole: text, wholeSeen: false }), 2)).toContain(text);
    expect(live.bubble(listening, null)).toBe("");
    expect(live.bubble(ask({ whole: text, wholeSeen: true }), 2)).toBe(`${WHOLE_READ_SAID} Ctrl+Alt+Y allow; Ctrl+Alt+N not now.`);
    expect(live.bubble(carryingOn, null)).toBe("");
    expect(live.bubble(ask({ whole: text, wholeSeen: true }), 2)).toBeNull();
  });

  it("says an answer in the same words as the last again after Ember thought in between, as the overlay's bubble does", () => {
    const live = new HandleLive();
    expect(live.bubble(answer, null)).toBe("Ember says: 12 GB free.");
    expect(live.bubble(thinking, null)).toBe("");
    expect(live.bubble(answer, null)).toBe("Ember says: 12 GB free.");
    // While it shows, it is said once.
    expect(live.bubble(answer, null)).toBeNull();
  });

  it("says only that a question's whole text has all been shown, and a new question whole", () => {
    const live = new HandleLive();
    const text = "Dear team, the figures are attached. Bye";
    expect(live.bubble(ask({ whole: text, wholeSeen: false }), 4)).toContain(text);
    expect(live.bubble(ask({ whole: text, wholeSeen: true }), 4)).toBe(`${WHOLE_READ_SAID} Ctrl+Alt+Y allow; Ctrl+Alt+N not now.`);
    // Another question about the same text, already read: the question, not "You can allow it now" alone.
    const again = live.bubble(ask({ whole: text, wholeSeen: true }), 5);
    expect(again).toMatch(/^Ember needs you: /);
    expect(again).toContain(text);
  });

  it("knows a question by its buttons' number, whatever its buttons are", () => {
    expect(questionOf([{ id: "q7:once" }, { id: "q7:deny" }])).toBe(7);
    expect(questionOf([{ id: "ui:panel:12" }, { id: "q12:deny" }])).toBe(12);
    expect(questionOf([{ id: "ui:more" }])).toBeNull();
    expect(questionOf([])).toBeNull();
  });

  it("says a task that ended, once, in Home's words for it, and nothing for one it first sees (accessibility-c8-2)", () => {
    const live = new HandleLive();
    const task = (status: TaskCard["status"], extra: Partial<TaskCard> = {}): TaskCard => ({ id: "t1", title: "Print two lines with two commands", status, detail: "", ...extra });
    expect(live.taskNews([task("running")], false)).toBeNull();
    expect(live.taskNews([task("waiting")], false)).toBeNull();
    expect(live.taskNews([task("running")], false)).toBeNull();
    expect(live.taskNews([task("done")], false)).toBe("Print two lines with two commands: Done");
    expect(live.taskNews([task("done")], false)).toBeNull();
    // Two at once, each in its own words; one whose question went unanswered says so.
    const two = new HandleLive();
    two.taskNews([task("running"), { ...task("running"), id: "t2", title: "Tidy the desktop" }], false);
    expect(two.taskNews([task("failed"), { ...task("stopped", { unanswered: true }), id: "t2", title: "Tidy the desktop" }], false))
      .toBe("Print two lines with two commands: Didn't finish. Tidy the desktop: No answer in time");
    // A task the card first sees already ended is no news.
    expect(new HandleLive().taskNews([task("done")], false)).toBeNull();
  });

  it("holds a task's end while the microphone opens or is open for a request, and says it after (accessibility-c8-2)", () => {
    const live = new HandleLive();
    const task = (status: TaskCard["status"]): TaskCard => ({ id: "t1", title: "Print two lines with two commands", status, detail: "" });
    live.taskNews([task("running")], false);
    expect(live.taskNews([task("done")], true)).toBeNull();
    expect(live.taskNews([task("done")], true)).toBeNull();
    expect(live.taskNews([task("done")], false)).toBe("Print two lines with two commands: Done");
    expect(micOpen({ mic: "active" })).toBe(true);
    expect(micOpen({ mic: "starting" })).toBe(true);
    expect(micOpen({ mic: "waiting", micLearning: true })).toBe(true);
    expect(micOpen({ mic: "waiting" })).toBe(false);
    expect(micOpen({ mic: "off" })).toBe(false);
    expect(micOpen({})).toBe(false);
  });

  it("is what the card's page says, emptied when the bubble's words have gone and nothing else is said (accessibility-c8-1)", () => {
    const main = readFileSync("app/renderer/handle/main.ts", "utf8");
    expect(main).toContain("const said = live.bubble(view, questionOf(b.actions), name);");
    expect(main).toContain('else if (said === "" && $("live").textContent) $("live").textContent = "";');
  });

  it("says a task's end on the card in a status region of its own, held a second past the microphone (accessibility-c8-2)", () => {
    const main = readFileSync("app/renderer/handle/main.ts", "utf8");
    const page = readFileSync("app/renderer/handle/index.html", "utf8");
    expect(page).toContain('<div id="task-live" class="sr" role="status" aria-live="polite" aria-atomic="true"></div>');
    expect(main).toContain("const news = live.taskNews(tasksNow, newsHeld);");
    expect(main).toContain("newsSoon = setTimeout(() => { newsSoon = undefined; newsHeld = false; sayTasks(); }, LIVE_SETTLE_MS);");
  });
});
