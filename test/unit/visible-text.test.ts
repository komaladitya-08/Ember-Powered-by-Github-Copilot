/**
 * The command card's visible text (design §3.9.1, critique security-10): controls, direction overrides, invisible
 * characters, tabs and odd spaces become visible tokens, and in every token the letters from a script other than its
 * main one are marked "mixed".
 */

import { describe, expect, it } from "vitest";
import { hasHidden, visibleText, type VisibleSegment } from "../../app/shared/visible-text";

const seg = (text: string, kind: VisibleSegment["kind"]): VisibleSegment => ({ text, kind });

describe("visibleText", () => {
  it("leaves an ordinary command alone, newlines included", () => {
    expect(visibleText("rm -rf build")).toEqual([seg("rm -rf build", "plain")]);
    expect(visibleText("cat <<EOF\nx\nEOF")).toEqual([seg("cat <<EOF\nx\nEOF", "plain")]);
    expect(visibleText("")).toEqual([]);
  });

  it.each([
    ["ls\tx", [seg("ls", "plain"), seg("\u2192", "tab"), seg("x", "plain")]],
    ["a\u00a0b", [seg("a", "plain"), seg("\u27e8NBSP\u27e9", "nbsp"), seg("b", "plain")]],
    ["a\u2003b", [seg("a", "plain"), seg("\u27e8U+2003\u27e9", "nbsp"), seg("b", "plain")]],
    ["echo \u202eabc", [seg("echo ", "plain"), seg("\u27e8RLO\u27e9", "bidi"), seg("abc", "plain")]],
    ["\u2066x\u2069", [seg("\u27e8LRI\u27e9", "bidi"), seg("x", "plain"), seg("\u27e8PDI\u27e9", "bidi")]],
    ["x\u200by", [seg("x", "plain"), seg("\u27e8ZWSP\u27e9", "invisible"), seg("y", "plain")]],
    ["x\u00ady", [seg("x", "plain"), seg("\u27e8SHY\u27e9", "invisible"), seg("y", "plain")]],
    ["\ufeffls", [seg("\u27e8BOM\u27e9", "invisible"), seg("ls", "plain")]],
    ["e\u001b[31m", [seg("e", "plain"), seg("\u27e8U+001B\u27e9", "control"), seg("[31m", "plain")]],
    ["a\rb", [seg("a", "plain"), seg("\u27e8U+000D\u27e9", "control"), seg("b", "plain")]],
    ["\ud800x", [seg("\u27e8U+D800\u27e9", "invisible"), seg("x", "plain")]],
    // A line separator reads as a line break but is a word character to a shell.
    ["rm x\u2028y", [seg("rm x", "plain"), seg("\u27e8U+2028\u27e9", "control"), seg("y", "plain")]],
    // Variation selectors change the letter before them without showing; noncharacters can't be drawn.
    ["a\ufe0fb\u{e0100}", [seg("a", "plain"), seg("\u27e8U+FE0F\u27e9", "invisible"), seg("b", "plain"), seg("\u27e8U+E0100\u27e9", "invisible")]],
    ["x\ufdd0\u{1fffe}", [seg("x", "plain"), seg("\u27e8U+FDD0\u27e9", "invisible"), seg("\u27e8U+1FFFE\u27e9", "invisible")]],
  ])("shows %j", (s, want) => {
    expect(visibleText(s)).toEqual(want);
  });

  it("marks letters from another script than their token's", () => {
    expect(visibleText("bu\u0456ld")).toEqual([seg("bu", "plain"), seg("\u0456", "mixed"), seg("ld", "plain")]);
    expect(visibleText("\u0440m -rf x")).toEqual([seg("\u0440", "mixed"), seg("m -rf x", "plain")]);
    expect(visibleText("rm\u0430x")).toEqual([seg("rm", "plain"), seg("\u0430", "mixed"), seg("x", "plain")]);
    expect(visibleText("\u03bfpen")).toEqual([seg("\u03bf", "mixed"), seg("pen", "plain")]);
    // On a tie with Latin, the other script is the one marked.
    expect(visibleText("\u0441d")).toEqual([seg("\u0441", "mixed"), seg("d", "plain")]);
  });

  it("doesn't mark a token written in one script, or Latin with its accents", () => {
    expect(visibleText("\u043f\u0440\u0438\u0432\u0435\u0442 world")).toEqual([seg("\u043f\u0440\u0438\u0432\u0435\u0442 world", "plain")]);
    expect(visibleText("na\u00efve r\u00e9sum\u00e9 caf\u00e9")).toEqual([seg("na\u00efve r\u00e9sum\u00e9 caf\u00e9", "plain")]);
  });

  it("marks Latin beside Chinese, Japanese or Korean letters too, the token's main script left plain (§3.9.1)", () => {
    // 日本語のファイル.txt: eight CJK letters, then three Latin ones.
    expect(visibleText("cat \u65e5\u672c\u8a9e\u306e\u30d5\u30a1\u30a4\u30eb.txt"))
      .toEqual([seg("cat \u65e5\u672c\u8a9e\u306e\u30d5\u30a1\u30a4\u30eb.", "plain"), seg("txt", "mixed")]);
    // A Latin word with one Han letter in it; a tie marks the script that isn't Latin.
    expect(visibleText("rm bu\u4e00ld")).toEqual([seg("rm bu", "plain"), seg("\u4e00", "mixed"), seg("ld", "plain")]);
    expect(visibleText("\ud55ca")).toEqual([seg("\ud55c", "mixed"), seg("a", "plain")]);
  });

  it("doesn't mark a token wholly in one script other than Latin, with its digits and punctuation", () => {
    expect(visibleText("cat \u65e5\u672c\u8a9e\u306e\u30d5\u30a1\u30a4\u30eb_2.\u6587\u66f8")).toEqual([seg("cat \u65e5\u672c\u8a9e\u306e\u30d5\u30a1\u30a4\u30eb_2.\u6587\u66f8", "plain")]);
    expect(visibleText("mkdir \ud504\ub85c\uc81d\ud2b8-1")).toEqual([seg("mkdir \ud504\ub85c\uc81d\ud2b8-1", "plain")]);
    expect(visibleText("cat \u05e7\u05d5\u05d1\u05e5-3.\u05d8\u05e7\u05e1\u05d8")).toEqual([seg("cat \u05e7\u05d5\u05d1\u05e5-3.\u05d8\u05e7\u05e1\u05d8", "plain")]);
    expect(visibleText("ls \u0444\u0430\u0439\u043b_10.\u0442\u0435\u043a\u0441\u0442")).toEqual([seg("ls \u0444\u0430\u0439\u043b_10.\u0442\u0435\u043a\u0441\u0442", "plain")]);
  });

  it("judges each token on its own", () => {
    expect(visibleText("ls \u043f\u0430\u043f\u043a\u0430 build")).toEqual([seg("ls \u043f\u0430\u043f\u043a\u0430 build", "plain")]);
  });
});

describe("hasHidden", () => {
  it("is true for anything visibleText marks, tabs aside", () => {
    expect(hasHidden("rm -rf build")).toBe(false);
    expect(hasHidden("ls\tx")).toBe(false);
    expect(hasHidden("bu\u0456ld")).toBe(true);
    expect(hasHidden("x\u200by")).toBe(true);
    expect(hasHidden("a\u00a0b")).toBe(true);
    expect(hasHidden("echo \u202e")).toBe(true);
  });
});
