/** Set-of-marks: numbered boxes over interactive elements, drawn as SVG on the screenshot (never on secret fields, which are blacked out). */

import type { AxNode, Bounds } from "./sidecar";

const MARKABLE = new Set(["push button", "toggle button", "check box", "radio button", "combo box", "text", "entry",
  "spin button", "slider", "menu item", "menu", "link", "page tab", "list item", "check menu item", "radio menu item",
  "tree item", "icon", "table cell"]);

const esc = (s: string) => s.replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

export function marksSvg(nodes: AxNode[], origin: Bounds, scale: number, width: number, height: number): string {
  const parts: string[] = [];
  for (const n of nodes) {
    if (!n.bounds || !MARKABLE.has(n.role) || n.role === "password text" || n.secret) continue;
    const x = (n.bounds.x - origin.x) * scale, y = (n.bounds.y - origin.y) * scale;
    const w = n.bounds.width * scale, h = n.bounds.height * scale;
    if (x + w < 0 || y + h < 0 || x > width || y > height) continue;
    const label = String(n.id);
    const tw = 7 * label.length + 6;
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="#ff7a1a" stroke-width="2"/>`,
      `<rect x="${x.toFixed(1)}" y="${Math.max(0, y - 14).toFixed(1)}" width="${tw}" height="14" fill="#ff7a1a"/>`,
      `<text x="${(x + 3).toFixed(1)}" y="${(Math.max(0, y - 14) + 11).toFixed(1)}" font-family="DejaVu Sans, sans-serif" font-size="11" font-weight="700" fill="#1a0f0b">${esc(label)}</text>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
}
