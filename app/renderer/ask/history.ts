/**
 * The ask box's earlier questions, gone through with ↑ and ↓, and the text being typed, kept while the user looks back.
 * Each opening of the box starts again at the newest; the update that follows once Ember's quick look is done (what
 * Ember will see) keeps the user's place and their half-typed text. Pure and renderer-safe.
 */

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export class AskHistory {
  private list: string[] = [];
  /** Where the user is in the list; list.length is the new, unsent text. */
  private at = 0;
  /** What was typed before going back through the list. */
  private draft = "";

  /**
   * What main sent: `opened` when the box has just opened (back to the newest, nothing kept), else a later update of
   * the same opening, which keeps the place and the draft (a list that changed all the same starts again).
   */
  context(history: readonly string[], opened: boolean): void {
    if (!opened && same(history, this.list)) return;
    this.list = [...history];
    this.at = this.list.length;
    this.draft = "";
  }

  /** Earlier questions there are. */
  get size(): number {
    return this.list.length;
  }

  /** ↑ (-1) or ↓ (+1) from `value`, what the field holds now: the text to show instead, or null with no history. */
  step(dir: -1 | 1, value: string): string | null {
    if (!this.list.length) return null;
    if (this.at === this.list.length) this.draft = value;
    this.at = Math.min(this.list.length, Math.max(0, this.at + dir));
    return this.at === this.list.length ? this.draft : this.list[this.at];
  }
}
