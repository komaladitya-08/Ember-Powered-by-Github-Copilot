/** Pending Voice Match work cannot outlive Stop, enrolment or an owner change (SR-1, SR-2). */
import { describe, expect, it, vi } from "vitest";
import { VoiceGate } from "../../app/voice/match";
import type { VoiceEvent } from "../../app/voice/engine";

const owner = Float32Array.of(1, 0);
const other = Float32Array.of(0, 1);
const audio = new Float32Array(32_000).fill(0.1);
const request = (text = "Open the calendar."): VoiceEvent => ({ type: "utterance", text, ms: 0, window: "wake" });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup() {
  const pending: { resolve: (p: Float32Array) => void; reject: (e: Error) => void }[] = [];
  const sent: VoiceEvent[] = [];
  const error = vi.fn(), sample = vi.fn();
  const gate = new VoiceGate(() => ({ print: () => new Promise<Float32Array>((resolve, reject) => pending.push({ resolve, reject })) }), e => sent.push(e), error);
  gate.setOwner(owner);
  gate.onSample = sample;
  return { gate, pending, sent, error, sample };
}

describe("pending Voice Match requests", () => {
  for (const invalidation of ["cancel", "stop", "replace", "remove", "toggle"] as const) {
    for (const phase of ["whole", "rest", "wake"] as const) {
      it(`drops ${phase} verification after ${invalidation}, without delaying a fresh request (SR-1, SR-2)`, async () => {
        const { gate, pending, sent, sample } = setup();
        if (phase === "wake") {
          gate.event({ type: "wake", keyword: "hey ember" }, audio);
          gate.event(request(), audio);
        } else {
          gate.event(request(), audio, phase === "rest");
          if (phase === "rest") { pending[0].resolve(owner); await flush(); }
        }
        const stale = pending.at(-1)!;
        if (invalidation === "stop") gate.event({ type: "stop" }, null);
        else if (invalidation === "cancel") gate.cancel();
        else if (invalidation === "replace") gate.setOwner(other);
        else { gate.setOwner(null); if (invalidation === "toggle") gate.setOwner(owner); }
        const baseline = [...sent];
        // Fresh work finishes even while the cancelled print remains unresolved.
        gate.event(request("Fresh request."), audio);
        if (gate.on) pending.at(-1)!.resolve(invalidation === "replace" ? other : owner);
        await flush();
        expect(sent).toEqual([...baseline, { ...request("Fresh request."), ...(gate.on ? { verified: true } : {}) }]);
        const samples = sample.mock.calls.length;
        stale.resolve(owner);
        await flush();
        expect(sent).toHaveLength(baseline.length + 1);
        expect(sample).toHaveBeenCalledTimes(samples);
      });
    }
  }

  it("suppresses failures from a cancelled check rather than emitting its unverified request", async () => {
    const { gate, pending, sent, error } = setup();
    gate.event(request(), audio);
    gate.cancel();
    pending[0].reject(new Error("late failure"));
    await flush();
    expect(sent).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it("finishes a request against one snapshot during a benign adaptation refresh", async () => {
    const { gate, pending, sent } = setup();
    gate.event(request(), audio, true);
    pending[0].resolve(owner);
    await flush();
    gate.setOwner(Float32Array.of(0.99, 0.01), { anchor: owner, threshold: 0.78 }, true);
    // The pending request passed the original 0.75 threshold, not the new 0.78 one.
    pending[1].resolve(Float32Array.of(0.76, Math.sqrt(1 - 0.76 ** 2)));
    await flush();
    expect(sent).toEqual([{ ...request(), verified: true }]);
  });
});
