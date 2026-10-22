/**
 * The remote's own administrator policy (§5.3.8, §9): loaded with admin.ts's loader from ADMIN_POLICY_PATHS (never an
 * import of the PC's per-OS loaders: critique integration-19), root-owned and not group- or world-writable, and on macOS
 * its folder too; read at start and every 10 s. It binds what Ember does on this machine: a broken policy or
 * `features.ssh: false` means the agent refuses to serve; `ssh.desktop`, `ssh.requireConsoleConsent`, `commands.ssh` and
 * `ssh.commandGraceSeconds` mean what §5.3.8 says. Plain Node.
 */

import fs from "node:fs";
import path from "node:path/posix";
import { ADMIN_POLICY_PATHS, adminSummary, loadAdminPolicy, lockedDown, type AdminSummary, type LoadedAdminPolicy } from "../main/admin";
import type { AgentOs } from "./places";

/** How often the policy is read again. */
export const POLICY_EVERY_MS = 10_000;

/** What loading the policy reads of the machine. */
export interface PolicyIo {
  load(file: string, o: { requireRootOwned: boolean }): LoadedAdminPolicy;
  /** lstat's facts of a path, or null when it doesn't exist. */
  lstat(p: string): { dir: boolean; symlink: boolean; uid: number; mode: number } | null;
}

/** The real machine's PolicyIo. */
export const REAL_POLICY_IO: PolicyIo = {
  load: (file, o) => loadAdminPolicy(file, o),
  lstat(p) {
    try {
      const st = fs.lstatSync(p);
      return { dir: st.isDirectory(), symlink: st.isSymbolicLink(), uid: st.uid, mode: st.mode };
    } catch {
      return null;
    }
  },
};

/**
 * This machine's policy. macOS: the folder holding it must belong to root and be writable only by root, or Ember is
 * locked down (an administrator's MDM puts it there; a user-owned folder would let the user swap the file).
 */
export function loadRemotePolicy(os: AgentOs, io: PolicyIo = REAL_POLICY_IO): LoadedAdminPolicy {
  const file = ADMIN_POLICY_PATHS[os];
  if (os === "darwin") {
    const dir = path.dirname(file);
    const st = io.lstat(dir);
    if (st && (!st.dir || st.symlink || st.uid !== 0 || (st.mode & 0o022) !== 0)) {
      return lockedDown(file, `${dir} must be a folder that belongs to root and is writable only by root`);
    }
  }
  return io.load(file, { requireRootOwned: true });
}

/** Why the agent won't serve under this policy (in Ember's words, naming `host`), or null when it may. */
export function serveRefusal(loaded: LoadedAdminPolicy, host: string): string | null {
  if (loaded.error) return `${host}'s Ember policy is broken: ${loaded.error}`;
  if (loaded.policy.features.ssh === false) return "This computer's administrator doesn't allow Ember here.";
  return null;
}

/** The policy as it is now, read again every 10 s; `onChange` gets the new one whenever its summary changes. */
export class PolicyWatch {
  private loaded: LoadedAdminPolicy;
  private key: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(private read: () => LoadedAdminPolicy, private onChange: (loaded: LoadedAdminPolicy, summary: AdminSummary) => void) {
    this.loaded = read();
    this.key = JSON.stringify(adminSummary(this.loaded));
  }

  get current(): LoadedAdminPolicy {
    return this.loaded;
  }

  get summary(): AdminSummary {
    return adminSummary(this.loaded);
  }

  /** Reads the file now; true when what it says changed. */
  refresh(): boolean {
    let next: LoadedAdminPolicy;
    try {
      next = this.read();
    } catch (err) {
      next = lockedDown("the administrator's policy", `it couldn't be read: ${(err as Error).message}`);
    }
    const key = JSON.stringify(adminSummary(next));
    this.loaded = next;
    if (key === this.key) return false;
    this.key = key;
    this.onChange(next, adminSummary(next));
    return true;
  }

  start(every = POLICY_EVERY_MS): void {
    this.timer ??= setInterval(() => this.refresh(), every);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
