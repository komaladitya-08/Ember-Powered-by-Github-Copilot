/**
 * Perception: what is on the user's screen, as text (always) and as an image
 * (for workers, on request). Text comes from the accessibility tree via the
 * sidecar; images come straight from X11 with Ember hidden and private
 * windows and secret fields blacked out. Every position handed out is in
 * physical X pixels, also for HiDPI apps that report logical ones (see windows.ts).
 */

import { isSecurityWindow } from "../policy/policy";
import { captureRect, type Capture } from "./capture";
import { marksSvg } from "./marks";
import { focusedElement, insideSecrets, isNeverLook, isSecretNode, secretIds, serializeElements, inferLabels, quoteUntrusted, screenWord } from "./elements";
import { scaleBounds, type AtspiSidecar, type AxNode, type AxWindow, type Bounds, type OtherWindow, type PointElement, type ReadWindowResult } from "./sidecar";
import { coveringRects, elementScales, matchFrame, scaleNodes, shellCovers, uncoveredArea, type FrameMatch } from "./windows";
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
  /**
   * Ember's own process. Its windows stay out of screenshots, but the ones that take clicks
   * (handle, desk view, ask box) hide what lies under them; the click-through overlay doesn't.
   */
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
  x11Window: (X11Window & { wmClass?: string }) | null;
  nodes: AxNode[];
  blocked: boolean;
  /** The app didn't answer in time, even when asked again (busy or hung): `nodes` are partial, or there is no window. */
  busy: boolean;
  /** Cut short: "nodes" at the element limit, "time" when reading took too long, "depth" when something on screen is nested deeper than a read goes. */
  truncated: "nodes" | "time" | "depth" | null;
  /** The app's other windows the user is in or must answer first (an Open dialog); private ones left out. */
  others: OtherWindow[];
  ms: number;
  /** Physical pixels per pixel the app's window frame reports (2 for GDK_SCALE=2); the bounds here are already physical. */
  axScale: number;
  /** The user is in one of Ember's own windows (the ask box, settings): Ember never reads those, so nothing was read. */
  ember?: boolean;
}

export interface Perceived extends Seen {
  text: string;
  capture: Capture | null;
}

/** A busy app (a file dialog listing a big folder) is asked once more after this long. */
const BUSY_RETRY_MS = 300;
/** Secret fields whose position is checked again once the picture is taken (they can scroll meanwhile). */
const MAX_SECRET_RECHECK = 24;
/** Workers see every element a read returns (the sidecar's MAX_NODES), so every id they may need is there. */
const WORKER_LINES = 400;

export class Perception {
  /** The overlay hide in progress: concurrent captures share it, and Ember shows again when the last one is done. */
  private hidden: { count: number; restore: Promise<() => void> } | null = null;
  /** Scale per app (by pid): it rarely changes, and finding it takes a walk over the X window tree. */
  private scales = new Map<string, { k: number; until: number }>();

  constructor(private o: PerceptionOptions) {}

  /** The focused window's accessibility tree (empty when blocked or unreadable). */
  async focused(stack?: StackedWindow[] | null): Promise<Seen> {
    const x11Window = this.o.x11?.activeWindow() ?? null;
    if (x11Window && x11Window.pid === this.ownPid) {
      return { window: null, x11Window: null, nodes: [], blocked: false, busy: false, truncated: null, others: [], ms: 0, axScale: 1, ember: true };
    }
    return this.read(x11Window ? { pid: x11Window.pid ?? undefined, title: x11Window.title } : {}, x11Window, stack);
  }

  /** Ember's own process: its windows (the ask box, settings, the overlay) are never read or listed. */
  private get ownPid(): number {
    return this.o.ownPid ?? process.pid;
  }

  /** On the never-look list, or a password or authentication prompt (polkit, keyring…): Ember looks away (M8.3). */
  private isPrivate(app: string, title: string, list: string[]): boolean {
    return isNeverLook({ app, name: title }, list) || isSecurityWindow({ app, title });
  }

  /**
   * A window's tree (see WindowTarget); with an empty target, the active window's. `stack`: the
   * X11 windows when the caller has them (undefined: looked up when needed).
   */
  async read(target: WindowTarget, x11Window: (X11Window & { wmClass?: string }) | null = null, stack?: StackedWindow[] | null): Promise<Seen> {
    const t0 = Date.now();
    const params = target.pid != null && target.path ? { pid: target.pid, path: target.path }
      : target.pid != null || target.title ? { ...(target.pid != null ? { pid: target.pid } : {}), ...(target.title ? { title: target.title } : {}) }
      : target.path ? null // a path means nothing without its process
      : {};
    const list = this.o.neverLook().filter(i => i.trim());
    // Never-look apps are known by their X11 class too (an Electron app's accessibility name is only
    // "electron"): those processes aren't read at all.
    if (list.length && stack === undefined) stack = this.stackNow();
    const skipPids = list.length && stack ? [...new Set(stack.filter(s => s.pid != null && isNeverLook({ app: s.wmClass, name: "" }, list)).map(s => s.pid!))] : [];
    const ask = () => params ? this.o.sidecar.readWindow({ ...params, ownPid: this.ownPid, ...(list.length ? { neverLook: list, skipPids } : {}) })
      : Promise.resolve<ReadWindowResult>({ window: null, nodes: [], ms: 0 });
    let res = await ask();
    if (res.busy) {
      await new Promise(r => setTimeout(r, BUSY_RETRY_MS));
      const again = await ask();
      // The second answer, unless the app answered even less of it.
      if (!again.busy || again.nodes.length >= res.nodes.length) res = again;
    }
    const window = res.window;
    const match = window && stack ? matchFrame(window, stack) : null;
    const blocked = !!res.blocked
      || !!window && this.isPrivate(window.app, window.name, list)
      || !!match && this.isPrivate(match.window.wmClass, match.window.title, list)
      || !!x11Window && this.isPrivate(x11Window.wmClass ?? "", x11Window.title, list);
    const none = { busy: false, truncated: null, others: [], axScale: 1 };
    if (blocked) {
      // A private window's title goes no further than this (not to the model, not to the logs).
      return { ...none, window: window && { ...window, name: "" }, x11Window: x11Window && { ...x11Window, title: "" }, nodes: [], blocked, ms: Date.now() - t0 };
    }
    if (!window) return { ...none, window, x11Window, nodes: [], blocked, busy: !!res.busy, ms: Date.now() - t0 };
    const k = this.frameScale(window, stack, match);
    const frame = window.bounds && scaleBounds(window.bounds, k);
    // Element by element: Chromium's web contents report physical pixels inside a frame that reports logical ones.
    const each = k !== 1 ? elementScales(res.nodes, k, frame) : null;
    if (each) {
      const groups = new Map<number, number[]>();
      for (const [id, s] of each) if (s !== 1) groups.set(s, [...groups.get(s) ?? [], id]);
      for (const [s, ids] of groups) this.o.sidecar.scaleElements(ids, s);
    }
    const nodes = await this.withSecrets(scaleNodes(res.nodes, each ?? 1));
    return {
      window: { ...window, bounds: frame }, x11Window, nodes, blocked, busy: !!res.busy,
      truncated: res.slow ? "time" : !res.truncated ? null : res.cut?.length && !res.cut.includes("nodes") ? "depth" : "nodes",
      others: (res.others ?? []).filter(w => !this.isPrivate(window.app, w.name, list)),
      ms: Date.now() - t0, axScale: k,
    };
  }

  /**
   * What shows at point `p` in the window `target` names (its pid and path), outermost first: for the wheel, whether
   * a control it would change is there. Positions are as the app reports them, the same as read()'s for a window
   * whose axScale is 1. null when that can't be told: no pid and path, a private or closed window, an app that
   * didn't answer in time.
   */
  async atPoint(target: WindowTarget, p: { x: number; y: number }): Promise<PointElement[] | null> {
    if (target.pid == null || !target.path) return null;
    const list = this.o.neverLook().filter(i => i.trim());
    const stack = list.length ? this.stackNow() : null;
    const skipPids = list.length && stack ? [...new Set(stack.filter(s => s.pid != null && isNeverLook({ app: s.wmClass, name: "" }, list)).map(s => s.pid!))] : [];
    const res = await this.o.sidecar.atPoint({ pid: target.pid, path: target.path, x: Math.round(p.x), y: Math.round(p.y), ownPid: this.ownPid, ...(list.length ? { neverLook: list, skipPids } : {}) });
    return res.blocked || res.busy || res.found === false ? null : res.chain;
  }

  /**
   * Fields the sidecar didn't know were secret (a revealed password beside its "Show password"
   * toggle, an unnamed field under a "Card number" label): their contents are dropped here, and
   * the sidecar is told, so nothing is typed into them either.
   */
  private async withSecrets(nodes: AxNode[]): Promise<AxNode[]> {
    const secret = secretIds(nodes);
    // What a secret field holds goes too (Chromium lists a text box's text as static text inside it).
    const inside = insideSecrets(nodes, secret);
    const fresh = nodes.filter(n => secret.has(n.id) && !n.secret).map(n => n.id);
    if (!fresh.length && !inside.size) return nodes;
    if (fresh.length) await Promise.resolve().then(() => this.o.sidecar.markSecret(fresh)).catch(err => this.o.log.warn("perception.mark_secret_failed", { err }));
    return nodes.flatMap(n => {
      if (inside.has(n.id)) return [];
      if (!secret.has(n.id) || n.secret) return [n];
      const { text: _text, selection: _selection, value: _value, ...rest } = n;
      return [{ ...rest, secret: true }];
    });
  }

  /**
   * Physical pixels per pixel this window's frame reports: its X11 top-level's size over its
   * accessibility frame's (HiDPI apps report logical pixels). From `stack` when given, else
   * remembered per app for a while.
   */
  private frameScale(window: AxWindow, stack?: StackedWindow[] | null, match?: FrameMatch | null): number {
    const key = window.pid != null ? `pid:${window.pid}` : `title:${window.name}`;
    const now = Date.now();
    if (!stack) {
      const known = this.scales.get(key);
      if (known && known.until > now) return known.k;
      stack = this.stackNow();
      if (!stack) return 1;
      match = undefined;
    }
    if (match === undefined) match = matchFrame(window, stack);
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
  private locate(seen: Seen, stack: StackedWindow[]): { index: number; rect: Bounds; pid: number | null } | null {
    if (seen.window) {
      // Its bounds are physical already, so it matches at scale 1.
      const m = matchFrame(seen.window, stack);
      return m && { index: m.index, rect: { x: m.window.x, y: m.window.y, width: m.window.width, height: m.window.height }, pid: m.window.pid };
    }
    const w = seen.x11Window;
    const index = w ? stack.findIndex(s => s.client === w.id || s.id === w.id) : -1;
    if (index < 0) return null;
    const s = stack[index];
    return { index, rect: { x: s.x, y: s.y, width: s.width, height: s.height }, pid: s.pid };
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
    if (seen.ember) return EMBERS_OWN;
    const title = seen.window?.name || seen.x11Window?.title || "";
    if (!seen.window) {
      if (seen.busy) return BUSY_APP;
      const named = title ? `\n<screen source="window-title" untrusted="true">\nWindow: ${quoteUntrusted(title, 100)}\n</screen>` : "";
      return `The focused window does not expose accessibility information, so its contents can't be read as text.${named}`;
    }
    const focus = focusedElement(seen.nodes);
    const label = focus ? focus.name || inferLabels(seen.nodes).get(focus.id) || "" : "";
    const focusLine = focus ? `Focused element: [${focus.id}] ${screenWord(focus.role)}${label ? ` ${quoteUntrusted(label, 80)}` : ""}.` : "No element has keyboard focus.";
    return `The user's focused window, read through accessibility:\n${serializeElements(seen.window, seen.nodes, { maxLines: 120, header: [focusLine, ...othersLine(seen)] })}${notes(seen)}`;
  }

  /**
   * For workers: elements with bounds, plus an optional marked screenshot. A window
   * screenshot shows only that window: whatever other windows cover of it is blacked
   * out, and so are secret fields (they get no mark either).
   */
  async perceive(opts: { image: boolean; scope: "window" | "screen"; target?: WindowTarget }): Promise<Perceived> {
    // One fresh look at the window stack serves the scale, what covers the window, and the private windows.
    const stack = opts.image ? this.stackNow() : undefined;
    const seen = opts.target ? await this.read(opts.target, null, stack) : await this.focused(stack);
    const text = seen.blocked
      ? "This window is private (on the user's never-look list, or a password prompt). Do not interact with it."
      : seen.window ? serializeElements(seen.window, seen.nodes, { withBounds: true, maxLines: WORKER_LINES, header: othersLine(seen) }) + notes(seen)
      : seen.busy ? BUSY_APP
      : seen.ember ? EMBERS_OWN
      : "The focused window exposes no accessibility information; use the screenshot.";
    if (!opts.image || seen.blocked) return { ...seen, text, capture: null };
    const noShot = (why: string): Perceived => ({ ...seen, text: `${text}\n(No screenshot: ${why}.)`, capture: null });
    const x11 = this.o.x11;
    if (!x11) return noShot("screenshots aren't available on this display");
    // While a password prompt has focus anywhere on screen, no screenshots at all.
    const active = x11.focusWindow() ?? x11.activeWindow();
    if (active && isSecurityWindow({ app: active.wmClass, title: active.title })) return noShot("a password prompt is open, so Ember looks away until it's done");
    // GNOME Shell draws its own dialogs (polkit, keyring) and notifications: no X11 window shows where they are.
    const shell = await this.shellOverlays();
    if (shell.unchecked) return noShot("GNOME Shell didn't answer in time, so Ember can't tell whether a system dialog (a password prompt) is open; try again in a moment");
    if (shell.dialog) return noShot("a system dialog is open, so Ember looks away until it's done");
    if (shell.overview) return noShot("the Activities overview or the window switcher is open (it shows every window), so Ember looks away until it's closed");
    const windowScope = opts.scope === "window" && !!(seen.window || seen.x11Window);
    let rect = this.o.screenBounds();
    // A window: blacked out wherever other windows lie on top of it (the stacking order says which).
    const own = this.ownPid;
    const covering = (s: StackedWindow[] | null): Bounds[] | null => {
      const at = s && this.locate(seen, s);
      return at ? coveringRects(s!, at.index, at.rect, [seen.window?.pid ?? seen.x11Window?.pid, at.pid], own) : null;
    };
    let covers: Bounds[] = [];
    if (windowScope) {
      const at = stack && this.locate(seen, stack);
      if (!at) return noShot("Ember couldn't find the window on screen, so it can't tell what covers it");
      rect = at.rect;
      covers = coveringRects(stack!, at.index, rect, [seen.window?.pid ?? seen.x11Window?.pid, at.pid], own);
      if (uncoveredArea(rect, covers) <= 0.01 * rect.width * rect.height) return noShot("the window is covered by other windows");
    }
    const mask = await this.privateWindows(stack);
    if (mask === null) {
      // Can't tell where private windows are, so no screenshot (fail closed).
      this.o.log.warn("perception.capture_declined", { reason: "private windows could not be listed" });
      return noShot("Ember couldn't check for private windows");
    }
    const secrets = seen.nodes.filter(n => n.secret && n.bounds);
    const k = seen.axScale;
    // Before every picture the window's secret fields are looked for on their own too (in the app's own pixels): a
    // read can miss some, cut short or not. Without all of them there is no picture.
    let unread: { id: number; bounds: Bounds }[] = [];
    if (seen.window) {
      const more = await this.unreadSecrets(seen);
      if (typeof more === "string") return noShot(more);
      // The ones the read found are blacked out (and looked at again) already.
      const known = new Set(secrets.map(n => rectKey(n.bounds!)));
      unread = more.filter(f => !physical(f.bounds, k).some(b => known.has(rectKey(b))));
    }
    const blacked = [...mask, ...covers, ...shell.masks];
    let coveredAfter = false;
    const capture = await captureRect(x11, rect, {
      mask: [...blacked, ...secrets.map(n => pad(n.bounds!)), ...unread.flatMap(f => physical(f.bounds, k).map(pad))],
      // Windows can move or open, and fields scroll, while the picture is taken: black out where they are afterwards too.
      maskAfter: async () => {
        const now = this.stackNow();
        const priv = await this.privateWindows(now);
        if (priv === null) return null;
        const fields = [...await this.whereNow(secrets), ...await this.whereNow(unread, k)];
        if (seen.window) {
          // A secret field that appeared or scrolled in after the first look may be in the picture: the window is
          // looked through again now the pixels are taken, and without all of it there is no picture (as before it).
          const late = await this.unreadSecrets(seen);
          if (typeof late === "string") return null;
          const lateRects = late.flatMap(f => physical(f.bounds, k).map(pad));
          fields.push(...lateRects);
          blacked.push(...lateRects);
        }
        blacked.push(...priv);
        if (!windowScope) return [...priv, ...fields];
        const after = covering(now);
        if (after === null) return null; // the window is gone from the stack: no picture
        coveredAfter = after.length > 0;
        blacked.push(...after);
        return [...priv, ...fields, ...after];
      },
      hideOverlay: this.o.hideOverlay ? () => this.hideOverlay() : undefined,
      // No marks on what is blacked out (an element under another window can't be clicked either).
      overlaySvg: (scale, w, h, origin) => seen.nodes.length ? marksSvg(seen.nodes.filter(n => !n.bounds || !blacked.some(b => holds(b, n.bounds!))), origin, scale, w, h) : null,
    });
    if (!capture) return noShot("the window is off screen, or the screen couldn't be captured safely");
    const note = covers.length || coveredAfter ? "\n(Screenshot: parts covered by other windows are hidden.)" : "";
    return { ...seen, text: text + note, capture };
  }

  /**
   * Where these (secret) fields are now, padded; the ones that can't be read again keep their old place.
   * `k`: their bounds are as the app reports them, at this scale (both places are blacked out).
   */
  private async whereNow(fields: { id: number; bounds: Bounds | null }[], k = 1): Promise<Bounds[]> {
    const places = await Promise.all(fields.slice(0, MAX_SECRET_RECHECK).map(async n => {
      const now = await this.o.sidecar.readElement(n.id).catch(() => null);
      return physical(now?.bounds ?? n.bounds!, k).map(pad);
    }));
    return places.flat();
  }

  /**
   * The window's secret fields on screen, looked for on their own, or why they can't all be known (then no
   * picture is taken). A window without a process or path can't be looked through: then a complete read's own do.
   */
  private async unreadSecrets(seen: Seen): Promise<{ id: number; bounds: Bounds }[] | string> {
    const w = seen.window;
    const busy = "the app is busy, so Ember can't check it for password fields; try again in a moment";
    if (!w || w.pid == null || !w.path) {
      if (!seen.truncated && !seen.busy) return [];
      return seen.busy ? busy : "Ember couldn't check the whole window for password fields";
    }
    try {
      const r = await this.o.sidecar.secretFields({ pid: w.pid, path: w.path });
      if (r.complete) return r.fields;
      return r.busy ? busy : "the window is too big for Ember to check all of it for password fields in time; close what you don't need, or work in a smaller part of it";
    } catch (err) {
      this.o.log.warn("perception.secret_scan_failed", { err });
      return "Ember couldn't check the whole window for password fields";
    }
  }

  /**
   * GNOME Shell's dialogs and notifications now (a shell too busy to be looked through counts as a dialog;
   * best effort otherwise: nothing is known when the check fails, without GNOME Shell for one).
   */
  private async shellOverlays(): Promise<ReturnType<typeof shellCovers>> {
    try {
      const r = await this.o.sidecar.shellOverlays();
      return shellCovers(r.overlays, r.complete !== false);
    } catch (err) {
      this.o.log.warn("perception.shell_check_failed", { err });
      return shellCovers([]);
    }
  }

  /** Is a GNOME Shell system dialog (a polkit or keyring password prompt, most likely) on screen, or may one be? */
  async systemDialogOpen(): Promise<boolean> {
    return (await this.shellOverlays()).dialog;
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

  /** Visible windows (app, title, physical bounds), never-look ones (by app, title or X11 class) left out. */
  async windows(): Promise<AxWindow[]> {
    const { windows } = await this.o.sidecar.listWindows({ ownPid: this.ownPid });
    const list = this.o.neverLook().filter(i => i.trim());
    const stack = list.length || windows.some(w => w.bounds) ? this.stackNow() : null;
    const privatePids = new Set(list.length && stack ? stack.filter(s => s.pid != null && isNeverLook({ app: s.wmClass, name: "" }, list)).map(s => s.pid) : []);
    return windows.flatMap(w => {
      const m = stack && w.bounds ? matchFrame(w, stack) : null;
      if (isNeverLook(w, list) || (w.pid != null && privatePids.has(w.pid)) || (m && isNeverLook({ app: m.window.wmClass, name: m.window.title }, list))) return [];
      const k = w.bounds && stack ? this.frameScale(w, stack, m) : 1;
      return [k !== 1 ? { ...w, bounds: scaleBounds(w.bounds!, k) } : w];
    });
  }

  /**
   * Bounds of every visible window on the never-look list (blacked out in screenshots), whole
   * frames, title bars included. Both sources are used: X11 sees every top-level window (even apps
   * that expose nothing over accessibility, e.g. started before it was turned on), AT-SPI knows
   * app names. null means neither could be listed: the caller must not capture (fail closed)
   * while anything is on the never-look list.
   */
  async privateWindows(stack?: StackedWindow[] | null): Promise<Bounds[] | null> {
    const list = this.o.neverLook();
    if (!list.some(i => i.trim())) return [];
    const frame = (w: StackedWindow): Bounds => ({ x: w.x, y: w.y, width: w.width, height: w.height });
    let s: StackedWindow[] | null = null;
    let x11: Bounds[] | null = null;
    try {
      s = stack ?? (this.o.x11 ? this.o.x11.stack() : null);
      x11 = s && s.filter(w => isNeverLook({ app: w.wmClass, name: w.title }, list)).map(frame);
    } catch (err) {
      this.o.log.warn("perception.x11_windows_failed", { err });
    }
    let atspi: Bounds[] | null = null;
    try {
      const { windows } = await this.o.sidecar.listWindows({ ownPid: this.ownPid });
      atspi = windows.filter(w => w.bounds && isNeverLook(w, list)).map(w => {
        // Its X11 window when it can be found (the whole frame, in physical pixels), else its own report, scaled.
        const m = s && matchFrame(w, s);
        if (m) return frame(m.window);
        return scaleBounds(w.bounds!, this.scales.get(w.pid != null ? `pid:${w.pid}` : `title:${w.name}`)?.k ?? 1);
      });
    } catch (err) {
      this.o.log.warn("perception.atspi_windows_failed", { err });
    }
    if (x11 === null && atspi === null) return null;
    return [...(x11 ?? []), ...(atspi ?? [])];
  }
}

const BUSY_APP = "The app is busy and didn't answer (it may be loading something). Try again in a moment.";
const EMBERS_OWN = "The user is in one of Ember's own windows (the ask box or settings), not in an app; Ember doesn't read its own windows. If they mean an app, ask them to switch to it.";

const rectKey = (b: Bounds) => `${b.x},${b.y},${b.width},${b.height}`;

/** A secret field's rectangle, a little larger: its border and focus ring go too. */
const pad = (b: Bounds): Bounds => ({ x: b.x - 3, y: b.y - 3, width: b.width + 6, height: b.height + 6 });

/**
 * Where a rectangle an app reported may be on screen: at a scale other than 1 both as reported and
 * scaled (Chromium's pages report physical pixels inside a frame that reports logical ones).
 */
const physical = (b: Bounds, k: number): Bounds[] => (k === 1 ? [b] : [b, scaleBounds(b, k)]);

/** Is the middle of `r` inside `b`? */
const holds = (b: Bounds, r: Bounds) => {
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
};

/** The app's other windows (an Open dialog over the window read), for the header inside the <screen> wrapper. */
function othersLine(seen: Seen): string[] {
  if (!seen.others.length) return [];
  const list = seen.others.map(w => `${quoteUntrusted(w.name || "(untitled)", 80)} (${[screenWord(w.role), w.modal ? "modal" : "", w.active ? "the user is in it" : ""].filter(Boolean).join(", ")})`);
  return [`Also open in this app: ${list.join("; ")}. To work there, switch to it by its title.`];
}

/** What Ember says about a read that is incomplete (after the <screen> wrapper: these are Ember's words). */
function notes(seen: Seen): string {
  const out: string[] = [];
  if (seen.busy) out.push("(The app was busy and stopped answering partway, so this list may be incomplete. Try again in a moment.)");
  if (seen.truncated === "nodes") out.push(`(The window has more elements than Ember reads at once; only the first ${seen.nodes.length} are listed. Scroll to the part you need, open it, or work in a smaller window, then look again.)`);
  if (seen.truncated === "time") out.push("(Reading the window took too long, so only part of it is listed. Scroll to the part you need or close what you don't need, then look again.)");
  if (seen.truncated === "depth") out.push("(Part of the window is nested too deeply for Ember to read, so elements there are missing from this list. Use the screenshot for that part.)");
  return out.length ? `\n${out.join("\n")}` : "";
}
