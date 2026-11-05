/**
 * A question's deadline is fixed when it shows: an answer arriving after it, by any path, approves nothing, even when
 * the timer's callback has not run yet (review of #183: the clock can pass the deadline before the timer fires).
 */

import { describe, expect, it, vi } from "vitest";
import { Confirmer, type Question } from "../../app/main/agent/confirm";

const Q: Question = { title: "May I?", prompt: "Click “Send”?", options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }], task: "t1", risky: true };

function rig() {
  vi.useFakeTimers();
  let t = 1_000;
  const c = new Confirmer(() => undefined, { armMs: 0, gapMs: 0, timeoutMs: 1000, now: () => t });
  return { c, advance: (ms: number) => { t += ms; } };
}

describe("the Confirmer's deadline", () => {
  it("rejects an Allow pressed after the deadline though the timer has not fired (bubble, key, voice)", async () => {
    const { c, advance } = rig();
    try {
      const q = c.ask(Q);
      advance(1000); // the logical clock is at the deadline; fake timers are not advanced, so the callback hasn't run
      expect(c.refusal("q1:once")).toBe("gone");
      expect(c.answer("q1:once")).toBe(false);
      await expect(q).resolves.toBeNull(); // ended as expired, not approved
      const q2 = c.ask(Q);
      advance(1000);
      expect(c.answerKey("primary")).toBe(false);
      await expect(q2).resolves.toBeNull();
      const q3 = c.ask(Q);
      advance(5000);
      expect(c.answerVoice("allow", { verified: true })).toBe("stale");
      await expect(q3).resolves.toBeNull();
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
