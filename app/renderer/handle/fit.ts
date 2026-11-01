/**
 * The corner card's height, and whether its words have the room a question's whole text needs to count as seen (review
 * #116): pure, so the tests hold the page to it. The card asks main for the height its content needs as if nothing were
 * squeezed (main keeps it within its limits): the words' rows at their own heights (the words and a whole text's block
 * at all of theirs, the block up to its own most), the face's row never shorter than the face, then the question's
 * buttons and the task row with the gaps under them. Renderer-safe: no DOM here.
 */

/** A row as measured: its height when nothing squeezes it, and its margins. */
export interface CardRow { natural: number; marginTop: number; marginBottom: number }

export interface CardMeasure {
  /** The top row (the face and the words): its padding above and below, its least height, the face's height. */
  top: { padTop: number; padBottom: number; min: number; face: number };
  /** The words' column: its padding at the top, the gap between its rows, and its shown rows. */
  text: { padTop: number; gap: number; rows: readonly CardRow[] };
  /** The shown rows under the top row (the question's buttons, the task row). */
  below: readonly CardRow[];
}

const size = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);
const outer = (r: CardRow): number => size(r.natural) + size(r.marginTop) + size(r.marginBottom);

/** The height (CSS px) the card needs to show all it holds without squeezing any of it. */
export function cardNeed(m: CardMeasure): number {
  const rows = m.text.rows;
  const words = size(m.text.padTop) + rows.reduce((sum, r) => sum + outer(r), 0) + size(m.text.gap) * Math.max(0, rows.length - 1);
  const top = Math.max(size(m.top.min), size(m.top.padTop) + Math.max(words, size(m.top.face)) + size(m.top.padBottom));
  return Math.ceil(top + m.below.reduce((sum, r) => sum + outer(r), 0));
}

/** The card's words as laid out now (CSS px, the viewport's). */
export interface CardRoom {
  /** The question's sentence: the height of it in view, all of its height, its line height. */
  sentence: { clientHeight: number; scrollHeight: number; lineHeight: number };
  /** Where the words' rows may end (the top row's content box, above the buttons), and where each shown one ends. */
  wordsEnd: number;
  rowsEnd: readonly number[];
}

/**
 * The words have room: the question's sentence shows at least two lines (all of it, when it is shorter), and every row
 * of words ends inside its space, so nothing runs into (or is cut off above) the buttons. Until then a whole text's
 * block doesn't count as seen, even at its end: Allow would go through without the sentence that says what is typed
 * where. Unmeasurable numbers don't count as room.
 */
export function cardClear(r: CardRoom): boolean {
  const { clientHeight, scrollHeight, lineHeight } = r.sentence;
  if (![clientHeight, scrollHeight, r.wordsEnd].every(Number.isFinite)) return false;
  const line = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 20;
  if (clientHeight < Math.min(scrollHeight, 2 * line) - 1) return false;
  return r.rowsEnd.every(end => Number.isFinite(end) && end <= r.wordsEnd + 1);
}

/** How many lines a row keeps however little room is left: `most`, or all of its lines when it has fewer. */
export function linesKept(contentHeight: number, lineHeight: number, most: number): number {
  if (!(most > 0) || !Number.isFinite(contentHeight) || contentHeight <= 0) return 0;
  const line = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 20;
  return Math.min(most, Math.ceil(contentHeight / line - 0.05));
}
