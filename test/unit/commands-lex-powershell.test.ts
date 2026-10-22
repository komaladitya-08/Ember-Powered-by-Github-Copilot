/**
 * The PowerShell tokenizer (design §3.4.2): statements, pipelines, commands with parameters and arguments, strings
 * and the variables Ember resolves, subexpressions, arrays, redirections (on commands and on values), the restricted
 * script blocks of the filtering cmdlets, and everything else (flow control, types, hashtables, splatting,
 * dot-sourcing, `&` with anything but a literal, `--%`, PowerShell 7's `&&`) as unclear.
 */

import { describe, expect, it } from "vitest";
import { lexPowerShell, restrictedExpression, type PsArg, type PsSeg, type PsStatement } from "../../app/main/commands/lex-powershell";

const seg = (s: PsSeg): string => (s.t === "lit" ? (s.q ? `'${s.s}'` : s.s) : s.t === "var" ? `$${s.name}` : `<${s.why}>`);
function arg(a: PsArg): string {
  const subs = a.subs.length ? `{subs:${a.subs.length}}` : "";
  if (a.kind === "param") return `-${a.param}${a.attached ? `:${a.segs.map(seg).join("")}` : ""}${subs}`;
  if (a.kind === "block") return `{${a.segs.map(seg).join("")}}`;
  if (a.items) return `${a.items.map(i => i.map(seg).join("")).join(",")}${subs}`;
  return a.segs.map(seg).join("") + subs;
}
/** Statements as one line: commands in [ ], values as expr( ), assignments as $x= . */
function show(sts: PsStatement[]): string {
  return sts.map(st => (st.assign ? `$${st.assign}= ` : "") + st.elements.map(e => {
    const redirs = e.redirs.map(r => ` ${r.op}${r.target ? arg(r.target) : ""}${r.merge ? "&1" : ""}`).join("");
    if (e.kind === "expr") return `expr(${e.segs.map(seg).join("")}${e.subs.length ? ` subs:${e.subs.length}` : ""}${redirs})`;
    return `${e.call ? "& " : ""}[${[arg(e.name), ...e.args.map(arg)].join(" ")}${redirs}]${e.background ? " &" : ""}`;
  }).join(" | ")).join(" ; ");
}
const lex = (text: string): string => show(lexPowerShell(text).statements);

describe("lexPowerShell: commands, values and statements", () => {
  it.each([
    ["Get-ChildItem -Recurse -Filter *.ts", "[Get-ChildItem -Recurse -Filter *.ts]"],
    ["gci src | Select-Object Name", "[gci src] | [Select-Object Name]"],
    ["Remove-Item -Path:x -Recurse", "[Remove-Item -Path:x -Recurse]"],
    ["rm a,b,c", "[rm a,b,c]"],
    ["'it''s' | Out-File x", "expr('it's') | [Out-File x]"],
    ['"$HOME\\x"', "expr($HOME'\\x')"],
    ["Get-Content $env:USERPROFILE\\.ssh\\id_rsa", "[Get-Content $env:USERPROFILE\\.ssh\\id_rsa]"],
    ["echo $(Get-Date)", "[echo <subexpression>{subs:1}]"],
    ["iex (iwr https://x)", "[iex <subexpression>{subs:1}]"],
    ["& 'C:\\Program Files\\x.exe' -a", "& ['C:\\Program Files\\x.exe' -a]"],
    ["$x = Get-Date", "$x= [Get-Date]"],
    ["$env:X = 'y'", "$env:X= expr('y')"],
    ["a; b\nc", "[a] ; [b] ; [c]"],
    ["Write-Host `\n hi", "[Write-Host hi]"],
    ["Remove-Item`\n x", "[Remove-Item x]"],
    ["Remove-Item`\r\n x", "[Remove-Item x]"],
    ["# comment\nls", "[ls]"],
    ["<# block #> ls", "[ls]"],
    ["Start-Process x &", "[Start-Process x] &"],
    ["cmd /c dir & del y", "[cmd /c dir] & ; [del y]"],
    ["ls -- -x", "[ls - -x]"],
    ["1 + 2", "expr(1+2)"],
    ["(ls).Count", "expr(<subexpression>.Count subs:1)"],
    ["git commit -m 'msg' --amend", "[git commit -m 'msg' --amend]"],
  ])("%j", (text, want) => {
    expect(lex(text)).toBe(want);
  });

  it("reads typographic quotes and dashes as PowerShell does", () => {
    expect(lex("Get-Item \u201cx\u201d")).toBe("[Get-Item 'x']");
    expect(lex("Remove-Item \u2013Recurse x")).toBe("[Remove-Item -Recurse x]");
  });

  it("keeps restricted script blocks as text for the classifier", () => {
    expect(lex("Get-ChildItem | Where-Object { $_.Length -gt 1 }")).toBe("[Get-ChildItem] | [Where-Object {' $_.Length -gt 1 '}]");
    expect(lex("Get-ChildItem | Sort-Object { $_.Name }")).toBe("[Get-ChildItem] | [Sort-Object {' $_.Name '}]");
  });
});

describe("lexPowerShell: redirections", () => {
  it("reads them on commands", () => {
    expect(lex("ls > out.txt 2>&1")).toBe("[ls >out.txt 2>&1]");
    expect(lex("npm test *> all.log")).toBe("[npm test *>all.log]");
    expect(lex("npm test 2>> err.log")).toBe("[npm test 2>>err.log]");
  });

  it("reads them on values", () => {
    expect(lex("'x' > notes.txt")).toBe("expr('x' >notes.txt)");
    expect(lex("'x' >> $PROFILE")).toBe("expr('x' >>$PROFILE)");
    expect(lexPowerShell("'x' > a.txt 'y'").fatal).toBe(true);
  });
});

describe("lexPowerShell: what it can't follow", () => {
  it.each([
    [". .\\x.ps1", "dot-sourcing"],
    ["if ($x) { y }", "the keyword if"],
    ["function f { }", "the keyword function"],
    ["@{a=1}", "a hashtable"],
    ["[IO.File]::Delete('x')", "a [Type]"],
    ["x && y", "&& or || (PowerShell 7 only)"],
    ['Get-Content "x', 'unterminated "'],
    ["ls --% x", "--% (stop-parsing)"],
    ["rm @args", "splatting"],
  ])("gives up on %j", (text, reason) => {
    const p = lexPowerShell(text);
    expect(p.fatal).toBe(true);
    expect(p.unclear.map(u => u.why)).toContain(reason);
  });

  it("notes a call of something that isn't a literal, and $ExecutionContext", () => {
    expect(lexPowerShell("& $cmd").unclear.map(u => u.why)).toContain("call-operator");
    expect(lexPowerShell("$ExecutionContext.x").unclear.map(u => u.why)).toContain("execution-context");
  });

  it("never throws", () => {
    for (const text of ["", "'", "\"", "@(", "$(", "{", "}", "[", "<#", "`", "&", "|", ";", "--%", "\u0000"]) expect(() => lexPowerShell(text)).not.toThrow();
  });
});

describe("restrictedExpression", () => {
  it.each([
    ["$_.Length -gt 10", true],
    ["$_.Name -like '*.ts' -and $_.Length -gt 1", true],
    ["!$_.PSIsContainer", true],
    ["($_.A, $_.B)", true],
    ["-not $_.y", true],
    ["$_.Size -gt 1MB", true],
    ["$_.Delete()", false],
    ["[int]$_", false],
    ["Remove-Item $_", false],
    ['$_.Name -eq "a$(b)"', false],
    ["$_.x[0]", false],
    ["$ExecutionContext.InvokeCommand", false],
  ])("%j → %s", (text, want) => {
    expect(restrictedExpression(text)).toBe(want);
  });
});
