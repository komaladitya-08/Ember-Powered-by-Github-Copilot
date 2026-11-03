/**
 * How alike two spoken words sound, for correcting the recogniser's near-misses (correct.ts): a small English sound
 * key (Metaphone's main rules: silent letters dropped, letters that sound alike merged, vowels kept only at the start)
 * and edit distance over letters and over keys. Pure and tiny: Moonshine runs offline with no way to bias it towards
 * a name, so Ember fixes the text after it (docs/ASSISTANT.md "Personalisation").
 */

/** Letters only, lower case, accents dropped ("Zoë" → "zoe"). */
export function letters(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
}

/** The word's sound key: "Priya" → "PR", "Pria" → "PR", "Jira" → "JR", "Gira" → "JR", "Slack" → "SLK". */
export function soundKey(word: string): string {
  let w = letters(word);
  if (!w) return "";
  // Silent or merged starts.
  w = w.replace(/^(kn|gn|pn|wr|ps)/, m => m[1]).replace(/^x/, "s").replace(/^wh/, "w");
  let out = "";
  // A letter in a set ("" past the word's end is in none). Voiced and unvoiced pairs share a key (b/p, d/t, g/k, v/f,
  // z/s): the recogniser confuses them most.
  const vowel = (ch: string) => ch !== "" && "aeiou".includes(ch);
  const soft = (ch: string) => ch !== "" && "eiy".includes(ch);
  for (let i = 0; i < w.length; i++) {
    const c = w[i], next = w[i + 1] ?? "", prev = w[i - 1] ?? "";
    let k: string;
    if (vowel(c)) k = i === 0 ? "A" : "";
    else if (c === "y") k = i === 0 && !vowel(next) ? "A" : i === 0 ? "J" : "";
    else if (c === "b") k = prev === "m" && i === w.length - 1 ? "" : "P";
    else if (c === "c") {
      if (next === "h") { k = "X"; i++; }
      else if (soft(next)) k = "S";
      else if (next === "k") { k = "K"; i++; }
      else k = "K";
    } else if (c === "d") k = next === "g" && soft(w[i + 2] ?? "") ? "J" : "T";
    else if (c === "g") {
      if (next === "h") { k = i + 2 >= w.length || !vowel(w[i + 2]) ? "" : "K"; i++; }
      else if (next === "n" && (i + 2 >= w.length)) k = "";
      else k = soft(next) ? "J" : "K";
    } else if (c === "h") k = vowel(next) && !vowel(prev) ? "H" : "";
    else if (c === "j") k = "J";
    else if (c === "k") k = prev === "c" ? "" : "K";
    else if (c === "p") { if (next === "h") { k = "F"; i++; } else k = "P"; }
    else if (c === "q") k = "K";
    else if (c === "s") { if (next === "h") { k = "X"; i++; } else k = "S"; }
    else if (c === "t") { if (next === "h") { k = "0"; i++; } else k = "T"; }
    else if (c === "v") k = "F";
    else if (c === "w") k = vowel(next) ? "W" : "";
    else if (c === "x") k = "KS";
    else if (c === "z") k = "S";
    else k = c.toUpperCase(); // f l m n r
    // Doubled sounds count once ("Slakk" is "Slack").
    if (k && !out.endsWith(k)) out += k;
  }
  return out;
}

/** Levenshtein distance (insert, delete, change one character each count 1; a swap of neighbours counts 1 too). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push([i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2][j - 2] + 1);
      rows[i][j] = d;
    }
  }
  return rows[a.length][b.length];
}

/** 1 for the same, 0 for nothing alike: 1 − distance / the longer length. */
export function likeness(a: string, b: string): number {
  const n = Math.max(a.length, b.length);
  return n ? 1 - editDistance(a, b) / n : 1;
}

/**
 * How alike `heard` (the recogniser's words, run together) and `word` (a lexicon entry's) sound, 0 to 1: their sound
 * keys weigh 0.6, their letters 0.4. Measured on the voice clips' near-misses (docs/ASSISTANT.md): a real near-miss
 * ("Pria" for "Priya", "Slak" for "Slack", "Jirah" for "Jira") came to 0.85 or more, a different word that shares
 * sounds ("close" for "Clocks", "files" for "Firefox") to 0.75 or less.
 */
export function soundsLike(heard: string, word: string): number {
  const a = letters(heard), b = letters(word);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 0.6 * likeness(soundKey(a), soundKey(b)) + 0.4 * likeness(a, b);
}
