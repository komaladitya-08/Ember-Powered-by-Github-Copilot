// Renders Ember's SVG icon with sharp: one PNG (the RPM, the AppImage, the Linux windows' icon the build writes), a
// Windows .ico (PNG-compressed entries, written here because sharp can't write ICO), or a macOS .iconset folder for
// iconutil. 32 px and below come from the small artwork beside the SVG (ember-small.svg). The container format and
// which artwork each size uses are pure functions so they can be tested on any OS; sharp is loaded only to render.
// usage: node scripts/package/icon.mjs <in.svg> <out.png> <size>
//        node scripts/package/icon.mjs --ico <in.svg> <out.ico>
//        node scripts/package/icon.mjs --iconset <in.svg> <out.iconset>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** The sizes in Ember's .ico: Explorer, the taskbar and shortcuts pick from these (256 is the largest ICO allows). */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** The images an .iconset holds (iconutil's names): 16 to 512 points, each at 1x and 2x. */
export const ICONSET = [16, 32, 128, 256, 512].flatMap(points => [
  { name: `icon_${points}x${points}.png`, size: points },
  { name: `icon_${points}x${points}@2x.png`, size: points * 2 },
]);

/**
 * An .ico file holding PNG images: a 6-byte ICONDIR, one 16-byte entry per image, then the PNGs. Width and height
 * are one byte each, so 256 is written as 0 (as the format says).
 * @param {{ size: number; png: Buffer }[]} images
 */
export function icoFromPngs(images) {
  if (!images.length) throw new Error("an .ico needs at least one image");
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1: icon (2 would be a cursor)
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    if (!Number.isInteger(size) || size < 1 || size > 256) throw new Error(`an .ico image is 1 to 256 pixels, not ${size}`);
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0); // width
    e.writeUInt8(size === 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // no palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map(i => i.png)]);
}

/** Images this size and smaller are drawn from the small artwork: the full icon's detail turns to mud there (review #247). */
export const SMALL_MAX = 32;

/**
 * The small artwork beside an icon's SVG (ember.svg: ember-small.svg), or null when there is none.
 * @param {string} svg
 * @param {(file: string) => boolean} [exists]
 */
export function smallArtFor(svg, exists = fs.existsSync) {
  const small = svg.replace(/\.svg$/i, "-small.svg");
  return small !== svg && exists(small) ? small : null;
}

/**
 * How one image of an icon set is drawn: from the full icon, or (SMALL_MAX and below) from the small artwork. Windows
 * draws small icons to the canvas's edge; macOS keeps every size on Apple's grid, so in an iconset the small tile is
 * inset by the full icon's own margin (12 of 128) and lines up with the large sizes.
 * @param {number} size
 * @param {"ico" | "iconset"} kind
 * @returns {{ art: "full" | "small"; inset: number }}
 */
export function drawPlan(size, kind) {
  if (size > SMALL_MAX) return { art: "full", inset: 0 };
  return { art: "small", inset: kind === "iconset" ? Math.floor((size * 12) / 128) : 0 };
}

/** sharp, loaded on first use (importing this module for its pure functions needs no native code). */
const sharp = () => createRequire(import.meta.url)("sharp");

/** The SVG as a square PNG of `size` pixels (density 384, so the larger sizes stay sharp). */
const render = (svg, size) => sharp()(svg, { density: 384 }).resize(size, size).png();

/** One image of an icon set as a PNG, drawn as drawPlan says (the full icon when there is no small artwork). */
async function renderFor(svg, size, kind) {
  const plan = drawPlan(size, kind);
  const small = plan.art === "small" ? smallArtFor(svg) : null;
  if (!small) return render(svg, size).toBuffer();
  const d = plan.inset;
  const tile = await render(small, size - 2 * d).toBuffer();
  if (!d) return tile;
  return sharp()(tile).extend({ top: d, bottom: d, left: d, right: d, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

/** Writes Ember's .ico, rendered from the SVG (and its small artwork). */
export async function writeIco(svg, out) {
  const images = [];
  for (const size of ICO_SIZES) images.push({ size, png: await renderFor(svg, size, "ico") });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, icoFromPngs(images));
}

/** Writes an .iconset folder (for `iconutil -c icns`), rendered from the SVG (and its small artwork). */
export async function writeIconset(svg, dir) {
  if (!dir.endsWith(".iconset")) throw new Error(`iconutil needs the folder's name to end in .iconset: ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const { name, size } of ICONSET) fs.writeFileSync(path.join(dir, name), await renderFor(svg, size, "iconset"));
}

/** Writes the SVG as one square PNG of `size` pixels (the RPM's and AppImage's icon, the Linux windows' icon). */
export async function writePng(svg, out, size) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await render(svg, size).toFile(out);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "--ico" && rest.length === 2) await writeIco(rest[0], rest[1]);
  else if (mode === "--iconset" && rest.length === 2) await writeIconset(rest[0], rest[1]);
  else if (mode && !mode.startsWith("--") && rest.length >= 1) {
    const [output, size = "256"] = rest;
    await writePng(mode, output, Number(size));
  } else {
    console.error("usage: node scripts/package/icon.mjs <in.svg> <out.png> <size> | --ico <in.svg> <out.ico> | --iconset <in.svg> <out.iconset>");
    process.exit(2);
  }
}
