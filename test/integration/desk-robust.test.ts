/**
 * Ember's desk when things go wrong, on real desks (Xvfb, dbus-daemon): its
 * display dying while Ember types there, Ember itself being killed (the next
 * Ember clears the desk away), and the take-over view with a user whose
 * keyboard isn't a US one. Skipped where the desk can't run.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildSync } from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeskManager, deskProcesses, running } from "../../app/main/desk/desk";
import { openDeskPlace, type DeskPlace } from "../../app/main/desk/place";
import { CursorBorrow } from "../../app/main/hands/borrow";
import { DESK } from "../../app/shared/desk";
import { deskAgentScript } from "../unit/desk-agent-build";
import type { Logger } from "../../app/main/logger";

const h = vi.hoisted(() => ({ ipc: null as unknown as import("node:events").EventEmitter, windows: [] as { webContents: object }[] }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  h.ipc = new EventEmitter();
  class BrowserWindow extends EventEmitter {
    webContents = { send: () => undefined };
    constructor() { super(); h.windows.push(this); }
    isDestroyed() { return false; }
    isVisible() { return false; }
    setAlwaysOnTop() {}
    setIgnoreMouseEvents() {}
    loadFile() { return Promise.resolve(); }
    showInactive() {}
    hide() {}
    focus() {}
    getBounds() { return { x: 0, y: 0, width: 340, height: 238 }; }
    setBounds() {}
  }
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  return { BrowserWindow, ipcMain: { on: (ch: string, fn: (...a: unknown[]) => void) => h.ipc.on(ch, fn) }, screen: { getPrimaryDisplay: () => ({ workArea: area }), getDisplayMatching: () => ({ workArea: area }) } };
});

const root = fileURLToPath(new URL("../../", import.meta.url));
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const available = DeskManager.available().ok && process.platform === "linux" && ["/usr/lib64/libX11.so.6", "/usr/lib/x86_64-linux-gnu/libX11.so.6"].some(f => fs.existsSync(f));
const hasXev = spawnSync("sh", ["-c", "command -v xev"]).status === 0;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await sleep(25); return cond(); };

describe.skipIf(!available)("Ember's desk when things go wrong", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-desk-robust-"));
  const desks: DeskManager[] = [];
  let agent = "";
  beforeAll(() => { agent = deskAgentScript(); });
  afterAll(() => { for (const d of desks) d.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const make = (display: number) => { const d = new DeskManager(quiet, { handOff: path.join(dir, "Ember"), display, width: 640, height: 400, agent }); desks.push(d); return d; };
  const open = (desk: DeskManager) => openDeskPlace(desk, { sidecarScript: "/nonexistent.py", log: quiet, neverLook: () => [], profiles: path.join(dir, "profiles") });

  it("survives its display dying while Ember types there (10 times with SIGKILL, 10 with SIGTERM)", async () => {
    const desk = make(255);
    for (const sig of ["SIGKILL", "SIGTERM"] as const) {
      for (let run = 0; run < 10; run++) {
        const place = await open(desk);
        const borrow = new CursorBorrow(place.input);
        const lock = `/tmp/.X${place.info.display.slice(1)}-lock`;
        const xvfb = Number(fs.readFileSync(lock, "utf8").trim());
        setTimeout(() => process.kill(xvfb, sig), 50 + Math.random() * 250);
        const typing = borrow.borrow(async hand => { for (let i = 0; i < 40; i++) { await hand.glideTo(20 + i * 10, 20 + i * 5); await hand.type("hello world "); } }, { idleMs: 0 });
        await expect(typing, `${sig} run ${run}`).rejects.toThrow(/desk has stopped|Stopped/i);
        expect(await until(() => desk.running === null)).toBe(true);
        expect(place.dead).toBe(true);
      }
    }
  }, 120_000);

  it("clears away the desk of an Ember that was killed, and uses its display again", async () => {
    // A stand-in Ember: starts a desk, an app and something that left its process group, then is killed.
    const script = path.join(root, ".cache", "test", "desk-owner.cjs");
    buildSync({
      stdin: {
        contents: `import { DeskManager } from "./app/main/desk/desk";
          const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
          const desk = new DeskManager(quiet, { handOff: ${JSON.stringify(path.join(dir, "Ember"))}, display: 257, width: 320, height: 200, agent: ${JSON.stringify(agent)} });
          desk.start().then(info => { desk.run(["sleep", "400"]); desk.run(["setsid", "-f", "sleep", "401"]); setTimeout(() => console.log(JSON.stringify({ display: info.display, id: info.env.EMBER_DESK_ID })), 300); });
          setInterval(() => {}, 1000);`,
        resolveDir: root, loader: "ts",
      },
      bundle: true, platform: "node", format: "cjs", outfile: script, external: ["electron", "koffi", "sharp"], logLevel: "silent",
    });
    const owner = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
    const started = await new Promise<{ display: string; id: string }>((resolve, reject) => {
      owner.stdout.on("data", (d: Buffer) => { try { resolve(JSON.parse(d.toString())); } catch { /* more to come */ } });
      owner.once("exit", () => reject(new Error("the stand-in Ember exited")));
    });
    const orphans = deskProcesses(started.id);
    expect(orphans.length).toBeGreaterThanOrEqual(5); // Xvfb, dbus-daemon, Ember's desk helper, a window manager (if any), both sleeps
    owner.kill("SIGKILL");
    await new Promise(r => owner.once("exit", r));
    // (Another Ember starting meanwhile, a test run for one, may clear it away first: that's fine too.)
    // The next Ember's desk clears it away first, and gets the same display.
    const desk = make(257);
    const info = await desk.start();
    expect(deskProcesses(started.id)).toEqual([]);
    expect(orphans.every(p => !running(p))).toBe(true);
    expect(fs.existsSync(path.join(os.tmpdir(), started.id))).toBe(false);
    expect(info.display).toBe(started.display);
    desk.stop();
  }, 60_000);

  it.skipIf(!hasXev)("takes over with a German keyboard: the desk gets the characters the user typed", async () => {
    const { DeskView } = await import("../../app/main/desk/view");
    const desk = make(259);
    const place: DeskPlace = await open(desk);
    const out = path.join(dir, "xev.log");
    const pid = desk.run(["sh", "-c", `exec xev -event keyboard -geometry 300x200+0+0 > ${out}`]).pid;
    expect(await until(() => place.input.findWindow("Event Tester", pid) !== 0, 15_000)).toBe(true);
    // Clicked into once the window manager has it (until then the click goes elsewhere).
    const xev = place.input.findWindow("Event Tester", pid);
    expect(await until(() => {
      place.input.move(100, 100);
      place.input.button(1, true);
      place.input.button(1, false);
      return place.input.focusedWindow() === xev;
    }, 10_000)).toBe(true);
    const view = new DeskView(quiet);
    view.show(place);
    const win = h.windows.at(-1)!;
    const send = (ch: string, v?: unknown) => h.ipc.emit(ch, { sender: win.webContents }, v);
    const key = (k: string, code: string, down: boolean) => send(DESK.input, { type: "key", key: k, code, down });
    const tap = (k: string, code: string) => { key(k, code, true); key(k, code, false); };
    send(DESK.takeOver);
    expect(view.userInControl).toBe(true);
    // German: Shift+7 "/", Shift+0 "=", AltGr+Q "@", ü; French Shift+& "1"; then € and a Cyrillic letter.
    key("Shift", "ShiftLeft", true); tap("/", "Digit7"); tap("=", "Digit0"); key("Shift", "ShiftLeft", false);
    key("AltGraph", "AltRight", true); tap("@", "KeyQ"); key("AltGraph", "AltRight", false);
    tap("ü", "BracketLeft");
    key("Shift", "ShiftLeft", true); tap("1", "Digit1"); key("Shift", "ShiftLeft", false);
    tap("€", "KeyE");
    tap("я", "KeyZ");
    // Ctrl+Z (on the German Z key, where US has Y) is Ctrl+Z.
    key("Control", "ControlLeft", true); tap("z", "KeyY"); key("Control", "ControlLeft", false);
    await sleep(500);
    const presses = [...fs.readFileSync(out, "utf8").matchAll(/KeyPress event[\s\S]*?keysym 0x([0-9a-f]+), (\w+)\)/g)].map(m => m[2]);
    expect(presses.filter(k => !/^(Shift|Control)_[LR]$/.test(k))).toEqual(["slash", "equal", "at", "udiaeresis", "1", "U20AC", "U044F", "z"]);
    send(DESK.handBack);
    place.close();
    desk.stop();
  }, 30_000);
});
