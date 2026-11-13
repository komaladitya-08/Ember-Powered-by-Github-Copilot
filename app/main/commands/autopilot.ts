/**
 * Autopilot for commands (PLAN.md §2 "Commands (M12)" and "Approvals", §10 "Settled" (3); owner decision of
 * 2026-11-12). While Autopilot is the approval mode in force, a command the rules would ask about (decide.ts, held by
 * the flow) announces with its Stop countdown instead: a deletion, a push, a system change, an administrator's command,
 * download-and-run, text carried from another window, a task that text tried to steer. It still asks for exactly
 * these, each because it protects something Autopilot keeps:
 * - a command that would read or print secrets, so that no secret reaches the model;
 * - a command that would outlive the kill switch, so that Stop stops everything;
 * - a command Ember can't tell the effect of (the classifier's "unclear"), which may be either of those;
 * - what the organisation's policy or the user's own "ask every command" for that computer requires.
 *
 * It asks by what the classifier found, which this module only reads: every signal the decision carries counts, its
 * classes and its rules alike, so a finding whose class was lost on the way still asks by its rule, and a rule the
 * classifier gains later is held until it is known not to matter here (outlivesStop reads the escape rules that way
 * round). Tampering with Ember's own safety is the classifier's refusal, which no mode touches. Pure.
 */

import { AUTOPILOT_WORDS } from "../policy/policy";
import { outlivesStop } from "./review";
import type { CommandCapability, CommandDecision, CommandMode, DangerClass, Finding } from "./types";

/**
 * A rule of the classifier's that says a command would read or print secrets, whatever class its finding carries:
 * every `secret.*` rule, a path that holds secrets (`path.secret`, `path.secret-tree`), the shell's history and a WSL
 * distro exported whole. A test reads the classifier's source for the rules it files under "secret" and holds this to them.
 */
const SECRET_RULE = /^secret\.|^path\.secret(-|$)|^path\.history$|^wsl\.export$/;
/** Does this rule say the command would read or print secrets? (A remote's script findings carry `in-script:` first.) */
export const readsSecrets = (rule: string): boolean => SECRET_RULE.test(rule.replace(/^in-script:/, ""));

/** Why a command still asks in Autopilot. */
export type AutopilotAsk = "organisation" | "user" | "secret" | "outlives-stop" | "unclear";

/** What a finding, or a rule on its own, says that Autopilot must still ask about; null: it may be announced. */
export function askedOfFinding(f: { cls?: DangerClass; rule: string }): Extract<AutopilotAsk, "secret" | "outlives-stop" | "unclear"> | null {
  const rule = f.rule.replace(/^in-script:/, "");
  if (f.cls === "secret" || readsSecrets(rule)) return "secret";
  if (outlivesStop(rule)) return "outlives-stop";
  if (f.cls === "unclear" || rule.startsWith("unclear.")) return "unclear";
  return null;
}

/** What autopilotAsks reads beside the decision. */
export interface AutopilotInput {
  /** Every finding of the classification, standing or not: a finding the decision dropped still says what the command is. */
  findings: readonly Pick<Finding, "cls" | "rule">[];
  /** The organisation's commands mode for this kind of target. */
  mode: CommandMode;
  /** Why every command asks on this target, as its service says (root is no reason to ask in Autopilot). */
  askEvery: CommandCapability["askEvery"];
  /** The user's own "ask every command" for this computer (a distro another program owns and a project folder count). */
  userAskEvery: boolean;
}

/**
 * Why `d`, a command that asks, still asks in Autopilot; null when it may be announced instead. The organisation's
 * policy first, then the user's own switch, then what the command is: secrets before outliving Stop before unclear.
 */
export function autopilotAsks(d: Pick<CommandDecision, "classes" | "rules">, o: AutopilotInput): AutopilotAsk | null {
  if (o.mode === "ask" || o.askEvery === "admin" || d.rules.includes("admin.ask")) return "organisation";
  if (o.userAskEvery || o.askEvery === "user" || o.askEvery === "tool" || d.rules.includes("user.ask-every")) return "user";
  const signals = [...d.classes.map(cls => ({ cls, rule: "" })), ...d.rules.map(rule => ({ rule })), ...o.findings].map(askedOfFinding);
  for (const why of ["secret", "outlives-stop", "unclear"] as const) if (signals.includes(why)) return why;
  return null;
}

/** What each class of command does, in Ember's own words, for the announcement: never a word of the command. */
const DOES: Readonly<Record<DangerClass, string>> = {
  destroy: "deletes or overwrites data",
  publish: "sends or publishes something",
  "remote-delete": "deletes something in source control or a remote service",
  system: "changes the system or runs as an administrator",
  escape: "downloads and runs code",
  // (These two always ask: they are never announced.)
  secret: "touches passwords or keys",
  unclear: "does something Ember can't tell",
};

/** The card's line under an announcement Autopilot made, and what its decision's rules end with. */
export const AUTOPILOT_LINE = "Autopilot is on, so Ember didn't ask first.";
export const AUTOPILOT_RULE = "autopilot";

/**
 * The decision for a command that asks, in Autopilot: announced with its Stop countdown, saying the kind of command
 * (its most serious class) and never its text, or null where it still asks (autopilotAsks). The card shows the exact
 * command and what the rules found, as an announcement's always does.
 */
export function autopilotCommand(d: CommandDecision, o: AutopilotInput): CommandDecision | null {
  if (d.verdict !== "ask" || autopilotAsks(d, o) !== null) return null;
  const why = d.reason.replace(/^It asks first: /, "").replace(/[.\s]+$/, "");
  return {
    ...d, verdict: "announce",
    requested: { intent: AUTOPILOT_RULE, announce: `Running a command${d.classes.length ? ` that ${DOES[d.classes[0]]}` : ""}, ${AUTOPILOT_WORDS}` },
    rules: [...new Set([...d.rules, AUTOPILOT_RULE])],
    reason: `Autopilot was on, so Ember didn't ask${why ? ` (${why})` : ""}.`,
    says: [...d.says, AUTOPILOT_LINE],
  };
}
