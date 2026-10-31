/**
 * First run's Start row stays at the settings window's foot while the page scrolls under it (styles.css), so whatever
 * takes keyboard focus scrolls clear of it by the page's scroll padding (WCAG 2.4.11). How tall the row is depends on
 * its words: the text size, the window's width and its zoom wrap them onto more lines (96 px at Default in a wide
 * window, 176 px at Larger in the narrowest, more when zoomed in), so a fixed padding fell short. The row's own height
 * is kept on the page's root as --start-row-h, which the padding adds the row's gap to. Pure and renderer-safe: the
 * observer is passed in, so the tests drive a fake one.
 */

/** What the browser's ResizeObserver is, as far as followStartRow needs it. */
export type SizeWatch = new (report: (entries: ResizeObserverEntry[]) => void) => { observe(target: Element): void };

/** The page's root element, as far as followStartRow writes to it. */
export interface StyleRoot {
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): string };
}

/** The row's height as the stylesheet takes it (whole px, rounded up, so the padding is never short), or null when not drawn. */
export function startRowHeight(px: number): string | null {
  return Number.isFinite(px) && px > 0 ? `${Math.ceil(px)}px` : null;
}

/**
 * Keeps `row`'s height (its border box) on `root` as --start-row-h whenever it changes size. Hidden or not yet laid out,
 * the property goes, and the stylesheet's own length (scaled by the text size) applies.
 */
export function followStartRow(row: Element, root: StyleRoot, Watch: SizeWatch = ResizeObserver): void {
  new Watch(entries => {
    const h = startRowHeight(entries.at(-1)?.borderBoxSize?.[0]?.blockSize ?? Number.NaN);
    if (h) root.style.setProperty("--start-row-h", h);
    else root.style.removeProperty("--start-row-h");
  }).observe(row);
}
