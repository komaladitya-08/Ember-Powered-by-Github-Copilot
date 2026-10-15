/**
 * Accessibility windows on the X11 screen: which top-level window an AT-SPI
 * frame is, how many physical pixels one of its reported pixels is (HiDPI
 * apps report logical pixels: GDK_SCALE=2 halves every coordinate), and
 * which windows stacked above it hide parts of it.
 */

import { scaleBounds, type AxNode, type AxWindow, type Bounds } from "./sidecar";
import type { StackedWindow } from "../x11";

export interface FrameMatch {
  /** Position in the stack (0 is the bottom). */
  index: number;
  window: StackedWindow;
  /** Physical pixels per reported pixel (1 unless it is clearly something else). */
  scale: number;
}

/** Within this, a scale counts as 1 (toolkits round logical sizes). */
const SAME = 0.05;

/**
 * The top-level window an accessibility frame belongs to: same process (or the
 * same title when either side has no pid), the same shape, and the same place
 * once scaled. The window's own title breaks ties between an app's windows.
 */
export function matchFrame(w: Pick<AxWindow, "pid" | "name" | "bounds">, stack: StackedWindow[]): FrameMatch | null {
  const b = w.bounds;
  if (!b || b.width <= 0 || b.height <= 0) return null;
  let best: FrameMatch | null = null, bestCost = Infinity;
  for (let index = 0; index < stack.length; index++) {
    const s = stack[index];
    if (s.overrideRedirect) continue;
    const samePid = w.pid != null && s.pid === w.pid;
    if (!samePid && !((w.pid == null || s.pid == null) && s.title === w.name)) continue;
    const o = s.outer;
    const kw = o.width / b.width, kh = o.height / b.height;
    if (!(kw > 0) || Math.abs(kw - kh) > SAME * Math.max(kw, kh)) continue;
    // GDK scales are whole numbers and Qt's usually quarters: one logical pixel of rounding in
    // the frame size shouldn't put a click 5 px off at the far side of a 4K screen.
    const nice = Math.round(kw * 4) / 4;
    const k = Math.abs(kw - 1) <= SAME ? 1 : Math.abs(kw - nice) <= 0.01 * nice ? nice : kw;
    const off = Math.abs(o.x - b.x * k) + Math.abs(o.y - b.y * k);
    if (off > 8 + 4 * k) continue;
    const cost = off + (s.title === w.name ? 0 : 1000);
    if (cost < bestCost) { best = { index, window: s, scale: k }; bestCost = cost; }
  }
  return best;
}

/** The same nodes in physical pixels. */
export function scaleNodes(nodes: AxNode[], k: number): AxNode[] {
  return k === 1 ? nodes : nodes.map(n => (n.bounds ? { ...n, bounds: scaleBounds(n.bounds, k) } : n));
}

export function intersect(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x && y1 > y ? { x, y, width: x1 - x, height: y1 - y } : null;
}

/**
 * The parts of `rect` hidden by windows stacked above `index`. Windows of the
 * processes in `ignore` don't count: the target app's own menus and dialogs
 * are part of what the worker looks at, and Ember's overlay is hidden for the capture.
 */
export function coveringRects(stack: StackedWindow[], index: number, rect: Bounds, ignore: (number | null | undefined)[]): Bounds[] {
  const out: Bounds[] = [];
  for (const s of stack.slice(index + 1)) {
    if (s.pid != null && ignore.includes(s.pid)) continue;
    const r = intersect(s, rect);
    if (r) out.push(r);
  }
  return out;
}

/** Area of `rect` that none of `covers` hides. */
export function uncoveredArea(rect: Bounds, covers: Bounds[]): number {
  const clipped = covers.map(c => intersect(c, rect)).filter((c): c is Bounds => !!c);
  const xs = [...new Set([rect.x, rect.x + rect.width, ...clipped.flatMap(c => [c.x, c.x + c.width])])].sort((a, b) => a - b);
  const ys = [...new Set([rect.y, rect.y + rect.height, ...clipped.flatMap(c => [c.y, c.y + c.height])])].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
      if (!clipped.some(c => cx > c.x && cx < c.x + c.width && cy > c.y && cy < c.y + c.height)) area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
    }
  }
  return area;
}
