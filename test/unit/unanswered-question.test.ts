/**
 * A question nobody answered (cause 10 of the investigation of the owner's report of 2026-11-12; PLAN.md §2
 * "Approvals"). It approves nothing and its step is not taken, but it is not the user's no: the task is not held to
 * asking for the rest of its steps (`saidNoThisTask`), as it is after a "Not now", a deny or a Stop during a command's
 * countdown, and the model is told the question went unanswered, neither a yes nor a no, so that it stops and says so
 * instead of working around it. For one step, fill_cells and a command's cards (a remote's gate 2 asks through the
 * same card).
 */

import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../../app/main/policy/policy";
import { ALL_SCOPES, type AutonomyScopes } from "../../app/main/policy/autonomy";
import { Worker, leftUndone, type WorkerDeps } from "../../app/main/agent/worker";
import type { CommandFlowContext } from "../../app/main/commands/flow";
import type { AxNode } from "../../app/main/perception/sidecar";
import { Presenter } from "../../app/main/agent/presenter";
import { Confirmer, EXPIRED_TASK_THOUGHT } from "../../app/main/agent/confirm";
import { ANSWER_WORDS, STATUS_WORDS } from "../../app/shared/activity";
import type { EmberState } from "../../app/shared/overlay";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const BOLD: AxNode = { id: 1, parent: null, depth: 1, role: "push button", name: "Bold", states: ["enabled", "sensitive"], bounds: { x: 10, y: 10, width: 40, height: 20 } };
const DELETE: AxNode = { id: 3, parent: null, depth: 1, role: "push button", name: "Delete", states: ["enabled", "sensitive"], bounds: { x: 60, y: 10, width: 40, height: 20 } };

/**
 * A worker on a window with Bold and Delete, in Interactive (every scope on) unless `scopes` says otherwise. Each
 * question is answered by `answers` in turn: null is a question that ran out of time, "deny" a "Not now".
 */
function worker(answers: (string | null)[], o: { scopes?: () => AutonomyScopes | null } = {}) {
  const audit: Record<string, unknown>[] = [];
  const asked: string[] = [];
  const activity: Record<string, unknown>[] = [];
  const window = { app: "gedit", pid: 1, name: "notes.txt", role: "frame", active: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const seen = { window, x11Window: null, nodes: [BOLD, DELETE], blocked: false, ms: 0 };
  const scopes = o.scopes ?? (() => ({ ...ALL_SCOPES }));
  const w = new Worker({
    client: {} as never, log: quiet, model: "m", vision: false, workDir: "/tmp",
    perception: { perceive: async () => ({ ...seen, text: "<screen>", capture: null }), read: async () => seen, windows: async () => [window], systemDialogOpen: async () => false } as never,
    sidecar: {
      readElement: async (id: number) => { const n = seen.nodes.find(x => x.id === id); return n ? { role: n.role, name: n.name, states: n.states, bounds: n.bounds } : null; },
      doAction: async () => ({ ok: true, after: { role: "push button", name: "Bold", states: [], bounds: BOLD.bounds } }),
    } as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}), autonomy: scopes }),
    autonomy: scopes,
    confirmer: { ask: async (q: { prompt: string }) => { asked.push(q.prompt); return answers.length ? answers.shift() : "once"; } } as never,
    audit: { write: (e: Record<string, unknown>) => audit.push(e) } as never,
    settings: { get: () => ({ grants: {} }), update: () => undefined } as never,
    presenter: new Presenter(() => undefined),
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
    onActivity: (e: Record<string, unknown>) => { activity.push(e); },
    // (fill_cells borrows the keyboard: its question is asked only where a borrow could start.)
    cursor: { borrow: { borrow: async () => undefined } as never, findWindow: () => 1, setBorrowing: () => undefined },
  } as unknown as WorkerDeps, { id: "t1", goal: "delete the old line, then make it bold", target: { title: "notes.txt" } });
  const call = (name: string, args: Record<string, unknown>) => w.tools().find(t => t.name === name)!.handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
  const clicks = () => audit.filter(e => e.event === "decision" && e.kind === "click");
  const inner = w as unknown as {
    authorizeCells(jobs: unknown[]): Promise<{ textResultForLlm: string; resultType: string } | null | "each">;
    commandContext(): CommandFlowContext;
    saidNoThisTask: boolean; expired: boolean; declined: boolean; session: unknown;
  };
  // The user says something more to the task (a steer needs a session to tell: a stand-in that takes the words).
  const says = async (text: string) => { inner.session = { send: async () => undefined }; expect(await w.steer(text, text)).toBe(true); };
  return { audit, asked, activity, call, clicks, inner, says };
}

describe("a question that ran out of time unanswered (cause 10)", () => {
  it("takes no step and tells the model the question went unanswered, neither a yes nor a no", async () => {
    const h = worker([null]);
    await h.call("perceive_window", {});
    const r = await h.call("click", { id: 3 });
    expect(r.resultType).toBe("denied");
    expect(r.textResultForLlm).toBe("Your question went unanswered: time ran out before the user answered, which is neither a yes nor a no. Nothing was approved, so the step wasn't taken. Don't retry it or work around it; finish the task now, saying that the question went unanswered and what wasn't done.");
    expect(r.textResultForLlm).not.toMatch(/said no/);
    // Nothing was clicked, and the audit says the question expired.
    expect(h.audit.some(e => e.event === "action")).toBe(false);
    expect(h.audit.find(e => e.event === "confirm")).toMatchObject({ answer: "expired" });
    // Calls the model sent in the same reply still do nothing behind it.
    expect(leftUndone("click", r as never)).toBe("no");
  });

  it("doesn't put the rest of the task back to asking: an ordinary step after it is announced as before", async () => {
    const h = worker([null]);
    await h.call("perceive_window", {});
    expect((await h.call("click", { id: 3 })).resultType).toBe("denied");
    expect((await h.call("click", { id: 1 })).resultType).toBe("success");
    // Only the risky step was asked about; Bold went ahead in the mode, said and recorded as such.
    expect(h.asked).toEqual([expect.stringMatching(/Delete/)]);
    expect(h.clicks().map(e => [e.verdict, e.autonomy ?? null])).toEqual([["confirm", null], ["allow", true]]);
    expect(h.clicks()[1].reason).not.toMatch(/suspended/);
    expect(h.inner.saidNoThisTask).toBe(false);
  });

  it("approved nothing: the risky step is asked about again once the user says something more, and never taken unasked", async () => {
    const h = worker([null, null]);
    await h.call("perceive_window", {});
    await h.call("click", { id: 3 });
    // Sent again at once, it isn't asked about a second time (refused-steps.test.ts): the user isn't there.
    expect((await h.call("click", { id: 3 })).resultType).toBe("denied");
    expect(h.asked).toHaveLength(1);
    await h.says("are you done?");
    expect((await h.call("click", { id: 3 })).resultType).toBe("denied");
    expect(h.asked).toHaveLength(2);
    expect(h.audit.some(e => e.event === "action")).toBe(false);
  });

  it("ends the task as unanswered, not as the user's “Not now”, when nothing was done after it", async () => {
    const h = worker([null]);
    await h.call("perceive_window", {});
    await h.call("click", { id: 3 });
    expect([h.inner.expired, h.inner.declined]).toEqual([true, false]);
    // What its card and Home say of it (unchanged): no answer, never "you said not now" or "Stopped".
    expect(h.activity.filter(e => e.type === "answer")).toEqual([{ type: "answer", answer: "expired" }]);
    expect([ANSWER_WORDS.expired, STATUS_WORDS.unanswered]).toEqual(["Asked you: no answer", "No answer in time"]);
  });

  it("holds the task to asking after a “Not now”, as before", async () => {
    const h = worker(["deny"]);
    await h.call("perceive_window", {});
    const r = await h.call("click", { id: 3 });
    expect(r.textResultForLlm).toBe("The user said no. Don't retry or work around it; finish the task and say what wasn't done.");
    expect((await h.call("click", { id: 1 })).resultType).toBe("success");
    expect(h.asked).toHaveLength(2);
    expect(h.clicks()[1].reason).toMatch(/working without asking is suspended after the user said no$/);
    expect(h.inner.saidNoThisTask).toBe(true);
  });

  it("holds the task to asking after a “Not now” that came after an unanswered question", async () => {
    const h = worker([null, "deny"]);
    await h.call("perceive_window", {});
    await h.call("click", { id: 3 });
    await h.says("go on");
    await h.call("click", { id: 3 });
    await h.call("click", { id: 1 });
    expect(h.asked).toHaveLength(3);
    expect(h.inner.saidNoThisTask).toBe(true);
  });

  it("is the same for fill_cells: an unanswered batch isn't typed, and the next ordinary step is announced", async () => {
    // Below Interactive the batch asks; the mode comes into force afterwards (the user agreed to its card meanwhile).
    let scopes: AutonomyScopes | null = null;
    const h = worker([null], { scopes: () => scopes });
    await h.call("perceive_window", {});
    const r = await h.inner.authorizeCells([{ cell: "B5", text: "4", place: { col: 1, row: 5 }, seenKey: "B5", expected: undefined, listed: undefined }]);
    expect(r).toMatchObject({ resultType: "denied", textResultForLlm: expect.stringMatching(/^Your question went unanswered: .* neither a yes nor a no\./) });
    expect(h.audit.find(e => e.event === "confirm")).toMatchObject({ kind: "cursor_text", answer: "expired" });
    scopes = { ...ALL_SCOPES };
    expect((await h.call("click", { id: 1 })).resultType).toBe("success");
    expect(h.asked).toHaveLength(1);
    expect(h.clicks().at(-1)).toMatchObject({ verdict: "allow", autonomy: true });
  });

  it("is the same for a command's cards (a remote's gate 2 included): unanswered keeps the mode, a no or a Stop in its countdown ends it for the task", async () => {
    const unanswered = worker([null]);
    const ctx = unanswered.inner.commandContext();
    // The card's question, asked through the worker as the flow asks it.
    expect(await ctx.confirmer.ask({ title: "May I run a command?", prompt: "On this computer: rm -rf build", options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }], task: "t1" } as never)).toBeNull();
    ctx.onDeclined?.(true);
    expect(ctx.autonomy?.()).toEqual({ ...ALL_SCOPES });
    expect([unanswered.inner.saidNoThisTask, unanswered.inner.expired, unanswered.inner.declined]).toEqual([false, true, false]);
    // "Not now" on the card, and a Stop during a command's countdown (flow.ts calls onDeclined with nothing).
    const no = worker(["deny"]);
    const ctxNo = no.inner.commandContext();
    await ctxNo.confirmer.ask({ title: "May I run a command?", prompt: "On this computer: rm -rf build", options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }], task: "t1" } as never);
    expect(ctxNo.autonomy?.()).toBeNull();
    const stopped = worker([]);
    const ctxStop = stopped.inner.commandContext();
    ctxStop.onDeclined?.();
    expect(ctxStop.autonomy?.()).toBeNull();
    expect([stopped.inner.saidNoThisTask, stopped.inner.declined]).toEqual([true, true]);
  });
});

describe("the Confirmer's own word for a question that ran out of time (cause 10)", () => {
  it("resolves it as no answer (null), never as “deny”, and says in the bubble that nothing was approved", async () => {
    const shown: Partial<EmberState>[] = [];
    let now = 0;
    const c = new Confirmer(s => { shown.push(s); }, { timeoutMs: 20, now: () => now });
    const answer = c.ask({ title: "May I?", prompt: "Click “Delete”?", options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }], task: "t1" });
    now = 1000;
    expect(await answer).toBeNull();
    expect(shown.at(-1)?.bubble?.thought).toBe(EXPIRED_TASK_THOUGHT);
    expect(EXPIRED_TASK_THOUGHT).toBe("Time ran out, so nothing was approved and I haven't done it.");
    expect(shown.at(-1)?.bubble?.thought).not.toMatch(/won't/);
  });
});
