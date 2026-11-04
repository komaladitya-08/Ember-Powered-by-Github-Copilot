// The source a release carries for the GPL part of Ember's voice (GNU GPL version 3, section 6; docs/DEVELOPING.md §15).
// sherpa-onnx's text-to-speech holds eSpeak NG, so whoever offers Ember's packages offers this source beside them, and
// doesn't depend on another person's repository staying up. CI's release job runs it before release.mjs:
//   node scripts/package/gpl-source.mjs <folder>
// Each archive is fetched from the URL packaging/licences/sherpa-onnx*.txt names and refused unless its SHA-256 matches.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** What to attach: `file` is its name in the release. Bumping sherpa-onnx means pinning its new sources here. */
export const GPL_SOURCES = [
  {
    file: "source-sherpa-onnx-1.13.8.zip",
    url: "https://github.com/k2-fsa/sherpa-onnx/archive/11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf.zip",
    sha256: "1e546178d875fae6e74ffd9aa15a13546b9a4a13d0c90c60524ca5022a113edf",
  },
  {
    file: "source-espeak-ng-ed530aa.zip",
    url: "https://github.com/csukuangfj/espeak-ng/archive/ed530aa113046142eb5115cf2fc9157854d0ffe1.zip",
    sha256: "e4e262cbe34f7fe21f91f1ba3397f2728e1f30eafbae7853f2b753a9ed13f0dd",
  },
  {
    file: "source-piper-phonemize-f3ff95a.zip",
    url: "https://github.com/csukuangfj/piper-phonemize/archive/f3ff95afc03640bc1399e113e83361192a2fafb4.zip",
    sha256: "d9cca4e2bdc7d6dd8dffb96a4668283dbd3f77a9c194a3e530c1e8eba9406a5d",
  },
];

/**
 * Writes `bytes` as `source.file` in `dir`, or throws, writing nothing, when they aren't what is pinned.
 * @param {string} dir
 * @param {{ file: string; sha256: string }} source
 * @param {Uint8Array} bytes
 */
export function keepVerified(dir, source, bytes) {
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== source.sha256) throw new Error(`${source.file}: SHA-256 ${got}, expected ${source.sha256}`);
  fs.writeFileSync(path.join(dir, source.file), bytes);
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: node scripts/package/gpl-source.mjs <folder>");
  for (const source of GPL_SOURCES) {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`${source.url}: status ${response.status}`);
    keepVerified(dir, source, new Uint8Array(await response.arrayBuffer()));
    console.log(`kept ${source.file}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}
