import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../../app/main/logger";

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
  it("never throws on circular values, BigInts or nested errors, and keeps codes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-log-"));
    const log = createLogger({ dir });
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    const err = Object.assign(new Error("boom"), { code: "ENOSPC" });
    expect(() => log.error("odd", { loop, big: 10n, nested: { err } })).not.toThrow();
    const line = JSON.parse(fs.readFileSync(log.file, "utf8").trim().split("\n").at(-1)!);
    expect(line).toMatchObject({ big: "10", loop: { a: 1, self: "[circular]" }, nested: { err: { message: "boom", code: "ENOSPC" } } });
    expect(fs.statSync(log.file).mode & 0o077).toBe(0);
  });
});
