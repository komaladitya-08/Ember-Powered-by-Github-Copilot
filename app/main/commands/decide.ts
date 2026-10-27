/**
 * The command decision (design §3.8.2, OWNER DECISION 4): run, announce, ask or refuse, by eleven rules in order, the
 * first that applies deciding. Ember's own refusals and the administrator's "off" refuse; root or an elevated token,
 * the administrator's "ask", the user's "ask every", a tainted task and carried text ask even for ordinary commands;
 * an ordinary command runs; a dangerous one the user's own words named exactly announces; everything else asks. The
 * card's lines (§3.8.4) come in their fixed order. `reason` goes to the audit journal, which keeps it, so it never
 * holds a path or the command's text (only `command` and `cwd` are reduced to sizes there). Pure.
 */

import type { ClassificationExtra } from "./classify";
import type { CommandDecision, DangerClass, DecideInput, Finding } from "./types";
import { matchIntent, mentioned } from "./intent";
import { joinList } from "./words";

/** The classes in the card's order (§3.8.4), which is also "most serious first". */
export const CLASS_ORDER: readonly DangerClass[] = ["destroy", "publish", "remote-delete", "secret", "system", "escape", "unclear"];

/** The card's fixed lines (§3.8.4). */
export const LINES = {
  rootPosix: "Commands here run as root (the administrator), so each one asks first.",
  rootWindows: "Ember is running as an administrator here, so each command asks first.",
  adminAsk: "Your organisation asks you to approve every command.",
  userAsk: "You asked Ember to check every command with you.",
  toolDistro: "Podman uses this distro: Ember asks before every command here.",
  unclear: "Ember can't tell exactly what this does.",
  tainted: "I'm checking each step: a step came up that you didn't ask for.",
  unasked: "You didn't ask for this.",
  windows: "This can reach your Windows files.",
} as const;

/** A short, path-free reason per class for the audit (the card has the full lines). */
const CLASS_REASON: Readonly<Record<DangerClass, string>> = {
  destroy: "it deletes or overwrites data",
  publish: "it sends or publishes something",
  "remote-delete": "it deletes something in source control or a remote service",
  secret: "it touches passwords, keys or other secrets",
  system: "it changes the system or runs with privileges",
  escape: "it downloads and runs code or keeps running after Ember stops",
  unclear: "Ember can't tell exactly what it does",
};

/** How long Allow stays disarmed for a dangerous or policy-wide ask, and for an ordinary command asked by policy only. */
export const ARM_ASK_MS = 1500;
export const ARM_POLICY_MS = 500;

const offWords = (kind: DecideInput["binding"]["kind"]): string =>
  kind === "wsl" ? "in WSL" : kind === "ssh" ? "on computers reached over SSH" : "on this computer";

/** A distro another program owns (Podman's machine): every command asks there (§2.2). */
const toolDistro = (i: DecideInput): boolean => i.binding.kind === "wsl" && /^wsl:podman-machine/i.test(i.binding.id);

/** Whether a WSL command reaches the Windows side (§3.8.2's Windows line), when the classification didn't say. */
function reachesWindows(i: DecideInput): boolean {
  const extra = i.cls as Partial<ClassificationExtra>;
  if (typeof extra.windowsReach === "boolean") return extra.windowsReach;
  const mount = (i.facts.wsl?.mountRoot ?? "/mnt").replace(/\/+$/, "");
  return i.cls.commands.some(c =>
    /\.(exe|com|bat|cmd)$/i.test(c.program) || c.family !== "posix"
    || c.args.some(a => a !== null && (a === mount || a.startsWith(`${mount}/`) || /^[A-Za-z]:[\\/]|^\\\\/.test(a))));
}

/** The findings' lines in the card's order: each class's words, unclear's general line first. */
function findingLines(F: readonly Finding[]): string[] {
  const out: string[] = [];
  for (const cls of CLASS_ORDER) {
    const fs = F.filter(f => f.cls === cls);
    if (fs.length === 0) continue;
    // A script Ember can't read all of says so in its own line (scripts.ts unreadPart): the command itself is clear.
    if (cls === "unclear" && fs.some(f => !f.widening.includes("in-script"))) out.push(LINES.unclear);
    for (const f of fs) if (f.says && !out.includes(f.says)) out.push(f.says);
  }
  return out;
}

const uniq = <T>(xs: readonly T[]): T[] => xs.filter((x, k) => xs.indexOf(x) === k);

/** Decides one command (§3.8.2): rules 1-11 in order, the card's lines, the arm time. */
export function decideCommand(i: DecideInput): CommandDecision {
  const cls = i.cls;
  // 1. Ember's own refusal (D4.5).
  if (cls.refuse) {
    return { verdict: "refuse", reason: cls.refuse.says, classes: [], rules: [cls.refuse.rule], says: [cls.refuse.says], unasked: false, armMs: 0 };
  }
  // 2. The administrator turned commands off here.
  if (i.mode === "off") {
    const says = `Your organisation has turned off commands ${offWords(i.binding.kind)}.`;
    return { verdict: "refuse", reason: says, classes: [], rules: ["admin.off"], says: [says], unasked: false, armMs: 0 };
  }
  // 3. Overwrites of paths the target says don't exist are dropped.
  const F = cls.findings.filter(f => !(f.ifExists !== undefined && i.paths.get(f.ifExists)?.exists === false));
  const windowsLine = i.binding.kind === "wsl" && reachesWindows(i) ? [LINES.windows] : [];
  const classes = CLASS_ORDER.filter(c => F.some(f => f.cls === c));
  const findingRules = uniq(F.map(f => f.rule));
  const privileged = i.facts.privileged;
  const policyAsk = privileged || i.mode === "ask" || i.userAskEvery || i.tainted || i.carried !== null;
  // 9. An ordinary command, nothing asking: it runs.
  if (!policyAsk && F.length === 0) {
    return { verdict: "run", reason: "An ordinary command.", classes: [], rules: [], says: windowsLine, unasked: false, armMs: 0 };
  }
  // 10. The user's own words asked for exactly this.
  if (!policyAsk && i.userWords.trim() !== "") {
    const extra = cls as Partial<ClassificationExtra>;
    const m = matchIntent({ ...cls, findings: F }, i.userWords, {
      os: i.facts.os, home: i.facts.home, cwd: typeof extra.cwd === "string" ? extra.cwd : "", ember: i.facts.ember,
      downloaded: new Set<string>(), ...(i.facts.wsl ? { wsl: { mountRoot: i.facts.wsl.mountRoot, windows: i.facts.wsl.windows } } : {}),
      git: i.git,
    });
    if (m) {
      return {
        verdict: "announce", reason: `The user's own words asked for this (${m.intent}).`, classes, rules: findingRules,
        says: [...findingLines(F), ...windowsLine], requested: { intent: m.intent, announce: m.announce }, unasked: false, armMs: 0,
      };
    }
  }
  // 4-8 and 11: it asks.
  const windows = i.facts.os === "win32" || i.binding.shellOs === "win32";
  const lines: string[] = [];
  const reasons: string[] = [];
  const rules: string[] = [];
  if (privileged) { lines.push(windows ? LINES.rootWindows : LINES.rootPosix); reasons.push("commands here run as an administrator"); rules.push("privileged"); }
  if (i.mode === "ask") { lines.push(LINES.adminAsk); reasons.push("the organisation asks for every command"); rules.push("admin.ask"); }
  if (i.userAskEvery) { lines.push(toolDistro(i) ? LINES.toolDistro : LINES.userAsk); reasons.push(toolDistro(i) ? "another program owns this distro" : "the user asked to check every command"); rules.push("user.ask-every"); }
  lines.push(...findingLines(F));
  for (const c of classes) reasons.push(CLASS_REASON[c]);
  rules.push(...findingRules);
  if (i.carried) {
    lines.push(`This command may carry text Ember read in ${joinList(i.carried.from)}.`);
    reasons.push("it may carry text Ember read elsewhere in the task");
    rules.push("carried");
  }
  if (i.tainted) { lines.push(LINES.tainted); reasons.push("an earlier step in the task wasn't the user's"); rules.push("tainted"); }
  const unasked = F.length > 0 && !mentioned(F, i.userWords);
  if (unasked) lines.push(LINES.unasked);
  lines.push(...windowsLine);
  const allClasses: DangerClass[] = privileged && !classes.includes("system")
    ? CLASS_ORDER.filter(c => c === "system" || classes.includes(c))
    : classes;
  const onlyPolicy = F.length === 0 && !privileged && !i.tainted && i.carried === null;
  return {
    verdict: "ask",
    reason: `It asks first: ${reasons.join("; ")}.`,
    classes: allClasses,
    rules: uniq(rules),
    says: uniq(lines),
    unasked,
    armMs: onlyPolicy ? ARM_POLICY_MS : ARM_ASK_MS,
  };
}
