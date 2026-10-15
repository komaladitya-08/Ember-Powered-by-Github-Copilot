/**
 * Perception: what is on the user's screen, as text (always) and as an image
 * (for workers, on request). Text comes from the accessibility tree via the
 * sidecar; images come straight from X11 with Ember hidden and private
 * windows blacked out. Every position handed out is in physical X pixels,
 * also for HiDPI apps that report logical ones (see windows.ts).
 */

import { isSecurityWindow } from "../policy/policy";
import { captureRect, type Capture } from "./capture";
import { marksSvg } from "./marks";
import { focusedElement, isNeverLook, isSecretNode, serializeElements, inferLabels, quoteUntrusted, screenWord } from "./elements";
import { scaleBounds, type AtspiSidecar, type AxNode, type AxWindow, type Bounds } from "./sidecar";
import { coveringRects, matchFrame, scaleNodes, uncoveredArea } from "./windows";
import type { StackedWindow, X11, X11Window } from "../x11";
import type { Logger } from "../logger";

export interface PerceptionOptions {
  sidecar: AtspiSidecar;
  x11: X11 | null;
  neverLook: () => string[];
  /** Full screen in physical pixels (all displays). */
  screenBounds: () => Bounds;
  hideOverlay?: () => Promise<() => void>;
  log: Logger;
  /** Ember's own process: its windows (the overlay, hidden while capturing) never count as covering a window. */
  ownPid?: number;
}

/**
 * A window to read. `pid` with `path` (from an earlier read) names exactly one
 * window; otherwise pid and title are matched together. Never the active
 * window instead: a target that matches nothing is not found.
 */
export interface WindowTarget { pid?: number; title?: string; path?: string }

export interface QuickContext {
  /** The window the user was in; tasks start there. */
  target: WindowTarget & { app?: string };
  /** For the model, wrapped as untrusted. */
  text: string;
}

export interface Seen {
  window: AxWindow | null;
  x11Window: X11Window | null;
  nodes: AxNode[];
  blocked: boolean;
  ms: number;
  /** Physical pixels per pixel the app reports (2 for GDK_SCALE=2); the bounds here are already physical. */
  axScale: number;
}

export interface Perceived extends Seen {
  text: string;
  capture: Capture | null;
}

export class Perception {
  /** The overlay hide in progress: concurrent captures share it, and Ember shows again when the last one is done. */
  private hidden: { count: number; restore: Promise<() => void> } | null = null;
  /** Scale per app (by pid): it rarely changes, and finding it takes a walk over the X window tree. */
  private scales = new Map<string, { k: number; until: number }>();

  constructor(private o: PerceptionOptions) {}

  /** The focused window's accessibility tree (empty when blocked or unreadable). */
  async focused(stack?: StackedWindow[] | null): Promise<Seen> {
    const x11Window = this.o.x11?.activeWindow() ?? null;
    return this.read(x11Window ? { pid: x11Window.pid ?? undefined, title: x11Window.title } : {}, x11Window, stack);
  }

  /** A window's tree (see WindowTarget); with an empty target, the active window's. */
  async read(target: WindowTarget, x11Window: X11Window | null = null, stack?: StackedWindow[] | null): Promise<Seen> {
    const t0 = Date.now();
    const params = target.pid != null && target.path ? { pid: target.pid, path: target.path }
      : target.pid != null || target.title ? { ...(target.pid != null ? { pid: target.pid } : {}), ...(target.title ? { title: target.title } : {}) }
      : target.path ? null // a path means nothing without its process
      : {};
    const res = params ? await this.o.sidecar.readWindow(params) : { window: null, nodes: [] as AxNode[], ms: 0 };
    const window = res.window;
    // Never-look apps, and password or authentication prompts (polkit, keyring…): Ember looks away (M8.3).
    const blocked = !!window && (isNeverLook(window, this.o.neverLook()) || isSecurityWindow(window))
      || (!window && !!x11Window && (isNeverLook({ app: "", name: x11Window.title }, this.o.neverLook()) || isSecurityWindow(x11Window)));
    if (blocked) {
      // A private window's title goes no further than this (not to the model, not to the logs).
      return { window: window && { ...window, name: "" }, x11Window: x11Window && { ...x11Window, title: "" }, nodes: [], blocked, ms: Date.now() - t0, axScale: 1 };
    }
    const k = window ? this.axScale(window, stack) : 1;
    if (k !== 1) this.o.sidecar.scaleElements(res.nodes.map(n => n.id), k);
    return {
      window: window && window.bounds && k !== 1 ? { ...window, bounds: scaleBounds(window.bounds, k) } : window,
      x11Window, nodes: scaleNodes(res.nodes, k), blocked, ms: Date.now() - t0, axScale: k,
    };
  }

  /**
   * Physical pixels per pixel this window's app reports: its X11 top-level's size over its
   * accessibility frame's (HiDPI apps report logical pixels). From `stack` when given, else
   * remembered per app for a while.
   */
  private axScale(window: AxWindow, stack?: StackedWindow[] | null): number {
    const key = window.pid != null ? `pid:${window.pid}` : `title:${window.name}`;
    const now = Date.now();
    if (!stack) {
      const known = this.scales.get(key);
      if (known && known.until > now) return known.k;
      stack = this.stackNow();
      if (!stack) return 1;
    }
    const match = matchFrame(window, stack);
    const k = match?.scale ?? 1;
    if (k !== 1 && this.scales.get(key)?.k !== k) this.o.log.info("perception.hidpi", { pid: window.pid, scale: Math.round(k * 100) / 100 });
    this.scales.delete(key);
    this.scales.set(key, { k, until: now + (match ? 30_000 : 5_000) });
    if (this.scales.size > 200) this.scales.delete(this.scales.keys().next().value!);
    return k;
  }

  /** The X11 top-level windows, bottom to top (null without X11 or when it fails). */
  private stackNow(): StackedWindow[] | null {
    if (!this.o.x11) return null;
    try {
      return this.o.x11.stack();
    } catch (err) {
      this.o.log.warn("perception.stack_failed", { err });
      return null;
    }
  }

  /** Where the window read in `seen` is in the stack (null when it can't be found there). */
  private locate(seen: Seen, stack: StackedWindow[]): { index: number; rect: Bounds } | null {
    if (seen.window) {
      // Its bounds are physical already, so it matches at scale 1.
      const m = matchFrame(seen.window, stack);
      return m && { index: m.index, rect: { x: m.window.x, y: m.window.y, width: m.window.width, height: m.window.height } };
    }
    const w = seen.x11Window;
    const index = w ? stack.findIndex(s => s.client === w.id || s.id === w.id) : -1;
    if (index < 0) return null;
    const s = stack[index];
    return { index, rect: { x: s.x, y: s.y, width: s.width, height: s.height } };
  }

  /**
   * Taken the moment the user calls Ember (before the ask box or anything else
   * takes focus): which window they're in, what has focus, and any selected
   * text, so "make this bold" knows what "this" is. Short; untrusted.
   */
  async quickContext(): Promise<QuickContext | null> {
    let seen: Seen;
    try {
      seen = await this.focused();
    } catch {
      return null;
    }
    const pid = seen.window?.pid ?? seen.x11Window?.pid ?? undefined;
    // A private window: only its process (a task started there is refused), never its title.
    if (seen.blocked) return { target: { pid }, text: `<context untrusted="true">The user is in a private window (on their never-look list, or a password prompt).</context>` };
    const title = seen.window?.name || seen.x11Window?.title || "";
    if (!title) return null;
    const app = seen.window?.app ?? "";
    const target = { pid, title, app, ...(seen.window?.path ? { path: seen.window.path } : {}) };
    const focus = focusedElement(seen.nodes);
    const label = focus ? focus.name || inferLabels(seen.nodes).get(focus.id) || "" : "";
    const secret = !!focus && isSecretNode(focus, label);
    const lines = [`App: ${quoteUntrusted(app || "unknown", 60)}, window: ${quoteUntrusted(title, 100)}.`];
    if (focus) lines.push(`Focused: ${screenWord(focus.role)}${label ? ` ${quoteUntrusted(label, 60)}` : ""}${secret ? " (a secret field; its contents are not shown)" : ""}.`);
    if (focus && !secret) {
      if (focus.selection) lines.push(`Selected text: ${quoteUntrusted(focus.selection, 300)}.`);
      else if (focus.text) lines.push(`Its text begins: ${quoteUntrusted(focus.text, 120)}.`);
    }
    return { target, text: `<context source="focused-window" untrusted="true">\n${lines.join("\n")}\n</context>` };
  }

  /** Text for the conductor: where the user is and what the window contains. */
  async describe(): Promise<string> {
    let seen: Seen;
    try {
      seen = await this.focused();
    } catch (err) {
      this.o.log.warn("perception.describe_failed", { err });
      return "Ember could not read the screen right now (the accessibility service did not answer).";
    }
    // Everything read from the screen (titles, names, text) stays inside the untrusted <screen> wrapper, quoted.
    if (seen.blocked) return `The user is in a private window (on their "never look at" list, or a password prompt). Do not read or describe it.`;
    const title = seen.window?.name || seen.x11Window?.title || "";
    if (!seen.window) {
      const named = title ? `\n<screen source="window-title" untrusted="true">\nWindow: ${quoteUntrusted(title, 100)}\n</screen>` : "";
      return `The focused window does not expose accessibility information, so its contents can't be read as text.${named}`;
    }
    const focus = focusedElement(seen.nodes);
    const label = focus ? focus.name || inferLabels(seen.nodes).get(focus.id) || "" : "";
    const focusLine = focus ? `Focused element: [${focus.id}] ${screenWord(focus.role)}${label ? ` ${quoteUntrusted(label, 80)}` : ""}.` : "No element has keyboard focus.";
    return `The user's focused window, read through accessibility:\n${serializeElements(seen.window, seen.nodes, { maxLines: 120, header: [focusLine] })}`;
  }

  /**
   * For workers: elements with bounds, plus an optional marked screenshot. A window
   * screenshot shows only that window: whatever other windows cover of it is blacked out.
   */
  async perceive(opts: { image: boolean; scope: "window" | "screen"; target?: WindowTarget }): Promise<Perceived> {
    // One fresh look at the window stack serves the scale, what covers the window, and the private windows.
    const stack = opts.image ? this.stackNow() : null;
    const seen = opts.target ? await this.read(opts.target, null, stack) : await this.focused(stack);
    const text = seen.blocked
      ? "This window is private (on the user's never-look list, or a password prompt). Do not interact with it."
      : seen.window ? serializeElements(seen.window, seen.nodes, { withBounds: true }) : "The focused window exposes no accessibility information; use the screenshot.";
    if (!opts.image || seen.blocked) return { ...seen, text, capture: null };
    const noShot = (why: string): Perceived => ({ ...seen, text: `${text}\n(No screenshot: ${why}.)`, capture: null });
    const x11 = this.o.x11;
    if (!x11) return noShot("screenshots aren't available on this display");
    // While a password prompt has focus anywhere on screen, no screenshots at all.
    const active = x11.focusWindow() ?? x11.activeWindow();
    if (active && isSecurityWindow({ app: active.wmClass, title: active.title })) return noShot("a password prompt is open, so Ember looks away until it's done");
    const windowScope = opts.scope === "window" && !!(seen.window || seen.x11Window);
    let rect = this.o.screenBounds();
    // A window: blacked out wherever other apps' windows lie on top of it (the stacking order says which).
    const ignore = [this.o.ownPid ?? process.pid, seen.window?.pid ?? seen.x11Window?.pid];
    const covering = (s: StackedWindow[] | null): Bounds[] | null => {
      const at = s && this.locate(seen, s);
      return at ? coveringRects(s!, at.index, at.rect, ignore) : null;
    };
    let covers: Bounds[] = [];
    if (windowScope) {
      const at = stack && this.locate(seen, stack);
      if (!at) return noShot("Ember couldn't find the window on screen, so it can't tell what covers it");
      rect = at.rect;
      covers = coveringRects(stack!, at.index, rect, ignore);
      if (uncoveredArea(rect, covers) <= 0.01 * rect.width * rect.height) return noShot("the window is covered by other windows");
    }
    const mask = await this.privateWindows(stack);
    if (mask === null) {
      // Can't tell where private windows are, so no screenshot (fail closed).
      this.o.log.warn("perception.capture_declined", { reason: "private windows could not be listed" });
      return noShot("Ember couldn't check for private windows");
    }
    let coveredAfter = false;
    const capture = await captureRect(x11, rect, {
      mask: [...mask, ...covers],
      // Windows can move or open while the picture is taken: black out where they are afterwards too.
      maskAfter: async () => {
        const now = this.stackNow();
        const priv = await this.privateWindows(now);
        if (priv === null || !windowScope) return priv;
        const after = covering(now);
        if (after === null) return null; // the window is gone from the stack: no picture
        coveredAfter = after.length > 0;
        return [...priv, ...after];
      },
      hideOverlay: this.o.hideOverlay ? () => this.hideOverlay() : undefined,
      overlaySvg: (scale, w, h, origin) => seen.nodes.length ? marksSvg(seen.nodes, origin, scale, w, h) : null,
    });
    if (!capture) return noShot("the window is off screen, or the screen couldn't be captured safely");
    const note = covers.length || coveredAfter ? "\n(Screenshot: parts covered by other windows are hidden.)" : "";
    return { ...seen, text: text + note, capture };
  }

  /** Hides Ember for a capture. Concurrent captures share one hide; the last one to finish shows Ember again. */
  private async hideOverlay(): Promise<() => void> {
    const h = this.hidden ??= { count: 0, restore: this.o.hideOverlay!() };
    h.count++;
    const release = () => {
      if (--h.count > 0) return false;
      if (this.hidden === h) this.hidden = null;
      return true;
    };
    let restore: () => void;
    try {
      restore = await h.restore;
    } catch (err) {
      release();
      throw err;
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (release()) restore();
    };
  }

  /** Visible windows (app, title, physical bounds), never-look ones left out. */
  async windows(): Promise<AxWindow[]> {
    const { windows } = await this.o.sidecar.listWindows();
    const shown = windows.filter(w => !isNeverLook(w, this.o.neverLook()));
    const stack = shown.some(w => w.bounds) ? this.stackNow() : null;
    return shown.map(w => {
      const k = w.bounds && stack ? this.axScale(w, stack) : 1;
      return k !== 1 ? { ...w, bounds: scaleBounds(w.bounds!, k) } : w;
    });
  }

  /** Bounds of every visible window on the never-look list (blacked out in screenshots). */
  /**
   * Both sources are used: X11 sees every top-level window (even apps that expose
   * nothing over accessibility, e.g. started before it was turned on), AT-SPI
   * knows app names. null means neither could be listed: the caller must not
   * capture (fail closed) while anything is on the never-look list.
   */
  async privateWindows(stack?: StackedWindow[] | null): Promise<Bounds[] | null> {
    const list = this.o.neverLook();
    if (!list.some(i => i.trim())) return [];
    // From X11: whole frames, so the title bar (which shows the title) is covered too.
    let x11: Bounds[] | null = null;
    try {
      const s = stack ?? (this.o.x11 ? this.o.x11.stack() : null);
      x11 = s && s.filter(w => isNeverLook({ app: w.wmClass, name: w.title }, list)).map(w => ({ x: w.x, y: w.y, width: w.width, height: w.height }));
    } catch (err) {
      this.o.log.warn("perception.x11_windows_failed", { err });
    }
    let atspi: Bounds[] | null = null;
    try {
      const { windows } = await this.o.sidecar.listWindows();
      atspi = windows.filter(w => w.bounds && isNeverLook(w, list)).map(w => {
        const k = this.scales.get(w.pid != null ? `pid:${w.pid}` : `title:${w.name}`)?.k ?? 1;
        return scaleBounds(w.bounds!, k);
      });
    } catch (err) {
      this.o.log.warn("perception.atspi_windows_failed", { err });
    }
    if (x11 === null && atspi === null) return null;
    return [...(x11 ?? []), ...(atspi ?? [])];
  }
}
