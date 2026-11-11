/**
 * Writing a simple `[[ … ]]` test as `[ … ]` before a POSIX command line is judged (commands-remote-r6-2). Pure text
 * in, text out; the command that runs is never changed.
 *
 * The constraint: nothing here may decide less safely than the classifier already does for the written-out text. Only
 * a test `[` reads exactly as `[[` does is written out (plainTests), on a line that holds nothing this module doesn't
 * read: a backslash, a backtick, `$(…)`, any parenthesis or brace, a comment, a here-document or here-string, `&` on
 * its own, `!`, a `$` that isn't `$name` or `${name}`, or any reserved word but `[[` (an `if`, a loop, `time`) leaves
 * the line judged as written.
 *
 * A `for` loop is never written out: every loop is judged as written, and asks. The seventh round wrote a short loop
 * out pass by pass (`NAME=word; body`), and its reviews kept finding lines whose written-out text was not what bash or
 * zsh runs (a redirection in front of the body's first command, an option of `print` or `printf` made up from the
 * list's word, bash's `BASH_ALIASES=…` with no subscript: commands-remote-y7-1 to y7-3), so that was taken out again.
 */

/** The longest written-out line (classify.ts's MAX_COMMAND_CHARS: a longer one would ask as too long anyway). */
const MAX_CHARS = 8000;

/** Words the shell reads as syntax at the start of a command. */
const RESERVED: ReadonlySet<string> = new Set([
  "if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "time", "coproc", "in",
  "[[", "]]", "{", "}", "!", "repeat", "foreach", "end", "always", "nocorrect", "noglob",
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** A `$name` or `${name}` in the text. */
interface Ref { s: number; e: number; name: string; braced: boolean; quoted: boolean }
/** A word, or an operator that ends a simple command. */
interface Tok {
  k: "word" | "op";
  s: number;
  e: number;
  /** The word as written, or the operator (`;`, a newline, `&&`, `||`, `|`). */
  raw: string;
  /** A word: its text with the quotes taken off. */
  value: string;
  /** A word: it is what a redirection reads or writes (`> out`). */
  target: boolean;
  refs: Ref[];
  /** A word: whether any of it is inside single quotes. */
  single: boolean;
}

/** The line's words and operators, or null when it holds anything this module doesn't read (the header's list). */
function scan(t: string): Tok[] | null {
  const toks: Tok[] = [];
  let cur: Tok | null = null;
  let target = false;
  const end = (at: number): void => {
    if (cur === null) return;
    cur.e = at;
    cur.raw = t.slice(cur.s, at);
    toks.push(cur);
    cur = null;
  };
  const word = (at: number): Tok => {
    if (cur === null) { cur = { k: "word", s: at, e: at, raw: "", value: "", target, refs: [], single: false }; target = false; }
    return cur;
  };
  /** Ends a simple command at an operator; false when a redirection is left with nothing after it (`echo x >;`). */
  const op = (s: number, e: number): boolean => {
    end(s);
    if (target) return false;
    toks.push({ k: "op", s, e, raw: t.slice(s, e), value: "", target: false, refs: [], single: false });
    return true;
  };
  /** Reads a `$name` or `${name}` at i; the index after it, or -1. */
  const ref = (i: number, quoted: boolean): number => {
    const m = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/.exec(t.slice(i, i + 200));
    if (m === null) return -1;
    const w = word(i);
    w.refs.push({ s: i, e: i + m[0].length, name: m[1] ?? m[2], braced: m[2] !== undefined, quoted });
    w.value += m[0];
    return i + m[0].length;
  };
  for (let i = 0; i < t.length;) {
    const c = t[i];
    if (c === " " || c === "\t") { end(i); i++; continue; }
    if (c === "\n") { if (!op(i, i + 1)) return null; i++; continue; }
    if (c === ";") {
      if (t[i + 1] === ";" || t[i + 1] === "&" || t[i + 1] === "|") return null;
      if (!op(i, i + 1)) return null;
      i++; continue;
    }
    if (c === "&") {
      if (t[i + 1] !== "&" || !op(i, i + 2)) return null;
      i += 2; continue;
    }
    if (c === "|") {
      const two = t[i + 1] === "|";
      if (t[i + 1] === "&" || !op(i, two ? i + 2 : i + 1)) return null;
      i += two ? 2 : 1; continue;
    }
    if (c === "<" || c === ">") {
      // A number straight in front is the descriptor (`2> err`), not a word.
      const fd = cur as Tok | null;
      if (fd !== null && /^[0-9]+$/.test(t.slice(fd.s, i))) { target = fd.target; cur = null; } else end(i);
      let j = i + 1;
      if (c === "<" && (t[j] === "<" || t[j] === "(")) return null;
      if (t[j] === ">" || t[j] === "|") j++;
      if (t[j] === "&") j++;
      if (t[j] === "(" || t[j] === "<" || t[j] === ">" || t[j] === "&" || t[j] === "|") return null;
      target = true;
      i = j;
      continue;
    }
    if (c === "'") {
      const close = t.indexOf("'", i + 1);
      if (close < 0) return null;
      const w = word(i);
      w.single = true;
      w.value += t.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (c === "\"") {
      const w = word(i);
      let j = i + 1;
      for (;;) {
        const d = t[j];
        if (d === undefined || d === "\\" || d === "`") return null;
        if (d === "\"") break;
        if (d === "$") { j = ref(j, true); if (j < 0) return null; continue; }
        w.value += d;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === "$") { i = ref(i, false); if (i < 0) return null; continue; }
    if (c === "!" && t[i + 1] === "=" && cur === null) { word(i).value += "!="; i += 2; continue; }
    if ("\\`()#{}!".includes(c) || c < " " || c === "\x7f") return null;
    word(i).value += c;
    i++;
  }
  end(t.length);
  // A redirection with nothing after it.
  if (target) return null;
  return toks;
}

/** The simple commands of a run of tokens: each one's words, and the operator in front of it. */
function simples(toks: readonly Tok[]): { words: Tok[]; before: Tok | null }[] {
  const out: { words: Tok[]; before: Tok | null }[] = [];
  let words: Tok[] = [];
  let before: Tok | null = null;
  for (const k of toks) {
    if (k.k === "word") { words.push(k); continue; }
    out.push({ words, before });
    words = [];
    before = k;
  }
  out.push({ words, before });
  return out;
}

/** A simple command's program word: the first word that isn't an assignment or a redirection's file. */
const programOf = (words: readonly Tok[]): Tok | undefined => words.find(w => !w.target && !ASSIGNMENT.test(w.raw));

/** `[[ … ]]`'s tests of one file or text, which `[ … ]` reads the same way. */
const UNARY: ReadonlySet<string> = new Set(["-e", "-f", "-d", "-r", "-w", "-x", "-s", "-L", "-h", "-p", "-S", "-b", "-c", "-n", "-z"]);
const TEXT_BINARY: ReadonlySet<string> = new Set(["=", "==", "!="]);
const NUMBER_BINARY: ReadonlySet<string> = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
const FILE_BINARY: ReadonlySet<string> = new Set(["-nt", "-ot", "-ef"]);
/**
 * A test's operand `[` reads as `[[` does: a plain word that isn't an operator, or one word in double quotes. Never one
 * that holds `[[` or `]]` itself (`[[ -e "[[" ]]`): the comparison with main can't write that test out to prove it.
 */
const operand = (w: Tok): boolean => !w.target && !w.single && !/\[\[|\]\]/.test(w.raw) && (/^[A-Za-z0-9_./:@%+,][A-Za-z0-9_./:@%+,-]*$/.test(w.raw) || /^"[^"]*"$/.test(w.raw));
const numeral = (w: Tok): boolean => /^(0|[1-9][0-9]{0,8})$/.test(w.raw);

/**
 * The line with each simple `[[ … ]]` test written as `[ … ]`, or null when it has none or isn't certain: only a test
 * of one file or text (`-f x`, `-n "$x"`), two texts (`=`, `!=`), two whole numbers or two files, with every operand
 * a plain word or one double-quoted word (so nothing is split or matched as a pattern in either form), on a line with
 * no reserved word (an `if`, a loop) and nothing else this module doesn't read.
 */
export function plainTests(text: string): string | null {
  if (text.length > MAX_CHARS || !text.includes("[[")) return null;
  const toks = scan(text);
  if (toks === null) return null;
  const edits: { s: number; e: number; text: string }[] = [];
  for (const c of simples(toks)) {
    const p = programOf(c.words);
    if (p === undefined || !RESERVED.has(p.raw)) continue;
    if (p.raw !== "[[" || p !== c.words[0]) return null;
    const close = c.words[c.words.length - 1];
    const ops = c.words.slice(1, -1);
    if (close.raw !== "]]" || c.words.some(w => w.target)) return null;
    const [a, b, d] = ops;
    if (ops.length === 2 && UNARY.has(a.raw) && operand(b)) { /* one file or text */ }
    else if (ops.length === 3 && operand(a) && operand(d) && (TEXT_BINARY.has(b.raw) || FILE_BINARY.has(b.raw))) { /* two texts or files */ }
    else if (ops.length === 3 && numeral(a) && numeral(d) && NUMBER_BINARY.has(b.raw)) { /* two whole numbers */ }
    else return null;
    edits.push({ s: p.s, e: p.e, text: "[" });
    if (ops.length === 3 && b.raw === "==") edits.push({ s: b.s, e: b.e, text: "=" });
    edits.push({ s: close.s, e: close.e, text: "]" });
  }
  if (edits.length === 0) return null;
  let out = "";
  let at = 0;
  for (const e of edits) { out += text.slice(at, e.s) + e.text; at = e.e; }
  return out + text.slice(at);
}

/** The text a POSIX command line is judged by: its simple `[[ … ]]` tests as `[ … ]`, or itself (a loop as written). */
export function judgedText(text: string): string {
  return plainTests(text) ?? text;
}
