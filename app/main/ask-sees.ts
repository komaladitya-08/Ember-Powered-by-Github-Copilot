/**
 * What the ask box says Ember will see (§5.5): the window's app and title, and everything else the quick context sends
 * with a request (the text selected or the start of the focused field's text, the titles of the other open windows),
 * so nothing goes by surprise; or that Ember won't look at a private window. Read from the context's own lines, which
 * Ember writes one fact per line with all screen text quoted on that line. Pure: main sends the result to the box.
 */

import { friendlyApp } from "../shared/apps";
import type { AskContext } from "../shared/ipc";
import type { QuickContext } from "./perception";

/** The longest app and title shown in the chip (the tooltip and screen readers get the same). */
const SEES_MAX = 80;

/** The quick context of a window on the user's never-look list or a password prompt (perception's quickContextText). */
const PRIVATE = "The user is in a private window";

/** The part of the ask box's context that says what Ember will see. */
export type AskSees = Pick<AskContext, "sees" | "carries" | "privateWindow">;

/** What the box shows for `c` (null: nothing read, so nothing is said). */
export function askSees(c: QuickContext | null): AskSees {
  if (!c) return { sees: null };
  const t = c.target;
  if (!t.title && c.text.includes(PRIVATE)) return { sees: null, privateWindow: true };
  const named = [t.app && friendlyApp(t.app), t.title].filter(Boolean).join(" · ") || null;
  const sees = named && named.length > SEES_MAX ? named.slice(0, SEES_MAX - 1) + "…" : named;
  if (!sees) return { sees: null };
  const lines = c.text.split("\n");
  const list = lines.indexOf("Open windows:");
  const own = list >= 0 ? lines.slice(0, list) : lines;
  // The other windows: each listed one, less the one the user is in (marked after its quoted title).
  const windows = list >= 0 ? lines.slice(list + 1).filter(l => l.startsWith("- ") && !/\(focused by the user\)( \(busy, not answering\))?$/.test(l)).length : 0;
  return {
    sees,
    carries: {
      selection: own.some(l => l.startsWith("Selected text: ")),
      fieldText: own.some(l => l.startsWith("Its text begins: ")),
      windows,
    },
  };
}
