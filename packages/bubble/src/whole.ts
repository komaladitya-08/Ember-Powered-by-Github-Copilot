/**
 * The whole text under a question (review #116): what a page decides about the block that shows all of a typed text the
 * question's sentence cuts to its two ends. Pure, so the bubble and the corner card (no compositor) judge it the same
 * way and the tests hold them to it. Allow works only once every line of the block has been in view: it fits, or it was
 * scrolled to its end, in the page's final layout (its typeface loaded) and on screen. Each press of the approve key
 * before then scrolls it on by a page. Renderer-safe: no DOM here.
 */

/** Above a question's buttons while its whole text hasn't all been in view (the consent cards say it so: CONSENT_READ_HINT). */
export const WHOLE_READ_HINT = "Scroll down to read it all first.";
/** Before the whole text, for screen readers (they hear it all; the block is for the eye). */
export const WHOLE_LABEL = "The whole text";
/** One CSS pixel of slack for sub-pixel layout. */
const SLACK = 1;

/** A question's whole text as main sends it (BubbleState.whole). */
export interface WholeState { n: number; text: string; seen: boolean; page: number }

/** What the page knows about the block it shows: the question's, whether all of it has been in view, the pages scrolled on. */
export interface WholeView { n: number; text: string; seen: boolean; paged: number }

/** The block's own scroll numbers and where it is (CSS px, the viewport's). */
export interface WholeMetrics {
  scrollTop: number; scrollHeight: number; clientHeight: number;
  /** The block's box in the viewport, and the viewport's size. */
  top: number; bottom: number; viewportHeight: number;
}

/**
 * The view after main sends `next` (null: no whole text). `fresh`: another question's text (or a new one), which shows
 * from its start and hasn't been in view; `pages`: how many pages to scroll on now (the approve key's presses since the
 * last state, never those of an earlier question). Once in view stays in view for the same question, and main's word
 * that it was counts too (another display's bubble saw it).
 */
export function wholeNext(prev: WholeView | null, next: WholeState | null): { view: WholeView | null; fresh: boolean; pages: number } {
  if (!next || typeof next.text !== "string" || !next.text) return { view: null, fresh: false, pages: 0 };
  const page = Number.isInteger(next.page) && next.page > 0 ? next.page : 0;
  if (!prev || prev.n !== next.n || prev.text !== next.text) {
    return { view: { n: next.n, text: next.text, seen: next.seen === true, paged: page }, fresh: true, pages: 0 };
  }
  return { view: { ...prev, seen: prev.seen || next.seen === true, paged: Math.max(prev.paged, page) }, fresh: false, pages: Math.max(0, page - prev.paged) };
}

/**
 * Every line of the block is in view now: it is on screen, laid out in its final typeface, and it fits or is scrolled
 * to its end. An empty or unmeasurable block, one hidden, or one running off the screen isn't.
 */
export function wholeInView(m: WholeMetrics, o: { shown: boolean; fontsLoaded: boolean }): boolean {
  if (!o.shown || !o.fontsLoaded) return false;
  const nums = [m.scrollTop, m.scrollHeight, m.clientHeight, m.top, m.bottom, m.viewportHeight];
  if (!nums.every(Number.isFinite) || m.clientHeight <= 0 || m.scrollHeight <= 0) return false;
  const onScreen = m.top >= -SLACK && m.bottom <= m.viewportHeight + SLACK;
  return onScreen && m.scrollTop + m.clientHeight >= m.scrollHeight - SLACK;
}

/** The view once the block was measured (`inView`: wholeInView): seen for good once it was; `report` the first time. */
export function wholeJudged(v: WholeView, inView: boolean): { view: WholeView; report: boolean } {
  if (v.seen || !inView) return { view: v, report: false };
  return { view: { ...v, seen: true }, report: true };
}

/** Main still has to be told it was seen (it was, here, and main's state doesn't say so yet). */
export const wholeUnreported = (v: WholeView | null, next: WholeState | null): boolean => !!v && v.seen && !!next && next.n === v.n && next.seen !== true;

/** How far one press of the approve key scrolls the block: a page, less a line, so the reader keeps their place. */
export function wholePage(clientHeight: number, lineHeight: number): number {
  const line = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 20;
  return Math.max(line, (Number.isFinite(clientHeight) ? clientHeight : 0) - line);
}
