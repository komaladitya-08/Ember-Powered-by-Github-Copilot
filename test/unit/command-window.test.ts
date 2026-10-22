/**
 * The command window's controller (app/main/commands/window.ts; \u00a73.9-\u00a73.10, R1, R7): who it takes messages from, when
 * the approve chord's guard (cardReady) holds, when Allow counts, the announcement's countdown and its Stop, one card at
 * a time, and each run's tab (output, typing, Stop, Close). Plain Node with fakes for the window and ipcMain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS_IPC } from "../../app/shared/commands";
import { COMMANDS_EXTRA_IPC, type AnswerMsg, type OutputMsg, type Snapshot, type WindowView } from "../../app/renderer/command/model";
import { MAX_TABS, createCommandWindowController, createCommandWindowPort, outcomeOf, typedPieces, validCard } from "../../app/main/commands/window";
import type { BrowserWindowLike, IpcLike, WebContentsLike } from "../../app/main/targets/types";
import type { CommandCard, RunExit, RunningCommand } from "../../app/main/commands/types";
import type { Logger } from "../../app/main/logger";

type Handler = (event: { sender: WebContentsLike }, ...args: unknown[]) => unknown;

class FakeIpc implements IpcLike {
  ons = new Map<string, Handler[]>();
  handles = new Map<string, Handler>();
  on(channel: string, fn: Handler) { this.ons.set(channel, [...(this.ons.get(channel) ?? []), fn]); }
  handle(channel: string, fn: Handler) {
    if (this.handles.has(channel)) throw new Error(`second handler for ${channel}`);
    this.handles.set(channel, fn);
  }
  send(channel: string, sender: WebContentsLike, ...args: unknown[]) { for (const fn of this.ons.get(channel) ?? []) fn({ sender }, ...args); }
  invoke(channel: string, sender: WebContentsLike, ...args: unknown[]) { return this.handles.get(channel)!({ sender }, ...args); }
}

class FakeContents implements WebContentsLike {
  sent: { channel: string; args: unknown[] }[] = [];
  constructor(readonly id: number) {}
  send(channel: string, ...args: unknown[]) { this.sent.push({ channel, args }); }
  states(): WindowView[] { return this.sent.filter(s => s.channel === COMMANDS_IPC.state).map(s => s.args[0] as WindowView); }
  last(): WindowView { const s = this.states(); return s[s.length - 1]; }
  outputs(): OutputMsg[] { return this.sent.filter(s => s.channel === COMMANDS_IPC.output).map(s => s.args[0] as OutputMsg); }
}

let nextId = 100;
class FakeWindow implements BrowserWindowLike {
  webContents = new FakeContents(nextId++);
  visible = false; minimized = false; destroyed = false; onTop = false; focused = false;
  calls: string[] = [];
  private handlers = new Map<string, (() => void)[]>();
  show() { this.visible = true; this.calls.push("show"); }
  showInactive() { this.visible = true; this.minimized = false; this.calls.push("showInactive"); }
  hide() { this.visible = false; this.calls.push("hide"); }
  focus() { this.focused = true; this.calls.push("focus"); }
  close() { this.destroyed = true; this.visible = false; this.calls.push("close"); this.emit("closed"); }
  moveTop() { this.calls.push("moveTop"); }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  isDestroyed() { return this.destroyed; }
  isAlwaysOnTop() { return this.onTop; }
  isFocused() { return this.focused; }
  setAlwaysOnTop(flag: boolean) { this.onTop = flag; this.calls.push(`top:${flag}`); }
  setBounds() { /* not used */ }
  setContentProtection() { /* windows.ts sets it */ }
  on(event: string, fn: () => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]); }
  emit(event: string) { for (const fn of this.handlers.get(event) ?? []) fn(); }
}

const logs: { level: string; msg: string; fields?: unknown }[] = [];
const log: Logger = {
  debug: (msg, fields) => logs.push({ level: "debug", msg, fields }),
  info: (msg, fields) => logs.push({ level: "info", msg, fields }),
  warn: (msg, fields) => logs.push({ level: "warn", msg, fields }),
  error: (msg, fields) => logs.push({ level: "error", msg, fields }),
  child: () => log,
  file: "",
};

const SHA = "a".repeat(64);
const card = (over: Partial<CommandCard> = {}): CommandCard => ({
  runId: "0123456789abcdef", target: "ssh:build-01", targetLabel: "build-01", login: "deploy", shell: "bash", cwd: "/home/deploy/src/app",
  command: "rm -r build", sha256: SHA, taskId: "t1", taskTitle: "Clean the build", mode: "ask", says: ["Deletes build and everything in it."],
  unasked: true, armMs: 600, ...over,
});

class FakeRun implements RunningCommand {
  inputs: Uint8Array[] = [];
  stops: string[] = [];
  private fns: ((c: Uint8Array) => void)[] = [];
  private end!: (e: RunExit) => void;
  readonly done = new Promise<RunExit>(r => { this.end = r; });
  constructor(readonly runId: string, readonly interactive = true) {}
  onOutput(fn: (c: Uint8Array) => void) { this.fns.push(fn); return () => { this.fns = this.fns.filter(f => f !== fn); }; }
  emit(text: string) { for (const f of this.fns) f(new TextEncoder().encode(text)); }
  get listeners() { return this.fns.length; }
  input(bytes: Uint8Array) { this.inputs.push(bytes); }
  typedLines() { return []; }
  forgetTyped() { /* not used */ }
  stop(why: "user" | "task" | "killswitch" | "timeout") { this.stops.push(why); }
  finish(e: Partial<RunExit> = {}) { this.end({ code: 0, signal: null, ended: "exit", ms: 3200, ...e }); }
}

function setup(o: { keyHint?: () => string | null } = {}) {
  const ipc = new FakeIpc();
  const windows: FakeWindow[] = [];
  const ctl = createCommandWindowController({
    create: () => { const w = new FakeWindow(); windows.push(w); return w; },
    ipc, log, os: "linux", keyHint: o.keyHint ?? (() => "Ctrl+Alt+Y allow · Ctrl+Alt+N not now"),
  });
  const win = () => windows[windows.length - 1];
  const page = () => win().webContents;
  /** The page says the card's whole command is (or isn't) in view. */
  const seen = (n: number, inView = true, isSeen = true) => ipc.send(COMMANDS_IPC.cardSeen, page(), { n, inView, seen: isSeen });
  const answers: AnswerMsg[] = [];
  ctl.onAnswer(a => answers.push(a));
  return { ipc, ctl, windows, win, page, seen, answers };
}

beforeEach(() => { vi.useFakeTimers(); logs.length = 0; });
afterEach(() => { vi.useRealTimers(); });

describe("the command window's sender checks", () => {
  it("takes every page message only from its own window's page (critique integration-5)", async () => {
    const { ipc, ctl, page, seen, answers } = setup();
    const stranger = new FakeContents(9999);
    const run = new FakeRun("0123456789abcdef");
    ctl.attach(card(), run);
    ctl.showCard(1, card());
    vi.advanceTimersByTime(1000);
    // From another page: nothing happens.
    ipc.send(COMMANDS_IPC.cardSeen, stranger, { n: 1, inView: true, seen: true });
    expect(ctl.cardReady(1)).toBe(false);
    ipc.send(COMMANDS_IPC.answer, stranger, { n: 1, answer: "once", sha256: SHA });
    ipc.send(COMMANDS_IPC.input, stranger, { runId: run.runId, data: "secret\r" });
    ipc.send(COMMANDS_IPC.stop, stranger, { runId: run.runId });
    ipc.send(COMMANDS_EXTRA_IPC.size, stranger, { cols: 80, rows: 24 });
    expect(ipc.invoke(COMMANDS_IPC.state, stranger)).toBeNull();
    expect(answers).toEqual([]);
    expect(run.inputs).toEqual([]);
    expect(run.stops).toEqual([]);
    expect(ctl.termSize()).toEqual({ cols: 100, rows: 30 });
    expect(logs.filter(l => l.msg === "commands.ipc_refused").map(l => (l.fields as { channel: string }).channel).sort())
      .toEqual([COMMANDS_IPC.answer, COMMANDS_IPC.cardSeen, COMMANDS_IPC.input, COMMANDS_EXTRA_IPC.size, COMMANDS_IPC.state, COMMANDS_IPC.stop].sort());
    // From its own page: each one counts.
    seen(1);
    ipc.send(COMMANDS_IPC.answer, page(), { n: 1, answer: "once", sha256: SHA });
    expect(answers).toEqual([{ n: 1, answer: "once", sha256: SHA }]);
    expect(ctl.owns(page())).toBe(true);
    expect(ctl.owns(stranger)).toBe(false);
  });

  it("owns no sender before its window exists or after it closed", () => {
    const { ctl, win } = setup();
    expect(ctl.owns(new FakeContents(100))).toBe(false);
    ctl.show();
    const contents = win().webContents;
    expect(ctl.owns(contents)).toBe(true);
    win().close();
    expect(ctl.owns(contents)).toBe(false);
  });

  it("takes only well-formed messages: odd types and sizes are dropped", () => {
    const { ipc, ctl, page, answers } = setup();
    const run = new FakeRun("0123456789abcdef");
    ctl.attach(card(), run);
    for (const bad of [null, "x", 1, { n: "1", answer: "deny", sha256: SHA }, { n: 1, answer: "always", sha256: SHA }, { n: 1, answer: "deny", sha256: "x" }]) {
      ipc.send(COMMANDS_IPC.answer, page(), bad);
    }
    ipc.send(COMMANDS_IPC.input, page(), { runId: "nope", data: "x" });
    ipc.send(COMMANDS_IPC.input, page(), { runId: run.runId, data: 5 });
    ipc.send(COMMANDS_IPC.input, page(), { runId: run.runId, data: "x".repeat(64 * 1024 + 1) });
    expect(answers).toEqual([]);
    expect(run.inputs).toEqual([]);
  });

  it("registers one invoke handler (the page's pull) and listens on its own channels only, once a window exists", () => {
    const { ipc, ctl } = setup();
    expect(ipc.handles.size + ipc.ons.size).toBe(0);
    ctl.show();
    ctl.show();
    expect([...ipc.handles.keys()]).toEqual([COMMANDS_IPC.state]);
    for (const ch of ipc.ons.keys()) expect(ch).toMatch(/^commands:/);
  });
});

describe("cardReady (the approve chord's guard, R7)", () => {
  function ready() {
    const s = setup();
    s.ctl.showCard(7, card());
    s.seen(7);
    return s;
  }

  it("holds while the card is up, on top, not minimised and its whole command is in view", () => {
    const { ctl, win } = ready();
    expect(win().onTop).toBe(true);
    expect(ctl.cardReady(7)).toBe(true);
  });

  it("fails for another question, a hidden or minimised window, or one neither on top nor focused", () => {
    const { ctl, win } = ready();
    expect(ctl.cardReady(8)).toBe(false);
    win().minimized = true;
    expect(ctl.cardReady(7)).toBe(false);
    win().minimized = false;
    win().visible = false;
    expect(ctl.cardReady(7)).toBe(false);
    win().visible = true;
    win().onTop = false;
    expect(ctl.cardReady(7)).toBe(false);
    win().focused = true;
    expect(ctl.cardReady(7)).toBe(true);
  });

  it("fails until the page says the whole command is in view, and again when it no longer is", () => {
    const { ctl, seen } = setup();
    ctl.showCard(3, card());
    expect(ctl.cardReady(3)).toBe(false);
    seen(3, false, true);
    expect(ctl.cardReady(3)).toBe(false);
    seen(3, true, true);
    expect(ctl.cardReady(3)).toBe(true);
    seen(3, false, true);
    expect(ctl.cardReady(3)).toBe(false);
  });

  it("never takes 'in view' without 'seen', and 'seen' sticks for the card", () => {
    const { ctl, seen } = setup();
    ctl.showCard(3, card());
    seen(3, true, false);
    expect(ctl.cardReady(3)).toBe(false);
    seen(3, false, true);
    seen(3, true, false);
    expect(ctl.cardReady(3)).toBe(true);
  });

  it("forgets the page's report when the card changes, hides, or the window closes", () => {
    const { ctl, seen, win } = setup();
    ctl.showCard(3, card());
    seen(3);
    ctl.showCard(4, card({ sha256: "b".repeat(64) }));
    expect(ctl.cardReady(3)).toBe(false);
    expect(ctl.cardReady(4)).toBe(false);
    seen(4);
    expect(ctl.cardReady(4)).toBe(true);
    ctl.hideCard(4);
    expect(ctl.cardReady(4)).toBe(false);
    ctl.showCard(5, card());
    seen(5);
    win().close();
    expect(ctl.cardReady(5)).toBe(false);
  });
});

describe("Allow", () => {
  it("counts only once the card is armed and its whole command was seen, with the card's own hash", () => {
    const { ipc, ctl, page, seen, answers } = setup();
    ctl.showCard(1, card({ armMs: 1500 }));
    const allow = (over: Record<string, unknown> = {}) => ipc.send(COMMANDS_IPC.answer, page(), { n: 1, answer: "once", sha256: SHA, ...over });
    allow();
    seen(1);
    allow();
    expect(answers).toEqual([]);
    vi.advanceTimersByTime(1500);
    allow({ sha256: "b".repeat(64) });
    allow({ n: 2 });
    expect(answers).toEqual([]);
    allow();
    expect(answers).toEqual([{ n: 1, answer: "once", sha256: SHA }]);
    expect(logs.some(l => l.msg === "commands.allow_too_early")).toBe(true);
  });

  it("needs the page to have seen the whole command, even after the arm time", () => {
    const { ipc, ctl, page, seen, answers } = setup();
    ctl.showCard(1, card());
    vi.advanceTimersByTime(5000);
    seen(1, false, false);
    ipc.send(COMMANDS_IPC.answer, page(), { n: 1, answer: "once", sha256: SHA });
    expect(answers).toEqual([]);
  });

  it("takes Not now at any time for the card on screen", () => {
    const { ipc, ctl, page, answers } = setup();
    ctl.showCard(1, card());
    ipc.send(COMMANDS_IPC.answer, page(), { n: 1, answer: "deny", sha256: SHA });
    expect(answers).toEqual([{ n: 1, answer: "deny", sha256: SHA }]);
  });

  it("is never taken for a card that isn't on screen", () => {
    const { ipc, ctl, page, seen, answers } = setup();
    ctl.showCard(1, card());
    seen(1);
    vi.advanceTimersByTime(1000);
    ctl.hideCard(1);
    ipc.send(COMMANDS_IPC.answer, page(), { n: 1, answer: "once", sha256: SHA });
    expect(answers).toEqual([]);
  });
});

describe("one card at a time", () => {
  it("shows the newest question and drops the old one's state", () => {
    const { ctl, page } = setup();
    ctl.showCard(1, card());
    ctl.showCard(2, card({ command: "git push --force", sha256: "c".repeat(64) }));
    expect(page().last().card).toMatchObject({ n: 2, command: "git push --force" });
    ctl.hideCard(1);
    expect(page().last().card?.n).toBe(2);
    ctl.hideCard(2);
    expect(page().last().card).toBeNull();
  });

  it("refuses a malformed card: nothing shows, so nothing can be allowed", () => {
    const { ctl, windows } = setup();
    ctl.showCard(1, { ...card(), sha256: "nope" });
    ctl.showCard(2, { ...card(), says: "Deletes" as unknown as string[] });
    ctl.showCard(-1, card());
    expect(windows).toHaveLength(0);
    expect(ctl.cardReady(1)).toBe(false);
    expect(validCard(card())).toBe(true);
    expect(validCard({ ...card(), runId: "0123" })).toBe(false);
    expect(validCard({ ...card(), command: "" })).toBe(false);
  });

  it("brings the window up without taking the keyboard, on top while the card shows, and lets it go after", () => {
    const { ctl, win } = setup();
    ctl.showCard(1, card());
    expect(win().calls).toEqual(["top:true", "showInactive", "moveTop"]);
    expect(win().focused).toBe(false);
    ctl.hideCard(1);
    expect(win().onTop).toBe(false);
    // Nothing else in it: it goes away again.
    expect(win().visible).toBe(false);
  });

  it("shows the key hint only while a card is up", () => {
    const { ctl, page } = setup();
    ctl.show();
    expect(page().last().keyHint).toBeNull();
    ctl.showCard(1, card());
    expect(page().last().keyHint).toBe("Ctrl+Alt+Y allow · Ctrl+Alt+N not now");
    const quiet = setup({ keyHint: () => null });
    quiet.ctl.showCard(1, card());
    expect(quiet.page().last().keyHint).toBeNull();
  });
});

describe("announcing (D4.4, \u00a73.9.2)", () => {
  it("resolves true when the time runs out, showing the countdown meanwhile", async () => {
    const { ctl, page, win } = setup();
    const p = ctl.announce(card({ mode: "announce" }), 4000, new AbortController().signal);
    expect(page().last().announce).toMatchObject({ card: { runId: "0123456789abcdef" }, endsAt: Date.now() + 4000 });
    expect(win().onTop).toBe(true);
    vi.advanceTimersByTime(3999);
    let settled = false;
    void p.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(p).resolves.toBe(true);
    expect(page().last().announce).toBeNull();
  });

  it("resolves false on the page's Stop, on cancelAnnounce, on the signal and when the window closes", async () => {
    const a = setup();
    const p1 = a.ctl.announce(card(), 4000, new AbortController().signal);
    a.ipc.send(COMMANDS_IPC.stop, a.page(), { runId: "0123456789abcdef" });
    await expect(p1).resolves.toBe(false);

    const b = setup();
    const p2 = b.ctl.announce(card(), 4000, new AbortController().signal);
    b.ctl.cancelAnnounce("0123456789abcdef");
    await expect(p2).resolves.toBe(false);

    const c = setup();
    const ac = new AbortController();
    const p3 = c.ctl.announce(card(), 4000, ac.signal);
    ac.abort();
    await expect(p3).resolves.toBe(false);
    const done = new AbortController();
    done.abort();
    await expect(c.ctl.announce(card(), 4000, done.signal)).resolves.toBe(false);

    const d = setup();
    const p4 = d.ctl.announce(card(), 4000, new AbortController().signal);
    d.win().close();
    await expect(p4).resolves.toBe(false);

    const e = setup();
    const p5 = e.ctl.announce(card(), 4000, new AbortController().signal);
    e.ctl.dispose();
    await expect(p5).resolves.toBe(false);
  });

  it("ends every waiting announcement when the window is closed, without opening it again", async () => {
    const { ctl, windows } = setup();
    const first = ctl.announce(card(), 4000, new AbortController().signal);
    const second = ctl.announce(card({ runId: "fedcba9876543210" }), 4000, new AbortController().signal);
    windows[0].close();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(windows).toHaveLength(1);
    const third = ctl.announce(card(), 4000, new AbortController().signal);
    const fourth = ctl.announce(card({ runId: "fedcba9876543210" }), 4000, new AbortController().signal);
    ctl.dispose();
    await expect(third).resolves.toBe(false);
    await expect(fourth).resolves.toBe(false);
    expect(windows).toHaveLength(2);
  });

  it("counts down one announcement at a time, each for its whole time once shown", async () => {
    const { ctl, page } = setup();
    const first = ctl.announce(card(), 4000, new AbortController().signal);
    const second = ctl.announce(card({ runId: "fedcba9876543210" }), 4000, new AbortController().signal);
    expect(page().last().announce?.card.runId).toBe("0123456789abcdef");
    vi.advanceTimersByTime(4000);
    await expect(first).resolves.toBe(true);
    expect(page().last().announce).toMatchObject({ card: { runId: "fedcba9876543210" }, endsAt: Date.now() + 4000 });
    ctl.cancelAnnounce("fedcba9876543210");
    await expect(second).resolves.toBe(false);
  });

  it("doesn't let a command run when there is no window to count down in", async () => {
    const ctl = createCommandWindowController({ create: () => { throw new Error("no display"); }, ipc: new FakeIpc(), log, os: "linux", keyHint: () => null });
    await expect(ctl.announce(card(), 4000, new AbortController().signal)).resolves.toBe(false);
    ctl.showCard(1, card());
    expect(ctl.cardReady(1)).toBe(false);
    expect(logs.some(l => l.msg === "commands.window_failed")).toBe(true);
  });

  it("refuses to announce a malformed card", async () => {
    const { ctl } = setup();
    await expect(ctl.announce({ ...card(), runId: "x" }, 4000, new AbortController().signal)).resolves.toBe(false);
  });
});

describe("a run's tab", () => {
  it("shows the header, Running…, then the status line from how it ended", async () => {
    const { ctl, page } = setup();
    const run = new FakeRun("0123456789abcdef", true);
    ctl.attach(card(), run);
    expect(page().last().tabs[0]).toMatchObject({
      runId: run.runId, header: "On build-01 as deploy · bash · in /home/deploy/src/app", status: "Running…", interactive: true, ended: false,
      title: "Clean the build", typing: "Type here to answer the command. Ember never sees what you type.", outcome: "running",
    });
    run.finish({ code: 2, ms: 1100 });
    await vi.runAllTimersAsync();
    expect(page().last().tabs[0]).toMatchObject({ status: "Ended with exit code 2 after 1.1 s.", interactive: false, ended: true, typing: "", outcome: "failed" });
  });

  it("sends output in batches with its byte offsets, and a reloading page gets the rest whole", () => {
    const { ipc, ctl, page } = setup();
    const run = new FakeRun("0123456789abcdef");
    ctl.attach(card(), run);
    run.emit("hello ");
    run.emit("world\r\n");
    expect(page().outputs()).toEqual([]);
    vi.advanceTimersByTime(20);
    const out = page().outputs();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ runId: run.runId, at: 0 });
    expect(new TextDecoder().decode(out[0].bytes)).toBe("hello world\r\n");
    run.emit("more");
    const snap = ipc.invoke(COMMANDS_IPC.state, page()) as Snapshot;
    expect(snap.state.tabs).toHaveLength(1);
    expect(snap.replay).toHaveLength(1);
    expect(new TextDecoder().decode(snap.replay[0].bytes)).toBe("hello world\r\nmore");
    // What was pending went out with the pull, at its own offset.
    expect(page().outputs().at(-1)).toMatchObject({ at: 13 });
  });

  it("keeps only the newest 256 KiB of a run for a reloading page", () => {
    const { ipc, ctl, page } = setup();
    const run = new FakeRun("0123456789abcdef");
    ctl.attach(card(), run);
    for (let i = 0; i < 40; i++) run.emit("x".repeat(10_000));
    const snap = ipc.invoke(COMMANDS_IPC.state, page()) as Snapshot;
    expect(snap.replay[0].bytes.length).toBe(256 * 1024);
    expect(snap.replay[0].at).toBe(400_000 - 256 * 1024);
  });

  it("passes typing only to a live run that takes it, in pieces of at most 4 KiB, and never logs it", async () => {
    const { ipc, ctl, page } = setup();
    const run = new FakeRun("0123456789abcdef", true);
    const pipe = new FakeRun("fedcba9876543210", false);
    ctl.attach(card(), run);
    ctl.attach(card({ runId: pipe.runId }), pipe);
    ipc.send(COMMANDS_IPC.input, page(), { runId: run.runId, data: "hunter2\r" });
    ipc.send(COMMANDS_IPC.input, page(), { runId: pipe.runId, data: "hunter2\r" });
    expect(run.inputs.map(b => new TextDecoder().decode(b))).toEqual(["hunter2\r"]);
    expect(pipe.inputs).toEqual([]);
    ipc.send(COMMANDS_IPC.input, page(), { runId: run.runId, data: "é".repeat(5000) });
    expect(run.inputs.slice(1).map(b => b.length)).toEqual([4096, 4096, 1808]);
    run.finish();
    await vi.runAllTimersAsync();
    ipc.send(COMMANDS_IPC.input, page(), { runId: run.runId, data: "late" });
    expect(run.inputs).toHaveLength(4);
    expect(JSON.stringify(logs)).not.toContain("hunter2");
    expect(typedPieces("ab", 1).map(b => [...b])).toEqual([[97], [98]]);
    expect(typedPieces("€", 1).map(b => b.length)).toEqual([3]);
  });

  it("stops a live run from its Stop and closes only a finished tab", async () => {
    const { ipc, ctl, page } = setup();
    const run = new FakeRun("0123456789abcdef");
    ctl.attach(card(), run);
    ipc.send(COMMANDS_IPC.close, page(), { runId: run.runId });
    expect(page().last().tabs).toHaveLength(1);
    ipc.send(COMMANDS_IPC.stop, page(), { runId: run.runId });
    expect(run.stops).toEqual(["user"]);
    run.finish({ ended: "stopped-user", code: null, ms: 12_000 });
    await vi.runAllTimersAsync();
    expect(page().last().tabs[0].status).toBe("You stopped it after 12 s. What it already changed stays.");
    ipc.send(COMMANDS_IPC.close, page(), { runId: run.runId });
    expect(page().last().tabs).toHaveLength(0);
    expect(run.listeners).toBe(0);
  });

  it("keeps the newest 20 tabs, dropping finished ones first and never one still running", async () => {
    const { ctl, page } = setup();
    const runs: FakeRun[] = [];
    for (let i = 0; i < MAX_TABS + 3; i++) {
      const id = i.toString(16).padStart(16, "0");
      const r = new FakeRun(id);
      runs.push(r);
      ctl.attach(card({ runId: id }), r);
      if (i >= 2) { r.finish(); await vi.runAllTimersAsync(); }
    }
    const ids = page().last().tabs.map(t => t.runId);
    expect(ids).toHaveLength(MAX_TABS);
    // The two runs still going stay; the oldest finished ones went.
    expect(ids).toContain(runs[0].runId);
    expect(ids).toContain(runs[1].runId);
    expect(ids[0]).toBe(runs[runs.length - 1].runId);
  });

  it("shows a note while running (a distro starting) and the size the page said fits", () => {
    const { ipc, ctl, page } = setup();
    ctl.show();
    ipc.send(COMMANDS_EXTRA_IPC.size, page(), { cols: 132, rows: 40 });
    ipc.send(COMMANDS_EXTRA_IPC.size, page(), { cols: 5, rows: 40 });
    expect(ctl.termSize()).toEqual({ cols: 132, rows: 40 });
    const run = new FakeRun("0123456789abcdef");
    ctl.attach(card({ target: "wsl:Ubuntu", targetLabel: "Ubuntu (WSL)" }), run);
    expect(page().last().tabs[0]).toMatchObject({ cols: 132, rows: 40, header: "In Ubuntu (WSL) · bash · in /home/deploy/src/app" });
    ctl.note(run.runId, "Starting Ubuntu…");
    expect(page().last().tabs[0].status).toBe("Starting Ubuntu…");
    ctl.note(run.runId, null);
    expect(page().last().tabs[0].status).toBe("Running…");
  });

  it("names how a run ended for its tab's symbol", () => {
    expect(outcomeOf({ code: 0, signal: null, ended: "exit", ms: 1 })).toBe("done");
    expect(outcomeOf({ code: 1, signal: null, ended: "exit", ms: 1 })).toBe("failed");
    expect(outcomeOf({ code: null, signal: null, ended: "killswitch", ms: 1 })).toBe("stopped");
    expect(outcomeOf({ code: null, signal: null, ended: "lost", ms: 1 })).toBe("failed");
    expect(outcomeOf(null)).toBe("failed");
  });
});

describe("the window's life", () => {
  it("makes no window until something needs one (commands off: nothing new on screen)", () => {
    const { windows, ctl } = setup();
    expect(windows).toHaveLength(0);
    expect(ctl.cardReady(1)).toBe(false);
    ctl.hideCard(1);
    ctl.cancelAnnounce("0123456789abcdef");
    expect(windows).toHaveLength(0);
  });

  it("makes a new window after the user closed it, and the new page can pull the state", () => {
    const { ipc, ctl, windows, page } = setup();
    ctl.showCard(1, card());
    windows[0].close();
    ctl.show();
    expect(windows).toHaveLength(2);
    expect(windows[1].calls).toEqual(["show", "moveTop", "focus"]);
    const snap = ipc.invoke(COMMANDS_IPC.state, page()) as Snapshot;
    expect(snap.state.card?.n).toBe(1);
  });

  it("closes the window and stops taking messages once disposed", () => {
    const { ipc, ctl, win, page, answers } = setup();
    ctl.showCard(1, card());
    const contents = page();
    ctl.dispose();
    expect(win().destroyed).toBe(true);
    ipc.send(COMMANDS_IPC.answer, contents, { n: 1, answer: "deny", sha256: SHA });
    expect(answers).toEqual([]);
    ctl.showCard(2, card());
    expect(ctl.cardReady(2)).toBe(false);
  });

  it("has the contract's factory return the same controller", () => {
    const ipc = new FakeIpc();
    const port = createCommandWindowPort({ create: () => new FakeWindow(), ipc, log, os: "win32", keyHint: () => null });
    for (const k of ["showCard", "hideCard", "cardReady", "announce", "cancelAnnounce", "attach", "show", "owns", "dispose"]) {
      expect(typeof (port as unknown as Record<string, unknown>)[k]).toBe("function");
    }
  });
});
