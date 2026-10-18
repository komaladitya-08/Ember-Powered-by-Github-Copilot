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
    const c = new Confirmer(p => shown.push(p), { timeoutMs: 10_000, armMs: 0, gapMs: 0 });
    const q1 = c.ask({ title: "May I?", prompt: "Click “Save”?", options: [{ id: "once", label: "Allow" }, { id: "deny", label: "Not now" }] });
    const q2 = c.ask({ title: "May I?", prompt: "Click “Send”?", options: [{ id: "once", label: "Allow" }, { id: "deny", label: "Not now" }] });
    const ids = shown.at(-1)!.bubble!.actions.map(a => a.id);
    expect(shown.at(-1)!.bubble).toMatchObject({ mood: "attention", thought: "Click “Save”?" });
    expect(c.answer("q2:once")).toBe(false); // not the question on screen
    expect(c.answer("q1:bogus")).toBe(false);
    expect(c.answer(ids[0])).toBe(true);
    await expect(q1).resolves.toBe("once");
    await new Promise(r => setTimeout(r, 5)); // the next question follows after a (here zero) gap
    expect(shown.at(-1)!.bubble?.thought).toBe("Click “Send”?");
    c.cancelAll();
    await expect(q2).resolves.toBeNull();
  });

  it("ignores clicks in a question's first moments, and the next question waits a beat (no double-click approvals)", async () => {
    let t = 0;
    const shown: Partial<EmberState>[] = [];
    const c = new Confirmer(p => shown.push(p), { timeoutMs: 10_000, armMs: 500, gapMs: 40, now: () => t });
    const opts = [{ id: "once", label: "Allow" }, { id: "deny", label: "Not now" }];
    const q1 = c.ask({ title: "May I?", prompt: "Click “Next”?", options: opts });
    const q2 = c.ask({ title: "May I?", prompt: "Borrow your mouse to click “Delete”?", options: opts });
    expect(c.answer("q1:once")).toBe(false); // a click already on its way
    t = 600;
    expect(c.answer("q1:once")).toBe(true);
    await expect(q1).resolves.toBe("once");
    expect(c.waiting).toBe(false); // the second click of a double-click lands on nothing
    expect(c.answer("q2:once")).toBe(false);
    await new Promise(r => setTimeout(r, 60));
    expect(shown.at(-1)!.bubble?.thought).toContain("Delete");
    expect(c.answer("q2:once")).toBe(false); // just appeared
    t = 1300;
    expect(c.answer("q2:deny")).toBe(true);
    await expect(q2).resolves.toBe("deny");
  });

  it("a queued question gets its full time once it is on screen, and a stopped task's question goes away", async () => {
    vi.useFakeTimers();
    const c = new Confirmer(() => undefined, { timeoutMs: 1000, armMs: 0, gapMs: 10 });
    const opts = [{ id: "once", label: "Allow" }];
    const q1 = c.ask({ title: "?", prompt: "first", options: opts });
    const q2 = c.ask({ title: "?", prompt: "second", options: opts });
    vi.advanceTimersByTime(990);
    expect(c.answer("q1:once")).toBe(true);
    await expect(q1).resolves.toBe("once");
    vi.advanceTimersByTime(10 + 900);
    expect(c.waiting).toBe(true); // 1.9 s after it was asked, but only 0.9 s on screen
    const ac = new AbortController();
    const q3 = c.ask({ title: "?", prompt: "third", options: opts }, ac.signal);
    ac.abort();
    await expect(q3).resolves.toBeNull();
    vi.advanceTimersByTime(200);
    await expect(q2).resolves.toBeNull();
    vi.useRealTimers();
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
    const confirmer = new Confirmer(p => shown.push(p), { armMs: 0 });
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

describe("Confirmer keyboard answers and borrowing", () => {
  it("answers by key, refuses everything while Ember holds the mouse, and reports when questions come and go", async () => {
    let borrowing = true;
    const changes: (number | null)[] = [];
    const c = new Confirmer(() => undefined, { armMs: 0, gapMs: 0, blocked: () => borrowing, onChange: q => changes.push(q?.n ?? null) });
    const q = c.ask({ title: "May I?", prompt: "Click “Save”?", options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }] });
    expect(c.answerKey("primary")).toBe(false); // a borrowed click or key can't approve
    borrowing = false;
    expect(c.answerKey("always")).toBe(false); // not offered
    expect(c.answerKey("deny")).toBe(true);
    await expect(q).resolves.toBe("deny");
    expect(changes).toEqual([1, null]);
  });
});

describe("review round 2: stopping and questions", () => {
  const ask = (c: Confirmer) => c.ask({ title: "May I?", context: "Tidy the desktop", prompt: "Click “Save”?", options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }] });

  it("“Not now” (or no answer) leaves Ember idle, not working", async () => {
    const shown: Partial<EmberState>[] = [];
    const c = new Confirmer(s => shown.push(s), { armMs: 0, gapMs: 0, timeoutMs: 50 });
    const q = ask(c);
    expect(c.answerKey("deny")).toBe(true);
    await q;
    expect(shown.at(-1)).toMatchObject({ emotion: "neutral", bubble: { mood: "idle", thought: "Okay, I won't." } });
    await ask(c); // expires
    expect(shown.at(-1)).toMatchObject({ emotion: "neutral", bubble: { mood: "idle" } });
    const yes = ask(c);
    expect(c.answerKey("primary")).toBe(true);
    await yes;
    expect(shown.at(-1)).toMatchObject({ emotion: "focused", bubble: { mood: "acting" } });
  });

  it("the question names the keys that answer it", async () => {
    const shown: Partial<EmberState>[] = [];
    const c = new Confirmer(s => shown.push(s), { armMs: 0, gapMs: 0, keyHint: () => "Ctrl+Alt+Y allow · Ctrl+Alt+N not now" });
    const q = ask(c);
    expect(shown[0].bubble?.step).toBe("Ctrl+Alt+Y allow · Ctrl+Alt+N not now");
    c.cancelAll();
    await q;
    const plain = new Confirmer(s => shown.push(s), { armMs: 0, gapMs: 0 });
    const q2 = ask(plain);
    expect(shown.at(-1)?.bubble?.step).toBeNull();
    plain.cancelAll();
    await q2;
  });

  it("says “stopped”, once: never “cancelled”", async () => {
    const { taskOutcome } = await import("../../app/main/agent/tasks");
    const cards: TaskCard[][] = [];
    const tm = new TaskManager({
      log: quiet, makeWorker: () => fakeWorker(() => new Promise(() => undefined)), maxRunning: 0,
      currentWindow: () => null, setCards: c => cards.push(c), deleteSession: async () => undefined,
    });
    const t = tm.start("Tidy the desktop");
    tm.cancel(t.id);
    expect(t.result?.summary).toBe("Stopped before it started.");
    expect(taskOutcome(t)).toBe("Tidy the desktop: stopped before it started.");
    expect(taskOutcome({ title: "Tidy", status: "cancelled", result: { success: false, summary: "Stopped.", stopped: true } })).toBe("Tidy: stopped.");
    expect(taskOutcome({ title: "Tidy", status: "cancelled", result: { success: false, summary: "You took the mouse back at step 3." } })).toBe("Tidy: stopped. You took the mouse back at step 3.");
    expect(taskOutcome({ title: "Tidy", status: "done", result: { success: true, summary: "Moved 3 files." } })).toBe("Tidy: done. Moved 3 files.");
  });

  it("a closed manager's cards never come back", async () => {
    vi.useFakeTimers();
    const cards: TaskCard[][] = [];
    const tm = new TaskManager({
      log: quiet, makeWorker: () => fakeWorker(async () => ({ success: true, summary: "ok" })), cardMs: 100,
      currentWindow: () => null, setCards: c => cards.push(c), deleteSession: async () => undefined, keepMs: 0,
    });
    tm.start("one");
    await vi.advanceTimersByTimeAsync(10);
    tm.close();
    expect(cards.at(-1)).toEqual([]);
    const n = cards.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(cards.length).toBe(n);
    vi.useRealTimers();
  });
});

describe("review round 3: how tasks end", () => {
  const manager = (makeWorker: ConstructorParameters<typeof TaskManager>[0]["makeWorker"], extra = {}) => {
    const cards: TaskCard[][] = [];
    const tm = new TaskManager({ log: quiet, makeWorker, currentWindow: () => null, setCards: c => cards.push(c), deleteSession: async () => undefined, keepMs: 0, ...extra });
    return { tm, cards };
  };

  it("a task the user declined (“Not now”) ends calmly: a stopped card that goes, not a lasting failure", async () => {
    vi.useFakeTimers();
    const { tm, cards } = manager(() => fakeWorker(async () => ({ success: false, stopped: true, summary: "You said not now, so I left it." })), { cardMs: 100 });
    const t = tm.start("Turn on Night Light");
    await vi.advanceTimersByTimeAsync(10);
    expect(t.status).toBe("cancelled");
    expect(cards.at(-1)).toEqual([{ id: t.id, title: "Turn on Night Light", status: "stopped", detail: "You said not now, so I left it.", actions: [{ id: `task:${t.id}:dismiss`, label: "Close" }] }]);
    await vi.advanceTimersByTimeAsync(200);
    expect(cards.at(-1)).toEqual([]);
    vi.useRealTimers();
  });

  it("tasks cut off under them (Copilot stopped) end as failed with the reason, running or waiting", async () => {
    const { tm } = manager(() => fakeWorker(signal => new Promise(resolve => signal.addEventListener("abort", () => resolve({ success: false, stopped: true, summary: "Stopped." })))), { maxRunning: 1 });
    const a = tm.start("a"), b = tm.start("b");
    await vi.waitFor(() => expect(a.status).toBe("running"));
    tm.cancelAll("Copilot stopped unexpectedly; the task didn't finish.");
    await vi.waitFor(() => expect(a.status).toBe("failed"));
    expect([a, b].map(t => [t.status, t.result?.summary])).toEqual([
      ["failed", "Copilot stopped unexpectedly; the task didn't finish."],
      ["failed", "Copilot stopped unexpectedly; the task didn't finish."],
    ]);
  });

  it("settled() waits until no question is up or waiting its turn", async () => {
    const c = new Confirmer(() => undefined, { armMs: 0, gapMs: 20 });
    await c.settled();
    const q = { title: "May I?", prompt: "Click?", options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }] };
    void c.ask(q);
    void c.ask(q);
    let settled = false;
    void c.settled().then(() => { settled = true; });
    c.answerKey("deny");
    await new Promise(r => setTimeout(r, 40));
    expect(settled).toBe(false);
    c.answerKey("deny");
    await new Promise(r => setTimeout(r, 0));
    expect(settled).toBe(true);
  });
});

describe("review round 4: how tasks end", () => {
  const manager = (makeWorker: ConstructorParameters<typeof TaskManager>[0]["makeWorker"], extra = {}) => {
    const cards: TaskCard[][] = [];
    const tm = new TaskManager({ log: quiet, makeWorker, currentWindow: () => null, setCards: c => cards.push(c), deleteSession: async () => undefined, keepMs: 0, ...extra });
    return { tm, cards };
  };

  it("a task that fails on a service error says so in plain words, not the SDK's text", async () => {
    const fails = (msg: string) => () => fakeWorker(async () => { throw new Error(msg); });
    const rate = manager(fails("Failed to get response from the AI model; retried 5 times (total retry wait time: 54.36 seconds) Last error: 429 Rate limit exceeded"));
    const a = rate.tm.start("Turn on Night Light");
    await vi.waitFor(() => expect(a.status).toBe("failed"));
    expect(a.result?.summary).toBe("Copilot's usage limit was reached for now. Try again a bit later.");
    const key = manager(fails("Authentication failed with provider at http://llm.corp/v1 (HTTP 401). Check your COPILOT_PROVIDER_API_KEY."), { provider: true });
    const b = key.tm.start("Turn on Night Light");
    await vi.waitFor(() => expect(b.status).toBe("failed"));
    expect(b.result?.summary).toBe("Your organisation's AI endpoint refused the request. Ask your administrator to check Ember's endpoint settings.");
    expect(key.cards.at(-1)?.[0].detail).toBe(b.result?.summary);
  });

  it("says when a finished card goes, and whether the user closed it", async () => {
    vi.useFakeTimers();
    const removed: [string, boolean][] = [];
    const { tm } = manager(() => fakeWorker(async () => ({ success: false, summary: "It broke." })), { cardMs: 100, onRemoved: (t: { id: string }, byUser: boolean) => removed.push([t.id, byUser]) });
    const failed = tm.start("a");
    await vi.advanceTimersByTimeAsync(10);
    tm.dismiss(failed.id);
    const ok = manager(() => fakeWorker(async () => ({ success: true, summary: "Done." })), { cardMs: 100, onRemoved: (t: { id: string }, byUser: boolean) => removed.push([t.id, byUser]) });
    const done = ok.tm.start("b");
    await vi.advanceTimersByTimeAsync(200);
    expect(removed).toEqual([[failed.id, true], [done.id, false]]);
    vi.useRealTimers();
  });
});
