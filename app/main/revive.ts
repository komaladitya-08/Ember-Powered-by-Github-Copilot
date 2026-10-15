/**
 * Brings back a window whose page crashed: reloaded after half a second, then more slowly each
 * time it crashes again soon after (up to a minute), so a page that crashes on load doesn't spin.
 */

import type { BrowserWindow } from "electron";

export function revive(win: BrowserWindow, onGone?: (reason: string) => void): void {
  let delay = 500;
  let lastLoad = 0;
  let lastCrash = 0;
  win.webContents.on("did-finish-load", () => { lastLoad = Date.now(); });
  win.webContents.on("render-process-gone", (_e, details) => {
    // A load that finished after the last crash, then a minute of running fine, starts the count again
    // (a page that crashes while loading never finishes one, so it keeps slowing down).
    const now = Date.now();
    if (lastLoad > lastCrash && now - lastLoad > 60_000) delay = 500;
    lastCrash = now;
    onGone?.(details.reason);
    const wait = delay;
    delay = Math.min(delay * 2, 60_000);
    setTimeout(() => { if (!win.isDestroyed()) win.webContents.reload(); }, wait);
  });
}
