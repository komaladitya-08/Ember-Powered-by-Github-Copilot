/**
 * The whole of a long typed text is in view before Allow works (review #116, the rest of it): the Confirmer puts it in
 * the question's bubble, and takes Allow (its button and the approve key) only once the page that shows it says all of it
 * has been in view; the approve key before then shows the next part. Not now always works; a question whose text shows
 * whole in its sentence is as before.
 */

import { describe, expect, it, vi } from "vitest";
import { Confirmer, type Question } from "../../app/main/agent/confirm";
import type { EmberState } from "../../app/shared/overlay";

/** A text over 160 characters whose middle the question's sentence leaves out. */
const LONG = `Dear team, ${"the figures are attached. ".repeat(4)}MIDDLE-SECRET-PAYLOAD ${"see you at lunch. ".repeat(5)}Bye`;

const OPTIONS = [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }];
const typing = (more: Partial<Question> = {}): Question => ({ title: "May I?", context: "Write to the team", prompt: "Type “Dear team…Bye” (191 characters) into the “Message” text field?", options: OPTIONS, task: "t1", detail: LONG, ...more });
const KEYS = "Ctrl+Alt+Y allow · Ctrl+Alt+N not now";
const READ_KEYS = "Ctrl+Alt+Y shows the next part · Ctrl+Alt+N not now";
/** A Confirmer that shows at once and takes an answer at once (no arm time), recording what it shows. */
function confirmer(o: { blocked?: () => boolean; readKeys?: boolean } = {}) {
  const shown: Partial<EmberState>[] = [];
  const c = new Confirmer(p => shown.push(p), {
    armMs: 0, gapMs: 0, keyHint: () => KEYS, ...(o.readKeys === false ? {} : { readKeyHint: () => READ_KEYS }), ...(o.blocked ? { blocked: o.blocked } : {}),
  });
  return { c, shown, bubble: () => shown.at(-1)!.bubble! };
}

describe("the Confirmer's question with a whole text to read", () => {
  it("puts the whole text in the bubble, under the question's own sentence, not yet read", async () => {
    const { c, bubble } = confirmer();
    const q = c.ask(typing());
    // Its keys say what the approve key does for now: show the next part (never "allow", which it doesn't yet).
    expect(bubble()).toMatchObject({ mood: "attention", thought: `${typing().prompt}\nYour task: Write to the team`, step: READ_KEYS });
    expect(bubble().whole).toEqual({ n: 1, text: LONG, seen: false, page: 0 });
    // The buttons are the question's own: Allow, Not now.
    expect(bubble().actions.map(a => a.id)).toEqual(["q1:once", "q1:deny"]);
    c.cancelAll();
    await expect(q).resolves.toBeNull();
  });

  it("takes Allow (button or key) only once all of it has been in view", async () => {
    const { c, bubble } = confirmer();
    const q = c.ask(typing());
    expect(c.answer("q1:once")).toBe(false);
    expect(c.answerKey("primary")).toBe(false);
    expect(c.waiting).toBe(true);
    // Another question's text, or a question with nothing to read, says nothing about this one.
    expect(c.wholeSeen(2)).toBe(false);
    expect(bubble().whole?.seen).toBe(false);
    expect(c.wholeSeen(1)).toBe(true);
    expect(bubble().whole).toMatchObject({ n: 1, seen: true });
    // From now on the approve key allows, and the keys under the question say so.
    expect(bubble().step).toBe(KEYS);
    // Said once is enough.
    expect(c.wholeSeen(1)).toBe(false);
    expect(c.answer("q1:once")).toBe(true);
    await expect(q).resolves.toBe("once");
  });

  it("takes the approve key once all of it has been in view, and “Always in …” too only then", async () => {
    const { c } = confirmer();
    const q = c.ask(typing({ options: [OPTIONS[0], { id: "always", label: "Always in gedit" }, OPTIONS[1]] }));
    expect(c.answer("q1:always")).toBe(false);
    c.wholeSeen(1);
    expect(c.answerKey("primary")).toBe(true);
    await expect(q).resolves.toBe("once");
    const r = c.ask(typing({ options: [OPTIONS[0], { id: "always", label: "Always in gedit" }, OPTIONS[1]] }));
    await new Promise(res => setTimeout(res, 0));
    c.wholeSeen(2);
    expect(c.answer("q2:always")).toBe(true);
    await expect(r).resolves.toBe("always");
  });

  it("the approve key before then shows the next part instead (each press a page on), never while Ember drives the mouse", async () => {
    let driving = false;
    const { c, bubble } = confirmer({ blocked: () => driving });
    const q = c.ask(typing());
    expect(c.answerKey("primary")).toBe(false);
    expect(bubble().whole?.page).toBe(1);
    expect(c.answerKey("primary")).toBe(false);
    expect(bubble().whole?.page).toBe(2);
    // The bubble shown again is the same question: its words, buttons and keys.
    expect(bubble()).toMatchObject({ mood: "attention", title: "May I?", step: READ_KEYS, task: "t1" });
    expect(bubble().actions.map(a => a.id)).toEqual(["q1:once", "q1:deny"]);
    driving = true;
    expect(c.answerKey("primary")).toBe(false);
    expect(bubble().whole?.page).toBe(2);
    driving = false;
    c.cancelAll();
    await expect(q).resolves.toBeNull();
  });

  it("takes Not now at once, from the bubble or the key", async () => {
    for (const how of ["bubble", "key"] as const) {
      const { c } = confirmer();
      const q = c.ask(typing());
      expect(how === "key" ? c.answerKey("deny") : c.answer("q1:deny")).toBe(true);
      await expect(q).resolves.toBe("deny");
    }
  });

  it("names no key while its whole text waits to be read, when main gives no words for that (never “allow”)", async () => {
    const { c, bubble } = confirmer({ readKeys: false });
    const q = c.ask(typing());
    expect(bubble().step).toBeNull();
    c.wholeSeen(1);
    expect(bubble().step).toBe(KEYS);
    c.cancelAll();
    await expect(q).resolves.toBeNull();
  });

  it("leaves a question whose text shows whole in its sentence as it was", async () => {
    const { c, shown, bubble } = confirmer();
    const q = c.ask(typing({ detail: undefined, prompt: "Type “Hello” into the “Message” text field?" }));
    expect(bubble()).not.toHaveProperty("whole");
    expect(bubble().step).toBe(KEYS);
    expect(c.wholeSeen(1)).toBe(false);
    expect(shown).toHaveLength(1);
    expect(c.answerKey("primary")).toBe(true);
    await expect(q).resolves.toBe("once");
    // An empty text is nothing to read either.
    const r = c.ask(typing({ detail: "" }));
    await new Promise(res => setTimeout(res, 0));
    expect(bubble()).not.toHaveProperty("whole");
    expect(c.answer("q2:once")).toBe(true);
    await expect(r).resolves.toBe("once");
  });

  it("says nothing was read when no question is up", () => {
    const { c } = confirmer();
    expect(c.wholeSeen(1)).toBe(false);
  });

  it("arms Allow afresh once all of it has been in view: a key press that pages on never also allows", async () => {
    let t = 10_000;
    const c = new Confirmer(() => undefined, { armMs: 500, gapMs: 0, now: () => t });
    const q = c.ask(typing());
    t += 2_000;
    // Paging through: the third press brings the end into view, and the page says so at once.
    for (let i = 0; i < 3; i++) { expect(c.answerKey("primary")).toBe(false); t += 30; }
    expect(c.wholeSeen(1)).toBe(true);
    // The very next press (one too many, or a key held down and repeating) doesn't allow, nor does a click this soon.
    t += 30;
    expect(c.answerKey("primary")).toBe(false);
    expect(c.answer("q1:once")).toBe(false);
    // A key held down keeps repeating: never taken while it does.
    for (let i = 0; i < 40; i++) { t += 30; expect(c.answerKey("primary")).toBe(false); }
    // Let go, then a press of its own once Allow has been armed again: taken.
    t += 500;
    expect(c.answerKey("primary")).toBe(true);
    await expect(q).resolves.toBe("once");
  });

  it("takes a click on Allow once it has been armed after all of it was in view, and Not now at any time", async () => {
    let t = 10_000;
    const c = new Confirmer(() => undefined, { armMs: 500, gapMs: 0, now: () => t });
    const q = c.ask(typing());
    t += 2_000;
    expect(c.wholeSeen(1)).toBe(true);
    t += 100;
    expect(c.answer("q1:once")).toBe(false);
    t += 400;
    expect(c.answer("q1:once")).toBe(true);
    await expect(q).resolves.toBe("once");
    const r = c.ask(typing());
    await new Promise(res => setTimeout(res, 0));
    t += 2_000;
    c.wholeSeen(2);
    expect(c.answerKey("deny")).toBe(true);
    await expect(r).resolves.toBe("deny");
  });

  it("waits longer for a long text, a minute per 1000 characters of it, ten with More time (final review U1)", async () => {
    vi.useFakeTimers();
    try {
      // The longest text type_text and set_value take (worker.ts: 5000 characters).
      const text = "word ".repeat(1000).trim();
      for (const scale of [1, 10]) {
        // As main makes it: 2 minutes, times More time to read and answer.
        const c = new Confirmer(() => undefined, { timeoutMs: () => 120_000 * scale });
        const q = c.ask(typing({ detail: text }));
        // Paging on with the approve key as the user reads, past the question's own 2 minutes (20): still asked.
        for (let i = 0; i < 18; i++) { c.answerKey("primary"); await vi.advanceTimersByTimeAsync(7_000 * scale); }
        expect(c.waiting).toBe(true);
        // A minute more for every 1000 characters (ten with More time): about 7 minutes in all (70).
        const time = 120_000 * scale * (1 + text.length / 2000);
        await vi.advanceTimersByTimeAsync(time - 18 * 7_000 * scale - 1_000);
        expect(c.waiting).toBe(true);
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(q).resolves.toBeNull();
      }
      // A question with nothing more to read keeps the question's own time.
      const c = new Confirmer(() => undefined, { timeoutMs: () => 120_000 });
      const q = c.ask(typing({ detail: undefined, prompt: "Type “Hello” into the “Message” text field?" }));
      await vi.advanceTimersByTimeAsync(119_000);
      expect(c.waiting).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(q).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the pages' word that a whole text was read", () => {
  it("names the question, and nothing else reads as it", async () => {
    const { wholeSeenAction, wholeSeenOf } = await import("../../app/shared/overlay");
    expect(wholeSeenAction(7)).toBe("ui:seen:7");
    expect(wholeSeenOf(wholeSeenAction(7))).toBe(7);
    for (const id of ["ui:seen:", "ui:seen:0", "ui:seen:-1", "ui:seen:1x", "q1:once", "ui:seen:1:once", "ui:panel:1", "ui:seen:01"]) expect(wholeSeenOf(id), id).toBeNull();
  });

  it("holds Allow and Always back until it is read, never Not now, and only for its own question", async () => {
    const { waitsForWhole } = await import("../../app/shared/overlay");
    const whole = { n: 4, text: LONG, seen: false, page: 0 };
    expect(waitsForWhole("q4:once", whole)).toBe(true);
    expect(waitsForWhole("q4:always", whole)).toBe(true);
    expect(waitsForWhole("q4:deny", whole)).toBe(false);
    expect(waitsForWhole("q14:once", whole)).toBe(false);
    expect(waitsForWhole("ui:panel:4", whole)).toBe(false);
    expect(waitsForWhole("q4:once", { ...whole, seen: true })).toBe(false);
    expect(waitsForWhole("q4:once", undefined)).toBe(false);
  });

  it("says to scroll in the consent cards' own words", async () => {
    const { WHOLE_READ_HINT } = await import("@ember/bubble");
    const { CONSENT_READ_HINT } = await import("../../app/renderer/prompt/copy");
    expect(WHOLE_READ_HINT).toBe(CONSENT_READ_HINT);
  });

  it("reaches the Confirmer from the overlay and the corner card in main, whatever Ember's hands are doing", async () => {
    const fs = await import("node:fs");
    const MAIN = fs.readFileSync("app/main/main.ts", "utf8");
    const route = MAIN.indexOf("const seen = wholeSeenOf(id);\n    if (seen !== null) { confirmer?.wholeSeen(seen); return; }");
    expect(route).toBeGreaterThan(0);
    // After the check that the sender is the overlay or the handle, before the borrow's guard and the targets runtime.
    expect(route).toBeGreaterThan(MAIN.indexOf("if (!(overlay?.owns(event.sender) || fromHandle) || typeof id !== \"string\" || id.length > 120) return;"));
    expect(route).toBeLessThan(MAIN.indexOf("if (borrowRef?.driving && !(task && task[2] === \"stop\")"));
    expect(route).toBeLessThan(MAIN.indexOf("if (targets?.bubbleAction(id)) return;"));
    // Both pages send it and show the read hint.
    for (const page of ["app/renderer/overlay/main.ts", "app/renderer/handle/main.ts"]) {
      const src = fs.readFileSync(page, "utf8");
      expect(src, page).toContain("wholeSeenAction(");
      expect(src, page).toContain("waitsForWhole(");
    }
    // And a screen reader hears only the news once all of it has been shown, not the question again: in the bubble (the
    // overlay's), and on the corner card.
    for (const page of ["packages/bubble/src/bubble.ts", "app/renderer/handle/main.ts"]) expect(fs.readFileSync(page, "utf8"), page).toContain("wholeReadNews(");
  });

  it("names what the approve key does while the whole text waits, under the question and aloud (main's wiring)", async () => {
    const fs = await import("node:fs");
    const MAIN = fs.readFileSync("app/main/main.ts", "utf8");
    const { WHOLE_KEY_HINT, WHOLE_KEY_SAY } = await import("@ember/bubble");
    expect(WHOLE_KEY_HINT).toBe("shows the next part");
    expect(WHOLE_KEY_SAY).toBe("to show the next part");
    // The same keys Ember holds (whichever chord it holds), the approve key's words swapped.
    expect(MAIN).toContain("readKeyHint: () => { holdQuestionKeys(); return readKeyWords(heldKeys()).map(k => k.hint).join(\" · \") || undefined; },");
    expect(MAIN).toContain("questionAloud(q.question, { keys: (q.question.detail ? readKeyWords(heldKeys()) : heldKeys()).map(k => k.say), spoken: spokenText })");
    const { readKeyWords } = await import("../../app/main/agent/presenter");
    const held = [
      { which: "primary" as const, hint: "Ctrl+Alt+Y allow", say: "Control Alt Y to allow" },
      { which: "deny" as const, hint: "Ctrl+Alt+N not now", say: "Control Alt N for not now" },
    ];
    expect(readKeyWords(held)).toEqual([
      { hint: "Ctrl+Alt+Y shows the next part", say: "Control Alt Y to show the next part" },
      { hint: "Ctrl+Alt+N not now", say: "Control Alt N for not now" },
    ]);
    // A fallback chord is named as held; words that don't end as expected are left out, never said to allow.
    expect(readKeyWords([{ ...held[0], hint: "Ctrl+Alt+Shift+Y allow", say: "Control Alt Shift Y to allow" }])[0]).toEqual({ hint: "Ctrl+Alt+Shift+Y shows the next part", say: "Control Alt Shift Y to show the next part" });
    expect(readKeyWords([{ ...held[0], hint: "Ctrl+Alt+Y OK", say: "Control Alt Y for OK" }, held[1]])).toEqual([held[1]].map(({ hint, say }) => ({ hint, say })));
  });
});

describe("the eval's simulated user", () => {
  it("reads a whole text through before it answers, and answers its question once", async () => {
    const { simulatedUser } = await import("../../eval/src/runner");
    const questions: string[] = [];
    const task = { user: { answer: "allow", answers: [], grants: [] } } as unknown as Parameters<typeof simulatedUser>[0];
    const c = simulatedUser(task, questions);
    await expect(c.ask(typing())).resolves.toBe("once");
    expect(questions).toEqual([`${typing().prompt}\nYour task: Write to the team`]);
  });
});
