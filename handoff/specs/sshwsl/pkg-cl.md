# Package CL: the command classifier, decision, intent matcher and output shaping

Read first: `specs/pkg-common.md`, `specs/sshwsl/pkg-common.md`, `specs/sshwsl/decisions.md` (OWNER DECISION 4 above
all), then `specs/sshwsl/design.md`: header, "Limitations and departures" (L2, L8, L18, L19, L25, L26), §3.1, §3.4-§3.9.1
(every rule), §3.11, §7.3 (T1, T25-T28), §10.1 (CL row), §11.4 (CL row), and "Critique resolutions" rows naming CL
(security-1..14, wsl-1, -3, -4, -5, -6, -22, integration-11, -26, -27).

## Goal
The pure heart of OWNER DECISION 4: decide, deterministically and conservatively, which commands run straight away,
which ask, which announce because the user's own words asked for exactly that, and which Ember refuses; and shape what
the model gets back. Pure TypeScript, synchronous, no I/O, total (never throws), plain Node (the remote agent bundles
it), OS-neutral (paths by the target's rules, never the PC's).

## Start and merge
Starts when S0a has merged. Merges after MX, before RUN.

## Files you own (all new)
- `app/main/commands/{lex-posix,lex-powershell,lex-cmd,words,tables,paths,classify,intent,decide,redact,output,prompts,taint}.ts`
- `app/shared/visible-text.ts` (renderer-safe: no Node imports)
- `test/fixtures/commands/{posix,powershell,cmd,wsl}.json` (the corpus), `test/unit/commands-{lex-posix,lex-powershell,lex-cmd,classify,intent,decide,redact,output,prompts,taint,paths}.test.ts`, `test/unit/visible-text.test.ts`

## Shared files
None. (`commands/types.ts` is S0a's contract: extend only in your own files.)

## Contracts you consume (S0a; normative)

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

## Contracts you implement (normative)

```ts
export interface IntentMatch {
  /** The intent row (below). */
  intent: string;
  /** What the bubble says before it runs: "Pushing feature-x to origin, as you asked." */
  announce: string;
}
```

```ts
export interface ShapeOptions {
  target: TargetId; label: string; shell: ShellId; exit: RunExit;
  /** Lines the user typed into the run (L2): cut out wherever they appear. */
  typed: string[];
  /** Characters of output after which a secret prompt started (from the run's tracker), with their ends. */
  secretSpans: { from: number; to: number }[];
}
```

```ts
export function classifyCommand(text: string, shell: ShellId, ctx: ClassifyContext): Classification;
export function decideCommand(i: DecideInput): CommandDecision;
export function matchIntent(cls: Classification, userWords: string, ctx: ClassifyContext & { git: GitFacts | null }): IntentMatch | null;
export function shapeOutput(raw: Uint8Array, o: ShapeOptions): string;
export function redactSecrets(text: string): string;
/** One per run: fed the decoded output as it comes and told when the user presses Enter (interactive runs only). */
export interface SecretTracker { output(text: string): void; enter(): void; spans(): { from: number; to: number }[] }
export function trackSecretPrompts(o: { interactive: boolean }): SecretTracker;
/** The reason the shaped output reads like instructions to Ember (§3.11 step 7), or null. */
export function outputTaint(text: string): string | null;
/** A target path made absolute and normalised with the target's rules (path.posix or path.win32 by os). */
export function resolveTargetPath(p: string, o: { os: OS; home: string; cwd: string }): string;
// app/shared/visible-text.ts (renderer-safe):
export interface VisibleSegment { text: string; kind: "plain" | "control" | "bidi" | "invisible" | "tab" | "nbsp" | "mixed" }
export function visibleText(s: string): VisibleSegment[];
```

## What to build (the design's sections are the specification; highlights)
- Tokenizers (§3.4.1-§3.4.3): POSIX (bash/zsh/dash), a conservative PowerShell 5.1 subset, cmd (nested only). Everything
  not fully understood → an "unclear" finding (g, always asks). Limits: 64 simple commands, 8 nesting levels, 8000
  characters.
- Resolving words (§3.4.4): quote removal; case-insensitive and extension-stripped lookup on Windows, macOS, PowerShell,
  and for interop names on WSL (`CMD.EXE`); `.bat`/`.cmd` as `cmd /c`; Windows path forms (`\\?\`, `\\.\`, admin
  shares, unresolved 8.3 names → unclear; `\\wsl.localhost\<D>\…` → distro + POSIX path); **every path with
  `resolveTargetPath` by `ctx.os`** (lint forbids bare `node:path` in your folder).
- Wrappers and payloads (§3.4.5): sudo-family (e + inner), env/nice/timeout/…, `find -exec/-execdir/-ok` and
  `xargs`/`parallel` payloads classified recursively, `sh -c`/`powershell -Command`/`cmd /c` recursion, interpreters with
  inline code → unclear, **wsl.exe/wslg/bash.exe/distro launchers** parsed as wsl does (no `--exec` → the tail is
  default-shell text; ambiguous joins → unclear; a WSL context), interop cmd from a Linux cwd → unclear, nested
  cmd/PowerShell from WSL with `ctx.wsl.windows`.
- Redirections (§3.4.6) with the **work tree** rule for appends; pipelines and lists (§3.4.7) including launchers (f) and
  GUI programs (unclear: "Open apps with open_app instead.").
- Options before the verb and code-running options (§3.4.8): `GLOBAL_OPTIONS` grammars; unknown option before a verb →
  unclear; host-pointing options → b; the `git -c`/`--config-env`/`git config` deny-set; `.git/hooks/` writes → e.
- Tables (§3.5.1-§3.5.9), complete, including archivers that delete their input, unpacking rules, shell start-up files
  (e, no intent row), WSL configuration files, wsl.exe options, history files (d), and the flat refusals (§3.5.8) in every
  path form (lexical and real; POSIX and Windows; case-insensitive under drive mounts).
- Paths (§3.6): `probe` lists every path (≤ 64, more → unclear); with `ctx.real` (the second pass), judge both forms and
  take the stricter.
- `matchIntent` (§3.7): reads only `userWords` (the caller passes the worker's `commandWords`: never the goal); null when
  empty; widening signals only from the user's words (a trailing `/` in the command never counts); `git push` rows with
  `GitFacts` (bare push / `HEAD` only for single-branch `push.default` and a known branch); explicit refspecs named or
  confirmed current.
- `decideCommand` (§3.8.2): rules 1-11 in order; `armMs`; the Windows line; the tool-owned distro line.
- `shapeOutput` (§3.11 steps 1-6), `trackSecretPrompts` (an unclosed span on a pipe run runs to the end), `redactSecrets`
  (step 4's patterns), `outputTaint` (step 7's patterns; ordinary tool hints don't match), `visibleText` (controls,
  bidi, invisibles, tabs, NBSP, and mixed-script letters in every token).

## Tests (OS-neutral)
§10.1's CL row in full: the corpus of ≥ 800 cases (every D4.2 example runs; every D4.3 example and table row asks or
refuses as specified; every obfuscation and every critique case listed there, incl. `git -c alias.x='!…'`,
`npm --prefix /x run deploy`, `find -exec sh -c`, `tar --remove-files`, `echo x >> ~/.bashrc`, `cat ~/.bash_history`,
`wsl -- "rm -rf ~"`, `CMD.EXE /c del x`, `cmd.exe /c type C:\Users\ana\.aws\credentials` from WSL,
`type C:\Users\ANA~1\.aws\credentials`, `xdg-open x`, `gedit notes.txt`); paths judged with `os: "linux"` give the same
results whatever `process.platform` is (run the POSIX corpus with `path.win32` deliberately unavailable to your code);
every intent row's "covers" and "broader" columns (empty `userWords` → never announces; `rm -rf build/` after "delete
build" asks; bare `git push` without facts asks, with `matching` asks, with `simple` + branch announces it); the decision
order; redaction; shaping (ANSI, CR progress bars, bounds, wrapping, `<` escaping, typed-text and secret-span removal);
`outputTaint`; `visibleText`; fuzz (random bytes never throw and never classify as ordinary when unparsable); speed
< 5 ms per KiB.

## Acceptance criteria
- Every rule of §3.4-§3.8 and §3.11 implemented exactly; the exports above with exactly these signatures.
- `npx tsc --noEmit`, `npm run lint`, `npm test` pass; no import outside `commands/types.ts`, your own files, `zod` and
  `node:path/posix`/`node:path/win32`; the remote bundle check (SB) will reject anything else.
- The report lists the corpus size per family and every place the design was ambiguous and what you chose (always the
  stricter reading).
