/**
 * Ember's long-term memory as a graph: entities (people, projects, apps, places, topics) joined by facts, each fact a
 * short sentence about one or two entities. It follows Graphiti's temporal knowledge graph (Zep, arXiv 2501.13956): a
 * fact that a newer one contradicts is closed (`invalidAt`), never deleted, so Ember knows what *was* true and when,
 * and a near-duplicate reinforces the fact already there instead of adding another. Recall is in ./recall.ts and the
 * sleep-time upkeep in ./consolidate.ts.
 *
 * Plain data and pure methods, with no I/O and no Electron: ./store.ts loads and saves it. Every fact passes
 * ./guard.ts first, so no secret is ever kept.
 */

import crypto from "node:crypto";
import { z } from "zod";
import { memoryRefusal } from "./guard";
import { nameKey, similarity } from "./text";

export const ENTITY_KINDS = ["person", "organisation", "project", "app", "place", "topic", "thing"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * Where a fact came from, most trusted first: the user told Ember (`user`), Ember inferred it from the conversation
 * (`conversation`), a task's result (`task`), what Ember saw on the screen or in an app (`observed`), or a connected
 * service (`connector`). Only `user` facts may steer what Ember does; the rest are context.
 */
export const SOURCES = ["user", "conversation", "task", "observed", "connector"] as const;
export type Source = (typeof SOURCES)[number];

/** The longest fact kept, in characters: memory holds sentences, not documents. */
export const MAX_FACT_CHARS = 400;
/** The most facts kept (open and closed together); consolidation prunes below it. */
export const MAX_FACTS = 5000;
/** Facts at least this alike (./text.ts similarity) about the same entities are one fact. */
export const DUPLICATE = 0.8;

const Iso = z.string().min(10).max(40);
const Id = z.string().min(1).max(40);

export const EntitySchema = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  kind: z.enum(ENTITY_KINDS),
  aliases: z.array(z.string().min(1).max(120)).max(20),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Entity = z.infer<typeof EntitySchema>;

export const FactSchema = z.object({
  id: Id,
  text: z.string().min(1).max(MAX_FACT_CHARS),
  /** The entities it is about: the first is its subject. */
  entities: z.array(Id).min(1).max(8),
  /** A short relation name ("works_on", "prefers"); "" when the fact has none. */
  predicate: z.string().max(40),
  source: z.enum(SOURCES),
  /** 0 to 1: how sure Ember is (a user's own words are 1). */
  confidence: z.number().min(0).max(1),
  /** When it became true (when Ember learned it, unless told otherwise). */
  validAt: Iso,
  /** When a newer fact replaced it, or null while it holds. */
  invalidAt: Iso.nullable(),
  /** The fact that replaced it. */
  supersededBy: Id.nullable(),
  createdAt: Iso,
  /** The last time recall returned it, and how often it has (or was reinforced). */
  lastUsedAt: Iso.nullable(),
  uses: z.number().int().min(0),
});
export type Fact = z.infer<typeof FactSchema>;

export const MemoryDataSchema = z.object({
  version: z.literal(1),
  entities: z.array(EntitySchema).max(MAX_FACTS * 2),
  facts: z.array(FactSchema).max(MAX_FACTS * 2),
});
export type MemoryData = z.infer<typeof MemoryDataSchema>;

/** An entity named in a new fact: matched to one already known by name or alias, else made. */
export interface EntityRef { name: string; kind?: EntityKind }

export interface NewFact {
  text: string;
  /** What it is about, subject first (1 to 8). */
  about: EntityRef[];
  predicate?: string;
  /**
   * The predicate holds one value at a time ("lives_in", "works_at", "prefers_editor"): a new fact closes the open
   * ones with the same subject and predicate that say something else.
   */
  single?: boolean;
  source: Source;
  confidence?: number;
  /** When it became true, if not now. */
  validAt?: string;
}

export type AddResult =
  | { kind: "added"; fact: Fact; closed: Fact[] }
  | { kind: "reinforced"; fact: Fact }
  | { kind: "refused"; reason: string };

/** What the graph needs from outside: the time and fresh ids (tests pass fixed ones). */
export interface GraphClock { now: () => Date; id: (prefix: "e" | "f") => string }

export const SYSTEM_CLOCK: GraphClock = {
  now: () => new Date(),
  id: prefix => `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
};

/** The trust a source starts with, when the caller gives none. */
const START_CONFIDENCE: Record<Source, number> = { user: 1, conversation: 0.7, task: 0.6, observed: 0.5, connector: 0.6 };

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const predicateOf = (s: string | undefined) => clean(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

export class MemoryGraph {
  private entities = new Map<string, Entity>();
  private facts = new Map<string, Fact>();
  /** nameKey of every name and alias → entity id. */
  private names = new Map<string, string>();

  constructor(data?: MemoryData, private clock: GraphClock = SYSTEM_CLOCK) {
    for (const e of data?.entities ?? []) this.putEntity(e);
    // A fact naming an entity that isn't there (a hand-edited file) is dropped rather than left dangling.
    for (const f of data?.facts ?? []) if (f.entities.every(id => this.entities.has(id))) this.facts.set(f.id, f);
  }

  get size(): { entities: number; facts: number; open: number } {
    let open = 0;
    for (const f of this.facts.values()) if (!f.invalidAt) open++;
    return { entities: this.entities.size, facts: this.facts.size, open };
  }

  toJSON(): MemoryData {
    return { version: 1, entities: [...this.entities.values()], facts: [...this.facts.values()] };
  }

  entity(id: string): Entity | undefined { return this.entities.get(id); }
  fact(id: string): Fact | undefined { return this.facts.get(id); }
  allEntities(): Entity[] { return [...this.entities.values()]; }
  /** Every fact, or only the ones that still hold. */
  allFacts(openOnly = false): Fact[] { return [...this.facts.values()].filter(f => !openOnly || !f.invalidAt); }

  /** The entity known by `name` (or an alias of it), if any. */
  find(name: string): Entity | undefined {
    const id = this.names.get(nameKey(name));
    return id ? this.entities.get(id) : undefined;
  }

  /** The open facts about an entity. */
  factsAbout(entityId: string, openOnly = true): Fact[] {
    return this.allFacts(openOnly).filter(f => f.entities.includes(entityId));
  }

  /** The entity for `ref`: the one known by that name, else a new one. A kind given later fills in a vague one. */
  resolve(ref: EntityRef): Entity {
    const name = clean(ref.name).slice(0, 120);
    const known = this.find(name);
    const now = this.clock.now().toISOString();
    if (known) {
      if (ref.kind && known.kind === "thing" && ref.kind !== "thing") this.putEntity({ ...known, kind: ref.kind, updatedAt: now });
      return this.entities.get(known.id)!;
    }
    const e: Entity = { id: this.clock.id("e"), name, kind: ref.kind ?? "thing", aliases: [], createdAt: now, updatedAt: now };
    this.putEntity(e);
    return e;
  }

  /** Adds `alias` as another name for an entity (refused if another entity already has it). */
  addAlias(entityId: string, alias: string): boolean {
    const e = this.entities.get(entityId);
    const key = nameKey(alias);
    if (!e || !key) return false;
    const owner = this.names.get(key);
    if (owner && owner !== entityId) return false;
    if (!owner) this.putEntity({ ...e, aliases: [...e.aliases, clean(alias).slice(0, 120)].slice(0, 20), updatedAt: this.clock.now().toISOString() });
    return true;
  }

  /**
   * Remembers a fact: refused if it holds a secret, a reinforcement of an open near-duplicate about the same
   * entities, or a new fact that closes the open ones it replaces (`single`).
   */
  add(input: NewFact): AddResult {
    const text = clean(input.text);
    if (!text) return { kind: "refused", reason: "it is empty" };
    if (text.length > MAX_FACT_CHARS) return { kind: "refused", reason: `it is longer than ${MAX_FACT_CHARS} characters` };
    if (!input.about.length || input.about.some(r => !nameKey(r.name))) return { kind: "refused", reason: "it isn't about anything named" };
    const secret = memoryRefusal(text) ?? input.about.map(r => memoryRefusal(r.name)).find(Boolean) ?? null;
    if (secret) return { kind: "refused", reason: secret };
    const now = this.clock.now().toISOString();
    const entities = [...new Set(input.about.slice(0, 8).map(r => this.resolve(r).id))];
    const predicate = predicateOf(input.predicate);
    const confidence = Math.min(1, Math.max(0, input.confidence ?? START_CONFIDENCE[input.source]));

    const same = this.allFacts(true).find(f => sameEntities(f.entities, entities) && similarity(f.text, text) >= DUPLICATE);
    if (same) {
      // Said again: surer (the stronger source wins), and fresh.
      const fact: Fact = { ...same, confidence: Math.max(same.confidence, confidence), uses: same.uses + 1, lastUsedAt: now, source: stronger(same.source, input.source) };
      this.facts.set(fact.id, fact);
      return { kind: "reinforced", fact };
    }

    const fact: Fact = {
      id: this.clock.id("f"), text, entities, predicate, source: input.source, confidence,
      validAt: input.validAt ?? now, invalidAt: null, supersededBy: null, createdAt: now, lastUsedAt: null, uses: 0,
    };
    const closed: Fact[] = [];
    if (input.single && predicate) {
      for (const f of this.allFacts(true)) {
        // A weaker source never overrules what the user said; it is kept beside it until they say otherwise.
        if (f.entities[0] === entities[0] && f.predicate === predicate && rank(input.source) <= rank(f.source)) {
          const c: Fact = { ...f, invalidAt: fact.validAt, supersededBy: fact.id };
          this.facts.set(c.id, c);
          closed.push(c);
        }
      }
    }
    this.facts.set(fact.id, fact);
    return { kind: "added", fact, closed };
  }

  /** Recall returned these facts: they count as used now. */
  touch(ids: string[]): void {
    const now = this.clock.now().toISOString();
    for (const id of ids) {
      const f = this.facts.get(id);
      if (f) this.facts.set(id, { ...f, lastUsedAt: now, uses: f.uses + 1 });
    }
  }

  /** Forgets one fact for good (not closed: gone). True if it was there. */
  forgetFact(id: string): boolean {
    const had = this.facts.delete(id);
    if (had) this.dropOrphans();
    return had;
  }

  /** Forgets an entity and every fact about it. */
  forgetEntity(id: string): number {
    let n = 0;
    for (const f of [...this.facts.values()]) if (f.entities.includes(id)) { this.facts.delete(f.id); n++; }
    this.entities.delete(id);
    this.reindex();
    this.dropOrphans();
    return n;
  }

  /** Forgets everything. */
  clear(): void {
    this.entities.clear();
    this.facts.clear();
    this.names.clear();
  }

  /** Replaces a fact in place (consolidation's merges). */
  replaceFact(f: Fact): void {
    if (this.facts.has(f.id)) this.facts.set(f.id, f);
  }

  /** Folds entity `from` into `into`: its names become aliases, and its facts move over. */
  mergeEntities(into: string, from: string): void {
    const a = this.entities.get(into);
    const b = this.entities.get(from);
    if (!a || !b || into === from) return;
    for (const f of this.facts.values()) {
      if (f.entities.includes(from)) this.facts.set(f.id, { ...f, entities: [...new Set(f.entities.map(id => (id === from ? into : id)))] });
    }
    this.entities.delete(from);
    const aliases = [...new Set([...a.aliases, b.name, ...b.aliases])].filter(n => nameKey(n) !== nameKey(a.name)).slice(0, 20);
    this.entities.set(into, { ...a, kind: a.kind === "thing" ? b.kind : a.kind, aliases, updatedAt: this.clock.now().toISOString() });
    this.reindex();
  }

  /** Entities no fact mentions any more are dropped. */
  dropOrphans(): number {
    const used = new Set<string>();
    for (const f of this.facts.values()) for (const id of f.entities) used.add(id);
    let n = 0;
    for (const id of [...this.entities.keys()]) if (!used.has(id)) { this.entities.delete(id); n++; }
    if (n) this.reindex();
    return n;
  }

  private putEntity(e: Entity): void {
    this.entities.set(e.id, e);
    for (const n of [e.name, ...e.aliases]) {
      const key = nameKey(n);
      if (key && !this.names.has(key)) this.names.set(key, e.id);
    }
  }

  private reindex(): void {
    this.names.clear();
    for (const e of this.entities.values()) this.putEntity(e);
  }
}

const sameEntities = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));
/** 0 is most trusted. */
const rank = (s: Source) => SOURCES.indexOf(s);
const stronger = (a: Source, b: Source): Source => (rank(a) <= rank(b) ? a : b);
