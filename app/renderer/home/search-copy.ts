/**
 * Search settings, at the top of Home's sidebar (Apple's System Settings: search filters the sidebar and finds a
 * setting several levels deep). Pure, so it is unit-tested (home-status.test.ts "Search settings"): which labels match
 * what was typed, and what a screen reader hears. Matching is by every word typed, in any order, ignoring case and
 * accents.
 */

/** One thing the search can find: a heading, a switch's label, a footnote, a button. */
export interface Searchable { pane: string; text: string }

/** Lower case without accents or quote marks, so “Hey Ember” is found by hey ember. */
export function searchFold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[“”‘’"']/g, "").toLowerCase();
}

/** The items whose words hold every word of `query` (none for a blank query), in the page's order. */
export function searchMatches<T extends Searchable>(query: string, items: readonly T[]): T[] {
  const words = searchFold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return items.filter(i => { const t = searchFold(i.text); return words.every(w => t.includes(w)); });
}

/** What a screen reader hears as the search narrows the sidebar. */
export function searchMessage(query: string, matches: number, panes: number): string {
  if (!query.trim()) return "";
  if (!matches) return "Nothing found. Try another word.";
  return `${matches === 1 ? "1 match" : `${matches} matches`} in ${panes === 1 ? "1 section" : `${panes} sections`}. Press Enter to go to the first.`;
}
