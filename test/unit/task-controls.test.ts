import { describe, expect, it, vi } from "vitest";
import { createTaskWindowControl, sameTaskWindow, taskControl } from "../../app/main/agent/task-controls";
import { TaskManager, type Task } from "../../app/main/agent/tasks";
import { Perception, type PerceptionOptions } from "../../app/main/perception";
import { Confirmer } from "../../app/main/agent/confirm";
import type { Logger } from "../../app/main/logger";
import type { TaskSpec } from "../../app/main/agent/worker";

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } } as unknown as Logger;

it("stops only the exact intended task, and refuses stale IDs, titles and repeated Stop", async () => {
  const stopped: string[] = [];
  const tm = new TaskManager({
    log, setCards() {}, currentWindow: () => null, deleteSession: async () => undefined,
    makeWorker: spec => ({ sessionId: null, dispose: async () => undefined, steer: async () => false,
      run: signal => new Promise(resolve => signal.addEventListener("abort", () => { stopped.push(spec.id); resolve({ success: false, stopped: true, summary: "Stopped." }); })),
    }),
  });
  const a = tm.start("Same title"), b = tm.start("Same title");
  await vi.waitFor(() => expect(tm.list().map(t => t.status)).toEqual(["running", "running"]));
  const host = { tasks: tm, retryTask: vi.fn(() => false) };
  expect(taskControl(host, { id: a.title, action: "stop" })).toBe(false);
  expect(taskControl(host, { id: "8-deadbeef", action: "stop" })).toBe(false);
  expect(taskControl(host, { id: a.id, action: "stop" })).toBe(true);
  expect(taskControl(host, { id: a.id, action: "stop" })).toBe(false);
  expect(stopped).toEqual([a.id]);
  expect(tm.get(b.id)?.status).toBe("running");
  expect(tm.activities().find(t => t.id === b.id)?.controls?.stop).toBe(true);
  expect(taskControl(host, { id: b.id, action: "invented" })).toBe(false);
  tm.cancelAll(); await tm.drain(100); tm.close();
});

it("retry creates a new task with the original provenance and needs a fresh exact approval", async () => {
  const confirmer = new Confirmer(() => undefined, { armMs: 0, gapMs: 0 });
  const specs: TaskSpec[] = [];
  const tm = new TaskManager({
    log, setCards() {}, currentWindow: () => ({ title: "Changed foreground", pid: 99 }), deleteSession: async () => undefined,
    makeWorker: spec => {
      specs.push(spec);
      return { sessionId: null, dispose: async () => undefined, steer: async () => false, run: async () => {
        await confirmer.ask({ title: "May I?", task: spec.id, prompt: "Send?", options: [{ id: "once", label: "Allow" }, { id: "deny", label: "Not now" }] });
        return { success: false, summary: "Couldn't finish." };
      } };
    },
  });
  const first = tm.start("Model-authored goal", { target: { title: "Original window", pid: 7 }, userWords: "Original request", commandWords: "", typedOnly: true });
  await vi.waitFor(() => expect(confirmer.currentNumber).toBe(1));
  expect(confirmer.answer("q1:once")).toBe(true);
  await vi.waitFor(() => expect(tm.get(first.id)?.status).toBe("failed"));
  const host = { tasks: tm, retryTask: (id: string) => !!tm.retry(id) };
  expect(tm.activities().find(t => t.id === first.id)?.controls?.retry).toBe(true);
  expect(taskControl(host, { id: first.id, action: "retry" })).toBe(true);
  expect(taskControl(host, { id: first.id, action: "retry" })).toBe(false);
  await vi.waitFor(() => expect(confirmer.currentNumber).toBe(2));
  expect(specs[1]).toMatchObject({ target: { title: "Original window", pid: 7 }, userWords: "Original request", commandWords: "", typedOnly: true });
  expect(specs[1].id).not.toBe(first.id);
  expect(confirmer.answer("q1:once")).toBe(false);
  expect(tm.get(specs[1].id)?.status).toBe("running");
  expect(confirmer.answer("q2:once")).toBe(true);
  await vi.waitFor(() => expect(tm.get(specs[1].id)?.status).toBe("failed"));
  tm.dismiss(specs[1].id);
  expect(taskControl(host, { id: specs[1].id, action: "retry" })).toBe(false);
  expect(tm.activities().find(t => t.id === specs[1].id)?.controls).toEqual({ stop: false, retry: false, window: false });
  tm.close(); confirmer.cancelAll();
});

it("expired retry specs become unavailable while their result remains in history", async () => {
  vi.useFakeTimers();
  try {
    const tm = new TaskManager({ log, setCards() {}, currentWindow: () => null, deleteSession: async () => undefined, failureCardMs: 10,
      makeWorker: () => ({ sessionId: null, dispose: async () => undefined, steer: async () => false, run: async () => ({ success: false, summary: "Failed." }) }),
    });
    const task = tm.start("Fail");
    await vi.advanceTimersByTimeAsync(1);
    expect(tm.canRetry(task.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(tm.activities().find(t => t.id === task.id)?.controls?.retry).toBe(false);
    expect(tm.retry(task.id)).toBe(null);
    tm.close();
  } finally { vi.useRealTimers(); }
});

describe("showing the task's own app", () => {
  const ref = { id: 8, pid: 7, title: "notes.txt", wmClass: "editor" };
  const window = { ...ref, client: 8 };
  const task = { window: ref, targetId: "local", hand: "background" } as Task;
  it("checks native identity instead of choosing a window with a matching title", () => {
    expect(sameTaskWindow(ref, window)).toBe(true);
    for (const changed of [{ pid: 99 }, { id: 99, client: 99 }, { title: "Other" }, { wmClass: "other" }]) expect(sameTaskWindow(ref, { ...window, ...changed })).toBe(false);
  });
  it("refreshes on activation and fails closed for gone, remote, desk, blocked and closed-window states", () => {
    let shown = [window], blocked = false;
    const activate = vi.fn(), list = vi.fn(() => shown);
    const open = createTaskWindowControl({ list, activate, blocked: () => blocked });
    expect(open(task, false)).toBe(true);
    expect(open(task, false)).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    shown = [{ ...window, pid: 99 }];
    expect(open(task, true)).toBe(false);
    expect(activate).not.toHaveBeenCalled();
    shown = [window];
    expect(open(task, true)).toBe(true);
    expect(activate).toHaveBeenCalledWith(8);
    expect(open({ ...task, targetId: "ssh:build-01" }, true)).toBe(false);
    expect(open({ ...task, hand: "desk" }, true)).toBe(false);
    blocked = true;
    expect(open(task, true)).toBe(false);
    blocked = false; shown = [];
    expect(open(task, true)).toBe(false);
  });
});


it("binds an actual accessibility read to native identity with process, title and geometry, and never private windows", () => {
  const bounds = { x: 10, y: 10, width: 600, height: 400 };
  let stack = [{ id: 88, client: 8, pid: 7, title: "notes.txt", wmClass: "editor", ...bounds, inner: bounds, outer: bounds, overrideRedirect: false }];
  let neverLook: string[] = [];
  const p = new Perception({ log, sidecar: {} as PerceptionOptions["sidecar"], x11: { stack: () => stack } as PerceptionOptions["x11"],
    neverLook: () => neverLook, screenBounds: () => bounds, ownPid: 99 });
  const read = { app: "editor", pid: 7, name: "notes.txt", role: "frame", bounds, active: false };
  expect(p.nativeWindow(read)).toMatchObject({ id: 8, pid: 7, title: "notes.txt", wmClass: "editor" });
  expect(p.nativeWindow({ ...read, pid: 6 })).toBe(null);
  expect(p.nativeWindow({ ...read, name: "Other" })).toBe(null);
  expect(p.nativeWindow({ ...read, bounds: { ...bounds, x: 800 } })).toBe(null);
  neverLook = ["editor"];
  expect(p.nativeWindow(read)).toBe(null);
  neverLook = []; stack = [];
  expect(p.nativeWindow(read)).toBe(null);
});
