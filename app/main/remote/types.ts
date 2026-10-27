/**
 * The PC's side of SSH (§5.1): the host records the user added, what Ember carries over from the user's own ssh
 * command line, a live connection (RemoteLink) and the connections that make them (Connections), the prompts a
 * connection needs from the user, and the framed stream both ends speak (Mux, implemented in mux.ts). Plain Node:
 * the remote agent bundles the Mux side of it.
 */

import type { EvMap, EvName, Msg, Op, OpArgs, OpResult, Welcome } from "./protocol";
import type { PromptAnswer, PromptCard } from "../../shared/remote-ui";

/** A host the user added (settings.targets.hosts). */
export interface HostRecord {
  /** HOST_ID: the alias lower-cased, [^a-z0-9._-] → "-", made unique with "-2", "-3"… */
  id: string;
  /** What ssh is given as the destination: the alias, or user@host. */
  dest: string;
  /** A port given apart from the alias (else ssh's own config decides). */
  port?: number;
  /** Options carried over from the user's own ssh command line (§2.7), shown on the consent card. */
  extra?: { jump?: string[]; identityFiles?: string[]; configFile?: string; options?: Record<string, string> };
  /** Where ssh runs: this PC's client, or a WSL distro's (L22). */
  via?: "local" | `wsl:${string}`;
  /** What `ssh -G` resolved it to when the user consented. */
  resolved: { user: string; hostname: string; port: number; jump: string[] };
  consent: { version: number; at: string | null };
  /** sha256 of the remote's machine id (and boot id) at the first connection (a changed one is asked about again). */
  machineIdHash?: string;
  lastUsed?: string;
}

/** What Ember's own connection carries over from the user's ssh command line (shown on the consent card). */
export interface SshSeen {
  dest: string;
  user?: string;
  port?: number;
  /** -J hops, as written (each checked with validDest). */
  jump?: string[];
  /** -i files and -F config, as written (absolute or ~-relative; nothing else). */
  identityFiles?: string[];
  configFile?: string;
  /** -o options from this allow-list only: Port, User, ProxyJump, IdentityFile, IdentitiesOnly, HostKeyAlias, HostName. */
  options?: Record<string, string>;
  /** Where the user's ssh ran: their Windows session or a WSL distro (L22). */
  via?: "local" | `wsl:${string}`;
}

/** How a connection is coming along, for the settings window and the bubble (§8.7's messages on failure). */
export type ConnectProgress =
  | { step: "resolving" | "connecting" | "checking" | "starting" | "ready" }
  | { step: "downloading" | "copying"; done: number; total: number }
  | { step: "failed"; message: string; fix?: string; retry: boolean; kind: string };

/** One live connection (§5.1). */
export interface RemoteLink {
  readonly id: string;
  readonly hostId: string;
  readonly welcome: Welcome;
  readonly state: "ready" | "stalled" | "lost" | "closed";
  readonly epoch: number;
  readonly rttMs: number;
  request<O extends Op>(op: O, args: OpArgs<O>, o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<OpResult<O>>;
  on<E extends EvName>(ev: E, fn: (d: EvMap[E]) => void): () => void;
  onBytes(channel: number, fn: (b: Uint8Array) => void): () => void;
  /** §5.1.11: epoch at once, stop frame, escalation. Never throws. */
  stop(): Promise<{ ms: number; escalated: boolean }>;
  onState(fn: (s: "ready" | "stalled" | "lost" | "closed", why?: string) => void): () => void;
  close(why: string): Promise<void>;
}

/** The SSH connections (createConnections in app/main/remote/connections.ts). */
export interface Connections {
  /** Resolves when ready; refuses (throws a ConnectError with the §8.7 message) on any check. */
  connect(host: HostRecord, o: { interactive: boolean; signal?: AbortSignal }): Promise<RemoteLink>;
  disconnect(hostId: string): Promise<void>;
  link(hostId: string): RemoteLink | null;
  /** Removes Ember's helper from the host (§5.2.7); `signal` stops it where it is (the user's Cancel in settings). */
  uninstall(host: HostRecord, o?: { signal?: AbortSignal }): Promise<void>;
  /** ssh -G for a destination the user typed (settings' Add, the consent card), with its carried options. */
  resolve(dest: string, o?: { port?: number; extra?: HostRecord["extra"]; via?: HostRecord["via"] }): Promise<HostRecord["resolved"] & { controlPath: string | null }>;
  onProgress(fn: (hostId: string, p: ConnectProgress) => void): () => void;
  stopAll(): Promise<void>;
  dispose(): Promise<void>;
}

/** A connection refused or failed: `message` and `fix` are §8.7's words, `kind` its class (classifySshFailure). */
export class ConnectError extends Error { constructor(message: string, readonly kind: string, readonly fix?: string, readonly retry = false) { super(message); } }

/** The prompts a connection needs from the user (the prompt window implements it). */
export interface PromptUi {
  ask(card: PromptCard): Promise<PromptAnswer>;
  dismiss(id: string): void;
}

/** Both ends of the framed stream (§5.1.10; MX implements createMux in mux.ts). */
export interface Mux {
  /** ctl/data JSON messages, already validated against the protocol's schemas. */
  send(msg: Msg): void;
  onMessage(fn: (msg: Msg) => void): () => void;
  /** A bulk channel's bytes (credit-limited). */
  sendBytes(channel: number, bytes: Uint8Array): void;
  onBytes(fn: (channel: number, bytes: Uint8Array) => void): () => void;
  ping(): void;
  /** ms since the last frame from the other end. */
  silentMs(): number;
  readonly rttMs: number;
  /** Bytes in flight and the measured throughput (bytes/s), for the escalation deadline. */
  inFlight(): { bytes: number; throughput: number };
  reset(code: number, reason: string): void;
  onClose(fn: (why: string) => void): () => void;
}
