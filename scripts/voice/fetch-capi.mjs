// Fetches sherpa-onnx's prebuilt C API for Linux x64 (the release Ember's speech already pins, 1.13.8), checks it by
// SHA-256 and unpacks it into .cache/voice/capi, for native speech in development (app/voice/capi.ts). Its libraries
// need GLIBC_2.17, GLIBCXX_3.4.19 and CXXABI_1.3.7, inside RHEL 8's limits. Downloading and unpacking are the app's own
// (app/voice/models.ts), as prepare.mjs does. Then run Ember with the folder it prints:
//   EMBER_SHERPA_CAPI=<folder> npm run dev
// usage: node scripts/voice/fetch-capi.mjs [dir]   (default dir: .cache/voice/capi)
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VERSION = "1.13.8";
const RELEASE = {
  name: `sherpa-onnx ${VERSION} C API (Linux x64)`, kind: "tar.bz2", target: `sherpa-onnx-v${VERSION}-linux-x64-shared`,
  url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}/sherpa-onnx-v${VERSION}-linux-x64-shared.tar.bz2`,
  sha256: "c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4",
};
if (process.platform !== "linux" || process.arch !== "x64") { console.error("the C API is fetched for Linux x64 only (Windows and macOS use the addon)"); process.exit(1); }
const dir = path.resolve(process.argv[2] ?? path.join(root, ".cache/voice/capi"));
fs.mkdirSync(dir, { recursive: true });
const bundle = path.join(dir, "models.cjs");
await build({ entryPoints: [path.join(root, "app/voice/models.ts")], outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "error" });
const { fetchModel, httpsDownloader } = createRequire(import.meta.url)(bundle);
const lib = path.join(dir, RELEASE.target, "lib");
if (!fs.existsSync(path.join(lib, "libsherpa-onnx-c-api.so"))) await fetchModel(dir, RELEASE, httpsDownloader);
console.log(lib);
