/**
 * Gate 2: the remote's own check of every command (§3.16) and every desktop step (§5.3.7) before it happens, under
 * this machine's administrator policy. It can refuse (`deny`), demand the user's yes (`needs_confirm`), or say the
 * step no longer fits (`changed`, `stale`, `stopped`); it never approves and never loosens what the PC decided. Above
 * all (critique security-3): any finding of the remote's own classification whose class or rule the PC's stamp
 * doesn't name means the two machines disagree, so it asks, for a stamp of "run" and of "announce" alike. Ages are
 * measured on the PC (`ageMs`); no clock is compared across machines (critique integration-6). Pure over its inputs.
 *
 * A shell script the command runs is read here, on this machine's own filesystem, and judged with the same rules as
 * on the PC (L8, the lead's ruling; app/main/commands/scripts.ts): the PC can't see this machine's files, so its stamp
 * never covers what a script does, and any finding in one asks. A script this task wrote or downloaded here that
 * can't be read in full asks too (the padding bypass), from the agent's own memory of the task's commands.
 */

import { createHash } from "node:crypto";
import type { ActStamp } from "../main/perception/ports";
import type { ElementInfo } from "../main/perception/sidecar";
import type { ActionKind, ActionRequest, Decision, TextMode } from "../main/policy/policy";
import { normalizeLabel } from "../main/policy/policy";
import { ALWAYS_ASK } from "../main/commands/types";
import type { Classification, ClassifyContext, CommandMode, Finding, PathFact, RunnerFacts, RunSpec } from "../main/commands/types";
import { judgeScripts, type TaskWrites } from "../main/commands/scripts";
import type { ClassifyCommand } from "./contracts";

/** An approval older than this no longer counts (a question expires at 120 s anyway). */
export const APPROVAL_MAX_MS = 120_000;
/** A desktop step's stamp older than this is stale. */
export const STEP_MAX_MS = 10_000;
/** At most this many of the remote's own card lines go back to the PC. */
const SAYS_MAX = 10;
const LINE_MAX = 500;
/** inspect() gets this long before every path counts as "couldn't tell". */
export const INSPECT_MS = 5000;
/**
 * Reading the command's scripts (and inspecting their paths): one read or inspect at most SCRIPT_MS, all of them at
 * most SCRIPTS_MS (the run must start within serve.ts's RUN_START_MAX_MS of its request); a script left unread then
 * counts as unreadable.
 */
export const SCRIPT_MS = 2000;
export const SCRIPTS_MS = 3000;

/** The words gate 2 answers with (Ember's own, sentence case). */
export const GATE_WORDS = {
  commandsOff: "This computer's administrator has turned off commands from Ember.",
  adminAsks: "This computer's administrator asks for your approval of every command.",
  root: "Commands here run as root (the administrator), so each one asks first.",
  disagree: "This computer's own check found more in this command than Ember asked about.",
  approvalMissing: "This command needs your approval again.",
  mismatch: "The command that arrived doesn't match the one Ember decided on.",
  noAudit: "This computer couldn't record the command, so Ember won't run it.",
  actionsOff: "This computer's administrator doesn't let Ember act in apps.",
  stepMismatch: "The step that arrived doesn't match the one Ember decided on.",
  noStepAudit: "This computer couldn't record the step, so Ember won't do it.",
} as const;

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** One line of the remote's card for the PC: plain, at most 500 characters. */
const line = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, LINE_MAX);

/** gateCommand's answer: run it (with the classification and whether the user said yes), or why not. */
export type CommandGate =
  | { status: "ok"; cls: Classification; approved: boolean }
  | { status: "deny" | "needs_confirm"; reason: string; says?: string[]; rules?: string[] }
  | { status: "stale" | "stopped" };

/** What gateCommand needs. */
export interface CommandGateInput {
  spec: RunSpec;
  /** The request's epoch, and the newest this agent has seen (a stop raises it). */
  epoch: number;
  agentEpoch: number;
  /** A frame from the PC within 1.5 s. */
  fresh: boolean;
  /** The PC's id for this target (`ssh:<host>`), when known: the stamp's hash covers it. */
  targetId: string | null;
  /** This machine's own commands mode for SSH (admin.ts commandMode on its own policy). */
  mode: CommandMode;
  facts: RunnerFacts;
  classify: ClassifyCommand;
  inspect: (paths: string[], cwd: string) => Promise<PathFact[]>;
  /** A shell script's text from this machine's filesystem (readScriptText); absent: no script is read (L8 as before). */
  readScript?: (path: string, cwd: string) => Promise<string | null>;
  /** What this task's earlier commands downloaded and wrote here (the agent's own memory); absent: nothing yet. */
  task?: { downloaded: ReadonlySet<string>; written: TaskWrites };
  now?: () => number;
}

/** inspect() within INSPECT_MS, else every path "couldn't tell" (which counts as existing). */
async function inspectSoon(inspect: CommandGateInput["inspect"], paths: string[], cwd: string): Promise<PathFact[]> {
  const unknown = paths.map((): PathFact => ({ exists: null, real: null }));
  if (!paths.length) return [];
  let timer: NodeJS.Timeout | undefined;
  try {
    const got = await Promise.race([inspect(paths, cwd), new Promise<null>(r => { timer = setTimeout(() => r(null), INSPECT_MS); })]);
    return got && got.length === paths.length ? got : unknown;
  } catch {
    return unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gate 2 for a command (§3.16): freshness and epoch; the stamp belongs to this spec; this machine's commands mode; its
 * own classification with its own facts and real paths (a refusal denies; root asks without a yes); then every finding
 * the stamp doesn't cover asks, carrying this machine's card lines and rules. A finding is covered when the stamp
 * names its rule and its class (never for an always-ask class: secret, escape, unclear), or, after the user's yes, its
 * rule (the PC resends with the rules a needs_confirm
 * carried once the user said yes to them, §3.8.3 step 13). An approval older than 120 s counts as none.
 */
export async function gateCommand(i: CommandGateInput): Promise<CommandGate> {
  const { spec } = i;
  const stamp = spec.stamp;
  if (i.epoch < i.agentEpoch) return { status: "stopped" };
  if (!i.fresh) return { status: "stale" };
  if (stamp.taskId !== spec.taskId) return { status: "deny", reason: GATE_WORDS.mismatch };
  if (i.targetId !== null && stamp.sha256 !== sha256Hex(`${i.targetId}\0${spec.shell}\0${spec.cwd}\0${spec.command}`)) {
    return { status: "deny", reason: GATE_WORDS.mismatch };
  }
  if (i.mode === "off") return { status: "deny", reason: GATE_WORDS.commandsOff };
  const approval = stamp.approval && stamp.approval.ageMs < APPROVAL_MAX_MS ? stamp.approval : null;
  // Every reason to ask is gathered into one question, so a single yes (with these rules added) covers them all: the
  // PC asks once and sends again once (§3.8.3 step 13).
  const asks: string[] = [];
  if (stamp.verdict === "ask" && !approval) asks.push(GATE_WORDS.approvalMissing);
  if (i.mode === "ask" && !approval) asks.push(GATE_WORDS.adminAsks);

  const downloaded = i.task?.downloaded ?? new Set<string>();
  const ctx: ClassifyContext = {
    os: i.facts.os, home: i.facts.home, cwd: spec.cwd, ember: i.facts.ember, downloaded,
    ...(i.facts.wsl ? { wsl: { mountRoot: i.facts.wsl.mountRoot, windows: i.facts.wsl.windows } } : {}),
  };
  let cls = i.classify(spec.command, spec.shell, ctx);
  const probe = cls.probe.slice(0, 64);
  const facts = await inspectSoon(i.inspect, probe, spec.cwd);
  const byPath = new Map<string, PathFact>();
  const real = new Map<string, string>();
  probe.forEach((p, k) => {
    byPath.set(p, facts[k]);
    const r = facts[k].real;
    if (r !== null) {
      real.set(p, r);
      if (!byPath.has(r)) byPath.set(r, facts[k]);
    }
  });
  // The second pass judges the real paths too (§3.8.3 step 5); never a third.
  if ([...real].some(([p, r]) => p !== r)) cls = i.classify(spec.command, spec.shell, { ...ctx, real });
  // The scripts it runs, read here (L8): their refusals refuse, their findings join (the stamp never covers them).
  const read = i.readScript;
  cls = await judgeScripts(cls, read ? { read: (p, cwd) => read(p, cwd), inspect: (paths, cwd) => inspectSoon(i.inspect, paths, cwd) } : null, i.classify, {
    os: i.facts.os, home: i.facts.home, ember: i.facts.ember, wsl: i.facts.wsl, downloaded, written: i.task?.written ?? null, paths: byPath,
    isOver: () => false, probeMs: SCRIPT_MS, budgetMs: SCRIPTS_MS, ...(i.now ? { now: i.now } : {}),
  });
  if (cls.refuse) return { status: "deny", reason: line(cls.refuse.says) || GATE_WORDS.mismatch };
  if (i.facts.privileged && !approval) asks.push(GATE_WORDS.root);

  // An overwrite counts only when its target exists here (§3.8.2 rule 3).
  const findings = cls.findings.filter(f => !(f.ifExists && byPath.get(f.ifExists)?.exists === false));
  // Secrets, escapes and what can't be classified always ask (D4.4): a stamp naming one without the user's yes (a
  // "run" or "announce" no PC should send) covers nothing of it.
  const covered = (f: Finding) => stamp.rules.includes(f.rule) && (approval !== null || (stamp.classes.includes(f.cls) && !ALWAYS_ASK.has(f.cls)));
  const extra = findings.filter(f => !covered(f));
  if (extra.length || asks.length) {
    const rules = [...new Set(extra.map(f => f.rule))].slice(0, 64);
    return {
      status: "needs_confirm",
      reason: extra.length ? GATE_WORDS.disagree : asks[0],
      says: [...new Set([...asks, ...extra.map(f => f.says)].map(line))].slice(0, SAYS_MAX),
      ...(rules.length ? { rules } : {}),
    };
  }
  return { status: "ok", cls, approved: approval !== null };
}

/** A desktop step as gate 2 sees it: the act op or a launch, with the value it carries (as text). */
export interface StepGateInput {
  stamp: ActStamp;
  op: "do_action" | "set_text" | "set_value" | "select_option" | "open_app";
  /** set_text's text, select_option's option, set_value's number as text, open_app's app name. */
  value?: string;
  mode?: TextMode;
  /** The element as read now (null: gone), and its window's app and title now (null: gone). */
  element: Pick<ElementInfo, "role" | "name" | "secret" | "withheld"> | null;
  window: { app: string; title: string } | null;
  /** The remote administrator's `features.actions`. */
  actionsAllowed: boolean;
  /** A PolicyEngine built with this machine's policy (§5.3.7 step 4). */
  decide: (r: ActionRequest) => Decision;
}

/** The kinds of step each op may carry out. */
const KINDS: Record<StepGateInput["op"], readonly ActionKind[]> = {
  do_action: ["click", "toggle"],
  set_text: ["text"],
  set_value: ["value"],
  select_option: ["select"],
  open_app: ["open_app"],
};

/** Labels compared as the policy compares them (look-alikes, invisible characters and case folded). */
const same = (a: string, b: string) => normalizeLabel(a).trim() === normalizeLabel(b).trim();

/**
 * Gate 2 for a desktop step (§5.3.7 steps 2-5; freshness, epoch and the write-ahead audit are the caller's): the stamp
 * is under 10 s old and fits the op and its value; the element and its window are still what the PC saw (else
 * `changed`); this machine's administrator lets Ember act; and this machine's PolicyEngine, judging the step from the
 * stamp and the fresh facts, doesn't deny it or want a yes the stamp doesn't carry.
 */
export function gateStep(i: StepGateInput): { status: "ok" } | { status: "deny" | "needs_confirm"; reason: string } | { status: "changed" | "stale" } {
  const { stamp } = i;
  if (!(stamp.ageMs < STEP_MAX_MS)) return { status: "stale" };
  if (!KINDS[i.op].includes(stamp.kind)) return { status: "deny", reason: GATE_WORDS.stepMismatch };
  const carriesValue = i.op === "set_text" || i.op === "set_value" || i.op === "select_option";
  if (carriesValue && (i.value === undefined || stamp.valueSha256 !== sha256Hex(i.value))) return { status: "deny", reason: GATE_WORDS.stepMismatch };
  if (!i.actionsAllowed) return { status: "deny", reason: GATE_WORDS.actionsOff };
  let request: ActionRequest;
  if (i.op === "open_app") {
    if (!i.value || !same(i.value, stamp.app)) return { status: "changed" };
    request = { taskId: stamp.taskId, kind: "open_app", app: "", window: "", value: i.value };
  } else {
    if (!stamp.element) return { status: "deny", reason: GATE_WORDS.stepMismatch };
    if (!i.element || !i.window) return { status: "changed" };
    if (!same(i.element.role, stamp.element.role) || !same(i.element.name, stamp.element.name)) return { status: "changed" };
    if (!same(i.window.app, stamp.app) || !same(i.window.title, stamp.window)) return { status: "changed" };
    request = {
      taskId: stamp.taskId, kind: stamp.kind, app: i.window.app, window: i.window.title,
      element: { role: i.element.role, name: i.element.name, ...(i.element.secret ? { secret: true } : {}), ...(i.element.withheld ? { withheld: true } : {}) },
      ...(i.value !== undefined ? { value: i.value } : {}),
      ...(i.mode ? { mode: i.mode } : {}),
    };
  }
  const d = i.decide(request);
  if (d.verdict === "deny") return { status: "deny", reason: line(d.reason) };
  if (d.verdict === "confirm" && !stamp.approval) return { status: "needs_confirm", reason: line(d.prompt || d.reason) };
  return { status: "ok" };
}
