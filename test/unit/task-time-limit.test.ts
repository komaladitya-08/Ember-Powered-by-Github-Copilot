/**
 * A task stops 20 minutes after it starts, but the time a question waits for the user's answer doesn't count: with
 * More time to read and answer a question waits 20 minutes, and one with a long text to read longer still
 * (confirm.ts), which the docs promise (final review U1). Its own steps' questions and its commands' alike.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker, type WorkerDeps, type WorkerResult } from "../../app/main/agent/worker";
import type { Question } from "../../app/main/agent/confirm";
import { Presenter } from "../../app/main/agent/presenter";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const MIN = 60_000;

/** A task whose every step is asked about; each question is answered `answerMs` after it is asked (or ends on Stop). */
function makeTask(answerMs: number) {
  const asked: Question[] = [];
  const window = { app: "gedit", pid: 1, name: "notes.txt", role: "frame", active: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const node = { id: 1, parent: null, depth: 1, role: "entry", name: "Message", states: ["enabled", "editable", "focused"], bounds: { x: 10, y: 10, width: 200, height: 20 } };
  const seen = { window, x11Window: null, nodes: [node], blocked: false, ms: 0 };
  /* eslint-disable @typescript-eslint/no-explicit-any -- a pretend SDK session */
  const listeners = new Set<(e: any) => void>();
  const emit = (type: string, data: Record<string, unknown> = {}) => { for (const l of [...listeners]) l({ type, data }); };
  let tools: string[] = [];
  const session = {
    sessionId: "ember-task-t1",
    rpc: { tools: { initializeAndValidate: async () => ({}), getCurrentMetadata: async () => ({ tools: tools.map(name => ({ name })) }) } },
    on(fn: (e: any) => void) { listeners.add(fn); return () => listeners.delete(fn); },
    // The turn begins, and goes on until the test ends it.
    async send({ prompt }: { prompt: string }) { emit("user.message", { content: prompt }); emit("assistant.turn_start", { turnId: "0" }); return "m"; },
    async abort() { emit("abort", { reason: "user initiated" }); emit("session.idle", { aborted: true }); },
  };
  const client = { createSession: async (cfg: any) => { tools = (cfg.tools ?? []).map((t: any) => t.name); return session; } };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const deps = {
    client: client as never, log: quiet, model: "m", vision: false, workDir: fs.mkdtempSync(path.join(os.tmpdir(), "ember-limit-")),
    perception: { perceive: async () => ({ ...seen, text: "[1] entry \"Message\"", capture: null }), read: async () => seen, windows: async () => [window] } as never,
    sidecar: { readElement: async () => ({ role: node.role, name: node.name, states: node.states, bounds: node.bounds }) } as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}), confirmEveryAction: () => true, allowGrants: () => false }),
    confirmer: {
      ask: (q: Question, signal?: AbortSignal) => new Promise<string | null>(resolve => {
        asked.push(q);
        const timer = setTimeout(() => resolve("once"), answerMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(null); }, { once: true });
      }),
    } as never,
    audit: { write: () => undefined } as never,
    settings: { get: () => ({ grants: {} }), update: () => undefined } as never,
    presenter: new Presenter(() => undefined),
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
    // The task's own time limit is the usual 20 minutes; Copilot's silence isn't what these tests are about.
    limits: { turnSlowMs: 600 * MIN, turnSilentMs: 600 * MIN },
  } as unknown as WorkerDeps;
  const w = new Worker(deps, { id: "t1", goal: "write to the team", target: { title: "notes.txt" } });
  const inner = w as unknown as {
    haltReason: string | null;
    authorize(r: ActionRequest): Promise<unknown>;
    commandContext(): { confirmer: { ask(q: Question, signal?: AbortSignal): Promise<string | null> }; signal: AbortSignal };
  };
  let n = 0;
  /** A step the runtime runs as a tool: under way from its start to its end (a tool under way is never silence). */
  const step = async <T>(fn: () => Promise<T>): Promise<T> => {
    const toolCallId = `c${++n}`;
    emit("tool.execution_start", { toolCallId, toolName: "type_text" });
    try { return await fn(); } finally { emit("tool.execution_complete", { toolCallId }); }
  };
  return {
    w, asked, inner,
    perceive: () => w.tools().find(t => t.name === "perceive_window")!.handler!({}, {} as never),
    typeStep: (value: string) => step(() => inner.authorize({ taskId: "t1", kind: "text", app: "gedit", window: "notes.txt", element: { role: "entry", name: "Message" }, mode: "replace", currentText: "", value } as ActionRequest)),
    commandQuestion: () => step(() => { const ctx = inner.commandContext(); return ctx.confirmer.ask({ title: "May I?", prompt: "Run ls?", options: [{ id: "once", label: "Allow" }, { id: "deny", label: "Not now" }], task: "t1" }, ctx.signal); }),
    endTurn: () => emit("session.idle"),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("a task's time limit", () => {
  it("doesn't count the time a question waits for the user's answer: its steps' questions or its commands' (final review U1)", async () => {
    // More time to read and answer: a question waits up to 20 minutes, here answered after 18.
    const task = makeTask(18 * MIN);
    await task.perceive();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    let result: WorkerResult | null = null;
    void task.w.run(new AbortController().signal).then(r => { result = r; });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    // 5 minutes of work, then a question the user answers 18 minutes later: 23 minutes on, the task goes on.
    const typed = task.typeStep("Hello there");
    await vi.advanceTimersByTimeAsync(18 * MIN);
    expect(await typed).toBeNull();
    expect(task.inner.haltReason).toBeNull();
    // A command's question too: 41 minutes on, 5 of them work.
    const ran = task.commandQuestion();
    await vi.advanceTimersByTimeAsync(18 * MIN);
    expect(await ran).toBe("once");
    expect(task.asked).toHaveLength(2);
    expect(task.inner.haltReason).toBeNull();
    // The time before and after the questions counts: 14 minutes more is 19 of work, and the 20th stops it.
    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(task.inner.haltReason).toBeNull();
    await vi.advanceTimersByTimeAsync(MIN + 1);
    expect(task.inner.haltReason).toBe("I stopped because the task took longer than 20 minutes.");
    await vi.advanceTimersByTimeAsync(5000);
    expect(result).toEqual({ success: false, summary: "I stopped because the task took longer than 20 minutes." });
  });

  it("still stops a task 20 minutes in while no question is up", async () => {
    const task = makeTask(30 * MIN);
    await task.perceive();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    let result: WorkerResult | null = null;
    void task.w.run(new AbortController().signal).then(r => { result = r; });
    await vi.advanceTimersByTimeAsync(20 * MIN - 1);
    expect(task.inner.haltReason).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    expect(task.inner.haltReason).toBe("I stopped because the task took longer than 20 minutes.");
    await vi.advanceTimersByTimeAsync(5000);
    expect(result).toEqual({ success: false, summary: "I stopped because the task took longer than 20 minutes." });
  });

  it("starts no clock again for a question that ends with its task", async () => {
    const task = makeTask(30 * MIN);
    await task.perceive();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    let result: WorkerResult | null = null;
    void task.w.run(new AbortController().signal).then(r => { result = r; });
    await vi.advanceTimersByTimeAsync(MIN);
    const typed = task.typeStep("Hello there");
    await vi.advanceTimersByTimeAsync(MIN);
    // The turn ends with the question up, and so does the summary's: the task is over, and its question with it.
    task.endTurn();
    await vi.advanceTimersByTimeAsync(0);
    task.endTurn();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).not.toBeNull();
    expect(await typed).not.toBeNull();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(task.inner.haltReason).toBeNull();
  });
});
