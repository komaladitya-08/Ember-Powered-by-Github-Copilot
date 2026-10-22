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
import { placesNamed } from "../targets/resolve";
import type { TargetBinding } from "../targets/types";
import type { ConsentPanel } from "../../shared/consent";
import type { OS } from "../../shared/shortcuts";
import type { TargetId } from "../../shared/targets";
import { carriedText } from "./carried";
import { classifyCommand } from "./classify";
import { LINES, decideCommand } from "./decide";
import { cleanOutput, shapeOutput, type ShapeOptions } from "./output";
import { resolveTargetPath } from "./paths";
import { trackSecretPrompts, type SecretTracker } from "./prompts";
import { redactSecrets } from "./redact";
import { outputTaint } from "./taint";
import {
  ALWAYS_ASK,
  type Classification, type ClassifyContext, type CommandCapability, type CommandCard, type CommandDecision, type CommandMode, type CommandRunner,
  type CommandService, type DecideInput, type GitFacts, type PathFact, type RunCommandArgs, type RunExit, type RunnerFacts, type RunningCommand,
  type RunSpec, type ShellId,
} from "./types";

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
  /**
   * The task's folder and downloads on this target (kept by the worker across calls). `outputTainted` (the flow's own):
   * a command's output tainted the task, so the card says so in its own words (§3.8.4).
   */
  state: { cwd: string | null; downloaded: Set<string>; running: boolean; outputTainted?: boolean };
  /** The command window's size for new runs. */
  size: () => { cols: number; rows: number };
  /** Ember's own pids now (D4.5; main's live list, §3.6.2). */
  emberPids: () => number[];
  /** The user said no to a question of this flow (or let it go unanswered): the worker's `declined` (extension, AG). */
  onDeclined?: () => void;
}

export type { SecretTracker, ShapeOptions };

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

/** The card's taint line when what tainted the task was a command's own output (§3.8.4). */
export const OUTPUT_TAINT_LINE = "I'm checking each step: an earlier command printed text that looked like instructions.";

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

/** The card's first line when the user's words name a place that looks like a computer Ember doesn't know. */
export const unknownPlaceLine = (places: string[], here: string) => `You named ${listOf(places)}, but this runs ${here}.`;

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

/** How long an announced command waits for the user's Stop before it runs (D4.4, §3.7). */
export const ANNOUNCE_MS = 4000;
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
const SAID_NO = "The user said no (or didn't answer). Don't run it again or work around it; finish the task saying what wasn't done.";
const STOPPED_BEFORE = "The user stopped it before it ran. Don't run it again; finish the task saying so.";
const UNSEEN = "Ember couldn't show the command in its command window, so it stopped it at once (commands only run where the user can watch them). Don't run it again; finish the task saying so.";

/** The card's lines for the reasons the flow itself holds (§3.8.4). */
export const CARD_LINES = {
  root: "Commands here run as root (the administrator), so each one asks first.",
  admin: "Ember is running as an administrator here, so each command asks first.",
  adminAsk: "Your organisation asks you to approve every command.",
  userAsk: "You asked Ember to check every command with you.",
  tool: "Podman uses this distro: Ember asks before every command here.",
  tainted: "I'm checking each step: a step came up that you didn't ask for.",
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
 * the user pressed, never what they typed).
 */
class OutputKeeper {
  private head = "";
  private tail = "";
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
    this.tail += text;
    const room = KEEP_CHARS - HEAD_CHARS;
    if (this.tail.length > room) {
      const cut = this.tail.length - room;
      this.tail = this.tail.slice(cut);
      this.dropped += cut;
    }
  }

  /** The text kept, with a note where the middle went, and `spans` (positions in everything printed) moved into it. */
  kept(spans: { from: number; to: number }[]): { text: string; spans: { from: number; to: number }[] } {
    const h = this.head.length;
    if (!this.dropped) return { text: this.head + this.tail, spans };
    const note = `\n[… ${this.dropped} characters of output left out …]\n`;
    const end = h + this.dropped;
    const from = (p: number) => (p < h ? p : p < end ? h : p - this.dropped + note.length);
    const to = (p: number) => (p <= h ? p : p < end ? h + note.length : p - this.dropped + note.length);
    return { text: this.head + note + this.tail, spans: spans.map(s => ({ from: from(s.from), to: to(s.to) })).filter(s => s.to > s.from) };
  }
}

/** The text a run printed with its secret spans and the user's typed lines taken out, for the taint check. */
function checkedText(text: string, spans: { from: number; to: number }[], typed: string[]): string {
  let out = "";
  let at = 0;
  for (const s of [...spans].sort((a, b) => a.from - b.from)) {
    if (s.from > at) out += text.slice(at, s.from);
    at = Math.max(at, s.to);
  }
  out += text.slice(at);
  for (const t of typed.map(l => l.trim()).filter(l => l.length >= 3)) out = out.split(t).join(" ");
  return out.replace(TERMINAL_CODES, "");
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
  const left = (r.cls?.findings ?? []).filter(f => !(f.ifExists !== undefined && r.paths?.get(f.ifExists)?.exists === false));
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
      return fail(`It couldn't start: ${o.redact(exit.error ?? "an unknown error").replace(/</g, "‹").replace(/[.\s]+$/, "").slice(0, 300)}.`);
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
  try {
    return await flow(a, ctx);
  } finally {
    ctx.state.running = false;
  }
}

async function flow(a: RunCommandArgs, ctx: CommandFlowContext): Promise<ToolResultObject> {
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
    const consent = (svc as CommandService & Partial<CommandConsentSource>).consentPanel?.() ?? null;
    if (!consent) return denied(`Commands aren't turned on for ${place} yet: the user can turn them on in Ember's settings, under Commands. Finish the task saying so.`);
    const q: PanelQuestion = {
      title: `Turn on commands on ${place}?`, context: ctx.task.title, prompt: "Ember needs your OK first. Read what it means in the window that opened.",
      options: [{ id: "once", label: "Turn on", primary: true }, { id: "deny", label: "Not now" }],
      task, ...(where ? { where } : {}), panel: { kind: "consent", consent }, clickOnly: true,
    };
    const answer = await ctx.confirmer.ask(q, ctx.signal);
    audit({ phase: "answered", answer: ctx.isOver() ? "stopped" : answer ?? "expired", q: "consent" });
    if (ctx.isOver()) return STOPPED();
    if (answer !== "once") {
      ctx.onDeclined?.();
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

  // Step 6: the branch facts a push's announcement needs.
  const git: GitFacts | null = cls.needsGit ? await within(svc.runner.gitFacts(cwd), PROBE_MS, null) : null;
  if (ctx.isOver()) return STOPPED();

  // Steps 7-8: text carried from elsewhere, then the decision on the user's own words only.
  const words = ctx.task.commandWords();
  others = [...new Set([...others, ...othersNamedIn(svc, words)])].slice(0, 5);
  places = [...new Set([...places, ...placesNamedIn(svc, words, binding, others)])].slice(0, 5);
  where = whereWords(binding) ?? (others.length || places.length ? here : undefined);
  const tainted = ctx.task.tainted();
  const carried = carriedText(a.command, ctx.task.readFrom(), words, binding.shellOs);
  const mode = svc.mode();
  const userAskEvery = svc.userAskEvery();
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
  if (d.verdict === "ask" && (others.length || places.length)) {
    const lines = [...(places.length ? [unknownPlaceLine(places, here)] : []), ...(others.length ? [wrongTargetLine(others, here)] : [])];
    d = { ...d, says: [...lines, ...d.says.filter(l => !lines.includes(l))] };
  }
  const refused = d.verdict === "refuse";
  audit({
    phase: "decided", shell, cwd, ...(refused ? {} : { command: j.redactSecrets(a.command).slice(0, AUDIT_COMMAND_CHARS) }), commandChars: a.command.length,
    verdict: d.verdict, classes: d.classes, rules: d.rules, ...(d.requested ? { requested: "user", intent: d.requested.intent } : {}), reason: d.reason,
  });
  ctx.log.info("commands.decided", { task, target, verdict: d.verdict, classes: d.classes, chars: a.command.length });

  // Step 9.
  if (refused) return denied(`Not allowed: ${d.reason} Don't try another way; tell the user in finish_task.`);

  let runId = newRunId();
  const sha256 = commandSha256(target, shell, cwd, a.command);
  const why = `Why: ${shownQuote(a.why, 200)}`;
  const card = (cardMode: CommandCard["mode"], says: string[]): CommandCard => ({
    runId, target, targetLabel: binding.label, ...(binding.login ? { login: binding.login } : {}), shell, cwd, command: a.command, sha256, taskId: task,
    taskTitle: ctx.task.title, mode: cardMode, says, unasked: cardMode === "ask" && d.unasked, armMs: d.armMs,
  });
  /** Asks with the command card; "once", "no" (said no or let it expire) or "stopped". */
  const askCard = async (says: string[], q: string, prompt = `On ${place}: ${firstLine(says)}`): Promise<"once" | "no" | "stopped"> => {
    const question: PanelQuestion = {
      title: "May I run a command?", context: ctx.task.title, prompt,
      options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }],
      task, ...(where ? { where } : {}), armMs: d.armMs, panel: { kind: "command", card: card("ask", [...says, why]) },
    };
    const answer = await ctx.confirmer.ask(question, ctx.signal);
    audit({ phase: "answered", answer: ctx.isOver() ? "stopped" : answer ?? "expired", q });
    if (ctx.isOver()) return "stopped";
    if (answer === "once") return "once";
    ctx.onDeclined?.();
    return "no";
  };

  // Step 10: the card.
  let approvedAt: number | null = null;
  if (d.verdict === "ask") {
    const answer = await askCard(d.says, "card");
    if (answer === "stopped") return STOPPED();
    if (answer === "no") return denied(SAID_NO);
    approvedAt = performance.now();
  }

  // A run slot on this target (MAX_RUNS_PER_TARGET), taken before an announcement: its countdown ends in the run, not
  // in a wait for another task's command to end.
  const timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(1, Math.round(a.timeoutSeconds ?? DEFAULT_TIMEOUT_S)));
  const release = await slotOn(svc.runner, ctx.signal);
  if (!release) return STOPPED();
  try {
    // Step 11: an announcement with its Stop window (D4.4).
    if (d.verdict === "announce" && d.requested) {
      const stopId = `ui:cmdstop:${runId}`;
      ctx.presenter.announce(d.requested.announce, stopId);
      let go = false;
      try {
        go = await svc.window.announce(card("announce", [...d.says, why]), ANNOUNCE_MS, ctx.signal);
      } catch (err) {
        ctx.log.warn("commands.announce_failed", { task, err });
      } finally {
        ctx.presenter.endAnnouncement(stopId);
      }
      if (ctx.isOver()) return STOPPED();
      if (!go) {
        audit({ phase: "answered", answer: "deny", q: "announce" });
        return denied(STOPPED_BEFORE);
      }
    }

    // Steps 12-14: run (a remote's own check may ask once more), then shape what it printed.
    let rules = d.rules;
    let asked = false;
    for (;;) {
      const run = await runOnce(ctx, j, {
        runId, shell, cwd, command: a.command, timeoutS, card: card("run", d.verdict === "run" ? [] : [...d.says, why]),
        stamp: { taskId: task, sha256, verdict: d.verdict === "announce" ? "announce" : d.verdict === "ask" ? "ask" : "run", classes: d.classes, rules, approvedAt },
      });
      if (run === "stopped") return STOPPED();
      if (run === "unseen") return fail(UNSEEN);
      const { exit } = run;
      // The remote's gate 2 refused the run before it started: its end is audited here (the error is sized in the journal).
      if (exit.ended === "refused-remote") {
        audit({ phase: "ended", runId, ended: exit.ended, code: null, signal: null, ms: exit.ms, needsConfirm: exit.needsConfirm === true, error: j.redactSecrets(exit.error ?? "") });
      }
      if (exit.ended === "refused-remote" && exit.needsConfirm && !asked) {
        // Gate 2 found more than the PC did: the user sees its own lines, quoted, and says yes once more or not.
        asked = true;
        const theirs = (exit.remoteSays ?? []).filter(l => typeof l === "string").slice(0, 10).map(l => shownQuote(l));
        // In the card's order (§3.8.4): the remote's own lines come before "You didn't ask for this." and the Windows line.
        const own = [`${binding.label}'s own check also found:`, ...theirs];
        const at = d.says.findIndex(l => l === LINES.unasked || l === LINES.windows);
        const lines = at < 0 ? [...d.says, ...own] : [...d.says.slice(0, at), ...own, ...d.says.slice(at)];
        const answer = await askCard(lines, "remote",
          `On ${place}: ${d.says.length ? firstLine(d.says) : `${binding.label}'s own check wants your OK first.`}`);
        if (answer === "stopped") return STOPPED();
        if (answer === "no") return denied(SAID_NO);
        approvedAt = performance.now();
        rules = [...new Set([...rules, ...remoteRules(exit)])];
        // A new run (its own id and tab); the approval is bound to the same bytes, folder, shell and computer.
        runId = newRunId();
        continue;
      }
      if (exit.ended === "lost") factsCache.delete(ctx.state);
      if (exit.ended === "refused-remote") return resultOf(exit, "", { label: binding.label, timeoutS, redact: j.redactSecrets });
      return finishRun(ctx, j, run, { cls, label: binding.label, shell, timeoutS, runId });
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
  stamp: { taskId: string; sha256: string; verdict: "run" | "announce" | "ask"; classes: CommandDecision["classes"]; rules: string[]; approvedAt: number | null };
}): Promise<RunOutcome | "stopped" | "unseen"> {
  if (ctx.isOver()) return "stopped";
  const svc = ctx.service;
  const { cols, rows } = windowSize(svc.window) ?? ctx.size();
  const spec: RunSpec = {
    runId: o.runId, taskId: o.stamp.taskId, shell: o.shell, command: o.command, cwd: o.cwd, timeoutMs: o.timeoutS * 1000, cols, rows,
    stamp: {
      taskId: o.stamp.taskId, sha256: o.stamp.sha256, verdict: o.stamp.verdict, classes: o.stamp.classes, rules: o.stamp.rules,
      approval: o.stamp.approvedAt === null ? null : { ageMs: Math.max(0, Math.round(performance.now() - o.stamp.approvedAt)) },
    },
  };
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

/** Steps 14: shape, check for instructions, note downloads, audit the end, and say how it went. */
function finishRun(ctx: CommandFlowContext, j: CommandJudge, run: RunOutcome, o: { cls: Classification; label: string; shell: ShellId; timeoutS: number; runId: string }): ToolResultObject {
  const { exit, out, tracker, running } = run;
  const typed = running.typedLines();
  running.forgetTyped();
  // The run's own tracker, when its runner keeps one, adds its spans: a secret hidden by either stays hidden.
  const theirs = (running as RunningCommand & { secretSpans?: () => { from: number; to: number }[] }).secretSpans?.() ?? [];
  const kept = out.kept([...tracker.spans(), ...theirs]);
  const raw = new TextEncoder().encode(kept.text);
  const shaped = j.shapeOutput(raw, { target: ctx.service.binding.id, label: o.label, shell: o.shell, exit, typed, secretSpans: kept.spans });
  const task = ctx.task.id;
  const target = ctx.service.binding.id;
  // What it printed is checked whole, before shaping cuts it to size (CL's cleaned text, as the model's copy is made
  // from it; and the flow's own copy, which keeps what a carriage return overwrote), and as the model gets it.
  const clean = j.cleanOutput ? j.cleanOutput(raw, { typed, secretSpans: kept.spans }) : null;
  const taint = (clean !== null ? j.outputTaint(clean) : null) ?? j.outputTaint(j.redactSecrets(checkedText(kept.text, kept.spans, typed))) ?? j.outputTaint(shaped);
  if (taint) {
    ctx.state.outputTainted = true;
    ctx.task.taint(taint);
    ctx.audit({ event: "command", phase: "tainted", task, target, runId: o.runId, rule: taint });
  }
  if (exit.ended === "exit" && exit.code === 0) for (const p of o.cls.downloads) ctx.state.downloaded.add(p);
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
