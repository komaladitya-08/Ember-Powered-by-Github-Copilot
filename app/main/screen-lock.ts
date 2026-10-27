/**
 * Whether this computer's screen is locked, or its session isn't the one in front (another user's, or the login
 * screen): while it is, Ember stops listening and speaking, takes no requests and stops the tasks working on its
 * desktop, as it does for a remote computer whose screen locks (review #81). Electron's lock-screen and unlock-screen
 * events tell it on Windows and macOS. On Linux they don't come, and the X screensaver doesn't see GNOME's lock shield,
 * so logind's LockedHint (which GNOME Shell sets) and Active are polled. Plain Node: the events, the poll and the
 * clock are passed in.
 */

import { execFile } from "node:child_process";

/** Electron's powerMonitor, as far as the lock goes. */
export interface LockEvents {
  on(event: "lock-screen" | "unlock-screen", listener: () => void): unknown;
}

/** Runs a program and gives its output, or null when it couldn't run or failed. */
export type RunText = (cmd: string, args: string[]) => Promise<string | null>;

/** RunText on this system: null too when the program took over 2 s. */
export const execText: RunText = (cmd, args) => new Promise(resolve => {
  execFile(cmd, args, { encoding: "utf8", timeout: 2000 }, (err, out) => resolve(err ? null : out));
});

export interface ScreenLockOptions {
  events?: LockEvents;
  /** Locked when Ember starts (Electron's getSystemIdleState(…) === "locked"). */
  initial?: () => boolean;
  /** Is it locked now? null: can't tell (what it knew stands). */
  poll?: () => Promise<boolean | null>;
  /** How often `poll` asks (ms). */
  pollMs?: number;
  onChange: (locked: boolean) => void;
}

/** `loginctl show-session <id> -p LockedHint -p Active` read: locked, or not in front, is true; null when it can't say. */
export function parseLoginctl(text: string): boolean | null {
  const props = new Map(text.split("\n").map(l => l.trim().split("=", 2) as [string, string | undefined]).filter(([k, v]) => k && v !== undefined));
  if (props.get("LockedHint") === "yes" || props.get("Active") === "no") return true;
  return props.get("LockedHint") === "no" && props.get("Active") === "yes" ? false : null;
}

/**
 * Linux: the screen's state from logind, for Ember's own session (`sessionId`: XDG_SESSION_ID), or, started without one,
 * the user's graphical session (`loginctl show-user <uid> -p Display`). null when it can't tell.
 */
export async function loginctlLocked(run: RunText, o: { sessionId: string | undefined; uid: number }): Promise<boolean | null> {
  let id = o.sessionId;
  if (!id) id = /^Display=(\S+)$/m.exec((await run("loginctl", ["show-user", String(o.uid), "-p", "Display"])) ?? "")?.[1];
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const text = await run("loginctl", ["show-session", id, "-p", "LockedHint", "-p", "Active"]);
  return text === null ? null : parseLoginctl(text);
}

export class ScreenLock {
  private state = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private o: ScreenLockOptions) {}

  get locked(): boolean {
    return this.state;
  }

  start(): void {
    this.stopped = false;
    try {
      this.state = this.o.initial?.() ?? false;
    } catch {
      // Unknown at start: Ember was just started by its user, so it's taken as unlocked (the events and polls follow).
      this.state = false;
    }
    this.o.events?.on("lock-screen", () => this.set(true));
    this.o.events?.on("unlock-screen", () => this.set(false));
    if (this.o.poll) void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const now = await this.o.poll!().catch(() => null);
    if (this.stopped) return;
    if (now !== null) this.set(now);
    this.timer = setTimeout(() => void this.tick(), this.o.pollMs ?? 2000);
    this.timer.unref?.();
  }

  private set(locked: boolean): void {
    if (this.stopped || locked === this.state) return;
    this.state = locked;
    this.o.onChange(locked);
  }
}
