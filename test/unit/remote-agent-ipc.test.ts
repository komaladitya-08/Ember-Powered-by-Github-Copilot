import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { DesktopController } from "../../app/remote/desktop";
import { IpcError, lineRpc, type LineRpc } from "../../app/remote/desktop-ipc";
import { noticeText } from "../../app/remote/notice";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

/** Two ends of a JSON-lines link over in-memory pipes. */
function pair(answer: (op: string, a: unknown) => Promise<unknown>) {
  const ab = new PassThrough(), ba = new PassThrough();
  const closed: string[] = [];
  const events: [string, unknown][] = [];
  const a: LineRpc = lineRpc({ input: ba, output: ab, log: quiet, onRequest: async () => ({}), onEvent: (ev, d) => events.push([ev, d]), onClose: why => closed.push(`a: ${why}`) });
  const b: LineRpc = lineRpc({ input: ab, output: ba, log: quiet, onRequest: answer, onEvent: () => {}, onClose: why => closed.push(`b: ${why}`) });
  return { a, b, ab, ba, closed, events };
}

describe("serve ⇄ desktop child lines (desktop-ipc.ts)", () => {
  it("answers requests by id, both kinds of answer, and passes events", async () => {
    const p = pair(async (op, a) => {
      if (op === "fail") throw new IpcError("denied", "no");
      if (op === "boom") throw new Error("internal detail");
      return { echo: a };
    });
    expect(await p.a.request("echo", { x: 1 }, 1000)).toEqual({ echo: { x: 1 } });
    await expect(p.a.request("fail", {}, 1000)).rejects.toMatchObject({ code: "denied", message: "no" });
    await expect(p.a.request("boom", {}, 1000)).rejects.toMatchObject({ code: "internal" });
    p.b.event("stop", {});
    await new Promise(r => setTimeout(r, 10));
    expect(p.events).toEqual([["stop", {}]]);
  });

  it("ends the link on a malformed line, failing what waits with gone", async () => {
    const p = pair(() => new Promise(() => {}));
    const waiting = p.a.request("never", {}, 5000);
    p.ba.write("not json\n");
    await expect(waiting).rejects.toMatchObject({ code: "gone" });
    expect(p.closed).toContain("a: a malformed line");
    await expect(p.a.request("x", {}, 100)).rejects.toMatchObject({ code: "gone" });
  });

  it("fails a request the other side doesn't answer in time", async () => {
    const p = pair(() => new Promise(() => {}));
    await expect(p.a.request("slow", {}, 20)).rejects.toMatchObject({ code: "internal" });
  });

  it("ends when the other side's output ends", async () => {
    const p = pair(async () => ({}));
    p.ba.end();
    await new Promise(r => setTimeout(r, 10));
    expect(p.closed).toContain("a: the other side closed");
  });
});

describe("serve's side of the desktop child (desktop.ts)", () => {
  it("reads the child's stderr into the log (an unread pipe would stall it), and says none when the child can't verify the desktop", async () => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    // No pid: nothing here may signal a real process.
    const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: undefined }) as unknown as ChildProcess;
    const logged: [string, unknown][] = [];
    const log = { ...quiet, debug: (ev: string, f?: unknown) => { logged.push([ev, f]); } } as unknown as Logger;
    const envs: NodeJS.ProcessEnv[] = [];
    const c = new DesktopController({
      unavailable: null, host: "build-01",
      discover: async () => ({ access: "screen", session: { id: "2", type: "x11", locked: false, active: true }, env: { DISPLAY: ":0", XAUTHORITY: "/run/user/1000/gdm/Xauthority" } }),
      spawnChild: env => { envs.push(env); return proc; },
      baseEnv: { HOME: "/home/deploy", PATH: "/usr/bin:/bin", SSH_CONNECTION: "10.0.0.2 5 10.0.0.3 22", DISPLAY: "localhost:10.0" },
      scripts: { atspi: "/a.py", notice: "/n.py" }, audit: async () => {}, changed: () => {}, consoleStop: () => {}, log, now: () => Date.now(),
    });
    // The child: a complaint on stderr, then init answered with none.
    readline.createInterface({ input: stdin }).on("line", l => {
      const m = JSON.parse(l) as { t: string; id: number; op: string };
      if (m.op !== "init") return;
      stderr.write("Xlib:  extension \"RANDR\" missing on display \":0\".\n");
      setTimeout(() => stdout.write(`${JSON.stringify({ t: "res", id: m.id, ok: true, v: { access: "none", why: "Ember can't open build-01's display.", notice: "off" } })}\n`), 5);
    });
    const policy = { neverLook: [], actionsAllowed: true, confirmEveryAction: true, screenImages: true };
    expect(await c.ensure({ pc: "ana-laptop", allowed: true, consent: false, policy })).toEqual({ access: "none", why: "Ember can't open build-01's display.", notice: "off" });
    expect(logged).toContainEqual(["remote.desktop_child_stderr", { line: "Xlib:  extension \"RANDR\" missing on display \":0\"." }]);
    // The child's environment: the session's DISPLAY, never the SSH login's tunnel or its SSH_* variables.
    expect(envs[0]).toMatchObject({ DISPLAY: ":0", HOME: "/home/deploy" });
    expect(envs[0].SSH_CONNECTION).toBeUndefined();
  });
});

describe("watching the desktop while it is in use (§5.3.4 step 8, INT)", () => {
  /** A controller whose child verifies the desktop, a discovery the test changes, and its ticks driven by hand. */
  const rig = () => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: undefined }) as unknown as ChildProcess;
    readline.createInterface({ input: stdin }).on("line", l => {
      const m = JSON.parse(l) as { t: string; id: number; op: string };
      if (m.t === "req") stdout.write(`${JSON.stringify({ t: "res", id: m.id, ok: true, v: m.op === "init" ? { access: "screen", notice: "shown" } : {} })}\n`);
    });
    const session = { id: "2", type: "x11" as const, locked: false as const, active: true as const };
    let found: Awaited<ReturnType<ConstructorParameters<typeof DesktopController>[0]["discover"]>> = { access: "screen", session, env: { DISPLAY: ":0" } };
    let now = 0;
    const changed: unknown[] = [];
    const ticks: (() => void)[] = [];
    const c = new DesktopController({
      unavailable: null, host: "build-01", discover: async () => found, spawnChild: () => proc, baseEnv: {},
      scripts: { atspi: "/a.py", notice: "/n.py" }, audit: async () => {}, changed: s => changed.push(s), consoleStop: () => {}, log: quiet, now: () => now,
      every: fn => { ticks.push(fn); return { stop: () => { ticks.splice(ticks.indexOf(fn), 1); } }; },
    });
    const policy = { neverLook: [], actionsAllowed: true, confirmEveryAction: true, screenImages: true };
    const tick = async () => { now += 5000; for (const f of [...ticks]) f(); await new Promise(r => setTimeout(r, 10)); };
    return { c, changed, ticks, tick, policy, set: (f: typeof found) => { found = f; } };
  };

  it("tells the PC when the session goes inactive or locks between steps, and stops looking once the child is gone", async () => {
    const r = rig();
    expect(await r.c.ensure({ pc: "ana-laptop", allowed: true, consent: false, policy: r.policy })).toMatchObject({ access: "screen", notice: "shown" });
    expect(r.ticks).toHaveLength(1);
    await r.tick();
    expect(r.changed).toEqual([]);
    r.set({ access: "none", why: "build-01's screen is locked.", session: { type: "x11", locked: true, active: true } });
    await r.tick();
    expect(r.changed).toEqual([{ access: "none", why: "build-01's screen is locked.", session: { type: "x11", locked: true, active: true }, notice: "off" }]);
    expect(r.ticks).toEqual([]);
    expect(r.c.pid).toBeNull();
  });

  it("starts no helper (and no notice) for a desktop.state that was still looking when Stop came", async () => {
    let finish: () => void = () => {};
    let spawned = 0;
    const proc = () => {
      spawned++;
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      readline.createInterface({ input: stdin }).on("line", l => {
        const m = JSON.parse(l) as { t: string; id: number; op: string };
        if (m.t === "req") stdout.write(`${JSON.stringify({ t: "res", id: m.id, ok: true, v: m.op === "init" ? { access: "screen", notice: "shown" } : {} })}\n`);
      });
      return Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: undefined }) as unknown as ChildProcess;
    };
    const session = { id: "2", type: "x11" as const, locked: false as const, active: true as const };
    const c = new DesktopController({
      unavailable: null, host: "build-01", baseEnv: {}, spawnChild: proc,
      // loginctl and busctl take their time.
      discover: () => new Promise(r => { finish = () => r({ access: "screen", session, env: { DISPLAY: ":0" } }); }),
      scripts: { atspi: "/a.py", notice: "/n.py" }, audit: async () => {}, changed: () => {}, consoleStop: () => {}, log: quiet, now: () => Date.now(),
      every: () => ({ stop: () => {} }),
    });
    const policy = { neverLook: [], actionsAllowed: true, confirmEveryAction: true, screenImages: true };
    const asked = c.ensure({ pc: "ana-laptop", allowed: true, consent: false, policy });
    c.stop();
    finish();
    expect(await asked).toEqual({ access: "none", why: "Ember stopped using build-01's screen.", notice: "off" });
    expect(spawned).toBe(0);
    expect(c.pid).toBeNull();
    // The next desktop.state (a new task) starts afresh, not the stopped one's answer.
    const next = c.ensure({ pc: "ana-laptop", allowed: true, consent: false, policy });
    finish();
    expect(await next).toMatchObject({ access: "screen", notice: "shown" });
    expect(spawned).toBe(1);
    // A look between steps that Stop overtakes says why, and never trips over the child it stopped.
    const looking = c.recheck();
    c.stop();
    expect(await looking).toBe("Ember isn't using build-01's screen now.");
  });

  it("looks only while a child runs: never before desktop.state, nor after Stop", async () => {
    const r = rig();
    expect(r.ticks).toEqual([]);
    await r.c.ensure({ pc: "ana-laptop", allowed: true, consent: false, policy: r.policy });
    r.c.stop();
    expect(r.ticks).toEqual([]);
  });
});

describe("the notice's words (§5.3.9)", () => {
  it("names the PC as it reported itself", () => {
    expect(noticeText("ana-laptop")).toEqual({
      using: "Ember on ana-laptop is using this screen.",
      asking: "Ember on ana-laptop wants to use this screen.",
      paused: "Ember on ana-laptop lost its connection and isn't using this screen now.",
    });
    expect(noticeText("").using).toBe("Ember on another computer is using this screen.");
  });
});
