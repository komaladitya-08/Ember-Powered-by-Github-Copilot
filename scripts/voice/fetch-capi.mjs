// Fetches sherpa-onnx's prebuilt C API for Linux x64 (CAPI_RELEASE in app/voice/models.ts: the release Ember's speech
// already pins, 1.13.8), checks the archive by SHA-256, unpacks it into .cache/voice/capi and checks each library Ember
// loads against its own SHA-256. The Linux packages carry those libraries (stage.mjs copies them from here into
// resources/voice-native, checked again); in development, run Ember on them with the folder it prints:
//   EMBER_SHERPA_CAPI=<folder> npm run dev
// They need GLIBC_2.17, GLIBCXX_3.4.19 and CXXABI_1.3.7, inside RHEL 8's limits (npm run check:symvers checks them).
// Downloading and unpacking are the app's own (app/voice/models.ts), as prepare.mjs does. A folder already in place is
// used only when every library in it matches its pin.
// usage: node scripts/voice/fetch-capi.mjs [dir]   (default dir: .cache/voice/capi)
import { build } from "esbuild";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
if (process.platform !== "linux" || process.arch !== "x64") { console.error("the C API is fetched for Linux x64 only (Windows and macOS use the addon)"); process.exit(1); }
const dir = path.resolve(process.argv[2] ?? path.join(root, ".cache/voice/capi"));
fs.mkdirSync(dir, { recursive: true });
const bundle = path.join(dir, "models.cjs");
await build({ entryPoints: [path.join(root, "app/voice/models.ts")], outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "error" });
const { CAPI_RELEASE, fetchModel, httpsDownloader } = createRequire(import.meta.url)(bundle);
const lib = path.join(dir, CAPI_RELEASE.target, "lib");
/** The libraries that don't match their pins (missing ones included). */
const wrong = () => Object.entries(CAPI_RELEASE.libs).filter(([f, sha]) => {
  try { return crypto.createHash("sha256").update(fs.readFileSync(path.join(lib, f))).digest("hex") !== sha; } catch { return true; }
}).map(([f]) => f);
if (wrong().length) await fetchModel(dir, CAPI_RELEASE, httpsDownloader);
const still = wrong();
if (still.length) { console.error(`${still.join(", ")} in ${CAPI_RELEASE.target} don't match their SHA-256 pins (app/voice/models.ts CAPI_RELEASE)`); process.exit(1); }
console.log(lib);
