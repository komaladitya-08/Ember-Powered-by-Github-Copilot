/**
 * A backtick before a line break inside a PowerShell word (#64), as pwsh 7.6 reads it: backtick + LF keeps a literal
 * LF in the word, and backtick + CR keeps a literal CR, after which the LF ends the statement. Between words a
 * backtick and a line break (LF or CRLF) is a line continuation.
 */

import { describe, expect, it } from "vitest";
import { lexPowerShell, type PsArg } from "../../app/main/commands/lex-powershell";
import { classifyCommand } from "../../app/main/commands/classify";
import { contextOf } from "../fixtures/commands/corpus";

const text = (a: PsArg): string => a.segs.map(s => (s.t === "lit" ? s.s : `<${s.t}>`)).join("");
/** Each statement's first command as its words. */
function commands(src: string): string[][] {
  return lexPowerShell(src).statements.map(st => {
    const el = st.elements[0];
    return el && el.kind === "command" ? [text(el.name), ...el.args.map(text)] : [];
  });
}

describe("PowerShell: a backtick and a line break inside a word (#64)", () => {
  it("keeps a literal LF in the word: git`<LF>status is one word, not git with the argument status", () => {
    expect(commands("git`\nstatus --short")).toEqual([["git\nstatus", "--short"]]);
    expect(commands("f ab`\ncd")).toEqual([["f", "ab\ncd"]]);
  });

  it("keeps a literal CR, and the LF after it ends the statement: the next line is a command of its own", () => {
    expect(commands("f ab`\r\ng cd")).toEqual([["f", "ab\r"], ["g", "cd"]]);
    expect(commands("git`\r\nstatus --short")).toEqual([["git\r"], ["status", "--short"]]);
  });

  it("reads a backtick and a line break between words as a line continuation, LF or CRLF", () => {
    expect(commands("Write-Host `\n hi")).toEqual([["Write-Host", "hi"]]);
    expect(commands("Write-Host `\r\n hi")).toEqual([["Write-Host", "hi"]]);
  });

  it("never lets the classifier read git`<LF>status as git status, or miss the command after a CRLF", () => {
    const ctx = contextOf("win32");
    const rules = (t: string): string[] => classifyCommand(t, "powershell", ctx).findings.map(f => f.rule);
    expect(rules("git status --short")).toEqual([]);
    // "git\nstatus" is no program Ember knows, so it asks.
    expect(rules("git`\nstatus --short")).toContain("unclear.program");
    // The second line's Remove-Item is a command of its own, so it is classified as one.
    expect(rules("echo ab`\r\nRemove-Item -Recurse C:\\Users\\ana\\Documents")).toContain("ps.Remove-Item");
  });
});
