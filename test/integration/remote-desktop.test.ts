// The remote agent's desktop child against a real X server (§10.2 `ssh-linux`'s desktop step): Xvfb, a session bus,
// AT-SPI and a GTK 3 window, with discovery's answer injected (logind isn't available on runners; EMBER_REMOTE_DEV=1
// builds only). It checks what only a real desktop can: the notice shows before anything is read, reads and a tier-1
// step go through gate 2, the screenshot is a PNG with the password field blacked out before it left the agent, and
// Stop ends the desktop. Skips without EMBER_SSH_TEST; fails when it is "1" and the display, the session bus, Python's
// GTK or the build is missing.
// Run: EMBER_SSH_TEST=1 dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24" node scripts/run-integration.mjs test/integration/remote-desktop.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import sharp from "sharp";
import { AGENT, connectLocal, hello, RemoteError, ROOT, sha256Hex, type AgentLink } from "./remote-harness";
import type { AxNode } from "../../app/main/perception/sidecar";
import type { ActStamp } from "../../app/main/perception/ports";

const required = process.env.EMBER_SSH_TEST === "1";
// Only with the variable: the suite turns accessibility on in the session's settings, which a developer's own
// desktop must not get by accident.
const enabled = !!process.env.EMBER_SSH_TEST;
const python = process.env.EMBER_PYTHON ?? "python3";
const gtk = enabled && spawnSync(python, ["-c", "import gi; gi.require_version('Gtk', '3.0'); from gi.repository import Gtk"], { stdio: "ignore" }).status === 0;
const available = !!process.env.DISPLAY && !!process.env.DBUS_SESSION_BUS_ADDRESS && fs.existsSync(AGENT) && gtk;
const BENCH = "Ember Test Bench";

describe.skipIf(!enabled || (!available && !required))("the remote desktop child against Xvfb (§5.3.4-§5.3.9)", () => {
  let link: AgentLink;
  let bench: ChildProcess;
  const benchEvents: Record<string, unknown>[] = [];
  let home = "";
  let epoch = 1;

  const stamp = (o: Partial<ActStamp> = {}): ActStamp => ({
    taskId: "1-ci", kind: "text", app: "", window: BENCH, element: null, verdict: "confirm", approval: { given: true }, ageMs: 200, ...o,
  });

  beforeAll(async () => {
    if (!available) throw new Error("the desktop suite needs DISPLAY, a session bus (dbus-run-session), Python's GTK 3 and npm run build");
    // Apps expose themselves over AT-SPI only with accessibility on (a real desktop's user turns it on once).
    spawnSync("gsettings", ["set", "org.gnome.desktop.interface", "toolkit-accessibility", "true"], { stdio: "ignore" });
    bench = spawn(python, [path.join(ROOT, "test/fixtures/gtk3_bench.py")], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, GTK_MODULES: "gail:atk-bridge" } });
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("the GTK bench didn't come up")), 20_000);
      readline.createInterface({ input: bench.stdout! }).on("line", l => {
        try {
          const ev = JSON.parse(l) as Record<string, unknown>;
          benchEvents.push(ev);
          if (ev.event === "ready") { clearTimeout(t); resolve(); }
        } catch { /* not an event */ }
      });
    });
    await ready;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ember-remote-desktop-"));
    // The agent runs with its own HOME: it reads the settings database there (dconf reads its file directly).
    const db = path.join(os.homedir(), ".config/dconf/user");
    if (fs.existsSync(db)) {
      fs.mkdirSync(path.join(home, ".config/dconf"), { recursive: true });
      fs.copyFileSync(db, path.join(home, ".config/dconf/user"));
    }
    const session = { DISPLAY: process.env.DISPLAY!, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS!, ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}) };
    link = connectLocal({ home, env: { ...session, EMBER_REMOTE_TEST_DESKTOP: JSON.stringify({ access: "screen", session: { id: "ci", type: "x11" }, env: session }) } });
  }, 60_000);

  afterAll(async () => {
    link?.end();
    await link?.exited;
    bench?.kill();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it("says in welcome that a desktop is there, without showing anything yet", async () => {
    const w = await link.request("hello", hello({ epoch }));
    expect(w.desktop).toMatchObject({ access: "screen", notice: "off", session: { type: "x11" } });
  });

  it("shows its notice, titled Ember with a Stop button, before anything is read", async () => {
    const s = await link.request("desktop.state", {}, 60_000);
    expect(s).toMatchObject({ access: "screen", notice: "shown" });
    const { windows } = await link.request("perceive.windows", {});
    expect(windows.map(w => w.name)).toEqual(expect.arrayContaining(["Ember", BENCH]));
  });

  let nodes: AxNode[] = [];
  it("reads a window with its elements, a password field's text never", async () => {
    const seen = await link.request("perceive.read", { target: { title: BENCH } });
    expect(seen.window?.name).toBe(BENCH);
    nodes = seen.nodes;
    expect(nodes.some(n => n.role === "push button" && n.name === "Save")).toBe(true);
    const pw = nodes.find(n => n.name === "Password");
    expect(pw?.secret).toBe(true);
    expect(pw?.text ?? "").toBe("");
  });

  it("types into a field only with the stamp's yes, and refuses a stale stamp or an older epoch (§5.3.7)", async () => {
    const name = nodes.find(n => n.name === "Name" && /text/.test(n.role))!;
    const app = (await link.request("perceive.read", { target: { title: BENCH } })).window!.app;
    const base = { opId: "s1", epoch, op: "set_text" as const, id: name.id, text: "Ada", mode: "replace" as const };
    const st = stamp({ app, element: { role: name.role, name: name.name }, valueSha256: sha256Hex("Ada") });
    expect((await link.request("act", { ...base, stamp: { ...st, approval: null } })).status).toBe("needs_confirm");
    expect(await link.request("act", { ...base, stamp: { ...st, ageMs: 10_000 } })).toEqual({ status: "stale" });
    expect(await link.request("act", { ...base, epoch: 0, stamp: st })).toEqual({ status: "stopped" });
    expect((await link.request("act", { ...base, stamp: { ...st, valueSha256: sha256Hex("Bob") } })).status).toBe("deny");
    const ok = await link.request("act", { ...base, stamp: st });
    expect(ok.status).toBe("ok");
    await new Promise(r => setTimeout(r, 500));
    expect(benchEvents.some(e => e.event === "text" && e.name === "Name" && e.value === "Ada")).toBe(true);
  });

  it("sends a PNG on a bulk channel with the password field blacked out before it left (§5.3.6)", async () => {
    const r = await link.request("perceive.perceive", { image: true, scope: "window", target: { title: BENCH } }, 60_000);
    expect(r.image).not.toBeNull();
    const img = r.image!;
    const bytes = await link.waitBytes(img.channel, img.bytes);
    expect(bytes.length).toBe(img.bytes);
    expect(sha256Hex(bytes.toString("latin1")).length).toBe(64);
    const { data, info } = await sharp(bytes, { failOn: "error" }).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([img.width, img.height]);
    const pw = r.seen.nodes.find(n => n.name === "Password" && n.bounds)!;
    const cx = Math.round((pw.bounds!.x + pw.bounds!.width / 2 - img.rect.x) * img.scale);
    const cy = Math.round((pw.bounds!.y + pw.bounds!.height / 2 - img.rect.y) * img.scale);
    const at = (cy * info.width + cx) * info.channels;
    expect([data[at], data[at + 1], data[at + 2]]).toEqual([0, 0, 0]);
  });

  it("ends the desktop on Stop, and shows the notice again on the next desktop.state", async () => {
    epoch = 2;
    await link.request("stop", { epoch });
    await expect(link.request("perceive.windows", {})).rejects.toBeInstanceOf(RemoteError);
    const s = await link.request("desktop.state", {}, 60_000);
    expect(s).toMatchObject({ access: "screen", notice: "shown" });
  });
});
