import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { DesktopController, DISCOVERY_MS, WATCH_MS, type DesktopAsk, type DesktopDeps } from "../../app/remote/desktop";
import { IpcError, type ChildPolicy, type InitResult } from "../../app/remote/desktop-ipc";
import type { DesktopFound, NoDesktop } from "../../app/remote/desktop-linux";
import type { DesktopState } from "../../app/main/remote/protocol";
import type { Logger } from "../../app/main/logger";

const POLICY: ChildPolicy = {
  neverLook: ["secret"],
  actionsAllowed: true,
  confirmEveryAction: true,
  maxActionsPerMinute: 5,
  screenImages: false,
};
const ASK: DesktopAsk = { pc: "ana-laptop", allowed: true, consent: false, policy: POLICY };
const OFF_WHY = "An administrator turned off Ember's use of build-01's screen: it can run commands there.";
const SESSION = { id: "2", type: "x11" as const, locked: false as const, active: true as const };

function found(o: Partial<DesktopFound> = {}): DesktopFound {
  return { access: "screen", session: SESSION, env: { DISPLAY: ":0" }, ...o };
}
function noDesktop(why: string, session?: NoDesktop["session"]): NoDesktop {
  return { access: "none", why, ...(session ? { session } : {}) };
}

interface LogEntry { level: "debug" | "info" | "warn" | "error"; event: string; fields?: unknown }
function makeLog() {
  const entries: LogEntry[] = [];
  const log = {
    debug: (event: string, fields?: unknown) => { entries.push({ level: "debug", event, fields }); },
    info: (event: string, fields?: unknown) => { entries.push({ level: "info", event, fields }); },
    warn: (event: string, fields?: unknown) => { entries.push({ level: "warn", event, fields }); },
    error: (event: string, fields?: unknown) => { entries.push({ level: "error", event, fields }); },
    child() { return log; },
  } as unknown as Logger;
  return { log, entries };
}

function rig(o: Partial<DesktopDeps> = {}) {
  const changes: DesktopState[] = [];
  const { log, entries } = makeLog();
  let consoleStops = 0;
  let now = 0;
  const deps: DesktopDeps = {
    unavailable: null,
    host: "build-01",
    discover: async () => found(),
    spawnChild: () => fakeChild().proc,
    baseEnv: {},
    scripts: { atspi: "/a.py", notice: "/n.py" },
    audit: async () => {},
    changed: s => { changes.push(s); },
    consoleStop: () => { consoleStops++; },
    log,
    now: () => now,
    every: () => ({ stop: () => {} }),
    ...o,
  };
  const c = new DesktopController(deps);
  return { c, deps, changes, entries, log, get consoleStops() { return consoleStops; }, setNow: (n: number) => { now = n; } };
}

interface WireMessage {
  t?: "req" | "res" | "ev";
  id?: number;
  op?: string;
  a?: unknown;
  ok?: boolean;
  v?: unknown;
  e?: { code?: string; m?: string };
  ev?: string;
  d?: unknown;
}

const HANDLED = Symbol("handled");
type Handled = typeof HANDLED;
type Handler = (op: string, a: unknown, id: number, c: FakeChild) => unknown | Promise<unknown> | Handled;

interface FakeChild {
  proc: ChildProcess & { kill: Mock };
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  requests: { op: string; a: unknown }[];
  messages: WireMessage[];
  reply(id: number, v: unknown): void;
  fail(id: number, code: string, m: string): void;
  event(ev: string, d?: unknown): void;
  request(op: string, a: unknown, id?: number): number;
  exit(code?: number | null, signal?: NodeJS.Signals | null): void;
}

/** The child end of desktop-ipc.ts over in-memory pipes: it answers requests and can send events/requests. */
function fakeChild(o: { pid?: number; handle?: Handler; init?: InitResult | (() => InitResult | Promise<InitResult>) } = {}): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: { op: string; a: unknown }[] = [];
  const messages: WireMessage[] = [];
  let nextId = 1000;
  const proc = Object.assign(new EventEmitter(), {
    stdin, stdout, stderr,
    pid: o.pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(),
  });
  const child: FakeChild = {
    proc: proc as unknown as FakeChild["proc"],
    stdin, stdout, stderr, requests, messages,
    reply(id, v) { if (!stdout.writableEnded) stdout.write(`${JSON.stringify({ t: "res", id, ok: true, v })}\n`); },
    fail(id, code, m) { if (!stdout.writableEnded) stdout.write(`${JSON.stringify({ t: "res", id, ok: false, e: { code, m } })}\n`); },
    event(ev, d) { if (!stdout.writableEnded) stdout.write(`${JSON.stringify({ t: "ev", ev, d })}\n`); },
    request(op, a, id = nextId++) { stdout.write(`${JSON.stringify({ t: "req", id, op, a })}\n`); return id; },
    exit(code = 0, signal = null) { proc.exitCode = code; proc.signalCode = signal; proc.emit("exit", code, signal); },
  };
  const fallback: InitResult = { access: "screen", notice: "shown" };
  const handler: Handler = o.handle ?? (op => {
    if (op !== "init") return {};
    return typeof o.init === "function" ? o.init() : o.init ?? fallback;
  });
  readline.createInterface({ input: stdin }).on("line", line => {
    let m: WireMessage;
    try { m = JSON.parse(line) as WireMessage; } catch { return; }
    messages.push(m);
    if (m.t !== "req" || typeof m.id !== "number" || typeof m.op !== "string") return;
    const id = m.id;
    const op = m.op;
    requests.push({ op, a: m.a });
    let r: unknown;
    try {
      r = handler(op, m.a, id, child);
    } catch (err) {
      child.fail(id, err instanceof IpcError ? err.code : "internal", err instanceof Error ? err.message : String(err));
      return;
    }
    if (r === HANDLED) return;
    Promise.resolve(r).then(
      v => child.reply(id, v ?? {}),
      (err: unknown) => child.fail(id, err instanceof IpcError ? err.code : "internal", err instanceof Error ? err.message : String(err)),
    );
  });
  return child;
}

async function until(fn: () => boolean, tries = 500): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await new Promise(r => setImmediate(r));
  }
  throw new Error("condition not met");
}

const response = (child: FakeChild, id: number) => child.messages.find(m => m.t === "res" && m.id === id);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("desktop preview and discovery", () => {
  it("says a machine that offers no desktop at all does so without looking", async () => {
    const discover = vi.fn(async () => found());
    const r = rig({ unavailable: "macOS offers no remote desktop to Ember.", discover });
    expect(await r.c.preview(true)).toEqual({ access: "none", why: "macOS offers no remote desktop to Ember.", notice: "off" });
    expect(discover).not.toHaveBeenCalled();
    expect(r.c.state).toEqual({ access: "none", why: "macOS offers no remote desktop to Ember.", notice: "off" });
  });

  it("says the administrator turned the screen off when the PC may not use it", async () => {
    const discover = vi.fn(async () => found());
    const r = rig({ discover });
    expect(await r.c.preview(false)).toEqual({ access: "none", why: OFF_WHY, notice: "off" });
    expect(discover).not.toHaveBeenCalled();
  });

  it("previews discovery's reason and session, or the desktop it found", async () => {
    const locked = { type: "x11" as const, locked: true, active: true };
    const discover = vi.fn(async (): Promise<DesktopFound | NoDesktop> => noDesktop("build-01's screen is locked.", locked));
    const r = rig({ discover });
    expect(await r.c.preview(true)).toEqual({ access: "none", why: "build-01's screen is locked.", session: locked, notice: "off" });

    discover.mockResolvedValue(found({ access: "text" }));
    expect(await r.c.preview(true)).toEqual({
      access: "text", session: { type: "x11", locked: false, active: true }, notice: "off",
    });
  });

  it("turns a failed look into commands only, and logs the failure", async () => {
    const err = new Error("loginctl is missing");
    const r = rig({ discover: async () => { throw err; } });
    expect(await r.c.preview(true)).toEqual({ access: "none", why: "Ember couldn't check build-01's desktop.", notice: "off" });
    const warn = r.entries.find(e => e.event === "remote.desktop_discovery_failed");
    expect(warn).toMatchObject({ level: "warn", fields: { err } });
  });
});

describe("desktop.state: ensure starts, reuses and refuses", () => {
  it("answers no desktop at once when the machine can't offer one or the PC may not use it", async () => {
    const discover = vi.fn(async () => found());
    const spawn = vi.fn(() => fakeChild().proc);
    const unavailable = rig({ unavailable: "macOS offers no remote desktop to Ember.", discover, spawnChild: spawn });
    expect(await unavailable.c.ensure(ASK)).toEqual({ access: "none", why: "macOS offers no remote desktop to Ember.", notice: "off" });
    expect(discover).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();

    const forbidden = rig({ discover, spawnChild: spawn });
    expect(await forbidden.c.ensure({ ...ASK, allowed: false })).toEqual({ access: "none", why: OFF_WHY, notice: "off" });
    expect(discover).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports discovery's reason (and session) before starting anything", async () => {
    const session = { type: "x11" as const, locked: true, active: true };
    const spawn = vi.fn(() => fakeChild().proc);
    const r = rig({ discover: async () => noDesktop("build-01's screen is locked.", session), spawnChild: spawn });
    expect(await r.c.ensure(ASK)).toEqual({ access: "none", why: "build-01's screen is locked.", session, notice: "off" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("lowers to discovery's none and tells the PC when a new desktop.state finds no desktop", async () => {
    const child = fakeChild();
    const session = { type: "x11" as const, locked: true, active: true };
    let answer: DesktopFound | NoDesktop = found();
    const r = rig({ spawnChild: () => child.proc, discover: async () => answer });
    await r.c.ensure(ASK);
    answer = noDesktop("build-01's screen is locked.", session);
    const none = { access: "none" as const, why: "build-01's screen is locked.", session, notice: "off" as const };
    expect(await r.c.ensure(ASK)).toEqual(none);
    expect(child.requests.filter(x => x.op === "init")).toHaveLength(1);
    expect(r.changes.at(-1)).toEqual(none);
    r.c.stop();
  });

  it("starts one child for overlapping desktop.state calls", async () => {
    let release: (() => void) | null = null;
    const discover = vi.fn(() => new Promise<DesktopFound>(r => { release = () => r(found()); }));
    const child = fakeChild();
    const spawn = vi.fn(() => child.proc);
    const r = rig({ discover, spawnChild: spawn });
    const first = r.c.ensure(ASK);
    const second = r.c.ensure(ASK);
    expect(second).toBe(first);
    await until(() => release !== null);
    release!();
    expect(await first).toMatchObject({ access: "screen", notice: "shown" });
    expect(await second).toEqual(await first);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    r.c.stop();
  });

  it("does not let an overtaken start clear a newer start's shared promise", async () => {
    const releases: (() => void)[] = [];
    const discover = vi.fn(() => new Promise<DesktopFound>(res => { releases.push(() => res(found())); }));
    const child = fakeChild();
    const spawn = vi.fn(() => child.proc);
    const r = rig({ discover, spawnChild: spawn });

    const first = r.c.ensure(ASK);
    await until(() => releases.length === 1);
    r.c.stop();

    const second = r.c.ensure(ASK);
    await until(() => releases.length === 2);
    releases[0]();
    expect(await first).toEqual({ access: "none", why: "Ember stopped using build-01's screen.", notice: "off" });

    const third = r.c.ensure(ASK);
    expect(third).toBe(second);
    expect(discover).toHaveBeenCalledTimes(2);

    releases[1]();
    expect(await second).toMatchObject({ access: "screen", notice: "shown" });
    expect(await third).toEqual(await second);
    expect(spawn).toHaveBeenCalledTimes(1);
    r.c.stop();
  });

  it("starts nothing for a desktop.state a stop overtook during discovery", async () => {
    let release: (() => void) | null = null;
    const discover = vi.fn(() => new Promise<DesktopFound>(res => { release = () => res(found()); }));
    const spawn = vi.fn(() => fakeChild().proc);
    const r = rig({ discover, spawnChild: spawn });

    const pending = r.c.ensure(ASK);
    await until(() => release !== null);
    r.c.stop();
    release!();

    expect(await pending).toEqual({ access: "none", why: "Ember stopped using build-01's screen.", notice: "off" });
    expect(spawn).not.toHaveBeenCalled();
    expect(r.changes).toEqual([]);
  });

  it("starts the child with the session environment and the init arguments", async () => {
    const child = fakeChild();
    const envs: NodeJS.ProcessEnv[] = [];
    const r = rig({
      spawnChild: env => { envs.push(env); return child.proc; },
      baseEnv: { HOME: "/home/deploy", PATH: "/usr/bin:/bin", DISPLAY: "localhost:10.0", SSH_CONNECTION: "10.0.0.2 5 10.0.0.3 22" },
    });
    expect(await r.c.ensure({ ...ASK, consent: true })).toEqual({
      access: "screen", session: { type: "x11", locked: false, active: true }, notice: "shown",
    });
    expect(envs[0]).toMatchObject({ HOME: "/home/deploy", DISPLAY: ":0" });
    expect(envs[0].SSH_CONNECTION).toBeUndefined();
    expect(child.requests[0]).toEqual({
      op: "init",
      a: {
        type: "x11", access: "screen", pc: "ana-laptop", host: "build-01", consent: true,
        policy: POLICY, atspi: "/a.py", notice: "/n.py",
      },
    });
    r.c.stop();
  });

  it("returns the access the helper verified, including text", async () => {
    const child = fakeChild({ init: { access: "text", notice: "shown" } });
    const r = rig({ spawnChild: () => child.proc });
    expect(await r.c.ensure(ASK)).toEqual({
      access: "text", session: { type: "x11", locked: false, active: true }, notice: "shown",
    });
    r.c.stop();
  });

  it("reuses a child on the same session: sends the policy, resumes a paused notice, and keeps one watch", async () => {
    const child = fakeChild();
    const ticks: (() => void)[] = [];
    const r = rig({
      spawnChild: () => child.proc,
      every: fn => { ticks.push(fn); return { stop: () => { const i = ticks.indexOf(fn); if (i >= 0) ticks.splice(i, 1); } }; },
    });
    expect(await r.c.ensure(ASK)).toMatchObject({ access: "screen", notice: "shown" });
    expect(ticks).toHaveLength(1);

    r.c.pause();
    await until(() => child.requests.some(x => x.op === "pause"));
    const nextPolicy: ChildPolicy = { ...POLICY, screenImages: true };
    expect(await r.c.ensure({ ...ASK, policy: nextPolicy })).toEqual({
      access: "screen", session: { type: "x11", locked: false, active: true }, notice: "shown",
    });
    expect(child.requests.map(x => x.op)).toEqual(["init", "pause", "policy", "resume"]);
    expect(child.requests.find(x => x.op === "policy")?.a).toEqual(nextPolicy);
    expect(ticks).toHaveLength(1);

    r.c.stop();
    expect(ticks).toHaveLength(0);
  });

  it("says why a paused notice can't be resumed", async () => {
    const child = fakeChild({
      pid: 102,
      handle: (op, _a, id, c) => {
        if (op === "init") return { access: "screen", notice: "shown" };
        if (op === "resume") { c.fail(id, "internal", "the notice is gone."); return HANDLED; }
        return {};
      },
    });
    const r = rig({ spawnChild: () => child.proc });
    await r.c.ensure(ASK);
    r.c.pause();
    await until(() => child.requests.some(x => x.op === "pause"));
    expect(await r.c.ensure(ASK)).toEqual({ access: "none", why: "the notice is gone.", notice: "off" });
    // The controller keeps the paused child, so a later desktop.state can try to resume it again.
    expect(r.c.pid).toBe(102);
    r.c.stop();
  });

  it("lets a stop that overtook its policy request answer with the stop, telling the PC", async () => {
    let release: (() => void) | null = null;
    const child = fakeChild({
      handle: op => {
        if (op === "init") return { access: "screen", notice: "shown" };
        if (op === "policy") return new Promise(r => { release = () => r({}); });
        return {};
      },
    });
    const r = rig({ spawnChild: () => child.proc });
    await r.c.ensure(ASK);
    const stale = r.c.ensure(ASK);
    await until(() => release !== null);
    r.c.stop();
    release!();
    const stopped = { access: "none" as const, why: "Ember stopped using build-01's screen.", notice: "off" as const };
    expect(await stale).toEqual(stopped);
    expect(r.changes).toEqual([stopped]);
  });

  it("lets a vanished notice during a resume win over the resumed answer", async () => {
    const child = fakeChild({
      handle: (op, _a, id, c) => {
        if (op === "init") return { access: "screen", notice: "shown" };
        if (op === "resume") {
          c.reply(id, {});
          c.event("gone", {});
          return HANDLED;
        }
        return {};
      },
    });
    const r = rig({ spawnChild: () => child.proc });
    await r.c.ensure(ASK);
    r.c.pause();
    await until(() => child.requests.some(x => x.op === "pause"));
    expect(await r.c.ensure(ASK)).toEqual({ access: "none", why: "Ember stopped using build-01's screen.", notice: "off" });
    expect(r.changes).toEqual([{
      access: "none", why: "Ember's notice went away from build-01's screen, so it stopped using it.", notice: "failed",
    }]);
  });

  it("starts a fresh child when the session changed, ending the old one", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const children = [first, second];
    const spawn = vi.fn(() => children.shift()!.proc);
    let answer: DesktopFound | NoDesktop = found();
    const r = rig({ discover: async () => answer, spawnChild: spawn });
    await r.c.ensure(ASK);
    answer = found({ session: { id: "3", type: "x11", locked: false, active: true } });
    expect(await r.c.ensure(ASK)).toMatchObject({ access: "screen", notice: "shown" });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(first.stdin.writableEnded).toBe(true);
    expect(second.requests.some(x => x.op === "init")).toBe(true);
    r.c.stop();
  });

  it("starts a fresh child when the same session now offers text instead of the child's screen", async () => {
    const first = fakeChild();
    const second = fakeChild({ init: { access: "text", notice: "shown" } });
    const children = [first, second];
    const spawn = vi.fn(() => children.shift()!.proc);
    let answer: DesktopFound | NoDesktop = found();
    const r = rig({ discover: async () => answer, spawnChild: spawn });
    await r.c.ensure(ASK);
    answer = found({ access: "text" });
    expect(await r.c.ensure(ASK)).toEqual({
      access: "text", session: { type: "x11", locked: false, active: true }, notice: "shown",
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(first.stdin.writableEnded).toBe(true);
    expect(second.requests.some(x => x.op === "init")).toBe(true);
    r.c.stop();
  });

  it("leaves a newer helper's shown state untold when an overtaken start settles", async () => {
    const releases: (() => void)[] = [];
    const discover = vi.fn(() => new Promise<DesktopFound>(res => { releases.push(() => res(found())); }));
    const child = fakeChild();
    const r = rig({ discover, spawnChild: () => child.proc });

    const first = r.c.ensure(ASK);
    await until(() => releases.length === 1);
    r.c.stop();
    const second = r.c.ensure(ASK);
    await until(() => releases.length === 2);
    releases[1]();
    const shown = {
      access: "screen" as const,
      session: { type: "x11" as const, locked: false as const, active: true as const },
      notice: "shown" as const,
    };
    expect(await second).toEqual(shown);

    releases[0]();
    expect(await first).toEqual({ access: "none", why: "Ember stopped using build-01's screen.", notice: "off" });
    expect(r.changes).toEqual([]);
    expect(r.c.state).toEqual(shown);
    r.c.stop();
  });

  it("tells the PC when a stopped desktop.state has no newer helper", async () => {
    const child = fakeChild();
    let release: (() => void) | null = null;
    let looks = 0;
    const discover = vi.fn(() => {
      looks++;
      if (looks === 1) return Promise.resolve(found());
      return new Promise<DesktopFound>(res => { release = () => res(found()); });
    });
    const r = rig({ discover, spawnChild: () => child.proc });
    expect(await r.c.ensure(ASK)).toMatchObject({ access: "screen", notice: "shown" });

    const pending = r.c.ensure(ASK);
    await until(() => release !== null);
    r.c.stop();
    release!();

    const stopped = { access: "none" as const, why: "Ember stopped using build-01's screen.", notice: "off" as const };
    expect(await pending).toEqual(stopped);
    expect(r.changes.at(-1)).toEqual(stopped);
    expect(r.c.state).toEqual(stopped);
  });
});

describe("starting the child's failures", () => {
  it("logs and says so when the helper can't be spawned", async () => {
    const r = rig({ spawnChild: () => { throw new Error("ENOENT"); } });
    expect(await r.c.ensure(ASK)).toEqual({
      access: "none", why: "Ember couldn't start its desktop helper on build-01.", notice: "off",
    });
    const error = r.entries.find(e => e.event === "remote.desktop_child_failed");
    expect(error?.level).toBe("error");
    expect((error?.fields as { err: Error }).err.message).toBe("ENOENT");
  });

  it("says so when the helper has no pipes", async () => {
    const proc = Object.assign(new EventEmitter(), {
      stdin: null, stdout: null, stderr: null, pid: undefined, kill: vi.fn(),
    }) as unknown as ChildProcess;
    const r = rig({ spawnChild: () => proc });
    expect(await r.c.ensure(ASK)).toEqual({
      access: "none", why: "Ember couldn't start its desktop helper on build-01.", notice: "off",
    });
    expect(r.c.pid).toBeNull();
  });

  it("reports init's refusal with its notice and stops the helper", async () => {
    const child = fakeChild({ pid: 800, init: { access: "none", why: "build-01's screen is locked.", notice: "off" } });
    const r = rig({ spawnChild: () => child.proc });
    expect(await r.c.ensure(ASK)).toEqual({ access: "none", why: "build-01's screen is locked.", notice: "off" });
    expect(r.c.pid).toBeNull();
  });

  it("tells the PC when a lower follows an init refusal whose notice was shown", async () => {
    const child = fakeChild({ init: { access: "none", notice: "shown" } });
    let answer: DesktopFound | NoDesktop = found();
    const r = rig({ spawnChild: () => child.proc, discover: async () => answer });
    expect(await r.c.ensure(ASK)).toEqual({ access: "none", notice: "shown" });
    expect(r.changes).toEqual([]);

    const session = { type: "x11" as const, locked: true, active: true };
    answer = noDesktop("build-01's screen is locked.", session);
    const none = { access: "none" as const, why: "build-01's screen is locked.", session, notice: "off" as const };
    expect(await r.c.ensure(ASK)).toEqual(none);
    expect(r.changes).toEqual([none]);
  });
});

describe("the child's requests and events", () => {
  it("passes the child's audit request on with its epoch, and refuses an unknown operation", async () => {
    const child = fakeChild();
    const audits: { entry: Record<string, unknown>; epoch: number }[] = [];
    let failAudit = false;
    const r = rig({
      spawnChild: () => child.proc,
      audit: async (entry, epoch) => {
        if (failAudit) throw new Error("disk full");
        audits.push({ entry, epoch });
      },
    });
    await r.c.ensure(ASK);

    const id = child.request("audit", { entry: { event: "step", taskId: "t" }, epoch: 9 }, 900);
    await until(() => response(child, id) !== undefined);
    expect(audits).toEqual([{ entry: { event: "step", taskId: "t" }, epoch: 9 }]);
    expect(response(child, id)).toEqual({ t: "res", id: 900, ok: true, v: {} });

    const unknown = child.request("nope", {}, 901);
    await until(() => response(child, unknown) !== undefined);
    expect(response(child, unknown)).toEqual({ t: "res", id: 901, ok: false, e: { code: "unknown_op", m: "nope" } });

    failAudit = true;
    const failed = child.request("audit", { entry: { event: "boom" }, epoch: 3 }, 902);
    await until(() => response(child, failed) !== undefined);
    expect(response(child, failed)).toEqual({ t: "res", id: 902, ok: false, e: { code: "internal", m: "disk full" } });
    r.c.stop();
  });

  it("reports the console's Stop, then stops the child when the notice went away", async () => {
    const child = fakeChild({ pid: 300 });
    const r = rig({ spawnChild: () => child.proc });
    await r.c.ensure(ASK);

    child.event("stop", {});
    await until(() => r.consoleStops === 1);
    expect(r.c.pid).toBe(300);

    child.event("gone", { reason: "closed" });
    await until(() => r.c.pid === null);
    const gone = {
      access: "none" as const, why: "Ember's notice went away from build-01's screen, so it stopped using it.", notice: "failed" as const,
    };
    expect(r.c.state).toEqual(gone);
    expect(r.changes.at(-1)).toEqual(gone);
  });

  it("logs the helper's stderr and cuts a long line to 300 characters", async () => {
    const child = fakeChild();
    const r = rig({ spawnChild: () => child.proc });
    await r.c.ensure(ASK);

    child.stderr.write("Xlib: a warning\n");
    await until(() => r.entries.some(e => e.event === "remote.desktop_child_stderr"));
    expect(r.entries.find(e => e.event === "remote.desktop_child_stderr")).toEqual({
      level: "debug", event: "remote.desktop_child_stderr", fields: { line: "Xlib: a warning" },
    });

    child.stderr.write(`${"x".repeat(400)}\n`);
    await until(() => r.entries.filter(e => e.event === "remote.desktop_child_stderr").length === 2);
    const long = r.entries.filter(e => e.event === "remote.desktop_child_stderr")[1];
    expect((long.fields as { line: string }).line).toHaveLength(300);
    r.c.stop();
  });

  it("stops the desktop when the helper's output closes", async () => {
    const child = fakeChild({ pid: 301 });
    const r = rig({ spawnChild: () => child.proc });
    await r.c.ensure(ASK);
    child.stdout.end();
    await until(() => r.c.pid === null);
    expect(r.c.state).toEqual({ access: "none", why: "Ember's desktop helper on build-01 stopped.", notice: "failed" });
  });

  it("closes the link with the helper's exit reason", async () => {
    const child = fakeChild({
      pid: 302,
      handle: op => (op === "init" ? { access: "screen", notice: "shown" } : new Promise(() => {})),
    });
    const r = rig({ spawnChild: () => child.proc });
    await r.c.ensure(ASK);
    const waiting = r.c.request("read", {});
    await until(() => child.requests.some(x => x.op === "read"));
    const rejection = expect(waiting).rejects.toMatchObject({ code: "gone", message: "the desktop helper exited" });
    child.exit(0, null);
    await rejection;
    await until(() => r.c.pid === null);
    expect(r.c.state).toMatchObject({ access: "none", why: "Ember's desktop helper on build-01 stopped.", notice: "failed" });
  });
});

describe("recheck, request, policy and pause", () => {
  it("recheck while paused says the connection was silent and does not look", async () => {
    const child = fakeChild({ pid: 400 });
    const discover = vi.fn(async () => found());
    const r = rig({ spawnChild: () => child.proc, discover });
    await r.c.ensure(ASK);
    const looks = discover.mock.calls.length;
    r.c.pause();
    await until(() => child.requests.some(x => x.op === "pause"));
    expect(await r.c.recheck()).toBe("Ember stopped using build-01's screen while the connection was silent.");
    expect(discover).toHaveBeenCalledTimes(looks);
    expect(r.c.pid).toBe(400);
    r.c.stop();
  });

  it("recheck reuses discovery for DISCOVERY_MS and stops the child when the session changed", async () => {
    const child = fakeChild({ pid: 401 });
    const discover = vi.fn(async () => found());
    const r = rig({ spawnChild: () => child.proc, discover });
    await r.c.ensure(ASK);
    expect(discover).toHaveBeenCalledTimes(1);

    r.setNow(DISCOVERY_MS + 1);
    expect(await r.c.recheck()).toBeNull();
    expect(discover).toHaveBeenCalledTimes(2);

    r.setNow(DISCOVERY_MS + 500);
    expect(await r.c.recheck()).toBeNull();
    expect(discover).toHaveBeenCalledTimes(2);

    r.setNow(2 * DISCOVERY_MS + 1);
    expect(await r.c.recheck()).toBeNull();
    expect(discover).toHaveBeenCalledTimes(3);

    discover.mockResolvedValue(found({ session: { id: "3", type: "x11", locked: false, active: true } }));
    r.setNow(3 * DISCOVERY_MS + 1);
    expect(await r.c.recheck()).toBe("build-01's desktop session changed.");
    expect(r.c.pid).toBeNull();
    expect(r.changes.at(-1)).toEqual({ access: "none", why: "build-01's desktop session changed.", notice: "off" });
  });

  it("recheck stops the child and keeps discovery's session when the desktop went away", async () => {
    const child = fakeChild({ pid: 402 });
    const session = { type: "x11" as const, locked: true, active: true };
    let answer: DesktopFound | NoDesktop = found();
    const r = rig({ spawnChild: () => child.proc, discover: async () => answer });
    await r.c.ensure(ASK);
    answer = noDesktop("build-01's screen is locked.", session);
    r.setNow(DISCOVERY_MS + 1);
    expect(await r.c.recheck()).toBe("build-01's screen is locked.");
    expect(r.c.pid).toBeNull();
    expect(r.changes.at(-1)).toEqual({ access: "none", why: "build-01's screen is locked.", session, notice: "off" });
  });

  it("request refuses without a child, with the last reason or the generic one", async () => {
    const r = rig();
    await expect(r.c.request("read", {})).rejects.toMatchObject({
      code: "not_ready", message: "Ember isn't using build-01's screen now.",
    });
    await r.c.preview(false);
    await expect(r.c.request("read", {})).rejects.toMatchObject({ code: "not_ready", message: OFF_WHY });
  });

  it("request passes a read or step to the child with its arguments", async () => {
    const child = fakeChild({
      handle: op => (op === "init" ? { access: "screen", notice: "shown" } : op === "read" ? { value: 42 } : {}),
    });
    const r = rig({ spawnChild: () => child.proc });
    await r.c.ensure(ASK);
    expect(await r.c.request("read", { id: 3 })).toEqual({ value: 42 });
    expect(child.requests.at(-1)).toEqual({ op: "read", a: { id: 3 } });
    r.c.stop();
  });

  it("policy does nothing without a child and sends a new policy, ignoring its refusal", async () => {
    const idle = rig();
    expect(() => idle.c.policy(POLICY)).not.toThrow();

    const child = fakeChild({
      handle: op => (op === "init" ? { access: "screen", notice: "shown" } : op === "policy" ? Promise.reject(new IpcError("denied", "no")) : {}),
    });
    const r = rig({ spawnChild: () => child.proc });
    await r.c.ensure(ASK);
    const next: ChildPolicy = { ...POLICY, neverLook: ["other"] };
    r.c.policy(next);
    await until(() => child.requests.some(x => x.op === "policy"));
    expect(child.requests.find(x => x.op === "policy")?.a).toEqual(next);
    await new Promise(res => setImmediate(res));
    r.c.stop();
  });

  it("pause does nothing without a child or when already paused, and sends pause once otherwise", async () => {
    const idle = rig();
    expect(() => idle.c.pause()).not.toThrow();

    const child = fakeChild();
    const r = rig({ spawnChild: () => child.proc });
    await r.c.ensure(ASK);
    r.c.pause();
    await until(() => child.requests.filter(x => x.op === "pause").length === 1);
    r.c.pause();
    await new Promise(res => setImmediate(res));
    expect(child.requests.filter(x => x.op === "pause")).toHaveLength(1);
    r.c.stop();
  });
});

describe("the watch timer", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] }); });

  it("looks every WATCH_MS with the default timer, and stops with the child", async () => {
    const discover = vi.fn(async () => found());
    const child = fakeChild();
    const r = rig({ spawnChild: () => child.proc, discover, now: () => Date.now(), every: undefined });
    expect(await r.c.ensure(ASK)).toMatchObject({ access: "screen", notice: "shown" });
    expect(discover).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WATCH_MS);
    await until(() => discover.mock.calls.length === 2);
    expect(r.changes).toEqual([]);

    r.c.stop();
    await vi.advanceTimersByTimeAsync(WATCH_MS * 3);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("does nothing while paused, and catches a look whose lowering throws", async () => {
    const ticks: (() => void)[] = [];
    const discover = vi.fn(async (): Promise<DesktopFound | NoDesktop> => found());
    const changes: DesktopState[] = [];
    let throwOnChange = false;
    const child = fakeChild();
    const r = rig({
      spawnChild: () => child.proc,
      discover,
      changed: s => { if (throwOnChange) throw new Error("the PC is gone"); changes.push(s); },
      every: fn => { ticks.push(fn); return { stop: () => { const i = ticks.indexOf(fn); if (i >= 0) ticks.splice(i, 1); } }; },
    });
    await r.c.ensure(ASK);
    const looks = discover.mock.calls.length;

    r.c.pause();
    await until(() => child.requests.some(x => x.op === "pause"));
    for (const fn of [...ticks]) fn();
    await new Promise(res => setImmediate(res));
    expect(discover).toHaveBeenCalledTimes(looks);

    await r.c.ensure(ASK);
    throwOnChange = true;
    discover.mockResolvedValue(noDesktop("build-01's screen is locked.", { type: "x11", locked: true, active: true }));
    r.setNow(DISCOVERY_MS + 1);
    for (const fn of [...ticks]) fn();
    await until(() => r.entries.some(e => e.event === "remote.desktop_watch_failed"));
    const warn = r.entries.find(e => e.event === "remote.desktop_watch_failed");
    expect(warn?.level).toBe("warn");
    expect((warn?.fields as { err: Error }).err.message).toBe("the PC is gone");
    expect(r.c.pid).toBeNull();
  });

  it("never runs two looks at once", async () => {
    const ticks: (() => void)[] = [];
    let calls = 0;
    let release: (() => void) | null = null;
    const discover = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.resolve(found());
      return new Promise<DesktopFound>(r => { release = () => r(found()); });
    });
    const child = fakeChild();
    const r = rig({
      spawnChild: () => child.proc,
      discover,
      every: fn => { ticks.push(fn); return { stop: () => { const i = ticks.indexOf(fn); if (i >= 0) ticks.splice(i, 1); } }; },
    });
    await r.c.ensure(ASK);
    expect(calls).toBe(1);
    r.setNow(DISCOVERY_MS + 1);
    for (const fn of [...ticks]) fn();
    for (const fn of [...ticks]) fn();
    await new Promise(res => setImmediate(res));
    expect(calls).toBe(2);
    expect(release).not.toBeNull();
    release!();
    await new Promise(res => setImmediate(res));
    r.c.stop();
  });
});

describe("the default watch timer", () => {
  it("unrefs the default interval so the watch never holds the agent open", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const r = rig({ every: undefined });
    expect(await r.c.ensure(ASK)).toMatchObject({ access: "screen", notice: "shown" });
    expect(spy).toHaveBeenCalledTimes(1);
    const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    r.c.stop();
  });
});

describe("timeouts and reaping", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] }); });

  it("fails an init the helper doesn't answer in time and stops it", async () => {
    const child = fakeChild({ handle: op => (op === "init" ? new Promise(() => {}) : {}) });
    const r = rig({ spawnChild: () => child.proc });
    const pending = r.c.ensure(ASK);
    await until(() => child.requests.some(x => x.op === "init"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({
      access: "none", why: "the desktop helper didn't answer init in time", notice: "failed",
    });
    expect(r.c.pid).toBeNull();
  });

  it("gives a consent init the longer consent timeout", async () => {
    let resolveInit: (() => void) | null = null;
    const child = fakeChild({
      handle: op => (op === "init"
        ? new Promise<InitResult>(res => { resolveInit = () => res({ access: "screen", notice: "shown" }); })
        : {}),
    });
    const r = rig({ spawnChild: () => child.proc });
    const pending = r.c.ensure({ ...ASK, consent: true });
    await until(() => resolveInit !== null);
    // INIT_MS is 30_000 and INIT_CONSENT_MS is 150_000; only the former is exported.
    await vi.advanceTimersByTimeAsync(30_001);
    resolveInit!();
    expect(await pending).toEqual({
      access: "screen", session: { type: "x11", locked: false, active: true }, notice: "shown",
    });
    r.c.stop();
  });

  it("stops the helper whose init failed and tells the PC exactly once", async () => {
    const first = fakeChild({ pid: 700 });
    const second = fakeChild({ pid: 701, handle: op => (op === "init" ? new Promise(() => {}) : {}) });
    const children = [first, second];
    const spawn = vi.fn(() => children.shift()!.proc);
    const r = rig({ spawnChild: spawn });
    expect(await r.c.ensure(ASK)).toMatchObject({ access: "screen", notice: "shown" });
    r.c.stop();

    const pending = r.c.ensure(ASK);
    await until(() => second.requests.some(x => x.op === "init"));
    await vi.advanceTimersByTimeAsync(30_000);
    const failed = {
      access: "none" as const, why: "the desktop helper didn't answer init in time", notice: "failed" as const,
    };
    expect(await pending).toEqual(failed);
    expect(second.stdin.writableEnded).toBe(true);
    expect(r.changes).toEqual([failed]);
    expect(r.c.pid).toBeNull();
  });

  it("fails a read the helper doesn't answer in time", async () => {
    const child = fakeChild({ handle: op => (op === "init" ? { access: "screen", notice: "shown" } : new Promise(() => {})) });
    const r = rig({ spawnChild: () => child.proc });
    await r.c.ensure(ASK);
    const pending = r.c.request("read", {});
    await until(() => child.requests.some(x => x.op === "read"));
    const rejection = expect(pending).rejects.toMatchObject({
      code: "internal", message: "the desktop helper didn't answer read in time",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    r.c.stop();
  });

  it("kills a stopped child's group after a second when it hasn't gone", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = fakeChild({ pid: 4242 });
    const r = rig({ spawnChild: () => child.proc });
    await r.c.ensure(ASK);
    r.c.stop();
    expect(child.stdin.writableEnded).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
  });

  it("does not reap a stopped child that exited within its second", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = fakeChild({ pid: 5151 });
    const r = rig({ spawnChild: () => child.proc });
    await r.c.ensure(ASK);
    r.c.stop();
    child.exit(0, null);
    r.c.reap();
    expect(kill).not.toHaveBeenCalled();
  });

  it("reaps a stopped child's group at once and clears it", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = fakeChild({ pid: 6262 });
    const r = rig({ spawnChild: () => child.proc });
    await r.c.ensure(ASK);
    r.c.reap();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-6262, "SIGKILL");
    expect(r.c.pid).toBeNull();
    r.c.reap();
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
