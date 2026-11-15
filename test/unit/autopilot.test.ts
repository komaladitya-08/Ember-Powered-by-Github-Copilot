/**
 * Autopilot for app steps (owner decision of 2026-11-12; PLAN.md §2 "Approvals", §10 "Settled" (3), (4)): it never asks
 * about a step in an app. Every question becomes an announced step, a risky one included, recorded with the mode; a
 * task that was steered, went off-task or where the user said no stays announced; the step the user refused is never
 * tried again; and every refusal stays a refusal. Ordinary typing into password, card and secret fields and sign-in
 * windows is refused here as in every mode; the vault's fill has its own tests (vault-fill-policy, vault-fill-worker).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AUTOPILOT_REASON, AUTOPILOT_WORDS, PolicyEngine, type ActionRequest, type Decision, type PolicyInputs } from "../../app/main/policy/policy";
import { ALL_SCOPES, approvalInputs, autopilotPermitted } from "../../app/main/policy/autonomy";
import { Worker, type TaskSpec, type WorkerDeps } from "../../app/main/agent/worker";
import type { CommandFlowContext } from "../../app/main/commands/flow";
import { Presenter } from "../../app/main/agent/presenter";
import { describeEntry } from "../../app/renderer/home/copy";
import type { AxNode } from "../../app/main/perception/sidecar";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

/** An engine as main wires it for a mode: Interactive's inputs, with Autopilot on top unless `o` says otherwise. */
const engine = (o: Partial<PolicyInputs> = {}) => new PolicyEngine({ neverLook: () => ["KeePassXC"], grants: () => ({}), autonomy: () => ({ ...ALL_SCOPES }), trustAskedApps: () => true, autopilot: () => true, ...o });
const interactive = (o: Partial<PolicyInputs> = {}) => engine({ autopilot: () => false, ...o });

const IN = { taskId: "t1", app: "gedit", window: "notes.txt", goal: "tidy the notes" };
/** Steps that ask in Interactive, each for another reason. */
const ASKS: Record<string, ActionRequest> = {
  "a risky control nobody asked for": { ...IN, kind: "click", element: { role: "push button", name: "Delete" } },
  "a risky control the user asked for": { ...IN, goal: "send the report", app: "thunderbird", window: "Write: Q3", kind: "click", element: { role: "push button", name: "Send" } },
  "a destructive key": { ...IN, kind: "keys", value: "Delete", element: { role: "text", name: "" } },
  "OK in a dialog about something hard to undo": { ...IN, kind: "click", element: { role: "push button", name: "OK" }, dialog: { name: "Confirm", text: "Delete 500 files?" } },
  "a system setting": { ...IN, app: "gnome-control-center", window: "Settings", kind: "toggle", value: "off", element: { role: "check box", name: "Automatic Screen Lock" } },
  "a security setting": { ...IN, app: "soffice", window: "Options", kind: "toggle", value: "off", element: { role: "check box", name: "Block any links from documents not among the trusted locations" }, dialog: { name: "Options - Security", text: "" } },
};
/** Steps Ember refuses in every mode (CLAUDE.md "Never"). */
const NEVER: Record<string, ActionRequest> = {
  "a password field": { ...IN, kind: "text", value: "hunter2", element: { role: "password text", name: "Password" } },
  "a secret or payment field": { ...IN, kind: "text", value: "4111 1111 1111 1111", element: { role: "entry", name: "Card number", secret: true } },
  "the user's terminal": { ...IN, app: "gnome-terminal-server", window: "Terminal", kind: "text", value: "ls", element: { role: "terminal", name: "" } },
  "a never-look window": { ...IN, app: "keepassxc", window: "Passwords - KeePassXC", kind: "click", element: { role: "push button", name: "Copy" } },
  "Ember's own window": { ...IN, app: "ember", window: "Ember", kind: "click", element: { role: "push button", name: "Allow" } },
  "a system authentication prompt": { ...IN, app: "polkit-gnome-authentication-agent-1", window: "Authentication Required", kind: "click", element: { role: "push button", name: "Authenticate" } },
  "a desktop-level key": { ...IN, kind: "keys", value: "super", element: { role: "text", name: "" } },
  "Ember's own stop shortcut": { ...IN, kind: "keys", value: "ctrl+alt+x", element: { role: "text", name: "" } },
  "making a file executable": { ...IN, app: "nautilus", window: "Properties", kind: "toggle", value: "on", element: { role: "check box", name: "Allow executing file as program" } },
};

describe("a question about a step, in Autopilot (modes-D1)", () => {
  it.each(Object.entries(ASKS))("goes ahead announced instead of asking: %s", (_what, r) => {
    const asked = interactive().decide(r);
    expect(asked.verdict).toBe("confirm");
    const d = engine().decide(r);
    expect(d).toMatchObject({ verdict: "allow", autonomy: true, mode: "autopilot", remember: false, tier: asked.tier });
    expect(d.reason).toBe(`${asked.reason}; ${AUTOPILOT_REASON}`);
    expect(d.announce).toMatch(new RegExp(` in \\S.*, ${AUTOPILOT_WORDS.replace(/[.]/g, "\\.")}`));
    // What made it a question stays on the record: risky, and whether the user's words named it.
    expect(d.risky).toBe(asked.risky);
    expect(d.aligned).toBe(asked.aligned);
  });

  it("says the kind of step, the app and a size, never a control's name, the text typed or what the screen says", () => {
    const typed: ActionRequest = { ...IN, app: "firefox", window: "Send money - Example Bank", kind: "cursor_text", value: "wire 5,000 to account 12345678", mode: "replace",
      element: { role: "entry", name: "Amount to transfer" }, currentText: "x".repeat(200), dialog: { name: "Transfer", text: "Send 5,000 to Mallory?" } };
    const d = engine().decide(typed);
    expect(d.announce).toBe(`Using your keyboard to type 30 characters in Firefox, ${AUTOPILOT_WORDS} Move the mouse or press a key to take it back.`);
    for (const secret of ["wire", "12345678", "Amount", "Send money", "Example Bank", "Mallory", "Transfer"]) expect(d.announce).not.toContain(secret);
    expect(engine().decide(ASKS["a destructive key"]).announce).toBe(`Using your keyboard to press Delete in gedit, ${AUTOPILOT_WORDS} Move the mouse or press a key to take it back.`);
    expect(engine().decide(ASKS["a system setting"]).announce).toBe(`Changing a setting in Settings, ${AUTOPILOT_WORDS}`);
    expect(engine().decide({ ...ASKS["a risky control nobody asked for"], onDesk: true, kind: "cursor_click" }).announce).toBe(`Using the mouse to click in gedit, ${AUTOPILOT_WORDS}`);
    // Text carried from another window, in a step that is risky too: the kind of step, not only where the text came from.
    const moved: ActionRequest = { ...IN, app: "thunderbird", window: "Write: Q3", kind: "text", value: "the quarterly numbers are down", element: { role: "entry", name: "Body" },
      readFrom: [{ app: "firefox", window: "Inbox", text: "the quarterly numbers are down" }] };
    expect(engine().decide(moved).announce).toBe("Moving text from Firefox into Thunderbird (30 characters), without asking as you let me.");
    const over = engine().decide({ ...moved, mode: "replace", currentText: "x".repeat(200) });
    expect(over.mode).toBe("autopilot");
    expect(over.announce).toBe(`Typing 30 characters in Thunderbird, ${AUTOPILOT_WORDS}`);
  });

  it.each(Object.entries(NEVER))("still refuses %s, exactly as in Interactive", (_what, r) => {
    const refused = interactive().decide(r);
    expect(refused).toMatchObject({ verdict: "deny", tier: "never" });
    expect(engine().decide(r)).toEqual(refused);
    expect(engine().autopilotStep(r, refused)).toBe(refused);
  });

  it("leaves a step that never asked as it was: a read, an allowed step, and Interactive's own waivers in their words", () => {
    const bold: ActionRequest = { ...IN, kind: "click", element: { role: "push button", name: "Bold" } };
    for (const r of [bold, { ...IN, kind: "read" as const }, { ...bold, kind: "cursor_click" as const }, { taskId: "t1", kind: "open_app" as const, app: "", window: "", value: "Firefox" }]) {
      expect(engine().decide(r), r.kind).toEqual(interactive().decide(r));
    }
    expect(engine().decide(bold)).toMatchObject({ verdict: "allow", autonomy: true, announce: "Clicking in gedit, without asking as you let me." });
    expect(engine().decide(bold).mode).toBeUndefined();
  });

  it("is in force only where the organisation's policy lets it be, whatever the engine is told (D2)", () => {
    const r = ASKS["a risky control nobody asked for"];
    const confirms = engine({ confirmEveryAction: () => true });
    expect(confirms.autopilot).toBe(false);
    expect(confirms.decide(r)).toEqual(interactive({ confirmEveryAction: () => true }).decide(r));
    expect(confirms.decide(r).verdict).toBe("confirm");
    const off = engine({ actionsAllowed: () => false });
    expect(off.autopilot).toBe(false);
    expect(off.decide(r).verdict).toBe("deny");
    // Absent or false: every step decides exactly as in Interactive.
    for (const e of [engine({ autopilot: undefined }), engine({ autopilot: () => false })]) {
      expect(e.autopilot).toBe(false);
      for (const step of [...Object.values(ASKS), ...Object.values(NEVER)]) expect(e.decide(step)).toEqual(interactive().decide(step));
    }
    expect(engine().autopilot).toBe(true);
  });

  it("takes a question the worker holds a step to in the same way, and nothing but a question", () => {
    const e = engine();
    const r: ActionRequest = { ...IN, kind: "click", element: { role: "push button", name: "Bold" } };
    const held: Decision = { tier: "confirm", verdict: "confirm", everyTime: true, remember: false, reason: "first action in gedit; text on screen tried to give Ember instructions", prompt: "Click Bold? (I'm checking each step.)" };
    expect(e.autopilotStep(r, held)).toEqual({ ...held, verdict: "allow", autonomy: true, mode: "autopilot", reason: `${held.reason}; ${AUTOPILOT_REASON}`, announce: `Clicking in gedit, ${AUTOPILOT_WORDS}` });
    const allowed: Decision = { tier: "reversible", verdict: "allow", reason: "easy to undo", prompt: "" };
    expect(e.autopilotStep(r, allowed)).toBe(allowed);
    expect(interactive().autopilotStep(r, held)).toBe(held);
  });

  it("is allowed under an administrator's policy only with a mode allowed at all and no cap below it (D3)", () => {
    const admin = (o: Record<string, unknown> = {}) => ({ features: {}, allowGrants: true, confirmEveryAction: false, ...o });
    expect(autopilotPermitted(null)).toBe(true);
    expect(autopilotPermitted(admin())).toBe(true);
    expect(autopilotPermitted(admin({ approvals: { maxMode: "autopilot" } }))).toBe(true);
    for (const o of [{ approvals: { maxMode: "assisted" } }, { approvals: { maxMode: "interactive" } }, { features: { autonomy: false } }, { features: { actions: false } }, { allowGrants: false }, { confirmEveryAction: true }]) {
      expect(autopilotPermitted(admin(o)), JSON.stringify(o)).toBe(false);
    }
  });

  it("gets its own inputs from the mode: Interactive's, with every remaining question announced and no check (D2)", () => {
    expect(approvalInputs("autopilot")).toEqual({ scopes: ALL_SCOPES, askedApps: true, check: false, autopilot: true });
    for (const m of ["asking", "interactive", "assisted"] as const) expect(approvalInputs(m).autopilot).toBe(false);
  });
});

const BOLD: AxNode = { id: 1, parent: null, depth: 1, role: "push button", name: "Bold", states: ["enabled", "sensitive"], bounds: { x: 10, y: 10, width: 40, height: 20 } };
const DELETE: AxNode = { id: 3, parent: null, depth: 1, role: "push button", name: "Delete", states: ["enabled", "sensitive"], bounds: { x: 60, y: 10, width: 40, height: 20 } };
const REFUSED_BEFORE = /^The user already said no to this step in this task/;

/**
 * A worker on a window with Bold and Delete, in Autopilot unless `autopilot` says otherwise. Each question is answered
 * by `answers` in turn; `failAudit`: writing the audit log fails from then on.
 */
function worker(o: {
  answers?: (string | null)[]; spec?: Partial<TaskSpec>; autopilot?: () => boolean;
  /** The shell's own password prompt is open, or Ember can't tell (Perception.promptOpen). */
  promptOpen?: () => boolean | "unchecked";
  /** The model reads pictures, and a look with image=true comes with this one (null: masking failed, so none). */
  capture?: () => { mimeType: string; data: Buffer } | null;
  /** Home's "Send screenshots for tasks" (default on). */
  screenImages?: () => boolean;
  maxSteps?: number;
} = {}) {
  const audit: Record<string, unknown>[] = [];
  const asked: string[] = [];
  const activity: Record<string, unknown>[] = [];
  const order: string[] = [];
  const stamps: Record<string, unknown>[] = [];
  const answers = o.answers ?? [];
  const state = { failAudit: false };
  const window = { app: "gedit", pid: 1, name: "notes.txt", role: "frame", active: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const seen = { window, x11Window: null, nodes: [BOLD, DELETE], blocked: false, ms: 0 };
  const presenter = new Presenter(() => undefined);
  vi.spyOn(presenter, "workedWithoutAsking").mockImplementation(text => { order.push(`announce: ${text}`); });
  const on = o.autopilot ?? (() => true);
  const w = new Worker({
    client: {} as never, log: quiet, model: "m", vision: !!o.capture, workDir: "/tmp",
    ...(o.maxSteps ? { limits: { maxSteps: o.maxSteps } } : {}),
    perception: {
      // (A picture only when the worker asks for one, as the real perception takes it.)
      perceive: async (r: { image?: boolean }) => ({ ...seen, text: "<screen>", capture: r?.image ? o.capture?.() ?? null : null }), read: async () => seen, windows: async () => [window], systemDialogOpen: async () => false,
      ...(o.promptOpen ? { promptOpen: async () => o.promptOpen!() } : {}),
    } as never,
    sidecar: {
      readElement: async (id: number) => { const n = seen.nodes.find(x => x.id === id); return n ? { role: n.role, name: n.name, states: n.states, bounds: n.bounds } : null; },
      doAction: async () => { order.push("action"); return { ok: true, after: { role: "push button", name: "Bold", states: [], bounds: BOLD.bounds } }; },
    } as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}), autonomy: () => ({ ...ALL_SCOPES }), trustAskedApps: () => true, autopilot: on }),
    autonomy: () => ({ ...ALL_SCOPES }), autopilot: on,
    confirmer: { ask: async (q: { prompt: string }) => { order.push("question"); asked.push(q.prompt); return answers.length ? answers.shift() : "once"; } } as never,
    audit: { write: (e: Record<string, unknown>) => { if (state.failAudit) throw new Error("disk full"); audit.push(e); } } as never,
    settings: { get: () => ({ grants: {}, screenImages: o.screenImages?.() ?? true }), update: () => undefined } as never,
    presenter,
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
    onActivity: (e: Record<string, unknown>) => { activity.push(e); },
    onAuthorized: (s: Record<string, unknown>) => { stamps.push(s); },
    cursor: { borrow: { borrow: async () => undefined } as never, findWindow: () => 1, setBorrowing: () => undefined },
  } as unknown as WorkerDeps, { id: "t1", goal: "Delete the old line in notes.txt, then make the heading bold", userWords: "delete the old line, then make it bold", target: { title: "notes.txt" }, ...o.spec });
  const call = (name: string, args: Record<string, unknown>) => w.tools().find(t => t.name === name)!.handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
  const inner = w as unknown as {
    authorize(req: Record<string, unknown>): Promise<{ textResultForLlm: string; resultType: string } | null>;
    authorizeCells(jobs: unknown[]): Promise<{ textResultForLlm: string; resultType: string } | null | "each">;
    ahead: { entries: Record<string, unknown>[]; words: string | null } | null;
    tainted: boolean; steered: boolean; saidNoThisTask: boolean; userTookOver: boolean; isOver: boolean; stopNow(why?: string): void;
  };
  const cells = (...at: string[]) => inner.authorizeCells(at.map((cell, n) => ({ cell, text: "4", place: { col: 1, row: 5 + n }, seenKey: cell, expected: "x".repeat(200), listed: undefined })));
  return { w, state, audit, asked, activity, order, stamps, call, inner, cells, decisions: () => audit.filter(e => e.event === "decision"), actions: () => audit.filter(e => e.event === "action") };
}

describe("a task's steps in Autopilot (modes-D1)", () => {
  it("takes a risky step with no question: announced once the look right before acting has passed, recorded with the mode", async () => {
    const h = worker();
    await h.call("perceive_window", {});
    expect((await h.call("click", { id: 3 })).resultType).toBe("success");
    expect(h.order).toEqual([`announce: Clicking in gedit, ${AUTOPILOT_WORDS}`, "action"]);
    expect(h.asked).toEqual([]);
    const decided = h.decisions();
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ kind: "click", verdict: "allow", autonomy: true, mode: "autopilot", tier: "confirm", element: { role: "push button", name: "Delete" } });
    expect(decided[0].reason).toMatch(new RegExp(`; ${AUTOPILOT_REASON}$`));
    // The record is written before the step, and "What Ember did" says why nobody was asked.
    expect(h.audit.map(e => e.event)).toEqual(["decision", "action"]);
    expect(describeEntry(decided[0] as never)).toMatchObject({ tag: "Without asking", why: "Autopilot was on, so Ember didn't ask." });
    expect(h.activity.filter(e => e.type === "announce")).toEqual([{ type: "announce", text: `Clicking in gedit, ${AUTOPILOT_WORDS}` }]);
    expect(h.activity.some(e => e.type === "question")).toBe(false);
  });

  it("stays announced after a step the user didn't ask for, and marks the task as before", async () => {
    const h = worker({ spec: { userWords: "make the heading bold" } });
    await h.call("perceive_window", {});
    // "Delete" names nothing the user asked for: in Interactive it asks, saying so, and every later step asks too.
    expect((await h.call("click", { id: 3 })).resultType).toBe("success");
    expect(h.decisions()[0]).toMatchObject({ verdict: "allow", autonomy: true, mode: "autopilot", aligned: false });
    expect(h.inner.tainted).toBe(true);
    // An ordinary step of that task, which Interactive would now ask about: announced, as Autopilot's, saying why.
    expect((await h.call("click", { id: 1 })).resultType).toBe("success");
    expect(h.decisions()[1]).toMatchObject({ verdict: "allow", autonomy: true, mode: "autopilot" });
    expect(h.decisions()[1].reason).toBe(`first action in gedit; a step came up that the user didn't ask for; ${AUTOPILOT_REASON}`);
    expect(h.asked).toEqual([]);
    expect(h.order.filter(x => x.startsWith("announce"))).toEqual(Array(2).fill(`announce: Clicking in gedit, ${AUTOPILOT_WORDS}`));
  });

  it("stays announced in a task that text on screen tried to steer, and in one where the user said no", async () => {
    const steered = worker();
    await steered.call("perceive_window", {});
    steered.inner.tainted = true;
    steered.inner.steered = true;
    expect((await steered.call("click", { id: 1 })).resultType).toBe("success");
    expect((await steered.call("click", { id: 3 })).resultType).toBe("success");
    expect(steered.asked).toEqual([]);
    expect(steered.decisions().map(d => d.mode)).toEqual(["autopilot", "autopilot"]);
    expect(steered.decisions()[0].reason).toBe(`first action in gedit; text on screen tried to give Ember instructions; ${AUTOPILOT_REASON}`);
    const refused = worker();
    await refused.call("perceive_window", {});
    refused.inner.saidNoThisTask = true;
    expect((await refused.call("click", { id: 1 })).resultType).toBe("success");
    expect((await refused.call("click", { id: 3 })).resultType).toBe("success");
    expect(refused.asked).toEqual([]);
    expect(refused.decisions()[0]).toMatchObject({ verdict: "allow", autonomy: true, mode: "autopilot" });
    expect(refused.decisions()[0].reason).toBe(`first action in gedit; working without asking is suspended after the user said no; ${AUTOPILOT_REASON}`);
    expect(refused.actions()).toHaveLength(2);
  });

  it("never tries the step the user refused again, however it is reached, and goes on with the rest", async () => {
    // The user says no in Interactive; then Autopilot comes into force for the same task (they chose it in Home).
    let on = false;
    const h = worker({ answers: ["deny"], autopilot: () => on });
    await h.call("perceive_window", {});
    expect((await h.call("click", { id: 3 })).textResultForLlm).toMatch(/^The user said no\./);
    on = true;
    // The same click, the borrowed mouse on that button, and Enter or Space on it: one step, refused each time.
    expect((await h.call("click", { id: 3 })).textResultForLlm).toMatch(REFUSED_BEFORE);
    const again = { taskId: "t1", app: "gedit", window: "notes.txt", element: { role: "push button", name: "Delete" } };
    for (const reworded of [{ ...again, kind: "cursor_click" }, { ...again, kind: "keys", value: "Return" }, { ...again, kind: "keys", value: "space" }, { ...again, kind: "toggle", value: "on" }]) {
      expect(await h.inner.authorize(reworded), reworded.kind).toMatchObject({ resultType: "denied", textResultForLlm: expect.stringMatching(REFUSED_BEFORE) });
    }
    expect(h.asked).toHaveLength(1);
    expect(h.actions()).toEqual([]);
    expect(h.order.some(x => x.startsWith("announce"))).toBe(false);
    expect(h.audit.some(e => e.autonomy === true)).toBe(false);
    expect(describeEntry(h.decisions().at(-1) as never)).toMatchObject({ tag: "Refused", why: "You said no to this step earlier in this task." });
    // Another step of that task goes ahead, announced.
    expect((await h.call("click", { id: 1 })).resultType).toBe("success");
    expect(h.decisions().at(-1)).toMatchObject({ verdict: "allow", autonomy: true, mode: "autopilot" });
    expect(h.asked).toHaveLength(1);
  });

  it("borrows nothing more once the user took the mouse back: refused, never asked about or announced (cause 4)", async () => {
    const h = worker();
    h.inner.userTookOver = true;
    const borrow = { taskId: "t1", kind: "cursor_click", app: "gedit", window: "notes.txt", element: { role: "push button", name: "Bold" } };
    for (const req of [borrow, { ...borrow, element: { role: "push button", name: "Delete" } }, { ...borrow, kind: "keys", value: "Delete" }]) {
      expect(await h.inner.authorize(req)).toMatchObject({ resultType: "denied", textResultForLlm: expect.stringMatching(/^Not allowed: the user took the mouse back earlier in this task, and Autopilot doesn't ask before using it again\./) });
      expect(h.inner.ahead).toBeNull();
    }
    expect(h.asked).toEqual([]);
    expect(h.decisions().map(d => [d.verdict, d.tier, d.autonomy, d.mode])).toEqual(Array(3).fill(["deny", "never", undefined, undefined]));
    expect(h.activity.filter(e => e.type === "refused")).toHaveLength(3);
    // So is a batch of cells, whole; and in a task held to asking too.
    expect(await h.cells("B5", "B6")).toMatchObject({ resultType: "denied" });
    h.inner.saidNoThisTask = true;
    expect(await h.inner.authorize(borrow)).toMatchObject({ resultType: "denied" });
    h.inner.tainted = true;
    expect(await h.inner.authorize(borrow)).toMatchObject({ resultType: "denied" });
    expect(h.asked).toEqual([]);
    // A step that borrows nothing still goes ahead.
    expect(await h.inner.authorize({ ...borrow, kind: "click" })).toBeNull();
    expect(h.inner.ahead?.words).toBe(`Clicking in gedit, ${AUTOPILOT_WORDS}`);
  });

  it("announces a batch of cells once, as Autopilot's, each cell recorded with the mode", async () => {
    const h = worker();
    await h.call("perceive_window", {});
    expect(await h.cells("B5", "B6")).toBeNull();
    expect(h.asked).toEqual([]);
    // (Held until the borrow's look right before acting has passed.)
    expect(h.inner.ahead!.words).toBe(`Using your keyboard to fill 2 cells in gedit, ${AUTOPILOT_WORDS} Move the mouse or press a key to take it back.`);
    expect(h.inner.ahead!.entries.map(e => [e.verdict, e.autonomy, e.mode])).toEqual([["allow", true, "autopilot"], ["allow", true, "autopilot"]]);
    // In a task where the user said no, too.
    h.inner.saidNoThisTask = true;
    expect(await h.cells("C5", "C6")).toBeNull();
    expect(h.asked).toEqual([]);
  });

  it("takes no step it can't record: a failed write to the audit log stops the task", async () => {
    const h = worker();
    await h.call("perceive_window", {});
    h.state.failAudit = true;
    const result = await h.call("click", { id: 3 });
    expect(result.resultType).not.toBe("success");
    expect(h.order).toEqual([]);
    expect(h.inner.isOver).toBe(true);
  });

  it("says on a remote's stamp that the step was announced, never that the user said yes (modes-D3)", async () => {
    let on = true;
    const h = worker({ answers: ["once"], autopilot: () => on });
    await h.call("perceive_window", {});
    await h.call("click", { id: 3 });
    expect(h.stamps.at(-1)).toMatchObject({ kind: "click", verdict: "allow", approval: null, announced: true, element: { role: "push button", name: "Delete" } });
    // A step Interactive's own waiver let through was no question on a remote to begin with: nothing is claimed for it.
    await h.call("click", { id: 1 });
    expect(h.stamps.at(-1)).toMatchObject({ verdict: "allow", approval: null });
    expect(h.stamps.at(-1)!.announced).toBeUndefined();
    // Outside Autopilot the user's yes travels as before.
    on = false;
    await h.call("click", { id: 3 });
    expect(h.stamps.at(-1)).toMatchObject({ verdict: "confirm", approval: { given: true } });
    expect(h.stamps.at(-1)!.announced).toBeUndefined();
  });

  it("tells the command flow whether Autopilot is in force, read afresh at each command, also in a task held to asking (modes-D2)", () => {
    let on = true;
    const h = worker({ autopilot: () => on });
    const context = () => (h.w as unknown as { commandContext(): CommandFlowContext }).commandContext();
    expect(context().autopilot!()).toBe(true);
    // A task that was steered or told no gets no scopes (Interactive's waiver is suspended), but Autopilot still holds.
    h.inner.tainted = true;
    h.inner.saidNoThisTask = true;
    expect(context().autonomy!()).toBeNull();
    expect(context().autopilot!()).toBe(true);
    const held = context();
    on = false;
    expect(held.autopilot!()).toBe(false);
    // And the host hands each worker the mode in force through the one mapping every consumer uses.
    const host = readFileSync(path.join(__dirname, "../../app/main/agent/host.ts"), "utf8");
    expect(host).toContain("autopilot: () => approvalInputs(modeInForce(this.o.settings.get().approvals, this.o.admin?.() ?? null)).autopilot,");
    const main = readFileSync(path.join(__dirname, "../../app/main/main.ts"), "utf8");
    expect(main).toContain("autopilot: () => approvalsNow().autopilot,");
  });

  it("asks as before once Autopilot is no longer in force, at the very next step", async () => {
    let on = true;
    const h = worker({ answers: ["once"], autopilot: () => on });
    await h.call("perceive_window", {});
    await h.call("click", { id: 3 });
    expect(h.asked).toEqual([]);
    on = false;
    await h.call("click", { id: 3 });
    expect(h.asked).toEqual(["Click the “Delete” button in gedit?"]);
    expect(h.decisions().at(-1)).toMatchObject({ verdict: "confirm" });
    expect(h.decisions().at(-1)!.mode).toBeUndefined();
  });
});

describe("what Autopilot keeps (modes-D4)", () => {
  it("takes no step while the system's own password prompt is open, or while Ember can't tell: refused, never announced", async () => {
    for (const open of [true, "unchecked"] as const) {
      const h = worker({ promptOpen: () => open });
      await h.call("perceive_window", {}).catch(() => undefined);
      const out = await h.call("click", { id: 3 });
      expect(out.resultType, String(open)).toBe("denied");
      expect(h.order).toEqual([]);
      expect(h.asked).toEqual([]);
      // Recorded only as refused: nothing says Ember went ahead.
      expect(h.audit.some(e => e.autonomy === true)).toBe(false);
      expect(h.decisions().at(-1)).toMatchObject({ verdict: "deny", tier: "never" });
      expect(h.activity.some(e => e.type === "announce")).toBe(false);
    }
  });

  it("sends a picture only as before: recorded by app and size, none when masking failed, none once screenshots are turned off", async () => {
    const jpeg = { mimeType: "image/jpeg", data: Buffer.alloc(2048, 1) };
    let on = true;
    const h = worker({ capture: () => jpeg, screenImages: () => on });
    type Look = { binaryResultsForLlm?: unknown[]; textResultForLlm: string };
    const look = async () => (await h.call("perceive_window", { image: true })) as Look;
    expect((await look()).binaryResultsForLlm).toHaveLength(1);
    expect(h.audit.filter(e => e.event === "read")).toEqual([{ event: "read", task: "t1", kind: "screenshot", app: "gedit", ok: true, bytes: 2048 }]);
    // Masking failed (the capture comes back empty): no picture, and none recorded.
    const unmasked = worker({ capture: () => null });
    expect(((await unmasked.call("perceive_window", { image: true })) as Look).binaryResultsForLlm).toBeUndefined();
    expect(unmasked.audit.filter(e => e.event === "read")).toEqual([]);
    on = false;
    const off = await look();
    expect(off.binaryResultsForLlm).toBeUndefined();
    expect(off.textResultForLlm).toContain("(No screenshot: the user turned off sending screenshots for tasks; work from the elements.)");
    expect(h.audit.filter(e => e.event === "read")).toHaveLength(1);
  });

  it("stops at once: after a Stop no step is announced or taken", async () => {
    const h = worker();
    await h.call("perceive_window", {});
    h.inner.stopNow();
    const out = await h.call("click", { id: 3 });
    expect(out.resultType).not.toBe("success");
    expect(out.textResultForLlm).toMatch(/stopped/i);
    expect(h.order).toEqual([]);
    expect(h.decisions()).toEqual([]);
  });

  it("keeps the limit on a task's steps: the call past it does nothing", async () => {
    const h = worker({ maxSteps: 3 });
    await h.call("perceive_window", {});
    for (let i = 0; i < 2; i++) expect((await h.call("click", { id: 3 })).resultType).toBe("success");
    expect((await h.call("click", { id: 3 })).textResultForLlm).toMatch(/Stopped/);
    expect(h.order.filter(x => x === "action")).toHaveLength(2);
    expect(h.inner.isOver).toBe(true);
  });

  it("keeps the limit on actions a minute: a step past it waits its turn, and is never let through as Autopilot's", () => {
    let now = 1000;
    const e = engine({ rateLimit: 2, now: () => now });
    const r = ASKS["a risky control nobody asked for"];
    expect([e.decide(r).verdict, e.decide(r).verdict]).toEqual(["allow", "allow"]);
    const third = e.decide(r);
    expect(third).toMatchObject({ verdict: "deny", paced: true });
    expect(third.mode).toBeUndefined();
    expect(e.autopilotStep(r, third)).toBe(third);
    expect(e.paceMs()).toBeGreaterThan(0);
    now += 60_001;
    expect(e.decide(r).verdict).toBe("allow");
    // Ember's own 40, which the organisation can only lower, is what every engine counts with.
    expect(engine().perMinute).toBe(40);
  });

  it("leaves the limits on tasks, steps and time where no mode reaches them", () => {
    const read = (f: string) => readFileSync(path.join(__dirname, "../../app/main", f), "utf8");
    const tasks = read("agent/tasks.ts"), wk = read("agent/worker.ts");
    // At most two tasks at work (and two guides beside them): TaskManager's, which knows nothing of the mode.
    expect(tasks).toContain("const max = this.d.maxRunning ?? 2;");
    expect(tasks).not.toMatch(/autopilot|approvalInputs|modeInForce/i);
    // 150 tool calls and 20 minutes a task: the worker's own, read from nothing the mode sets.
    expect(wk).toContain("const maxSteps = this.d.limits?.maxSteps ?? 150;");
    expect(wk).toContain("const maxMs = d.limits?.maxMs ?? 20 * 60_000;");
    expect(read("agent/host.ts")).not.toMatch(/limits: \{[^}]*autopilot/);
    // 40 actions a minute across all tasks, which the organisation's policy can only lower.
    expect(read("policy/policy.ts")).toContain("return this.o.rateLimit ?? 40;");
    expect(read("main.ts")).toContain("rateLimit: policy.maxActionsPerMinute,");
  });
});
