// Bundles demo/playground into one self-contained HTML file: dist/ember-playground.html
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const dir = new URL("demo/playground/", root);

const { outputFiles } = await build({
  entryPoints: [new URL("main.ts", dir).pathname],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  write: false,
});

const js = outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = await readFile(new URL("styles.css", dir), "utf8");
const html = (await readFile(new URL("index.html", dir), "utf8"))
  .replace("/*@style*/", () => css)
  .replace("/*@script*/", () => js);

await mkdir(new URL("dist/", root), { recursive: true });
const out = new URL("dist/ember-playground.html", root);
await writeFile(out, html);
console.log(`wrote ${out.pathname} (${(html.length / 1024).toFixed(1)} KB)`);
