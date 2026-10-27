/**
 * The ask box's line under the field: what Ember will see, as the window's app and title plus what else a request
 * sends from the screen (so nothing goes by surprise), shortened on the chip and whole in its tooltip and for screen
 * readers. Pure and renderer-safe; ui-copy.test.ts pins the words.
 */

import type { AskContext } from "../../shared/ipc";

/** The chip's words: `text` (may be shortened), `extra` (never shortened), `full` (tooltip, screen readers). */
export interface SeesView {
  text: string;
  extra: string;
  full: string;
}

const PRIVATE = "Ember won't look at this window";
const s = (n: number) => (n === 1 ? "" : "s");

/** What the chip says for `c`; null when Ember will see nothing (nothing is shown). */
export function seesView(c: Pick<AskContext, "sees" | "carries" | "privateWindow">): SeesView | null {
  if (c.privateWindow) return { text: PRIVATE, extra: "", full: `${PRIVATE}.` };
  if (!c.sees) return null;
  const k = c.carries;
  const short: string[] = [], long: string[] = [];
  if (k?.selection) { short.push("selected text"); long.push("the text you selected"); }
  else if (k?.fieldText) { short.push("field text"); long.push("the start of the focused field's text"); }
  if (k && k.windows > 0) { short.push(`${k.windows} window title${s(k.windows)}`); long.push(`the title${s(k.windows)} of ${k.windows} other open window${s(k.windows)}`); }
  const joined = long.length === 2 ? `${long[0]} and ${long[1]}` : long[0] ?? "";
  return {
    text: c.sees,
    extra: short.length ? `+ ${short.join(", ")}` : "",
    full: `Ember will see: ${c.sees}${joined ? `, with ${joined}` : ""}.`,
  };
}
