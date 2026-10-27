/**
 * Puts every crash of Ember's own processes in ember.log (review #91): a GPU, utility or other child process that
 * went (Electron's app "child-process-gone"; a GPU process crashing over and over is the usual cause of blank or black
 * windows on VMs and remote desktops), and any page's renderer that went, named by its page, with Chromium's reason.
 * Recovery stays with each window (revive(), or closing a card's window); this only makes sure the log says what
 * happened. Takes Electron's app by injection, so it loads under plain Node.
 */

import type { Logger } from "./logger";

/** What Electron says about a child process that went (Details), as far as the log uses it. */
export interface ChildProcessGone {
  type: string;
  reason: string;
  exitCode: number;
  serviceName?: string;
  name?: string;
}

/** A page's web contents, as far as this watches it. */
export interface GoneContents {
  on(event: "render-process-gone", listener: (event: unknown, details: { reason: string; exitCode: number }) => void): unknown;
  getURL(): string;
}

/** Electron's app, as far as this watches it. */
export interface CrashSource {
  on(event: "child-process-gone", listener: (event: unknown, details: ChildProcessGone) => void): unknown;
  on(event: "web-contents-created", listener: (event: unknown, contents: GoneContents) => void): unknown;
}

/** The page's name ("home", "prompt", "command"…) from its URL: Ember's pages are renderer/<page>/index.html. */
export function pageName(url: string): string {
  const m = /\/renderer\/([a-z-]+)\/index\.html(?:[?#].*)?$/.exec(url.replace(/\\/g, "/"));
  return m ? m[1] : url.startsWith("file:") ? "file" : url ? "other" : "none";
}

/** Logs each crash `app` reports: child processes as app.child_process_gone, pages as window.renderer_gone. */
export function watchCrashes(app: CrashSource, log: Pick<Logger, "warn" | "error">): void {
  app.on("child-process-gone", (_e, d) => {
    // A clean exit is not a crash (a utility process Ember ended itself).
    if (d.reason === "clean-exit") return;
    log.error("app.child_process_gone", { type: d.type, reason: d.reason, exitCode: d.exitCode, ...(d.serviceName ? { service: d.serviceName } : {}), ...(d.name ? { name: d.name } : {}) });
  });
  app.on("web-contents-created", (_e, contents) => {
    contents.on("render-process-gone", (_g, d) => {
      let page = "none";
      try { page = pageName(contents.getURL()); } catch { /* a page that can't say where it was */ }
      log.warn("window.renderer_gone", { page, reason: d.reason, exitCode: d.exitCode });
    });
  });
}
