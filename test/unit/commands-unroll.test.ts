/**
 * Writing a short `for` loop out pass by pass, and a simple `[[ … ]]` test as `[ … ]` (app/main/commands/unroll.ts,
 * commands-remote-r6-2). The written-out text is what the classifier judges, so it must mean to the shell exactly what
 * the loop means: the last test runs both through bash and sh (echo and printf only) and compares what they print.
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

  it("means the same to bash and sh as the loop it was written from (commands-remote-r6-2)", () => {
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
    const env = { PATH: "/usr/bin:/bin", HOME: "/nonexistent" };
    for (const shell of [["bash", "--noprofile", "--norc"], ["sh"]]) {
      if (spawnSync(shell[0], ["-c", "exit 0"], { env }).status !== 0) continue;
      const script = pairs.map(([line, u]) => `(${line}\n)\necho ===\n(${u}\n)\necho ===`).join("\n");
      const r = spawnSync(shell[0], shell.slice(1), { input: script, encoding: "utf8", cwd: "/", env, maxBuffer: 64 * 1024 * 1024 });
      expect(r.stderr, shell[0]).toBe("");
      const out = r.stdout.split("===\n");
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
    ]) expect(plainTests(line), line).toBeNull();
  });
});
