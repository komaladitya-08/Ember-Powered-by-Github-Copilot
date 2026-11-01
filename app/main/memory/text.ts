/**
 * Words for Ember's memory (./graph.ts, ./recall.ts): how a fact or a question is cut into terms, and how names are
 * folded so "VS Code", "vs code" and "VS-Code" are one entity. Pure and OS-neutral: memory is matched the same on
 * every platform, and nothing here reaches outside its argument.
 */

/** Words too common to say anything about a fact (English only for now: other languages match on every word). */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "do", "does", "for", "from", "has", "have",
  "he", "her", "his", "how", "i", "if", "in", "into", "is", "it", "its", "me", "my", "of", "on", "or", "our", "she",
  "so", "that", "the", "their", "them", "they", "this", "to", "uses", "was", "we", "were", "what", "when", "where",
  "which", "who", "why", "will", "with", "you", "your",
]);

/** Lowercase NFKC text without invisible characters, as names and terms are matched. */
export function fold(s: string): string {
  return s.normalize("NFKC").replace(/\p{Cf}/gu, "").toLowerCase();
}

/** A plural's singular, roughly ("projects" → "project", "class" stays): enough that "meetings" finds "meeting". */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

/**
 * The terms of `s`: its words and numbers, folded and singular, without stopwords or single Latin letters (the "s" of
 * "Priya's" would otherwise join every possessive). A single CJK character is a word, and kept.
 */
export function terms(s: string): string[] {
  const words = fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter(w => !STOPWORDS.has(w) && !/^[a-z]$/.test(w)).map(stem);
}

/** One key per name: folded, with punctuation and spacing dropped ("VS-Code" and "vs code" are both "vscode"). */
export function nameKey(name: string): string {
  return (fold(name).match(/[\p{L}\p{N}]+/gu) ?? []).join("");
}

/** How alike two texts are, 0 to 1 (Jaccard on their terms): near-duplicate facts score 0.8 and up. */
export function similarity(a: string, b: string): number {
  const x = new Set(terms(a));
  const y = new Set(terms(b));
  if (!x.size && !y.size) return 1;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}
