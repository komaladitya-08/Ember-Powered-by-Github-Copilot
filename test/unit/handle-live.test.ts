/**
 * What the no-compositor corner card says in its live region of the bubble's words: each question, answer and problem
 * once, a question worded like the last one too, and nothing left there once it has gone (handle/live.ts).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { WHOLE_READ_SAID, type BubbleView } from "@ember/bubble";
import { HandleLive, questionOf } from "../../app/renderer/handle/live";

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

  it("is what the card's page says, emptied when the bubble's words have gone and nothing else is said (accessibility-c8-1)", () => {
    const main = readFileSync("app/renderer/handle/main.ts", "utf8");
    expect(main).toContain("const said = live.bubble(view, questionOf(b.actions), name);");
    expect(main).toContain('else if (said === "" && $("live").textContent) $("live").textContent = "";');
  });
});
