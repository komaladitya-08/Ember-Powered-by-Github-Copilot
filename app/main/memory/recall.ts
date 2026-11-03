/**
 * Finding what Ember remembers that bears on a question, the way HippoRAG 2 does (Gutiérrez et al., arXiv 2502.14802):
 * lexical matches seed a Personalized PageRank over the entity–fact graph, so a fact two hops away ("the report is for
 * Priya" → "Priya's team uses Jira") is found from a question that names only one end. Final scores mix the walk with
 * the BM25 match, how recently a fact was used and how sure Ember is of it, as Generative Agents' retrieval does
 * (Park et al., 2023: relevance, recency, importance).
 *
 * Matching by meaning comes from Better recall (./embed.ts), once its model is downloaded: a question's nearest facts
 * by vector (`RecallOptions.semantic`) seed the walk beside the lexical matches, and add a score of their own. Without
 * them recall is exactly lexical, as it was before the model (memory.test.ts checks it byte for byte). Pure: the graph
 * is only read.
 */

import type { Fact, MemoryGraph } from "./graph";
import { nameKey, terms } from "./text";

export interface RecallOptions {
  /** How many facts to return (default 8). */
  k?: number;
  /** Closed facts too (what used to be true), marked as such. */
  history?: boolean;
  /**
   * Facts less relevant than this are left out, however fresh or sure (default 0.03): relevance is the stronger of the
   * walk and the lexical match, each as a share of the best fact's, so a fact one specific hop away (a few percent of
   * the matched fact's rank) stays and one reached only through a hub ("User", in most facts) drops out. A question
   * that matches nothing finds nothing whatever this is: nothing seeds the walk.
   */
  minRelevance?: number;
  /** More fact ids to seed the walk with, and their weights. */
  extraSeeds?: Map<string, number>;
  /**
   * The facts most like the question by meaning (fact id → cosine similarity, from ./embed.ts's index): each seeds
   * the walk, and counts towards relevance and the score by how far it is above SEMANTIC_FLOOR, as a share of the
   * best match's.
   */
  semantic?: Map<string, number>;
  now?: Date;
}

export interface Recalled { fact: Fact; score: number }

/** BM25's usual constants. */
const K1 = 1.2;
const B = 0.75;
/** PageRank's chance of following an edge rather than jumping back to a seed (HippoRAG uses 0.5). */
const DAMPING = 0.5;
const ITERATIONS = 30;
/** A fact's recency halves every this many days without use. */
const HALF_LIFE_DAYS = 30;

const WEIGHTS = { walk: 0.45, lexical: 0.35, recency: 0.1, confidence: 0.1 };
/**
 * Facts less alike than this (cosine, all-MiniLM-L6-v2) are no match by meaning. On the benchmark
 * (test/fixtures/memory-bench.json) nine in ten paraphrased questions' answers score 0.25 or more, a few as little as
 * 0.15 to 0.2; questions about nothing remembered reach 0.3 to 0.5 with a fact on the same subject ("Make the text
 * bigger" and the preferred terminal font size), which is context worth having. 0.2 found 96% of answers in the first
 * five; 0.25 found 89%.
 */
export const SEMANTIC_FLOOR = 0.2;
/**
 * The mix with semantic matches, measured on the benchmark (docs/MEMORY.md §2): the semantic share from 0.4 to 0.9
 * found 83–84% of paraphrased answers first (lexical alone: 9%), and every keyword question's answer first. 0.6 is in
 * the middle of that plateau; the rest keeps the lexical mix's proportions.
 */
export const SEMANTIC_WEIGHTS = { walk: 0.18, lexical: 0.14, semantic: 0.6, recency: 0.04, confidence: 0.04 };
/**
 * How many facts may count by meaning alone (none of the question's words reach them, and it names nothing they are
 * about): the best match only, so a request about nothing remembered brings at most one fact more than the words do.
 * Measured on the benchmark (docs/MEMORY.md §2): unrelated requests got 3.2 facts with no limit and get 1.3 with one
 * (0.5 by words alone); other-words questions found first 84% → 83%, in the first five 96% → 86%. No cosine floor
 * does as well: unrelated requests' best matches (0.18–0.49) overlap the right answers' (0.2–0.3).
 */
export const SEMANTIC_ALONE = 1;
/** A semantic match seeds the walk this strongly at best (a lexical match's best is 1). */
export const SEMANTIC_SEED = 1;

/** The text a fact is matched on: its sentence and the names of what it is about. */
function document(graph: MemoryGraph, f: Fact): string[] {
  const names = f.entities.flatMap(id => {
    const e = graph.entity(id);
    return e ? [e.name, ...e.aliases] : [];
  });
  return terms(`${f.text} ${names.join(" ")}`);
}

/** BM25 scores of `facts` for `query`, by fact id (only the ones that match). */
export function bm25(graph: MemoryGraph, facts: Fact[], query: string[]): Map<string, number> {
  const docs = facts.map(f => ({ id: f.id, words: document(graph, f) }));
  const avg = docs.reduce((n, d) => n + d.words.length, 0) / (docs.length || 1);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.words)) df.set(t, (df.get(t) ?? 0) + 1);
  const out = new Map<string, number>();
  const q = [...new Set(query)];
  for (const d of docs) {
    const tf = new Map<string, number>();
    for (const t of d.words) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const t of q) {
      const n = tf.get(t);
      if (!n) continue;
      const idf = Math.log(1 + (docs.length - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      s += idf * (n * (K1 + 1)) / (n + K1 * (1 - B + B * d.words.length / (avg || 1)));
    }
    if (s > 0) out.set(d.id, s);
  }
  return out;
}

/** Entities the question names (all of a name's words, or its folded whole, appear in it), weighted by name length. */
export function namedEntities(graph: MemoryGraph, query: string): Map<string, number> {
  const words = new Set(terms(query));
  const whole = nameKey(query);
  const out = new Map<string, number>();
  for (const e of graph.allEntities()) {
    for (const n of [e.name, ...e.aliases]) {
      const nt = terms(n);
      const key = nameKey(n);
      const hit = (nt.length > 0 && nt.every(t => words.has(t))) || (key.length >= 4 && whole.includes(key));
      if (hit) out.set(e.id, Math.max(out.get(e.id) ?? 0, 1 + Math.min(nt.length, 3) * 0.25));
    }
  }
  return out;
}

/**
 * Personalized PageRank over the bipartite graph of entities and facts (each fact joined to its entities), from
 * `seeds` (node id → weight). Returns every node's rank, summing to 1.
 *
 * A fact passes its rank to its entities in inverse proportion to how many facts each is in, so a hub ("User", in
 * nearly every fact) doesn't carry the walk to everything: the walk follows the specific names, as HippoRAG's node
 * specificity intends. An entity passes its rank evenly to its facts.
 */
export function personalizedPageRank(facts: Fact[], seeds: Map<string, number>): Map<string, number> {
  const degree = new Map<string, number>();
  for (const f of facts) for (const e of f.entities) degree.set(e, (degree.get(e) ?? 0) + 1);
  const edges = new Map<string, { to: string; w: number }[]>();
  const add = (from: string, to: string, w: number) => { (edges.get(from) ?? edges.set(from, []).get(from)!).push({ to, w }); };
  for (const f of facts) {
    const inv = f.entities.map(e => 1 / degree.get(e)!);
    const sum = inv.reduce((a, b) => a + b, 0);
    f.entities.forEach((e, i) => { add(f.id, e, inv[i] / sum); add(e, f.id, 1 / degree.get(e)!); });
  }
  const known = [...seeds].filter(([id, w]) => edges.has(id) && w > 0);
  const total = known.reduce((a, [, w]) => a + w, 0);
  if (!total) return new Map();
  const reset = new Map(known.map(([id, w]) => [id, w / total]));
  let rank = new Map(reset);
  for (let i = 0; i < ITERATIONS; i++) {
    const next = new Map<string, number>();
    for (const [id, r] of reset) next.set(id, (1 - DAMPING) * r);
    for (const [id, r] of rank) {
      for (const { to, w } of edges.get(id) ?? []) next.set(to, (next.get(to) ?? 0) + DAMPING * r * w);
    }
    rank = next;
  }
  return rank;
}

const normalise = (m: Map<string, number>, ids: Iterable<string>) => {
  let max = 0;
  for (const id of ids) max = Math.max(max, m.get(id) ?? 0);
  return (id: string) => (max ? (m.get(id) ?? 0) / max : 0);
};

/** Each semantic match's share of the best one's height above SEMANTIC_FLOOR (0 at the floor, 1 for the best). */
const aboveFloor = (m: Map<string, number>) => {
  let max = SEMANTIC_FLOOR;
  for (const v of m.values()) max = Math.max(max, v);
  return (id: string) => (max > SEMANTIC_FLOOR ? Math.max(0, ((m.get(id) ?? SEMANTIC_FLOOR) - SEMANTIC_FLOOR) / (max - SEMANTIC_FLOOR)) : 0);
};

/** The facts that bear on `query`, best first. An empty question, or nothing that matches, finds nothing. */
export function recall(graph: MemoryGraph, query: string, o: RecallOptions = {}): Recalled[] {
  const now = (o.now ?? new Date()).getTime();
  const facts = graph.allFacts(!o.history);
  const q = terms(query);
  if (!facts.length) return [];
  const lexical = bm25(graph, facts, q);
  const named = namedEntities(graph, query);
  // Facts the question's words or names also reach count from the floor; of the rest, only the best SEMANTIC_ALONE.
  // The user's own entity, and the word "user" ("add a user", "my username"), are in almost every fact: neither says a
  // request is about one, so neither lets a fact past SEMANTIC_ALONE.
  const isUser = (e: string) => nameKey(graph.entity(e)?.name ?? "") === "user";
  const aboutWords = o.semantic?.size && q.includes("user") ? bm25(graph, facts, q.filter(t => t !== "user")) : lexical;
  const about = (id: string) => aboutWords.has(id) || graph.fact(id)?.entities.some(e => named.has(e) && !isUser(e)) === true;
  let alone = 0;
  const kept = o.semantic?.size
    ? new Map([...o.semantic].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).filter(([id]) => about(id) || alone++ < SEMANTIC_ALONE))
    : undefined;
  const semantic = kept?.size ? kept : undefined;
  if (!q.length && !o.extraSeeds?.size && !semantic) return [];
  if (!lexical.size && !named.size && !o.extraSeeds?.size && !semantic) return [];

  const seeds = new Map<string, number>();
  const lex = normalise(lexical, lexical.keys());
  for (const id of lexical.keys()) seeds.set(id, lex(id));
  for (const [id, w] of named) seeds.set(id, (seeds.get(id) ?? 0) + w);
  for (const [id, w] of o.extraSeeds ?? []) seeds.set(id, (seeds.get(id) ?? 0) + w);
  const ids = facts.map(f => f.id);
  const s = semantic ? aboveFloor(semantic) : null;
  if (s) for (const id of semantic!.keys()) seeds.set(id, (seeds.get(id) ?? 0) + SEMANTIC_SEED * s(id));
  const walk = personalizedPageRank(facts, seeds);

  const w = normalise(walk, ids);
  const l = normalise(lexical, ids);
  const out: Recalled[] = [];
  const min = o.minRelevance ?? 0.03;
  for (const f of facts) {
    const relevance = s ? Math.max(w(f.id), l(f.id), s(f.id)) : Math.max(w(f.id), l(f.id));
    if (relevance < min) continue;
    const used = Date.parse(f.lastUsedAt ?? f.createdAt);
    const days = Math.max(0, (now - used) / 86_400_000);
    const recency = Math.pow(0.5, days / HALF_LIFE_DAYS);
    const mix = s
      ? SEMANTIC_WEIGHTS.walk * w(f.id) + SEMANTIC_WEIGHTS.lexical * l(f.id) + SEMANTIC_WEIGHTS.semantic * s(f.id) + SEMANTIC_WEIGHTS.recency * recency + SEMANTIC_WEIGHTS.confidence * f.confidence
      : WEIGHTS.walk * w(f.id) + WEIGHTS.lexical * l(f.id) + WEIGHTS.recency * recency + WEIGHTS.confidence * f.confidence;
    // A closed fact is history: it ranks below what holds now.
    const score = mix * (f.invalidAt ? 0.5 : 1);
    out.push({ fact: f, score });
  }
  return out.sort((a, b) => b.score - a.score || a.fact.id.localeCompare(b.fact.id)).slice(0, o.k ?? 8);
}
