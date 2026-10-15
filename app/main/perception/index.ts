/**
 * Perception: what is on the user's screen, as text (always) and as an image
 * (for workers, on request). Text comes from the accessibility tree via the
 * sidecar; images come straight from X11 with Ember hidden and private
 * windows blacked out.
 */

import { isSecurityWindow } from "../policy/policy";
import { captureRect, type Capture } from "./capture";
import { marksSvg } from "./marks";
import { focusedElement, isNeverLook, isSecretNode, serializeElements, inferLabels, quoteUntrusted, screenWord } from "./elements";
import type { AtspiSidecar, AxNode, AxWindow, Bounds } from "./sidecar";
import type { X11, X11Window } from "../x11";
import type { Logger } from "../logger";

export interface PerceptionOptions {
  sidecar: AtspiSidecar;
  x11: X11 | null;
  neverLook: () => string[];
  /** Full screen in physical pixels (all displays). */
  screenBounds: () => Bounds;
  hideOverlay?: () => Promise<() => void>;
  log: Logger;
}

export interface WindowTarget { pid?: number; title?: string }

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
}

export interface Perceived extends Seen {
  text: string;
  capture: Capture | null;
}

export class Perception {
  /** The overlay hide in progress: concurrent captures share it, and Ember shows again when the last one is done. */
  private hidden: { count: number; restore: Promise<() => void> } | null = null;

  constructor(private o: PerceptionOptions) {}

  /** The focused window's accessibility tree (empty when blocked or unreadable). */
  async focused(): Promise<Seen> {
    const x11Window = this.o.x11?.activeWindow() ?? null;
    return this.read(x11Window ? { pid: x11Window.pid ?? undefined, title: x11Window.title } : {}, x11Window);
  }

  /** A specific window's tree: by title (most precise), else by pid, else the active one. */
  async read(target: WindowTarget, x11Window: X11Window | null = null): Promise<Seen> {
    const t0 = Date.now();
    let res = target.title ? await this.o.sidecar.readWindow({ title: target.title }) : { window: null, nodes: [] as AxNode[], ms: 0 };
    if (!res.window) res = await this.o.sidecar.readWindow(target.pid ? { pid: target.pid } : {});
    const window = res.window;
    // Never-look apps, and password or authentication prompts (polkit, keyring…): Ember looks away (M8.3).
    const blocked = !!window && (isNeverLook(window, this.o.neverLook()) || isSecurityWindow(window))
      || (!window && !!x11Window && (isNeverLook({ app: "", name: x11Window.title }, this.o.neverLook()) || isSecurityWindow(x11Window)));
    if (!blocked) return { window, x11Window, nodes: res.nodes, blocked, ms: Date.now() - t0 };
    // A private window's title goes no further than this (not to the model, not to the logs).
    return { window: window && { ...window, name: "" }, x11Window: x11Window && { ...x11Window, title: "" }, nodes: [], blocked, ms: Date.now() - t0 };
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
    const target = { pid, title, app };
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

  /** For workers: elements with bounds, plus an optional marked screenshot. */
  async perceive(opts: { image: boolean; scope: "window" | "screen"; target?: WindowTarget }): Promise<Perceived> {
    const seen = opts.target ? await this.read(opts.target) : await this.focused();
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
    const rect = opts.scope === "window" && (seen.window?.bounds || seen.x11Window)
      ? (seen.window?.bounds ?? { x: seen.x11Window!.x, y: seen.x11Window!.y, width: seen.x11Window!.width, height: seen.x11Window!.height })
      : this.o.screenBounds();
    const mask = await this.privateWindows();
    if (mask === null) {
      // Can't tell where private windows are, so no screenshot (fail closed).
      this.o.log.warn("perception.capture_declined", { reason: "private windows could not be listed" });
      return noShot("Ember couldn't check for private windows");
    }
    const capture = await captureRect(x11, rect, {
      mask,
      // A private window can move or open while the picture is taken: black out where they are afterwards too.
      maskAfter: () => this.privateWindows(),
      hideOverlay: this.o.hideOverlay ? () => this.hideOverlay() : undefined,
      overlaySvg: (scale, w, h, origin) => seen.nodes.length ? marksSvg(seen.nodes, origin, scale, w, h) : null,
    });
    if (!capture) return noShot("the window is off screen, or the screen couldn't be captured safely");
    return { ...seen, text, capture };
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

  /** Visible windows (app and title), never-look ones left out. */
  async windows(): Promise<AxWindow[]> {
    const { windows } = await this.o.sidecar.listWindows();
    return windows.filter(w => !isNeverLook(w, this.o.neverLook()));
  }

  /** Bounds of every visible window on the never-look list (blacked out in screenshots). */
  /**
   * Both sources are used: X11 sees every top-level window (even apps that expose
   * nothing over accessibility, e.g. started before it was turned on), AT-SPI
   * knows app names. null means neither could be listed: the caller must not
   * capture (fail closed) while anything is on the never-look list.
   */
  async privateWindows(): Promise<Bounds[] | null> {
    const list = this.o.neverLook();
    if (!list.some(i => i.trim())) return [];
    let x11: Bounds[] | null = null;
    try {
      x11 = (this.o.x11?.clientWindows() ?? [])
        .filter(w => isNeverLook({ app: w.wmClass, name: w.title }, list))
        .map(w => ({ x: w.x, y: w.y, width: w.width, height: w.height }));
      if (!this.o.x11) x11 = null;
    } catch (err) {
      this.o.log.warn("perception.x11_windows_failed", { err });
    }
    let atspi: Bounds[] | null = null;
    try {
      const { windows } = await this.o.sidecar.listWindows();
      atspi = windows.filter(w => w.bounds && isNeverLook(w, list)).map(w => w.bounds!);
    } catch (err) {
      this.o.log.warn("perception.atspi_windows_failed", { err });
    }
    if (x11 === null && atspi === null) return null;
    return [...(x11 ?? []), ...(atspi ?? [])];
  }
}
