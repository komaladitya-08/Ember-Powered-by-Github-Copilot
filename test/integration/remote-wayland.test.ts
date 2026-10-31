// The remote agent's "text" desktop on Wayland (§10.2 `wayland-remote`, L5): a headless mutter session with no
// Xwayland, a session bus, AT-SPI and a GTK 3 window on Wayland, with discovery's answer injected (logind and a user
// manager aren't available on runners; EMBER_REMOTE_DEV=1 builds only, EMBER_REMOTE_WAYLAND=1 turning the text path
// on). It checks what only a real Wayland session can: the notice falls back to a resident notification with a Stop
// action (a stand-in notification service records it, as a headless mutter has none), AT-SPI reads with a password
// field's text never sent, tier-1 steps through gate 2, no screenshot, and the notification's Stop ending the desktop.
// Until this passes on the runner, Wayland remotes stay commands only. Skips without EMBER_SSH_TEST; fails when it is
// "1" and WAYLAND_DISPLAY, the session bus, Python's GTK or the build is missing.
// Run: EMBER_SSH_TEST=1 dbus-run-session -- sh -c 'mutter --headless --wayland --no-x11 --virtual-monitor 1280x1024 \
//   --wayland-display ember-wl & sleep 3; WAYLAND_DISPLAY=ember-wl node scripts/run-integration.mjs test/integration/remote-wayland.test.ts'

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { AGENT, connectLocal, hello, RemoteError, ROOT, sha256Hex, type AgentLink } from "./remote-harness";
import type { AxNode } from "../../app/main/perception/sidecar";
import type { ActStamp } from "../../app/main/perception/ports";

const required = process.env.EMBER_SSH_TEST === "1";
// Only with the variable: the suite turns accessibility on in the session's settings, which a developer's own
// desktop must not get by accident.
const enabled = !!process.env.EMBER_SSH_TEST;
const python = process.env.EMBER_PYTHON ?? "python3";
const gtk = enabled && spawnSync(python, ["-c", "import gi; gi.require_version('Gtk', '3.0'); from gi.repository import Gtk"], { stdio: "ignore" }).status === 0;
const available = !!process.env.WAYLAND_DISPLAY && !!process.env.XDG_RUNTIME_DIR && !!process.env.DBUS_SESSION_BUS_ADDRESS && fs.existsSync(AGENT) && gtk;
const BENCH = "Ember Test Bench";

type Line = Record<string, unknown>;

/** A Python helper printing JSON lines: its lines so far, and a wait for one. */
function helper(script: string, env: NodeJS.ProcessEnv) {
  const proc = spawn(python, [script], { stdio: ["pipe", "pipe", "inherit"], env });
  const lines: Line[] = [];
  const waiters = new Set<() => void>();
  readline.createInterface({ input: proc.stdout! }).on("line", l => {
    try { lines.push(JSON.parse(l) as Line); } catch { return; }
    for (const w of waiters) w();
  });
  const wait = (pick: (l: Line) => boolean, ms = 20_000) => new Promise<Line>((resolve, reject) => {
    const check = () => {
      const hit = lines.find(pick);
      if (!hit) return;
      waiters.delete(check);
      clearTimeout(timer);
      resolve(hit);
    };
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`timed out waiting in ${path.basename(script)}`)); }, ms);
    waiters.add(check);
    check();
  });
  return { proc, lines, wait, send: (o: Line) => proc.stdin!.write(`${JSON.stringify(o)}\n`) };
}

describe.skipIf(!enabled || (!available && !required))("the remote desktop's text path on Wayland, without Xwayland (L5, §5.3.9)", { timeout: 90_000 }, () => {
  let link: AgentLink;
  let bench: ReturnType<typeof helper>;
  let notices: ReturnType<typeof helper>;
  let home = "";
  let epoch = 1;
  const children: ChildProcess[] = [];

  const stamp = (o: Partial<ActStamp> = {}): ActStamp => ({
    taskId: "1-ci", kind: "text", app: "", window: BENCH, element: null, verdict: "confirm", approval: { given: true }, ageMs: 200, ...o,
  });

  beforeAll(async () => {
    if (!available) throw new Error("the Wayland suite needs WAYLAND_DISPLAY and XDG_RUNTIME_DIR (a headless mutter), a session bus, Python's GTK 3 and npm run build");
    // Apps expose themselves over AT-SPI only with accessibility on (a real desktop's user turns it on once).
    spawnSync("gsettings", ["set", "org.gnome.desktop.interface", "toolkit-accessibility", "true"], { stdio: "ignore" });
    // A Wayland-only session: nothing may fall back to X.
    const session = { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY!, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR!, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS! };
    const base: NodeJS.ProcessEnv = { ...process.env, DISPLAY: undefined, XAUTHORITY: undefined };
    notices = helper(path.join(ROOT, "test/fixtures/remote/fake_notifications.py"), base);
    children.push(notices.proc);
    await notices.wait(l => l.event === "ready");
    bench = helper(path.join(ROOT, "test/fixtures/gtk3_bench.py"), { ...base, GDK_BACKEND: "wayland", GTK_MODULES: "gail:atk-bridge" });
    children.push(bench.proc);
    await bench.wait(l => l.event === "ready");
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ember-remote-wayland-"));
    // The agent runs with its own HOME: it reads the settings database there (dconf reads its file directly).
    const db = path.join(os.homedir(), ".config/dconf/user");
    if (fs.existsSync(db)) {
      fs.mkdirSync(path.join(home, ".config/dconf"), { recursive: true });
      fs.copyFileSync(db, path.join(home, ".config/dconf/user"));
    }
    link = connectLocal({
      home,
      env: { ...session, EMBER_REMOTE_WAYLAND: "1", EMBER_REMOTE_TEST_DESKTOP: JSON.stringify({ access: "text", session: { id: "ci", type: "wayland" }, env: session }) },
    });
  }, 90_000);

  afterAll(async () => {
    link?.end();
    await link?.exited;
    for (const c of children) c.kill();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it("says in welcome that a Wayland desktop is there for reading, without showing anything yet", async () => {
    const w = await link.request("hello", hello({ epoch }));
    expect(w.desktop).toMatchObject({ access: "text", notice: "off", session: { type: "wayland" } });
    expect(notices.lines.filter(l => l.event === "notify")).toHaveLength(0);
  });

  it("shows its notice as a resident notification with a Stop button, before anything is read", async () => {
    const s = await link.request("desktop.state", {}, 60_000);
    expect(s).toMatchObject({ access: "text", notice: "shown" });
    const shown = await notices.wait(l => l.event === "notify");
    expect(shown).toMatchObject({ summary: "Ember", resident: true, actions: ["stop", "Stop"] });
    expect(String(shown.body)).toContain("ci-pc");
  });

  let nodes: AxNode[] = [];
  it("lists and reads windows over AT-SPI, a password field's text never", async () => {
    const { windows } = await link.request("perceive.windows", {});
    expect(windows.map(w => w.name)).toContain(BENCH);
    const seen = await link.request("perceive.read", { target: { title: BENCH } });
    expect(seen.window?.name).toBe(BENCH);
    nodes = seen.nodes;
    expect(nodes.some(n => n.role === "push button" && n.name === "Save")).toBe(true);
    const pw = nodes.find(n => n.name === "Password");
    expect(pw?.secret).toBe(true);
    expect(pw?.text ?? "").toBe("");
  });

  it("takes tier-1 steps through gate 2: text with the stamp's yes, and a button's action", async () => {
    const app = (await link.request("perceive.read", { target: { title: BENCH } })).window!.app;
    const name = nodes.find(n => n.name === "Name" && /text/.test(n.role))!;
    const text = { opId: "w1", epoch, op: "set_text" as const, id: name.id, text: "Ada", mode: "replace" as const };
    const st = stamp({ app, element: { role: name.role, name: name.name }, valueSha256: sha256Hex("Ada") });
    expect((await link.request("act", { ...text, stamp: { ...st, approval: null } })).status).toBe("needs_confirm");
    expect(await link.request("act", { ...text, stamp: { ...st, ageMs: 10_000 } })).toEqual({ status: "stale" });
    expect((await link.request("act", { ...text, stamp: st })).status).toBe("ok");
    await bench.wait(l => l.event === "text" && l.name === "Name" && l.value === "Ada", 5000);
    // Grants are off on remotes, so every step there asks the user (L4): without the stamp's yes, gate 2 asks.
    const save = nodes.find(n => n.role === "push button" && n.name === "Save")!;
    const click = { opId: "w2", epoch, op: "do_action" as const, id: save.id, action: "click" };
    const clickStamp = stamp({ kind: "click", app, element: { role: save.role, name: save.name } });
    expect(await link.request("act", { ...click, stamp: { ...clickStamp, approval: null } })).toMatchObject({ status: "needs_confirm" });
    expect((await link.request("act", { ...click, stamp: clickStamp })).status).toBe("ok");
    await bench.wait(l => l.event === "clicked" && l.name === "Save", 5000);
  });

  it("sends no screenshot from a Wayland session, and says why", async () => {
    const r = await link.request("perceive.perceive", { image: true, scope: "window", target: { title: BENCH } }, 60_000);
    expect(r.image).toBeNull();
    expect(r.noShot).toBeTruthy();
  });

  it("stops everything when the notification's Stop is pressed, and the PC hears it", async () => {
    const shown = notices.lines.filter(l => l.event === "notify").at(-1)!;
    notices.send({ invoke: shown.id, key: "stop" });
    const heard = await link.event("console.stop", () => true, 10_000);
    expect(typeof heard.at).toBe("string");
    await expect(link.request("perceive.windows", {})).rejects.toBeInstanceOf(RemoteError);
    // The link stays: the next desktop.state asks for the notice again.
    epoch = 2;
    await link.request("stop", { epoch });
    expect(await link.request("desktop.state", {}, 60_000)).toMatchObject({ access: "text", notice: "shown" });
  });
});
