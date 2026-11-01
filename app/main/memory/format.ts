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

/** One line for a fact: `- [f…] (you told me, 2026-10-03) Prefers dark mode.` (closed facts say until when). */
export function factLine(f: Fact): string {
  const until = f.invalidAt ? `, no longer true since ${day(f.invalidAt)}` : "";
  return `- [${f.id}] (${FROM[f.source]}, ${day(f.validAt)}${until}) ${f.text.replace(/</g, "‹")}`;
}

/** The `<memory>` element for these facts, or "" for none. */
export function memoryBlock(found: Recalled[] | Fact[]): string {
  const facts = found.map(x => ("fact" in x ? x.fact : x));
  return facts.length ? `<memory untrusted="true">\n${facts.map(factLine).join("\n")}\n</memory>` : "";
}
