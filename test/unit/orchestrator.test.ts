/**
 * Ember's two bodies (docs/DESIGN.md "Two bodies"): a task that works in the background shows its work, its plan and
 * its result on its card in the corner, never in the bubble beside the cursor, until it uses the user's mouse and
 * keyboard; and what a task shows on its card comes only from the fixed, checked catalog of app/shared/view.ts.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PlanSchema, ViewSchema } from "../../app/main/agent/view-schema";
import { BubbleOwner, Presenter } from "../../app/main/agent/presenter";
import { TaskManager } from "../../app/main/agent/tasks";
import type { Worker, WorkerResult } from "../../app/main/agent/worker";
import type { Logger } from "../../app/main/logger";
import type { EmberState, TaskCard } from "../../app/shared/overlay";
import { HAND_WORDS, PLAN_WORD, planSteps, upgradeView, viewText, type PlanStep, type TaskHand, type ViewDoc } from "../../app/shared/view";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

describe("the view catalog", () => {
  it("takes the blocks a card can draw", () => {
    const view = [
      { kind: "text", text: "Three invoices are overdue." },
      { kind: "list", items: ["Acme, 12 days", "Globex, 5 days"], ordered: true },
      { kind: "facts", rows: [{ label: "Total", value: "£4,210" }] },
      { kind: "table", columns: ["Client", "Days"], rows: [["Acme", "12"], ["Globex", "5"]] },
      { kind: "file", path: "/home/me/overdue.csv", label: "Saved" },
    ];
    expect(ViewSchema.parse(view)).toEqual(view);
  });

  it.each([
    ["markup or code", [{ kind: "html", html: "<b>hi</b>" }]],
    ["a button", [{ kind: "button", label: "Pay now" }]],
    ["a table wider than a card", [{ kind: "table", columns: ["a", "b", "c", "d"], rows: [["1", "2", "3", "4"]] }]],
    ["a row that doesn't match its columns", [{ kind: "table", columns: ["a", "b"], rows: [["1"]] }]],
    ["more blocks than a card holds", Array.from({ length: 7 }, () => ({ kind: "text", text: "x" }))],
    ["an empty view", []],
  ])("refuses %s", (_why, view) => {
    expect(ViewSchema.safeParse(view).success).toBe(false);
  });

  it("converts to the JSON Schema the Copilot runtime is given for finish_task and report_progress", () => {
    // The SDK sends a zod schema to the runtime through its toJSONSchema() (@github/copilot-sdk schema.js).
    const finish = z.object({ success: z.boolean(), summary: z.string().max(400), view: ViewSchema.optional() }).toJSONSchema() as unknown as { properties: { view: { type: string; maxItems: number; items: { oneOf?: unknown[]; anyOf?: unknown[] } } } };
    expect(finish.properties.view).toMatchObject({ type: "array", maxItems: 6 });
    expect((finish.properties.view.items.oneOf ?? finish.properties.view.items.anyOf)?.length).toBe(10);
    expect(z.object({ text: z.string(), plan: PlanSchema.optional() }).toJSONSchema()).toMatchObject({ properties: { plan: { type: "array", maxItems: 8 } } });
  });

    it("says a view in words, for the conversation and the next turn", () => {
    expect(viewText([
      { kind: "text", text: "Found two." },
      { kind: "list", items: ["Acme", "Globex"], ordered: true },
      { kind: "facts", rows: [{ label: "Total", value: "£4,210" }] },
      { kind: "table", columns: ["Client", "Days"], rows: [["Acme", "12"]] },
      { kind: "file", path: "/tmp/a.csv", label: "Saved" },
    ])).toBe("Found two.\n1. Acme\n2. Globex\nTotal: £4,210\nClient | Days\nAcme | 12\nSaved: /tmp/a.csv");
  });

  it("marks a plan's steps before, at and after the one under way", () => {
    expect(planSteps(["Open the sheet", "Find overdue rows", "Save a copy"], 1).map(s => s.state)).toEqual(["done", "now", "todo"]);
    expect(planSteps(["a", "b"], 2).map(s => s.state)).toEqual(["done", "done"]);
    expect(PlanSchema.safeParse(Array.from({ length: 9 }, () => "step")).success).toBe(false);
    expect(PLAN_WORD.now).toBe("Now: ");
    expect(HAND_WORDS.cursor).toBe("Using your mouse and keyboard");
  });
});

describe("a task's card", () => {
  function setup(run: (update: (u: { plan?: PlanStep[]; hand?: TaskHand; view?: ViewDoc }) => void) => Promise<WorkerResult>) {
    const cards: TaskCard[][] = [];
    const views: [string, ViewDoc | null][] = [];
    const tm = new TaskManager({
      log: quiet, currentWindow: () => null, setCards: c => cards.push(c), deleteSession: async () => undefined, keepMs: 0,
      onView: (id, v) => views.push([id, v]),
      cardMs: 15_000, failureCardMs: 60_000,
      makeWorker: (_spec, _progress, update) => ({ run: () => run(update!), dispose: async () => undefined, sessionId: "s" }) as unknown as Worker,
    });
    return { tm, cards, views };
  }

  it("says how a task works and shows its plan while it works", async () => {
    let finish!: (r: WorkerResult) => void;
    const { tm, cards, views } = setup(update => new Promise(resolve => {
      finish = resolve;
      update({ plan: planSteps(["Open the sheet", "Find overdue rows"], 0) });
      update({ hand: "cursor" });
    }));
    const t = tm.start("Find the overdue invoices");
    await vi.waitFor(() => expect(cards.at(-1)?.[0].hand).toBe("cursor"));
    expect(cards.at(-1)?.[0].plan?.map(p => p.state)).toEqual(["now", "todo"]);
    finish({ success: true, summary: "Two are overdue.", view: upgradeView([{ kind: "list", items: ["Acme", "Globex"] }]) });
    await vi.waitFor(() => expect(tm.get(t.id)?.status).toBe("done"));
    const done = cards.at(-1)![0];
    expect(done.hand).toBeUndefined();
    expect(done.plan?.every(p => p.state === "done")).toBe(true);
    // The view goes apart from the cards (main's ViewHub); the card says which rev it shows.
    expect(done.viewRev).toBe(1);
    expect(views.at(-1)?.[1] && viewText(views.at(-1)![1]!)).toBe("- Acme\n- Globex");
  });

  it("starts a task that does the work in the background", async () => {
    const { tm, cards } = setup(() => new Promise(() => undefined));
    tm.start("Tidy my downloads");
    await vi.waitFor(() => expect(cards.at(-1)?.[0]).toMatchObject({ status: "running", hand: "background" }));
  });

  it("keeps a card with a result on screen as long as a failure, so it can be read", async () => {
    vi.useFakeTimers();
    try {
      const { tm, cards, views } = setup(async () => ({ success: true, summary: "Done.", view: upgradeView([{ kind: "text", text: "Three files moved." }]) }));
      const t = tm.start("Move the files");
      await vi.waitFor(() => expect(cards.at(-1)?.[0]?.status).toBe("done"));
      vi.advanceTimersByTime(20_000);
      expect(cards.at(-1)).toHaveLength(1);
      vi.advanceTimersByTime(41_000);
      expect(cards.at(-1)).toEqual([]);
      // Its view goes with its card.
      expect(views.at(-1)).toEqual([t.id, null]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the bubble beside the cursor", () => {
  function presenter(corner: boolean) {
    const pushed: Partial<EmberState>[] = [];
    const p = new Presenter(s => pushed.push(s), undefined, () => "Move the files", new BubbleOwner(), undefined, false, { task: "t1", corner });
    return { p, bubbles: () => pushed.filter(s => s.bubble).map(s => s.bubble!) };
  }

  it("never shows a background task's work or result: its card does", () => {
    const { p, bubbles } = presenter(true);
    p.progress("Moving three files…");
    p.outcome({ title: "Move the files", text: "Three files moved.", emotion: "happy", gesture: "thumbsUp", mood: "done" });
    expect(bubbles()).toEqual([]);
  });

  it("shows a task's work while it uses the user's mouse and keyboard, and lets go of it after", () => {
    const { p, bubbles } = presenter(true);
    p.foreground = true;
    p.progress("Clicking Save (your mouse)…");
    expect(bubbles().at(-1)).toMatchObject({ visible: true, mood: "acting", thought: "Clicking Save (your mouse)…" });
    p.foreground = false;
    expect(bubbles().at(-1)?.visible).toBe(false);
    p.progress("Checking the folder…");
    expect(bubbles()).toHaveLength(2);
  });

  it("still shows a task's work where cornering wasn't asked for (a guide)", () => {
    const { p, bubbles } = presenter(false);
    p.progress("Finding the button…");
    expect(bubbles().at(-1)).toMatchObject({ visible: true, thought: "Finding the button…" });
  });
});

describe("a task's live view", () => {
  it("shows on its card while it works, one rev on at the end, and finish_task's view takes its place", async () => {
    let finish!: (r: WorkerResult) => void;
    let update!: (u: { view?: ViewDoc }) => void;
    const cards: TaskCard[][] = [];
    const views: [string, ViewDoc | null][] = [];
    const tm = new TaskManager({
      log: quiet, currentWindow: () => null, setCards: c => cards.push(c), deleteSession: async () => undefined, keepMs: 0,
      onView: (id, v) => views.push([id, v]),
      makeWorker: (_spec, _progress, u) => { update = u!; return { run: () => new Promise<WorkerResult>(r => { finish = r; }), dispose: async () => undefined, sessionId: "s" } as unknown as Worker; },
    });
    const t = tm.start("Count the overdue invoices");
    await vi.waitFor(() => expect(update).toBeDefined());
    update({ view: { ...upgradeView([{ kind: "text", text: "Checked 3 of 12" }]), rev: 4 } });
    await vi.waitFor(() => expect(cards.at(-1)?.[0].viewRev).toBe(4));
    expect(cards.at(-1)?.[0].status).toBe("running");
    finish({ success: true, summary: "Two are overdue.", view: upgradeView([{ kind: "text", text: "Two overdue" }]) });
    await vi.waitFor(() => expect(tm.get(t.id)?.status).toBe("done"));
    expect(cards.at(-1)?.[0].viewRev).toBe(5);
    expect(viewText(views.at(-1)![1]!)).toBe("Two overdue");
  });

  it("stays as the result when finish_task gives none", async () => {
    let update!: (u: { view?: ViewDoc }) => void;
    let finish!: (r: WorkerResult) => void;
    const views: [string, ViewDoc | null][] = [];
    const tm = new TaskManager({
      log: quiet, currentWindow: () => null, setCards: () => undefined, deleteSession: async () => undefined, keepMs: 0, onView: (id, v) => views.push([id, v]),
      makeWorker: (_spec, _progress, u) => { update = u!; return { run: () => new Promise<WorkerResult>(r => { finish = r; }), dispose: async () => undefined, sessionId: "s" } as unknown as Worker; },
    });
    const t = tm.start("Tally it");
    await vi.waitFor(() => expect(update).toBeDefined());
    update({ view: upgradeView([{ kind: "text", text: "12 rows" }]) });
    finish({ success: true, summary: "Done." });
    await vi.waitFor(() => expect(tm.get(t.id)?.status).toBe("done"));
    expect(tm.get(t.id)?.view && viewText(tm.get(t.id)!.view!)).toBe("12 rows");
  });

  it("reaches Home's Task activity too, live while the task works", async () => {
    let update!: (u: { view?: ViewDoc }) => void;
    const tm = new TaskManager({
      log: quiet, currentWindow: () => null, setCards: () => undefined, deleteSession: async () => undefined, keepMs: 0,
      makeWorker: (_spec, _progress, u) => { update = u!; return { run: () => new Promise<WorkerResult>(() => undefined), dispose: async () => undefined, sessionId: "s" } as unknown as Worker; },
    });
    const t = tm.start("Tally it");
    await vi.waitFor(() => expect(update).toBeDefined());
    update({ view: upgradeView([{ kind: "text", text: "12 rows so far" }]) });
    const entry = tm.activities().find(e => e.id === t.id)!;
    expect(entry.status).toBe("running");
    expect(entry.view && viewText(entry.view)).toBe("12 rows so far");
  });

  it("isn't sent once its manager has closed, from a worker still winding down (review S6)", async () => {
    let update!: (u: { view?: ViewDoc }) => void;
    const views: [string, ViewDoc | null][] = [];
    const tm = new TaskManager({
      log: quiet, currentWindow: () => null, setCards: () => undefined, deleteSession: async () => undefined, keepMs: 0, onView: (id, v) => views.push([id, v]),
      makeWorker: (_spec, _progress, u) => { update = u!; return { run: () => new Promise<WorkerResult>(() => undefined), dispose: async () => undefined, sessionId: "s" } as unknown as Worker; },
    });
    tm.start("Tally it");
    await vi.waitFor(() => expect(update).toBeDefined());
    tm.close();
    update({ view: upgradeView([{ kind: "text", text: "late" }]) });
    expect(views).toEqual([]);
  });
});
