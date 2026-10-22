import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AtspiSidecar, ID_BLOCK, type ActionResult, type AxNode } from "../../app/main/perception/sidecar";
import { hostLaunch } from "../../app/sidecar-host/launch";
import { benchDesktop, type FakeLogLine } from "../../app/sidecar-host/providers/fake";
import type { Logger } from "../../app/main/logger";

/**
 * The built host, run as its own process by node, driven through Ember's real client (AtspiSidecar) against the fake
 * desktop (EMBER_AX_PROVIDER=fake, which only a development tree honours): framing, the id block, the secrets handed to
 * a new process, and the bench's controls end to end, as the Windows integration test does with the real bridge.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-host-e2e-"));
const desktop = path.join(dir, "desktop.json");
const bench = benchDesktop();
// A field nothing says is secret until Ember finds it is (a key revealed beside "Show"): marked, then remembered.
bench[0].children!.push({ role: "Edit", name: "Recovery hint", value: "blue-horse", editable: true, bounds: { x: 210, y: 390, width: 200, height: 24 }, actions: ["setValue"] });
fs.writeFileSync(desktop, JSON.stringify(bench));
let script = "";

/** The host as npm run build bundles it (scripts/build-app.mjs), into .cache/test (a development tree). */
function buildHost(): string {
  const out = path.join(root, ".cache", "test", "ax-sidecar.cjs");
  const tmp = `${out}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  buildSync({ entryPoints: [path.join(root, "app/sidecar-host/main.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron", "koffi", "sharp"], outfile: tmp, logLevel: "silent" });
  fs.renameSync(tmp, out);
  return out;
}

const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log } as unknown as Logger;
const running: AtspiSidecar[] = [];
function client(logFile = path.join(dir, `bench-${running.length}.log`)) {
  const launch = hostLaunch({ execPath: process.execPath, host: script, env: { ...process.env, EMBER_AX_PROVIDER: "fake", EMBER_AX_FAKE_DESKTOP: desktop, EMBER_AX_FAKE_LOG: logFile }, platform: process.platform, packaged: false });
  const s = new AtspiSidecar("unused.py", log, "unused-python", process.env, launch);
  running.push(s);
  const lines = (): FakeLogLine[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
  return { s, lines };
}
const failure = (p: Promise<unknown>) => p.then(() => "resolved", (e: Error) => e.message);
const byName = (nodes: AxNode[], name: string) => nodes.find(n => n.name === name)!;

/** The host processes this test process started (Linux: by /proc). */
function hostPids(): number[] {
  return fs.readdirSync("/proc").filter(d => /^\d+$/.test(d)).flatMap(d => {
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      return ppid === process.pid && fs.readFileSync(`/proc/${d}/cmdline`, "utf8").includes("ax-sidecar") ? [Number(d)] : [];
    } catch {
      return []; // gone meanwhile
    }
  });
}

beforeAll(() => { script = buildHost(); });
afterAll(() => { for (const s of running.splice(0)) s.stop(); });

describe("the built sidecar host through Ember's client", () => {
  it("answers on the wire as the Python sidecar does, numbering elements from the block it was given", async () => {
    const { s } = client();
    expect(await s.status()).toMatchObject({ version: 3, toolkitAccessibility: true, apps: 1 });
    const { windows } = await s.listWindows({ ownPid: process.pid });
    expect(windows).toEqual([expect.objectContaining({ app: "powershell", name: "Ember Bench (Windows)", role: "frame", path: expect.any(String) })]);
    const r = await s.readWindow({ pid: windows[0].pid!, path: windows[0].path, ownPid: process.pid });
    expect((r.nodes[0].id - 1) % ID_BLOCK).toBe(0);
    expect(r.nodes.map(n => n.role)).toEqual(expect.arrayContaining(["entry", "password text", "check box", "combo box", "slider", "list", "push button", "label"]));
    const pw = byName(r.nodes, "Password");
    expect(pw).toMatchObject({ role: "password text", secret: true });
    expect(pw.text).toBeUndefined();
    // The client keeps the secret keys to itself.
    expect("secretKeys" in r).toBe(false);
  });

  it("does the bench's actions, and the bench sees them", async () => {
    const { s, lines } = client();
    const r = await s.readWindow({ title: "Ember Bench" });
    const id = (name: string) => byName(r.nodes, name).id;
    expect((await s.setText(id("Name"), "Ada")).after?.text).toBe("Ada");
    expect(await s.doAction(id("Save"))).toMatchObject({ ok: true, action: "click" });
    expect((await s.doAction(id("Remember me"), "toggle")).after?.states).toContain("checked");
    expect(await s.listOptions(id("Theme"))).toEqual({ options: ["Light", "Dark", "System"] });
    expect((await s.selectOption(id("Theme"), "Dark")).after?.selected).toBe("Dark");
    expect((await s.setValue(id("Volume"), 80)).after?.value).toBe(80);
    expect(await s.canDo(id("Save"), "click")).toEqual({ tier1: true, action: "click" });
    expect(await failure(s.setText(id("Password"), "hunter2"))).toBe("password fields are off limits to Ember; the user must fill them in");
    const save = byName(r.nodes, "Save").bounds!;
    const here = await s.atPoint({ pid: r.window!.pid!, path: r.window!.path!, x: save.x + 5, y: save.y + 5 });
    expect(here.chain.map(c => c.name)).toEqual(["Save"]);
    const secrets = await s.secretFields({ pid: r.window!.pid!, path: r.window!.path! });
    expect(secrets).toMatchObject({ complete: true, fields: [{ role: "password text" }] });
    expect(lines().map(l => [l.op, l.name])).toEqual([["setValue", "Name"], ["invoke", "Save"], ["toggle", "Remember me"], ["select", "Dark"], ["setRange", "Volume"]]);
  });

  it("answers at once when a button opens a modal dialog, and the dialog can be read", async () => {
    const { s } = client();
    const r = await s.readWindow({ title: "Ember Bench" });
    const t0 = Date.now();
    expect(await failure(s.doAction(byName(r.nodes, "Open dialog").id))).toMatch(/did not answer/);
    expect(Date.now() - t0).toBeLessThan(3000);
    const dialog = await s.readWindow({ title: "Saved?" });
    expect(dialog.window?.role).toBe("dialog");
    const ok: ActionResult = await s.doAction(byName(dialog.nodes, "OK").id);
    expect(ok).toMatchObject({ ok: true, after: null, gone: true });
  });

  it.skipIf(!fs.existsSync("/proc"))("hands the secrets it knew to the next process after one is killed", async () => {
    // Only this test's host left running, so the one killed is its own.
    for (const old of running.splice(0)) old.stop();
    for (let i = 0; i < 50 && hostPids().length; i++) await new Promise(res => setTimeout(res, 50));
    const { s } = client();
    const r = await s.readWindow({ title: "Ember Bench" });
    const hint = byName(r.nodes, "Recovery hint");
    expect(hint.text).toBe("blue-horse");
    await s.markSecret([hint.id]);
    const before = hostPids();
    expect(before.length).toBe(1);
    for (const pid of before) process.kill(pid, "SIGKILL");
    // Ember's client starts a new process at once (it had answered), telling it the keys first.
    let after: number[] = [];
    for (let i = 0; i < 50 && !after.length; i++) {
      await new Promise(res => setTimeout(res, 100));
      after = hostPids().filter(p => !before.includes(p));
    }
    expect(after.length).toBe(1);
    const again = await s.readWindow({ title: "Ember Bench" });
    expect(byName(again.nodes, "Recovery hint")).toMatchObject({ secret: true });
    expect(JSON.stringify(again)).not.toContain("blue-horse");
    expect(await failure(s.setText(byName(again.nodes, "Recovery hint").id, "x"))).toBe("this looks like a password or payment field; the user must fill it in");
    // An id from the killed process names nothing in this one.
    expect(await failure(s.readElement(hint.id))).toMatch(/no longer known/);
    expect(Math.floor((again.nodes[0].id - 1) / ID_BLOCK)).toBeGreaterThan(Math.floor((hint.id - 1) / ID_BLOCK));
  });

  it("answers a bad line with an error and carries on, and exits when its input closes", async () => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, EMBER_AX_PROVIDER: "fake", EMBER_AX_FAKE_DESKTOP: desktop }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.stdin.write("{not json\n");
    child.stdin.write('{"jsonrpc":"2.0","id":7,"method":"ping","params":{}}\n');
    child.stdin.end();
    const code = await new Promise<number | null>(res => child.on("exit", res));
    expect(code).toBe(0);
    const answers = out.trim().split("\n").map(l => JSON.parse(l));
    expect(answers[0]).toMatchObject({ id: null, error: { message: expect.any(String) } });
    expect(answers[1]).toEqual({ jsonrpc: "2.0", id: 7, result: { version: 3 } });
  });
});
