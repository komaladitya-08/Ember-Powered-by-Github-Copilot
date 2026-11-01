/**
 * vitest's global setup: draws one mark's worth of text with sharp before any test runs. The first text sharp draws on
 * a computer builds fontconfig's cache of the system's fonts; on a fresh Windows runner that took longer than a test's
 * 15 s (ci.yml run 141, remote.yml run 15: the tests that draw Ember's marks timed out), and milliseconds after, in
 * every process (the cache is on disk).
 */

import sharp from "sharp";

export default async function setup(): Promise<void> {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><text x="1" y="12" font-family="DejaVu Sans, sans-serif" font-size="11" font-weight="700">1</text></svg>';
  try {
    await sharp({ create: { width: 16, height: 16, channels: 3, background: "#ffffff" } }).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  } catch {
    // Best effort: a test that draws text says what failed.
  }
}
