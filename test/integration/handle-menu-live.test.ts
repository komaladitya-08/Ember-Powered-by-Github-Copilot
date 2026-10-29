/**
 * The handle's menu and the ask box on a real X server (Xvfb) with the built app (dist/app; `npm run build` first):
 * picking "Ask Ember…" with the keyboard opens the ask box (review #67: a guard on menu-will-close, which Electron sends
 * just before the pick's click, swallowed every pick), and Esc on the menu opens nothing; the line under the ask box's
 * field keeps the window's name readable when it is crowded: a remote computer, what else is sent, a paste cut at the
 * limit (reviews #70, #74); the box is as large as its words at each text size (review #57). Skipped without Xvfb, off
 * Linux, or without a build, except with EMBER_ATSPI_TEST=1 (RHEL 8 CI, which builds first): there a missing one fails.
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
  /** Runs `fn` in Ember's main process, given the electron module (and `arg`). */
  evaluate<T, A = undefined>(fn: (electron: typeof Electron, arg: A) => T, arg?: A): Promise<T>;
  process(): ChildProcess;
  close(): Promise<void>;
};

/** CI's RHEL 8 job: Xvfb and the build must be there (a skip would hide that the menu was never checked). */
const required = process.env.EMBER_ATSPI_TEST === "1" && process.platform === "linux";

describe.skipIf(!required && (!xvfb || !built))("the handle's menu on a real X server", () => {
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
    if (!xvfb || !built) throw new Error(`the handle's menu can't be checked here: ${!xvfb ? "no Xvfb" : "no build (npm run build first)"}`);
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

  it("keeps the window's name readable under the ask box when the line is crowded or a long paste was cut", async () => {
    await app.evaluate(() => (globalThis as unknown as { __ember: { showAsk(): void } }).__ember.showAsk());
    for (let t = 0; t < 50 && !(await askShown()); t++) await sleep(100);
    expect(await askShown()).toBe(true);
    // The quick look's own update has come and gone: what follows is this test's.
    await sleep(1500);
    const ssh = { id: "ssh:deploy@build-server-01", kind: "ssh", label: "deploy@build-server-01", state: "lost", can: "", active: true };
    const cases = {
      "a mail window, field text and three windows": { sees: "Firefox · Inbox (12) — Mail", carries: { selection: false, fieldText: true, windows: 3 }, history: ["a"] },
      "an editor, a selection and five windows": { sees: "Visual Studio Code · extension.ts — ember-improve", carries: { selection: true, fieldText: false, windows: 5 }, history: ["a"] },
      "a lost SSH computer, field text and two windows": { sees: "Terminal · deploy@build-server-01: ~/src", carries: { selection: false, fieldText: true, windows: 2 }, history: ["a"], target: ssh },
      "a private window": { sees: null, privateWindow: true, history: ["a"] },
    };
    type Row = { name: number; nameWhole: number; overflow: number; cut: boolean; cutOnLine: boolean; state: string; height: number };
    const row = (ctx: object, text: string) => app.evaluate(async ({ BrowserWindow }, a: { ctx: object; text: string }): Promise<Row> => {
      const w = BrowserWindow.getAllWindows().find(x => x.getTitle() === "Ask Ember")!;
      w.webContents.send("agent:ask-context", { sees: null, history: ["a"], opened: true });
      w.webContents.send("agent:ask-context", a.ctx);
      await new Promise(r => setTimeout(r, 150));
      await w.webContents.executeJavaScript(`{ const q = document.getElementById("q"); q.value = ${JSON.stringify(a.text)}; q.dispatchEvent(new Event("input")); }`);
      await new Promise(r => setTimeout(r, 400));
      const page = await w.webContents.executeJavaScript(`(() => {
        const t = document.getElementById("sees-text"), meta = document.querySelector(".meta"), cut = document.getElementById("cut");
        const state = document.getElementById("where-state");
        return { name: t.clientWidth, nameWhole: t.scrollWidth, overflow: meta.scrollWidth - meta.clientWidth, cut: !cut.hidden && cut.getBoundingClientRect().width > 0,
          cutOnLine: meta.contains(cut), state: state && state.getBoundingClientRect().width > 0 ? state.textContent : "" };
      })()`) as Omit<Row, "height">;
      return { ...page, height: w.getBounds().height };
    }, { ctx, text });
    for (const [what, ctx] of Object.entries(cases)) {
      for (const text of ["", "x".repeat(2000)]) {
        const r = await row(ctx, text);
        const label = `${what}${text ? ", 2000 characters pasted" : ""}: ${JSON.stringify(r)}`;
        // The window's name keeps the room it aims for (or all it needs), and nothing is pushed off the line.
        expect.soft(r.name, label).toBeGreaterThanOrEqual(Math.min(160, r.nameWhole));
        expect.soft(r.overflow, label).toBe(0);
        // The note says the paste was cut, on its own line under it: the box is a line taller than four lines of text.
        expect.soft(r.cut, label).toBe(!!text);
        expect.soft(r.cutOnLine, label).toBe(false);
        if (text) expect.soft(r.height, label).toBe(92 + 4 * 24);
        if ("target" in ctx) expect.soft(r.state, label).toBe(" (lost)");
      }
    }
    await hideAsk();
  }, 60_000);

  it("opens the ask box as large as its words at the text size, and at the new size once it changes (review #57)", async () => {
    type Seen = { width: number; height: number; size: string; font: string; clipped: boolean; room: number };
    const opened = async (size: string, text = ""): Promise<Seen> => {
      await app.evaluate((_e, s: string) => (globalThis as unknown as { __ember: { settings: { update(p: object): void } } }).__ember.settings.update({ textSize: s }), size);
      await sleep(300);
      await app.evaluate(() => (globalThis as unknown as { __ember: { showAsk(): void } }).__ember.showAsk());
      for (let t = 0; t < 50 && !(await askShown()); t++) await sleep(100);
      await sleep(800);
      return app.evaluate(async ({ BrowserWindow }, t: string): Promise<Seen> => {
        const w = BrowserWindow.getAllWindows().find(x => x.getTitle() === "Ask Ember")!;
        await w.webContents.executeJavaScript(`{ const q = document.getElementById("q"); q.value = ${JSON.stringify(t)}; q.dispatchEvent(new Event("input")); }`);
        await new Promise(r => setTimeout(r, 400));
        const page = await w.webContents.executeJavaScript(`(() => {
          const meta = document.querySelector(".meta"), form = document.getElementById("form");
          const foot = Math.max(...[...form.children].filter(e => getComputedStyle(e).display !== "none").map(e => e.getBoundingClientRect().bottom));
          return { size: document.documentElement.dataset.textSize ?? "default", font: getComputedStyle(document.getElementById("q")).fontSize,
            clipped: meta.scrollHeight > meta.clientHeight + 0.5 || meta.scrollWidth > meta.clientWidth, room: innerHeight - foot };
        })()`) as Omit<Seen, "width" | "height">;
        const { width, height } = w.getBounds();
        return { width, height, ...page };
      }, text);
    };
    try {
      // 560 × 92 at the default size; the field and the line under it grow with the text, not the window's insets.
      for (const [size, width, height, font] of [["larger", 728, 111, "23.4px"], ["large", 644, 101, "20.7px"], ["default", 560, 92, "18px"]] as const) {
        const r = await opened(size);
        const label = `${size}: ${JSON.stringify(r)}`;
        expect.soft(r, label).toMatchObject({ width, height, size, font, clipped: false });
        expect.soft(r.room, label).toBeGreaterThanOrEqual(8);
        await hideAsk();
      }
      // A paste cut at the limit at Larger: four lines and the note, each row 24 px times the scale.
      const cut = await opened("larger", "x".repeat(2000));
      expect.soft(cut, JSON.stringify(cut)).toMatchObject({ width: 728, height: 111 + Math.round(4 * 24 * 1.3), clipped: false });
      expect.soft(cut.room, JSON.stringify(cut)).toBeGreaterThanOrEqual(8);
    } finally {
      await hideAsk();
      await app.evaluate(() => (globalThis as unknown as { __ember: { settings: { update(p: object): void } } }).__ember.settings.update({ textSize: "default" }));
    }
  }, 60_000);
});
