/** The Home correction boundary rejects old accounts, withheld consent and malformed records before writing. */
import { describe, expect, it, vi } from "vitest";
import { correctMemoryRequest } from "../../app/main/memory/correction";

const expected = { id: "fact-a", text: "Prefers tea", source: "conversation" as const, at: "2026-11-04", revision: 0 };
const request = { expected, text: "Prefers coffee", epoch: 3 };
describe("local memory correction authorisation", () => {
  it("passes the exact record to the durable correction only for the current owned and consented view", () => {
    const correct = vi.fn(() => ({ ...expected, text: request.text, revision: 1 }));
    expect(correctMemoryRequest(request, { ready: true, inForce: true, epoch: 3, correct })).toEqual({ ...expected, text: request.text, revision: 1 });
    expect(correct).toHaveBeenCalledExactlyOnceWith(expected, request.text);
  });
  it("refuses account changes, unavailable ownership and memory off without invoking correction", () => {
    for (const state of [{ ready: false, inForce: true, epoch: 3 }, { ready: true, inForce: false, epoch: 3 }, { ready: true, inForce: true, epoch: 4 }]) {
      const correct = vi.fn(() => expected);
      expect(() => correctMemoryRequest(request, { ...state, correct })).toThrow();
      expect(correct).not.toHaveBeenCalled();
    }
  });
  it("checks complete bounded records and prevents payloads from changing source authority", () => {
    for (const sent of [null, { ...request, expected: { id: expected.id } }, { ...request, text: "x".repeat(401) },
      { ...request, text: " " }, { ...request, source: "user" }, { ...request, expected: { ...expected, revision: -1 } }]) {
      const correct = vi.fn(() => expected);
      expect(() => correctMemoryRequest(sent, { ready: true, inForce: true, epoch: 3, correct })).toThrow();
      expect(correct).not.toHaveBeenCalled();
    }
  });
});
