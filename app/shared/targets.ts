/**
 * Where Ember acts: this computer, a WSL distro on it, or a computer reached over SSH. A task acts on exactly one
 * target. Shared by main and the renderers (labels and badges), so it holds data and pure helpers only.
 */

/** The kinds of place a task can act on. */
export type TargetKind = "local" | "wsl" | "ssh";

/** "local", "wsl:<distro name>" or "ssh:<host id>" (a host id is HostRecord.id in settings). */
export type TargetId = "local" | `wsl:${string}` | `ssh:${string}`;

/** This computer. */
export const LOCAL_TARGET: TargetId = "local";

/** A WSL distro's name as WSL allows it (verify against `wsl --install --name` rules; refuse anything else). */
export const DISTRO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A host record's id: lower case, made by Ember from the alias (never typed by the model). */
export const HOST_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The parts of a target id, or null when it isn't one (fail closed: an unknown id is never acted on). "local" has the
 * name "" (it needs none); a distro's or host's name must pass DISTRO_NAME or HOST_ID.
 */
export function parseTargetId(id: string): { kind: TargetKind; name: string } | null {
  if (typeof id !== "string") return null;
  if (id === LOCAL_TARGET) return { kind: "local", name: "" };
  const m = /^(wsl|ssh):(.*)$/s.exec(id);
  if (!m) return null;
  const kind = m[1] as "wsl" | "ssh";
  const name = m[2];
  return (kind === "wsl" ? DISTRO_NAME : HOST_ID).test(name) ? { kind, name } : null;
}

/** A target id from its parts; throws when `name` breaks DISTRO_NAME or HOST_ID. */
export function targetIdOf(kind: "wsl" | "ssh", name: string): TargetId {
  if (kind === "wsl") {
    if (typeof name !== "string" || !DISTRO_NAME.test(name)) throw new Error(`not a WSL distro name: ${JSON.stringify(name)}`);
    return `wsl:${name}`;
  }
  if (kind === "ssh") {
    if (typeof name !== "string" || !HOST_ID.test(name)) throw new Error(`not a host id: ${JSON.stringify(name)}`);
    return `ssh:${name}`;
  }
  throw new Error(`not a target kind with a name: ${JSON.stringify(kind)}`);
}

/** What the renderers show about a target (settings, handle menu, badges). */
export interface TargetSummary {
  id: TargetId;
  kind: TargetKind;
  /** "This computer", "Ubuntu (WSL)", "build-01". */
  label: string;
  /** The remote login beside a remote's label ("deploy"), from the connection record (never from the remote). */
  login?: string;
  state: "ready" | "connecting" | "lost" | "off" | "unavailable";
  /** What Ember can do there now, in a few words: "apps and commands", "commands only", "Linux apps". */
  can: string;
  /** The picker's choice: requests that name no computer go here. */
  active: boolean;
  /** Why the last connection to it failed, while it isn't connected (the settings row keeps it after the bubble goes). */
  problem?: string;
}

/**
 * The settings (home) window's channels for computers and their commands. Main accepts them only from the home
 * window's own page (TargetsDeps.isHome; critique integration-5).
 */
export const TARGETS_IPC = {
  /** The renderer asks for the TargetSummary list. */
  list: "targets:list",
  /** Main pushes a changed TargetSummary list. */
  changed: "targets:changed",
  /** The renderer asks main to do something to a target (TargetsAct). */
  act: "targets:act",
} as const;

/** What the settings window can ask of the targets runtime (every one checked in main: ids, host ids, the sender). */
export type TargetsAct =
  | { kind: "activate"; id: TargetId }
  | { kind: "connect" | "disconnect" | "forget" | "uninstall"; hostId: string }
  | { kind: "add"; dest: string }
  | { kind: "wsl"; on: boolean }
  | { kind: "commands"; id: TargetId; on: boolean; askEvery?: boolean }
  | { kind: "offerSsh"; on: boolean }
  | { kind: "openCommands" };
