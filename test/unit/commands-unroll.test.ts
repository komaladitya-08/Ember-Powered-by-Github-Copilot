/**
 * Writing a short `for` loop out pass by pass, and a simple `[[ … ]]` test as `[ … ]` (app/main/commands/unroll.ts,
 * commands-remote-r6-2). The written-out text is what the classifier judges, so it must mean to the shell exactly what
 * the loop means: one test runs both through bash, sh and (where it is installed) zsh, with echo and printf only, and
 * compares what they print.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { judgedText, MAX_PASSES, plainTests, unrollLoops } from "../../app/main/commands/unroll";

describe("a short for loop written out pass by pass (commands-remote-r6-2)", () => {
  it("writes each pass out with the list's word in place of the variable, the assignment in front (commands-remote-r6-2)", () => {
    expect(unrollLoops("for i in 1 2 3; do echo $i; done")).toBe("i=1; echo 1; i=2; echo 2; i=3; echo 3");
    expect(unrollLoops("for f in --hard; do git reset $f; done")).toBe("f=--hard; git reset --hard");
    expect(unrollLoops("for f in -delete; do find . $f; done")).toBe("f=-delete; find . -delete");
    expect(unrollLoops("for i in 1 2; do sed -i s/a/b/ ember/settings.json; cd ~/.config; done"))
      .toBe("i=1; sed -i s/a/b/ ember/settings.json; cd ~/.config; i=2; sed -i s/a/b/ ember/settings.json; cd ~/.config");
    expect(unrollLoops("cd src; for f in a.txt b.txt; do wc -l \"$f\"; done; echo ok")).toBe("cd src; f=a.txt; wc -l \"a.txt\"; f=b.txt; wc -l \"b.txt\"; echo ok");
    expect(unrollLoops("for f in a b\ndo\n  rm -f $f.log\n  echo \"did ${f}x\"\ndone\nls")).toBe("f=a\nrm -f a.log\n  echo \"did ax\"\nf=b\nrm -f b.log\n  echo \"did bx\"\nls");
    expect(unrollLoops("for u in a.sh b.sh; do curl -O https://example.com/$u; bash $u; done"))
      .toBe("u=a.sh; curl -O https://example.com/a.sh; bash a.sh; u=b.sh; curl -O https://example.com/b.sh; bash b.sh");
    expect(unrollLoops("for d in src test; do cd $d && npm test; cd ..; done")).toBe("d=src; cd src && npm test; cd ..; d=test; cd test && npm test; cd ..");
    expect(unrollLoops("for f in a b; do echo $f; done; for g in c d; do echo $g; done")).toBe("f=a; echo a; f=b; echo b; g=c; echo c; g=d; echo d");
    expect(unrollLoops("for v in 1 2; do ls --sort=$v dir/$v-x \"$v\"/y ${v}z; done")).toBe("v=1; ls --sort=1 dir/1-x \"1\"/y 1z; v=2; ls --sort=2 dir/2-x \"2\"/y 2z");
  });

  it("leaves every other loop as written, to ask as before (commands-remote-r6-2)", () => {
    for (const line of [
      // Not a for over written-out words.
      "while true; do rm x; done", "until false; do rm x; done", "select f in a b; do rm $f; done", "for f in *.log; do rm $f; done", "for f in $(ls); do rm $f; done",
      "for f in $FILES; do rm $f; done", "for f in \"a\" b; do rm $f; done", "for f in 'a b' c; do rm $f; done", "for f in {a,b}; do rm $f; done", "for f in ~ /; do ls $f; done",
      "for f; do rm $f; done", "for f in; do rm x; done", "for ((i=0;i<3;i++)); do echo $i; done", "for f in a=b; do env $f ls; done", "for f in do; do echo $f; done",
      `for f in ${Array.from({ length: MAX_PASSES + 1 }, (_, n) => n).join(" ")}; do echo $f; done`, "for f in a b; do echo $f; done; for g in 1 2 3 4 5 6 7 8 9 10 11; do echo $g; done",
      // A name the shell itself may read, or one that isn't a plain loop name.
      "for PATH in /tmp/x; do ls; done", "for HOME in /etc; do ls ~; done", "for path in /tmp/x; do ls; done", "for IFS in . -; do ls; done", "for CDPATH in /etc; do cd ssh; done",
      // The loop isn't a command of its own, or something else stands in the line.
      "for f in a b; do echo $f; done | cat", "for f in a b; do echo $f; done > out", "for f in a b; do echo $f; done &", "true && for f in a b; do echo $f; done",
      "true &&\nfor f in a b; do echo $f; done", "time for f in a b; do echo $f; done", "if true; then for f in a b; do echo $f; done; fi", "(for f in a b; do echo $f; done)",
      "{ for f in a b; do echo $f; done; }", "for f in a b; do echo $f; done; while true; do ls; done", "for f in a b; do echo $f # x; done", "for f in a b; do echo \\$f; done",
      // The body: a nested loop, an if, a test, a break, a group, a substitution, a here-document, a background job.
      "for f in a b; do for g in c d; do echo $f$g; done; done", "for f in a b; do if true; then echo $f; fi; done", "for f in a b; do [[ -f $f ]] && echo $f; done",
      "for f in a b; do break; done", "for f in a b; do echo $f || continue; done", "for f in a b; do { echo $f; }; done", "for f in a b; do (echo $f); done",
      "for f in a b; do echo $(cat $f); done", "for f in a b; do echo `cat $f`; done", "for f in a b; do cat <<EOF\n$f\nEOF\ndone", "for f in a b; do cat <<< $f; done",
      "for f in a b; do sleep 1 & done", "for f in a b; do echo $f; done; done", "for f in a b; do echo $f done", "for f in a b; do; echo $f; done", "for f in a b>; do echo $f; done", "for f in a b; do echo $f >; done", "for f in a b; do echo $f > && ls; done",
      // The variable set, read, exported or used anywhere but as its own `$f`.
      "for f in a b; do f=x; echo $f; done", "for f in a b; do read f; echo $f; done", "for f in a b; do echo $f; done; echo $f", "for f in a b; do echo '$f'; done",
      "for f in a b; do sh -c 'echo $f'; done", "for f in a b; do printf -v f x; done", "for f in a b; do echo ${f:-x}; done", "for f in a b; do echo ${!f}; done",
      "for f in a b; do echo ${f%.*}; done", "f=1; for f in a b; do echo $f; done", "for f in a b; do echo $f; done; for f in c; do echo $f; done",
      // A word that can change variables or how words are read behind Ember's back.
      "for f in a b; do eval echo $f; done", "for f in a b; do . ./x.sh; echo $f; done", "for f in a b; do source x.sh; echo $f; done", "IFS=.; for f in a.b; do echo $f; done",
      "for f in a b; do export X=$f; done", "for f in a b; do set -- x; echo $f; done", "for f in a b; do unset g; echo $f; done", "for f in a b; do $CMD $f; done",
      "for f in a b; do builtin echo $f; done", "for f in a b; do command echo $f; done", "for f in a b; do exec echo $f; done", "for f in a b; do trap 'ls' EXIT; done",
      // A `$f` where the word itself would mean something else to the shell.
      "for f in a b; do $f; done", "for f in a b; do $f x; done", "for f in a b; do X=$f ls; done", "for f in a b; do x=$f; done", "for n in 1 2; do echo hi $n>out; done",
      "for n in 1 2; do echo hi $n>&2; done", "for n in 1 2; do cat $n<in; done", "for f in a b; do echo ~$f; done", "for f in a b; do echo ~x$f; done", "for f in a b; do ls x[$f]; done",
      "for f in a b; do echo $f[1]; done", "for f in a b; do echo $f:h; done", "for f in a b; do echo \"$f[1]\"; done", "for f in a b; do echo \"$f:h\"; done",
      "for f in a b; do echo $f=1; done", "for f in a b; do echo =$f; done", "for f in a b; do echo $f$f$g; done", "for f in a b; do echo *$f; done", "for f in a b; do echo $f*; done", "for f in a b; do echo *\"$f\"*; done", "for f in a b; do echo $g$f; done", "for f in a b; do echo \"$g$f\"; done", "for f in a b; do echo \"$$f\"; done",
    ]) expect(unrollLoops(line), line).toBeNull();
    // Another shell's text is never touched.
    expect(judgedText("ls; pwd")).toBe("ls; pwd");
  });

  it("leaves a loop with a letter outside ASCII as written: zsh reads it as part of the variable's name (commands-remote-x7-1)", () => {
    // zsh 5.9 with a UTF-8 locale prints `[--hard]` for `for f in x; do echo "[--hard$fé]"; done`; bash and sh `[--hardxé]`.
    for (const tail of ["é", "ß", "я", "中", "١", "ª", "Ａ", "ｆ", "éx"]) {
      for (const body of ["git reset \"--hard$f§\"", "find . \"-delete$f§\"", "cat \"/etc/shadow$f§\"", "history \"-c$f§\"", "git stash \"drop$f§\"", "echo \"$f§\"", "echo $f§", "echo \"${f}§\""]) {
        const line = `for f in x; do ${body.replace("§", tail)}; done`;
        expect(unrollLoops(line), line).toBeNull();
        expect(judgedText(line), line).toBe(line);
      }
    }
    for (const line of ["for f in a b; do echo $f; done; echo café", "echo é; for f in a b; do echo $f; done", "for f in é b; do echo $f; done", "for f in a b; do echo $f \u00a0x; done"]) expect(unrollLoops(line), line).toBeNull();
  });

  it("leaves a loop as written when a command in it can set the variable from a word that looks like an option (commands-remote-x7-2)", () => {
    // zsh 5.9: `for f in a; do print -vf -- --hard; echo "<$f>"; done` prints `<--hard>`; `zparseopts -af x` empties f.
    for (const line of [
      "for f in a; do print -vf -- --hard; git reset $f; done", "for f in a; do print -rvf -- -delete; find . $f; done", "for f in a; do print -nvf -- --hard; git reset \"$f\"; done",
      "for f in a; do print -vf -- -c; history $f; done", "for file in x; do print -vfile -- --hard; git reset $file; done", "for f in a b\ndo\nprint -vf -- --hard; git reset $f\ndone",
      "cd sub; for f in a; do print -vf /; ls $f; done; echo ok", "for f in a; do print \"-vf\" -- --hard; git reset $f; done", "for f in a; do print -v'f' -- --hard; git reset $f; done",
      "for f in a; do print -rv fi''le -- --hard; git reset $f; done", "for f in a; do - print -vf -- --hard; git reset $f; done", "for f in a; do X=1 print -vf -- --hard; git reset $f; done",
      "for f in a; do print $OPT --hard; git reset $f; done", "for f in a; do print \"$OPT\" --hard; git reset $f; done", "for f in -vf; do print $f --hard; git reset $f; done",
      "for f in a; do printf -vf %s --hard; git reset $f; done", "for f in a; do printf $OPT f --hard; git reset $f; done", "for f in a; do printf \"-vf\" %s --hard; git reset $f; done",
      "for f in x; do zparseopts -af q; cat /etc/shadow$f; done", "for f in x; do zparseopts -D -E -af q; cat $f; done", "for f in x; do compgen -Vf -W --hard; git reset $f; done",
      "for f in x; do zformat -f f %a a:--hard; git reset $f; done", "for f in x; do zstyle -s :x y f; git reset $f; done", "for f in x; do vared -c f; git reset $f; done",
      "for f in x; do getln f; git reset $f; done", "for f in x; do zregexparse f g x; git reset $f; done", "for f in x; do functions -c p q; q; git reset $f; done",
      "disable -r done\nfor f in a b; do echo $f; done", "for f in x; do - zparseopts -af q; cat $f; done",
    ]) expect(unrollLoops(line), line).toBeNull();
    // An option of a program that isn't the shell's own can't set the variable, and print's and printf's other options are fine.
    expect(unrollLoops("for f in a b; do rm -f $f; done")).toBe("f=a; rm -f a; f=b; rm -f b");
    expect(unrollLoops("for d in src test; do test -d $d && ls -d $d; done")).toBe("d=src; test -d src && ls -d src; d=test; test -d test && ls -d test");
    expect(unrollLoops("for f in a b; do printf '%s|' $f; print -rn -- $f; print -l -- x \"$f\"; done")).toBe("f=a; printf '%s|' a; print -rn -- a; print -l -- x \"a\"; f=b; printf '%s|' b; print -rn -- b; print -l -- x \"b\"");
  });

  it("leaves a loop as written when an assignment with a subscript earlier on the line may have made a command (commands-remote-x7-3)", () => {
    // bash --posix: `BASH_ALIASES[p]='printf -vf %s --hard'`, then on the next line `for f in a; do p; echo "[$f]"; done`
    // prints `[--hard]`; zsh does with `functions[p]='print -vf -- --hard'`.
    for (const line of [
      "BASH_ALIASES[p]='printf -vf %s --hard'\nfor f in a; do p; git reset $f; done", "POSIXLY_CORRECT=1\nBASH_ALIASES[p]='printf -vf %s --hard'\nfor f in a; do p; git reset $f; done",
      "BASH_ALIASES[p]='printf -vf %s -delete'\nfor f in a; do p; find . $f; done", "functions[p]='print -vf -- --hard'; for f in a; do p; git reset $f; done",
      "functions[p]='print -vf -- -delete'\nfor f in a; do p; find . $f; done", "aliases[p]='print -vf -- --hard'\nfor f in a; do p; git reset $f; done",
      "functions[p]+='print -vf -- --hard'; for f in a; do p; git reset $f; done", "functions['p']='f=--hard'; for f in a; do p; git reset $f; done",
      "for f in a; do functions[p]='f=--hard'; p; git reset $f; done", "options[shwordsplit]=on; for f in a b; do echo $f; done", "for f in a b; do echo $f; done; BASH_CMDS[ls]=/tmp/x",
    ]) expect(unrollLoops(line), line).toBeNull();
  });

  it("leaves a loop as written when its body uses a variable the line itself sets, or $_ (commands-remote-x7-5)", () => {
    // The second pass of `for i in 1 2; do git reset $x; x=--hard; done` runs `git reset --hard`; main asked before every
    // loop. bash prints `[--hard]` for `echo --hard; for i in 1; do echo "[$_]"; done` and `[]` for the written-out text.
    for (const line of [
      "for i in 1 2; do git reset $x; x=--hard; done", "for i in 1 2; do x=--hard; git reset $x; done", "for i in 1 2; do find . $x; x=-delete; done",
      "x=--hard; for i in 1 2; do git reset $x; done", "for i in 1 2; do git reset \"$x\"; x=--hard; done", "for i in 1 2; do git reset ${x}; x+=--hard; done",
      "for i in 1 2; do git reset $x; x=--hard make; done", "for i in 1; do git reset $x; done; x=--hard", "for i in 1 2\ndo\n  history $x\n  x=-c\ndone",
      "echo --hard; for i in 1; do git reset $_; done", "echo -delete; for i in 1; do find . \"$_\"; done", "for i in 1 2; do echo $i; done; echo ${_}",
    ]) expect(unrollLoops(line), line).toBeNull();
    // A variable the line doesn't set, and one set but not used in a loop, are as they were.
    expect(unrollLoops("for i in 1 2; do ls $HOME/$i; done")).toBe("i=1; ls $HOME/1; i=2; ls $HOME/2");
    expect(unrollLoops("x=1; for i in 1 2; do echo $i; done; echo $x")).toBe("x=1; i=1; echo 1; i=2; echo 2; echo $x");
  });

  it("means the same to bash, sh and zsh as the loop it was written from (commands-remote-r6-2, x7-1)", () => {
    // Every way a `$f` may stand in a word, crossed with lists; only echo and printf, which are the shell's own.
    const before = ["", "a", "/", ".", ":", ",", "@", "%", "+", "-", "--o=", "x=", "=", "~", "~/", "~a", "~a/", "[", "*", "?", "\"q\"", "'q'", "1", "$g", "${g}"];
    const refs = ["$f", "${f}", "\"$f\"", "\"${f}\"", "\"x $f y\"", "\"${f}z\""];
    const after = ["", "a", "1", "_", ".", "/", ",", "-", "*", "?", ":", "[1]", "=", "=1", "@", "%", "+", "~", "\"q\"", "'q'", "$f", ".txt", "$g"];
    const lines: string[] = [];
    for (const b of before) for (const r of refs) for (const a of after) {
      lines.push(`for f in a -n x.y 1 /; do printf '%s|' p ${b}${r}${a} q; echo; done`);
      if (`${b}${a}`.includes("g")) lines.push(`g=k; for f in a 1; do echo ${b}${r}${a}; done`);
    }
    const pairs = lines.map(line => [line, unrollLoops(line)] as const).filter((p): p is readonly [string, string] => p[1] !== null);
    // Plenty of them are written out, none with a redirection, and none of the places the header rules out.
    expect(pairs.length).toBeGreaterThan(400);
    expect(pairs.some(([, u]) => /[<>]/.test(u))).toBe(false);
    // Where there is no such shell on the path (Windows), there is nothing to compare.
    const env = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" };
    // zsh too where it is installed, with the UTF-8 locale Ember's own start gives it (commands-remote-x7-1).
    for (const shell of [["bash", "--noprofile", "--norc"], ["sh"], ["zsh", "-f"]]) {
      if (spawnSync(shell[0], ["-c", "exit 0"], { env }).status !== 0) continue;
      const script = pairs.map(([line, u]) => `(${line}\n)\necho @@@\n(${u}\n)\necho @@@`).join("\n");
      const r = spawnSync(shell[0], shell.slice(1), { input: script, encoding: "utf8", cwd: "/", env, maxBuffer: 64 * 1024 * 1024 });
      // zsh stops a command at `~a` (no such user), in the loop and in its written-out text alike.
      if (shell[0] !== "zsh") expect(r.stderr, shell[0]).toBe("");
      const out = r.stdout.split("@@@\n");
      expect(out.length, shell[0]).toBe(pairs.length * 2 + 1);
      const wrong = pairs.filter((_, k) => out[2 * k] !== out[2 * k + 1]).map(([line]) => line);
      expect(wrong, shell[0]).toEqual([]);
    }
  }, 60_000);
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
