# Package AG: agent integration (run_command, the command flow, targets in the conductor, host and worker)

Read first: `specs/pkg-common.md`, `specs/sshwsl/pkg-common.md`, `specs/sshwsl/decisions.md` (D3, OWNER DECISION 4),
then `specs/sshwsl/design.md`: header, "Limitations and departures", §2.3 (binding), §2.4 (where), §2.6 (routing,
per-target hands, refusal before queueing, context target, async launch), §3.2, §3.7 (`commandWords`), §3.8 (decision
and the flow), §3.9 (asking, announcing, consent), §3.11 step 7 (output taint), §3.15 (prompts and caps), §5.3.7
(desktop `needs_confirm` → denied), §6, §10.1 (AG row), §11.4 (AG row), "Critique resolutions" rows naming AG
(security-1, -3, -7, wsl-6, integration-3, -6, -7, -15, -17, -24, -25).

## Goal
Put commands and targets into Ember's brain without changing it for anyone who doesn't use them: the worker's
`run_command` tool and its flow (decide, ask, announce, run, shape, taint), the conductor's target-aware tools, the
host's per-target workers, and the prompts, which stay byte-identical to today when nothing is on.

## Start and merge
Starts when S0b has merged (you may begin on S0a and merge S0b in when it lands). Merges after WB, before TG.

## Files you own
- `app/main/commands/flow.ts`, `app/main/commands/carried.ts` (S0a stubs)
- `test/unit/{worker-commands,command-flow,conductor-targets,host-targets,persona-commands,tasks-where}.test.ts`

## Shared files you may touch (minimally; list every hunk)
- `app/main/agent/worker.ts`: the `run_command` tool (§3.2) when `WorkerDeps.commands` is set and its capability isn't
  "off"; `commandWords` (`spec.userWords ?? ""`, extended only by a steer's `userWords` argument, never by the model's
  steer `text`; the policy's `userWords` unchanged); `commandContext()`; `taint(why)`; tools by desktop access;
  `onAuthorized(stamp)` called immediately before `run()` (after the lease and the pre-step pause) with `ageMs`; the
  grant key; awaiting `apps.launch` (S0a already awaits it; turn a thrown refusal into `denied`); remote `needs_confirm`
  for desktop steps → `denied` (§5.3.7).
- `app/main/agent/host.ts`: binding (`TargetsForAgent.bind`) and `handsFor` **before queueing** in `startTask`; the
  per-target `makeWorker` of §2.6; `refusedWorker` as a `WorkerLike`; `localTargetHands`; the context target only when
  `QuickContext.targetId` equals the bound target; the trusted per-request line (`activeLine()`, plus the "since this
  conversation began" sentence when caps changed); `onTaskFinished` "On build-01: " prefix.
- `app/main/agent/conductor.ts`: `start_task.target`, `describe_screen.target`, `show_me` refusal off this screen,
  `list_computers` and `offer_connect` only with `caps().targets`; the caps read at session creation.
- `app/main/agent/tasks.ts`: `TaskManager.start(…, targetId)`, `TaskCard.where`, lease keys through the worker.
- `app/main/agent/persona.ts`, `worker-persona.ts`: §3.15 exactly; `identity(words, caps)` and `toolRules(words, caps)`
  return today's exact text when caps are off.
- `app/main/agent/presenter.ts`: `Presenter.announce(text: string, stopId: string)`; `where` badges.
- `app/main/policy/vocabulary.ts`: the WSL terminal row chosen by state (bare "wsl" not a terminal word only with WSL
  on; "WSL terminal"/"WSL shell" still are); `test/unit/vocabulary-win32.test.ts` updated deliberately.

## Contracts you implement (normative)

```ts
/** What run_command needs from its worker. */
export interface CommandFlowContext {
  task: {
    id: string;
    title: string;
    /** The user's own words only (Worker.commandWords, §3.7): never the goal; "" when none. */
    commandWords: () => string;
    agreed: () => Agreement[];
    tainted: () => boolean;
    /** Marks the task tainted (command output that reads like instructions, §3.11 step 7); audited. */
    taint: (why: string) => void;
    readFrom: () => ReadSource[];
  };
  service: CommandService;
  confirmer: Confirmer;
  presenter: Presenter;
  audit: (e: AuditEntry) => void;
  log: Logger;
  /** The task's own stop: the run stops with it. */
  signal: AbortSignal;
  isOver: () => boolean;
  /** The task's folder and downloads on this target (kept by the worker across calls). */
  state: { cwd: string | null; downloaded: Set<string>; running: boolean };
  /** The command window's size for new runs. */
  size: () => { cols: number; rows: number };
  /** Ember's own pids now (D4.5; main's live list, §3.6.2). */
  emberPids: () => number[];
}

/** Runs one run_command call to the end; returns the tool result (done, denied or fail). */
export async function runCommandTool(a: RunCommandArgs, ctx: CommandFlowContext): Promise<ToolResultObject>;
```

```ts
this.tool("run_command",
  `Run one command on ${binding.label} in Ember's own command window, where the user watches it and can stop it. ` +
  `Shells here: ${shells.join(", ")} (default ${shells[0]}). Most commands run straight away; ones that delete or ` +
  `overwrite data, push or publish anywhere, touch passwords or keys, change the system, or download and run code ` +
  `stop and ask the user first. Never put a password, token or key in a command. The output comes back as untrusted text.`,
  z.object({
    target: z.string().min(1).max(80).describe(`Where it runs: "${binding.label}" (this task's computer)`),
    command: z.string().min(1).max(8000).describe("The exact command text"),
    shell: z.enum(shells as [ShellId, ...ShellId[]]).optional(),
    cwd: z.string().min(1).max(1024).optional().describe("The folder to run it in: absolute, or ~/…; default: the task's folder"),
    timeoutSeconds: z.number().int().min(1).max(900).optional().describe("Default 120"),
    why: z.string().min(3).max(200).describe("One short sentence: why this command, in plain words"),
  }),
  async a => runCommandTool(a, this.commandContext()))
```

```ts
// in AgentHost.launch, replacing today's makeWorker (host.ts:801-819):
makeWorker: (spec, progress) => {
  const got = this.o.targets ? this.o.targets.handsFor(spec.targetId ?? "local") : { ok: true as const, hands: localTargetHands(hands!, this.sys) };
  if (!got.ok) return refusedWorker(spec, got.why);             // a WorkerLike whose run() finishes at once with { success: false, summary: why }
  const h = got.hands;
  return new Worker({
    client, log: this.o.log.child(`task-${spec.id}`), model: this.status.workerModel, runtimeDefault, vision: workerVision() && h.binding.desktop === "screen",
    provider: this.o.provider, workDir: path.join(this.o.userData, "copilot", "empty-workdir"),
    perception: h.perception, sidecar: h.sidecar, policy: h.policy, confirmer: h.confirmer, audit: h.audit,
    settings: this.o.settings, presenter: this.taskPresenter(spec.id, spec.goal, h.binding),
    lease: (key, owner, signal) => this.tasks!.lease(h.leaseKey(key), owner, signal),
    flyTo: h.flyTo, cursor: h.cursor, clipboard: h.clipboard, pointer: h.pointer, activationKey: h.activationKey,
    desk: h.desk, onDesk: h.onDesk, onProgress: progress, onUsage: (i, o) => this.recordUsage(i, o),
    limits: { turnStartMs: this.o.turnStartMs, turnSlowMs: this.o.turnSlowMs, turnSilentMs: this.o.turnSilentMs },
    inotifyUsedUp: this.o.inotifyUsedUp ?? inotifyUsedUp,
    system: h.system, target: h.binding, commands: h.commands, grantKey: h.grantKey, onAuthorized: h.onAuthorized,
  }, spec);
},
```

```ts
// app/main/commands/carried.ts (built on policy.ts's exported runsIn, S0b):
export function carriedText(text: string, sources: ReadSource[], words: string, os: OS): { from: string[] } | null;
// presenter.ts:
announce(text: string, stopId: string): void;
```

## Contracts you consume (normative)

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
await confirmer.ask({
  title: "May I run a command?", context: taskGoalShort, prompt: `On ${label}: ${firstLine(d.says)}`,
  options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }],
  task: taskId, where: whereWords, armMs: d.armMs,
  panel: { kind: "command", card },
}, signal);
```

```ts
/** How an answer arrived: a bubble button, Ember's approve/deny keys, or the panel window's own buttons. */
export type AnswerVia = "bubble" | "key" | "panel";

/** A question whose full content shows in a window of Ember's own (the command card, a consent card). */
export type QuestionPanel =
  | { kind: "command"; card: CommandCard }
  | { kind: "consent"; consent: ConsentPanel };

/** A first-use consent card (§8.4): its exact text, and a hash of it that the yes must carry back. Lives in
 * app/shared/consent.ts (renderer-safe); confirm.ts imports it. */
export interface ConsentPanel {
  feature: "commands" | "wsl" | "ssh";
  target: TargetId;
  targetLabel: string;
  title: string;
  body: string[];
  yes: string;
  no: string;
  /** sha256Hex of title + "\n" + body.join("\n"). */
  sha256: string;
}

// Question gains:
  /** Where the asking task acts ("on build-01"): a badge in the bubble and the panel. */
  where?: string;
  /** How long clicks are ignored after it shows (default ConfirmerTiming.armMs). */
  armMs?: number;
  /** Its full content shows in a panel window; only that window's buttons (or the keys while it is fully shown) allow it. */
  panel?: QuestionPanel;
  /** The keys can't allow it (consent cards: a click only). */
  clickOnly?: boolean;
```

From CL: `classifyCommand`, `decideCommand`, `matchIntent` (through `decideCommand`), `shapeOutput`, `outputTaint`
(§3.11's export block); `ANNOUNCE_MS = 4000` is yours (export it from `flow.ts`).

## What to build
- `runCommandTool` steps 1-14 of §3.8.3 exactly: validation (target echo check, cwd by the target's rules), consent
  question, facts, classification pass 1, `inspect` and pass 2 when a real path differs, `gitFacts` when `needsGit`,
  `carriedText`, `decideCommand`, refuse/ask/announce/run, the stamp with `classes`, `rules` and `approval.ageMs`
  computed at send, the remote `needs_confirm` ask-once with `remoteSays`, shaping, output taint, downloads after exit
  0, audit entries of §3.12, the plain results of §3.8.6.
- One command at a time per task (`state.running`); `MAX_RUNS_PER_TARGET = 3` waits honour the task's stop.
- Binding and routing per §2.3 and §2.6; the conductor's tools per §2.6's table; persona texts per §3.15.

## Tests (OS-neutral; fakes for CommandService, runner, Confirmer, presenter, targets)
§10.1's AG row: `run_command` only with a CommandService; the target echo check; every flow step (ask, announce + Stop,
refuse, consent, two passes, git facts, remote needs_confirm retry with `remoteSays`, carried text, taint from GUI and
from output); **a task whose `userWords` is absent can only ask, never announce, for every D4.4 example**, and a model
steer never reaches `commandWords`; binding rules; refusal before queueing; the context target only from the same
target; conductor tools only with caps; tools by desktop access; persona texts exactly, and today's exact texts when
caps are off; the WSL terminal row only with WSL on; `open_app` awaits an async remote launch and returns its refusal.

## Acceptance criteria
- `npx tsc --noEmit`, `npm run lint`, `npm test` pass; the existing agent tests unchanged except
  `vocabulary-win32.test.ts`'s deliberate WSL case.
- With no targets runtime (the eval, tests) or with everything off, the conductor's and workers' prompts, tools and
  behaviour are byte-identical to today.
