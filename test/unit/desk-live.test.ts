/**
 * A real desk (Xvfb, xauth, dbus-daemon): what its apps get in their
 * environment, that a dying display can't take Ember with it, that stale
 * displays are reused and that a failed start leaves nothing behind.
 * Skipped where the desk can't run.
 */

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeskManager } from "../../app/main/desk/desk";
import { openDeskPlace } from "../../app/main/desk/place";
import { openX11 } from "../../app/main/x11";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const libX11 = (() => { try { openX11(":0")?.close(); return true; } catch { return false; } })();
const available = DeskManager.available().ok && libX11 && process.platform === "linux";
const until = async (cond: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 25)); return cond(); };

describe.skipIf(!available)("a real desk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-desk-live-"));
  const desks: DeskManager[] = [];
  const make = (o: ConstructorParameters<typeof DeskManager>[1] = {}) => {
    const d = new DeskManager(quiet, { handOff: path.join(dir, "Ember"), display: 160, width: 320, height: 200, ...o });
    desks.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of desks) d.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives its apps no sign-in, keys or agents, and folders of their own", async () => {
    const saved = { GH_TOKEN: process.env.GH_TOKEN, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, EMBER_PROVIDER_API_KEY: process.env.EMBER_PROVIDER_API_KEY };
    Object.assign(process.env, { GH_TOKEN: "gho_test", SSH_AUTH_SOCK: "/tmp/agent", EMBER_PROVIDER_API_KEY: "sk-test" });
    const desk = make({ profiles: path.join(dir, "profiles"), env: { EMBER_BENCH_LOG: "/tmp/bench.jsonl" } });
    try {
      const info = await desk.start();
      expect(Number(info.display.slice(1))).toBeGreaterThanOrEqual(160);
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
      // The cookie never appears on a command line.
      const cookie = spawnSync("xauth", ["-f", info.env.XAUTHORITY!, "list"], { encoding: "utf8" }).stdout.trim().split(/\s+/).at(-1)!;
      expect(cookie).toMatch(/^[0-9a-f]{32}$/);
      const cmdlines = fs.readdirSync("/proc").filter(p => /^\d+$/.test(p)).map(p => { try { return fs.readFileSync(`/proc/${p}/cmdline`, "utf8"); } catch { return ""; } });
      expect(cmdlines.some(c => c.includes(cookie))).toBe(false);
    } finally {
      desk.stop();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it("survives its display dying: everything there is marked dead before any more X calls", async () => {
    const desk = make();
    const place = await openDeskPlace(desk, { sidecarScript: "/nonexistent.py", log: quiet, neverLook: () => [], profiles: path.join(dir, "profiles2") });
    const info = desk.running!;
    expect(place.x11.capture(0, 0, 10, 10)?.width).toBe(10);
    let told = 0, placeTold = 0;
    desk.onDead(() => { told++; });
    place.onDead(() => { placeTold++; });
    const lock = `/tmp/.X${info.display.slice(1)}-lock`;
    const pid = Number(fs.readFileSync(lock, "utf8").trim());
    process.kill(pid, "SIGKILL");
    // Even before Node hears that it exited, nothing touches the dead display.
    await until(() => !desk.alive(), 2000);
    expect(() => place.x11.capture(0, 0, 10, 10)).toThrow(/desk has stopped/);
    expect(() => place.input.move(1, 1)).toThrow(/desk has stopped/);
    expect(await until(() => told === 1)).toBe(true);
    expect(placeTold).toBe(1);
    expect(place.dead).toBe(true);
    expect(desk.running).toBeNull();
    expect(() => desk.run(["true"])).toThrow(/isn't running/);
    place.close(); // no XCloseDisplay on the dead connection
    // SIGKILL left its lock behind: the number is free again.
    expect(fs.existsSync(lock)).toBe(true);
    const again = await desk.start();
    expect(again.display).toBe(info.display);
    desk.stop();
  });

  it("gives two desks starting at once different displays", async () => {
    const a = make({ display: 170 }), b = make({ display: 170 });
    const [ia, ib] = await Promise.all([a.start(), b.start()]);
    expect(ia.display).not.toBe(ib.display);
    for (const i of [ia, ib]) {
      const c = (() => { const saved = process.env.XAUTHORITY; process.env.XAUTHORITY = i.env.XAUTHORITY; try { return openX11(i.display); } finally { if (saved === undefined) delete process.env.XAUTHORITY; else process.env.XAUTHORITY = saved; } })();
      expect(c).not.toBeNull();
      c?.close();
    }
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
  });
});
