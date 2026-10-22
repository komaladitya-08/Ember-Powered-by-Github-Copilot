/**
 * Which WSLg window is which Linux window, and where a Linux app's reported pixels are on the Windows screen (§4.9).
 * WSLg draws every Linux toplevel as an RDP "RAIL" window of its distro's msrdc.exe: Windows sees its title and its
 * client area, AT-SPI inside the distro sees the frame and its children in the app's own pixels (window-relative on
 * Wayland, root-relative on X11, logical at any scale). Nothing ties the two together but the title and the shape, so
 * every match here fails closed: ambiguity leaves a window identified by title only (no coordinates) or not at all.
 * Pure: no window system, no sidecar, no clock (the router caches what this decides for 2 s).
 */

import type { Bounds } from "../perception/sidecar";
import type { Rect } from "../platform/types";

/** A RAIL window of one distro's msrdc, as the Windows window system stacks it (physical pixels). */
export interface RailWindow {
  hwnd: number;
  /** msrdc.exe's pid (every Linux window of the distro shares it). */
  pid: number;
  title: string;
  /** The client area: what WSLg draws the Linux window into. */
  inner: Rect;
  /** The visible frame (DWM's frame bounds). */
  frame: Rect;
  /** A menu, list or tooltip (rules.isPopup): never matched to a frame on its own. */
  popup: boolean;
  /** Its owner window (GW_OWNER), 0 for none or unknown. */
  owner: number;
}

/** One toplevel of a distro's accessible apps, as the distro's sidecar lists it (the app's own pixels). */
export interface LinuxFrame {
  /** The Linux process (never compared with a Windows pid). */
  pid: number | null;
  /** The frame's accessible object path (with `pid`, names it until it closes). */
  path: string;
  /** The AT-SPI application name. */
  app: string;
  name: string;
  role: string;
  active: boolean;
  bounds: Bounds | null;
  /** Its direct children's extents: the content box is their union (the frame itself may carry shadows). */
  children: Bounds[];
  /** The basename of /proc/<pid>/exe. */
  program?: string;
  /** The basenames of /proc/<pid>/cmdline's first two words (an interpreter's script: python3 /usr/bin/terminator). */
  argv0?: string;
  argv1?: string;
  /** /proc/<pid>/comm: 15 bytes at most, cut by the kernel. */
  comm?: string;
  /** Listed as last seen: its app didn't answer this time (its bounds may be stale). */
  busy?: boolean;
}

/** Where the app's pixel (x, y) is on screen: (dx + x·k, dy + y·k). */
export interface Transform { k: number; dx: number; dy: number }

/** A RAIL window matched to a Linux frame: with a proven transform, or by its unique title only (`transform` null). */
export interface WindowMatch { hwnd: number; frame: LinuxFrame; transform: Transform | null }

/** k's range (from .wslgconfig's scaling factor and integer HiDPI rounding) and its grid. */
const K_MIN = 0.5;
const K_MAX = 4;
const K_STEP = 1 / 8;
/** The most the content may sit inside the client area, per unit of scale: the sides and bottom, the top. */
const SIDE_INSET = 8;
const TOP_INSET = 48;
/** How far k and k' (from the height) may disagree over the box, and the self-check's slack, in pixels. */
const AGREE_PX = 2;
const CHECK_PX = 3;
/** RDP may cut a long title: one this long that starts exactly one frame's name is that frame's. */
const LONG_TITLE = 100;
/** GTK's "no position" (INT_MIN) and anything as absurd: never part of a content box. */
const ABSURD = 1 << 24;

/** A title as both sides are compared: NFC, whitespace collapsed and trimmed. */
export function normaliseTitle(title: string): string {
  return title.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * A RAIL title as the Linux side names the window: without WSLg's leading "[WARN:…]" bracket ("[WARN:COPY MODE]") and
 * one trailing " (<distro>)" for one of `distros` (the longest that fits), then normalised.
 */
export function railTitle(title: string, distros: readonly string[]): string {
  let t = normaliseTitle(title).replace(/^\[WARN:[^\]]*\]\s*/i, "");
  const tail = [...distros].sort((a, b) => b.length - a.length).find(d => d && t.endsWith(` (${d})`));
  if (tail) t = t.slice(0, t.length - tail.length - 3);
  return normaliseTitle(t);
}

/** Is this rectangle something a toolkit really reports (finite, positive size, not GTK's INT_MIN)? */
function usable(b: Bounds | null | undefined): b is Bounds {
  return !!b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0
    && Math.abs(b.x) < ABSURD && Math.abs(b.y) < ABSURD && b.width < ABSURD && b.height < ABSURD;
}

/** The union of the frame's direct children's extents (what shows, without CSD shadows), else the frame's own. */
export function contentBox(frame: Bounds | null, children: readonly Bounds[]): Bounds | null {
  const kids = children.filter(usable);
  if (!kids.length) return usable(frame) ? { ...frame } : null;
  const x = Math.min(...kids.map(c => c.x)), y = Math.min(...kids.map(c => c.y));
  const right = Math.max(...kids.map(c => c.x + c.width)), bottom = Math.max(...kids.map(c => c.y + c.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** One k's fit of the box into the client area (insets l = r, t, b), or null when the model doesn't hold. */
function fitAt(k: number, inner: Rect, box: Bounds): { k: number; l: number; t: number } | null {
  const l = (inner.width - box.width * k) / 2;
  if (l < -1 || l > SIDE_INSET * k + 1) return null;
  // t + b: what the height leaves, which must be a top and bottom inset within AGREE_PX (k' agrees with k).
  const vertical = inner.height - box.height * k;
  if (vertical < -AGREE_PX || vertical > (SIDE_INSET + TOP_INSET) * k + AGREE_PX) return null;
  // The bottom border is the side borders' (Weston's frame), and none where there are none (CSD).
  const b = Math.min(Math.max(l, 0), SIDE_INSET * k, Math.max(vertical, 0));
  const t = vertical - b;
  if (t < -AGREE_PX || t > TOP_INSET * k + AGREE_PX) return null;
  return { k, l: Math.max(l, 0), t: Math.max(t, 0) };
}

/**
 * The transform that puts `box` (the content box, in the app's pixels) into `inner` (the RAIL window's client area,
 * physical pixels): the client area = box × k plus insets (l, t, r, b) with l = r, 0 ≤ b ≤ 8k, 0 ≤ t ≤ 48k, and k in
 * [0.5, 4] on the 1/8 grid with the height agreeing within 2 px. Exactly one k must fit (two would put clicks in
 * different places), and the self-check must pass: the topmost and the leftmost child land in the client area's top and
 * left bands, and every child inside it. null otherwise.
 */
export function fitTransform(inner: Rect, box: Bounds, children: readonly Bounds[] = []): Transform | null {
  if (!usable(box) || !usable(inner)) return null;
  const fits: { k: number; l: number; t: number }[] = [];
  for (let k = K_MIN; k <= K_MAX + 1e-9; k += K_STEP) {
    const f = fitAt(k, inner, box);
    if (f) fits.push(f);
  }
  if (fits.length !== 1) return null;
  const { k, l, t } = fits[0];
  const transform = { k, dx: inner.x + l - box.x * k, dy: inner.y + t - box.y * k };
  return selfCheck(transform, inner, children.filter(usable).length ? children.filter(usable) : [box]) ? transform : null;
}

/** §4.9 step 5: the topmost and leftmost children map into the top and left bands, and every child into the client area. */
function selfCheck(tr: Transform, inner: Rect, children: readonly Bounds[]): boolean {
  const top = children.reduce((a, c) => (c.y < a.y || (c.y === a.y && c.x < a.x) ? c : a));
  const left = children.reduce((a, c) => (c.x < a.x || (c.x === a.x && c.y < a.y) ? c : a));
  const topY = tr.dy + top.y * tr.k, leftX = tr.dx + left.x * tr.k;
  if (topY < inner.y - CHECK_PX || topY > inner.y + TOP_INSET * tr.k + CHECK_PX) return false;
  if (leftX < inner.x - CHECK_PX || leftX > inner.x + SIDE_INSET * tr.k + CHECK_PX) return false;
  return children.every(c => {
    const m = mapBounds(tr, c);
    return m.x >= inner.x - CHECK_PX && m.y >= inner.y - CHECK_PX
      && m.x + m.width <= inner.x + inner.width + CHECK_PX && m.y + m.height <= inner.y + inner.height + CHECK_PX;
  });
}

/** An app-reported rectangle on screen (physical pixels). */
export function mapBounds(tr: Transform, b: Bounds): Bounds {
  const x = Math.round(tr.dx + b.x * tr.k), y = Math.round(tr.dy + b.y * tr.k);
  return { x, y, width: Math.round(tr.dx + (b.x + b.width) * tr.k) - x, height: Math.round(tr.dy + (b.y + b.height) * tr.k) - y };
}

/** A screen point in the app's own pixels (the inverse, for at_point). */
export function unmapPoint(tr: Transform, p: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round((p.x - tr.dx) / tr.k), y: Math.round((p.y - tr.dy) / tr.k) };
}

/** The frames `title` names: equal titles, else (a long, maybe cut, title) the one frame whose name it starts. */
function framesTitled(title: string, frames: readonly LinuxFrame[]): LinuxFrame[] {
  const equal = frames.filter(f => normaliseTitle(f.name) === title);
  if (equal.length || title.length < LONG_TITLE) return equal;
  const prefixed = frames.filter(f => normaliseTitle(f.name).startsWith(title));
  return prefixed.length === 1 ? prefixed : [];
}

/**
 * The RAIL windows of one distro matched to its frames (§4.9 steps 1-6). A window with exactly one frame that fits it,
 * which fits no other window, gets that frame and the transform; a window whose title is unique on both sides gets its
 * frame with no transform (no coordinates: tier 1 only); every other window is left out (unidentified). A window with
 * no title takes the active frame when it is the foreground window. Popups are never matched here (see popupOwners).
 */
export function matchWindows(rails: readonly RailWindow[], frames: readonly LinuxFrame[], o: { distro: string; foreground: number }): Map<number, WindowMatch> {
  const tops = rails.filter(r => !r.popup);
  const titleOf = new Map(tops.map(r => [r.hwnd, railTitle(r.title, [o.distro])]));
  const candidates = new Map<number, LinuxFrame[]>();
  for (const r of tops) {
    const t = titleOf.get(r.hwnd)!;
    if (t) candidates.set(r.hwnd, framesTitled(t, frames));
    else candidates.set(r.hwnd, r.hwnd === o.foreground ? frames.filter(f => f.active).slice(0, 2) : []);
  }
  // Which frames fit which windows (a busy app's frame is as last seen: its place can't be trusted).
  const fits = new Map<number, Map<LinuxFrame, Transform>>();
  const fitted = new Map<LinuxFrame, number[]>();
  for (const r of tops) {
    const mine = new Map<LinuxFrame, Transform>();
    for (const f of candidates.get(r.hwnd)!) {
      const box = f.busy ? null : contentBox(f.bounds, f.children);
      const tr = box && fitTransform(r.inner, box, f.children.length ? f.children : [box]);
      if (!tr) continue;
      mine.set(f, tr);
      fitted.set(f, [...fitted.get(f) ?? [], r.hwnd]);
    }
    fits.set(r.hwnd, mine);
  }
  const out = new Map<number, WindowMatch>();
  const claimed = new Set<LinuxFrame>();
  for (const r of tops) {
    const mine = fits.get(r.hwnd)!;
    if (mine.size !== 1) continue;
    const [[frame, transform]] = [...mine];
    if (fitted.get(frame)!.length !== 1) continue;
    out.set(r.hwnd, { hwnd: r.hwnd, frame, transform });
    claimed.add(frame);
  }
  // Identity only: one window and one frame with that title, neither already taken.
  for (const r of tops) {
    if (out.has(r.hwnd)) continue;
    const t = titleOf.get(r.hwnd)!;
    const cands = candidates.get(r.hwnd)!;
    if (cands.length !== 1 || claimed.has(cands[0])) continue;
    const sameTitle = t ? tops.filter(o2 => titleOf.get(o2.hwnd) === t).length : 1;
    if (sameTitle !== 1) continue;
    if (t && frames.filter(f => normaliseTitle(f.name) === normaliseTitle(cands[0].name)).length !== 1) continue;
    out.set(r.hwnd, { hwnd: r.hwnd, frame: cands[0], transform: null });
    claimed.add(cands[0]);
  }
  return out;
}

/**
 * The identified window each popup belongs to (§4.6, critique wsl-11), for masking and covering only: by its Win32
 * owner chain (`ownerOf`, nearest first), else by lying within the same msrdc's nearest window below it in the stack
 * (bottom to top: the window it opened over), when that one is identified. Popups nothing claims stay unidentified.
 */
export function popupOwners(stackOrder: readonly RailWindow[], identified: ReadonlySet<number>, ownerOf: (hwnd: number) => number): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < stackOrder.length; i++) {
    const p = stackOrder[i];
    if (!p.popup) continue;
    let owner = 0;
    const seen = new Set<number>();
    for (let o = p.owner || ownerOf(p.hwnd); o && !seen.has(o) && seen.size < 8; o = ownerOf(o)) {
      seen.add(o);
      if (identified.has(o)) { owner = o; break; }
    }
    if (!owner) {
      let below: RailWindow | undefined;
      for (let j = i - 1; j >= 0; j--) {
        if (stackOrder[j].pid === p.pid && !stackOrder[j].popup) { below = stackOrder[j]; break; }
      }
      if (below && identified.has(below.hwnd) && inside(p.frame, below.frame)) owner = below.hwnd;
    }
    if (owner) out.set(p.hwnd, owner);
  }
  return out;
}

/** Does `a` lie within `b` (2 px of slack for rounding)? */
function inside(a: Rect, b: Rect): boolean {
  return a.x >= b.x - 2 && a.y >= b.y - 2 && a.x + a.width <= b.x + b.width + 2 && a.y + a.height <= b.y + b.height + 2;
}

/**
 * Which of several running distros' frames name the windows of one msrdc pid (titles normalised with each distro's
 * name): that distro when exactly one does, else null (none, or more than one: unidentified this time).
 */
export function distroOfTitles(titles: readonly string[], frames: ReadonlyMap<string, readonly LinuxFrame[]>): string | null {
  const hits = [...frames].filter(([distro, fs]) => titles.some(t => {
    const want = railTitle(t, [distro]);
    return !!want && framesTitled(want, fs).length > 0;
  }));
  return hits.length === 1 ? hits[0][0] : null;
}
