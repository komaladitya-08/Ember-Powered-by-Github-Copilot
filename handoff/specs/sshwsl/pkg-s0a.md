# Package S0a: the SSH/WSL contract (Step 0a)

Read first: `specs/pkg-common.md`, `specs/sshwsl/pkg-common.md`, `specs/sshwsl/decisions.md`, then
`specs/sshwsl/design.md`: header, "Limitations and departures", §11.1-§11.2 (your full list), and the sections whose
TypeScript you land: §2.1, §2.4, §3.1, §3.3, §4.1, §5.1.2, §5.1.10, §5.4, §7.4, §8.5 (IPC), §9.1, §10.1 (S0a row),
§10.2 (the workflow). Then "Critique resolutions" rows naming S0a.

## Goal
Land every shared type, schema, normative text, stub, build entry, lint rule and the CI workflow that the other
packages code against, with **no behaviour change at all**. Nothing else starts until you merge, so be fast: this is
typing out the design, not designing. Where this brief and the design differ, the design wins; say so in the report.

## Start and merge
Starts first, alone. Merges first. Everyone else branches from your merge.

## Files you create (exact content from the design)
- `app/shared/targets.ts` (§2.1 first block) plus `TARGETS_IPC` and `TargetsAct` (§11.2).
- `app/shared/commands.ts`: `COMMANDS_IPC` (§8.5) plus `output: "commands:output"`; `CommandWindowState`,
  `CommandTabView` (§11.2).
- `app/shared/remote-ui.ts`: `PROMPT_IPC`, `PromptCard` (with `via?` on the secret card), `PromptAnswer` (§11.2).
- `app/main/targets/types.ts`: §2.1 second block (with `PromptCaps`), plus `TargetsDeps`, `IpcLike`, `WebContentsLike`,
  `BrowserWindowLike` (below).
- `app/main/commands/types.ts`: §3.1 entirely, plus `export interface JobHostRef { execPath: string; script: string }`.
- `app/main/commands/run/shells.ts`: §3.3's code block exactly (`NO_RC`, `POSIX_PRELUDE`, `posixBody`, `posixInner`,
  `WSL_EVAL`, `PS_INNER`), implemented (it is pure text). RUN owns it after you.
- `app/main/wsl/types.ts`: §4.1's block (it imports `CommandRunner`, `WindowsContext` from commands/types and
  `PlatformDoctorRow`).
- `app/main/remote/protocol.ts`: §5.4 with **every zod schema written out** (`OP_SCHEMAS`, `EV_SCHEMAS`, each `.strict()`,
  with `CAPS`), including `Hello.pcId`, `Welcome.tccLimited`/`graceSeconds`, `RemoteApp.argv`/`terminal`,
  `cmd.inspect`, `cmd.git`, `cmd.run`'s `says`/`rules`.
- `app/main/remote/types.ts`: `HostRecord` (§5.1.2), `SshSeen` (§2.7), and §11.2's remote types block (`ConnectProgress`,
  `RemoteLink`, `Connections`, `ConnectError`, `PromptUi`, `Mux`).
- `app/main/perception/ports.ts` (§11.2: `PerceptionPort`, `PerceptionSidecar`, `SidecarPort`, `ActStamp` with `ageMs`).
- Stubs, each exporting its final signature (§11.2 "Stubs"): `app/main/targets/runtime.ts` (a local-only runtime;
  `caps()` all false; `targetDoctorRows` → `[]`), `app/main/wsl/{routed-sidecar,routed-windows,privacy}.ts` (identity),
  `app/main/wsl/service.ts` (`createWsl` → null), `app/main/policy/target-rules.ts` (`targetRules` → null),
  `app/main/commands/run/local.ts`, `app/main/commands/run/job-host.ts`, `app/main/commands/window.ts`,
  `app/main/remote/prompt-window.ts`, `app/main/commands/{flow,carried}.ts`, `app/main/remote/connections.ts`,
  `app/main/remote/target.ts`, `app/main/remote/mux.ts`, `app/preload/{command,prompt}.ts`,
  `app/renderer/{command,prompt}/{index.html,main.ts,styles.css}`, `app/askpass/main.ts`,
  `app/main/remote/link-worker.ts`, `app/remote/main.ts`, `app/remote/capture-stub.ts`. Each stub has a module doc
  comment saying which package owns it and that it is a stub.
- `.github/workflows/remote.yml`: every job of §10.2 with its runner and set-up, each test step skipping a test file that
  doesn't exist yet, `workflow_dispatch` inputs `ref` and `only` (`all|unit|commands|wsl|ssh|macos|wayland`), the
  macOS job only on dispatch or weekly, pinned action versions (copy `ci.yml`'s pins; `Vampire/setup-wsl` by commit).
  Each job's owner (§10.2 table) is written in a comment above it.
- `test/unit/sshwsl-contract.test.ts`, `test/unit/lint-boundaries.test.ts`.

## Shared files you edit (minimal; behaviour-neutral)
- `app/shared/overlay.ts`: `BubbleState.where`, `TaskCard.where`, `EmberState.target` (§2.4 block).
- `app/shared/consent.ts`: `FEATURE_CONSENT_VERSION`, `ConsentPanel` type (`CONSENT_VERSION` unchanged).
- `app/main/admin.ts`: §9.1 (schema additions incl. `ssh.commandGraceSeconds`, `LOCKDOWN`, `ADMIN_POLICY_PATHS`,
  `commandMode`, `AdminSummary`, `adminSummary`, `combineAdmin`, `hostAllowed`), implemented and tested.
- `app/main/settings.ts`: `targets` (incl. `pcId` default ""), `commands`, `HostRecordSchema`, `repairSettings` keeping
  valid host records one by one (§7.4 block, §11.2).
- `app/main/policy/audit.ts`: event union gains `"command" | "remote" | "wsl"`; `journalLine` sizes `command`, `cwd`.
- `app/main/agent/killswitch.ts`: `StopSource` gains `"remote-console"`.
- `app/main/agent/worker.ts`, `host.ts`, `tasks.ts`, `app/main/perception/index.ts`: **types only** (§11.2 list):
  port types, optional `WorkerDeps` fields, `TaskSpec.targetId`, the widened `apps.launch` (await its one call site),
  `HostOptions.targets`/`taskBase`, `WorkerLike`, `PerceptionOptions.sidecar`/`capture` (`capture ?? captureRect` at
  its one use), `QuickContext.targetId`. No other line changes.
- `scripts/build-app.mjs`: the entries, pages, `dist/remote` clean-up and xterm.css copy of §11.2.
- `package.json`/`package-lock.json`: `"@xterm/xterm": "5.5.0"` (exact) in `dependencies`, written with
  `npm install --package-lock-only --save-exact @xterm/xterm@5.5.0` (lockfile only: `node_modules` is the main
  checkout's symlink and must not change). `build-app.mjs` copies `xterm.css` only when it is present (a missing copy
  logs a warning, never fails the build); report "Needs from the lead: `npm ci` in the main checkout so UI has xterm".
- `eslint.config.mjs`: the two `no-restricted-imports` rules of §11.2.

## Contracts you land (normative TypeScript from the design)

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
// BubbleState gains:
  /** Where the task this bubble belongs to acts, when not on this computer ("on build-01", "in Ubuntu (WSL)"). */
  where?: string;
// TaskCard gains:
  /** Where the task acts, when not on this computer. */
  where?: string;
// EmberState gains:
  /** The picker's target, for the handle's badge (absent or "local": no badge). */
  target?: TargetSummary;
```

```ts
/**
 * Commands on every target (OWNER DECISION 4): what a command is, how it is classified and decided, how it runs in
 * Ember's own command window, and what comes back. Plain Node: the remote agent bundles the same code.
 */

import type { OS } from "../../shared/shortcuts";
import type { TargetId } from "../../shared/targets";
import type { TargetBinding } from "../targets/types";
import type { Agreement } from "../policy/policy";

/** The shells Ember runs commands in ("cmd" is never offered as a run_command shell in v1: L3; it is parsed when nested). */
export type ShellId = "bash" | "zsh" | "sh" | "powershell" | "cmd";
/** How a shell's text is parsed. */
export type ShellFamily = "posix" | "powershell" | "cmd";
export const SHELL_FAMILY: Readonly<Record<ShellId, ShellFamily>> = { bash: "posix", zsh: "posix", sh: "posix", powershell: "powershell", cmd: "cmd" };

/**
 * D4.3's dangerous classes: a "destroy" (deleting or overwriting data), b "publish" (submitting or sending anywhere),
 * c "remote-delete" (deleting from source control or a remote service), d "secret" (credentials, secrets, the
 * clipboard, screen pictures, shell history), e "system" (privilege and system changes, package installs, other users'
 * processes, anything that runs later: shell start-up files, git hooks and code-running git settings), f "escape"
 * (download-and-run, or outliving the kill switch), g "unclear" (Ember can't classify it confidently).
 */
export type DangerClass = "destroy" | "publish" | "remote-delete" | "secret" | "system" | "escape" | "unclear";

/** Classes that always ask, even when the user's own words asked for it (D4.4). */
export const ALWAYS_ASK: ReadonlySet<DangerClass> = new Set(["secret", "escape", "unclear"]);

/** What a dangerous part of a command acts on, resolved where Ember can (paths absolute on the target). */
export interface CommandObject {
  kind: "path" | "glob" | "remote" | "branch" | "tag" | "changelist" | "host" | "package" | "image" | "repo" | "url" | "process" | "other";
  /** As written in the command (quotes removed). */
  text: string;
  /** Absolute path on the target, normalised with the target's path rules (for paths and globs); absent when it can't be known. */
  resolved?: string;
}

/** One reason a command is dangerous. */
export interface Finding {
  cls: DangerClass;
  /** The table row that matched (§3.5), e.g. "posix.rm", "git.push", "git.push.force", "redirect.overwrite". */
  rule: string;
  /** Plain words for the card, sentence case: "Deletes build and everything in it." */
  says: string;
  /** The program and subcommand as the user would name them: "git push", "rm", "Remove-Item". */
  program: string;
  objects: CommandObject[];
  /** Options that widen it beyond its plain form: "--force", "-r outside the named folder", "--all", "--mirror". */
  widening: string[];
  /** The finding holds only if this path exists (an overwrite); the decision drops it when the target says it doesn't. */
  ifExists?: string;
  /** Index into Classification.commands. */
  at: number;
}

/** One simple command as parsed (wrappers unwrapped, quotes removed). */
export interface ParsedCommand {
  /** The program as run: "rm" for `sudo rm -r x` and for `\rm`, `r''m`; "Remove-Item" for PowerShell's `rm`. */
  program: string;
  /** Its arguments with quotes removed; null where an expansion Ember couldn't resolve stands. */
  args: (string | null)[];
  /** Wrappers in front of it, outermost first: ["sudo"], ["env", "nice"], ["xargs"], ["find -exec"], ["wsl"]. */
  wrappers: string[];
  redirects: { op: ">" | ">>" | ">|" | "&>" | "&>>" | "<" | "<<" | "<<<" | "2>" | "2>>"; target: string | null }[];
  /** Index of the command whose output it reads (a pipeline), if any. */
  pipedFrom?: number;
  /** Run in the background (`&`, PowerShell 7's `&`). */
  background: boolean;
  /** The family its text was parsed as (a nested `cmd /c` inside PowerShell is "cmd"). */
  family: ShellFamily;
}

/** What the classifier says about a command (pure: classifyCommand in commands/classify.ts). */
export interface Classification {
  shell: ShellId;
  family: ShellFamily;
  /** Empty: an ordinary command. */
  findings: Finding[];
  /** D4.5: Ember refuses it outright (its own safety machinery, or driving Ember). */
  refuse: { rule: string; says: string } | null;
  /**
   * Every path the command names, resolved on the target (operands, redirection targets, cd and find starts, -exec
   * operands; at most 64, more → an "unclear" finding): the target reports whether each exists and its real path
   * before the decision (§3.6, §3.8.3).
   */
  probe: string[];
  /** A `git push` whose announcement needs the branch facts (§3.7): the flow asks the target for GitFacts. */
  needsGit: boolean;
  /** Files and folders this command downloads: a later command that runs one of them is class "escape". */
  downloads: string[];
  /** Every program it runs, for the card and the audit. */
  programs: string[];
  /** The command is only `cd <path>` (or `Set-Location <path>`): it sets the task's folder instead of running. */
  cdOnly?: string;
  commands: ParsedCommand[];
}

/** The Windows side of a WSL target, for nested cmd/PowerShell and Windows-form paths (critique wsl-4). */
export interface WindowsContext {
  /** C:\Users\ana */
  home: string;
  localAppData: string;
  appData: string;
  temp: string;
  /** C:\Windows */
  systemRoot: string;
  /** Ember's own Windows paths (§3.6.2), refused in either form. */
  emberPaths: string[];
}

/** What a target reported about one path of Classification.probe. */
export interface PathFact {
  /** lstat found it; null: couldn't tell (counts as existing). */
  exists: boolean | null;
  /** Its real path (symlinks, 8.3 short names and junctions resolved; of the nearest existing parent plus the rest when it doesn't exist); null: couldn't tell. */
  real: string | null;
}

/** A git work tree's push facts, read with fixed argv by the target (§3.7). */
export interface GitFacts {
  /** `git rev-parse --abbrev-ref HEAD` ("HEAD" when detached → null). */
  branch: string | null;
  /** `git config --get push.default` (null: unset, which means "simple"). */
  pushDefault: string | null;
  /** `git rev-parse --abbrev-ref @{u}` ("origin/feature-x"), null without one. */
  upstream: string | null;
}

/** The context a classification needs about the target (from RunnerFacts and the task). */
export interface ClassifyContext {
  /** The target's OS: it picks the path rules (path.posix or path.win32), never the PC's (critique integration-11). */
  os: OS;
  home: string;
  /** The folder the command runs in (absolute on the target). */
  cwd: string;
  /** Paths and process ids that are Ember's own on the target (D4.5). */
  ember: { paths: string[]; pids: number[]; names: RegExp };
  /** Absolute paths this task downloaded so far (Classification.downloads of earlier commands). */
  downloaded: ReadonlySet<string>;
  /** WSL facts, when the target is a distro. */
  wsl?: { mountRoot: string; windows: WindowsContext | null };
  /** The second pass (§3.8.3): each probed path's real path, as the target reported it. */
  real?: ReadonlyMap<string, string>;
  /** Extra folders that count as temporary on this target (POSIX /tmp and /var/tmp, Windows %TEMP% are built in). */
  tempDirs?: string[];
}

/** The commands mode an administrator set for a kind of target (R5, D4.7). */
export type CommandMode = "on" | "ask" | "off";

export type CommandVerdict = "run" | "announce" | "ask" | "refuse";

/** decideCommand's answer (pure: commands/decide.ts). */
export interface CommandDecision {
  verdict: CommandVerdict;
  /** Why, in Ember's words (audit; the model's text when refused). */
  reason: string;
  /** The classes behind an ask or an announcement, most serious first. */
  classes: DangerClass[];
  /** The rules behind it (Finding.rule), for the stamp and the audit. */
  rules: string[];
  /** The card's lines (§3.8.4), sentence case, most serious first. */
  says: string[];
  /** D4.4 matched: what to announce ("Pushing feature-x to origin, as you asked.") and the intent row. */
  requested?: { intent: string; announce: string };
  /** Nothing in the user's own words named this (a dangerous command): the card says "You didn't ask for this." */
  unasked: boolean;
  /** How long the card's Allow stays disarmed (ms). */
  armMs: number;
}

/** Everything decideCommand reads. */
export interface DecideInput {
  cls: Classification;
  /** The target's answer for each path in cls.probe. */
  paths: ReadonlyMap<string, PathFact>;
  /** The target's git facts when cls.needsGit (null: not asked or couldn't tell). */
  git: GitFacts | null;
  binding: TargetBinding;
  facts: RunnerFacts;
  /** The administrator's mode for this kind of target (both machines', stricter, for SSH). */
  mode: CommandMode;
  /** The user's own "Ask before every command" for this target, or a tool-owned distro (§2.2). */
  userAskEvery: boolean;
  /**
   * The user's OWN words for this task: TaskSpec.userWords and the user's own steers, nothing else. Never the
   * conductor's goal (the worker's policy `userWords` falls back to it; this never does: critique security-1), the
   * model's `why`, screen text, files or output. "" when the task wasn't started from the user's words: then nothing
   * announces.
   */
  userWords: string;
  agreed: Agreement[];
  /** Something on screen or in command output tried to steer the task (Worker.tainted, §3.11). */
  tainted: boolean;
  /** Text Ember read elsewhere in this task that the command carries (commands/carried.ts); null: none. */
  carried: { from: string[] } | null;
}

/** What a target's command runner knows about itself (asked once per task and again after a reconnect). */
export interface RunnerFacts {
  /** The OS commands run on. */
  os: OS;
  /** Shells found, the default first (posix: bash, else zsh on macOS, else sh; Windows: ["powershell"]). */
  shells: ShellId[];
  /** Absolute path of each shell found (made only of [A-Za-z0-9/._-] on POSIX, else that shell isn't offered). */
  shellPaths: Partial<Record<ShellId, string>>;
  /** util-linux or BSD `script` for a PTY (absolute path); null: pipes with stdin closed. */
  script: { path: string; kind: "util-linux" | "bsd" } | null;
  home: string;
  user: string;
  /** uid 0, or an elevated Windows token: every command asks (D4.6). */
  privileged: boolean;
  /** A PTY can be had (script found); false: pipes with stdin closed. */
  pty: boolean;
  ember: ClassifyContext["ember"];
  /** Folders added to PATH as data (macOS: Homebrew and /etc/paths(.d) entries that exist; §3.3.1). */
  extraPath: string[];
  wsl?: { mountRoot: string; interop: boolean; windows: WindowsContext | null };
}

/** One command to run, exactly as approved or decided. */
export interface RunSpec {
  /** 16 lower-case hex digits, random per run (also the environment marker EMBER_RUN_ID). */
  runId: string;
  taskId: string;
  shell: ShellId;
  /** The exact text (UTF-8), never rewritten after the decision. */
  command: string;
  /** Absolute on the target. */
  cwd: string;
  timeoutMs: number;
  cols: number;
  rows: number;
  /** For an SSH target's gate 2 (§3.16): what the PC decided, and the user's yes if it asked. */
  stamp: CommandStamp;
}

/** The PC's decision travelling with a remote command (never a credential: the remote checks, it never trusts it to loosen). */
export interface CommandStamp {
  taskId: string;
  /** sha256Hex(`${target}\0${shell}\0${cwd}\0${command}`). */
  sha256: string;
  verdict: "run" | "announce" | "ask";
  /** CommandDecision.classes and .rules: what the PC asked or announced for. Gate 2 asks for anything beyond them. */
  classes: DangerClass[];
  rules: string[];
  /**
   * The user's yes (verdict "ask", or a remote's needs_confirm answered on the PC): how long ago it was given, measured
   * on the PC when the request is sent (no clock is compared across machines: critique integration-6). null: no yes.
   */
  approval: { ageMs: number } | null;
}

/** How a run ended. */
export interface RunExit {
  code: number | null;
  signal: string | null;
  ended: "exit" | "stopped-user" | "stopped-task" | "killswitch" | "timeout" | "lost" | "failed-to-start" | "refused-remote";
  ms: number;
  /** failed-to-start and refused-remote: why, in plain words. */
  error?: string;
  /** refused-remote: the remote would run it after the user's yes (gate 2's needs_confirm). */
  needsConfirm?: boolean;
  /** refused-remote: the card lines the remote's own check produced (untrusted text, shown quoted). */
  remoteSays?: string[];
}

/** A command running (or finished) in Ember's command window. */
export interface RunningCommand {
  readonly runId: string;
  /** The user can type into it (a PTY, or a pipe whose stdin is open). */
  readonly interactive: boolean;
  /** Raw output bytes as they come (stdout and stderr merged in a PTY; interleaved as read on pipes). */
  onOutput(fn: (chunk: Uint8Array) => void): () => void;
  /** The user's typing, from the command window's own page only. Never logged, never shown to the model. */
  input(bytes: Uint8Array): void;
  /** The lines the user typed (in memory only), so output shaping can cut them out (L2). Cleared by forgetTyped(). */
  typedLines(): string[];
  forgetTyped(): void;
  stop(why: "user" | "task" | "killswitch" | "timeout"): void;
  readonly done: Promise<RunExit>;
}

/** Runs commands on one target (the local runner, WSL's, a remote's proxy). */
export interface CommandRunner {
  readonly target: TargetId;
  facts(): Promise<RunnerFacts>;
  /** For each path: does it exist (lstat), and its real path. At most 64 paths. Never throws (all null on failure). */
  inspect(paths: string[], cwd: string): Promise<PathFact[]>;
  /** The git push facts of the work tree at `cwd` (fixed argv, read-only); null outside a work tree or on failure. */
  gitFacts(cwd: string): Promise<GitFacts | null>;
  /** Starts a run; never throws (failures end `done` with failed-to-start). */
  start(spec: RunSpec): RunningCommand;
  /** Stops every run of this runner (the kill switch, quitting); resolves once each was signalled. */
  stopAll(why: "killswitch" | "quit"): Promise<void>;
  /** Runs not yet ended. */
  readonly running: number;
}

/** What the command window shows for a command: the card (asking or announcing) and the run's header. */
export interface CommandCard {
  runId: string;
  target: TargetId;
  targetLabel: string;
  login?: string;
  shell: ShellId;
  cwd: string;
  /** The exact command (the renderer makes control, bidi, zero-width and mixed-script characters visible: app/shared/visible-text.ts). */
  command: string;
  /** CommandStamp.sha256: the Allow click must carry it back. */
  sha256: string;
  taskId: string;
  taskTitle: string;
  mode: "ask" | "announce" | "run";
  says: string[];
  unasked: boolean;
  armMs: number;
}

/** What a target offers for commands right now. */
export interface CommandCapability {
  state: "on" | "needs-consent" | "off";
  /** Why it is off, in plain words for the model and the card. */
  why?: string;
  /** Every command asks: the administrator's "ask" mode, the user's own switch, root (D4.6), or a tool-owned distro (§2.2). */
  askEvery: "admin" | "user" | "root" | "tool" | null;
}

/** The command window as the command flow drives it (UI implements it: app/main/commands/window.ts). */
export interface CommandWindowPort {
  /** Shows question n's card (the window comes up, always on top); answers come back through the Confirmer. */
  showCard(n: number, card: CommandCard): void;
  /** Question n's card went (answered, expired, cancelled). */
  hideCard(n: number): void;
  /** Question n's card is on screen with the whole command in view (R7: the approve chord's guard). */
  cardReady(n: number): boolean;
  /** An announcement (D4.4): true when the command may run, false when the user pressed Stop or `signal` aborted within `ms`. */
  announce(card: CommandCard, ms: number, signal: AbortSignal): Promise<boolean>;
  /** Stops an announcement now (the bubble's Stop, `ui:cmdstop:<runId>`): its announce() resolves false. */
  cancelAnnounce(runId: string): void;
  /** Shows a run live: its output, its Stop button, the user's typing into it. */
  attach(card: CommandCard, run: RunningCommand): void;
}

/** One target's commands: what the worker's run_command tool uses. */
export interface CommandService {
  readonly binding: TargetBinding;
  capability(): CommandCapability;
  /**
   * The shells offered, the default first, known without waiting (local: found at start; WSL: the distro's facts once
   * read, else ["bash", "sh"]; SSH: welcome.facts.shells; Windows: ["powershell"]). run_command's schema is built from it.
   */
  shells(): ShellId[];
  readonly runner: CommandRunner;
  readonly window: CommandWindowPort;
  /** The user said yes to the commands card for this target: remember it (settings). */
  consented(): void;
  /** The user's "Ask before every command" here (or a tool-owned distro). */
  userAskEvery(): boolean;
  /** The administrator's mode here (both machines', stricter, for SSH). */
  mode(): CommandMode;
}

/** run_command's arguments as the tool accepts them (§3.2). */
export interface RunCommandArgs {
  target: string;
  command: string;
  shell?: ShellId;
  cwd?: string;
  timeoutSeconds?: number;
  why: string;
}
```

```ts
/** Flags that keep each POSIX shell from reading profile or rc files. */
export const NO_RC: Readonly<Record<"bash" | "zsh" | "sh", readonly string[]>> = { bash: ["--noprofile", "--norc"], zsh: ["-f"], sh: [] };

/**
 * What every POSIX run does first: globbing on, no pager waits for keys (git log in a PTY would otherwise start less),
 * a UTF-8 locale when none is set, then the start marker (an OSC sequence output shaping strips; a run whose output
 * ends without it failed to start: its stderr is the reason, §3.13). One line, no single quote, no tab, no run of
 * spaces: it is embedded in single-quoted -c text and split and re-joined by WSL_EVAL.
 */
export const POSIX_PRELUDE = 'set +f; export PAGER=cat GIT_PAGER=cat SYSTEMD_PAGER=cat MANPAGER=cat; [ -n "$LANG" ] || export LANG=C.UTF-8; printf "\\033]777;ember-start\\007"';

/**
 * The body every POSIX run executes: the prelude, the command text read and unset first (from EMBER_CMD, or decoded
 * from EMBER_CMD_B64 for WSL), the PTY's size set inside script(1) (whose PTY starts without one), then `eval "$c"`,
 * which runs the text exactly as `bash -c "$c"` would (same parser, here-docs and `exit` included).
 */
export function posixBody(o: { pty: boolean; from: "env" | "b64" }): string;
// from "env": 'c=$EMBER_CMD; unset EMBER_CMD'
// from "b64": 'c=$(printf %s "$EMBER_CMD_B64" | base64 -d) || exit 126; unset EMBER_CMD_B64'
// then: 'unset BASH_ENV ENV'; pty: 'stty cols "$EMBER_COLS" rows "$EMBER_ROWS" 2>/dev/null; unset EMBER_COLS EMBER_ROWS'
// then: 'eval "$c"'; joined with "; " after POSIX_PRELUDE.

/**
 * The text script(1) runs with /bin/sh -c: exec the chosen shell (its absolute path from RunnerFacts.shellPaths, made
 * only of [A-Za-z0-9/._-], else the run fails to start) without rc files on posixBody({ pty: true, from }).
 */
export function posixInner(shell: "bash" | "zsh" | "sh", shellPath: string, from: "env" | "b64"): string {
  return `exec ${shellPath} ${NO_RC[shell].join(" ")} -c '${posixBody({ pty: true, from })}'`.replace(/ {2,}/g, " ");
}

/**
 * What WSL runs as its -c text: no quote or backslash in it, so Windows' argument quoting and wsl.exe's own parsing
 * can't change it (critique wsl-18). EMBER_INNER (posixInner(…, "b64") or posixBody({ pty: false, from: "b64" }))
 * arrives through WSLENV; `set -f` keeps the split words from globbing before eval re-parses them.
 */
export const WSL_EVAL = "set -f; eval $EMBER_INNER";

/** PowerShell's fixed launcher (§3.3, critique integration-10). */
export const PS_INNER =
  "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; $OutputEncoding = New-Object Text.UTF8Encoding $false }; " +
  "$s = [ScriptBlock]::Create($env:EMBER_CMD); Remove-Item Env:\\EMBER_CMD -ErrorAction SilentlyContinue; " +
  "$global:LASTEXITCODE = 0; & $s; $ok = $?; $c = $LASTEXITCODE; if ($c) { exit $c } elseif (-not $ok) { exit 1 }";
```

```ts
/** One WSL distro as Ember sees it. */
export interface WslDistro {
  name: string;
  /** 1 or 2 (WSL1 runs no WSLg). */
  version: 1 | 2;
  isDefault: boolean;
  /**
   * The distro's default user id **as the distro itself reports it** (`id -u` in the facts script, or the in-distro
   * sidecar's status): 0 means root (WSLg acting refused, every command asks). null: not known yet (not running since
   * Ember started). The registry's DefaultUid is a hint for listing only: an imported distro's /etc/wsl.conf
   * `[user] default=` wins over it (critique wsl-7).
   */
  defaultUid: number | null;
  running: boolean;
  /** Its first-run set-up (user creation) hasn't happened yet: Ember never starts it (critique wsl-19f). */
  needsSetup: boolean;
  /** A tool's own distro: "podman" (commands only, every command asks). Docker's and Rancher's are never listed. */
  tool?: "podman";
}

/** What WSL looks like on this PC. */
export interface WslFacts {
  installed: boolean;
  /** The wsl.exe Ember runs (Store/MSI WSL's, else the inbox one). */
  wslExe: string | null;
  /** docker-desktop*, rancher-desktop* are never listed. */
  distros: WslDistro[];
  /**
   * WSLg can be there: the Store/MSI WSL (wslVersion !== null), some distro of version 2, and no `guiApplications=false`;
   * confirmed per distro by the sidecar's `status.wslg` (/mnt/wslg exists). The inbox WSL never has WSLg (critique wsl-21).
   */
  wslg: { available: boolean; disabledByUser: boolean; version: string | null };
  /** "2.3.26.0" from `wsl --version`; null for the inbox WSL. */
  wslVersion: string | null;
}

/** WSL for Ember (createWsl in app/main/wsl/service.ts; null off Windows). */
export interface WslService {
  facts(o?: { refresh?: boolean }): Promise<WslFacts>;
  /** Cheap: the last facts' running set, refreshed at most every 2 s on demand. */
  isRunning(distro: string): boolean;
  /** The running set read now, uncached (`wsl --list --running --quiet`, filtered to known names). */
  runningNow(): Promise<Set<string>>;
  /** The command runner for a distro (§4.2). */
  runner(distro: string): CommandRunner;
  /** The distro's default uid as the distro reports it; asked only when it is running (never boots it). */
  defaultUid(distro: string): Promise<number | null>;
  /** The Windows side's facts for nested cmd/PowerShell and Windows-form paths (§3.4.5). */
  windowsContext(): WindowsContext;
  /** sha256 of /proc/sys/kernel/random/boot_id of each running WSL2 distro (SA's same-machine rule, §5.1.14). */
  bootIds(): Promise<string[]>;
  onChange(fn: (f: WslFacts) => void): () => void;
  doctorRows(): Promise<PlatformDoctorRow[]>;
  dispose(): void;
}
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

```ts
// settings.ts (Step 0a):
const ConsentRecord = z.object({ version: z.number().int().min(0).default(0), at: z.string().nullable().default(null) }).default({ version: 0, at: null });
// app/shared/consent.ts (Step 0a; CONSENT_VERSION stays 1):
export const FEATURE_CONSENT_VERSION = { wsl: 1, ssh: 1, commands: 1 } as const;
```

```ts
const CommandModeSchema = z.enum(["on", "ask", "off"]);

// AdminPolicySchema.features gains:
    /** WSL: reading and acting in WSLg apps, and the WSL target (commands are `commands.wsl`). */
    wsl: z.boolean().optional(),
    /** SSH: connecting to other computers (on the PC); on a remote: letting Ember in at all. */
    ssh: z.boolean().optional(),

// AdminPolicySchema gains:
  /** Commands per kind of target (R5: absent in a policy that exists → "off"; D4.7). */
  commands: z.object({
    local: CommandModeSchema.optional(),
    wsl: CommandModeSchema.optional(),
    ssh: CommandModeSchema.optional(),
  }).strict().optional(),
  ssh: z.object({
    /** Patterns of computers Ember may connect to (matched against user@host:port, host:port and host). */
    allowedHosts: z.array(z.string().min(1).max(255)).max(200).optional(),
    /** false: commands only on remotes (no desktop). On a remote: no desktop for Ember arriving over SSH. */
    desktop: z.boolean().optional(),
    /** On a remote: a person at its screen must allow Ember before it reads anything there. */
    requireConsoleConsent: z.boolean().optional(),
    /** Where the PC downloads Node for remotes instead of nodejs.org (same layout; still checked by SHA-256). */
    runtimeMirror: z.string().url().startsWith("https://").optional(),
    /** How long a command on a remote keeps running while the link is silent (L10; default 20; both machines: the smaller). */
    commandGraceSeconds: z.number().int().min(3).max(120).optional(),
  }).strict().optional(),
```

```ts
/** Where an administrator's policy file lives on a POSIX machine (Windows uses the registry: platform/win32). */
export const ADMIN_POLICY_PATHS: Readonly<{ linux: string; darwin: string }> = {
  linux: "/etc/ember/policy.json",
  darwin: "/Library/Application Support/Ember/policy.json",
};
```

```ts
/** R5's commands mode (§3.8.1). */
export function commandMode(loaded: LoadedAdminPolicy, kind: TargetKind): CommandMode;

/** What a remote and the PC tell each other about their policies (protocol, gate 1). */
export interface AdminSummary {
  source: string | null;
  error?: string;
  features: { actions?: boolean; cursor?: boolean; desk?: boolean; screenImages?: boolean; wsl?: boolean; ssh?: boolean; voice?: boolean; speak?: boolean };
  neverLook: string[];
  confirmEveryAction: boolean;
  allowGrants: boolean;
  maxActionsPerMinute?: number;
  commands: Record<TargetKind, CommandMode>;
  ssh: { desktop?: boolean; requireConsoleConsent?: boolean; allowedHosts?: string[]; commandGraceSeconds?: number };
  models: { allowed?: string[] };
  provider: boolean;
}
export function adminSummary(loaded: LoadedAdminPolicy): AdminSummary;

/** Both machines' rules for what Ember does on the remote: each value the stricter of the two (property-tested never to loosen either). */
export function combineAdmin(local: AdminSummary, remote: AdminSummary): AdminSummary;

/** Whether the PC's policy lets Ember connect to this resolved destination (§5.1.3). */
export function hostAllowed(p: AdminPolicy, d: { user: string; hostname: string; port: number }): boolean;
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

## Tests
- `sshwsl-contract.test.ts` (§10.1 S0a): settings defaults/repair; `commandMode` against §9.3's table; `LOCKDOWN`;
  `adminSummary`; `combineAdmin` property test (random pairs; never looser than either input; grace the smaller);
  `hostAllowed`; `ADMIN_POLICY_PATHS`; every protocol schema accepts a valid example and rejects an extra key, a too-long
  string and a non-finite number; `shells.ts` texts (no quote except `posixInner`'s fixed single quotes, no tab, no
  run of spaces; `WSL_EVAL` has no quote or backslash; `PS_INNER` exact); the runtime stub gives today's local hands
  with `commands: null`.
- `lint-boundaries.test.ts`: runs ESLint's API on two in-memory files (an `electron` import outside the allow-list; a
  bare `node:path` import under `app/main/remote/`) and expects both rules to fire.
- All tests OS-neutral (sshwsl/pkg-common.md).

## Acceptance criteria
- `npx tsc --noEmit`, `npm run lint`, `npm test` pass; `npm run build` produces `dist/app/{askpass,remote-link,job-host}.cjs`,
  `dist/remote/ember-remote.cjs` and `dist/remote/meta.json`, and the two new renderer pages.
- No behaviour change: nothing new is wired into `main.ts`; a packaged Linux build behaves exactly as before.
- Every name, field and signature matches the design byte for byte (the report lists any deviation and why).
- `remote.yml` is valid (`actionlint` if available, else a YAML parse) and every job is skipped or green when dispatched
  with `only: unit` on your branch (only if the lead allows pushing; otherwise "not run").
