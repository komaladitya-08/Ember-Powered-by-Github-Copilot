/**
 * Ember's own display settings in every page of its: Calm mode (html.calm, by which ember.css and each page's styles
 * stop springs, slides and pulses). The overlay, the handle and the settings window set it themselves from the
 * settings they are sent, but the Ask box, the command and prompt windows and the desk view are sent none, so main
 * applies it to each page of Ember's as the page loads and again whenever the setting changes (review #248). Plain
 * Node: a page comes in structurally, and only Ember's own bundled pages are touched.
 */

import type { Settings } from "./settings";

/** What a page shows differently by Ember's settings. */
export interface PagePrefs {
  calm: boolean;
}

/** The display settings to apply, from Ember's settings. */
export function pagePrefs(s: Pick<Settings, "reduceMotion">): PagePrefs {
  return { calm: s.reduceMotion === true };
}

/**
 * Which of Ember's pages a URL is ("command" for …/renderer/command/index.html), or null for anything else. File URLs
 * use "/" on every OS (as isTrustedSender in windows.ts expects).
 */
export function pageOf(url: string): string | null {
  if (!url.startsWith("file://")) return null;
  const m = /\/renderer\/([a-z]+)\/index\.html$/.exec(decodeURIComponent(url.split(/[?#]/)[0]));
  return m ? m[1] : null;
}

/** The code that applies `prefs` to a page: built from a boolean only, never from text that came from anywhere. */
export function prefsScript(prefs: PagePrefs, _page: string): string {
  return `document.documentElement.classList.toggle("calm", ${prefs.calm ? "true" : "false"});`;
}

/** A page as Electron's webContents has it. */
export interface PrefsPage {
  isDestroyed(): boolean;
  getURL(): string;
  executeJavaScript(code: string): Promise<unknown>;
}

/**
 * Applies `prefs` to `page` when it is one of Ember's own pages; true when it did. A window that has gone is
 * skipped, and a page that went away during the call is no error (it gets them again as it loads).
 */
export async function applyPagePrefs(page: PrefsPage, prefs: PagePrefs): Promise<boolean> {
  if (page.isDestroyed()) return false;
  const name = pageOf(page.getURL());
  if (!name) return false;
  try {
    await page.executeJavaScript(prefsScript(prefs, name));
    return true;
  } catch {
    // Navigated or closed meanwhile: its next load applies them (dom-ready in main.ts).
    return false;
  }
}
