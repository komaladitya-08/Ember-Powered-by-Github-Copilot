/**
 * What Ember says out loud for an answer written in Markdown: the words, not the markup. Code is left to the
 * bubble (read aloud, it's noise), a link is said by its text, a bare address by its site's name.
 */

const CODE = "(code shown in the bubble)";
const TABLE = "(table shown in the bubble)";
const FENCED_CODE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;

/** End of a link target, allowing balanced or escaped parentheses and quoted titles. */
function linkEnd(text: string, from: number): number {
  let depth = 1;
  let closer = text[from] === "<" ? ">" : "";
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (closer) { if (c === closer) closer = ""; continue; }
    if (depth === 1 && (c === '"' || c === "'") && /\s/.test(text[i - 1])) closer = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Scan the same inline boundaries for streaming cuts and for removing finished link targets. */
function inlineComplete(text: string, link?: (start: number, label: string, end: number) => void): boolean {
  let ticks = 0, brackets = 0, labelStart = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!ticks && c === "\\") { i++; continue; }
    if (c === "`") {
      const start = i;
      while (text[i + 1] === "`") i++;
      const count = i - start + 1;
      if (ticks === count) ticks = 0;
      else if (!ticks) ticks = count;
    } else if (!ticks && c === "[") {
      if (!brackets) labelStart = i;
      brackets++;
    } else if (!ticks && c === "]" && brackets) {
      brackets--;
      if (brackets || text[i + 1] !== "(") continue;
      const end = linkEnd(text, i + 2);
      if (end < 0) return false;
      link?.(text[labelStart - 1] === "!" ? labelStart - 1 : labelStart, text.slice(labelStart + 1, i), end);
      i = end - 1;
    }
  }
  return !ticks && !brackets;
}

/** A streamed prefix can be said only after its fences and inline markup close. */
export function speechMarkupOpen(markdown: string): boolean {
  const fences = (markdown.match(/(^|\n)[ \t]*(```|~~~)/g) ?? []).length;
  return fences % 2 !== 0 || !inlineComplete(markdown.replace(FENCED_CODE, "$1"));
}

function linkLabels(text: string): string {
  let words = "", from = 0;
  inlineComplete(text, (start, label, end) => { words += text.slice(from, start) + label; from = end; });
  return words + text.slice(from);
}

/**
 * A key chord as written ("Ctrl+Alt+Y", "Win + Shift + S", "Cmd+Space"): modifiers joined by "+" to a key, standing on
 * its own: never inside a word, an address or a path ("me.alt+s@example.com", "build/ctrl+c"; review of #143).
 */
const CHORD = /(?<![\w.@+/\\-])(?:(?:ctrl|control|alt|shift|win|super|cmd|command|option|opt|fn)\s*\+\s*)+(?:f\d{1,2}|[a-z0-9]|enter|return|esc|escape|tab|space|delete|del|backspace|home|end|pgup|pgdn|up|down|left|right|period|comma|plus|minus)(?![\w@+/\\-]|\.\w)/gi;
/** How a key in a chord is said (keyLabel's names, for the ear): the rest are said as they are written. */
const KEY_SAID: Readonly<Record<string, string>> = {
  ctrl: "Control", win: "Windows key", cmd: "Command", opt: "Option", esc: "Escape", del: "Delete", return: "Enter",
  pgup: "Page Up", pgdn: "Page Down",
};

export function spokenText(markdown: string): string {
  const prose = markdown
    // Fenced code (an unclosed fence runs to the end, as a streamed answer can).
    .replace(FENCED_CODE, `$1${CODE}`)
    // Tables: a header row and its |---| line, and the rows after it.
    .replace(/(^|\n)[ \t]*\|.*\|[ \t]*\n[ \t]*\|?[ \t]*:?-{3,}[\s\S]*?(?=\n[ \t]*(?!\|)|$)/g, `$1${TABLE}`);
  return linkLabels(prose)
    .replace(/<?\b(?:https?:\/\/|www\.)([^\s/<>()]+?)(?:[/?#][^\s<>()]*?)?>?(?=[.,;:!?)]*(?:\s|$))/gi, (_m, host: string) => host.replace(/^www\./i, ""))
    .replace(/(?<![\\`])(`+)(?!`)([^\n]*?)(?<!`)\1(?!`)/g, "$2")
    // Emphasis as CommonMark sees it: no space just inside a marker ("6 * 7 * 1" and "*.tmp and *.log" are said with their
    // stars), and underscores only around whole words ("__init__.py" keeps them).
    .replace(/\*\*(?=[^\s*])([^*\n]*[^\s*])\*\*/g, "$1")
    .replace(/(^|[\s(])__(?=[^\s_])([^_\n]*[^\s_])__(?=[.,!?;:)]*(?:\s|$))/g, "$1$2")
    .replace(/(^|[\s(])([*_])(?=[^\s*_])([^*_\n]*[^\s*_])\2(?=[\s.,!?;:)]|$)/g, "$1$3")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    .replace(/^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
    // Key chords as said ("Ctrl+Shift+T" is "Control Shift T", not "C T R L plus…"), and a path through menus or
    // settings ("Settings › Voice") as "Settings, then Voice"; an arrow as "to", an ampersand between words as "and".
    .replace(CHORD, chord => chord.split(/\s*\+\s*/).map(k => KEY_SAID[k.toLowerCase()] ?? k).join(" "))
    .replace(/\s*›\s*(?=\S)/g, ", then ")
    .replace(/\s+(?:→|->)\s+/g, " to ")
    // (Only a lone "&" between words: not "&&", "1 & 2" or one inside an address.)
    .replace(/(\p{L})\s+&\s+(?=\p{L})/gu, "$1 and ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Does the answer end by asking something ("…Should I close that one too?")? Its follow-up window then takes
 * "Okay." or "Fine." as the reply it is, not as the end of the conversation. What is only shown (code, a table)
 * after the question doesn't count.
 */
export function endsWithQuestion(answer: string): boolean {
  let said = spokenText(answer);
  for (let shown = [CODE, TABLE].find(p => said.endsWith(p)); shown; shown = [CODE, TABLE].find(p => said.endsWith(p))) said = said.slice(0, -shown.length).trimEnd();
  return /\?[\s"'”’)\]*_]*$/.test(said);
}

/**
 * How an announced command (D4.4) says to cancel it (owner decision V1): with the kill phrase only where Ember can tell
 * its own voice from the user's (speaker rejection runs), or hearing itself say it would pull the kill switch and stop
 * everything (review #251); elsewhere with the stop shortcut as said aloud, when Ember holds it; else the Stop button.
 */
export function cancelWords(o: { killPhrase: boolean; stopKey: string | null }): string {
  if (o.killPhrase) return "Say 'Ember, stop' to cancel.";
  return o.stopKey ? `Press ${o.stopKey} to cancel.` : "Press Stop to cancel.";
}

/** "Ember, stop" in any of its forms, with its quotes (and a full stop inside them, which is kept). */
const KILL_PHRASE = /["“‘']?\b(?:(?:hey|hi|ok|okay)[\s,]+)?embers?[\s,.!…-]*(?:please[\s,]+)?stop\b(?:([.!]?)["”’'])?/gi;
/** "Hey Ember" (or "OK Ember"), with its quotes: the greeting and the name together. */
const WAKE_PHRASE = /["“‘']?\b(?:hey|hi|ok|okay|k|hay|pay|pey)[\s,]*(?:ember|emmer)\b(?!['’]?s\b)(?:([,.!]?)["”’'])?/gi;
/**
 * The greeting ending one sentence and the name starting the next ("Okay. Ember can't open that."): the recognizer
 * writes it as engine.ts's CUT_IN_WAKE takes for a cut-in, so a word goes between them ("Okay. So Ember can't…"), and
 * none is dropped. voice-spoken.test.ts checks on a corpus that CUT_IN_WAKE never matches what Ember says.
 */
const WAKE_APART = /\b(hey|hi|ok|okay|k|hay|pay|pey)([\s,]*[.!][\s,.!]*)(ember|emmer)\b(?!['’]?s\b)/gi;

/**
 * What Ember says, without the stop and wake phrases, where it can't tell its own voice from the user's: its
 * microphone would hear it say them, and "Ember, stop" (or "Hey Ember, stop", "Hey Ember, cancel") stops everything
 * (review #251). They are named instead ("the stop phrase"); the bubble still shows them.
 */
export function withoutOwnPhrases(text: string): string {
  return text
    .replace(KILL_PHRASE, (_m, p?: string) => `the stop phrase${p ?? ""}`)
    .replace(WAKE_PHRASE, (_m, p?: string) => `the wake phrase${p ?? ""}`)
    .replace(WAKE_APART, (_m, greeting: string, between: string, name: string) => `${greeting}${between}So ${name}`);
}
