# Package SB: the remote agent (`ember-remote`), the remote parts, and the SSH CI jobs

Read first: `specs/pkg-common.md`, `specs/sshwsl/pkg-common.md`, `specs/sshwsl/decisions.md` (D2, D3, R2, R3, R5, R6,
D4.6), then `specs/sshwsl/design.md`: header, "Limitations and departures" (L4-L6, L9, L10, L12, L16, L17, L21, L23,
L24), §3.13 (the ladder; orphans), §3.16 (gate 2 for commands), §5.1.9-§5.1.11 (the bootstrap's other end, framing,
liveness), §5.2 entirely, §5.3 entirely, §5.4, §7, §9 (remote policy), §10.1-§10.2 (SB rows; `ssh-linux`, `ssh-el8`,
`wayland-remote`, `ssh-macos`), §11.4 (SB row), "Critique resolutions" rows naming SB (security-3, remote-1, -2, -5, -7,
-8, -9, -10, -13..16, -22, -25..27, integration-2, -6, -14, -19).

## Goal
The clone on the remote: a plain-Node agent that serves the framed protocol over the SSH channel only, re-checks every
step and command against the remote's own admin policy (gate 2: it can refuse or ask, never approve), runs commands
with the same launchers and ladder as the PC, reaches the same user's local console desktop on Linux (X11 full read +
tier 1; Wayland text once its CI job passes), writes its own audit, shows its notice, and stops on EOF, the dead-man
(desktop) and the grace (commands). Plus the parts pipeline that ships it inside every Ember installer.

## Start and merge
Starts when S0a has merged (fake the mux until MX merges; RUN's runner and CL's classifier land before you merge).
Merges after SA, before SC.

## Files you own
- `app/remote/**` (`main.ts` and `capture-stub.ts` S0a stubs; `serve`, `lock`, `watchdog`, `liveness`, `gate`,
  `desktop-linux`, `desktop-child`, `screen`, `png`, `mask`, `commands`, `audit`, `admin`, `consent`, `notice`, `orphans`)
- `sidecar/notice/ember_notice.py`
- `scripts/package/{remote-parts.mjs,remote-parts.d.mts,remote-runtime.json,tar-writer.mjs}`
- `test/integration/remote-{ssh,el8,desktop,wayland}.test.ts`, `test/unit/remote-agent-{serve,gate,desktop-linux,png,lock,liveness,policy,orphans,tar,build}.test.ts`,
  `test/fixtures/remote/**` (real `loginctl`/`busctl` output captured from RHEL 8 and Ubuntu 24.04 containers or VMs;
  never hand-ordered)

## Shared files you may touch (minimally; list every hunk)
- `scripts/package/stage.mjs` (copy `dist/remote-parts/` to `resources/remote-parts/`; fail closed without
  `remote-parts.json` unless `--allow-missing-remote-parts`; one block), `scripts/package/layout.mjs` (list the folder),
  `package.json` (every `package*` script runs `node scripts/package/remote-parts.mjs` after the build),
  `scripts/check-symvers.sh` (aarch64 `koffi.node` against glibc 2.28).
- `.github/workflows/remote.yml`: the `ssh-linux`, `ssh-el8`, `wayland-remote` and `ssh-macos` jobs' set-up only.
- `ci.yml` is **not** yours: if I-win's/I-mac's package steps need `--allow-missing-remote-parts`, say so for the lead.

## Contracts you implement (normative)

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

The agent's side of every op and event; gate 2 answers per §3.16 and §5.3.7; `Welcome` with `pcId` checked against
`--pc`, `tccLimited`, `graceSeconds`.

## Contracts you consume

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

`createMux` (MX), RUN's `launchArgv`/`commandEnv`/`sweepScript`/`localFacts`, CL's `classifyCommand` (gate 2),
`PolicyEngine`, `Perception` with `PerceptionOptions.capture`, `openLinuxWindows`, `hands/system.ts`'s app functions,
`AuditLog`/`journalSink`, `KillSwitch`, `loadAdminPolicy(ADMIN_POLICY_PATHS[os], { requireRootOwned: true })`.

## What to build (normative details in §5.2-§5.3)
- **Start-up hygiene** (§5.3.3): refuse `NODE_*`, `LD_*`, `DYLD_*`; packaged = `versions/<partsId>/` with `.verified`;
  ignore `EMBER_*` but `EMBER_LOG_LEVEL`; the orphan sweep from `runs/` stamps; stop on EOF/SIGHUP/SIGTERM.
- **Serve**: the preamble and mux; ops dispatch closed; `hello` checks (`pcId` equals `--pc`); the lock with `pcId`
  (same-pcId takeover after the grace; another PC → `busy`); the remote policy every 10 s; the grace and the desktop
  dead-man as separate timers; `stop` answers; the watchdog thread killing run groups/sessions before the agent.
- **Gate 2** (§3.16, §5.3.7): freshness, epoch, sha256, the remote's `commands.ssh`, its own classification with its
  own `inspect` — **any class or rule beyond the stamp's → `needs_confirm` with `says`/`rules`**, for "run" and
  "announce"; `ageMs` limits (10 s for desktop steps, 120 s for a command approval); write-ahead audit.
- **Commands**: RUN's launchers and ladder on the remote (PTY through `script`; stdin kept open); `cmd.inspect`,
  `cmd.git`, `cmd.input`, `cmd.stop`; output on bulk channels.
- **Desktop** (§5.3.4-§5.3.6, §5.3.9): `discoverDesktop` over injected readers (loginctl `Key=Value` by name, seat/remote
  rules incl. VNC/xrdp → none, lock signals, the session environment from the user manager or a readable scope process,
  the X11 rules, the base environment); the desktop child (Perception with `png.ts` capture, AT-SPI sidecar, X11 window
  system with a root-sized `ScreenLike`, apps with the session's environment); the notice (GTK on X11/Xwayland, a
  resident notification on Wayland without Xwayland; failed → desktop none); console consent; Wayland only after
  `wayland-remote` passes.
- **macOS remotes**: commands only; `tcc` → `welcome.tccLimited`; the session folder under `DARWIN_USER_TEMP_DIR`.
- **Parts** (§5.2.2): the esbuild bundle (S0a's entry; the capture alias), koffi's `node_modules` layout, the
  deterministic JS tar writer + gzip, `remote-parts.json`, `partsId`, `remote-runtime.json` with `minimum` and `pinned`
  (xz and gz hashes, GPG-checked once; record how), symvers on aarch64.
- **The bundle check** (`remote-agent-build.test.ts`): metafile-only allow-list (§5.2.2).

## Tests
- Unit (OS-neutral): §10.1's SB row in full (gate 2 incl. extra classes on "announce"; `discoverDesktop` on captured real
  output: another user, each lock signal, Wayland, VNC/xrdp, two sessions, `DISPLAY=localhost:10.0`, root, GNOME ≥ 3.34;
  the desktop child's base environment; PNG round-trip and masks; lock staleness and same-pcId takeover; dead-man vs
  grace; orphan sweep; watchdog order; remote policy via `ADMIN_POLICY_PATHS`; the tar writer's determinism; the
  metafile allow-list and the capture alias).
- Integration (§10.2): `remote-ssh.test.ts` (`ssh-linux`; `EMBER_SSH_TEST=1`, `EMBER_TEST_ALLOW_LOOPBACK_SSH=1`),
  `remote-el8.test.ts` (`ssh-el8`), `remote-desktop.test.ts` (Xvfb, `EMBER_REMOTE_DEV=1`), `remote-wayland.test.ts`
  (`wayland-remote`), and the macOS commands-only path with a two-archive install (`ssh-macos`;
  `EMBER_SSH_TEST_MACOS=1`).

## Acceptance criteria
- `npx tsc --noEmit`, `npm run lint`, `npm test` pass; `npm run build` produces `dist/remote/ember-remote.cjs` whose
  metafile passes the bundle check; `remote-parts.mjs` gives identical bytes on two runs.
- The agent never listens, never persists anything beyond §5.2.3's folders, stops on EOF, and never approves.
- The CI jobs green or "not testable on this runner" exactly where §10.2 allows; otherwise reported "not run".
