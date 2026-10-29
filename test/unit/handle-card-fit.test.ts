/**
 * The corner card (no compositor) with a question's whole text (review #116, the verifier's second pass): it asks for
 * the height all it holds needs, not the squeezed one it has; the sentence keeps its first lines and the block gives way
 * first; and a block at its end counts as seen only while the sentence shows beside it and nothing runs into the buttons.
 * test/integration/handle-card-whole-live.test.ts checks the real card at each text size.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cardClear, cardNeed, linesKept, type CardMeasure } from "../../app/renderer/handle/fit";

/** The card at the default text size with a whole text's question and its task row, as the verifier measured it. */
const card = (o: Partial<CardMeasure["text"]> = {}): CardMeasure => ({
  top: { padTop: 12, padBottom: 8, min: 116, face: 96 },
  text: {
    padTop: 4, gap: 2,
    rows: [
      { natural: 16, marginTop: 0, marginBottom: 0 }, // Ember
      { natural: 20, marginTop: 0, marginBottom: 0 }, // May I?
      { natural: 140, marginTop: 2, marginBottom: 0 }, // the sentence, all seven lines
      { natural: 152, marginTop: 6, marginBottom: 0 }, // the block, its seven lines and padding
      { natural: 16, marginTop: 4, marginBottom: 0 }, // Scroll down to read it all first.
      { natural: 16, marginTop: 4, marginBottom: 0 }, // the keys
    ],
    ...o,
  },
  below: [{ natural: 28, marginTop: 0, marginBottom: 12 }, { natural: 36, marginTop: 0, marginBottom: 12 }],
});

describe("the corner card's height", () => {
  it("is what all it holds needs: the sentence, the block, its hint and keys, the buttons and the task row", () => {
    // 12 + (4 + 16 + 20 + 142 + 158 + 20 + 20 + 5 gaps of 2) + 8, then 28 + 12 and 36 + 12. It asked for 344 before.
    expect(cardNeed(card())).toBe(498);
  });

  it("is never shorter than the face's row, and takes numbers it can't read as nothing", () => {
    expect(cardNeed(card({ rows: [] }))).toBe(116 + 40 + 48);
    expect(cardNeed({ ...card({ rows: [{ natural: Number.NaN, marginTop: 2, marginBottom: 0 }] }), below: [] })).toBe(116);
  });
});

describe("the lines a row keeps however little room is left", () => {
  it("keeps its first three lines, or all of them when it has fewer", () => {
    expect(linesKept(140, 20, 3)).toBe(3);
    expect(linesKept(20, 20, 3)).toBe(1);
    expect(linesKept(39.6, 20, 3)).toBe(2);
    expect(linesKept(440, 20, 7)).toBe(7);
    expect(linesKept(0, 20, 3)).toBe(0);
    expect(linesKept(140, 20, 0)).toBe(0);
    expect(linesKept(140, Number.NaN, 3)).toBe(3);
  });
});

describe("room for a whole text to count as seen", () => {
  const room = (thought: number, ends: number[] = [118, 198, 220, 240]) => ({ sentence: { clientHeight: thought, scrollHeight: 140, lineHeight: 20 }, wordsEnd: 250, rowsEnd: ends });

  it("needs the question's sentence beside it: two lines or more of it in view (all, when it is shorter)", () => {
    // The verifier's card: the sentence squeezed to nothing by the block under it.
    expect(cardClear(room(0))).toBe(false);
    expect(cardClear(room(20))).toBe(false);
    expect(cardClear(room(40))).toBe(true);
    expect(cardClear(room(140))).toBe(true);
    expect(cardClear({ ...room(20), sentence: { clientHeight: 20, scrollHeight: 20, lineHeight: 20 } })).toBe(true);
  });

  it("needs every row of words to end above the buttons: none runs into them or is cut off", () => {
    expect(cardClear(room(60, [118, 198, 220, 262]))).toBe(false);
    expect(cardClear(room(60, [118, 198, 220, 250.5]))).toBe(true);
  });

  it("counts numbers it can't read as no room", () => {
    expect(cardClear(room(Number.NaN))).toBe(false);
    expect(cardClear(room(60, [Number.NaN]))).toBe(false);
    expect(cardClear({ ...room(60), wordsEnd: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe("the card's page", () => {
  const css = readFileSync("app/renderer/handle/styles.css", "utf8");
  const page = readFileSync("app/renderer/handle/main.ts", "utf8");
  const rule = (sel: string) => new RegExp(`(?:^|\\n)${sel.replace(/[.[\]()*"=]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";

  it("lets the block give way first, down to its first lines, and the sentence keep its own; cuts off what still doesn't fit", () => {
    expect(rule("body.fallback .whole")).toMatch(/flex: 0 1000 calc\(var\(--lines-shown, 7\) \* 1lh\); min-height: calc\(var\(--lines-kept, 0\) \* 1lh\); max-height: 7lh;/);
    expect(rule("body.fallback .thought")).toMatch(/flex: 0 1 auto; min-height: calc\(var\(--lines-kept, 0\) \* 1lh\);/);
    expect(rule("body.fallback .handle")).toMatch(/overflow: hidden;/);
  });

  it("asks for what it needs, keeps the lines, and takes the block's end as read only with room for the words", () => {
    expect(page).toContain("const h = cardNeed(cardMeasure());");
    expect(page).toContain("keepLines();");
    expect(page).toContain("const shown = fallback && document.visibilityState === \"visible\" && wordsClear();");
  });

  it("is checked on a real X server in CI's RHEL 8 job", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toMatch(/EMBER_ATSPI_TEST=1 \\\n.*npm run test:integration -- .*test\/integration\/handle-card-whole-live\.test\.ts/);
  });
});
