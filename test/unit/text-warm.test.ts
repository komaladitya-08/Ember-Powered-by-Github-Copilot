/**
 * Warming sharp's text drawing (the first screenshot with Ember's marks on a fresh Windows machine paid fontconfig's
 * cache build: 2 s on one CI runner, more than 15 s on another). It is scheduled once, a few seconds after start, on
 * Windows and macOS only, never for `ember --doctor`, and never again once a start has done it; it is best effort.
 * Main's wiring is read from main.ts's source (Electron's entry point can't be loaded here).
 */

import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OS } from "../../app/shared/shortcuts";

type Warm = typeof import("../../app/main/perception/text-warm");
let warm: Warm;

beforeEach(async () => {
  // The schedule is once per process: each test gets the module afresh.
  vi.resetModules();
  warm = await import("../../app/main/perception/text-warm");
});

function setup(o: { os?: OS; argv?: string[]; marker?: string | null; draw?: () => Promise<void>; write?: (p: string, t: string) => void } = {}) {
  const timers: { f: () => void; ms: number }[] = [];
  const written: [string, string][] = [];
  const log = { info: vi.fn(), warn: vi.fn() };
  const draw = vi.fn(o.draw ?? (async () => undefined));
  const opts = {
    os: o.os ?? "win32", argv: o.argv ?? ["Ember.exe"], marker: "C:\\Users\\a\\AppData\\Local\\ember\\text-warmed", key: "1.2.0",
    draw, log, later: (f: () => void, ms: number) => { timers.push({ f, ms }); },
    files: {
      read: () => (o.marker === undefined ? null : o.marker),
      write: o.write ?? ((p: string, t: string) => { written.push([p, t]); }),
    },
  };
  /** Runs what was scheduled and lets its drawing finish. */
  const fire = async () => { for (const t of timers.splice(0)) t.f(); await new Promise(r => setTimeout(r, 0)); };
  return { opts, timers, written, log, draw, fire };
}

describe("warming sharp's text for the first marked screenshot", () => {
  it("is scheduled once, a few seconds after start, and draws only when its time comes", async () => {
    const s = setup();
    expect(warm.scheduleTextWarm(s.opts)).toBe(true);
    expect(warm.scheduleTextWarm(s.opts)).toBe(false);
    expect(s.timers).toHaveLength(1);
    expect(s.timers[0]!.ms).toBeGreaterThanOrEqual(5000);
    // Start-up isn't held: nothing is drawn yet.
    expect(s.draw).not.toHaveBeenCalled();
    await s.fire();
    expect(s.draw).toHaveBeenCalledTimes(1);
    // Done once for this user: later starts find the marker.
    expect(s.written).toEqual([[s.opts.marker, "1.2.0"]]);
    expect(s.log.info).toHaveBeenCalledWith("text_warm.done", expect.objectContaining({ ms: expect.any(Number) }));
  });

  it("isn't scheduled where it was already done for this version, and is after an update", () => {
    expect(warm.scheduleTextWarm(setup({ marker: "1.2.0" }).opts)).toBe(false);
    expect(warm.scheduleTextWarm(setup({ marker: "1.1.0" }).opts)).toBe(true);
  });

  it("runs on macOS too, and not on Linux", () => {
    expect(warm.scheduleTextWarm(setup({ os: "linux" }).opts)).toBe(false);
    expect(warm.scheduleTextWarm(setup({ os: "darwin" }).opts)).toBe(true);
  });

  it("doesn't run when Ember starts for --doctor", () => {
    const s = setup({ argv: ["Ember.exe", "--doctor"] });
    expect(warm.scheduleTextWarm(s.opts)).toBe(false);
    expect(s.timers).toHaveLength(0);
  });

  it("is best effort: a drawing that fails or throws, or a marker that can't be written, is logged and nothing more", async () => {
    const failing = setup({ draw: async () => { throw new Error("no fonts"); } });
    warm.scheduleTextWarm(failing.opts);
    await expect(failing.fire()).resolves.toBeUndefined();
    expect(failing.log.warn).toHaveBeenCalledWith("text_warm.failed", expect.objectContaining({ err: expect.any(Error) }));
    // Not done: a later start tries again.
    expect(failing.written).toEqual([]);

    vi.resetModules();
    warm = await import("../../app/main/perception/text-warm");
    const throwing = setup({ draw: () => { throw new Error("sharp didn't load"); } });
    warm.scheduleTextWarm(throwing.opts);
    await expect(throwing.fire()).resolves.toBeUndefined();
    expect(throwing.log.warn).toHaveBeenCalledWith("text_warm.failed", expect.anything());

    vi.resetModules();
    warm = await import("../../app/main/perception/text-warm");
    const readOnly = setup({ write: () => { throw new Error("EACCES"); } });
    warm.scheduleTextWarm(readOnly.opts);
    await expect(readOnly.fire()).resolves.toBeUndefined();
    expect(readOnly.log.warn).toHaveBeenCalledWith("text_warm.marker_failed", expect.anything());
  });

  it("draws a mark's text with sharp", async () => {
    const { warmText } = await import("../../app/main/perception/capture");
    await expect(warmText()).resolves.toBeUndefined();
  });

  it("is what main schedules when it starts, never in the doctor's run", () => {
    const main = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8");
    expect(main).toMatch(/scheduleTextWarm\(\{[^}]*argv: process\.argv[^}]*draw: warmText/);
    const doctor = main.slice(main.indexOf("async function runDoctor"), main.indexOf("\n}\n", main.indexOf("async function runDoctor")));
    expect(doctor).not.toContain("scheduleTextWarm");
  });
});
