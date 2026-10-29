/**
 * Ember's own display settings in every page of its: Calm mode (html.calm, by which ember.css and each page's styles
 * stop springs, slides and pulses) and the text size (html[data-text-size], by which ember.css scales the type). The
 * overlay, the handle and the settings window are sent the settings, but the ask box, the command and prompt windows
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
/** The pages whose type keeps its size: the microphone's page, which shows no words. */
const FIXED_TYPE = new Set(["mic"]);

/**
 * How much the text grows at each size (ember.css's --text-scale): the windows sized for their words (the handle's
 * pill, the ask box, the desk view's bar, the command and prompt windows) grow by it too (review #57).
 */
const TEXT_SCALE: Readonly<Record<Settings["textSize"], number>> = { default: 1, large: 1.15, larger: 1.3 };

/** The text's scale for a text size (an unknown one is the default's, 1). */
export function textScale(size: Settings["textSize"] | undefined): number {
  return size !== undefined && TEXT_SIZES.includes(size) ? TEXT_SCALE[size] : 1;
}

/**
 * A window's size for the text size: each length times `scale`, rounded, but no larger than `room` (the work area)
 * where that is smaller; never smaller than the usual size, so the default size is exactly as before.
 */
export function scaledSize<T extends Record<string, number>>(size: T, scale: number, room?: { width: number; height: number }): T {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(size)) {
    const max = room ? (/width/i.test(k) ? room.width : room.height) : Infinity;
    out[k] = Math.max(v, Math.min(Math.round(v * scale), max));
  }
  return out as T;
}

type Bounds = { x: number; y: number; width: number; height: number };

/**
 * Where an open window goes when the text's scale changes from `from` to `to`: its size times to / from (a size the user
 * chose keeps its proportion, and back at the default the usual size is exact again), at least `least`, inside `area`
 * (its display's work area), centred where it was.
 */
export function rescaledBounds(now: Bounds, from: number, to: number, area: Bounds, least = { width: 1, height: 1 }): Bounds {
  const grow = (v: number, lo: number, room: number) => Math.min(Math.max(Math.round((v * to) / from), lo), room);
  const width = grow(now.width, least.width, area.width);
  const height = grow(now.height, least.height, area.height);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return {
    x: clamp(Math.round(now.x + (now.width - width) / 2), area.x, area.x + area.width - width),
    y: clamp(Math.round(now.y + (now.height - height) / 2), area.y, area.y + area.height - height),
    width,
    height,
  };
}

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
