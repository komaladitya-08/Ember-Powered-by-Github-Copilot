/**
 * What Ember says out loud for an answer written in Markdown: the words, not the markup. Code is left to the
 * bubble (read aloud, it's noise), a link is said by its text, a bare address by its site's name.
 */

const CODE = "(code shown in the bubble)";
const TABLE = "(table shown in the bubble)";

export function spokenText(markdown: string): string {
  return markdown
    // Fenced code (an unclosed fence runs to the end, as a streamed answer can).
    .replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, `$1${CODE}`)
    // Tables: a header row and its |---| line, and the rows after it.
    .replace(/(^|\n)[ \t]*\|.*\|[ \t]*\n[ \t]*\|?[ \t]*:?-{3,}[\s\S]*?(?=\n[ \t]*(?!\|)|$)/g, `$1${TABLE}`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<?\b(?:https?:\/\/|www\.)([^\s/<>()]+?)(?:[/?#][^\s<>()]*?)?>?(?=[.,;:!?)]*(?:\s|$))/gi, (_m, host: string) => host.replace(/^www\./i, ""))
    .replace(/`([^`\n]+)`/g, "$1")
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
/** "Hey Ember" (or "OK Ember"), with its quotes. */
const WAKE_PHRASE = /["“‘']?\b(?:hey|hi|ok|okay)[\s,]+ember\b(?:([,.!]?)["”’'])?/gi;

/**
 * What Ember says, without the stop and wake phrases, where it can't tell its own voice from the user's: its
 * microphone would hear it say them, and "Ember, stop" (or "Hey Ember, stop", "Hey Ember, cancel") stops everything
 * (review #251). They are named instead ("the stop phrase"); the bubble still shows them.
 */
export function withoutOwnPhrases(text: string): string {
  return text.replace(KILL_PHRASE, (_m, p?: string) => `the stop phrase${p ?? ""}`).replace(WAKE_PHRASE, (_m, p?: string) => `the wake phrase${p ?? ""}`);
}
