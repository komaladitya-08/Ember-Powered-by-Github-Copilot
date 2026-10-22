/**
 * The Windows window system and input backends on a real Windows desktop, against the WinForms bench
 * (test/fixtures/win_bench.ps1, which logs what happens to it as JSON lines): the bench is in the stack and the apps'
 * windows with its process and program name, activation brings it to the front, a capture of it has real pixels, a
 * click on its Save button arrives, text typed with KEYEVENTF_UNICODE arrives whatever the layout, and nothing stays
 * pressed. Skipped off Windows; with EMBER_WIN32_TEST=1 it fails instead of skipping when Windows, the backends or
 * Windows PowerShell are missing, so CI learns what broke.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Input, Rect, ScreenLike } from "../../app/main/platform/types";
import { openWin32Input, openWin32Windows, win32Error, type Win32WindowSystem } from "../../app/main/platform/win32";

const required = process.env.EMBER_WIN32_TEST === "1";
const onWindows = process.platform === "win32";
const TITLE = "Ember Bench (Windows)";
const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const benchScript = fileURLToPath(new URL("../fixtures/win_bench.ps1", import.meta.url));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface BenchEvent { event: string; control?: string; length?: number; hwnd?: number; pid?: number; controls?: Record<string, Rect> }

/** Polls `fn` until it gives something truthy, or fails after `ms` saying what was awaited. */
async function waitFor<T>(fn: () => T | null | undefined | false, ms: number, what: string): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const centre = (r: Rect) => ({ x: r.x + Math.floor(r.width / 2), y: r.y + Math.floor(r.height / 2) });

/** Starts a bench that logs to `log` (its window shows; Windows PowerShell shares the test's console). */
function startBench(log: string): ChildProcess {
  return spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", benchScript, "-Log", log, "-Seconds", "300"], { stdio: ["ignore", "inherit", "inherit"] });
}

describe.skipIf(!onWindows && !required)("the Windows backends on a real desktop", () => {
  let ws: Win32WindowSystem;
  let x: Input;
  let bench: ChildProcess | undefined;
  let dir = "";
  let log = "";
  let ready: BenchEvent;
  let hwnd = 0;

  const events = (path = log): BenchEvent[] => {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line) as BenchEvent]; } catch { return []; } // a line still being written
    });
  };
  const seen = (match: (e: BenchEvent) => boolean) => events().some(match);
  const controlRect = (name: string): Rect => {
    const r = ready.controls?.[name];
    if (!r) throw new Error(`the bench's ready line has no rectangle for "${name}"`);
    return r;
  };

  beforeAll(async () => {
    // Every facility the suite needs, each failing loudly (this only runs on Windows or with EMBER_WIN32_TEST=1).
    if (!onWindows) throw new Error("EMBER_WIN32_TEST=1, but this isn't Windows");
    const screen: ScreenLike = {
      getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 1 }),
      getAllDisplays: () => [],
    };
    const opened = openWin32Windows({ screen });
    if (!opened) throw new Error(`the Windows window system didn't open: ${String(win32Error)}`);
    ws = opened;
    const input = openWin32Input();
    if (!input) throw new Error(`Windows input didn't open: ${String(win32Error)}`);
    x = input;
    if (!existsSync(powershell)) throw new Error(`Windows PowerShell isn't at ${powershell}`);
    dir = mkdtempSync(join(tmpdir(), "ember-bench-"));
    log = join(dir, "bench.jsonl");
    bench = startBench(log);
    ready = await waitFor(() => events().find(e => e.event === "ready"), 45_000, "the bench's ready line");
    hwnd = (ready.hwnd ?? 0) >>> 0;
    expect(hwnd).toBeGreaterThan(0);
    expect(ready.pid).toBe(bench.pid);
  }, 60_000);

  afterAll(() => {
    x?.releaseAll();
    x?.close();
    ws?.close();
    bench?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("lists the bench in the stack and the apps' windows with its process, program name and title", () => {
    const stacked = ws.stack().find(w => w.id === hwnd);
    expect(stacked).toMatchObject({ client: hwnd, pid: ready.pid, title: TITLE, wmClass: "powershell", overrideRedirect: false });
    // The window rectangle has the invisible resize borders the DWM frame leaves out; the client area is inside.
    expect(stacked!.outer.width).toBeGreaterThanOrEqual(stacked!.width);
    expect(stacked!.inner.width).toBeLessThanOrEqual(stacked!.width);
    const listed = ws.clientWindows().find(w => w.id === hwnd);
    expect(listed).toMatchObject({ pid: ready.pid, title: TITLE, wmClass: "powershell" });
    expect(listed!.wmClassName).toMatch(/^WindowsForms10\./);
  });

  it("finds the bench by its title, and lets input reach it", () => {
    expect(x.findWindow(TITLE, ready.pid)).toBe(hwnd);
    expect(x.findWindow(TITLE, undefined, "powershell")).toBe(hwnd);
    expect(x.blockedReason!(hwnd)).toBeNull();
    expect(x.screenLocked!()).toBe(false);
    expect(x.keyboardGrabbed!()).toBe(false);
  });

  it("brings the bench to the front: it becomes the active and focused window", async () => {
    x.activate(hwnd);
    await waitFor(() => x.activeWindow() === hwnd, 3_000, "the bench to become the foreground window");
    await waitFor(() => x.focusedWindow() === hwnd, 3_000, "the bench to have the keyboard");
    expect(ws.activeWindow()?.id).toBe(hwnd);
    expect(ws.focusWindow()?.id).toBe(hwnd);
  });

  it("captures the bench as BGRA pixels that aren't all one colour", () => {
    const stacked = ws.stack().find(w => w.id === hwnd)!;
    const img = ws.capture(stacked.x, stacked.y, stacked.width, stacked.height);
    expect(img).not.toBeNull();
    expect(img!.bgra.length).toBe(img!.width * img!.height * 4);
    expect(img!.width).toBeGreaterThan(100);
    const first = img!.bgra.readUInt32LE(0) & 0xffffff;
    let differs = false;
    for (let i = 0; i < img!.bgra.length && !differs; i += 4) differs = (img!.bgra.readUInt32LE(i) & 0xffffff) !== first;
    expect(differs).toBe(true);
    const screen = ws.screenBounds();
    expect(stacked.x).toBeGreaterThanOrEqual(screen.x);
    expect(stacked.x + stacked.width).toBeLessThanOrEqual(screen.x + screen.width);
  });

  it("moves the pointer exactly onto the Save button and clicks it", async () => {
    const at = centre(controlRect("Save"));
    expect(x.onScreen!(at.x, at.y)).toBe(true);
    x.move(at.x, at.y);
    await sleep(50);
    expect(x.pointer()).toEqual(at);
    expect(ws.pointer()).toMatchObject(at);
    expect(x.pointerOn!(hwnd)).toBe(true);
    x.button(1, true);
    await sleep(40);
    expect(x.pointerState()!.mask & 256).toBe(256);
    x.button(1, false);
    await waitFor(() => seen(e => e.event === "click" && e.control === "Save"), 3_000, `{"event":"click","control":"Save"}`);
    expect(x.pointerState()!.mask).toBe(0);
  });

  it("types into the Name box with KEYEVENTF_UNICODE, accents included", async () => {
    const at = centre(controlRect("Name"));
    // The Name box had the focus when the bench opened: wait for a new focus event, the one this click gives.
    const focused = () => events().filter(e => e.event === "focus" && e.control === "Name").length;
    const before = focused();
    x.move(at.x, at.y);
    await sleep(30);
    x.button(1, true);
    await sleep(40);
    x.button(1, false);
    await waitFor(() => focused() > before, 3_000, "the Name box to have the focus");
    const text = "Ember 1é";
    for (const ch of text) {
      expect(x.textKey!(ch, true)).toBe(true);
      expect(x.textKey!(ch, false)).toBe(true);
      await sleep(12);
    }
    await waitFor(() => seen(e => e.event === "text" && e.control === "Name" && e.length === text.length), 3_000, `the Name box to hold ${text.length} characters`);
  });

  it("finds keys on the desktop's layout: letters by their VK, punctuation through the layout, never a dead key", () => {
    expect(x.keycodeOf(x.keysymOf("a"))).toBe(0x41);
    expect(x.needsShift(x.keysymOf("A"))).toBe(true);
    // "/" has a live key (shifted or not) on every layout a CI machine has; the lookup asks ToUnicodeEx for real.
    expect(x.keycodeOf(x.keysymOf("slash"))).toBeGreaterThan(0);
  });

  it("reports no keys down when idle, and nothing stays down after releaseAll()", async () => {
    expect(x.keysDown()).toEqual([]);
    expect(ws.keysDown()).toEqual({ control: false, alt: false, space: false });
    const shift = x.keycodeOf(x.keysymOf("Shift_L"));
    expect(shift).toBe(0xa0);
    expect(x.keysym(x.keysymOf("Shift_L"), true)).toBe(true);
    x.button(2, true);
    await sleep(20);
    expect(x.keysDown()).toContain(shift);
    x.releaseAll();
    await sleep(20);
    expect(x.keysDown()).toEqual([]);
    expect(x.pointerState()!.mask).toBe(0);
  });

  it("knows the bench's centre is on a monitor and a point far off isn't", () => {
    const stacked = ws.stack().find(w => w.id === hwnd)!;
    const at = centre(stacked);
    expect(x.onScreen!(at.x, at.y)).toBe(true);
    const screen = ws.screenBounds();
    expect(x.onScreen!(screen.x - 10_000, screen.y - 10_000)).toBe(false);
    expect(x.screenSize()).toEqual({ width: screen.width, height: screen.height });
  });

  it("takes the foreground from another app's window and back, and tells two same-titled windows apart by process", async () => {
    const otherLog = join(dir, "other.jsonl");
    const other = startBench(otherLog);
    try {
      const otherReady = await waitFor(() => events(otherLog).find(e => e.event === "ready"), 45_000, "the second bench's ready line");
      const otherHwnd = (otherReady.hwnd ?? 0) >>> 0;
      x.activate(otherHwnd);
      await waitFor(() => x.activeWindow() === otherHwnd, 3_000, "the second bench to take the foreground");
      x.activate(hwnd);
      await waitFor(() => x.activeWindow() === hwnd, 3_000, "the first bench to take the foreground back");
      expect(x.focusedWindow()).toBe(hwnd);
      expect(x.findWindow(TITLE, ready.pid)).toBe(hwnd);
      expect(x.findWindow(TITLE, otherReady.pid)).toBe(otherHwnd);
      expect(x.findWindow(TITLE)).toBe(0); // two windows with that title: input to a guess could go anywhere
    } finally {
      other.kill();
    }
  }, 60_000);
});
