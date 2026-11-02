/**
 * Device pixels for the floating pages (overlay, handle, Ask): what keeps them crisp at 100 %, 125 % and 150 % scaling.
 * A whole CSS px is half a device pixel at 150 %, so things that move are placed on device pixels (snapToDevice in
 * @ember/bubble), hairlines are one device pixel (`--dpx` on the page's root, read by ember.css's --glass-hairline), and
 * a canvas's backing store is a whole number of device pixels with its CSS size derived from it (else it is resampled).
 * The scale changes without a resize event when a window moves to another monitor or the desktop's scale changes, so
 * it is watched with a `resolution` media query.
 */

/** A canvas `css` px wide at `dpr`: its backing store (whole device pixels) and the CSS size that maps it 1:1. */
export function canvasSize(css: number, dpr: number): { backing: number; css: number } {
  const s = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const backing = Math.max(1, Math.ceil(css * s - 1e-6));
  return { backing, css: backing / s };
}

/** One device pixel in CSS px (the `--dpx` hairline). */
export function devicePixel(dpr: number): number {
  return 1 / (dpr > 0 && Number.isFinite(dpr) ? dpr : 1);
}

/**
 * Sets `--dpx` on the page's root now and whenever the scale changes, and calls `onChange` with the new scale (to size
 * canvases again and redraw).
 */
export function watchPixels(onChange: (dpr: number) => void = () => {}): void {
  let query: MediaQueryList | null = null;
  const apply = (): void => {
    const dpr = window.devicePixelRatio || 1;
    document.documentElement.style.setProperty("--dpx", `${devicePixel(dpr)}px`);
    query?.removeEventListener("change", apply);
    query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    query.addEventListener("change", apply);
    onChange(dpr);
  };
  apply();
}
