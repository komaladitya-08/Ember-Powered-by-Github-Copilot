/**
 * What a Forget means for the conversation it was made in (memory-r9-1). The conversation still holds what the user had
 * Ember forget or correct: their own statement, earlier `<memory>` blocks, Ember's answers. So until it ends:
 * - nothing much like what went is kept again but in the user's own words (`heldBack`): never from Ember's own later
 *   reply, a task it started or its remember tool, however long after the Forget; and a turn teaches only what rests
 *   on what the user said in it, so what they state themselves is still learned (memory-x9-3);
 * - the conversation is told what went, by id and only for facts it was given (`changes`, ./format.ts `memoryChanged`):
 *   a forgotten fact's words are never sent again. For a fact Ember learned by reading it, which has no id there, it is
 *   told only that something of that kind went (memory-x9-7).
 *
 * It only ever makes memory keep less. In RAM only: the words that went are never written, and go when the
 * conversation does (`ended`). Pure: MemoryLearning (./learning.ts) says when.
 */

import { memoryChanged, memoryIds } from "./format";
import type { Source } from "./graph";
import { ownEvidence } from "./learn";
import { ownWords } from "./service";
import { negated, termSimilarity, terms } from "./text";

/**
 * At least this much of the smaller one's words in common makes a fact much like one the user had Ember forget:
 * "Follows a vegetarian diet" beside "Is vegetarian", "Is employed by Globex" beside "Works at Globex".
 */
export const LIKE_FORGOTTEN = 0.5;
/** The most forgotten facts held apart; with more, everything is held back as after Forget everything. */
export const HELD_MAX = 50;
/** What the remember tool is told for a fact much like one forgotten in this conversation that isn't in the user's own words. */
export const HELD_FORGOTTEN = "Not remembered: the user had Ember forget this earlier in this conversation. Keep it again only when they say it again themselves, in their own words.";
/** And for one that says what a fact said before the user corrected it. */
export const HELD_CORRECTED = "Not remembered: the user corrected this in Settings earlier in this conversation, and this says what it said before. Keep it again only when they say it themselves, in their own words.";
/** And, after Forget everything, for any fact that isn't. */
export const HELD_ALL = "Not remembered: the user had Ember forget everything earlier in this conversation, so until a new conversation only what they say themselves is kept. If they said this in this request, save it in their own words.";

/**
 * At least this much of a fact's words in the user's own words it rests on makes them say it: "Lives in Leeds" on
 * "I've just moved to Leeds for the new job", never "Does not eat meat" on "Suggest something for dinner".
 */
export const RESTS_ON = 0.5;

/**
 * Where a fact comes from: a turn (the user's own words in it, "" when Ember couldn't tell they were theirs, and the
 * words of the turn the fact rests on, as the model quoted them), a task's result, or the remember tool.
 */
export type HeldFrom = { said: string; evidence?: string } | "task" | "tool";

/**
 * Whether a fact from a turn rests on what the user said in it (memory-x9-3): it is mostly their own words
 * (`ownWords`), or the words it rests on are theirs word for word and hold half of it or more (RESTS_ON), however the
 * model worded it ("Has a peanut allergy" on "I'm allergic to peanuts by the way"). Never what rests on Ember's
 * reply, which may say what went in words that share none with it, nor on words of the user's that don't say it.
 */
function restsOnUser(text: string, from: { said: string; evidence?: string }): boolean {
  if (ownWords(text, from.said)) return true;
  if (!from.evidence || !ownEvidence(from.evidence, from.said)) return false;
  return share(new Set(terms(text)), new Set(terms(from.evidence))) >= RESTS_ON;
}

/**
 * The same, of what the user states as true now (memory-x9-2): after Forget everything a question that names a fact
 * ("Did I tell you I was vegetarian?") is not the user saying it, so only evidence that is their own statement counts.
 */
function statedByUser(text: string, from: { said: string; evidence?: string }): boolean {
  if (!from.evidence || ownEvidence(from.evidence, from.said) !== "stated") return false;
  return share(new Set(terms(text)), new Set(terms(from.evidence))) >= RESTS_ON;
}

/** Whether two wordings are much alike (LIKE_FORGOTTEN of the smaller one's terms). */
const like = (a: ReadonlySet<string>, b: ReadonlySet<string>) => Math.max(share(a, b), share(b, a)) >= LIKE_FORGOTTEN;
/** The terms of `a` that `b` has too, each once, in the order `a` says them. */
const sharedInOrder = (a: readonly string[], b: ReadonlySet<string>) => [...new Set(a)].filter(t => b.has(t)).join(" ");

/**
 * Whether `text` says what a corrected fact said before rather than what it says now (memory-x9-2). Much like the old
 * wording, and:
 * - where the correction turned it round ("Is vegetarian" → "Is not vegetarian"), said the old way round;
 * - else nearer the old wording than the new ("Has two kids" once "two children" became "three children");
 * - or, with the same words in both ("Prefers tea to coffee" → "Prefers coffee to tea"), in the old order.
 */
function saysBefore(text: string, before: string, after: string): boolean {
  const [c, b, a] = [terms(text), terms(before), terms(after)];
  const [C, B, A] = [new Set(c), new Set(b), new Set(a)];
  if (!like(B, C)) return false;
  if (negated(before) !== negated(after)) return negated(text) === negated(before);
  const [nearBefore, nearAfter] = [termSimilarity(C, B), termSimilarity(C, A)];
  if (nearBefore !== nearAfter) return nearBefore > nearAfter;
  return sharedInOrder(c, B) === sharedInOrder(b, C) && sharedInOrder(c, A) !== sharedInOrder(a, C);
}

const share = (a: ReadonlySet<string>, b: ReadonlySet<string>) => (a.size ? [...a].filter(t => b.has(t)).length / a.size : 0);
/** What the conversation is still to be told. `heard`, `heardBack`: ids too, but only whether there are any is ever said. */
const nothing = () => ({ forgot: [] as string[], corrected: [] as string[], back: [] as string[], all: false, heard: [] as string[], heardBack: [] as string[] });

export class ConversationHold {
  /**
   * The words that went, as terms, with the fact's id and its Undo. A correction's: the words its new wording dropped,
   * and both wordings whole (`was`), since one that negates or swaps drops none (memory-x9-2).
   */
  private held: { words: ReadonlySet<string>; id: string; undo?: string; was?: { before: string; after: string } }[] = [];
  /** Forget everything in this conversation, or more Forgets than `held` keeps. */
  private heldAll = false;
  /** Something was asked in this conversation: it may hold what a Forget everything forgets. */
  private talked = false;
  /** The ids of the facts this conversation was given (`<memory>`, recall, remember's answers). */
  private given = new Set<string>();
  /** What the conversation hasn't been told yet. */
  private tell = nothing();
  /** `tell` went with a request's `<memory>`: once a turn begins, it has been said. */
  private telling = false;
  /** The ids the conversation was told were forgotten: an Undo is told too. */
  private toldForgot = new Set<string>();
  /**
   * The facts Ember learned by reading this conversation (its "Ember learned" lines): the conversation holds what the
   * user said, but was never given them by id (memory-x9-7). And those it was told, without one, that Ember forgot.
   */
  private learned = new Set<string>();
  private toldHeard = new Set<string>();

  /** A request was asked in this conversation. */
  asked(): void { this.talked = true; }

  /** A `<memory>` block went to the conversation: the facts it was given. The block, as it was. */
  gave(block: string): string {
    for (const id of memoryIds(block)) this.given.add(id);
    return block;
  }

  /** The remember tool told the conversation it kept (or had) the fact `id`. */
  gaveId(id: string): void { this.given.add(id); }

  /** Ember learned the fact `id` by reading a turn or a task's result of this conversation. */
  learnedHere(id: string): void { this.learned.add(id); }

  /** Ember's note of what the conversation hasn't been told yet, to go with a request; "" with nothing to say. */
  changes(): string {
    const note = memoryChanged({ ...this.tell, heard: this.tell.heard.length > 0, heardBack: this.tell.heardBack.length > 0 });
    if (note) this.telling = true;
    return note;
  }

  /** A turn began: a request that carried the note has reached the conversation. */
  began(): void {
    if (!this.telling) return;
    for (const id of this.tell.forgot) this.toldForgot.add(id);
    for (const id of this.tell.back) this.toldForgot.delete(id);
    for (const id of this.tell.heard) this.toldHeard.add(id);
    for (const id of this.tell.heardBack) this.toldHeard.delete(id);
    this.tell = nothing();
    this.telling = false;
  }

  /** The conversation ended: the next one holds nothing of what was forgotten in this one. */
  ended(): void {
    this.held = [];
    this.heldAll = false;
    this.talked = false;
    this.given.clear();
    this.toldForgot.clear();
    this.learned.clear();
    this.toldHeard.clear();
    this.tell = nothing();
    this.telling = false;
  }

  /** Fact `id` was forgotten (its words `text`; `undo`: the token that puts it back). */
  forgot(id: string, text: string, undo: string): void {
    this.hold(terms(text), id, "forgot", undo);
  }

  /** The conversation forgot fact `id` itself (forget_memory), and knows: it is told nothing more. */
  forgotByTool(id: string): void {
    this.tell.forgot = this.tell.forgot.filter(x => x !== id);
    this.tell.heard = this.tell.heard.filter(x => x !== id);
  }

  /** Fact `id` was corrected from `before` to `after`: what it said before is held, whole, and the words the new wording dropped. */
  corrected(id: string, before: string, after: string): void {
    const kept = new Set(terms(after));
    this.hold(terms(before).filter(t => !kept.has(t)), id, "corrected", undefined, { before, after });
  }

  /**
   * Everything was forgotten. A conversation under way still holds it: until it ends only the user's own words are
   * kept, and it is told. At sign-out and an account change the conversation went first, and nothing is held.
   */
  forgotAll(): void {
    this.held = [];
    this.given.clear();
    this.toldForgot.clear();
    this.learned.clear();
    this.toldHeard.clear();
    this.heldAll = this.talked;
    this.tell = { ...nothing(), all: this.talked };
    this.telling = false;
  }

  /** The Undo `token` put its fact back: nothing is held for it, and a conversation told it went is told it is back. */
  restored(token: string): void {
    for (const h of this.held.filter(x => x.undo === token)) {
      // Told, or to be told, without an id (a fact it only heard: memory-x9-7), or by id.
      const heard = this.tell.heard.includes(h.id) || this.toldHeard.has(h.id);
      const pending = this.tell.forgot.includes(h.id) || this.tell.heard.includes(h.id);
      this.tell.forgot = this.tell.forgot.filter(x => x !== h.id);
      this.tell.heard = this.tell.heard.filter(x => x !== h.id);
      // Never said (or maybe on its way): only a conversation that was or may have been told hears of the Undo.
      if ((pending && this.telling) || this.toldForgot.has(h.id) || this.toldHeard.has(h.id)) {
        if (heard) this.tell.heardBack = [...this.tell.heardBack.filter(x => x !== h.id), h.id];
        else this.tell.back = [...this.tell.back.filter(x => x !== h.id), h.id];
        this.telling = false;
      }
    }
    this.held = this.held.filter(h => h.undo !== token);
  }

  private hold(gone: Iterable<string>, id: string, how: "forgot" | "corrected", undo?: string, was?: { before: string; after: string }): void {
    const words = new Set(gone);
    if (this.held.length >= HELD_MAX) this.heldAll = true;
    else this.held = [...this.held, { words, id, ...(undo ? { undo } : {}), ...(was ? { was } : {}) }];
    if (!this.given.has(id)) {
      // Learned by reading this conversation, which holds what the user said but no id for it: told without one, and
      // without the fact's words (memory-x9-7).
      if (how === "forgot" && this.learned.has(id)) {
        this.tell.heardBack = this.tell.heardBack.filter(x => x !== id);
        if (!this.tell.heard.includes(id)) this.tell.heard = [...this.tell.heard, id];
        this.telling = false;
      }
      return;
    }
    this.tell.back = this.tell.back.filter(x => x !== id);
    if (!this.tell[how].includes(id)) this.tell[how] = [...this.tell[how], id];
    // Told again with the next request, whole: one that carried only part of it may be on its way.
    this.telling = false;
  }

  /**
   * Whether a fact is held back, and why: `all` after Forget everything, `like` for what the user had Ember forget,
   * `corrected` for what a fact said before they corrected it. Never the user's own (`user`: their words, stated as
   * true now; the caller never calls a question's words that). Otherwise:
   * - anything much like what went (LIKE_FORGOTTEN), or that says what a corrected fact said before (`saysBefore`),
   *   from a turn, a task or the remember tool;
   * - from a turn, anything that doesn't rest on what the user said in it (`restsOnUser`): Ember's reply may say what
   *   went in words that share none with it ("You don't eat meat" for "Is vegetarian"). What the user states is still
   *   learned, however the model words it (memory-x9-3);
   * - after Forget everything, anything from a task or the remember tool, and from a turn anything but what the user
   *   states in it (`statedByUser`: never a question that names the fact, memory-x9-2).
   * The remember tool is otherwise refused only what is like it, so "remember…" still keeps what the model words freely.
   */
  heldBack(text: string, source: Source, from: HeldFrom): "all" | "like" | "corrected" | null {
    if (source === "user" || (!this.heldAll && !this.held.length)) return null;
    const turn = typeof from === "object" ? from : null;
    if (this.heldAll && !(turn && statedByUser(text, turn))) return "all";
    const words = new Set(terms(text));
    for (const h of this.held) {
      if (h.was && saysBefore(text, h.was.before, h.was.after)) return "corrected";
      if (like(h.words, words)) return h.was ? "corrected" : "like";
    }
    return turn && !restsOnUser(text, turn) ? "like" : null;
  }
}
