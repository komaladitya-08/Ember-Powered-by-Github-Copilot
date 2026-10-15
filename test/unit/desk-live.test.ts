/**
 * A real desk (Xvfb, xauth, dbus-daemon): what its apps get in their
 * environment, that a dying display or helper can't take Ember with it, that
 * stale displays are reused, that a failed start leaves nothing behind and
 * that desks left by a killed Ember are cleared away. Skipped where the desk
 * can't run.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeskManager, deskProcesses, reapDesks, removeTree, running, xAccepts } from "../../app/main/desk/desk";
import { openDeskPlace } from "../../app/main/desk/place";
import { deskAgentScript } from "./desk-agent-build";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const libX11 = (() => { try { return fs.existsSync("/usr/lib64/libX11.so.6") || fs.existsSync("/usr/lib/x86_64-linux-gnu/libX11.so.6"); } catch { return false; } })();
const available = DeskManager.available().ok && libX11 && process.platform === "linux";
const until = async (cond: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 25)); return cond(); };
const environ = (pid: number) => { try { return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"); } catch { return []; } };

describe("removeTree", () => {
  it("removes a desk folder but never reaches into a mount inside it, and never throws", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-tree-"));
    const mount = path.join(dir, "runtime", "gvfs");
    fs.mkdirSync(path.join(mount, "share"), { recursive: true });
    fs.writeFileSync(path.join(mount, "share", "users-file.txt"), "keep me");
    fs.writeFileSync(path.join(dir, "Xauthority"), "cookie");
    fs.writeFileSync(path.join(dir, "owner.json"), "{}");
    // A read-only folder of Ember's own (LibreOffice's macros on the desk) goes too.
    fs.mkdirSync(path.join(dir, "runtime", "libreoffice", "basic"), { recursive: true });
    fs.writeFileSync(path.join(dir, "runtime", "libreoffice", "basic", "Module1.xba"), "x", { mode: 0o400 });
    fs.chmodSync(path.join(dir, "runtime", "libreoffice", "basic"), 0o500);
    const unmounted: string[] = [];
    // A mount that can't be let go: left alone, the rest goes.
    expect(removeTree(dir, { mounts: () => [mount], unmount: p => { unmounted.push(p); throw new Error("busy"); }, keep: ["owner.json"] })).toBe(false);
    expect(unmounted).toEqual([mount]);
    expect(fs.readFileSync(path.join(mount, "share", "users-file.txt"), "utf8")).toBe("keep me");
    expect(fs.existsSync(path.join(dir, "Xauthority"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "runtime", "libreoffice"))).toBe(false);
    // Once it is let go, everything goes; `keep` leaves the owner record (and so the folder).
    let mounted = [mount];
    expect(removeTree(dir, { mounts: () => mounted, unmount: () => { mounted = []; }, keep: ["owner.json"] })).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["owner.json"]);
    expect(removeTree(dir, { mounts: () => [] })).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(removeTree(dir)).toBe(true); // already gone
  });
});

describe("reapDesks", () => {
  it("clears away desks whose Ember is gone, by their mark, and leaves a running Ember's desks alone", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-reap-"));
    const gone = spawnSync("true").pid!; // a process that has exited: its id names no Ember
    const mk = (id: string, owner: object) => { fs.mkdirSync(path.join(tmp, id)); fs.writeFileSync(path.join(tmp, id, "owner.json"), JSON.stringify(owner)); };
    mk("ember-desk-dead01", { pid: gone, start: 1, id: "ember-desk-dead01", groups: [] });
    mk("ember-desk-live01", { pid: process.pid, start: Number(fs.readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")[19]), id: "ember-desk-live01", groups: [] });
    fs.mkdirSync(path.join(tmp, "ember-desk-other")); // no owner record: not a desk folder
    // Processes of the dead Ember's desk, one of them having left its process group (setsid).
    const env = { ...process.env, EMBER_DESK_ID: "ember-desk-dead01" };
    const a = spawn("sleep", ["300"], { env, detached: true, stdio: "ignore" });
    const b = spawn("setsid", ["sleep", "301"], { env, detached: true, stdio: "ignore" });
    const live = spawn("sleep", ["302"], { env: { ...process.env, EMBER_DESK_ID: "ember-desk-live01" }, detached: true, stdio: "ignore" });
    try {
      expect(await until(() => deskProcesses("ember-desk-dead01").length === 2)).toBe(true);
      expect(await reapDesks(quiet, tmp)).toBe(2);
      expect(running(a.pid)).toBe(false);
      expect(deskProcesses("ember-desk-dead01")).toEqual([]);
      expect(fs.readdirSync(tmp).sort()).toEqual(["ember-desk-live01", "ember-desk-other"]);
      expect(running(live.pid)).toBe(true);
    } finally {
      for (const p of [a, b, live]) try { process.kill(p.pid!, "SIGKILL"); } catch { /* gone */ }
      for (const pid of deskProcesses("ember-desk-dead01")) process.kill(pid, "SIGKILL");
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!available)("a real desk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-desk-live-"));
  const desks: DeskManager[] = [];
  let agent = "";
  beforeAll(() => { agent = deskAgentScript(); });
  const make = (o: ConstructorParameters<typeof DeskManager>[1] = {}) => {
    const d = new DeskManager(quiet, { handOff: path.join(dir, "Ember"), display: 241, width: 320, height: 200, agent, ...o });
    desks.push(d);
    return d;
  };
  const place = (desk: DeskManager, profiles: string) => openDeskPlace(desk, { sidecarScript: "/nonexistent.py", log: quiet, neverLook: () => [], profiles: path.join(dir, profiles) });
  afterAll(() => {
    for (const d of desks) d.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives its apps no sign-in, keys or agents, folders of their own, accessibility and the desk's mark", async () => {
    const saved = { GH_TOKEN: process.env.GH_TOKEN, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, EMBER_PROVIDER_API_KEY: process.env.EMBER_PROVIDER_API_KEY };
    Object.assign(process.env, { GH_TOKEN: "gho_test", SSH_AUTH_SOCK: "/tmp/agent", EMBER_PROVIDER_API_KEY: "sk-test" });
    const desk = make({ profiles: path.join(dir, "profiles"), env: { EMBER_BENCH_LOG: "/tmp/bench.jsonl" } });
    try {
      const info = await desk.start();
      expect(Number(info.display.slice(1))).toBeGreaterThanOrEqual(241);
      const out = path.join(dir, "env.txt");
      const child = desk.run(["sh", "-c", `env > ${out}`]);
      await new Promise(r => child.once("exit", r));
      const env = Object.fromEntries(fs.readFileSync(out, "utf8").trim().split("\n").map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.SSH_AUTH_SOCK).toBeUndefined();
      expect(env.EMBER_PROVIDER_API_KEY).toBeUndefined();
      expect(env.DISPLAY).toBe(info.display);
      expect(env.DBUS_SESSION_BUS_ADDRESS).toMatch(/^unix:/);
      expect(env.XDG_CONFIG_HOME).toBe(path.join(dir, "profiles", "xdg", "config"));
      expect(env.XDG_DATA_HOME).toBe(path.join(dir, "profiles", "xdg", "data"));
      expect(env.EMBER_BENCH_LOG).toBe("/tmp/bench.jsonl"); // passed on purpose (tests)
      expect(env.HOME).toBe(os.homedir());
      expect(env.EMBER_DESK_ID).toMatch(/^ember-desk-/);
      // The bus has accessibility on too: the services it starts for apps get it.
      const bus = deskProcesses(env.EMBER_DESK_ID).find(p => fs.readFileSync(`/proc/${p}/comm`, "utf8").trim() === "dbus-daemon")!;
      expect(environ(bus)).toEqual(expect.arrayContaining(["GNOME_ACCESSIBILITY=1", "QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1", `EMBER_DESK_ID=${env.EMBER_DESK_ID}`]));
      expect(environ(bus).some(v => v.startsWith("GH_TOKEN="))).toBe(false);
      // Ember's desk helper gets only what it needs.
      const helper = environ(desk.agent!.pid);
      expect(helper).toEqual(expect.arrayContaining([`DISPLAY=${info.display}`, `XAUTHORITY=${info.env.XAUTHORITY}`]));
      expect(helper.some(v => /^(GH_TOKEN|SSH_AUTH_SOCK|EMBER_PROVIDER_API_KEY)=/.test(v))).toBe(false);
      // The cookie never appears on a command line.
      const cookie = spawnSync("xauth", ["-f", info.env.XAUTHORITY!, "list"], { encoding: "utf8" }).stdout.trim().split(/\s+/).at(-1)!;
      expect(cookie).toMatch(/^[0-9a-f]{32}$/);
      const cmdlines = fs.readdirSync("/proc").filter(p => /^\d+$/.test(p)).map(p => { try { return fs.readFileSync(`/proc/${p}/cmdline`, "utf8"); } catch { return ""; } });
      expect(cmdlines.some(c => c.includes(cookie))).toBe(false);
      // Only that cookie opens the display.
      expect(await xAccepts(Number(info.display.slice(1)), Buffer.from(cookie, "hex"))).toBe(true);
      expect(await xAccepts(Number(info.display.slice(1)), Buffer.alloc(16))).toBe(false);
    } finally {
      desk.stop();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it("survives its display dying in the middle of input: Ember makes no X call there, its helper does", async () => {
    const desk = make();
    const p = await place(desk, "profiles2");
    const info = desk.running!;
    expect(p.x11.capture(0, 0, 10, 10)?.width).toBe(10);
    expect(Buffer.isBuffer(p.x11.capture(0, 0, 10, 10)?.bgra)).toBe(true);
    let told = 0, placeTold = 0;
    desk.onDead(() => { told++; });
    p.onDead(() => { placeTold++; });
    const lock = `/tmp/.X${info.display.slice(1)}-lock`;
    const pid = Number(fs.readFileSync(lock, "utf8").trim());
    setTimeout(() => process.kill(pid, "SIGKILL"), 50);
    // Input as fast as it goes while the server dies: in Ember's own process, Xlib would have ended it.
    let error: unknown = null;
    for (const t0 = Date.now(); Date.now() - t0 < 3000 && !error; await new Promise(r => setImmediate(r))) {
      try { for (let i = 0; i < 20; i++) { p.input.move(i, i); p.input.keysDown(); } } catch (err) { error = err; }
    }
    expect(String(error)).toMatch(/desk has stopped/);
    expect(() => p.x11.capture(0, 0, 10, 10)).toThrow(/desk has stopped/);
    expect(await until(() => told === 1)).toBe(true);
    expect(placeTold).toBe(1);
    expect(p.dead).toBe(true);
    expect(desk.running).toBeNull();
    expect(() => desk.run(["true"])).toThrow(/isn't running/);
    p.close();
    // SIGKILL left its lock behind: the number is free again.
    const again = await desk.start();
    expect(again.display).toBe(info.display);
    desk.stop();
  });

  it("counts the desk as dead when its helper dies, and starts a new one next time", async () => {
    const desk = make({ display: 244 });
    const p = await place(desk, "profiles3");
    let why = "";
    desk.onDead(w => { why = w; });
    process.kill(desk.agent!.pid, "SIGKILL");
    expect(await until(() => !!why)).toBe(true);
    expect(why).toMatch(/helper exited/);
    expect(p.dead).toBe(true);
    expect(() => p.input.pointer()).toThrow(/desk has stopped/);
    const p2 = await place(desk, "profiles3");
    expect(p2.input.screenSize()).toEqual({ width: 320, height: 200 });
    // The mini-view's picture comes from the helper as a JPEG.
    const shot = await p2.snapshot(160, 60);
    expect(shot?.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(shot).toMatchObject({ width: 320, height: 200 });
    p2.close();
    desk.stop();
  });

  it("stops cleanly even with something mounted in its folder, and starts again", async (ctx) => {
    if (process.getuid?.() !== 0) ctx.skip(); // mounting needs root here (gvfs would mount with FUSE as the user)
    const desk = make({ display: 246 });
    const info = await desk.start();
    const runtime = info.env.XDG_RUNTIME_DIR!;
    const mount = path.join(runtime, "gvfs");
    fs.mkdirSync(mount);
    if (spawnSync("mount", ["-t", "tmpfs", "tmpfs", mount]).status !== 0) ctx.skip();
    fs.writeFileSync(path.join(mount, "remote-file"), "not Ember's");
    try {
      expect(() => desk.stop()).not.toThrow();
      expect(desk.running).toBeNull();
      expect(fs.readFileSync(path.join(mount, "remote-file"), "utf8")).toBe("not Ember's");
      expect(fs.existsSync(path.join(path.dirname(runtime), "Xauthority"))).toBe(false); // the cookie is gone
      const again = await desk.start();
      expect(again.display).not.toBe("");
      expect(desk.alive()).toBe(true);
      desk.stop();
    } finally {
      spawnSync("umount", ["-l", mount]);
      fs.rmSync(path.dirname(runtime), { recursive: true, force: true });
    }
  });

  it("gives two desks starting at once different displays", async () => {
    const a = make({ display: 248 }), b = make({ display: 248 });
    const [ia, ib] = await Promise.all([a.start(), b.start()]);
    expect(ia.display).not.toBe(ib.display);
    expect(a.alive() && b.alive()).toBe(true);
    a.stop();
    b.stop();
  });

  it("leaves nothing behind when it can't start", async () => {
    const file = path.join(dir, "not-a-folder");
    fs.writeFileSync(file, "");
    const before = fs.readdirSync("/tmp/.X11-unix").length;
    const desk = make({ handOff: path.join(file, "Ember") });
    await expect(desk.start()).rejects.toThrow();
    expect(desk.running).toBeNull();
    expect(fs.readdirSync("/tmp/.X11-unix").length).toBeLessThanOrEqual(before);
    // Nor when its helper can't start.
    const broken = make({ display: 250, agent: path.join(dir, "no-such-helper.cjs") });
    await expect(broken.start()).rejects.toThrow(/helper/);
    expect(broken.running).toBeNull();
    expect(await until(() => fs.readdirSync("/tmp/.X11-unix").length <= before)).toBe(true);
  });

  it("kills what left the desk's process groups when it stops", async () => {
    const desk = make({ display: 252 });
    await desk.start();
    const id = desk.running!.env.EMBER_DESK_ID!;
    desk.run(["setsid", "-f", "sleep", "303"]);
    expect(await until(() => deskProcesses(id).some(p => fs.readFileSync(`/proc/${p}/cmdline`, "utf8").includes("303")))).toBe(true);
    desk.stop();
    expect(await until(() => deskProcesses(id).length === 0, 3000)).toBe(true);
  });
});
