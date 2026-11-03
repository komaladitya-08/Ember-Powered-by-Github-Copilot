/**
 * Better recall's tokenizer (app/main/memory/wordpiece.ts) cuts text into exactly the ids Hugging Face's tokenizers
 * (0.23.3, all-MiniLM-L6-v2's tokenizer.json) does. test/fixtures/wordpiece-reference.json holds its ids for a quarter
 * of the benchmark's texts and for hard cases (accents, CJK, control and invisible characters, punctuation, emoji, a
 * word too long for the vocabulary), with the part of the vocabulary those texts reach: every entry the longest-match
 * search could try, at its own id, so the search goes exactly as it would with the whole file.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WordPiece, normalise, preTokenize } from "../../app/main/memory/wordpiece";

const ref = JSON.parse(fs.readFileSync(path.resolve("test/fixtures/wordpiece-reference.json"), "utf8")) as { vocab: [number, string][]; cases: { text: string; ids: number[] }[] };
/** vocab.txt with only the reference's entries, each on its own line number (its id). */
function vocabText(): string {
  const lines: string[] = [];
  for (const [id, token] of ref.vocab) lines[id] = token;
  return Array.from(lines, t => t ?? "").join("\n");
}

describe("the memory model's tokenizer", () => {
  const wp = new WordPiece(vocabText());

  it("gives the reference tokenizer's ids for every text", () => {
    expect(ref.cases.length).toBeGreaterThanOrEqual(60);
    for (const c of ref.cases) expect(wp.encode(c.text, 10_000).ids, c.text).toEqual(c.ids);
  });

  it("lowercases, strips accents and drops invisible characters", () => {
    expect(normalise("Héllo​WÖRLD﻿")).toBe("helloworld");
    expect(normalise("tab\there\r\n")).toBe("tab here  ");
  });

  it("splits punctuation into words of its own", () => {
    expect(preTokenize("vs-code's settings.json")).toEqual(["vs", "-", "code", "'", "s", "settings", ".", "json"]);
  });

  it("wraps the text in [CLS] and [SEP], and cuts it at the model's limit", () => {
    const e = wp.encode("the user lives in leeds the user lives in leeds the user lives in leeds", 8);
    expect(e.ids).toHaveLength(8);
    expect(e.ids[0]).toBe(wp.cls);
    expect(e.ids[7]).toBe(wp.sep);
    expect(e.mask).toEqual(new Array(8).fill(1));
    expect(e.types).toEqual(new Array(8).fill(0));
  });

  it("refuses a vocabulary without its special tokens", () => {
    expect(() => new WordPiece("hello\nworld")).toThrow(/\[CLS\]/);
  });
});
