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
  "conversation-h": "chat history transcript messages clear delete erase new chat",
  "copilot-h": "connections github account sign in sign out login model",
  "project-h": "files review patch diff workspace folder",
  "byok-h": "byok bring your own key api key provider openai azure anthropic ollama lm studio endpoint local model server",
  "voice-h": "mic microphone wake word hey ember speech speak listen voice match hearing",
  "pick-h": "character avatar size handle login log in startup autostart start at login launch",
  "memory-h": "remember forget routines reminders delete erase",
  "privacy-h": "permissions never look passwords autonomy work without asking always allow",
  "privacy-terms-h": "data keeps kept sends screenshot screenshots audit record history usage statistics telemetry privacy policy consent before ember starts retention",
  "access-h": "appearance light dark mode theme accessibility text size font bigger larger glass transparency contrast motion calm reduce motion keyboard",
  "computers-h": "ssh wsl remote server linux windows",
  "commands-h": "terminal shell command line run",
  "extensions-h": "plugins marketplace connectors tools",
  "checks-h": "doctor setup check diagnostics troubleshoot version shortcuts keys hotkeys keyboard shortcuts",
};

/** A node as the DOM gives it, as far as shownText reads it (text nodes are 3, elements 1). */
export interface ShownNode {
  readonly nodeType: number;
  readonly nodeValue: string | null;
  readonly childNodes: ArrayLike<ShownNode>;
  readonly tagName?: string;
  readonly hidden?: boolean;
  getAttribute?(name: string): string | null;
  readonly classList?: { contains(token: string): boolean };
}

/** Elements whose words a result never shows: a pop-up's options (a pick, not a name) and what isn't text. */
const UNSHOWN = new Set(["SELECT", "OPTION", "DATALIST", "SCRIPT", "STYLE", "TEMPLATE"]);

/**
 * An element's words as the page shows them (home-6): without the alternatives it hides ([hidden]: the sentence for a
 * shortcut another app took), what is hidden from everyone (aria-hidden), a pop-up's options, or words for screen
 * readers only (.sr). textContent ran all of them together ("Memory: SourceAll sourcesYou told me…").
 */
export function shownText(node: ShownNode): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType !== 1) return "";
  if (node.hidden || node.getAttribute?.("aria-hidden") === "true" || UNSHOWN.has(node.tagName?.toUpperCase() ?? "") || node.classList?.contains("sr")) return "";
  let out = "";
  for (let i = 0; i < node.childNodes.length; i++) out += shownText(node.childNodes[i]);
  return out;
}

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
  return `${matches === 1 ? "1 match" : `${matches} matches`} in ${panes === 1 ? "1 section" : `${panes} sections`}. Press Enter for the first, or choose a result.`;
}
