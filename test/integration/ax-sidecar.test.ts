/**
 * The accessibility sidecar host end to end on Windows: the host built from source, started as Ember will start it
 * (hostLaunch: its own binary as plain Node, the UI Automation bridge's script and cache in its environment) and driven
 * through Ember's real client (AtspiSidecar) against the shared WinForms bench (test/fixtures/win_bench.ps1), whose log
 * says what each action did. Windows only: skipped elsewhere, and failing instead of skipping when EMBER_UIA_TEST=1
 * and something it needs is missing. On macOS it is skipped, saying why, until the macOS AX provider exists.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AtspiSidecar, type AxNode, type AxWindow, type ReadWindowResult } from "../../app/main/perception/sidecar";
import { hostLaunch } from "../../app/sidecar-host/launch";
import { bridgeEnv, powershellPath } from "../../app/sidecar-host/providers/uia";
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

/** The host as npm run build bundles it, into .cache/test (a development tree). */
function buildHost(): string {
  const out = path.resolve(".cache", "test", "ax-sidecar.cjs");
  const tmp = `${out}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  buildSync({ entryPoints: [path.resolve("app/sidecar-host/main.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron", "koffi", "sharp"], outfile: tmp, logLevel: "silent" });
  fs.renameSync(tmp, out);
  return out;
}

describe.skipIf(process.platform !== "darwin")("the accessibility sidecar host on macOS", () => {
  it.skip("is skipped until the macOS AX provider exists (the host answers \"unsupported\" there meanwhile)", () => undefined);
});

describe.skipIf(process.platform === "darwin" || (!available && !required))("the accessibility sidecar host on a real WinForms window", { timeout: 180_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-host-"));
  const cache = path.join(dir, "uia-cache");
  const log = path.join(dir, "bench.log");
  const note = (msg: string, fields?: Record<string, unknown>) => { if (process.env.EMBER_TEST_VERBOSE) console.error(msg, fields ?? ""); };
  const logger = { debug: note, info: note, warn: note, error: note, child: () => logger } as unknown as Logger;
  let bench: ChildProcess | undefined;
  let benchPid = 0;
  let benchHwnd = 0;
  let s: AtspiSidecar;
  let win: AxWindow;
  let read: ReadWindowResult;
  const node = (name: string, role?: string): AxNode => {
    const found = read.nodes.find(n => n.name === name && (!role || n.role === role));
    expect(found, `"${name}" in ${JSON.stringify(read.nodes.map(n => [n.role, n.name]))}`).toBeTruthy();
    return found!;
  };
  const reread = async () => { read = await s.readWindow({ pid: win.pid!, path: win.path, ownPid: process.pid }); };
  /** The Name text box (its label beside it is called "Name" too). */
  const nameField = () => node("Name", read.nodes.find(n => n.name === "Name" && n.role === "text") ? "text" : "entry");
  const CONTROLS = ["Name", "Password", "Remember me", "Theme", "Volume", "Fruit", "Save", "Open dialog"];

  beforeAll(async () => {
    // Required runs (EMBER_UIA_TEST=1) fail here, naming what is missing, instead of skipping.
    expect(process.platform, "the sidecar host's Windows provider runs only on Windows").toBe("win32");
    expect(fs.existsSync(POWERSHELL), `Windows PowerShell 5.1 at ${POWERSHELL}`).toBe(true);
    expect(fs.existsSync(SCRIPT), "the UI Automation bridge, sidecar/uia/ember_uia.ps1").toBe(true);
    expect(fs.existsSync(BENCH), "the shared WinForms bench, test/fixtures/win_bench.ps1").toBe(true);
    const host = buildHost();
    // Not windowsHide: that hides the first window the process shows, which would be the bench itself.
    bench = spawn(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Sta", "-File", BENCH, "-Log", log, "-Seconds", "900"], { stdio: "ignore", env: bridgeEnv(process.env) });
    const ready = await waitFor("the bench's ready line", () => logged(log, { event: "ready" }), 60_000);
    benchPid = Number(ready.pid);
    benchHwnd = Number(ready.hwnd);
    const launch = hostLaunch({ execPath: process.execPath, host, uiaScript: SCRIPT, uiaCache: cache, env: process.env, platform: "win32", packaged: false });
    // The bridge's first start compiles it (with Defender scanning the result): CI machines can take a while.
    s = new AtspiSidecar("unused.py", logger, "unused-python", process.env, { ...launch, firstRequestMs: 90_000 });
    await waitFor("the host and its bridge to start", () => s.status().then(st => st.version === 3, () => false), 120_000);
  }, 180_000);

  afterAll(async () => {
    s?.stop();
    if (bench && bench.exitCode === null) bench.kill();
    await sleep(500);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("lists the bench's window by its program, its pid and its HWND", async () => {
    const { windows } = await s.listWindows({ ownPid: process.pid });
    win = windows.find(w => w.name === TITLE)!;
    expect(win, JSON.stringify(windows.map(w => [w.app, w.name]))).toBeTruthy();
    expect(win).toMatchObject({ app: "powershell", pid: benchPid, path: String(benchHwnd), role: "frame" });
    expect(win.bounds!.width).toBeGreaterThan(100);
  });

  it("reads its controls with AT-SPI roles, and never the password", async () => {
    await reread();
    expect(read.window!.name).toBe(TITLE);
    expect(read.nodes[0]).toMatchObject({ depth: 0, parent: null, role: "frame" });
    expect(["entry", "text"]).toContain(nameField().role);
    expect(node("Name", "label").bounds).toBeTruthy();
    const pw = node("Password", "password text");
    expect(pw.secret).toBe(true);
    expect(pw.text).toBeUndefined();
    expect(node("Remember me").role).toBe("check box");
    expect(node("Theme").role).toBe("combo box");
    expect(node("Volume").role).toBe("slider");
    expect(node("Fruit").role).toBe("list");
    expect(node("Save").role).toBe("push button");
    expect(node("Open dialog").role).toBe("push button");
    for (const n of read.nodes.filter(x => CONTROLS.includes(x.name) && x.role !== "label")) {
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
    expect(await s.canDo(node("Save").id, "click")).toMatchObject({ tier1: true, action: "click" });
    const r = await s.doAction(node("Save").id, "click");
    expect(r).toMatchObject({ ok: true, action: "click" });
    await waitFor("the bench's click", () => logged(log, { event: "click", control: "Save" }));
  });

  it("toggles Remember me, and reads it turned on", async () => {
    const id = node("Remember me").id;
    const r = await s.doAction(id, "toggle");
    expect(r.ok).toBe(true);
    await waitFor("Remember me checked", async () => (await s.readElement(id)).states.includes("checked"), 2000);
    await waitFor("the bench's toggle", () => logged(log, { event: "toggle", control: "Remember me", checked: true }));
  });

  it("chooses Dark in the Theme drop-down without opening it", async () => {
    const id = node("Theme").id;
    expect((await s.listOptions(id)).options).toEqual(expect.arrayContaining(["Light", "Dark", "System"]));
    const r = await s.selectOption(id, "Dark");
    expect(r).toMatchObject({ ok: true, option: "Dark" });
    await waitFor("the bench's select", () => logged(log, { event: "select", control: "Theme", value: "Dark" }));
    expect((await s.readElement(id)).selected).toBe("Dark");
  });

  it("sets the Volume slider within its range only", async () => {
    const id = node("Volume").id;
    await expect(s.setValue(id, 150)).rejects.toThrow(/is outside/);
    expect((await s.setValue(id, 70)).ok).toBe(true);
    await waitFor("the bench's value", () => logged(log, { event: "value", control: "Volume", value: 70 }));
  });

  it("selects a Fruit as a click selects it (never opening it), or leaves it to the mouse when the bench isn't in front", async () => {
    const banana = read.nodes.find(n => n.name === "Banana");
    expect(banana, "the Fruit list's items").toBeTruthy();
    const r = await s.doAction(banana!.id, "click").catch((e: Error) => e);
    if (r instanceof Error) expect(r.message).toMatch(/^background_unavailable: its window isn't the active one/);
    else {
      expect(r).toMatchObject({ ok: true, action: "select item" });
      await waitFor("the bench's select", () => logged(log, { event: "select", control: "Fruit", value: "Banana" }));
    }
  });

  it("tells what is at Save's centre, with the bounds a read gives", async () => {
    const save = node("Save");
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

  it("answers at once when a click opens a modal dialog, and the dialog can be read and answered", async () => {
    const t0 = Date.now();
    const r = await s.doAction(node("Open dialog").id, "click").then(x => x, (e: Error) => e);
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
});
