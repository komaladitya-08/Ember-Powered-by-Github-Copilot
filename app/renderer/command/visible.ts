/**
 * Every character of a command or an untrusted prompt made visible (§3.9.1, critique security-10): C0/C1 controls as
 * `⟨U+001B⟩` tokens, bidi controls as `⟨RLO⟩`, zero-width and other invisible characters as `⟨ZWSP⟩`, tabs as `→`, a
 * non-breaking space as `⟨NBSP⟩`, and in every whitespace-separated token the letters from a script other than the
 * token's main one marked "mixed" (the page underlines them, with a legend). Renderer-safe and pure.
 *
 * The contract puts `visibleText` in `app/shared/visible-text.ts` (package CL), which was not on this branch while
 * the command and prompt windows were built. This module has CL's exact signature so the pages import it from one
 * place: once CL's module lands, this file becomes `export { visibleText, type VisibleSegment } from
 * "../../shared/visible-text";` (the pages also accept CL's segments when their `text` is the raw character: see
 * `segmentLabel`).
 */

/** One run of a string as the card shows it. */
export interface VisibleSegment { text: string; kind: "plain" | "control" | "bidi" | "invisible" | "tab" | "nbsp" | "mixed" }

/** Bidi controls by name (U+202A-202E, U+2066-2069, U+200E/200F, U+061C). */
const BIDI: Readonly<Record<number, string>> = {
  0x202a: "LRE", 0x202b: "RLE", 0x202c: "PDF", 0x202d: "LRO", 0x202e: "RLO",
  0x2066: "LRI", 0x2067: "RLI", 0x2068: "FSI", 0x2069: "PDI",
  0x200e: "LRM", 0x200f: "RLM", 0x061c: "ALM",
};
/** Zero-width characters with names people search for; every other invisible one is shown by its code point. */
const NAMED_INVISIBLE: Readonly<Record<number, string>> = {
  0x200b: "ZWSP", 0x200c: "ZWNJ", 0x200d: "ZWJ", 0x2060: "WJ", 0xfeff: "BOM", 0x00ad: "SHY",
};
/** Single invisible code points: policy.ts's INVISIBLE list (besides \p{Cf}) and the combining grapheme joiner. */
const INVISIBLE_POINTS: ReadonlySet<number> = new Set([0xad, 0x115f, 0x1160, 0x2800, 0x3164, 0xffa0, 0x034f, 0x17b4, 0x17b5]);
/** Invisible ranges: Mongolian variation selectors, variation selectors, tags and the supplementary selectors. */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [[0x180b, 0x180f], [0xfe00, 0xfe0f], [0xe0000, 0xe007f], [0xe0100, 0xe01ef]];
/** policy.ts's INVISIBLE (format characters and the blank look-alikes) plus variation selectors and tags. */
const isInvisible = (ch: string, cp: number) => /^\p{Cf}$/u.test(ch) || INVISIBLE_POINTS.has(cp) || INVISIBLE_RANGES.some(([a, b]) => cp >= a && cp <= b);
/** Spaces that look like a space but aren't one (a shell doesn't split on them): every Zs but U+0020 and U+00A0. */
const ODD_SPACE = /^[\u1680\u2000-\u200a\u202f\u205f\u3000]$/u;
/** Where a token ends: the whitespace a shell splits on (the odd spaces above stay inside a token, as a shell sees them). */
const SPLIT = /[ \t\n\r\f\v]/;

const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/** The script group of a letter, for mixed-script marking (scripts people write together count as one). */
function scriptOf(ch: string): string | null {
  if (!/\p{L}/u.test(ch)) return null;
  if (/\p{sc=Latin}/u.test(ch)) return "Latin";
  if (/\p{sc=Cyrillic}/u.test(ch)) return "Cyrillic";
  if (/\p{sc=Greek}/u.test(ch)) return "Greek";
  if (/\p{sc=Armenian}/u.test(ch)) return "Armenian";
  if (/\p{sc=Georgian}/u.test(ch)) return "Georgian";
  if (/\p{sc=Cherokee}/u.test(ch)) return "Cherokee";
  if (/\p{sc=Hebrew}/u.test(ch)) return "Hebrew";
  if (/\p{sc=Arabic}/u.test(ch)) return "Arabic";
  if (/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Bopomofo}]/u.test(ch)) return "CJK";
  if (/\p{sc=Thai}/u.test(ch)) return "Thai";
  if (/\p{sc=Devanagari}/u.test(ch)) return "Devanagari";
  // Letters of no script (mathematical alphanumerics such as 𝐫) are a group of their own, so they stand out too.
  if (/\p{sc=Common}/u.test(ch) || /\p{sc=Inherited}/u.test(ch)) return "Common";
  return "Other";
}

/** The special form of one character, or null when it shows as itself. */
function special(ch: string): VisibleSegment | null {
  const cp = ch.codePointAt(0)!;
  if (ch === "\t") return { text: "→", kind: "tab" };
  if (cp === 0xa0) return { text: "⟨NBSP⟩", kind: "nbsp" };
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029) return { text: `⟨${hex(cp)}⟩`, kind: "control" };
  if (BIDI[cp]) return { text: `⟨${BIDI[cp]}⟩`, kind: "bidi" };
  if (isInvisible(ch, cp) || ODD_SPACE.test(ch)) return { text: `⟨${NAMED_INVISIBLE[cp] ?? hex(cp)}⟩`, kind: "invisible" };
  return null;
}

/** A string as segments: plain runs merged, every special character and every out-of-script letter on its own. */
export function visibleText(s: string): VisibleSegment[] {
  const out: VisibleSegment[] = [];
  const push = (seg: VisibleSegment) => {
    const last = out[out.length - 1];
    if (seg.kind === "plain" && last?.kind === "plain") last.text += seg.text;
    else out.push(seg);
  };
  const chars = [...String(s ?? "")];
  let i = 0;
  while (i < chars.length) {
    // One token: up to the next splitting whitespace (that whitespace is a token of its own).
    let j = i;
    if (SPLIT.test(chars[i])) j = i + 1;
    else while (j < chars.length && !SPLIT.test(chars[j])) j++;
    const token = chars.slice(i, j);
    // The token's main script: the one most of its letters are in (the first seen wins a tie). Letters of no script
    // are never the main one while the token has letters of a real script.
    const counts = new Map<string, number>();
    for (const ch of token) {
      const sc = scriptOf(ch);
      if (sc) counts.set(sc, (counts.get(sc) ?? 0) + 1);
    }
    let main: string | null = null;
    for (const [sc, n] of counts) {
      if (sc === "Common" && counts.size > 1) continue;
      if (main === null || n > counts.get(main)!) main = sc;
    }
    // Latin beside Chinese, Japanese or Korean letters is how those languages name files (UTS #39's "highly
    // restrictive" mixes), and no Latin letter looks like one of theirs: nothing to mark.
    if ([...counts.keys()].every(sc => sc === "Latin" || sc === "CJK")) main = null;
    for (const ch of token) {
      const sp = special(ch);
      if (sp) { push(sp); continue; }
      const sc = scriptOf(ch);
      push(sc && main && sc !== main ? { text: ch, kind: "mixed" } : { text: ch, kind: "plain" });
    }
    i = j;
  }
  return out;
}

/** What a segment shows: CL's segments may carry the raw character for a special kind, this module's carry the token. */
export function segmentLabel(seg: VisibleSegment): string {
  if (seg.kind === "plain" || seg.kind === "mixed") return seg.text;
  if (seg.kind === "tab") return seg.text === "\t" ? "→" : seg.text;
  if (seg.text.startsWith("⟨")) return seg.text;
  return [...seg.text].map(ch => special(ch)?.text ?? `⟨${hex(ch.codePointAt(0)!)}⟩`).join("");
}

/** The segment ends a line (a newline control): the page breaks the line after its token, so a script reads as lines. */
export const breaksLine = (seg: VisibleSegment): boolean => seg.kind === "control" && (seg.text === "⟨U+000A⟩" || seg.text === "\n");

/** Which legend lines a string needs (§8.5): ⟨ ⟩ tokens, and letters from another alphabet. */
export function legendFor(segments: readonly VisibleSegment[]): { tokens: boolean; mixed: boolean } {
  return {
    tokens: segments.some(s => s.kind === "control" || s.kind === "bidi" || s.kind === "invisible" || s.kind === "nbsp"),
    mixed: segments.some(s => s.kind === "mixed"),
  };
}
