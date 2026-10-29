/**
 * The accessibility sidecar host end to end on macOS: the host built from source, started by hostLaunch's spawn form
 * with this Node (Ember itself forks it as a utility process, which needs Electron: ember-darwin covers that, review
 * #177), with the in-process AX provider, driven through Ember's
 * real client (AtspiSidecar) against the macOS bench (test/fixtures/mac_bench.js, an AppKit window run by osascript),
 * whose log says what each action did. It also reads the bench with the provider directly in this process, for what
 * the protocol doesn't show: every key of its 200-row list, and the window list's system prompts at rest.
 *
 * macOS only: skipped elsewhere and without the Accessibility permission, and failing instead of skipping when
 * EMBER_AX_TEST=1 and something it needs is missing (printing which processes TCC may hold responsible, so CI learns
 * which one needs the grant). In-process grants are no evidence of what Ember.app gets: the packaged doctor run
 * through LaunchServices is (design §10 item 3); this test checks the provider itself. It records the design's "verify
 * in CI" items as it goes: that JXA's target-action works on this macOS (else Save's click can't be heard, said as
 * "not testable on this runner"), and that CFHash keys agree between two host processes (else KEY_MODE must become
 * "path", R4). It also checks the ask box's read: the field that had the keyboard, and its selection, once another app
 * has it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AtspiSidecar, type AxNode, type AxWindow, type ReadWindowResult, type SidecarLaunch, type SidecarStatus } from "../../app/main/perception/sidecar";
import { hostLaunch } from "../../app/sidecar-host/launch";
import { AxDarwinProvider } from "../../app/sidecar-host/providers/ax-darwin";
import { axApiError, openAxApi } from "../../app/sidecar-host/providers/ax-darwin-api";
import { axOverlayRole } from "../../app/sidecar-host/roles";
import type { Logger } from "../../app/main/logger";
import { windowsNow } from "./darwin-support";

const BENCH = path.resolve("test/fixtures/mac_bench.js");
const OSASCRIPT = "/usr/bin/osascript";
const TITLE = "Ember Bench (macOS)";
const required = process.env.EMBER_AX_TEST === "1";
const onMac = process.platform === "darwin";
/** AXIsProcessTrusted() for this process (the host child inherits the same responsible process here). */
const trusted = onMac && !!openAxApi()?.trusted();
const available = onMac && trusted && fs.existsSync(OSASCRIPT) && fs.existsSync(BENCH);

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

/** The bench's JSON-lines log. */
function benchEvents(log: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = fs.readFileSync(log, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap(line => {
    try {
      return line.trim() ? [JSON.parse(line) as Record<string, unknown>] : [];
    } catch {
      return []; // a line still being written: the next poll reads it whole
    }
  });
}
const logged = (log: string, match: Record<string, unknown>) => benchEvents(log).find(e => Object.entries(match).every(([k, v]) => e[k] === v));

/** This process and its ancestors (the TCC "responsible process" is one of them), for the grant message. */
function ancestry(): string {
  const chain = [`${process.pid} ${process.execPath}`];
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const r = spawnSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
    const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout?.trim() ?? "");
    if (!m) break;
    chain.push(`${pid} ${m[2]}`);
    pid = Number(m[1]);
  }
  return chain.join("\n  ");
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

describe.skipIf(!available && !required)("the accessibility sidecar host on a real AppKit window (macOS AX)", { timeout: 180_000 }, () => {
  // Made when the tests run, not when they are collected (skipped ones too, on every platform).
  let dir = "";
  let log = "";
  const stderr: string[] = [];
  const note = (msg: string, fields?: Record<string, unknown>) => {
    if (msg === "sidecar.stderr" && typeof fields?.line === "string") stderr.push(fields.line);
    if (process.env.EMBER_TEST_VERBOSE) console.error(msg, fields ?? "");
  };
  const logger = { debug: note, info: note, warn: note, error: note, child: () => logger } as unknown as Logger;
  let bench: ChildProcess | undefined;
  let ready: Record<string, unknown> = {};
  let benchPid = 0;
  let windowId = 0;
  let launch: SidecarLaunch;
  let s: AtspiSidecar;
  let started: SidecarStatus;
  let win: AxWindow;
  let read: ReadWindowResult;
  /** The element called `name` with AT-SPI role `role` (a label and its control share a name). */
  const node = (name: string, role: string): AxNode => {
    const found = read.nodes.find(n => n.name === name && n.role === role);
    expect(found, `${role} "${name}" in ${JSON.stringify(read.nodes.map(n => [n.role, n.name]))}`).toBeTruthy();
    return found!;
  };
  const reread = async () => { read = await s.readWindow({ pid: benchPid, path: String(windowId), ownPid: process.pid }); };
  const second = () => new AtspiSidecar("unused.py", logger, "unused-python", process.env, { ...launch, firstRequestMs: 30_000 });

  beforeAll(async () => {
    // Required runs (EMBER_AX_TEST=1) fail here, naming what is missing, instead of skipping.
    expect(process.platform, "the sidecar host's AX provider runs only on macOS").toBe("darwin");
    expect(openAxApi(), `the AX API binds (${String(axApiError)})`).not.toBeNull();
    console.log(`ax-sidecar-darwin: AXIsProcessTrusted() = ${trusted} for\n  ${ancestry()}`);
    expect(trusted, `Accessibility must be granted to the process TCC holds responsible for this test, one of:\n  ${ancestry()}`).toBe(true);
    expect(fs.existsSync(OSASCRIPT), OSASCRIPT).toBe(true);
    expect(fs.existsSync(BENCH), "the macOS bench, test/fixtures/mac_bench.js").toBe(true);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-ax-host-"));
    log = path.join(dir, "bench.jsonl");
    const host = buildHost();
    bench = spawn(OSASCRIPT, ["-l", "JavaScript", BENCH, log, "900"], { stdio: ["ignore", "ignore", "pipe"] });
    let benchErr = "";
    bench.stderr?.on("data", (d: Buffer) => { benchErr += d.toString(); });
    ready = await waitFor("the bench's ready line", () => logged(log, { event: "ready" }), 60_000).catch(err => {
      throw new Error(`${(err as Error).message}; the bench said: ${JSON.stringify(benchEvents(log))} ${benchErr.slice(0, 2000)}`);
    });
    benchPid = Number(ready.pid);
    windowId = Number(ready.window);
    console.log(`ax-sidecar-darwin: bench ready ${JSON.stringify(ready)}`);
    // Ember's own process is this one: the host never asks it anything (EMBER_OWNER_PID).
    const base = hostLaunch({ execPath: process.execPath, host, env: process.env, platform: "darwin", packaged: false });
    launch = { ...base, env: { ...base.env, EMBER_OWNER_PID: String(process.pid) } };
    s = new AtspiSidecar("unused.py", logger, "unused-python", process.env, { ...launch, firstRequestMs: 30_000 });
    started = await s.status();
    console.log(`ax-sidecar-darwin: status from inside the host ${JSON.stringify(started)}`);
    expect(started.toolkitAccessibility, `the host's AX provider says: ${started.detail ?? "(nothing)"}`).toBe(true);
  }, 180_000);

  afterAll(async () => {
    s?.stop();
    if (bench && bench.exitCode === null) bench.kill();
    await sleep(300);
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("says in status that the AX provider is up with the Accessibility permission", () => {
    expect(started).toMatchObject({ version: 3, toolkitAccessibility: true });
    expect(started.python).toMatch(/\(ax\)$/);
    expect(started.apps).toBeGreaterThan(0);
    expect(started.detail).toBeUndefined();
  });

  it("lists the bench's window by its process (osascript), its pid and its CGWindowID", async () => {
    const { windows } = await s.listWindows({ ownPid: process.pid });
    win = windows.find(w => w.name === TITLE)!;
    expect(win, JSON.stringify(windows.map(w => [w.app, w.pid, w.path, w.name]))).toBeTruthy();
    expect(win).toMatchObject({ app: "osascript", pid: benchPid, path: String(windowId), role: "frame" });
    expect(win.path).toMatch(/^\d+$/);
    const frame = ready.frame as { x: number; y: number; width: number; height: number };
    for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(win.bounds![k] - frame[k]), `bounds.${k}`).toBeLessThanOrEqual(2);
  });

  it("reads its controls with AT-SPI roles, each told from the label of the same name, and never the password", async () => {
    await reread();
    console.log(`ax-sidecar-darwin: read ${JSON.stringify(read.nodes.map(n => [n.role, n.name]))}`);
    expect(read.window!.name).toBe(TITLE);
    expect(read.nodes[0]).toMatchObject({ depth: 0, parent: null, role: "frame" });
    for (const label of ["Name", "Password", "Theme", "Volume", "Notes", "Rows"]) expect(node(label, "label").bounds).toBeTruthy();
    const pw = node("Password", "password text");
    expect(pw.secret).toBe(true);
    expect(pw.text).toBeUndefined();
    expect(node("Name", "entry").states).toEqual(expect.arrayContaining(["editable", "enabled", "sensitive"]));
    expect(node("Remember me", "check box").states).not.toContain("checked");
    expect(node("Theme", "combo box").selected).toBe("Light");
    expect(node("Volume", "slider").value).toBe(50);
    expect(node("Notes", "text")).toMatchObject({ text: "First line\nSecond line", states: expect.arrayContaining(["multi line"]) });
    expect(node("Save", "push button").actions).toContain("click");
    expect(node("Rows", "table")).toBeTruthy();
    // (Not the title bar's buttons: a window that can't be resized has its zoom button disabled.)
    for (const [name, role] of [["Name", "entry"], ["Password", "password text"], ["Remember me", "check box"], ["Theme", "combo box"],
      ["Volume", "slider"], ["Notes", "text"], ["Save", "push button"]]) {
      const n = node(name!, role!);
      expect(n.states.includes("enabled") && n.states.includes("sensitive"), `${n.role} "${n.name}" says enabled`).toBe(true);
    }
    expect(JSON.stringify(read)).not.toMatch(/"(button|search|search box)"/);
  });

  it("sets the Name field's text, and the bench sees it", async () => {
    const r = await s.setText(node("Name", "entry").id, "Ember 1");
    expect(r.ok).toBe(true);
    expect(r.after?.text).toBe("Ember 1");
    await waitFor("the bench's text event", () => logged(log, { event: "text", control: "Name", length: 7 }));
  });

  it("refuses the password field, whatever is asked", async () => {
    await expect(s.setText(node("Password", "password text").id, "hunter2")).rejects.toThrow("password fields are off limits to Ember; the user must fill them in");
    await sleep(300);
    expect(logged(log, { event: "text", control: "Password" })).toBeUndefined();
  });

  it("clicks Save by its own action (AXPress), and the bench hears it where JXA's target-action works", async () => {
    expect(await s.canDo(node("Save", "push button").id, "click")).toMatchObject({ tier1: true, action: "click" });
    const r = await s.doAction(node("Save", "push button").id, "click");
    expect(r).toMatchObject({ ok: true, action: "click" });
    if (ready.actions === true) await waitFor("the bench's click", () => logged(log, { event: "click", control: "Save" }));
    else console.warn("ax-sidecar-darwin: not testable on this runner: JXA's ObjC.registerSubclass target-action (the bench can't hear Save)");
  });

  it("toggles Remember me, and reads it turned on", async () => {
    const id = node("Remember me", "check box").id;
    expect((await s.doAction(id, "toggle")).ok).toBe(true);
    await waitFor("Remember me checked", async () => (await s.readElement(id)).states.includes("checked"), 3000);
    await waitFor("the bench's toggle", () => logged(log, { event: "toggle", control: "Remember me", checked: true }));
  });

  it("sets the Volume slider within its range only, and the bench sees the new value", async () => {
    const id = node("Volume", "slider").id;
    await expect(s.setValue(id, 150)).rejects.toThrow("value 150.0 is outside 0.0..100.0");
    const r = await s.setValue(id, 70);
    expect(r).toMatchObject({ ok: true, after: { role: "slider", value: 70 } });
    await waitFor("the bench's value", () => logged(log, { event: "value", control: "Volume", value: 70 }));
  });

  it("tells what is at Save's centre, with the bounds a read gives", async () => {
    const save = node("Save", "push button");
    const b = save.bounds!;
    const here = await s.atPoint({ pid: benchPid, path: String(windowId), x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), ownPid: process.pid });
    expect(here.busy).toBeUndefined();
    expect(here.chain[here.chain.length - 1]).toMatchObject({ role: "push button", name: "Save", bounds: save.bounds });
  });

  it("finds every secret field for a screenshot's masks", async () => {
    const found = await s.secretFields({ pid: benchPid, path: String(windowId) });
    expect(found.complete).toBe(true);
    expect(found.fields).toEqual([expect.objectContaining({ role: "password text", bounds: node("Password", "password text").bounds })]);
  });

  it("lists the 200 rows' names through the host", async () => {
    const { options, left } = await s.listOptions(node("Rows", "table").id);
    console.log(`ax-sidecar-darwin: list_options gave ${options.length} rows named in time, ${left ?? 0} left`);
    expect(options.length + (left ?? 0)).toBe(200);
    expect(options[0]).toBe("Row 1");
  });

  it("gives the password field the same key from a second host process (CFHash agrees across processes, R4)", async () => {
    const params = { pid: benchPid, path: String(windowId), ownPid: process.pid };
    const first = await s.request<{ secretKeys?: [string, string][] }>("read_window", params);
    const other = second();
    try {
      await waitFor("the second host", async () => (await other.status().catch(() => null))?.toolkitAccessibility === true, 30_000);
      const again = await other.request<{ secretKeys?: [string, string][] }>("read_window", params);
      console.log(`ax-sidecar-darwin: secret keys ${JSON.stringify(first.secretKeys)} and ${JSON.stringify(again.secretKeys)}`);
      expect(first.secretKeys).toHaveLength(1);
      expect(first.secretKeys![0]![1], "the key is the exact CFHash").toMatch(/^\d+:h[0-9a-f]+$/);
      expect(again.secretKeys, "CFHash differs between host processes: KEY_MODE must become \"path\" (design R4)").toEqual(first.secretKeys);
    } finally {
      other.stop();
    }
  });

  it("reads the 200-row list by range with no two keys alike, and logs no key collision", async () => {
    const notes: string[] = [];
    const details: unknown[] = [];
    const p = new AxDarwinProvider({ open: openAxApi, openError: () => axApiError, owner: process.pid, note: (e, f) => { notes.push(e); details.push({ e, ...f }); } });
    try {
      await p.start();
      const w = (await p.topWindows()).find(x => x.key === String(windowId));
      expect(w, "the bench's window in the provider's list").toBeTruthy();
      const snap = await p.snapshot(w!.handle, { maxDepth: 64, maxNodes: 1600, deadlineMs: 3000 });
      expect(new Set(snap.nodes.map(n => n.key)).size).toBe(snap.nodes.length);
      const table = snap.nodes.find(n => n.platformRole === "AXTable");
      expect(table, JSON.stringify(snap.nodes.map(n => n.platformRole))).toBeTruthy();
      const rows = (await p.children(table!.handle, 1000)).filter(n => n.platformRole === "AXRow");
      console.log(`ax-sidecar-darwin: ${rows.length} rows, ${new Set(rows.map(r => r.key)).size} keys, notes ${JSON.stringify(details)}`);
      expect(rows).toHaveLength(200);
      expect(new Set(rows.map(r => r.key)).size).toBe(200);
      expect(notes).not.toContain("ax.key_collision");
      // Evidence for shell_overlays: what the window list holds of the system's prompts at rest (nothing, normally).
      const overlays = (await p.topWindows()).filter(x => axOverlayRole(x));
      console.log(`ax-sidecar-darwin: system overlays at rest ${JSON.stringify(overlays.map(o => [o.app, o.key, axOverlayRole(o)]))}`);
    } finally {
      p.stop();
    }
  });

  it("reports nothing over the desktop at rest, and Mission Control as an overview while it is up", async () => {
    const dockWindows = () => JSON.stringify(windowsNow().filter(e => e.owner === "Dock").map(e => ({ id: e.id, title: e.title, layer: e.layer, alpha: e.alpha, ...e.bounds })));
    // Which windows the Dock has, by id and level (the strip's own size changes with the apps in it).
    const dockKey = () => windowsNow().filter(e => e.owner === "Dock").map(e => `${e.id}/${e.layer}`).join(",");
    const rest = dockKey();
    console.log(`ax-sidecar-darwin: the Dock's windows at rest ${dockWindows()}`);
    expect((await s.shellOverlays()).overlays).toEqual([]);
    const mc = "/System/Applications/Mission Control.app";
    if (!fs.existsSync(mc)) {
      console.log(`ax-sidecar-darwin: not testable on this runner: Mission Control (no ${mc})`);
      return;
    }
    spawnSync("/usr/bin/open", ["-a", mc]);
    let opened = false;
    try {
      // Up: the Dock's windows change; told apart: shell_overlays says overview.
      opened = await waitFor("Mission Control to open", () => dockKey() !== rest, 8_000).then(() => true, () => false);
      const told = opened && await waitFor("Mission Control as an overview in shell_overlays", async () => (await s.shellOverlays()).overlays.some(o => o.role === "overview"), 5_000).then(() => true, () => false);
      console.log(`ax-sidecar-darwin: Mission Control asked for (opened: ${opened}); the Dock's windows ${dockWindows()}; shell_overlays ${JSON.stringify(await s.shellOverlays())}`);
      if (!opened) console.log("ax-sidecar-darwin: not testable on this runner: Mission Control didn't open (the Dock's windows didn't change)");
      else expect(told, "Mission Control told apart from the Dock at rest (else: dialogs only, design §5.3's fallback)").toBe(true);
    } finally {
      // The same app again closes it; else Escape, as the user would (a Mission Control left up covers every later test).
      if (opened || dockKey() !== rest) {
        spawnSync("/usr/bin/open", ["-a", mc]);
        const closed = () => waitFor("Mission Control to close", () => dockKey() === rest, 8_000).then(() => true, () => false);
        if (!(await closed())) {
          spawnSync("/usr/bin/osascript", ["-e", 'tell application "System Events" to key code 53'], { timeout: 10_000 });
          if (!(await closed())) console.log(`ax-sidecar-darwin: Mission Control may still be up: ${dockWindows()}`);
        }
      }
    }
  });

  it("never reads Ember's own process (EMBER_OWNER_PID), though its windows are listed", async () => {
    // A host that takes the bench for Ember: it lists the bench's window but finds, reads and hit-tests nothing in it.
    const owner = new AtspiSidecar("unused.py", logger, "unused-python", process.env, { ...launch, env: { ...launch.env, EMBER_OWNER_PID: String(benchPid) }, firstRequestMs: 30_000 });
    try {
      const { windows } = await owner.listWindows({});
      expect(windows.some(w => w.pid === benchPid && w.path === String(windowId)), JSON.stringify(windows.map(w => [w.app, w.pid, w.path]))).toBe(true);
      expect(await owner.readWindow({ pid: benchPid, path: String(windowId) })).toMatchObject({ window: null, nodes: [] });
      expect(await owner.readWindow({ title: TITLE })).toMatchObject({ window: null, nodes: [] });
      const b = node("Save", "push button").bounds!;
      expect(await owner.atPoint({ pid: benchPid, path: String(windowId), x: b.x + 5, y: b.y + 5 })).toMatchObject({ chain: [], found: false });
      expect(await owner.secretFields({ pid: benchPid, path: String(windowId) })).toMatchObject({ fields: [], complete: false });
    } finally {
      owner.stop();
    }
  });

  it("tells the ask box's read which field had the keyboard once another app has it, and reads its selection (cross-review P1)", async () => {
    // The ask box shows before the screen is read, and its panel takes the keyboard: the read of the user's window is
    // told that something had it there (focusBefore {}), and the host asks the app which element (its
    // AXFocusedUIElement). Here the Name field has the keyboard with its text selected, and Finder takes it, as the box
    // would.
    const api = openAxApi();
    const app = api?.app(benchPid) ?? null;
    expect(app, `the bench's app element (${String(axApiError)})`).toBeTruthy();
    const frontmost = () => api!.attr(app!, "AXFrontmost") === true;
    if (!frontmost()) api!.set(app!, "AXFrontmost", true);
    await waitFor("the bench in front", frontmost, 5_000);
    await reread();
    await s.request("focus", { id: node("Name", "entry").id });
    // A text field that takes the keyboard selects all of its text.
    const had = await waitFor("the Name field with the keyboard and its text selected", async () => {
      await reread();
      const n = node("Name", "entry");
      return n.states.includes("focused") && n.selection ? n : null;
    }, 5_000);
    console.log(`ax-sidecar-darwin: the Name field has the keyboard, with ${JSON.stringify(had.selection)} selected`);
    spawnSync("/usr/bin/open", ["-a", "Finder"]);
    await waitFor("another app in front", () => !frontmost(), 10_000);
    await reread();
    console.log(`ax-sidecar-darwin: with Finder in front, the bench's own read says focused: ${JSON.stringify(read.nodes.filter(n => n.states.includes("focused")).map(n => [n.role, n.name]))}`);
    read = await s.readWindow({ pid: benchPid, path: String(windowId), ownPid: process.pid, focusBefore: {} });
    expect(node("Name", "entry"), "the Name field, in the read told something had the keyboard").toMatchObject({ states: expect.arrayContaining(["focused"]), selection: had.selection });
  });

  it("writes only protocol lines on stdout and notes, never screen text, on stderr", () => {
    expect(stderr.join("\n")).not.toMatch(/Ember 1|hunter2|First line/);
  });
});
