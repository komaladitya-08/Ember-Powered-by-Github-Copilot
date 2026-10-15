/**
 * Ember's desk (tier 2): a private X display nobody looks at, with its own
 * D-Bus session (so its apps' accessibility lives on their own bus) and a
 * window manager if one is installed. Ember can use full mouse and keyboard
 * input there without ever touching the user's. It has its own clipboard (a
 * separate display), an auth cookie so other users can't connect, and is torn
 * down completely when Ember quits.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logger";
import { appEnv } from "../hands/system";

export interface DeskInfo {
  display: string;
  width: number;
  height: number;
  env: NodeJS.ProcessEnv;
  /** Where Ember puts what it made for the user. */
  handOff: string;
}

const which = (cmd: string): string | null => {
  for (const dir of (process.env.PATH ?? "/usr/bin:/bin").split(":")) {
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
};

/** The first display number with no X server (lock file or socket). */
export function freeDisplay(from = 90, exists: (p: string) => boolean = fs.existsSync): number {
  for (let n = from; n < from + 50; n++) {
    if (!exists(`/tmp/.X${n}-lock`) && !exists(`/tmp/.X11-unix/X${n}`)) return n;
  }
  throw new Error("no free X display number");
}

export class DeskManager {
  private procs: ChildProcess[] = [];
  private dir: string | null = null;
  private info: DeskInfo | null = null;
  private starting: Promise<DeskInfo> | null = null;

  constructor(private log: Logger, private o: { width?: number; height?: number; handOff?: string } = {}) {
    // Even if Ember exits without quitting cleanly, don't leave the desk running.
    process.once("exit", () => { for (const p of this.procs) try { p.kill("SIGKILL"); } catch { /* gone */ } });
  }

  get running(): DeskInfo | null {
    return this.info;
  }

  /** Can this machine run a desk at all? */
  static available(): { ok: boolean; missing: string[] } {
    const missing = ["Xvfb", "xauth", "dbus-daemon"].filter(c => !which(c));
    return { ok: missing.length === 0, missing };
  }

  start(): Promise<DeskInfo> {
    if (this.info) return Promise.resolve(this.info);
    this.starting ??= this.boot().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async boot(): Promise<DeskInfo> {
    const t0 = Date.now();
    const { ok, missing } = DeskManager.available();
    if (!ok) throw new Error(`Ember's desk needs ${missing.join(", ")} (dnf install xorg-x11-server-Xvfb xorg-x11-xauth dbus-daemon)`);
    const width = this.o.width ?? 1280, height = this.o.height ?? 800;
    const n = freeDisplay();
    const display = `:${n}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-desk-"));
    fs.chmodSync(dir, 0o700);
    this.dir = dir;

    // Only Ember (and processes it starts) may connect: an MIT cookie in a private file.
    const xauth = path.join(dir, "Xauthority");
    fs.writeFileSync(xauth, "", { mode: 0o600 });
    execFileSync("xauth", ["-f", xauth, "add", display, ".", crypto.randomBytes(16).toString("hex")], { stdio: "ignore" });

    const xvfb = spawn("Xvfb", [display, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-auth", xauth, "-noreset"], { stdio: "ignore" });
    this.track(xvfb, "Xvfb");
    await this.waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${n}`), 5000, "the desk display didn't start");

    // A session bus of its own: apps' D-Bus activation and the accessibility bus stay on the desk.
    const runtime = path.join(dir, "runtime");
    fs.mkdirSync(runtime, { mode: 0o700 });
    const baseEnv: NodeJS.ProcessEnv = { ...appEnv(), DISPLAY: display, XAUTHORITY: xauth, XDG_RUNTIME_DIR: runtime };
    delete baseEnv.DBUS_SESSION_BUS_ADDRESS;
    delete baseEnv.WAYLAND_DISPLAY;
    const bus = spawn("dbus-daemon", ["--session", "--nofork", "--nopidfile", "--print-address=1"], { env: baseEnv, stdio: ["ignore", "pipe", "ignore"] });
    this.track(bus, "dbus-daemon");
    const address = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("the desk's D-Bus didn't start")), 5000);
      bus.stdout!.on("data", (d: Buffer) => {
        out += d.toString();
        const line = out.split("\n")[0];
        if (out.includes("\n") && line) { clearTimeout(timer); resolve(line.trim()); }
      });
    });

    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      DBUS_SESSION_BUS_ADDRESS: address,
      // Every toolkit exposes accessibility on the desk.
      // (NO_AT_BRIDGE must be absent, not "0": GTK only checks that it exists.)
      GNOME_ACCESSIBILITY: "1", QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1", ACCESSIBILITY_ENABLED: "1",
      GDK_BACKEND: "x11", QT_QPA_PLATFORM: "xcb", XDG_SESSION_TYPE: "x11",
    };
    const wm = ["metacity", "openbox", "xfwm4"].find(c => which(c));
    if (wm) this.track(spawn(wm, wm === "metacity" ? ["--replace", "--no-composite"] : [], { env, stdio: "ignore" }), wm);

    const handOff = this.o.handOff ?? path.join(os.homedir(), "Ember");
    fs.mkdirSync(handOff, { recursive: true });
    this.info = { display, width, height, env, handOff };
    this.log.info("desk.started", { display, wm: wm ?? "none", ms: Date.now() - t0 });
    return this.info;
  }

  /** Starts a program on the desk (never on the user's display). */
  run(argv: string[], extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
    if (!this.info) throw new Error("the desk isn't running");
    const child = spawn(argv[0], argv.slice(1), { env: { ...this.info.env, ...extraEnv }, stdio: ["ignore", "ignore", "pipe"], cwd: this.info.handOff });
    this.track(child, path.basename(argv[0]));
    let err = "";
    child.stderr?.on("data", (d: Buffer) => { if (err.length < 4000) err += d.toString(); });
    child.on("exit", code => { if (code) this.log.warn("desk.app_exited", { app: path.basename(argv[0]), code, stderr: err.slice(-1500) }); });
    return child;
  }

  stop(): void {
    // Apps first, then the window manager, bus and display (reverse start order).
    for (const p of [...this.procs].reverse()) {
      try { p.kill("SIGTERM"); } catch { /* gone */ }
    }
    const procs = this.procs;
    setTimeout(() => { for (const p of procs) if (p.exitCode === null) try { p.kill("SIGKILL"); } catch { /* gone */ } }, 1500).unref();
    this.procs = [];
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
    if (this.info) this.log.info("desk.stopped", { display: this.info.display });
    this.dir = null;
    this.info = null;
  }

  private track(p: ChildProcess, name: string): void {
    this.procs.push(p);
    p.on("error", err => this.log.warn("desk.process_error", { name, err }));
    p.on("exit", () => { this.procs = this.procs.filter(x => x !== p); });
  }

  private async waitFor(cond: () => boolean, ms: number, error: string): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error(error);
      await new Promise(r => setTimeout(r, 25));
    }
  }
}

/**
 * Opens an X connection to the desk. libX11 reads XAUTHORITY when the
 * connection is made, so it is pointed at the desk's cookie just for the call.
 */
export function withDeskAuth<T>(desk: DeskInfo, open: (display: string) => T): T {
  const saved = process.env.XAUTHORITY;
  process.env.XAUTHORITY = desk.env.XAUTHORITY;
  try {
    return open(desk.display);
  } finally {
    if (saved === undefined) delete process.env.XAUTHORITY; else process.env.XAUTHORITY = saved;
  }
}
