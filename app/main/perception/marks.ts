/** Set-of-marks: numbered boxes over interactive elements, drawn as SVG on the screenshot (never on secret fields, which are blacked out). */

import type { AxNode, Bounds } from "./sidecar";
import { isSheetCell } from "./elements";

const MARKABLE = new Set(["push button", "toggle button", "check box", "radio button", "combo box", "text", "entry",
  "spin button", "slider", "menu item", "menu", "link", "page tab", "list item", "check menu item", "radio menu item",
  "tree item", "icon", "table cell"]);

/** The marks' font: capture.ts warmText draws with it too, so fontconfig has settled it before the first marks. */
export const MARK_FONT = "DejaVu Sans, sans-serif";

const esc = (s: string) => s.replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

/** Less of an element than this (px across) showing is a sliver: no mark (it would sit on whatever lies beside it). */
export const SLIVER_PX = 8;

export function marksSvg(nodes: AxNode[], origin: Bounds, scale: number, width: number, height: number): string {
  const parts: string[] = [];
  for (const n of nodes) {
    // A spreadsheet's cells go unmarked: hundreds of marks would hide what they hold, and their addresses name them.
    if (!n.bounds || !MARKABLE.has(n.role) || n.role === "password text" || n.secret || isSheetCell(n)) continue;
    // Partly scrolled out of its list: the box goes round the part that shows, and a sliver gets none.
    const b = n.shown ?? n.bounds;
    if (n.shown && (b.width < Math.min(SLIVER_PX, n.bounds.width) || b.height < Math.min(SLIVER_PX, n.bounds.height))) continue;
    const x = (b.x - origin.x) * scale, y = (b.y - origin.y) * scale;
    const w = b.width * scale, h = b.height * scale;
    if (x + w < 0 || y + h < 0 || x > width || y > height) continue;
    const label = String(n.id);
    const tw = 7 * label.length + 6;
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="#ff7a1a" stroke-width="2"/>`,
      `<rect x="${x.toFixed(1)}" y="${Math.max(0, y - 14).toFixed(1)}" width="${tw}" height="14" fill="#ff7a1a"/>`,
      `<text x="${(x + 3).toFixed(1)}" y="${(Math.max(0, y - 14) + 11).toFixed(1)}" font-family="${MARK_FONT}" font-size="11" font-weight="700" fill="#1a0f0b">${esc(label)}</text>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
}
