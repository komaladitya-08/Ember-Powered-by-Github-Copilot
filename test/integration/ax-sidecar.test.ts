/**
 * The accessibility sidecar host end to end on Windows: the host built from source, started as Ember will start it
 * (hostLaunch: its own binary as plain Node, the UI Automation bridge's script and cache in its environment) and driven
 * through Ember's real client (AtspiSidecar) against the shared WinForms bench (test/fixtures/win_bench.ps1), whose log
 * says what each action did. Windows only: skipped elsewhere, and failing instead of skipping when EMBER_UIA_TEST=1
 * and something it needs is missing. macOS has its own, against its AppKit bench: ax-sidecar-darwin.test.ts. Last, it
 * checks the ask box's read with a real keyboard (Ember's input backend): the field that had it, and its selection,
 * once another window has it.
 *
 * The bench labels each control with the control's own accessible name (the label "Theme" beside the drop-down
 * "Theme"), so controls are looked up by name and role, never by name alone: the label comes first in the tree.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AtspiSidecar, type AxNode, type AxWindow, type ReadWindowResult, type SidecarLaunch, type SidecarStatus } from "../../app/main/perception/sidecar";
import { hostLaunch } from "../../app/sidecar-host/launch";
import { bridgeEnv, powershellPath } from "../../app/sidecar-host/providers/uia";
import { openWin32Input, openWin32Windows, win32Error } from "../../app/main/platform/win32";
import type { ScreenLike } from "../../app/main/platform/types";
import type { Logger } from "../../app/main/logger";

const SCRIPT = path.resolve("sidecar/uia/ember_uia.ps1");
const BENCH = path.resolve("test/fixtures/win_bench.ps1");
const TITLE = "Ember Bench (Windows)";
const POWERSHELL = powershellPath(process.env);
const required = process.env.EMBER_UIA_TEST === "1";
const available = process.platform === "win32" && fs.existsSync(POWERSHELL) && fs.existsSync(SCRIPT) && fs.existsSync(BENCH);
/** What Ember's worker matches for a busy app or an action whose outcome is unknown. */
const IS_BUSY = /\bbusy\b|did not (receive a reply|answer)|timeout was reached/i;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Polls until `probe` gives a value, or fails naming what it waited for. */
async function waitFor<T>(what: string, probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(100);
  }
}

/** The bench's JSON-lines log, whatever encoding PowerShell wrote it in. */
function benchEvents(log: string): Record<string, unknown>[] {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(log);
  } catch {
    return [];
  }
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString("utf16le");
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) text = bytes.subarray(3).toString("utf8");
  else text = bytes.toString("utf8");
  return text.split(/\r?\n/).flatMap(line => {
    try {
      return line.trim() ? [JSON.parse(line) as Record<string, unknown>] : [];
    } catch {
      return []; // a line still being written: the next poll reads it whole
    }
  });
}
const logged = (log: string, match: Record<string, unknown>) => benchEvents(log).find(e => Object.entries(match).every(([k, v]) => e[k] === v));

/**
 * The program a process runs, as Windows names it (tasklist's image name without ".exe"): "powershell" for the bench
 * run as a script, "EmberBench" once it is compiled to its own program. "" when the process is gone.
 */
function programOf(pid: number): string {
  const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  return /^"([^"]+)"/m.exec(out)?.[1].replace(/\.exe$/i, "") ?? "";
}

/** The host as npm run build bundles it, into .cache/test (a development tree). */
function buildHost(): string {
  const out = path.resolve(".cache", "test", "ax-sidecar.cjs");
  const tmp = `${out}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  buildSync({ entryPoints: [path.resolve("app/sidecar-host/main.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron", "koffi", "sharp"], outfile: tmp, logLevel: "silent" });
  fs.renameSync(tmp, out);
  return out;
}

describe.skipIf(!available && !required)("the accessibility sidecar host on a real WinForms window", { timeout: 180_000 }, () => {
  // Made when the tests run, not when they are collected (skipped ones too, on every platform).
  let dir = "";
  let cache = "";
  let log = "";
  const note = (msg: string, fields?: Record<string, unknown>) => { if (process.env.EMBER_TEST_VERBOSE) console.error(msg, fields ?? ""); };
  const logger = { debug: note, info: note, warn: note, error: note, child: () => logger } as unknown as Logger;
  let bench: ChildProcess | undefined;
  let benchPid = 0;
  let benchHwnd = 0;
  let launch: SidecarLaunch;
  let s: AtspiSidecar;
  let started: SidecarStatus;
  let win: AxWindow;
  let read: ReadWindowResult;
  /** The element called `name` with AT-SPI role `role` (several are called the same: a label and its control). */
  const node = (name: string, role: string): AxNode => {
    const found = read.nodes.find(n => n.name === name && n.role === role);
    expect(found, `${role} "${name}" in ${JSON.stringify(read.nodes.map(n => [n.role, n.name]))}`).toBeTruthy();
    return found!;
  };
  const reread = async () => { read = await s.readWindow({ pid: win.pid!, path: win.path, ownPid: process.pid }); };
  /** The Name text box: a single-line WinForms TextBox, "entry" (a multi-line one would be "text"). */
  const nameField = () => node("Name", read.nodes.some(n => n.name === "Name" && n.role === "text") ? "text" : "entry");
  /** Each bench control and the role the host gives it (the labels beside them are "label"). */
  const CONTROLS: [string, string][] = [["Password", "password text"], ["Remember me", "check box"], ["Theme", "combo box"], ["Volume", "slider"],
    ["Fruit", "list"], ["Save", "push button"], ["Open dialog", "push button"]];

  beforeAll(async () => {
    // Required runs (EMBER_UIA_TEST=1) fail here, naming what is missing, instead of skipping.
    expect(process.platform, "the sidecar host's Windows provider runs only on Windows").toBe("win32");
    expect(fs.existsSync(POWERSHELL), `Windows PowerShell 5.1 at ${POWERSHELL}`).toBe(true);
    expect(fs.existsSync(SCRIPT), "the UI Automation bridge, sidecar/uia/ember_uia.ps1").toBe(true);
    expect(fs.existsSync(BENCH), "the shared WinForms bench, test/fixtures/win_bench.ps1").toBe(true);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-host-"));
    cache = path.join(dir, "uia-cache");
    log = path.join(dir, "bench.log");
    const host = buildHost();
    // Not windowsHide: that hides the first window the process shows, which would be the bench itself.
    bench = spawn(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Sta", "-File", BENCH, "-Log", log, "-Seconds", "900"], { stdio: "ignore", env: bridgeEnv(process.env) });
    const ready = await waitFor("the bench's ready line", () => logged(log, { event: "ready" }), 60_000);
    benchPid = Number(ready.pid);
    benchHwnd = Number(ready.hwnd);
    launch = hostLaunch({ execPath: process.execPath, host, uiaScript: SCRIPT, uiaCache: cache, env: process.env, platform: "win32", packaged: false });
    // The bridge's first start compiles it (with Defender scanning the result): CI machines can take a while. status
    // answers at once while it starts (toolkitAccessibility null), and says why when it can't (false, with detail).
    s = new AtspiSidecar("unused.py", logger, "unused-python", process.env, { ...launch, firstRequestMs: 90_000 });
    started = await waitFor("the host and its bridge to start", async () => {
      const st = await s.status().catch(() => null);
      if (st?.toolkitAccessibility === false) throw new Error(`the bridge didn't start: ${st.detail} (language mode ${st.languageMode ?? "unknown"})`);
      return st?.toolkitAccessibility === true ? st : null;
    }, 120_000);
  }, 180_000);

  afterAll(async () => {
    s?.stop();
    if (bench && bench.exitCode === null) bench.kill();
    // The bench compiled to its own program outlives the script that started it.
    if (benchPid && benchPid !== bench?.pid) {
      try {
        process.kill(benchPid);
      } catch {
        // Gone already.
      }
    }
    await sleep(500);
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("says in status that the bridge is up, with its DPI awareness and no failure", () => {
    expect(started).toMatchObject({ version: 3, toolkitAccessibility: true, dpi: "per-monitor-v2" });
    expect(started.apps).toBeGreaterThan(0);
    expect(started.detail).toBeUndefined();
    expect(started.languageMode).toBeUndefined();
    if (started.processDpi !== undefined) expect(started.processDpi).toMatch(/^(per-monitor(-v2)?|system|unaware)$/);
  });

  it("lists the bench's window by its program, its pid and its HWND", async () => {
    const { windows } = await s.listWindows({ ownPid: process.pid });
    win = windows.find(w => w.name === TITLE)!;
    expect(win, JSON.stringify(windows.map(w => [w.app, w.name]))).toBeTruthy();
    const program = programOf(benchPid);
    expect(program, `the bench's process ${benchPid}`).not.toBe("");
    expect(win).toMatchObject({ pid: benchPid, path: String(benchHwnd), role: "frame" });
    expect(win.app.toLowerCase()).toBe(program.toLowerCase());
    expect(win.bounds!.width).toBeGreaterThan(100);
  });

  it("reads its controls with AT-SPI roles, each told from the label of the same name, and never the password", async () => {
    await reread();
    expect(read.window!.name).toBe(TITLE);
    expect(read.nodes[0]).toMatchObject({ depth: 0, parent: null, role: "frame" });
    expect(["entry", "text"]).toContain(nameField().role);
    for (const label of ["Name", "Password", "Theme", "Volume", "Fruit"]) expect(node(label, "label").bounds).toBeTruthy();
    const pw = node("Password", "password text");
    expect(pw.secret).toBe(true);
    expect(pw.text).toBeUndefined();
    for (const [name, role] of [["Name", nameField().role], ...CONTROLS]) {
      const n = node(name, role);
      expect(n.states.includes("enabled") && n.states.includes("sensitive"), `${n.role} "${n.name}" says enabled`).toBe(true);
    }
    expect(JSON.stringify(read)).not.toMatch(/"(button|search|search box)"/);
  });

  it("sets the Name field's text, and the bench sees it", async () => {
    const r = await s.setText(nameField().id, "Ember 1");
    expect(r.ok).toBe(true);
    expect(r.after?.text).toBe("Ember 1");
    await waitFor("the bench's text event", () => logged(log, { event: "text", control: "Name", length: 7 }));
  });

  it("refuses the password field, whatever is asked", async () => {
    await expect(s.setText(node("Password", "password text").id, "hunter2")).rejects.toThrow("password fields are off limits to Ember; the user must fill them in");
    expect(logged(log, { event: "text", control: "Password" })).toBeUndefined();
  });

  it("clicks Save by its own action", async () => {
    expect(await s.canDo(node("Save", "push button").id, "click")).toMatchObject({ tier1: true, action: "click" });
    const r = await s.doAction(node("Save", "push button").id, "click");
    expect(r).toMatchObject({ ok: true, action: "click" });
    await waitFor("the bench's click", () => logged(log, { event: "click", control: "Save" }));
  });

  it("toggles Remember me, and reads it turned on", async () => {
    const id = node("Remember me", "check box").id;
    const r = await s.doAction(id, "toggle");
    expect(r.ok).toBe(true);
    await waitFor("Remember me checked", async () => (await s.readElement(id)).states.includes("checked"), 2000);
    await waitFor("the bench's toggle", () => logged(log, { event: "toggle", control: "Remember me", checked: true }));
  });

  it("chooses Dark in the Theme drop-down, and the bench hears it", async () => {
    const id = node("Theme", "combo box").id;
    expect((await s.listOptions(id)).options).toEqual(expect.arrayContaining(["Light", "Dark", "System"]));
    const r = await s.selectOption(id, "Dark");
    expect(r).toMatchObject({ ok: true, option: "Dark" });
    await waitFor("the bench's select", () => logged(log, { event: "select", control: "Theme", value: "Dark" }));
    expect((await s.readElement(id)).selected).toBe("Dark");
  });

  it("sets the Volume slider within its range only, and reads the new value back", async () => {
    const id = node("Volume", "slider").id;
    await expect(s.setValue(id, 150)).rejects.toThrow("value 150.0 is outside 0.0..100.0");
    const r = await s.setValue(id, 70);
    expect(r).toMatchObject({ ok: true, after: { role: "slider", value: 70 } });
    expect((await s.readElement(id)).value).toBe(70);
    // The bench logs the TrackBar's ValueChanged, which WinForms raises only for a scroll message it can route to the
    // control: .NET's slider proxy (WindowsSlider.cs) sends its parent WM_HSCROLL with no control handle (lParam 0), so
    // the app may not hear a value set by UI Automation. Recorded for the run's evidence, not asserted (see the report).
    const heard = await waitFor("the bench's value", () => logged(log, { event: "value", control: "Volume", value: 70 }), 2000).then(() => true, () => false);
    if (!heard) console.warn("ax-sidecar: the WinForms TrackBar didn't raise ValueChanged for a value set by UI Automation (WM_HSCROLL with lParam 0)");
  });

  it("selects a Fruit as a click selects it (never opening it), and the bench hears it, or leaves it to the mouse when the bench isn't in front", async () => {
    const banana = node("Banana", "list item");
    const r = await s.doAction(banana.id, "click").catch((e: Error) => e);
    if (r instanceof Error) expect(r.message).toMatch(/^background_unavailable: its window isn't the active one/);
    else {
      expect(r).toMatchObject({ ok: true, action: "select item", after: { states: expect.arrayContaining(["selected"]) } });
      await waitFor("the bench's select", () => logged(log, { event: "select", control: "Fruit", value: "Banana" }));
    }
  });

  it("tells what is at Save's centre, with the bounds a read gives", async () => {
    const save = node("Save", "push button");
    const b = save.bounds!;
    const here = await s.atPoint({ pid: win.pid!, path: win.path!, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), ownPid: process.pid });
    expect(here.busy).toBeUndefined();
    expect(here.chain[here.chain.length - 1]).toMatchObject({ role: "push button", name: "Save", bounds: save.bounds });
  });

  it("finds every secret field for a screenshot's masks", async () => {
    const found = await s.secretFields({ pid: win.pid!, path: win.path! });
    expect(found.complete).toBe(true);
    expect(found.fields).toEqual([expect.objectContaining({ role: "password text", bounds: node("Password", "password text").bounds })]);
  });

  it("never reads Ember's own process (EMBER_OWNER_PID), though its windows are listed", async () => {
    // A second host that takes the bench for Ember: it lists the bench's window but finds, reads and hit-tests nothing
    // in it, and its bridge makes no UI Automation call into it (skipPids).
    const owner = new AtspiSidecar("unused.py", logger, "unused-python", process.env, { ...launch, env: { ...launch.env, EMBER_OWNER_PID: String(benchPid) }, firstRequestMs: 90_000 });
    try {
      await waitFor("the second host's bridge", async () => (await owner.status().catch(() => null))?.toolkitAccessibility === true, 60_000);
      const { windows } = await owner.listWindows({});
      expect(windows.some(w => w.pid === benchPid && w.path === String(benchHwnd)), JSON.stringify(windows.map(w => [w.app, w.pid, w.path]))).toBe(true);
      expect(await owner.readWindow({ pid: benchPid, path: String(benchHwnd) })).toMatchObject({ window: null, nodes: [] });
      expect(await owner.readWindow({ title: TITLE })).toMatchObject({ window: null, nodes: [] });
      const b = node("Save", "push button").bounds!;
      expect(await owner.atPoint({ pid: benchPid, path: String(benchHwnd), x: b.x + 5, y: b.y + 5 })).toMatchObject({ chain: [], found: false });
      expect(await owner.secretFields({ pid: benchPid, path: String(benchHwnd) })).toMatchObject({ fields: [], complete: false });
    } finally {
      owner.stop();
    }
  });

  it("answers at once when a click opens a modal dialog, and the dialog can be read and answered", async () => {
    const t0 = Date.now();
    const r = await s.doAction(node("Open dialog", "push button").id, "click").then(x => x, (e: Error) => e);
    expect(Date.now() - t0).toBeLessThan(4000);
    if (r instanceof Error) expect(r.message).toMatch(IS_BUSY);
    else expect(r.ok).toBe(true);
    const dialog = await waitFor("the Saved? dialog", async () => {
      const d = await s.readWindow({ pid: benchPid, title: "Saved?", ownPid: process.pid }).catch(() => null);
      return d?.window && d.nodes.some(n => n.role === "push button") ? d : null;
    }, 10_000);
    expect(dialog.window!.role).toBe("dialog");
    // The host keeps answering meanwhile.
    expect((await s.status()).version).toBe(3);
    const ok = dialog.nodes.find(n => n.role === "push button" && /^ok$/i.test(n.name));
    expect(ok, JSON.stringify(dialog.nodes.map(n => [n.role, n.name]))).toBeTruthy();
    const done = await s.doAction(ok!.id, "click").catch((e: Error) => e);
    if (done instanceof Error) expect(done.message).toMatch(IS_BUSY);
    await waitFor("the bench's dialog answer", () => logged(log, { event: "dialog", result: "OK" }));
  });

  it("tells the ask box's read which field had the keyboard once another window has it, and reads its selection (cross-review P1)", async () => {
    // The ask box shows before the screen is read: main takes what has the keyboard first (WindowSystem.keyboardFocus:
    // the foreground thread's focused window), the box takes it, and the read of the user's window is told what had it
    // (focusBefore), since UI Automation's focus is the whole system's by then. Here the Name field has the keyboard with
    // its text selected, and another bench takes it, as the box would.
    const screen: ScreenLike = { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 1 }), getAllDisplays: () => [] };
    const ws = openWin32Windows({ screen });
    const x = openWin32Input();
    expect(ws, `the Windows window system (${String(win32Error)})`).toBeTruthy();
    expect(x, `Windows input (${String(win32Error)})`).toBeTruthy();
    const otherLog = path.join(dir, "other-bench.log");
    let other: ChildProcess | undefined;
    let otherPid = 0;
    const tap = async (key: string) => {
      const k = x!.keysymOf(key);
      x!.keysym(k, true);
      await sleep(30);
      x!.keysym(k, false);
      await sleep(30);
    };
    try {
      const hwnd = benchHwnd >>> 0;
      x!.activate(hwnd);
      await waitFor("the bench in front", () => x!.activeWindow() === hwnd, 5_000);
      await reread();
      expect((await s.setText(nameField().id, "Ember 1")).ok).toBe(true);
      await s.request("focus", { id: nameField().id });
      // End, then Shift+Home: the whole line selected, as the user would select it.
      await tap("End");
      const shift = x!.keysymOf("Shift_L");
      x!.keysym(shift, true);
      await sleep(30);
      await tap("Home");
      x!.keysym(shift, false);
      const had = await waitFor("the Name field with the keyboard and its text selected", async () => {
        await reread();
        const n = nameField();
        return n.states.includes("focused") && n.selection === "Ember 1" ? n : null;
      }, 5_000);
      // What main takes just before the box shows.
      const native = ws!.keyboardFocus();
      expect(native, "the bench's focused window").toBeGreaterThan(0);
      other = spawn(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Sta", "-File", BENCH, "-Log", otherLog, "-Seconds", "300"], { stdio: "ignore", env: bridgeEnv(process.env) });
      const otherReady = await waitFor("the other bench's ready line", () => logged(otherLog, { event: "ready" }), 60_000);
      otherPid = Number(otherReady.pid);
      const otherHwnd = Number(otherReady.hwnd) >>> 0;
      x!.activate(otherHwnd);
      await waitFor("the other bench in front", () => x!.activeWindow() === otherHwnd, 5_000);
      await reread();
      console.log(`ax-sidecar: with another window in front, the bench's own read says focused: ${JSON.stringify(read.nodes.filter(n => n.states.includes("focused")).map(n => [n.role, n.name]))}`);
      read = await s.readWindow({ pid: benchPid, path: String(benchHwnd), ownPid: process.pid, focusBefore: { native } });
      expect(nameField(), "the Name field, in the read told what had the keyboard").toMatchObject({ states: expect.arrayContaining(["focused"]), selection: had.selection });
    } finally {
      x?.releaseAll();
      x?.close();
      ws?.close();
      if (other && other.exitCode === null) other.kill();
      // The bench compiled to its own program outlives the script that started it.
      if (otherPid && otherPid !== other?.pid) {
        try {
          process.kill(otherPid);
        } catch {
          // Gone already.
        }
      }
    }
  });
});
