/**
 * The Linux overlay shaper: Ember's floating windows take clicks only inside the rectangles they report, through the
 * X Shape extension's input region (xshape.ts, unchanged), so a press on Allow is the overlay's even before hover
 * polling has run. Electron-free (overlay.ts uses it as its default, and its tests run under plain Node).
 */

import { closeInputShape, setInputShape } from "../../xshape";
import type { FloatingKind, FloatingWindow, OverlayShaper } from "../types";
import { x11WindowId } from "./window-system";

/** Today's window options and setVisibleOnAllWorkspaces calls, exactly (overlay.ts and handle.ts made them). */
const LINUX_FLOATING: Readonly<Record<FloatingKind, FloatingWindow>> = {
  overlay: { options: {}, allWorkspaces: { visibleOnFullScreen: true } },
  handle: { options: {}, allWorkspaces: "plain" },
  ask: { options: {}, allWorkspaces: null },
  "desk-view": { options: {}, allWorkspaces: null },
};

/** XShape input regions; click-through windows call setIgnoreMouseEvents(true) with no options, as they always have. */
export function linuxOverlayShaper(): OverlayShaper {
  return {
    setInputRegion: (win, rects, scale) => {
      const xid = x11WindowId(win);
      return xid ? setInputShape(xid, rects, scale) : false;
    },
    release: () => closeInputShape(),
    forward: false,
    floating: kind => {
      const f = LINUX_FLOATING[kind];
      return { options: {}, allWorkspaces: f.allWorkspaces && typeof f.allWorkspaces === "object" ? { ...f.allWorkspaces } : f.allWorkspaces };
    },
  };
}
