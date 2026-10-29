/**
 * The ask box's field: one line that grows to four as the user adds lines (Shift+Enter) or pastes several (a traceback,
 * a config file keep their lines), Enter sends, and a note says when the text reached the most that is sent. Pure and
 * renderer-safe; the page measures and main sizes the window.
 */

/** The field's sizes (styles.css) and the most that is sent (main cuts there too). */
export const FIELD = { line: 24, oneLine: 46, maxLines: 4, maxChars: 2000 } as const;

/** The note shown while the field holds as much as is sent (a longer paste was cut). */
export const CUT_NOTE = `Only the first ${FIELD.maxChars} characters will be sent.`;

/** The lines the field shows for text `scrollHeight` px tall, measured at one line's height: 1 to FIELD.maxLines. */
export function fieldLines(scrollHeight: number): number {
  const lines = Math.round((scrollHeight - (FIELD.oneLine - FIELD.line)) / FIELD.line);
  return Math.min(FIELD.maxLines, Math.max(1, Number.isFinite(lines) ? lines : 1));
}

/** The field's height in px for `lines` lines. */
export const fieldHeight = (lines: number): number => FIELD.oneLine + (lines - 1) * FIELD.line;

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

/** The field holds as much as is sent: anything typed or pasted beyond it was left out, so the note shows. */
export const atLimit = (value: string): boolean => value.length >= FIELD.maxChars;

/** The send key as the keyboard names it: Return on a Mac, Enter elsewhere (`os` from main, in the page's address). */
export const sendKey = (os: string | null): string => (os === "darwin" ? "Return" : "Enter");
