/**
 * The PowerShell tokenizer (design §3.4.2): a conservative subset of Windows PowerShell 5.1's grammar. Statements,
 * pipelines, commands with their parameters and arguments, strings, the variables Ember can resolve, subexpressions
 * (parsed and classified, their values unresolved), restricted script blocks for the filtering cmdlets, and
 * redirections. Everything else (flow control, functions, classes, hashtables, splatting, types, dot-sourcing, `&` with
 * anything but a literal path, `--%`, PowerShell 7's `&&`/`||`) is recorded as unclear (D4.3 g). Pure.
 */

import type { Unclear } from "./lex-posix";

/** One part of a PowerShell word. */
export type PsSeg = { t: "lit"; s: string; q: boolean } | { t: "var"; name: string } | { t: "unres"; why: string };

/** One element of a command after its name. */
export interface PsArg {
  kind: "word" | "param" | "block";
  /** The value's parts (a parameter's attached value after `:`). */
  segs: PsSeg[];
  raw: string;
  quoted: boolean;
  /** A parameter's name, without its dash. */
  param?: string;
  /** `-Name:value`. */
  attached?: boolean;
  /** An array argument (`a,b,c`): each element's parts. */
  items?: PsSeg[][];
  /** Statements parsed out of subexpressions in it (classified too). */
  subs: PsStatement[][];
}

export interface PsRedir { op: ">" | ">>" | "2>" | "2>>" | "*>" | "*>>"; target: PsArg | null; merge?: boolean }

/** A command: its name (a bare word, or a literal after `&`), its arguments and redirections. */
export interface PsCommand {
  kind: "command";
  name: PsArg;
  call: boolean;
  args: PsArg[];
  redirs: PsRedir[];
  /** PowerShell 7's trailing `&`. */
  background: boolean;
}

/**
 * A value in a pipeline (a variable, a literal, a parenthesised pipeline): its nested statements are classified, and
 * its redirections (`'x' > notes.txt`) judged like a command's.
 */
export interface PsExpr { kind: "expr"; subs: PsStatement[][]; raw: string; segs: PsSeg[]; redirs: PsRedir[] }

export type PsElement = PsCommand | PsExpr;

/** One statement: a pipeline, possibly assigned to a variable. */
export interface PsStatement { elements: PsElement[]; assign: string | null }

export interface PsParse {
  statements: PsStatement[];
  unclear: Unclear[];
  fatal: boolean;
  simpleCount: number;
}

class Fatal extends Error {}

const MAX_SIMPLE = 64;
const MAX_DEPTH = 8;

const SINGLE_QUOTES = "'‘’‚‛";
const DOUBLE_QUOTES = "\"“”„";
const DASHES = "-–—―";
const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\f" || c === "\v";
/** One character of a set (an empty string, past the end of the text, is none of them). */
const isSq = (c: string | undefined): boolean => c !== undefined && c.length === 1 && SINGLE_QUOTES.includes(c);
const isDq = (c: string | undefined): boolean => c !== undefined && c.length === 1 && DOUBLE_QUOTES.includes(c);
const isDash = (c: string | undefined): boolean => c !== undefined && c.length === 1 && DASHES.includes(c);

/** Keywords that start a statement Ember doesn't follow. */
const KEYWORDS = new Set([
  "if", "elseif", "else", "switch", "foreach", "for", "while", "do", "until", "function", "filter", "workflow", "class",
  "enum", "try", "catch", "finally", "trap", "begin", "process", "end", "param", "data", "dynamicparam", "configuration",
  "inlinescript", "parallel", "sequence", "using",
]);

/** Comparison and logical operators allowed in a restricted script block or expression (case variants too). */
const EXPR_OPS = /^-(c|i)?(eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|and|or|not|xor|is|isnot)$/i;

/**
 * Whether a script block's or expression's text uses only variables, member access without a call, literals, the
 * allowed operators, parentheses and commas (§3.4.2).
 */
export function restrictedExpression(text: string): boolean {
  let i = 0;
  const s = text;
  while (i < s.length) {
    const c = s[i];
    if (isSpace(c) || c === "\n" || c === "\r") { i++; continue; }
    if (c === "$") {
      const m = /^\$(\{[^}]*\}|[A-Za-z_?^$][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?)/.exec(s.slice(i));
      if (!m) return false;
      if (/^\$executioncontext/i.test(m[0])) return false;
      i += m[0].length;
      while (s[i] === ".") {
        const mm = /^\.[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
        if (!mm) return false;
        i += mm[0].length;
        if (s[i] === "(") return false;
      }
      if (s[i] === "[") return false;
      continue;
    }
    if (isSq(c)) {
      let k = i + 1;
      for (; k < s.length; k++) {
        if (isSq(s[k])) { if (isSq(s[k + 1])) { k++; continue; } break; }
      }
      if (k >= s.length) return false;
      i = k + 1;
      continue;
    }
    if (isDq(c)) {
      let k = i + 1;
      for (; k < s.length; k++) {
        if (s[k] === "`") { k++; continue; }
        if (s[k] === "$" && (s[k + 1] === "(" || s[k + 1] === "{")) return false;
        if (isDq(s[k])) break;
      }
      if (k >= s.length) return false;
      i = k + 1;
      continue;
    }
    const num = /^(0x[0-9a-f]+|\d+(\.\d+)?)(kb|mb|gb|tb|pb)?/i.exec(s.slice(i));
    if (num && /\d/.test(c)) { i += num[0].length; continue; }
    if (isDash(c)) {
      const op = /^[-–—―][A-Za-z]+/.exec(s.slice(i));
      if (op) {
        if (!EXPR_OPS.test(`-${op[0].slice(1)}`)) return false;
        i += op[0].length;
        continue;
      }
      i++;
      continue;
    }
    if (s.startsWith("..", i)) { i += 2; continue; }
    if ("!+*/%(),".includes(c)) { i++; continue; }
    return false;
  }
  return true;
}

/** The tokenizer's state over one text. */
class Parser {
  i = 0;
  unclear: Unclear[] = [];
  count = 0;

  constructor(readonly s: string, public depth = 0) {}

  private peek(n = 0): string { return this.s[this.i + n] ?? ""; }
  private eof(): boolean { return this.i >= this.s.length; }
  fatal(why: string): never { this.unclear.push({ why }); throw new Fatal(why); }
  note(why: string, says?: string): void { if (!this.unclear.some(u => u.why === why)) this.unclear.push(says ? { why, says } : { why }); }

  /** Spaces, comments and line continuations (a backtick before a newline). */
  private skipSpaces(): void {
    for (;;) {
      const c = this.peek();
      if (isSpace(c)) { this.i++; continue; }
      if (c === "`" && (this.peek(1) === "\n" || (this.peek(1) === "\r" && this.peek(2) === "\n"))) { this.i += this.peek(1) === "\r" ? 3 : 2; continue; }
      if (c === "<" && this.peek(1) === "#") {
        const end = this.s.indexOf("#>", this.i + 2);
        if (end < 0) this.fatal("unterminated <#");
        this.i = end + 2;
        continue;
      }
      if (c === "#") {
        while (!this.eof() && this.peek() !== "\n") this.i++;
        continue;
      }
      return;
    }
  }

  private skipSeparators(): void {
    for (;;) {
      this.skipSpaces();
      const c = this.peek();
      if (c === "\n" || c === "\r" || c === ";") { this.i++; continue; }
      return;
    }
  }

  /** Statements until the end, or until `)` / `}` when nested. */
  parseStatements(term: ")" | null): PsStatement[] {
    const out: PsStatement[] = [];
    for (;;) {
      this.skipSeparators();
      if (this.eof()) {
        if (term) this.fatal("unterminated (");
        return out;
      }
      if (term && this.peek() === term) return out;
      out.push(this.parseStatement(term));
    }
  }

  private parseStatement(term: ")" | null): PsStatement {
    this.skipSpaces();
    let assign: string | null = null;
    const word = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(this.s.slice(this.i));
    if (word && KEYWORDS.has(word[0].toLowerCase()) && !/[A-Za-z0-9_-]/.test(this.s[this.i + word[0].length] ?? "")) {
      this.fatal(`the keyword ${word[0].toLowerCase()}`);
    }
    if (this.peek() === "$") {
      const m = /^\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?)\s*([-+*/%]|\?\?)?=(?!=)/.exec(this.s.slice(this.i));
      if (m) {
        assign = m[1].replace(/^\{|\}$/g, "");
        this.i += m[0].length;
        this.skipSpaces();
      }
    }
    const elements: PsElement[] = [this.parseElement(true, term)];
    for (;;) {
      this.skipSpaces();
      if (this.peek() === "|" && this.peek(1) !== "|") {
        this.i++;
        this.skipSeparatorsInPipe();
        elements.push(this.parseElement(false, term));
        continue;
      }
      break;
    }
    this.skipSpaces();
    const c = this.peek();
    if (this.s.startsWith("&&", this.i) || this.s.startsWith("||", this.i)) this.fatal("&& or || (PowerShell 7 only)");
    if (!(c === "" || c === "\n" || c === "\r" || c === ";" || (term && c === term))) this.fatal(`unexpected ${c}`);
    return { elements, assign };
  }

  /** After `|`, a newline may follow. */
  private skipSeparatorsInPipe(): void {
    for (;;) {
      this.skipSpaces();
      if (this.peek() === "\n" || this.peek() === "\r") { this.i++; continue; }
      return;
    }
  }

  private parseElement(first: boolean, term: ")" | null): PsElement {
    this.skipSpaces();
    const c = this.peek();
    if (c === "&") {
      if (this.peek(1) === "&") this.fatal("&&");
      this.i++;
      this.skipSpaces();
      const name = this.parseArg(term);
      if (!name || name.kind !== "word" || name.segs.some(s => s.t !== "lit") || name.subs.length) {
        this.note("call-operator", "It runs a program Ember can't name.");
        return this.parseCommandRest({ kind: "word", segs: [{ t: "unres", why: "call" }], raw: name?.raw ?? "&", quoted: false, subs: name?.subs ?? [] }, true, term);
      }
      return this.parseCommandRest(name, true, term);
    }
    if (c === "." && (isSpace(this.peek(1)) || isSq(this.peek(1)) || isDq(this.peek(1)))) this.fatal("dot-sourcing");
    if (c === "[") this.fatal("a [Type]");
    if (c === "{") this.fatal("a script block");
    if (c === "@" && this.peek(1) === "{") this.fatal("a hashtable");
    if (c === "$" || c === "(" || (c === "@" && this.peek(1) === "(") || isSq(c) || isDq(c) || /\d/.test(c) || (isDash(c) && first)) {
      if (!first && !(c === "$" || c === "(")) this.fatal("a value after |");
      return this.parseExpression(term);
    }
    const name = this.parseArg(term);
    if (!name) this.fatal(`unexpected ${c}`);
    return this.parseCommandRest(name, false, term);
  }

  /** A value element: its tokens must be the restricted kind; nested pipelines in it are parsed and classified. */
  private parseExpression(term: ")" | null): PsExpr {
    const start = this.i;
    const subs: PsStatement[][] = [];
    const segs: PsSeg[] = [];
    const redirs: PsRedir[] = [];
    let cut = -1;
    for (;;) {
      this.skipSpaces();
      const c = this.peek();
      if (this.eof() || c === "\n" || c === "\r" || c === ";" || c === "|" || (term && c === term) || c === ")") break;
      const at = this.i;
      const r = c === ">" || /^[1-6*]>/.test(this.s.slice(this.i, this.i + 2)) ? this.tryRedir(term) : null;
      if (r) {
        if (cut < 0) cut = at;
        for (const sub of r.target?.subs ?? []) subs.push(sub);
        redirs.push(r);
        continue;
      }
      if (redirs.length) this.fatal("a value after a redirection");
      if (c === "(" || (c === "$" && this.peek(1) === "(") || (c === "@" && this.peek(1) === "(")) {
        this.i += c === "(" ? 1 : 2;
        subs.push(this.nested());
        segs.push({ t: "unres", why: "subexpression" });
        continue;
      }
      if (c === "{" || c === "[" || c === "@") this.fatal(`${c} in a value`);
      const a = this.parseArg(term);
      if (!a) this.fatal(`unexpected ${c}`);
      subs.push(...a.subs);
      if (a.kind === "param") {
        if (!EXPR_OPS.test(`-${a.param ?? ""}`)) this.fatal("an operator Ember doesn't follow");
      } else segs.push(...a.segs);
    }
    const raw = this.s.slice(start, cut < 0 ? this.i : cut).trimEnd();
    // Member calls and types anywhere in the value make it unclear.
    if (/\.[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(raw.replace(/'[^']*'/g, "''")) || /\[[A-Za-z_.]+\]/.test(raw.replace(/'[^']*'/g, "''"))) {
      this.note("method-call", "It calls a .NET method Ember can't follow.");
    }
    if (/\$executioncontext/i.test(raw)) this.note("execution-context", "It uses $ExecutionContext.");
    return { kind: "expr", subs, raw, segs, redirs };
  }

  /** `( … )`, `$( … )` or `@( … )` already opened: the statements inside, then the closing `)`. */
  private nested(): PsStatement[] {
    this.depth++;
    if (this.depth > MAX_DEPTH) this.note("depth", "It nests commands too deeply for Ember to follow.");
    const st = this.parseStatements(")");
    if (this.peek() !== ")") this.fatal("unterminated (");
    this.i++;
    this.depth--;
    return st;
  }

  private parseCommandRest(name: PsArg, call: boolean, term: ")" | null): PsCommand {
    const cmd: PsCommand = { kind: "command", name, call, args: [], redirs: [], background: false };
    this.count++;
    if (this.count > MAX_SIMPLE) this.note("too-many", "It has more commands than Ember can check one by one.");
    for (;;) {
      this.skipSpaces();
      const c = this.peek();
      if (this.eof() || c === "\n" || c === "\r" || c === ";" || c === "|" || (term && c === term) || c === ")") break;
      if (c === "&") {
        if (this.peek(1) === "&") break;
        this.i++;
        cmd.background = true;
        continue;
      }
      if (this.s.startsWith("--%", this.i)) this.fatal("--% (stop-parsing)");
      const r = this.tryRedir(term);
      if (r) { cmd.redirs.push(r); continue; }
      if (c === "<") this.fatal("< (reserved)");
      if (c === "@" && /[A-Za-z_]/.test(this.peek(1))) this.fatal("splatting");
      if (c === "@" && this.peek(1) === "{") this.fatal("a hashtable");
      if (c === "{") {
        const end = this.matchBrace();
        const text = this.s.slice(this.i + 1, end);
        cmd.args.push({ kind: "block", segs: [{ t: "lit", s: text, q: true }], raw: this.s.slice(this.i, end + 1), quoted: true, subs: [] });
        this.i = end + 1;
        continue;
      }
      if (c === "[") this.note("type-arg", "It uses a [Type] Ember doesn't follow.");
      const a = this.parseArg(term);
      if (!a) this.fatal(`unexpected ${c}`);
      cmd.args.push(a);
    }
    return cmd;
  }

  /** The index of the `}` closing the `{` at the cursor (quotes respected). */
  private matchBrace(): number {
    let depth = 0;
    for (let k = this.i; k < this.s.length; k++) {
      const c = this.s[k];
      if (isSq(c)) { while (++k < this.s.length && !isSq(this.s[k])); continue; }
      if (isDq(c)) { while (++k < this.s.length && !isDq(this.s[k])) if (this.s[k] === "`") k++; continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) return k; }
    }
    return this.fatal("unterminated {");
  }

  private tryRedir(term: ")" | null): PsRedir | null {
    const m = /^([1-6*])?(>>|>)(&[12])?/.exec(this.s.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    const n = m[1];
    if (m[3]) return { op: n === "*" ? "*>" : "2>", target: null, merge: true };
    const base = n === "*" ? "*" : n && n !== "1" ? "2" : "";
    const op = `${base}${m[2]}` as PsRedir["op"];
    this.skipSpaces();
    const target = this.parseArg(term);
    if (!target || target.kind !== "word") this.fatal("a redirection without a target");
    return { op, target };
  }

  /** One argument, parameter or array at the cursor, or null at an operator. */
  parseArg(term: ")" | null): PsArg | null {
    const c = this.peek();
    if (this.eof() || c === "\n" || c === "\r" || c === ";" || c === "|" || c === ")" || (term && c === term)) return null;
    const start = this.i;
    if (isDash(c) && /[A-Za-z_?]/.test(this.peek(1))) {
      const m = /^[-–—―]([A-Za-z_?][A-Za-z0-9_?-]*)(:?)/.exec(this.s.slice(this.i))!;
      this.i += m[0].length;
      if (m[2] === ":") {
        const v = this.parseWord(term);
        return { kind: "param", param: m[1], attached: true, segs: v?.segs ?? [], raw: this.s.slice(start, this.i), quoted: v?.quoted ?? false, subs: v?.subs ?? [], items: v?.items };
      }
      return { kind: "param", param: m[1], segs: [], raw: this.s.slice(start, this.i), quoted: false, subs: [] };
    }
    if (this.s.startsWith("--", this.i) && (isSpace(this.peek(2)) || this.peek(2) === "")) {
      this.i += 2;
      return { kind: "param", param: "", segs: [], raw: "--", quoted: false, subs: [] };
    }
    return this.parseWord(term);
  }

  /** A word (bare, quoted, variables, subexpressions, concatenated) and a comma-separated array of them. */
  private parseWord(term: ")" | null): PsArg | null {
    const start = this.i;
    const items: PsSeg[][] = [];
    let segs: PsSeg[] = [];
    const subs: PsStatement[][] = [];
    let quoted = false;
    const lit = (s: string, q: boolean): void => {
      const last = segs[segs.length - 1];
      if (last && last.t === "lit" && last.q === q) last.s += s;
      else segs.push({ t: "lit", s, q });
    };
    for (;;) {
      if (this.eof()) break;
      const c = this.peek();
      if (isSpace(c) || c === "\n" || c === "\r" || c === ";" || c === "|" || c === ")" || (term && c === term) || c === "{" || c === "}") break;
      if (c === "&") break;
      if (c === ">" || (c === "<" && this.peek(1) !== "#")) break;
      if (c === ",") {
        items.push(segs);
        segs = [];
        this.i++;
        this.skipSpaces();
        continue;
      }
      if (c === "`") {
        const n = this.peek(1);
        if (n === "") { lit("`", false); this.i++; continue; }
        // A backtick before a line break continues the line: it ends the word, like a space.
        if (n === "\n" || (n === "\r" && this.peek(2) === "\n")) break;
        if (/[0abefnrtvu]/.test(n)) this.note("backtick-escape", "It uses a backtick escape Ember doesn't decode.");
        lit(n, true);
        quoted = true;
        this.i += 2;
        continue;
      }
      if (isSq(c)) {
        quoted = true;
        let k = this.i + 1;
        let body = "";
        for (; k < this.s.length; k++) {
          if (isSq(this.s[k])) {
            if (isSq(this.s[k + 1])) { body += "'"; k++; continue; }
            break;
          }
          body += this.s[k];
        }
        if (k >= this.s.length) this.fatal("unterminated '");
        lit(body, true);
        this.i = k + 1;
        continue;
      }
      if (isDq(c)) {
        quoted = true;
        this.parseDouble(segs, subs);
        continue;
      }
      if (c === "@" && (isSq(this.peek(1)) || isDq(this.peek(1))) && (this.peek(2) === "\n" || this.peek(2) === "\r")) {
        quoted = true;
        this.parseHereString(segs, subs);
        continue;
      }
      if (c === "$" || (c === "@" && this.peek(1) === "(")) {
        if (this.peek(1) === "(") {
          this.i += 2;
          subs.push(this.nested());
          segs.push({ t: "unres", why: "subexpression" });
          continue;
        }
        if (c === "@") { lit("@", false); this.i++; continue; }
        this.parseVariable(segs, false);
        continue;
      }
      if (c === "(" && segs.length === 0) {
        this.i++;
        subs.push(this.nested());
        segs.push({ t: "unres", why: "subexpression" });
        continue;
      }
      if (c === "(") this.fatal("a ( inside a word");
      lit(isDash(c) ? "-" : c, false);
      this.i++;
    }
    if (this.i === start) return null;
    const raw = this.s.slice(start, this.i);
    if (items.length) {
      items.push(segs);
      return { kind: "word", segs: [{ t: "unres", why: "array" }], items, raw, quoted, subs };
    }
    return { kind: "word", segs, raw, quoted, subs };
  }

  /** `"…"`: `$var`, `$(…)`, backtick escapes, `""`. */
  private parseDouble(segs: PsSeg[], subs: PsStatement[][]): void {
    this.i++;
    const lit = (s: string): void => {
      const last = segs[segs.length - 1];
      if (last && last.t === "lit" && last.q) last.s += s;
      else segs.push({ t: "lit", s, q: true });
    };
    for (;;) {
      if (this.eof()) this.fatal("unterminated \"");
      const c = this.peek();
      if (isDq(c)) {
        if (isDq(this.peek(1))) { lit("\""); this.i += 2; continue; }
        this.i++;
        return;
      }
      if (c === "`") {
        const n = this.peek(1);
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "", a: "", b: "", e: "", f: "", v: "" };
        if (n in map) {
          if (map[n] === "" && n !== "0") this.note("backtick-escape", "It uses a backtick escape Ember doesn't decode.");
          lit(map[n]);
        } else lit(n);
        this.i += 2;
        continue;
      }
      if (c === "$") {
        if (this.peek(1) === "(") {
          this.i += 2;
          subs.push(this.nested());
          segs.push({ t: "unres", why: "subexpression" });
          continue;
        }
        this.parseVariable(segs, true);
        continue;
      }
      lit(c);
      this.i++;
    }
  }

  /** `@'…'@` and `@"…"@` (the closing marker at the start of a line). */
  private parseHereString(segs: PsSeg[], subs: PsStatement[][]): void {
    const q = this.peek(1);
    const expandable = isDq(q);
    const bodyStart = this.s.indexOf("\n", this.i) + 1;
    const close = new RegExp(`\\n[${expandable ? DOUBLE_QUOTES : SINGLE_QUOTES}]@`);
    const m = close.exec(this.s.slice(bodyStart - 1));
    if (!m) this.fatal("unterminated here-string");
    const end = bodyStart - 1 + m.index;
    const body = this.s.slice(bodyStart, end).replace(/\r$/, "");
    this.i = end + m[0].length;
    if (!expandable) { segs.push({ t: "lit", s: body, q: true }); return; }
    if (/\$/.test(body)) {
      if (/\$\(/.test(body)) {
        const sub = new Parser(body, this.depth + 1);
        // Subexpressions in an expandable here-string run: parse each and classify it.
        let k = body.indexOf("$(");
        while (k >= 0) {
          sub.i = k + 2;
          try { subs.push(sub.nested()); } catch (e) { this.absorb(sub); throw e; }
          k = body.indexOf("$(", sub.i);
        }
        this.absorb(sub);
      }
      segs.push({ t: "unres", why: "expandable here-string" });
      return;
    }
    segs.push({ t: "lit", s: body, q: true });
  }

  private absorb(sub: Parser): void {
    for (const u of sub.unclear) this.note(u.why, u.says);
    this.count += sub.count;
  }

  /** `$name`, `$env:NAME`, `${…}`, `$_`, member access (a method call is unclear). */
  private parseVariable(segs: PsSeg[], inString: boolean): void {
    const rest = this.s.slice(this.i);
    let m = /^\$\{([^}]*)\}/.exec(rest);
    let name: string;
    if (m) name = m[1];
    else {
      m = /^\$([A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?|[?^$_])/.exec(rest);
      if (!m) {
        segs.push({ t: "lit", s: "$", q: inString });
        this.i++;
        return;
      }
      name = m[1];
    }
    this.i += m[0].length;
    if (/^executioncontext$/i.test(name)) this.note("execution-context", "It uses $ExecutionContext.");
    let member = "";
    if (!inString) {
      while (this.peek() === "." && /[A-Za-z_]/.test(this.peek(1))) {
        const mm = /^\.[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i))!;
        this.i += mm[0].length;
        member += mm[0];
        if (this.peek() === "(") this.fatal("a method call");
      }
      if (this.peek() === "[") this.fatal("an index");
    }
    segs.push({ t: "var", name: name + member });
  }
}

/** Tokenizes a PowerShell 5.1 command text. Never throws. */
export function lexPowerShell(text: string): PsParse {
  const p = new Parser(text);
  try {
    const statements = p.parseStatements(null);
    return { statements, unclear: p.unclear, fatal: false, simpleCount: p.count };
  } catch (e) {
    if (!(e instanceof Fatal)) p.unclear.push({ why: "internal" });
    return { statements: [], unclear: p.unclear, fatal: true, simpleCount: p.count };
  }
}
