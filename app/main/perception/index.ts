/**
 * Perception: what is on the user's screen, as text (always) and as an image
 * (for workers, on request). Text comes from the accessibility tree via the
 * sidecar; images come straight from X11 with Ember hidden and private
 * windows blacked out.
 */

import { captureRect, type Capture } from "./capture";
import { marksSvg } from "./marks";
import { focusedElement, isNeverLook, serializeElements, inferLabels } from "./elements";
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
    const blocked = !!window && isNeverLook(window, this.o.neverLook())
      || (!window && !!x11Window && isNeverLook({ app: "", name: x11Window.title }, this.o.neverLook()));
    return { window, x11Window, nodes: blocked ? [] : res.nodes, blocked, ms: Date.now() - t0 };
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
    const title = seen.window?.name || seen.x11Window?.title || "an unknown window";
    if (seen.blocked) return `The user is in "${title}", which is on their "never look at" list. Do not read or describe it.`;
    if (!seen.window) return `The focused window is "${title}", but it does not expose accessibility information, so its contents can't be read as text.`;
    const focus = focusedElement(seen.nodes);
    const labels = inferLabels(seen.nodes);
    const focusLine = focus ? `Focused element: [${focus.id}] ${focus.role} "${focus.name || labels.get(focus.id) || ""}".` : "No element has keyboard focus.";
    return [`The user is in ${seen.window.app || "an application"}, window "${title}". ${focusLine}`, serializeElements(seen.window, seen.nodes, { maxLines: 120 })].join("\n");
  }

  /** For workers: elements with bounds, plus an optional marked screenshot. */
  async perceive(opts: { image: boolean; scope: "window" | "screen"; target?: WindowTarget }): Promise<Perceived> {
    const seen = opts.target ? await this.read(opts.target) : await this.focused();
    const text = seen.blocked
      ? "This window is on the user's never-look list. Do not interact with it; tell the conductor."
      : seen.window ? serializeElements(seen.window, seen.nodes, { withBounds: true }) : "The focused window exposes no accessibility information; use the screenshot.";
    let capture: Capture | null = null;
    if (opts.image && this.o.x11 && !seen.blocked) {
      const rect = opts.scope === "window" && (seen.window?.bounds || seen.x11Window)
        ? (seen.window?.bounds ?? { x: seen.x11Window!.x, y: seen.x11Window!.y, width: seen.x11Window!.width, height: seen.x11Window!.height })
        : this.o.screenBounds();
      const mask = await this.privateWindows();
      if (mask === null) {
        // Can't tell where private windows are, so no screenshot (fail closed).
        this.o.log.warn("perception.capture_declined", { reason: "private windows could not be listed" });
        return { ...seen, text: `${text}\n(No screenshot: Ember couldn't check for private windows.)`, capture: null };
      }
      capture = await captureRect(this.o.x11, rect, {
        mask,
        hideOverlay: this.o.hideOverlay,
        overlaySvg: (scale, w, h) => seen.nodes.length ? marksSvg(seen.nodes, rect, scale, w, h) : null,
      });
    }
    return { ...seen, text, capture };
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
