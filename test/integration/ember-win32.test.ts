/**
 * Ember-level checks on a real Windows desktop (design §11.5): Ember's own Windows composition (win32Platform, what
 * loadPlatform gives on Windows) opened as main opens it, with its window system, input and accessibility host
 * (sidecarLaunch: the host built from source and run as plain Node, the UI Automation bridge's script and a cache of its
 * own), and Perception on top, wired as main wires it. Against Ember's bench (EmberBench.exe from
 * test/fixtures/win_bench.ps1): systemDialogOpen is false at rest, both from the window system and through Perception;
 * a window-scope screenshot of the bench has real pixels and its password field blacked out; Ember's overlay (the
 * stand-in in overlay-child.ts: the overlay's own window options in a real Electron) shows in a plain capture and is
 * gone from Perception's, which hides it as main does, and shows again afterwards; C15, the window the bridge lists for
 * the Settings app matched by pid to the window system's frame (only with UAC on: EMBER_CI_LUA); and the packaged
 * accessibility host answers a ping when run as Ember.exe in node mode (EMBER_PACKAGED_APP, after staging). Last, Ember
 * itself (the development build, npm run build) started as at login: the real ask chord (Win+Alt+Space through
 * SendInput), pressed while the user types in the bench's Name field, opens the box, and what it holds of letters typed
 * straight after is printed (review #78: Windows has no typed-ahead hold; typeahead-probe.ts), with when Ember heard
 * the chord, showed the box and had the keyboard (its log), how many letters the bench got, and the box's tip to wait
 * for it (its first openings); then its right-click menu, opened once the field is the window under the pointer (waited
 * for and named in the output, window-at.ts: cifix-2; a box that closed before then fails at once, with which window
 * had the foreground and what Ember's windows did from the chord on: cifix-x9-2) and dismissed by a click on the bench,
 * leaves the bench the keyboard (review #77). Then a probe that only prints opens the box again with each stage of its read
 * of the bench left out (EMBER_TEST_ASK_READ: cifix-x9-9, cifix-x9-10). Last, Ember started again with Text size set to Larger through its
 * settings opens the box 728 × 142 DIP (173 with the tip's row), its page and field at that size (review #57;
 * ask-size.ts).
 *
 * Skipped off Windows; with EMBER_WIN32_TEST=1 it fails instead of skipping when Windows, the backends, Windows
 * PowerShell, Electron or (with EMBER_PACKAGED_APP set) the packaged app is missing. What this runner can't show is
 * printed as "not testable on this runner: <reason>" from the facts CI exports, never passed vacuously.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import sharp from "sharp";
import type { ElectronParts, Input, Platform, PlatformDeps, Rect, ScreenLike, SidecarLaunch, WindowSystem } from "../../app/main/platform/types";
import type { Logger } from "../../app/main/logger";
import { loadPlatform } from "../../app/main/platform";
import { loadWin32 } from "../../app/main/platform/win32/ffi";
import { AtspiSidecar, type SidecarStatus } from "../../app/main/perception/sidecar";
import { Perception } from "../../app/main/perception";
import { matchFrame } from "../../app/main/perception/windows";
import type { Capture } from "../../app/main/perception/capture";
import { startOverlayChild, type OverlayChild } from "./overlay-child";
import { PROBE_PACE_MS, PROBE_TEXT, probeTimeline, probeVerdict } from "./typeahead-probe";
import { askWant, closeAsk, openAskAt, setTextSize, type InEmber } from "./ask-size";
import { focusTrail, hoverActivation, lookAt, readProbeSummary, waitForWindowAt, watchEvent, type ProbeLook, type ProbeMark, type TrailEvent, type WatchedWindow, type WindowAt } from "./window-at";

const required = process.env.EMBER_WIN32_TEST === "1";
const onWindows = process.platform === "win32";
// Without the trailing separator: as a command-line argument, `"D:\a\Ember\"` ends in an escaped quote on Windows.
const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const TITLE = "Ember Bench (Windows)";
const powershell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
const benchScript = path.join(root, "test", "fixtures", "win_bench.ps1");
const watchScript = path.join(root, "test", "fixtures", "win_foreground_watch.ps1");
const packaged = process.env.EMBER_PACKAGED_APP ? path.resolve(root, process.env.EMBER_PACKAGED_APP) : "";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/**
 * How long the Ask field may be under another window before the right-click is given up (cifix-2): Ember's hello can
 * come up to 6 s after start and stays 15 s at most, and nothing else of Ember's is over the box by itself. That is
 * the limit for another program's window or none (timing); one of Ember's own over the field is given OWN_OVER_MS.
 */
const ASK_FIELD_WAIT_MS = 22_000;
/**
 * How long one of Ember's own windows (its overlay, handle, a menu) may stay over a point this suite is about to press
 * (cifix-x9-1): one period of the overlay taking the top back. Longer, and a real press there would go to Ember's
 * bubble instead of the field, so the test fails saying so rather than waiting it out.
 */
const OWN_OVER_MS = 2_000;
/**
 * The steps after the ask chord come this far apart (cifix-x9-4): the box's handover ends 1.5 s after it shows, and
 * the suite reads the box at 3 s and moves the pointer onto it at 6 s, so what took the keyboard follows only one.
 */
const SETTLE_MS = 3_000;
const notTestable = (what: string, reason: string) => console.log(`not testable on this runner: ${what}: ${reason}`);
/**
 * Whether this runner activates the window under the pointer (window-at.ts hoverActivation), read from its registry.
 */
function windowTracking(): string {
  const q = (v: string) => spawnSync("reg", ["query", "HKCU\\Control Panel\\Desktop", "/v", v], { encoding: "utf8", windowsHide: true, timeout: 5_000 }).stdout ?? "";
  return hoverActivation(q("UserPreferencesMask"), q("ActiveWndTrkTimeout"));
}

interface BenchReady { hwnd: number; pid: number; window: Rect; controls: Record<string, Rect> }

/** Polls `fn` until it gives something truthy, or fails after `ms` saying what was awaited. */
async function waitFor<T>(what: string, fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms: number): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(100);
  }
}

/** The bench's ready line (UTF-8 JSON lines; a line still being written is skipped until it is whole). */
function benchReady(log: string): BenchReady | null {
  if (!fs.existsSync(log)) return null;
  for (const line of fs.readFileSync(log, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line) as BenchReady & { event?: string };
      if (e.event === "ready") return e;
    } catch {
      // a line still being written: the next poll reads it whole
    }
  }
  return null;
}

/** How long the bench's Name field is now, by its log's last "text" line for it (0 before any). */
function benchNameLength(log: string): number {
  let length = 0;
  for (const line of fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n") : []) {
    try {
      const e = JSON.parse(line) as { event?: string; control?: string; length?: number };
      if (e.event === "text" && e.control === "Name" && typeof e.length === "number") length = e.length;
    } catch {
      // a line still being written: read whole next time
    }
  }
  return length;
}

/** Builds EmberBench.exe (cached in %TEMP% per version) and gives its path. */
function buildBench(): string {
  const r = spawnSync(powershell, [...POWERSHELL_ARGS, "-File", benchScript, "-BuildOnly"], { encoding: "utf8", windowsHide: true, timeout: 180_000 });
  if (r.status !== 0) throw new Error(`the bench didn't build (exit ${String(r.status)}): ${r.stderr || String(r.error)}`);
  const { exe } = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "") as { exe: string };
  if (!fs.existsSync(exe)) throw new Error(`the bench's build named ${exe}, but there is no such file`);
  return exe;
}

/** The accessibility host as npm run build bundles it, into `dir` (main.cjs's folder in a development tree). */
function buildHost(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  buildSync({ entryPoints: [path.join(root, "app", "sidecar-host", "main.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron", "koffi", "sharp"], outfile: path.join(dir, "ax-sidecar.cjs"), logLevel: "silent" });
}

/** The share of an image's pixels inside `r` (screen pixels) that `test` accepts; the image is the capture decoded. */
function share(img: { data: Buffer; width: number; height: number; channels: number }, c: Capture, r: Rect, test: (red: number, green: number, blue: number) => boolean): number {
  const x0 = Math.max(0, Math.round((r.x - c.rect.x) * c.scale)), y0 = Math.max(0, Math.round((r.y - c.rect.y) * c.scale));
  const x1 = Math.min(img.width, Math.round((r.x + r.width - c.rect.x) * c.scale)), y1 = Math.min(img.height, Math.round((r.y + r.height - c.rect.y) * c.scale));
  let hits = 0, all = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * img.channels;
      all++;
      if (test(img.data[i], img.data[i + 1], img.data[i + 2])) hits++;
    }
  }
  return all ? hits / all : 0;
}

const decode = async (c: Capture) => {
  const { data, info } = await sharp(c.data).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
};
/** The middle of a rectangle: what the set-of-marks labels drawn beside other controls can't reach. */
const inner = (r: Rect, fx = 0.6, fy = 0.4): Rect => ({ x: r.x + r.width * (1 - fx) / 2, y: r.y + r.height * (1 - fy) / 2, width: r.width * fx, height: r.height * fy });
const dark = (r: number, g: number, b: number) => r < 40 && g < 40 && b < 40;
const red = (r: number, g: number, b: number) => r >= 200 && g <= 60 && b <= 60;

interface AskMenuProbe {
  editable: boolean | null;
  popup: boolean;
  shown: boolean;
  closed: boolean;
}
/** A raw BGRA capture's share of red pixels. */
function redShareBgra(bgra: Buffer): number {
  let n = 0;
  for (let i = 0; i < bgra.length; i += 4) if (red(bgra[i + 2], bgra[i + 1], bgra[i])) n++;
  return bgra.length ? n / (bgra.length / 4) : 0;
}

describe.skipIf(!onWindows && !required)("Ember on a real Windows desktop", { timeout: 180_000 }, () => {
  const note = (msg: string, fields?: Record<string, unknown>) => { if (process.env.EMBER_TEST_VERBOSE) console.error(msg, fields ?? ""); };
  const log = { debug: note, info: note, warn: note, error: (msg: string, fields?: Record<string, unknown>) => console.error(msg, fields ?? ""), child: () => log } as unknown as Logger;
  let dir = "";
  let platform: Platform;
  let ws: WindowSystem;
  let input: Input | null = null;
  let launch: SidecarLaunch;
  let sidecar: AtspiSidecar;
  let started: SidecarStatus;
  let bench: ChildProcess | undefined;
  let ready: BenchReady;
  /** The bench's JSON-lines log (its Name field's length after each change, among the rest). */
  let benchLog = "";
  let overlay: OverlayChild | null = null;
  /** Perception's hideOverlay: the stand-in when one is up (as main hides its overlay and handle), else nothing to hide. */
  let hideOverlay: () => Promise<() => void> = async () => () => undefined;
  let perception: Perception;
  const screen: ScreenLike = { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 1 }), getAllDisplays: () => [] };

  beforeAll(async () => {
    // Every facility, each failing loudly (this only runs on Windows or with EMBER_WIN32_TEST=1).
    if (!onWindows) throw new Error("EMBER_WIN32_TEST=1, but this isn't Windows");
    if (!fs.existsSync(powershell)) throw new Error(`Windows PowerShell isn't at ${powershell}`);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-win32-"));
    const appDir = path.join(dir, "app");
    buildHost(appDir);
    const electron = {
      app: {
        isPackaged: false, getPath: () => path.join(dir, "userData"), getAppPath: () => root, getVersion: () => "0.0.0",
        isAccessibilitySupportEnabled: () => false, setLoginItemSettings: () => undefined, getLoginItemSettings: () => ({ openAtLogin: false }), focus: () => undefined,
      },
      screen, desktopCapturer: {}, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }), getMediaAccessStatus: () => "granted" },
      shell: { openExternal: async () => undefined }, powerMonitor: { on: () => undefined }, browserWindow: { getFocusedWindow: () => null },
    } as unknown as ElectronParts;
    const deps: PlatformDeps = { electron, packaged: false, execPath: process.execPath, appPath: root, resourcesPath: path.join(root, "resources"), env: process.env };
    // What main does: loadPlatform, then (after ready) the window system, input and the host's launch.
    platform = loadPlatform(deps);
    expect(platform.os).toBe("win32");
    const opened = platform.openWindows(log);
    if (!opened) throw new Error("Ember's Windows window system didn't open");
    ws = opened;
    input = platform.openInput(ws, log);
    if (!input) throw new Error("Ember's Windows input didn't open");
    const l = platform.sidecarLaunch({ appDir, appPath: root, resourcesPath: path.join(root, "resources"), packaged: false, userData: path.join(dir, "userData"), execPath: process.execPath });
    if (!l) throw new Error("the Windows platform gave no launch for the accessibility host");
    launch = l;
    expect(launch.firstRequestMs).toBe(20_000);
    expect(launch.env?.EMBER_UIA_SCRIPT).toBe(path.win32.join(root, "sidecar", "uia", "ember_uia.ps1"));
    // The bridge's first start compiles it into this test's own cache (Defender scans the result): give it longer.
    sidecar = new AtspiSidecar(path.join(root, "sidecar", "atspi", "ember_atspi.py"), log, undefined, undefined, { ...launch, firstRequestMs: 90_000 });
    started = await waitFor("the host and its bridge to start", async () => {
      const st = await sidecar.status().catch(() => null);
      if (st?.toolkitAccessibility === false) throw new Error(`the bridge didn't start: ${String(st.cause ?? st.detail)} (language mode ${String(st.languageMode ?? "unknown")})`);
      return st?.toolkitAccessibility === true ? st : null;
    }, 120_000);
    const exe = buildBench();
    benchLog = path.join(dir, "bench.jsonl");
    // Not windowsHide: that would hide the bench's window.
    bench = spawn(exe, ["-Log", benchLog, "-Seconds", "900"], { stdio: "ignore" });
    ready = await waitFor("the bench's ready line", () => benchReady(benchLog), 60_000);
    ready.hwnd >>>= 0;
    perception = new Perception({
      sidecar, x11: ws, log, neverLook: () => [], screenBounds: () => ws.screenBounds(), words: platform.system.words,
      isSecurityWindow: platform.system.privacy.isSecurityWindow, hideOverlay: () => hideOverlay(),
      // Ember's own windows are its main process's: the overlay stand-in's process here.
      get ownPid() { return overlay?.pid; },
    } as ConstructorParameters<typeof Perception>[0]);
    console.log(`runner facts: elevated=${process.env.EMBER_CI_ELEVATED ?? "?"} lua=${process.env.EMBER_CI_LUA ?? "?"} server=${process.env.EMBER_CI_SERVER ?? "?"} os=${os.release()}; host ${JSON.stringify(started)}`);
  }, 360_000);

  afterEach(async () => {
    if (!overlay) return;
    const child = overlay;
    overlay = null;
    hideOverlay = async () => () => undefined;
    await child.close();
  });

  afterAll(() => {
    sidecar?.stop();
    input?.releaseAll();
    input?.close();
    ws?.close();
    if (bench && bench.exitCode === null) bench.kill();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** Brings the bench to the front and waits until it is the active window. */
  const front = async () => {
    input!.activate(ready.hwnd);
    await waitFor("the bench to be the active window", () => ws.activeWindow()?.id === ready.hwnd, 5_000);
  };

  it("says no system dialog is open at rest, from the window system and through Perception", async () => {
    expect(ws.systemDialogOpen).toBeTypeOf("function");
    expect(ws.systemDialogOpen!()).toBe(false);
    expect(await perception.systemDialogOpen()).toBe(false);
  });

  it("takes a window-scope screenshot of the bench with real pixels and its password field blacked out", async () => {
    await front();
    const seen = await perception.perceive({ image: true, scope: "window", target: { pid: ready.pid, title: TITLE } });
    expect(seen.capture, seen.text).toBeTruthy();
    const password = seen.nodes.find(n => n.role === "password text");
    expect(password, JSON.stringify(seen.nodes.map(n => [n.role, n.name]))).toBeTruthy();
    expect(password!.secret).toBe(true);
    const img = await decode(seen.capture!);
    const masked = share(img, seen.capture!, inner(ready.controls.Password), dark);
    const name = share(img, seen.capture!, inner(ready.controls.Name), dark);
    console.log(`window screenshot ${seen.capture!.width}x${seen.capture!.height} of ${JSON.stringify(seen.capture!.rect)}: password field ${(masked * 100).toFixed(0)} % black, name field ${(name * 100).toFixed(0)} % black`);
    expect(masked).toBeGreaterThan(0.95);
    // The picture isn't black everywhere: the Name field beside it shows (a white text box).
    expect(name).toBeLessThan(0.2);
  });

  it("shows Ember's overlay in a plain capture, leaves it out of Perception's screenshot, and shows it again after", async () => {
    await front();
    // The stand-in covers the Fruit list and the Save button: on top of the bench, away from its password field.
    const fruit = ready.controls.Fruit, save = ready.controls.Save;
    const x = Math.min(fruit.x, save.x), y = Math.min(fruit.y, save.y);
    const cover = { x, y, width: Math.max(fruit.x + fruit.width, save.x + save.width) - x, height: Math.max(fruit.y + fruit.height, save.y + save.height) - y };
    overlay = await startOverlayChild(root, cover);
    const child = overlay;
    hideOverlay = async () => {
      const show = await child.hide();
      return () => { void show(); };
    };
    const before = ws.capture(cover.x, cover.y, cover.width, cover.height);
    const plain = before && "then" in before ? await before : before;
    expect(plain, "a plain capture of the overlay's rectangle").toBeTruthy();
    const plainRed = redShareBgra(plain!.bgra);
    // A click-through layered window covers nothing for the stack (win32/rules.ts coversScreen), as on Linux.
    const stacked = ws.stack().some(w => w.id === child.hwnd);
    console.log(`overlay stand-in pid ${child.pid} hwnd ${child.hwnd}: in the stack ${String(stacked)}; a plain capture is ${(plainRed * 100).toFixed(0)} % red`);
    expect(stacked).toBe(false);
    expect(plainRed, "the overlay shows in a capture taken without hiding it (else hiding it proves nothing)").toBeGreaterThan(0.8);
    const seen = await perception.perceive({ image: true, scope: "window", target: { pid: ready.pid, title: TITLE } });
    expect(seen.capture, seen.text).toBeTruthy();
    const img = await decode(seen.capture!);
    const shot = share(img, seen.capture!, inner(cover, 0.8, 0.8), red);
    console.log(`Perception's screenshot: ${(shot * 100).toFixed(1)} % red where the overlay is`);
    expect(shot).toBeLessThan(0.01);
    // Shown again once the pixels are in.
    await waitFor("the overlay to show again", () => {
      const again = ws.capture(cover.x, cover.y, cover.width, cover.height);
      return again && !("then" in again) && redShareBgra(again.bgra) > 0.8;
    }, 3_000);
  });

  it("matches the Settings app's window from the bridge to the window system's frame by pid (C15)", async () => {
    if (process.env.EMBER_CI_LUA !== "1") {
      notTestable("C15 (a UWP frame matched by pid)", `UAC is off (EnableLUA=${process.env.EMBER_CI_LUA ?? "unknown"}), so Windows refuses to start UWP apps such as Settings; checked by hand (design §12.3 item 7)`);
      return;
    }
    spawnSync("explorer.exe", ["ms-settings:"], { windowsHide: true });
    try {
      const w = await waitFor("the Settings window from the bridge", async () => {
        const { windows } = await sidecar.listWindows({ ownPid: process.pid });
        return windows.find(x => /^systemsettings$/i.test(x.app) && x.bounds);
      }, 30_000);
      const stack = ws.stack();
      const m = matchFrame(w, stack);
      console.log(`Settings: bridge ${JSON.stringify(w)}; matched ${JSON.stringify(m?.window ?? null)}`);
      expect(m, "the frame Perception matches for Settings").toBeTruthy();
      expect(m!.window.pid).toBe(w.pid);
      // The hosted program's name, as the bridge reports it (C15: the same pid and program on both sides).
      expect(m!.window.wmClass.toLowerCase()).toBe(w.app.toLowerCase());
      expect(w.app.toLowerCase()).toBe("systemsettings");
      expect(m!.scale).toBe(1);
    } finally {
      spawnSync("taskkill", ["/IM", "SystemSettings.exe", "/F"], { windowsHide: true, stdio: "ignore" });
    }
  });

  it("runs the packaged accessibility host as Ember.exe in node mode, and it answers a ping within 30 s", async () => {
    if (!packaged) {
      // A required run names the staged app (CI stages first); a local run without one says so.
      if (required) throw new Error("EMBER_WIN32_TEST=1 without EMBER_PACKAGED_APP: stage Ember first and name its folder (dist/package/Ember)");
      console.log("not run: EMBER_PACKAGED_APP names no staged Ember (node scripts/package/stage.mjs makes dist/package/Ember)");
      return;
    }
    const exe = path.join(packaged, "Ember.exe");
    const host = path.join(packaged, "resources", "app", "dist", "app", "ax-sidecar.cjs");
    expect(fs.existsSync(exe), exe).toBe(true);
    expect(fs.existsSync(host), host).toBe(true);
    const child = spawn(exe, [host], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", EMBER_UIA_CACHE: path.join(dir, "packaged-uia") } });
    let stderr = "";
    child.stderr.on("data", d => { stderr += d; });
    try {
      const lines = readline.createInterface({ input: child.stdout });
      const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer to ping within 30 s\n${stderr}`)), 30_000);
        lines.on("line", line => {
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg.id === 1) { clearTimeout(timer); resolve(msg); }
          } catch {
            // not a protocol line
          }
        });
        child.on("exit", code => { clearTimeout(timer); reject(new Error(`the packaged host exited (${String(code)})\n${stderr}`)); });
      });
      const t0 = Date.now();
      child.stdin.write(`${JSON.stringify({ id: 1, method: "ping", params: {} })}\n`);
      const msg = await answer;
      console.log(`the packaged host answered ping in ${Date.now() - t0} ms: ${JSON.stringify(msg)}`);
      expect(msg.error).toBeUndefined();
      expect(msg.result).toBeTruthy();
    } finally {
      child.stdin.end();
      setTimeout(() => { if (child.exitCode === null) child.kill(); }, 3_000).unref();
    }
  });

  it("opens the ask box from the real ask chord, says what it holds of letters typed straight after (review #78 probe), and leaves the bench the keyboard when a click there dismisses its right-click menu (review #77)", async () => {
    const main = path.join(root, "dist", "app", "main.cjs");
    if (!fs.existsSync(main)) throw new Error(`${main} is missing: run npm run build first`);
    const userData = path.join(dir, "ember-userData");
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ version: 1, onboarded: true, wakeWord: false, consent: { version: 10, at: "2026-10-15T00:00:00.000Z" } }));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
    // As at login: Ember only greets, so no settings window takes the keyboard.
    const ember: ElectronApplication = await electron.launch({
      executablePath: createRequire(import.meta.url)("electron") as unknown as string, args: [root, "--autostart"], timeout: 90_000,
      env: { ...env, EMBER_TEST_HOOKS: "1", EMBER_USER_DATA: userData },
    });
    const askWindow = () => ember.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find(x => x.getTitle() === "Ask Ember");
      return w ? { visible: w.isVisible(), focused: w.isFocused() } : null;
    });
    let fgTimer: ReturnType<typeof setInterval> | undefined;
    let watcher: ChildProcess | null = null;
    try {
      await waitFor("Ember's test hooks", () => ember.evaluate(() => !!(globalThis as { __ember?: unknown }).__ember), 60_000);
      const accel = "Super+Alt+Space";
      if (!(await ember.evaluate(({ globalShortcut }, a) => globalShortcut.isRegistered(a), accel))) {
        notTestable("letters typed straight after the ask chord", `another app holds ${accel}`);
        return;
      }
      // Watched from before the chord to the right-click (cifix-x9-2): which window had the foreground (read every
      // 20 ms here) and what each of Ember's windows went through (its own events, in Ember), so a box gone by the
      // right-click is told with what took the keyboard from it and when, not only with what was left under the point.
      const api = loadWin32()!;
      const trail: TrailEvent[] = [];
      const emberPid = ember.process().pid;
      let fgLast = -1;
      const readForeground = () => {
        const id = api.foregroundWindow();
        if (id === fgLast) return;
        fgLast = id;
        const pid = id ? api.threadProcess(id).pid : 0;
        const who = !id ? "no window" : id === ready.hwnd ? "the bench"
          : emberPid !== undefined && pid === emberPid ? `Ember's ${JSON.stringify(api.title(id, false))}`
          : `a window of ${api.processImage(pid) ?? `pid ${pid}`} (class ${api.className(id)}, title ${JSON.stringify(api.title(id, false))})`;
        // Where the pointer was then, and the window under it (cifix-x9-3: the third failure's bench took the keyboard
        // about when the suite moved the pointer onto the box).
        const p = api.cursorPos();
        const under = p ? api.root(api.windowFromPoint(p.x, p.y)) : 0;
        const pointer = !p ? "the pointer unknown" : `the pointer at ${p.x},${p.y} over ${!under ? "no window" : under === ready.hwnd ? "the bench"
          : `${api.className(under)} ${JSON.stringify(api.title(under, false))} (window ${under}, pid ${api.threadProcess(under).pid})`}`;
        trail.push({ t: Date.now(), what: `foreground: ${who} (window ${id}); ${pointer}` });
      };
      /** One of the suite's own steps, on the same clock. */
      const step = (what: string) => trail.push({ t: Date.now(), what: `test: ${what}` });
      // Every visible top-level window coming or going, of any program (cifix-x9-5): the control run at 32178e6 had the
      // bench take the keyboard 1.4 s after the box showed with no step of this suite near it, and nothing in Ember's
      // log, so a window that comes up for a moment (and hands the foreground on as it goes) is what is looked for.
      const shownNow = () => {
        const out = new Map<number, string>();
        for (let w = api.topWindow(), n = 0; w && n < 2_000; w = api.nextWindow(w), n++) {
          if (!api.isVisible(w)) continue;
          const pid = api.threadProcess(w).pid;
          out.set(w, `${api.processImage(pid) ?? `pid ${pid}`} (class ${api.className(w)}, title ${JSON.stringify(api.title(w, false))}, window ${w})`);
        }
        return out;
      };
      let shownLast = shownNow();
      const readWindows = () => {
        const now = shownNow();
        for (const [w, what] of now) if (!shownLast.has(w)) trail.push({ t: Date.now(), what: `window shown: ${what}` });
        for (const [w, what] of shownLast) if (!now.has(w)) trail.push({ t: Date.now(), what: `window gone: ${what}` });
        shownLast = now;
      };
      fgTimer = setInterval(() => { readForeground(); readWindows(); }, 20);
      // Every foreground, focus and minimise change as Windows reports it, however brief (cifix-x9-6: the window list
      // at bcbd4f1 showed nothing coming or going when the bench took the keyboard back), with the Win and Alt keys'
      // state then. Best effort: a watcher that doesn't start is said in the timeline, and the test goes on.
      const watched = (w: WatchedWindow) => (w.root === ready.hwnd ? "the bench"
        : emberPid !== undefined && w.pid === emberPid ? `Ember's ${JSON.stringify(w.title)}`
        : `${w.image || `pid ${w.pid}`} (class ${w.className}, title ${JSON.stringify(w.title)})`);
      watcher = spawn(powershell, [...POWERSHELL_ARGS, "-File", watchScript, "-WatchPid", String(ready.pid)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const watchErr: string[] = [];
      watcher.stderr?.on("data", (d: Buffer) => { if (watchErr.join("").length < 2_000) watchErr.push(d.toString()); });
      const watchReady = new Promise<boolean>(resolve => {
        readline.createInterface({ input: watcher!.stdout! }).on("line", line => {
          if (line.startsWith('{"ready":true')) { resolve(true); return; }
          const e = watchEvent(line, watched);
          if (e) trail.push(e);
        });
        watcher!.on("exit", () => resolve(false));
        watcher!.on("error", () => resolve(false));
        setTimeout(() => resolve(false), 30_000).unref();
      });
      if (!(await watchReady)) trail.push({ t: Date.now(), what: `the foreground watcher didn't start: ${watchErr.join("").trim().slice(0, 300) || "no answer in 30 s"}` });
      await ember.evaluate(({ app, BrowserWindow }) => {
        const seen: { t: number; what: string }[] = [];
        (globalThis as { __winTrail?: typeof seen }).__winTrail = seen;
        const watch = (w: InstanceType<typeof BrowserWindow>) => {
          const note = (e: string) => () => seen.push({ t: Date.now(), what: `Ember's ${JSON.stringify(w.isDestroyed() ? "?" : w.getTitle())} ${e}` });
          w.on("show", note("show"));
          w.on("hide", note("hide"));
          w.on("focus", note("focus"));
          w.on("blur", note("blur"));
          // Where it is and what its page asks main for (channel names only): a context arriving resizes the box.
          w.on("move", note("move"));
          w.on("resize", note("resize"));
          w.webContents.on("ipc-message", (_e, channel) => seen.push({ t: Date.now(), what: `Ember's ${JSON.stringify(w.isDestroyed() ? "?" : w.getTitle())} page sends ${channel}` }));
          // What main sends the Ask box's page (channel names only; cifix-x9-7): the context Ember read of the window
          // the box opened over arrives this way, once per opening and late, as the bench's return at 0.9-1.5 s did.
          if (w.getTitle() === "Ask Ember") {
            const send = w.webContents.send.bind(w.webContents);
            w.webContents.send = (channel: string, ...args: unknown[]) => {
              seen.push({ t: Date.now(), what: `Ember sends the "Ask Ember" page ${channel}` });
              send(channel, ...args);
            };
          }
        };
        BrowserWindow.getAllWindows().forEach(watch);
        app.on("browser-window-created", (_e, w) => watch(w));
      });
      let pressedFrom = Date.now();
      /** The trail so far, with Ember's own log lines since the chord, as one line. */
      const trailNow = async () => {
        readForeground();
        const inEmber = await ember.evaluate(() => (globalThis as { __winTrail?: { t: number; what: string }[] }).__winTrail ?? []).catch(() => []);
        const emberLog = path.join(userData, "logs", "ember.log");
        const logged: TrailEvent[] = [];
        for (const raw of fs.existsSync(emberLog) ? fs.readFileSync(emberLog, "utf8").split("\n") : []) {
          try {
            const e = JSON.parse(raw) as { t?: unknown; msg?: unknown };
            const t = typeof e.t === "string" ? Date.parse(e.t) : NaN;
            if (typeof e.msg === "string" && t >= pressedFrom) logged.push({ t, what: `log ${e.msg}` });
          } catch {
            // a line still being written
          }
        }
        return `${focusTrail("from the chord", pressedFrom, [...trail, ...inEmber, ...logged], 200)}; ${windowTracking()}`;
      };
      await front();
      const x = input!;
      // The user is typing in the bench's Name field: letters that go there instead of the box are in the bench's log.
      const name = ready.controls.Name;
      x.move(Math.round(name.x + name.width / 2), Math.round(name.y + name.height / 2));
      await sleep(150);
      x.button(1, true);
      x.button(1, false);
      await sleep(300);
      const nameBefore = benchNameLength(benchLog);
      // Win+Alt+Space with SendInput (what a person's keyboard gives), let go, then the letters at once.
      const mods = ["Super_L", "Alt_L"].map(n => x.keysymOf(n));
      const space = x.keysymOf("space");
      for (const k of mods) expect(x.keysym(k, true)).toBe(true);
      const pressedAt = pressedFrom = Date.now();
      step("the ask chord");
      x.keysym(space, true);
      x.keysym(space, false);
      for (const k of [...mods].reverse()) x.keysym(k, false);
      // VK_LWIN 0x5B, VK_MENU 0x12: what Windows thinks of the chord's keys once they were let go.
      step(`the chord's keys let go (Win ${api.asyncKeyDown(0x5b) ? "still down" : "up"}, Alt ${api.asyncKeyDown(0x12) ? "still down" : "up"})`);
      const typedAt: number[] = [];
      for (const ch of PROBE_TEXT) {
        typedAt.push(Date.now());
        x.textKey!(ch, true);
        x.textKey!(ch, false);
        await sleep(PROBE_PACE_MS);
      }
      step("the letters typed");
      await waitFor("the ask box from the real chord", async () => (await askWindow())?.visible, 5_000)
        .catch(async (e: unknown) => { throw new Error(`${(e as Error).message} (the ask window: ${JSON.stringify(await askWindow())})`); });
      await sleep(800);
      // cifix-x9-4: in every run so far the bench took the foreground back about 1.5 s after the chord, when this suite
      // read the box, moved the pointer onto it and the box's handover (OPENING_MS, 1.5 s from showing) was ending, all
      // within 50 ms. Each comes in its own moment here, 3 s apart (a user may well read for that long), so the
      // timeline tells which one it follows; the box must hold the keyboard through all of it, as it must for a user.
      await sleep(Math.max(0, pressedAt + SETTLE_MS - Date.now()));
      step("reading what the box holds");
      const { held, tip } = await ember.evaluate(async ({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find(b => b.getTitle() === "Ask Ember");
        return w ? await w.webContents.executeJavaScript(`({ held: document.querySelector("#q")?.value ?? "", tip: document.getElementById("tip")?.hidden === false ? document.getElementById("tip").textContent : null })`) as { held: string; tip: string | null } : { held: "", tip: null };
      });
      const verdict = probeVerdict("Windows", PROBE_TEXT, held);
      console.log(verdict.line);
      // When Ember heard the chord, showed the box and had the keyboard (its own log), and where the lost letters went.
      const emberLog = path.join(userData, "logs", "ember.log");
      console.log(probeTimeline("Windows", fs.existsSync(emberLog) ? fs.readFileSync(emberLog, "utf8") : "", pressedAt, typedAt, verdict.lost).line);
      console.log(`typed-ahead probe (Windows): the bench's Name field got ${benchNameLength(benchLog) - nameBefore} of the letters; the box's tip: ${tip === null ? "not shown" : JSON.stringify(tip)}`);
      expect(verdict.inOrder, verdict.line).toBe(true);
      // A fresh profile: this is the box's first opening, where Ember can't hold the letters typed meanwhile.
      expect(tip, "the box's tip to wait for it on its first openings").toBe("Wait for this box before you type: letters typed sooner go to the app underneath.");

      // Review #77: open the field's edit menu, then click a point on the bench outside the Ask window.
      // If the native menu swallows the first click, Ask keeps the keyboard until the next click reaches the bench.
      const { at, askId } = await ember.evaluate(async ({ BrowserWindow, Menu, screen }) => {
        const w = BrowserWindow.getAllWindows().find(w => w.getTitle() === "Ask Ember")!;
        // Observe the real menu in this test's disposable Electron process. Its HWND varies across Windows versions.
        const probe: AskMenuProbe = { editable: null, popup: false, shown: false, closed: false };
        (globalThis as { __askMenuProbe?: AskMenuProbe }).__askMenuProbe = probe;
        w.webContents.once("context-menu", (_event, params) => { probe.editable = params.isEditable; });
        const popup = Menu.prototype.popup;
        Menu.prototype.popup = function (options) {
          if (options?.window !== w) return popup.call(this, options);
          Menu.prototype.popup = popup;
          probe.popup = true;
          this.once("menu-will-show", () => { probe.shown = true; });
          return popup.call(this, {
            ...options,
            callback: () => { probe.closed = true; options.callback?.(); },
          });
        };
        const box = w.getBounds();
        const field = await w.webContents.executeJavaScript(`(() => {
          const { x, y, width, height } = document.getElementById("q").getBoundingClientRect();
          return { x: x + width / 2, y: y + height / 2 };
        })()`) as { x: number; y: number };
        // Electron bounds are DIP; SendInput positions are physical pixels.
        return { at: screen.dipToScreenPoint({ x: Math.round(box.x + field.x), y: Math.round(box.y + field.y) }), askId: w.getNativeWindowHandle().readUInt32LE(0) };
      });
      const menuState = () => ember.evaluate(() => (globalThis as { __askMenuProbe?: AskMenuProbe }).__askMenuProbe);
      const hit = (x: number, y: number) => api.root(api.windowFromPoint(x, y));
      // What is under a point, named in this suite's words: Ember's own windows by their titles, the bench, or the
      // program another window belongs to (cifix-2: CI found "262636" over the field, and nothing said what it was).
      const windowAt = (px: number, py: number): WindowAt | null => {
        const id = hit(px, py);
        return id ? { id, className: api.className(id), title: api.title(id, false), pid: api.threadProcess(id).pid } : null;
      };
      const emberFacts = () => ember.evaluate(({ BrowserWindow }) => {
        const hooks = (globalThis as { __ember?: { overlay(): { overlays?: Map<number, { interactive: unknown; clickThrough: boolean }> } | null; state(): { bubble?: { visible?: boolean; title?: string; actions?: unknown[] } } } }).__ember;
        const bubble = hooks?.state().bubble;
        return {
          windows: BrowserWindow.getAllWindows().map(w => ({ title: w.getTitle(), id: w.getNativeWindowHandle().readUInt32LE(0), visible: w.isVisible(), focused: w.isFocused(), bounds: w.getBounds() })),
          overlays: [...(hooks?.overlay()?.overlays?.values() ?? [])].map(o => ({ clickThrough: o.clickThrough, interactive: o.interactive })),
          bubble: bubble ? { visible: bubble.visible === true, title: bubble.title ?? "", actions: bubble.actions?.length ?? 0 } : null,
        };
      });
      const own = new Map((await emberFacts()).windows.map(w => [w.id, w.title]));
      // Ember's own: its windows as Electron lists them, and anything else of its main process (a native menu).
      const named = (w: WindowAt) => (w.id === ready.hwnd ? "the bench" : own.has(w.id) ? `Ember's window ${JSON.stringify(own.get(w.id))}`
        : emberPid !== undefined && w.pid === emberPid ? "a window of Ember's that it doesn't list"
        : `a window of ${api.processImage(w.pid) ?? "a program that can't be named"}`);
      const emberOwn = (w: WindowAt) => own.has(w.id) || (emberPid !== undefined && w.pid === emberPid);
      /**
       * Waits for `want` to be the window under the point (window-at.ts), prints what it saw, and fails saying what was
       * there instead: at the limit, or as soon as one of Ember's own windows has stayed there OWN_OVER_MS.
       */
      const reaches = async (what: string, want: number, px: number, py: number, limitMs: number) => {
        const seen = await waitForWindowAt({ what, want, limitMs, own: emberOwn, ownLimitMs: OWN_OVER_MS, read: () => windowAt(px, py), name: named, now: Date.now, sleep });
        console.log(seen.line);
        if (!seen.reached) throw new Error(`${seen.line}; Ember's side: ${JSON.stringify(await emberFacts().catch((e: unknown) => String(e)))}; ${await trailNow()}`);
      };
      await sleep(Math.max(0, pressedAt + 2 * SETTLE_MS - Date.now()));
      const still = await askWindow();
      if (!still?.visible) throw new Error(`the Ask box before the pointer moved onto it (review #77): ${still ? "closed" : "gone"} by itself since it was shown; ${await trailNow()}`);
      step(`the pointer onto the Ask field, at ${at.x},${at.y}`);
      x.move(at.x, at.y);
      step("the pointer moved");
      await sleep(150);
      // The box is topmost, and so are Ember's overlay and handle, which raise themselves and take the pointer where
      // they have something to click (the hello's buttons, for as long as it stays up: 15 s at most, from up to 6 s
      // after start). The right-click needs the field itself under the pointer: waited for, never assumed. Ember's
      // own window staying over the field is not waited out (cifix-x9-1): it would take the user's click. The box itself
      // must still be up: one that has closed is never waited for, and the failure says what took the keyboard (cifix-x9-2).
      const box = await askWindow();
      if (!box?.visible) throw new Error(`the Ask box before the right-click (review #77): ${box ? "closed" : "gone"} since it was shown, so there is no field to press; ${await trailNow()}`);
      // Printed when it passes too: what a pass looked like is the comparison a failure needs (cifix-x9-3).
      console.log(`the Ask box up before the right-click (review #77); ${await trailNow()}`);
      // cifix-x9-12: Ember's read of the bench, which runs while the box is up, must leave the box the foreground. It
      // didn't: TextPattern's caret arithmetic over the bench's Name field handed the bench the foreground about 1 s in,
      // and only the box's 1.5 s handover took it back (or, landing after it, the box closed). The box must not have lost
      // the keyboard once, from showing to now, the read answered meanwhile: the handover must not be what keeps it up.
      const lost = (await ember.evaluate(() => (globalThis as { __winTrail?: { t: number; what: string }[] }).__winTrail ?? []))
        .filter(e => e.what === "Ember's \"Ask Ember\" blur" && e.t >= pressedAt);
      expect(lost.map(e => e.t - pressedAt), `the Ask box lost the keyboard while it was up (cifix-x9-12); ${await trailNow()}`).toEqual([]);
      await reaches("the Ask field under the pointer before the right-click (review #77)", askId, at.x, at.y, ASK_FIELD_WAIT_MS);
      expect(hit(at.x, at.y), "the right-click reaches the Ask field").toBe(askId);
      x.button(3, true);
      x.button(3, false);
      await waitFor("the Ask edit menu to appear", async () => {
        const state = await menuState();
        if (state?.closed) throw new Error("the Ask edit menu closed before the bench click");
        return state?.editable === true && state.shown;
      }, 3_000).catch(async (err: Error) => {
        throw new Error(`${err.message}: ${JSON.stringify({ menu: await menuState(), ask: await askWindow() })}`, { cause: err });
      });
      expect((await askWindow())?.visible, "Ask stays open while its menu is up").toBe(true);
      const benchX = ready.window.x + ready.window.width - 40, benchY = ready.window.y + ready.window.height - 40;
      await reaches("the bench's corner under the dismissing click (review #77)", ready.hwnd, benchX, benchY, 3_000);
      expect(hit(benchX, benchY), "the dismissing click reaches the bench, not Ask or its menu").toBe(ready.hwnd);
      x.move(benchX, benchY);
      await sleep(150);
      x.button(1, true);
      x.button(1, false);
      await waitFor("the Ask edit menu to close", async () => (await menuState())?.closed, 3_000);
      await sleep(1500);
      const after = await askWindow();
      const benchActive = ws.activeWindow()?.id === ready.hwnd;
      console.log(`right-click menu dismissed by a click on the bench (review #77): bench active ${benchActive}, ask box ${JSON.stringify(after)}`);
      if (!benchActive) {
        expect(after?.visible && after.focused, "the box kept the keyboard (the menu swallowed the click)").toBe(true);
        x.button(1, true);
        x.button(1, false);
        await waitFor("the bench to have the keyboard", () => ws.activeWindow()?.id === ready.hwnd, 3_000);
      }
      expect((await askWindow())?.visible, "the box after a click activated the bench").toBe(false);
    } finally {
      clearInterval(fgTimer);
      // Its input closing ends it; killed if it doesn't go.
      if (watcher) {
        const w = watcher;
        w.stdin?.end();
        setTimeout(() => { if (w.exitCode === null) w.kill(); }, 3_000).unref();
      }
      const proc = ember.process();
      await Promise.race([ember.close().catch(() => undefined), sleep(10_000)]);
      if (proc.exitCode === null) proc.kill();
    }
  });

  // A probe, not a check (cifix-x9-9, cifix-x9-10): the box is opened again over the bench once for each stage of
  // Ember's read of it left out (EMBER_TEST_ASK_READ=skip:<stage>, development only; delay:<ms> and off showed the
  // read is what hands the bench the foreground), and each opening's timeline and one summary line are printed. A box
  // that closes meanwhile is the probe's finding. Nothing here can fail the suite:
  // every step is bounded, its errors are printed, and Ember is closed and the bench given the keyboard back after.
  it("prints when the bench takes the foreground back with each stage of the box's read left out (read probe, cifix-x9-9, cifix-x9-10)", async () => {
    const main = path.join(root, "dist", "app", "main.cjs");
    if (!fs.existsSync(main)) { console.log("read probe: not run: npm run build first"); return; }
    const api = loadWin32();
    if (!api || !input) { console.log("read probe: not run: no window system here"); return; }
    // At 2d7b0b4 the bench came back 780 ms into the delayed read and never with it off (cifix-x9-9): the read does it.
    // Now one opening per stage of it left out (cifix-x9-10), so the stage whose absence keeps the bench away is named.
    // At 079e73d (cifix-x9-10) the bench stayed away with the read off, its lookup off and its text looks off, and came
    // back with only the looks around secret fields off: the text looks do it. Now each text look and its steps are
    // timed (skip:time-texts, nothing left out), twice, and the look and step under way at the return are printed.
    // At addfc65 (cifix-x9-11) the bench came back in the caret step of the text look of its Name field, a native
    // single-line Edit, and ea4bc03 reads such an Edit's caret from the control (cifix-x9-12). Whether the same happens
    // over other text fields is not known (cifix-x9-13): the box opens once more over the bench, to confirm the fix,
    // then over Notepad (a multi-line native Edit) and WordPad (RichEdit), where Windows has them, to see.
    const openings: { plan: string; target: "bench" | "notepad" | "wordpad" }[] = [
      { plan: "skip:time-texts", target: "bench" }, { plan: "skip:time-texts", target: "notepad" }, { plan: "skip:time-texts", target: "wordpad" },
    ];
    for (const { plan: probePlan, target } of openings) {
      const plan = `${probePlan} over ${target}`;
      // Filled inside the bounded run, ended in finally.
      const held: { ember: ElectronApplication | null; watcher: ChildProcess | null; app: ChildProcess | null } = { ember: null, watcher: null, app: null };
      // The window read: the bench's, or the app started for this opening.
      let readHwnd = ready.hwnd;
      const readName = target === "bench" ? "the bench" : `the read app (${target})`;
      let poll: ReturnType<typeof setInterval> | undefined;
      try {
        await Promise.race([(async () => {
          if (target !== "bench") {
            const exe = target === "notepad" ? path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "notepad.exe")
              : path.win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "Windows NT", "Accessories", "wordpad.exe");
            if (!fs.existsSync(exe)) { console.log(`read probe (${plan}): not run: ${exe} isn't on this runner`); return; }
            const child = held.app = spawn(exe, [], { stdio: "ignore" });
            const pid = child.pid ?? 0;
            readHwnd = await waitFor(`${target}'s window`, () => {
              for (let w = api.topWindow(), n = 0; w && n < 2_000; w = api.nextWindow(w), n++) {
                if (api.isVisible(w) && api.threadProcess(w).pid === pid && api.title(w, false)) return w;
              }
              return 0;
            }, 20_000);
          }
          const userData = path.join(dir, `ember-userData-probe-${plan.replace(/\W/g, "")}`);
          fs.mkdirSync(userData, { recursive: true });
          fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ version: 1, onboarded: true, wakeWord: false, consent: { version: 10, at: "2026-10-15T00:00:00.000Z" } }));
          const env: Record<string, string> = {};
          for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
          const app = held.ember = await electron.launch({
            executablePath: createRequire(import.meta.url)("electron") as unknown as string, args: [root, "--autostart"], timeout: 60_000,
            env: { ...env, EMBER_TEST_HOOKS: "1", EMBER_USER_DATA: userData, EMBER_TEST_ASK_READ: probePlan },
          });
          await waitFor("Ember's test hooks", () => app.evaluate(() => !!(globalThis as { __ember?: unknown }).__ember), 60_000);
          if (!(await app.evaluate(({ globalShortcut }, a) => globalShortcut.isRegistered(a), "Super+Alt+Space"))) { console.log(`read probe (${plan}): not run: another app holds the ask chord`); return; }
          const marks: ProbeMark[] = [];
          const looks: ProbeLook[] = [];
          const lines: TrailEvent[] = [];
          await app.evaluate(({ app: a, BrowserWindow }) => {
            const seen: { t: number; what: string }[] = [];
            (globalThis as { __probe?: typeof seen }).__probe = seen;
            const watch = (w: InstanceType<typeof BrowserWindow>) => {
              if (w.getTitle() !== "Ask Ember") return;
              const note = (e: string) => () => seen.push({ t: Date.now(), what: e });
              w.on("show", note("show"));
              w.on("hide", note("hide"));
              w.on("focus", note("focus"));
              w.on("blur", note("blur"));
              const send = w.webContents.send.bind(w.webContents);
              w.webContents.send = (channel: string, ...args: unknown[]) => { seen.push({ t: Date.now(), what: `send ${channel}` }); send(channel, ...args); };
            };
            BrowserWindow.getAllWindows().forEach(watch);
            a.on("browser-window-created", (_e, w) => watch(w));
          });
          let last = -1;
          poll = setInterval(() => {
            const id = api.foregroundWindow();
            if (id === last) return;
            last = id;
            const pid = id ? api.threadProcess(id).pid : 0;
            const whose = id === readHwnd ? readName : pid === app.process().pid ? `Ember's ${JSON.stringify(api.title(id, false))}` : `${api.processImage(pid) ?? `pid ${pid}`} (class ${api.className(id)})`;
            lines.push({ t: Date.now(), what: `foreground: ${whose}` });
            if (id === readHwnd) marks.push({ t: Date.now(), kind: "bench foreground" });
            else if (pid === app.process().pid) marks.push({ t: Date.now(), kind: "box foreground" });
          }, 20);
          const watcher = held.watcher = spawn(powershell, [...POWERSHELL_ARGS, "-File", watchScript], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
          const named = (w: WatchedWindow) => (w.root === readHwnd ? readName : w.pid === app.process().pid ? `Ember's ${JSON.stringify(w.title)}` : `${w.image || `pid ${w.pid}`} (class ${w.className})`);
          await new Promise<void>(resolve => {
            readline.createInterface({ input: watcher.stdout! }).on("line", line => {
              if (line.startsWith('{"ready":true')) { resolve(); return; }
              const e = watchEvent(line, named);
              if (!e) return;
              lines.push(e);
              if (e.what.startsWith(`Windows says foreground: ${readName}`)) marks.push({ t: e.t, kind: "bench foreground" });
            });
            watcher.on("exit", () => resolve());
            setTimeout(resolve, 30_000).unref();
          });
          if (target === "bench") {
            await front();
            const name = ready.controls.Name;
            input!.move(Math.round(name.x + name.width / 2), Math.round(name.y + name.height / 2));
            await sleep(150);
            input!.button(1, true);
            input!.button(1, false);
          } else {
            // Into the app's text, a few letters typed: a bare caret after text, as in the bench's Name field.
            input!.activate(readHwnd);
            await waitFor(`${target} to be the active window`, () => api.foregroundWindow() === readHwnd, 5_000);
            const r = api.windowRect(readHwnd);
            if (r) input!.move(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
            await sleep(150);
            input!.button(1, true);
            input!.button(1, false);
            await sleep(150);
            for (const ch of "hello") { input!.textKey!(ch, true); input!.textKey!(ch, false); await sleep(40); }
          }
          await sleep(300);
          const mods = ["Super_L", "Alt_L"].map(n => input!.keysymOf(n));
          for (const k of mods) input!.keysym(k, true);
          const chord = Date.now();
          input!.keysym(input!.keysymOf("space"), true);
          input!.keysym(input!.keysymOf("space"), false);
          for (const k of [...mods].reverse()) input!.keysym(k, false);
          // Long enough for the delayed read (4 s after the box shows) and the 1.5 s handover after it.
          await sleep(plan.startsWith("delay:") ? 7_000 : 4_000);
          const inEmber = await app.evaluate(() => (globalThis as { __probe?: { t: number; what: string }[] }).__probe ?? []).catch(() => []);
          let contexts = 0;
          for (const e of inEmber) {
            lines.push({ t: e.t, what: `Ember's "Ask Ember" ${e.what}` });
            if (e.what === "show") marks.push({ t: e.t, kind: "box shown" });
            if (e.what === "hide") marks.push({ t: e.t, kind: "box hidden" });
            // The first context goes as the box shows; the read's own answer is the next one.
            if (e.what === "send agent:ask-context" && ++contexts === 2) marks.push({ t: e.t, kind: "read answered" });
          }
          const log = path.join(userData, "logs", "ember.log");
          for (const raw of fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n") : []) {
            try {
              const e = JSON.parse(raw) as { t?: unknown; msg?: unknown };
              const t = typeof e.t === "string" ? Date.parse(e.t) : NaN;
              if (typeof e.msg !== "string" || !(t >= chord)) continue;
              lines.push({ t, what: `log ${e.msg}` });
              if (e.msg === "ask.read_started") marks.push({ t, kind: "read started" });
              if (e.msg === "ask.read_probe_texts" && typeof (e as { looks?: unknown }).looks === "string") {
                try {
                  for (const l of JSON.parse((e as { looks: string }).looks) as ProbeLook[]) {
                    looks.push(l);
                    lines.push({ t: l.start, what: `text look ${l.i} (${l.role}) began; steps ${l.steps.map(s => `${s.step} at ${s.t - chord} ms`).join(", ")}; ended at ${l.end - chord} ms` });
                  }
                } catch {
                  // cut short in the log: the timeline says what it has
                }
              }
            } catch {
              // a line still being written
            }
          }
          console.log(focusTrail(`read probe (${plan}) from the chord`, chord, lines, 200));
          console.log(readProbeSummary(plan, chord, marks));
          for (const m of marks) if (m.kind === "bench foreground" && m.t > (marks.find(x => x.kind === "box shown")?.t ?? Infinity)) console.log(`read probe (${plan}): at the bench's return (${m.t - chord} ms): ${lookAt(looks, m.t)}`);
        })(), sleep(100_000).then(() => { throw new Error("it took over 100 s"); })]);
      } catch (err) {
        console.log(`read probe (${plan}): stopped: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearInterval(poll);
        const w = held.watcher;
        if (w) { w.stdin?.end(); setTimeout(() => { if (w.exitCode === null) w.kill(); }, 3_000).unref(); }
        // The app started for this opening goes, unsaved (nothing it holds is kept).
        const started = held.app;
        if (started && started.exitCode === null) started.kill();
        const ember = held.ember;
        if (ember) {
          const proc = ember.process();
          await Promise.race([ember.close().catch(() => undefined), sleep(10_000)]);
          if (proc.exitCode === null) proc.kill();
        }
        // The bench has the keyboard again for what follows, whatever the probe left.
        await front().catch((err: unknown) => console.log(`read probe (${plan}): the bench didn't take the keyboard back: ${String(err)}`));
      }
    }
  }, 420_000);

  it("opens the ask box as large as its words at Larger text, its window wider and taller, the tip's row too (review #57)", async () => {
    // Windows' box is a "toolbar" window without a resizing frame that, before the text size reached it, only ever
    // changed height: this proves it takes the wider bounds (ask-size.ts: the steps handle-menu-live takes on Linux).
    const main = path.join(root, "dist", "app", "main.cjs");
    if (!fs.existsSync(main)) throw new Error(`${main} is missing: run npm run build first`);
    const userData = path.join(dir, "ember-userData-text");
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ version: 1, onboarded: true, wakeWord: false, consent: { version: 10, at: "2026-10-15T00:00:00.000Z" } }));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
    const ember: ElectronApplication = await electron.launch({
      executablePath: createRequire(import.meta.url)("electron") as unknown as string, args: [root, "--autostart"], timeout: 90_000,
      env: { ...env, EMBER_TEST_HOOKS: "1", EMBER_USER_DATA: userData },
    });
    const inEmber: InEmber = (fn, arg) => ember.evaluate(fn as never, arg) as never;
    try {
      await waitFor("Ember's test hooks", () => ember.evaluate(() => !!(globalThis as { __ember?: unknown }).__ember), 60_000);
      const seen = await openAskAt(inEmber, "larger");
      console.log(`the ask box at Larger text (review #57): ${JSON.stringify(seen)}`);
      // Windows rounds the two pixel edges separately, and Electron converts them back to whole DIP on readback.
      const hwnd = await ember.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === "Ask Ember")!.getNativeWindowHandle().readUInt32LE(0));
      const native = loadWin32()!.windowRect(hwnd);
      const { width, height, ...page } = askWant("larger", seen.tip);
      expect(native, JSON.stringify({ native, seen })).toMatchObject({ width: Math.round(width * seen.scaleFactor) });
      expect(Math.abs(native!.height - height * seen.scaleFactor), JSON.stringify({ native, seen })).toBeLessThan(1);
      expect(seen, JSON.stringify(seen)).toMatchObject(page);
      expect(Math.abs(seen.height - height), JSON.stringify(seen)).toBeLessThanOrEqual(1);
      expect(seen.room, JSON.stringify(seen)).toBeGreaterThanOrEqual(8);
    } finally {
      await closeAsk(inEmber);
      await setTextSize(inEmber, "default").catch(() => undefined);
      const proc = ember.process();
      await Promise.race([ember.close().catch(() => undefined), sleep(10_000)]);
      if (proc.exitCode === null) proc.kill();
    }
  });
});
