// Fetches the Node runtime archives Ember sends to computers it reaches over SSH (scripts/package/remote-runtime.json's
// pinned release), so packages can carry them (stage.mjs --with-runtimes) and a network-restricted PC never downloads
// one: each checked against the SHA-256 pinned there (models.ts's downloader: HTTPS_PROXY honoured, nothing kept that
// doesn't match), into .cache/remote-runtime. Only what Ember sends: .tar.xz for Linux (it has xz), .tar.gz for macOS
// (which has no xz program).
//   usage: node scripts/package/runtimes.mjs [dir]
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { RUNTIME_BUNDLE as BUNDLED } from "./layout.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = path.resolve(process.argv[2] ?? path.join(root, ".cache/remote-runtime"));
fs.mkdirSync(dir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(root, "scripts/package/remote-runtime.json"), "utf8"));


const bundle = path.join(dir, ".models.cjs");
await build({ entryPoints: [path.join(root, "app/voice/models.ts")], outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "error" });
const { fetchModel, httpsDownloader, sha256File } = createRequire(import.meta.url)(bundle);
for (const [target, format] of Object.entries(BUNDLED)) {
  const e = manifest.targets[target]?.[format];
  if (!e) throw new Error(`remote-runtime.json has no ${format} archive for ${target}`);
  const file = path.join(dir, e.file);
  if (fs.existsSync(file) && fs.statSync(file).size === e.bytes && (await sha256File(file)) === e.sha256) { console.log(`ok   ${e.file}`); continue; }
  await fetchModel(dir, { name: e.file, url: `https://nodejs.org/dist/v${manifest.pinned}/${e.file}`, sha256: e.sha256, kind: "file", target: e.file }, httpsDownloader);
  if (fs.statSync(file).size !== e.bytes) { fs.rmSync(file); throw new Error(`${e.file}: not the size pinned`); }
  console.log(`got  ${e.file}`);
}
fs.rmSync(bundle, { force: true });
console.log(`runtimes in ${dir}`);
