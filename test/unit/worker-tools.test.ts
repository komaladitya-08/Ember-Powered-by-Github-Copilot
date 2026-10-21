/**
 * A worker's tools called directly (no model): one at a time, and every
 * refusal is in the audit log.
 */

import { describe, expect, it } from "vitest";
import { Worker, afterKeys, cellOf, clearLane, dismissName, guideSay, pickOption, sameFocus, usableBounds, type WorkerDeps } from "../../app/main/agent/worker";
import type { AxNode } from "../../app/main/perception/sidecar";
import { Presenter } from "../../app/main/agent/presenter";
import { PolicyEngine } from "../../app/main/policy/policy";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** The result a worker already ended with (a cancelled guide ends itself, without a finish_task). */
const resultOf = (w: Worker) => (w as unknown as { result: { success: boolean; stopped?: boolean; summary: string } | null }).result;

function makeWorker(o: {
  blocked?: boolean; busy?: boolean; role?: string; name?: string; states?: () => string[] | null; pointer?: () => { x: number; y: number; mask: number }; mode?: "guide";
  /** More of what readElement says (a menu's `open`). */
  extra?: () => Record<string, unknown>;
  canDo?: (id: number, kind: string, caret: boolean) => { tier1: boolean; why?: string; focused?: boolean; windowActive?: boolean; action?: string; handler?: { role: string; name: string }; handlerUnknown?: boolean };
  /** The user's answer to every question (default "once"), and the app's grant. */
  answer?: string; grants?: Record<string, "act">; noCursor?: boolean;
  /** The window with the keyboard on the user's screen, and whether Enter or Space is held down there (guides). */
  activeWindow?: () => { app: string; title: string; pid?: number } | null; activationKey?: () => boolean;
  /** How long a look at the element takes (an app busy opening a dialog answers slowly). */
  readMs?: number;
  /** The role of what the element sits in (a dialog's table, a drop-down's popup). */
  parentRole?: string;
  /** Text goes in by accessibility (otherwise the helper says it can't). */
  setTextOk?: boolean;
  /** Extra nodes in the window (a dialog's Cancel or Search beside the row pointed at). */
  more?: AxNode[];
  /** What readElement adds for an id (null: that element is gone). */
  live?: (id: number) => Record<string, unknown> | null | undefined;
  /** Runs as the question appears (the user's click on Allow may change the screen). */
  onAsk?: () => void;
} = {}) {
  const flown: unknown[] = [];
  const audit: Record<string, unknown>[] = [];
  const events: string[] = [];
  const asked: string[] = [];
  const guided: string[] = [];
  const window = { app: "gedit", pid: 1, name: "notes.txt", role: "frame", active: true, bounds: { x: 0, y: 0, width: 800, height: 600 }, ...(o.busy ? { busy: true } : {}) };
  const startStates = o.states?.() ?? ["enabled", "sensitive"];
  const node = { id: 1, parent: o.parentRole ? 0 : null, depth: 1, role: o.role ?? "push button", name: o.name ?? "Bold", states: startStates ?? ["enabled", "sensitive"], bounds: { x: 10, y: 10, width: 40, height: 20 } };
  const extras = o.more ?? [];
  const seen = { window, x11Window: null, nodes: [...(o.parentRole ? [{ id: 0, parent: null, depth: 0, role: o.parentRole, name: "", states: [], bounds: null }] : []), node, ...extras], blocked: !!o.blocked, ms: 0 };
  const presenter = new Presenter(() => undefined);
  const show = presenter.guide.bind(presenter);
  presenter.guide = (say, step) => { guided.push(say); show(say, step); };
  const w = new Worker({
    client: {} as never, log: quiet, model: "m", vision: false, workDir: "/tmp",
    perception: { perceive: async () => ({ ...seen, text: "[1] push button \"Bold\"", capture: null }), read: async () => seen, windows: async () => [window] } as never,
    sidecar: {
      readElement: async (id: number) => {
        if (o.readMs) await sleep(o.readMs);
        const extra = o.live?.(id);
        if (extra === null) return null;
        const base = id === node.id ? node : extras.find(n => n.id === id);
        if (!base) return extra ? extra as never : null;
        const states = o.states && id === node.id ? o.states() : base.states;
        if (states === null) return null;
        return { role: base.role, name: base.name, states, bounds: base.bounds, ...(id === node.id ? o.extra?.() : {}), ...extra };
      },
      doAction: async () => { events.push("start"); await sleep(80); events.push("end"); return { ok: true, after: { role: "push button", name: "Bold", states: [], bounds: node.bounds } }; },
      setText: async (_id: number, text: string) => {
        events.push("set_text");
        if (!o.setTextOk) throw new Error("background_unavailable: this element's text can't be edited directly");
        return { ok: true, after: { role: node.role, name: node.name, states: ["enabled", "editable"], bounds: node.bounds, text } };
      },
      ...(o.canDo ? { canDo: async (id: number, kind: string, caret: boolean) => o.canDo!(id, kind, caret) } : {}),
    } as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => o.grants ?? { gedit: "act" } }),
    confirmer: { ask: async (q: { prompt: string }) => { asked.push(q.prompt); o.onAsk?.(); return o.answer ?? "once"; } } as never,
    audit: { write: (e: Record<string, unknown>) => audit.push(e) } as never,
    settings: { get: () => ({ grants: {} }), update: () => undefined } as never,
    presenter,
    lease: async () => () => undefined, flyTo: (b: unknown) => { flown.push(b); }, onProgress: () => undefined,
    cursor: o.noCursor ? undefined : {
      borrow: { borrow: async (fn: (hand: unknown) => Promise<void>) => fn({ glideTo: async () => undefined, click: async () => undefined, keys: async () => undefined, type: async () => undefined, scroll: async () => undefined }) },
      findWindow: () => 1, setBorrowing: () => undefined, ...(o.activeWindow ? { activeWindow: o.activeWindow } : {}),
    },
    pointer: o.pointer, activationKey: o.activationKey,
  } as unknown as WorkerDeps, { id: "t1", goal: "make it bold", target: { title: "notes.txt" }, mode: o.mode });
  const tool = (name: string) => w.tools().find(t => t.name === name)!;
  const call = (name: string, args: Record<string, unknown>) => tool(name).handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
  return { w, audit, events, asked, call, flown, guided };
}

describe("worker tools", () => {
  it("run one at a time when the runtime calls several at once", async () => {
    const { call, events } = makeWorker();
    await call("perceive_window", {});
    const results = await Promise.all([call("click", { id: 1 }), call("click", { id: 1 }), call("report_progress", { text: "bolding" })]);
    expect(results.map(r => r.resultType)).toEqual(["success", "success", "success"]);
    expect(events).toEqual(["start", "end", "start", "end"]);
  });

  it("an option is chosen by its whole name (case and spacing aside), never by a part of it", () => {
    const options = ["Keep", "Delete permanently", "delete  permanently ", "Move to Trash"];
    expect(pickOption(options, "permanently")).toBeNull();
    expect(pickOption(options, "Keep")).toBe("Keep");
    expect(pickOption(options, " move to trash")).toBe("Move to Trash");
    // Two names that differ only in case or spacing: the exact one, or none.
    expect(pickOption(options, "Delete permanently")).toBe("Delete permanently");
    expect(pickOption(options, "DELETE PERMANENTLY")).toBeNull();
  });

  it("keys said yes to for a spreadsheet go to a cell of it, but a cell said yes to is that cell (review round 7)", () => {
    // A look at LibreOffice Calc may come to the cell with the keyboard or only to its sheet (also focused).
    const nodes: AxNode[] = [
      { id: 5, parent: null, depth: 7, role: "table", name: "Sheet big", states: ["focused"], bounds: null },
      { id: 6, parent: 5, depth: 8, role: "table cell", name: "C12", states: ["focused"], bounds: null, grid: true },
      { id: 7, parent: null, depth: 7, role: "table", name: "Table1", states: [], bounds: null },
      { id: 8, parent: 7, depth: 8, role: "table cell", name: "A1", states: ["focused"], bounds: null, grid: false },
    ];
    const byId = (id: number) => nodes.find(n => n.id === id);
    const sheet = { role: "table", name: "Sheet big" };
    const cell = { role: "table cell", name: "C12", ...cellOf(nodes[1], byId) };
    expect(cell).toEqual({ role: "table cell", name: "C12", grid: true, sheet: expect.any(Number) });
    expect(sameFocus(cell, sheet)).toBe(true);
    expect(sameFocus(cell, { role: "table", name: "Sheet other" })).toBe(false);
    expect(sameFocus(sheet, cell)).toBe(false);
    expect(sameFocus({ role: "table cell", name: "D5", ...cellOf(nodes[1], byId) }, cell)).toBe(false);
    // A Writer table's cell isn't a sheet's.
    expect(sameFocus({ role: "table cell", name: "A1", ...cellOf(nodes[3], byId) }, { role: "table", name: "Table1" })).toBe(false);
    expect(sameFocus(undefined, undefined)).toBe(true);
    expect(sameFocus(cell, undefined)).toBe(false);
  });

  it("a busy app's window is listed as busy, not gone", async () => {
    const { call } = makeWorker({ busy: true });
    expect((await call("list_windows", {})).textResultForLlm).toContain('- "gedit": "notes.txt" (focused by the user) (busy, not answering)');
  });

  it("a key press refused in a private window is in the audit log", async () => {
    const { call, audit } = makeWorker({ blocked: true });
    const r = await call("press_keys", { keys: "Return" });
    expect(r.resultType).toBe("denied");
    expect(audit).toContainEqual(expect.objectContaining({ event: "decision", kind: "keys", verdict: "deny", tier: "never", value: "Return" }));
  });
});

describe("guides (review round 5)", () => {
  it("hovering the menu item pointed at isn't a click: the step waits for the press", async () => {
    // GTK selects (and focuses) a menu item under the pointer; the user presses it 800 ms later.
    let t0 = 0;
    const later = () => t0 > 0 && Date.now() - t0 > 800;
    const { call } = makeWorker({ role: "menu item", name: "Save", states: () => (t0 > 0 ? ["enabled", "sensitive", "selected", "focused"] : ["enabled", "sensitive"]),
      pointer: () => ({ x: 20, y: 15, mask: later() ? 256 : 0 }), mode: "guide" });
    await call("perceive_window", {});
    await call("point_at", { id: 1, say: "Click Save" });
    const waiting = call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { t0 = Date.now(); }, 100);
    const r = await waiting;
    expect(r.textResultForLlm).toMatch(/^The user clicked it/);
    expect(Date.now() - t0).toBeGreaterThan(700);
  });

  it("a menu item that goes (its menu closed) or gets checked has changed; a button that only gets focus hasn't (PR7-2)", async () => {
    let gone = false;
    const menu = makeWorker({ role: "menu item", name: "Save", states: () => (gone ? null : ["enabled", "sensitive"]), pointer: () => ({ x: 0, y: 0, mask: 0 }), mode: "guide" });
    await menu.call("perceive_window", {});
    const waiting = menu.call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { gone = true; }, 100);
    expect((await waiting).textResultForLlm).toMatch(/The window changed/);
    let checked = false;
    const check = makeWorker({ role: "check menu item", name: "Word Wrap", states: () => (checked ? ["enabled", "checked"] : ["enabled"]), pointer: () => ({ x: 0, y: 0, mask: 0 }), mode: "guide" });
    await check.call("perceive_window", {});
    const toggled = check.call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { checked = true; }, 100);
    expect((await toggled).textResultForLlm).toMatch(/^It changed/);
    let focused = false;
    const button = makeWorker({ states: () => (focused ? ["enabled", "focused"] : ["enabled"]), pointer: () => ({ x: 0, y: 0, mask: 0 }), mode: "guide" });
    await button.call("perceive_window", {});
    const tabbed = button.call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { focused = true; }, 100);
    expect((await tabbed).textResultForLlm).toMatch(/hasn't clicked it yet/);
  }, 8000);

  it("a keyboard user's step counts: Enter on the button pointed at, or a menu item chosen that opens its dialog (PR7-2)", async () => {
    // Tab onto "Add", then Enter.
    let focused = false, enter = false;
    const button = makeWorker({ name: "Add", states: () => (focused ? ["enabled", "focused"] : ["enabled"]), pointer: () => ({ x: 0, y: 0, mask: 0 }),
      activationKey: () => enter, mode: "guide" });
    await button.call("perceive_window", {});
    const t0 = Date.now();
    const waiting = button.call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { enter = true; }, 100); // Enter elsewhere first: not on it
    setTimeout(() => { enter = false; focused = true; }, 300);
    setTimeout(() => { enter = true; }, 1200);
    expect((await waiting).textResultForLlm).toMatch(/^The user pressed Enter or Space on it/);
    expect(Date.now() - t0).toBeGreaterThan(1100);
    // F10, arrows to "Save As…" (selected), Enter: the menu closes and the Save As dialog takes the keyboard.
    let selected = false, dialog = false;
    const menu = makeWorker({ role: "menu item", name: "Save As…", states: () => (selected ? ["enabled", "selected"] : ["enabled"]), pointer: () => ({ x: 0, y: 0, mask: 0 }),
      activeWindow: () => (dialog ? { app: "gedit", title: "Save As" } : { app: "gedit", title: "notes.txt" }), mode: "guide" });
    await menu.call("perceive_window", {});
    const saved = menu.call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { selected = true; }, 100);
    setTimeout(() => { selected = false; dialog = true; }, 900);
    expect((await saved).textResultForLlm).toMatch(/^Another window has the keyboard now \("Save As"\)/);
    // Another window without the element ever reached (the user went elsewhere): the step waits.
    let switched = false;
    const away = makeWorker({ role: "menu item", name: "Save As…", states: () => ["enabled"], pointer: () => ({ x: 0, y: 0, mask: 0 }),
      activeWindow: () => (switched ? { app: "firefox", title: "News" } : { app: "gedit", title: "notes.txt" }), mode: "guide" });
    await away.call("perceive_window", {});
    const left = away.call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { switched = true; }, 100);
    expect((await left).textResultForLlm).toMatch(/hasn't clicked it yet/);
  }, 12_000);

  it("only a step's own reaching counts: a dialog's default button that had the keyboard, or Ember's own window, ends nothing (HND8-5)", async () => {
    // "OK" has the keyboard from the start; the user goes to another window: they didn't choose it.
    let away = false;
    const ok = makeWorker({ name: "OK", states: () => ["enabled", "focused"], pointer: () => ({ x: 0, y: 0, mask: 0 }),
      activeWindow: () => (away ? { app: "firefox", title: "News", pid: 9 } : { app: "gedit", title: "Confirm", pid: 2 }), mode: "guide" });
    await ok.call("perceive_window", {});
    const waiting = ok.call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { away = true; }, 700);
    expect((await waiting).textResultForLlm).toMatch(/hasn't clicked it yet/);
    // Tabbed onto "Cancel", then the user opens Ember's ask box (Ember's own window): the step waits; then the
    // window they were in gives the keyboard to another one of theirs: chosen with the keyboard.
    let focused = false, own = false, other = false;
    const cancel = makeWorker({ name: "Cancel", states: () => (focused ? ["enabled", "focused"] : ["enabled"]), pointer: () => ({ x: 0, y: 0, mask: 0 }),
      activeWindow: () => (other ? { app: "gedit", title: "Saved", pid: 2 } : own ? { app: "ember", title: "Ask Ember", pid: process.pid } : { app: "gedit", title: "Confirm", pid: 2 }), mode: "guide" });
    await cancel.call("perceive_window", {});
    const t0 = Date.now();
    const step = cancel.call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { focused = true; }, 100);
    setTimeout(() => { own = true; }, 900);
    setTimeout(() => { own = false; other = true; }, 2200);
    expect((await step).textResultForLlm).toMatch(/^Another window has the keyboard now \("Saved"\)/);
    expect(Date.now() - t0).toBeGreaterThan(2100);
  }, 15_000);
});

describe("guides in the live test: Mousepad's View ▸ Select Font… opened its dialog, and the step stayed", () => {
  const still = { x: 0, y: 0, mask: 0 };

  it("a menu item whose menu closed (GTK keeps it, no longer showing) ends the step, and its highlight goes", async () => {
    let closed = false;
    const { call, flown } = makeWorker({ role: "menu item", name: "Select Font…", states: () => ["enabled", "sensitive"], extra: () => (closed ? { offscreen: true } : {}),
      pointer: () => still, mode: "guide" });
    await call("perceive_window", {});
    await call("point_at", { id: 1, say: "Choose Select Font" });
    const waiting = call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { closed = true; }, 100);
    expect((await waiting).textResultForLlm).toMatch(/^Its menu closed/);
    expect(flown.at(-1)).toBeNull();
  });

  it("a new window of the same app taking the keyboard ends a menu item's step, though the item was never seen selected", async () => {
    let dialog = false;
    const { call } = makeWorker({ role: "menu item", name: "Select Font…", states: () => ["enabled", "sensitive"], pointer: () => still,
      activeWindow: () => (dialog ? { app: "mousepad", title: "Choose Mousepad Font", pid: 7 } : { app: "mousepad", title: "Untitled 1 - Mousepad", pid: 7 }), mode: "guide" });
    await call("perceive_window", {});
    const waiting = call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { dialog = true; }, 100);
    expect((await waiting).textResultForLlm).toMatch(/^A new window of the app has the keyboard now \("Choose Mousepad Font"\)/);
    // Another app's window is no such sign: the step waits.
    let other = false;
    const away = makeWorker({ role: "menu item", name: "Select Font…", states: () => ["enabled", "sensitive"], pointer: () => still,
      activeWindow: () => (other ? { app: "firefox", title: "News", pid: 9 } : { app: "mousepad", title: "Untitled 1 - Mousepad", pid: 7 }), mode: "guide" });
    await away.call("perceive_window", {});
    const left = away.call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { other = true; }, 100);
    expect((await left).textResultForLlm).toMatch(/hasn't clicked it yet/);
  }, 12_000);

  it("a quick click while a look at the app is under way still counts", async () => {
    let t0 = 0;
    // Down for 60 ms, while every look at the app takes 400 ms.
    const pointer = () => ({ x: 20, y: 15, mask: t0 && Date.now() - t0 > 600 && Date.now() - t0 < 660 ? 256 : 0 });
    const { call } = makeWorker({ role: "menu item", name: "Select Font…", states: () => ["enabled", "sensitive"], pointer, readMs: 400, mode: "guide" });
    await call("perceive_window", {});
    t0 = Date.now();
    expect((await call("wait_for_click", { id: 1, timeoutSeconds: 5 })).textResultForLlm).toMatch(/^The user clicked it/);
  }, 8000);
});

describe("guides in a dialog's list (live retest: Monospace Bold in the font chooser)", () => {
  it("a row that becomes selected ends the step, however it was chosen", async () => {
    let chosen = false;
    const { call, flown } = makeWorker({ role: "table cell", name: "Monospace Bold", parentRole: "table", states: () => (chosen ? ["enabled", "selected"] : ["enabled"]),
      pointer: () => ({ x: 0, y: 0, mask: 0 }), mode: "guide" });
    await call("perceive_window", {});
    await call("point_at", { id: 1, say: "Select a font style" });
    const waiting = call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { chosen = true; }, 100);
    expect((await waiting).textResultForLlm).toMatch(/^It changed: table cell "Monospace Bold"/);
    expect(flown.at(-1)).toBeNull();
  });

  it("in a drop-down's popup, a row selected by the pointer passing over it isn't the step", async () => {
    let hovered = false;
    const { call } = makeWorker({ role: "list item", name: "Dark", parentRole: "menu", states: () => (hovered ? ["enabled", "selected"] : ["enabled"]), pointer: () => ({ x: 0, y: 0, mask: 0 }), mode: "guide" });
    await call("perceive_window", {});
    const waiting = call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { hovered = true; }, 100);
    expect((await waiting).textResultForLlm).toMatch(/hasn't clicked it yet/);
  }, 8000);
});

describe("guides through menus with the keyboard (review round 6)", () => {
  it("a menu opened with Alt+F or F10 (its items show) counts; hovering it, which selects it, doesn't", async () => {
    let hovered = false, open = false;
    const { call } = makeWorker({ role: "menu", name: "File", states: () => (hovered || open ? ["enabled", "selected", "focused"] : ["enabled"]),
      extra: () => ({ open }), pointer: () => ({ x: 0, y: 0, mask: 0 }), mode: "guide" });
    await call("perceive_window", {});
    await call("point_at", { id: 1, say: "Open the File menu" });
    const t0 = Date.now();
    const waiting = call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { hovered = true; }, 100);
    setTimeout(() => { open = true; }, 1300);
    const r = await waiting;
    expect(r.textResultForLlm).toMatch(/^It changed: menu .*File.*\(open\)/);
    expect(Date.now() - t0).toBeGreaterThan(1200);
  });

  it("a menu that stays closed while hovered: the step waits for the user", async () => {
    const { call } = makeWorker({ role: "menu", name: "File", states: () => ["enabled", "selected"], extra: () => ({ open: false }), pointer: () => ({ x: 0, y: 0, mask: 0 }), mode: "guide" });
    await call("perceive_window", {});
    const r = await call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    expect(r.textResultForLlm).toMatch(/hasn't clicked it yet/);
  }, 8000);
});

describe("a click goes to the control that handles it (SEC7-1)", () => {
  it("text inside a link is asked about as the link it works; a risky text inside a harmless row as itself", async () => {
    const link = makeWorker({ role: "static", name: "Settings", answer: "deny", canDo: () => ({ tier1: true, action: "clickancestor", handler: { role: "link", name: "Delete my account" } }) });
    await link.call("perceive_window", {});
    expect((await link.call("click", { id: 1 })).resultType).toBe("denied");
    expect(link.asked).toEqual([expect.stringMatching(/^Click “Delete my account” link .*You didn't ask for this/)]);
    expect(link.audit).toContainEqual(expect.objectContaining({ event: "decision", kind: "click", element: { role: "link", name: "Delete my account" } }));
    // An unnamed clickable box round "Block user": named by the text, and asked about.
    const box = makeWorker({ role: "static", name: "Block user", answer: "deny", canDo: () => ({ tier1: true, action: "clickancestor", handler: { role: "section", name: "" } }) });
    await box.call("perceive_window", {});
    await box.call("click", { id: 1 });
    expect(box.asked).toEqual([expect.stringMatching(/^Click “Block user” section/)]);
    // A row named harmlessly round a risky word: the word is what is asked about.
    const row = makeWorker({ role: "static", name: "Remove", answer: "deny", canDo: () => ({ tier1: true, action: "clickancestor", handler: { role: "list item", name: "Ana Silva" } }) });
    await row.call("perceive_window", {});
    await row.call("click", { id: 1 });
    expect(row.asked).toEqual([expect.stringMatching(/^Click “Remove” static/)]);
    // Nothing risky either way: the app's grant covers it, and the journal names the link.
    const plain = makeWorker({ role: "static", name: "Docs", canDo: () => ({ tier1: true, action: "clickancestor", handler: { role: "link", name: "Help" } }) });
    await plain.call("perceive_window", {});
    expect((await plain.call("click", { id: 1 })).textResultForLlm).toMatch(/^Done/);
    expect([plain.asked, plain.audit.filter(e => e.event === "action").map(e => e.element)]).toEqual([[], [{ role: "link", name: "Help" }]]);
  });
});

describe("a click handed further than Ember can see (SEC8-5)", () => {
  it("text whose click the page hands to a control too deep to find is refused, never judged by its own words", async () => {
    const { call, asked, events, audit } = makeWorker({ role: "static", name: "Learn about it", canDo: () => ({ tier1: true, action: "clickancestor", handlerUnknown: true }) });
    await call("perceive_window", {});
    const r = await call("click", { id: 1 });
    expect(r.resultType).toBe("failure");
    expect(r.textResultForLlm).toMatch(/can't tell what a click on element 1 works: .* too deep for Ember to find, so nothing was clicked/);
    expect([asked, events]).toEqual([[], []]);
    expect(audit).toContainEqual(expect.objectContaining({ event: "action", kind: "click", ok: false }));
  });
});

describe("one question per step (review round 6)", () => {
  it("where only the mouse can do it, only the question to borrow it is asked", async () => {
    const { call, asked, events } = makeWorker({ role: "check box", name: "Urgent", grants: {}, answer: "deny", canDo: () => ({ tier1: false, why: "no 'toggle' action (has: showcontextmenu)" }) });
    await call("perceive_window", {});
    const r = await call("toggle", { id: 1, on: true });
    expect(asked).toEqual([expect.stringMatching(/^Borrow your mouse to click “Urgent” check box/)]);
    expect(r.resultType).toBe("denied");
    expect(events).toEqual([]);
  });

  it("where accessibility can do it, the question about acting in the app is asked, and nothing about the mouse", async () => {
    const { call, asked, events } = makeWorker({ grants: {}, canDo: () => ({ tier1: true }) });
    await call("perceive_window", {});
    expect((await call("click", { id: 1 })).resultType).toBe("success");
    expect(asked).toEqual([expect.stringMatching(/^Let me work in .*First step: click “Bold” push button/)]);
    expect(events).toEqual(["start", "end"]);
  });

  it("where neither can, it says so without asking", async () => {
    const { call, asked, audit } = makeWorker({ noCursor: true, grants: {}, canDo: () => ({ tier1: false, why: "no 'click' action (has: none)" }) });
    await call("perceive_window", {});
    const r = await call("click", { id: 1 });
    expect(asked).toEqual([]);
    expect(r.textResultForLlm).toMatch(/can't do this by accessibility .*no 'click' action/);
    expect(audit).toContainEqual(expect.objectContaining({ event: "action", kind: "click", ok: false }));
  });

  it("text typed at the caret: refused before asking where the field hasn't the keyboard in the window the user is in; asked to borrow otherwise", async () => {
    const field = (windowActive: boolean) => makeWorker({ role: "paragraph", name: "Body", states: () => ["enabled", "sensitive", "editable"], grants: {}, answer: "deny",
      canDo: (_id, kind, caret) => ({ tier1: kind !== "text", ...(caret ? { focused: false, windowActive } : {}) }) });
    const active = field(true);
    await active.call("perceive_window", {});
    const r = await active.call("type_text", { id: 1, text: "Hello", mode: "insert" });
    expect(active.asked).toEqual([]);
    expect(r.textResultForLlm).toMatch(/can't put the caret in the right place/);
    // Behind another window, the caret may come back once the window is in front: asked (only) to borrow.
    const behind = field(false);
    await behind.call("perceive_window", {});
    await behind.call("type_text", { id: 1, text: "Hello", mode: "insert" });
    expect(behind.asked).toEqual([expect.stringMatching(/^Borrow your mouse and keyboard to type “Hello” into “Body” paragraph/)]);
    expect(behind.events).toEqual([]);
  });
});

describe("a menu's approval survives the click that closed it (live: Thunar File > Create Document)", () => {
  it("Allow keeps its yes for reopening the menu and clicking the same item, so it isn't asked again", async () => {
    // The user's click on Allow lands outside the open menu: GTK closes it, so the approved click has to be made again.
    let closed = false;
    const { call, asked, audit } = makeWorker({
      role: "menu item", name: "Create Document", parentRole: "menu",
      canDo: () => ({ tier1: false, why: "the menu item needs the mouse" }),
      onAsk: () => { closed = true; },
      live: () => (closed ? null : undefined),
    });
    await call("perceive_window", {});
    const first = await call("click", { id: 1 });
    expect(first.textResultForLlm).toMatch(/closed when you answered .*reopen its menu and click it again, without asking/);
    expect(asked).toHaveLength(1);
    closed = false;
    const retry = await call("click", { id: 1 });
    expect(retry.resultType).toBe("success");
    expect(asked).toHaveLength(1);
    expect(audit).toContainEqual(expect.objectContaining({ event: "decision", verdict: "allow", reason: expect.stringMatching(/already allowed this menu item/) }));
  });
});

describe("where the wheel goes (review round 4)", () => {
  const list = { x: 0, y: 0, width: 400, height: 300 };
  it("the widest lane across the list that no wheel-changed control touches, inside the window", () => {
    // Rows with a label column (0–150) and a combo box or spin button filling the rest.
    expect(clearLane(list, [{ x: 156, y: 40, width: 244, height: 30 }, { x: 156, y: 900, width: 244, height: 30 }], true, list)).toBe(78);
    // Sideways, a row no control spans.
    expect(clearLane(list, [{ x: 0, y: 0, width: 400, height: 100 }], false, list)).toBe(200);
    // The window cuts the list: only its visible part counts.
    expect(clearLane(list, [{ x: 0, y: 0, width: 200, height: 20 }], true, { x: 0, y: 0, width: 300, height: 300 })).toBe(250);
  });
  it("none when controls cover every column", () => {
    expect(clearLane(list, [{ x: 0, y: 40, width: 220, height: 30 }, { x: 200, y: 400, width: 200, height: 30 }], true, list)).toBeNull();
  });
});

describe("what the keys select (review round 7)", () => {
  /** Keys pressed in turn into one field: what is selected after each, and what was typed there. */
  const press = (keys: string[], typed = "") => keys.reduce<{ typed: string; selected: "all" | "some" | null; after: (string | null)[] }>((s, k) => {
    const next = afterKeys(k, s.typed, s.selected);
    return { typed: next.typed, selected: next.selected, after: [...s.after, next.selected] };
  }, { typed, selected: null, after: [] });

  it("Ctrl+A selects everything, Shift with a key that moves selects some, until a key moves the caret or replaces it (SEC7-2)", () => {
    expect(press(["ctrl+a", "ctrl+c", "Escape", "ctrl+b", "Left"]).after).toEqual(["all", "all", "all", "all", null]);
    expect(press(["ctrl+Home", "ctrl+shift+End", "shift+Left", "period"]).after).toEqual([null, "some", "some", null]);
    // Ctrl+A then Shift keeps it all selected (Shift+Left gives back one character).
    expect(press(["ctrl+a", "shift+Left"]).after).toEqual(["all", "all"]);
    // Keys that delete the selection: Backspace, Delete, Ctrl+Backspace, Ctrl+X, a paste.
    for (const k of ["BackSpace", "Delete", "ctrl+BackSpace", "ctrl+x", "ctrl+v", "Tab", "Return"]) expect(press(["ctrl+a", k]).after[1], k).toBeNull();
  });

  it("what was typed there goes with everything selected and replaced, but stays when only part of it was", () => {
    expect(press(["ctrl+a", "x"], "448").typed).toBe("x");
    expect(press(["ctrl+a", "BackSpace"], "448").typed).toBe("");
    expect(press(["shift+Left", "x"], "448").typed).toBe("448x");
    expect(press(["Left", "8", "1"], "44").typed).toBe("4481");
  });
});

describe("what Ember did on its desk (review round 8, PR8-3)", () => {
  it("an action done by accessibility on Ember's desk is audited as the desk's (tier 2); one on the user's screen isn't", async () => {
    const { w, call, audit } = makeWorker();
    await call("perceive_window", {});
    expect((await call("click", { id: 1 })).resultType).toBe("success");
    const actions = () => audit.filter(e => e.event === "action");
    expect(actions().at(-1)).toMatchObject({ kind: "click", ok: true });
    expect(actions().at(-1)).not.toHaveProperty("tier");
    // On the desk: the same helper calls, through the desk's own sidecar.
    const d = (w as unknown as { d: WorkerDeps }).d;
    (w as unknown as { place: unknown }).place = { perception: d.perception, sidecar: d.sidecar, userInControl: () => false, dead: false, onDead() {} };
    expect((await call("click", { id: 1 })).resultType).toBe("success");
    expect(actions().at(-1)).toMatchObject({ kind: "click", ok: true, tier: 2 });
  });
});

describe("windows where the app's suggestion isn't the user's (live retest: a restored session saved as ~/shopping-list.txt)", () => {
  it("an offer to restore a session, or a Save dialog for a file the user never named, comes with a note", async () => {
    const { dialogNote } = await import("../../app/main/agent/worker");
    expect(dialogNote({ name: "Question", role: "dialog" }, [{ name: "Do you want to restore your previous session?" }], "make this text all uppercase")).toMatch(/answer No/);
    expect(dialogNote({ name: "Question", role: "dialog" }, [{ name: "Do you want to restore your previous session?" }], "restore my last session")).toBe("");
    expect(dialogNote({ name: "Save As", role: "file chooser" }, [{ name: "Name", text: "shopping-list.txt" }], "make this text all uppercase")).toMatch(/named no file/);
    expect(dialogNote({ name: "Save As", role: "file chooser" }, [], "save it as ~/Ember/list.txt")).toBe("");
    expect(dialogNote({ name: "notes.txt - Mousepad", role: "frame" }, [{ name: "File" }], "")).toBe("");
  });
});

describe("an Allow covers that step only, never typing or keys (live retest: a yes to Ctrl+End let Ember type and save)", () => {
  it("after the user allowed a click in the app, another click is covered and typing from that Allow is too", async () => {
    const { call, asked, events } = makeWorker({ role: "text", name: "Doc", grants: {}, setTextOk: true, states: () => ["enabled", "sensitive", "editable", "focused"] });
    await call("perceive_window", {});
    await call("click", { id: 1 });
    expect(asked).toHaveLength(1);
    await call("click", { id: 1 });
    expect(asked).toHaveLength(1);
    await call("type_text", { id: 1, text: "APPLES", mode: "append" });
    expect(asked).toHaveLength(1);
    expect(events).toContain("set_text");
  });

  it("after the user allowed Ctrl+End (movement), typing is asked about again", async () => {
    const { call, asked } = makeWorker({ role: "text", name: "Doc", grants: {}, setTextOk: true, states: () => ["enabled", "sensitive", "editable", "focused"] });
    await call("perceive_window", {});
    // The keys are asked about; the fake hand can't press them (no borrow), which is fine: the Allow is what we need.
    await call("press_keys", { keys: "ctrl+End" }).catch(() => undefined);
    expect(asked[0]).toMatch(/End/);
    const afterMove = asked.length;
    await call("type_text", { id: 1, text: "APPLES", mode: "append" });
    expect(asked.length).toBeGreaterThan(afterMove);
    expect(asked.at(-1)).toMatch(/APPLES/);
  });
});

describe("guide words and highlights (live retest: font chooser)", () => {
  it("names the row, never “the table cell”", () => {
    expect(guideSay("press Enter on the table cell", { role: "table cell", name: "Monospace Bold" })).toBe("press Enter on Monospace Bold");
    expect(guideSay("Click Display", { role: "push button", name: "Display" })).toBe("Click Display");
    expect(dismissName("_Cancel")).toBe(true);
    expect(dismissName("Select Font…")).toBe(false);
    expect(usableBounds({ x: 10, y: 10, width: 0, height: 12 })).toBeNull();
    expect(usableBounds({ x: 10, y: 10, width: 40, height: 20 })).toEqual({ x: 10, y: 10, width: 40, height: 20 });
  });

  it("point_at rewrites a vague instruction and does not highlight a different row", async () => {
    const { call, guided, flown } = makeWorker({
      role: "table cell", name: "Monospace Bold", parentRole: "table", mode: "guide",
      live: () => ({ role: "table cell", name: "Liberation Mono", bounds: { x: 10, y: 80, width: 120, height: 18 } }),
    });
    await call("perceive_window", {});
    await call("point_at", { id: 1, say: "press Enter on the table cell" });
    expect(guided.at(-1)).toBe("press Enter on Monospace Bold");
    // Live read of this id is now another font: the box stays on the named row's last place, not that other row.
    expect(flown.at(-1)).toEqual({ x: 10, y: 10, width: 40, height: 20 });
    expect(flown.at(-1)).not.toEqual({ x: 10, y: 80, width: 120, height: 18 });
  });

  it("typing in an already-focused search box ends the step", async () => {
    let typed = "";
    const { call } = makeWorker({
      role: "text", name: "Search", mode: "guide",
      states: () => ["enabled", "focused", "editable"],
      extra: () => ({ text: typed }),
      pointer: () => ({ x: 0, y: 0, mask: 0 }),
    });
    await call("perceive_window", {});
    const waiting = call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { typed = "mono"; }, 100);
    expect((await waiting).textResultForLlm).toMatch(/^It changed/);
  });

  it("a click on Cancel, or the dialog closing, is a cancelled step, never a successful finish", async () => {
    const cancel = { id: 2, parent: 0, depth: 1, role: "push button", name: "Cancel", states: ["enabled"], bounds: { x: 200, y: 400, width: 80, height: 24 } };
    let down = false;
    const click = makeWorker({
      role: "table cell", name: "Monospace Bold", parentRole: "table", mode: "guide", more: [cancel],
      pointer: () => ({ x: 220, y: 410, mask: down ? 256 : 0 }),
    });
    await click.call("perceive_window", {});
    const waiting = click.call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { down = true; }, 100);
    expect((await waiting).textResultForLlm).toMatch(/pressed .Cancel/);
    // It ends at once as a calm stop: no model turn to say "Switching windows" first, and no failure framing.
    expect(resultOf(click.w)).toEqual({ success: false, stopped: true, summary: "The guide was cancelled." });
    const again = await click.call("finish_task", { success: true, summary: "You picked a font." });
    expect(again.textResultForLlm).toMatch(/already finished/);

    let gone = false;
    const away = makeWorker({
      role: "table cell", name: "Monospace Bold", parentRole: "table", mode: "guide",
      live: () => (gone ? null : {}),
      pointer: () => ({ x: 0, y: 0, mask: 0 }),
    });
    await away.call("perceive_window", {});
    const left = away.call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { gone = true; }, 100);
    expect((await left).textResultForLlm).toMatch(/closed without this being used/);
    expect(resultOf(away.w)).toEqual({ success: false, stopped: true, summary: "The guide was cancelled." });
  });

  it("a click on the search box, while Ember pointed at a row, says so", async () => {
    const search = { id: 3, parent: 0, depth: 1, role: "text", name: "Search", states: ["enabled"], bounds: { x: 200, y: 200, width: 200, height: 24 } };
    let down = false;
    const { call } = makeWorker({
      role: "table cell", name: "Monospace Bold", parentRole: "table", mode: "guide", more: [search],
      pointer: () => ({ x: 220, y: 210, mask: down ? 256 : 0 }),
    });
    await call("perceive_window", {});
    const waiting = call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { down = true; }, 100);
    expect((await waiting).textResultForLlm).toMatch(/search box/);
  });

  it("a finished click leaves no highlight (live retest: empty orange box after a save)", async () => {
    const { call, flown } = makeWorker();
    await call("perceive_window", {});
    await call("click", { id: 1 });
    expect(flown.at(-1)).toBeNull();
    expect(flown.some(b => b && typeof b === "object" && "width" in b)).toBe(true);
  });

  it("Cancel in a dialog whose Size field AT-SPI still reports ends the step and clears the highlight", async () => {
    let title = "Font";
    const { w, call, flown } = makeWorker({
      role: "spin button", name: "Size", parentRole: "dialog", mode: "guide",
      live: () => ({ bounds: { x: 80, y: 120, width: 48, height: 22 } }),
      pointer: () => ({ x: 0, y: 0, mask: 0 }),
      activeWindow: () => ({ app: "mousepad", title, pid: 1 }),
    });
    await call("perceive_window", {});
    const waiting = call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { title = "notes.txt - Mousepad"; }, 80);
    expect((await waiting).textResultForLlm).toMatch(/cancelled|closed this step/i);
    expect(flown.at(-1)).toBeNull();
    expect(resultOf(w)).toEqual({ success: false, stopped: true, summary: "The guide was cancelled." });
  });

  it("a field whose box collapses to nothing loses its highlight", async () => {
    let box = { x: 80, y: 120, width: 48, height: 22 };
    const { call, flown } = makeWorker({
      role: "spin button", name: "Size", parentRole: "dialog", mode: "guide",
      live: () => ({ bounds: box }),
      pointer: () => ({ x: 0, y: 0, mask: 0 }),
    });
    await call("perceive_window", {});
    const waiting = call("wait_for_click", { id: 1, timeoutSeconds: 5 });
    setTimeout(() => { box = { x: 80, y: 120, width: 0, height: 0 }; }, 80);
    expect((await waiting).textResultForLlm).toMatch(/disappeared|cancelled/i);
    expect(flown.at(-1)).toBeNull();
  });
});
