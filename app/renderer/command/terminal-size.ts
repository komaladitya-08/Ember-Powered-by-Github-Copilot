/**
 * The arithmetic of a run's terminal's size in the command window, in a pure module so renderer-command.test.ts can
 * check it against what the built page measures, without a DOM: the room the parts round the terminal take at each
 * text size, how many columns and rows fit what is left, and where xterm's hidden input belongs when the type's size
 * changes.
 */

import { textScaleOf } from "./terminal-options";

/** The window's height taken by everything round a run's terminal at the default text size: padding, tabs, header, command, hint, status. */
const TERM_CHROME_PX = 250;
/**
 * The part of it that is words and buttons, which grow with the text size (the paddings and gaps don't). Measured on
 * the built page: 203, 219 and 234 px of parts round the terminal at Default, Large and Larger.
 */
const TERM_CHROME_TEXT_PX = 105;

/**
 * The height, in CSS px, left out of the window for the parts round a run's terminal at a text scale: 250, 266 and
 * 282 px at Default, Large and Larger. A scale that isn't one from 1 to 2 is the default's.
 */
export function termChromePx(scale: number): number {
  return TERM_CHROME_PX + Math.round(TERM_CHROME_TEXT_PX * (textScaleOf(String(scale)) - 1));
}

/**
 * The page's text scale changed from `prev` to `next` (main sets html[data-text-size] as the page loads and on every
 * settings change, whatever changed): every run's terminal, shown or not, draws its type at it, then `report` tells main
 * the size new runs start at, measured at it. The same scale again does nothing. A scale that isn't one from 1 to 2 is
 * the default's. Returns the scale the page now has.
 */
export function applyTextScale(prev: number, next: number, terms: Iterable<{ setTextScale(scale: number): void }>, report: (scale: number) => void): number {
  const scale = textScaleOf(String(next));
  if (scale === prev) return prev;
  for (const t of terms) t.setTextScale(scale);
  report(scale);
  return scale;
}

/**
 * How many columns and rows fit a run's terminal in a window `width` × `height` CSS px with nothing above it but the
 * tab's own parts (what new runs start at: a card shown for the moment doesn't make them smaller). A column and a few
 * pixels are left over so the last column and row are never cut.
 */
export function fitTerminal(cell: { width: number; height: number }, width: number, height: number): { cols: number; rows: number } {
  const cols = Math.floor((width - 16) / cell.width) - 1;
  const rows = Math.floor((height - 8) / cell.height);
  return { cols: Math.max(20, Math.min(500, cols)), rows: Math.max(5, Math.min(200, rows)) };
}

/** xterm's hidden input's place and size, as its inline style holds them ("920.8px", or "" before xterm places it). */
export interface InputBox {
  left: string;
  top: string;
  width: string;
  height: string;
  lineHeight: string;
}

/** Each length unset: xterm's own place for the input, off the grid to the left and no size (its stylesheet's). */
const UNPLACED: InputBox = Object.freeze({ left: "", top: "", width: "", height: "", lineHeight: "" });

/**
 * Where xterm's hidden input goes when the type's size changes, from the grid xterm drew before (`from`, CSS px) and
 * after (`to`). xterm puts the input on the cursor's cell, but only when the cursor moves: after a smaller type it stays
 * at the old cell's px, past the grid, and the terminal's box scrolls into empty space (for good, once the run has
 * finished). The same cell at the new size is its lengths across scaled as the grid's width and those down as its
 * height (xterm's cell is its grid over its columns and rows, and the run's columns and rows stay, §3.10). A length
 * xterm hasn't set stays unset; a grid that can't be read puts the input back in xterm's own place off the grid.
 */
export function inputAtGrid(box: Readonly<InputBox>, from: { width: number; height: number }, to: { width: number; height: number }): InputBox {
  const ok = (n: number) => Number.isFinite(n) && n > 0;
  if (![from.width, from.height, to.width, to.height].every(ok)) return { ...UNPLACED };
  const sx = to.width / from.width, sy = to.height / from.height;
  const scaled = (v: string, by: number): string => {
    const n = Number.parseFloat(v);
    return /px$/.test(v.trim()) && Number.isFinite(n) ? `${n * by}px` : "";
  };
  return {
    left: scaled(box.left, sx),
    width: scaled(box.width, sx),
    top: scaled(box.top, sy),
    height: scaled(box.height, sy),
    lineHeight: scaled(box.lineHeight, sy),
  };
}
