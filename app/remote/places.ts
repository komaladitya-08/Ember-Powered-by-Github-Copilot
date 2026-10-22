/**
 * Where the remote agent keeps things (§5.2.3), and how it names this machine. Nothing is written outside these
 * folders: the data folder (runtime/ and versions/, written by the bootstrap), the per-machine state folder (audit/,
 * logs/, runs/, consent.json) and the per-session folder (the single-instance lock). Folders 0700, files 0600. Fixed
 * paths relative to $HOME (XDG_DATA_HOME and XDG_STATE_HOME are not followed: the bootstrap's paths need no shell
 * expansion). Plain Node; a target's paths through node:path/posix.
 */

import { createHash } from "node:crypto";
import path from "node:path/posix";

/** The OSes an agent runs on in v1. */
export type AgentOs = "linux" | "darwin";

/** The agent's folders on this machine. */
export interface Places {
  /** Runtime and parts: ~/.local/share/ember-remote (Linux), ~/Library/Application Support/Ember Remote (macOS). */
  data: string;
  /** Per machine (NFS homes are shared between hosts): <data or ~/.local/state/ember-remote>/<machine>. */
  state: string;
  audit: string;
  logs: string;
  /** One stamp per running command (`runs/<runId>`), for the orphan sweep after an abnormal end (§3.13). */
  runs: string;
  consent: string;
  /** The per-session folder (0700). */
  session: string;
  /** The single-instance lock: in the session folder when it outlives this agent, else in the state folder. */
  lock: string;
}

/** sha256 of a line as `printf '%s\n' <text> | sha256sum` hashes it (a file that already ends in a newline as it is). */
export function hashLine(text: string): string {
  return createHash("sha256").update(text.endsWith("\n") ? text : `${text}\n`).digest("hex");
}

/**
 * This machine's name in state paths (critique remote-22): the first 12 hex digits of the machine-id hash and the
 * first 4 of the host-name hash, so cloned VMs sharing a machine id on one NFS home still keep apart.
 */
export function machineKey(machineHash: string, hostHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(machineHash) || !/^[0-9a-f]{64}$/.test(hostHash)) throw new Error("a machine key needs two sha256 hashes");
  return `${machineHash.slice(0, 12)}${hostHash.slice(0, 4)}`;
}

/** The data folder (runtime/ and versions/) under `home`. */
export function dataFolder(os: AgentOs, home: string): string {
  return os === "darwin" ? path.join(home, "Library/Application Support/Ember Remote") : path.join(home, ".local/share/ember-remote");
}

/** Where this machine's administrator keeps Ember's policy (the folders of admin.ts' ADMIN_POLICY_PATHS, as data). */
const ADMIN_POLICY_DIRS: Readonly<Record<AgentOs, string>> = { linux: "/etc/ember", darwin: "/Library/Application Support/Ember" };

/**
 * Ember's own paths on this machine (§3.6.2, D4.5): a command that names one is refused outright. The agent's data,
 * state and per-session folders, the administrator's policy folder, and on Linux /var/log/ember-remote.
 */
export function emberPaths(os: AgentOs, p: Pick<Places, "data" | "state" | "session">): string[] {
  const stateRoot = os === "darwin" ? path.join(p.data, "state") : path.dirname(p.state);
  return [p.data, stateRoot, p.session, ADMIN_POLICY_DIRS[os], ...(os === "linux" ? ["/var/log/ember-remote"] : [])];
}

/** Every folder of the agent for this machine (`session` from sessionFolder; `stable`: it outlives this agent). */
export function placesFor(o: { os: AgentOs; home: string; machine: string; session: string; sessionStable: boolean }): Places {
  if (!path.isAbsolute(o.home)) throw new Error("the home folder must be absolute");
  if (!/^[0-9a-f]{16}$/.test(o.machine)) throw new Error("not a machine key");
  const state = o.os === "darwin" ? path.join(dataFolder(o.os, o.home), "state", o.machine) : path.join(o.home, ".local/state/ember-remote", o.machine);
  return {
    data: dataFolder(o.os, o.home),
    state,
    audit: path.join(state, "audit"),
    logs: path.join(state, "logs"),
    runs: path.join(state, "runs"),
    consent: path.join(state, "consent.json"),
    session: o.session,
    lock: path.join(o.sessionStable ? o.session : state, "lock"),
  };
}

/** What sessionFolder reads of the machine (injected for tests). */
export interface SessionIo {
  uid: number;
  env: NodeJS.ProcessEnv;
  /** lstat's facts of a path, or null when it doesn't exist or can't be read. */
  lstat(p: string): { dir: boolean; symlink: boolean; uid: number; mode: number } | null;
  mkdir(p: string): void;
  /** mkdtemp(prefix): the new folder. */
  mkdtemp(prefix: string): string;
  /** `getconf DARWIN_USER_TEMP_DIR` (macOS: SSH logins don't reliably get TMPDIR), or null. */
  darwinTemp(): string | null;
}

/** A folder of this uid's own, 0700, not a link. */
function ownPrivate(io: SessionIo, p: string): boolean {
  const st = io.lstat(p);
  return !!st && st.dir && !st.symlink && st.uid === io.uid && (st.mode & 0o777) === 0o700;
}

/**
 * The per-session folder (§5.2.3): `$XDG_RUNTIME_DIR/ember-remote/` when XDG_RUNTIME_DIR is a 0700 folder of this
 * uid (Linux), `$(getconf DARWIN_USER_TEMP_DIR)ember-remote/` (macOS); else a fresh `/tmp/ember-remote.XXXXXX`, which
 * doesn't outlive the agent (`stable: false`). An existing folder of the name must be this uid's own 0700 folder.
 */
export function sessionFolder(os: AgentOs, io: SessionIo): { dir: string; stable: boolean } {
  let parent: string | null = null;
  if (os === "linux") {
    const rt = io.env.XDG_RUNTIME_DIR;
    if (rt && path.isAbsolute(rt) && ownPrivate(io, rt)) parent = rt;
  } else {
    const t = io.darwinTemp();
    if (t && path.isAbsolute(t)) {
      const st = io.lstat(t.replace(/\/+$/, "") || "/");
      if (st && st.dir && !st.symlink && st.uid === io.uid) parent = t;
    }
  }
  if (parent) {
    const dir = path.join(parent, "ember-remote");
    if (!io.lstat(dir)) {
      try { io.mkdir(dir); } catch { /* raced, or refused: checked below */ }
    }
    if (ownPrivate(io, dir)) return { dir, stable: true };
  }
  return { dir: io.mkdtemp("/tmp/ember-remote."), stable: false };
}
