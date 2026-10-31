/**
 * The cmd tokenizer (design §3.4.3), used only for cmd text nested in another command (`cmd /c "…"` inside PowerShell,
 * a `.bat` run through WSL interop): cmd is never a run_command shell in v1 (L3). One line; `&` (one after the other),
 * `&&`, `||`, `|`; redirections; `"…"` quoting; `^` escapes outside quotes; `%NAME%` expanded once (the classifier
 * resolves the profile folders from facts; anything else is unresolved). Blocks, `for`, `if`, `goto`, `call`, labels,
 * `setlocal` and delayed expansion are unclear (D4.3 g). Pure.
 */

import type { Unclear } from "./lex-posix";

/** One part of a cmd word. */
export type CSeg = { t: "lit"; s: string; q: boolean } | { t: "var"; name: string } | { t: "unres"; why: string };

export interface CWord { segs: CSeg[]; raw: string; quoted: boolean }
export interface CRedir { fd: number | null; op: ">" | ">>" | "<"; target: CWord | null; dup?: string }
export interface CSimple { words: CWord[]; redirs: CRedir[] }
export interface CPipeline { cmds: CSimple[] }

/** A cmd line: pipelines joined by `&`, `&&` or `||`. */
export interface CmdParse {
  pipes: CPipeline[];
  ops: ("&" | "&&" | "||")[];
  unclear: Unclear[];
  fatal: boolean;
  simpleCount: number;
}

class Fatal extends Error {}

/** Tokenizes one cmd line. Never throws. */
export function lexCmd(text: string): CmdParse {
  const unclear: Unclear[] = [];
  const note = (why: string, says?: string): void => { if (!unclear.some(u => u.why === why)) unclear.push(says ? { why, says } : { why }); };
  const fatal = (why: string): never => { unclear.push({ why }); throw new Fatal(why); };
  const pipes: CPipeline[] = [];
  const ops: ("&" | "&&" | "||")[] = [];
  let count = 0;
  try {
    if (/[\r\n]/.test(text.replace(/\r?\n$/, ""))) fatal("more than one cmd line");
    const s = text.replace(/\r?\n$/, "");
    let i = 0;
    let cur: CPipeline = { cmds: [] };
    let cmd: CSimple = { words: [], redirs: [] };
    let word: CWord | null = null;
    let inQuote = false;
    const startWord = (): CWord => {
      if (!word) word = { segs: [], raw: "", quoted: false };
      return word;
    };
    const lit = (c: string, q: boolean): void => {
      const w = startWord();
      const last = w.segs[w.segs.length - 1];
      if (last && last.t === "lit" && last.q === q) last.s += c;
      else w.segs.push({ t: "lit", s: c, q });
    };
    let redirPending: CRedir | null = null;
    const endWord = (): void => {
      if (!word) return;
      if (redirPending) { redirPending.target = word; cmd.redirs.push(redirPending); redirPending = null; } else cmd.words.push(word);
      word = null;
    };
    const endCmd = (): void => {
      endWord();
      if (redirPending) fatal("redirection without a target");
      if (cmd.words.length === 0 && cmd.redirs.length === 0) fatal("empty command");
      cur.cmds.push(cmd);
      count++;
      cmd = { words: [], redirs: [] };
    };
    while (i < s.length) {
      const c = s[i];
      if (c === "%") {
        const m = /^%([A-Za-z_][A-Za-z0-9_()#$'{}[\]~.-]*)%/.exec(s.slice(i));
        if (m) {
          startWord().segs.push({ t: "var", name: m[1] });
          word!.raw += m[0];
          i += m[0].length;
          continue;
        }
        if (/^%~/.test(s.slice(i))) note("cmd-modifier", "It uses cmd's %~ modifiers.");
        lit("%", inQuote);
        word!.raw += c;
        i++;
        continue;
      }
      if (c === "!" && /^![A-Za-z_][A-Za-z0-9_]*!/.test(s.slice(i))) note("cmd-delayed", "It uses cmd's delayed expansion.");
      if (inQuote) {
        if (c === "\"") { inQuote = false; startWord().quoted = true; word!.raw += c; i++; continue; }
        lit(c, true);
        word!.raw += c;
        i++;
        continue;
      }
      if (c === "\"") { inQuote = true; startWord().quoted = true; word!.raw += c; i++; continue; }
      if (c === "^") {
        if (i + 1 >= s.length) fatal("a ^ at the end of the line");
        lit(s[i + 1], true);
        word!.quoted = true;
        word!.raw += s.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === " " || c === "\t" || ((c === "," || c === ";" || c === "=") && cmd.words.length === 0 && word !== null && !redirPending)) {
        endWord();
        i++;
        continue;
      }
      if (c === "(" && cmd.words.length === 0 && !word) fatal("a cmd block");
      if (c === "&" || c === "|") {
        const two = s.slice(i, i + 2);
        endCmd();
        if (two === "&&" || two === "||") {
          pipes.push(cur);
          ops.push(two);
          cur = { cmds: [] };
          i += 2;
        } else if (c === "&") {
          pipes.push(cur);
          ops.push("&");
          cur = { cmds: [] };
          i++;
        } else {
          i++;
        }
        continue;
      }
      if (c === ">" || c === "<") {
        let fd: number | null = null;
        const wv = word as CWord | null;
        const only = wv && wv.segs.length === 1 ? wv.segs[0] : null;
        if (only && only.t === "lit" && !only.q && /^\d$/.test(only.s) && s[i - 1] === only.s) {
          fd = Number(only.s);
          word = null;
        } else endWord();
        let op: ">" | ">>" | "<" = c === "<" ? "<" : ">";
        i++;
        if (c === ">" && s[i] === ">") { op = ">>"; i++; }
        if (s[i] === "&") {
          const m = /^&(\d)/.exec(s.slice(i));
          if (!m) fatal("a redirection Ember doesn't follow");
          cmd.redirs.push({ fd, op, target: null, dup: m![1] });
          i += 2;
          continue;
        }
        while (s[i] === " " || s[i] === "\t") i++;
        redirPending = { fd, op, target: null };
        continue;
      }
      lit(c, false);
      word!.raw += c;
      i++;
    }
    if (inQuote) fatal("unterminated \"");
    if (word || cmd.words.length || cmd.redirs.length || redirPending) endCmd();
    else if (ops.length) fatal("a line ending in an operator");
    if (cur.cmds.length) pipes.push(cur);
    return { pipes, ops, unclear, fatal: false, simpleCount: count };
  } catch (e) {
    if (!(e instanceof Fatal)) unclear.push({ why: "internal" });
    return { pipes: [], ops: [], unclear, fatal: true, simpleCount: count };
  }
}
