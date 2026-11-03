/**
 * Ember's memory upkeep while the user isn't asking anything: Letta's "sleep-time compute" (Lin et al., arXiv
 * 2504.13171), the part that needs no model. Incremental remembering leaves the graph messy (one person under two
 * names, the same fact said three ways, observations nobody ever needed), so this pass merges entities that share a
 * name, folds near-duplicate facts together, and forgets what has gone stale, keeping the graph under MAX_FACTS.
 *
 * What the user told Ember is never dropped for age or disuse; only `forget` (theirs) removes it, or the cap when the
 * graph is full of nothing else. Pure over the graph it is given.
 */

import { setImmediate } from "node:timers/promises";
import { DUPLICATE, MAX_FACTS, type Fact, type MemoryGraph } from "./graph";
import { nameKey, terms, termSimilarity } from "./text";

/** Closed facts older than this are forgotten (days). */
export const HISTORY_DAYS = 180;
/** Inferred and observed facts never used in this long, and not sure, are forgotten (days). */
export const STALE_DAYS = 90;
/** "Not sure": below this confidence. */
export const STALE_CONFIDENCE = 0.6;

export interface ConsolidateReport { mergedEntities: number; mergedFacts: number; forgotten: number; orphans: number }

const DAY = 86_400_000;
const SLICE_MS = 8;
type ConsolidateOptions = { now?: Date; maxFacts?: number };

/** How much a fact is worth keeping when the graph is full: trust, use and freshness. */
function worth(f: Fact, now: number): number {
  const age = (now - Date.parse(f.lastUsedAt ?? f.createdAt)) / DAY;
  return (f.source === "user" ? 2 : 0) + f.confidence + Math.log1p(f.uses) - age / 365 - (f.invalidAt ? 1 : 0);
}

export function consolidate(graph: MemoryGraph, o: ConsolidateOptions = {}): ConsolidateReport {
  const steps = consolidationSteps(graph, o);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** Runs the same pass on a detached graph, letting input and Stop run between slices. */
export async function consolidateInSlices(graph: MemoryGraph, o: ConsolidateOptions, signal: AbortSignal): Promise<ConsolidateReport | null> {
  const steps = consolidationSteps(graph, o);
  while (!signal.aborted) {
    await setImmediate();
    if (signal.aborted) break;
    const until = performance.now() + SLICE_MS;
    do {
      const step = steps.next();
      if (step.done) return step.value;
    } while (performance.now() < until);
  }
  return null;
}

function* consolidationSteps(graph: MemoryGraph, o: ConsolidateOptions): Generator<void, ConsolidateReport> {
  const now = (o.now ?? new Date()).getTime();
  const report: ConsolidateReport = { mergedEntities: 0, mergedFacts: 0, forgotten: 0, orphans: 0 };

  // One entity per name: an alias that became another entity's name (added before it was known) folds into the older.
  const byKey = new Map<string, string>();
  for (const e of [...graph.allEntities()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    yield;
    if (!graph.entity(e.id)) continue;
    const keys = [e.name, ...e.aliases].map(nameKey).filter(Boolean);
    const into = keys.map(k => byKey.get(k)).find(id => id && id !== e.id && graph.entity(id));
    if (into) {
      graph.mergeEntities(into, e.id);
      report.mergedEntities++;
      for (const k of keys) byKey.set(k, into);
    } else {
      for (const k of keys) if (!byKey.has(k)) byKey.set(k, e.id);
    }
  }

  // Near-duplicate open facts about the same entities: the stronger one stays and takes the other's uses.
  const open = graph.allFacts(true).sort((a, b) => b.confidence - a.confidence || b.uses - a.uses || a.createdAt.localeCompare(b.createdAt));
  const wordSets: Set<string>[] = [];
  for (const f of open) {
    wordSets.push(new Set(terms(f.text)));
    yield;
  }
  const gone = new Set<string>();
  for (let i = 0; i < open.length; i++) {
    yield;
    const a = open[i];
    if (gone.has(a.id)) continue;
    let keep = graph.fact(a.id)!;
    for (let j = i + 1; j < open.length; j++) {
      if (j % 64 === 0) yield;
      const b = open[j];
      if (gone.has(b.id) || b.entities.length !== keep.entities.length || !b.entities.every(id => keep.entities.includes(id))) continue;
      if (termSimilarity(wordSets[i], wordSets[j]) < DUPLICATE) continue;
      keep = { ...keep, uses: keep.uses + b.uses, source: keep.source === "user" || b.source !== "user" ? keep.source : "user" };
      graph.forgetFact(b.id);
      gone.add(b.id);
      report.mergedFacts++;
      yield;
    }
    graph.replaceFact(keep);
  }

  // Stale: old history, and unsure guesses nobody needed.
  for (const f of graph.allFacts()) {
    yield;
    const since = (now - Date.parse(f.invalidAt ?? f.lastUsedAt ?? f.createdAt)) / DAY;
    const oldHistory = !!f.invalidAt && since > HISTORY_DAYS;
    const staleGuess = !f.invalidAt && f.source !== "user" && f.uses === 0 && f.confidence < STALE_CONFIDENCE && since > STALE_DAYS;
    if (oldHistory || staleGuess) { graph.forgetFact(f.id); report.forgotten++; }
  }

  // Over the cap: the least worth keeping go first.
  const max = o.maxFacts ?? MAX_FACTS;
  const all = graph.allFacts();
  if (all.length > max) {
    const byWorth = all.map(f => ({ f, score: worth(f, now) })).sort((a, b) => a.score - b.score);
    for (const { f } of byWorth.slice(0, all.length - max)) {
      graph.forgetFact(f.id);
      report.forgotten++;
      yield;
    }
  }
  report.orphans = graph.dropOrphans();
  return report;
}
