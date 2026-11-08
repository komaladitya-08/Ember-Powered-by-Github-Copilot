/**
 * The ask box's field: one line that grows to four as the user adds lines (Shift+Enter) or pastes several (a traceback,
 * a config file keep their lines), Enter sends, and a count shows near the most that is sent; the box's
 * first few openings on Windows and macOS say to wait for it. Pure and renderer-safe; the page measures and main sizes
 * the window. Its sizes grow with the text size (Settings > Comfort & access), as main grows the window (ask.ts).
 */

/** The field's sizes at the default text size (styles.css) and the most that is sent (main cuts there too). */
export const FIELD = { line: 24, oneLine: 46, maxLines: 4, maxChars: 2000 } as const;

/**
 * The text's scale on the page, from its --text-scale (ember.css: 1, or 1.15 or 1.3 as main sets the text size); the
 * default's 1 from anything that isn't a scale.
 */
export function textScaleOf(value: string): number {
  const n = Number(value.trim() || NaN);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** From how many characters the box counts them (90% of the most that is sent, as Home's composer: home-5). */
export const COUNT_FROM = 1800;
const num = (k: number) => k.toLocaleString("en-GB");
/**
 * The count on its own line under the field once a request nears the most that is sent, and how far over it is
 * (companion-i1): a paste is kept whole, never cut at the limit unseen, and nothing is sent until it fits. "" while
 * well under the limit. Worded as Home's composer is (home/copy.ts composerCount).
 */
export function askCount(n: number): string {
  if (n < COUNT_FROM) return "";
  const over = n - FIELD.maxChars;
  return `${num(n)} of ${num(FIELD.maxChars)} characters${over > 0 ? `, ${num(over)} too many` : ""}.`;
}
/** Said as a request goes over the limit, and when Enter is pressed while it is (companion-i1). */
export const ASK_OVER = `This request is longer than ${num(FIELD.maxChars)} characters. Shorten it to send it.`;

/**
 * The tip the box's first few openings show where Ember can't hold the letters typed while it opens (Windows, macOS):
 * those go to the app the user is in (review #78).
 */
export const WAIT_TIP = "Wait for this box before you type: letters typed sooner go to the app underneath.";

/**
 * The rows the box needs: the field's lines, one each for the cut note and wait tip, and the measured suggestion and
 * Listen once groups, including every wrapped line.
 */
export const boxRows = (lines: number, cut: boolean, tip: boolean, suggestRows = 0, listenRows = 0): number =>
  lines + (cut ? 1 : 0) + (tip ? 1 : 0) + suggestRows + listenRows;

/** A measured auxiliary group plus its 4 px gap, in main's text-scaled rows; hidden groups need none. */
export const auxiliaryRows = (height: number, scale = 1): number =>
  height > 0 ? Math.ceil((height + 4) / (FIELD.line * scale)) : 0;

/**
 * The lines the field shows for text `scrollHeight` px tall, measured at one line's height: 1 to FIELD.maxLines.
 * `scale`: the text's (textScaleOf), by which its lines and padding grow.
 */
export function fieldLines(scrollHeight: number, scale = 1): number {
  const lines = Math.round((scrollHeight - (FIELD.oneLine - FIELD.line) * scale) / (FIELD.line * scale));
  return Math.min(FIELD.maxLines, Math.max(1, Number.isFinite(lines) ? lines : 1));
}

/** The field's height in px for `lines` lines at the text's `scale`. */
export const fieldHeight = (lines: number, scale = 1): number => (FIELD.oneLine + (lines - 1) * FIELD.line) * scale;

/** What Enter does: send, add a line (Shift+Enter), or nothing of Ember's while an input method is composing. */
export function enterAction(e: { shiftKey: boolean; isComposing: boolean }): "send" | "newline" | "compose" {
  if (e.isComposing) return "compose";
  return e.shiftKey ? "newline" : "send";
}

/**
 * Whether ↑ or ↓ goes through earlier questions rather than moving the caret: ↑ only from the first line, ↓ only
 * from the last, and never with text selected.
 */
export function historyKey(value: string, start: number, end: number, key: "ArrowUp" | "ArrowDown"): boolean {
  if (start !== end) return false;
  return key === "ArrowUp" ? !value.slice(0, start).includes("\n") : !value.slice(end).includes("\n");
}

/** The request is longer than is sent: it isn't sent until it is shortened (companion-i1). */
export const overLimit = (value: string): boolean => value.length > FIELD.maxChars;

/** The send key as the keyboard names it: Return on a Mac, Enter elsewhere (`os` from main, in the page's address). */
export const sendKey = (os: string | null): string => (os === "darwin" ? "Return" : "Enter");
