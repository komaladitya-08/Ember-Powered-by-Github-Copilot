/** TaskManager: guides beside running tasks (review #142). */

import { describe, expect, it, vi } from "vitest";
import { TaskManager } from "../../app/main/agent/tasks";
import type { Worker, WorkerResult } from "../../app/main/agent/worker";
import type { TaskCard } from "../../app/shared/overlay";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const never = () => ({ run: () => new Promise<WorkerResult>(() => undefined), steer: async () => false, dispose: async () => undefined, sessionId: null }) as unknown as Worker;

function manager(extra: Partial<ConstructorParameters<typeof TaskManager>[0]> = {}) {
  const cards: TaskCard[][] = [];
  const tm = new TaskManager({ log: quiet, makeWorker: never, currentWindow: () => null, setCards: c => cards.push(c), deleteSession: async () => undefined, keepMs: 0, ...extra });
  return { tm, cards };
}

describe("a guide beside running tasks (review #142)", () => {
  it("starts at once while two tasks act: it only points and waits for the user's clicks", async () => {
    const { tm } = manager();
    const a = tm.start("tidy the desktop"), b = tm.start("rename the photos");
    const guide = tm.start("show me how to turn on Night Light", { mode: "guide" });
    expect([a, b].map(t => tm.get(t.id)!.status)).toEqual(["running", "running"]);
    expect(tm.get(guide.id)!.status).toBe("running");
    // A third task that acts still waits its turn.
    const c = tm.start("empty the bin");
    expect(tm.get(c.id)!.status).toBe("queued");
  });

  it("runs one guide at a time: a second waits for the first, and tasks don't wait for guides", async () => {
    const results: ((r: WorkerResult) => void)[] = [];
    const { tm } = manager({ makeWorker: () => ({ run: () => new Promise<WorkerResult>(r => results.push(r)), steer: async () => false, dispose: async () => undefined, sessionId: null }) as unknown as Worker });
    const g1 = tm.start("show me the clock settings", { mode: "guide" });
    const g2 = tm.start("show me the sound settings", { mode: "guide" });
    const t = tm.start("tidy the desktop");
    expect([g1, g2, t].map(x => tm.get(x.id)!.status)).toEqual(["running", "queued", "running"]);
    results[0]({ success: true, summary: "Shown." });
    await vi.waitFor(() => expect(tm.get(g2.id)!.status).toBe("running"));
  });
});

describe("a worker that can't be made (review #145)", () => {
  it("fails the task with a plain sentence instead of leaving it waiting for ever, and what queued behind it starts", async () => {
    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => { rejections.push(r); };
    process.on("unhandledRejection", onRejection);
    try {
      let n = 0;
      const { tm, cards } = manager({ maxRunning: 1, makeWorker: () => { if (n++ === 0) throw new Error("boom"); return never(); } });
      const a = tm.start("tidy the desktop");
      const b = tm.start("rename the photos");
      await vi.waitFor(() => expect(tm.get(a.id)!.status).toBe("failed"));
      expect(tm.get(a.id)!.result?.summary).toBe("Ember couldn't start this task. Try again; if it keeps happening, restart Ember.");
      expect(cards.at(-1)?.find(c => c.id === a.id)?.actions).toEqual([{ id: `task:${a.id}:dismiss`, label: "Close" }]);
      await vi.waitFor(() => expect(tm.get(b.id)!.status).toBe("running"));
      await new Promise(r => setTimeout(r, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
