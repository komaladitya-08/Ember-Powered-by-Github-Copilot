/**
 * Search settings, at the top of Home's sidebar (Apple's System Settings: search filters the sidebar and finds a
 * setting several levels deep). Pure, so it is unit-tested (home-status.test.ts "Search settings"): which labels match
 * what was typed, and what a screen reader hears. Matching is by every word typed, in any order, ignoring case and
 * accents.
 */

/** One thing the search can find: a heading, a switch's label, a footnote, a button. */
export interface Searchable { pane: string; text: string; alias?: string }

/** Lower case without accents or quote marks, so “Hey Ember” is found by hey ember. */
export function searchFold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[“”‘’"']/g, "").toLowerCase();
}

/**
 * Other words people use for a pane (System Settings finds "Bluetooth" under its own name and "AirPods" alike): added
 * to the pane's heading, so "mic" finds Voice. By the heading's id; words only, never shown.
 */
export const SEARCH_ALIASES: Readonly<Record<string, string>> = {
  "copilot-h": "github account sign in sign out login model",
  "byok-h": "byok bring your own key api key provider openai azure anthropic ollama lm studio endpoint local model server",
  "voice-h": "mic microphone wake word hey ember speech speak listen voice match hearing",
  "pick-h": "character avatar size handle",
  "memory-h": "remember forget routines reminders",
  "privacy-h": "permissions never look passwords autonomy work without asking always allow",
  "access-h": "accessibility text size font bigger larger glass transparency contrast motion calm reduce motion keyboard",
  "computers-h": "ssh wsl remote server linux windows",
  "commands-h": "terminal shell command line run",
  "extensions-h": "plugins marketplace connectors tools",
  "checks-h": "doctor setup check diagnostics troubleshoot version",
};

/**
 * The items whose words hold every word of `query` (none for a blank query), in the page's order: those whose own words
 * hold it first, then those found only by a pane's other words (SEARCH_ALIASES), so Enter goes to the setting named.
 */
export function searchMatches<T extends Searchable>(query: string, items: readonly T[]): T[] {
  const words = searchFold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const holds = (t: string) => { const f = searchFold(t); return words.every(w => f.includes(w)); };
  const own = items.filter(i => holds(i.text));
  return [...own, ...items.filter(i => !own.includes(i) && !!i.alias && holds(`${i.text} ${i.alias}`))];
}

/** What a screen reader hears as the search narrows the sidebar. */
export function searchMessage(query: string, matches: number, panes: number): string {
  if (!query.trim()) return "";
  if (!matches) return "Nothing found. Try another word.";
  return `${matches === 1 ? "1 match" : `${matches} matches`} in ${panes === 1 ? "1 section" : `${panes} sections`}. Press Enter to go to the first.`;
}
