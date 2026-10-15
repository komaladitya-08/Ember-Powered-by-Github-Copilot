// Stages Ember as a self-contained Linux app folder, the input for the RPM and the AppImage:
//   dist/package/ember/            Electron, renamed to "ember", with chrome-sandbox
//     resources/app/               package.json, dist/app (the built app), production node_modules
//     resources/sidecar/atspi/     the accessibility sidecar (run by the system Python)
//   dist/package/voice-models/     the speech models, trimmed to the files Ember loads (if downloaded)
// Only linux-x64 glibc builds are kept (no musl, no wasm fallbacks).
// usage: node scripts/package/stage.mjs   (after npm run build)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const out = path.join(root, "dist/package");
const app = path.join(out, "ember");
const resources = path.join(app, "resources");
const rel = p => path.relative(root, p);

if (!fs.existsSync(path.join(root, "dist/app/main.cjs"))) throw new Error("build the app first (npm run build)");
// Only this script's folders are replaced; built packages beside them stay until rebuilt.
for (const d of ["ember", "voice-models"]) fs.rmSync(path.join(out, d), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1. Electron itself, as "ember".
const electronDist = path.join(root, "node_modules/electron/dist");
fs.cpSync(electronDist, app, { recursive: true, verbatimSymlinks: true });
fs.renameSync(path.join(app, "electron"), path.join(app, "ember"));
fs.rmSync(path.join(resources, "default_app.asar"), { force: true });

// 2. The app: its package.json, the build, and production dependencies only.
const appDir = path.join(resources, "app");
fs.mkdirSync(appDir, { recursive: true });
const { name, version, description, license, author, main } = pkg;
fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name, productName: "Ember", version, description, license, author, main, type: pkg.type, dependencies: pkg.dependencies }, null, 2) + "\n");
fs.cpSync(path.join(root, "dist/app"), path.join(appDir, "dist/app"), {
  recursive: true,
  filter: src => !src.endsWith(".map"), // source maps stay out of the package
});

const SKIP = [/linuxmusl/, /@img[\\/]sharp-wasm32/, /@emnapi/];
const prod = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: root, encoding: "utf8" })
  .trim().split("\n").filter(p => p !== root && !SKIP.some(r => r.test(p)));
for (const src of prod) {
  const dest = path.join(appDir, path.relative(root, src));
  fs.cpSync(src, dest, {
    recursive: true,
    filter: s => {
      const r = path.relative(src, s);
      // Docs, tests and type declarations aren't needed at run time; nested node_modules are copied on their own.
      return !/(^|[\\/])(test|tests|docs?|examples?|\.github)([\\/]|$)/i.test(r) && !/\.(md|d\.ts|d\.cts|d\.mts|map)$/i.test(r) && !/(^|[\\/])node_modules([\\/]|$)/.test(r);
    },
  });
}
// koffi ships prebuilt binaries for every platform: keep linux x64 only.
const koffiBuilds = path.join(appDir, "node_modules/koffi/build/koffi");
if (fs.existsSync(koffiBuilds)) {
  for (const d of fs.readdirSync(koffiBuilds)) if (d !== "linux_x64") fs.rmSync(path.join(koffiBuilds, d), { recursive: true, force: true });
}

// 3. The accessibility sidecar (main.ts looks for it under resources/ when packaged).
fs.mkdirSync(path.join(resources, "sidecar/atspi"), { recursive: true });
fs.copyFileSync(path.join(root, "sidecar/atspi/ember_atspi.py"), path.join(resources, "sidecar/atspi/ember_atspi.py"));

// 4. Speech models (optional sub-package): only the files Ember loads.
const models = path.join(root, ".cache/voice/models");
if (fs.existsSync(path.join(models, ".silero_vad.onnx.ok"))) {
  const dest = path.join(out, "voice-models");
  fs.cpSync(models, dest, {
    recursive: true,
    filter: s => {
      const b = path.basename(s);
      if (/test_wavs|^bpe\.model$/.test(b)) return false;
      // The keyword spotter loads the int8 encoder and joiner and the float decoder.
      if (/^(encoder|joiner)-epoch.*\d\.onnx$/.test(b) && !b.includes("int8")) return false;
      if (/^decoder-epoch.*int8\.onnx$/.test(b)) return false;
      return true;
    },
  });
}

const du = p => execFileSync("du", ["-sh", p], { encoding: "utf8" }).split("\t")[0];
console.log(`staged ${rel(app)} (${du(app)}): Ember ${version}, Electron ${JSON.parse(fs.readFileSync(path.join(root, "node_modules/electron/package.json"), "utf8")).version}`);
console.log(`  production modules: ${prod.map(p => path.relative(path.join(root, "node_modules"), p)).join(", ")}`);
if (fs.existsSync(path.join(out, "voice-models"))) console.log(`staged ${rel(path.join(out, "voice-models"))} (${du(path.join(out, "voice-models"))})`);
else console.log("no speech models in .cache/voice (run scripts/voice/prepare.mjs to include them)");
