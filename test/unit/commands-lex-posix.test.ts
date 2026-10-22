/**
 * The POSIX tokenizer (design §3.4.1): lists, pipelines, subshells and groups, words with their quoting and expansions
 * kept apart, redirections and here-documents, brace expansion in bash and zsh, and every construct it can't follow
 * recorded as unclear (fatal when the structure itself can't be trusted).
 */

import { describe, expect, it } from "vitest";
import { lexPosix, MAX_DEPTH, MAX_SIMPLE, type PList, type PWord } from "../../app/main/commands/lex-posix";

/** A word as one string: quoted literals in '…', variables as $NAME, tildes as ~user, unresolved parts as <why>. */
function word(x: PWord): string {
  const body = x.segs.map(s => (s.t === "lit" ? (s.q ? `'${s.s}'` : s.s) : s.t === "var" ? `$${s.name}` : s.t === "tilde" ? `~${s.user}` : `<${s.why}>`)).join("");
  return body + (x.proc ? `{${x.proc}}` : "") + (x.subs.length ? `{subs:${x.subs.length}}` : "");
}

/** A whole list as one line: simple commands in [ ], groups by kind, operators between. */
function show(l: PList): string {
  return l.items.map(ao => ao.pipes.map((p, i) => (p.bang ? "! " : "") + p.cmds.map(c => {
    if (c.kind !== "simple") return `${c.kind}(${show(c.body)})`;
    const assigns = c.assigns.map(a => `${a.name}=${word(a.value)}`);
    const redirs = c.redirs.map(r => {
      const hd = r.heredoc ? `<<${JSON.stringify(r.heredoc.body)}${r.heredoc.quoted ? " quoted" : ""}${r.heredoc.subs.length ? ` subs:${r.heredoc.subs.length}` : ""}>` : "";
      return `${r.fd ?? ""}${r.op}${r.target ? word(r.target) : ""}${r.dup !== undefined ? `dup${r.dup}` : ""}${hd}`;
    });
    return `[${[...assigns, ...c.words.map(word), ...redirs].join(" ")}]`;
  }).join(" | ") + (i < ao.ops.length ? ` ${ao.ops[i]} ` : "")).join("") + (ao.background ? " &" : "")).join(" ; ");
}

const lex = (text: string, shell: "bash" | "zsh" | "sh" = "bash"): string => show(lexPosix(text, shell).list);
const why = (text: string, shell: "bash" | "zsh" | "sh" = "bash"): string[] => lexPosix(text, shell).unclear.map(u => u.why);

describe("lexPosix: structure", () => {
  it.each([
    ["ls -la src", "[ls -la src]"],
    ["a && b || c; d &", "[a] && [b] || [c] ; [d] &"],
    ["a | b |& c", "[a] | [b] | [c]"],
    ["! a", "! [a]"],
    ["(cd x && ls)", "subshell([cd x] && [ls])"],
    ["{ ls; }", "group([ls])"],
    ["ls; rm x", "[ls] ; [rm x]"],
    ["ls # rm x", "[ls]"],
    ["ls \\\n -la", "[ls -la]"],
    ["ls\tx", "[ls x]"],
    ["FOO=bar make", "[FOO=bar make]"],
    ["x=$(rm y)", "[x=<command substitution>{subs:1}]"],
  ])("%j", (text, want) => {
    expect(lex(text)).toBe(want);
  });

  it("splits keywords into commands of their own, for the classifier to call unclear", () => {
    expect(lex("if true; then rm x; fi")).toBe("[if true] ; [then rm x] ; [fi]");
  });

  it("counts the simple commands, substitutions included", () => {
    expect(lexPosix("$(echo rm) x", "bash").simpleCount).toBe(2);
    expect(lexPosix("a && b || c; d &", "bash").simpleCount).toBe(4);
  });
});

describe("lexPosix: words", () => {
  it.each([
    ["r''m x", "[r''m x]"],
    ['"r"m x', "['r'm x]"],
    ["\\rm x", "['r'm x]"],
    ["$HOME/x ${HOME}", "[$HOME/x $HOME]"],
    ["${x:-rm} y", "[<expansion> y]"],
    ["$(echo rm) x", "[<command substitution>{subs:1} x]"],
    ["`echo rm` x", "[<command substitution>{subs:1} x]"],
    ["echo $((1+2))", "[echo <arithmetic>]"],
    ["echo $'a\\x41\\n'", "[echo 'aA\n']"],
    ["ls ~/x ~bob/y", "[ls ~/x ~bob/y]"],
    ["echo $1 $@ $#", "[echo <$1> <$@> <$#>]"],
    ["echo ${#x} ${x[0]}", "[echo <expansion> <expansion>]"],
    ["echo 'it''s'", "[echo 'its']"],
    ['echo "$(echo "nested")"', "[echo <command substitution>{subs:1}]"],
    ["echo a\\ b", "[echo a' 'b]"],
    ["echo ${HOME}x \"$HOME\" '$HOME'", "[echo $HOMEx $HOME '$HOME']"],
    ['echo "a $(b) c"', "[echo 'a '<command substitution>' c'{subs:1}]"],
    ["echo \\$HOME", "[echo '$'HOME]"],
    ['echo "\\"q\\""', "[echo '\"q\"']"],
    ["diff <(ls a) <(ls b)", "[diff <process substitution>{<}{subs:1} <process substitution>{<}{subs:1}]"],
  ])("%j", (text, want) => {
    expect(lex(text)).toBe(want);
  });

  it("marks a word quoted when any part of it was", () => {
    const w = lexPosix("r''m", "bash").list.items[0].pipes[0].cmds[0];
    expect(w.kind === "simple" && w.words[0].quoted).toBe(true);
  });

  it("expands braces in bash and zsh, not in sh", () => {
    expect(lex("cp file{,.bak}")).toBe("[cp file file.bak]");
    expect(lex("cp file{,.bak}", "zsh")).toBe("[cp file file.bak]");
    expect(lex("cp file{,.bak}", "sh")).toBe("[cp file{,.bak}]");
    expect(lex("echo {a..c}")).toBe("[echo a b c]");
    expect(lex("echo {a,b}{1,2}")).toBe("[echo a1 a2 b1 b2]");
  });
});

describe("lexPosix: redirections and here-documents", () => {
  it("reads every redirection form", () => {
    expect(lex("ls > out 2>&1 >> log < in &> all 2> err >| f <<< word")).toBe("[ls >out 2>&dup1 >>log <in &>all 2>err >|f <<<word]");
    expect(lex("ls &>> f")).toBe("[ls &>>f]");
    expect(lex("ls 1>f 2>>g")).toBe("[ls 1>f 2>>g]");
    expect(lex("ls >&2")).toBe("[ls >&dup2]");
    expect(lex("exec 3>&-")).toBe("[exec 3>&dup-]");
  });

  it("parses an unquoted here-document's substitutions, and not a quoted one's", () => {
    expect(lex("cat <<EOF\n$(rm x)\nEOF")).toBe('[cat <<<<"$(rm x)\\n" subs:1>]');
    expect(lex("cat <<'EOF'\n$(rm x)\nEOF")).toBe('[cat <<<<"$(rm x)\\n" quoted>]');
    expect(lex("cat <<-EOF\n\tx\n\tEOF")).toBe('[cat <<-<<"x\\n">]');
  });
});

describe("lexPosix: what it can't follow", () => {
  it.each([
    ['echo "x', "unterminated \""],
    ["a &&", "empty command"],
    ["echo $(", "unterminated ("],
    ["echo )", "unexpected )"],
    ["case x in a) rm;; esac", "unexpected )"],
    ["f() { rm x; }", "a ( inside a word"],
  ])("gives up on %j", (text, reason) => {
    const p = lexPosix(text, "bash");
    expect(p.fatal).toBe(true);
    expect(p.unclear.map(u => u.why)).toContain(reason);
  });

  it("records zsh's own syntax as unclear", () => {
    expect(why("=ls", "zsh")).toContain("zsh");
    expect(why("ls **/*.ts", "zsh")).toContain("zsh");
    expect(why("echo ${(f)x}", "zsh")).toContain("zsh");
    expect(lexPosix("ls *(.)", "zsh").fatal).toBe(true);
    expect(lexPosix("ls <1-10>", "zsh").fatal).toBe(true);
  });

  it("records bash's locale strings as unclear", () => {
    expect(why('echo $"x"')).toContain("locale-string");
  });

  it(`notes more than ${MAX_SIMPLE} commands and nesting deeper than ${MAX_DEPTH}`, () => {
    expect(why(`true${" && true".repeat(MAX_SIMPLE)}`)).toContain("too-many");
    expect(why(`echo ${"$(".repeat(MAX_DEPTH + 2)}x${")".repeat(MAX_DEPTH + 2)}`)).toContain("depth");
    expect(why(`true${" && true".repeat(MAX_SIMPLE - 2)}`)).toEqual([]);
  });

  it("never throws", () => {
    for (const text of ["", "\0", "$((", "<<", "<<EOF", "'''", "\\", "$(`$(`", "{", "}", ")(", "|||", ";;;", "&&&", "\u202e"]) {
      expect(() => lexPosix(text, "bash")).not.toThrow();
      expect(() => lexPosix(text, "zsh")).not.toThrow();
      expect(() => lexPosix(text, "sh")).not.toThrow();
    }
  });
});
