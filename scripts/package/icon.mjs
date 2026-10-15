// Renders Ember's SVG icon to a PNG. usage: node scripts/package/icon.mjs <in.svg> <out.png> <size>
import { createRequire } from "node:module";
const sharp = createRequire(import.meta.url)("sharp");
const [, , input, output, size = "256"] = process.argv;
await sharp(input, { density: 384 }).resize(Number(size), Number(size)).png().toFile(output);
