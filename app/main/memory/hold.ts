/**
 * What a Forget means for the conversation it was made in (memory-r9-1). The conversation still holds what the user had
 * Ember forget or correct: their own statement, earlier `<memory>` blocks, Ember's answers. So until it ends:
 * - nothing much like what went is kept again but in the user's own words (`heldBack`): never from Ember's own later
 *   reply, a task it started or its remember tool, however long after the Forget; and a turn teaches only what rests
 *   on what the user said in it, so what they state themselves is still learned (memory-x9-3);
 * - the conversation is told what went, by id and only for facts it was given (`changes`, ./format.ts `memoryChanged`):
 *   a forgotten fact's words are never sent again.
 *
 * It only ever makes memory keep less. In RAM only: the words that went are never written, and go when the
 * conversation does (`ended`). Pure: MemoryLearning (./learning.ts) says when.
 */

import { memoryChanged, memoryIds } from "./format";
import type { Source } from "./graph";
import { ownEvidence } from "./learn";
import { ownWords } from "./service";
import { terms } from "./text";

/**
 * At least this much of the smaller one's words in common makes a fact much like one the user had Ember forget:
 * "Follows a vegetarian diet" beside "Is vegetarian", "Is employed by Globex" beside "Works at Globex".
 */
export const LIKE_FORGOTTEN = 0.5;
/** The most forgotten facts held apart; with more, everything is held back as after Forget everything. */
export const HELD_MAX = 50;
/** What the remember tool is told for a fact much like one forgotten in this conversation that isn't in the user's own words. */
export const HELD_FORGOTTEN = "Not remembered: the user had Ember forget this earlier in this conversation. Keep it again only when they say it again themselves, in their own words.";
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

const share = (a: ReadonlySet<string>, b: ReadonlySet<string>) => (a.size ? [...a].filter(t => b.has(t)).length / a.size : 0);
const nothing = () => ({ forgot: [] as string[], corrected: [] as string[], back: [] as string[], all: false });

export class ConversationHold {
  /** The words that went (a correction's: those its new wording dropped), as terms, with the fact's id and its Undo. */
  private held: { words: ReadonlySet<string>; id: string; undo?: string }[] = [];
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

  /** A request was asked in this conversation. */
  asked(): void { this.talked = true; }

  /** A `<memory>` block went to the conversation: the facts it was given. The block, as it was. */
  gave(block: string): string {
    for (const id of memoryIds(block)) this.given.add(id);
    return block;
  }

  /** The remember tool told the conversation it kept (or had) the fact `id`. */
  gaveId(id: string): void { this.given.add(id); }

  /** Ember's note of what the conversation hasn't been told yet, to go with a request; "" with nothing to say. */
  changes(): string {
    const note = memoryChanged(this.tell);
    if (note) this.telling = true;
    return note;
  }

  /** A turn began: a request that carried the note has reached the conversation. */
  began(): void {
    if (!this.telling) return;
    for (const id of this.tell.forgot) this.toldForgot.add(id);
    for (const id of this.tell.back) this.toldForgot.delete(id);
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
  }

  /** Fact `id` was corrected from `before` to `after`: the words the new wording dropped are held. */
  corrected(id: string, before: string, after: string): void {
    const kept = new Set(terms(after));
    this.hold(terms(before).filter(t => !kept.has(t)), id, "corrected");
  }

  /**
   * Everything was forgotten. A conversation under way still holds it: until it ends only the user's own words are
   * kept, and it is told. At sign-out and an account change the conversation went first, and nothing is held.
   */
  forgotAll(): void {
    this.held = [];
    this.given.clear();
    this.toldForgot.clear();
    this.heldAll = this.talked;
    this.tell = { ...nothing(), all: this.talked };
    this.telling = false;
  }

  /** The Undo `token` put its fact back: nothing is held for it, and a conversation told it went is told it is back. */
  restored(token: string): void {
    for (const h of this.held.filter(x => x.undo === token)) {
      const pending = this.tell.forgot.includes(h.id);
      this.tell.forgot = this.tell.forgot.filter(x => x !== h.id);
      // Never said (or maybe on its way): only a conversation that was or may have been told hears of the Undo.
      if ((pending && this.telling) || this.toldForgot.has(h.id)) {
        this.tell.back = [...this.tell.back.filter(x => x !== h.id), h.id];
        this.telling = false;
      }
    }
    this.held = this.held.filter(h => h.undo !== token);
  }

  private hold(gone: Iterable<string>, id: string, how: "forgot" | "corrected", undo?: string): void {
    const words = new Set(gone);
    if (words.size || how === "forgot") {
      if (this.held.length >= HELD_MAX) this.heldAll = true;
      else this.held = [...this.held, { words, id, ...(undo ? { undo } : {}) }];
    }
    if (!this.given.has(id)) return;
    this.tell.back = this.tell.back.filter(x => x !== id);
    if (!this.tell[how].includes(id)) this.tell[how] = [...this.tell[how], id];
    // Told again with the next request, whole: one that carried only part of it may be on its way.
    this.telling = false;
  }

  /**
   * Whether a fact is held back, and why: `all` after Forget everything, `like` for what the user had Ember forget or
   * correct in this conversation. Never the user's own (`user`: their words, stated as true now). Otherwise:
   * - anything much like what went (LIKE_FORGOTTEN), from a turn, a task or the remember tool;
   * - from a turn, anything that doesn't rest on what the user said in it (`restsOnUser`): Ember's reply may say what
   *   went in words that share none with it ("You don't eat meat" for "Is vegetarian"). What the user states is still
   *   learned, however the model words it (memory-x9-3);
   * - after Forget everything, anything from a task or the remember tool, and from a turn as above.
   * The remember tool is otherwise refused only what is like it, so "remember…" still keeps what the model words freely.
   */
  heldBack(text: string, source: Source, from: HeldFrom): "all" | "like" | null {
    if (source === "user" || (!this.heldAll && !this.held.length)) return null;
    const theirs = typeof from === "object" && restsOnUser(text, from);
    if (this.heldAll && !theirs) return "all";
    const words = new Set(terms(text));
    if (this.held.some(h => Math.max(share(h.words, words), share(words, h.words)) >= LIKE_FORGOTTEN)) return "like";
    return typeof from === "object" && !theirs ? "like" : null;
  }
}
