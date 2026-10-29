# Package TG: the targets runtime (wires every piece together)

Read first: `specs/pkg-common.md`, `specs/sshwsl/pkg-common.md`, `specs/sshwsl/decisions.md`, then
`specs/sshwsl/design.md`: header, "Limitations and departures", §2 entirely, §3.8.1 (modes), §3.9 (panels, consent,
`questionWords`), §4.1-§4.2 (WSL service), §5.1 (connections), §5.5 (remote parts), §7.4 (consent records), §8 (menu,
bubble messages, settings, consent cards, doctor rows), §9 (admin), §10.1 (TG row), §11.3 (the `main.ts` hooks that
call you), §11.4 (TG row), "Critique resolutions" rows naming TG (wsl-13, -14, -22, remote-20, integration-3, -5, -15,
-24, -25).

## Goal
Replace S0a's local-only `createTargets` with the real runtime: the registry of targets, binding from the user's words,
per-target hands and command services (local, WSL, SSH), consent cards, the ssh-noticing offer, the settings IPC, the
menu, the bubble actions, the quick context for a remote, the kill-switch part, the doctor rows and `pcId`. You wire
the factories of RUN, CL, UI, WA, SA and SC; you change no shared file unless a hook is missing (then list it).

## Start and merge
Starts when S0b has merged (code against the other packages' S0a stubs and fakes; their real factories land before
you). Merges last of the main packages (after AG).

## Files you own
- `app/main/targets/{runtime (S0a stub),registry,resolve,hands,local-service,wsl-service,remote-service,consent,menu,quick-context,doctor,ipc,offer}.ts`
- `test/unit/targets-{resolve,registry,hands,runtime,offer,quick-context,ipc}.test.ts`

## Shared files
`app/main/main.ts` only if a hook of §11.3 is missing or wrong (list it as "Needs from S0b" if you can't).

## Contracts you implement (normative)

```ts
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

/** The parts of a target id, or null when it isn't one (fail closed: an unknown id is never acted on). */
export function parseTargetId(id: string): { kind: TargetKind; name: string } | null;

/** A target id from its parts; throws when `name` breaks DISTRO_NAME or HOST_ID. */
export function targetIdOf(kind: "wsl" | "ssh", name: string): TargetId;

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
}
```

```ts
import type { OS } from "../../shared/shortcuts";
import type { TargetId, TargetKind, TargetSummary } from "../../shared/targets";
import type { Hands } from "../agent/host";
import type { WorkerSystem } from "../agent/worker";
import type { CommandService } from "../commands/types";
import type { ActStamp } from "../perception/ports";
import type { QuickContext } from "../perception";
import type { Question } from "../agent/confirm";
import type { PlatformDoctorRow } from "../platform/types";
import type { WslService } from "../wsl/types";

/**
 * How much of a target's desktop Ember may use. "screen": perceive with screenshots, open apps, act by accessibility
 * (and the borrowed mouse where the target's hands offer it); "text": perceive without screenshots, open apps, act by
 * accessibility; "none": no desktop (headless, a locked or foreign session, a policy that forbids it).
 */
export type DesktopAccess = "screen" | "text" | "none";

/** A task's target as the worker sees it (built by the targets runtime from local data only). */
export interface TargetBinding {
  id: TargetId;
  kind: TargetKind;
  /** TargetSummary.label. */
  label: string;
  login?: string;
  /** The OS whose vocabulary judges the target's windows (WSL: "win32", the screen is Windows'). */
  screenOs: OS;
  /** The OS commands run on (WSL: "linux"; a macOS remote: "darwin"). */
  shellOs: OS;
  desktop: DesktopAccess;
  /** Why `desktop` is "none" or "text", in plain words ("build-01 has no desktop session for deploy"). */
  desktopWhy?: string;
}

/** What a worker on one target gets: the screen's hands, that OS's system, and the target's commands. */
export interface TargetHands extends Hands {
  binding: TargetBinding;
  system: WorkerSystem;
  /** null: no commands here (off, or not offered on this kind of target). */
  commands: CommandService | null;
  /** The settings.grants key for an app on this target (local: lower-case app; remote: "ssh:<id>:<app>"). */
  grantKey(app: string): string;
  /** The TaskManager lease key for a window key (local and WSL: unchanged, they share this screen; SSH: "<target id>|<key>"). */
  leaseKey(windowKey: string): string;
  /**
   * The worker's policy said yes to this step: called immediately before the step runs (after the window lease and the
   * pre-step pause, worker.ts:1751-1769), with `ageMs` measured then. Remotes attach it to the step (§5.5).
   */
  onAuthorized?(stamp: ActStamp): void;
}

/** What the conductor's and worker's prompts may promise (§3.15): both false gives today's exact texts. */
export interface PromptCaps {
  /** Commands are on (or waiting only for the user's card) on at least one target. */
  commands: boolean;
  /** A targets runtime with more than "local" exists, or SSH is allowed: list_computers and offer_connect are offered. */
  targets: boolean;
}

/** What AgentHost asks of the targets runtime (HostOptions.targets). */
export interface TargetsForAgent {
  /** The target requests go to when they name none (the picker's choice). */
  readonly active: TargetId;
  /**
   * The target a task starts on (§2.3): one the user's own words name, else the model's `choice` if the user's words
   * name it too, else the active one. Two different targets named: refused.
   */
  bind(o: { userWords: string; choice?: string }): { ok: true; binding: TargetBinding } | { ok: false; why: string };
  /**
   * The hands a worker on `id` gets now; refused (with why) when the target can't be used. `local` without a window
   * system gives commands-only hands (`desktop: "none"`, perception and sidecar ports that refuse every call).
   */
  handsFor(id: TargetId): { ok: true; hands: TargetHands } | { ok: false; why: string };
  /** list_computers's answer (§2.6). */
  describeTargets(): string;
  /** describe_screen on a target other than this screen; null when `id` is this screen. */
  describeScreen(id: TargetId): Promise<string> | null;
  /** offer_connect: shows the user a Connect button for a host their words named; returns what to tell the model. */
  offerConnect(name: string, userWords: string): string;
  /**
   * A short line for each request, saying where Ember is set to work and what commands can do now (trusted: built from
   * local data): "(Ember is set to work on build-01, connected as deploy: commands only. Commands: on for this
   * computer; off in Ubuntu (WSL).)". Empty only when the active target is "local", nothing else is connected and no
   * target has commands on or awaiting consent.
   */
  activeLine(): string;
  /** What the prompts may promise now (§3.15). */
  caps(): PromptCaps;
}

/** The targets runtime main builds once (createTargets in app/main/targets/runtime.ts). */
export interface TargetsRuntime {
  readonly agent: TargetsForAgent;
  /** WSL on this PC (Windows only; null elsewhere or when the admin turned WSL off). */
  readonly wsl: WslService | null;
  /** The kill switch's "targets" part: every command stopped and every remote told to stop; never throws. */
  stopAll(): Promise<void>;
  /** What the quit question names. */
  busy(): { commands: number; connections: number };
  /** The handle menu's "Work on" submenu (plain objects main hands to Menu.buildFromTemplate). */
  menuItems(): MenuItemLike[];
  /** Bubble action ids this runtime owns ("target:…", "offer:…", "conn:…", "ui:panel:…", "ui:cmdstop:…"); true when handled. */
  bubbleAction(id: string): boolean;
  /** The quick context when the active target isn't this screen (a promise), or null to take the local one. */
  quickContext(): Promise<QuickContext | null> | null;
  /** A question came up (or went: null): show or hide its panel window. */
  questionChanged(q: { n: number; question: Question } | null): void;
  /** Question n's panel is on screen showing all of it (the approve chord's guard, R7). */
  panelReady(n: number): boolean;
  /** What to speak and put in a notification for a question with a panel; null: the question's own prompt. */
  questionWords(q: Question): string | null;
  /** Doctor and setup-check rows (SSH client, WSL, command window terminal, remote parts). */
  doctorRows(): Promise<PlatformDoctorRow[]>;
  summaries(): TargetSummary[];
  dispose(): Promise<void>;
}

/** The fields of Electron's MenuItemConstructorOptions the targets menu uses (main passes them through). */
export interface MenuItemLike {
  label?: string;
  type?: "normal" | "separator" | "submenu" | "radio";
  checked?: boolean;
  enabled?: boolean;
  submenu?: MenuItemLike[];
  click?: () => void;
}
```

```ts
/** The targets the user's own words name for this request (deduplicated, in order of appearance). */
export function targetsNamed(words: string, targets: readonly NamedTarget[]): TargetId[];

/** A target's names: its label, its alias, its hostname (SSH), its distro name (WSL); "local" has fixed words. */
export interface NamedTarget { id: TargetId; names: string[] }
```

```ts
export interface TargetsDeps {
  log: Logger;
  os: OS;
  sys: SystemPlatform;
  userData: string;
  /** dist/app (askpass.cjs, remote-link.cjs, job-host.cjs). */
  appDir: string;
  resourcesPath: string;
  execPath: string;
  packaged: boolean;
  settings: SettingsStore;
  /** The PC's policy with its source (R5). */
  admin: () => LoadedAdminPolicy;
  audit: () => AuditLog | null;
  confirmer: () => Confirmer | null;
  /** This screen's hands (null without a window system: then local is commands-only, §2.6). */
  localHands: Hands | null;
  showState: (patch: Partial<EmberState>) => void;
  notify: (title: string, body: string) => void;
  openSettings: (section?: "computers" | "commands") => void;
  ipc: IpcLike;
  /** The settings (home) window's page: the only sender TARGETS_IPC accepts (critique integration-5). */
  isHome: (sender: WebContentsLike) => boolean;
  windows: { command: () => BrowserWindowLike; prompt: () => BrowserWindowLike };
  /** Electron's net.fetch (system proxy), for the Node runtime downloads. */
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }>;
  /** main's devEnv: unpackaged-only switches (EMBER_TEST_ALLOW_LOOPBACK_SSH). */
  devEnv: (name: string) => string | undefined;
  /** Ember runs elevated (Windows: the platform's TokenElevation, `win32/system/environment.ts`; POSIX: uid 0). */
  elevated: () => boolean;
  /** Ember's own pids now: app.getAppMetrics() plus the sidecar's, voice's and the desk's (D4.5, live). */
  emberPids: () => number[];
  /** Folders to add to commands' PATH on this PC (macOS: extraBinDirs that exist; else []). */
  extraPath: () => string[];
  /** Ember's job host (Windows; null elsewhere). */
  jobHost: JobHostRef | null;
}

/** The parts of ipcMain the runtime uses; every handler checks the sender itself. */
export interface IpcLike {
  on(channel: string, fn: (event: { sender: WebContentsLike }, ...args: unknown[]) => void): void;
  handle(channel: string, fn: (event: { sender: WebContentsLike }, ...args: unknown[]) => unknown): void;
}
export interface WebContentsLike { readonly id: number; send(channel: string, ...args: unknown[]): void }
export interface BrowserWindowLike {
  readonly webContents: WebContentsLike;
  show(): void; showInactive(): void; hide(): void; focus(): void; close(): void; moveTop(): void;
  isVisible(): boolean; isMinimized(): boolean; isDestroyed(): boolean; isAlwaysOnTop(): boolean; isFocused(): boolean;
  setAlwaysOnTop(flag: boolean, level?: "normal" | "floating" | "torn-off-menu" | "modal-panel" | "main-menu" | "status" | "pop-up-menu" | "screen-saver"): void;
  setBounds(b: { x?: number; y?: number; width?: number; height?: number }): void;
  setContentProtection(enable: boolean): void;
  on(event: "closed" | "focus" | "blur" | "show" | "hide", fn: () => void): void;
}
```

```ts
export function createTargets(deps: TargetsDeps): TargetsRuntime;
export function targetDoctorRows(o: { os: OS; sys: SystemPlatform; admin: () => LoadedAdminPolicy; resourcesPath: string; packaged: boolean }): Promise<PlatformDoctorRow[]>;
```

## Factories you consume (their packages' final signatures)

```ts
// RUN
export function createLocalRunner(o: { log: Logger; os: OS; env: NodeJS.ProcessEnv; ember: { paths: string[]; pids: () => number[]; names: RegExp }; home: string; user: string; elevated: () => boolean; extraPath: string[]; jobHost: JobHostRef | null }): CommandRunner;
// UI
export function createCommandWindowPort(o: { create: () => BrowserWindowLike; ipc: IpcLike; log: Logger; os: OS; keyHint: () => string | null }): CommandWindowPort & { show(): void; owns(sender: WebContentsLike): boolean; dispose(): void };
export function createPromptWindow(o: { create: () => BrowserWindowLike; ipc: IpcLike; log: Logger; os: OS }): PromptUi & { showConsent(n: number, c: ConsentPanel): void; hideConsent(n: number): void; consentReady(n: number): boolean; dispose(): void };
// WA
export function createWsl(o: { log: Logger; env: NodeJS.ProcessEnv; os: OS; ember: { winPaths: string[] }; jobHost: JobHostRef | null }): WslService | null;
// SA
export function createConnections(o: { log: Logger; os: OS; userData: string; appDir: string; execPath: string; resourcesPath: string; settings: SettingsStore; admin: () => LoadedAdminPolicy; prompts: PromptUi; fetch: TargetsDeps["fetch"]; allowLoopback: boolean; audit: () => AuditLog | null; pcId: () => string; wsl: () => WslService | null; jobHost: JobHostRef | null }): Connections;
export function sshDestination(argv: readonly string[]): SshSeen | null;
export function userSshProcesses(os: OS, o?: { wsl?: { exe: string; distros: string[] } }): Promise<{ pid: number; argv: string[]; via: SshSeen["via"] }[] | null>;
// SC
export function remoteTargetParts(link: RemoteLink, o: { log: Logger; settings: SettingsStore; localAdmin: () => LoadedAdminPolicy; hostLabel: string; login: string }): RemoteTargetParts;
// admin.ts (S0a)
export function commandMode(loaded: LoadedAdminPolicy, kind: TargetKind): CommandMode;
export function combineAdmin(local: AdminSummary, remote: AdminSummary): AdminSummary;
export function adminSummary(loaded: LoadedAdminPolicy): AdminSummary;
```

## What to build
- **Registry** (§2.2): `local` always; `wsl:<d>` per §2.2 (hidden Docker/Rancher, Podman "tool" asks, `needsSetup`
  never started); `ssh:<id>` per host record and link state ("connecting", "ready", "stalled" shown as ready with a
  warning, "lost", "off").
- **Binding** (§2.3): `targetsNamed` and `bind` exactly; WSL's "first visible distro" rule.
- **Hands** (§2.6 table): local (main's; commands-only hands when `localHands` is null), WSL (same screen, **lease key
  identity**), SSH (`remoteTargetParts`; a per-connection PolicyEngine; no tier 3; `currentWindow` null).
- **Command services**: local (RUN's runner + UI's window + CL), WSL (`WslService.runner`), SSH (SC's `RemoteRunner`);
  `capability()` from `commandMode` (stricter of both machines for SSH), the user's switch, the card, privileged facts,
  tool distros; `MAX_RUNS_PER_TARGET = 3`.
- **Consent** (§3.9.3, §7.4, §8.4): cards built per OS (stop chord substituted before hashing), recorded in settings
  (`targets.wsl.consent`, `HostRecord.consent` re-asked when `ssh -G`'s resolution or the machine id changes,
  `commands[<id>].consent`).
- **The ssh-noticing offer** (§2.7): only while SSH is allowed and `offerSsh` is on; only when a terminal window is
  focused and its title changed; ≤ every 10 s; Windows CIM only on SSH-looking titles and while useful; the WSL reader
  only with WSL on; once per destination per run; never while a question is up; `dismissedOffers`; carried options shown
  on the card; `via` only when L22's check passed.
- **IPC** (`TARGETS_IPC`): every handler checks `deps.isHome(sender)` (integration-5); `TargetsAct` handled.
- **Menu, bubble actions, quick context, active line, caps** (§2.4, §2.6, §2.8, §8.1, §8.2): menu items only when §8.1
  says; `bubbleAction` for `target:`, `offer:`, `conn:`, `ui:panel:`, `ui:cmdstop:`; `quickContext()` with `targetId`;
  `activeLine()` incl. commands state; `caps()`.
- **Kill switch, quit, doctor**: `stopAll()` calls every runner's `stopAll` and every link's `stop()` at once and never
  throws; `busy()`; `doctorRows()`/`targetDoctorRows` per §8.8.
- **pcId**: 32 random hex digits written to `settings.targets.pcId` at first use.

## Tests (OS-neutral; fakes for every factory)
§10.1's TG row: name normalisation and place words (incl. spoken numbers); registry states; the hands table (WSL lease
identity; local without a window system); the kill-switch part calls every runner and link at once; busy counts; menu
items; bubble actions incl. `ui:cmdstop:`; the noticing triggers (incl. Windows CIM gating and the WSL reader);
`targets:act` refused from any sender but the home window; the active line and caps; consent records and re-asking.

## Acceptance criteria
- `createTargets` and `targetDoctorRows` with exactly S0a's signatures; `npx tsc --noEmit`, `npm run lint`, `npm test`
  pass.
- With the admin turning WSL/SSH/commands off, or nothing configured, Ember behaves exactly as today (no menu items, no
  badges, no polling beyond the noticing triggers' cheap checks, `caps()` all false).
- The report lists which factories were still stubs when you finished, if any.
