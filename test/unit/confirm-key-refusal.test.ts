/**
 * Ember's allow and not-now keys pressed when the Confirmer can't take them (owner's report of 2026-11-12): the press
 * did nothing visible. It now says why on the question, under its sentence and above the keys, while every gate stays
 * as it was: the arm delay, Ember borrowing the mouse, a whole text read and rested on, a command card shown whole, a
 * consent card by a click only. A press that pages a whole text on isn't refused, and says nothing.
 */

import { describe, expect, it } from "vitest";
import { Confirmer, KEY_REFUSED, type Question } from "../../app/main/agent/confirm";
import { spokenAnswer } from "../../app/shared/spoken-answer";

const options = [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }];
const q = (o: Partial<Question> = {}): Question => ({ title: "May I?", prompt: "Click “Save” in gedit?", options, ...o });
const KEYS = "Ctrl+Alt+Y allow · Ctrl+Alt+N not now";

/** A Confirmer at a controllable clock; `step()` is what the question's bubble says under its sentence now. */
function confirmer(o: { blocked?: () => boolean; panelReady?: (n: number) => boolean } = {}) {
  let t = 1000;
  const bubbles: { step?: string | null }[] = [];
  const c = new Confirmer(p => { if (p.bubble) bubbles.push(p.bubble); }, { armMs: 500, gapMs: 0, now: () => t, keyHint: () => KEYS, readKeyHint: () => "Ctrl+Alt+Y shows the next part · Ctrl+Alt+N not now", ...o });
  return { c, later: (ms: number) => { t += ms; }, step: () => bubbles.at(-1)?.step ?? null };
}

describe("an allow key press that is refused (owner's report of 2026-11-12)", () => {
  it("says on the question that it was pressed as the question came up, and takes the next press", async () => {
    const { c, later, step } = confirmer();
    const answer = c.ask(q());
    later(200);
    expect(c.answerKey("primary")).toBe(false);
    expect(step()).toBe(`${KEY_REFUSED["not-yet"]}\n${KEYS}`);
    later(400);
    expect(c.answerKey("primary")).toBe(true);
    expect(await answer).toBe("once");
  });

  it("says Ember is using the mouse while it borrows it, and takes a press once it has stopped", async () => {
    let borrowing = true;
    const { c, later, step } = confirmer({ blocked: () => borrowing });
    const answer = c.ask(q());
    later(600);
    expect(c.answerKey("primary")).toBe(false);
    expect(step()).toBe(`${KEY_REFUSED.busy}\n${KEYS}`);
    borrowing = false;
    expect(c.answerKey("primary")).toBe(true);
    expect(await answer).toBe("once");
  });

  it("says a command card's window must show all of it first, and never allows it before", async () => {
    let shown = false;
    const card = { kind: "command" as const, card: { sha256: "a".repeat(64) } as never };
    const { c, later, step } = confirmer({ panelReady: () => shown });
    const answer = c.ask(q({ panel: card }));
    later(600);
    expect(c.answerKey("primary")).toBe(false);
    expect(step()).toMatch(new RegExp(`^${KEY_REFUSED.panel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    shown = true;
    expect(c.answerKey("primary")).toBe(true);
    expect(await answer).toBe("once");
  });

  it("says a consent card needs a click, and Not now by key still works", async () => {
    const consent = { kind: "consent" as const, consent: { sha256: "b".repeat(64) } as never };
    const { c, later, step } = confirmer({ panelReady: () => true });
    const answer = c.ask(q({ panel: consent, clickOnly: true }));
    later(600);
    expect(c.answerKey("primary")).toBe(false);
    expect(step()).toMatch(/^This one needs a click in its window/);
    expect(c.answerKey("deny")).toBe(true);
    expect(await answer).toBe("deny");
  });

  it("pages a whole text on without a word, and says to press again once all of it shown when pressed too soon after", async () => {
    const { c, later, step } = confirmer();
    const answer = c.ask(q({ detail: "x".repeat(400) }));
    later(600);
    // Paging on is what the key does until the end has shown: no refusal, no note.
    expect(c.answerKey("primary")).toBe(false);
    expect(step()).toBe("Ctrl+Alt+Y shows the next part · Ctrl+Alt+N not now");
    c.wholeSeen(1);
    later(100);
    expect(c.answerKey("primary")).toBe(false);
    expect(step()).toBe(`${KEY_REFUSED["too-soon"]}\n${KEYS}`);
    later(600);
    expect(c.answerKey("primary")).toBe(true);
    expect(await answer).toBe("once");
  });

  it("says nothing when no question is up, and none of its words read as a spoken answer, should Ember be listening for one", () => {
    const { c, step } = confirmer();
    expect(c.answerKey("primary")).toBe(false);
    expect(step()).toBeNull();
    for (const line of Object.values(KEY_REFUSED)) {
      const words = line.split(/\s+/);
      for (let i = 0; i < words.length; i++) expect(spokenAnswer(words.slice(i).join(" ")), line).toBeNull();
      expect(line).not.toMatch(/\bember\b/i);
    }
  });
});
