// Stages Ember as a self-contained Linux app folder, the input for the RPM and the AppImage:
//   dist/package/ember/            Electron, renamed to "ember", with chrome-sandbox
//     THIRD_PARTY_NOTICES          the licences of everything bundled (beside Electron's LICENSE
//                                  and LICENSES.chromium.html)
//     resources/app/               package.json, LICENSE, dist/app (the built app), production node_modules
//     resources/sidecar/atspi/     the accessibility sidecar (run by the system Python)
//   dist/package/voice-models/     the speech models, trimmed to the files Ember loads (if downloaded and verified)
// Only linux-x64 glibc builds are kept (no musl, no wasm fallbacks). Licence and notice files always are.
// usage: node scripts/package/stage.mjs   (after npm run build)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const out = path.join(root, "dist/package");
const app = path.join(out, "ember");
const resources = path.join(app, "resources");
const rel = p => path.relative(root, p);

if (!fs.existsSync(path.join(root, "dist/app/main.cjs"))) throw new Error("build the app first (npm run build)");

// The production packages to bundle: Linux x64 glibc builds only.
// tslib is only @emnapi's (sharp's wasm fallback).
const SKIP = [/linuxmusl/, /@img[\\/]sharp-wasm32/, /@emnapi/, /node_modules[\\/]tslib$/];
const prod = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: root, encoding: "utf8" })
  .trim().split("\n").filter(p => p !== root && !SKIP.some(r => r.test(p)));
// The RPM's License: tag must name every bundled package's licence (checked before anything is staged).
const licenseOf = src => {
  const p = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
  return { p, lic: typeof p.license === "string" ? p.license : (p.licenses ?? []).map(l => l.type ?? l).join(" OR ") };
};
const spdx = expr => String(expr ?? "").split(/\s+(?:AND|OR|WITH)\s+|[()\s]+/).filter(Boolean);
const specLicense = spdx(/^License:\s*(.+)$/m.exec(fs.readFileSync(path.join(root, "packaging/rpm/ember.spec"), "utf8"))?.[1]);
const uncovered = prod.flatMap(src => {
  const { p, lic } = licenseOf(src);
  return (spdx(lic).length ? spdx(lic) : ["(none)"]).filter(id => !specLicense.includes(id)).map(id => `${p.name} (${id})`);
});
if (uncovered.length) throw new Error(`packaging/rpm/ember.spec "License:" doesn't cover ${uncovered.join(", ")}: add the licence there`);

// Only this script's folders are replaced; built packages beside them stay until rebuilt.
for (const d of ["ember", "voice-models"]) fs.rmSync(path.join(out, d), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1. Electron itself, as "ember". Requiring the package downloads the binary if npm ci didn't.
const electronDist = path.dirname(createRequire(import.meta.url)("electron"));
fs.cpSync(electronDist, app, { recursive: true, verbatimSymlinks: true });
fs.renameSync(path.join(app, "electron"), path.join(app, "ember"));
fs.rmSync(path.join(resources, "default_app.asar"), { force: true });

// 2. The app: its package.json, the build, and production dependencies only.
const appDir = path.join(resources, "app");
fs.mkdirSync(appDir, { recursive: true });
const { name, version, description, license, author, main } = pkg;
fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name, productName: "Ember", version, description, license, author, main, type: pkg.type, dependencies: pkg.dependencies }, null, 2) + "\n");
fs.copyFileSync(path.join(root, "LICENSE"), path.join(appDir, "LICENSE"));
fs.cpSync(path.join(root, "dist/app"), path.join(appDir, "dist/app"), {
  recursive: true,
  filter: src => !src.endsWith(".map"), // source maps stay out of the package
});

// Licence and notice files are how the licences are met: they always ship. libvips's LGPL notice is in its README.
const NOTICE = /^(licen[cs]es?|copying|notices?|copyrightnotice|third[-_]?party[-_]?notices)([-._].*)?$/i;
const isNotice = (pkgDir, rel) => NOTICE.test(path.basename(rel)) || (/@img[\\/]sharp-libvips-/.test(pkgDir) && rel === "README.md");
for (const src of prod) {
  const dest = path.join(appDir, path.relative(root, src));
  fs.cpSync(src, dest, {
    recursive: true,
    filter: s => {
      const r = path.relative(src, s);
      // Nested node_modules are copied on their own.
      if (/(^|[\\/])node_modules([\\/]|$)/.test(r)) return false;
      if (isNotice(src, r)) return true;
      // Docs, tests and type declarations aren't needed at run time.
      return !/(^|[\\/])(test|tests|docs?|examples?|\.github)([\\/]|$)/i.test(r) && !/\.(md|d\.ts|d\.cts|d\.mts|map)$/i.test(r);
    },
  });
}
// koffi ships prebuilt binaries for other platforms: keep linux x64 glibc only (it picks the build by the libc it runs on).
const koffiBuilds = path.join(appDir, "node_modules/koffi/build/koffi");
if (fs.existsSync(koffiBuilds)) {
  for (const d of fs.readdirSync(koffiBuilds)) if (d !== "linux_x64") fs.rmSync(path.join(koffiBuilds, d), { recursive: true, force: true });
}
fs.rmSync(path.join(appDir, "node_modules/@koromix/koffi-linux-x64/musl_x64"), { recursive: true, force: true });
// The Copilot runtime's helpers for its own built-in tools (search, browser plugin, skills). Ember's sessions
// turn every built-in tool off (app/main/agent/session-config.ts), and the runtime runs without them
// (checked: the conductor integration test against a runtime pruned like this).
for (const d of ["ripgrep", "tgrep", "plugins", "builtin-skills"]) {
  fs.rmSync(path.join(appDir, "node_modules/@github/copilot-sdk-linux-x64", d), { recursive: true, force: true });
}

// 3. The accessibility sidecar (main.ts looks for it under resources/ when packaged).
fs.mkdirSync(path.join(resources, "sidecar/atspi"), { recursive: true });
fs.copyFileSync(path.join(root, "sidecar/atspi/ember_atspi.py"), path.join(resources, "sidecar/atspi/ember_atspi.py"));

// 4. Speech models (optional sub-package): only when every model is in place and verified (its marker
//    holds the SHA-256 it's pinned to), and only the files Ember loads (no partial downloads).
const models = path.join(root, ".cache/voice/models");
const VOICE_MODELS = await voiceModels();
const verified = m => {
  try { return fs.readFileSync(path.join(models, `.${m.target}.ok`), "utf8").trim() === m.sha256 && fs.existsSync(path.join(models, m.target)); } catch { return false; }
};
const unverified = VOICE_MODELS.filter(m => !verified(m));
if (fs.existsSync(models) && unverified.length) {
  console.log(`speech models not bundled: ${unverified.map(m => m.target).join(", ")} missing or not verified (run node scripts/voice/prepare.mjs)`);
}
if (!unverified.length) {
  const dest = path.join(out, "voice-models");
  // Each pinned model and its marker; nothing else in the folder (an interrupted download, an older model).
  for (const m of VOICE_MODELS) {
    fs.cpSync(path.join(models, m.target), path.join(dest, m.target), {
      recursive: true,
      filter: s => {
        const b = path.basename(s);
        if (/^\.download-|\.part$/.test(b)) return false;
        if (/test_wavs|^bpe\.model$/.test(b)) return false;
        // The keyword spotter loads the int8 encoder and joiner and the float decoder.
        if (/^(encoder|joiner)-epoch.*\d\.onnx$/.test(b) && !b.includes("int8")) return false;
        if (/^decoder-epoch.*int8\.onnx$/.test(b)) return false;
        return true;
      },
    });
    fs.copyFileSync(path.join(models, `.${m.target}.ok`), path.join(dest, `.${m.target}.ok`));
  }
  fs.writeFileSync(path.join(dest, "NOTICE"), "Ember's offline speech models, as published by the k2-fsa/sherpa-onnx project.\n\n"
    + VOICE_MODELS.map(m => `${m.name}: ${m.target}\n  licence ${m.license}; from ${m.url}`).join("\n") + "\n");
}

// 5. Licences: every bundled package's licence and notices, beside Electron's (LICENSE, LICENSES.chromium.html).
const sections = prod.map(src => {
  const { p, lic } = licenseOf(src);
  const files = fs.readdirSync(src).filter(f => isNotice(src, f) && fs.statSync(path.join(src, f)).isFile()).sort();
  return [`${p.name} ${p.version}: ${lic}`, ...(files.length
    ? files.map(f => `--- ${f} ---\n${fs.readFileSync(path.join(src, f), "utf8").trim()}`)
    : ["(no licence file in the package; its package.json gives the licence above)"])].join("\n\n");
});
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, "node_modules/electron/package.json"), "utf8")).version;
fs.writeFileSync(path.join(app, "THIRD_PARTY_NOTICES"), [
  `Ember ${version}: ${license}. The licences of everything Ember bundles follow.`,
  `--- Ember's LICENSE ---\n${fs.readFileSync(path.join(root, "LICENSE"), "utf8").trim()}`,
  `Electron ${electronVersion}: MIT (LICENSE beside this file). Chromium and the libraries in it, among them FFmpeg\n(LGPL-2.1-or-later): LICENSES.chromium.html beside this file.`,
  ...sections,
].join(`\n\n${"=".repeat(78)}\n\n`) + "\n");

/** The pinned speech models (app/voice/models.ts), bundled for Node. */
async function voiceModels() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-stage-"));
  try {
    const outfile = path.join(tmp, "models.cjs");
    await build({ entryPoints: [path.join(root, "app/voice/models.ts")], outfile, bundle: true, platform: "node", format: "cjs", logLevel: "error" });
    return createRequire(import.meta.url)(outfile).VOICE_MODELS;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const du = p => execFileSync("du", ["-sh", p], { encoding: "utf8" }).split("\t")[0];
console.log(`staged ${rel(app)} (${du(app)}): Ember ${version}, Electron ${electronVersion}`);
console.log(`  production modules: ${prod.map(p => path.relative(path.join(root, "node_modules"), p)).join(", ")}`);
if (fs.existsSync(path.join(out, "voice-models"))) console.log(`staged ${rel(path.join(out, "voice-models"))} (${du(path.join(out, "voice-models"))})`);
else if (!fs.existsSync(models)) console.log("no speech models in .cache/voice (run scripts/voice/prepare.mjs to include them)");
