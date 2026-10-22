/**
 * The WSL router (§4.3-§4.6): one per main process, shared by the routed sidecar (routed-sidecar.ts) and the routed
 * window system (routed-windows.ts). It knows which RAIL window of WSLg's msrdc is which Linux window: it starts one
 * accessibility helper per running distro with a WSLg window on screen (launch-sidecar.ts), checks it runs as the
 * distro's own non-root user and has found the bus the apps use, lists the distro's frames, and matches them to the
 * RAIL windows (match.ts). What it can't match stays "msrdc", a remote surface: refused and masked as before.
 *
 * Fail-closed rules kept here: nothing happens off Windows, with WSL off, or without a WSL service; a distro is never
 * booted (a helper starts only after an uncached running list names its distro, and never again on its own after an
 * exit); a helper that reports uid 0 is stopped and never routed to; a Windows pid, skipPids or ownPid never goes into
 * a distro; whatever a distro says is validated before it is used; an identity is trusted for 2 s at most.
 */

import wpath from "node:path/win32";
import { FEATURE_CONSENT_VERSION } from "../../shared/consent";
import { NEVER_LOOK_DEFAULTS } from "../../shared/never-look";
import { LAUNCHERS } from "../hands/terminals";
import { isNeverLook } from "../perception/elements";
import { matchFrame } from "../perception/windows";
import type { AxWindow, Bounds } from "../perception/sidecar";
import type { PlatformDoctorRow, Rect, StackedWindow } from "../platform/types";
import type { WrapForWslOptions } from "./routed-sidecar";
import type { WslFacts, WslService } from "./types";
import {
  helperDoctorRows, helperFactory, helperScriptPath, parseHelperStatus,
  type DistroSidecar, type HelperFactory, type HelperProblem, type HelperStatusInfo,
} from "./launch-sidecar";
import { distroOfTitles, matchWindows, normaliseTitle, popupOwners, railTitle, type LinuxFrame, type RailWindow, type Transform } from "./match";
import { openRailProbe, railWindows, WslgPids, type RailProbe } from "./rail";

/** An identified WSLg window. */
export interface WslWindow {
  hwnd: number;
  /** msrdc.exe's pid: what Windows, the stack and the lists report. */
  pid: number;
  distro: string;
  /** "wsl:<distro>:<app>". */
  app: string;
  /** "wsl:<distro>:<linux pid>:<frame's object path>": names the window to the router (opaque elsewhere). */
  path: string;
  frame: LinuxFrame;
  /** null: identified by its unique title only (tier 1, no coordinates). */
  transform: Transform | null;
  /** The RAIL window's client area (physical pixels): the window's bounds in every list and read. */
  inner: Rect;
  railTitle: string;
}

/** What one look at the screen found (trusted for IDENTITY_MS). */
export interface Snapshot {
  at: number;
  windows: Map<number, WslWindow>;
  /** A popup's HWND → the identified window it belongs to (masking and covering only). */
  popups: Map<number, number>;
  /** Every WSLg RAIL window on screen, by HWND. */
  rails: Map<number, RailWindow>;
  /** Never-look windows (NEVER_LOOK_DEFAULTS.linux): left unidentified (masked, refused) and out of every list. */
  hidden: Map<number, { distro: string; linuxPid: number | null }>;
  /** The Windows stack it was made from (bottom to top). */
  stack: StackedWindow[];
  foreground: number;
}

/** How long an identity (and a transform) is trusted (§4.9 step 7). */
export const IDENTITY_MS = 2000;
/** A helper whose distro has shown no RAIL window this long is stopped (§4.3). */
export const IDLE_MS = 60_000;
/** How often the lifecycle is looked at while a helper runs. */
const TICK_MS = 10_000;
/** find_bus again for new unmatched RAIL windows at most this often per distro. */
const RESCAN_MS = 5000;
/** After a helper failed to start (no python3, no pyatspi, no path to the script), it isn't tried again for this long. */
const RETRY_MS = 30_000;
/** The most titles find_bus is given, and the most element ids remembered (their window, for mapping). */
const MAX_TITLES = 32;
const MAX_IDS = 50_000;

const EMPTY = (at: number, stack: StackedWindow[] = [], foreground = 0): Snapshot =>
  ({ at, windows: new Map(), popups: new Map(), rails: new Map(), hidden: new Map(), stack, foreground });

/** One distro's helper and what it found. */
interface DistroState {
  name: string;
  sidecar: DistroSidecar | null;
  /** May a new helper process start now (set only around the router's own start, after runningNow() named the distro). */
  allow: boolean;
  /** The helper process that passed the checks (its pid): any other process is checked again before use. */
  verifiedPid: number | null;
  readying: Promise<DistroSidecar | null> | null;
  status: HelperStatusInfo | null;
  problem: HelperProblem | null;
  bus: string | null;
  /** The RAIL windows find_bus was last given (a new unmatched one asks again), and when. */
  scanned: Set<number>;
  scannedAt: number;
  lastRail: number;
  /** Not started again before this (after a failure); root and no-WSLg wait for the distro to stop instead. */
  retryAt: number;
}

/** The parts of a router tests replace. */
export interface RouterDeps {
  rail: RailProbe | null;
  helpers: HelperFactory;
  now: () => number;
  every: (fn: () => void, ms: number) => { stop(): void };
}

/** A string the distro gave, kept only when it is a plain short name. */
function plain(v: unknown, max = 64): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= 256 && !/\p{Cc}/u.test(v) ? v.slice(0, max) : undefined;
}

/** A rectangle the distro gave, kept only when every part is a finite number. */
function rect(v: unknown): Bounds | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  return [b.x, b.y, b.width, b.height].every(n => typeof n === "number" && Number.isFinite(n))
    ? { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number } : null;
}

/** A frame as the helper lists it (§4.3 item 2), validated: anything malformed is left out (fail closed). */
export function linuxFrame(v: unknown): LinuxFrame | null {
  if (!v || typeof v !== "object") return null;
  const w = v as Record<string, unknown>;
  const path = plain(w.path, 256);
  if (!path || !path.startsWith("/")) return null;
  const pid = typeof w.pid === "number" && Number.isSafeInteger(w.pid) && w.pid > 0 ? w.pid : null;
  const children = Array.isArray(w.children) ? w.children.slice(0, 64).map(rect).filter((b): b is Bounds => !!b) : [];
  return {
    pid, path, app: typeof w.app === "string" ? w.app.slice(0, 200) : "", name: typeof w.name === "string" ? w.name.slice(0, 1000) : "",
    role: typeof w.role === "string" ? w.role.slice(0, 60) : "", active: w.active === true, bounds: rect(w.bounds), children,
    ...(plain(w.program) ? { program: plain(w.program) } : {}), ...(plain(w.argv0) ? { argv0: plain(w.argv0) } : {}),
    ...(plain(w.argv1) ? { argv1: plain(w.argv1) } : {}), ...(plain(w.comm, 16) ? { comm: plain(w.comm, 16) } : {}),
    ...(w.busy === true ? { busy: true } : {}),
  };
}

const lower = (s: string) => s.toLowerCase();
const basename = (s: string) => s.slice(s.lastIndexOf("/") + 1);
/** Without invisible format characters (zero-width, bidi controls): "gnome\u200b-terminal" is gnome-terminal. */
const visible = (s: string) => s.replace(/\p{Cf}+/gu, "");

/** A name fit for an app id: no colon, blank, control or invisible character (it is shown in questions and grants). */
const idPart = (s: string) => lower(visible(s).trim()).replace(/[\s:\p{Cc}]+/gu, "-").slice(0, 64);

/**
 * The window's app (§4.5): the program (/proc/<pid>/exe's basename), but for an interpreter or launcher (python3
 * running /usr/bin/terminator) its script's name, else the AT-SPI application name; lower case. null without any.
 */
export function linuxApp(f: Pick<LinuxFrame, "program" | "argv1" | "app">): string | null {
  const prog = f.program ? idPart(basename(f.program)) : "";
  const script = f.argv1 && !f.argv1.startsWith("-") ? idPart(basename(f.argv1)) : "";
  const name = prog && !LAUNCHERS.linux.test(prog) ? prog : script || idPart(f.app) || prog;
  return name || null;
}

/** Every name the window's Linux app goes by (exe, argv0, argv1, AT-SPI name, comm): the vocabulary union judges each. */
export function linuxNames(f: Pick<LinuxFrame, "program" | "argv0" | "argv1" | "app" | "comm">): string[] {
  const names = [f.program, f.argv0, f.argv1, f.comm].filter((n): n is string => !!n).map(n => lower(visible(basename(n))));
  if (visible(f.app).trim()) names.push(lower(visible(f.app).trim()));
  return [...new Set(names.filter(Boolean))];
}

/** "wsl:<distro>:<linux pid>:<path>" → its parts, or null. */
export function parseWslPath(path: string): { distro: string; pid: number; path: string } | null {
  const m = /^wsl:([A-Za-z0-9][A-Za-z0-9._-]{0,63}):(\d{1,10}):(\/.*)$/s.exec(path);
  return m ? { distro: m[1], pid: Number(m[2]), path: m[3] } : null;
}

/** Errors that mean the helper process is gone (it can be started again, with the checks). */
const GONE = /accessibility helper (not running|stopped|was restarted|could not run)/;

export class WslRouter {
  private states = new Map<string, DistroState>();
  private snap: Snapshot | null = null;
  private inflight: Promise<Snapshot> | null = null;
  private pidDistro = new Map<number, string>();
  private wslg: WslgPids;
  private ticker: { stop(): void } | null = null;
  private watched: WslService | null = null;
  private unwatch: (() => void) | null = null;
  /** Element id → the window path it came from (for mapping its bounds), oldest first. */
  private ids = new Map<number, string>();
  /** Every Linux name each app id went by (the vocabulary union reads it; it only grows). */
  readonly names = new Map<string, Set<string>>();
  private disposed = false;

  constructor(readonly o: WrapForWslOptions, private d: RouterDeps) {
    this.wslg = new WslgPids(d.rail);
  }

  /**
   * WSL is in use here: Windows, the user turned WSL on after its consent card (§7.4: a record of an older card, or
   * none, is off), and there is a WSL service (the admin allows it).
   */
  active(): boolean {
    if (this.disposed || this.o.os !== "win32") return false;
    try {
      const wsl = this.o.settings.get().targets?.wsl;
      if (wsl?.on !== true || !((wsl.consent?.version ?? 0) >= FEATURE_CONSENT_VERSION.wsl)) return false;
      return this.o.wsl() !== null;
    } catch {
      return false; // can't tell: off
    }
  }

  /** The service, watched for distros that stop. */
  private service(): WslService | null {
    let wsl: WslService | null;
    try {
      wsl = this.o.wsl();
    } catch {
      wsl = null;
    }
    if (wsl !== this.watched) {
      this.unwatch?.();
      this.unwatch = null;
      this.watched = wsl;
      if (wsl) {
        try {
          this.unwatch = wsl.onChange(f => this.factsChanged(f));
        } catch (err) {
          this.o.log.warn("wsl.watch_failed", { err });
        }
      }
    }
    return wsl;
  }

  private factsChanged(f: WslFacts): void {
    const running = new Set(f.distros.filter(d => d.running).map(d => d.name));
    for (const st of this.states.values()) if (!running.has(st.name)) this.forgetDistro(st, "stopped");
  }

  /** The last look, when it is fresh enough to trust (IDENTITY_MS); else null, and a new look starts. */
  fresh(): Snapshot | null {
    if (!this.active()) return null;
    const s = this.snap;
    if (s && this.d.now() - s.at <= IDENTITY_MS) return s;
    void this.refresh().catch(err => this.o.log.warn("wsl.refresh_failed", { err }));
    return null;
  }

  /** The app name of window `hwnd` (process `pid`), when identified now; `popups`: a popup takes its window's. */
  identityNow(hwnd: number, pid: number | null, popups: boolean): string | null {
    const s = this.fresh();
    if (!s) return null;
    const own = s.windows.get(hwnd);
    if (own) return own.pid === pid ? own.app : null;
    if (!popups) return null;
    const owner = s.popups.get(hwnd);
    const rail = s.rails.get(hwnd);
    const w = owner !== undefined ? s.windows.get(owner) : undefined;
    return w && rail && rail.pid === pid ? w.app : null;
  }

  /** A new look (coalesced: callers while one runs share it). */
  refresh(): Promise<Snapshot> {
    this.inflight ??= this.look().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** The snapshot, refreshed when older than IDENTITY_MS. */
  async current(): Promise<Snapshot> {
    const s = this.snap;
    return s && this.d.now() - s.at <= IDENTITY_MS ? s : this.refresh();
  }

  private state(name: string): DistroState {
    let st = this.states.get(name);
    if (!st) {
      st = { name, sidecar: null, allow: false, verifiedPid: null, readying: null, status: null, problem: null, bus: null, scanned: new Set(), scannedAt: -Infinity, lastRail: -Infinity, retryAt: -Infinity };
      this.states.set(name, st);
    }
    return st;
  }

  private stackNow(): StackedWindow[] {
    try {
      return this.o.ws()?.stack() ?? [];
    } catch (err) {
      this.o.log.warn("wsl.stack_failed", { err });
      return [];
    }
  }

  private foregroundNow(): number {
    try {
      return this.o.ws()?.activeWindow()?.id ?? 0;
    } catch {
      return 0;
    }
  }

  private async look(): Promise<Snapshot> {
    const at = this.d.now();
    if (!this.active()) {
      this.stopAll("off");
      return (this.snap = EMPTY(at));
    }
    const wsl = this.service()!;
    const stack = this.stackNow();
    const foreground = this.foregroundNow();
    const pids = this.wslg.of(stack);
    const rails = railWindows(stack, pids, this.d.rail);
    for (const p of [...this.pidDistro.keys()]) if (!pids.has(p)) this.pidDistro.delete(p);
    if (!rails.length) return (this.snap = EMPTY(at, stack, foreground));
    let facts: WslFacts;
    try {
      facts = await wsl.facts();
    } catch (err) {
      this.o.log.warn("wsl.facts_failed", { err });
      return (this.snap = EMPTY(at, stack, foreground));
    }
    const running = (n: string) => { try { return wsl.isRunning(n); } catch { return false; } };
    // Distros that can show Linux apps now: WSL 2, set up, not a tool's, not known to run as root, running.
    const candidates = facts.distros.filter(d => d.version === 2 && !d.needsSetup && !d.tool && d.defaultUid !== 0 && running(d.name)).map(d => d.name);
    // Every running WSL 2 distro may show Linux apps, root's and a tool's too (never read for): msrdc's windows are
    // all one distro's only when no other runs.
    const showing = facts.distros.filter(d => d.version === 2 && running(d.name)).length;
    const known = new Set(candidates);
    for (const [p, n] of [...this.pidDistro]) if (!known.has(n)) this.pidDistro.delete(p);
    const byPid = new Map<number, RailWindow[]>();
    for (const r of rails) byPid.set(r.pid, [...byPid.get(r.pid) ?? [], r]);
    const unresolved = [...byPid.keys()].filter(p => !this.pidDistro.has(p));
    if (candidates.length === 1 && showing === 1) for (const p of unresolved.splice(0)) this.pidDistro.set(p, candidates[0]);
    const consult = new Set<string>([...byPid.keys()].map(p => this.pidDistro.get(p)).filter((n): n is string => !!n));
    if (unresolved.length) for (const n of candidates) consult.add(n);
    const titlesFor = (n: string) => {
      const mine = rails.filter(r => !r.popup && (this.pidDistro.get(r.pid) === n || unresolved.includes(r.pid)));
      return [...new Set(mine.map(r => railTitle(r.title, [n])).filter(Boolean))].slice(0, MAX_TITLES);
    };
    const frames = new Map<string, LinuxFrame[]>();
    await Promise.all([...consult].map(async n => {
      const st = this.state(n);
      st.lastRail = at;
      const f = await this.framesOf(st, wsl, facts, titlesFor(n));
      if (f) frames.set(n, f);
    }));
    this.ensureTicker();
    for (const p of unresolved) {
      const n = distroOfTitles(byPid.get(p)!.filter(r => !r.popup).map(r => r.title), frames);
      if (n) this.pidDistro.set(p, n);
    }
    const snap = EMPTY(at, stack, foreground);
    for (const r of rails) snap.rails.set(r.hwnd, r);
    // Linux's defaults and the user's (and administrator's) own list, against every name the app goes by: a window any
    // of them names stays "msrdc" (masked and refused), not only one whose app id or title says it.
    const listed = this.userNeverLook();
    if (!listed) return (this.snap = snap); // can't tell which apps are never to be looked at: none identified
    const neverLook = [...NEVER_LOOK_DEFAULTS.linux, ...listed];
    for (const [n, fs] of frames) {
      const mine = rails.filter(r => this.pidDistro.get(r.pid) === n);
      if (!mine.length) continue;
      // A frame without a process can't be read by its path (pid and path name a window together): never matched.
      const matched = matchWindows(mine, fs.filter(f => f.pid !== null), { distro: n, foreground });
      for (const m of matched.values()) {
        const app = linuxApp(m.frame);
        const names = linuxNames(m.frame);
        const rail = snap.rails.get(m.hwnd)!;
        if (!app) continue;
        // Never-look apps (KeePassXC, Seahorse, polkit…): stay "msrdc" (masked, refused) and out of every list.
        if (names.some(x => isNeverLook({ app: x, name: m.frame.name }, neverLook)) || isNeverLook({ app, name: m.frame.name }, neverLook)) {
          snap.hidden.set(m.hwnd, { distro: n, linuxPid: m.frame.pid });
          continue;
        }
        const id = `wsl:${n}:${app}`;
        this.rememberNames(id, names);
        snap.windows.set(m.hwnd, {
          hwnd: m.hwnd, pid: rail.pid, distro: n, app: id, path: `wsl:${n}:${m.frame.pid}:${m.frame.path}`, frame: m.frame,
          transform: m.transform, inner: rail.inner, railTitle: railTitle(rail.title, [n]),
        });
      }
      // RAIL windows nothing matched (a new app, or the bus was wrong): find_bus again, in the background.
      const unmatched = mine.filter(r => !r.popup && !matched.has(r.hwnd));
      const st = this.state(n);
      if (unmatched.some(r => !st.scanned.has(r.hwnd)) && at - st.scannedAt >= RESCAN_MS && st.sidecar && st.verifiedPid !== null) {
        void this.rescan(st, titlesFor(n), mine.map(r => r.hwnd));
      }
    }
    const order = rails;
    for (const [popup, owner] of popupOwners(order, new Set(snap.windows.keys()), h => this.d.rail?.owner(h) ?? 0)) snap.popups.set(popup, owner);
    return (this.snap = snap);
  }

  /** The never-look list in the settings (the user's and the administrator's entries); null when it can't be read. */
  private userNeverLook(): string[] | null {
    try {
      const list: unknown = this.o.settings.get().privacy?.neverLook ?? [];
      return Array.isArray(list) ? list.filter((i): i is string => typeof i === "string" && !!i.trim()) : null;
    } catch {
      return null;
    }
  }

  private rememberNames(id: string, names: string[]): void {
    const key = lower(id);
    const set = this.names.get(key) ?? new Set<string>();
    for (const n of names) set.add(n);
    this.names.delete(key);
    this.names.set(key, set);
    while (this.names.size > 256) this.names.delete(this.names.keys().next().value!);
  }

  /** The distro's frames, from its checked helper; null when there is none (yet), or it can't say. */
  private async framesOf(st: DistroState, wsl: WslService, facts: WslFacts, titles: string[]): Promise<LinuxFrame[] | null> {
    const sc = await this.ready(st, wsl, facts, titles);
    if (!sc) return null;
    if (st.bus === "none") {
      // No bus showed these windows when the helper started (an app not yet on its accessibility bus): asked again
      // now and then while Linux windows are on screen, as for windows nothing matched.
      if (!titles.length || this.d.now() - st.scannedAt < RESCAN_MS) return null;
      await this.rescan(st, titles, []);
      if (st.bus === "none" || !st.sidecar || st.sidecar !== sc) return null;
    }
    try {
      const res = await sc.listWindows({});
      const list = Array.isArray((res as { windows?: unknown }).windows) ? (res as { windows: unknown[] }).windows : [];
      return list.slice(0, 500).map(linuxFrame).filter((f): f is LinuxFrame => !!f);
    } catch (err) {
      this.o.log.warn("wsl.list_failed", { distro: st.name, err: String(err) });
      return null;
    }
  }

  /**
   * The distro's helper, checked: started if none runs (only once an uncached running list names the distro), its
   * status read (uid 0 → stopped for good while the distro runs; no /mnt/wslg or no pyatspi → stopped), and its bus
   * chosen by `titles` (find_bus). null when it can't be used now.
   */
  private ready(st: DistroState, wsl: WslService, facts: WslFacts, titles: string[]): Promise<DistroSidecar | null> {
    if (st.sidecar && st.verifiedPid !== null && st.sidecar.pid === st.verifiedPid) return Promise.resolve(st.sidecar);
    st.readying ??= this.start(st, wsl, facts, titles).finally(() => { st.readying = null; });
    return st.readying;
  }

  private async start(st: DistroState, wsl: WslService, facts: WslFacts, titles: string[]): Promise<DistroSidecar | null> {
    // Root and no WSLg hold until the distro stops; the rest are tried again now and then (the user may install python3).
    if (st.problem === "root" || st.problem === "nowslg" || st.problem === "missing" || this.d.now() < st.retryAt) return null;
    if (!facts.wslExe) return null;
    let names: Set<string>;
    try {
      names = await wsl.runningNow();
    } catch {
      return null; // can't tell whether it runs: never boot it
    }
    if (!names.has(st.name) || !this.active()) return null;
    if (!st.sidecar) {
      const made = await this.d.helpers.create(st.name, facts.wslExe, () => st.allow && this.mayStart(st.name));
      if ("problem" in made) {
        st.problem = made.problem;
        st.retryAt = this.d.now() + RETRY_MS;
        return null;
      }
      st.sidecar = made;
    }
    const sc = st.sidecar;
    st.verifiedPid = null;
    let status: HelperStatusInfo;
    try {
      st.allow = true;
      const asked = sc.request("status", {});
      st.allow = false;
      status = parseHelperStatus(await asked);
    } catch (err) {
      st.allow = false;
      this.o.log.warn("wsl.helper_start_failed", { distro: st.name, err: String(err) });
      st.problem = "start";
      st.retryAt = this.d.now() + RETRY_MS;
      this.stopHelper(st);
      return null;
    }
    st.status = status;
    if (status.uid === null || status.uid === 0) {
      // Root (or a helper that won't say): never routed to (L17, critique wsl-7).
      if (status.uid === 0) st.problem = "root";
      else {
        st.problem = "start";
        st.retryAt = this.d.now() + RETRY_MS;
      }
      this.stopHelper(st);
      return null;
    }
    if (status.wslg === false) {
      st.problem = "nowslg";
      this.stopHelper(st);
      return null;
    }
    if (status.pyatspi === false) {
      st.problem = "pyatspi";
      st.retryAt = this.d.now() + RETRY_MS;
      this.stopHelper(st);
      return null;
    }
    const bus = await this.findBus(st, sc, titles);
    if (bus === "restart") return null;
    if (sc.pid === null) {
      // It went while choosing its bus (find_bus took too long and it was ended): not started again on every look.
      st.problem = "start";
      st.retryAt = this.d.now() + RETRY_MS;
      this.stopHelper(st);
      return null;
    }
    st.verifiedPid = sc.pid;
    st.problem = bus === "none" ? "bus" : null;
    return sc;
  }

  /** find_bus with `titles`: the bus chosen, "restart" when the helper must start over on another bus. */
  private async findBus(st: DistroState, sc: DistroSidecar, titles: string[]): Promise<string | "restart"> {
    st.scannedAt = this.d.now();
    let res: unknown;
    try {
      res = await sc.request("find_bus", { titles }, 15_000);
    } catch (err) {
      this.o.log.warn("wsl.find_bus_failed", { distro: st.name, err: String(err) });
      st.bus = "none";
      return "none";
    }
    const r = (res && typeof res === "object" ? res : {}) as { bus?: unknown; restart?: unknown };
    if (r.restart === true) {
      // Another bus fits the windows better and this process has the old one loaded: a new process picks it.
      this.stopHelper(st);
      return "restart";
    }
    st.bus = typeof r.bus === "string" && ["env", "proc", "runtime", "x11"].includes(r.bus) ? r.bus : "none";
    if (st.status) st.status = { ...st.status, bus: st.bus as HelperStatusInfo["bus"] };
    return st.bus;
  }

  private async rescan(st: DistroState, titles: string[], hwnds: number[]): Promise<void> {
    st.scanned = new Set(hwnds);
    const sc = st.sidecar;
    if (!sc) return;
    const bus = await this.findBus(st, sc, titles);
    if (bus !== "restart" && (st.problem === null || st.problem === "bus")) st.problem = bus === "none" ? "bus" : null;
  }

  /** The design's mayStart: the distro runs and WSL is on (the router's own gate, `allow`, comes first). */
  private mayStart(distro: string): boolean {
    if (!this.active()) return false;
    try {
      return this.o.wsl()?.isRunning(distro) === true;
    } catch {
      return false;
    }
  }

  /** Stops a distro's helper process (it may be started again later, with every check). */
  private stopHelper(st: DistroState): void {
    const sc = st.sidecar;
    st.sidecar = null;
    st.verifiedPid = null;
    st.bus = null;
    st.scanned = new Set();
    st.allow = false;
    try {
      sc?.stop();
    } catch (err) {
      this.o.log.warn("wsl.helper_stop_failed", { distro: st.name, err });
    }
  }

  /** The distro stopped (or WSL went off): its helper goes and what was learnt about it is forgotten. */
  private forgetDistro(st: DistroState, why: string): void {
    if (st.sidecar) this.o.log.info("wsl.helper_stopped", { distro: st.name, why });
    this.stopHelper(st);
    st.status = null;
    st.retryAt = -Infinity;
    if (st.problem !== "missing") st.problem = null;
    for (const [p, n] of [...this.pidDistro]) if (n === st.name) this.pidDistro.delete(p);
  }

  private ensureTicker(): void {
    if (this.ticker || ![...this.states.values()].some(s => s.sidecar)) return;
    this.ticker = this.d.every(() => this.tick(), TICK_MS);
  }

  /** The lifecycle (§4.3): helpers of distros that stopped, of WSL turned off, or idle for IDLE_MS go. */
  tick(): void {
    const now = this.d.now();
    const on = this.active();
    if (on) {
      // A distro whose RAIL windows are still on screen isn't idle, whether or not anyone looked.
      const stack = this.stackNow();
      const pids = this.wslg.of(stack);
      for (const p of pids) {
        const n = this.pidDistro.get(p);
        if (n) this.state(n).lastRail = now;
      }
    }
    for (const st of this.states.values()) {
      if (!st.sidecar) continue;
      if (!on) this.forgetDistro(st, "off");
      else if (!this.mayStart(st.name)) this.forgetDistro(st, "stopped");
      else if (now - st.lastRail > IDLE_MS) {
        this.o.log.info("wsl.helper_stopped", { distro: st.name, why: "idle" });
        this.stopHelper(st);
      }
    }
    if (![...this.states.values()].some(s => s.sidecar)) {
      this.ticker?.stop();
      this.ticker = null;
    }
  }

  /** Every helper stops (the kill switch, WSL turned off); they start again when a Linux window needs reading. */
  stopAll(why: string): void {
    for (const st of this.states.values()) if (st.sidecar) this.forgetDistro(st, why);
    this.snap = null;
  }

  dispose(): void {
    this.stopAll("quit");
    this.disposed = true;
    this.ticker?.stop();
    this.ticker = null;
    this.unwatch?.();
    this.unwatch = null;
  }

  /** The helper processes running now (Ember's own: a command may never stop them). */
  pids(): number[] {
    return [...this.states.values()].map(s => s.sidecar?.pid ?? null).filter((p): p is number => p !== null);
  }

  // ───────────── What the routed sidecar uses ─────────────

  /** The distro whose helper handed out element `id`, or null. */
  distroOfId(id: number): string | null {
    for (const st of this.states.values()) if (st.sidecar?.ownsId(id)) return st.name;
    return null;
  }

  /**
   * Calls `fn` on the distro's helper, checked (and started if it isn't running and the distro runs); once more after
   * the helper had gone. Throws when there is none.
   */
  async withHelper<T>(distro: string, fn: (sc: DistroSidecar) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const sc = await this.helperOf(distro);
      if (!sc) throw new Error(`Ember can't read Linux apps in ${distro} right now.`);
      try {
        return await fn(sc);
      } catch (err) {
        if (attempt > 0 || !(err instanceof Error) || !GONE.test(err.message)) throw err;
        const st = this.states.get(distro);
        if (st && st.sidecar && st.sidecar.pid !== st.verifiedPid) st.verifiedPid = null;
      }
    }
  }

  /** The distro's checked helper, if it can have one now (never booting the distro). */
  private async helperOf(distro: string): Promise<DistroSidecar | null> {
    if (!this.active()) return null;
    const wsl = this.service();
    if (!wsl) return null;
    const st = this.state(distro);
    if (st.sidecar && st.verifiedPid !== null && st.sidecar.pid === st.verifiedPid && st.bus !== "none") return st.sidecar;
    let facts: WslFacts;
    try {
      facts = await wsl.facts();
    } catch {
      return null;
    }
    const d = facts.distros.find(x => x.name === distro);
    if (!d || d.version !== 2 || d.needsSetup || d.tool || d.defaultUid === 0) return null;
    const titles = [...(this.snap?.rails.values() ?? [])].filter(r => !r.popup && this.pidDistro.get(r.pid) === distro).map(r => railTitle(r.title, [distro])).filter(Boolean);
    const sc = await this.ready(st, wsl, facts, [...new Set(titles)].slice(0, MAX_TITLES));
    return sc && st.bus !== "none" ? sc : null;
  }

  /** The identified window `path` names, from a look at most IDENTITY_MS old (null: gone or no longer identified). */
  async windowAt(path: string): Promise<WslWindow | null> {
    const s = await this.current();
    for (const w of s.windows.values()) if (w.path === path) return w;
    return null;
  }

  /**
   * Which identified window a read names: a "wsl:" path (or gone: "gone"), a WSLg msrdc pid with the title of exactly one
   * identified window (or, without a title, the foreground one), or with nothing at all the foreground window when it
   * is identified. "base": UIA's to read (another app, or a RAIL window nobody identified). "private": a never-look
   * Linux window (hidden), which nobody reads, not even by its title through UIA.
   */
  async target(params: { pid?: number; title?: string; path?: string }): Promise<WslWindow | "gone" | "base" | "private"> {
    const s = await this.current();
    if (params.path?.startsWith("wsl:")) {
      for (const w of s.windows.values()) if (w.path === params.path) return w;
      return "gone";
    }
    // Another reader's path (UIA's) names exactly one window of its own: never a Linux window found by pid instead.
    if (params.path) return "base";
    const all = [...s.windows.values()];
    if (params.pid == null && !params.title && !params.path) return s.hidden.has(s.foreground) ? "private" : s.windows.get(s.foreground) ?? "base";
    if (params.pid == null || ![...s.rails.values()].some(r => r.pid === params.pid)) return "base";
    const hidden = [...s.hidden.keys()].map(h => s.rails.get(h)).filter((r): r is RailWindow => !!r && r.pid === params.pid);
    if (!params.title) {
      if (hidden.some(r => r.hwnd === s.foreground)) return "private";
      return all.find(w => w.pid === params.pid && w.hwnd === s.foreground) ?? "base";
    }
    const named = (rail: string, distro: string) => {
      const want = lower(railTitle(rail, [distro]));
      return want === lower(railTitle(params.title!, [distro])) || lower(normaliseTitle(rail)) === lower(normaliseTitle(params.title!));
    };
    if (hidden.some(r => named(r.title, s.hidden.get(r.hwnd)!.distro))) return "private";
    const mine = all.filter(w => w.pid === params.pid);
    const t = lower(normaliseTitle(params.title));
    const hits = mine.filter(w => lower(w.railTitle) === t || lower(normaliseTitle(w.frame.name)) === t || lower(railTitle(params.title!, [w.distro])) === lower(w.railTitle));
    if (hits.length === 1) return hits[0];
    return hits.find(w => w.hwnd === s.foreground) ?? "base";
  }

  /**
   * The Linux pids of `distro`'s never-look windows (the distro's own skipPids): the hidden ones (Linux's defaults), and
   * the identified ones the user's list (`neverLook`) names by any name their app goes by.
   */
  skipPids(distro: string, neverLook: readonly string[] = []): number[] {
    const s = this.snap;
    if (!s) return [];
    const list = neverLook.filter(i => i.trim());
    const listed = [...s.windows.values()].filter(w => w.distro === distro && w.frame.pid !== null && list.length
      && [w.app, ...linuxNames(w.frame)].some(n => isNeverLook({ app: n, name: w.frame.name }, list)));
    return [...new Set([...[...s.hidden.values()].filter(h => h.distro === distro && h.linuxPid !== null).map(h => h.linuxPid!), ...listed.map(w => w.frame.pid!)])];
  }

  /** Remembers which window these element ids came from (for mapping their bounds later). */
  rememberIds(ids: number[], path: string): void {
    for (const id of ids) {
      this.ids.delete(id);
      this.ids.set(id, path);
    }
    while (this.ids.size > MAX_IDS) this.ids.delete(this.ids.keys().next().value!);
  }

  /** The window element `id` came from. */
  pathOfId(id: number): string | null {
    return this.ids.get(id) ?? null;
  }

  /**
   * Is UIA's window `w` a RAIL window the router speaks for (identified or never-look), so the routed list leaves it out?
   * By its frame in the stack, else (UIA's bounds didn't place it) by its pid and title.
   */
  covers(w: Pick<AxWindow, "pid" | "name" | "bounds">, s: Snapshot): boolean {
    if (w.pid == null || ![...s.rails.values()].some(r => r.pid === w.pid)) return false;
    const spoken = (h: number) => s.windows.has(h) || s.hidden.has(h) || s.popups.has(h);
    const railStack = s.stack.filter(x => s.rails.has(x.id));
    const m = matchFrame(w, railStack);
    if (m) return spoken(m.window.id);
    return [...s.rails.values()].some(r => r.pid === w.pid && normaliseTitle(r.title) === normaliseTitle(w.name) && spoken(r.hwnd));
  }

  // ───────────── The doctor ─────────────

  /** The doctor's rows for every running WSL 2 distro (§8.8), looking inside each without booting any. */
  async doctorRows(): Promise<PlatformDoctorRow[]> {
    if (this.o.os !== "win32") return [];
    const wsl = this.service();
    if (!wsl) return [];
    let facts: WslFacts;
    try {
      facts = await wsl.facts();
    } catch {
      return [];
    }
    let running: Set<string>;
    try {
      running = await wsl.runningNow();
    } catch {
      running = new Set();
    }
    const rows: PlatformDoctorRow[] = [];
    for (const d of facts.distros) {
      if (d.version !== 2 || d.needsSetup || d.tool || !running.has(d.name)) continue;
      const st = this.states.get(d.name);
      const missing = !this.d.helpers.present();
      const diag = missing || !facts.wslExe ? null : await this.d.helpers.diag(d.name, facts.wslExe).catch(() => null);
      rows.push(...helperDoctorRows(d.name, { missing, diag, known: st ? { problem: st.problem, status: st.status } : null }));
    }
    return rows;
  }
}

// ───────────── One router per main process ─────────────

const ROUTERS = new WeakMap<WrapForWslOptions, WslRouter>();
const LIVE = new Set<WslRouter>();
let latest: WslRouter | null = null;

/** Where this install's helper script is (the packaged resources, else the source tree beside dist/app). */
function defaultScript(): string | null {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath ?? null;
  const appDir = typeof __dirname === "string" ? __dirname : null;
  return helperScriptPath({ resourcesPath, appDir });
}

/** The real dependencies (this process's environment, Ember's job host beside main.cjs, koffi on Windows). */
function defaultDeps(o: WrapForWslOptions): RouterDeps {
  const extra = o.helper ?? {};
  const jobHost = extra.jobHost !== undefined ? extra.jobHost
    : o.os === "win32" && typeof __dirname === "string" ? { execPath: process.execPath, script: wpath.join(__dirname, "job-host.cjs") } : null;
  return {
    rail: o.os === "win32" ? openRailProbe(o.os) : null,
    helpers: helperFactory({ os: o.os, log: o.log.child("helper"), script: () => (extra.script !== undefined ? extra.script : defaultScript()), jobHost, env: extra.env ?? process.env }),
    now: () => Date.now(),
    every: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return { stop: () => clearInterval(t) }; },
  };
}

/** The router for these options (one per options object: main passes the same one to both wrappers). */
export function routerFor(o: WrapForWslOptions, deps?: RouterDeps): WslRouter {
  let r = ROUTERS.get(o);
  if (!r) {
    r = new WslRouter(o, deps ?? defaultDeps(o));
    ROUTERS.set(o, r);
    LIVE.add(r);
    latest = r;
  }
  return r;
}

/** The router main made last (the system's app catalogue and the vocabulary union read WSL through it). */
export function currentRouter(): WslRouter | null {
  return latest;
}

/** Every Linux name an identified app id ("wsl:<distro>:<app>") went by, as the routers saw them. */
export function wslNamesOf(app: string): string[] {
  const key = lower(app.trim());
  const out = new Set<string>();
  for (const r of LIVE) for (const n of r.names.get(key) ?? []) out.add(n);
  return [...out];
}

/** The kill switch's part for WSL helpers (TG calls it with every helper's stop): they start again when needed. */
export function stopWslHelpers(): void {
  for (const r of LIVE) r.stopAll("killswitch");
}

/** The pids of every WSL helper running now (TG's emberPids: a command may never stop Ember's own helpers). */
export function wslHelperPids(): number[] {
  return [...LIVE].flatMap(r => r.pids());
}

/** The doctor's WSL helper rows (TG's targetDoctorRows adds them): wsl-helper:<distro> and wsl-a11y:<distro>. */
export async function wslHelperDoctorRows(): Promise<PlatformDoctorRow[]> {
  return latest ? latest.doctorRows() : [];
}

/**
 * The same rows where no router runs (`ember --doctor`, a process of its own): a short-lived router over `wsl` with no
 * window probe and nothing to read settings from (its rows need neither), let go at once. Like a running router's, it
 * only looks inside distros already running (the diagnosis script); nothing is started there and no distro is booted.
 */
export async function doctorHelperRows(o: {
  os: WrapForWslOptions["os"]; log: WrapForWslOptions["log"]; wsl: WslService; resourcesPath: string | null; appDir: string | null; env: NodeJS.ProcessEnv;
  /** The router's parts (tests); default: the real helper factory without a job host, no RAIL probe. */
  helpers?: RouterDeps["helpers"];
}): Promise<PlatformDoctorRow[]> {
  if (o.os !== "win32") return [];
  const settings = { get: () => { throw new Error("the doctor reads no settings"); } } as unknown as WrapForWslOptions["settings"];
  const helpers = o.helpers ?? helperFactory({ os: o.os, log: o.log, script: () => helperScriptPath({ resourcesPath: o.resourcesPath, appDir: o.appDir }), jobHost: null, env: o.env });
  const r = new WslRouter({ os: o.os, log: o.log, ws: () => null, wsl: () => o.wsl, settings }, { rail: null, helpers, now: () => Date.now(), every: () => ({ stop: () => undefined }) });
  try {
    return await r.doctorRows();
  } finally {
    r.dispose();
  }
}

/** Forgets a router (its routed sidecar was stopped). */
export function dropRouter(r: WslRouter): void {
  r.dispose();
  LIVE.delete(r);
  if (latest === r) latest = null;
}
