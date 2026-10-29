# Package SA: the SSH transport (connect, prompts, bootstrap, install streaming, the link)

Read first: `specs/pkg-common.md`, `specs/sshwsl/pkg-common.md`, `specs/sshwsl/decisions.md` (D2, D3, R2, R4, R10, R11),
then `specs/sshwsl/design.md`: header, "Limitations and departures" (L10, L14, L15, L21-L24), §2.7, §5.1 entirely,
§5.2.1-§5.2.5 (what you download, stream and verify), §5.4 (`hello`, the protocol), §7.2-§7.3, §8.6-§8.8 (prompt cards,
messages, doctor rows), §9.1 (`hostAllowed`, `ssh.*` keys), §10.1-§10.2 (SA rows), §11.4 (SA row), "Critique
resolutions" rows naming SA (remote-1..6, -10, -11, -16..24, -27, -29, wsl-14, integration-30).

## Goal
Open Ember's own SSH connection to a host the user chose, with the user's own SSH settings and keys but hardened so
nothing is forwarded, no master is left behind and no prompt pops up anywhere but Ember's prompt window; probe the
remote, refuse before uploading anything when a check fails, stream and verify the helper, and carry the framed
protocol over one ssh process run from a worker thread. Plain Node in main's process (the link worker) and an askpass
helper; no network listener (the askpass channel is a per-run local socket or pipe).

## Start and merge
Starts when S0a has merged. Use a fake `Mux` until MX merges. Merges after WA, before SB.

## Files you own
- `app/main/remote/{ssh-argv,ssh-config,ssh-errors,destination,askpass-server,askpass-pipe,askpass-win,link,link-worker (S0a stub),bootstrap,plan,runtime-download,parts-cache,connections (S0a stub),same-machine,notice-ssh}.ts`
- `app/main/remote/scripts/{bootstrap.sh,uninstall-request.sh}`, `resources/ssh/ember_askpass.cs`
- `app/askpass/main.ts` (S0a stub)
- `test/unit/{ssh-argv,ssh-config,ssh-errors,ssh-destination,ssh-notice,remote-plan,remote-same-machine,remote-bootstrap-io,askpass-server,askpass-pipe,runtime-download}.test.ts`
- `test/integration/{ssh-transport,ssh-windows}.test.ts`

## Shared files
None. (The `ssh-linux` and `wsl-windows` jobs run your integration files; SB and WA own their set-up: ask them through
your report for any set-up step you need, e.g. the jump-host sshd on 2223.)

## Contracts you implement (normative)

```ts
export function createConnections(o: {
  log: Logger; os: OS; userData: string; appDir: string; execPath: string; resourcesPath: string; settings: SettingsStore;
  admin: () => LoadedAdminPolicy; prompts: PromptUi; fetch: TargetsDeps["fetch"]; allowLoopback: boolean;
  audit: () => AuditLog | null; pcId: () => string; wsl: () => WslService | null; jobHost: JobHostRef | null;
}): Connections;
export function sshArgv(o: SshArgvOptions): string[];            // §5.1.4 (define SshArgvOptions in ssh-argv.ts)
export function parseSshG(text: string): SshConfig;              // §5.1.3
export function classifySshFailure(stderr: string, exitCode: number | null, o: { probeBegan: boolean; os: OS; darwinMajor?: number; lan?: boolean }): { kind: string; message: string; fix?: string; retry: boolean };
export function validDest(s: string): boolean;
export function validHop(s: string): boolean;
export function planInstall(probe: Record<string, string>, local: PlanLocal): Plan;   // §5.1.9
```

```ts
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

/** The destination an OpenSSH client command line connects to, or null (a -V, -G, -O, -Q run, a -W/-N tunnel, no host). */
export function sshDestination(argv: readonly string[]): SshSeen | null;

/**
 * The user's own ssh client processes now: pid and argv (Linux /proc/<pid>/cmdline of own-uid "ssh" processes;
 * macOS `ps -U <uid> -o pid=,args=`; Windows a CIM query for ssh.exe of this session; with WSL on, also each running
 * distro's own-uid ssh processes through one fixed `wsl.exe -d <d> --exec /bin/sh -s` reader of /proc/*/cmdline,
 * script on stdin). Null when it can't be read.
 */
export function userSshProcesses(os: OS, o?: { wsl?: { exe: string; distros: string[] } }): Promise<{ pid: number; argv: string[]; via: SshSeen["via"] }[] | null>;
```

```ts
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

## Contracts you consume

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

`createMux` (MX, `partsId` in its options), `hostAllowed` and `combineAdmin` (`admin.ts`), `WslService.bootIds()` and
`WslService` for `via: "wsl:<d>"` (WA), `PromptUi` (UI), `JobHostRef` (S0a).

## What to build (normative details in §5.1)
- **Client** (§5.1.1): absolute paths; ≥ 7.6 (Windows ≥ 8.1); `OpenSSH_for_Windows_` parsed; via WSL `/usr/bin/ssh` in the
  distro.
- **Resolve** (§5.1.3): `ssh -G` with the carried options; known-hosts refusals incl. `NUL`; `hostAllowed` for the host
  and every hop; ProxyJump rewritten into the hardened ProxyCommand chain (≤ 3 hops; `%` doubled per nesting; Windows one
  hop, verify on `ssh-windows`, else refuse with §8.7's message); ≥ 8.7 session options.
- **Argv** (§5.1.4): exactly the listed options, always `ControlMaster=no`, `ControlPath=none` unless riding a checked
  master; batch environment (`SSH_ASKPASS_REQUIRE=never`, no `SSH_ASKPASS`, no `DISPLAY`); `detached: true` on POSIX, the
  job host on Windows.
- **Connect flow** (§5.1.5): batch first; interactive on unknown key or auth (askpass available); the 45 s deadline,
  paused while a prompt is open; changed key refused.
- **Askpass** (§5.1.6): POSIX wrapper + `askpass.cjs` (prompt after the script path); per-run sockets in short
  `mkdtemp` folders (≤ 100-byte paths); nonce, one prompt at a time; the jump host's prompt labelled with its host;
  **Windows**: Win32-OpenSSH ≥ 8.4 with `SSH_ASKPASS_REQUIRE=force`, the helper `ember-askpass.exe` compiled at first use
  from `resources/ssh/ember_askpass.cs` by Windows PowerShell 5.1's `Add-Type -OutputType ConsoleApplication` into
  `<userData>\ssh\` (verified by SHA-256, rebuilt on update; FullLanguage only), talking to a named pipe with a
  user-SID-only DACL, `PIPE_REJECT_REMOTE_CLIENTS` and `FILE_FLAG_FIRST_PIPE_INSTANCE`; never a `.cmd`, never Ember.exe.
- **Failure classes** (§5.1.8) and messages (§8.7).
- **Bootstrap** (§5.1.9): the fixed script; **nothing written before `EMBER-PROBE-END`, no archive before its
  `EMBER-READY`**; the probe keys (incl. `kernel`, `macos`, `fapolicyd`, `selinux`, `tcc`, `tmp`, `host`, `boot`,
  `session` parsed by name); `planInstall` in order; the install lock; the exec check; `INSTALL`/`SERVE` lines with `pcId`.
- **Runtime download** (§5.2.1): `minimum`/`pinned`, xz or gz, `net.fetch` through `o.fetch`, SHA-256 before anything is
  sent; the admin mirror.
- **Link** (§5.1.10-§5.1.13): the link worker thread owning ssh, the mux, pings, "stalled" at 5 s, "lost" at the grace,
  the escalation deadline from RTT and bytes in flight (≤ 10 s), epoch fencing on Stop; reconnect with backoff, `busy`
  retryable for the same `pcId`.
- **Same machine** (§5.1.14): loopback/own addresses, machine-id **and** boot id, the PC's WSL boot ids; the test switch.
- **Noticing** (§2.7): `sshDestination` with the carried options; `userSshProcesses` (Linux `/proc`, macOS `ps`,
  Windows CIM, WSL reader).
- **Uninstall** (§5.2.7) through the same bootstrap.

## Tests
- Unit (OS-neutral; a fake ssh process, fake fs and timers): §10.1's SA row in full, especially the bootstrap I/O order
  (critique remote-1, -17), the argv cases ("ControlMaster auto + ControlPersist" config, a two-hop ProxyJump, carried
  options), the failure classes, the validators against injection, the same-machine rules, askpass paths and nonces, the
  Windows helper source compiled only in FullLanguage (fake PowerShell), pinned-hash and minimum checks.
- Integration (`EMBER_SSH_TEST=1`, `EMBER_TEST_ALLOW_LOOPBACK_SSH=1`): `ssh-transport.test.ts` in `ssh-linux` (-G, batch,
  unknown key → interactive with a fake prompt UI, changed key refused, auth classes, ProxyJump through the 2223 hop,
  no master left behind); `ssh-windows.test.ts` in `wsl-windows` (Win32-OpenSSH batch connect, 4 MiB both ways through
  the mux, `ControlMaster=no`/`ControlPath=none` accepted, the `wsl=1` loopback refusal, askpass ≥ 8.4).

## Acceptance criteria
- `createConnections` and the exports above; `npx tsc --noEmit`, `npm run lint`, `npm test` pass.
- No network listener anywhere; no secret on any argv or in any log; the GitHub token absent from every child
  environment.
- Integration green in CI, or reported "not run" with the reason.
