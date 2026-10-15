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
    const t0 = Date.now();
    const x11Window = this.o.x11?.activeWindow() ?? null;
    let res = await this.o.sidecar.readWindow(x11Window?.pid ? { pid: x11Window.pid } : {});
    if (!res.window && x11Window?.title) res = await this.o.sidecar.readWindow({ title: x11Window.title });
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
  async perceive(opts: { image: boolean; scope: "window" | "screen" }): Promise<Perceived> {
    const seen = await this.focused();
    const text = seen.blocked
      ? "This window is on the user's never-look list. Do not interact with it; tell the conductor."
      : seen.window ? serializeElements(seen.window, seen.nodes, { withBounds: true }) : "The focused window exposes no accessibility information; use the screenshot.";
    let capture: Capture | null = null;
    if (opts.image && this.o.x11 && !seen.blocked) {
      const rect = opts.scope === "window" && (seen.window?.bounds || seen.x11Window)
        ? (seen.window?.bounds ?? { x: seen.x11Window!.x, y: seen.x11Window!.y, width: seen.x11Window!.width, height: seen.x11Window!.height })
        : this.o.screenBounds();
      const mask = await this.privateWindows();
      capture = await captureRect(this.o.x11, rect, {
        mask,
        hideOverlay: this.o.hideOverlay,
        overlaySvg: (scale, w, h) => seen.nodes.length ? marksSvg(seen.nodes, rect, scale, w, h) : null,
      });
    }
    return { ...seen, text, capture };
  }

  /** Bounds of every visible window on the never-look list (blacked out in screenshots). */
  private async privateWindows(): Promise<Bounds[]> {
    try {
      const { windows } = await this.o.sidecar.listWindows();
      return windows.filter(w => w.bounds && isNeverLook(w, this.o.neverLook())).map(w => w.bounds!);
    } catch {
      return [];
    }
  }
}
