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
