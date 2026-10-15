import { describe, expect, it, vi } from "vitest";
import { TaskManager } from "../../app/main/agent/tasks";
import { Confirmer, guardWhileAsking } from "../../app/main/agent/confirm";
import { findApp, parseDesktopFile, type DesktopApp } from "../../app/main/hands/system";
import type { Worker, WorkerResult } from "../../app/main/agent/worker";
import type { TaskCard, EmberState } from "../../app/shared/overlay";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

function fakeWorker(run: (signal: AbortSignal) => Promise<WorkerResult>, id = "s") {
  return { run, dispose: async () => undefined, sessionId: id } as unknown as Worker;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("TaskManager", () => {
  const setup = (makeWorker: ConstructorParameters<typeof TaskManager>[0]["makeWorker"], extra = {}) => {
    const cards: TaskCard[][] = [];
    const deleted: string[] = [];
    const tm = new TaskManager({
      log: quiet, makeWorker, currentWindow: () => ({ title: "notes.txt", pid: 7 }),
      setCards: c => cards.push(c), deleteSession: async id => { deleted.push(id); }, keepMs: 0, ...extra,
    });
    return { tm, cards, deleted };
  };

  it("runs a task, shows its card, and reports the result once", async () => {
    const { tm, cards, deleted } = setup(spec => {
      expect(spec.target).toEqual({ title: "notes.txt", pid: 7 });
      return fakeWorker(async () => ({ success: true, summary: "Night Light is on." }), `sess-${spec.id}`);
    });
    const t = tm.start("Turn on Night Light");
    await vi.waitFor(() => expect(tm.get(t.id)?.status).toBe("done"));
    expect(cards.at(-1)?.[0]).toMatchObject({ title: "Turn on Night Light", status: "done", detail: "Night Light is on." });
    expect(tm.takeReports().map(r => r.id)).toEqual([t.id]);
    expect(tm.takeReports()).toEqual([]);
    await vi.waitFor(() => expect(deleted).toEqual([`sess-${t.id}`]));
  });

  it("runs two at once and queues the third", async () => {
    const gates = [deferred<WorkerResult>(), deferred<WorkerResult>(), deferred<WorkerResult>()];
    let n = 0;
    const { tm } = setup(() => { const g = gates[n++]; return fakeWorker(() => g.promise); });
    const a = tm.start("a"), b = tm.start("b"), c = tm.start("c");
    await vi.waitFor(() => expect([a, b, c].map(t => tm.get(t.id)!.status)).toEqual(["running", "running", "queued"]));
    gates[0].resolve({ success: true, summary: "a done" });
    await vi.waitFor(() => expect(tm.get(c.id)!.status).toBe("running"));
    gates[1].resolve({ success: false, summary: "b failed" });
    gates[2].resolve({ success: true, summary: "c done" });
    await vi.waitFor(() => expect(tm.get(c.id)!.status).toBe("done"));
    expect(tm.get(b.id)!.status).toBe("failed");
  });

  it("cancels running and queued tasks", async () => {
    const { tm } = setup(() => fakeWorker(signal => new Promise(resolve => signal.addEventListener("abort", () => resolve({ success: false, summary: "Stopped." })))), { maxRunning: 1 });
    const a = tm.start("a"), b = tm.start("b");
    await vi.waitFor(() => expect(tm.get(a.id)!.status).toBe("running"));
    tm.cancelAll();
    await vi.waitFor(() => expect(tm.get(a.id)!.status).toBe("cancelled"));
    expect(tm.get(b.id)!.status).toBe("cancelled");
  });

  it("gives one task at a time a window lease", async () => {
    const { tm } = setup(() => fakeWorker(async () => ({ success: true, summary: "" })));
    const order: string[] = [];
    const releaseA = await tm.lease("Notes.txt", "A");
    const waitingB = tm.lease("notes.txt", "B").then(release => { order.push("B"); release(); });
    expect(await tm.lease("notes.txt", "A")).toBeTypeOf("function"); // re-entrant for the holder
    order.push("A");
    releaseA();
    await waitingB;
    expect(order).toEqual(["A", "B"]);
  });
});

describe("Confirmer", () => {
  it("shows one question at a time and only accepts its own buttons", async () => {
    const shown: Partial<EmberState>[] = [];
    const c = new Confirmer(p => shown.push(p), 10_000);
    const q1 = c.ask({ title: "May I?", prompt: "Click “Save”?", options: [{ id: "once", label: "Allow" }, { id: "deny", label: "Not now" }] });
    const q2 = c.ask({ title: "May I?", prompt: "Click “Send”?", options: [{ id: "once", label: "Allow" }, { id: "deny", label: "Not now" }] });
    const ids = shown.at(-1)!.bubble!.actions.map(a => a.id);
    expect(shown.at(-1)!.bubble).toMatchObject({ mood: "attention", thought: "Click “Save”?" });
    expect(c.answer("q2:once")).toBe(false); // not the question on screen
    expect(c.answer("q1:bogus")).toBe(false);
    expect(c.answer(ids[0])).toBe(true);
    await expect(q1).resolves.toBe("once");
    expect(shown.at(-1)!.bubble?.thought).toBe("Click “Send”?");
    c.cancelAll();
    await expect(q2).resolves.toBeNull();
  });

  it("treats no answer as no", async () => {
    vi.useFakeTimers();
    const c = new Confirmer(() => undefined, 1000);
    const q = c.ask({ title: "?", prompt: "?", options: [{ id: "once", label: "Allow" }] });
    vi.advanceTimersByTime(1001);
    await expect(q).resolves.toBeNull();
    vi.useRealTimers();
  });
});

describe("apps", () => {
  it("parses visible applications from .desktop files", () => {
    const text = "[Desktop Entry]\nType=Application\nName=Text Editor\nGenericName=Text Editor\nKeywords=notepad;gedit;\nExec=gedit %U\n[Desktop Action new]\nName=New Window\n";
    expect(parseDesktopFile(text)).toEqual({ name: "Text Editor", keywords: ["text editor", "notepad", "gedit"], visible: true, exec: "gedit %U" });
    expect(parseDesktopFile("[Desktop Entry]\nType=Application\nName=X\nNoDisplay=true\n")?.visible).toBe(false);
    expect(parseDesktopFile("[Desktop Entry]\nType=Link\nName=X\n")).toBeNull();
  });
  it("finds apps by name, id or keyword", () => {
    const apps: DesktopApp[] = [
      { id: "org.gnome.gedit", name: "Text Editor", file: "", keywords: ["notepad", "gedit"] },
      { id: "org.gnome.Nautilus", name: "Files", file: "", keywords: ["folder", "explorer"] },
    ];
    expect(findApp(apps, "files")?.id).toBe("org.gnome.Nautilus");
    expect(findApp(apps, "text")?.id).toBe("org.gnome.gedit");
    expect(findApp(apps, "gedit")?.id).toBe("org.gnome.gedit");
    expect(findApp(apps, "explorer")?.id).toBe("org.gnome.Nautilus");
    expect(findApp(apps, "spreadsheet")).toBeNull();
  });
});

describe("execArgv", () => {
  it("splits Exec lines without a shell and drops field codes", async () => {
    const { execArgv } = await import("../../app/main/hands/system");
    expect(execArgv("gedit %U")).toEqual(["gedit"]);
    expect(execArgv('"/opt/My App/bin/app" --flag %f')).toEqual(["/opt/My App/bin/app", "--flag"]);
    expect(execArgv("env FOO=1 app 100%%")).toEqual(["env", "FOO=1", "app", "100%"]);
  });
});

describe("guardWhileAsking", () => {
  it("keeps a question on screen until it is answered", async () => {
    const shown: Partial<EmberState>[] = [];
    const confirmer = new Confirmer(p => shown.push(p));
    const setState = guardWhileAsking(() => confirmer.waiting, p => shown.push(p));
    const q = confirmer.ask({ title: "May I?", prompt: "Press ctrl+s?", options: [{ id: "once", label: "Allow" }] });
    const question = shown.at(-1)!.bubble!;
    // A worker's reasoning arrives while the question is up: the bubble stays, other fields pass.
    setState({ emotion: "thinking", bubble: { ...question, mood: "thinking", thought: "hmm", actions: [] }, tasks: [] });
    expect(shown.at(-1)).toEqual({ tasks: [] });
    setState({ talking: true });
    expect(shown.at(-1)).toEqual({ tasks: [] });
    confirmer.answer(question.actions[0].id);
    await q;
    setState({ emotion: "happy" });
    expect(shown.at(-1)).toEqual({ emotion: "happy" });
  });
});
