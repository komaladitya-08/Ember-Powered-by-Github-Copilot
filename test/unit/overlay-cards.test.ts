/**
 * The task cards over other apps: what a card says about its task (a task in line is not one that needs you), and
 * what the main process tells the cards (review #130); what the handle says while tasks run (review #131).
 */

import { describe, expect, it } from "vitest";
import { TaskManager } from "../../app/main/agent/tasks";
import { STATE_WORD, busyLine, stackOrder, underWay } from "../../app/renderer/overlay/stack";
import { cardTask } from "../../app/renderer/handle/card";
import type { Worker, WorkerResult } from "../../app/main/agent/worker";
import type { TaskCard } from "../../app/shared/overlay";
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
});
