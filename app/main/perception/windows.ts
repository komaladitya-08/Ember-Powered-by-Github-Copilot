/**
 * Accessibility windows on the X11 screen: which top-level window an AT-SPI
 * frame is, how many physical pixels one of its reported pixels is (HiDPI
 * apps report logical pixels: GDK_SCALE=2 halves every coordinate), and
 * which windows stacked above it hide parts of it.
 */

import { scaleBounds, type AxNode, type AxWindow, type Bounds, type ShellOverlay } from "./sidecar";
import type { StackedWindow } from "../x11";

export interface FrameMatch {
  /** Position in the stack (0 is the bottom). */
  index: number;
  window: StackedWindow;
  /** Physical pixels per pixel the frame reports (1 unless it is clearly something else). */
  scale: number;
}

/** Within this, a scale counts as 1 (toolkits round logical sizes). */
const SAME = 0.05;

/**
 * The top-level window an accessibility frame belongs to: the same shape and the same place
 * once scaled, as the whole window (GTK), as the app's own window inside the window manager's
 * frame (Chromium, Electron, Qt), or as that window less the shadow it draws itself (client-side
 * decorations: Firefox and Chrome on GNOME). Same process, or the same title when the processes
 * differ (Flatpak apps have another pid inside their sandbox); the title breaks ties between an app's windows.
 */
export function matchFrame(w: Pick<AxWindow, "pid" | "name" | "bounds">, stack: StackedWindow[]): FrameMatch | null {
  const b = w.bounds;
  if (!b || b.width <= 0 || b.height <= 0) return null;
  let best: FrameMatch | null = null, bestCost = Infinity;
  for (let index = 0; index < stack.length; index++) {
    const s = stack[index];
    if (s.overrideRedirect) continue;
    const samePid = w.pid != null && s.pid === w.pid;
    const sameTitle = !!w.name && s.title === w.name;
    if (!samePid && !sameTitle) continue;
    for (const o of [s.outer, s.inner, { x: s.x, y: s.y, width: s.width, height: s.height }]) {
      const kw = o.width / b.width, kh = o.height / b.height;
      if (!(kw > 0) || Math.abs(kw - kh) > SAME * Math.max(kw, kh)) continue;
      // GDK scales are whole numbers and Qt's usually quarters: one logical pixel of rounding in
      // the frame size shouldn't put a click 5 px off at the far side of a 4K screen.
      const nice = Math.round(kw * 4) / 4;
      const k = Math.abs(kw - 1) <= SAME ? 1 : Math.abs(kw - nice) <= 0.01 * nice ? nice : kw;
      const off = Math.abs(o.x - b.x * k) + Math.abs(o.y - b.y * k);
      if (off > 8 + 4 * k) continue;
      const cost = off + (sameTitle ? 0 : 1000) + (samePid ? 0 : 500);
      if (cost < bestCost) { best = { index, window: s, scale: k }; bestCost = cost; }
    }
  }
  return best;
}

/** Roles under which another renderer draws: Chromium's web contents report physical pixels inside a frame that reports logical ones. */
const EMBEDDED = new Set(["document web", "document frame", "embedded"]);

/**
 * Physical pixels per reported pixel, element by element. Most toolkits report every element
 * like their frame (`k`: GTK and Qt in logical pixels); an embedded document that only fits
 * `window` (the frame, in physical pixels) unscaled already reports physical pixels, and so
 * does everything inside it (Chromium and Electron at a scale above 1).
 */
export function elementScales(nodes: AxNode[], k: number, window: Bounds | null): Map<number, number> {
  const out = new Map<number, number>();
  const slack = 4 + 2 * k;
  const fits = (r: Bounds) => !!window && r.x >= window.x - slack && r.y >= window.y - slack
    && r.x + r.width <= window.x + window.width + slack && r.y + r.height <= window.y + window.height + slack;
  for (const n of nodes) {
    let s = (n.parent !== null ? out.get(n.parent) : undefined) ?? k;
    if (s !== 1 && EMBEDDED.has(n.role) && n.bounds && !fits(scaleBounds(n.bounds, s)) && fits(n.bounds)) s = 1;
    out.set(n.id, s);
  }
  return out;
}

/** The same nodes in physical pixels (`k`: one scale for all, or each element's own). */
export function scaleNodes(nodes: AxNode[], k: number | Map<number, number>): AxNode[] {
  if (k === 1) return nodes;
  return nodes.map(n => {
    const s = typeof k === "number" ? k : k.get(n.id) ?? 1;
    return n.bounds && s !== 1 ? { ...n, bounds: scaleBounds(n.bounds, s) } : n;
  });
}

export function intersect(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x && y1 > y ? { x, y, width: x1 - x, height: y1 - y } : null;
}

/** Ember's overlay lets every click through (and is hidden for captures): it covers nothing. */
export const OVERLAY_TITLE = "Ember overlay";

/**
 * The parts of `rect` hidden by windows stacked above `index`. The target app's own popups
 * (processes in `same`: its menus, lists and tooltips, which the window manager doesn't
 * manage) are part of what the worker looks at; its other windows (a Find dialog, a "Save
 * changes?" prompt) hide what lies under them like anyone's. Ember's own windows (process
 * `own`) are left out of pictures, but the ones that take clicks (the handle, the desk view,
 * the ask box) do hide what lies under them; the click-through overlay doesn't.
 */
export function coveringRects(stack: StackedWindow[], index: number, rect: Bounds, same: (number | null | undefined)[], own?: number): Bounds[] {
  const out: Bounds[] = [];
  for (const s of stack.slice(index + 1)) {
    const mine = own != null && s.pid === own;
    if (mine ? s.title === OVERLAY_TITLE : s.overrideRedirect && s.pid != null && same.includes(s.pid)) continue;
    const r = intersect(s, rect);
    if (r) out.push(r);
  }
  return out;
}

/**
 * What GNOME Shell's own drawings (not X11 windows, but in every screenshot) mean for a picture:
 * a system dialog (polkit's or the keyring's password prompt, most likely) means none at all, so
 * does the Activities overview or the window switcher (pictures of every window, private ones
 * too), and notifications are blacked out.
 */
export function shellCovers(overlays: ShellOverlay[]): { dialog: boolean; overview: boolean; masks: Bounds[] } {
  return {
    dialog: overlays.some(o => o.role !== "notification" && o.role !== "overview"),
    overview: overlays.some(o => o.role === "overview"),
    masks: overlays.flatMap(o => (o.role !== "overview" && o.bounds && o.bounds.width > 0 && o.bounds.height > 0 ? [o.bounds] : [])),
  };
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
