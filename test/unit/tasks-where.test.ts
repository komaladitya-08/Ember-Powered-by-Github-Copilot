/**
 * Where a task acts, as the user sees it (§2.4): the TaskManager keeps a task's target for its life and puts "on
 * build-01" / "in Ubuntu (WSL)" on its card (nothing for this computer, so today's cards are unchanged); a task's
 * bubbles carry the same badge; an announced command shows with its Stop and gives the bubble back after it; leases
 * are keyed as the worker hands them (another computer's windows never block this screen's).
 */

import { describe, expect, it, vi } from "vitest";
import { TaskManager, type WorkerLike } from "../../app/main/agent/tasks";
import { Presenter } from "../../app/main/agent/presenter";
import { ANNOUNCE_MS } from "../../app/main/commands/flow";
import { SHORTCUTS } from "../../app/shared/shortcuts";
import type { TaskSpec, WorkerResult } from "../../app/main/agent/worker";
import type { EmberState, TaskCard } from "../../app/shared/overlay";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

function setup(run: (spec: TaskSpec) => Promise<WorkerResult> = async () => ({ success: true, summary: "Done." })) {
  const cards: TaskCard[][] = [];
  const specs: TaskSpec[] = [];
  const audit: Record<string, unknown>[] = [];
  const tm = new TaskManager({
    log: quiet, currentWindow: () => ({ title: "notes.txt", pid: 7 }), setCards: c => cards.push(c), deleteSession: async () => undefined,
    audit: { write: (e: Record<string, unknown>) => audit.push(e) } as never, keepMs: 0,
    makeWorker: spec => { specs.push(spec); return { run: () => run(spec), steer: async () => false, dispose: async () => undefined, sessionId: null } satisfies WorkerLike; },
  });
  return { tm, cards, specs, audit };
}

describe("a task's target and its card (§2.4)", () => {
  it("keeps the target for the task's life and badges its card", async () => {
    const { tm, cards, specs, audit } = setup();
    const t = tm.start("check the disk", { targetId: "ssh:build-01", where: "on build-01", target: {}, userWords: "on build-01, check the disk" });
    expect(t).toMatchObject({ targetId: "ssh:build-01", where: "on build-01" });
    await vi.waitFor(() => expect(tm.get(t.id)?.status).toBe("done"));
    expect(specs[0]).toMatchObject({ targetId: "ssh:build-01", target: {} });
    expect(cards[0][0]).toMatchObject({ title: "check the disk", where: "on build-01" });
    expect(cards.at(-1)![0]).toMatchObject({ status: "done", where: "on build-01" });
    expect(audit[0]).toMatchObject({ event: "task", phase: "asked", target: "ssh:build-01" });
  });

  it("a WSL task says where too", () => {
    const { tm, cards } = setup(() => new Promise(() => undefined));
    tm.start("open gedit", { targetId: "wsl:Ubuntu", where: "in Ubuntu (WSL)" });
    expect(cards.at(-1)![0].where).toBe("in Ubuntu (WSL)");
  });

  it("a task on this computer, or with no target, has today's card, spec and audit entry", async () => {
    const { tm, cards, specs, audit } = setup();
    const a = tm.start("tidy up");
    const b = tm.start("tidy up again", { targetId: "local" });
    await vi.waitFor(() => expect([a, b].map(t => tm.get(t.id)?.status)).toEqual(["done", "done"]));
    for (const c of cards.flat()) expect(c).not.toHaveProperty("where");
    expect(specs[0]).not.toHaveProperty("targetId");
    expect(specs[0].target).toEqual({ title: "notes.txt", pid: 7 });
    expect(specs[1].targetId).toBe("local");
    for (const e of audit.filter(x => x.phase === "asked")) expect(e).not.toHaveProperty("target");
  });

  it("a task its target refused ends at once with why, as a failure on its card", async () => {
    const { tm, cards } = setup(async () => ({ success: false, summary: "build-01 isn't connected. Connect it from Ember's menu first." }));
    const t = tm.start("check the disk", { targetId: "ssh:build-01", where: "on build-01", target: {} });
    await vi.waitFor(() => expect(tm.get(t.id)?.status).toBe("failed"));
    expect(cards.at(-1)![0]).toMatchObject({ status: "failed", detail: "build-01 isn't connected. Connect it from Ember's menu first.", where: "on build-01" });
  });
});

describe("leases by the keys the worker hands over (§2.6)", () => {
  it("another computer's window never waits for this screen's window of the same name", async () => {
    const { tm } = setup();
    const here = await tm.lease("notes.txt", "a");
    let got = false;
    const remote = tm.lease("ssh:build-01|notes.txt", "b").then(r => { got = true; return r; });
    await vi.waitFor(() => expect(got).toBe(true));
    // The same key (a WSL task shares this screen: identity) waits its turn.
    let wsl = false;
    const same = tm.lease("notes.txt", "c").then(r => { wsl = true; return r; });
    await new Promise(r => setTimeout(r, 10));
    expect(wsl).toBe(false);
    here();
    await same;
    expect(wsl).toBe(true);
    (await remote)();
  });
});

describe("a task's bubbles say where it acts", () => {
  const presenter = (where?: string) => {
    const shown: Partial<EmberState>[] = [];
    const p = new Presenter(patch => shown.push(patch), undefined, () => "Check the disk", undefined, undefined, false, { task: "t1", ...(where ? { where } : {}) });
    return { p, shown };
  };

  it("every bubble of a task on another computer carries its badge", () => {
    const { p, shown } = presenter("on build-01");
    p.taskStarted();
    p.progress("Reading the disk usage");
    p.outcome({ title: "Check the disk", text: "There is 40 GB free.", emotion: "proud", gesture: "thumbsUp", mood: "done" });
    const bubbles = shown.filter(s => s.bubble).map(s => s.bubble!);
    expect(bubbles.length).toBeGreaterThan(1);
    for (const b of bubbles) expect(b).toMatchObject({ task: "t1", where: "on build-01" });
  });

  it("a task on this computer has no badge", () => {
    const { p, shown } = presenter();
    p.taskStarted();
    for (const s of shown.filter(x => x.bubble)) expect(s.bubble).not.toHaveProperty("where");
  });

  it("an announcement shows with Stop, says where and when, and is spoken; then the task's bubble comes back", () => {
    const spoken: string[] = [];
    const shown: Partial<EmberState>[] = [];
    const p = new Presenter(patch => shown.push(patch), undefined, () => "Publish the branch", undefined, undefined, false,
      { task: "t1", where: "on build-01", onAnnounce: t => spoken.push(t) });
    p.taskStarted();
    p.announce("Pushing feature-x to origin, as you asked.", "ui:cmdstop:0123456789abcdef");
    expect(shown.at(-1)!.bubble).toMatchObject({
      visible: true, title: "Pushing feature-x to origin, as you asked", thought: `On build-01. It starts in ${ANNOUNCE_MS / 1000} seconds. Ctrl+Alt+X stops everything at once.`,
      actions: [{ id: "ui:cmdstop:0123456789abcdef", label: "Stop" }], where: "on build-01", task: "t1",
    });
    expect(spoken).toEqual(["Pushing feature-x to origin, as you asked."]);
    p.endAnnouncement("ui:cmdstop:0123456789abcdef");
    expect(shown.at(-1)!.bubble).toMatchObject({ title: "Publish the branch", actions: [], where: "on build-01" });
    // Ending another announcement changes nothing.
    const n = shown.length;
    p.endAnnouncement("ui:cmdstop:ffffffffffffffff");
    expect(shown).toHaveLength(n);
  });

  it("an announcement on this computer says so", () => {
    const shown: Partial<EmberState>[] = [];
    const p = new Presenter(patch => shown.push(patch), undefined, () => "x", undefined, undefined, false, { task: "t2" });
    p.announce("Deleting build, as you asked.", "ui:cmdstop:1");
    expect(shown.at(-1)!.bubble!.thought).toBe("On this computer. It starts in 4 seconds. Ctrl+Alt+X stops everything at once.");
  });

  it("an announcement says the time it is given and the PC's own stop chord (review #46)", () => {
    const shown: Partial<EmberState>[] = [];
    const p = new Presenter(patch => shown.push(patch), undefined, () => "x", undefined, undefined, false, { task: "t3", shortcuts: SHORTCUTS.win32 });
    p.announce("Deleting build, as you asked.", "ui:cmdstop:2", 15_000);
    expect(shown.at(-1)!.bubble!.thought).toBe("On this computer. It starts in 15 seconds. Win+Alt+X stops everything at once.");
  });
});
