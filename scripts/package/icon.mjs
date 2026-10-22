// Renders Ember's SVG icon with sharp: one PNG (the RPM, the AppImage), a Windows .ico (PNG-compressed entries,
// written here because sharp can't write ICO), or a macOS .iconset folder for iconutil. The container format is a
// pure function so it can be tested on any OS; sharp is loaded only to render.
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

/** sharp, loaded on first use (importing this module for its pure functions needs no native code). */
const sharp = () => createRequire(import.meta.url)("sharp");

/** The SVG as a square PNG of `size` pixels (density 384, so the larger sizes stay sharp). */
const render = (svg, size) => sharp()(svg, { density: 384 }).resize(size, size).png();

/** Writes Ember's .ico, rendered from the SVG. */
export async function writeIco(svg, out) {
  const images = [];
  for (const size of ICO_SIZES) images.push({ size, png: await render(svg, size).toBuffer() });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, icoFromPngs(images));
}

/** Writes an .iconset folder (for `iconutil -c icns`), rendered from the SVG. */
export async function writeIconset(svg, dir) {
  if (!dir.endsWith(".iconset")) throw new Error(`iconutil needs the folder's name to end in .iconset: ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const { name, size } of ICONSET) await render(svg, size).toFile(path.join(dir, name));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "--ico" && rest.length === 2) await writeIco(rest[0], rest[1]);
  else if (mode === "--iconset" && rest.length === 2) await writeIconset(rest[0], rest[1]);
  else if (mode && !mode.startsWith("--") && rest.length >= 1) {
    const [output, size = "256"] = rest;
    await render(mode, Number(size)).toFile(output);
  } else {
    console.error("usage: node scripts/package/icon.mjs <in.svg> <out.png> <size> | --ico <in.svg> <out.ico> | --iconset <in.svg> <out.iconset>");
    process.exit(2);
  }
}
