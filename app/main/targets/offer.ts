/**
 * Noticing the user's own ssh and offering to come along (§2.7, R4). Read-only: the process list and each ssh's command
 * line (the destination and the few options Ember carries over), kept in memory and logged without the host. It looks
 * only while SSH is allowed and the user's offer switch is on, only when the window the user is in is a terminal whose
 * title just changed, and at most once every 10 s; on Windows the process query (a PowerShell start) runs only for
 * a title that looks like an SSH session and only while SSH is in use or the user hasn't turned the first offer away;
 * ssh inside WSL is read only with WSL on and only in distros running at that moment (never starting one). Each
 * destination is offered once per run, never one the user dismissed or Ember is already connected to, and never while
 * a question is up. Ember never opens a connection here: the offer's button does, after the SSH card.
 */

import type { OS } from "../../shared/shortcuts";
import type { Logger } from "../logger";
import type { SshSeen } from "../remote/types";

/** SA's noticing functions (app/main/remote/notice-ssh.ts), with their exact signatures (§2.7). */
export interface SshNotice {
  sshDestination(argv: readonly string[]): SshSeen | null;
  userSshProcesses(os: OS, o?: { wsl?: { exe: string; distros: string[] } }): Promise<{ pid: number; argv: string[]; via: SshSeen["via"] }[] | null>;
}

/** At most one look at the process list in this long (§2.7). */
export const NOTICE_INTERVAL_MS = 10_000;
/** How often the window the user is in is looked at (cheap: one window-system call). */
export const NOTICE_TICK_MS = 2000;

/** A Windows terminal title that looks like an SSH session ("deploy@build-01: ~", "ssh build-01"). */
export function sshLookingTitle(title: string): boolean {
  return title.includes("@") || /(^|\s)ssh\s/i.test(title);
}

/** The destination a seen ssh connects to, as one key (user, host and port, lower case): one offer per key per run. */
export function seenKey(s: SshSeen): string {
  const at = s.dest.lastIndexOf("@");
  const user = s.user ?? (at >= 0 ? s.dest.slice(0, at) : "");
  const host = (at >= 0 ? s.dest.slice(at + 1) : s.dest).toLowerCase();
  return `${s.via ?? "local"}|${user}@${host}:${s.port ?? ""}`;
}

/** What the noticer needs from the runtime (every piece cheap and synchronous except the process read). */
export interface NoticerDeps {
  os: OS;
  log: Logger;
  notice: SshNotice | null;
  /** SSH allowed by the administrator and the user's offer switch on. */
  enabled(): boolean;
  /** The window the user is in now (its program and title), or null when it can't be told. */
  activeWindow(): { app: string; title: string } | null;
  isTerminal(app: string): boolean;
  /** Windows: the process query may run (a host record exists, or the user hasn't dismissed an offer yet). */
  cimAllowed(): boolean;
  /**
   * WSL on: its wsl.exe and the visible distros Ember works in, to read too; null otherwise. The process read reads
   * only those of them that run at that moment (the running set read again, uncached) and never starts a stopped one.
   */
  wsl(): { exe: string; distros: string[] } | null;
  /** The user said "Don't offer again" for this destination. */
  dismissed(s: SshSeen): boolean;
  /** Ember is already connected (or connecting) to this destination. */
  connected(s: SshSeen): boolean;
  questionUp(): boolean;
  /** Shows the offer. */
  offer(s: SshSeen): void;
  now(): number;
}

/** The noticer: tick() on a timer; the process list is read at most once every 10 s, on a changed terminal title. */
export interface Noticer {
  tick(): void;
  /** The check the triggers run (exported for tests): read, pick the first new destination, offer it. */
  check(): Promise<void>;
  /** Destinations offered this run. */
  readonly offered: ReadonlySet<string>;
}

/** Makes the noticer. */
export function createNoticer(d: NoticerDeps): Noticer {
  const offered = new Set<string>();
  let lastTitle: string | null = null;
  let lastCheck = -Infinity;
  /** A title change seen while the 10 s were still running: one check when they end (not a loop). */
  let pending = false;
  let running = false;

  async function check(): Promise<void> {
    if (!d.notice || running) return;
    running = true;
    try {
      const wsl = d.wsl();
      let procs: Awaited<ReturnType<SshNotice["userSshProcesses"]>>;
      try {
        procs = await d.notice.userSshProcesses(d.os, wsl && wsl.distros.length ? { wsl } : undefined);
      } catch (err) {
        d.log.warn("remote.ssh_seen_failed", { err });
        return;
      }
      if (!procs) return;
      for (const p of procs) {
        let seen: SshSeen | null;
        try { seen = d.notice.sshDestination(p.argv); } catch { seen = null; }
        if (!seen) continue;
        if (p.via) seen = { ...seen, via: p.via };
        const key = seenKey(seen);
        if (offered.has(key) || d.dismissed(seen) || d.connected(seen)) continue;
        // The user's own ssh; logged without its host (§2.7).
        d.log.info("remote.ssh_seen", { via: seen.via?.startsWith("wsl:") ? "wsl" : "local" });
        // Never over a question: offered later, when the next trigger finds it again.
        if (d.questionUp()) return;
        offered.add(key);
        d.offer(seen);
        return;
      }
    } finally {
      running = false;
    }
  }

  function tick(): void {
    if (!d.enabled() || !d.notice) { lastTitle = null; pending = false; return; }
    let w: { app: string; title: string } | null;
    try { w = d.activeWindow(); } catch { w = null; }
    let terminal: boolean;
    try { terminal = !!w && d.isTerminal(w.app); } catch { terminal = false; }
    if (!w || !terminal) { lastTitle = null; pending = false; return; }
    const changed = w.title !== lastTitle;
    lastTitle = w.title;
    if (!changed && !pending) return;
    // Within the 10 s, or while the last look is still reading: one look later, when they are over.
    if (running || d.now() - lastCheck < NOTICE_INTERVAL_MS) { pending = true; return; }
    pending = false;
    // Windows: a PowerShell start per look, so only for a title that looks like SSH and while it may still help.
    if (d.os === "win32" && (!sshLookingTitle(w.title) || !d.cimAllowed())) return;
    lastCheck = d.now();
    void check();
  }

  return { tick, check, offered };
}
