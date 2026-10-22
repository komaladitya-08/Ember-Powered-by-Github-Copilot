/**
 * The Windows UI Automation bridge (sidecar/uia) end to end against the shared WinForms bench
 * (test/fixtures/win_bench.ps1): it starts the way the sidecar host starts it, compiles once into its cache and then
 * starts quickly from it, reads the bench's controls with UIA's own control types (never the password's value), acts
 * through UIA patterns (the bench logs what happened), answers by its deadline when a click opens a modal dialog, and
 * exits when stdin closes. Windows only: skipped elsewhere, and failing instead of skipping when EMBER_UIA_TEST=1.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { POWERSHELL, UiaBridge, bridgeEnv, type BridgeAnswer, type RawNode, type UiaWindow } from "./uia-client";

const SCRIPT = path.resolve("sidecar/uia/ember_uia.ps1");
const BENCH = path.resolve("test/fixtures/win_bench.ps1");
const TITLE = "Ember Bench (Windows)";
const required = process.env.EMBER_UIA_TEST === "1";
const available = process.platform === "win32" && fs.existsSync(POWERSHELL) && fs.existsSync(BENCH);

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
  const events: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    try {
      if (line.trim()) events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A line still being written: the next poll reads it whole.
    }
  }
  return events;
}

function logged(log: string, match: Record<string, unknown>): Record<string, unknown> | undefined {
  return benchEvents(log).find(e => Object.entries(match).every(([k, v]) => e[k] === v));
}

/** The node of that control type and name; failing that, the only node of that type (WinForms names vary). */
function control(nodes: RawNode[], type: string, name: string): RawNode {
  const named = nodes.find(n => n.controlType === type && n.name === name);
  if (named) return named;
  const ofType = nodes.filter(n => n.controlType === type);
  expect(ofType.length, `one ${type} named "${name}" in ${JSON.stringify(nodes.map(n => [n.controlType, n.name]))}`).toBe(1);
  return ofType[0];
}

function centre(node: RawNode): { x: number; y: number } {
  expect(node.bounds, `bounds of ${node.name}`).toBeTruthy();
  const b = node.bounds!;
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}

describe.skipIf(!available && !required)("the UI Automation bridge on a real WinForms window", { timeout: 120_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-uia-"));
  const cache = path.join(dir, "cache");
  const log = path.join(dir, "bench.log");
  let bench: ChildProcess | undefined;
  let benchHwnd = 0;
  let benchPid = 0;
  let bridge: UiaBridge | undefined;
  let coldMs = 0;
  let nodes: RawNode[] = [];

  const ui = () => {
    expect(bridge, "a running bridge").toBeTruthy();
    return bridge!;
  };

  beforeAll(async () => {
    // Required runs (EMBER_UIA_TEST=1) fail here, naming what is missing, instead of skipping.
    expect(process.platform, "the UI Automation bridge runs only on Windows").toBe("win32");
    expect(fs.existsSync(POWERSHELL), `Windows PowerShell 5.1 at ${POWERSHELL}`).toBe(true);
    expect(fs.existsSync(SCRIPT), "sidecar/uia/ember_uia.ps1").toBe(true);
    expect(fs.existsSync(BENCH), "the shared WinForms bench, test/fixtures/win_bench.ps1").toBe(true);
    // Not windowsHide: that hides the first window the process shows, which would be the bench itself.
    bench = spawn(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Sta", "-File", BENCH, "-Log", log, "-Seconds", "600"], {
      stdio: "ignore",
      env: bridgeEnv(process.env),
    });
    const ready = await waitFor("the bench's ready line", () => logged(log, { event: "ready" }), 60_000);
    benchHwnd = Number(ready.hwnd);
    benchPid = Number(ready.pid);
    expect(benchHwnd).toBeGreaterThan(0);
    expect(benchPid).toBeGreaterThan(0);
  }, 90_000);

  afterAll(async () => {
    bridge?.kill();
    if (bench && bench.exitCode === null) bench.kill();
    await sleep(500);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("starts with a ready line and Per-Monitor-V2 DPI awareness, compiling into the cache the first time", async () => {
    const start = Date.now();
    const first = new UiaBridge(SCRIPT, bridgeEnv(process.env, { EMBER_UIA_CACHE: cache }));
    try {
      const ready = await first.ready;
      coldMs = Date.now() - start;
      expect(ready).toEqual({ ready: true, version: 1, dpi: "per-monitor-v2" });
      expect(coldMs).toBeLessThan(30_000);
      // One build and its hash (a temporary build Add-Type still holds may be left until a later start).
      const files = fs.readdirSync(cache);
      const builds = files.filter(f => /^ember_uia-[0-9a-f]{64}\.dll$/.test(f));
      expect(builds, files.join(", ")).toHaveLength(1);
      expect(files).toContain(builds[0] + ".sha256");
      expect(await first.call("ping")).toEqual({ version: 1 });
      const status = await first.call<Record<string, unknown>>("status");
      expect(status).toMatchObject({ version: 1, dpi: "per-monitor-v2", busyPids: [] });
      expect(String(status.clr)).toMatch(/^4\./);
    } finally {
      const exit = await first.close();
      expect(exit.code).toBe(0);
    }
    expect(first.strayLines).toEqual([]);
  });

  it("starts again quickly from its cached build", async () => {
    const start = Date.now();
    bridge = new UiaBridge(SCRIPT, bridgeEnv(process.env, { EMBER_UIA_CACHE: cache }));
    await bridge.ready;
    const warmMs = Date.now() - start;
    expect(warmMs, `cold ${coldMs} ms, warm ${warmMs} ms`).toBeLessThan(Math.max(coldMs, 1));
    expect(warmMs).toBeLessThan(10_000);
  });

  it("lists the bench among the top-level windows, with its process and program name", async () => {
    const { windows } = await ui().call<{ windows: UiaWindow[] }>("topWindows", { deadlineMs: 4000 });
    const w = windows.find(x => x.hwnd === benchHwnd);
    expect(w, JSON.stringify(windows.map(x => [x.hwnd, x.name, x.processName]))).toBeTruthy();
    expect(w).toMatchObject({ name: TITLE, pid: benchPid, controlType: "Window" });
    expect(w!.processName.toLowerCase()).toBe("powershell");
    expect(w!.busy).toBeUndefined();
    expect(w!.h).toBeGreaterThan(0);
    expect(w!.bounds?.width).toBeGreaterThan(0);
    // Front-most first, numbered densely.
    expect(windows.map(x => x.z)).toEqual(windows.map((_, i) => i));
    const own = await ui().call<{ windows: UiaWindow[] }>("topWindows", { pid: benchPid, deadlineMs: 4000 });
    expect(own.windows.every(x => x.pid === benchPid)).toBe(true);
    expect(own.windows.some(x => x.hwnd === benchHwnd)).toBe(true);
  });

  it("reads the bench's controls with UIA control types, and never the password field's value", async () => {
    const snap = await ui().call<{ nodes: RawNode[]; truncated: boolean; cut: string[]; busy: boolean }>("snapshot", { hwnd: benchHwnd, deadlineMs: 4000 }, 10_000);
    nodes = snap.nodes;
    expect(snap.busy).toBe(false);
    expect(snap.cut).toEqual([]);
    expect(nodes[0]).toMatchObject({ parent: -1, depth: 0, controlType: "Window", name: TITLE, hwnd: benchHwnd, pid: benchPid });
    nodes.forEach((n, i) => {
      if (i === 0) return;
      expect(n.parent).toBeGreaterThanOrEqual(0);
      expect(n.parent).toBeLessThan(i);
      expect(n.depth).toBe(nodes[n.parent!].depth! + 1);
      expect(n.runtimeId).toMatch(/^-?\d+(\.-?\d+)*$/);
    });
    const name = control(nodes, "Edit", "Name");
    const password = control(nodes, "Edit", "Password");
    expect(name.isPassword).toBe(false);
    expect(password.isPassword).toBe(true);
    expect(password.patterns.value ?? {}).not.toHaveProperty("value");
    expect(control(nodes, "CheckBox", "Remember me").patterns.toggle).toBe("Off");
    expect(control(nodes, "ComboBox", "Theme").patterns.expand).toBeDefined();
    expect(control(nodes, "Slider", "Volume").patterns.range).toMatchObject({ min: 0, max: 100 });
    const fruit = control(nodes, "List", "Fruit");
    const items = nodes.filter(n => n.parent === nodes.indexOf(fruit) && n.controlType === "ListItem").map(n => n.name);
    expect(items).toEqual(["Apple", "Banana", "Cherry"]);
    expect(control(nodes, "Button", "Save").patterns.invoke).toBe(true);
    expect(control(nodes, "Button", "Open dialog").patterns.invoke).toBe(true);
  });

  it("types into the Name box through ValuePattern, and the bench logs the text's length", async () => {
    const name = control(nodes, "Edit", "Name");
    const text = "Ember 1é";
    expect(await ui().call("perform", { handle: name.h, op: "setValue", value: text })).toEqual({ ok: true });
    await waitFor("the bench's text event", () => logged(log, { event: "text", control: "Name", length: text.length }));
    const fresh = await ui().call<RawNode>("element", { handle: name.h });
    expect(fresh.h).toBe(name.h);
    expect(fresh.patterns.value?.value).toBe(text);
    const info = await ui().call<{ text?: string; source?: string }>("textInfo", { handle: name.h });
    expect(info.text).toBe(text);
  });

  it("refuses to set the password field and calls it secret instead of reading it", async () => {
    const password = control(nodes, "Edit", "Password");
    const answer = await ui().request("perform", { handle: password.h, op: "setValue", value: "hunter2" });
    expect(answer.error?.code).toBe("denied");
    expect(await ui().call("textInfo", { handle: password.h })).toEqual({ secret: true });
    expect(logged(log, { event: "text", control: "Password" })).toBeUndefined();
  });

  it("clicks Save through InvokePattern", async () => {
    expect(await ui().call("perform", { handle: control(nodes, "Button", "Save").h, op: "invoke" })).toEqual({ ok: true });
    await waitFor("the bench's click event", () => logged(log, { event: "click", control: "Save" }));
  });

  it("toggles Remember me through TogglePattern", async () => {
    const box = control(nodes, "CheckBox", "Remember me");
    expect(await ui().call("perform", { handle: box.h, op: "toggle" })).toEqual({ ok: true });
    await waitFor("the bench's toggle event", () => logged(log, { event: "toggle", control: "Remember me", checked: true }));
    expect((await ui().call<RawNode>("element", { handle: box.h })).patterns.toggle).toBe("On");
  });

  it("chooses Dark in the Theme combo box through its list item", async () => {
    const combo = control(nodes, "ComboBox", "Theme");
    // Win32 combo boxes expose their items without opening (directly, or inside a List child).
    const findDark = async (): Promise<RawNode | undefined> => {
      const kids = await ui().call<RawNode[]>("children", { handle: combo.h });
      const direct = kids.find(k => k.controlType === "ListItem" && k.name === "Dark");
      if (direct) return direct;
      for (const list of kids.filter(k => k.controlType === "List")) {
        const items = await ui().call<RawNode[]>("children", { handle: list.h });
        const dark = items.find(k => k.controlType === "ListItem" && k.name === "Dark");
        if (dark) return dark;
      }
      return undefined;
    };
    const dark = await findDark();
    expect(dark, "the Dark item").toBeTruthy();
    expect(await ui().call("perform", { handle: dark!.h, op: "select" })).toEqual({ ok: true });
    const selected = () => logged(log, { event: "select", control: "Theme", value: "Dark" });
    try {
      await waitFor("the bench's select event", selected, 2000);
    } catch {
      // Some providers change the selection without telling the app; choosing in the open list does tell it.
      await ui().call("perform", { handle: combo.h, op: "expand" });
      const open = await findDark();
      expect(open, "the Dark item in the open list").toBeTruthy();
      await ui().call("perform", { handle: open!.h, op: "select" });
      await ui().call("perform", { handle: combo.h, op: "collapse" });
      await waitFor("the bench's select event after choosing in the open list", selected, 5000);
    }
  });

  it("sets the Volume slider through RangeValuePattern", async () => {
    const slider = control(nodes, "Slider", "Volume");
    expect(await ui().call("perform", { handle: slider.h, op: "setRange", value: 40 })).toEqual({ ok: true });
    expect((await ui().call<RawNode>("element", { handle: slider.h })).patterns.range?.value).toBe(40);
  });

  it("finds the Save button under its centre, from the window down", async () => {
    // Bring the bench to the front so nothing else is under the point (Windows may refuse: then it is already there).
    await ui().request("perform", { handle: nodes[0].h, op: "focus" });
    await sleep(300);
    const save = control(nodes, "Button", "Save");
    const chain = await ui().call<RawNode[]>("elementsAt", centre(save));
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain[0]).toMatchObject({ hwnd: benchHwnd, parent: -1, depth: 0 });
    const last = chain[chain.length - 1];
    expect(last).toMatchObject({ controlType: "Button", name: "Save", runtimeId: save.runtimeId });
    expect(last.bounds).toEqual(save.bounds);
    chain.forEach((n, i) => expect([n.parent, n.depth]).toEqual([i - 1, i]));
  });

  it("reports the focused element and its window", async () => {
    const name = control(nodes, "Edit", "Name");
    expect(await ui().call("perform", { handle: name.h, op: "focus" })).toEqual({ ok: true });
    const focused = await waitFor("focus on the Name box", async () => {
      const f = await ui().call<{ element: RawNode | null; window: number | null; hwnd: number | null }>("focused");
      return f.element?.runtimeId === name.runtimeId ? f : null;
    }, 5000);
    expect(focused.hwnd).toBe(benchHwnd);
    expect(focused.window).toBeGreaterThan(0);
    expect(focused.element?.hasKeyboardFocus).toBe(true);
  });

  it("answers by its deadline when a click opens a modal dialog, and the dialog can be read and closed meanwhile", async () => {
    const open = control(nodes, "Button", "Open dialog");
    const start = Date.now();
    const answer: BridgeAnswer = await ui().request("perform", { handle: open.h, op: "invoke", deadlineMs: 800 });
    const took = Date.now() - start;
    expect(took, "answered by the deadline").toBeLessThan(800 + 700);
    if (answer.error) expect(answer.error).toMatchObject({ code: "busy", message: "the app did not answer in time (it may still do it)" });
    else expect(answer.result).toEqual({ ok: true });
    const dialog = await waitFor("the modal dialog among the bench's windows", async () => {
      const { windows } = await ui().call<{ windows: UiaWindow[] }>("topWindows", { pid: benchPid, deadlineMs: 2000 });
      return windows.find(w => w.hwnd !== benchHwnd && (w.className === "#32770" || w.name === "Saved?"));
    });
    expect(dialog.busy, "the bench still answers while its dialog is open").toBeUndefined();
    expect(dialog.isModal ?? true).toBe(true);
    // The bench isn't hung (its dialog runs a message loop), so requests about it still work.
    expect((await ui().call<{ busyPids: number[] }>("status")).busyPids).not.toContain(benchPid);
    const inside = await ui().call<{ nodes: RawNode[] }>("snapshot", { handle: dialog.h, deadlineMs: 2000 });
    const ok = inside.nodes.find(n => n.controlType === "Button" && n.name === "OK");
    expect(ok, JSON.stringify(inside.nodes.map(n => [n.controlType, n.name]))).toBeTruthy();
    expect(await ui().call("perform", { handle: ok!.h, op: "invoke", deadlineMs: 2000 })).toEqual({ ok: true });
    await waitFor("the dialog to close", async () => {
      const { windows } = await ui().call<{ windows: UiaWindow[] }>("topWindows", { pid: benchPid, deadlineMs: 2000 });
      return !windows.some(w => w.hwnd === dialog.hwnd);
    });
  });

  it("frees released handles and answers errors with the documented codes", async () => {
    const save = control(nodes, "Button", "Save");
    expect(await ui().call("release", { handles: [save.h] })).toEqual({});
    expect((await ui().request("element", { handle: save.h })).error?.code).toBe("gone");
    expect((await ui().request("nonsense")).error).toEqual({ code: "bad_request", message: "unknown method: nonsense" });
    const name = control(nodes, "Edit", "Name");
    expect((await ui().request("perform", { handle: name.h, op: "spin" })).error?.code).toBe("bad_request");
    expect((await ui().request("perform", { handle: name.h, op: "toggle" })).error).toMatchObject({ code: "failed", message: "unsupported:toggle" });
  });

  it("exits with code 0 within 2 s when stdin closes", async () => {
    const exit = await ui().close();
    expect(exit.code).toBe(0);
    expect(exit.ms).toBeLessThan(2000);
    expect(ui().strayLines).toEqual([]);
    bridge = undefined;
  });
});
