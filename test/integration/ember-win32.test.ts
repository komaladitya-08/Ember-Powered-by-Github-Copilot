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
 * accessibility host answers a ping when run as Ember.exe in node mode (EMBER_PACKAGED_APP, after staging).
 *
 * Skipped off Windows; with EMBER_WIN32_TEST=1 it fails instead of skipping when Windows, the backends, Windows
 * PowerShell, Electron or (with EMBER_PACKAGED_APP set) the packaged app is missing. What this runner can't show is
 * printed as "not testable on this runner: <reason>" from the facts CI exports, never passed vacuously.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { ElectronParts, Input, Platform, PlatformDeps, Rect, ScreenLike, SidecarLaunch, WindowSystem } from "../../app/main/platform/types";
import type { Logger } from "../../app/main/logger";
import { loadPlatform } from "../../app/main/platform";
import { AtspiSidecar, type SidecarStatus } from "../../app/main/perception/sidecar";
import { Perception } from "../../app/main/perception";
import { matchFrame } from "../../app/main/perception/windows";
import type { Capture } from "../../app/main/perception/capture";
import { startOverlayChild, type OverlayChild } from "./overlay-child";

const required = process.env.EMBER_WIN32_TEST === "1";
const onWindows = process.platform === "win32";
const root = fileURLToPath(new URL("../../", import.meta.url));
const TITLE = "Ember Bench (Windows)";
const powershell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
const benchScript = path.join(root, "test", "fixtures", "win_bench.ps1");
const packaged = process.env.EMBER_PACKAGED_APP ? path.resolve(root, process.env.EMBER_PACKAGED_APP) : "";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const notTestable = (what: string, reason: string) => console.log(`not testable on this runner: ${what}: ${reason}`);

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
      if (st?.toolkitAccessibility === false) throw new Error(`the bridge didn't start: ${String(st.detail)} (language mode ${String(st.languageMode ?? "unknown")})`);
      return st?.toolkitAccessibility === true ? st : null;
    }, 120_000);
    const exe = buildBench();
    const benchLog = path.join(dir, "bench.jsonl");
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

  afterAll(() => {
    overlay?.close();
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
    const stacked = ws.stack().find(w => w.id === child.hwnd);
    console.log(`overlay stand-in pid ${child.pid} hwnd ${child.hwnd}: in the stack ${JSON.stringify(stacked ?? null)}; a plain capture is ${(plainRed * 100).toFixed(0)} % red`);
    expect(stacked, "the overlay stand-in's window in the stack").toBeTruthy();
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
      expect(m!.window.wmClass).toBe("systemsettings");
      expect(m!.scale).toBe(1);
    } finally {
      spawnSync("taskkill", ["/IM", "SystemSettings.exe", "/F"], { windowsHide: true, stdio: "ignore" });
    }
  });

  it.runIf(onWindows && !!packaged)("runs the packaged accessibility host as Ember.exe in node mode, and it answers a ping within 30 s", async () => {
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
});

describe.runIf(required && onWindows && !process.env.EMBER_PACKAGED_APP)("the packaged accessibility host", () => {
  it("needs EMBER_PACKAGED_APP (the staged Ember folder) in a required run", () => {
    throw new Error("EMBER_WIN32_TEST=1 without EMBER_PACKAGED_APP: stage Ember first and name its folder (dist/package/Ember)");
  });
});
