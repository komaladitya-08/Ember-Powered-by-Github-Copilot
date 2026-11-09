/**
 * How long Home waits before drawing its characters again (pure, so it is unit-tested: home-frame-gap.test.ts). Home
 * often sits open behind the apps the user works in, and its hero kept breathing and blinking there about 10 times a
 * second, a few percent of a core with no GPU (rp-4). In a window the user isn't working in, a still face now isn't
 * drawn again until something changes: the window taking the focus, the pointer coming over it, the window showing,
 * another section.
 */

/**
 * The gap in ms before the next frame, or null to draw nothing until something changes. `motion`: 0 something moves
 * quickly or the pointer is about, 1 a calm face, 2 every face shown still. `focused`: the window the user is working
 * in (document.hasFocus()): every frame, ~30 fps or ~15 (a still face waits longer still: restingGap); otherwise less
 * often, and a still face not at all.
 */
export function homeFrameGap(motion: 0 | 1 | 2, focused: boolean): number | null {
  if (focused) return [0, 33, 66][motion];
  return motion === 2 ? null : [33, 66][motion];
}
