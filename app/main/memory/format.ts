/**
 * How recalled memories reach a model: one `<memory untrusted="true">` element, each fact on its own line with its id
 * (so "forget that" can name it), where it came from and when Ember learned it. Untrusted because a fact's words may
 * have come from the screen, a task or a connected service: the model treats them as information, never instructions
 * (CLAUDE.md "Untrusted text"). `<` is replaced as in `<task_results>`, so a fact can't close the element.
 */

import type { Fact, Source } from "./graph";
import type { Recalled } from "./recall";

const FROM: Record<Source, string> = {
  user: "you told me",
  conversation: "from our conversation",
  task: "from a task",
  observed: "seen on screen",
  connector: "from a connected service",
};

const day = (iso: string) => iso.slice(0, 10);

/**
 * One line for a fact: `- [f…] (you told me, 2026-10-03) Prefers dark mode.` (closed facts say until when). Ember's
 * own notes say so ("Ember's own summary", "Ember's own guess"), never "from our conversation" (memory-3).
 */
export function factLine(f: Fact): string {
  const until = f.invalidAt ? `, no longer true since ${day(f.invalidAt)}` : "";
  const from = f.predicate === "summary" ? "Ember's own summary" : f.predicate === "reflection" ? "Ember's own guess" : FROM[f.source];
  return `- [${f.id}] (${from}, ${day(f.validAt)}${until}) ${f.text.replace(/</g, "‹")}`;
}

/** The `<memory>` element for these facts, or "" for none. */
export function memoryBlock(found: Recalled[] | Fact[]): string {
  const facts = found.map(x => ("fact" in x ? x.fact : x));
  return facts.length ? `<memory untrusted="true">\n${facts.map(factLine).join("\n")}\n</memory>` : "";
}

/** A fact's id as Ember makes one (./graph.ts): nothing else goes into Ember's own note. */
const FACT_ID = /^[A-Za-z0-9_-]{1,40}$/;
/** The most ids one note names. */
const CHANGED_IDS = 20;

/** What the user had Ember change since the conversation was last told: facts by id, or everything. */
export interface MemoryChanges { forgot: readonly string[]; corrected: readonly string[]; back: readonly string[]; all: boolean }

/** The `[id]`s in a `<memory>` block: the facts a conversation was given (memory-r9-1). */
export function memoryIds(block: string): string[] {
  return [...block.matchAll(/^- \[([A-Za-z0-9_-]{1,40})\]/gm)].map(m => m[1]!);
}

/**
 * Ember's own note to the conversation after a Forget, a correction or Forget everything made outside it (Settings,
 * "forget that"): the conversation still holds what those facts said, so it is told they are gone (memory-r9-1). By id
 * only, and only ids the conversation was given: a forgotten fact's words are never sent again, and nothing a fact
 * said (which may have come from the screen) rides in a line that isn't marked untrusted. "" with nothing to say.
 */
export function memoryChanged(c: MemoryChanges): string {
  const ids = (list: readonly string[]) => list.filter(id => FACT_ID.test(id)).slice(0, CHANGED_IDS).map(id => `[${id}]`);
  const lines: string[] = [];
  if (c.all) lines.push("The user had Ember forget everything it remembered about them. Nothing from an earlier <memory>, or that you saved with remember, holds any more: don't use it or repeat it, and remember again only what the user says themselves from now on.");
  const forgot = ids(c.forgot);
  if (forgot.length) lines.push(`The user had Ember forget ${forgot.join(", ")}. What ${forgot.length > 1 ? "those facts" : "that fact"} said is gone: don't use it or repeat it, and don't remember it again unless the user says it again themselves.`);
  const corrected = ids(c.corrected);
  if (corrected.length) lines.push(`The user corrected ${corrected.join(", ")} in Settings. What ${corrected.length > 1 ? "they" : "it"} said before is wrong: don't use it or repeat it; recall gives ${corrected.length > 1 ? "them as they read" : "it as it reads"} now.`);
  const back = ids(c.back);
  if (back.length) lines.push(`The user had Ember remember ${back.join(", ")} again.`);
  return lines.length ? `<memory_changed>\n${lines.join("\n")}\n</memory_changed>` : "";
}

/**
 * What the recall tool says after the facts it gives (memory-r9-7): how many there are in all and where the full list
 * is, so Ember never passes the few that match best off as everything, nor says nothing is remembered when the
 * query's words matched none. Ember's own line, built from two counts alone: no more facts go to the model for it.
 * `shown`: the facts in the block; `total`: what Ember remembers (`history`: with what is no longer true). "" when
 * nothing is kept at all.
 */
export function recallNote(shown: number, total: number, history = false): string {
  if (total <= 0) return "";
  const kept = history ? "Ember keeps, what is no longer true included" : "Ember remembers";
  const facts = (n: number) => (n === 1 ? "1 fact" : `${n} facts`);
  if (shown <= 0) {
    return `Nothing matched that, of the ${facts(total)} ${kept}. recall finds facts by the words they share with the query, so search for a subject's own words (a name, their work, an app). The user can see the full list in Settings › Memory.`;
  }
  if (shown >= total) return `(${total === 1 ? "The only fact" : total === 2 ? "Both facts" : `All ${total} facts`} ${kept}.)`;
  return `(${shown} of the ${total} facts ${kept}: the ${shown === 1 ? "one that matches" : "ones that match"} best. The user can see them all in Settings › Memory.)`;
}
