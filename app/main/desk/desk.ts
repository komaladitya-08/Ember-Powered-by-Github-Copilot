/**
 * Ember's desk (tier 2): a private X display nobody looks at, with its own
 * D-Bus session (so its apps' accessibility lives on their own bus) and a
 * window manager if one is installed. Ember can use full mouse and keyboard
 * input there without ever touching the user's. It has its own clipboard (a
 * separate display), an auth cookie so other users can't connect, its own
 * user folders (so its apps never change the user's settings), and is torn
 * down completely when Ember quits. Ember itself makes no X call there: a
 * helper process does (agent.ts), so a dying desk can't take Ember with it.
 * Everything on the desk carries EMBER_DESK_ID in its environment, and the
 * desk's folder names its owner: a desk left behind by an Ember that was
 * killed is cleared away the next time one starts.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logger";
import { appEnv } from "../hands/system";
import { DeskAgent } from "./agent";

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
  alive: pid => running(pid), // a zombie X server (killed, not yet reaped) holds nothing: its lock is stale
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

/**
 * Does the X server on :n let this cookie in? A plain X11 handshake on its socket: no
 * Xlib in Ember, so nothing here can end Ember if the server goes away meanwhile.
 */
export function xAccepts(n: number, cookie: Buffer, timeoutMs = 1000): Promise<boolean> {
  const name = Buffer.from("MIT-MAGIC-COOKIE-1");
  const pad = (k: number) => (4 - (k % 4)) % 4;
  // Byte order "l" (little-endian), protocol 11.0, then the authorisation name and data, each padded to 4 bytes.
  const req = Buffer.alloc(12 + name.length + pad(name.length) + cookie.length + pad(cookie.length));
  req.write("l", 0);
  req.writeUInt16LE(11, 2);
  req.writeUInt16LE(name.length, 6);
  req.writeUInt16LE(cookie.length, 8);
  name.copy(req, 12);
  cookie.copy(req, 12 + name.length + pad(name.length));
  return new Promise(resolve => {
    const s = net.connect(`/tmp/.X11-unix/X${n}`);
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    s.once("connect", () => s.write(req));
    s.once("data", d => finish(d[0] === 1)); // 1: Success (0 Failed, 2 Authenticate)
    s.once("error", () => finish(false));
    s.once("close", () => finish(false));
  });
}

/** When a process started (clock ticks since boot): with its id, it tells a process from a later one given the same id. */
export function startTime(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  } catch {
    return null;
  }
}

/**
 * Processes of the desk `id`: those with EMBER_DESK_ID=<id> in their environment (however they
 * detached), and everyone in a recorded process group that one of them is in. Never Ember itself.
 */
export function deskProcesses(id: string, groups: number[] = []): number[] {
  const marker = Buffer.from(`EMBER_DESK_ID=${id}\0`);
  const self = (() => { try { const s = fs.readFileSync("/proc/self/stat", "utf8"); return Number(s.slice(s.lastIndexOf(")") + 2).split(" ")[2]); } catch { return -1; } })();
  const all: { pid: number; group: number; marked: boolean }[] = [];
  let names: string[];
  try { names = fs.readdirSync("/proc"); } catch { return []; }
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let env: Buffer, stat: string;
    try { env = fs.readFileSync(`/proc/${name}/environ`); stat = fs.readFileSync(`/proc/${name}/stat`, "utf8"); } catch { continue; } // gone, or another user's
    const at = env.indexOf(marker);
    all.push({ pid: Number(name), group: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]), marked: at === 0 || (at > 0 && env[at - 1] === 0) });
  }
  const ours = new Set(all.filter(p => p.marked && p.group !== self && groups.includes(p.group)).map(p => p.group));
  return all.filter(p => p.marked || ours.has(p.group)).map(p => p.pid);
}

function killAll(pids: number[], sig: NodeJS.Signals): void {
  for (const pid of pids) try { process.kill(pid, sig); } catch { /* gone */ }
}

/** Mount points (from /proc/self/mountinfo, unescaped). */
function mountPoints(): string[] {
  try {
    return fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter(Boolean)
      .map(l => l.split(" ")[4].replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))));
  } catch {
    return [];
  }
}

/** Lets go of a FUSE mount (gvfs, the document portal) even while it's busy. */
function lazyUnmount(p: string): void {
  for (const cmd of ["fusermount", "fusermount3"]) {
    try { execFileSync(cmd, ["-u", "-z", p], { stdio: "ignore", timeout: 3000 }); return; } catch { /* the other one, or not ours */ }
  }
}

/** LibreOffice's lock file for a document: ".~lock.<name>#" beside it. */
const LOCK_FILE = /^\.~lock\..+#$/;

/**
 * Removes LibreOffice's lock files in `dir` (and folders in it, a few levels down) that a desk's LibreOffice left:
 * those naming a desk's profile (`desk`: those desks' ids, else any desk's). A desk stopped with documents open leaves
 * them (LibreOffice doesn't remove them when it is signalled to end), and the user's own LibreOffice would then open
 * those documents read-only, "locked by" themselves. Never follows links; never throws. Returns how many went.
 * `o.depth`: folder levels below `dir` looked in (4); `o.hidden`: false leaves hidden folders out; `o.skip`: folders
 * not gone into. At most 5000 entries are looked at.
 */
export function clearDeskLocks(dir: string, desk?: string | string[], o: { depth?: number; hidden?: boolean; skip?: ReadonlySet<string> } = {}): number {
  const marks = desk === undefined ? ["ember-desk-"] : [desk].flat().filter(Boolean);
  if (!marks.length) return 0;
  const depthMax = o.depth ?? 4;
  let removed = 0, seen = 0;
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > 5000) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < depthMax && (o.hidden !== false || !e.name.startsWith(".")) && !o.skip?.has(p)) walk(p, depth + 1);
      } else if (e.isFile() && LOCK_FILE.test(e.name)) {
        try {
          // ",user,host,date,profile URL;": the profile is the desk's (its folder's name), never the user's own.
          const text = fs.readFileSync(p, "utf8").slice(0, 4096);
          if (marks.some(m => text.includes(m))) { fs.unlinkSync(p); removed++; }
        } catch { /* gone, or not ours to read */ }
      }
    }
  };
  walk(dir, 0);
  return removed;
}

/**
 * The locks a desk's LibreOffice left (`desk`: those desks', else any desk's), wherever its documents are likely to be:
 * the hand-off folder, and the home folder two folders down (a document opened or saved elsewhere there), leaving out
 * hidden folders and anything mounted there (a network share that doesn't answer would hold Ember up). Synchronous, so
 * it is done even when Ember exits right after. Returns how many went.
 */
export function clearDeskLocksNear(handOff: string, desk?: string | string[], home = os.homedir()): number {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  // (Mount points are real paths: so are the folders compared with them.)
  const skip = new Set([...mountPoints(), real(handOff)]);
  return clearDeskLocks(handOff, desk) + clearDeskLocks(real(home), desk, { depth: 2, hidden: false, skip });
}

/**
 * Removes a folder Ember made. Anything mounted inside it (gvfs's FUSE mount in the desk's
 * runtime folder, the document portal) is let go first, lazily; what can't be is left alone:
 * removal never reaches into a mount, which may show the user's own files. `keep`: names in
 * the folder itself to leave (the folder then stays too). Never throws; false if something else was left behind.
 */
export function removeTree(dir: string, o: { mounts?: () => string[]; unmount?: (p: string) => void; keep?: string[] } = {}): boolean {
  const mounted = (o.mounts ?? mountPoints)().filter(m => m === dir || m.startsWith(dir + "/"));
  for (const m of mounted.sort((a, b) => b.length - a.length)) try { (o.unmount ?? lazyUnmount)(m); } catch { /* left alone below */ }
  const still = new Set((o.mounts ?? mountPoints)());
  const gone = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";
  let root: fs.Stats;
  try { root = fs.lstatSync(dir); } catch (err) { return gone(err); }
  const remove = (p: string, st: fs.Stats): boolean => {
    if (st.dev !== root.dev || still.has(p)) return false; // a mount: never into it
    if (!st.isDirectory()) { try { fs.unlinkSync(p); return true; } catch (err) { return gone(err); } }
    // Folders made read-only there (LibreOffice's macro folders) are Ember's own: they can go too.
    if ((st.mode & 0o700) !== 0o700) try { fs.chmodSync(p, 0o700); } catch { /* not ours */ }
    let names: string[];
    try { names = fs.readdirSync(p); } catch (err) { return gone(err); }
    let all = true, kept = false;
    for (const n of names) {
      if (p === dir && o.keep?.includes(n)) { kept = true; continue; }
      const c = path.join(p, n);
      try { all = remove(c, fs.lstatSync(c)) && all; } catch (err) { all = gone(err) && all; }
    }
    if (!all || kept) return all;
    try { fs.rmdirSync(p); return true; } catch (err) { return gone(err); }
  };
  return remove(dir, root);
}

/** What the desk's folder says about who made it. */
interface Owner { pid: number; start: number | null; id: string; groups: number[] }
const OWNER = "owner.json";

/**
 * Desks left behind by an Ember that is gone (killed, or ended by a crash): their processes are
 * killed and their folders removed. Resolves once those processes have exited, so their display
 * numbers are free again. Desks of an Ember still running are left alone.
 */
export function reapDesks(log?: Logger, tmp = os.tmpdir()): Promise<number> {
  // One at a time: a desk starting waits for the clearing already under way.
  let p = reaping.get(tmp);
  if (!p) { p = reapNow(log, tmp).finally(() => reaping.delete(tmp)); reaping.set(tmp, p); }
  return p;
}
const reaping = new Map<string, Promise<number>>();

async function reapNow(log: Logger | undefined, tmp: string): Promise<number> {
  const victims: number[] = [];
  let names: string[];
  try { names = fs.readdirSync(tmp).filter(n => n.startsWith("ember-desk-")); } catch { return 0; }
  for (const name of names) {
    const dir = path.join(tmp, name);
    let owner: Owner;
    try {
      if (fs.lstatSync(dir).uid !== process.getuid?.()) continue; // another user's
      owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER), "utf8")) as Owner;
    } catch { continue; } // not a desk folder
    if (owner.id !== name || (running(owner.pid) && startTime(owner.pid) === owner.start)) continue;
    const pids = deskProcesses(owner.id, owner.groups ?? []);
    killAll(pids, "SIGKILL");
    victims.push(...pids);
    removeTree(dir);
    log?.info("desk.reaped", { desk: name, processes: pids.length });
  }
  for (const t0 = Date.now(); victims.some(p => running(p)) && Date.now() - t0 < 3000;) await new Promise(r => setTimeout(r, 25));
  return victims.length;
}

/** Signals a desk process and everything it started (each runs in its own process group). */
function signal(p: ChildProcess, sig: NodeJS.Signals): void {
  if (!p.pid) return;
  try { process.kill(-p.pid, sig); } catch { try { p.kill(sig); } catch { /* gone */ } }
}

export class DeskManager {
  private procs: ChildProcess[] = [];
  private dir: string | null = null;
  /** The desk's EMBER_DESK_ID (its folder's name). */
  private id: string | null = null;
  /** Process groups started for the desk (recorded in its folder for reapDesks()). */
  private groups = new Set<number>();
  private info: DeskInfo | null = null;
  private xvfb: ChildProcess | null = null;
  private helper: DeskAgent | null = null;
  private starting: Promise<DeskInfo> | null = null;
  private deadFns = new Set<(why: string) => void>();
  /** Desks stopped in the last moments, whose processes may still be quitting (id → folder). */
  private leaving = new Map<string, string>();
  /** Its clean-up as Ember exits (exitNow), listened for while a desk of its is up or still going. */
  private exitHook: (() => void) | null = null;

  /**
   * `profiles`: where the desk's own user folders live (default: a throw-away folder).
   * `env`: extra variables for everything on the desk (tests pass their fixtures' settings).
   * `display`: the first display number to try.
   * `agent`: the desk helper's script (default: desk-agent.cjs beside Ember's main script).
   */
  constructor(private log: Logger, private o: { width?: number; height?: number; handOff?: string; profiles?: string; env?: NodeJS.ProcessEnv; display?: number; agent?: string } = {}) {
    // Desks an earlier Ember left behind (it was killed) go as soon as Ember starts.
    void reapDesks(log);
  }

  /**
   * Listens for Ember's exit from the start of a desk until the last of its desks has gone (unwatchExit): one listener
   * per manager and only then, so a manager that has nothing to clean up adds none to `process` (one added by every
   * manager made and never removed went past Node's 10 and kept each manager alive).
   */
  private watchExit(): void {
    if (this.exitHook) return;
    this.exitHook = () => this.exitNow();
    process.once("exit", this.exitHook);
  }

  /** Stops listening once no desk is up and none is still going. */
  private unwatchExit(): void {
    if (!this.exitHook || this.id || this.leaving.size) return;
    process.removeListener("exit", this.exitHook);
    this.exitHook = null;
  }

  /**
   * Even if Ember exits without quitting cleanly, don't leave the desk running or its cookie on disk.
   * SIGTERM first (Xvfb then removes its lock and socket), a moment to go, then SIGKILL: Ember won't be
   * there to wait. A folder keeps its owner record if something still runs; the next Ember clears it.
   */
  private exitNow(): void {
    this.helper?.stop();
    for (const p of this.procs) signal(p, "SIGTERM");
    const desks = new Map(this.leaving);
    if (this.id && this.dir) {
      desks.set(this.id, this.dir);
      killAll(deskProcesses(this.id, [...this.groups]), "SIGTERM");
    }
    const left = (ms: number) => {
      const nap = new Int32Array(new SharedArrayBuffer(4));
      for (const t0 = Date.now(); ; Atomics.wait(nap, 0, 0, 10)) {
        const pids = [...desks.keys()].flatMap(id => deskProcesses(id));
        if (!pids.length || Date.now() - t0 >= ms) return pids;
      }
    };
    killAll(left(300), "SIGKILL");
    const still = left(200).length > 0;
    for (const dir of desks.values()) removeTree(dir, still ? { keep: [OWNER] } : {});
    // Their LibreOffice left its locks on the documents it had open: they go now (stop()'s later clearing won't come).
    if (desks.size) clearDeskLocksNear(this.handOff, [...desks.keys()]);
  }

  get running(): DeskInfo | null {
    return this.info;
  }

  /** Where Ember puts what it made for the user (~/Ember). */
  private get handOff(): string {
    return this.o.handOff ?? path.join(os.homedir(), "Ember");
  }

  /** The helper that makes the desk's X calls (null while the desk isn't running). */
  get agent(): DeskAgent | null {
    return this.info ? this.helper : null;
  }

  /** Is the desk up: its display, and the helper that talks to it? */
  alive(): boolean {
    return !!this.info && running(this.xvfb?.pid) && !!this.helper?.alive;
  }

  /** Calls `fn` when the desk dies on its own (its display or its helper; not when stopped). Returns a function that stops listening. */
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
    const handOff = this.handOff;
    fs.mkdirSync(handOff, { recursive: true });
    // A desk an earlier Ember left running (it was killed) goes first: its display number is free again.
    await reapDesks(this.log);
    // And the lock files its LibreOffice left beside documents (in the hand-off folder, or elsewhere in the home folder).
    const stale = clearDeskLocksNear(handOff);
    if (stale) this.log.info("desk.locks_cleared", { files: stale });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-desk-"));
    fs.chmodSync(dir, 0o700);
    this.dir = dir;
    this.id = path.basename(dir);
    this.groups = new Set();
    this.watchExit();
    this.record();
    try {
      // Every process on the desk carries this, however it detaches: stop() and reapDesks() find them by it.
      const marker = { EMBER_DESK_ID: this.id };
      // Only Ember (and processes it starts) may connect: an MIT cookie in a private file.
      const xauth = path.join(dir, "Xauthority");
      fs.writeFileSync(xauth, "", { mode: 0o600 });
      const cookie = crypto.randomBytes(16);
      let display = "";
      for (let attempt = 0, from = this.o.display ?? 90; !display; attempt++) {
        const n = freeDisplay(from);
        // On stdin, never on a command line: any user can read those in /proc.
        execFileSync("xauth", ["-f", xauth, "source", "-"], { input: `add :${n} . ${cookie.toString("hex")}\n`, stdio: ["pipe", "ignore", "ignore"] });
        if (await this.startDisplay(n, width, height, xauth, cookie, { ...appEnv(process.env, { session: false }), ...marker })) display = `:${n}`;
        else if (attempt >= 4) throw new Error("the desk display didn't start");
        else from = n + 1; // another X server took the number first
      }

      // The helper that makes every X call on the desk (Ember makes none).
      const agent = await DeskAgent.start(this.o.agent ?? path.join(__dirname, "desk-agent.cjs"),
        { ...appEnv(process.env, { session: false }), ...marker, DISPLAY: display, XAUTHORITY: xauth });
      this.helper = agent;
      agent.onExit(why => { if (this.helper === agent) this.died(why); });

      // The desk's own user folders: settings, data and caches of its apps and of the D-Bus
      // services they start (dconf writes settings for them) stay there, never in the user's.
      const home = path.join(profiles ?? path.join(dir, "profiles"), "xdg");
      const folders = { XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state") };
      for (const f of Object.values(folders)) fs.mkdirSync(f, { recursive: true, mode: 0o700 });
      // A session bus of its own: apps' D-Bus activation and the accessibility bus stay on the desk.
      const runtime = path.join(dir, "runtime");
      fs.mkdirSync(runtime, { mode: 0o700 });
      // Built from an allowlist: Ember's sign-in, keys and the user's agents never reach the desk.
      // The bus passes this environment to the services it starts, so accessibility is on for them too.
      const baseEnv: NodeJS.ProcessEnv = {
        ...appEnv(process.env, { session: false }), ...this.o.env, ...folders, ...marker, DISPLAY: display, XAUTHORITY: xauth, XDG_RUNTIME_DIR: runtime,
        // Every toolkit exposes accessibility on the desk.
        // (NO_AT_BRIDGE must be absent, not "0": GTK only checks that it exists.)
        GNOME_ACCESSIBILITY: "1", QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1", QT_ACCESSIBILITY: "1", ACCESSIBILITY_ENABLED: "1",
        GDK_BACKEND: "x11", QT_QPA_PLATFORM: "xcb", XDG_SESSION_TYPE: "x11",
      };
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

      const env: NodeJS.ProcessEnv = { ...baseEnv, DBUS_SESSION_BUS_ADDRESS: address };
      const wm = ["metacity", "openbox", "xfwm4"].find(c => which(c));
      let wmMs: number | null = null;
      if (wm) {
        const p = spawn(wm, wm === "metacity" ? ["--replace", "--no-composite"] : [], { env, stdio: "ignore", detached: true });
        this.track(p, wm);
        wmMs = await this.wmReady(agent, p, wm);
      }
      if (!running(this.xvfb?.pid) || !agent.alive) throw new Error("the desk display didn't start");

      this.info = { display, width, height, env, handOff };
      this.log.info("desk.started", { display, wm: wm ?? "none", wmMs, ms: Date.now() - t0 });
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
  private async startDisplay(n: number, width: number, height: number, xauth: string, cookie: Buffer, env: NodeJS.ProcessEnv): Promise<boolean> {
    const xvfb = spawn("Xvfb", [`:${n}`, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-auth", xauth, "-noreset"], { env, stdio: "ignore", detached: true });
    this.track(xvfb, "Xvfb");
    let exited = false;
    xvfb.once("exit", () => { exited = true; });
    xvfb.once("error", () => { exited = true; });
    for (const t0 = Date.now(); Date.now() - t0 < 5000; await new Promise(r => setTimeout(r, 25))) {
      if (exited || !running(xvfb.pid)) return false;
      if (realProbe.lockPid(n) !== xvfb.pid) continue;
      if (!(await xAccepts(n, cookie))) continue;
      this.xvfb = xvfb;
      xvfb.once("exit", (code, sig) => { if (this.xvfb === xvfb) this.died(`the desk display exited (${sig ?? code})`); });
      return true;
    }
    throw new Error("the desk display didn't start");
  }

  /**
   * Waits until the window manager manages new windows (see the helper's wm probe), 3 s at most: an app
   * whose window is mapped while it is still starting could stay unmanaged and unseen (openbox 3.6).
   * Not if it has exited (the desk then has none), and not with a helper that can't tell.
   * The time it took; null if it didn't get ready.
   */
  private async wmReady(agent: DeskAgent, wm: ChildProcess, name: string): Promise<number | null> {
    if (!agent.calls.wm?.includes("ready")) return null;
    const t0 = Date.now();
    try {
      for (;;) {
        if (agent.call<boolean>("wm", "ready")) return Date.now() - t0;
        if (!running(wm.pid) || Date.now() - t0 >= 3000) {
          this.log.warn("desk.wm_not_ready", { wm: name, exited: !running(wm.pid), ms: Date.now() - t0 });
          return null;
        }
        await new Promise(r => setTimeout(r, 15));
      }
    } catch {
      return null; // the helper has gone: the start fails just after
    } finally {
      try { if (agent.alive) agent.call("wm", "end"); } catch { /* gone meanwhile */ }
    }
  }

  /** The desk died on its own (its display or its helper): everyone stops using it before anything else, then the rest is torn down. */
  private died(why: string): void {
    if (!this.info) return;
    this.xvfb = null;
    this.log.warn("desk.died", { display: this.info.display, why });
    for (const fn of [...this.deadFns]) {
      try { fn(why); } catch (err) { this.log.warn("desk.dead_handler_failed", { err }); }
    }
    this.stop();
  }

  /** Starts a program on the desk (never on the user's display). */
  run(argv: string[], extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
    if (!this.alive()) throw new Error("the desk isn't running");
    const child = spawn(argv[0], argv.slice(1), { env: { ...this.info!.env, ...extraEnv, EMBER_DESK_ID: this.id! }, stdio: ["ignore", "ignore", "pipe"], cwd: this.info!.handOff, detached: true });
    this.track(child, path.basename(argv[0]));
    let err = "";
    child.stderr?.on("data", (d: Buffer) => { if (err.length < 4000) err += d.toString(); });
    child.on("exit", code => { if (code) this.log.warn("desk.app_exited", { app: path.basename(argv[0]), code, stderr: err.slice(-1500) }); });
    return child;
  }

  stop(): void {
    // Everything is let go first, so nothing below can leave the manager half stopped.
    const procs = [...this.procs].reverse(), dir = this.dir, id = this.id, groups = [...this.groups], info = this.info, helper = this.helper;
    this.procs = [];
    this.xvfb = null;
    this.helper = null;
    this.dir = null;
    this.id = null;
    this.info = null;
    if (id && dir) this.leaving.set(id, dir);
    setTimeout(() => {
      // Only processes not yet exited: their ids (and groups) can't have been reused yet.
      for (const p of procs) if (p.exitCode === null && p.signalCode === null) signal(p, "SIGKILL");
      if (id) { killAll(deskProcesses(id, groups), "SIGKILL"); this.leaving.delete(id); }
      // Its LibreOffice is gone: anything it locked meanwhile goes too.
      if (id && info) clearDeskLocksNear(info.handOff, id);
      // Apps that save as they quit may have put files back.
      if (dir && !removeTree(dir)) this.log.warn("desk.folder_left", { dir });
      this.unwatchExit();
    }, 1500).unref();
    helper?.stop();
    // Apps first, then the window manager, bus and display (reverse start order), each with what it started;
    // then whatever left its group (setsid) but carries the desk's mark.
    for (const p of procs) signal(p, "SIGTERM");
    if (id) killAll(deskProcesses(id, groups), "SIGTERM");
    // LibreOffice ends without removing its locks on the documents it had open, and the user's own would then open
    // them read-only, "locked by" themselves: they go now, as Ember may exit before the moment above.
    if (id && info) {
      const files = clearDeskLocksNear(info.handOff, id);
      if (files) this.log.info("desk.locks_cleared", { files });
    }
    // The cookie and everything else go now; the owner record stays until the desk's processes have gone.
    if (dir && !removeTree(dir, { keep: [OWNER] })) this.log.warn("desk.folder_left", { dir });
    if (info) this.log.info("desk.stopped", { display: info.display });
  }

  /** Writes who owns the desk into its folder (reapDesks() reads it). */
  private record(): void {
    if (!this.dir || !this.id) return;
    const owner: Owner = { pid: process.pid, start: startTime(process.pid), id: this.id, groups: [...this.groups] };
    try { fs.writeFileSync(path.join(this.dir, OWNER), JSON.stringify(owner), { mode: 0o600 }); } catch (err) { this.log.warn("desk.record_failed", { err }); }
  }

  private track(p: ChildProcess, name: string): void {
    this.procs.push(p);
    if (p.pid) { this.groups.add(p.pid); this.record(); }
    p.on("error", err => this.log.warn("desk.process_error", { name, err }));
    p.on("exit", () => { this.procs = this.procs.filter(x => x !== p); });
  }
}
