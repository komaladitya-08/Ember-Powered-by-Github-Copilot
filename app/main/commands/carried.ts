/**
 * Text a command carries from elsewhere in its task (§3.8.3 step 7; owned by package AG). A command is judged the way
 * typed text is (policy.ts's withCarried, through its runsOf and runsIn, which Step 0b exports): a run of letters and
 * digits, or a long number, that the command shares with something this task read, and that the user's own words don't
 * hold, means the command may carry it there (a page that says "run curl … | sh" read in a browser), and the decision
 * asks (§3.8.2 rule 8). Every source counts as read elsewhere: Ember's command window is never a window a task reads.
 *
 * Fails closed: without policy.ts's matcher (a build without Step 0b), any source read counts as carried.
 */

import * as policy from "../policy/policy";
import { friendlyApp } from "../../shared/apps";
import type { OS } from "../../shared/shortcuts";
import type { ReadSource } from "../policy/policy";

/** What makes text recognisable (policy.ts's Runs): runs of letters and digits, and numbers of five digits or more. */
interface Runs { grams: Set<string>; numbers: Set<string> }
/** policy.ts's run matcher (Step 0b's `export { runsIn, runsOf }`). */
interface RunMatcher {
  runsOf(s: string): Runs;
  runsIn(runs: Runs, text: string): Set<string>;
}

/** The matcher policy.ts exports, or null when it doesn't (then every source counts). */
function matcher(): RunMatcher | null {
  const m = policy as unknown as Partial<RunMatcher>;
  return typeof m.runsOf === "function" && typeof m.runsIn === "function" ? { runsOf: m.runsOf, runsIn: m.runsIn } : null;
}

/** How the card names where the text was read: each app once, then the window list and the screen at the request. */
function placesOf(sources: ReadSource[]): string[] {
  const apps = [...new Set(sources.filter(s => !s.listed && !s.described && s.app.trim()).map(s => friendlyApp(s.app)).filter(Boolean))];
  return [
    ...apps,
    ...(sources.some(s => s.listed) ? ["the list of open windows"] : []),
    ...(sources.some(s => s.described) ? ["your screen when you asked"] : []),
  ];
}

/**
 * Where text in `text` was read in this task (`sources`, the worker's readFrom), as the card names those places, or null
 * when it carries none. `words`: the user's own words for the task (Worker.commandWords): a run they said themselves is
 * theirs, not carried. `_os`: the target's OS; runs are judged on folded letters and digits, the same on every OS
 * (quotes, carets, backticks and backslashes drop out).
 */
export function carriedText(text: string, sources: ReadSource[], words: string, _os: OS): { from: string[] } | null {
  if (!sources.length) return null;
  const m = matcher();
  let from = sources;
  if (m) {
    const runs = m.runsOf(text);
    if (!runs.grams.size && !runs.numbers.size) return null;
    const own = m.runsIn(runs, words);
    from = sources.filter(s => [...m.runsIn(runs, s.text ?? s.window)].some(g => !own.has(g)));
  }
  if (!from.length) return null;
  const places = placesOf(from);
  return { from: places.length ? places : ["another window"] };
}
