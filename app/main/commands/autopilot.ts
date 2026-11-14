/**
 * Autopilot for commands (PLAN.md §2 "Commands (M12)" and "Approvals"; the owner's decisions of 2026-11-12 and
 * 2026-11-14: "Autopilot is where it does everything autonomously without asking me questions, without asking me any
 * permissions, anything"). While Autopilot is the approval mode in force, a command the rules would ask about
 * (decide.ts, held by the flow) announces with its Stop countdown instead: a deletion, a push, a system change, an
 * administrator's command, download-and-run, code Ember can't read, text carried from another window, a task that
 * text tried to steer, a command that reads or prints secrets and one that would outlive the kill switch. Of those:
 * - one that reads or prints secrets runs with its output withheld from the model (the model is told only that it
 *   ran, its end and that its output was kept from it; the command window shows it to the user), so no secret reaches
 *   the model without a question;
 * - one that would outlive Stop says so in its announcement and its audit.
 * It asks only where the organisation's policy or the user's own "ask every command" for that computer says so: both
 * are explicit switches, the user's shown as theirs in Home. It refuses, with no question to put, a command the user's
 * own words for the task rule out ("push, but don't force": their no, said in advance), one that may be something
 * they said no to earlier in the task (the flow), a deletion or a write of what Ember can't resolve, which may be
 * Ember's own audit log, settings or vault (commands-remote-c11-3: the model can name the place plainly and send it
 * again, and Ember judges what it names), and a remote-control verb of a terminal Ember doesn't know, which may act in
 * the user's own terminals.
 *
 * It reads what the classifier found and never changes it: every signal the decision carries counts, its classes and
 * its rules alike, so a finding whose class was lost on the way is still withheld or said by its rule. Tampering with
 * Ember's own safety is the classifier's refusal, which no mode touches. Pure.
 */

import { AUTOPILOT_WORDS } from "../policy/policy";
import { DOWNLOADS_ONLY, outlivesStop } from "./review";
import { SHELL_FAMILY, TERMINAL_VERB_RULE, UNRESOLVED_RULES, type Classification, type CommandCapability, type CommandDecision, type CommandMode, type DangerClass, type Finding, type ShellId } from "./types";

/**
 * A rule of the classifier's that says a command would read or print secrets, whatever class its finding carries:
 * every `secret.*` rule, a path that holds secrets (`path.secret`, `path.secret-tree`), the shell's history and a WSL
 * distro exported whole. A test reads the classifier's source for the rules it files under "secret" and holds this to them.
 */
const SECRET_RULE = /^secret\.|^path\.secret(-|$)|^path\.history$|^wsl\.export$/;
/** Does this rule say the command would read or print secrets? (A remote's script findings carry `in-script:` first.) */
export const readsSecrets = (rule: string): boolean => SECRET_RULE.test(rule.replace(/^in-script:/, ""));

/** Why a command still asks in Autopilot: the organisation's policy, or the user's own switch for that computer. */
export type AutopilotAsk = "organisation" | "user";

/** Why Autopilot refuses a command, having no question to put: the user's own no, or a target Ember can't name. */
export type AutopilotRefusal = "ruled-out" | "unresolved" | "terminal" | "secret-saved";

/**
 * What a remote's gate 2 answers with, among its rules, where its own administrator doesn't allow Autopilot: the PC
 * then asks with the card at once, instead of announcing what that computer will not take for a yes.
 */
export const NO_AUTOPILOT_RULE = "admin.no-autopilot";

/**
 * What a finding, or a rule on its own, says about the command: the organisation's (`admin.*`: a remote's own policy,
 * sent back by its gate 2), that it reads or prints secrets, that it outlives Stop, that Ember can't tell what it does;
 * null for none of these. Only "organisation" still asks in Autopilot; the others say how it is announced.
 */
export function askedOfFinding(f: { cls?: DangerClass; rule: string }): "organisation" | "secret" | "outlives-stop" | "unclear" | null {
  const rule = f.rule.replace(/^in-script:/, "");
  if (rule.startsWith("admin.")) return "organisation";
  if (f.cls === "secret" || readsSecrets(rule)) return "secret";
  if (outlivesStop(rule)) return "outlives-stop";
  if (f.cls === "unclear" || rule.startsWith("unclear.")) return "unclear";
  return null;
}

/** And one that may act in the user's own terminals or editor, which Ember never does (classify.ts toolVerbs). */
const NEVER_RULES: ReadonlySet<string> = new Set([TERMINAL_VERB_RULE]);

/** The rule, and the card's line, of a download-and-run that is handed a secret (handedSecrets). */
export const HANDED_RULE = "secret.handed-to-download";
export const HANDED_SAYS = "Gives a password, key or other secret to code it downloads.";

/** The most words of one command, and variables of one line, that handedSecrets judges: past it, it counts as handed. */
const HANDED_MAX = 32;
/** A variable a shell would expand, wherever it stands in the line: `$NAME`, `${NAME…}`, `$env:NAME`, `%NAME%`. */
const EXPANDS = /\$\{?(?:env:)?([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%|!([A-Za-z_][A-Za-z0-9_]*)!/gi;
/**
 * What makes a word one Ember can't resolve, beside a plain variable: a command or process substitution, arithmetic,
 * a positional or indirect expansion (any `$` a plain variable doesn't account for), another user's home (`~ana`),
 * and in PowerShell a parenthesised expression.
 */
const OPAQUE = (family: string) => (family === "powershell" ? /[$`(]|~[A-Za-z0-9_+-]/ : /[$`]|[<>]\(|~[A-Za-z0-9_+-]/);
/** A variable the line sets where a word begins: `NAME=value`, the value bare or in one pair of quotes. */
const ASSIGNS = /(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]*)/g;
/** A word as a POSIX shell, and as PowerShell, would take it back whole. */
const posixWord = (a: string) => `'${a.replace(/'/g, "'\\''")}'`;
const psWord = (a: string) => `'${a.replace(/'/g, "''")}'`;

/**
 * A command that downloads code and runs it (`npx`, `pnpm dlx`, `pipx run`, `curl … | sh`: the classifier's four
 * rules, DOWNLOADS_ONLY) and hands that code a secret: a word of its own, or an option's value, that names a path
 * holding passwords or keys, or a variable named for one, expanded anywhere in the line. The code can print the key
 * into the output the model reads, or send it anywhere, and "downloads and runs" alone is what Autopilot announces and
 * Assisted's check may clear (modes-y9-5). The classifier judges the package's own line as a command of its own now
 * (commands-remote-r9-3: `npx -y tool ~/.ssh/id_rsa` carries `path.secret`, a token's variable `secret.env`), so most
 * such lines are found twice, and both findings stand; this still finds alone what the line puts in the environment
 * or pipes to a shell. Whether a word is a secret is the classifier's own answer, never a list kept here: each is
 * shown to it (`judge`) as the file a plain reader would open, each variable as one printed, and a finding there that
 * says secrets (readsSecrets) makes this one. It only ever adds a question, in every mode and on every target (the
 * flow and a remote's gate 2 both call it). A word that can't be judged, or more words than it judges, counts as handed; so does a word the
 * classifier couldn't resolve (`$(echo ~/.ssh/id_rsa)`, `~ana/.ssh/id_rsa`, `$D/id_rsa` after `D=~/.ssh`), unless all
 * the line expands is plain variables it sets nowhere itself, whose names were judged above (`--port $PORT`)
 * (modes-y9-x9-2). What the line puts in the environment is handed over as well (`KEY=~/.ssh/id_rsa npx tool`,
 * `env KEY=…`, an `export` earlier in the line): each such value is judged as a word is, its name as a variable is,
 * and a value Ember can't resolve counts as handed (modes-y9-y9-6). Every word is judged, also after one was found:
 * the caller reads the classifier's refusal of a word that points at Ember's own files off `judge` (modes-y9-y9-9).
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
  const names = [...new Set([...command.matchAll(EXPANDS)].map(m => m[1] ?? m[2] ?? m[3]))];
  // Is every word of the line that can't be resolved a plain variable from outside it? Its names stand nowhere bare
  // (an assignment, `read K`, `for f in`: the line sets it, to what Ember doesn't follow), and nothing else expands.
  const plain = (): boolean => {
    // (`$_` is the last command's word or the pipeline's item; PowerShell's own variables are set with the same `$x`
    // that reads them, so only its `$env:` ones count as from outside.)
    const outside = family === "powershell" ? /\$\{?env:[A-Za-z_][A-Za-z0-9_]*\}?(?!\s*[-+*/]?=(?!=))/gi : EXPANDS;
    if (names.length === 0 || names.includes("_") || OPAQUE(family).test(command.replace(outside, ""))) return false;
    if (family === "powershell") return true;
    const fold = family === "posix" ? "" : "i";
    return !names.some(n => new RegExp(`(^|[^$%!{:A-Za-z0-9_])${n}(?![A-Za-z0-9_])`, fold).test(command));
  };
  let handed = names.length > HANDED_MAX || names.some(n => secret(prints(n)));
  // What the line puts in the environment: `NAME=value` at the start of a word (a prefix, `env`'s, `export`'s, `set`'s).
  const sets = [...command.matchAll(ASSIGNS)].map(m => ({ name: m[1], value: m[2].replace(/^(["'])(.*)\1$/s, "$2") }));
  if (sets.length > HANDED_MAX) handed = true;
  for (const { name, value } of sets.slice(0, HANDED_MAX)) {
    if (secret(prints(name)) || (value !== "" && (OPAQUE(family).test(value) || /%[A-Za-z_]/.test(value) || secret(reads(value))))) handed = true;
  }
  for (const at of new Set(downloads.map(f => f.at))) {
    const args = cls.commands[at]?.args ?? [];
    const words = args.filter((a): a is string => a !== null);
    if (words.length > HANDED_MAX || (words.length < args.length && !plain())) handed = true;
    for (const w of words.slice(0, HANDED_MAX)) {
      // The word itself, and what an option carries: `--key=PATH`, `--key:PATH`, `-kPATH`.
      const after = (sep: string) => (w.includes(sep) ? w.slice(w.indexOf(sep) + 1) : "");
      const values = !w.startsWith("-") ? [w] : [after("="), after(":"), /^-[A-Za-z]./.test(w) ? w.slice(2) : ""];
      for (const v of values) if (v !== "" && !v.startsWith("-") && secret(reads(v))) handed = true;
    }
  }
  return handed ? found() : [];
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
   * this." already reads): never announced over their words, it is refused (autopilotRefuses).
   */
  ruledOut?: boolean;
  /** It deletes or writes where Ember can't resolve every word, or from its input (types.ts unnamedTarget). */
  unnamed?: boolean;
}

/**
 * What the command is, read from every signal it carries (the decision's classes and rules, and each finding of the
 * classification, standing or not): the organisation's rule, secrets, outliving Stop, something Ember can't tell; null
 * for none. Only the organisation's asks in Autopilot and keeps a command from Assisted's check (review.ts
 * notReviewable); the rest say how an announcement is made (autopilotCommand, the flow's withheld output).
 */
export function keptQuestion(d: Pick<CommandDecision, "classes" | "rules">, findings: readonly Pick<Finding, "cls" | "rule">[]): "organisation" | "secret" | "outlives-stop" | "unclear" | null {
  const signals = [...d.classes.map(cls => ({ cls, rule: "" })), ...d.rules.map(rule => ({ rule })), ...findings];
  const asked = signals.map(askedOfFinding);
  for (const why of ["organisation", "secret", "outlives-stop", "unclear"] as const) if (asked.includes(why)) return why;
  return null;
}

/** Does the command read or print secrets, by any signal it carries? Its output is then withheld from the model. */
export function printsSecrets(d: Pick<CommandDecision, "classes" | "rules">, findings: readonly Pick<Finding, "cls" | "rule">[]): boolean {
  return [...d.classes.map(cls => ({ cls, rule: "" })), ...d.rules.map(rule => ({ rule })), ...findings].some(f => askedOfFinding(f) === "secret");
}

/** Would the command outlive the kill switch, by any signal it carries? Its announcement and audit then say so. */
export function outlivesKillSwitch(d: Pick<CommandDecision, "rules">, findings: readonly Pick<Finding, "cls" | "rule">[]): boolean {
  return [...d.rules, ...findings.map(f => f.rule)].some(r => outlivesStop(r.replace(/^in-script:/, "")));
}

/**
 * Why `d`, a command that asks, still asks in Autopilot; null when it may be announced instead: the organisation's
 * policy first, then the user's own switch for that computer. Nothing the command is makes it ask (the owner's
 * decision of 2026-11-14).
 */
export function autopilotAsks(d: Pick<CommandDecision, "classes" | "rules">, o: AutopilotInput): AutopilotAsk | null {
  if (o.mode === "ask" || o.askEvery === "admin" || d.rules.includes("admin.ask") || [...d.rules, ...o.findings.map(f => f.rule)].some(r => askedOfFinding({ rule: r }) === "organisation")) return "organisation";
  if (o.userAskEvery || o.askEvery === "user" || o.askEvery === "tool" || d.rules.includes("user.ask-every")) return "user";
  return null;
}

/**
 * Why Autopilot refuses `d` instead of announcing it (it has no question to put): the user's own words for the task
 * rule it out, what it deletes or writes is what Ember can't resolve (UNRESOLVED_RULES), or it may act in the user's
 * own terminals (NEVER_RULES); null for none.
 */
export function autopilotRefuses(d: Pick<CommandDecision, "rules">, o: Pick<AutopilotInput, "findings" | "ruledOut" | "unnamed">): AutopilotRefusal | null {
  if (o.ruledOut) return "ruled-out";
  const rules = [...d.rules, ...o.findings.map(f => f.rule)].map(r => r.replace(/^in-script:/, ""));
  if (rules.some(r => NEVER_RULES.has(r))) return "terminal";
  if (o.unnamed || rules.some(r => UNRESOLVED_RULES.has(r))) return "unresolved";
  return null;
}

/** What the model is told of Autopilot's refusal, by its reason (never a word of the command). */
export const AUTOPILOT_REFUSES: Readonly<Record<AutopilotRefusal, string>> = {
  "ruled-out": "The user's own words for this task rule this command out. Don't try another way; tell the user in finish_task.",
  terminal: "It may act in the user's own terminals or editor, which Ember never does. Don't try another way; tell the user in finish_task.",
  unresolved: "It may delete, change or read something Ember can't name (a variable, a substitution, a list it reads or another user's home), which could be Ember's own records. Write the command again with each place named plainly, so Ember can judge it.",
  "secret-saved": "It reads passwords or keys and saves them to a file, where a later command would show them to you. Don't try another way; tell the user in finish_task.",
};

/** What each class of command does, in Ember's own words, for the announcement: never a word of the command. */
const DOES: Readonly<Record<DangerClass, string>> = {
  destroy: "deletes or overwrites data",
  publish: "sends or publishes something",
  "remote-delete": "deletes something in source control or a remote service",
  system: "changes the system or runs as an administrator",
  escape: "downloads and runs code",
  secret: "shows passwords or keys",
  unclear: "does something Ember can't tell",
  unknown: "runs a program Ember doesn't know",
};

/** The card's line under an announcement Autopilot made, and what its decision's rules end with. */
export const AUTOPILOT_LINE = "Autopilot is on, so Ember didn't ask first.";
export const AUTOPILOT_RULE = "autopilot";
/** The card's line of an announced command whose output is kept from the model, and of one that outlives Stop. */
export const WITHHELD_LINE = "Its output may hold passwords or keys, so Ember keeps it from the AI model: only you see it here.";
export const OUTLIVES_LINE = "Stop won't reach what this command leaves running.";

/**
 * The decision for a command that asks, in Autopilot: announced with its Stop countdown, saying the kind of command
 * (its most serious class; that it keeps running after Stop first) and never its text, or null where it still asks
 * (autopilotAsks) or is refused (autopilotRefuses). The card shows the exact command and what the rules found, as an
 * announcement's always does, and says when its output is kept from the model or Stop won't reach it.
 */
export function autopilotCommand(d: CommandDecision, o: AutopilotInput): CommandDecision | null {
  if (d.verdict !== "ask" || autopilotAsks(d, o) !== null || autopilotRefuses(d, o) !== null) return null;
  const why = d.reason.replace(/^It asks first: /, "").replace(/[.\s]+$/, "");
  const secret = printsSecrets(d, o.findings);
  const outlives = outlivesKillSwitch(d, o.findings);
  const does = outlives ? "keeps running after Stop" : secret ? DOES.secret : d.classes.length ? DOES[d.classes[0]] : "";
  return {
    ...d, verdict: "announce",
    requested: { intent: AUTOPILOT_RULE, announce: `Running a command${does ? ` that ${does}` : ""}, ${AUTOPILOT_WORDS}` },
    rules: [...new Set([...d.rules, AUTOPILOT_RULE])],
    reason: `Autopilot was on, so Ember didn't ask${why ? ` (${why})` : ""}.`,
    says: [...d.says, ...(secret ? [WITHHELD_LINE] : []), ...(outlives ? [OUTLIVES_LINE] : []), AUTOPILOT_LINE],
    ...(secret ? { withheld: true } : {}),
    ...(outlives ? { outlivesStop: true } : {}),
  };
}
