/**
 * The cmd tokenizer (design §3.4.3): one line, `&`, `&&`, `||` and `|`, redirections, `"…"` quoting, `^` escapes,
 * `%NAME%` kept apart for the classifier to resolve, and blocks, delayed expansion, `%~` modifiers and more than one
 * line as unclear (`for`, `if`, `goto`, `call` and labels are left to the classifier's built-ins, which call them
 * unclear).
 */

import { describe, expect, it } from "vitest";
import { lexCmd, type CWord } from "../../app/main/commands/lex-cmd";

const word = (x: CWord): string => x.segs.map(s => (s.t === "lit" ? (s.q ? `'${s.s}'` : s.s) : s.t === "var" ? `%${s.name}%` : `<${s.why}>`)).join("");
function lex(text: string): string {
  const p = lexCmd(text);
  return p.pipes.map((pp, i) => pp.cmds.map(c => `[${[...c.words.map(word), ...c.redirs.map(r => `${r.fd ?? ""}${r.op}${r.target ? word(r.target) : ""}${r.dup !== undefined ? `&${r.dup}` : ""}`)].join(" ")}]`).join(" | ") + (i < p.ops.length ? ` ${p.ops[i]} ` : "")).join("");
}

describe("lexCmd", () => {
  it.each([
    ["dir /s /b", "[dir /s /b]"],
    ['del "my file.txt"', "[del 'my file.txt']"],
    ["echo %USERPROFILE%\\x", "[echo %USERPROFILE%\\x]"],
    ["a & b && c || d", "[a] & [b] && [c] || [d]"],
    ["dir | findstr x", "[dir] | [findstr x]"],
    ["echo x > out.txt 2>&1", "[echo x >out.txt 2>&1]"],
    ["echo x>out.txt", "[echo x >out.txt]"],
    ["type a >> b", "[type a >>b]"],
    ["sort < in.txt", "[sort <in.txt]"],
    ["echo x 2> err.txt 1> out.txt", "[echo x 2>err.txt 1>out.txt]"],
    ["echo ^& x", "[echo '&' x]"],
    ["^d^e^l x", "['del' x]"],
    ["@echo off", "[@echo off]"],
    ["echo 100%", "[echo 100%]"],
    ["cd /d C:\\x", "[cd /d C:\\x]"],
    ["if exist x del x", "[if exist x del x]"],
    ["call x.bat", "[call x.bat]"],
    [":label", "[:label]"],
  ])("%j", (text, want) => {
    expect(lex(text)).toBe(want);
  });

  it("keeps the raw program word, so carets can be seen", () => {
    expect(lexCmd("^d^e^l x").pipes[0].cmds[0].words[0].raw).toBe("^d^e^l");
  });

  it("counts the simple commands", () => {
    expect(lexCmd("a & b && c || d").simpleCount).toBe(4);
  });

  it.each([
    ["(echo x)", "a cmd block"],
    ['echo "unbalanced', 'unterminated "'],
    ["echo a\nb", "more than one cmd line"],
  ])("gives up on %j", (text, reason) => {
    const p = lexCmd(text);
    expect(p.fatal).toBe(true);
    expect(p.unclear.map(u => u.why)).toContain(reason);
  });

  it("notes delayed expansion and %~ modifiers", () => {
    expect(lexCmd("echo !x!").unclear.map(u => u.why)).toContain("cmd-delayed");
    expect(lexCmd("echo %~dp0").unclear.map(u => u.why)).toContain("cmd-modifier");
  });

  it("never throws", () => {
    for (const text of ["", "\"", "^", "%", "%%", "(", ")", "&", "|", "<", ">", "&&&", "\u0000"]) expect(() => lexCmd(text)).not.toThrow();
  });
});
