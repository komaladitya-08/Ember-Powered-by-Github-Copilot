/**
 * Ember's icon at small sizes and on Linux windows (review #247). The full icon (assets/ember.svg) is a 104 px tile on
 * a 128 px canvas with a baked shadow: at 16 px it was a 13 px graphite square with Cinder a brown smudge, nearly gone
 * on a dark taskbar. 16, 24 and 32 px now come from assets/ember-small.svg: to the canvas's edge in the Windows .ico,
 * on Apple's grid in the macOS iconset. Linux windows carry dist/app/ember.png, which the build renders from the SVG.
 * The renders use sharp, as packaging does.
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ICO_SIZES, drawPlan, smallArtFor, writeIco, writeIconset, writePng } from "../../scripts/package/icon.mjs";

const SVG = path.resolve("assets/ember.svg");
const SMALL = path.resolve("assets/ember-small.svg");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-icon-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The images an .ico holds: each directory entry's size and the PNG it points at. */
function icoImages(ico: Buffer): { size: number; png: Buffer }[] {
  return Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
    const e = 6 + 16 * i;
    const size = ico.readUInt8(e) || 256;
    return { size, png: ico.subarray(ico.readUInt32LE(e + 12), ico.readUInt32LE(e + 12) + ico.readUInt32LE(e + 8)) };
  });
}

/** A PNG's width, its opaque pixels' bounding box width, and how much of the canvas is opaque (alpha > 200). */
async function opaque(png: Buffer): Promise<{ width: number; box: number; share: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0, min = info.width, max = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 200) { n++; min = Math.min(min, x); max = Math.max(max, x); }
    }
  }
  return { width: info.width, box: max - min + 1, share: n / (info.width * info.height) };
}

/** WCAG relative luminance of an sRGB colour (0-255 channels). */
const luminance = (r: number, g: number, b: number) => {
  const c = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};

/** The contrast between the icon's outer pixels, laid on a dark taskbar (#202020), and the taskbar. */
async function edgeContrastOnDark(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).flatten({ background: "#202020" }).raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  let sum = 0, n = 0;
  for (let i = 0; i < w; i++) {
    for (const [x, y] of [[i, 0], [i, w - 1], [0, i], [w - 1, i]]) {
      const p = (y * w + x) * info.channels;
      sum += luminance(data[p], data[p + 1], data[p + 2]); n++;
    }
  }
  const edge = sum / n, bar = luminance(0x20, 0x20, 0x20);
  return (Math.max(edge, bar) + 0.05) / (Math.min(edge, bar) + 0.05);
}

describe("Ember's icon at small sizes (review #247)", () => {
  it("draws 32 px and below from the small artwork: to the edge on Windows, on Apple's grid on macOS", () => {
    for (const size of [16, 24, 32]) expect(drawPlan(size, "ico")).toEqual({ art: "small", inset: 0 });
    for (const size of [48, 64, 128, 256]) expect(drawPlan(size, "ico")).toEqual({ art: "full", inset: 0 });
    // ember.svg's own margin (12 of 128) at that size, so the small tile lines up with the large ones in Finder.
    expect(drawPlan(16, "iconset")).toEqual({ art: "small", inset: 1 });
    expect(drawPlan(32, "iconset")).toEqual({ art: "small", inset: 3 });
    expect(drawPlan(64, "iconset")).toEqual({ art: "full", inset: 0 });
  });

  it("finds the small artwork beside the icon, and does without when there is none", () => {
    expect(smallArtFor(SVG)).toBe(SMALL);
    expect(smallArtFor(path.join(tmp, "other.svg"))).toBeNull();
  });

  it("fills the .ico's 16, 24 and 32 px images and keeps their edge visible on a dark taskbar", async () => {
    const out = path.join(tmp, "ember.ico");
    await writeIco(SVG, out);
    const images = icoImages(fs.readFileSync(out));
    expect(images.map(i => i.size)).toEqual(ICO_SIZES);
    for (const { size, png } of images.filter(i => i.size <= 32)) {
      const o = await opaque(png);
      expect(o.width).toBe(size);
      expect(o.share).toBeGreaterThan(0.9);
      expect(await edgeContrastOnDark(png)).toBeGreaterThan(1.5);
    }
    // The large sizes are the full icon, as before.
    const big = await opaque(images.find(i => i.size === 256)!.png);
    expect(big.box).toBeLessThan(220);
  });

  it("puts the small artwork on Apple's grid in the iconset's 16 and 32 px images", async () => {
    const dir = path.join(tmp, "ember.iconset");
    await writeIconset(SVG, dir);
    const box = async (name: string) => (await opaque(fs.readFileSync(path.join(dir, name)))).box;
    expect(await box("icon_16x16.png")).toBe(14);
    expect(await box("icon_32x32.png")).toBe(26);
    expect(await box("icon_16x16@2x.png")).toBe(26);
  });

  it("renders the PNG Linux windows carry", async () => {
    const out = path.join(tmp, "ember.png");
    await writePng(SVG, out, 256);
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 256, 256]);
  });
});
