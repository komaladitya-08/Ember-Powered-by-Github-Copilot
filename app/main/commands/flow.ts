/**
 * The run_command flow (§3.8.3; package AG): one command from the model's call to its result. It checks the call (the
 * computer named is this task's, the folder by that computer's path rules), asks for the commands card the first time,
 * reads the target's facts, classifies the command (twice when a path's real form differs), asks the target for git
 * facts, and decides with the user's own words only (never the goal the conductor wrote: critique security-1). Then it
 * refuses, asks with the command card, announces (D4.4) or runs, in Ember's command window. A remote's own check may ask
 * once more (§3.16). What comes back is the shaped, untrusted output; output that reads like instructions taints the
 * task, so every later command asks (§3.11 step 7). Every step is audited (§3.12); the command's text reaches no log.
 *
 * The classifier, the decision and the shaping are CL's pure functions (classify, decide, output, redact, prompts,
 * taint, paths), reached through CommandJudge so the tests can pass their own. The flow also holds CL's answer to a few
 * invariants of its own (a task without the user's own words never announces; taint, carried text, "ask every" and
 * root always ask), so a looser decision can never run a command the design says must ask.
 */

import crypto from "node:crypto";
import type { ToolResultObject } from "@github/copilot-sdk";
import type { Logger } from "../logger";
import type { Confirmer, Question } from "../agent/confirm";
import type { Presenter } from "../agent/presenter";
import type { AuditEntry } from "../policy/audit";
import type { Agreement, ReadSource } from "../policy/policy";
import { commandActs, commandNamed, type CommandAsked, type Refusals } from "../policy/refusals";
import { placeMentions, placesNamed } from "../targets/resolve";
import type { TargetBinding } from "../targets/types";
import type { ConsentPanel } from "../../shared/consent";
import type { OS } from "../../shared/shortcuts";
import type { TargetId } from "../../shared/targets";
import { pendingCommand } from "./pending";
import { carriedText } from "./carried";
import { notReviewable, reviewedDecision, type CommandReviewer } from "./review";
import { AUTOPILOT_LINE, AUTOPILOT_RULE, askedOfFinding, autopilotCommand, handedSecrets } from "./autopilot";
import { AUTOPILOT_WORDS } from "../policy/policy";
import { classifyCommand } from "./classify";
import { LINES, decideCommand } from "./decide";
import { covers, type AutonomyScopes } from "../policy/autonomy";
import { heldByWords, mentioned, namedKind, ruledOut } from "./intent";
import { capLines, cleanOutput, cleanOutputAsync, clearCutSteps, CUT_SLACK, redactedWhole, shapeCleaned, shapeOutput, type ShapeOptions } from "./output";
import { resolveTargetPath } from "./paths";
import { trackSecretPrompts, type SecretTracker } from "./prompts";
import { redactSecrets, redactSecretsYielding, runSteps, runStepsYielding } from "./redact";
import { judgeScripts, newTaskWrites, noteWrites, withoutReadFlow, type ScriptIo, type TaskWrites } from "./scripts";
import { outputTaint } from "./taint";
import {
  ALWAYS_ASK,
  type Classification, type ClassifyContext, type CommandCapability, type CommandCard, type CommandDecision, type CommandMode, type CommandRunner,
  type CommandService, type DecideInput, type Finding, type GitFacts, type PathFact, type RunCommandArgs, type RunExit, type RunnerFacts, type RunningCommand,
  type RunSpec, SHELL_FAMILY, type ShellId, standingFindings,
} from "./types";
import { judgedText } from "./unroll";

/** What run_command needs from its worker. */
export interface CommandFlowContext {
  task: {
    id: string;
    title: string;
    /** The user's own words only (Worker.commandWords, §3.7): never the goal; "" when none. */
    commandWords: () => string;
    /**
     * The task's words when some of them were heard where Ember can't tell the user from its speakers (OWNER V1): they
     * never count for an announcement, but the card says the user asked by voice rather than "You didn't ask for this."
     */
    spokenWords?: () => string;
    /**
     * The user's own words for Assisted's check (Worker.checkWords): what the reviewer reads a command against, spoken
     * requests heard unchecked included, never a suggestion's, a routine's saved steps or words heard over Ember's
     * voice. Absent: commandWords.
     */
    checkWords?: () => string;
    /**
     * The user's own words for this task, quoted on one line (Worker.ownWordsLine), or "" for none: the "Your task:" line
     * of a question about a command they didn't ask for, or of any in a task that was steered (Question.taskLine;
     * tasks-approvals-c1-1). Absent, such a question has no task line, never the goal.
     */
    ownWords?: () => string;
    agreed: () => Agreement[];
    tainted: () => boolean;
    /** Marks the task tainted (command output that reads like instructions, §3.11 step 7); audited. */
    taint: (why: string) => void;
    readFrom: () => ReadSource[];
  };
  service: CommandService;
  /** Asks the user, through the worker: the wait for an answer doesn't count toward the task's time limit. */
  /** `howAnswered` (optional): how the card was answered, for the audit (a spoken answer, and whether Voice Match verified it). */
  confirmer: Pick<Confirmer, "ask"> & { howAnswered?: Confirmer["howAnswered"] };
  /**
   * The approval mode in force (policy/autonomy.ts): its scopes for this task, or null (below Interactive, or the task
   * was steered or told no). With commands and crossWindow on, as every mode has them, an ordinary command that asks
   * only because it carries text read elsewhere announces instead (autonomousCommand).
   */
  autonomy?: () => AutonomyScopes | null;
  presenter: Presenter;
  audit: (e: AuditEntry) => void;
  log: Logger;
  /** The task's own stop: the run stops with it. */
  signal: AbortSignal;
  isOver: () => boolean;
  /**
   * The task's folder and downloads on this target (kept by the worker across calls). The flow's own: `outputTainted`
   * (a command's output tainted the task, so the card says so in its own words, §3.8.4) and `written` (what the task's
   * commands wrote, so a script of its own that can't be read in full asks: L8's padding bypass).
   */
  state: { cwd: string | null; downloaded: Set<string>; running: boolean; outputTainted?: boolean; written?: TaskWrites };
  /** The command window's size for new runs. */
  size: () => { cols: number; rows: number };
  /** Ember's own pids now (D4.5; main's live list, §3.6.2). */
  emberPids: () => number[];
  /**
   * The user said no to a question of this flow, or (`expired`) let it go unanswered: the worker's `declined` or
   * `expired` (extension, AG). Only a no holds the task to asking afterwards.
   */
  onDeclined?: (expired?: boolean) => void;
  /**
   * Assisted's check for commands (review.ts), while Assisted is the approval mode in force: a command that would ask,
   * and that may be reviewed at all (notReviewable), is shown to the reviewer first, and runs with its announcement
   * when the reviewer finds it in the user's own words.
   */
  review?: CommandReviewer;
  /**
   * Autopilot is the approval mode in force (policy/autonomy.ts approvalInputs().autopilot), read at each command: one
   * that would ask announces with its Stop instead, in a task that was steered or told no too, but for the few that
   * still ask there (autopilot.ts autopilotAsks). Absent or false: nothing changes.
   */
  autopilot?: () => boolean;
  /** Home project commands always need the exact command card, with the chosen folder still present at launch. */
  projectFolderCurrent?: () => boolean;
  /**
   * What the user said no to in this task, or left unanswered (the worker's, policy/refusals.ts): a command they turned
   * down, sent again or reworded, is refused without a card, a review or an announcement, and a card nobody answered
   * isn't shown again until they next say something to the task (commands-remote-r9-8). Absent: nothing is kept.
   */
  refusals?: Refusals;
}

export type { SecretTracker, ShapeOptions };
export { scriptLanguage, type ScriptLanguage } from "./scripts";

/**
 * A command question's task line (Question.taskLine; tasks-approvals-c1-1): the user's own words, never the goal, under a
 * command they didn't ask for or in a task that screen text or a command's output tried to steer, read as it is asked.
 */
function ownTaskLine(ctx: CommandFlowContext, unasked: boolean): { taskLine?: string } {
  if (!unasked && !ctx.task.tainted() && !ctx.state.outputTainted) return {};
  return { taskLine: ctx.task.ownWords?.() ?? "" };
}

/** CL's pure functions the flow calls (§3.11's export block: exactly CL's signatures). */
export interface CommandJudge {
  classifyCommand(text: string, shell: ShellId, ctx: ClassifyContext): Classification;
  decideCommand(i: DecideInput): CommandDecision;
  shapeOutput(raw: Uint8Array, o: ShapeOptions): string;
  redactSecrets(text: string): string;
  trackSecretPrompts(o: { interactive: boolean }): SecretTracker;
  outputTaint(text: string): string | null;
  resolveTargetPath(p: string, o: { os: OS; home: string; cwd: string }): string;
  /**
   * CL's steps 1-4 of shaping (terminal codes, secret spans, typed lines, redaction) without the cut to size: what the
   * output-taint check reads, so nothing hides in the part the model's copy leaves out (CL's review). Optional for
   * judges a test makes; the flow then checks its own cleaned copy.
   */
  cleanOutput?(raw: Uint8Array, o: Pick<ShapeOptions, "typed" | "secretSpans">): string;
}

/** CL's own functions: what every command is judged by unless a test passes its own judge. */
export const CL_JUDGE: CommandJudge = Object.freeze({
  classifyCommand, decideCommand, shapeOutput, redactSecrets, trackSecretPrompts, outputTaint, resolveTargetPath, cleanOutput,
});
let judge: CommandJudge = CL_JUDGE;

/** Hands the flow a judge (tests pass their own); null: CL's own again. */
export function setCommandJudge(j: CommandJudge | null): void {
  judge = j ?? CL_JUDGE;
}

/** What a task's bubble says while Assisted's check reads a command against the user's words, before any card (flow). */
export const CHECKING_COMMAND = "Checking this command against what you asked…";

/** The card's line when the user asked for it by voice where Ember can't tell their voice from the speakers (OWNER V1). */
export const SPOKEN_LINE = "You asked by voice. Ember can't tell your voice from what your speakers play, so it checks first.";

/** The card's taint line when what tainted the task was a command's own output (§3.8.4). */
export const OUTPUT_TAINT_LINE = "Ember is checking each step: an earlier command printed text that looked like instructions.";

/** A command service that can show its first-use commands card (§8.4.3; built by the targets runtime). */
export interface CommandConsentSource {
  /** The commands card for this target, with its text hashed; null when it can't be shown (then nothing is turned on). */
  consentPanel(): ConsentPanel | null;
}

/**
 * A command service that knows the other computers Ember works on (built by the targets runtime): D4.4's wrong-target
 * guard (DOC's review). Without it (no targets runtime: tests, the eval) this computer is the only one there is.
 */
export interface CommandTargetGuard {
  /** The labels of known targets other than this service's that the user's own words name anywhere. */
  othersNamed(words: string): string[];
  /**
   * The places the user's own words name that look like a computer but that Ember doesn't know ("delete build/ on
   * prod-db": TG's placesNamed over every target and ssh-config host). Without it, the flow looks with this target's
   * own names only.
   */
  placesNamed(words: string): string[];
}

/** The card's first line when the user's words also name another computer: it says which one runs the command. */
export const wrongTargetLine = (others: string[], here: string) => `You also named ${listOf(others)}, but this runs ${here}.`;

/**
 * The card's first line when the user's words name a place that looks like a computer Ember doesn't know: it may be a
 * folder or a branch after all ("in my-app"), so the card says what it looks like (review #31).
 */
export const unknownPlaceLine = (places: string[], here: string) =>
  places.length === 1 && places[0] === "another computer"
    ? `It looks like you named another computer, but this runs ${here}.`
    : `It looks like you named another computer (${listOf(places)}), but this runs ${here}.`;

/** Place words that name a folder ("delete build/ in my-app"), for notLocalPlaces. */
const FOLDER_WORDS: ReadonlySet<string> = new Set(["in", "inside", "into"]);

/**
 * The places that are still unknown computers once the target has been asked (review #31): one every mention of which
 * reads as a folder ("in my-app") that is a folder of the task's folder's path or is there, or as a branch ("on
 * feature-x") that the task's folder is on, is a folder or a branch, not a computer. Only what the target confirms takes
 * a place out: a check that can't answer leaves it in (the command asks).
 */
async function notLocalPlaces(places: string[], words: string, o: {
  runner: CommandRunner; cwd: string; git: GitFacts | null; at: (p: string) => string; isOver: () => boolean;
}): Promise<string[]> {
  const simple = (p: string) => /^[\p{L}\p{N}_][\p{L}\p{N}._-]*$/u.test(p) && !/^\d+(\.\d+){3}$/.test(p);
  const all = (p: string, ok: (via: string) => boolean) => { const m = placeMentions(words, p); return m.length > 0 && m.every(ok); };
  const folders = places.filter(p => simple(p) && all(p, v => FOLDER_WORDS.has(v)));
  const branches = places.filter(p => simple(p) && all(p, v => v === "on"));
  const gone = new Set<string>();
  const above = new Set(o.cwd.split(/[\\/]+/).filter(Boolean).map(s => s.toLowerCase()));
  for (const p of folders) if (above.has(p.toLowerCase())) gone.add(p);
  const look = folders.filter(p => !gone.has(p));
  if (look.length) {
    const found = await inspect(o.runner, look.map(o.at), o.cwd);
    look.forEach((p, i) => { if (found[i].exists === true) gone.add(p); });
  }
  if (branches.length && !o.isOver()) {
    const branch = (o.git ?? await within(o.runner.gitFacts(o.cwd), PROBE_MS, null))?.branch?.toLowerCase();
    for (const p of branches) if (branch && branch === p.toLowerCase()) gone.add(p);
  }
  return places.filter(p => !gone.has(p));
}

/** Strings a guard gave: each once, at most five (anything else is dropped). */
const guardList = (got: unknown): string[] =>
  Array.isArray(got) ? [...new Set(got.filter((x): x is string => typeof x === "string" && x.trim() !== ""))].slice(0, 5) : [];

/** The other computers the user's words name (the guard's answer; a guard that fails counts as naming one: it asks). */
function othersNamedIn(svc: CommandService, words: string): string[] {
  const guard = (svc as CommandService & Partial<CommandTargetGuard>).othersNamed;
  if (typeof guard !== "function" || !words.trim()) return [];
  try {
    return guardList(guard.call(svc, words));
  } catch {
    return ["another computer"];
  }
}

/**
 * The places the user's words name that look like a computer Ember doesn't know (the lead's ruling): the guard's answer,
 * or, without one (no targets runtime), placesNamed over this target's own names. A guard that fails counts as naming
 * one (it asks). Names `others` already gives (a known computer) are left out.
 */
function placesNamedIn(svc: CommandService, words: string, binding: TargetBinding, others: string[]): string[] {
  if (!words.trim()) return [];
  const guard = (svc as CommandService & Partial<CommandTargetGuard>).placesNamed;
  let got: string[];
  try {
    got = typeof guard === "function" ? guardList(guard.call(svc, words))
      : placesNamed(words, [{ id: binding.id, names: [binding.label, binding.id.slice(binding.id.indexOf(":") + 1)] }]);
  } catch {
    got = ["another computer"];
  }
  const said = new Set(others.map(normalName));
  return got.filter(p => !said.has(normalName(p)));
}

/** How long an announced command waits for the user's Stop before it runs (D4.4, §3.7), unless the window says longer. */
export const ANNOUNCE_MS = 4000;
/** The longest countdown a command window may ask for. */
const ANNOUNCE_MAX_MS = 60_000;

/**
 * How long an announcement counts down: what the command window says (UI's announceMs: longer while a screen reader
 * runs, review #46), never less than ANNOUNCE_MS nor more than a minute; ANNOUNCE_MS when it doesn't say.
 */
function announceTime(w: CommandService["window"]): number {
  const ask = (w as CommandService["window"] & { announceMs?: (base: number) => unknown }).announceMs;
  if (typeof ask !== "function") return ANNOUNCE_MS;
  try {
    const ms = ask.call(w, ANNOUNCE_MS);
    return typeof ms === "number" && Number.isFinite(ms) && ms >= ANNOUNCE_MS && ms <= ANNOUNCE_MAX_MS ? ms : ANNOUNCE_MS;
  } catch {
    return ANNOUNCE_MS; // a window that can't say: the usual time
  }
}

/**
 * Whether announcement `runId` ended because the command window couldn't show it to the end (UI's announceGone: its page
 * crashed, it closed; cross-review S2) rather than by the user's Stop; false when the window doesn't say.
 */
function announceGone(w: CommandService["window"], runId: string): boolean {
  const ask = (w as CommandService["window"] & { announceGone?: (runId: string) => unknown }).announceGone;
  if (typeof ask !== "function") return false;
  try {
    return ask.call(w, runId) === true;
  } catch {
    return false; // a window that can't say: the user's Stop, as before
  }
}
/** Runs one target runs at once; a fourth waits for a slot, honouring its task's stop (§3.8.3). */
export const MAX_RUNS_PER_TARGET = 3;
/** A run_command call's default time limit (§3.13), and its longest. */
export const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 900;
/** The shells run_command may run in (cmd only inside PowerShell, L3): a target that reports another is not believed. */
const RUN_SHELLS: ReadonlySet<string> = new Set<ShellId>(["bash", "zsh", "sh", "powershell"]);
/** How long the target's facts may take (a WSL distro may have to boot). */
const FACTS_MS = 30_000;
/** How long inspect and git facts may take. */
const PROBE_MS = 5000;
/** Output kept for shaping (§3.10): the first characters, and a rolling tail up to the whole cap. */
const HEAD_CHARS = 64 * 1024;
const KEEP_CHARS = 4 * 1024 * 1024;
/** After a task's stop, how long its run gets to end before the tool returns anyway. */
const STOP_GRACE_MS = 3000;
/** The audit keeps a command's text redacted and at most this long (§3.12). */
const AUDIT_COMMAND_CHARS = 2000;

const done = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "success" });
const fail = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "failure", error: text });
const denied = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "denied" });
const STOPPED = (): ToolResultObject => denied("Stopped. Do nothing more.");
const SAID_NO = "The user said no. Don't run it again or work around it; finish the task saying what wasn't done.";
/** To a command whose card ran out of time: nobody said yes and nobody said no (the worker's UNANSWERED says the same of a step). */
const TIMED_OUT = "Your question went unanswered: time ran out before the user answered, which is neither a yes nor a no. Nothing was approved, so the command didn't run. Don't run it again or work around it; finish the task now, saying that the question went unanswered and what wasn't done.";
/** To a command the user already said no to in this task, sent again or reworded: refused without a card (Refusals). */
const REFUSED_BEFORE = "The user already said no to this command in this task, or to one that does the same to the same thing, so Ember refused it without asking them again. Don't run it another way; finish the task saying what wasn't done.";
/** To a command whose card went unanswered, sent again before the user said anything more to the task: not asked twice. */
const STILL_UNANSWERED = "Ember already asked the user about this command, or one that does the same to the same thing, and the question went unanswered; they haven't said anything to this task since, so Ember didn't ask again and it didn't run. Don't run it another way; finish the task now, saying that the question went unanswered and what wasn't done.";
const STOPPED_BEFORE = "The user stopped it before it ran. Don't run it again; finish the task saying so.";
const UNSHOWN_BEFORE = "Ember's command window couldn't show the countdown to the end, so the command didn't run (commands only run where the user can watch them). Don't run it again; finish the task saying so.";
const UNSEEN = "Ember couldn't show the command in its command window, so it stopped it at once (commands only run where the user can watch them). Don't run it again; finish the task saying so.";

/** The card's lines for the reasons the flow itself holds (§3.8.4). */
export const CARD_LINES = {
  root: "Commands here run as root (the administrator), so each one asks first.",
  admin: "Ember is running as an administrator here, so each command asks first.",
  adminAsk: "Your organisation asks you to approve every command.",
  userAsk: "You asked Ember to check every command with you.",
  tool: "Podman uses this distro: Ember asks before every command here.",
  tainted: "Ember is checking each step: a step came up that you didn't ask for.",
  carried: (places: string[]) => `This command may carry text Ember read in ${listOf(places)}.`,
} as const;

/** How a sentence names a task's target: "this computer" for the PC, else its label ("build-01", "Ubuntu (WSL)"). */
export const placeName = (t: Pick<TargetBinding, "kind" | "label">) => (t.kind === "local" ? "this computer" : t.label);

/** The badge for where a task acts (§2.4): "on build-01", "in Ubuntu (WSL)"; none for this computer. */
export function whereWords(t: Pick<TargetBinding, "kind" | "label">): string | undefined {
  return t.kind === "ssh" ? `on ${t.label}` : t.kind === "wsl" ? `in ${t.label}` : undefined;
}

/** "a", "a and b", "a, b and c". */
function listOf(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0] ?? "another window";
}

/** Number words a request may say a name with ("build zero one"), as digits (§2.3 rule 1). */
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const NUMBER_WORD = new RegExp(`\\b(${NUMBER_WORDS.join("|")})\\b`, "g");

/** A name as §2.3 rule 1 compares it: NFKC, lower case, number words as digits, only letters and digits. */
export function normalName(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(NUMBER_WORD, w => String(NUMBER_WORDS.indexOf(w))).replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The words that name this computer in run_command's `target`. */
const LOCAL_NAMES = new Set(["thiscomputer", "local", "mycomputer", "thispc", "thismac", "thismachine", "thislaptop"]);

/** Does run_command's `target` name the task's target: its label, its alias or distro name, or "this computer" (§3.2)? */
export function namesTarget(said: string, t: Pick<TargetBinding, "id" | "kind" | "label">): boolean {
  const n = normalName(said);
  if (!n) return false;
  if (n === normalName(t.label)) return true;
  if (t.kind === "local") return LOCAL_NAMES.has(n);
  const name = t.id.slice(t.id.indexOf(":") + 1);
  return n === normalName(name);
}

/** Characters that would hide or reorder what a line says: shown as ⟨U+XXXX⟩ (remote text on the card, quoted). */
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0]/gu; // eslint-disable-line no-control-regex -- control characters are exactly what is made visible

/** Untrusted text for the card: quoted, one line, every hidden character shown, at most `max` characters. */
export function shownQuote(s: string, max = 300): string {
  const one = s.replace(/[\r\n\t]+/g, " ").replace(HIDDEN, c => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`);
  return `“${one.length > max ? `${one.slice(0, max - 1)}…` : one}”`;
}

/** Untrusted text for the model: JSON-quoted, `<` escaped (as quoteUntrusted). */
const forModel = (s: string, max = 300) => JSON.stringify(s.length > max ? `${s.slice(0, max)}…` : s).replace(/</g, "\\u003c");

/** sha256Hex(`${target}\0${shell}\0${cwd}\0${command}`): what an approval binds to (§3.9.1). */
export function commandSha256(target: TargetId, shell: ShellId, cwd: string, command: string): string {
  return crypto.createHash("sha256").update(`${target}\0${shell}\0${cwd}\0${command}`, "utf8").digest("hex");
}

/** `p`, or `fallback` once `ms` pass or it rejects. */
async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); timer.unref?.(); });
  try {
    return await Promise.race([p.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The target's facts, read once per task (again after the connection was lost): what a run's runner said. */
const factsCache = new WeakMap<object, { runner: CommandRunner; facts: RunnerFacts }>();

async function factsOf(ctx: CommandFlowContext): Promise<RunnerFacts | null> {
  const runner = ctx.service.runner;
  const held = factsCache.get(ctx.state);
  if (held && held.runner === runner) return held.facts;
  const facts = await within(runner.facts().then(f => f as RunnerFacts | null), FACTS_MS, null);
  if (facts) factsCache.set(ctx.state, { runner, facts });
  return facts;
}

/** A runner's script reading (the CommandRunner extension of L8's ruling), as judgeScripts takes it; null without one. */
function scriptIo(runner: CommandRunner): ScriptIo | null {
  const read = (runner as CommandRunner & { readScript?(path: string, cwd: string): Promise<string | null> }).readScript;
  if (typeof read !== "function") return null;
  return { read: (path, cwd) => read.call(runner, path, cwd), inspect: (paths, cwd) => runner.inspect(paths, cwd) };
}

/** Each path's facts, all unknown when the target doesn't answer in time (§3.8.3 step 5). */
async function inspect(runner: CommandRunner, paths: string[], cwd: string): Promise<PathFact[]> {
  const unknown = paths.map((): PathFact => ({ exists: null, real: null }));
  if (!paths.length) return [];
  const got = await within(runner.inspect(paths, cwd), PROBE_MS, unknown);
  return paths.map((_, i) => got[i] ?? { exists: null, real: null });
}

/** Run slots per runner (MAX_RUNS_PER_TARGET). */
const slots = new WeakMap<CommandRunner, { used: number; waiters: Set<() => void> }>();

/** A slot to run on `runner`, or null when `signal` aborted first; the function returned gives it back. */
async function slotOn(runner: CommandRunner, signal: AbortSignal): Promise<(() => void) | null> {
  let s = slots.get(runner);
  if (!s) slots.set(runner, s = { used: 0, waiters: new Set() });
  const held = s;
  while (held.used >= MAX_RUNS_PER_TARGET) {
    if (signal.aborted) return null;
    await new Promise<void>(resolve => {
      const wake = () => { held.waiters.delete(wake); signal.removeEventListener("abort", wake); resolve(); };
      held.waiters.add(wake);
      signal.addEventListener("abort", wake, { once: true });
    });
  }
  if (signal.aborted) return null;
  held.used++;
  let given = false;
  return () => {
    if (given) return;
    given = true;
    held.used--;
    for (const w of [...held.waiters]) w();
  };
}

/** A run's id: 16 lower-case hex digits, random per run (also its environment marker, EMBER_RUN_ID). */
const newRunId = () => crypto.randomBytes(8).toString("hex");

/** A first line for the bubble: the card's first reason, or a plain one. */
const firstLine = (says: string[]) => says.find(l => l.trim()) ?? "This command needs your OK.";

/** Seconds as the results say them: "3.4", "12". */
const seconds = (ms: number) => (ms < 10_000 ? (Math.round(ms / 100) / 10).toString() : Math.round(ms / 1000).toString());

/** Terminal codes taken out of text before it is checked for instructions (shaping does this fully, §3.11 step 1). */
const TERMINAL_CODES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[ -/]*[0-~]?|[\u0000-\u0008\u000b-\u001f\u007f]/g; // eslint-disable-line no-control-regex -- terminal control codes are what is removed

/**
 * The output a run printed, decoded as it comes: the first HEAD_CHARS characters and a rolling tail up to KEEP_CHARS
 * (the middle counted, not kept), and where its secret prompts were (the tracker sees every character and every Enter
 * the user pressed, never what they typed). The tail is a list of chunks, cut back to size only when it holds twice
 * what is kept: cutting a single string per chunk copied 4 MiB each time and saturated the main thread.
 *
 * The cut between the two comes before the output is cleaned, and so before the vault's redactor reads it: a value
 * the cut fell in would go on as a fragment nothing recognises (integ-x-1). So the text each side of the cut is kept
 * too (CUT_SLACK characters after the head, and the last of what was left out), and `kept` moves the cut off any
 * value it would fall in (output.ts clearCut), counting what that gives up as left out. Exported for its tests.
 */
export class OutputKeeper {
  private head = "";
  /** What the run printed right after the head, up to CUT_SLACK characters (kept or not). */
  private afterHead = "";
  /** The last CUT_SLACK characters left out before the tail. */
  private beforeTail = "";
  private tail: string[] = [];
  private tailLength = 0;
  private dropped = 0;
  private decoder = new TextDecoder("utf-8");
  bytes = 0;

  constructor(private tracker: SecretTracker) {}

  push(chunk: Uint8Array): void {
    this.bytes += chunk.length;
    this.add(this.decoder.decode(chunk, { stream: true }));
  }

  end(): void {
    this.add(this.decoder.decode());
  }

  private add(text: string): void {
    if (!text) return;
    this.tracker.output(text);
    if (this.head.length < HEAD_CHARS) {
      const take = HEAD_CHARS - this.head.length;
      this.head += text.slice(0, take);
      text = text.slice(take);
    }
    if (!text) return;
    if (this.afterHead.length < CUT_SLACK) this.afterHead += text.slice(0, CUT_SLACK - this.afterHead.length);
    this.tail.push(text);
    this.tailLength += text.length;
    if (this.tailLength > 2 * (KEEP_CHARS - HEAD_CHARS)) this.trim();
  }

  /** Cuts the tail to its last KEEP_CHARS - HEAD_CHARS characters, counting what goes. */
  private trim(): string {
    const room = KEEP_CHARS - HEAD_CHARS;
    let tail = this.tail.join("");
    if (tail.length > room) {
      const cut = tail.length - room;
      this.dropped += cut;
      this.beforeTail = cut >= CUT_SLACK ? tail.slice(cut - CUT_SLACK, cut) : (this.beforeTail + tail.slice(0, cut)).slice(-CUT_SLACK);
      tail = tail.slice(cut);
    }
    this.tail = [tail];
    this.tailLength = tail.length;
    return tail;
  }

  /** The text kept, with a note where the middle went, and `spans` (positions in everything printed) moved into it. */
  kept(spans: { from: number; to: number }[]): { text: string; spans: { from: number; to: number }[] } {
    return runSteps(this.keptSteps(spans));
  }

  /**
   * `kept` as steps, a step before each of the redactor's passes in the two cuts: a run's end gives Ember's main thread
   * back between them (merge review integ-y-2). `kept` runs the same steps at once.
   */
  *keptSteps(spans: { from: number; to: number }[]): Generator<void, { text: string; spans: { from: number; to: number }[] }, void> {
    let tail = this.trim();
    if (!this.dropped) return { text: this.head + tail, spans };
    // Neither end of what is left out may fall in a value the vault filled (integ-x-1): the head ends before one, the
    // tail starts after one, and a side with no such place is not kept at all.
    const lose = (yield* clearCutSteps(this.head.slice(-CUT_SLACK), this.afterHead, "before")) ?? this.head.length;
    // (What stands before the tail: the last of what was left out, with the head's end where less than that was.)
    const lead = this.dropped < CUT_SLACK ? (this.head + this.beforeTail).slice(-CUT_SLACK) : this.beforeTail;
    const skip = (yield* clearCutSteps(lead, tail.slice(0, CUT_SLACK), "after")) ?? tail.length;
    const head = lose ? this.head.slice(0, this.head.length - lose) : this.head;
    if (skip) tail = tail.slice(skip);
    const dropped = this.dropped + lose + skip;
    const h = head.length;
    const note = `\n[… ${dropped} characters of output left out …]\n`;
    const end = h + dropped;
    const from = (p: number) => (p < h ? p : p < end ? h : p - dropped + note.length);
    const to = (p: number) => (p <= h ? p : p < end ? h + note.length : p - dropped + note.length);
    return { text: head + note + tail, spans: spans.map(s => ({ from: from(s.from), to: to(s.to) })).filter(s => s.to > s.from) };
  }
}

/**
 * The text a run printed with its secret spans and the user's typed lines taken out, for the taint check, a whole-text
 * operation a step: each typed line's removal is a pass over up to 4 MiB, and a run keeps up to 1,000 of them, about
 * 0.8 s at once (stop-yield-y9-1).
 */
function* checkedTextSteps(text: string, spans: { from: number; to: number }[], typed: string[]): Generator<void, string, void> {
  let out = "";
  let at = 0;
  for (const s of [...spans].sort((a, b) => a.from - b.from)) {
    if (s.from > at) out += text.slice(at, s.from);
    at = Math.max(at, s.to);
  }
  out += text.slice(at);
  yield;
  for (const t of typed.map(l => l.trim()).filter(l => l.length >= 3)) {
    out = out.split(t).join(" ");
    yield;
  }
  out = out.replace(TERMINAL_CODES, "");
  yield;
  // Lines cut as cleanOutput cuts them: what is past that can't reach the model, and reading it costs main-thread time.
  return capLines(out);
}

/** A question with S0b's panel fields (confirm.ts §3.9.1): `where`, `armMs`, `panel`, `clickOnly`. */
type PanelQuestion = Question & {
  where?: string;
  armMs?: number;
  panel?: { kind: "command"; card: CommandCard } | { kind: "consent"; consent: ConsentPanel };
  clickOnly?: boolean;
};

/** Why every command asks on this target, from the flow's own view (§3.8.2 rules 1-8), for the guard below. */
interface AskReasons {
  words: string;
  privileged: boolean;
  os: OS;
  mode: CommandMode;
  askEvery: CommandCapability["askEvery"];
  userAskEvery: boolean;
  tainted: boolean;
  carried: { from: string[] } | null;
  /** The classification decided on, and the target's answer for its paths: its refusal and findings hold too. */
  cls?: Classification;
  paths?: ReadonlyMap<string, PathFact>;
}

/**
 * CL's decision held to the flow's invariants: the classification's refusal (D4.5) and the administrator's "off"
 * refuse; root, the administrator's or the user's "ask every", a tool-owned distro, taint and carried text make a
 * command that would run or announce ask; a finding the decision kept never runs unasked, and secrets, escapes and
 * unclear commands never announce (D4.4); an announcement needs the user's own words (critique security-1: a task
 * without them can only ask); and a verdict the flow doesn't know asks.
 */
export function heldDecision(d: CommandDecision, r: AskReasons, kind: TargetBinding["kind"]): CommandDecision {
  const refuse = r.cls?.refuse ?? null;
  if (refuse && d.verdict !== "refuse") return { ...d, verdict: "refuse", reason: refuse.says, rules: [...new Set([...d.rules, refuse.rule])], requested: undefined };
  if (d.verdict === "refuse") return d;
  if (r.mode === "off") {
    const where = kind === "local" ? "on this computer" : kind === "wsl" ? "in WSL" : "on computers reached over SSH";
    return { ...d, verdict: "refuse", reason: `Your organisation has turned off commands ${where}.`, requested: undefined };
  }
  if (d.verdict === "ask") return d;
  const ordinary = d.verdict === "run";
  const lines: string[] = [];
  let policyOnly = true;
  if (r.privileged) { lines.push(r.os === "win32" ? CARD_LINES.admin : CARD_LINES.root); policyOnly = false; }
  if (r.mode === "ask" || r.askEvery === "admin") lines.push(CARD_LINES.adminAsk);
  if (r.askEvery === "tool") lines.push(CARD_LINES.tool);
  else if (r.userAskEvery || r.askEvery === "user") lines.push(CARD_LINES.userAsk);
  if (r.askEvery === "root" && !r.privileged) { lines.push(r.os === "win32" ? CARD_LINES.admin : CARD_LINES.root); policyOnly = false; }
  if (r.tainted) { lines.push(CARD_LINES.tainted); policyOnly = false; }
  if (r.carried) { lines.push(CARD_LINES.carried(r.carried.from)); policyOnly = false; }
  // The findings that stand once the target said which overwritten paths don't exist (§3.8.2 rule 3).
  const left = standingFindings(r.cls?.findings ?? [], r.paths);
  const missed = (ordinary && left.length > 0)
    || (d.verdict === "announce" && [...d.classes, ...left.map(f => f.cls)].some(c => ALWAYS_ASK.has(c)))
    || (d.verdict !== "run" && d.verdict !== "announce");
  if (missed) {
    policyOnly = false;
    for (const f of left) if (f.says.trim() && !lines.includes(f.says)) lines.push(f.says);
  }
  const unrequested = d.verdict === "announce" && (!r.words.trim() || !d.requested);
  if (!lines.length && !unrequested && !missed) return d;
  return {
    ...d, verdict: "ask", requested: undefined,
    classes: [...new Set([...d.classes, ...left.map(f => f.cls)])],
    rules: [...new Set([...d.rules, ...left.map(f => f.rule)])],
    says: [...lines.filter(l => !d.says.includes(l)), ...d.says],
    unasked: d.unasked || !r.words.trim(),
    armMs: Math.max(d.armMs, ordinary && policyOnly && !unrequested ? 500 : 1500),
  };
}

/** The card's line, and the rule, of a command that may be one the user said no to earlier in the task (Refusals.commandLike). */
export const LIKE_REFUSED_LINE = "You said no to something like this earlier in this task.";
export const LIKE_REFUSED_RULE = "refused-like";

/** Words that turn a part of a request round: "do not push", "don't delete src", "never force", "everything except build". */
const SAYS_NOT = /(^|[^\p{L}\p{N}])(do\s+not|don['’]?t|does\s+not|doesn['’]?t|never|not|without|except|no|nothing|avoid)(?=$|[^\p{L}\p{N}])/giu;

/**
 * Words that hold a part of a request back without a "not": "leave the build folder alone", "keep build", "hold off on
 * publishing", "wait before pushing", "push later", "skip build", "leave it as it is for now" (modes-y9-4); by a time
 * or a condition ("push main next week", "on Monday", "in an hour", "after the review", "once CI is green", "when I
 * say so"); and by a keeping phrase ("build is off limits", "build must survive", "I still need build", "the push is
 * mine to do", "I'll do the push") (modes-y9-y9-7). It only ever keeps a question, so it errs wide.
 */
const HOLDS_BACK = /(^|[^\p{L}\p{N}])(leave|leaving|keep|keeping|preserve|spare|hold|holding|wait|waiting|not\s+yet|later|tomorrow|until|skip|skipping|untouched|stays?|staying|remains?|as\s+(it|they)\s+(is|are)|hands\s+off|stay\s+away|for\s+now|myself|by\s+hand|after|once|when|tonight|next\s+(week|month|year|time)|(on\s+)?(mon|tues|wednes|thurs|fri|satur|sun)day|in\s+(an?|\d+|a\s+few)\s+(minutes?|hours?|days?|weeks?)|off[\s-]+limits|surviv(e|es|ing)|still\s+need|mine|(i\s+will|i['’]ll)\s+do)(?=$|[^\p{L}\p{N}])/iu;
/**
 * Where one part of a request ends and the next begins. A full stop or a colon ends a part only before a space or at
 * the end: "notes.txt", "./build" and ".ssh" are one word each (modes-y9-x9-4).
 */
const PARTS = /[,;!?()\n]+|[.:]+(?=\s|$)|\s+(?:but|and|then|though|however)\s+/iu;
/** The card's line where the user's own words hold the command back (wordsRuleOut's HOLDS_BACK), in Autopilot. */
export const HELD_BACK_LINE = "Your words say to leave this or to wait, so Ember asks first.";

/**
 * Does this part of the user's words name what a finding acts on: a branch, a package, a service, or any part of a
 * path as the command writes it, up to its first wildcard (`~/Downloads/*` is in Downloads, `build/tmp` in build:
 * what lies in the folder they said to leave is theirs to leave too)?
 */
function namesObject(findings: readonly Finding[], part: string): boolean {
  // (A word with a dot in it whole, and in its pieces: "build.Keep src", typed without its space, still names build.)
  const said = new Set(part.toLowerCase().split(/[^\p{L}\p{N}._-]+/u).flatMap(w => [w.replace(/\.+$/, ""), ...w.split(".")]).filter(Boolean));
  return findings.some(f => f.objects.some(o => {
    const names = o.text.toLowerCase().split(/[\\/]+/).filter(Boolean);
    const cut = names.findIndex(n => /[*?[\]{}]/.test(n));
    return (cut < 0 ? names : names.slice(0, cut)).some(n => n.length >= 2 && n !== ".." && said.has(n));
  }));
}

/** Does a part of the user's words hold back what these findings act on, or the kind of step they are (HOLDS_BACK)? */
function wordsHoldBack(findings: readonly Finding[], words: string): boolean {
  return words.split(PARTS).some(part => HOLDS_BACK.test(part) && (namesObject(findings, part) || namedKind(findings, part) || mentioned(findings, part)));
}

/**
 * Do the user's own words rule out what these findings say the command does? What the card's "You didn't ask for
 * this." already reads (intent.ts ruledOut: a part that says not to names the kind of step and nothing else), and also
 * a step the words name only where they say not to ("do not push feature-x to GitHub yet": read without its "not" the
 * words name the push, read as said they don't), and a part that holds back what the command acts on or the kind of
 * step it is ("leave the build folder alone", "hold off on publishing": HOLDS_BACK), and words that name the step and
 * ask to be asked first, or that narrow a deletion or send it to the trash instead (intent.ts heldByWords). Autopilot
 * keeps the question for such a command: the user's no, said in advance. It only ever keeps a question, so a doubt
 * counts as ruled out.
 */
export function wordsRuleOut(findings: readonly Finding[], words: string): boolean {
  if (!words.trim() || findings.length === 0) return false;
  if (ruledOut(findings, words)) return true;
  if (!mentioned(findings, words) && mentioned(findings, words.replace(SAYS_NOT, "$1 "))) return true;
  // Their asking to be asked first, and a deletion they narrow or send to the trash or a stash instead (integ-x-3).
  return wordsHoldBack(findings, words) || heldByWords(findings, words);
}

/** A bare program name: no path, option, assignment or quoting. */
const BARE_PROGRAM = /^[A-Za-z_][\w.+-]*$/;
/** A word as a POSIX shell would take it back whole. */
const shellWord = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

/**
 * What a wrapper may hide where the classifier read its options wrongly (the brief's `sudo -h host printenv`: at this
 * commit `host` is taken for the program and the command behind it goes unjudged, so the decision says only that it
 * runs as an administrator, which Autopilot announces). For each POSIX command run behind a wrapper about whose own
 * program the classifier found nothing, every trailing part of its words that starts with a bare program name is
 * judged as a command of its own (`judge`: the classifier, which this only calls), and a finding there that would read
 * or print secrets or outlive the kill switch is returned, for Autopilot to keep the question. It can only add a
 * question (`sudo ls env` asks): never used to let anything through. A part that can't be judged counts as unclear.
 */
export function behindWrappers(cls: Pick<Classification, "commands" | "findings">, judge: (text: string) => readonly Pick<Finding, "cls" | "rule">[]): Pick<Finding, "cls" | "rule">[] {
  const out: Pick<Finding, "cls" | "rule">[] = [];
  cls.commands.forEach((c, k) => {
    if (c.family !== "posix" || c.wrappers.length === 0 || c.args.some(a => a === null)) return;
    // Judged already: a finding about the program itself, not only about the wrapper it runs behind.
    if (cls.findings.some(f => f.at === k && !c.wrappers.includes(f.program.split(" ")[0]))) return;
    const args = c.args as string[];
    for (let i = 0; i < Math.min(args.length, 16); i++) {
      if (!BARE_PROGRAM.test(args[i])) continue;
      try {
        for (const f of judge(args.slice(i).map(shellWord).join(" "))) {
          const why = askedOfFinding(f);
          if (why === "secret" || why === "outlives-stop") out.push({ cls: f.cls, rule: f.rule });
        }
      } catch {
        out.push({ cls: "unclear", rule: "unclear.behind-wrapper" }); // not judged: it asks
      }
    }
  });
  return out;
}

/**
 * "Work without asking" for a command (owner decision of 2026-11-02, PLAN.md §2 "Commands"): an ordinary command whose
 * only reason to ask is that it carries text read elsewhere in the task (rule "carried", no finding), in a task with the
 * user's own words that nothing steered, announces with its Stop countdown instead, saying where the text came from.
 * Anything the classifier flags (deleting, publishing, secrets, system changes, download-and-run, unclear), root, the
 * administrator's or the user's "ask every", taint and another computer named still ask. Null: it asks as decided.
 */
export function autonomousCommand(d: CommandDecision, o: { scopes: AutonomyScopes | null; words: string; tainted: boolean; carried: { from: string[] } | null; elsewhere: boolean; kind: TargetBinding["kind"] }): CommandDecision | null {
  // This computer only for now: WSL and SSH commands ask as before (security review of #127).
  if (o.kind !== "local") return null;
  if (d.verdict !== "ask" || !covers(o.scopes, ["commands", "crossWindow"]) || o.tainted || o.elsewhere || !o.carried || !o.words.trim()) return null;
  if (d.classes.length || d.rules.length !== 1 || d.rules[0] !== "carried") return null;
  const from = o.carried.from.length ? listOf(o.carried.from.slice(0, 3)) : "another window";
  return {
    ...d, verdict: "announce", unasked: false, rules: ["carried", "autonomy"],
    requested: { intent: "autonomy", announce: `Running a command with text from ${from}, without asking as you let me.` },
    reason: "Working without asking: an ordinary command that carries text read elsewhere in the task.",
  };
}

/** The result the model gets for how a run ended (§3.8.6). */
function resultOf(exit: RunExit, shaped: string, o: { label: string; timeoutS: number; redact: (s: string) => string }): ToolResultObject {
  switch (exit.ended) {
    case "exit":
      if (exit.code === 0) return done(shaped);
      return fail(`It ended with ${exit.code !== null ? `exit code ${exit.code}` : exit.signal ? `signal ${exit.signal}` : "no exit code"}.\n${shaped}`);
    case "stopped-user":
      return fail(`The user stopped it after ${seconds(exit.ms)} s. Don't run it again unless they ask.\n${shaped}`);
    case "stopped-task":
    case "killswitch":
      return STOPPED();
    case "timeout":
      return fail(`It took longer than ${o.timeoutS} s and was stopped.\n${shaped}`);
    case "lost":
      return fail(`The connection to ${o.label} dropped and the command was stopped there. What it already did stays.`);
    case "failed-to-start":
      return fail(`It couldn't start: ${o.redact(redactedWhole(exit.error ?? "an unknown error")).replace(/</g, "‹").replace(/[.\s]+$/, "").slice(0, 300)}.`);
    case "refused-remote":
      return denied(`${o.label} refused it: ${forModel(o.redact(exit.error ?? "no reason given"))}. Don't try another way; tell the user in finish_task.`);
  }
}

/** The extra rule ids a remote's needs_confirm carried (SC puts them on the run's end as `rules`). */
const remoteRules = (exit: RunExit) => {
  const r = (exit as RunExit & { rules?: unknown }).rules;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string").slice(0, 32) : [];
};

/** Runs one run_command call to the end; returns the tool result (done, denied or fail). */
export async function runCommandTool(a: RunCommandArgs, ctx: CommandFlowContext): Promise<ToolResultObject> {
  if (ctx.isOver()) return STOPPED();
  const binding = ctx.service.binding;
  const place = placeName(binding);
  // Step 1: a model that lost track of where it is never runs a command on the wrong computer.
  if (typeof a.target !== "string" || !namesTarget(a.target, binding)) return fail(`This task runs on ${place}; run_command can only run there.`);
  if (a.command.includes("\0")) return fail("The command can't hold a NUL character.");
  if (a.cwd !== undefined && /[\0\r\n]/.test(a.cwd)) return fail("The folder can't hold a NUL character or a line break.");
  if (ctx.state.running) return fail("This task's last command is still running: wait for its result.");
  ctx.state.running = true;
  // "Starting Ubuntu…" while the facts boot a stopped distro, before the run has a tab (§3.8.3 step 3).
  const endPending = followPending(ctx.service, ctx.task.id);
  const pending = pendingCommand(binding.id, ctx.signal);
  const current = { ...ctx, signal: pending.signal, isOver: () => ctx.isOver() || pending.signal.aborted };
  try {
    return await flow(a, current, endPending, pending);
  } finally {
    pending.dispose();
    endPending();
    ctx.state.running = false;
  }
}

async function flow(a: RunCommandArgs, ctx: CommandFlowContext, endPending: () => void, pending: ReturnType<typeof pendingCommand>): Promise<ToolResultObject> {
  const svc = ctx.service;
  const binding = svc.binding;
  const place = placeName(binding);
  // The user's words also name another computer Ember knows ("build-01 delete build/" bound to the active one): no
  // command announces, and every question says where it runs, this computer included (DOC's review). Read again with
  // the words the decision reads (a steer may have come meanwhile).
  let others = othersNamedIn(svc, ctx.task.commandWords());
  let places = placesNamedIn(svc, ctx.task.commandWords(), binding, others);
  const here = whereWords(binding) ?? `on ${place}`;
  let where = whereWords(binding) ?? (others.length || places.length ? here : undefined);
  const task = ctx.task.id;
  const target = binding.id;
  const audit = (e: Record<string, unknown>) => ctx.audit({ event: "command", task, target, ...e });
  const j = judge;

  // Step 2: the target's commands now; the first-use card when they wait for it.
  let cap = svc.capability();
  if (cap.state === "needs-consent") {
    // The card the user already said no to in this task (or left unanswered) isn't put up again for every command.
    const stood = ctx.refusals?.commandsConsent ?? null;
    if (stood) {
      audit({ phase: "decided", commandChars: a.command.length, verdict: "refuse", classes: [], rules: [stood === "refused" ? "refused-before" : "unanswered-before"],
        reason: stood === "refused" ? "The user said no to turning on commands here earlier in this task." : "The question about turning on commands here went unanswered, and the user hasn't said anything to this task since." });
      return denied(stood === "refused"
        ? `The user already said no to turning on commands on ${place} in this task, so Ember didn't ask again. Finish the task saying so.`
        : `Ember already asked the user to turn on commands on ${place} and the question went unanswered; they haven't said anything to this task since, so Ember didn't ask again. Finish the task now, saying that the question went unanswered.`);
    }
    const consent = (svc as CommandService & Partial<CommandConsentSource>).consentPanel?.() ?? null;
    if (!consent) return denied(`Commands aren't turned on for ${place} yet: the user can turn them on in Ember's settings, under Commands. Finish the task saying so.`);
    const q: PanelQuestion = {
      title: `Turn on commands on ${place}?`, context: ctx.task.title, ...ownTaskLine(ctx, false), prompt: "Ember needs your OK first. Read what it means in the window that opened.",
      options: [{ id: "once", label: "Turn on", primary: true }, { id: "deny", label: "Not now" }],
      task, ...(where ? { where } : {}), panel: { kind: "consent", consent }, clickOnly: true,
    };
    const answer = await ctx.confirmer.ask(q, ctx.signal);
    audit({ phase: "answered", answer: ctx.isOver() ? "stopped" : answer ?? "expired", q: "consent" });
    if (ctx.isOver()) return STOPPED();
    if (answer !== "once") {
      ctx.onDeclined?.(answer === null);
      ctx.refusals?.noteConsent(answer === null ? "waiting" : "refused");
      return denied(`The user didn't turn on commands on ${place}. Finish the task saying so.`);
    }
    svc.consented();
    cap = svc.capability();
  }
  if (cap.state !== "on") return denied(`${cap.why ?? `Commands are off on ${place}.`} Don't try another way; tell the user in finish_task.`);

  // Step 3: what the target is, its shell and the folder.
  const facts = await factsOf(ctx);
  if (ctx.isOver()) return STOPPED();
  if (!facts) return fail(`${place} didn't say what it can run commands with in time. Try again in a moment, or finish the task saying so.`);
  // cmd is never a run_command shell (L3: it runs only inside PowerShell's `cmd /c`); a shell Ember doesn't know isn't one.
  const shells: ShellId[] = facts.shells.filter(s => RUN_SHELLS.has(s));
  const shell = a.shell ?? shells[0];
  if (!shell || !shells.includes(shell)) return fail(`${shell ?? "That shell"} isn't available on ${place}. Shells here: ${shells.join(", ") || "none"}.`);
  const home = facts.home;
  const base = ctx.state.cwd ?? home;
  const cwd = a.cwd === undefined ? base : j.resolveTargetPath(a.cwd, { os: facts.os, home, cwd: base });
  if (a.cwd !== undefined && cwd !== base) {
    const [f] = await inspect(svc.runner, [cwd], base);
    if (ctx.isOver()) return STOPPED();
    if (f.exists === false) return fail(`There's no folder ${cwd} on ${place}.`);
  }

  // Step 4: pass 1. Ember's own pids are read now (they change as helpers restart): on this computer, and in WSL, whose
  // commands reach this computer's processes too (taskkill.exe, Stop-Process through interop); a remote's are its own.
  const ember = { ...facts.ember, pids: binding.kind !== "ssh" ? [...new Set([...facts.ember.pids, ...ctx.emberPids()])] : facts.ember.pids };
  const cctx: ClassifyContext = {
    os: facts.os, home, cwd, ember, downloaded: ctx.state.downloaded,
    ...(facts.wsl ? { wsl: { mountRoot: facts.wsl.mountRoot, windows: facts.wsl.windows } } : {}),
  };
  let cls = j.classifyCommand(a.command, shell, cctx);
  if (cls.cdOnly !== undefined && !cls.refuse) {
    if (ctx.projectFolderCurrent) return fail("Use Choose command folder to change the starting folder.");
    const to = j.resolveTargetPath(cls.cdOnly, { os: facts.os, home, cwd });
    const [f] = await inspect(svc.runner, [to], cwd);
    if (ctx.isOver()) return STOPPED();
    if (f.exists === false) return fail(`There's no folder ${to} on ${place}.`);
    ctx.state.cwd = to;
    audit({ phase: "cd", cwd: to });
    return done(`The task's folder on ${place} is now ${to}.`);
  }

  // Step 5: what the target says about each path; pass 2 when a real path differs from its lexical form.
  const probe = cls.probe.slice(0, 64);
  const found = await inspect(svc.runner, probe, cwd);
  if (ctx.isOver()) return STOPPED();
  const paths = new Map<string, PathFact>(probe.map((p, i) => [p, found[i]]));
  const real = new Map<string, string>();
  probe.forEach((p, i) => { const r = found[i].real; if (r !== null && r !== p) real.set(p, r); });
  if (real.size) cls = j.classifyCommand(a.command, shell, { ...cctx, real });
  // An sh or bash `if` asks only for what its commands do, as in a script; a loop asks as on main (commands-remote-2, c7-1).
  cls = withoutReadFlow(cls, shell);

  // Step 6: the branch facts a push's announcement needs.
  const git: GitFacts | null = cls.needsGit ? await within(svc.runner.gitFacts(cwd), PROBE_MS, null) : null;
  if (ctx.isOver()) return STOPPED();

  // Step 6b (L8, the lead's ruling): a shell script the command runs (`sh x.sh`, `./x.sh`, `cmd x.bat`, `powershell
  // -File x.ps1`) is read from the target and its text classified as a nested command, so a dangerous script asks and
  // a refusal refuses. Unreadable, too big or not a shell script leaves today's behaviour, unless the task itself wrote
  // or downloaded it (the padding bypass): then it asks.
  cls = await judgeScripts(cls, scriptIo(svc.runner), (text, sh, c) => j.classifyCommand(text, sh, c), {
    os: facts.os, home, ember, wsl: facts.wsl, downloaded: ctx.state.downloaded, written: ctx.state.written ?? null, paths, isOver: () => ctx.isOver(),
  });
  if (ctx.isOver()) return STOPPED();

  // Steps 7-8: text carried from elsewhere, then the decision on the user's own words only.
  const words = ctx.task.commandWords();
  others = [...new Set([...others, ...othersNamedIn(svc, words)])].slice(0, 5);
  places = [...new Set([...places, ...placesNamedIn(svc, words, binding, others)])].slice(0, 5);
  if (places.length) {
    places = await notLocalPlaces(places, words, { runner: svc.runner, cwd, git, at: p => j.resolveTargetPath(p, { os: facts.os, home, cwd }), isOver: () => ctx.isOver() });
    if (ctx.isOver()) return STOPPED();
  }
  where = whereWords(binding) ?? (others.length || places.length ? here : undefined);
  const tainted = ctx.task.tainted();
  // A line judged as its written-out form (unroll.ts) carries what that form holds too.
  const judged = SHELL_FAMILY[shell] === "posix" ? judgedText(a.command) : a.command;
  const carried = carriedText(judged === a.command ? a.command : `${a.command}\n${judged}`, ctx.task.readFrom(), words, binding.shellOs);
  const mode = svc.mode();
  const userAskEvery = !!ctx.projectFolderCurrent || svc.userAskEvery();
  const decided = j.decideCommand({ cls, paths, git, binding, facts, mode, userAskEvery, userWords: words, agreed: ctx.task.agreed(), tainted, carried });
  const held = heldDecision(decided, { words, privileged: facts.privileged, os: facts.os, mode, askEvery: cap.askEvery, userAskEvery, tainted, carried, cls, paths }, binding.kind);
  // Taint that came from a command's own output says so on the card (§3.8.4's output-taint wording).
  let d = ctx.state.outputTainted ? { ...held, says: held.says.map(l => (l === LINES.tainted ? OUTPUT_TAINT_LINE : l)) } : held;
  // D4.4's wrong-target guard: a command the user's words asked for still asks when they also name another computer,
  // or a place that looks like a computer Ember doesn't know ("delete build/ on prod-db", the lead's ruling), and every
  // card of such a task (asking for any reason) says first which computer runs it.
  if (d.verdict === "announce" && (others.length || places.length)) {
    d = {
      ...d, verdict: "ask", requested: undefined, rules: [...new Set([...d.rules, ...(others.length ? ["wrong-target"] : []), ...(places.length ? ["unknown-place"] : [])])],
      reason: others.length ? "It asks first: the user's words also name another computer." : "It asks first: the user's words name a computer Ember doesn't know.",
      armMs: Math.max(d.armMs, 1500),
    };
  }
  // Words heard where Ember can't tell the user from its speakers didn't count (OWNER V1): when they named it, the card
  // says so instead of "You didn't ask for this."
  const spoken = ctx.task.spokenWords?.() ?? "";
  if (d.verdict === "ask" && d.unasked && spoken.trim() && !ruledOut(cls.findings, spoken) && (mentioned(cls.findings, spoken) || namedKind(cls.findings, spoken))) {
    const says = d.says.includes(LINES.unasked) ? d.says.map(l => (l === LINES.unasked ? SPOKEN_LINE : l)) : [...d.says];
    if (!says.includes(SPOKEN_LINE)) says.splice(says.includes(LINES.windows) ? says.indexOf(LINES.windows) : says.length, 0, SPOKEN_LINE);
    d = { ...d, unasked: false, says };
  }
  if (d.verdict === "ask" && (others.length || places.length)) {
    const lines = [...(places.length ? [unknownPlaceLine(places, here)] : []), ...(others.length ? [wrongTargetLine(others, here)] : [])];
    d = { ...d, says: [...lines, ...d.says.filter(l => !lines.includes(l))] };
  }
  // A download-and-run handed a key, credentials or a token (`npx -y tool ~/.ssh/id_rsa`): the classifier says only that
  // it downloads and runs code, so the question says the rest, and no mode announces or clears it (modes-y9-5).
  // One pointed at Ember's own settings, record or programs is refused, as any command that touches them is: the
  // classifier's own refusal of that word, read as a file (modes-y9-y9-9: Autopilot announced `npx -y json -I -f
  // ~/.config/ember/settings.json …`).
  if (d.verdict === "ask" || d.verdict === "announce") {
    let tampers: Classification["refuse"] | null = null;
    const handed = handedSecrets(cls, a.command, shell, text => { const c = j.classifyCommand(text, shell, cctx); tampers ??= c.refuse ?? null; return c.findings; });
    const refuse = tampers as Classification["refuse"] | null;
    if (refuse) d = { ...d, verdict: "refuse", reason: refuse.says, rules: [...new Set([...d.rules, refuse.rule])], requested: undefined };
    else if (handed.length && d.verdict === "ask") {
      d = {
        ...d, classes: [...new Set(["secret" as const, ...d.classes])], rules: [...new Set([...d.rules, ...handed.map(f => f.rule)])],
        says: [...handed.map(f => f.says).filter(l => !d.says.includes(l)), ...d.says],
      };
    }
  }
  // A command the user already said no to in this task, sent again or reworded (the same danger to the same thing), or
  // one whose card nobody answered and they haven't spoken since: never asked about again, reviewed or announced,
  // whatever the mode would do with it now (CLAUDE.md "After a deny or “Not now”…"; commands-remote-r9-8). Ember's own
  // refusal (tampering, the organisation's "off") is said as itself.
  const sha256 = commandSha256(target, shell, cwd, a.command);
  const stand = standingFindings(cls.findings, paths);
  const about: CommandAsked = { sha256, cwd, command: a.command, acts: commandActs(stand, facts.os), named: commandNamed(stand, cls.commands), os: facts.os, home };
  const stood = d.verdict === "refuse" ? null : ctx.refusals?.command(about) ?? null;
  if (stood) {
    endPending();
    audit({
      phase: "decided", shell, cwd, commandChars: a.command.length, verdict: "refuse", classes: d.classes, rules: [...d.rules, stood === "refused" ? "refused-before" : "unanswered-before"],
      reason: stood === "refused" ? "The user said no to this command, or to one that does the same, earlier in this task."
        : "The question about this command, or one that does the same, went unanswered, and the user hasn't said anything to this task since.",
    });
    ctx.log.info("commands.decided", { task, target, verdict: "refuse", classes: d.classes, chars: a.command.length, stood });
    return denied(stood === "refused" ? REFUSED_BEFORE : STILL_UNANSWERED);
  }
  // A command that may be something the user said no to in this task, though it isn't recognisably the same: one with
  // a danger of a class the refused command had, whatever either names (a push by the remote's URL after a refused
  // push by its name: modes-y9-y9-1), any danger after a refused command Ember couldn't read (modes-y9-y9-2), one
  // Ember can't read at all; and a deletion or a push by command after a no to that kind of step in an app. It asks,
  // in every mode: never announced (by the user's earlier words, Interactive or Autopilot) and never shown to
  // Assisted's check. The user's yes is theirs to give (modes-y9-9, y9-2).
  const like = d.verdict !== "refuse" && d.verdict !== "run" && (ctx.refusals?.commandLike(about) ?? false);
  if (like) {
    d = {
      ...d, verdict: "ask", requested: undefined, rules: [...new Set([...d.rules, LIKE_REFUSED_RULE])], says: [LIKE_REFUSED_LINE, ...d.says.filter(l => l !== LIKE_REFUSED_LINE)],
      reason: d.verdict === "ask" ? d.reason : "It asks first: the user said no to something like this earlier in this task.", armMs: Math.max(d.armMs, 1500),
    };
  }
  // "Work without asking": an ordinary command that asks only for the text it carries announces instead (its Stop
  // countdown and the card still show where the text came from).
  const autonomous = like ? null : autonomousCommand(d, { scopes: ctx.autonomy?.() ?? null, words, tainted: tainted || !!ctx.state.outputTainted, carried, elsewhere: others.length > 0 || places.length > 0, kind: binding.kind });
  if (autonomous) d = autonomous;
  // Autopilot: a command that still asks is announced with its Stop countdown instead, whatever the task was held to
  // asking for (steered, off-task, the user said no: the refused command itself was refused above), as an
  // administrator too. Only a command that would read or print secrets, keep running after Stop or do something Ember
  // can't tell, one the user's own words rule out, and what the organisation's or the user's own "ask every command"
  // requires, still ask (autopilot.ts).
  // What a wrapper may hide where the classifier read its options wrongly: judged apart, to keep a question only, for
  // Autopilot and for Assisted's check alike (one predicate reads both: autopilot.ts keptQuestion).
  const hidden = d.verdict === "ask" && (ctx.autopilot?.() || ctx.review) ? behindWrappers(cls, text => j.classifyCommand(text, shell, cctx).findings) : [];
  if (ctx.autopilot?.() && d.verdict === "ask" && !like) {
    // (Their own words against it count wherever they were heard: where Ember can't tell the user from its speakers too.)
    const standing = standingFindings(cls.findings, paths);
    // A line judged as its written-out form (a `[[ … ]]` test read as `[ … ]`: unroll.ts) never announces, here either:
    // what it does behind the test is Ember's reading of it, so it counts as a command it can't tell (commands-b7-2).
    if ((cls as { writtenOut?: boolean }).writtenOut === true) hidden.push({ cls: "unclear", rule: "unclear.written-out" });
    const auto = autopilotCommand(d, { findings: [...cls.findings, ...hidden], mode, askEvery: cap.askEvery, userAskEvery, ruledOut: wordsRuleOut(standing, words) || wordsRuleOut(standing, spoken) });
    if (auto) d = auto;
    // The card says why it still asks where their words held it back: after "You didn't ask for this." (which the
    // card keeps), and in place of "your words don't name exactly this", a doubt of Ember's (modes-y9-x9-6).
    else if (wordsHoldBack(standing, words) || wordsHoldBack(standing, spoken)) {
      const at = d.says.findIndex(l => l === LINES.unasked || l === LINES.inexact || l === LINES.windows);
      const [keep, drop] = at < 0 ? [d.says.length, 0] : d.says[at] === LINES.unasked ? [at + 1, 0] : d.says[at] === LINES.inexact ? [at, 1] : [at, 0];
      d = { ...d, says: [...d.says.slice(0, keep), HELD_BACK_LINE, ...d.says.slice(keep + drop)] };
    }
  }
  // Assisted's check: a command that asks is shown to the reviewer with the user's own words and what the rules found
  // (the card's lines: an administrator's command, a steered task, carried text and another computer named say so
  // there); one it finds in those words runs with its announcement (Stop countdown) instead. A command that would read
  // or print secrets or keep running after Stop, and what the organisation's or the user's own "ask every command"
  // requires, are never reviewed (review.ts). The task's bubble says it is checking; a Stop doesn't wait for the answer.
  if (ctx.review && d.verdict === "ask" && !like) {
    const checkWords = ctx.task.checkWords?.() ?? words;
    const blocked = notReviewable(d, { words: checkWords, mode, askEvery: cap.askEvery, userAskEvery, command: a.command, findings: [...cls.findings, ...hidden] });
    if (blocked === null) {
      const t0 = performance.now();
      try { ctx.presenter.progress(CHECKING_COMMAND); } catch (err) { ctx.log.warn("commands.checking_not_said", { err }); }
      const asked = Promise.resolve().then(() => ctx.review!({
        userWords: checkWords, command: a.command, shell, cwd, where: binding.label || place, os: facts.os, why: a.why, findings: d.says,
      }, ctx.signal)).catch(() => null);
      let stop!: () => void;
      const stopped = new Promise<null>(resolve => { stop = () => resolve(null); ctx.signal.addEventListener("abort", stop, { once: true }); });
      const v = await Promise.race([asked, stopped]).finally(() => ctx.signal.removeEventListener("abort", stop));
      if (ctx.isOver()) return STOPPED();
      ctx.log.info("commands.reviewed", { task, target, verdict: v ? (v.run ? "run" : "ask") : "none", ms: Math.round(performance.now() - t0) });
      if (v?.run) d = reviewedDecision(d, v);
      else if (v?.why) d = { ...d, says: [...d.says, `Ember's review: ${v.why.replace(/[.\s]+$/, "")}.`] };
    }
  }
  // The checks are done: a boot from here on happens in the run, whose tab shows it (followStatus).
  endPending();
  const refused = d.verdict === "refuse";
  audit({
    phase: "decided", shell, cwd, ...(refused ? {} : { command: j.redactSecrets(a.command).slice(0, AUDIT_COMMAND_CHARS) }), commandChars: a.command.length,
    verdict: d.verdict, classes: d.classes, rules: d.rules, ...(d.requested ? { requested: "user", intent: d.requested.intent } : {}), reason: d.reason,
    ...(d.requested?.intent === AUTOPILOT_RULE ? { mode: "autopilot" } : {}),
    ...(d.review ? { review: d.review } : {}),
  });
  ctx.log.info("commands.decided", { task, target, verdict: d.verdict, classes: d.classes, chars: a.command.length });

  // Step 9.
  if (refused) return denied(`Not allowed: ${d.reason} Don't try another way; tell the user in finish_task.`);

  let runId = newRunId();
  const why = `Why: ${shownQuote(a.why, 200)}`;
  const card = (cardMode: CommandCard["mode"], says: string[]): CommandCard => ({
    runId, target, targetLabel: binding.label, ...(binding.login ? { login: binding.login } : {}), shell, cwd, command: a.command, sha256, taskId: task,
    taskTitle: ctx.task.title, mode: cardMode, says, unasked: cardMode === "ask" && d.unasked, armMs: d.armMs,
    ...(cardMode !== "run" && d.classes.length ? { classes: d.classes } : {}),
    ...(cardMode === "announce" && d.requested?.intent === "ai-review" ? { reviewed: true } : {}),
    // The header says the home folder as ~ in a POSIX shell (commands-remote-8).
    ...(shell !== "powershell" && home ? { home } : {}),
  });
  /** Asks with the command card; "once", "no" (Not now), "expired" (no answer in time: a timeout, not a refusal) or "stopped". */
  const askCard = async (says: string[], q: string, prompt = `On ${place}: ${firstLine(says)}`): Promise<"once" | "no" | "expired" | "stopped"> => {
    const question: PanelQuestion = {
      title: "May I run a command?", context: ctx.task.title, ...ownTaskLine(ctx, d.unasked), prompt,
      options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }],
      task, ...(where ? { where } : {}), armMs: d.armMs, panel: { kind: "command", card: card("ask", [...says, why]) },
      // A dangerous command (deleting, publishing, secrets, system changes…: the classifier's classes) looks risky.
      ...(d.classes.length > 0 ? { risky: true } : {}),
      ...(ctx.projectFolderCurrent ? { clickOnly: true } : {}),
    };
    const answer = await ctx.confirmer.ask(question, ctx.signal);
    const how = ctx.confirmer.howAnswered?.(question);
    audit({ phase: "answered", answer: ctx.isOver() ? "stopped" : answer ?? "expired", q, ...(how?.via === "voice" ? { via: "voice", verified: how.verified === true, ...(how.trust ? { trust: how.trust } : {}) } : {}) });
    if (ctx.isOver()) return "stopped";
    if (answer === "once") return "once";
    ctx.onDeclined?.(answer === null);
    // Kept for the task: the same command, or one that does the same, isn't asked about again (Refusals).
    ctx.refusals?.noteCommand(about, answer === null ? "waiting" : "refused");
    return answer === null ? "expired" : "no";
  };

  // Step 10: the card.
  let approvedAt: number | null = null;
  if (d.verdict === "ask") {
    const answer = await askCard(d.says, "card");
    if (answer === "stopped") return STOPPED();
    if (answer === "expired") return denied(TIMED_OUT);
    if (answer === "no") return denied(SAID_NO);
    approvedAt = performance.now();
  }

  // A run slot on this target (MAX_RUNS_PER_TARGET), taken before an announcement: its countdown ends in the run, not
  // in a wait for another task's command to end.
  const timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(1, Math.round(a.timeoutSeconds ?? DEFAULT_TIMEOUT_S)));
  const release = await slotOn(svc.runner, ctx.signal);
  if (!release) return STOPPED();
  /**
   * An announcement with its Stop window (D4.4): `words` in the task's bubble, `says` on the card that counts down in
   * the command window. True once it ran out unstopped; otherwise the result that ends this call.
   */
  const countdown = async (words: string, says: string[]): Promise<true | ToolResultObject> => {
    const stopId = `ui:cmdstop:${runId}`;
    const ms = announceTime(svc.window);
    ctx.presenter.announce(words, stopId, ms);
    let go = false;
    try {
      go = await svc.window.announce(card("announce", [...says, why]), ms, ctx.signal);
    } catch (err) {
      ctx.log.warn("commands.announce_failed", { task, err });
    } finally {
      ctx.presenter.endAnnouncement(stopId);
    }
    if (ctx.isOver()) return STOPPED();
    if (go) return true;
    // Its page crashed or the window closed during the countdown: the user didn't stop it (cross-review S2).
    const unshown = announceGone(svc.window, runId);
    audit({ phase: "answered", answer: unshown ? "unseen" : "deny", q: "announce" });
    // The user stopped it: a no, which holds the task to asking from now on (Work without asking too; review of #127).
    if (!unshown) { ctx.onDeclined?.(); ctx.refusals?.noteCommand(about, "refused"); }
    return denied(unshown ? UNSHOWN_BEFORE : STOPPED_BEFORE);
  };
  // When Autopilot's announcement of this command last ran out unstopped (a remote's gate 2 hears of it on the stamp,
  // never as a yes); null: none.
  let announcedAt: number | null = null;
  try {
    // Step 11.
    if (d.verdict === "announce" && d.requested) {
      const went = await countdown(d.requested.announce, d.says);
      if (went !== true) return went;
      if (d.requested.intent === AUTOPILOT_RULE) announcedAt = performance.now();
    }

    // Steps 12-14: run (a remote's own check may ask once more), then shape what it printed.
    let rules = d.rules;
    let asked = false;
    let toldRemote = false;
    for (;;) {
      // Every await above can outlive consent or a switch change. Fail closed on tightening; a new request
      // gets a new decision/card rather than treating an old announcement as approval.
      if (ctx.isOver()) return STOPPED();
      let live: CommandCapability;
      try { live = svc.capability(); } catch { return denied("Couldn't check whether commands are still allowed. Finish the task saying so."); }
      if (live.state !== "on") return denied(`${live.why ?? `Commands are off on ${place}.`} Don't try another way; tell the user in finish_task.`);
      if (svc.binding.id !== target || svc.runner.target !== target) return denied("The command's computer changed. Finish the task saying so.");
      // (Autopilot's announcement stands while Autopilot does: there root alone is no reason to ask, as when it was decided.)
      const everyAsks = announcedAt !== null
        ? !ctx.autopilot?.() || (live.askEvery !== null && live.askEvery !== "root")
        : live.askEvery !== null;
      if (svc.mode() === "off" || (approvedAt === null && (everyAsks || svc.userAskEvery() || svc.mode() === "ask"))) {
        return denied("Command permissions changed while this command was waiting. It did not run. Ask the user for a new request.");
      }
      if (ctx.projectFolderCurrent && !ctx.projectFolderCurrent()) return denied("The chosen command folder changed. Choose it again.");
      const run = await runOnce(ctx, j, {
        runId, shell, cwd, command: a.command, timeoutS, card: card("run", d.verdict === "run" ? [] : [...d.says, why]),
        stamp: { taskId: task, sha256, verdict: d.verdict === "announce" ? "announce" : d.verdict === "ask" ? "ask" : "run", classes: d.classes, rules, approvedAt, announcedAt },
      }, pending.started);
      if (run === "stopped") { noteDownloads(ctx, cls); return STOPPED(); }
      if (run === "unseen") { noteDownloads(ctx, cls); return fail(UNSEEN); }
      const { exit } = run;
      // The remote's gate 2 refused the run before it started: its end is audited here (the error is sized in the journal).
      if (exit.ended === "refused-remote") {
        audit({ phase: "ended", runId, ended: exit.ended, code: null, signal: null, ms: exit.ms, needsConfirm: exit.needsConfirm === true, error: j.redactSecrets(exit.error ?? "") });
      }
      if (exit.ended === "refused-remote" && exit.needsConfirm && !asked) {
        // Gate 2 found more than the PC did: the user sees its own lines, quoted, and says yes once more or not.
        pending.waiting();
        if (ctx.isOver()) { reaskEnded(svc, runId, "stopped"); return STOPPED(); }
        const theirs = (exit.remoteSays ?? []).filter(l => typeof l === "string").slice(0, 10).map(l => shownQuote(l));
        // In the card's order (§3.8.4): the remote's own lines come before "You didn't ask for this." and the Windows line.
        const own = [`${binding.label}'s own check also found:`, ...theirs];
        const at = d.says.findIndex(l => l === LINES.unasked || l === LINES.inexact || l === LINES.windows);
        const lines = at < 0 ? [...d.says, ...own] : [...d.says.slice(0, at), ...own, ...d.says.slice(at)];
        // Autopilot: the remote's own question is announced instead of asked, once, with its lines on a countdown of its
        // own. Never where its rules say the command would read or print secrets, outlive Stop or can't be told, or
        // where every command asks there: those go to the card below, as does whatever the remote still wants a yes for
        // after the announcement (its own administrator's policy holds as the organisation's).
        const extra = remoteRules(exit);
        if (!toldRemote && ctx.autopilot?.() && svc.mode() !== "ask" && !svc.userAskEvery() && extra.every(r => askedOfFinding({ rule: r }) === null)) {
          toldRemote = true;
          let went: true | ToolResultObject | null = null;
          try {
            went = await countdown(`Running a command that ${binding.label}'s own check asked about, ${AUTOPILOT_WORDS}`, [...lines.filter(l => l !== AUTOPILOT_LINE), AUTOPILOT_LINE]);
          } finally {
            // No run is coming for this tab: it says so instead of waiting for one.
            if (went !== true) reaskEnded(svc, runId, ctx.isOver() ? "stopped" : "no");
          }
          if (went !== true) return went;
          audit({ phase: "answered", answer: "announced", q: "remote", mode: "autopilot" });
          announcedAt = performance.now();
          rules = [...new Set([...rules, ...extra])];
          runId = newRunId();
          continue;
        }
        asked = true;
        let answer: "once" | "no" | "expired" | "stopped" = "stopped";
        try {
          answer = await askCard(lines, "remote",
            `On ${place}: ${d.says.length ? firstLine(d.says) : `${binding.label}'s own check wants your OK first.`}`);
        } finally {
          // No OK is coming: the sent-back run's tab says so instead of waiting for one (review #274).
          if (answer !== "once") reaskEnded(svc, runId, answer);
        }
        if (answer === "stopped") return STOPPED();
        if (answer === "expired") return denied(TIMED_OUT);
        if (answer === "no") return denied(SAID_NO);
        approvedAt = performance.now();
        rules = [...new Set([...rules, ...remoteRules(exit)])];
        // A new run (its own id and tab); the approval is bound to the same bytes, folder, shell and computer.
        runId = newRunId();
        continue;
      }
      if (exit.ended === "lost") factsCache.delete(ctx.state);
      // The retry sent back too: that is the remote's refusal, and its tab says so (review #274).
      if (exit.ended === "refused-remote" && exit.needsConfirm) reaskEnded(svc, runId, "refused");
      if (exit.ended === "refused-remote") return resultOf(exit, "", { label: binding.label, timeoutS, redact: j.redactSecrets });
      return await finishRun(ctx, j, run, { cls, label: binding.label, shell, timeoutS, runId });
    }
  } finally {
    release();
  }
}

/**
 * The size the command window says fits a new run's tab (UI's termSize), so the program draws for the terminal it is
 * shown in; null when the window doesn't say (the worker's own size then).
 */
function windowSize(w: CommandService["window"]): { cols: number; rows: number } | null {
  const termSize = (w as CommandService["window"] & { termSize?: () => unknown }).termSize;
  if (typeof termSize !== "function") return null;
  try {
    const got = termSize.call(w) as { cols?: unknown; rows?: unknown } | null;
    const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 1000;
    return got && ok(got.cols) && ok(got.rows) ? { cols: got.cols, rows: got.rows } : null;
  } catch {
    return null; // a window that can't say: the worker's size
  }
}

/** One started run and what it printed. */
interface RunOutcome { exit: RunExit; out: OutputKeeper; tracker: SecretTracker; running: RunningCommand }

/**
 * Starts the run with its stamp computed now (the approval's age measured at send: critique integration-6), shows it in
 * the command window, and waits for its end or the task's stop. "stopped": the task stopped (the run was told to stop);
 * "unseen": the command window couldn't show it, so it was stopped at once (a command never runs where the user can't
 * watch and stop it, D4.2). A run that ends after its task stopped still has its end audited.
 */
async function runOnce(ctx: CommandFlowContext, j: CommandJudge, o: {
  runId: string; shell: ShellId; cwd: string; command: string; timeoutS: number; card: CommandCard;
  stamp: { taskId: string; sha256: string; verdict: "run" | "announce" | "ask"; classes: CommandDecision["classes"]; rules: string[]; approvedAt: number | null; announcedAt?: number | null };
}, started: () => void): Promise<RunOutcome | "stopped" | "unseen"> {
  if (ctx.isOver()) return "stopped";
  const svc = ctx.service;
  const { cols, rows } = windowSize(svc.window) ?? ctx.size();
  const spec: RunSpec = {
    runId: o.runId, taskId: o.stamp.taskId, shell: o.shell, command: o.command, cwd: o.cwd, timeoutMs: o.timeoutS * 1000, cols, rows,
    stamp: {
      taskId: o.stamp.taskId, sha256: o.stamp.sha256, verdict: o.stamp.verdict, classes: o.stamp.classes, rules: o.stamp.rules,
      approval: o.stamp.approvedAt === null ? null : { ageMs: Math.max(0, Math.round(performance.now() - o.stamp.approvedAt)) },
      ...(typeof o.stamp.announcedAt === "number" ? { announced: { ageMs: Math.max(0, Math.round(performance.now() - o.stamp.announcedAt)) } } : {}),
    },
  };
  started();
  const running = svc.runner.start(spec);
  const tracker = j.trackSecretPrompts({ interactive: running.interactive });
  const out = new OutputKeeper(tracker);
  const unsubscribe = running.onOutput(chunk => out.push(chunk));
  ctx.audit({ event: "command", phase: "started", task: o.stamp.taskId, target: svc.binding.id, runId: o.runId });
  // The window gets the run with Enter presses noted for the tracker (what is typed goes straight to the run), and what
  // the run left running once its runner looked (RUN's and WA's `stragglers`, named on the tab's status line).
  const shown: RunningCommand & { readonly stragglers?: unknown } = {
    get stragglers() { return (running as RunningCommand & { stragglers?: unknown }).stragglers; },
    get runId() { return running.runId; },
    get interactive() { return running.interactive; },
    get done() { return running.done; },
    onOutput: fn => running.onOutput(fn),
    input: bytes => { if (bytes.includes(13) || bytes.includes(10)) tracker.enter(); running.input(bytes); },
    typedLines: () => running.typedLines(),
    forgetTyped: () => running.forgetTyped(),
    stop: why => running.stop(why),
  };
  const failed = (err: unknown): RunExit => ({ code: null, signal: null, ended: "failed-to-start", ms: 0, error: err instanceof Error ? err.message : String(err) });
  const ended: Promise<RunExit | null> = running.done.catch(failed);
  /** The end of a run the flow returned from early (its task stopped, or it couldn't be shown): audited when it comes. */
  const auditLateEnd = () => {
    void ended.then(exit => {
      const typed = running.typedLines().length;
      running.forgetTyped();
      if (!exit) return;
      ctx.audit({
        event: "command", phase: "ended", task: o.stamp.taskId, target: svc.binding.id, runId: o.runId, ended: exit.ended, code: exit.code, signal: exit.signal,
        ms: exit.ms, outBytes: out.bytes, secretSpans: tracker.spans().length, typedLines: typed,
      });
    });
  };
  try {
    svc.window.attach(o.card, shown);
  } catch (err) {
    ctx.log.warn("commands.attach_failed", { task: o.stamp.taskId, err });
    running.stop("task");
    unsubscribe();
    await within(ended, STOP_GRACE_MS, null);
    auditLateEnd();
    return "unseen";
  }
  // What the runner says while the run starts ("Starting Ubuntu…": a WSL distro that has to boot) shows on its tab.
  const offStatus = followStatus(svc, o.runId);
  // A run waiting at a prompt for the user's typing says so in the task's bubble too (review #263).
  const offWaiting = followWaiting(svc, o.runId, ctx.presenter);
  // The task's stop stops the run; the tool returns once it ended, or STOP_GRACE_MS later whatever the runner does.
  let onStop = () => undefined as void;
  const stopped = new Promise<RunExit | null>(resolve => {
    onStop = () => { running.stop("task"); void within(ended, STOP_GRACE_MS, null).then(() => resolve(null)); };
  });
  ctx.signal.addEventListener("abort", onStop, { once: true });
  if (ctx.signal.aborted) onStop();
  // The runner keeps the time limit; this only ends a run whose runner never did.
  const backstop = setTimeout(() => running.stop("timeout"), o.timeoutS * 1000 + 10_000);
  backstop.unref?.();
  try {
    const exit = await Promise.race([ended, stopped]);
    if (!exit || ctx.isOver()) {
      auditLateEnd();
      return "stopped";
    }
    out.end();
    return { exit, out, tracker, running };
  } finally {
    clearTimeout(backstop);
    ctx.signal.removeEventListener("abort", onStop);
    unsubscribe();
    offStatus();
    offWaiting();
  }
}

/**
 * Tells the command window (UI's reaskEnded) that no OK is coming for run `runId`, which the remote's own check sent back
 * for one; nothing when the window doesn't have it.
 */
function reaskEnded(svc: CommandService, runId: string, why: "no" | "expired" | "stopped" | "refused"): void {
  const w = svc.window as CommandService["window"] & { reaskEnded?: (runId: string, why: "no" | "expired" | "stopped" | "refused") => void };
  if (typeof w.reaskEnded !== "function") return;
  try { w.reaskEnded(runId, why); } catch { /* its tab only says it less well */ }
}

/** The task's bubble while its command waits at a prompt for the user to type (review #263). */
export const WAITING_BUBBLE = "A command is waiting for you to type in the command window.";
/** The task's bubble after the wait, when it said nothing before it. */
export const RUNNING_BUBBLE = "The command is running.";

/** The waiting line's button, which brings the command window up with the keyboard (the targets runtime handles it). */
export const showCommandWindowId = (runId: string): string => `ui:cmdshow:${runId}`;

/**
 * The command window's word that run `runId` waits for the user's typing (UI's onWaiting), said in the task's bubble
 * with a Show button that brings the command window up and gives it the keyboard, and under it the keyboard's own way
 * there (UI's typingRoute; review #263); nothing when the window doesn't have it. Once the run stops waiting (the user
 * typed, or it ended), the bubble says again what it said before, with its step and without Show, unless something
 * newer has replaced the waiting line since: that stays, without Show. Returns the unsubscribe.
 */
function followWaiting(svc: CommandService, runId: string, presenter: Presenter): () => void {
  const window = svc.window as CommandService["window"] & {
    onWaiting?: (fn: (runId: string, waiting: boolean) => void) => () => void;
    typingRoute?: () => string | null;
  };
  if (typeof window.onWaiting !== "function") return () => undefined;
  const show = showCommandWindowId(runId);
  const bubble = (): { thought: string; step: string | null; actions: { id: string; label: string }[] } | null => {
    try {
      const b = (presenter as Partial<Pick<Presenter, "bubble">>).bubble;
      return b && typeof b.thought === "string" ? { thought: b.thought, step: typeof b.step === "string" ? b.step : null, actions: Array.isArray(b.actions) ? b.actions : [] } : null;
    } catch { return null; }
  };
  const route = (): string | null => {
    try { const r = typeof window.typingRoute === "function" ? window.typingRoute() : null; return typeof r === "string" && r ? r : null; } catch { return null; }
  };
  /** What the bubble said before the waiting line (and its step), and the route said under it, while it shows that line. */
  let before: { thought: string; step: string | null; route: string | null } | null = null;
  const restore = (): void => {
    if (before === null) return;
    const back = before;
    before = null;
    const now = bubble();
    try {
      if (now?.thought === WAITING_BUBBLE) presenter.progress(back.thought.trim() ? back.thought : RUNNING_BUBBLE, { actions: now.actions.filter(a => a.id !== show), step: back.step });
      // Something newer is in the bubble: it stays, without Show (and the route under it).
      else if (now?.actions.some(a => a.id === show)) presenter.progress(now.thought, { actions: now.actions.filter(a => a.id !== show), step: now.step === back.route ? back.step : now.step });
    } catch { /* the bubble is only a pointer */ }
  };
  try {
    const off = window.onWaiting((id, waiting) => {
      if (id !== runId) return;
      if (!waiting) { restore(); return; }
      const now = bubble();
      const way = route();
      if (before === null) before = { thought: now !== null && now.thought !== WAITING_BUBBLE ? now.thought : "", step: now?.step ?? null, route: way };
      else before.route = way;
      try {
        // A line that needs the user ("Needs you", finished), so a screen reader hears it and its route: the window came
        // up without the keyboard, and the task's running commentary is never read out.
        presenter.progress(WAITING_BUBBLE, { actions: [...(now?.actions ?? []).filter(a => a.id !== show), { id: show, label: "Show" }], step: way, needsYou: true });
      } catch { /* the bubble is only a pointer: the window says it too */ }
    });
    return () => {
      try { off(); } catch { /* already gone */ }
      restore();
    };
  } catch {
    return () => undefined;
  }
}

/**
 * A runner's status line ("Starting Ubuntu…", WA's WSL runner: `status()`/`onStatus()`) as a note on the run's tab
 * (UI's `note(runId, text)`), until the run ends; nothing when either side doesn't have it. Returns the unsubscribe.
 */
function followStatus(svc: CommandService, runId: string): () => void {
  const runner = svc.runner as CommandService["runner"] & { status?: () => string | null; onStatus?: (fn: (text: string | null) => void) => () => void };
  const window = svc.window as CommandService["window"] & { note?: (runId: string, text: string | null) => void };
  if (typeof runner.onStatus !== "function" || typeof window.note !== "function") return () => undefined;
  const show = (text: string | null) => {
    try { window.note!(runId, typeof text === "string" && text ? text : null); } catch { /* a note is only a note */ }
  };
  try {
    const now = runner.status?.() ?? null;
    if (now) show(now);
    const off = runner.onStatus(show);
    return () => { try { off(); } catch { /* already gone */ } };
  } catch {
    return () => undefined;
  }
}

/** The command window's line for a task whose command has no tab yet (window.ts's controller has it; absent: only the bubble says it). */
export interface CommandWindowPending {
  /** Shows `text` for task `taskId` until it is replaced or cleared with null. */
  pending(taskId: string, text: string | null): void;
}

/**
 * The runner's status line ("Starting Ubuntu…": WA's WSL runner while the first command's facts boot a stopped distro)
 * while the flow reads the target's facts and checks the command, before the run has a tab: shown through the command
 * window's `pending` when it has one (the task's bubble says it too: host.ts); cleared when the checks end. Once the run
 * has its tab, followStatus notes the status there. Returns the unsubscribe (safe to call more than once).
 */
function followPending(svc: CommandService, taskId: string): () => void {
  const runner = svc.runner as CommandService["runner"] & { status?: () => string | null; onStatus?: (fn: (text: string | null) => void) => () => void };
  const window = svc.window as CommandService["window"] & Partial<CommandWindowPending>;
  if (typeof runner.onStatus !== "function" || typeof window.pending !== "function") return () => undefined;
  let shown = false;
  const show = (text: string | null) => {
    const t = typeof text === "string" && text ? text.slice(0, 200) : null;
    if (t === null && !shown) return;
    shown = t !== null;
    try { window.pending!(taskId, t); } catch { /* a note is only a note */ }
  };
  let off: () => void = () => undefined;
  try {
    off = runner.onStatus(show);
    show(runner.status?.() ?? null);
  } catch {
    // a runner that can't say: nothing is shown
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try { off(); } catch { /* already gone */ }
    show(null);
  };
}

/**
 * Notes what a run that started may have downloaded and written, whatever its end (D4.3 f: running a file downloaded
 * in this task asks; L8's padding bypass: a script of the task's own that can't be read in full asks): a download or a
 * write cut short by a later part of the line failing, a Stop or the time limit can still leave the file on disk, and
 * a later `bash x.sh` must not count it as the user's own.
 */
function noteDownloads(ctx: CommandFlowContext, cls: Classification): void {
  for (const p of cls.downloads) ctx.state.downloaded.add(p);
  noteWrites(ctx.state.written ??= newTaskWrites(), cls);
}

/** One macrotask: the stop shortcut's handler, waiting on Ember's main thread, runs first (merge review integ-y-2). */
const nextTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/**
 * Steps 14: shape, check for instructions, note downloads, audit the end, and say how it went. A run keeps up to 4 MiB
 * of output, and cleaning it held Ember's main thread about 1 s (1.7 s with three of each vault entry filled) where
 * Stop must answer within 300 ms (merge review integ-y-2): the cut, CL's own cleaning, and the check copy's making
 * (each typed line taken out, stop-yield-y9-1) and redaction run a whole-text operation a step (stop-yield-x9-1),
 * with a macrotask between two steps once 8 ms of them have run (runStepsYielding), and a Stop seen between them ends
 * the call as stopped, with nothing of the output, cleaned or not, for the model, the audit or the log. Measured on 4 MiB of coloured build output with a login, a card and
 * contact details filled, one to three of each: the longest stretch went from 1,163-1,901 ms to 134-175 ms (132-188
 * ms with nothing filled); with a colour code on every character, 115-216 ms; with 1,000 typed lines, 135-190 ms
 * (872 ms before their removal was stepped). The instructions check (outputTaint) is one step, about 190-230 ms on
 * Ember.js build output that says "ember" on every line. One known pass is longer still: the Key Vault value pattern over 4 MiB of secret
 * ids with no value, about 1.6 s.
 */
async function finishRun(ctx: CommandFlowContext, j: CommandJudge, run: RunOutcome, o: { cls: Classification; label: string; shell: ShellId; timeoutS: number; runId: string }): Promise<ToolResultObject> {
  const { exit, out, tracker, running } = run;
  const typed = running.typedLines();
  running.forgetTyped();
  const task = ctx.task.id;
  const target = ctx.service.binding.id;
  /** The end of a run Stop came to while its output was cleaned: what it may have written is noted, its end audited. */
  const stopped = (): ToolResultObject => {
    if (exit.ended !== "failed-to-start") noteDownloads(ctx, o.cls);
    ctx.audit({
      event: "command", phase: "ended", task, target, runId: o.runId, ended: exit.ended, code: exit.code, signal: exit.signal, ms: exit.ms,
      outBytes: out.bytes, typedLines: typed.length, stopped: true,
    });
    ctx.log.info("commands.ended", { task, target, ended: exit.ended, code: exit.code, ms: exit.ms, outBytes: out.bytes, stopped: true });
    return STOPPED();
  };
  if (ctx.isOver()) return stopped();
  // The run's own tracker, when its runner keeps one, adds its spans: a secret hidden by either stays hidden.
  const theirs = (running as RunningCommand & { secretSpans?: () => { from: number; to: number }[] }).secretSpans?.() ?? [];
  const kept = await runStepsYielding(out.keptSteps([...tracker.spans(), ...theirs]), () => ctx.isOver());
  if (kept === null || ctx.isOver()) return stopped();
  // The cut's last step, encoding and decoding are each a whole-text pass: a turn between them (stop-yield-x9-1).
  await nextTurn();
  if (ctx.isOver()) return stopped();
  const raw = new TextEncoder().encode(kept.text);
  await nextTurn();
  if (ctx.isOver()) return stopped();
  // What it printed is checked whole, before shaping cuts it to size (CL's cleaned text, as the model's copy is made
  // from it; and the flow's own copy, which keeps what a carriage return overwrote), and as the model gets it.
  const own = j.cleanOutput === cleanOutput;
  const clean = own ? await cleanOutputAsync(raw, { typed, secretSpans: kept.spans }, () => ctx.isOver()) : j.cleanOutput ? j.cleanOutput(raw, { typed, secretSpans: kept.spans }) : null;
  if (ctx.isOver()) return stopped();
  const shape: ShapeOptions = { target, label: o.label, shell: o.shell, exit, typed, secretSpans: kept.spans };
  // CL's own shaping is that same cleaned text bounded and wrapped: made from it, so the kept output (up to 4 MiB) is
  // cleaned once on Ember's main thread, not twice (integ-y-2). A judge a test passes shapes as it does.
  const shaped = clean !== null && j.shapeOutput === shapeOutput && own ? shapeCleaned(clean, shape) : j.shapeOutput(raw, shape);
  await nextTurn();
  if (ctx.isOver()) return stopped();
  let taint = clean !== null ? j.outputTaint(clean) : null;
  if (taint === null) {
    await nextTurn();
    if (ctx.isOver()) return stopped();
    const check = await runStepsYielding(checkedTextSteps(kept.text, kept.spans, typed), () => ctx.isOver());
    if (check === null || ctx.isOver()) return stopped();
    const checked = j.redactSecrets === redactSecrets ? await redactSecretsYielding(check, () => ctx.isOver()) : j.redactSecrets(check);
    if (checked === null || ctx.isOver()) return stopped();
    taint = j.outputTaint(checked) ?? j.outputTaint(shaped);
  }
  if (taint) {
    ctx.state.outputTainted = true;
    ctx.task.taint(taint);
    ctx.audit({ event: "command", phase: "tainted", task, target, runId: o.runId, rule: taint });
  }
  if (exit.ended !== "failed-to-start") noteDownloads(ctx, o.cls);
  ctx.audit({
    event: "command", phase: "ended", task, target, runId: o.runId, ended: exit.ended, code: exit.code, signal: exit.signal, ms: exit.ms,
    outBytes: out.bytes, secretSpans: kept.spans.length, typedLines: typed.length,
  });
  ctx.log.info("commands.ended", { task, target, ended: exit.ended, code: exit.code, ms: exit.ms, outBytes: out.bytes });
  const result = resultOf(exit, shaped, { label: o.label, timeoutS: o.timeoutS, redact: j.redactSecrets });
  if (!taint || result.resultType === "denied") return result;
  const note = "\n(The output contained text that looks like instructions; it was not followed. Every further command in this task asks the user.)";
  return { ...result, textResultForLlm: `${result.textResultForLlm}${note}`, ...(result.resultType === "failure" ? { error: `${result.textResultForLlm}${note}` } : {}) };
}
