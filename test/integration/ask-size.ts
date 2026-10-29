/**
 * The Ask box at a text size (review #57), shared by the live suites: handle-menu-live on Xvfb (RHEL 8 CI) and
 * ember-win32 and ember-darwin on real Windows and macOS runners, so the steps those runners take are the ones the X
 * server's run proves. Text size is set through Ember's own settings (its test hooks, EMBER_TEST_HOOKS), the box is
 * opened as the handle's menu opens it, and its window and its page are read: the window's size (ask.ts askSize: 560 × 92
 * at the default size, 644 × 101 at Large, 728 × 111 at Larger, each further row 24 px times the scale: a line of the
 * field, the note that a paste was cut, the tip to wait for the box on Windows' and macOS's first openings), the page's
 * text size and its field's type, whether the line under the field is cut off, and the room left below the box's foot.
 */

/** Runs `fn` in Ember's main process, given Electron's modules and `arg` (Playwright's evaluate). */
export type InEmber = <T, A>(fn: (electron: typeof import("electron"), arg: A) => T | Promise<T>, arg: A) => Promise<T>;

export type TextSize = "default" | "large" | "larger";

/** What each text size gives: its scale (page-prefs.ts textScale), the box one row tall (DIP), and its field's type. */
export const ASK_AT: Readonly<Record<TextSize, { scale: number; width: number; height: number; font: string }>> = {
  default: { scale: 1, width: 560, height: 92, font: "18px" },
  large: { scale: 1.15, width: 644, height: 101, font: "20.7px" },
  larger: { scale: 1.3, width: 728, height: 111, font: "23.4px" },
};

/** The box's height at `size` with `rows` rows (the field's lines, the note's, the tip's). */
export const askHeight = (size: TextSize, rows = 1): number => ASK_AT[size].height + Math.round((rows - 1) * 24 * ASK_AT[size].scale);

/** What the box showed: its window (DIP) and its page. */
export interface AskSeen {
  visible: boolean;
  width: number;
  height: number;
  /** The page's text size (html[data-text-size]; "default" without it). */
  size: string;
  /** The field's type (its computed font size). */
  font: string;
  /** Whether the tip to wait for the box shows (Windows' and macOS's first openings; never on Linux). */
  tip: boolean;
  /** Whether the line under the field is cut off. */
  clipped: boolean;
  /** From the foot of what the box shows to its window's bottom edge, in px. */
  room: number;
  /** The display's scale factor and work area, to tell a rounding or a small screen from a box that didn't grow. */
  scaleFactor: number;
  workArea: { x: number; y: number; width: number; height: number };
}

/** What the box must be at `size` with only its field's one line (and the tip's row while it shows). */
export function askWant(size: TextSize, tip: boolean): Pick<AskSeen, "visible" | "width" | "height" | "size" | "font" | "clipped"> {
  const at = ASK_AT[size];
  return { visible: true, width: at.width, height: askHeight(size, tip ? 2 : 1), size, font: at.font, clipped: false };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const askVisible = (inEmber: InEmber) => inEmber(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.getTitle() === "Ask Ember" && w.isVisible()), null);

/** Sets Text size as Settings does (every page follows it; the box from its next opening). */
export async function setTextSize(inEmber: InEmber, size: TextSize): Promise<void> {
  await inEmber((_e, s: TextSize) => (globalThis as unknown as { __ember: { settings: { update(p: object): void } } }).__ember.settings.update({ textSize: s }), size);
}

/**
 * Sets Text size to `size`, opens the box as the handle's menu does (it fails after 5 s if the box doesn't show), puts
 * `text` in its field once it is up, and reads the box.
 */
export async function openAskAt(inEmber: InEmber, size: TextSize, text = ""): Promise<AskSeen> {
  await setTextSize(inEmber, size);
  await sleep(300);
  await inEmber(() => (globalThis as unknown as { __ember: { showAsk(): void } }).__ember.showAsk(), null);
  for (let t = 0; !(await askVisible(inEmber)); t++) {
    if (t >= 50) throw new Error(`the Ask box didn't show within 5 s at text size ${size}`);
    await sleep(100);
  }
  await sleep(800);
  return inEmber(async ({ BrowserWindow, screen }, t: string): Promise<AskSeen> => {
    const w = BrowserWindow.getAllWindows().find(x => x.getTitle() === "Ask Ember")!;
    await w.webContents.executeJavaScript(`{ const q = document.getElementById("q"); q.value = ${JSON.stringify(t)}; q.dispatchEvent(new Event("input")); }`);
    await new Promise(r => setTimeout(r, 400));
    const page = await w.webContents.executeJavaScript(`(() => {
      const meta = document.querySelector(".meta"), form = document.getElementById("form");
      const foot = Math.max(...[...form.children].filter(e => getComputedStyle(e).display !== "none").map(e => e.getBoundingClientRect().bottom));
      return { size: document.documentElement.dataset.textSize ?? "default", font: getComputedStyle(document.getElementById("q")).fontSize,
        tip: document.getElementById("tip").hidden === false,
        clipped: meta.scrollHeight > meta.clientHeight + 0.5 || meta.scrollWidth > meta.clientWidth, room: innerHeight - foot };
    })()`) as Pick<AskSeen, "size" | "font" | "tip" | "clipped" | "room">;
    const bounds = w.getBounds();
    const display = screen.getDisplayMatching(bounds);
    return { visible: w.isVisible(), width: bounds.width, height: bounds.height, ...page, scaleFactor: display.scaleFactor, workArea: display.workArea };
  }, text);
}

/** Puts the box away as Esc does (its page's own close), else hides its window; never throws (for a finally). */
export async function closeAsk(inEmber: InEmber): Promise<void> {
  try {
    await inEmber(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find(x => x.getTitle() === "Ask Ember");
      if (w?.isVisible()) await w.webContents.executeJavaScript("window.emberAsk.close()");
    }, null);
    for (let t = 0; t < 20 && (await askVisible(inEmber)); t++) await sleep(100);
    await inEmber(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.getTitle() === "Ask Ember" && w.isVisible()) w.hide(); }, null);
  } catch {
    // Ember is gone or never started: nothing to put away
  }
}
