/**
 * The Windows window system and input backends on a real Windows desktop, against Ember's bench (test/fixtures/
 * win_bench.ps1 builds EmberBench.exe, a WinForms window that logs what happens to it as JSON lines): the bench is in
 * the stack and the apps' windows with its process and its own program name, also as a 32-bit build; activation
 * brings it to the front from a timer within a second, and no read or activation waits for a busy app; a capture of
 * it has real pixels and holds a layered window (the run reports whether it would without CAPTUREBLT); clicks and
 * keys reach its button, list view and tree view; text typed with KEYEVENTF_UNICODE arrives whatever the layout;
 * nothing stays pressed; killing the script that started a bench ends it; and a console window started from a
 * shortcut is named conhost, with its client's program beside it. Skipped off Windows; with EMBER_WIN32_TEST=1 it
 * fails instead of skipping when Windows, the backends or Windows PowerShell are missing, so CI learns what broke.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Input, Rect, ScreenLike } from "../../app/main/platform/types";
import { openWin32Input, openWin32Windows, win32Error, type Win32WindowSystem } from "../../app/main/platform/win32";
import { loadWin32 } from "../../app/main/platform/win32/ffi";

const required = process.env.EMBER_WIN32_TEST === "1";
const onWindows = process.platform === "win32";
const TITLE = "Ember Bench (Windows)";
const PROGRAM = "EmberBench";
const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
const benchScript = fileURLToPath(new URL("../fixtures/win_bench.ps1", import.meta.url));
const WS_EX_LAYERED = 0x80000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface BenchEvent {
  event: string;
  control?: string;
  value?: string | number;
  length?: number;
  expanded?: boolean;
  hwnd?: number;
  pid?: number;
  program?: string;
  bits?: number;
  controls?: Record<string, Rect>;
  items?: Record<string, Rect>;
  layered?: Rect & { hwnd: number; alpha: number };
}

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

/** The bench's log lines (UTF-8 JSON, one per line; a line still being written is skipped until it is whole). */
function events(path: string): BenchEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as BenchEvent]; } catch { return []; }
  });
}

/** Builds the bench for a platform (cached in %TEMP% per version) and gives its EmberBench.exe. */
function buildBench(platform: "anycpu" | "x86"): string {
  const r = spawnSync(powershell, [...POWERSHELL_ARGS, "-File", benchScript, "-BuildOnly", "-Platform", platform], { encoding: "utf8", windowsHide: true, timeout: 180_000 });
  if (r.status !== 0) throw new Error(`the bench didn't build for ${platform} (exit ${String(r.status)}): ${r.stderr || String(r.error)}`);
  const line = r.stdout.trim().split(/\r?\n/).pop() ?? "";
  const { exe } = JSON.parse(line) as { exe: string };
  if (!existsSync(exe)) throw new Error(`the bench's build said ${line}, but there is no such file`);
  return exe;
}

/**
 * Starts EmberBench.exe itself, so its process is the window's; it ends on its own after 15 minutes at the latest.
 * Not windowsHide: that would hide the bench's window.
 */
function startBench(exe: string, log: string, extra: string[] = []): ChildProcess {
  return spawn(exe, ["-Log", log, "-Seconds", "900", ...extra], { stdio: ["ignore", "inherit", "inherit"] });
}

/** The share of BGRA pixels that are the swatch's red, whatever an alpha just below 255 lets through. */
function redShare(bgra: Buffer): number {
  let red = 0;
  for (let i = 0; i < bgra.length; i += 4) if (bgra[i + 2] >= 230 && bgra[i + 1] <= 40 && bgra[i] <= 40) red++;
  return bgra.length ? red / (bgra.length / 4) : 0;
}

describe.skipIf(!onWindows && !required)("the Windows backends on a real desktop", () => {
  let ws: Win32WindowSystem;
  let x: Input;
  let exe = "";
  let bench: ChildProcess | undefined;
  const others: ChildProcess[] = [];
  let dir = "";
  let log = "";
  let commands = "";
  let ready: BenchEvent;
  let hwnd = 0;

  const seen = (match: (e: BenchEvent) => boolean, path = log) => events(path).some(match);
  const controlRect = (name: string): Rect => {
    const r = ready.controls?.[name];
    if (!r) throw new Error(`the bench's ready line has no rectangle for "${name}"`);
    return r;
  };
  const click = async (at: { x: number; y: number }) => {
    x.move(at.x, at.y);
    await sleep(30);
    x.button(1, true);
    await sleep(40);
    x.button(1, false);
  };
  /** Starts another bench (`start` runs EmberBench.exe or the script) and waits for its ready line. */
  const another = async (name: string, start: (log: string) => ChildProcess): Promise<{ log: string; proc: ChildProcess; ready: BenchEvent; hwnd: number }> => {
    const otherLog = join(dir, `${name}.jsonl`);
    const proc = start(otherLog);
    others.push(proc);
    const otherReady = await waitFor(() => events(otherLog).find(e => e.event === "ready"), 90_000, `the ${name} bench's ready line`);
    return { log: otherLog, proc, ready: otherReady, hwnd: (otherReady.hwnd ?? 0) >>> 0 };
  };
  /** Gives the bench a command through its -Commands file, renamed into place so it is read whole. */
  const command = (text: string) => {
    writeFileSync(`${commands}.tmp`, `${text}\n`);
    renameSync(`${commands}.tmp`, commands);
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
    commands = join(dir, "bench.cmd");
    exe = buildBench("anycpu");
    bench = startBench(exe, log, ["-Layered", "-Commands", commands]);
    ready = await waitFor(() => events(log).find(e => e.event === "ready"), 45_000, "the bench's ready line");
    hwnd = (ready.hwnd ?? 0) >>> 0;
    expect(hwnd).toBeGreaterThan(0);
    // Its own program, 64-bit, and the window is the process's that was started.
    expect(ready).toMatchObject({ pid: bench.pid, program: PROGRAM, bits: 64 });
  }, 240_000);

  afterAll(() => {
    x?.releaseAll();
    x?.close();
    ws?.close();
    for (const p of [bench, ...others]) if (p && p.exitCode === null) p.kill();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("lists the bench in the stack and the apps' windows with its process, its own program name and title", () => {
    const stacked = ws.stack().find(w => w.id === hwnd);
    expect(stacked).toMatchObject({ client: hwnd, pid: ready.pid, title: TITLE, wmClass: PROGRAM, overrideRedirect: false });
    expect(stacked).not.toHaveProperty("clientProgram"); // only console windows have one
    // The window rectangle has the invisible resize borders the DWM frame leaves out; the client area is inside.
    expect(stacked!.outer.width).toBeGreaterThanOrEqual(stacked!.width);
    expect(stacked!.inner.width).toBeLessThanOrEqual(stacked!.width);
    const listed = ws.clientWindows().find(w => w.id === hwnd);
    expect(listed).toMatchObject({ pid: ready.pid, title: TITLE, wmClass: PROGRAM });
    expect(listed!.wmClassName).toMatch(/^WindowsForms10\./);
    // The swatch is a tool window: in the stack (it covers what is under it), not among the apps' windows.
    const swatch = (ready.layered?.hwnd ?? 0) >>> 0;
    expect(ws.stack().some(w => w.id === swatch)).toBe(true);
    expect(ws.clientWindows().some(w => w.id === swatch)).toBe(false);
  });

  it("finds the bench by its title, and lets input reach it", () => {
    expect(x.findWindow(TITLE, ready.pid)).toBe(hwnd);
    expect(x.findWindow(TITLE, undefined, PROGRAM)).toBe(hwnd);
    expect(x.findWindow(TITLE, undefined, "emberbench.exe")).toBe(hwnd);
    expect(x.findWindow(TITLE, undefined, "powershell")).toBe(0);
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

  it("captures a layered window with CAPTUREBLT, and reports whether a copy without the flag has it too", () => {
    const swatch = ready.layered;
    expect(swatch, "the ready line's layered swatch (-Layered)").toBeTruthy();
    const api = loadWin32();
    expect(api).not.toBeNull();
    // The premise: a layered window (WS_EX_LAYERED with a constant alpha below 255) on top of that spot.
    const id = swatch!.hwnd >>> 0;
    expect(api!.exStyle(id) & WS_EX_LAYERED).toBe(WS_EX_LAYERED);
    const alpha = api!.layeredAlpha(id);
    expect(alpha).not.toBeNull();
    expect(alpha!).toBeLessThan(255);
    const r = { x: swatch!.x + 8, y: swatch!.y + 8, width: swatch!.width - 16, height: swatch!.height - 16 };
    expect(api!.windowFromPoint(r.x + 1, r.y + 1)).toBe(id);
    // Ember's capture (SRCCOPY | CAPTUREBLT) has the layered window as it is composed on screen.
    const shipped = ws.capture(r.x, r.y, r.width, r.height);
    expect(shipped).not.toBeNull();
    const withFlag = redShare(shipped!.bgra);
    expect(withFlag, "share of the swatch's red in Ember's capture").toBeGreaterThan(0.95);
    // The measurement (FX-PW item 4): the same copy with SRCCOPY alone. Recorded, not asserted: it decides the flag.
    const bare = api!.blit(r.x, r.y, r.width, r.height, false);
    expect(bare).not.toBeNull();
    const without = redShare(bare!);
    const verdict = without > 0.95 ? "includes" : without < 0.05 ? "leaves out" : "partly shows";
    const evidence = `CAPTUREBLT evidence on Windows ${release()}: a screen-DC BitBlt without CAPTUREBLT ${verdict} a layered `
      + `window (alpha ${String(alpha)}; ${Math.round(without * 100)} % of ${bare!.length / 4} pixels red; with CAPTUREBLT `
      + `${Math.round(withFlag * 100)} %)`;
    console.log(evidence);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${evidence}\n`);
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
    // The Name box had the focus when the bench opened: wait for a new focus event, the one this click gives.
    const focused = () => events(log).filter(e => e.event === "focus" && e.control === "Name").length;
    const before = focused();
    await click(centre(controlRect("Name")));
    await waitFor(() => focused() > before, 3_000, "the Name box to have the focus");
    const text = "Ember 1é";
    for (const ch of text) {
      expect(x.textKey!(ch, true)).toBe(true);
      expect(x.textKey!(ch, false)).toBe(true);
      await sleep(12);
    }
    await waitFor(() => seen(e => e.event === "text" && e.control === "Name" && e.length === text.length), 3_000, `the Name box to hold ${text.length} characters`);
  });

  it("selects and opens an item of the list view, and selects and expands a node of the tree view", async () => {
    const item = ready.items?.["Files/photo.jpg"];
    const node = ready.items?.["Places/Documents"];
    expect(item, "the ready line's rectangle for Files/photo.jpg").toBeTruthy();
    expect(node, "the ready line's rectangle for Places/Documents").toBeTruthy();
    await click(centre(item!));
    await waitFor(() => seen(e => e.event === "select" && e.control === "Files" && e.value === "photo.jpg"), 3_000, "the list view's select event");
    expect(seen(e => e.event === "open")).toBe(false); // one click selects, never opens
    await click(centre(item!));
    await sleep(20);
    await click(centre(item!));
    await waitFor(() => seen(e => e.event === "open" && e.control === "Files" && e.value === "photo.jpg"), 3_000, "the list view's open event (a double-click)");
    await click(centre(node!));
    await waitFor(() => seen(e => e.event === "select" && e.control === "Places" && e.value === "Documents"), 3_000, "the tree view's select event");
    const right = x.keysymOf("Right");
    expect(x.keysym(right, true)).toBe(true);
    x.keysym(right, false);
    await waitFor(() => seen(e => e.event === "expand" && e.control === "Places" && e.value === "Documents" && e.expanded === true), 3_000, "the tree view's expand event");
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

  it("takes the foreground from another app's window and back from a timer within a second, telling same-titled windows apart", async () => {
    // Started through the script, as the bridge's and the host's tests start it: the window is EmberBench.exe's.
    const other = await another("scripted", path => spawn(powershell, [...POWERSHELL_ARGS, "-File", benchScript, "-Log", path, "-Seconds", "900"], { stdio: ["ignore", "inherit", "inherit"] }));
    expect(other.ready.pid).not.toBe(other.proc.pid);
    expect(other.ready.program).toBe(PROGRAM);
    // From a timer, as CursorBorrow activates, with its one-second wait.
    const fromTimer = (window: number) => new Promise<void>(resolve => setTimeout(() => { x.activate(window); resolve(); }, 0));
    await fromTimer(other.hwnd);
    await waitFor(() => x.activeWindow() === other.hwnd, 1_000, "the second bench to take the foreground");
    await fromTimer(hwnd);
    await waitFor(() => x.activeWindow() === hwnd, 1_000, "the first bench to take the foreground back");
    expect(x.focusedWindow()).toBe(hwnd);
    expect(x.findWindow(TITLE, ready.pid)).toBe(hwnd);
    expect(x.findWindow(TITLE, other.ready.pid)).toBe(other.hwnd);
    expect(x.findWindow(TITLE)).toBe(0); // two windows with that title: input to a guess could go anywhere
    // Killing the script ends the bench it started (the tests' clean-up relies on it).
    other.proc.kill();
    await waitFor(() => seen(e => e.event === "exit", other.log), 5_000, "the second bench to exit with its script");
    await waitFor(() => !ws.clientWindows().some(w => w.id === other.hwnd), 5_000, "the second bench's window to go");
  }, 120_000);

  it("never waits for a busy app: reading, finding and activating windows return at once while the bench is busy", async () => {
    const other = await another("front", path => startBench(exe, path));
    x.activate(other.hwnd);
    await waitFor(() => x.activeWindow() === other.hwnd, 3_000, "another window to be in front");
    command("busy 3000");
    await waitFor(() => seen(e => e.event === "busy"), 3_000, "the bench to be busy");
    await sleep(200);
    const api = loadWin32()!;
    expect(api.isHung(hwnd), "busy for 3 s, not hung (Windows waits 5 s)").toBe(false);
    const timed = (what: string, fn: () => unknown) => {
      const t0 = performance.now();
      fn();
      const ms = performance.now() - t0;
      expect(ms, `${what} took ${ms.toFixed(0)} ms while the bench was busy`).toBeLessThan(500);
    };
    timed("stack()", () => expect(ws.stack().some(w => w.id === hwnd)).toBe(true));
    timed("clientWindows()", () => expect(ws.clientWindows().find(w => w.id === hwnd)?.title).toBe(TITLE));
    timed("findWindow()", () => expect(x.findWindow(TITLE, ready.pid)).toBe(hwnd));
    timed("activate()", () => x.activate(hwnd));
    timed("activeWindow()", () => ws.activeWindow());
    expect(seen(e => e.event === "idle"), "the bench still busy after the calls").toBe(false);
    await waitFor(() => seen(e => e.event === "idle"), 6_000, "the bench to be idle again");
    await waitFor(() => x.activeWindow() === hwnd, 3_000, "the bench to be in front once it handles messages again");
    other.proc.kill();
  }, 120_000);

  it("reads and drives a 32-bit build of the bench like the 64-bit one", async () => {
    const x86 = buildBench("x86");
    const other = await another("x86", path => startBench(x86, path));
    expect(other.ready).toMatchObject({ pid: other.proc.pid, program: PROGRAM, bits: 32 });
    expect(ws.clientWindows().find(w => w.id === other.hwnd)).toMatchObject({ pid: other.proc.pid, wmClass: PROGRAM, title: TITLE });
    expect(x.blockedReason!(other.hwnd)).toBeNull();
    x.activate(other.hwnd);
    await waitFor(() => x.activeWindow() === other.hwnd, 3_000, "the 32-bit bench to take the foreground");
    const save = other.ready.controls?.Save;
    expect(save).toBeTruthy();
    await click(centre(save!));
    await waitFor(() => seen(e => e.event === "click" && e.control === "Save", other.log), 3_000, "the 32-bit bench's click event");
    other.proc.kill();
  }, 240_000);

  it("names a console window started from a shortcut conhost, with the program inside as clientProgram", async () => {
    // As a Python REPL or a command prompt started from the Start menu: Windows reports the first client's process
    // (here cmd.exe) for the console window conhost.exe draws.
    const title = `Ember console ${process.pid}`;
    const lnk = join(dir, "Ember console.lnk");
    const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$link = (New-Object -ComObject WScript.Shell).CreateShortcut(${quote(lnk)})`,
      "$link.TargetPath = Join-Path $env:SystemRoot 'System32\\cmd.exe'",
      `$link.Arguments = ${quote(`/k title ${title}`)}`,
      "$link.Save()",
      `$p = Start-Process -FilePath ${quote(lnk)} -PassThru`,
      "if ($p) { $p.Id } else { 0 }",
    ].join("; ");
    const r = spawnSync(powershell, [...POWERSHELL_ARGS, "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    const started = Number(r.stdout.trim().split(/\r?\n/).pop()) || 0;
    let consolePid = started;
    try {
      const win = await waitFor(() => ws.clientWindows().find(w => w.title.includes(title)), 15_000, `a window titled "${title}"`);
      if (win.wmClassName === "CASCADIA_HOSTING_WINDOW_CLASS") {
        // Windows 11's default terminal took the console over: the window is Windows Terminal's own.
        expect(win.wmClass.toLowerCase()).toBe("windowsterminal");
        // §10 item 10's wording, in the log and the job summary, so the check is listed as not run rather than passed.
        const note = "not testable on this runner: the default terminal is Windows Terminal, so no classic console window opened";
        console.log(note);
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- console windows: ${note}\n`);
        return;
      }
      if (!consolePid) consolePid = win.pid ?? 0;
      expect(win).toMatchObject({ wmClass: "conhost", clientProgram: "cmd", wmClassName: "ConsoleWindowClass" });
      if (started) expect(win.pid).toBe(started);
      expect(ws.stack().find(w => w.id === win.id)).toMatchObject({ wmClass: "conhost", clientProgram: "cmd", pid: win.pid });
      expect(x.findWindow(win.title, undefined, "conhost")).toBe(win.id);
      x.activate(win.id);
      await waitFor(() => x.activeWindow() === win.id, 3_000, "the console window to take the foreground");
      expect(ws.activeWindow()).toMatchObject({ id: win.id, wmClass: "conhost", clientProgram: "cmd" });
    } finally {
      if (consolePid) spawnSync("taskkill", ["/PID", String(consolePid), "/T", "/F"], { windowsHide: true });
    }
  }, 90_000);
});
