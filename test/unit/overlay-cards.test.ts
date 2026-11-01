/**
 * The task cards over other apps: what a card says about its task (a task in line is not one that needs you), and
 * what the main process tells the cards (review #130); what the handle says while tasks run (review #131); a Stop
 * that says at once that it landed (review #132); a finished card's words kept to a card's size (review #134); cards
 * that slide to their new place in the stack instead of jumping (review #133).
 */

import { describe, expect, it } from "vitest";
import { TaskManager } from "../../app/main/agent/tasks";
import { STATE_WORD, busyLine, idleLine, slides, stackOrder, stopPending, underWay } from "../../app/renderer/overlay/stack";
import { cardTask } from "../../app/renderer/handle/card";
import type { Worker, WorkerResult } from "../../app/main/agent/worker";
import { TASK_STOPPING, type TaskCard } from "../../app/shared/overlay";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

/** A manager whose workers run until their `done` resolves, recording every set of cards it shows. */
function manager(extra: Partial<ConstructorParameters<typeof TaskManager>[0]> = {}) {
  const cards: TaskCard[][] = [];
  const done = deferred<WorkerResult>();
  const progress: ((text: string) => void)[] = [];
  const tm = new TaskManager({
    log: quiet, currentWindow: () => null, deleteSession: async () => undefined, keepMs: 0, setCards: c => cards.push(c),
    makeWorker: (_spec, p) => { progress.push(p); return { run: () => done.promise, dispose: async () => undefined, sessionId: "s" } as unknown as Worker; },
    ...extra,
  });
  return { tm, cards, done, progress };
}

describe("a task waiting its turn", () => {
  it("shows as queued, not as needing the user, and keeps its Stop", () => {
    const { tm, cards } = manager({ maxRunning: 1 });
    tm.start("Tidy the desktop");
    const second = tm.start("Rename the photos");
    const card = cards.at(-1)!.find(c => c.id === second.id)!;
    expect(card).toMatchObject({ status: "queued", detail: "Waiting to start", actions: [{ id: `task:${second.id}:stop`, label: "Stop" }] });
  });

  it("is read out as waiting its turn; only a task that asks is read as needing the user", () => {
    expect(STATE_WORD.queued).toBe("Waiting its turn: ");
    expect(STATE_WORD.waiting).toBe("Needs you: ");
  });

  it("counts as under way: its card sits with the running ones, nearest the handle, and the corner card shows it", () => {
    const card = (id: string, status: TaskCard["status"]): TaskCard => ({ id, title: id, status, detail: "", actions: [] });
    expect(underWay(card("q", "queued"))).toBe(true);
    expect(stackOrder([card("q", "queued"), card("d", "done"), card("r", "running")]).map(t => t.id)).toEqual(["d", "q", "r"]);
    expect(cardTask([card("d", "done"), card("q", "queued")])?.id).toBe("q");
  });
});

describe("the handle's line while tasks run", () => {
  const card = (id: string, status: TaskCard["status"]): TaskCard => ({ id, title: id, status, detail: "" });

  it("says how many tasks Ember is working on, counting those in line", () => {
    expect(busyLine([card("a", "running")])).toBe("Working on 1 task…");
    expect(busyLine([card("a", "running"), card("b", "queued"), card("c", "done")])).toBe("Working on 2 tasks…");
  });

  it("says nothing of tasks when none is under way (the handle says Ready or why not)", () => {
    expect(busyLine([])).toBeNull();
    expect(busyLine([card("a", "done"), card("b", "failed"), card("c", "stopped")])).toBeNull();
  });

  it("takes the place of Ready only: a word that says why Ember can't answer stays while tasks run", () => {
    const one = [card("a", "running")];
    // While tasks are at work Ember can't answer the user (it waits for them, then reconnects): that word says so.
    expect(idleLine("Waiting for tasks", one)).toBe("Waiting for tasks");
    expect(idleLine("Reconnecting…", one)).toBe("Reconnecting…");
    expect(idleLine("Copilot problem", [card("a", "running"), card("b", "queued")])).toBe("Copilot problem");
    expect(idleLine("Ready", one)).toBe("Working on 1 task…");
    expect(idleLine(undefined, [card("a", "running"), card("b", "queued")])).toBe("Working on 2 tasks…");
  });

  it("says Ready, or why not, when no task is under way", () => {
    expect(idleLine("Ready", [card("a", "done")])).toBe("Ready");
    expect(idleLine("Waiting for tasks", [])).toBe("Waiting for tasks");
    expect(idleLine(undefined, [])).toBeNull();
  });
});

describe("pressing Stop on a running task", () => {
  it("says Stopping… at once, while the task winds down, and then how it ended", async () => {
    const { tm, cards, done, progress } = manager();
    const t = tm.start("Tidy the desktop");
    await Promise.resolve();
    expect(cards.at(-1)![0]).toMatchObject({ status: "running", detail: "Working…" });
    tm.cancel(t.id);
    expect(cards.at(-1)![0]).toMatchObject({ status: "running", detail: TASK_STOPPING });
    expect(TASK_STOPPING).toBe("Stopping…");
    // The worker reports a step on its way out: the card keeps saying it is stopping.
    progress[0]("Closing the Files window");
    expect(cards.at(-1)![0]).toMatchObject({ status: "running", detail: TASK_STOPPING });
    done.resolve({ success: false, summary: "Stopped.", stopped: true });
    await expect.poll(() => cards.at(-1)![0].status).toBe("stopped");
    expect(cards.at(-1)![0].detail).toBe("Stopped.");
  });

  it("on the card, shows stopping until Ember says so, or for a few seconds if the press did not land", () => {
    expect(stopPending(1000, 1500, "Working…")).toBe(true);
    expect(stopPending(1000, 4500, "Working…")).toBe(false);
    expect(stopPending(1000, 60_000, TASK_STOPPING)).toBe(true);
  });
});

describe("a finished task's card", () => {
  it("keeps its words to a card's size; the whole summary still goes to the conversation", async () => {
    const { tm, cards, done } = manager();
    const t = tm.start("Summarise the report");
    const summary = "The report says ".concat("a great deal, ".repeat(150)).trim();
    done.resolve({ success: true, summary });
    await expect.poll(() => cards.at(-1)![0].status).toBe("done");
    const detail = cards.at(-1)![0].detail;
    expect(detail.length).toBeLessThanOrEqual(400);
    expect(detail.endsWith("…")).toBe(true);
    expect(summary.startsWith(detail.slice(0, -1))).toBe(true);
    expect(tm.get(t.id)!.result!.summary).toBe(summary);
  });

  it("keeps a short summary as it is", async () => {
    const { tm, cards, done } = manager();
    tm.start("Turn on Night Light");
    done.resolve({ success: true, summary: "Night Light is on." });
    await expect.poll(() => cards.at(-1)![0].detail).toBe("Night Light is on.");
  });
});

describe("cards that move in the stack", () => {
  it("slide from where they were: each by how far it moved; a new card, or one that barely moved, doesn't", () => {
    const before = new Map([["done", 600], ["run", 420], ["still", 300]]);
    // "done" ended and went to the top; "run" moved down into its place; "still" stayed; "new" appeared.
    const after = new Map([["done", 300.4], ["run", 600], ["still", 300.5], ["new", 700]]);
    expect([...slides(before, after)]).toEqual([["done", 299.6], ["run", -180]]);
  });
});
