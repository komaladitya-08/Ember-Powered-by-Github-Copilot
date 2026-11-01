/**
 * Whether this computer's screen is locked (review #81): Electron's lock events where it has them (Windows, macOS),
 * logind's LockedHint and Active on Linux (GNOME's lock shield sets LockedHint; the X screensaver doesn't see it), read
 * with loginctl and watched by one `gdbus monitor`. What main does on a change (LockController), its notices
 * (holdNotice), and the hands and borrowed input that refuse this screen while it's locked.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hands } from "../../app/main/agent/host";
import {
  LOCKED_SCREEN, LockController, ScreenLock, graphicalSession, holdNotice, lockAwareInput, lockedOutHands, logindLock, parseLoginctl, sessionLocked,
  sessionPath, type MainBubble, type RunText,
} from "../../app/main/screen-lock";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** The clock moves on `ms`, and the answers of what was asked meanwhile come in. */
const after = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe("logind's session state", () => {
  it.each([
    ["LockedHint=yes\nActive=yes\n", true],
    ["Active=no\nLockedHint=no\n", true], // another user's session, or the login screen, is in front
    ["LockedHint=no\nActive=yes\n", false],
    ["Active=yes\n", null], // no LockedHint: can't tell
    ["", null],
  ] as const)("%j is locked: %s", (text, locked) => expect(parseLoginctl(text)).toBe(locked));

  /** loginctl answering as a user with graphical session c2 and `types` for the sessions it's asked about. */
  const loginctl = (types: Record<string, string>) => {
    const asked: string[][] = [];
    const run: RunText = async (cmd, args) => {
      asked.push([cmd, ...args]);
      if (args[0] === "show-user") return "Display=c2\n";
      if (args.includes("Type")) return args[1] in types ? `Type=${types[args[1]]}\n` : null;
      return "LockedHint=yes\nActive=yes\n";
    };
    return { run, asked };
  };

  it("reads the session Ember runs in when it has a screen", async () => {
    const l = loginctl({ "3": "x11" });
    expect(await graphicalSession(l.run, { sessionId: "3", uid: 1000 })).toBe("3");
    expect(await sessionLocked(l.run, "3")).toBe(true);
    expect(l.asked).toEqual([
      ["loginctl", "show-session", "3", "-p", "Type"],
      ["loginctl", "show-session", "3", "-p", "LockedHint", "-p", "Active"],
    ]);
  });

  it("reads the user's graphical session when Ember was started from one without a screen (a terminal's, an SSH login's), or none", async () => {
    // Such a session is never the one in front (Active=no): read, it would keep Ember "locked" for good.
    const l = loginctl({ "7": "tty", "8": "unspecified" });
    expect(await graphicalSession(l.run, { sessionId: "7", uid: 1000 })).toBe("c2");
    expect(await graphicalSession(l.run, { sessionId: "8", uid: 1000 })).toBe("c2");
    expect(await graphicalSession(l.run, { sessionId: "9", uid: 1000 })).toBe("c2"); // gone: can't be read
    expect(await graphicalSession(l.run, { sessionId: undefined, uid: 1000 })).toBe("c2");
    expect(l.asked.filter(a => a[1] === "show-user")).toHaveLength(4);
    expect(await graphicalSession(async () => null, { sessionId: "3", uid: 1000 })).toBeNull();
    expect(await graphicalSession(async () => "Display=../x\n", { sessionId: undefined, uid: 1000 })).toBeNull();
    expect(await sessionLocked(async () => null, "3")).toBeNull();
  });

  it.each([["2", "_32"], ["13", "_313"], ["c2", "c2"], ["c1-x", "c1_2dx"]])("session %s is logind's object …/session/%s", (id, label) => {
    expect(sessionPath(id)).toBe(`/org/freedesktop/login1/session/${label}`);
  });
});

describe("logind's session, watched", () => {
  type Child = EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> };
  /** `gdbus` is each gdbus monitor started; loginctl says session 2 is graphical, and `say` what it says of its lock. */
  function setup(o: { session?: boolean } = {}) {
    const gdbus: { args: string[]; lc: string | undefined; p: Child }[] = [];
    let answer: string | null = "LockedHint=no\nActive=yes\n";
    const reads: string[][] = [];
    const run: RunText = async (_cmd, args) => {
      if (args[0] === "show-user") return o.session === false ? "Display=\n" : "Display=2\n";
      if (args.includes("Type")) return o.session === false ? null : "Type=x11\n";
      reads.push(args);
      return answer;
    };
    const spawn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const p = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
      if (cmd === "gdbus") gdbus.push({ args, lc: opts.env.LC_ALL, p });
      return p as unknown as ChildProcess;
    };
    const changes: boolean[] = [];
    const lock = new ScreenLock({ ...logindLock({ sessionId: "2", uid: 1000, run, spawn }), initial: () => true, onChange: on => changes.push(on) });
    return { lock, gdbus, reads, changes, say: (text: string | null) => { answer = text; } };
  }

  it("watches the session with one gdbus monitor, read again only when its properties change: no program every 2 s (review #81)", async () => {
    const s = setup();
    s.lock.start();
    await after(0);
    expect(s.gdbus.map(g => g.args)).toEqual([["monitor", "--system", "--dest", "org.freedesktop.login1", "--object-path", "/org/freedesktop/login1/session/_32"]]);
    expect(s.gdbus[0].lc).toBe("C");
    expect(s.reads).toHaveLength(1); // once at start
    const out = s.gdbus[0].p.stdout;
    out.emit("data", Buffer.from("Monitoring signals on object /org/freedesktop/login1/session/_32 owned by org.freedesktop.login1\n"));
    out.emit("data", Buffer.from("The name org.freedesktop.login1 is owned by :1.3\n"));
    await after(0);
    expect(s.reads).toHaveLength(2); // the watch began: whatever changed before it is read too
    await after(60_000);
    expect(s.reads).toHaveLength(2);
    s.say("LockedHint=yes\nActive=yes\n");
    out.emit("data", Buffer.from("/org/freedesktop/login1/session/_32: org.freedesktop.DBus.Properties.Prop"));
    out.emit("data", Buffer.from("ertiesChanged ('org.freedesktop.login1.Session', {'LockedHint': <true>}, @as [])\n"));
    await after(0);
    expect(s.lock.locked).toBe(true);
    s.say("LockedHint=no\nActive=yes\n");
    out.emit("data", Buffer.from("/org/freedesktop/login1/session/_32: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'LockedHint': <false>}, @as [])\n"));
    await after(0);
    expect(s.changes).toEqual([true, false]);
    expect(s.reads).toHaveLength(4);
    s.lock.stop();
    expect(s.gdbus[0].p.kill).toHaveBeenCalled();
  });

  it.each([
    ["isn't installed", (p: Child) => p.emit("error", Object.assign(new Error("spawn gdbus ENOENT"), { code: "ENOENT" }))],
    ["stops", (p: Child) => p.emit("exit", 1, null)],
  ])("reads every 5 s when gdbus %s", async (_, end) => {
    const s = setup();
    s.lock.start();
    await after(0);
    end(s.gdbus[0].p);
    await after(4999);
    expect(s.reads).toHaveLength(1);
    await after(1);
    expect(s.reads).toHaveLength(2);
    await after(10_000);
    expect(s.reads).toHaveLength(4);
    s.lock.stop();
    await after(10_000);
    expect(s.reads).toHaveLength(4);
  });

  it("watches and reads nothing without a graphical session, and stays unlocked", async () => {
    const s = setup({ session: false });
    s.lock.start();
    await after(60_000);
    expect(s.gdbus).toHaveLength(0);
    expect(s.lock.locked).toBe(false);
  });

  it("starts unlocked, whatever Electron says, and a first read that can't tell leaves it so (review #81)", async () => {
    // Electron's reading said locked (initial: true), and loginctl can't tell: Ember would have ignored its user until it
    // restarted.
    const s = setup();
    s.say(null);
    s.lock.start();
    expect(s.lock.locked).toBe(false);
    await after(0);
    expect(s.lock.locked).toBe(false);
    expect(s.changes).toEqual([]);
  });
});

describe("ScreenLock", () => {
  it("follows Electron's lock and unlock events, and says each change once", () => {
    const events = new EventEmitter();
    const changes: boolean[] = [];
    const lock = new ScreenLock({ events, initial: () => false, onChange: on => changes.push(on) });
    lock.start();
    expect(lock.locked).toBe(false);
    events.emit("lock-screen");
    events.emit("lock-screen");
    expect(lock.locked).toBe(true);
    events.emit("unlock-screen");
    expect(changes).toEqual([true, false]);
  });

  it("starts locked when the screen already is (Windows, macOS)", () => {
    const lock = new ScreenLock({ events: new EventEmitter(), initial: () => true, onChange: () => undefined });
    lock.start();
    expect(lock.locked).toBe(true);
  });

  it("without a watch, reads every 5 s, and keeps what it knew when a read can't tell", async () => {
    const answers: (boolean | null)[] = [false, true, null, true, false];
    const changes: boolean[] = [];
    const lock = new ScreenLock({ poll: async () => (answers.length ? answers.shift()! : false), onChange: on => changes.push(on) });
    lock.start();
    await after(0);
    expect(lock.locked).toBe(false);
    await after(5000);
    expect(lock.locked).toBe(true);
    await after(5000); // can't tell: still locked
    expect(lock.locked).toBe(true);
    await after(10_000);
    expect(changes).toEqual([true, false]);
    lock.stop();
    answers.push(true);
    await after(30_000);
    expect(changes).toEqual([true, false]);
  });

  it("counts only the latest read's answer", async () => {
    const pending: ((v: boolean) => void)[] = [];
    let changed: () => void = () => undefined;
    const lock = new ScreenLock({
      poll: () => new Promise<boolean>(r => pending.push(r)),
      watch: c => { changed = c; return () => undefined; },
      onChange: () => undefined,
    });
    lock.start();
    changed();
    pending[1](false);
    pending[0](true); // the older read, answering late
    await after(0);
    expect(lock.locked).toBe(false);
  });
});

describe("what main does when the screen locks and unlocks (review #81)", () => {
  function setup(stops: number[]) {
    const calls: string[] = [];
    const notices: string[] = [];
    let stopped = 0;
    const control = new LockController({
      stopDesktopTasks: () => { stopped++; return stops.shift() ?? 0; },
      setLocked: on => calls.push(on ? "locked" : "unlocked"),
      showNotice: n => notices.push(n.thought),
    });
    return { control, calls, notices, stopped: () => stopped };
  }

  it("a lock stops listening and the desktop tasks, and starts the sweep", async () => {
    const s = setup([1]);
    s.control.change(true);
    expect(s.calls).toEqual(["locked"]);
    expect(s.stopped()).toBe(1);
    await after(2000);
    expect(s.stopped()).toBe(2); // a task that turned to the desktop meanwhile
    await after(4000);
    expect(s.stopped()).toBe(4);
    s.control.dispose();
  });

  it("a task the sweep stops counts too: the notice after the unlock says so, once", async () => {
    const s = setup([1, 0, 1]);
    s.control.change(true);
    await after(4000);
    s.control.change(false);
    expect(s.calls).toEqual(["locked", "unlocked"]);
    expect(s.notices).toEqual(["Your screen locked, so I stopped the tasks working on it."]);
    await after(10_000);
    expect(s.stopped()).toBe(3); // the sweep ended with the unlock
    s.control.change(true);
    s.control.change(false);
    expect(s.notices).toHaveLength(1); // counted afresh: nothing stopped this time
  });

  it("one task stopped is said as one", () => {
    const s = setup([1]);
    s.control.change(true);
    s.control.change(false);
    expect(s.notices).toEqual(["Your screen locked, so I stopped the task working on it."]);
  });

  it("a lock and unlock with nothing stopped says nothing", async () => {
    const s = setup([]);
    s.control.change(true);
    await after(6000);
    s.control.change(false);
    expect(s.calls).toEqual(["locked", "unlocked"]);
    expect(s.notices).toEqual([]);
  });
});

describe("main's own notice (review #81)", () => {
  function setup(o: { taskAtWork: boolean }) {
    const log: string[] = [];
    let current: object = {};
    const b: MainBubble<object> = {
      claim: () => log.push("claim"),
      show: x => { current = x; log.push("show"); },
      current: () => current,
      release: () => { log.push("release"); if (o.taskAtWork) current = { progress: true }; return o.taskAtWork; },
      hide: () => { current = {}; log.push("hide"); },
    };
    return { b, log, replace: () => { current = { other: true }; } };
  }

  it("holds the bubble while it shows, and gives it back after: a task at work shows its progress again at once", async () => {
    const s = setup({ taskAtWork: true });
    holdNotice(s.b, { thought: "Your screen locked, so I stopped the task working on it." }, 8000);
    expect(s.log).toEqual(["claim", "show"]);
    await after(8000);
    expect(s.log).toEqual(["claim", "show", "release"]); // not 22 s more of nothing
  });

  it("hides it when nothing else is to show", async () => {
    const s = setup({ taskAtWork: false });
    holdNotice(s.b, {}, 8000);
    await after(8000);
    expect(s.log).toEqual(["claim", "show", "release", "hide"]);
  });

  it("leaves alone what replaced it meanwhile", async () => {
    const s = setup({ taskAtWork: false });
    holdNotice(s.b, {}, 8000);
    s.replace();
    await after(8000);
    expect(s.log).toEqual(["claim", "show"]);
  });
});

describe("this screen's hands while it's locked (review #81)", () => {
  function setup() {
    let locked = false;
    const seen: string[] = [];
    const port = (names: string[]) => Object.fromEntries(names.map(n => [n, vi.fn(async (...a: unknown[]) => { seen.push(n); return { n, a }; })]));
    const perception = port(["focused", "read", "atPoint", "quickContext", "describe", "perceive", "systemDialogOpen", "windows"]);
    const sidecar = { ...port(["readElement", "canDo", "doAction", "setText", "setValue", "selectOption", "listOptions"]), scaleOf: vi.fn(() => 2), stop: vi.fn() };
    const audit = vi.fn();
    const hands = { perception, sidecar, audit, confirmer: {}, policy: {}, flyTo: vi.fn(), currentWindow: () => ({ pid: 7, title: "Inbox" }) } as unknown as Hands;
    return { hands: lockedOutHands(hands, () => locked), seen, sidecar, audit, lock: (on: boolean) => { locked = on; } };
  }

  it("read and act on the screen while it's unlocked, as they are", async () => {
    const s = setup();
    await expect(s.hands.perception.read({ title: "Inbox" })).resolves.toEqual({ n: "read", a: [{ title: "Inbox" }] });
    await expect(s.hands.sidecar.setText(4, "hello")).resolves.toEqual({ n: "setText", a: [4, "hello"] });
    expect(s.hands.currentWindow()).toEqual({ pid: 7, title: "Inbox" });
    expect(s.hands.audit).toBe(s.audit);
  });

  it("refuse every read and step while it's locked, so a task that starts then reads and touches nothing", async () => {
    const s = setup();
    s.lock(true);
    for (const f of [() => s.hands.perception.read({ title: "Inbox" }), () => s.hands.perception.perceive({ image: false, scope: "window" }), () => s.hands.perception.quickContext(),
      () => s.hands.perception.windows(), () => s.hands.sidecar.readElement(4), () => s.hands.sidecar.doAction(4, "click"), () => s.hands.sidecar.setText(4, "hunter2")]) {
      await expect(f()).rejects.toThrow(LOCKED_SCREEN);
    }
    expect(s.seen).toEqual([]);
    expect(s.hands.currentWindow()).toBeNull();
    expect(s.hands.sidecar.scaleOf(4)).toBe(2); // not a read
    s.hands.sidecar.stop();
    expect(s.sidecar.stop).toHaveBeenCalled();
    s.lock(false);
    await expect(s.hands.sidecar.doAction(4, "click")).resolves.toEqual({ n: "doAction", a: [4, "click"] });
  });

  it("keep this screen's reason for its system-dialog check (secure keyboard entry, Wayland), refused while locked too", async () => {
    let locked = false;
    const why = "secure keyboard entry is on in Terminal";
    const perception = { systemDialogOpen: vi.fn(async () => true), systemDialogReason: vi.fn(async () => why) };
    const hands = lockedOutHands({ perception, sidecar: {}, currentWindow: () => null } as unknown as Hands, () => locked);
    await expect(hands.perception.systemDialogReason?.()).resolves.toBe(why);
    locked = true;
    await expect(hands.perception.systemDialogReason?.()).rejects.toThrow(LOCKED_SCREEN);
    expect(perception.systemDialogReason).toHaveBeenCalledTimes(1);
    // A screen that can't say why has none.
    expect(lockedOutHands({ perception: {}, sidecar: {}, currentWindow: () => null } as unknown as Hands, () => false).perception.systemDialogReason).toBeUndefined();
  });

  it("the borrowed mouse's input counts the screen as locked when Ember does, whatever its own check sees", () => {
    let locked = false;
    const input = { pointerLags: true as const, pointer: () => ({ x: 1, y: 2 }), screenLocked: () => false };
    const x = lockAwareInput(input, () => locked);
    expect(x.screenLocked()).toBe(false);
    locked = true;
    expect(x.screenLocked()).toBe(true); // GNOME's lock shield, which the X screensaver doesn't see
    expect(x.pointer()).toEqual({ x: 1, y: 2 });
    expect(x.pointerLags).toBe(true);
    locked = false;
    expect(lockAwareInput({ screenLocked: () => true }, () => locked).screenLocked()).toBe(true);
    expect(lockAwareInput({} as { screenLocked?(): boolean }, () => true).screenLocked?.()).toBe(true); // an input without a check of its own
  });
});
