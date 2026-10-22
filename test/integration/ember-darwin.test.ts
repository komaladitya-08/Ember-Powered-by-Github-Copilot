/**
 * Ember itself on a real Mac (design §11.5): the development build (npm run build) started in a real Electron with
 * the macOS platform loadPlatform gives it, as a login start with an onboarded profile (only the greeting: no settings
 * window), driven through its test hooks (EMBER_TEST_HOOKS) by Playwright. Against TextEdit as the user's app (Finder
 * when TextEdit can't start, with a warning and the reason) and the AppKit bench (test/fixtures/mac_bench.js):
 * - M1: Ember's overlay and handle show without taking the user's app's place: it stays the active app (LaunchServices'
 *   front app, whose menu bar shows) and AX's focused application, and Ember keeps its Dock icon and its app menu with
 *   Quit on Command+Q;
 * - M2: the ask box takes the keys typed while the user's app stays the active one (AX's focused application may be
 *   Ember's while its panel has the keyboard: logged), and hides when the user clicks back into their app (blur);
 * - no system dialog is open at rest, as the window system and as Perception see it;
 * - a window-scope screenshot of the bench through Ember's Perception (its accessibility host started as Ember starts
 *   it) has the bench's pixels and its password field blacked out;
 * - Ember's overlay, painted over the bench and seen in a plain screen grab, is left out of Perception's screenshot;
 * - the keyboard brake's polling (what CursorBorrow's check() reads every 8 ms) costs under 2 ms median (§8.5);
 * - with EMBER_PACKAGED_APP (the staged Ember.app): the packaged accessibility host, run as Ember in node mode, answers
 *   ping within 30 s and status with its AX provider up, which proves the bundle, RunAsNode and koffi load.
 * The permissions are only read, never asked for (a prompt on a runner sits over every later test).
 *
 * Skipped off macOS; with EMBER_DARWIN_TEST=1 it fails instead of skipping when macOS, the build, Electron or (with
 * EMBER_PACKAGED_APP set) the packaged app is missing.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import sharp from "sharp";
import type { Rect, ScreenLike } from "../../app/main/platform/types";
import { openDarwinInput, openDarwinWindows, type DarwinInput, type DarwinWindowSystem } from "../../app/main/platform/darwin";
import {
  BENCH_TITLE, ROOT, activePid, alertReport, appWindow, frontmostPid, pidsOf, sleep, startBench, waitFor, warn, whyNoWindow, type Bench,
} from "./darwin-support";

const required = process.env.EMBER_DARWIN_TEST === "1";
const onMac = process.platform === "darwin";
const packaged = process.env.EMBER_PACKAGED_APP ? path.resolve(ROOT, process.env.EMBER_PACKAGED_APP) : "";
const notTestable = (what: string, reason: string) => console.log(`not testable on this runner: ${what}: ${reason}`);
const TYPED = "hello ember";

/** A capture as Ember's Perception returns it, its image as base64 (what crosses from Electron's main process). */
interface Shot { rect: Rect; scale: number; width: number; height: number; mimeType: string; data: string }
interface Seen { text: string; nodes: [string, string, boolean][]; capture: Shot | null; blocked: boolean; busy: boolean }

/** The middle of a rectangle: what labels drawn beside other controls can't reach. */
const inner = (r: Rect, fx = 0.6, fy = 0.4): Rect => ({ x: r.x + r.width * (1 - fx) / 2, y: r.y + r.height * (1 - fy) / 2, width: r.width * fx, height: r.height * fy });
const dark = (r: number, g: number, b: number) => r < 40 && g < 40 && b < 40;
const red = (r: number, g: number, b: number) => r >= 200 && g <= 60 && b <= 60;

/** The share of the shot's pixels inside `r` (screen points) that `test` accepts. */
async function share(shot: Shot, r: Rect, test: (red: number, green: number, blue: number) => boolean): Promise<number> {
  const { data, info } = await sharp(Buffer.from(shot.data, "base64")).raw().toBuffer({ resolveWithObject: true });
  const x0 = Math.max(0, Math.round((r.x - shot.rect.x) * shot.scale)), y0 = Math.max(0, Math.round((r.y - shot.rect.y) * shot.scale));
  const x1 = Math.min(info.width, Math.round((r.x + r.width - shot.rect.x) * shot.scale)), y1 = Math.min(info.height, Math.round((r.y + r.height - shot.rect.y) * shot.scale));
  let hits = 0, all = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * info.width + x) * info.channels;
      all++;
      if (test(data[i]!, data[i + 1]!, data[i + 2]!)) hits++;
    }
  }
  return all ? hits / all : 0;
}

/** Electron's screen as far as the window system needs it (points: macOS's own unit). */
const pointScreen: ScreenLike = { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 1 }), getAllDisplays: () => [] };

describe.skipIf(!onMac && !required)("Ember on a real Mac", { timeout: 180_000 }, () => {
  let dir = "";
  let ember: ElectronApplication | null = null;
  let emberPid = 0;
  /** The user's app: TextEdit, else Finder. */
  let user = { name: "", pid: 0 };
  let textEditPid = 0;
  let bench: Bench | null = null;
  let ws: DarwinWindowSystem | null = null;
  let input: DarwinInput | null = null;

  /** Runs `fn` in Ember's main process with its test hooks (globalThis.__ember) and Electron's modules. */
  const inEmber = <T, A>(fn: (electron: typeof import("electron"), arg: A) => T | Promise<T>, arg: A): Promise<T> => ember!.evaluate(fn as never, arg) as Promise<T>;

  /** Ember's own windows: title, visible, focused (key), bounds. */
  const emberWindows = () => inEmber(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({
    title: w.getTitle(), visible: w.isVisible(), focused: w.isFocused(), bounds: w.getBounds(),
  })), null);

  beforeAll(async () => {
    if (!onMac) throw new Error("EMBER_DARWIN_TEST=1, but this isn't macOS");
    for (const f of ["dist/app/main.cjs", "dist/app/ax-sidecar.cjs"]) {
      if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`${f} is missing: run npm run build first`);
    }
    const electronPath = createRequire(import.meta.url)("electron") as unknown as string;
    if (!fs.existsSync(electronPath)) throw new Error(`no Electron binary at ${electronPath}`);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-darwin-ember-"));
    const openedWs = openDarwinWindows({ screen: pointScreen });
    if (!openedWs) throw new Error("the macOS window system didn't open in the test process");
    ws = openedWs;
    input = openDarwinInput();
    if (!input) throw new Error("macOS input didn't open in the test process");

    // The user's app, in front through LaunchServices as the user would have it: TextEdit with a document.
    const file = path.join(dir, "notes.txt");
    fs.writeFileSync(file, "﻿Some notes\n");
    const since = Date.now();
    const before = new Set(pidsOf("TextEdit"));
    spawnSync("/usr/bin/open", ["-n", "-F", "-a", "TextEdit", file, "--args", "-ApplePersistenceIgnoreState", "YES"], { encoding: "utf8" });
    const te = await waitFor("TextEdit's window", () => {
      const pid = pidsOf("TextEdit").find(p => !before.has(p));
      return pid && appWindow(pid) ? pid : null;
    }, 30_000).catch(() => 0);
    if (te) {
      textEditPid = te;
      user = { name: "TextEdit", pid: te };
    } else {
      warn(`TextEdit didn't show a window, so Finder is the user's app here:\n  ${whyNoWindow("TextEdit", since)}`);
      spawnSync("/usr/bin/open", ["-a", "Finder", dir], { encoding: "utf8" });
      const finder = await waitFor("Finder", () => pidsOf("Finder")[0], 10_000);
      user = { name: "Finder", pid: finder };
    }
    await waitFor(() => `${user.name} in front (active: ${activePid()}, AX: ${frontmostPid()}; alerts: ${alertReport() || "none"})`, () => activePid() === user.pid, 15_000);

    // Ember as a login start with an onboarded profile: only the greeting, as after a restart.
    const userData = path.join(dir, "userData");
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
      version: 1, character: "cinder", size: 60, speak: false, wakeWord: false, onboarded: true, consent: { version: 1, at: "2026-10-15T00:00:00.000Z" },
    }));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
    ember = await electron.launch({
      executablePath: electronPath, args: [ROOT, "--autostart"], timeout: 90_000,
      env: { ...env, EMBER_TEST_HOOKS: "1", EMBER_USER_DATA: userData },
    });
    emberPid = await inEmber(() => process.pid, null);
    // Its overlay (one per display) and handle up: what a start shows.
    await waitFor(async () => `Ember's overlay and handle (${JSON.stringify(await emberWindows())})`, async () => {
      const w = await emberWindows();
      return w.some(x => x.title === "Ember overlay" && x.visible) && w.some(x => x.title === "Ember" && x.visible);
    }, 30_000);
    console.log(`ember-darwin: Ember ${emberPid} up beside ${user.name} ${user.pid}: ${JSON.stringify(await emberWindows())}`);
  }, 240_000);

  afterAll(async () => {
    if (ember) {
      const proc = ember.process();
      await Promise.race([ember.close().catch(() => undefined), sleep(10_000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
    bench?.stop();
    if (textEditPid) {
      try {
        process.kill(textEditPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    input?.releaseAll();
    input?.close();
    ws?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("starts beside the user's app: it stays the active app, and Ember keeps its Dock icon and its app menu (M1)", async () => {
    // A start that activated Ember would have done so by now.
    await sleep(1500);
    console.log(`ember-darwin: after Ember's start the active app is ${activePid()}, AX's focused app ${frontmostPid()} (Ember ${emberPid}, ${user.name} ${user.pid})`);
    expect(activePid(), `the active app (Ember is ${emberPid}, ${user.name} ${user.pid})`).toBe(user.pid);
    expect(frontmostPid(), "AX's focused application").toBe(user.pid);
    const shell = await inEmber(({ app, Menu }) => {
      const menu = Menu.getApplicationMenu();
      const items = (menu?.items ?? []).flatMap(i => [i, ...(i.submenu?.items ?? [])]);
      const quit = items.find(i => i.label === "Quit Ember");
      return { dock: app.dock?.isVisible() ?? null, menus: (menu?.items ?? []).map(i => i.label), quit: quit ? String(quit.accelerator) : null };
    }, null);
    console.log(`ember-darwin: Dock icon ${shell.dock}; app menu ${JSON.stringify(shell.menus)}; Quit on ${shell.quit}`);
    expect(shell.dock).toBe(true);
    expect(shell.menus[0]).toBe("Ember");
    expect(shell.quit).toBe("Command+Q");
    const own = await emberWindows();
    expect(own.filter(w => w.focused), "no Ember window has the keyboard").toEqual([]);
  });

  it("takes typed keys in the ask box while the user's app stays the active one, and hides it when the user clicks back (M2)", async () => {
    await inEmber(() => (globalThis as unknown as { __ember: { showAsk(): void } }).__ember.showAsk(), null);
    const ask = await waitFor(async () => `the ask box shown with the keyboard (${JSON.stringify(await emberWindows())})`, async () => (await emberWindows()).find(w => w.title === "Ask Ember" && w.visible && w.focused), 10_000);
    // AX's focused application may be Ember's now (its panel has the keyboard); the active app, whose menu bar shows,
    // must still be the user's.
    console.log(`ember-darwin: with the ask box up the active app is ${activePid()}, AX's focused app ${frontmostPid()} (Ember ${emberPid}, ${user.name} ${user.pid})`);
    expect(activePid(), "the active app while the ask box is up").toBe(user.pid);
    for (const ch of TYPED) {
      expect(input!.textKey(ch, true)).toBe(true);
      expect(input!.textKey(ch, false)).toBe(true);
      await sleep(25);
    }
    const typed = () => inEmber(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find(x => x.getTitle() === "Ask Ember");
      return w ? String(await w.webContents.executeJavaScript(`document.querySelector("#q")?.value ?? ""`)) : null;
    }, null);
    await waitFor(async () => `"${TYPED}" in the ask box (it holds ${JSON.stringify(await typed())})`, async () => (await typed()) === TYPED, 5_000);
    expect(activePid(), "the active app after typing").toBe(user.pid);
    // The user clicks back into their app, away from the box: the box loses the keyboard and hides.
    const target = appWindow(user.pid);
    expect(target, `a window of ${user.name}`).toBeTruthy();
    const b = target!.bounds;
    const at = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + Math.min(b.height - 10, Math.max(40, b.height / 3))) };
    const overBox = at.x >= ask.bounds.x && at.x < ask.bounds.x + ask.bounds.width && at.y >= ask.bounds.y && at.y < ask.bounds.y + ask.bounds.height;
    if (overBox) at.y = Math.round(b.y + b.height - 15);
    input!.move(at.x, at.y);
    await sleep(150);
    input!.button(1, true);
    await sleep(60);
    input!.button(1, false);
    await waitFor(async () => `the ask box to hide after a click at ${at.x},${at.y} (${JSON.stringify(await emberWindows())})`, async () => !(await emberWindows()).some(w => w.title === "Ask Ember" && w.visible), 5_000);
    expect(activePid()).toBe(user.pid);
    expect(frontmostPid()).toBe(user.pid);
  });

  it("says no system dialog is open at rest, from the window system and through Perception", async () => {
    expect(ws!.systemDialogOpen(), `system alerts: ${alertReport() || "none"}`).toBe(false);
    expect(await inEmber(async () => (globalThis as unknown as { __ember: { perception(): { systemDialogOpen(): Promise<boolean> } } }).__ember.perception().systemDialogOpen(), null)).toBe(false);
  });

  describe("with the bench in front", () => {
    /** A window-scope look at the bench through Ember's Perception, its picture as base64. */
    const perceiveBench = () => inEmber(async (_e, target) => {
      const p = await (globalThis as unknown as { __ember: { perception(): { perceive(o: unknown): Promise<{ text: string; nodes: { role: string; name: string; secret?: boolean }[]; blocked: boolean; busy: boolean; capture: { rect: Rect; scale: number; width: number; height: number; mimeType: string; data: Buffer } | null }> } } })
        .__ember.perception().perceive({ image: true, scope: "window", target });
      return {
        text: p.text.slice(0, 1500), nodes: p.nodes.map(n => [n.role, n.name, !!n.secret]), blocked: p.blocked, busy: p.busy,
        capture: p.capture ? { rect: p.capture.rect, scale: p.capture.scale, width: p.capture.width, height: p.capture.height, mimeType: p.capture.mimeType, data: p.capture.data.toString("base64") } : null,
      } as Seen;
    }, { pid: bench!.ready.pid, title: BENCH_TITLE });

    beforeAll(async () => {
      // The user's app goes, so nothing of it covers the bench.
      if (textEditPid) {
        process.kill(textEditPid, "SIGKILL");
        textEditPid = 0;
      }
      bench = await startBench(dir);
      console.log(`ember-darwin: bench ready ${JSON.stringify(bench.ready)}`);
      if (!bench.ready.controls?.Password || !bench.ready.controls.Name || !bench.ready.controls.Rows) throw new Error(`the bench didn't give its controls' frames: ${JSON.stringify(bench.ready)}`);
      const stack = ws!.stack();
      const covered = stack.slice(stack.findIndex(s => s.id === bench!.ready.window) + 1).filter(s => s.pid !== emberPid && s.x < bench!.ready.frame.x + bench!.ready.frame.width
        && s.x + s.width > bench!.ready.frame.x && s.y < bench!.ready.frame.y + bench!.ready.frame.height && s.y + s.height > bench!.ready.frame.y && !s.overrideRedirect);
      if (covered.length) warn(`windows over the bench: ${JSON.stringify(covered.map(s => [s.wmClass, s.title]))}`);
    }, 90_000);

    it("takes a window-scope screenshot of the bench with its pixels and its password field blacked out", async () => {
      const seen = await perceiveBench();
      console.log(`ember-darwin: the bench as Perception reads it: ${JSON.stringify(seen.nodes)}; blocked ${seen.blocked}, busy ${seen.busy}`);
      expect(seen.capture, seen.text).toBeTruthy();
      expect(seen.nodes.find(n => n[0] === "password text"), "the password field, secret").toEqual(["password text", "Password", true]);
      const c = bench!.ready.controls!;
      const masked = await share(seen.capture!, inner(c.Password!), dark);
      const name = await share(seen.capture!, inner(c.Name!), dark);
      console.log(`ember-darwin: window screenshot ${seen.capture!.width}x${seen.capture!.height} of ${JSON.stringify(seen.capture!.rect)} at scale ${seen.capture!.scale}: `
        + `password field ${(masked * 100).toFixed(0)} % black, name field ${(name * 100).toFixed(0)} % black`);
      expect(masked).toBeGreaterThan(0.95);
      // The picture isn't black everywhere: the Name field beside it shows (a white text box).
      expect(name).toBeLessThan(0.2);
    });

    it("leaves Ember's overlay out of its screenshot, though a plain grab of the screen shows it", async () => {
      const rows = inner(bench!.ready.controls!.Rows!, 0.6, 0.6);
      // A red block painted by Ember's own overlay window over the bench's list (the overlay's page coordinates are the
      // display's points: it covers the display from its origin).
      const painted = await inEmber(async ({ BrowserWindow }, r) => {
        const overlay = BrowserWindow.getAllWindows().find(w => w.getTitle() === "Ember overlay" && w.isVisible());
        if (!overlay) return "no overlay window";
        const origin = overlay.getBounds();
        await overlay.webContents.executeJavaScript(`(() => {
          const d = document.createElement("div");
          d.id = "ember-test-red";
          Object.assign(d.style, { position: "fixed", left: "${r.x - origin.x}px", top: "${r.y - origin.y}px", width: "${r.width}px", height: "${r.height}px", background: "#ff0000", zIndex: "2147483647", pointerEvents: "none" });
          document.documentElement.appendChild(d);
          return true;
        })()`);
        return "";
      }, rows);
      expect(painted).toBe("");
      try {
        // A plain grab through Electron's desktopCapturer in Ember's process (nothing hidden): the block is on screen.
        const plain = await waitFor("the overlay's red block in a plain grab", () => inEmber(async ({ desktopCapturer, screen }, r) => {
          const d = screen.getPrimaryDisplay();
          const [source] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: d.size });
          if (!source) return 0;
          const img = source.thumbnail.crop({ x: Math.round(r.x - d.bounds.x), y: Math.round(r.y - d.bounds.y), width: Math.round(r.width), height: Math.round(r.height) });
          const px = img.toBitmap();
          let n = 0;
          for (let i = 0; i < px.length; i += 4) if (px[i + 2]! >= 200 && px[i + 1]! <= 60 && px[i]! <= 60) n++;
          return px.length ? n / (px.length / 4) : 0;
        }, inner(rows, 0.8, 0.8)).then(v => (v > 0.8 ? v : null)), 5_000);
        console.log(`ember-darwin: a plain grab is ${(plain * 100).toFixed(0)} % red where the overlay paints`);
        const seen = await perceiveBench();
        expect(seen.capture, seen.text).toBeTruthy();
        const shot = await share(seen.capture!, inner(rows, 0.8, 0.8), red);
        console.log(`ember-darwin: Perception's screenshot is ${(shot * 100).toFixed(1)} % red there`);
        expect(shot).toBeLessThan(0.01);
      } finally {
        await inEmber(async ({ BrowserWindow }) => {
          for (const w of BrowserWindow.getAllWindows().filter(x => x.getTitle() === "Ember overlay")) {
            await w.webContents.executeJavaScript(`document.getElementById("ember-test-red")?.remove()`);
          }
        }, null);
      }
    });
  });

  it("polls for the user taking over (CursorBorrow's check()) in under 2 ms median", () => {
    // What check() reads every 8 ms during a borrow: the user's own input, the pointer, the keys down and the buttons.
    const x = input!;
    const check = () => { x.userInput?.(); x.pointer(); x.keysDown(); x.pointerState(); };
    const times: number[] = [];
    for (let i = 0; i < 201; i++) {
      const t0 = performance.now();
      check();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[100]!, p95 = times[190]!;
    console.log(`ember-darwin: check() median ${median.toFixed(3)} ms, 95th percentile ${p95.toFixed(3)} ms`);
    expect(median).toBeLessThan(2);
  });

  it.runIf(onMac && !!packaged)("runs the packaged accessibility host as Ember in node mode: it answers ping within 30 s, and status with AX up (koffi loads)", async () => {
    const exe = path.join(packaged, "Contents", "MacOS", "Ember");
    const host = path.join(packaged, "Contents", "Resources", "app", "dist", "app", "ax-sidecar.cjs");
    expect(fs.existsSync(exe), exe).toBe(true);
    expect(fs.existsSync(host), host).toBe(true);
    const child = spawn(exe, [host], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    let stderr = "";
    child.stderr.on("data", d => { stderr += d; });
    const answers = new Map<number, Record<string, unknown>>();
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", line => {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (typeof msg.id === "number") answers.set(msg.id, msg);
      } catch {
        // not a protocol line
      }
    });
    const ask = async (id: number, method: string, ms: number) => {
      const t0 = Date.now();
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: {} })}\n`);
      const msg = await waitFor(() => `an answer to ${method} (exit ${String(child.exitCode)}; stderr ${stderr.slice(0, 2000)})`, () => answers.get(id) ?? (child.exitCode !== null ? Promise.reject(new Error(`the packaged host exited (${String(child.exitCode)})\n${stderr}`)) : null), ms);
      console.log(`ember-darwin: the packaged host answered ${method} in ${Date.now() - t0} ms: ${JSON.stringify(msg)}`);
      return msg;
    };
    try {
      const ping = await ask(1, "ping", 30_000);
      expect(ping.error).toBeUndefined();
      expect(ping.result).toBeTruthy();
      const status = await ask(2, "status", 30_000);
      expect(status.error).toBeUndefined();
      expect(status.result, "the AX provider (koffi and ApplicationServices) up, trusted under the runner's grants").toMatchObject({ toolkitAccessibility: true });
      expect(String((status.result as { python?: string }).python)).toMatch(/\(ax\)$/);
    } finally {
      child.stdin.end();
      setTimeout(() => { if (child.exitCode === null) child.kill(); }, 3_000).unref();
    }
  });

  it.runIf(onMac && !packaged)("names the packaged host check as not run without EMBER_PACKAGED_APP", () => {
    if (required) throw new Error("EMBER_DARWIN_TEST=1 without EMBER_PACKAGED_APP: stage Ember first and name its bundle (dist/package/Ember.app)");
    notTestable("the packaged accessibility host", "no EMBER_PACKAGED_APP (stage Ember.app first)");
  });
});
