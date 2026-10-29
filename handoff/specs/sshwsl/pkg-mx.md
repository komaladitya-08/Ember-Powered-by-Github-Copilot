# Package MX: the framed stream (mux) both ends share

Read first: `specs/pkg-common.md`, `specs/sshwsl/pkg-common.md`, then `specs/sshwsl/design.md`: header, §5.1.10
(framing and streams, normative), §5.1.11 (liveness numbers the mux reports), §5.4 (`Msg`, `OP_SCHEMAS`, `EV_SCHEMAS`,
`CAPS`), §11.4 (MX row), and "Critique resolutions" remote-23 and integration-16.

## Goal
Implement `app/main/remote/mux.ts`: the binary-safe framing, streams, credits and priorities of §5.1.10, used unchanged
by the PC's link worker (SA) and the remote agent (SB). Plain Node, no Electron, no koffi, no network.

## Start and merge
Starts when S0a has merged. Merges right after S0b, before SA and SB (their integration tests need you; until then they
use fakes of the `Mux` interface).

## Files you own
- `app/main/remote/mux.ts` (S0a stub: replace it, keep `createMux`'s signature).
- `test/unit/remote-mux.test.ts`.

## Shared files
None.

## Contract you implement

```ts
export function createMux(o: { read: NodeJS.ReadableStream; write: NodeJS.WritableStream; role: "pc" | "agent"; partsId: string; log: Logger }): Mux;
```

```ts
// app/main/remote/types.ts
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
  uninstall(host: HostRecord): Promise<void>;
  /** ssh -G for a destination the user typed (settings' Add, the consent card), with its carried options. */
  resolve(dest: string, o?: { port?: number; extra?: HostRecord["extra"]; via?: HostRecord["via"] }): Promise<HostRecord["resolved"] & { controlPath: string | null }>;
  onProgress(fn: (hostId: string, p: ConnectProgress) => void): () => void;
  stopAll(): Promise<void>;
  dispose(): Promise<void>;
}
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
```

You consume `Msg`, `OP_SCHEMAS`, `EV_SCHEMAS` and `CAPS` from `app/main/remote/protocol.ts` (S0a).

## What to build (all from §5.1.10)
- Preamble: the agent writes `\0EMBER-REMOTE/1 <partsId>\n`; the PC skips up to 64 KiB of noise before it and gives up
  after 20 s; the PC answers `\0EMBER-LOCAL/1 <partsId>\n`; a partsId mismatch is a protocol error (`o.partsId`).
- Frames `u32be length | u8 stream | u8 kind | payload`; streams 0 ctl, 1 data, 2 bulk, 3 diag; kinds 1 JSON, 2 BIN,
  3 CREDIT, 4 PING, 5 PONG, 6 RESET. ctl never credit-limited and always first; data chunks (`u32be msgId | u8 last |
  bytes`, ≤ 32 KiB, a message ≤ 4 MiB); bulk (`u32be channel | bytes ≤ 32 KiB`); diag dropped above 64 KiB queued.
- Credits: 64 KiB per credit-limited stream at start, grown up to 256 KiB only while the measured throughput keeps
  bytes in flight under 250 ms of transfer; never more ungranted bytes in flight; `inFlight()` reports bytes and
  throughput for the escalation deadline.
- Priority ctl > data > bulk > diag; write only while the stream accepts (`drain`).
- Validation: a frame over 1 MiB, an unknown stream or kind, or a JSON that fails its op's or event's schema → RESET and
  close. Messages are validated with the strict schemas before `onMessage` sees them; requests from the agent role's
  peer are allowed only in one direction (the agent never sends `req`: a `req` arriving at the PC is a protocol error).
- PING/PONG with `u64be` ms; `rttMs` and `silentMs()` maintained.

## Tests (OS-neutral; in-memory stream pairs)
`remote-mux.test.ts`: preamble noise ≤ 64 KiB accepted, more refused; partsId mismatch; caps (frame, message, chunk);
credits (start at 64 KiB, growth only under the 250 ms rule, never exceeded); priority (a ctl Stop overtakes 4 MiB of
queued bulk); chunking and reassembly of a 4 MiB data message; RESET on oversize, unknown stream/kind and schema
failure; a `req` sent by the agent role is refused at the PC; both roles over a pair of `PassThrough` streams with random
chunk boundaries (binary safety: every byte value, both ways).

## Acceptance criteria
- `npx tsc --noEmit`, `npm run lint`, `npm test` pass; no import of `electron`, `koffi` or any network module.
- SA's link worker and SB's serve can use `createMux` unchanged (state any extension you added).
