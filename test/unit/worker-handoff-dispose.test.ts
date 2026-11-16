import { describe, expect, it, vi } from "vitest";
import { Worker, type WorkerDeps } from "../../app/main/agent/worker";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

function make(mixed: boolean, disconnect: () => Promise<void>, toolTurn = Promise.resolve()) {
  const worker = new Worker({} as WorkerDeps, { id: "test", goal: "Open the app", target: {}, ...(mixed ? { deferHandoff: true } : {}) });
  const internals = worker as unknown as { session: { disconnect(): Promise<void> }; toolTurn: Promise<void> };
  internals.session = { disconnect };
  internals.toolTurn = toolTurn;
  return worker;
}

describe("retiring a desktop worker before mixed handoff", () => {
  it("waits for both the session and its queued tool calls", async () => {
    const disconnected = deferred(), tool = deferred();
    const w = make(true, () => disconnected.promise, tool.promise);
    expect(w.cleanupComplete()).toBe(false);
    let finished = false;
    const closing = w.dispose().then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    disconnected.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false); expect(w.cleanupComplete()).toBe(false);
    tool.resolve(); await closing;
    expect(finished).toBe(true); expect(w.cleanupComplete()).toBe(true);
  });

  it("fails on a rejected disconnect rather than authorizing handoff", async () => {
    const strong = make(true, async () => { throw new Error("disconnect failed"); });
    await expect(strong.dispose()).rejects.toThrow("disconnected"); expect(strong.cleanupComplete()).toBe(false);
    // Ordinary tasks preserve their existing best-effort cleanup behavior.
    const ordinary = make(false, async () => { throw new Error("disconnect failed"); });
    await expect(ordinary.dispose()).resolves.toBeUndefined(); expect(ordinary.cleanupComplete()).toBe(false);
  });

  it("does not certify ordinary cleanup even after disconnect succeeds while a tool remains queued", async () => {
    const tool = deferred(), ordinary = make(false, async () => undefined, tool.promise);
    await ordinary.dispose(); expect(ordinary.cleanupComplete()).toBe(false); tool.resolve();
  });

  it("preserves an ordinary hung disconnect's existing timeout without certifying cleanup", async () => {
    vi.useFakeTimers();
    try {
      const ordinary = make(false, () => new Promise(() => undefined)), closing = ordinary.dispose();
      await vi.advanceTimersByTimeAsync(3000); await expect(closing).resolves.toBeUndefined(); expect(ordinary.cleanupComplete()).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("fails when disconnect or the remaining tool queue times out", async () => {
    vi.useFakeTimers();
    try {
      const hungSession = make(true, () => new Promise(() => undefined));
      const waitingSession = hungSession.dispose().then(() => "ok", err => String(err));
      await vi.advanceTimersByTimeAsync(3000);
      expect(await waitingSession).toContain("disconnected");
      const hungTool = make(true, async () => undefined, new Promise(() => undefined));
      const waitingTool = hungTool.dispose().then(() => "ok", err => String(err));
      await vi.advanceTimersByTimeAsync(3000);
      expect(await waitingTool).toContain("tools stopped");
    } finally { vi.useRealTimers(); }
  });
});
