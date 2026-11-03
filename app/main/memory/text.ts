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

/** Words that turn a statement round ("not", "never", "don't"…). */
const NEGATION = /\b(?:not|no|never|none|nobody|nothing|neither|nor|without|cannot|nowhere)\b|n['’]t\b/gu;
/**
 * Words that say the opposite of liking or doing ("hate", "stopped", "tired of"…; "can't stand" is already a
 * negation): "I hate Teams" is not "Likes Teams", nor "I quit Globex" "Works at Globex" (review of PR #142).
 */
const AVERSE = /\b(?:hate[sd]?|hating|dislike[sd]?|disliking|detest(?:s|ed)?|loathe[sd]?|avoid(?:s|ed)?|stopp(?:ed|ing)|quit(?:s|ting)?|tired\s+of|sick\s+of|fed\s+up|gave\s+up|giv(?:e|es|ing)\s+up)\b/gu;

/** A statement's polarity: true when it is said the other way round (an odd number of negations and aversions). */
export function negated(s: string): boolean {
  const t = fold(s);
  return ((t.match(NEGATION)?.length ?? 0) + (t.match(AVERSE)?.length ?? 0)) % 2 === 1;
}

/**
 * Whether `fact` says what `said` says the same way round: its clause that covers the most of the fact's terms ("I'm
 * not on Atlas any more, I'm on Orion now" for "Works on Orion") has the fact's polarity. Clauses that cover it
 * equally and disagree can't tell ("I work with Bob, not with Alice" for "Works with Alice"): not the same way round.
 */
export function samePolarity(fact: string, said: string): boolean {
  const want = new Set(terms(fact));
  const clauses = said.split(/[.;!?\n,]+|\s+(?:but|although|though|whereas)\s+/i).filter(c => c.trim());
  if (!clauses.length) clauses.push(said);
  const counted = clauses.map(c => ({ c, n: terms(c).filter(t => want.has(t)).length }));
  const most = Math.max(...counted.map(x => x.n));
  const ways = new Set(counted.filter(x => x.n === most).map(x => negated(x.c)));
  return ways.size === 1 && ways.has(negated(fact));
}

/** How alike two texts are, 0 to 1 (Jaccard on their terms): near-duplicate facts score 0.8 and up. */
export function similarity(a: string, b: string): number {
  return termSimilarity(new Set(terms(a)), new Set(terms(b)));
}

/** The same comparison when several facts are compared against already-tokenized words. */
export function termSimilarity(x: ReadonlySet<string>, y: ReadonlySet<string>): number {
  if (!x.size && !y.size) return 1;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}
