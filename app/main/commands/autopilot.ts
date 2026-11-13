/**
 * Autopilot for commands (PLAN.md §2 "Commands (M12)" and "Approvals", §10 "Settled" (3); owner decision of
 * 2026-11-12). While Autopilot is the approval mode in force, a command the rules would ask about (decide.ts, held by
 * the flow) announces with its Stop countdown instead: a deletion, a push, a system change, an administrator's command,
 * download-and-run, text carried from another window, a task that text tried to steer. It still asks for exactly
 * these, each because it protects something Autopilot keeps:
 * - a command that would read or print secrets, so that no secret reaches the model;
 * - a command that would outlive the kill switch, so that Stop stops everything;
 * - a command Ember can't tell the effect of (the classifier's "unclear", and a program or a tool's command it doesn't
 *   know, "unknown": the closed default), which may be either of those;
 * - a command the user's own words for the task rule out ("push, but don't force", "don't delete src/"): their no,
 *   said in advance, which Autopilot keeps as it keeps a no to a question;
 * - what the organisation's policy or the user's own "ask every command" for that computer requires.
 *
 * It asks by what the classifier found, which this module only reads: every signal the decision carries counts, its
 * classes and its rules alike, so a finding whose class was lost on the way still asks by its rule, and a rule the
 * classifier gains later is held until it is known not to matter here (outlivesStop reads the escape rules that way
 * round). Tampering with Ember's own safety is the classifier's refusal, which no mode touches. Pure.
 */

import { AUTOPILOT_WORDS } from "../policy/policy";
import { DOWNLOADS_ONLY, outlivesStop } from "./review";
import { SHELL_FAMILY, type Classification, type CommandCapability, type CommandDecision, type CommandMode, type DangerClass, type Finding, type ShellId } from "./types";

/**
 * A rule of the classifier's that says a command would read or print secrets, whatever class its finding carries:
 * every `secret.*` rule, a path that holds secrets (`path.secret`, `path.secret-tree`), the shell's history and a WSL
 * distro exported whole. A test reads the classifier's source for the rules it files under "secret" and holds this to them.
 */
const SECRET_RULE = /^secret\.|^path\.secret(-|$)|^path\.history$|^wsl\.export$/;
/** Does this rule say the command would read or print secrets? (A remote's script findings carry `in-script:` first.) */
export const readsSecrets = (rule: string): boolean => SECRET_RULE.test(rule.replace(/^in-script:/, ""));

/** Why a command still asks in Autopilot. */
export type AutopilotAsk = "organisation" | "user" | "ruled-out" | "secret" | "outlives-stop" | "unclear";

/**
 * What a remote's gate 2 answers with, among its rules, where its own administrator doesn't allow Autopilot: the PC
 * then asks with the card at once, instead of announcing what that computer will not take for a yes.
 */
export const NO_AUTOPILOT_RULE = "admin.no-autopilot";

/**
 * What a finding, or a rule on its own, says that Autopilot must still ask about; null: it may be announced. A rule
 * that is an administrator's (`admin.*`: a remote's own policy, sent back by its gate 2) is the organisation's.
 */
export function askedOfFinding(f: { cls?: DangerClass; rule: string }): Extract<AutopilotAsk, "organisation" | "secret" | "outlives-stop" | "unclear"> | null {
  const rule = f.rule.replace(/^in-script:/, "");
  if (rule.startsWith("admin.")) return "organisation";
  if (f.cls === "secret" || readsSecrets(rule)) return "secret";
  if (outlivesStop(rule)) return "outlives-stop";
  // A program, or a tool's command, the classifier doesn't know (the closed default) is one Ember can't tell the effect
  // of either: it may read secrets or outlive Stop, so it asks as "unclear" does, unless the user's own words named it
  // (then the rules announced it before Autopilot was asked).
  if (f.cls === "unclear" || f.cls === "unknown" || rule.startsWith("unclear.") || rule.startsWith("unknown.")) return "unclear";
  return null;
}

/** The rule, and the card's line, of a download-and-run that is handed a secret (handedSecrets). */
export const HANDED_RULE = "secret.handed-to-download";
export const HANDED_SAYS = "Gives a password, key or other secret to code it downloads.";

/** The most words of one command, and variables of one line, that handedSecrets judges: past it, it counts as handed. */
const HANDED_MAX = 32;
/** A variable a shell would expand, wherever it stands in the line: `$NAME`, `${NAME…}`, `$env:NAME`, `%NAME%`. */
const EXPANDS = /\$\{?(?:env:)?([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/gi;
/** A word as a POSIX shell, and as PowerShell, would take it back whole. */
const posixWord = (a: string) => `'${a.replace(/'/g, "'\\''")}'`;
const psWord = (a: string) => `'${a.replace(/'/g, "''")}'`;

/**
 * A command that downloads code and runs it (`npx`, `pnpm dlx`, `pipx run`, `curl … | sh`: the classifier's four
 * rules, DOWNLOADS_ONLY) and hands that code a secret: a word of its own, or an option's value, that names a path
 * holding passwords or keys, or a variable named for one, expanded anywhere in the line. The classifier says only
 * "downloads and runs" of such a line (it doesn't judge the downloaded program's arguments), which Autopilot
 * announces and Assisted's check may clear; the code can print the key into the output the model reads, or send it
 * anywhere (modes-y9-5). Whether a word is a secret is the classifier's own answer, never a list kept here: each is
 * shown to it (`judge`) as the file a plain reader would open, each variable as one printed, and a finding there that
 * says secrets (readsSecrets) makes this one. It only ever adds a question, in every mode and on every target (the
 * flow and a remote's gate 2 both call it); once the classifier judges such a line itself, this finds the same thing
 * a second time. A word that can't be judged, or more words than it judges, counts as handed.
 */
export function handedSecrets(cls: Pick<Classification, "commands" | "findings">, command: string, shell: ShellId, judge: (text: string) => readonly Pick<Finding, "cls" | "rule">[]): Finding[] {
  const downloads = cls.findings.filter(f => DOWNLOADS_ONLY.has(f.rule.replace(/^in-script:/, "")));
  if (downloads.length === 0) return [];
  const family = SHELL_FAMILY[shell];
  const reads = (path: string) => (family === "powershell" ? `Get-Content -LiteralPath ${psWord(path)}` : family === "cmd" ? `type "${path.replace(/"/g, "")}"` : `cat -- ${posixWord(path)}`);
  const prints = (name: string) => (family === "powershell" ? `Write-Output $env:${name}` : family === "cmd" ? `echo %${name}%` : `echo "$${name}"`);
  const secret = (text: string): boolean => {
    try { return judge(text).some(f => f.cls === "secret" || readsSecrets(f.rule)); } catch { return true; } // not judged: it asks
  };
  const first = downloads[0];
  const found = (): Finding[] => [{ cls: "secret", rule: HANDED_RULE, says: HANDED_SAYS, program: first.program, objects: [], widening: [], at: first.at }];
  const names = [...new Set([...command.matchAll(EXPANDS)].map(m => m[1] ?? m[2]))];
  if (names.length > HANDED_MAX || names.some(n => secret(prints(n)))) return found();
  for (const at of new Set(downloads.map(f => f.at))) {
    const words = (cls.commands[at]?.args ?? []).filter((a): a is string => a !== null);
    if (words.length > HANDED_MAX) return found();
    for (const w of words) {
      // The word itself, and what an option carries: `--key=PATH`, `-kPATH`.
      const values = !w.startsWith("-") ? [w] : [w.includes("=") ? w.slice(w.indexOf("=") + 1) : "", /^-[A-Za-z]./.test(w) ? w.slice(2) : ""];
      if (values.some(v => v !== "" && !v.startsWith("-") && secret(reads(v)))) return found();
    }
  }
  return [];
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
  /**
   * The user's own words for the task rule this command out (intent.ts ruledOut, which the card's "You didn't ask for
   * this." already reads): never announced over their words, it asks.
   */
  ruledOut?: boolean;
}

/**
 * Why `d`, a command that asks, still asks in Autopilot; null when it may be announced instead. The organisation's
 * policy first, then the user's own switch and their own words against it, then what the command is: secrets before
 * outliving Stop before unclear.
 */
export function autopilotAsks(d: Pick<CommandDecision, "classes" | "rules">, o: AutopilotInput): AutopilotAsk | null {
  if (o.mode === "ask" || o.askEvery === "admin" || d.rules.includes("admin.ask")) return "organisation";
  if (o.userAskEvery || o.askEvery === "user" || o.askEvery === "tool" || d.rules.includes("user.ask-every")) return "user";
  if (o.ruledOut) return "ruled-out";
  const signals = [...d.classes.map(cls => ({ cls, rule: "" })), ...d.rules.map(rule => ({ rule })), ...o.findings].map(askedOfFinding);
  for (const why of ["organisation", "secret", "outlives-stop", "unclear"] as const) if (signals.includes(why)) return why;
  return null;
}

/** What each class of command does, in Ember's own words, for the announcement: never a word of the command. */
const DOES: Readonly<Record<DangerClass, string>> = {
  destroy: "deletes or overwrites data",
  publish: "sends or publishes something",
  "remote-delete": "deletes something in source control or a remote service",
  system: "changes the system or runs as an administrator",
  escape: "downloads and runs code",
  // (These three always ask: they are never announced.)
  secret: "touches passwords or keys",
  unclear: "does something Ember can't tell",
  unknown: "runs a program Ember doesn't know",
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
