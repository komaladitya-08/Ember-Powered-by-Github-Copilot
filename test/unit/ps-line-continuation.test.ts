/**
 * PowerShell line continuation (a backtick before a line break) is removed by PowerShell and the surrounding
 * characters stay in one token, so the words Ember shows must not be split by it (review #64).
 */

import { describe, expect, it } from "vitest";
import { lexPowerShell } from "../../app/main/commands/lex-powershell";

function words(text: string): string[] {
  const st = lexPowerShell(text).statements;
  const el = st[0]?.elements[0];
  if (!el || el.kind !== "command") return [];
  const raw = (a: { segs: { t: string; s?: string }[] }): string => a.segs.map(s => (s.t === "lit" ? s.s : "")).join("");
  return [raw(el.name), ...el.args.map(raw)];
}

describe("PowerShell line continuation inside a word", () => {
  it("removes the escaped newline instead of splitting the word", () => {
    expect(words("git`\nstatus --short")).toEqual(["gitstatus", "--short"]);
  });

  it("does the same for CRLF line breaks", () => {
    expect(words("git`\r\nstatus --short")).toEqual(["gitstatus", "--short"]);
  });

  it("keeps a space after the continuation as the end of the word", () => {
    expect(words("Remove-Item`\n x")).toEqual(["Remove-Item", "x"]);
  });
});
