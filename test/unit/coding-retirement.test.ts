import { describe, expect, it, vi } from "vitest";
import { CodingRetirement } from "../../app/main/agent/coding-retirement";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("coding runtime retirement", () => {
  it("blocks immediately when retirement begins and releases only after all runtimes confirm disposal", async () => {
    const r = new CodingRetirement(), a = deferred<boolean>(), b = deferred<boolean>();
    r.track(a.promise); r.track(b.promise);
    expect(r.blocked).toBe(false);
    const waiting = r.wait(1000);
    expect(r.blocked).toBe(true);
    a.resolve(true);
    await Promise.resolve();
    expect(r.blocked).toBe(true);
    b.resolve(true);
    expect(await waiting).toBe(true);
    expect(r.blocked).toBe(false);
  });

  it("keeps a timed-out runtime blocked until it eventually confirms disposal", async () => {
    vi.useFakeTimers();
    try {
      const r = new CodingRetirement(), d = deferred<boolean>();
      r.track(d.promise);
      const waiting = r.wait(25);
      await vi.advanceTimersByTimeAsync(25);
      expect(await waiting).toBe(false);
      expect(r.blocked).toBe(true);
      d.resolve(true);
      await vi.waitFor(() => expect(r.blocked).toBe(false));
    } finally { vi.useRealTimers(); }
  });

  it("never forgets failed or rejected cleanup just because the worker is no longer live", async () => {
    for (const make of [() => Promise.resolve(false), () => Promise.reject(new Error("could not stop"))]) {
      const r = new CodingRetirement();
      r.track(make());
      expect(await r.wait(1000)).toBe(false);
      expect(r.blocked).toBe(true);
      expect(await r.wait(1000)).toBe(false);
    }
  });
});
