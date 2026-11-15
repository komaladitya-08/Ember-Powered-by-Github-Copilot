import { describe, expect, it, vi } from "vitest";
import { MixedHandoffs } from "../../app/main/agent/mixed-handoff";
import { TaskManager } from "../../app/main/agent/tasks";
import type { Logger } from "../../app/main/logger";
import type { Worker } from "../../app/main/agent/worker";
import { afterNo, handoffCanContinue } from "../../app/main/agent/worker";

describe("sequential mixed task handoff", () => {
  it("runs the next part once after success, carrying the first result only as data", () => {
    const h = new MixedHandoffs<string>();
    const seen: string[] = [];
    expect(h.arm("one", () => true, value => seen.push(value))).toBe(true);
    expect(h.arm("one", () => true, () => { throw new Error("replaced"); })).toBe(false);
    expect(h.finish("one", "done", "built app")).toBe("started");
    expect(h.finish("one", "done", "built app")).toBe("absent");
    expect(seen).toEqual(["built app"]);
  });

  it("doesn't continue a stopped, failed or stale task, including after a late completion", () => {
    const h = new MixedHandoffs<string>();
    const seen: string[] = [];
    for (const status of ["failed", "cancelled", "queued"]) {
      h.arm(status, () => true, value => seen.push(value));
      expect(h.finish(status, status, "no")).toBe("skipped");
      expect(h.finish(status, "done", "late")).toBe("absent");
    }
    let current = true;
    h.arm("stale", () => current, value => seen.push(value));
    current = false;
    expect(h.finish("stale", "done", "stale")).toBe("skipped");
    h.arm("stopped", () => true, value => seen.push(value));
    h.clear();
    expect(h.finish("stopped", "done", "late")).toBe("absent");
    expect(seen).toEqual([]);
  });

  it("fails closed on errors without retrying a continuation", () => {
    const h = new MixedHandoffs<string>();
    h.arm("one", () => { throw new Error("gone"); }, () => { throw new Error("must not run"); });
    expect(h.finish("one", "done", "x")).toBe("failed");
    expect(h.finish("one", "done", "x")).toBe("absent");
  });
});

describe("the first worker retires before a mixed handoff", () => {
  function setup() {
    let release!: () => void, fail!: () => void;
    const cleanup = new Promise<void>((resolve, reject) => { release = resolve; fail = () => reject(new Error("not stopped")); });
    const handoffs = new MixedHandoffs<unknown>();
    const started: string[] = [];
    const cards: { detail?: string }[][] = [];
    const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
    const tm = new TaskManager({ log: quiet, currentWindow: () => null, setCards: c => cards.push(c), deleteSession: async () => undefined,
      makeWorker: spec => {
        started.push(spec.goal);
        return { sessionId: null, run: async () => ({ success: true, summary: "done" }), dispose: () => spec.goal === "first" ? cleanup : Promise.resolve(), handoffSafe: () => true } as unknown as Worker;
      },
      onFinished: task => { handoffs.finish(task.id, task.status, task.result); },
    });
    const first = tm.start("first", { deferHandoff: true });
    handoffs.arm(first.id, () => true, () => { tm.start("second"); });
    return { tm, first, started, cards, release, fail };
  }

  it("waits for successful disposal before it starts the next part", async () => {
    const s = setup();
    await vi.waitFor(() => expect(s.first.status).toBe("running"));
    expect(s.started).toEqual(["first"]);
    s.release();
    await vi.waitFor(() => expect(s.started).toEqual(["first", "second"]));
  });

  it("honours Stop while disposal is pending", async () => {
    const s = setup();
    await vi.waitFor(() => expect(s.first.status).toBe("running"));
    s.tm.cancel(s.first.id); s.release();
    await vi.waitFor(() => expect(s.first.status).toBe("cancelled"));
    expect(s.started).toEqual(["first"]);
  });

  it("keeps the execution slot and tells the user when stopping takes a long time", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      await Promise.resolve();
      s.tm.cancel(s.first.id);
      await vi.advanceTimersByTimeAsync(5000);
      expect(s.first.status).toBe("running");
      expect(s.cards.at(-1)?.[0].detail).toContain("Waiting to confirm");
      expect(s.started).toEqual(["first"]);
      s.release(); await vi.advanceTimersByTimeAsync(1);
      expect(s.first.status).toBe("cancelled");
    } finally { vi.useRealTimers(); }
  });

  it("reports failed cleanup as failure and never starts the next part, even if stopped", async () => {
    const s = setup();
    await vi.waitFor(() => expect(s.first.status).toBe("running"));
    s.tm.cancel(s.first.id); s.fail();
    await vi.waitFor(() => expect(s.first.status).toBe("failed"));
    expect(s.first.result?.summary).toContain("couldn't confirm");
    expect(s.started).toEqual(["first"]);
  });

  it("includes a failed handoff in the card and result before they are published", async () => {
    const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
    const cards: { detail?: string }[][] = [];
    const seen: string[] = [];
    const h = new MixedHandoffs<unknown>();
    const tm = new TaskManager({ log: quiet, currentWindow: () => null, setCards: c => cards.push(c), deleteSession: async () => undefined,
      makeWorker: () => ({ sessionId: null, run: async () => ({ success: true, summary: "First complete." }), dispose: async () => undefined, handoffSafe: () => true }) as unknown as Worker,
      beforeFinish: task => {
        if (h.finish(task.id, task.status, task.result) === "failed") task.result!.summary += " The next part didn't start.";
      },
      onFinished: task => { seen.push(task.result?.summary ?? ""); },
    });
    const first = tm.start("first", { deferHandoff: true });
    h.arm(first.id, () => true, () => { throw new Error("unavailable"); });
    await vi.waitFor(() => expect(first.status).toBe("done"));
    expect(first.result?.summary).toBe("First complete. The next part didn't start.");
    expect(cards.at(-1)?.[0].detail).toBe("First complete. The next part didn't start.");
    expect(seen).toEqual(["First complete. The next part didn't start."]);
  });

  it("does not run the next part when the first worker reports an unsafe handoff", async () => {
    const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
    const h = new MixedHandoffs<unknown>();
    const started: string[] = [];
    const tm = new TaskManager({ log: quiet, currentWindow: () => null, setCards: () => undefined, deleteSession: async () => undefined,
      makeWorker: spec => { started.push(spec.goal); return { sessionId: null, run: async () => ({ success: true, summary: "Some work done." }), dispose: async () => undefined, handoffSafe: () => false } as unknown as Worker; },
      beforeFinish: task => { h.finish(task.id, task.status, task.result); },
    });
    const first = tm.start("first", { deferHandoff: true });
    h.arm(first.id, () => true, () => { tm.start("second"); });
    await vi.waitFor(() => expect(first.status).toBe("failed"));
    expect(first.result?.summary).toContain("next part didn't start");
    expect(started).toEqual(["first"]);
  });

  it("refuses a handoff when some work succeeded but the user declined a later step", () => {
    const result = { success: true, summary: "Some work done." };
    expect(afterNo({ declined: true, expired: false, worked: true }, result)).toBeNull();
    expect(handoffCanContinue({ declined: true, expired: false, saidNo: true, undone: 1, tookOver: false, limit: false }, result)).toBe(false);
    expect(handoffCanContinue({ declined: false, expired: false, saidNo: false, undone: 0, tookOver: false, limit: false }, result)).toBe(true);
  });
});
