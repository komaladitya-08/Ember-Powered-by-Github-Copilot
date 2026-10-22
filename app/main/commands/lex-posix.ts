/**
 * The POSIX shell tokenizer (design §3.4.1; bash, zsh and dash share it): lists, pipelines, subshells and groups,
 * words with their quoting and expansions kept apart (so the classifier can tell `rm` from `r''m` from `$(echo rm)`),
 * redirections and here-documents, and every construct it doesn't fully understand recorded as a reason Ember can't
 * tell what the command does (D4.3 g: it asks). Hand-written and conservative on purpose (R8: no tree-sitter); pure.
 */

/** One part of a word. */
export type Seg =
  /** Literal text; `q`: it came from quotes or an escape (wildcards in it are inert). */
  | { t: "lit"; s: string; q: boolean }
  /** `$NAME` or `${NAME}`. */
  | { t: "var"; name: string }
  /** An expansion Ember can't resolve (a substitution, `${x:-y}`, `$((…))`, `$1`, `$@`…). */
  | { t: "unres"; why: string }
  /** `~` or `~user` at the start of a word (or of an assignment's value). */
  | { t: "tilde"; user: string };

/** A word as written. */
export interface PWord {
  segs: Seg[];
  raw: string;
  /** Lists parsed out of command and process substitutions in it (classified too). */
  subs: PList[];
  /** The whole word is a process substitution `<(…)` or `>(…)`. */
  proc: "<" | ">" | null;
  /** Quoting or escaping was used somewhere in it. */
  quoted: boolean;
}

/** The redirection operators. */
export type RedirOp = ">" | ">>" | ">|" | "&>" | "&>>" | "<" | "<>" | "<<" | "<<-" | "<<<" | ">&" | "<&";

/** One redirection. */
export interface PRedir {
  fd: number | null;
  op: RedirOp;
  /** The file (null for a here-document or a descriptor duplication). */
  target: PWord | null;
  /** `>&2`, `<&0`, `>&-`: the descriptor duplicated or closed. */
  dup?: string;
  heredoc?: { body: string; quoted: boolean; subs: PList[] };
}

export interface PSimple {
  kind: "simple";
  assigns: { name: string; value: PWord; append: boolean }[];
  words: PWord[];
  redirs: PRedir[];
}
export interface PGroup { kind: "subshell" | "group"; body: PList; redirs: PRedir[] }
export type PCommand = PSimple | PGroup;
export interface PPipeline { cmds: PCommand[]; bang: boolean }
export interface PAndOr { pipes: PPipeline[]; ops: ("&&" | "||")[]; background: boolean }
export interface PList { items: PAndOr[] }

/** Why a part couldn't be understood, with the card's specific line when there is one. */
export interface Unclear { why: string; says?: string }

/** The result of tokenizing one command text. */
export interface PosixParse {
  list: PList;
  unclear: Unclear[];
  /** Parsing stopped: the structure can't be trusted at all. */
  fatal: boolean;
  /** Simple commands seen (substitutions included). */
  simpleCount: number;
}

/** The limits of §3.4.1. */
export const MAX_SIMPLE = 64;
export const MAX_DEPTH = 8;

class Fatal extends Error {}

const META = " \t\n;&|<>()";
const isBlank = (c: string): boolean => c === " " || c === "\t";

/** The ANSI-C escapes §3.4.1 decodes in `$'…'`; anything else is unclear. */
function decodeAnsiC(body: string): string | null {
  let out = "";
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (c !== "\\") { out += c; continue; }
    const n = body[k + 1];
    if (n === undefined) return null;
    if (n === "n") { out += "\n"; k++; continue; }
    if (n === "t") { out += "\t"; k++; continue; }
    if (n === "\\" || n === "'" || n === "\"") { out += n; k++; continue; }
    if (n === "x") {
      const m = /^[0-9A-Fa-f]{1,2}/.exec(body.slice(k + 2));
      if (!m) return null;
      out += String.fromCharCode(parseInt(m[0], 16));
      k += 1 + m[0].length;
      continue;
    }
    if (n === "u") {
      const m = /^[0-9A-Fa-f]{1,4}/.exec(body.slice(k + 2));
      if (!m) return null;
      out += String.fromCharCode(parseInt(m[0], 16));
      k += 1 + m[0].length;
      continue;
    }
    if (n === "0") {
      const m = /^[0-7]{0,3}/.exec(body.slice(k + 2));
      out += String.fromCharCode(parseInt(m && m[0] ? m[0] : "0", 8));
      k += 1 + (m ? m[0].length : 0);
      continue;
    }
    return null;
  }
  return out;
}

/** The tokenizer's state over one text. */
class Parser {
  i = 0;
  unclear: Unclear[] = [];
  count = 0;
  depth = 0;
  private pending: { redir: PRedir; delim: string; strip: boolean }[] = [];

  constructor(readonly s: string, readonly shell: "bash" | "zsh" | "sh", depth = 0) {
    this.depth = depth;
  }

  private peek(n = 0): string { return this.s[this.i + n] ?? ""; }
  private eof(): boolean { return this.i >= this.s.length; }
  private fatal(why: string): never { this.unclear.push({ why }); throw new Fatal(why); }
  note(why: string, says?: string): void { if (!this.unclear.some(u => u.why === why)) this.unclear.push(says ? { why, says } : { why }); }

  /** Whether the text at the cursor is the word `w` standing alone. */
  private atWord(w: string): boolean {
    if (!this.s.startsWith(w, this.i)) return false;
    const after = this.s[this.i + w.length];
    return after === undefined || META.includes(after);
  }

  /** Spaces, tabs, line continuations and a comment. */
  private skipBlanks(): void {
    for (;;) {
      const c = this.peek();
      if (isBlank(c)) { this.i++; continue; }
      if (c === "\\" && this.peek(1) === "\n") { this.i += 2; continue; }
      if (c === "#") {
        while (!this.eof() && this.peek() !== "\n") this.i++;
        continue;
      }
      return;
    }
  }

  /** Blanks and newlines (here-document bodies are read after each newline). */
  private skipSpaceNewlines(): void {
    for (;;) {
      this.skipBlanks();
      if (this.peek() === "\n") { this.i++; this.readHeredocs(); continue; }
      return;
    }
  }

  private enter(): void {
    this.depth++;
    if (this.depth > MAX_DEPTH) this.note("depth", "It nests commands too deeply for Ember to follow.");
  }

  parseList(term: ")" | "}" | null): PList {
    const items: PAndOr[] = [];
    for (;;) {
      this.skipSpaceNewlines();
      if (this.eof()) {
        if (term !== null) this.fatal(`unterminated ${term === ")" ? "(" : "{"}`);
        break;
      }
      if (term === ")" && this.peek() === ")") break;
      if (term === "}" && this.atWord("}")) { this.i++; break; }
      const c = this.peek();
      if (c === ";" || c === "|" || c === ")" || (c === "&" && !(this.peek(1) === ">" && this.shell !== "sh"))) this.fatal(`unexpected ${c}`);
      const item = this.parseAndOr();
      items.push(item);
      this.skipBlanks();
      const d = this.peek();
      if (d === ";") {
        if (this.peek(1) === ";" || this.peek(1) === "&") this.fatal("case syntax");
        this.i++;
        continue;
      }
      if (d === "&") { this.i++; item.background = true; continue; }
      if (d === "\n") { this.i++; this.readHeredocs(); continue; }
      if (this.eof()) continue;
      if (term === ")" && d === ")") break;
      this.fatal(`unexpected ${d}`);
    }
    return { items };
  }

  private parseAndOr(): PAndOr {
    const pipes = [this.parsePipeline()];
    const ops: ("&&" | "||")[] = [];
    for (;;) {
      this.skipBlanks();
      if (this.s.startsWith("&&", this.i) || this.s.startsWith("||", this.i)) {
        ops.push(this.s.slice(this.i, this.i + 2) as "&&" | "||");
        this.i += 2;
        this.skipSpaceNewlines();
        pipes.push(this.parsePipeline());
        continue;
      }
      return { pipes, ops, background: false };
    }
  }

  private parsePipeline(): PPipeline {
    this.skipBlanks();
    let bang = false;
    if (this.atWord("!")) { this.i++; bang = true; this.skipBlanks(); }
    const cmds = [this.parseCommand()];
    for (;;) {
      this.skipBlanks();
      if (this.peek() === "|" && this.peek(1) !== "|") {
        this.i++;
        if (this.peek() === "&") this.i++;
        this.skipSpaceNewlines();
        cmds.push(this.parseCommand());
        continue;
      }
      return { cmds, bang };
    }
  }

  private parseCommand(): PCommand {
    this.skipBlanks();
    if (this.peek() === "(") {
      if (this.peek(1) === "(") this.fatal("arithmetic command");
      this.i++;
      this.enter();
      const body = this.parseList(")");
      if (this.peek() !== ")") this.fatal("unterminated (");
      this.i++;
      this.depth--;
      return { kind: "subshell", body, redirs: this.trailingRedirs() };
    }
    if (this.atWord("{")) {
      this.i++;
      this.enter();
      const body = this.parseList("}");
      this.depth--;
      return { kind: "group", body, redirs: this.trailingRedirs() };
    }
    return this.parseSimple();
  }

  /** Redirections after a subshell or group. */
  private trailingRedirs(): PRedir[] {
    const out: PRedir[] = [];
    for (;;) {
      this.skipBlanks();
      const r = this.tryRedir();
      if (!r) return out;
      out.push(r);
    }
  }

  private parseSimple(): PSimple {
    const cmd: PSimple = { kind: "simple", assigns: [], words: [], redirs: [] };
    for (;;) {
      this.skipBlanks();
      const c = this.peek();
      if (this.eof() || c === "\n" || c === ";" || c === "|" || c === ")") break;
      if (c === "&" && !(this.peek(1) === ">" && this.shell !== "sh")) break;
      if (c === "(") this.fatal("defines a function or uses ( where a word should be");
      const r = this.tryRedir();
      if (r) { cmd.redirs.push(r); continue; }
      const words = this.parseWord();
      if (!words) this.fatal(`unexpected ${c}`);
      if (cmd.words.length === 0) {
        const asg = words.length === 1 ? assignmentOf(words[0]) : null;
        if (asg) { cmd.assigns.push(asg); continue; }
      }
      cmd.words.push(...words);
    }
    if (cmd.words.length === 0 && cmd.assigns.length === 0 && cmd.redirs.length === 0) this.fatal("empty command");
    this.count++;
    if (this.count > MAX_SIMPLE) this.note("too-many", "It has more commands than Ember can check one by one.");
    return cmd;
  }

  /** A redirection at the cursor, or null (the cursor stays). */
  private tryRedir(): PRedir | null {
    let j = this.i;
    let fd: number | null = null;
    const digits = /^\d+/.exec(this.s.slice(j));
    if (digits && /[<>]/.test(this.s[j + digits[0].length] ?? "")) { fd = Number(digits[0]); j += digits[0].length; }
    const rest = this.s.slice(j);
    let op: RedirOp | null = null;
    if (fd === null && this.shell !== "sh" && rest.startsWith("&>>")) op = "&>>";
    else if (fd === null && this.shell !== "sh" && rest.startsWith("&>")) op = "&>";
    else if (rest.startsWith(">>")) op = ">>";
    else if (rest.startsWith(">|")) op = ">|";
    else if (rest.startsWith(">&")) op = ">&";
    else if (rest.startsWith(">(")) return null;
    else if (rest.startsWith(">")) op = ">";
    else if (rest.startsWith("<<<")) op = "<<<";
    else if (rest.startsWith("<<-")) op = "<<-";
    else if (rest.startsWith("<<")) op = "<<";
    else if (rest.startsWith("<>")) op = "<>";
    else if (rest.startsWith("<&")) op = "<&";
    else if (rest.startsWith("<(")) return null;
    else if (rest.startsWith("<")) op = "<";
    if (!op) return null;
    if (this.shell === "zsh" && op === "<" && /^<\d*-\d*>/.test(rest)) this.note("zsh", "It uses zsh-only syntax.");
    this.i = j + op.length;
    this.skipBlanks();
    if (op === "<<" || op === "<<-") {
      const w = this.parseWord();
      if (!w || w.length !== 1) this.fatal("here-document without a delimiter");
      const word = w[0];
      if (word.segs.some(sg => sg.t !== "lit")) this.fatal("here-document delimiter with an expansion");
      const delim = word.segs.map(sg => (sg.t === "lit" ? sg.s : "")).join("");
      const redir: PRedir = { fd, op, target: null, heredoc: { body: "", quoted: word.quoted, subs: [] } };
      this.pending.push({ redir, delim, strip: op === "<<-" });
      return redir;
    }
    const w = this.parseWord();
    if (!w || w.length !== 1) this.fatal("redirection without a target");
    const target = w[0];
    if (op === ">&" || op === "<&") {
      const lit = target.segs.length === 1 && target.segs[0].t === "lit" ? target.segs[0].s : null;
      if (lit !== null && /^(\d+|-)$/.test(lit)) return { fd, op, target: null, dup: lit };
      if (op === "<&") this.fatal("unexpected <&");
      // `>&file` is `&>file` in bash and zsh; in sh it is an error.
      return { fd, op: fd === null || fd === 1 ? "&>" : ">", target };
    }
    return { fd, op, target };
  }

  /** Reads the bodies of the here-documents started on the line just ended. */
  private readHeredocs(): void {
    while (this.pending.length) {
      const h = this.pending.shift()!;
      let body = "";
      for (;;) {
        if (this.eof()) this.fatal("unterminated here-document");
        let nl = this.s.indexOf("\n", this.i);
        if (nl < 0) nl = this.s.length;
        const raw = this.s.slice(this.i, nl);
        const line = h.strip ? raw.replace(/^\t+/, "") : raw;
        this.i = Math.min(nl + 1, this.s.length);
        if (line === h.delim) break;
        body += `${line}\n`;
      }
      const doc = h.redir.heredoc!;
      doc.body = body;
      if (!doc.quoted) doc.subs = this.bodySubs(body);
    }
  }

  /** Command substitutions in an unquoted here-document's body (they run when the document is read). */
  private bodySubs(body: string): PList[] {
    const sub = new Parser(body, this.shell, this.depth);
    const subs: PList[] = [];
    try {
      while (!sub.eof()) {
        const c = sub.peek();
        if (c === "\\") { sub.i += 2; continue; }
        if (c === "$") { const r = sub.parseDollar(true); subs.push(...r.subs); continue; }
        if (c === "`") { const r = sub.parseBackquote(); subs.push(...r.subs); continue; }
        sub.i++;
      }
    } finally {
      this.absorb(sub);
    }
    return subs;
  }

  private absorb(sub: Parser): void {
    for (const u of sub.unclear) this.note(u.why, u.says);
    this.count += sub.count;
    if (this.count > MAX_SIMPLE) this.note("too-many", "It has more commands than Ember can check one by one.");
  }

  /** One word (several after brace expansion), or null at an operator. */
  parseWord(): PWord[] | null {
    const start = this.i;
    const c0 = this.peek();
    if ((c0 === "<" || c0 === ">") && this.peek(1) === "(") {
      this.i += 2;
      this.enter();
      const list = this.parseList(")");
      if (this.peek() !== ")") this.fatal("unterminated process substitution");
      this.i++;
      this.depth--;
      const end = this.peek();
      if (end !== "" && !META.includes(end)) this.fatal("text after a process substitution");
      return [{ segs: [{ t: "unres", why: "process substitution" }], raw: this.s.slice(start, this.i), subs: [list], proc: c0, quoted: false }];
    }
    if (this.eof() || META.includes(c0)) return null;
    const segs: Seg[] = [];
    const subs: PList[] = [];
    let quoted = false;
    const lit = (s: string, q: boolean): void => {
      const last = segs[segs.length - 1];
      if (last && last.t === "lit" && last.q === q) last.s += s;
      else segs.push({ t: "lit", s, q });
    };
    if (this.shell === "zsh" && c0 === "=" && /[A-Za-z]/.test(this.peek(1))) this.note("zsh", "It uses zsh-only syntax.");
    for (;;) {
      if (this.eof()) break;
      const c = this.peek();
      if (c === "(") {
        // `name(` (a function), a zsh glob qualifier, or a bash extglob: none is understood.
        this.fatal("a ( inside a word");
      }
      if (META.includes(c)) break;
      if (c === "\\") {
        if (this.peek(1) === "\n") { this.i += 2; continue; }
        if (this.i + 1 >= this.s.length) { lit("\\", false); this.i++; continue; }
        lit(this.peek(1), true);
        quoted = true;
        this.i += 2;
        continue;
      }
      if (c === "'") {
        const end = this.s.indexOf("'", this.i + 1);
        if (end < 0) this.fatal("unterminated '");
        lit(this.s.slice(this.i + 1, end), true);
        quoted = true;
        this.i = end + 1;
        continue;
      }
      if (c === "\"") {
        quoted = true;
        this.parseDouble(segs, subs);
        continue;
      }
      if (c === "$") {
        const r = this.parseDollar(false);
        if (r.quoted) quoted = true;
        for (const s of r.segs) if (s.t === "lit") lit(s.s, s.q); else segs.push(s);
        subs.push(...r.subs);
        continue;
      }
      if (c === "`") {
        const r = this.parseBackquote();
        segs.push(...r.segs);
        subs.push(...r.subs);
        continue;
      }
      if (c === "~" && (segs.length === 0 || (segs.length === 1 && segs[0].t === "lit" && !segs[0].q && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(segs[0].s)))) {
        const m = /^~([A-Za-z0-9._+-]*)/.exec(this.s.slice(this.i));
        const user = m ? m[1] : "";
        const after = this.s[this.i + 1 + user.length];
        if (after === undefined || after === "/" || META.includes(after)) {
          segs.push({ t: "tilde", user });
          this.i += 1 + user.length;
          continue;
        }
      }
      if (this.shell === "zsh" && c === "*" && this.peek(1) === "*" && this.peek(2) === "/") this.note("zsh", "It uses zsh-only syntax.");
      lit(c, false);
      this.i++;
    }
    const word: PWord = { segs, raw: this.s.slice(start, this.i), subs, proc: null, quoted };
    return this.shell === "sh" ? [word] : this.expandBraces(word);
  }

  /** `"…"`: `\` escapes only `$ \` " \\` and newline; expansions inside. */
  private parseDouble(segs: Seg[], subs: PList[]): void {
    this.i++;
    const lit = (s: string): void => {
      const last = segs[segs.length - 1];
      if (last && last.t === "lit" && last.q) last.s += s;
      else segs.push({ t: "lit", s, q: true });
    };
    for (;;) {
      if (this.eof()) this.fatal("unterminated \"");
      const c = this.peek();
      if (c === "\"") { this.i++; return; }
      if (c === "\\") {
        const n = this.peek(1);
        if (n === "\n") { this.i += 2; continue; }
        if (n === "$" || n === "`" || n === "\"" || n === "\\") { lit(n); this.i += 2; continue; }
        lit("\\");
        this.i++;
        continue;
      }
      if (c === "$") {
        const r = this.parseDollar(true);
        for (const s of r.segs) if (s.t === "lit") lit(s.s); else segs.push(s);
        subs.push(...r.subs);
        continue;
      }
      if (c === "`") {
        const r = this.parseBackquote();
        segs.push(...r.segs);
        subs.push(...r.subs);
        continue;
      }
      lit(c);
      this.i++;
    }
  }

  /** `$…` at the cursor. */
  parseDollar(inDq: boolean): { segs: Seg[]; subs: PList[]; quoted: boolean } {
    const n = this.peek(1);
    if (n === "(") {
      if (this.peek(2) === "(") {
        // $((…)): arithmetic. Commands hidden inside it run too.
        let depth = 0;
        let k = this.i + 1;
        for (; k < this.s.length; k++) {
          if (this.s[k] === "(") depth++;
          else if (this.s[k] === ")") { depth--; if (depth === 0) break; }
        }
        if (k >= this.s.length) this.fatal("unterminated $((");
        const body = this.s.slice(this.i + 3, k - 1);
        if (/\$\(|`/.test(body)) this.note("arith-command", "It hides a command inside arithmetic.");
        // bash evaluates a variable's value as arithmetic too, and `a[$(…)]` in that value runs a command.
        else if (/[A-Za-z_]/.test(body)) this.note("arith-variable", "Its arithmetic reads a variable whose value could run a command.");
        this.i = k + 1;
        return { segs: [{ t: "unres", why: "arithmetic" }], subs: [], quoted: false };
      }
      this.i += 2;
      this.enter();
      const list = this.parseList(")");
      if (this.peek() !== ")") this.fatal("unterminated $(");
      this.i++;
      this.depth--;
      return { segs: [{ t: "unres", why: "command substitution" }], subs: [list], quoted: false };
    }
    if (n === "{") {
      let depth = 0;
      let k = this.i + 1;
      for (; k < this.s.length; k++) {
        const c = this.s[k];
        if (c === "\\") { k++; continue; }
        if (c === "'" && !inDq) { const e = this.s.indexOf("'", k + 1); if (e < 0) break; k = e; continue; }
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) break; }
      }
      if (k >= this.s.length) this.fatal("unterminated ${");
      const body = this.s.slice(this.i + 2, k);
      this.i = k + 1;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(body)) return { segs: [{ t: "var", name: body }], subs: [], quoted: false };
      if (/\$\(|`/.test(body)) this.note("hidden-command", "It hides a command inside a variable's expansion.");
      // Forms that evaluate a value as code: indirection (`${!x}`), prompt expansion (`${x@P}`), an array subscript
      // or a substring offset that isn't a plain number (`${a[i]}`, `${x:n}`: arithmetic on a variable).
      else if (/^!/.test(body) || /@P$/.test(body) || /\[(?![@*]\]|\d+\])/.test(body) || /^[A-Za-z_][A-Za-z0-9_]*:(?![-=?+])[^}]*[A-Za-z_]/.test(body)) {
        this.note("expansion-evaluates", "It expands a variable in a way that could run a command hidden in its value.");
      }
      if (this.shell === "zsh" && /^[(=~^]/.test(body)) this.note("zsh", "It uses zsh-only syntax.");
      return { segs: [{ t: "unres", why: "expansion" }], subs: [], quoted: false };
    }
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i + 1))!;
      this.i += 1 + m[0].length;
      return { segs: [{ t: "var", name: m[0] }], subs: [], quoted: false };
    }
    if (n !== undefined && /[0-9@*#?$!-]/.test(n)) {
      this.i += 2;
      return { segs: [{ t: "unres", why: `$${n}` }], subs: [], quoted: false };
    }
    if (n === "'" && !inDq) {
      let k = this.i + 2;
      for (; k < this.s.length; k++) {
        if (this.s[k] === "\\") { k++; continue; }
        if (this.s[k] === "'") break;
      }
      if (k >= this.s.length) this.fatal("unterminated $'");
      const decoded = decodeAnsiC(this.s.slice(this.i + 2, k));
      this.i = k + 1;
      if (decoded === null) {
        this.note("ansi-c", "It uses an escape Ember doesn't decode.");
        return { segs: [{ t: "unres", why: "ansi-c" }], subs: [], quoted: true };
      }
      return { segs: [{ t: "lit", s: decoded, q: true }], subs: [], quoted: true };
    }
    if (n === "\"" && !inDq) {
      this.note("locale-string", "It uses a translated string.");
      this.i++;
      const segs: Seg[] = [];
      const subs: PList[] = [];
      this.parseDouble(segs, subs);
      return { segs, subs, quoted: true };
    }
    if (n === "[") {
      this.note("old-arith", "It uses arithmetic Ember doesn't follow.");
    }
    this.i++;
    return { segs: [{ t: "lit", s: "$", q: inDq }], subs: [], quoted: false };
  }

  /** `` `…` ``: an old-style command substitution, parsed from its unescaped text. */
  parseBackquote(): { segs: Seg[]; subs: PList[] } {
    let k = this.i + 1;
    let body = "";
    for (; k < this.s.length; k++) {
      const c = this.s[k];
      if (c === "\\" && k + 1 < this.s.length && "$`\\".includes(this.s[k + 1])) { body += this.s[k + 1]; k++; continue; }
      if (c === "`") break;
      body += c;
    }
    if (k >= this.s.length) this.fatal("unterminated `");
    this.i = k + 1;
    const sub = new Parser(body, this.shell, this.depth + 1);
    if (sub.depth > MAX_DEPTH) this.note("depth", "It nests commands too deeply for Ember to follow.");
    let list: PList;
    try {
      list = sub.parseList(null);
    } catch (e) {
      this.absorb(sub);
      throw e;
    }
    this.absorb(sub);
    return { segs: [{ t: "unres", why: "command substitution" }], subs: [list] };
  }

  /** bash and zsh brace expansion of literal parts (`{a,b}`, `{1..5}`); a brace group Ember can't expand is unresolved. */
  private expandBraces(word: PWord): PWord[] {
    const out: PWord[] = [];
    const go = (segs: Seg[], budget: { n: number }): void => {
      for (let si = 0; si < segs.length; si++) {
        const seg = segs[si];
        if (seg.t !== "lit" || seg.q) continue;
        const g = braceGroup(seg.s);
        if (g === "partial") {
          // A brace group spanning quotes or expansions: bash expands it, Ember can't say into what.
          out.push({ ...word, segs: [{ t: "unres", why: "brace expansion" }] });
          budget.n = -1;
          return;
        }
        if (!g) continue;
        for (const alt of g.alts) {
          if (budget.n <= 0) return;
          const next: Seg[] = [...segs.slice(0, si), { t: "lit", s: seg.s.slice(0, g.from) + alt + seg.s.slice(g.to + 1), q: false }, ...segs.slice(si + 1)];
          go(next, budget);
        }
        return;
      }
      if (budget.n <= 0) return;
      budget.n--;
      out.push({ ...word, segs });
    };
    const budget = { n: MAX_SIMPLE };
    go(word.segs, budget);
    if (budget.n === -1) return [out[out.length - 1]];
    if (budget.n === 0 && out.length >= MAX_SIMPLE) return [{ ...word, segs: [{ t: "unres", why: "brace expansion" }] }];
    return out.length ? out : [word];
  }
}

/** The first brace group in an unquoted literal, its alternatives and bounds; "partial" when it doesn't close there. */
function braceGroup(s: string): { from: number; to: number; alts: string[] } | null | "partial" {
  for (let a = s.indexOf("{"); a >= 0; a = s.indexOf("{", a + 1)) {
    if (a > 0 && s[a - 1] === "$") continue;
    let depth = 0;
    let b = a;
    for (; b < s.length; b++) {
      if (s[b] === "{") depth++;
      else if (s[b] === "}") { depth--; if (depth === 0) break; }
    }
    if (b >= s.length) {
      if (s.slice(a).includes(",")) return "partial";
      continue;
    }
    const body = s.slice(a + 1, b);
    const seq = /^(-?\d+)\.\.(-?\d+)$/.exec(body) ?? /^([A-Za-z])\.\.([A-Za-z])$/.exec(body);
    if (seq) {
      const num = /^-?\d/.test(seq[1]);
      const x = num ? Number(seq[1]) : seq[1].charCodeAt(0);
      const y = num ? Number(seq[2]) : seq[2].charCodeAt(0);
      if (Math.abs(y - x) > MAX_SIMPLE) return "partial";
      const alts: string[] = [];
      for (let v = x; x <= y ? v <= y : v >= y; v += x <= y ? 1 : -1) alts.push(num ? String(v) : String.fromCharCode(v));
      return { from: a, to: b, alts };
    }
    // Split on top-level commas.
    const alts: string[] = [];
    let level = 0;
    let cur = "";
    for (const c of body) {
      if (c === "{") level++;
      if (c === "}") level--;
      if (c === "," && level === 0) { alts.push(cur); cur = ""; continue; }
      cur += c;
    }
    alts.push(cur);
    if (alts.length < 2) continue;
    return { from: a, to: b, alts };
  }
  return null;
}

/** `NAME=value` / `NAME+=value` before a command. */
function assignmentOf(w: PWord): { name: string; value: PWord; append: boolean } | null {
  const first = w.segs[0];
  if (!first || first.t !== "lit" || first.q) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(first.s);
  if (!m) return null;
  const restFirst = first.s.slice(m[0].length);
  const segs: Seg[] = [...(restFirst ? [{ t: "lit" as const, s: restFirst, q: false }] : []), ...w.segs.slice(1)];
  return { name: m[1], append: m[2] === "+", value: { segs, raw: w.raw.slice(m[0].length), subs: w.subs, proc: null, quoted: w.quoted } };
}

/** Tokenizes a POSIX command text (bash, zsh or sh rules). Never throws. */
export function lexPosix(text: string, shell: "bash" | "zsh" | "sh"): PosixParse {
  const p = new Parser(text, shell);
  try {
    const list = p.parseList(null);
    return { list, unclear: p.unclear, fatal: false, simpleCount: p.count };
  } catch (e) {
    if (!(e instanceof Fatal)) p.unclear.push({ why: "internal" });
    return { list: { items: [] }, unclear: p.unclear, fatal: true, simpleCount: p.count };
  }
}
