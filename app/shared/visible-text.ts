/**
 * A command made visible character by character for the command card (design §3.9.1, R7, critique security-10): control
 * characters, direction overrides, zero-width and other invisible characters, tabs and non-breaking spaces become
 * visible tokens, and in every whitespace-separated token the letters from a script other than the token's main one
 * are marked "mixed" (a Cyrillic "і" in "buіld"), so what the user approves is what runs. Renderer-safe: no Node or
 * Electron import; the command window's page and main's tests both use it.
 */

/** One run of the command as the card shows it. */
export interface VisibleSegment { text: string; kind: "plain" | "control" | "bidi" | "invisible" | "tab" | "nbsp" | "mixed" }

/** Bidi controls and their short names. */
const BIDI: Readonly<Record<number, string>> = {
  0x202a: "LRE", 0x202b: "RLE", 0x202c: "PDF", 0x202d: "LRO", 0x202e: "RLO",
  0x2066: "LRI", 0x2067: "RLI", 0x2068: "FSI", 0x2069: "PDI",
  0x200e: "LRM", 0x200f: "RLM", 0x061c: "ALM",
};

/** Named invisible characters. */
const INVISIBLE_NAMES: Readonly<Record<number, string>> = {
  0x200b: "ZWSP", 0x200c: "ZWNJ", 0x200d: "ZWJ", 0x2060: "WJ", 0xfeff: "BOM", 0x00ad: "SHY", 0x034f: "CGJ",
  0x180e: "MVS", 0x2061: "FA", 0x2062: "IT", 0x2063: "IS", 0x2064: "IP",
};

/** policy.ts's INVISIBLE set (format characters and the blank look-alikes), plus the zero-width characters. */
const INVISIBLE = /[\p{Cf}\u00ad\u115f\u1160\u180e\u2800\u3164\uffa0\u200b-\u200d\u2060\ufeff]|\u034f|\u17b4|\u17b5|\u180b|\u180c|\u180d|\u180f/u;

/** Space characters other than the plain space: shown, so two look-alike commands can't differ invisibly. */
const ODD_SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u;

/** Scripts a letter can belong to, checked in order; CJK scripts count as one, as they mix in ordinary text. */
const SCRIPTS: readonly [string, RegExp][] = [
  ["Latin", /\p{Script=Latin}/u],
  ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Greek", /\p{Script=Greek}/u],
  ["Armenian", /\p{Script=Armenian}/u],
  ["Georgian", /\p{Script=Georgian}/u],
  ["Cherokee", /\p{Script=Cherokee}/u],
  ["Hebrew", /\p{Script=Hebrew}/u],
  ["Arabic", /\p{Script=Arabic}/u],
  ["CJK", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u],
  ["Thai", /\p{Script=Thai}/u],
  ["Devanagari", /\p{Script=Devanagari}/u],
];
const LETTER = /\p{L}/u;

/** The script of a letter ("Other" for a letter of none of the listed scripts), or null for anything else. */
function scriptOf(ch: string): string | null {
  if (!LETTER.test(ch)) return null;
  for (const [name, re] of SCRIPTS) if (re.test(ch)) return name;
  return "Other";
}

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/** How one character shows, or null when it shows as itself. */
function special(ch: string): VisibleSegment | null {
  const cp = ch.codePointAt(0) ?? 0;
  if (ch === "\t") return { text: "→", kind: "tab" };
  // A newline is the command's own line break (here-documents span lines): shown as one.
  if (ch === "\n") return null;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return { text: `⟨${hex(cp)}⟩`, kind: "control" };
  if (BIDI[cp]) return { text: `⟨${BIDI[cp]}⟩`, kind: "bidi" };
  if (cp === 0x00a0) return { text: "⟨NBSP⟩", kind: "nbsp" };
  if (ODD_SPACE.test(ch)) return { text: `⟨${hex(cp)}⟩`, kind: "nbsp" };
  if (INVISIBLE.test(ch)) return { text: `⟨${INVISIBLE_NAMES[cp] ?? hex(cp)}⟩`, kind: "invisible" };
  // Unpaired surrogates and noncharacters can't be shown faithfully.
  if ((cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === 0xffff) return { text: `⟨${hex(cp)}⟩`, kind: "invisible" };
  return null;
}

/**
 * The command as the card shows it: plain runs, visible tokens for controls (`⟨U+001B⟩`), bidi controls (`⟨RLO⟩`),
 * invisible characters (`⟨ZWSP⟩`), tabs (`→`) and non-breaking spaces (`⟨NBSP⟩`), and "mixed" runs for letters from a
 * script other than their token's main one (on a tie between Latin and another script, the other one is marked).
 */
export function visibleText(s: string): VisibleSegment[] {
  const chars = Array.from(s);
  // The main script of each whitespace-separated token.
  const main: (string | null)[] = new Array<string | null>(chars.length).fill(null);
  let start = 0;
  const closeToken = (end: number): void => {
    const counts = new Map<string, number>();
    for (let k = start; k < end; k++) {
      const sc = scriptOf(chars[k]);
      if (sc) counts.set(sc, (counts.get(sc) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [sc, n] of counts) {
      if (n > bestN || (n === bestN && sc === "Latin")) { best = sc; bestN = n; }
    }
    for (let k = start; k < end; k++) main[k] = best;
  };
  for (let k = 0; k <= chars.length; k++) {
    if (k === chars.length || /\s/u.test(chars[k]) || special(chars[k]) !== null) {
      closeToken(k);
      start = k + 1;
    }
  }

  const out: VisibleSegment[] = [];
  const push = (text: string, kind: VisibleSegment["kind"]): void => {
    const last = out[out.length - 1];
    if (last && last.kind === kind && (kind === "plain" || kind === "mixed")) last.text += text;
    else out.push({ text, kind });
  };
  chars.forEach((ch, k) => {
    const sp = special(ch);
    if (sp) { out.push(sp); return; }
    const sc = scriptOf(ch);
    push(ch, sc !== null && main[k] !== null && sc !== main[k] ? "mixed" : "plain");
  });
  return out;
}

/** Whether `s` holds anything visibleText marks (a control, bidi, invisible, odd space or mixed-script letter). */
export function hasHidden(s: string): boolean {
  return visibleText(s).some(seg => seg.kind !== "plain" && seg.kind !== "tab");
}
