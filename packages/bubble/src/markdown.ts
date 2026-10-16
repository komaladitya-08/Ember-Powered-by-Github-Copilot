/**
 * Markdown the model may use anyway, made plain for the bubble, the handle and
 * speech. Finished text (`plainMarkdown`) and text still arriving (`plainStream`)
 * follow the same rules, so an answer doesn't change its words the moment it is done.
 *
 * Stars and underscores are emphasis only when they hug their words: "*soft*",
 * "**Steps:**" and "_more_." lose them, while "12 * 7 * 3 = 252", "5 * 2 = 10, and
 * 3 * 4 = 12", "5*3", "my_var", "__init__.py" and "src/__main__" keep theirs. Code
 * (`spans` and fenced blocks) keeps everything but its backticks.
 */

/** `*x*`, `**x**`, `***x***`: no space just inside the markers, no letter or digit just outside. */
const STARS = /(?<![\w*])(\*{1,3})(?=[^\s*])([^*\n]*?[^\s*])\1(?![\w*])/g;
/** The same with underscores, which also stay when attached to a "/" or a "." (paths, file names). */
const UNDERSCORES = /(?<![\w./])(_{1,3})(?=[^\s_])([^_\n]*?[^\s_])\1(?![\w/]|\.\w)/g;
/**
 * While text streams: an opening marker at the end whose other half hasn't arrived ("**Ste", "**Steps:*").
 * Only one a word starts right after (a letter, digit or opening quote) and that isn't attached to a word,
 * "." or a slash before it, so "*.md", a "**" glob and "C:\Users\_temp" keep their markers while they arrive.
 */
const OPEN_STARS = /(?<![\w*./\\])\*{1,3}(?=[\p{L}\p{N}"'“‘«])([^*\n]*?)\**$/u;
const OPEN_UNDERSCORES = /(?<![\w./\\])_{1,3}(?=[\p{L}\p{N}"'“‘«])([^_\n]*?)_*$/u;
const HEADING = /(^|\n)[ \t]{0,3}#{1,6}[ \t]+/g;
const BULLET = /(^|\n)[ \t]{0,3}[-*+][ \t]+/g;
const LINK = /\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g;
/** Fenced blocks and `spans`; while streaming, also one still open at the end. */
const CODE = /```[\s\S]*?```|`[^`\n]+`/g;
const CODE_SO_FAR = /```[\s\S]*?(?:```|$)|`[^`\n]+(?:`|$)|`$/g;

function emphasis(s: string): string {
  // Twice, for emphasis inside emphasis ("**bold *and* more**").
  for (let i = 0; i < 2; i++) {
    const next = s.replace(STARS, "$2").replace(UNDERSCORES, "$2");
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Text outside code. `lineStart`: it begins a line (else a heading or bullet rule must not fire at its start). */
function prose(s: string, lineStart: boolean, end: boolean): string {
  const line = (re: RegExp, to: string) => s.replace(re, (m, nl: string) => (nl || lineStart ? nl + to : m));
  s = line(HEADING, "");
  s = line(BULLET, "• ");
  s = emphasis(s);
  if (end) s = s.replace(OPEN_STARS, "$1").replace(OPEN_UNDERSCORES, "$1");
  return s.replace(LINK, "$1 ($2)");
}

function plain(s: string, streaming: boolean): string {
  let out = "";
  let at = 0;
  for (const m of s.matchAll(streaming ? CODE_SO_FAR : CODE)) {
    out += prose(s.slice(at, m.index), at === 0 || s[at - 1] === "\n", false);
    out += m[0].startsWith("```") ? m[0].replace(/```\w*\n?/g, "") : m[0].replace(/`/g, "");
    at = m.index + m[0].length;
  }
  return out + prose(s.slice(at), at === 0 || s[at - 1] === "\n", streaming);
}

/** A finished answer made plain. */
export function plainMarkdown(s: string): string {
  return plain(s, false);
}

/**
 * Text that is still arriving made plain, including markers whose other half
 * hasn't arrived yet ("**Ste", an open "`Sett" or code block).
 */
export function plainStream(s: string): string {
  return plain(s, true);
}
