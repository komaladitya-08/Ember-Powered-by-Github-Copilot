/**
 * What the user turned down in one task, kept so that it isn't tried again (CLAUDE.md "After a deny or “Not now”, Ember
 * never retries or works around it"; round nine's tasks-approvals-r9-1 and commands-remote-r9-8). Until this, that rule
 * was only words to the model: the same click sent again in its next reply was asked again (and done on a yes), a
 * refused command's card came up a second and a third time, and where a mode reviews or announces instead of asking,
 * the repeat would have gone ahead. A worker keeps one of these for its task and the command flow reads the same one.
 *
 * Two standings. "refused": the user said no (a "Not now", a deny, a Stop during a command's countdown); it holds for
 * the rest of the task, and the way back is a new request, which is a new task. "waiting": the question ran out of time
 * unanswered, which is nobody's no (cause 10 of the investigation of the owner's report of 2026-11-12) but must not nag
 * either: the step isn't asked about again until the user next says something to the task (`userSpoke`). A repeat of
 * either is refused without a question, never reviewed and never announced. This only tightens: nothing here lets a
 * step go ahead. Plain data and pure functions, no Electron.
 */

import type { ActionKind } from "./policy";
import type { DangerClass, Finding } from "../commands/types";
import type { OS } from "../../shared/shortcuts";

/** How a step stands with the user: turned down, or asked about and left unanswered. */
export type Standing = "refused" | "waiting";

/**
 * Kinds that are one step to the user whichever way Ember takes it: a click by accessibility, with the borrowed mouse
 * or as a toggle presses the same control, and text goes into the same field typed or set.
 */
const WAY: Readonly<Record<ActionKind, string>> = {
  read: "read", click: "press", cursor_click: "press", toggle: "press", text: "type", cursor_text: "type", select: "choose", value: "set",
  keys: "keys", scroll: "scroll", setting: "setting", open_app: "open",
};

/** An app step as its question was about it. */
export interface StepAsked {
  kind: ActionKind;
  /** The worker's stepKey(): the step's window and its element's role and name. */
  key: string;
  /** The element has a role (something is known to be acted on): only then can keys count as pressing it. */
  named: boolean;
  /** The keys pressed, the app opened or the setting changed (what the step is, where no element says it). */
  value?: string;
  /** Keys that work the control that has the keyboard (Enter, Space): the same step as a click on it. */
  activates?: boolean;
}

/**
 * The names a step goes by in a task's refusals: one refused under any of them is the same step. A control is one step
 * however it is pressed (so Enter on a refused button is that button's click, and the other way round); a field is one
 * step whatever would be typed into it (typing other words there is working around the no); keys are the step they
 * are in the element that has the keyboard; an app opened or a setting changed is named by itself, not by a window.
 */
export function stepNames(s: StepAsked): string[] {
  const value = (s.value ?? "").trim().toLowerCase();
  if (s.kind === "open_app" || s.kind === "setting") return [`${WAY[s.kind]}\n${value}`];
  if (s.kind === "keys") return [`keys\n${s.key}\n${value}`, ...(s.activates && s.named ? [`press\n${s.key}`] : [])];
  return [`${WAY[s.kind]}\n${s.key}`];
}

/**
 * What a risky step does, by the words policy found it risky for (Decision.about, the control's name, its reason):
 * sending, deleting, paying… After a no, a later risky step of a kind the user turned down is that step done another way
 * (Ctrl+Enter or "Send Now" for a refused Send, the Delete key or "Remove" for a refused "Move to Trash", Send in a
 * second compose window), refused for the rest of the task without a question, a check or an announcement (modes-x9s-3).
 */
const DOES: readonly (readonly [string, RegExp])[] = [
  ["send", /\b(send|sent|post|submit|publish|share|reply|forward|upload|tweet|invite)/i],
  ["delete", /\b(delete|remove|trash|erase|discard|wipe|destroy|format|uninstall|purge|unsubscribe)/i],
  ["pay", /\b(pay|buy|purchase|order|checkout|check out|donate|transfer|subscribe|billing)/i],
  ["install", /\b(install|update|upgrade|download)/i],
  ["sign-out", /\b(sign out|log out|logout|sign off|log off|disconnect)/i],
  ["overwrite", /\b(overwrite|replace|save|revert|reset|restore)/i],
  ["close", /\b(close|quit|exit|leave|block|ban)/i],
  ["security", /\b(security|protection|firewall|password|permission|privacy|warning|unsafe)/i],
];
const RISK = "risk\n";
/** A risky step whose kind Ember can't tell (another language, a bare "hard to undo"): it counts as every kind. */
const ANY_RISK = `${RISK}*`;
/**
 * The names a risky step goes by besides its own (stepNames): one for each thing it does; where its words say none,
 * ANY_RISK when policy named what makes it risky (`named`: Decision.about, a label in another language), else none (a
 * borrow that is risky only because it takes the mouse and keyboard).
 */
export function riskNames(words: string, named = true): string[] {
  const kinds = DOES.filter(([, re]) => re.test(words)).map(([k]) => `${RISK}${k}`);
  return kinds.length ? kinds : named ? [ANY_RISK] : [];
}

/** One thing a dangerous command does, and to what: the class, and the path, branch, package… or else the rule. */
export interface CommandAct {
  cls: DangerClass;
  kind: string;
  /** As written (for a path that could be resolved: its resolved form). */
  text: string;
  /** A resolved path's parts, up to its first wildcard: what lies in it, or holds it, is acted on too. */
  path?: string[];
}

/** A command as its card was about it. */
export interface CommandAsked {
  /** commandSha256(): the bytes, shell, folder and computer an approval binds to. */
  sha256: string;
  cwd: string;
  command: string;
  acts: CommandAct[];
}

const WILDCARD = /[*?[\]{}]/;

/**
 * What a command's findings act on (`findings`: those that stand, as the decision reads them). A finding with objects
 * gives one act for each; where no finding names an object, each gives its rule (`shutdown`, `git clean`), so a
 * wrapper's bare finding (sudo's) beside one that names something doesn't make every such command the same.
 */
export function commandActs(findings: readonly Finding[], os: OS): CommandAct[] {
  const fold = (s: string) => (os === "linux" ? s : s.toLowerCase());
  const acts: CommandAct[] = [];
  const named = findings.some(f => f.objects.length > 0);
  for (const f of findings) {
    if (!named) { acts.push({ cls: f.cls, kind: "rule", text: f.rule }); continue; }
    for (const o of f.objects) {
      if ((o.kind === "path" || o.kind === "glob") && o.resolved !== undefined) {
        const parts = fold(o.resolved).split(os === "win32" ? /[\\/]+/ : /\/+/).filter(p => p && p !== ".");
        const cut = parts.findIndex(p => WILDCARD.test(p));
        acts.push({ cls: f.cls, kind: "path", text: fold(o.resolved), path: o.kind === "glob" && cut >= 0 ? parts.slice(0, cut) : parts });
      } else {
        acts.push({ cls: f.cls, kind: o.kind, text: o.text.trim() });
      }
    }
  }
  return acts;
}

/** Is one path the other, inside it, or around it? */
function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameAct(a: CommandAct, b: CommandAct): boolean {
  if (a.cls !== b.cls) return false;
  if (a.path && b.path) return overlaps(a.path, b.path);
  return a.kind === b.kind && a.text === b.text;
}

/**
 * Is `now` the command the user turned down (`before`), sent again or reworded? The same bytes (in any shell, from the
 * same folder), or the same kind of danger to the same thing: `find build -delete` after a refused `rm -rf build`, a
 * deletion inside the folder or of the folder around it. A different danger, or the same one to something else, isn't.
 */
export function sameCommand(before: CommandAsked, now: CommandAsked): boolean {
  if (before.sha256 === now.sha256) return true;
  if (before.cwd === now.cwd && before.command.trim() === now.command.trim()) return true;
  return before.acts.some(a => now.acts.some(b => sameAct(a, b)));
}

/** One task's refusals. */
export class Refusals {
  private steps = new Map<string, Standing>();
  private commands: { asked: CommandAsked; standing: Standing }[] = [];
  /** The user turned down turning commands on for this task's computer (the first-use card): asked once, as any step. */
  private consent: Standing | null = null;

  /** A question about an app step ended without a yes. A no is never weakened to "waiting" by a later timeout. */
  noteStep(names: readonly string[], standing: Standing): void {
    for (const n of names) if (this.steps.get(n) !== "refused") this.steps.set(n, standing);
  }

  /** How an app step stands: refused under any of its names, else waiting under any, else null (never asked, or allowed). */
  step(names: readonly string[]): Standing | null {
    const found = names.flatMap(n => this.standingOf(n));
    return found.includes("refused") ? "refused" : found.includes("waiting") ? "waiting" : null;
  }

  /** How one name stands; a kind of risky step also by a risky step of no known kind, and one of no known kind by any. */
  private standingOf(n: string): (Standing | undefined)[] {
    if (!n.startsWith(RISK)) return [this.steps.get(n)];
    if (n === ANY_RISK) return [...this.steps].filter(([k]) => k.startsWith(RISK)).map(([, v]) => v);
    return [this.steps.get(n), this.steps.get(ANY_RISK)];
  }

  /** A command's card ended without a yes, or the user stopped its countdown. */
  noteCommand(asked: CommandAsked, standing: Standing): void {
    this.commands.push({ asked, standing });
  }

  /** How a command stands: refused if it is one the user said no to (sameCommand), else waiting, else null. */
  command(now: CommandAsked): Standing | null {
    const found = this.commands.filter(c => sameCommand(c.asked, now)).map(c => c.standing);
    return found.includes("refused") ? "refused" : found.includes("waiting") ? "waiting" : null;
  }

  /** The first-use commands card ended without a yes. */
  noteConsent(standing: Standing): void {
    if (this.consent !== "refused") this.consent = standing;
  }

  /** How turning commands on stands for this task. */
  get commandsConsent(): Standing | null {
    return this.consent;
  }

  /**
   * The user said something to the task: a question nobody answered may be asked again (they are there now). What they
   * said no to stays refused: asking for it afresh is a new request, which is a new task.
   */
  userSpoke(): void {
    for (const [n, s] of this.steps) if (s === "waiting") this.steps.delete(n);
    this.commands = this.commands.filter(c => c.standing === "refused");
    if (this.consent === "waiting") this.consent = null;
  }
}
