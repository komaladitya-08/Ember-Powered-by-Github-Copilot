// Loads sherpa-onnx's C API libraries from a folder with koffi, as app/voice/capi.ts does (onnxruntime first), and
// prints the library's version: an installed Ember's native speech loads on this system's own libraries. CI's package
// job runs it with the installed binary as plain Node, on rockylinux:8. It loads the koffi Ember ships beside the
// folder (resources/app/node_modules/koffi) when there is one.
// usage: ELECTRON_RUN_AS_NODE=1 /opt/ember/ember test/smoke/capi-load.mjs <voice-native folder>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const dir = process.argv[2];
if (!dir) { console.error("usage: capi-load.mjs <voice-native folder>"); process.exit(2); }
const require = createRequire(import.meta.url);
const shipped = path.resolve(dir, "..", "app", "node_modules", "koffi");
const koffi = require(fs.existsSync(shipped) ? shipped : "koffi");
koffi.load(path.join(dir, "libonnxruntime.so"));
const lib = koffi.load(path.join(dir, "libsherpa-onnx-c-api.so"));
const version = lib.func("const char *SherpaOnnxGetVersionStr()");
console.log(`sherpa-onnx ${version()}`);
