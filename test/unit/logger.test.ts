import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger, isLogStreamFailure } from "../../app/main/logger";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-log-"));
const lines = (f: string) => fs.readFileSync(f, "utf8").trim().split("\n").map(l => JSON.parse(l));

describe("logger", () => {
  it("writes JSON lines with level, scope and fields, honouring the level", () => {
    const log = createLogger({ dir: tmp(), level: "info", now: () => new Date("2026-10-15T00:00:00Z") });
    log.debug("hidden");
    log.child("agent").info("started", { sessions: 1 });
    log.error("boom", { err: new Error("bad") });
    const out = lines(log.file);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ t: "2026-10-15T00:00:00.000Z", level: "info", msg: "started", scope: "agent", sessions: 1 });
    expect(out[1].err.message).toBe("bad");
  });

  it("rotates by size and keeps a bounded number of files", () => {
    const dir = tmp();
    const log = createLogger({ dir, maxBytes: 200, keep: 2 });
    for (let i = 0; i < 40; i++) log.info("x".repeat(40), { i });
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(["ember.log", "ember.log.1", "ember.log.2"]);
  });
});

describe("logger robustness", () => {
  it("makes its folder again when it was removed under a running Ember, and goes on logging (reliability-r9-4)", () => {
    const dir = path.join(tmp(), "logs");
    const log = createLogger({ dir });
    log.info("before");
    fs.rmSync(dir, { recursive: true });
    log.info("after.one");
    log.info("after.two");
    expect(fs.readFileSync(path.join(dir, "ember.log"), "utf8").trim().split("\n").map(l => JSON.parse(l).msg)).toEqual(["after.one", "after.two"]);
    if (process.platform !== "win32") expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("goes on writing while a rotation can't be done whole, giving up an older file instead of every line to come (reliability-r9-4)", () => {
    const dir = tmp();
    // Something that can't be renamed over sits where the oldest kept file goes.
    fs.mkdirSync(path.join(dir, "ember.log.3"));
    fs.writeFileSync(path.join(dir, "ember.log.3", "in-the-way"), "");
    const log = createLogger({ dir, maxBytes: 200, keep: 3 });
    for (let i = 0; i < 40; i++) log.info("line", { i, pad: "x".repeat(40) });
    const kept = ["ember.log", "ember.log.1", "ember.log.2"].flatMap(f => { try { return fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n"); } catch { return []; } });
    // Before: the first 6 of the 40 lines (three files of 224 bytes), and nothing after. Now the newest are there,
    // in files that still rotate.
    expect(kept.map(l => JSON.parse(l).i)).toContain(39);
    expect(kept.map(l => JSON.parse(l).i)).not.toContain(0);
    expect(fs.statSync(path.join(dir, "ember.log")).size).toBeLessThan(200 + 150);
  });

  it("never throws on circular values, BigInts or nested errors, and keeps codes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-log-"));
    const log = createLogger({ dir });
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    const err = Object.assign(new Error("boom"), { code: "ENOSPC" });
    expect(() => log.error("odd", { loop, big: 10n, nested: { err } })).not.toThrow();
    const line = JSON.parse(fs.readFileSync(log.file, "utf8").trim().split("\n").at(-1)!);
    expect(line).toMatchObject({ big: "10", loop: { a: 1, self: "[circular]" }, nested: { err: { message: "boom", code: "ENOSPC" } } });
    // Owner-only: a POSIX mode (Windows has none; the log lives in the user's own profile folder there).
    if (process.platform !== "win32") expect(fs.statSync(log.file).mode & 0o077).toBe(0);
  });

  it("prints a value used twice side by side, and an error that is its own cause once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-log-"));
    const log = createLogger({ dir });
    const shared = { app: "gedit" };
    const err = new Error("loop") as Error & { cause?: unknown };
    err.cause = err;
    log.info("twice", { a: shared, b: shared, err });
    const line = JSON.parse(fs.readFileSync(log.file, "utf8").trim());
    expect(line).toMatchObject({ a: { app: "gedit" }, b: { app: "gedit" }, err: { message: "loop", cause: "[circular]" } });
  });

  it("writes to stderr when its folder can't be made, instead of throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-log-"));
    fs.writeFileSync(path.join(dir, "logs"), "a file in the way");
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { writes.push(String(s)); return true; });
    try {
      const log = createLogger({ dir: path.join(dir, "logs") });
      log.warn("still here");
    } finally { spy.mockRestore(); }
    expect(writes.join("")).toContain("still here");
  });
});

/**
 * A print stream whose reader has gone, as process.stdout is once `| head` exits: every write fails with EPIPE, each
 * time (Node keeps stdout usable after an error), reported after the write returns, first to its callback and then as an
 * `error` event. An `error` nobody listens for is an uncaught exception, which main.ts logs: `uncaught` stands in for
 * that handler, capped so the loop it once made can't hang the test.
 */
class GoneReader extends EventEmitter {
  writes = 0;
  readonly raised: Error[] = [];
  readonly unheard: Error[] = [];
  uncaught: (err: Error) => void = () => {};
  write(_line: string | Uint8Array, cb?: (err?: Error | null) => void): boolean {
    this.writes++;
    const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" });
    this.raised.push(err);
    process.nextTick(() => {
      cb?.(err);
      if (this.listenerCount("error") > 0) this.emit("error", err);
      else if (this.unheard.push(err) < 50) this.uncaught(err);
    });
    return false;
  }
}

/** Lets every failed write report itself (Node does so on the next tick). */
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe("logger print streams whose reader has gone", () => {
  it("stops printing to stdout after a failed write and keeps writing the file, instead of a loop of uncaught errors (reliability-r8-1)", async () => {
    const stdout = new GoneReader();
    const log = createLogger({ dir: tmp(), stdout: true, streams: { stdout, stderr: new GoneReader() } });
    stdout.uncaught = err => log.error("uncaught exception", { err }); // main.ts's handler as it was
    log.info("first");
    await settle();
    log.info("second");
    log.child("agent").info("third");
    await settle();
    expect(stdout.unheard).toEqual([]);
    expect(stdout.writes).toBe(1);
    const out = lines(log.file);
    expect(out.map(l => l.msg)).toEqual(["first", "log.stream_off", "second", "third"]);
    expect(out[1]).toMatchObject({ level: "warn", stream: "stdout", code: "EPIPE" });
  });

  it("hears a failed write to stderr while printing to stdout, as when a check's child writes there, and says so once (reliability-r8-1)", async () => {
    const stdout = new GoneReader();
    const stderr = new GoneReader();
    const log = createLogger({ dir: tmp(), stdout: true, streams: { stdout, stderr } });
    stdout.uncaught = stderr.uncaught = err => log.error("uncaught exception", { err });
    log.info("first");
    // Node's execFileSync copies a child's stderr to Ember's own.
    stderr.write("gsettings: no such schema\n", () => {});
    stderr.write("gsettings: no such schema\n", () => {});
    await settle();
    expect([...stdout.unheard, ...stderr.unheard]).toEqual([]);
    expect(stdout.writes).toBe(1);
    const out = lines(log.file);
    expect(out.filter(l => l.msg === "log.stream_off").map(l => l.stream).sort()).toEqual(["stderr", "stdout"]);
    expect(out.some(l => l.msg === "uncaught exception")).toBe(false);
  });

  it("stops printing to stderr, where lines go when the logs folder can't be made, after a failed write (reliability-r8-1)", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "logs"), "a file in the way");
    const stderr = new GoneReader();
    const log = createLogger({ dir: path.join(dir, "logs"), streams: { stderr } });
    stderr.uncaught = err => log.error("uncaught exception", { err });
    log.info("first");
    await settle();
    expect(() => log.warn("second")).not.toThrow();
    await settle();
    expect(stderr.unheard).toEqual([]);
    expect(stderr.writes).toBe(1);
  });

  it("stops printing to a stream whose write throws instead of reporting its error (reliability-r8-1)", () => {
    let writes = 0;
    const stdout = { write: () => { writes++; throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" }); }, on: () => stdout };
    const log = createLogger({ dir: tmp(), stdout: true, streams: { stdout, stderr: new GoneReader() } });
    log.info("first");
    log.info("second");
    expect(writes).toBe(1);
    expect(lines(log.file).map(l => l.msg)).toEqual(["first", "log.stream_off", "second"]);
  });

  it("names a log stream's own write errors for main.ts's uncaught-exception handler, and no other error (reliability-r8-1)", async () => {
    const stdout = new GoneReader();
    const log = createLogger({ dir: tmp(), stdout: true, streams: { stdout, stderr: new GoneReader() } });
    log.info("first");
    await settle();
    expect(isLogStreamFailure(stdout.raised[0])).toBe(true);
    // The same words from another pipe (a sidecar's, the runtime's) are still logged.
    expect(isLogStreamFailure(Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" }))).toBe(false);
    expect(isLogStreamFailure("EPIPE")).toBe(false);
    expect(isLogStreamFailure(undefined)).toBe(false);
  });
});
