/**
 * The handle's menu on a real X server (Xvfb) with the built app (dist/app; `npm run build` first): picking "Ask
 * Ember…" with the keyboard opens the ask box (review #67: a guard on menu-will-close, which Electron sends just before
 * the pick's click, swallowed every pick), and Esc on the menu opens nothing. Skipped without Xvfb, off Linux, or
 * without a build.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const built = fs.existsSync(path.join(root, "dist", "app", "main.cjs"));
const xvfb = process.platform === "linux" && spawnSync("sh", ["-c", "command -v Xvfb"], { stdio: "ignore" }).status === 0;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type ElectronApp = {
  /** Runs `fn` in Ember's main process, given the electron module. */
  evaluate<T>(fn: (electron: typeof Electron) => T): Promise<T>;
  process(): ChildProcess;
  close(): Promise<void>;
};

describe.skipIf(!xvfb || !built)("the handle's menu on a real X server", () => {
  let server: ChildProcess;
  let display = "";
  let app: ElectronApp;
  let userData = "";
  const events: { msg: string; source?: string }[] = [];

  /** Presses `keys` (X keysym names) one after another through XTEST, as a person at the keyboard. */
  function press(...keys: string[]): void {
    const koffi = requireCjs("koffi") as typeof import("koffi");
    const x = koffi.load("libX11.so.6"), xtst = koffi.load("libXtst.so.6");
    const XOpenDisplay = x.func("void *XOpenDisplay(const char *name)");
    const XCloseDisplay = x.func("int XCloseDisplay(void *dpy)");
    const XSync = x.func("int XSync(void *dpy, int discard)");
    const XStringToKeysym = x.func("unsigned long XStringToKeysym(const char *name)");
    const XKeysymToKeycode = x.func("uint8_t XKeysymToKeycode(void *dpy, unsigned long sym)");
    const XTestFakeKeyEvent = xtst.func("int XTestFakeKeyEvent(void *dpy, unsigned int keycode, int isPress, unsigned long delay)");
    const dpy = XOpenDisplay(display);
    for (const k of keys) {
      const code = Number(XKeysymToKeycode(dpy, Number(XStringToKeysym(k))));
      XTestFakeKeyEvent(dpy, code, 1, 0);
      XTestFakeKeyEvent(dpy, code, 0, 60);
      XSync(dpy, 0);
    }
    XCloseDisplay(dpy);
  }

  const askShown = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.getTitle() === "Ask Ember" && w.isVisible()));
  const showMenu = () => app.evaluate(() => (globalThis as unknown as { __ember: { showMenu(): void } }).__ember.showMenu());
  const hideAsk = () => app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.getTitle() === "Ask Ember") w.hide(); });

  beforeAll(async () => {
    server = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    display = ":" + await new Promise<string>((resolve, reject) => {
      server.stdio[3]!.on("data", (d: Buffer) => resolve(d.toString().trim()));
      server.on("exit", () => reject(new Error("Xvfb didn't start")));
    });
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "ember-menu-"));
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ version: 1, onboarded: true, consent: { version: 1, at }, wakeWord: false }));
    const { _electron } = requireCjs("playwright-core") as { _electron: { launch(o: object): Promise<ElectronApp> } };
    app = await _electron.launch({
      executablePath: requireCjs("electron") as unknown as string,
      // Started as at login: Ember only greets, so no settings window takes the keyboard.
      args: [root, "--autostart", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
      env: { ...process.env, DISPLAY: display, EMBER_USER_DATA: userData, EMBER_TEST_HOOKS: "1", EMBER_LOG_STDOUT: "1" },
      timeout: 60_000,
    });
    let buf = "";
    app.process().stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { events.push(JSON.parse(line) as { msg: string; source?: string }); } catch { /* not a log line */ }
      }
    });
    // The test hooks are there once Ember has started.
    for (let t = 0; t < 300; t++) {
      if (await app.evaluate(() => !!(globalThis as { __ember?: unknown }).__ember)) break;
      await sleep(100);
    }
  }, 90_000);
  afterAll(async () => {
    await app?.close().catch(() => { /* already gone */ });
    server?.kill();
    if (userData) fs.rmSync(userData, { recursive: true, force: true });
  });

  it("opens the ask box when \"Ask Ember…\" is picked with the keyboard", async () => {
    await showMenu();
    await sleep(1200);
    press("Down", "Return");
    for (let t = 0; t < 30 && !events.some(e => e.msg === "ask.reveal"); t++) await sleep(100);
    expect(events.filter(e => e.msg === "ask.menu_ignored")).toEqual([]);
    expect(events.find(e => e.msg === "ask.reveal")).toMatchObject({ source: "menu" });
    expect(await askShown()).toBe(true);
    await hideAsk();
  }, 30_000);

  it("opens nothing when the menu is closed with Esc", async () => {
    const before = events.filter(e => e.msg === "ask.open").length;
    await showMenu();
    await sleep(1200);
    press("Escape");
    await sleep(1000);
    expect(events.filter(e => e.msg === "ask.open").length).toBe(before);
    expect(await askShown()).toBe(false);
  }, 30_000);
});
