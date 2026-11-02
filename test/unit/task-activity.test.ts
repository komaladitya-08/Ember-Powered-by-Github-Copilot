/**
 * What a task's card shows of its activity (UI audit #2, #3 and #14): the TaskManager puts each task's activity on its
 * card, says a task whose question is up waits for the user, keeps a whole title, offers Try again on a failure, and
 * keeps finished tasks' activity for Home; the card's lines never repeat themselves; a worker that ends without
 * finish_task never shows its raw last words.
 */

import { describe, expect, it, vi } from "vitest";
import { TaskManager, titleOf } from "../../app/main/agent/tasks";
import { lastWordsSummary, type Worker, type WorkerResult } from "../../app/main/agent/worker";
import type { ActivityEvent } from "../../app/main/agent/activity";
import { cardLines } from "../../app/renderer/overlay/stack";
import { TASK_STOPPING, type TaskCard } from "../../app/shared/overlay";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

/** A manager whose workers run until `done` resolves, with each worker's activity callback kept. */
function manager(extra: Partial<ConstructorParameters<typeof TaskManager>[0]> = {}) {
  const cards: TaskCard[][] = [];
  const done = deferred<WorkerResult>();
  const tell: ((e: ActivityEvent) => void)[] = [];
  const specs: string[] = [];
  const tm = new TaskManager({
    log: quiet, currentWindow: () => null, deleteSession: async () => undefined, keepMs: 0, setCards: c => cards.push(c),
    makeWorker: (spec, _p, _u, activity) => { tell.push(activity!); specs.push(spec.goal); return { run: () => done.promise, dispose: async () => undefined, sessionId: "s" } as unknown as Worker; },
    ...extra,
  });
  return { tm, cards, done, tell, specs, last: () => cards.at(-1)!.at(-1)! };
}

describe("a running task's card", () => {
  it("carries what the task is doing in Ember's words, and its clock from when it began to run", async () => {
    const { tm, tell, last } = manager();
    const before = Date.now();
    tm.start("Turn on Night Light");
    await vi.waitFor(() => expect(tell.length).toBe(1));
    tell[0]({ type: "tool-start", id: "c1", tool: "click", step: "Clicking", app: "Settings" });
    expect(last().activity).toMatchObject({ live: "Clicking in Settings…", approvals: 0, nearLimit: false });
    expect(last().activity!.startedAt).toBeGreaterThanOrEqual(before);
  });

  it("says the task waits for the user while its question is up, and works again after (one state table)", async () => {
    const { tm, tell, last } = manager();
    tm.start("Send the report");
    await vi.waitFor(() => expect(tell.length).toBe(1));
    tell[0]({ type: "question" });
    expect(last()).toMatchObject({ status: "waiting", activity: { live: "Waiting for you" } });
    tell[0]({ type: "answer", answer: "allowed" });
    expect(last().status).toBe("running");
    expect(last().activity!.approvals).toBe(1);
  });

  it("tells “status?” what holds a running task up: the user's answer, or a Stop winding it down, and when it began to run (audit of the conversation features)", async () => {
    const { tm, tell } = manager();
    const t = tm.start("Send the report");
    expect(tm.holdUp(t.id)).toBeNull();
    await vi.waitFor(() => expect(tell.length).toBe(1));
    expect(t.ranAt).toBeGreaterThanOrEqual(t.started);
    expect(tm.holdUp(t.id)).toBeNull();
    tell[0]({ type: "question" });
    expect(tm.holdUp(t.id)).toBe("answer");
    tm.cancel(t.id);
    expect(tm.holdUp(t.id)).toBe("stopping");
  });

  it("names a change of hand in the details, but not the background it starts in", async () => {
    const { tm, tell, last } = manager({
      makeWorker: (_s, _p, update, activity) => { setTimeout(() => { update!({ hand: "background" }); update!({ hand: "cursor" }); activity!({ type: "turn" }); }, 0); return { run: () => new Promise(() => undefined), dispose: async () => undefined, sessionId: "s" } as unknown as Worker; },
    });
    tm.start("Rename the files");
    void tell;
    await vi.waitFor(() => expect(last().hand).toBe("cursor"));
    expect(last().activity!.rows.map(r => r.words)).toEqual(["Used your mouse and keyboard"]);
  });
});

describe("a failed task's card", () => {
  it("offers Try again beside Close, which starts the same request again and closes the failed card", async () => {
    const { tm, cards, done, specs } = manager();
    const t = tm.start("Open Text Editor and write a shopping list", { userWords: "write my shopping list" });
    await vi.waitFor(() => expect(specs.length).toBe(1));
    done.resolve({ success: false, summary: "I couldn't find Text Editor." });
    await vi.waitFor(() => expect(t.status).toBe("failed"));
    const card = cards.at(-1)!.find(c => c.id === t.id)!;
    expect(card.actions).toEqual([{ id: `task:${t.id}:retry`, label: "Try again" }, { id: `task:${t.id}:dismiss`, label: "Close" }]);
    expect(card.activity).toMatchObject({ live: "Didn't finish" });
    const again = tm.retry(t.id)!;
    expect(again.id).not.toBe(t.id);
    expect(again.goal).toBe(t.goal);
    expect(tm.get(t.id)).toBeUndefined();
    await vi.waitFor(() => expect(specs).toEqual([t.goal, t.goal]));
    // Only once: the failed card is gone.
    expect(tm.retry(t.id)).toBeNull();
  });

  it("offers no Try again on a stopped task or a guide", async () => {
    const stopped = manager();
    const a = stopped.tm.start("Tidy up");
    await vi.waitFor(() => expect(stopped.specs.length).toBe(1));
    stopped.done.resolve({ success: false, stopped: true, summary: "Stopped." });
    await vi.waitFor(() => expect(a.status).toBe("cancelled"));
    expect(stopped.last().actions).toEqual([{ id: `task:${a.id}:dismiss`, label: "Close" }]);
    expect(stopped.tm.retry(a.id)).toBeNull();
    const guide = manager();
    const g = guide.tm.start("Show me Night Light", { mode: "guide" });
    await vi.waitFor(() => expect(guide.specs.length).toBe(1));
    guide.done.resolve({ success: false, summary: "I couldn't find it." });
    await vi.waitFor(() => expect(g.status).toBe("failed"));
    expect(guide.last().actions).toEqual([{ id: `task:${g.id}:dismiss`, label: "Close" }]);
  });
});

describe("finished tasks' activity, for Home", () => {
  it("is kept in memory after the card goes, newest first, and only for the latest twenty", async () => {
    vi.useFakeTimers();
    try {
      const { tm, done } = manager({ cardMs: 10 });
      done.resolve({ success: true, summary: "Done." });
      const ids: string[] = [];
      for (let i = 0; i < 22; i++) { ids.push(tm.start(`Task ${i}`).id); await vi.advanceTimersByTimeAsync(50); }
      const kept = tm.activities();
      expect(kept.length).toBe(20);
      expect(kept[0]).toMatchObject({ id: ids[21], title: "Task 21", activity: { live: "Done" } });
      expect(tm.activity(ids[0])).toBeNull();
      expect(tm.activity(ids[21])?.endedAt).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a task's title", () => {
  it("keeps the whole request up to 72 characters, cut at a word, not at 40 (audit #2)", () => {
    expect(titleOf("Open Text Editor and write a shopping list")).toBe("Open Text Editor and write a shopping list");
    const long = "Open the quarterly report in LibreOffice Writer and make every heading bold, then save it";
    expect(titleOf(long)).toBe("Open the quarterly report in LibreOffice Writer and make every heading…");
    expect(titleOf(long).length).toBeLessThanOrEqual(72);
  });
});

describe("a card's lines", () => {
  const base: TaskCard = { id: "t", title: "Turn on Night Light", status: "running", detail: "Clicking…", actions: [] };
  const activity = { startedAt: 0, live: "Clicking in Settings…", approvals: 1, nearLimit: false, rows: [] };

  it("say what Ember does now, then the worker's note apart from it, never the step twice (audit #2)", () => {
    expect(cardLines({ ...base, activity: { ...activity, note: "Finding Night Light", summary: "Read the window" } })).toEqual({
      live: "Clicking in Settings…", detail: "Finding Night Light", tele: { state: null, step: null, extra: "1 approval" }, summary: "Read the window",
    });
  });

  it("say “Stopping…” in the live line from the moment Stop is pressed", () => {
    expect(cardLines({ ...base, activity }, true)).toMatchObject({ live: TASK_STOPPING, detail: "" });
    expect(cardLines({ ...base, detail: TASK_STOPPING, activity })).toMatchObject({ live: TASK_STOPPING });
  });

  it("once it ended, give the summary and the state's word, and no live line", () => {
    expect(cardLines({ ...base, status: "failed", detail: "I couldn't find Night Light.", activity: { ...activity, endedAt: 9000 } })).toEqual({
      live: null, detail: "I couldn't find Night Light.", tele: { state: "Didn't finish", step: null, extra: "1 approval" }, summary: null,
    });
  });

  it("never say the state twice: a result that is only “Stopped.” goes, and one that starts with it keeps the row quiet", () => {
    const ended = { ...activity, endedAt: 9000, approvals: 0 };
    expect(cardLines({ ...base, status: "stopped", detail: "Stopped.", activity: ended })).toMatchObject({ detail: "", tele: { state: "Stopped" } });
    expect(cardLines({ ...base, status: "stopped", detail: "Stopped before it started.", activity: ended })).toMatchObject({ detail: "Stopped before it started.", tele: { state: null } });
  });

  it("before a task runs, show what Ember said as before", () => {
    expect(cardLines({ ...base, status: "queued", detail: "Waiting to start" })).toEqual({ live: null, detail: "Waiting to start", tele: null, summary: null });
  });
});

describe("a task that ended without finish_task", () => {
  it("never shows the worker's tool-speak or Ember's own prompt as its result (audit #2)", () => {
    expect(lastWordsSummary("You said: :00 Call finish_task now with a short summary of what you did. Do nothing else.")).toBe("I stopped without finishing, and couldn't say what I'd done. You can try again.");
    expect(lastWordsSummary("I'll call perceive_window next.")).toMatch(/^I stopped without finishing/);
    expect(lastWordsSummary("")).toMatch(/^I stopped without finishing/);
    expect(lastWordsSummary("**Done.** I bolded the title.")).toBe("Done. I bolded the title.");
    expect(lastWordsSummary("I couldn't find Word Count in the Tools menu.")).toBe("I couldn't find Word Count in the Tools menu.");
  });
});
