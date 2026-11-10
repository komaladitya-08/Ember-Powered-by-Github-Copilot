/**
 * A question's deadline is fixed when it shows: an answer arriving after it, by any path, approves nothing, even when
 * the timer's callback has not run yet (review of #183: the clock can pass the deadline before the timer fires).
 */

import { describe, expect, it, vi } from "vitest";
import { Confirmer, type Question } from "../../app/main/agent/confirm";
import type { EmberState } from "../../app/shared/overlay";

const Q: Question = { title: "May I?", prompt: "Click “Send”?", options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }], task: "t1", risky: true };

function rig() {
  vi.useFakeTimers();
  let t = 1_000;
  const c = new Confirmer(() => undefined, { armMs: 0, gapMs: 0, timeoutMs: 1000, now: () => t });
  return { c, advance: (ms: number) => { t += ms; } };
}

describe("the Confirmer's deadline", () => {
  // Each entry point gets its own Confirmer, and none is preceded by another call that could end the question first
  // (refusal() expires a late question itself, which would hide a missing guard in answer()).
  it("answer() alone rejects a press after the deadline though the timer has not fired", async () => {
    const { c, advance } = rig();
    try {
      const q = c.ask(Q);
      advance(1000); // the logical clock is at the deadline; fake timers are not advanced, so the callback hasn't run
      expect(c.answer("q1:once")).toBe(false);
      await expect(q).resolves.toBeNull(); // ended as expired, not approved
      expect(c.answer("q1:once")).toBe(false); // the same id again: stale
    } finally { vi.useRealTimers(); }
  });

  it("refusal() says gone for a press after the deadline and ends the question as expired", async () => {
    const { c, advance } = rig();
    try {
      const q = c.ask(Q);
      advance(1000);
      expect(c.refusal("q1:once")).toBe("gone");
      await expect(q).resolves.toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("answerKey() rejects the allow key after the deadline", async () => {
    const { c, advance } = rig();
    try {
      const q = c.ask(Q);
      advance(1000);
      expect(c.answerKey("primary")).toBe(false);
      await expect(q).resolves.toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("answerVoice() calls a verified allow after the deadline stale", async () => {
    const { c, advance } = rig();
    try {
      const q = c.ask(Q);
      advance(5000);
      expect(c.answerVoice("allow", { verified: true })).toBe("stale");
      await expect(q).resolves.toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("still takes an answer before the deadline", async () => {
    const { c, advance } = rig();
    try {
      const q = c.ask(Q);
      advance(999);
      expect(c.answer("q1:once")).toBe(true);
      await expect(q).resolves.toBe("once");
    } finally { vi.useRealTimers(); }
  });
});

describe("a question that runs out of time (tasks-approvals-4)", () => {
  it("leaves its note up long enough to be read on coming back, longer with More time to read and answer", async () => {
    vi.useFakeTimers();
    try {
      let read = 1;
      const settled: unknown[] = [];
      const c = new Confirmer(() => undefined, { armMs: 0, gapMs: 0, timeoutMs: 1000, answerMs: () => 1500 * read, expiredMs: () => 10_000 * read, afterAnswer: s => settled.push(s) });
      const q = c.ask(Q);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(q).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(1600);
      // A 1.5 s note was gone before anyone coming back to the computer could see it.
      expect(settled).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(8500);
      expect(settled).toHaveLength(1);
      // With More time to read and answer, answers stay ten times as long, as the setting says bubbles do.
      read = 10;
      const q2 = c.ask(Q);
      await vi.advanceTimersByTimeAsync(10);
      expect(c.answer("q2:once")).toBe(true);
      await q2;
      await vi.advanceTimersByTimeAsync(14_000);
      expect(settled).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(settled).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
});

describe("what a timed-out question says to do next (tasks-approvals-r1)", () => {
  it("points a task's question at Try again on its card, and keeps “say or type the request again” for one with no task", async () => {
    const { EXPIRED_STEP, EXPIRED_TASK_STEP, EXPIRED_THOUGHT, EXPIRED_TASK_THOUGHT } = await import("../../app/main/agent/confirm");
    const shown: Partial<EmberState>[] = [];
    const c = new Confirmer(s => shown.push(s), { armMs: 0, gapMs: 0, timeoutMs: 20 });
    await c.ask(Q);
    expect(shown.at(-1)!.bubble).toMatchObject({ thought: EXPIRED_TASK_THOUGHT, step: EXPIRED_TASK_STEP });
    expect(EXPIRED_TASK_STEP).toBe("If I can't finish without it, choose Try again on its card. Otherwise, say or type the request again.");
    expect(EXPIRED_TASK_THOUGHT).toBe("Time ran out, so nothing was approved and I haven't done it.");
    const { task: _task, ...untasked } = Q;
    await c.ask(untasked);
    expect(shown.at(-1)!.bubble).toMatchObject({ thought: EXPIRED_THOUGHT, step: EXPIRED_STEP });
    expect(EXPIRED_STEP).toBe("To review it, say or type the request again.");
  });

  it("promises Try again only for a task that can't finish without the answer, since one that finishes the rest offers Close alone (tasks-approvals-c2-2)", async () => {
    const { EXPIRED_TASK_STEP } = await import("../../app/main/agent/confirm");
    const { TaskManager } = await import("../../app/main/agent/tasks");
    const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as never;
    const cards: { actions?: { label: string }[] }[][] = [];
    // The question went unanswered (the note is up), then the worker finished the rest and said it was done.
    const tm = new TaskManager({ log: quiet, currentWindow: () => null, setCards: c => cards.push(c), deleteSession: async () => undefined, keepMs: 0,
      makeWorker: () => ({ run: async () => ({ success: true, summary: "I tidied the build folder, but didn't delete the old one: my question timed out." }), dispose: async () => undefined, sessionId: "s" }) as never });
    tm.start("Tidy the build folder", { userWords: "tidy the build folder" });
    await vi.waitFor(() => expect(cards.at(-1)?.[0]?.actions?.map(a => a.label)).toEqual(["Close"]));
    // So the note says when the card offers Try again, and what to do otherwise; never that it does.
    expect(EXPIRED_TASK_STEP).toMatch(/^If I can't finish without it, choose Try again on its card\. Otherwise, say or type the request again\.$/);
    expect(EXPIRED_TASK_STEP).not.toMatch(/^To review it, choose Try again/);
  });
});
