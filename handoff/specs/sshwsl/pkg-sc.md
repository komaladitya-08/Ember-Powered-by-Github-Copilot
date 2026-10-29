# Package SC: the PC's side of a remote target (remote perception, sidecar, apps, runner, gate 1)

Read first: `specs/pkg-common.md`, `specs/sshwsl/pkg-common.md`, `specs/sshwsl/decisions.md` (D3: the brain is local),
then `specs/sshwsl/design.md`: header, "Limitations and departures" (L4, L5, L12, L16, L20), §2.6 (the SSH column of the
hands table), §3.1 (`CommandRunner`), §3.16 (what gate 2 answers), §5.3.7, §5.4, §5.5, §7.2 (what the PC validates),
§10.1 (SC row), §11.4 (SC row), "Critique resolutions" rows naming SC (security-3, -8, integration-6, -7, -26).

## Goal
Turn one live `RemoteLink` into the objects a worker uses on a remote target: a `PerceptionPort` whose text is built on
the PC by Ember's own code, a `SidecarPort` that sends a mutation only with a fresh stamp from gate 1, an async app
catalogue, a `CommandRunner` over `cmd.*`, and gate 1 (a per-remote `PolicyEngine`: the remote OS's vocabulary, the
combined policy, every action confirmed, no grants). Nothing a remote sends ever becomes an instruction, an approval or
an action on the PC.

## Start and merge
Starts when S0b has merged (the perception text functions). Use a fake `RemoteLink`. Merges after SB, before WB.

## Files you own
- `app/main/remote/{target (S0a stub),remote-perception,remote-sidecar,remote-apps,remote-runner,remote-capture,remote-policy}.ts`
- `test/unit/remote-{perception,sidecar,apps,runner,capture,policy}.test.ts`

## Shared files
None.

## Contracts you implement (normative)

```ts
/** What the targets runtime builds for one live link (remoteTargetParts in app/main/remote/target.ts). */
export interface RemoteTargetParts {
  perception: PerceptionPort;
  sidecar: SidecarPort;
  /** The remote's apps: list cached from apps.list (refreshed at most every 60 s); launch through apps.launch. */
  apps: WorkerSystem["apps"];
  runner: CommandRunner;
  /** Gate 1 for this remote (§2.6's table). */
  policy: PolicyEngine;
  system: WorkerSystem;
  binding: () => TargetBinding;
  onAuthorized(stamp: ActStamp): void;
  dispose(): void;
}

export function remoteTargetParts(link: RemoteLink, o: {
  log: Logger;
  settings: SettingsStore;
  /** The PC's admin policy with its source (R5) and the remote's summary combine into gate 1's inputs. */
  localAdmin: () => LoadedAdminPolicy;
  hostLabel: string;
  login: string;
}): RemoteTargetParts;
```

## Contracts you consume

```ts
/** What workers and the host use of a screen's perception: the local Perception, the desk's, or a remote's. */
export type PerceptionPort = Pick<Perception, "focused" | "read" | "atPoint" | "quickContext" | "describe" | "perceive" | "systemDialogOpen" | "windows">;
/** What Perception uses of its reader (AtspiSidecar, or WSL's routed one). */
export type PerceptionSidecar = Pick<AtspiSidecar, "listWindows" | "readWindow" | "atPoint" | "secretFields" | "markSecret" | "shellOverlays" | "scaleElements" | "readElement">;
/** What a worker uses of the reader, plus the remote's step stamp. */
export type SidecarPort = Pick<AtspiSidecar, "readElement" | "canDo" | "doAction" | "setText" | "setValue" | "selectOption" | "listOptions" | "scaleOf" | "stop">;
/** What gate 1 decided about a step, sent with it to a remote (a record for gate 2, never a credential). */
export interface ActStamp {
  taskId: string;
  kind: ActionKind;
  app: string;
  window: string;
  element: { role: string; name: string } | null;
  /** sha256Hex of the value typed, chosen or set (never the value). */
  valueSha256?: string;
  verdict: "allow" | "confirm";
  /** The user's yes, when one was given (its age travels in ageMs). */
  approval: { given: true } | null;
  /**
   * Milliseconds since the decision (or since the user's yes, when asked), measured on the PC's monotonic clock when
   * the step is sent; gate 2 refuses ≥ 10 000. No absolute time crosses machines (critique integration-6).
   */
  ageMs: number;
}
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

```ts
/**
 * The PC ⇄ remote agent protocol: messages inside the framed SSH stdio (mux.ts). Every message is validated with the
 * strict zod schema of its op or event, on both ends; anything else resets the link. The PC sends requests; the agent
 * answers them and sends events. The agent never sends a request, so nothing it says can make the PC do anything
 * but display data, stop, or mark the link lost.
 */

import { z } from "zod";
import type { OS } from "../../shared/shortcuts";
import type { AdminSummary } from "../admin";
import type { Seen, WindowTarget } from "../perception";
import type { ActionResult, AxWindow, Bounds, CanDo, ElementInfo, PointElement } from "../perception/sidecar";
import type { ActStamp } from "../perception/ports";
import type { TextMode } from "../policy/policy";
import type { GitFacts, PathFact, RunExit, RunnerFacts, RunSpec } from "../commands/types";
import type { DesktopAccess } from "../targets/types";

export const PROTO = 1;

export type Msg =
  | { t: "req"; id: number; op: Op; a: unknown }
  | { t: "res"; id: number; ok: true; v: unknown }
  | { t: "res"; id: number; ok: false; e: { code: ErrCode; m: string } }
  | { t: "ev"; ev: EvName; d: unknown };

export type ErrCode = "bad_request" | "unknown_op" | "not_ready" | "denied" | "needs_confirm" | "changed" | "stale"
  | "stopped" | "busy" | "gone" | "too_large" | "internal";

export type Op =
  | "hello" | "policy.sync" | "desktop.state"
  | "perceive.read" | "perceive.focused" | "perceive.perceive" | "perceive.atPoint" | "perceive.windows"
  | "perceive.openWindows" | "perceive.systemDialog"
  | "ax.readElement" | "ax.canDo" | "ax.listOptions"
  | "act" | "apps.list" | "apps.launch"
  | "cmd.facts" | "cmd.inspect" | "cmd.git" | "cmd.run" | "cmd.input" | "cmd.stop"
  | "stop" | "audit.recent" | "bye";

export type EvName = "desktop.changed" | "cmd.exit" | "console.stop" | "policy.changed" | "notice" | "log";

export interface Hello {
  proto: 1;
  partsId: string;
  /** The PC's name as the remote's audit records it (os.hostname(), ≤ 64 chars; unverified there). */
  local: { name: string; os: OS };
  /** This Ember install's id (§5.1.13): 32 hex digits; the agent checks it equals the one on its argv. */
  pcId: string;
  /** The per-host consent the user gave on the PC. */
  consent: { version: number; at: string };
  /** The never-look list in force on the PC (the user's and the PC admin's); the agent adds its own admin's. */
  neverLook: string[];
  localAdmin: AdminSummary;
  epoch: number;
}

export interface Welcome {
  proto: 1;
  partsId: string;
  os: "linux" | "darwin" | "win32";
  arch: "x64" | "arm64";
  machineIdHash: string;
  isWsl: boolean;
  uid: number;
  user: string;
  home: string;
  facts: RunnerFacts;
  desktop: DesktopState;
  remoteAdmin: AdminSummary;
  pid: number;
  /** The macOS "full disk access for remote users" check failed (protected folders unreadable to commands, L6). */
  tccLimited?: boolean;
  /** The command grace this agent applies (s): the smaller of both machines' ssh.commandGraceSeconds (L10). */
  graceSeconds: number;
}

export interface DesktopState {
  access: DesktopAccess;
  why?: string;
  session?: { type: "x11" | "wayland"; locked: boolean; active: boolean };
  notice: "shown" | "failed" | "off";
}

/** Seen (perception/index.ts) as plain data: every field as there, validated with CAPS. */
export type SeenWire = Seen;

/** A screenshot's bytes travel on a bulk channel before its answer; the answer says where and what. */
export interface ImageRef { channel: number; bytes: number; sha256: string; width: number; height: number; rect: Bounds; scale: number; mime: "image/png" }

/** A remote app as the PC judges it: argv and Terminal= come from its .desktop file, so gate 1 follows wrappers like gate 2 (critique integration-7). */
export interface RemoteApp { id: string; name: string; keywords?: string[]; categories?: string[]; argv?: string[]; terminal?: boolean }

export type ActOp =
  | { op: "do_action"; id: number; action: string }
  | { op: "set_text"; id: number; text: string; mode: TextMode }
  | { op: "set_value"; id: number; value: number }
  | { op: "select_option"; id: number; option: string };

export type GateAnswer =
  | { status: "ok" }
  | { status: "deny" | "needs_confirm"; reason: string }
  | { status: "changed" | "stale" | "stopped" };

/** Each op's arguments and result. */
export interface OpMap {
  "hello": [Hello, Welcome];
  "policy.sync": [{ neverLook: string[]; localAdmin: AdminSummary }, Record<string, never>];
  "desktop.state": [Record<string, never>, DesktopState];
  "perceive.read": [{ target: WindowTarget; keep?: boolean; cells?: string[] }, SeenWire];
  "perceive.focused": [Record<string, never>, SeenWire];
  "perceive.perceive": [{ image: boolean; scope: "window" | "screen"; target?: WindowTarget }, { seen: SeenWire; image: ImageRef | null; noShot?: string }];
  "perceive.atPoint": [{ target: WindowTarget; x: number; y: number; k: number }, { chain: PointElement[] | null }];
  "perceive.windows": [Record<string, never>, { windows: AxWindow[] }];
  "perceive.openWindows": [Record<string, never>, { lines: { app: string; title: string; active: boolean; busy?: boolean }[] }];
  "perceive.systemDialog": [Record<string, never>, { open: boolean }];
  "ax.readElement": [{ id: number; shown?: boolean; formula?: boolean }, ElementInfo];
  "ax.canDo": [{ id: number; kind: "click" | "toggle" | "text" | "value"; caret: boolean }, CanDo];
  "ax.listOptions": [{ id: number }, { options: string[]; left?: number }];
  "act": [{ opId: string; epoch: number; stamp: ActStamp } & ActOp, GateAnswer & { result?: ActionResult }];
  "apps.list": [Record<string, never>, { apps: RemoteApp[] }];
  "apps.launch": [{ epoch: number; appId: string; stamp: ActStamp }, GateAnswer & { pid?: number }];
  "cmd.facts": [Record<string, never>, RunnerFacts];
  "cmd.inspect": [{ paths: string[]; cwd: string }, { paths: PathFact[] }];
  "cmd.git": [{ cwd: string }, { git: GitFacts | null }];
  "cmd.run": [{ epoch: number; spec: RunSpec }, { status: "started"; channel: number; interactive: boolean } | { status: "deny" | "needs_confirm"; reason: string; says?: string[]; rules?: string[] }];
  "cmd.input": [{ runId: string; data: string /* base64, ≤ 4 KiB decoded; never logged */ }, Record<string, never>];
  "cmd.stop": [{ runId: string; why: "user" | "task" | "timeout" }, Record<string, never>];
  "stop": [{ epoch: number }, { ms: number; late: string[] }];
  "audit.recent": [{ limit: number }, { entries: Record<string, unknown>[] }];
  "bye": [Record<string, never>, Record<string, never>];
}

export interface EvMap {
  "desktop.changed": DesktopState;
  "cmd.exit": { runId: string; exit: RunExit; outBytes: number };
  "console.stop": { at: string };
  "policy.changed": AdminSummary;
  "notice": { state: "shown" | "failed" | "off" };
  "log": { level: "debug" | "info" | "warn" | "error"; event: string };
}

export type OpArgs<O extends Op> = OpMap[O][0];
export type OpResult<O extends Op> = OpMap[O][1];

/** zod schemas, one per op's args and result and per event, `.strict()`, with CAPS. */
export const OP_SCHEMAS: { readonly [O in Op]: { args: z.ZodType<OpArgs<O>>; result: z.ZodType<OpResult<O>> } };
export const EV_SCHEMAS: { readonly [E in EvName]: z.ZodType<EvMap[E]> };

export const CAPS = {
  ctlBytes: 64 * 1024, dataMessageBytes: 4 * 1024 * 1024, frameBytes: 1024 * 1024, chunkBytes: 32 * 1024,
  str: { app: 200, title: 1000, name: 1000, role: 64, state: 32, text: 4000, reason: 500, path: 4096, command: 8000 },
  nodes: 2000, states: 40, windows: 200, chain: 50, options: 500, lines: 200, paths: 64, neverLook: 300,
  image: { bytes: 8 * 1024 * 1024, side: 4096 }, coord: 100_000, auditEntries: 200,
} as const;
```

S0b's `perceivedText`, `describeText`, `quickContextText`, `openWindowsBlock`; `marksSvg`; sharp (PC side only);
`combineAdmin`, `adminSummary`; CL's `trackSecretPrompts`; `PolicyEngine`.

## What to build (normative details in §5.5)
- **RemotePerception**: the ops; `describe`/`quickContext` built on the PC from structured data with S0b's text
  functions (every remote string quoted and wrapped by Ember's code; `quickContext` carries `targetId`); images: wait
  for the PNG on its bulk channel, check size, sides, SHA-256, decode with sharp (`limitInputPixels: 4096 * 4096`,
  `failOn: "error"`), draw the marks, re-encode JPEG; coordinates are the remote's (never flown to).
- **RemoteSidecar**: reads via `ax.*`; each mutation needs the stamp from `onAuthorized` (called by the worker
  immediately before the step), ≤ 10 s old on the PC's monotonic clock, fitting kind and element; consumed; `ageMs` set
  when `act` is sent; `changed`/`stale`/`stopped`/`deny` mapped; **desktop `needs_confirm` → denied in v1**.
- **RemoteApps**: cached list (≤ 60 s); `find`/`isTerminalApp` with the remote OS's vocabulary using `RemoteApp.argv`
  and `terminal`; `launch` is async, needs a fresh stamp, and throws gate 2's words.
- **RemoteRunner**: `facts`, `inspect`, `gitFacts`, `start` (`cmd.run` with the stamp; a `needs_confirm` answer ends
  `done` as `refused-remote` with `needsConfirm`, `remoteSays` and the extra `rules`), `input` (base64, never logged),
  `stop`, output on the bulk channel, the secret tracker on the PC, `ended: "lost"` on loss.
- **Gate 1** (`remote-policy.ts`): the per-connection `PolicyEngine` of §2.6's SSH column.
- **Validation** (§7.2): every result checked against `OP_SCHEMAS` (the link already validated; check the semantic
  rules: element ids seen in this link's reads, bounds within `CAPS.coord`, `desktop.changed` only lowers access).

## Tests (OS-neutral; a fake link)
§10.1's SC row: text byte-identical to local Perception for the same `Seen`; a remote string with `</screen>` stays
quoted; stamps required, consumed, `ageMs` at send; `changed`/`needs_confirm` mapping; async `launch` throws the
refusal; `RemoteApp.argv`/`terminal` judged; `cmd.run` needs_confirm → `refused-remote` with `remoteSays`; image checks
and limits; gate-1 engine inputs (remote vocabulary, combined policy, confirm every action, no grants).

## Acceptance criteria
- `remoteTargetParts` exactly as above; `npx tsc --noEmit`, `npm run lint`, `npm test` pass.
- No remote message can reach the Confirmer, a bubble action, a setting, a local path, a URL, a window, a process or a
  model instruction (tests prove the obvious attempts fail).
