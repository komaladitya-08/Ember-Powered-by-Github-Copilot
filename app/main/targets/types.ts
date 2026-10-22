/**
 * The target model's types (§2.1): what a task's target is to the worker, the hands a worker on a target gets, what
 * AgentHost asks of the targets runtime, and everything main hands that runtime (TargetsDeps). Plain Node: Electron
 * objects come in through the structural shapes at the end (IpcLike, WebContentsLike, BrowserWindowLike), so the
 * runtime never imports Electron (L13).
 */

import type { OS } from "../../shared/shortcuts";
import type { TargetId, TargetKind, TargetSummary } from "../../shared/targets";
import type { EmberState } from "../../shared/overlay";
import type { Hands } from "../agent/host";
import type { WorkerSystem } from "../agent/worker";
import type { CommandService, JobHostRef } from "../commands/types";
import type { ActStamp } from "../perception/ports";
import type { QuickContext } from "../perception";
import type { Confirmer, Question } from "../agent/confirm";
import type { PlatformDoctorRow, SystemPlatform } from "../platform/types";
import type { WslService } from "../wsl/types";
import type { Logger } from "../logger";
import type { SettingsStore } from "../settings";
import type { LoadedAdminPolicy } from "../admin";
import type { AuditLog } from "../policy/audit";

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
  /**
   * The labels of the computers other than `id` that the user's own words name ("this computer" for the PC): a task
   * whose words do says where it acts in every bubble, this computer included, and never announces a command (D4.4's
   * wrong-target guard, DOC's review). Optional: a host without a targets runtime has only this computer.
   */
  othersNamed?(id: TargetId, userWords: string): string[];
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
  /**
   * Ember's own processes now (D4.5): main's list and the runtime's helpers' (ssh, askpass, WSL helpers, the Copilot
   * runtime), as this computer's commands are judged by; main hands it to the agent for commands in WSL, whose runner
   * can't see this computer's processes itself.
   */
  emberPids(): number[];
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

/** Everything main hands the targets runtime (createTargets): plain data, functions and Electron-free shapes. */
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
  /**
   * The keys that answer the question up now, as the command card's hint ("Ctrl+Alt+Y allow · Ctrl+Alt+N not now"),
   * only keys main actually holds; absent or null: the card shows no hint.
   */
  keyHint?: () => string | null;
}

/** The parts of ipcMain the runtime uses; every handler checks the sender itself. */
export interface IpcLike {
  on(channel: string, fn: (event: { sender: WebContentsLike }, ...args: unknown[]) => void): void;
  handle(channel: string, fn: (event: { sender: WebContentsLike }, ...args: unknown[]) => unknown): void;
}
/** The parts of a webContents the runtime uses: who sent a message, and sending one back. */
export interface WebContentsLike { readonly id: number; send(channel: string, ...args: unknown[]): void }
/** The parts of a BrowserWindow the command and prompt windows' controllers use (windows.ts makes the real ones). */
export interface BrowserWindowLike {
  readonly webContents: WebContentsLike;
  show(): void; showInactive(): void; hide(): void; focus(): void; close(): void; moveTop(): void;
  isVisible(): boolean; isMinimized(): boolean; isDestroyed(): boolean; isAlwaysOnTop(): boolean; isFocused(): boolean;
  setAlwaysOnTop(flag: boolean, level?: "normal" | "floating" | "torn-off-menu" | "modal-panel" | "main-menu" | "status" | "pop-up-menu" | "screen-saver"): void;
  setBounds(b: { x?: number; y?: number; width?: number; height?: number }): void;
  setContentProtection(enable: boolean): void;
  on(event: "closed" | "focus" | "blur" | "show" | "hide", fn: () => void): void;
}
