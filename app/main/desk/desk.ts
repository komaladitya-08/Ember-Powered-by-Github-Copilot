/**
 * Ember's desk (tier 2): a private X display nobody looks at, with its own
 * D-Bus session (so its apps' accessibility lives on their own bus) and a
 * window manager if one is installed. Ember can use full mouse and keyboard
 * input there without ever touching the user's. It has its own clipboard (a
 * separate display), an auth cookie so other users can't connect, its own
 * user folders (so its apps never change the user's settings), and is torn
 * down completely when Ember quits.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logger";
import { appEnv } from "../hands/system";
import { openX11 } from "../x11";

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

/** Is a process with this id running (as anyone)? */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Is this child still running? False as soon as it has exited, even before Node reaps it (a zombie). */
export function running(pid: number | undefined, read: (p: string) => string = p => fs.readFileSync(p, "utf8")): boolean {
  if (!pid) return false;
  let stat: string;
  try { stat = read(`/proc/${pid}/stat`); } catch (err) { return (err as NodeJS.ErrnoException).code !== "ENOENT"; }
  const state = stat.charAt(stat.lastIndexOf(")") + 2); // "pid (name) S …": the name may hold spaces and parentheses
  return state !== "Z" && state !== "X";
}

export interface DisplayProbe {
  exists(p: string): boolean;
  /** The pid in /tmp/.X<n>-lock, or null if it can't be read. */
  lockPid(n: number): number | null;
  alive(pid: number): boolean;
  /** Removes a stale file; false if it can't (another user's). */
  remove(p: string): boolean;
}

const realProbe: DisplayProbe = {
  exists: fs.existsSync,
  lockPid: n => { try { const pid = Number(fs.readFileSync(`/tmp/.X${n}-lock`, "utf8").trim()); return Number.isInteger(pid) && pid > 0 ? pid : null; } catch { return null; } },
  alive: pidAlive,
  remove: p => { try { fs.unlinkSync(p); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT"; } },
};

/**
 * The first display number with no X server. A lock file whose process is
 * gone (a desk left behind by a crash) is stale: it is removed with its socket
 * and the number used again.
 */
export function freeDisplay(from = 90, probe: Partial<DisplayProbe> = {}): number {
  const { exists, lockPid, alive, remove } = { ...realProbe, ...probe };
  for (let n = from; n < from + 50; n++) {
    const lock = `/tmp/.X${n}-lock`, socket = `/tmp/.X11-unix/X${n}`;
    if (exists(lock)) {
      const pid = lockPid(n);
      if (pid === null || alive(pid) || !remove(lock)) continue;
      if (exists(socket) && !remove(socket)) continue;
      return n;
    }
    if (!exists(socket)) return n;
  }
  throw new Error("no free X display number");
}

/** Signals a desk process and everything it started (each runs in its own process group). */
function signal(p: ChildProcess, sig: NodeJS.Signals): void {
  if (!p.pid) return;
  try { process.kill(-p.pid, sig); } catch { try { p.kill(sig); } catch { /* gone */ } }
}

export class DeskManager {
  private procs: ChildProcess[] = [];
  private dir: string | null = null;
  private info: DeskInfo | null = null;
  private xvfb: ChildProcess | null = null;
  private starting: Promise<DeskInfo> | null = null;
  private deadFns = new Set<(why: string) => void>();

  /**
   * `profiles`: where the desk's own user folders live (default: a throw-away folder).
   * `env`: extra variables for everything on the desk (tests pass their fixtures' settings).
   * `display`: the first display number to try.
   */
  constructor(private log: Logger, private o: { width?: number; height?: number; handOff?: string; profiles?: string; env?: NodeJS.ProcessEnv; display?: number } = {}) {
    // Even if Ember exits without quitting cleanly, don't leave the desk running or its cookie on disk.
    // (SIGTERM, so Xvfb removes its lock and socket.)
    process.once("exit", () => {
      for (const p of this.procs) signal(p, "SIGTERM");
      if (this.dir) try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });
  }

  get running(): DeskInfo | null {
    return this.info;
  }

  /** Is the desk's display up? No X call may be made on it otherwise: Xlib would end Ember. */
  alive(): boolean {
    return !!this.info && running(this.xvfb?.pid);
  }

  /** Calls `fn` when the desk's display dies on its own (not when stopped). Returns a function that stops listening. */
  onDead(fn: (why: string) => void): () => void {
    this.deadFns.add(fn);
    return () => { this.deadFns.delete(fn); };
  }

  /** Can this machine run a desk at all? */
  static available(): { ok: boolean; missing: string[] } {
    const missing = ["Xvfb", "xauth", "dbus-daemon"].filter(c => !which(c));
    return { ok: missing.length === 0, missing };
  }

  /** `profiles` is used when the manager was made without one. */
  start(o: { profiles?: string } = {}): Promise<DeskInfo> {
    if (this.info) return Promise.resolve(this.info);
    this.starting ??= this.boot(this.o.profiles ?? o.profiles).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async boot(profiles: string | undefined): Promise<DeskInfo> {
    const t0 = Date.now();
    const { ok, missing } = DeskManager.available();
    if (!ok) throw new Error(`Ember's desk needs ${missing.join(", ")} (dnf install xorg-x11-server-Xvfb xorg-x11-xauth dbus-daemon)`);
    const width = this.o.width ?? 1280, height = this.o.height ?? 800;
    // The hand-off folder first: if it can't be made, nothing has been started.
    const handOff = this.o.handOff ?? path.join(os.homedir(), "Ember");
    fs.mkdirSync(handOff, { recursive: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-desk-"));
    fs.chmodSync(dir, 0o700);
    this.dir = dir;
    try {
      // Only Ember (and processes it starts) may connect: an MIT cookie in a private file.
      const xauth = path.join(dir, "Xauthority");
      fs.writeFileSync(xauth, "", { mode: 0o600 });
      const cookie = crypto.randomBytes(16).toString("hex");
      let display = "";
      for (let attempt = 0, from = this.o.display ?? 90; !display; attempt++) {
        const n = freeDisplay(from);
        // On stdin, never on a command line: any user can read those in /proc.
        execFileSync("xauth", ["-f", xauth, "source", "-"], { input: `add :${n} . ${cookie}\n`, stdio: ["pipe", "ignore", "ignore"] });
        if (await this.startDisplay(n, width, height, xauth)) display = `:${n}`;
        else if (attempt >= 4) throw new Error("the desk display didn't start");
        else from = n + 1; // another X server took the number first
      }

      // The desk's own user folders: settings, data and caches of its apps and of the D-Bus
      // services they start (dconf writes settings for them) stay there, never in the user's.
      const home = path.join(profiles ?? path.join(dir, "profiles"), "xdg");
      const folders = { XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state") };
      for (const f of Object.values(folders)) fs.mkdirSync(f, { recursive: true, mode: 0o700 });
      // A session bus of its own: apps' D-Bus activation and the accessibility bus stay on the desk.
      const runtime = path.join(dir, "runtime");
      fs.mkdirSync(runtime, { mode: 0o700 });
      // Built from an allowlist: Ember's sign-in, keys and the user's agents never reach the desk.
      const baseEnv: NodeJS.ProcessEnv = { ...appEnv(process.env, { session: false }), ...this.o.env, ...folders, DISPLAY: display, XAUTHORITY: xauth, XDG_RUNTIME_DIR: runtime };
      const bus = spawn("dbus-daemon", ["--session", "--nofork", "--nopidfile", "--print-address=1"], { env: baseEnv, stdio: ["ignore", "pipe", "ignore"], detached: true });
      this.track(bus, "dbus-daemon");
      const address = await new Promise<string>((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error("the desk's D-Bus didn't start")), 5000);
        bus.once("exit", () => { clearTimeout(timer); reject(new Error("the desk's D-Bus didn't start")); });
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
      if (wm) this.track(spawn(wm, wm === "metacity" ? ["--replace", "--no-composite"] : [], { env, stdio: "ignore", detached: true }), wm);

      this.info = { display, width, height, env, handOff };
      this.log.info("desk.started", { display, wm: wm ?? "none", ms: Date.now() - t0 });
      return this.info;
    } catch (err) {
      // Whatever had started goes again: no display, bus or cookie left behind.
      this.stop();
      throw err;
    }
  }

  /**
   * Starts Xvfb on :n. True once it is ready: its lock file names it (so the
   * display is its, not another server's) and Ember's own cookie opens it.
   * False if it exits first (another server has :n). (Not -displayfd: with it,
   * Xvfb writes no lock file, and other X servers could take the number.)
   */
  private async startDisplay(n: number, width: number, height: number, xauth: string): Promise<boolean> {
    const xvfb = spawn("Xvfb", [`:${n}`, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-auth", xauth, "-noreset"], { stdio: "ignore", detached: true });
    this.track(xvfb, "Xvfb");
    let exited = false;
    xvfb.once("exit", () => { exited = true; });
    xvfb.once("error", () => { exited = true; });
    const display = { display: `:${n}`, env: { XAUTHORITY: xauth } };
    for (const t0 = Date.now(); Date.now() - t0 < 5000; await new Promise(r => setTimeout(r, 25))) {
      if (exited || !running(xvfb.pid)) return false;
      if (realProbe.lockPid(n) !== xvfb.pid) continue;
      const probe = withDeskAuth(display, d => openX11(d));
      if (!probe) continue;
      probe.close();
      this.xvfb = xvfb;
      xvfb.once("exit", (code, sig) => { if (this.xvfb === xvfb) this.died(code, sig); });
      return true;
    }
    throw new Error("the desk display didn't start");
  }

  /** The display went away on its own: everyone stops using it before anything else, then the rest is torn down. */
  private died(code: number | null, sig: NodeJS.Signals | null): void {
    this.xvfb = null;
    this.log.warn("desk.died", { display: this.info?.display, code, signal: sig });
    for (const fn of [...this.deadFns]) {
      try { fn(`the desk display exited (${sig ?? code})`); } catch (err) { this.log.warn("desk.dead_handler_failed", { err }); }
    }
    this.stop();
  }

  /** Starts a program on the desk (never on the user's display). */
  run(argv: string[], extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
    if (!this.alive()) throw new Error("the desk isn't running");
    const child = spawn(argv[0], argv.slice(1), { env: { ...this.info!.env, ...extraEnv }, stdio: ["ignore", "ignore", "pipe"], cwd: this.info!.handOff, detached: true });
    this.track(child, path.basename(argv[0]));
    let err = "";
    child.stderr?.on("data", (d: Buffer) => { if (err.length < 4000) err += d.toString(); });
    child.on("exit", code => { if (code) this.log.warn("desk.app_exited", { app: path.basename(argv[0]), code, stderr: err.slice(-1500) }); });
    return child;
  }

  stop(): void {
    // Apps first, then the window manager, bus and display (reverse start order), each with what it started.
    const procs = [...this.procs].reverse();
    this.procs = [];
    this.xvfb = null;
    for (const p of procs) signal(p, "SIGTERM");
    // Only processes not yet exited: their ids (and groups) can't have been reused yet.
    setTimeout(() => { for (const p of procs) if (p.exitCode === null && p.signalCode === null) signal(p, "SIGKILL"); }, 1500).unref();
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
}

/**
 * Opens an X connection to the desk. libX11 reads XAUTHORITY when the
 * connection is made, so it is pointed at the desk's cookie just for the call.
 */
export function withDeskAuth<T>(desk: Pick<DeskInfo, "display" | "env">, open: (display: string) => T): T {
  const saved = process.env.XAUTHORITY;
  process.env.XAUTHORITY = desk.env.XAUTHORITY;
  try {
    return open(desk.display);
  } finally {
    if (saved === undefined) delete process.env.XAUTHORITY; else process.env.XAUTHORITY = saved;
  }
}
