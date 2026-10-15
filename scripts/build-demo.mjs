// Bundles one demo (demo/<name>/{index.html,styles.css,main.ts}) into a single
// self-contained HTML file: dist/<name>.html
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const name = process.argv[2];
if (!name) throw new Error("usage: node scripts/build-demo.mjs <demo-name>");
const root = new URL("../", import.meta.url);
const dir = new URL(`demo/${name}/`, root);

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
const out = new URL(`dist/ember-${name}.html`, root);
await writeFile(out, html);
console.log(`wrote ${out.pathname} (${(html.length / 1024).toFixed(1)} KB)`);
