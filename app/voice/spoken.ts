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
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s.,!?;:)]|$)/g, "$1$2")
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
