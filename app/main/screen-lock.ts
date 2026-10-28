/**
 * Whether this computer's screen is locked, or its session isn't the one in front (another user's, or the login
 * screen): while it is, Ember stops listening and speaking, takes no requests and doesn't read or act on its desktop,
 * as it does for a remote computer whose screen locks (review #81). Electron's lock-screen and unlock-screen events
 * tell it on Windows and macOS. On Linux they don't come, and the X screensaver doesn't see GNOME's lock shield, so
 * logind's LockedHint (which GNOME Shell sets) and Active tell it: read with loginctl, and watched by one `gdbus monitor`
 * for the whole session (read every 5 s only where gdbus is missing). Plain Node: the events, the programs and the
 * clock are passed in.
 */

import { execFile, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { Hands } from "./agent/host";
import type { PerceptionPort, SidecarPort } from "./perception/ports";

/** Electron's powerMonitor, as far as the lock goes. */
export interface LockEvents {
  on(event: "lock-screen" | "unlock-screen", listener: () => void): unknown;
}

/** Runs a program and gives its output, or null when it couldn't run or failed. */
export type RunText = (cmd: string, args: string[]) => Promise<string | null>;

/** Starts a long-running program whose output is read line by line. */
export type SpawnLines = (cmd: string, args: string[], o: { stdio: ["ignore", "pipe", "ignore"]; env: NodeJS.ProcessEnv }) => ChildProcess;

/** loginctl's and gdbus's words are always read in English (gdbus's messages are translated). */
const C_LOCALE = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: "C" });

/** RunText on this system: null too when the program took over 2 s. */
export const execText: RunText = (cmd, args) => new Promise(resolve => {
  execFile(cmd, args, { encoding: "utf8", timeout: 2000, env: C_LOCALE() }, (err, out) => resolve(err ? null : out));
});

export interface ScreenLockOptions {
  events?: LockEvents;
  /** Locked when Ember starts (Electron's getSystemIdleState(…) === "locked"). Not asked when `poll` is given. */
  initial?: () => boolean;
  /**
   * Is it locked now? null: can't tell (what it knew stands). Given (Linux), Ember starts unlocked and only a read that
   * says locked makes it so: Electron's own reading there can't see GNOME's lock shield, or says locked wrongly, and a
   * wrong "locked" would make Ember ignore its user.
   */
  poll?: () => Promise<boolean | null>;
  /**
   * Says when it may have changed (`changed`: read again), and `ended` once it can't watch any more (`pollInstead`: read
   * every `pollMs` from then on). Returns what stops it. Without it, `poll` is read every `pollMs`.
   */
  watch?: (changed: () => void, ended: (pollInstead: boolean) => void) => () => void;
  /** How often `poll` is read without a watch (ms; 5 s). */
  pollMs?: number;
  onChange: (locked: boolean) => void;
}

/** `loginctl show-session <id> -p LockedHint -p Active` read: locked, or not in front, is true; null when it can't say. */
export function parseLoginctl(text: string): boolean | null {
  const props = new Map(text.split("\n").map(l => l.trim().split("=", 2) as [string, string | undefined]).filter(([k, v]) => k && v !== undefined));
  if (props.get("LockedHint") === "yes" || props.get("Active") === "no") return true;
  return props.get("LockedHint") === "no" && props.get("Active") === "yes" ? false : null;
}

const SESSION_ID = /^[A-Za-z0-9_-]+$/;
/** Session types with a screen (a terminal's or an SSH login's session has none). */
const GRAPHICAL = new Set(["x11", "wayland", "mir"]);

/**
 * Linux: the logind session whose screen is Ember's: the one Ember runs in (`sessionId`: XDG_SESSION_ID) when it has a
 * screen, else the user's graphical session (`loginctl show-user <uid> -p Display`). Started from a terminal's or an
 * SSH login's session, Ember would otherwise read that one, which is never in front. null when there is none.
 */
export async function graphicalSession(run: RunText, o: { sessionId: string | undefined; uid: number }): Promise<string | null> {
  if (o.sessionId && SESSION_ID.test(o.sessionId)) {
    const type = /^Type=(\S*)$/m.exec((await run("loginctl", ["show-session", o.sessionId, "-p", "Type"])) ?? "")?.[1];
    if (type && GRAPHICAL.has(type)) return o.sessionId;
  }
  const id = /^Display=(\S+)$/m.exec((await run("loginctl", ["show-user", String(o.uid), "-p", "Display"])) ?? "")?.[1];
  return id && SESSION_ID.test(id) ? id : null;
}

/** Whether logind's session `id` is locked or not in front; null when it can't tell. */
export async function sessionLocked(run: RunText, id: string): Promise<boolean | null> {
  const text = await run("loginctl", ["show-session", id, "-p", "LockedHint", "-p", "Active"]);
  return text === null ? null : parseLoginctl(text);
}

/**
 * logind's D-Bus object for session `id`. systemd escapes each character other than a-z, A-Z and 0-9, and a leading
 * digit, as `_` and two hex digits ("2" is "_32").
 */
export function sessionPath(id: string): string {
  const label = [...id].map((c, i) => (/[A-Za-z]/.test(c) || (i > 0 && /[0-9]/.test(c)) ? c : `_${c.charCodeAt(0).toString(16).padStart(2, "0")}`)).join("");
  return `/org/freedesktop/login1/session/${label || "_"}`;
}

/**
 * Linux: logind's view of Ember's screen, for ScreenLock. Read with loginctl when Ember starts and whenever `gdbus monitor`
 * (one process for the whole session, from glib2) says the session's properties changed; where gdbus is missing, or it
 * stops, read every few seconds instead. With no graphical session it can't tell, and nothing is watched.
 */
export function logindLock(o: { sessionId: string | undefined; uid: number; run?: RunText; spawn?: SpawnLines; log?: { info(event: string, fields?: object): void } }): Pick<ScreenLockOptions, "poll" | "watch"> {
  const run = o.run ?? execText;
  const spawn: SpawnLines = o.spawn ?? nodeSpawn;
  /** The session, once found (looked for again while it isn't). */
  let session: Promise<string | null> | null = null;
  const sessionOf = (): Promise<string | null> => {
    const p = session ??= graphicalSession(run, o);
    void p.then(id => { if (id === null && session === p) session = null; });
    return p;
  };
  return {
    poll: async () => {
      const id = await sessionOf();
      return id ? sessionLocked(run, id) : null;
    },
    watch: (changed, ended) => {
      let child: ChildProcess | null = null;
      let over = false;
      const end = (pollInstead: boolean, why: string) => {
        if (over) return;
        over = true;
        o.log?.info("screen.lock_watch_ended", { why, pollInstead });
        ended(pollInstead);
      };
      void sessionOf().then(id => {
        if (over) return;
        if (!id) { end(false, "no graphical session"); return; }
        const p = child = spawn("gdbus", ["monitor", "--system", "--dest", "org.freedesktop.login1", "--object-path", sessionPath(id)], { stdio: ["ignore", "pipe", "ignore"], env: C_LOCALE() });
        let rest = "";
        p.stdout?.on("data", (chunk: Buffer) => {
          const lines = (rest + chunk.toString("utf8")).split("\n");
          rest = lines.pop() ?? "";
          // The session's properties changed (LockedHint, Active), or the watch began (logind found, or back after a
          // restart): read again, so nothing that changed meanwhile is missed.
          if (lines.some(l => l.includes(".PropertiesChanged ") || /^The name \S+ is owned by /.test(l))) changed();
        });
        p.once("error", (err: NodeJS.ErrnoException) => end(true, err.code === "ENOENT" ? "gdbus isn't installed" : err.message));
        p.once("exit", (code, signal) => end(true, `gdbus stopped (${signal ?? `exit ${code}`})`));
      });
      return () => { over = true; child?.kill(); };
    },
  };
}

export class ScreenLock {
  private state = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private unwatch: (() => void) | null = null;
  /** Reads started: only the latest one's answer counts. */
  private reads = 0;

  constructor(private o: ScreenLockOptions) {}

  get locked(): boolean {
    return this.state;
  }

  start(): void {
    this.stopped = false;
    if (this.o.poll) {
      // Unlocked until a read says otherwise (one that can't tell leaves it so): see ScreenLockOptions.poll.
      this.state = false;
      void this.read();
      if (this.o.watch) this.unwatch = this.o.watch(() => void this.read(), pollInstead => { this.unwatch = null; if (pollInstead) this.pollLater(); });
      else this.pollLater();
    } else {
      try {
        this.state = this.o.initial?.() ?? false;
      } catch {
        // Unknown at start: Ember was just started by its user, so it's taken as unlocked (the events follow).
        this.state = false;
      }
    }
    this.o.events?.on("lock-screen", () => this.set(true));
    this.o.events?.on("unlock-screen", () => this.set(false));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unwatch?.();
    this.unwatch = null;
  }

  private async read(): Promise<void> {
    const n = ++this.reads;
    const now = await this.o.poll!().catch(() => null);
    if (this.stopped || n !== this.reads) return;
    if (now !== null) this.set(now);
  }

  private pollLater(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.read().then(() => this.pollLater()), this.o.pollMs ?? 5000);
    this.timer.unref?.();
  }

  private set(locked: boolean): void {
    if (this.stopped || locked === this.state) return;
    this.state = locked;
    this.o.onChange(locked);
  }
}

/** What the bubble says once the user is back, when tasks stopped while the screen was locked. */
export function lockNotice(stopped: number): { title: string; thought: string } {
  return { title: "Stopped while your screen was locked", thought: `Your screen locked, so I stopped ${stopped === 1 ? "the task" : "the tasks"} working on it.` };
}

/** What the bubble says when a request comes while the screen counts as locked (should the user see it, it isn't). */
export const LOCKED_ASK = { title: "Your screen is locked", thought: "Your screen is locked, so I didn't take that." };

export interface LockControllerOptions {
  /** Stops this computer's tasks that work on its desktop (AgentHost.cancelTasksOn("local", "desktop")): how many. */
  stopDesktopTasks: () => number;
  /** Listening and speech off while locked, on again after (VoiceService.setLocked). */
  setLocked: (locked: boolean) => void;
  /** Says, once the user is back, that tasks stopped meanwhile (lockNotice). */
  showNotice: (notice: { title: string; thought: string }) => void;
  /** How often a task that turns to the desktop while locked is looked for (ms; 2 s): a backstop, the hands refuse too. */
  sweepMs?: number;
}

/**
 * What main does when the screen locks or unlocks (ScreenLock's onChange): locked, listening and speech stop, and so do
 * the tasks working on this computer's desktop (also one that turns to it later, looked for every 2 s); unlocked,
 * listening starts again and, if tasks stopped meanwhile, the bubble says so, once.
 */
export class LockController {
  private stopped = 0;
  private sweep: NodeJS.Timeout | null = null;

  constructor(private o: LockControllerOptions) {}

  change(locked: boolean): void {
    this.o.setLocked(locked);
    this.dispose();
    if (locked) {
      this.stopTasks();
      this.sweep = setInterval(() => this.stopTasks(), this.o.sweepMs ?? 2000);
      this.sweep.unref?.();
      return;
    }
    if (this.stopped) this.o.showNotice(lockNotice(this.stopped));
    this.stopped = 0;
  }

  /** The sweep ends (Ember quits). */
  dispose(): void {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
  }

  private stopTasks(): void {
    this.stopped += this.o.stopDesktopTasks();
  }
}

/** Main's bubble, as holdNotice uses it. */
export interface MainBubble<B> {
  /** AgentHost.claimBubble: no presenter's timer hides main's bubble, nor does a task's work replace it. */
  claim(): void;
  show(bubble: B): void;
  /** What is on screen now. */
  current(): B;
  /** AgentHost.releaseBubble(bubble): false when nothing else shows (main hides it). */
  release(bubble: B): boolean;
  hide(): void;
}

/**
 * Shows main's own notice for `ms`, holding the bubble so a task's hide doesn't wipe it, and gives it back after: a task
 * still at work shows its progress again then, not when the hold would run out. Hidden if nothing else shows; a notice
 * replaced meanwhile is left alone.
 */
export function holdNotice<B>(b: MainBubble<B>, bubble: B, ms: number): NodeJS.Timeout {
  b.claim();
  b.show(bubble);
  return setTimeout(() => { if (b.current() === bubble && !b.release(bubble)) b.hide(); }, ms);
}

/** What a task reads when it tries to read or act on this computer's screen while it's locked. */
export const LOCKED_SCREEN = "This computer's screen is locked, so Ember didn't read it or act on it.";

/**
 * This screen's hands, refusing to read or act on it while `locked()`: the gate is at the desktop itself, so a task that
 * starts, or turns to the desktop, while the screen is locked can't read or touch it (the stop on locking and its sweep
 * are a backstop). Commands, which run in their own window, aren't hands. Its window is unknown meanwhile.
 */
export function lockedOutHands(h: Hands, locked: () => boolean): Hands {
  const gate = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => (...a: A): Promise<R> => (locked() ? Promise.reject(new Error(LOCKED_SCREEN)) : f(...a));
  const p = h.perception, s = h.sidecar;
  const perception: PerceptionPort = {
    focused: gate((...a: Parameters<PerceptionPort["focused"]>) => p.focused(...a)),
    read: gate((...a: Parameters<PerceptionPort["read"]>) => p.read(...a)),
    atPoint: gate((...a: Parameters<PerceptionPort["atPoint"]>) => p.atPoint(...a)),
    quickContext: gate(() => p.quickContext()),
    describe: gate(() => p.describe()),
    perceive: gate((...a: Parameters<PerceptionPort["perceive"]>) => p.perceive(...a)),
    systemDialogOpen: gate(() => p.systemDialogOpen()),
    windows: gate(() => p.windows()),
    // Why the system-dialog check is on (macOS's secure keyboard entry, a Wayland session), where this screen says.
    ...(p.systemDialogReason ? { systemDialogReason: gate(() => p.systemDialogReason!()) } : {}),
  };
  const sidecar: SidecarPort = {
    readElement: gate((...a: Parameters<SidecarPort["readElement"]>) => s.readElement(...a)),
    canDo: gate((...a: Parameters<SidecarPort["canDo"]>) => s.canDo(...a)),
    doAction: gate((...a: Parameters<SidecarPort["doAction"]>) => s.doAction(...a)),
    setText: gate((...a: Parameters<SidecarPort["setText"]>) => s.setText(...a)),
    setValue: gate((...a: Parameters<SidecarPort["setValue"]>) => s.setValue(...a)),
    selectOption: gate((...a: Parameters<SidecarPort["selectOption"]>) => s.selectOption(...a)),
    listOptions: gate((...a: Parameters<SidecarPort["listOptions"]>) => s.listOptions(...a)),
    scaleOf: id => s.scaleOf(id),
    stop: () => s.stop(),
  };
  return { ...h, perception, sidecar, currentWindow: () => (locked() ? null : h.currentWindow()) };
}

/**
 * The input the borrowed mouse uses, whose screenLocked() is also true while `locked()`: the borrow checks it before it
 * touches anything, and on Linux the input's own check (the X screensaver, DPMS) doesn't see GNOME's lock shield, so
 * keys could reach the lock screen's password field. Everything else is the input's own.
 */
export function lockAwareInput<X extends { screenLocked?(): boolean }>(input: X, locked: () => boolean): X {
  const own = input.screenLocked;
  return Object.assign(Object.create(input) as X, { screenLocked: () => locked() || (own?.call(input) ?? false) });
}
