import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../app/main/logger";
import { ASK_MS, SHOW_MS, noticeText, startNotice } from "../../app/remote/notice";

const flush = async () => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise<void>(resolve => setImmediate(resolve));
};

function logger() {
  const mocks = {
    warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn(), child: vi.fn(),
  };
  mocks.child.mockReturnValue(mocks);
  return { log: mocks as unknown as Logger, mocks };
}

function rig(o: { notification?: boolean } = {}) {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const kill = vi.fn(() => true);
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill }) as unknown as ChildProcess;
  const written: string[] = [];
  stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));
  const spawn = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => child);
  const { log, mocks } = logger();
  const env = { DISPLAY: ":0", PATH: "/usr/bin:/bin" };
  const notice = startNotice({
    python: "/usr/bin/python3", script: "/opt/ember/notice/ember_notice.py", env,
    notification: o.notification ?? false, log, spawn,
  });
  const send = async (ev: unknown) => { stdout.write(`${JSON.stringify(ev)}\n`); await flush(); };
  const sendRaw = async (line: string) => { stdout.write(`${line}\n`); await flush(); };
  return { child, stdin, stdout, stderr, kill, written, spawn, notice, log, mocks, env, send, sendRaw };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the notice's words (§5.3.9)", () => {
  it("says what Ember is doing in three sentences", () => {
    expect(noticeText("ana-laptop")).toEqual({
      using: "Ember on ana-laptop is using this screen.",
      asking: "Ember on ana-laptop wants to use this screen.",
      paused: "Ember on ana-laptop lost its connection and isn't using this screen now.",
    });
  });

  it("falls back to \"another computer\" for an empty PC name", () => {
    expect(noticeText("")).toEqual({
      using: "Ember on another computer is using this screen.",
      asking: "Ember on another computer wants to use this screen.",
      paused: "Ember on another computer lost its connection and isn't using this screen now.",
    });
  });
});

describe("starting the notice (notice.ts)", () => {
  it("spawns the remote's Python with -B, the script and piped stdio in its environment", () => {
    const r = rig();
    expect(r.spawn).toHaveBeenCalledWith(
      "/usr/bin/python3",
      ["-B", "/opt/ember/notice/ember_notice.py"],
      { stdio: ["pipe", "pipe", "pipe"], env: r.env },
    );
  });

  it("adds --notification when the session has no X window", () => {
    const r = rig({ notification: true });
    expect(r.spawn).toHaveBeenCalledWith(
      "/usr/bin/python3",
      ["-B", "/opt/ember/notice/ember_notice.py", "--notification"],
      { stdio: ["pipe", "pipe", "pipe"], env: r.env },
    );
  });

  it("logs the notice's stderr, shortened", async () => {
    const r = rig();
    const long = "x".repeat(250);
    r.stderr.write(`${long}\n`);
    await flush();
    expect(r.mocks.debug).toHaveBeenCalledWith("remote.notice_stderr", { line: "x".repeat(200) });
  });
});

describe("showing the notice", () => {
  it("writes the show command and resolves true once it is on screen", async () => {
    const r = rig();
    const shown = r.notice.show("Ember on ana-laptop is using this screen.");
    await flush();
    expect(r.written).toEqual([`${JSON.stringify({ cmd: "show", text: "Ember on ana-laptop is using this screen." })}\n`]);
    await r.send({ ev: "shown", form: "window" });
    await expect(shown).resolves.toBe(true);
  });

  it("resolves false when the notice says it failed, and reports why it went away", async () => {
    const r = rig();
    const gone = vi.fn();
    r.notice.onGone(gone);
    const shown = r.notice.show("anything");
    await flush();
    await r.send({ ev: "failed", why: "no display" });
    await expect(shown).resolves.toBe(false);
    expect(gone).toHaveBeenCalledWith("no display");
    expect(r.mocks.warn).toHaveBeenCalledWith("remote.notice_not_shown", { why: "no display" });
  });

  it("resolves false when nothing answers within SHOW_MS", async () => {
    vi.useFakeTimers();
    const r = rig();
    let settled: boolean | undefined;
    const shown = r.notice.show("anything").then(v => { settled = v; return v; });
    await flush();
    await vi.advanceTimersByTimeAsync(SHOW_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(shown).resolves.toBe(false);
    expect(settled).toBe(false);
  });
});

describe("asking the console", () => {
  it("resolves true only for Allow", async () => {
    const r = rig();
    const answer = r.notice.ask("Ember wants to use this screen.");
    await flush();
    expect(r.written).toEqual([`${JSON.stringify({ cmd: "ask", text: "Ember wants to use this screen." })}\n`]);
    await r.send({ ev: "answer", allow: true });
    await expect(answer).resolves.toBe(true);
  });

  it("resolves false for Don't allow", async () => {
    const r = rig();
    const answer = r.notice.ask("anything");
    await flush();
    await r.send({ ev: "answer", allow: false });
    await expect(answer).resolves.toBe(false);
  });

  it("resolves false after a custom timeout", async () => {
    vi.useFakeTimers();
    const r = rig();
    let settled: boolean | undefined;
    const answer = r.notice.ask("anything", 25).then(v => { settled = v; return v; });
    await flush();
    await vi.advanceTimersByTimeAsync(24);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toBe(false);
  });

  it("uses ASK_MS by default", async () => {
    vi.useFakeTimers();
    const r = rig();
    let settled: boolean | undefined;
    const answer = r.notice.ask("anything").then(v => { settled = v; return v; });
    await flush();
    await vi.advanceTimersByTimeAsync(ASK_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toBe(false);
  });

  it("resolves false at once, without writing, when the process already exited", async () => {
    const r = rig();
    r.child.emit("exit", 0, null);
    const answer = r.notice.ask("anything");
    await expect(answer).resolves.toBe(false);
    expect(r.written).toEqual([]);
  });

  it("resolves false when the notice says it failed", async () => {
    const r = rig();
    const answer = r.notice.ask("anything");
    await flush();
    await r.send({ ev: "failed", why: "no display" });
    await expect(answer).resolves.toBe(false);
  });
});

describe("the notice's other lines", () => {
  it("tells onStop listeners when someone presses Stop", async () => {
    const r = rig();
    const stop = vi.fn();
    r.notice.onStop(stop);
    await r.send({ ev: "stop" });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed, unknown and over-full lines without settling a pending show", async () => {
    const r = rig();
    let settled = false;
    const shown = r.notice.show("anything").then(v => { settled = true; return v; });
    await flush();
    await r.sendRaw("not json");
    await r.sendRaw(JSON.stringify({ ev: "surprise" }));
    await r.sendRaw(JSON.stringify({ ev: "shown", form: "window", extra: 1 }));
    expect(settled).toBe(false);
    expect(r.mocks.warn).toHaveBeenCalledTimes(3);
    for (const call of r.mocks.warn.mock.calls) expect(call).toEqual(["remote.notice_bad_line", {}]);
    await r.send({ ev: "shown", form: "notification" });
    await expect(shown).resolves.toBe(true);
  });
});

describe("when the notice's process ends", () => {
  it("fails a pending show on exit, reports gone once, and writes nothing afterwards", async () => {
    const r = rig();
    const gone = vi.fn();
    r.notice.onGone(gone);
    const shown = r.notice.show("anything");
    await flush();
    const before = r.written.length;
    r.child.emit("exit", 0, null);
    await expect(shown).resolves.toBe(false);
    expect(gone).toHaveBeenCalledTimes(1);
    expect(gone).toHaveBeenCalledWith("it closed");
    await expect(r.notice.show("later")).resolves.toBe(false);
    await expect(r.notice.ask("later")).resolves.toBe(false);
    expect(r.written).toHaveLength(before);
  });

  it("fails a pending ask on error, logging it, and fires onGone once even when exit follows", async () => {
    const r = rig();
    const gone = vi.fn();
    r.notice.onGone(gone);
    const answer = r.notice.ask("anything");
    await flush();
    const err = new Error("spawn failed");
    r.child.emit("error", err);
    r.child.emit("exit", 1, null);
    await expect(answer).resolves.toBe(false);
    expect(r.mocks.warn).toHaveBeenCalledWith("remote.notice_failed", { err });
    expect(gone).toHaveBeenCalledTimes(1);
    expect(gone).toHaveBeenCalledWith("it couldn't start");
  });

  it("fails a pending show when the notice's stdin errors, reporting gone once", async () => {
    const r = rig();
    const gone = vi.fn();
    r.notice.onGone(gone);
    const shown = r.notice.show("anything");
    await flush();
    r.stdin.emit("error", new Error("EPIPE"));
    await expect(shown).resolves.toBe(false);
    expect(gone).toHaveBeenCalledTimes(1);
    expect(gone).toHaveBeenCalledWith("it closed");
  });
});

describe("pausing and closing", () => {
  it("writes the paused command", async () => {
    const r = rig();
    r.notice.paused("Ember lost its connection.");
    await flush();
    expect(r.written).toEqual([`${JSON.stringify({ cmd: "paused", text: "Ember lost its connection." })}\n`]);
  });

  it("writes nothing after the process has exited", async () => {
    const r = rig();
    r.child.emit("exit", 0, null);
    r.notice.paused("anything");
    await flush();
    expect(r.written).toEqual([]);
  });

  it("ends stdin, kills with SIGKILL after a second, and does that only once", async () => {
    vi.useFakeTimers();
    const r = rig();
    r.notice.close();
    r.notice.close();
    expect(r.stdin.writableEnded).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(r.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.kill).toHaveBeenCalledTimes(1);
    expect(r.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("writes nothing after close", async () => {
    vi.useFakeTimers();
    const r = rig();
    r.notice.close();
    r.notice.paused("anything");
    await expect(r.notice.show("anything")).resolves.toBe(false);
    await expect(r.notice.ask("anything")).resolves.toBe(false);
    await flush();
    expect(r.written).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
  });
});
