/**
 * The Windows UI Automation bridge (sidecar/uia) end to end against the shared WinForms bench
 * (test/fixtures/win_bench.ps1, which compiles and runs EmberBench.exe): it starts the way the sidecar host starts it,
 * compiles once into its cache and then starts quickly from it, reads the bench's controls with UIA's own control
 * types (never the password's value), including the classic ListView and TreeView whose UIA view comes from .NET's
 * client-side proxies, acts through UIA patterns (the bench logs what happened), answers by its deadline when a click
 * opens a modal dialog, leaves a skipped process alone, names a console window conhost, reads the bench's 32-bit build
 * as well, and ends at once when stdin closes. Windows only: skipped elsewhere, and failing instead of skipping when
 * EMBER_UIA_TEST=1. The facts CI needs to judge a failure (DPI awareness, exit timings, why a window was busy) are
 * printed as "uia-bridge: ..." lines.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { POWERSHELL, UiaBridge, bridgeEnv, type BridgeAnswer, type BridgeExit, type RawNode, type UiaWindow } from "./uia-client";

const SCRIPT = path.resolve("sidecar/uia/ember_uia.ps1");
const BENCH = path.resolve("test/fixtures/win_bench.ps1");
const TITLE = "Ember Bench (Windows)";
/** The bench's program (compiled by win_bench.ps1, so that it isn't powershell, a terminal). */
const BENCH_PROGRAM = "emberbench";
const DPI_NAMES = ["per-monitor-v2", "per-monitor", "system", "unaware"];
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

/** The bench's JSON-lines log, whatever encoding it was written in. */
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

const shown = (nodes: RawNode[]) => JSON.stringify(nodes.map(n => [n.controlType, n.name, n.className]));

/** The node of that control type and name; failing that, the only node of that type (WinForms names vary). */
function control(nodes: RawNode[], type: string, name: string): RawNode {
  const named = nodes.find(n => n.controlType === type && n.name === name);
  if (named) return named;
  const ofType = nodes.filter(n => n.controlType === type);
  expect(ofType.length, `one ${type} named "${name}" in ${shown(nodes)}`).toBe(1);
  return ofType[0];
}

/** The nodes below `root` in a snapshot (its `parent` links). */
function under(nodes: RawNode[], root: RawNode): RawNode[] {
  const inside = new Set([nodes.indexOf(root)]);
  return nodes.filter((n, i) => {
    if (n.parent === undefined || !inside.has(n.parent)) return false;
    inside.add(i);
    return true;
  });
}

/** The bench's ListView (SysListView32: a DataGrid to UI Automation in details view, else a List) and its rows. */
function listView(nodes: RawNode[]): { view: RawNode; items: RawNode[] } {
  const view = nodes.find(n => /SysListView32/i.test(n.className ?? "") && (n.controlType === "DataGrid" || n.controlType === "List"));
  expect(view, `the bench's ListView in ${shown(nodes)}`).toBeTruthy();
  const items = under(nodes, view!).filter(n => n.controlType === "DataItem" || n.controlType === "ListItem");
  return { view: view!, items };
}

/** The bench's TreeView (SysTreeView32) and every tree item listed under it. */
function treeView(nodes: RawNode[]): { tree: RawNode; items: RawNode[] } {
  const tree = nodes.find(n => n.controlType === "Tree" && /SysTreeView32/i.test(n.className ?? ""));
  expect(tree, `the bench's TreeView in ${shown(nodes)}`).toBeTruthy();
  return { tree: tree!, items: under(nodes, tree!).filter(n => n.controlType === "TreeItem") };
}

function centre(node: RawNode): { x: number; y: number } {
  expect(node.bounds, `bounds of ${node.name}`).toBeTruthy();
  const b = node.bounds!;
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}

/** Ends a process if it still runs (clean-up: the bench's program outlives the script that started it). */
function end(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
}

/**
 * How win_bench.ps1 is asked for its 32-bit build (/platform:x86), from its param block: a [switch]$X86, or a
 * -Platform, -Architecture or -Arch parameter that takes "x86". Null when it has none.
 */
function x86Args(script: string): string[] | null {
  const text = fs.readFileSync(script, "latin1");
  const block = /\bparam\s*\(([\s\S]*?)\n\s*\)/i.exec(text)?.[1] ?? "";
  if (/\[switch\]\s*\$X86\b/i.test(block)) return ["-X86"];
  for (const name of ["Platform", "Architecture", "Arch"]) {
    if (new RegExp(`\\$${name}\\b`, "i").test(block)) return [`-${name}`, "x86"];
  }
  return null;
}

interface Bench { child: ChildProcess; hwnd: number; pid: number; log: string }

describe.skipIf(!available && !required)("the UI Automation bridge on a real WinForms window", { timeout: 120_000 }, () => {
  // Made in beforeAll: vitest still runs this body to list a skipped suite, and nothing would remove the folder then.
  let dir = "";
  let cache = "";
  let bench: Bench | undefined;
  let x86: Bench | undefined;
  let consolePid = 0;
  let bridge: UiaBridge | undefined;
  let coldMs = 0;
  let firstExit: BridgeExit | undefined;
  let nodes: RawNode[] = [];

  const ui = () => {
    expect(bridge, "a running bridge").toBeTruthy();
    return bridge!;
  };
  const main = () => {
    expect(bench, "the bench").toBeTruthy();
    return bench!;
  };

  /** Starts win_bench.ps1 (which builds and runs EmberBench.exe) and waits for its ready line. */
  async function startBench(log: string, extra: string[] = []): Promise<Bench> {
    // Not windowsHide: that hides the first window the process shows, which would be the bench itself.
    const child = spawn(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Sta", "-File", BENCH, "-Log", log, "-Seconds", "600", ...extra], {
      stdio: "ignore",
      env: bridgeEnv(process.env),
    });
    // The first start compiles the bench (and Defender scans it).
    const ready = await waitFor(`the bench's ready line in ${log}`, () => logged(log, { event: "ready" }), 90_000);
    const b: Bench = { child, hwnd: Number(ready.hwnd), pid: Number(ready.pid), log };
    expect(b.hwnd).toBeGreaterThan(0);
    expect(b.pid).toBeGreaterThan(0);
    return b;
  }

  function stopBench(b: Bench | undefined): void {
    if (!b) return;
    end(b.pid);
    if (b.child.exitCode === null) b.child.kill();
  }

  /**
   * topWindows until window `hwnd` is listed and was read (not busy), for at most `ms`: a window can be listed busy
   * while its app is still setting itself up. A busy first answer is printed with its reason.
   */
  async function listedRead(hwnd: number, ms = 10_000): Promise<{ windows: UiaWindow[]; w: UiaWindow | undefined }> {
    const until = Date.now() + ms;
    let first = true;
    for (;;) {
      const { windows } = await ui().call<{ windows: UiaWindow[] }>("topWindows", { deadlineMs: 4000 }, 10_000);
      const w = windows.find(x => x.hwnd === hwnd);
      if (w && !w.busy) return { windows, w };
      if (first && w) console.log(`uia-bridge: window ${hwnd} was listed busy at first (${w.reason ?? "no reason given"})`);
      first = false;
      if (Date.now() > until) return { windows, w };
      await sleep(250);
    }
  }

  beforeAll(async () => {
    // Required runs (EMBER_UIA_TEST=1) fail here, naming what is missing, instead of skipping.
    expect(process.platform, "the UI Automation bridge runs only on Windows").toBe("win32");
    expect(fs.existsSync(POWERSHELL), `Windows PowerShell 5.1 at ${POWERSHELL}`).toBe(true);
    expect(fs.existsSync(SCRIPT), "sidecar/uia/ember_uia.ps1").toBe(true);
    expect(fs.existsSync(BENCH), "the shared WinForms bench, test/fixtures/win_bench.ps1").toBe(true);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-uia-"));
    cache = path.join(dir, "cache");
    bench = await startBench(path.join(dir, "bench.log"));
  }, 120_000);

  afterAll(async () => {
    bridge?.kill();
    stopBench(bench);
    stopBench(x86);
    end(consolePid);
    await sleep(500);
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("starts with a ready line and Per-Monitor-V2 DPI awareness, compiling into the cache the first time", async () => {
    const start = Date.now();
    const first = new UiaBridge(SCRIPT, bridgeEnv(process.env, { EMBER_UIA_CACHE: cache }));
    try {
      const ready = await first.ready;
      coldMs = Date.now() - start;
      console.log(`uia-bridge: ready line ${JSON.stringify(ready)} after ${coldMs} ms (cold)`);
      expect(ready).toMatchObject({ ready: true, version: 1, dpi: "per-monitor-v2" });
      expect(Object.keys(ready).sort()).toEqual(["dpi", "processDpi", "ready", "version"]);
      expect(DPI_NAMES).toContain(ready.processDpi);
      expect(coldMs).toBeLessThan(30_000);
      // One build and its hash (a temporary build Add-Type still holds may be left until a later start).
      const files = fs.readdirSync(cache);
      const builds = files.filter(f => /^ember_uia-[0-9a-f]{64}\.dll$/.test(f));
      expect(builds, files.join(", ")).toHaveLength(1);
      expect(files).toContain(builds[0] + ".sha256");
      expect(await first.call("ping")).toEqual({ version: 1 });
      const status = await first.call<Record<string, unknown>>("status");
      expect(status).toMatchObject({ version: 1, dpi: "per-monitor-v2", processDpi: ready.processDpi, busyPids: [] });
      expect(String(status.clr)).toMatch(/^4\./);
    } finally {
      firstExit = await first.close();
    }
    // A bridge that made no UI Automation call: the baseline for the last test's exit.
    console.log(`uia-bridge: a bridge without UI Automation calls wrote its exit line ${firstExit.lineMs} ms and exited ${firstExit.ms} ms after its stdin closed`);
    expect(firstExit.code).toBe(0);
    expect(firstExit.lineMs, "the exit line").not.toBeNull();
    expect(firstExit.ms).toBeLessThan(2000);
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

  it("starts from a folder whose name has square brackets, from memory and with its cache in such a folder (review #201)", async () => {
    // Add-Type -Path would take "[portable]" for a wildcard and find no file; the bootstrap compiles by literal path.
    const staged = path.join(dir, "Ember [portable]", "sidecar", "uia");
    fs.mkdirSync(staged, { recursive: true });
    for (const f of ["ember_uia.ps1", "ember_uia.cs"]) fs.copyFileSync(path.join(path.dirname(SCRIPT), f), path.join(staged, f));
    const bracketCache = path.join(dir, "Jane [Work]", "cache");
    for (const extra of [{}, { EMBER_UIA_CACHE: bracketCache }] as Record<string, string>[]) {
      const b = new UiaBridge(path.join(staged, "ember_uia.ps1"), bridgeEnv(process.env, extra));
      try {
        expect(await b.ready).toMatchObject({ ready: true, version: 1 });
        expect(await b.call("ping")).toEqual({ version: 1 });
      } finally {
        const exit = await b.close();
        expect(exit.code).toBe(0);
      }
    }
    // Whether the build could be cached under a bracketed folder (-OutputAssembly); from memory works either way.
    const cached = fs.existsSync(bracketCache) ? fs.readdirSync(bracketCache) : [];
    console.log(`uia-bridge: a cache under "Jane [Work]" holds ${JSON.stringify(cached)}`);
  }, 120_000);

  it("lists the bench among the top-level windows, with its process and program name", async () => {
    const { windows, w } = await listedRead(main().hwnd);
    expect(w, JSON.stringify(windows.map(x => [x.hwnd, x.name, x.processName]))).toBeTruthy();
    expect(w!.busy, `listed from Win32 facts only: ${JSON.stringify(w)}`).toBeUndefined();
    expect(w).toMatchObject({ name: TITLE, pid: main().pid, controlType: "Window", className: expect.stringMatching(/WindowsForms10\.Window/) });
    expect(w!.processName.toLowerCase()).toBe(BENCH_PROGRAM);
    expect(w!.clientProgram).toBeUndefined();
    expect(w!.h).toBeGreaterThan(0);
    expect(w!.bounds?.width).toBeGreaterThan(0);
    // Front-most first, numbered densely.
    expect(windows.map(x => x.z)).toEqual(windows.map((_, i) => i));
    const own = await ui().call<{ windows: UiaWindow[] }>("topWindows", { pid: main().pid, deadlineMs: 4000 });
    expect(own.windows.every(x => x.pid === main().pid)).toBe(true);
    expect(own.windows.some(x => x.hwnd === main().hwnd)).toBe(true);
  });

  it("reads the bench's controls with UIA control types, and never the password field's value", async () => {
    const snap = await ui().call<{ nodes: RawNode[]; truncated: boolean; cut: string[]; busy: boolean }>("snapshot", { hwnd: main().hwnd, deadlineMs: 4000 }, 10_000);
    nodes = snap.nodes;
    expect(snap.busy).toBe(false);
    expect(snap.cut).toEqual([]);
    expect(nodes[0]).toMatchObject({ parent: -1, depth: 0, controlType: "Window", name: TITLE, hwnd: main().hwnd, pid: main().pid });
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

  it("reads the classic ListView's rows and the TreeView's items through .NET's client-side proxies", async () => {
    const { view, items } = listView(nodes);
    console.log(`uia-bridge: the ListView is a ${view.controlType} (${view.className}) with ${items.length} rows: ${JSON.stringify(items.map(i => [i.controlType, i.name]))}`);
    expect(items.length, `rows under the ListView in ${shown(nodes)}`).toBeGreaterThanOrEqual(2);
    for (const row of items) {
      expect(row.name, "every row has its text as its name").toBeTruthy();
      expect(row.patterns.selectionItem, `${row.name} can be selected`).toBeDefined();
    }
    const { tree, items: branches } = treeView(nodes);
    console.log(`uia-bridge: the TreeView (${tree.className}) lists ${JSON.stringify(branches.map(i => [i.name, i.patterns.expand]))}`);
    expect(branches.length, `items under the TreeView in ${shown(nodes)}`).toBeGreaterThanOrEqual(1);
    for (const item of branches) {
      expect(item.name, "every tree item has its text as its name").toBeTruthy();
      expect(item.patterns.expand, `${item.name} says whether it is open`).toBeDefined();
    }
  });

  it("selects a ListView row through SelectionItemPattern", async () => {
    const { items } = listView(nodes);
    const row = items[1];
    expect(await ui().call("perform", { handle: row.h, op: "select" })).toEqual({ ok: true });
    await waitFor(`${row.name} selected`, async () => (await ui().call<RawNode>("element", { handle: row.h })).patterns.selectionItem?.selected === true, 3000);
  });

  it("opens a TreeView branch through ExpandCollapsePattern and lists what it holds", async () => {
    const { items } = treeView(nodes);
    const branch = items.find(i => i.patterns.expand === "Collapsed") ?? items.find(i => i.patterns.expand === "Expanded");
    expect(branch, `a tree item with items of its own in ${JSON.stringify(items.map(i => [i.name, i.patterns.expand]))}`).toBeTruthy();
    const state = async () => (await ui().call<RawNode>("element", { handle: branch!.h })).patterns.expand;
    if (branch!.patterns.expand === "Expanded") {
      expect(await ui().call("perform", { handle: branch!.h, op: "collapse" })).toEqual({ ok: true });
      await waitFor(`${branch!.name} closed`, async () => await state() === "Collapsed", 3000);
    }
    expect(await ui().call("perform", { handle: branch!.h, op: "expand" })).toEqual({ ok: true });
    await waitFor(`${branch!.name} open`, async () => await state() === "Expanded", 3000);
    const kids = await ui().call<RawNode[]>("children", { handle: branch!.h });
    const leaves = kids.filter(k => k.controlType === "TreeItem");
    expect(leaves.length, `tree items under ${branch!.name}: ${shown(kids)}`).toBeGreaterThanOrEqual(1);
    expect(leaves.every(k => !!k.name)).toBe(true);
  });

  it("types into the Name box through ValuePattern, and the bench logs the text's length", async () => {
    const name = control(nodes, "Edit", "Name");
    const text = "Ember 1é";
    expect(await ui().call("perform", { handle: name.h, op: "setValue", value: text })).toEqual({ ok: true });
    await waitFor("the bench's text event", () => logged(main().log, { event: "text", control: "Name", length: text.length }));
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
    expect(logged(main().log, { event: "text", control: "Password" })).toBeUndefined();
  });

  it("clicks Save through InvokePattern", async () => {
    expect(await ui().call("perform", { handle: control(nodes, "Button", "Save").h, op: "invoke" })).toEqual({ ok: true });
    await waitFor("the bench's click event", () => logged(main().log, { event: "click", control: "Save" }));
  });

  it("toggles Remember me through TogglePattern", async () => {
    const box = control(nodes, "CheckBox", "Remember me");
    expect(await ui().call("perform", { handle: box.h, op: "toggle" })).toEqual({ ok: true });
    await waitFor("the bench's toggle event", () => logged(main().log, { event: "toggle", control: "Remember me", checked: true }));
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
    const selected = () => logged(main().log, { event: "select", control: "Theme", value: "Dark" });
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

  it("selects Banana in the Fruit list through SelectionItemPattern, and the bench is told", async () => {
    // .NET's list box proxy selects with LB_SETCURSEL alone; the bridge then sends LBN_SELCHANGE, as a click would, so
    // the app's own selection event runs.
    const fruit = control(nodes, "List", "Fruit");
    const banana = nodes.find(n => n.parent === nodes.indexOf(fruit) && n.name === "Banana");
    expect(banana, "the Banana item").toBeTruthy();
    expect(await ui().call("perform", { handle: banana!.h, op: "select" })).toEqual({ ok: true });
    await waitFor("the bench's select event for Banana", () => logged(main().log, { event: "select", control: "Fruit", value: "Banana" }), 3000)
      .catch((err: Error) => { throw new Error(`${err.message}; the list ${JSON.stringify(fruit)}; the bridge said: ${ui().stderr.slice(-1000)}`); });
    expect((await ui().call<RawNode>("element", { handle: banana!.h })).patterns.selectionItem?.selected).toBe(true);
    // For the host's choice of action, recorded rather than asserted: the list box proxy's SetFocus on an item of a
    // single-selection list selects it with LB_SETCURSEL alone, which doesn't tell the app (no LBN_SELCHANGE).
    const cherry = nodes.find(n => n.parent === nodes.indexOf(fruit) && n.name === "Cherry");
    if (cherry) {
      const focus = await ui().request("perform", { handle: cherry.h, op: "focus" });
      await sleep(300);
      const selected = (await ui().call<RawNode>("element", { handle: cherry.h })).patterns.selectionItem?.selected;
      const told = !!logged(main().log, { event: "select", control: "Fruit", value: "Cherry" });
      console.log(`uia-bridge: focus on a Fruit item: ${JSON.stringify(focus.error ?? focus.result)}, selected it: ${selected}, the app was told: ${told}`);
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
    expect(chain[0]).toMatchObject({ hwnd: main().hwnd, parent: -1, depth: 0 });
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
    expect(focused.hwnd).toBe(main().hwnd);
    expect(focused.window).toBeGreaterThan(0);
    expect(focused.element?.hasKeyboardFocus).toBe(true);
  });

  it("leaves a process in skipPids alone: its windows from Win32 facts only, nothing at a point or in focus", async () => {
    const skipPids = [main().pid];
    const { windows } = await ui().call<{ windows: UiaWindow[] }>("topWindows", { skipPids, deadlineMs: 4000 }, 10_000);
    const w = windows.find(x => x.hwnd === main().hwnd);
    expect(w, JSON.stringify(windows.map(x => [x.hwnd, x.name, x.processName]))).toMatchObject({ skipped: true, pid: main().pid, name: TITLE });
    expect(w!.processName.toLowerCase()).toBe(BENCH_PROGRAM);
    for (const field of ["h", "controlType", "patterns", "busy", "reason"] as const) expect(w, field).not.toHaveProperty(field);
    // Every other process is still read.
    expect(windows.some(x => x.pid !== main().pid && typeof x.h === "number")).toBe(true);
    // The bench is in front (the test before focused its Name box): nothing under Save's centre, nothing focused.
    const save = centre(control(nodes, "Button", "Save"));
    expect(await ui().call("elementsAt", { ...save, skipPids })).toEqual([]);
    expect(await ui().call("focused", { skipPids })).toEqual({ element: null, window: null, hwnd: main().hwnd, skipped: true });
    // The same requests without skipPids still reach it.
    expect((await ui().call<RawNode[]>("elementsAt", save)).length).toBeGreaterThanOrEqual(2);
    expect((await ui().request("topWindows", { skipPids: "me" })).error).toEqual({ code: "bad_request", message: "skipPids must be a list of process ids" });
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
      const { windows } = await ui().call<{ windows: UiaWindow[] }>("topWindows", { pid: main().pid, deadlineMs: 2000 });
      return windows.find(w => w.hwnd !== main().hwnd && (w.className === "#32770" || w.name === "Saved?"));
    });
    expect(dialog.busy, "the bench still answers while its dialog is open").toBeUndefined();
    expect(dialog.isModal ?? true).toBe(true);
    // The bench isn't hung (its dialog runs a message loop), so requests about it still work.
    expect((await ui().call<{ busyPids: number[] }>("status")).busyPids).not.toContain(main().pid);
    const inside = await ui().call<{ nodes: RawNode[] }>("snapshot", { handle: dialog.h, deadlineMs: 2000 });
    const ok = inside.nodes.find(n => n.controlType === "Button" && n.name === "OK");
    expect(ok, shown(inside.nodes)).toBeTruthy();
    expect(await ui().call("perform", { handle: ok!.h, op: "invoke", deadlineMs: 2000 })).toEqual({ ok: true });
    await waitFor("the dialog to close", async () => {
      const { windows } = await ui().call<{ windows: UiaWindow[] }>("topWindows", { pid: main().pid, deadlineMs: 2000 });
      return !windows.some(w => w.hwnd === dialog.hwnd);
    });
  });

  it("names a console window conhost, with the program running in it as its client", async () => {
    // A classic console window of its own, titled with a token to find it by (start opens it; this cmd /c then ends).
    const token = `EmberConsole-${process.pid}-${Date.now()}`;
    spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "start", `"${token}"`, "cmd.exe", "/d", "/k"], { stdio: "ignore", windowsVerbatimArguments: true });
    const w = await waitFor("the console window among the top-level windows", async () => {
      const { windows } = await ui().call<{ windows: UiaWindow[] }>("topWindows", { deadlineMs: 4000 }, 10_000);
      return windows.find(x => (x.name ?? "").includes(token));
    }, 15_000);
    consolePid = w.pid;
    console.log(`uia-bridge: the console window: ${JSON.stringify({ className: w.className, processName: w.processName, clientProgram: w.clientProgram, busy: w.busy, reason: w.reason })}`);
    // Windows Terminal as the default terminal would open it in a CASCADIA_HOSTING_WINDOW_CLASS window instead.
    expect(w.className, "a classic console window (set the default terminal to Windows Console Host if this fails)").toBe("ConsoleWindowClass");
    expect(w.processName).toBe("conhost");
    // Windows reports the console's first client as the window's process: the cmd that start ran.
    expect(w.clientProgram?.toLowerCase()).toBe("cmd");
    end(consolePid);
    await waitFor("the console window to close", async () => {
      const { windows } = await ui().call<{ windows: UiaWindow[] }>("topWindows", { deadlineMs: 4000 }, 10_000);
      return !windows.some(x => x.hwnd === w.hwnd);
    });
    consolePid = 0;
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

  it("reads and acts in the bench's 32-bit build as in its 64-bit one", async () => {
    const args = x86Args(BENCH);
    expect(args, "win_bench.ps1 takes a parameter for its /platform:x86 build (-Platform x86, -Architecture x86, -Arch x86 or -X86)").not.toBeNull();
    const rowsBefore = listView(nodes).items.map(r => r.name);
    // One bench at a time: both builds have the same title.
    stopBench(bench);
    bench = undefined;
    x86 = await startBench(path.join(dir, "bench-x86.log"), args!);
    // Otherwise this would only read the 64-bit build a second time.
    expect(logged(x86.log, { event: "ready" })?.bits, "the bench's ready line says it runs as a 32-bit process").toBe(32);
    const { w } = await listedRead(x86.hwnd);
    expect(w, "the 32-bit bench among the top-level windows").toBeTruthy();
    expect(w!.busy, `listed from Win32 facts only: ${JSON.stringify(w)}`).toBeUndefined();
    expect(w).toMatchObject({ name: TITLE, pid: x86.pid, controlType: "Window" });
    expect(w!.processName.toLowerCase()).toBe(BENCH_PROGRAM);
    const snap = await ui().call<{ nodes: RawNode[]; busy: boolean; cut: string[] }>("snapshot", { hwnd: x86.hwnd, deadlineMs: 4000 }, 10_000);
    expect(snap.busy).toBe(false);
    expect(snap.cut).toEqual([]);
    const read = snap.nodes;
    expect(control(read, "Edit", "Name").isPassword).toBe(false);
    const password = control(read, "Edit", "Password");
    expect(password.isPassword).toBe(true);
    expect(password.patterns.value ?? {}).not.toHaveProperty("value");
    const fruit = control(read, "List", "Fruit");
    expect(read.filter(n => n.parent === read.indexOf(fruit) && n.controlType === "ListItem").map(n => n.name)).toEqual(["Apple", "Banana", "Cherry"]);
    expect(listView(read).items.map(r => r.name), `rows of the 32-bit ListView in ${shown(read)}`).toEqual(rowsBefore);
    expect(treeView(read).items.length).toBeGreaterThanOrEqual(1);
    const text = "x86 é";
    expect(await ui().call("perform", { handle: control(read, "Edit", "Name").h, op: "setValue", value: text })).toEqual({ ok: true });
    await waitFor("the 32-bit bench's text event", () => logged(x86!.log, { event: "text", control: "Name", length: text.length }));
  }, 180_000); // the first 32-bit build compiles (and Defender scans it) within the test

  it("writes its exit line and ends at once with code 0 when stdin closes", async () => {
    const exit = await ui().close();
    const timings = `exit line ${exit.lineMs} ms and exit ${exit.ms} ms after stdin closed; a bridge without UI Automation calls: ${firstExit?.lineMs} ms and ${firstExit?.ms} ms`;
    console.log(`uia-bridge: ${timings}`);
    expect(exit.code).toBe(0);
    // The line says the bridge saw its input end: a late one would mean end of file reached it late.
    expect(exit.lineMs, timings).not.toBeNull();
    expect(exit.ms, timings).toBeLessThan(2000);
    // From the line to the process's end is the bridge's own exit (TerminateProcess), which takes no time to speak of.
    expect(exit.ms - exit.lineMs!, timings).toBeLessThan(1000);
    expect(ui().strayLines).toEqual([]);
    bridge = undefined;
  });
});
