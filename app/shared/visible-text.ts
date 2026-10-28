/**
 * A command made visible character by character for the command card (design §3.9.1, R7, critique security-10): control
 * characters, direction overrides, zero-width and other invisible characters, tabs and non-breaking spaces become
 * visible tokens, and in every word the letters from a script other than the word's main one are marked "mixed" (a
 * Cyrillic "і" in "buіld"), so what the user approves is what runs. A word ends at whitespace and at the characters
 * that join names into paths, options and addresses (/ \ = : , ; @ and the like), so the user's own folder in their
 * alphabet (C:\Users\Иван) marks nothing beside it, while a look-alike letter inside a word still is, and so is a
 * host spelled wholly in letters that only look Latin (https://аррӏе.com, deploy@аррӏе) (review #266).
 * Renderer-safe: no Node or Electron import; the command window's page and main's tests both use it.
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

/**
 * policy.ts's INVISIBLE set (format characters and the blank look-alikes), plus the zero-width characters, the
 * combining grapheme joiner, and the variation selectors (Mongolian, standard and supplementary), which change how the
 * letter before them looks without showing themselves.
 */
const INVISIBLE = /[\p{Cf}\u00ad\u115f\u1160\u180e\u2800\u3164\uffa0\u200b-\u200d\u2060\ufeff]|\u034f|\u17b4|\u17b5|\u180b|\u180c|\u180d|\u180f|[\ufe00-\ufe0f]|[\u{e0100}-\u{e01ef}]/u;

/** Space characters other than the plain space: shown, so two look-alike commands can't differ invisibly. */
const ODD_SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u;

/**
 * Scripts a letter can belong to, checked in order; Chinese, Japanese and Korean count as one script, as they mix in
 * ordinary text. A token wholly in one of them (digits and punctuation aside) is never marked; Latin beside any of them,
 * CJK included, is (§3.9.1: in every token, letters from a script other than its main one).
 */
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

/**
 * Letters of other alphabets that look like a Latin letter (Unicode's confusables, the common ones): Cyrillic а е о р
 * с у х ѕ і ј ӏ һ ԁ ԛ ԝ ү and capitals, Greek α ο ν ι ρ υ γ and capitals, Armenian օ ս հ ո. A word that mixes Latin
 * with only these is judged Latin, so раураl.com marks раура, and a word written wholly in them beside Latin in the
 * same token (deploy@аррӏе) is marked too (review #266). A real name in that alphabet (Иван, пример.рф) has letters
 * that look like no Latin one and is left alone.
 */
const LATIN_LOOKALIKE = /[\u0430\u0435\u043e\u0440\u0441\u0443\u0445\u0455\u0456\u0458\u04cf\u04bb\u0501\u051b\u051d\u04af\u0410\u0412\u0415\u041a\u041c\u041d\u041e\u0420\u0421\u0422\u0423\u0425\u0405\u0406\u0408\u04ae\u04ba\u04c0\u051a\u051c\u03b1\u03bf\u03bd\u03b9\u03c1\u03c5\u03b3\u0391\u0392\u0395\u0396\u0397\u0399\u039a\u039c\u039d\u039f\u03a1\u03a4\u03a5\u03a7\u0585\u057d\u0570\u0578]/u;

/** The script of a letter ("Other" for a letter of none of the listed scripts), or null for anything else. */
function scriptOf(ch: string): string | null {
  if (!LETTER.test(ch)) return null;
  for (const [name, re] of SCRIPTS) if (re.test(ch)) return name;
  return "Other";
}

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * Characters that end a word as whitespace does: path separators, option and assignment marks, list separators, the
 * at sign of user@host, brackets, pipes and quotes. Not "." "-" "_": they sit inside one name (buіld.sh, my-gіt), and a
 * web address's label in another alphabet (github.сом) stays one word with the rest of the name, so it is marked.
 */
const WORD_BREAK = /[/\\=:,;@|&<>()[\]{}'"`]/u;

/** How one character shows, or null when it shows as itself. */
function special(ch: string): VisibleSegment | null {
  const cp = ch.codePointAt(0) ?? 0;
  if (ch === "\t") return { text: "→", kind: "tab" };
  // A newline is the command's own line break (here-documents span lines): shown as one.
  if (ch === "\n") return null;
  // C0 and C1 controls, and the line and paragraph separators (a line break to a reader, a word character to a shell).
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029) return { text: `⟨${hex(cp)}⟩`, kind: "control" };
  if (BIDI[cp]) return { text: `⟨${BIDI[cp]}⟩`, kind: "bidi" };
  if (cp === 0x00a0) return { text: "⟨NBSP⟩", kind: "nbsp" };
  if (ODD_SPACE.test(ch)) return { text: `⟨${hex(cp)}⟩`, kind: "nbsp" };
  if (INVISIBLE.test(ch)) return { text: `⟨${INVISIBLE_NAMES[cp] ?? hex(cp)}⟩`, kind: "invisible" };
  // Unpaired surrogates and noncharacters (U+FDD0-FDEF, and the last two of every plane) can't be shown faithfully.
  if ((cp >= 0xd800 && cp <= 0xdfff) || (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) return { text: `⟨${hex(cp)}⟩`, kind: "invisible" };
  return null;
}

/**
 * The command as the card shows it: plain runs, visible tokens for controls (`⟨U+001B⟩`), bidi controls (`⟨RLO⟩`),
 * invisible characters (`⟨ZWSP⟩`), tabs (`→`) and non-breaking spaces (`⟨NBSP⟩`), and "mixed" runs for letters from a
 * script other than their word's main one (on a tie between Latin and another script, or when the other script's
 * letters all look Latin, the other one is marked; see LATIN_LOOKALIKE).
 */
export function visibleText(s: string): VisibleSegment[] {
  const chars = Array.from(s);
  // The main script of each word (whitespace, specials and WORD_BREAK end one).
  const main: (string | null)[] = new Array<string | null>(chars.length).fill(null);
  // Words written wholly in Latin look-alikes of another alphabet, as [start, end), and whether each token (whitespace
  // and specials end one) holds a Latin letter.
  const lookalikeWords: [number, number][] = [];
  const tokenLatin: boolean[] = new Array<boolean>(chars.length).fill(false);
  let start = 0;
  let tokenStart = 0;
  const closeToken = (end: number): void => {
    const counts = new Map<string, number>();
    let lookalikesOnly = true;
    for (let k = start; k < end; k++) {
      const sc = scriptOf(chars[k]);
      if (sc) counts.set(sc, (counts.get(sc) ?? 0) + 1);
      if (sc && sc !== "Latin" && !LATIN_LOOKALIKE.test(chars[k])) lookalikesOnly = false;
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [sc, n] of counts) {
      if (n > bestN || (n === bestN && sc === "Latin")) { best = sc; bestN = n; }
    }
    const others = [...counts.keys()].some(sc => sc !== "Latin");
    // Latin beside nothing but look-alikes (раураl.com): the look-alikes are the ones marked.
    if (others && lookalikesOnly && counts.has("Latin")) best = "Latin";
    if (others && lookalikesOnly && !counts.has("Latin")) lookalikeWords.push([start, end]);
    for (let k = start; k < end; k++) main[k] = best;
  };
  for (let k = 0; k <= chars.length; k++) {
    const blank = k === chars.length || /\s/u.test(chars[k]) || special(chars[k]) !== null;
    if (blank || WORD_BREAK.test(chars[k])) {
      closeToken(k);
      start = k + 1;
    }
    if (blank) {
      const latin = chars.slice(tokenStart, k).some(ch => scriptOf(ch) === "Latin");
      for (let j = tokenStart; j < k; j++) tokenLatin[j] = latin;
      tokenStart = k + 1;
    }
  }
  // A word wholly in look-alikes beside Latin in its token (deploy@аррӏе): marked as if the word were Latin.
  for (const [a, b] of lookalikeWords) if (tokenLatin[a]) for (let k = a; k < b; k++) main[k] = "Latin";

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
