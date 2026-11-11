/**
 * Writing a simple `[[ … ]]` test as `[ … ]` before a command line is judged (app/main/commands/unroll.ts,
 * commands-remote-r6-2), and never a `for` loop: every loop is judged as written, and asks, as on main
 * (commands-remote-y7-1, y7-2, y7-3).
 */

import { describe, expect, it } from "vitest";
import { judgedText, plainTests } from "../../app/main/commands/unroll";

describe("a for loop on a command line, which is judged as written (commands-remote-y7-1, y7-2, y7-3)", () => {
  it("judges every for loop by its own text, never by its passes written out, however plain it is", () => {
    for (const line of [
      "for i in 1 2 3; do echo $i; done", "for f in --hard; do git reset $f; done", "for f in a.txt b.txt; do wc -l \"$f\"; done",
      "cd src; for f in a.txt b.txt; do wc -l \"$f\"; done; echo ok", "for f in a b\ndo\n  rm -f $f.log\ndone\nls",
      // A redirection in front of the body's first command was dropped from the written-out text (y7-1).
      "for f in a; do >~/.bashrc echo $f; done", "for f in a; do 2>~/.profile ls $f; done", "for f in a; do >src/main.c echo $f; done",
      "for f in a; do >printf printf -vf %s --hard; git reset $f; done", "for f in a; do 2>printf print -vf -- --hard; git reset $f; done",
      // The list's word made printf's or print's option one that sets the loop's variable (y7-2).
      "for f in vf; do printf -$f %s --hard; git reset $f; done", "for f in -vf; do printf ''$f %s --hard; git reset $f; done",
      "for f in vf; do print -n$f -- --hard; git reset $f; done", "for f in vf; do print -$f -- --hard; git reset \"$f\"; done",
      "for f in -vf; do print ''$f -- --hard; git reset $f; done", "for i in v v; do git reset $x; printf -$i x %s --hard; done",
      // bash's alias table set with no subscript made `0` a command that set it (y7-3).
      "BASH_ALIASES='printf -vf %s --hard'\nfor f in a; do 0; git reset $f; done", "POSIXLY_CORRECT=1\nBASH_ALIASES+='printf -vf %s --hard'\nfor f in a; do 0; git reset $f; done",
      // A test on a line with a loop is left as written too.
      "for f in a b; do [[ -f x ]] && echo $f; done", "[[ -f x ]] && echo yes; for i in 1 2; do echo $i; done",
    ]) expect(judgedText(line), line).toBe(line);
    expect(judgedText("ls; pwd")).toBe("ls; pwd");
    expect(judgedText("[[ -f package.json ]] && echo yes")).toBe("[ -f package.json ] && echo yes");
  });
});

describe("a simple [[ … ]] test written as [ … ] (commands-remote-r6-2)", () => {
  it("writes a test of one file or text, two texts, two numbers or two files as [ … ] (commands-remote-r6-2)", () => {
    expect(plainTests("[[ -f package.json ]] && echo yes")).toBe("[ -f package.json ] && echo yes");
    expect(plainTests("[[ -d node_modules ]] || npm ci")).toBe("[ -d node_modules ] || npm ci");
    expect(plainTests("[[ -n \"$CI\" ]] && echo ci")).toBe("[ -n \"$CI\" ] && echo ci");
    expect(plainTests("[[ \"$a\" == \"$b\" ]]; [[ 1 -lt 2 ]]")).toBe("[ \"$a\" = \"$b\" ]; [ 1 -lt 2 ]");
    expect(plainTests("ls && [[ a != b ]] && [[ x -nt y ]]")).toBe("ls && [ a != b ] && [ x -nt y ]");
  });

  it("leaves a test [ … ] could read differently, and any line with an if or a loop, as written (commands-remote-r6-2)", () => {
    for (const line of [
      "[[ -f $x ]] && ls", "[[ $x == a ]]", "[[ a == b* ]]", "[[ x = * ]]", "[[ -f a && -f b ]]", "[[ -f a || -f b ]]", "[[ ! -f a ]]", "[[ a -eq b ]]", "[[ x -eq 0 ]]", "[[ 08 -eq 8 ]]",
      "[[ a =~ b ]]", "[[ a < b ]]", "[[ -v x ]]", "[[ -o errexit ]]", "[[ -t 1 ]]", "[[ -f 'a b' ]]", "[[ -f ~/x ]]", "[[ -f x -a -d y ]]", "[[ ( -f x ) ]]", "[[ -n $(ls) ]]",
      "[[ -n \"$(ls)\" ]]", "[[ -n \"`ls`\" ]]", "[[ -f x ]] > out", "[[ -f x]] && ls", "X=1 [[ -f x ]]", "if [[ -f x ]]; then ls; fi", "while [[ -f x ]]; do ls; done",
      "for f in a b; do [[ -f x ]] && echo $f; done", "[[ -f x ]] && { ls; }", "[[ -f x ]] && (ls)", "! [[ -f x ]]", "[[ -f x ]]; [[ $y ]]", "[[ -n \"a\"\"b\" ]]", "[[ -f -x ]]",
      // An operand that holds the test's own brackets: the comparison with main can't write it out to prove it.
      "[[ -e \"[[\" ]] || cat x", "[[ \"[[\" = \"]]\" ]]", "[[ x == \"[[\" ]] || cat x", "[[ -n \"a]]b\" ]]",
    ]) expect(plainTests(line), line).toBeNull();
  });
});
