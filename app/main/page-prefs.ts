/**
 * Ember's own display settings in every page of its: Calm mode (html.calm, by which ember.css and each page's styles
 * stop springs, slides and pulses) and the text size (html[data-text-size], by which ember.css scales the type). The
 * overlay, the handle and the settings window are sent the settings, but the Ask box, the command and prompt windows
 * and the desk view are sent none, so main applies both to each page of Ember's as the page loads and again whenever
 * they change (review #248, #57). Plain Node: a page comes in structurally, and only Ember's own bundled pages are
 * touched.
 */

import type { Settings } from "./settings";

/** What a page shows differently by Ember's settings. */
export interface PagePrefs {
  calm: boolean;
  textSize: Settings["textSize"];
}

const TEXT_SIZES: readonly Settings["textSize"][] = ["default", "large", "larger"];
/**
 * The pages whose type keeps its size: the Ask box (a 92 px window whose field is already 18 px) and the desk view's
 * 30 px bar. Their windows can't grow with their words.
 */
const FIXED_TYPE = new Set(["ask", "desk", "mic"]);

/** The display settings to apply, from Ember's settings (an unknown text size is the default). */
export function pagePrefs(s: Pick<Settings, "reduceMotion" | "textSize">): PagePrefs {
  return { calm: s.reduceMotion === true, textSize: TEXT_SIZES.includes(s.textSize) ? s.textSize : "default" };
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

/**
 * The code that applies `prefs` to `page`: built from a boolean and one of the three sizes only, never from text that
 * came from anywhere.
 */
export function prefsScript(prefs: PagePrefs, page: string): string {
  const size = FIXED_TYPE.has(page) ? "default" : TEXT_SIZES.find(t => t === prefs.textSize) ?? "default";
  return `document.documentElement.classList.toggle("calm", ${prefs.calm ? "true" : "false"});`
    + (size === "default" ? ` delete document.documentElement.dataset.textSize;` : ` document.documentElement.dataset.textSize = "${size}";`);
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
