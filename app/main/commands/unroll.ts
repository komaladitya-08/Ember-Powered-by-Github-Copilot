/**
 * Writing a short `for` loop out pass by pass, and a simple `[[ … ]]` test as `[ … ]`, before a POSIX command line is
 * judged (commands-remote-r6-2). Pure text in, text out; the command that runs is never changed.
 *
 * The constraint: nothing here may decide less safely than the classifier already does for the written-out text. A loop
 * is judged once per body by the classifier, so a value from its list could reach an option nothing looked at (`for f in
 * --hard; do git reset $f; done` is `git reset --hard`: commands-c7-1), and every loop asks. This module finds the one
 * kind of loop whose passes can be written out exactly: `for NAME in` a short list of plain words, with a body in which
 * each `$NAME` stands where putting the word itself means the same to bash, zsh and sh. It returns the line with each
 * pass written out (`NAME=word; body`, the word in place of every `$NAME`), so the classifier judges the sequence the
 * shell runs: the folder, the variables and the downloads carry from pass to pass, and every word reaches the judging
 * of the command it lands in. Anything it isn't sure of returns null, and the line is judged as written (a loop asks).
 *
 * What makes a line unsure (each returns null for the whole line): a backslash, a backtick, `$(…)`, any parenthesis or
 * brace, a comment, a here-document or here-string, `&` on its own, `!`, a `$` that isn't `$name` or `${name}`; any
 * reserved word but the loop's own (`if`, `while`, `case`, `[[`, a nested loop, `time`); a word that can change what a
 * variable holds or how words are read behind the classifier's back (`eval`, `source`, `read`, `export`, `set`, `IFS`
 * and the like, DENIED); `break` or `continue`; the loop's name anywhere but its own `$NAME` (set, read, exported, used
 * after the loop, or inside single quotes); a `$NAME` as the command word, beside a `~`, `[`, `=`, `<` or `>` that would
 * read differently with the word written in, or followed by `:` or `[` (zsh's modifiers and subscripts); a list word
 * that is quoted, a pattern, a variable, a reserved word or holds `=` or `~`; more than MAX_PASSES passes in the line.
 */

/** The most passes written out on one line (every loop's together); longer lists ask as before. */
export const MAX_PASSES = 12;
/** The longest written-out line (classify.ts's MAX_COMMAND_CHARS: a longer one would ask as too long anyway). */
const MAX_CHARS = 8000;

/** Words the shell reads as syntax at the start of a command. */
const RESERVED: ReadonlySet<string> = new Set([
  "if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "time", "coproc", "in",
  "[[", "]]", "{", "}", "!", "repeat", "foreach", "end", "always", "nocorrect", "noglob",
]);
/**
 * Words that can change a variable, how words are split or what a later word means without the name being written
 * where the classifier looks: a line holding one, in any place, quoted or not, is judged as written.
 */
const DENIED: ReadonlySet<string> = new Set([
  "eval", "source", "read", "mapfile", "readarray", "getopts", "let", "declare", "typeset", "local", "readonly", "export", "unset", "set",
  "shift", "trap", "exec", "alias", "unalias", "shopt", "setopt", "unsetopt", "emulate", "enable", "builtin", "command", "integer", "float",
  "autoload", "zmodload", "break", "continue", "wait", "IFS",
]);
/** A list word written out whole: nothing for the shell to expand, split, or read as an assignment. */
const VALUE = /^[A-Za-z0-9_./:@%+,-]+$/;
/** A word of plain characters (a program's name, an option, a file). */
const PLAIN = /^[A-Za-z0-9_./:@%+,=-]+$/;
/**
 * The names a written-out loop may use: one lower-case letter, or a common lower-case word. Setting a name the shell
 * itself reads changes what later words mean (`HOME` moves `~`, `CDPATH` moves `cd`, zsh's `path` is `PATH`), and the
 * shells' lists of such names are long, so only names known to be nobody's are written out.
 */
const NAMES: ReadonlySet<string> = new Set([
  "file", "files", "dir", "folder", "item", "name", "pkg", "package", "num", "arg", "src", "dst", "target", "branch", "repo", "ext", "ver",
  "version", "lib", "task", "img", "image", "tag", "key", "val", "value", "entry", "pattern", "script", "url", "port", "db", "table", "ns",
  "pod", "app", "service", "project", "filename", "fname", "word", "step", "kind", "env", "lang", "test", "suite", "spec",
]);
const loopName = (n: string): boolean => /^[a-z]$/.test(n) || NAMES.has(n);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** An option word (`-f`, `--force`): its letters are never a variable's name. */
const OPTION = /^--?[A-Za-z0-9][A-Za-z0-9-]*$/;

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

/** Whether a word holds `name` as a name of its own (set, read or used), apart from the `$NAME`s in `ok`. */
function namesIt(w: Tok, name: string, ok: ReadonlySet<Ref>): boolean {
  if (OPTION.test(w.raw)) return false;
  let text = "";
  let at = w.s;
  for (const r of w.refs) {
    if (!ok.has(r)) continue;
    text += `${w.raw.slice(at - w.s, r.s - w.s)}\u0000`;
    at = r.e;
  }
  text += w.raw.slice(at - w.s);
  return new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);
}

/** Whether writing the word in place of this `$NAME` means the same to the shell (the header's list of places). */
function standsPlain(t: string, w: Tok, r: Ref, afterProgram: boolean): boolean {
  const next = t[r.e];
  // Straight after another `$name` the word would lengthen that name (`$g$f` is not `$ga`).
  if (/\$[A-Za-z_][A-Za-z0-9_]*$/.test(t.slice(Math.max(0, r.s - 80), r.s))) return false;
  if (r.quoted) return next !== "[" && (r.braced || next !== ":") && !/[*?[]/.test(w.raw);
  // A pattern matches a `/` it is given by a variable differently from one written in it.
  if (!afterProgram || /[*?[\]]/.test(w.raw)) return false;
  const before = t.slice(w.s, r.s);
  if (before !== "") {
    const prev = before[before.length - 1];
    if (!/[A-Za-z0-9_./:,@%+"'-]/.test(prev) && !(prev === "=" && before.length > 1)) return false;
    const tilde = before.lastIndexOf("~");
    if (tilde >= 0 && !before.slice(tilde).includes("/")) return false;
  }
  // A number in front of `<` or `>` would become the descriptor (`echo $n>out` is not `echo 2>out`).
  if (next === "<" || next === ">") return false;
  if (r.e >= w.e) return true;
  return /["'./,-]/.test(next) || (r.braced && /[A-Za-z0-9_:]/.test(next));
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
/** The same for a command that may stand straight after a loop's `do` (`do . ./x.sh`). */
const programAfterDo = (words: readonly Tok[]): Tok | undefined => programOf(words[0]?.raw === "do" && !words[0].target ? words.slice(1) : words);

/** Whether the line holds nothing that changes variables or word reading behind the classifier (DENIED). */
function settled(toks: readonly Tok[]): boolean {
  for (const k of toks) {
    if (k.k !== "word") continue;
    if (DENIED.has(k.value) || /(?<![A-Za-z0-9_])IFS(?![A-Za-z0-9_])/.test(k.raw)) return false;
  }
  for (const c of simples(toks)) {
    const p = programAfterDo(c.words);
    if (p === undefined) continue;
    // A command Ember can't name (`$X args`) could be any of them; `.` is `source`.
    if (p.refs.length > 0 || p.value === ".") return false;
    // `printf -v name` sets a variable.
    const printf = c.words.findIndex(w => w.value === "printf");
    if (printf >= 0 && c.words.slice(printf + 1).some(w => w.value.startsWith("-v"))) return false;
  }
  return true;
}

/** A `for` loop found at a token: its name, its list, its body's tokens and the index of its `done`. */
interface Loop { name: Tok; list: Tok[]; body: Tok[]; done: number }

/** Reads `for NAME in words (; | newlines) do body (; | newlines) done` from the `for` at toks[at], or null. */
function loopAt(toks: readonly Tok[], at: number): Loop | null {
  let i = at + 1;
  const name = toks[i++];
  const kw = toks[i++];
  if (name?.k !== "word" || name.target || !loopName(name.raw) || kw?.k !== "word" || kw.target || kw.raw !== "in") return null;
  const list: Tok[] = [];
  while (toks[i]?.k === "word") list.push(toks[i++]);
  if (list.length === 0 || list.some(w => w.target || !VALUE.test(w.raw) || RESERVED.has(w.raw) || DENIED.has(w.raw))) return null;
  // One `;`, or newlines, then `do`.
  if (toks[i]?.raw === ";") i++;
  else if (toks[i]?.raw === "\n") { while (toks[i]?.raw === "\n") i++; }
  else return null;
  const kwDo = toks[i++];
  if (kwDo?.k !== "word" || kwDo.target || kwDo.raw !== "do") return null;
  while (toks[i]?.raw === "\n") i++;
  const start = i;
  if (toks[start]?.k !== "word") return null;
  // `done` as a command of its own, after `;` or a newline, with `;`, a newline or the end after it.
  let done = -1;
  for (let j = start + 1; j < toks.length; j++) {
    if (toks[j].k !== "word" || toks[j].target || toks[j].raw !== "done" || toks[j - 1].k !== "op") continue;
    done = j;
    break;
  }
  if (done < 0) return null;
  const after = toks[done + 1];
  if (after !== undefined && after.raw !== ";" && after.raw !== "\n") return null;
  let end = done;
  while (toks[end - 1].k === "op") end--;
  if (!/^(;\n*|\n+)$/.test(toks.slice(end, done).map(o => o.raw).join(""))) return null;
  return { name, list, body: toks.slice(start, end), done };
}

/**
 * The line with every `for NAME in words; do body; done` written out pass by pass, or null when it has no loop or
 * anything in it isn't certain (the header's list): then the line is judged as written, and a loop asks.
 */
export function unrollLoops(text: string): string | null {
  if (text.length > MAX_CHARS || !/(^|[;\n])[ \t]*for[ \t]/.test(text)) return null;
  const toks = scan(text);
  if (toks === null || !settled(toks)) return null;
  const edits: { s: number; e: number; text: string; name: Tok; refs: Set<Ref> }[] = [];
  let passes = 0;
  let from = 0;
  for (const c of simples(toks)) {
    const p = programOf(c.words);
    if (p === undefined || p.s < from || !RESERVED.has(p.raw)) continue;
    // Only a loop that starts the line or follows `;` or a newline; any other reserved word leaves the line as written.
    if (p.raw !== "for" || p !== c.words[0] || (c.before !== null && c.before.raw !== ";" && c.before.raw !== "\n")) return null;
    const at = toks.indexOf(p);
    // Newlines after `&&`, `||` or `|` only carry the line on: the loop would be that command's other half.
    let prev = at - 1;
    while (prev >= 0 && toks[prev].raw === "\n" && toks[prev].k === "op") prev--;
    if (prev >= 0 && toks[prev].k === "op" && toks[prev].raw !== ";") return null;
    const loop = loopAt(toks, at);
    if (loop === null) return null;
    passes += loop.list.length;
    if (passes > MAX_PASSES) return null;
    // Every `$NAME` in the body stands where the word itself means the same, after a plainly written program; no
    // command in the body starts with a reserved word (a nested loop, an `if`, `[[`).
    const refs = new Set<Ref>();
    for (const b of simples(loop.body)) {
      const prog = programOf(b.words);
      if (prog !== undefined && RESERVED.has(prog.raw)) return null;
      for (const w of b.words) {
        for (const r of w.refs) {
          if (r.name !== loop.name.raw) continue;
          if (prog === undefined || !standsPlain(text, w, r, w.s > prog.s && PLAIN.test(prog.raw))) return null;
          refs.add(r);
        }
      }
    }
    const bodyStart = loop.body[0].s;
    const bodyEnd = loop.body[loop.body.length - 1].e;
    const sep = text.slice(bodyStart, bodyEnd).includes("\n") ? "\n" : "; ";
    const ordered = [...refs].sort((a, b) => a.s - b.s);
    const written = loop.list.map(v => {
      let out = "";
      let at = bodyStart;
      for (const r of ordered) { out += text.slice(at, r.s) + v.raw; at = r.e; }
      return `${loop.name.raw}=${v.raw}${sep}${out}${text.slice(at, bodyEnd)}`;
    }).join(sep);
    edits.push({ s: p.s, e: toks[loop.done].e, text: written, name: loop.name, refs });
    from = toks[loop.done].e;
  }
  if (edits.length === 0) return null;
  // The loop's name is nowhere else: not set, read or used but by its own `$NAME`s, in any loop's body or after it.
  for (const e of edits) {
    for (const w of toks) if (w.k === "word" && w !== e.name && namesIt(w, e.name.raw, e.refs)) return null;
  }
  let out = "";
  let at = 0;
  for (const e of edits) { out += text.slice(at, e.s) + e.text; at = e.e; }
  out += text.slice(at);
  return out.length > MAX_CHARS ? null : out;
}

/** `[[ … ]]`'s tests of one file or text, which `[ … ]` reads the same way. */
const UNARY: ReadonlySet<string> = new Set(["-e", "-f", "-d", "-r", "-w", "-x", "-s", "-L", "-h", "-p", "-S", "-b", "-c", "-n", "-z"]);
const TEXT_BINARY: ReadonlySet<string> = new Set(["=", "==", "!="]);
const NUMBER_BINARY: ReadonlySet<string> = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
const FILE_BINARY: ReadonlySet<string> = new Set(["-nt", "-ot", "-ef"]);
/** A test's operand `[` reads as `[[` does: a plain word that isn't an operator, or one word in double quotes. */
const operand = (w: Tok): boolean => !w.target && !w.single && (/^[A-Za-z0-9_./:@%+,][A-Za-z0-9_./:@%+,-]*$/.test(w.raw) || /^"[^"]*"$/.test(w.raw));
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

/** The text a POSIX command line is judged by: its loops written out, or its simple `[[ … ]]` tests as `[ … ]`, or itself. */
export function judgedText(text: string): string {
  return unrollLoops(text) ?? plainTests(text) ?? text;
}
