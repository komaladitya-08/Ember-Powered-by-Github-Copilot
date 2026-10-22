// Stages Ember as a self-contained app folder for the OS this runs on (layout.mjs describes each target):
//   Linux (the input for the RPM and the AppImage; unchanged):
//     dist/package/ember/            Electron, renamed to "ember", with chrome-sandbox
//       THIRD_PARTY_NOTICES          the licences of everything bundled (beside Electron's LICENSE
//                                    and LICENSES.chromium.html)
//       resources/app/               package.json, LICENSE, dist/app (the built app), production node_modules
//       resources/sidecar/atspi/     the accessibility sidecar (run by the system Python)
//     dist/package/voice-models/     the speech models, trimmed to the files Ember loads (if downloaded and verified)
//   Windows: dist/package/Ember/      Ember.exe (electron.exe renamed, with Ember's version resource and icon and no
//                                     certificate table: exe-resources.mjs), the same notices and resources/app, the
//                                     UI Automation bridge in resources/sidecar/uia, resources/ember.ico
//   macOS:   dist/package/Ember.app   Electron.app renamed, its executable Contents/MacOS/Ember; notices, licences
//                                     and app/ in Contents/Resources; Info.plist edited, the icon, signed ad hoc
//                                     last (mac-bundle.mjs)
// Only the target's own platform builds are kept (no musl, no wasm fallbacks, no other OS). Licence and notice files
// always are. The staged binary's fuses are set as Ember ships them (fuses.mjs: no --inspect, no NODE_OPTIONS).
// Every file the target needs must exist, or nothing is staged; --allow-missing-sidecar stages without the
// accessibility host (dist/app/ax-sidecar.cjs) and the UIA bridge (sidecar/uia), an Ember that can't read apps, for a
// local try only: CI never passes it.
// Speech models ship beside the Linux app (an RPM sub-package); on Windows and macOS only with --with-models.
// usage: node scripts/package/stage.mjs [--allow-missing-sidecar] [--with-models]   (after npm run build)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { specLicenceIds, uncoveredLicences } from "./licences.mjs";
import { EMBER_FUSES, flipFuses, fuseMismatches } from "./fuses.mjs";
import { layoutFor, npmInvocation, prodPackageDirs, selectPackages } from "./layout.mjs";
import { writeIco, writeIconset } from "./icon.mjs";
import { exeResourceMismatches, readExeResources, rewriteExeResources } from "./exe-resources.mjs";
import { finishMacBundle } from "./mac-bundle.mjs";

const FLAGS = ["--allow-missing-sidecar", "--with-models"];
const flags = process.argv.slice(2);
const unknown = flags.filter(f => !FLAGS.includes(f));
if (unknown.length) { console.error(`unknown option ${unknown[0]}\nusage: node scripts/package/stage.mjs [${FLAGS.join("] [")}]`); process.exit(2); }
const allowMissingSidecar = flags.includes("--allow-missing-sidecar");
const withModels = flags.includes("--with-models");

const layout = layoutFor(process.platform, process.arch);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const out = path.join(root, "dist/package");
const app = path.join(out, layout.appDir);
const resources = path.join(app, layout.resourcesDir);
const rel = p => path.relative(root, p);
/** What --allow-missing-sidecar let through, said again at the end. */
const notStaged = [];

// The built app: main.cjs, its windows, and the helpers it starts beside itself (Linux: desk-agent.cjs, run as
// plain Node; Windows and macOS: ax-sidecar.cjs, the accessibility host, likewise).
const builtMissing = f => {
  const p = path.join(root, "dist/app", f);
  return f.endsWith("/") ? !fs.existsSync(p) || !fs.readdirSync(p).length : !fs.existsSync(p);
};
for (const f of layout.requiredDist.filter(builtMissing)) {
  if (!layout.sidecarDist.includes(f)) throw new Error(`build the app first (npm run build): dist/app/${f} is missing`);
  if (!allowMissingSidecar) throw new Error(`build the app first (npm run build): dist/app/${f} is missing (the accessibility host; --allow-missing-sidecar stages without it)`);
  notStaged.push(`dist/app/${f}`);
}
const sidecars = layout.sidecarFiles.filter(s => {
  if (fs.existsSync(path.join(root, s.from))) return true;
  if (!allowMissingSidecar) throw new Error(`${s.from} is missing (--allow-missing-sidecar stages without it)`);
  notStaged.push(s.from);
  return false;
});

// The production packages to bundle: the target's own platform builds only (layout.mjs).
const npm = npmInvocation({ platform: process.platform, execPath: process.execPath, npmExecPath: process.env.npm_execpath }, ["ls", "--omit=dev", "--all", "--parseable"]);
const { bundle: prod, missing } = selectPackages(prodPackageDirs(execFileSync(npm.file, npm.args, { cwd: root, encoding: "utf8", shell: npm.shell }), root, path), layout);
if (missing.length) throw new Error(`${missing.join(", ")} not installed: stage on a ${layout.target} machine after npm ci (npm installs only the host's platform packages)`);
// The RPM's License: tag must name every bundled package's licence, and those of the libraries a package
// says it bundles (sharp-libvips and sharp's Windows builds, in their README.md): checked before anything is
// staged (licences.mjs). It is the one list of licences Ember ships under, on every target.
const licenseOf = src => {
  const p = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
  return { p, lic: typeof p.license === "string" ? p.license : (p.licenses ?? []).map(l => l.type ?? l).join(" OR ") };
};
const uncovered = uncoveredLicences(prod.map(src => {
  const { p, lic } = licenseOf(src);
  const readme = path.join(src, "README.md");
  return { name: p.name, license: lic, readme: fs.existsSync(readme) ? fs.readFileSync(readme, "utf8") : null };
}), specLicenceIds(fs.readFileSync(path.join(root, "packaging/rpm/ember.spec"), "utf8")));
if (uncovered.length) throw new Error(`packaging/rpm/ember.spec "License:" doesn't cover ${uncovered.join(", ")}: add the licence there`);

// The speech models to bundle. Linux: a sub-package beside the app; Windows and macOS: inside the app with
// --with-models (otherwise Ember downloads them when "Hey Ember" is turned on).
const models = path.join(root, ".cache/voice/models");
const VOICE_MODELS = await voiceModels();
const verified = m => {
  try { return fs.readFileSync(path.join(models, `.${m.target}.ok`), "utf8").trim() === m.sha256 && fs.existsSync(path.join(models, m.target)); } catch { return false; }
};
const unverified = VOICE_MODELS.filter(m => !verified(m));
const modelsDest = layout.voiceModels === "beside" ? path.join(out, "voice-models") : withModels ? path.join(resources, "voice-models") : null;
if (withModels && unverified.length) throw new Error(`--with-models: ${unverified.map(m => m.target).join(", ")} missing or not verified (run node scripts/voice/prepare.mjs)`);

// Only this script's folders are replaced; built packages beside them stay until rebuilt.
for (const d of [layout.appDir, "voice-models"]) fs.rmSync(path.join(out, d), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1. Electron itself, as Ember. Requiring the package gives its executable (downloading it if npm ci didn't);
//    its dist folder is that path less layout.electronExe. macOS copies the whole Electron.app bundle, keeping the
//    frameworks' symlinks as they are.
const electronExe = createRequire(import.meta.url)("electron");
const electronDist = layout.electronExe.split("/").reduce(d => path.dirname(d), electronExe);
if (path.join(electronDist, layout.electronExe) !== path.normalize(electronExe)) throw new Error(`Electron's executable isn't where ${layout.target} has it: ${electronExe}`);
fs.cpSync(path.join(electronDist, layout.electronSource), app, { recursive: true, verbatimSymlinks: true });
for (const [from, to] of layout.renames) renameRetrying(path.join(app, from), path.join(app, to));
for (const f of layout.remove) fs.rmSync(path.join(app, f), { force: true });
// Electron's licences go inside the app folder (on Linux and Windows they already are).
for (const f of layout.electronNotices) fs.copyFileSync(path.join(electronDist, f), path.join(app, layout.noticesDir, f));
// Windows: Ember.exe's own version resource and icon (Task Manager and its Startup apps page, the privacy settings,
// the volume mixer and firewall prompts show them), without Electron's certificate table, which any change voids
// (exe-resources.mjs). Before the fuses, so they are flipped and checked in the bytes that ship. The .ico also
// serves shortcuts and windows.
if (layout.icon?.kind === "ico") await writeIco(path.join(root, "assets/ember.svg"), path.join(app, layout.icon.file));
let exeIdentity = null;
if (layout.exeResources) {
  if (layout.icon?.kind !== "ico") throw new Error(`${layout.target}: the executable's icon comes from an .ico, and this layout has none`);
  const company = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
  if (!company) throw new Error("package.json has no author to name as Ember.exe's company");
  const exe = path.join(app, layout.exe);
  const identity = { version: pkg.version, company, ico: fs.readFileSync(path.join(app, layout.icon.file)) };
  // Written beside and renamed over, so an interrupted run never leaves half an executable.
  fs.writeFileSync(`${exe}.resources`, rewriteExeResources(fs.readFileSync(exe), identity));
  renameRetrying(`${exe}.resources`, exe);
  const read = readExeResources(fs.readFileSync(exe));
  const wrongResources = exeResourceMismatches(read, identity);
  if (wrongResources.length) throw new Error(`${layout.exe}'s resources didn't take: ${wrongResources.join("; ")}`);
  exeIdentity = `${layout.exe}: "${read.versions[0].strings[0].values.FileDescription}" ${pkg.version} by ${company}, ${read.iconGroups[0].icons.length} icon sizes, unsigned`;
}
// Its fuses: no debugger (--inspect*) and no NODE_OPTIONS, in the app or in what it runs as plain Node; plain Node
// itself (RunAsNode) stays, for the desk helper and the accessibility host. Only the copy changes, not
// node_modules/electron.
const fuses = flipFuses(path.join(app, layout.fuseFile), EMBER_FUSES);
const wrongFuses = fuseMismatches(fuses, EMBER_FUSES);
if (wrongFuses.length) throw new Error(`the staged binary's fuses didn't take: ${wrongFuses.join("; ")}`);

// 2. The app: its package.json, the build, and production dependencies only.
const appDir = path.join(resources, "app");
fs.mkdirSync(appDir, { recursive: true });
const { name, version, description, license, author, main } = pkg;
fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name, productName: "Ember", version, description, license, author, main, type: pkg.type, dependencies: pkg.dependencies }, null, 2) + "\n");
fs.copyFileSync(path.join(root, "LICENSE"), path.join(appDir, "LICENSE"));
const builtDir = path.join(root, "dist/app");
fs.cpSync(builtDir, path.join(appDir, "dist/app"), {
  recursive: true,
  // Source maps stay out of the package, and so do other targets' helpers.
  filter: src => !src.endsWith(".map") && !layout.excludeDist.includes(path.relative(builtDir, src).split(path.sep).join("/")),
});

// Licence and notice files are how the licences are met: they always ship. libvips's LGPL notice is in its README
// (sharp-libvips's, or sharp's own on Windows, where it carries libvips itself).
const NOTICE = /^(licen[cs]es?|copying|notices?|copyrightnotice|third[-_]?party[-_]?notices)([-._].*)?$/i;
const isNotice = (pkgDir, rel) => NOTICE.test(path.basename(rel)) || (/@img[\\/]sharp-(libvips-|win32-)/.test(pkgDir) && rel === "README.md");
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
// Inside the platform builds: koffi's musl build or link-time files, libvips's headers, and the Copilot runtime's
// helpers for its own built-in tools (search, browser plugin, skills). Ember's sessions turn every built-in tool off
// (app/main/agent/session-config.ts), and the runtime runs without them (checked: the conductor integration test
// against a runtime pruned like this).
for (const p of layout.prune) fs.rmSync(path.join(appDir, "node_modules", p), { recursive: true, force: true });

// 3. The accessibility sidecar files (main.ts looks for them under resources/ when packaged).
for (const s of sidecars) {
  fs.mkdirSync(path.dirname(path.join(resources, s.to)), { recursive: true });
  fs.copyFileSync(path.join(root, s.from), path.join(resources, s.to));
}

// 4. Speech models (optional): only when every model is in place and verified (its marker holds the SHA-256 it's
//    pinned to), and only the files Ember loads (no partial downloads).
if (modelsDest && fs.existsSync(models) && unverified.length) {
  console.log(`speech models not bundled: ${unverified.map(m => m.target).join(", ")} missing or not verified (run node scripts/voice/prepare.mjs)`);
}
if (modelsDest && !unverified.length) {
  // Each pinned model and its marker; nothing else in the folder (an interrupted download, an older model).
  for (const m of VOICE_MODELS) {
    fs.cpSync(path.join(models, m.target), path.join(modelsDest, m.target), {
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
    fs.copyFileSync(path.join(models, `.${m.target}.ok`), path.join(modelsDest, `.${m.target}.ok`));
  }
  fs.writeFileSync(path.join(modelsDest, "NOTICE"), "Ember's offline speech models, as published by the k2-fsa/sherpa-onnx project.\n\n"
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
const fonts = path.posix.relative(layout.noticesDir, `${layout.resourcesDir}/app/dist/app/renderer/fonts`);
fs.writeFileSync(path.join(app, layout.noticesDir, "THIRD_PARTY_NOTICES"), [
  `Ember ${version}: ${license}. The licences of everything Ember bundles follow.`,
  `--- Ember's LICENSE ---\n${fs.readFileSync(path.join(root, "LICENSE"), "utf8").trim()}`,
  `Electron ${electronVersion}: MIT (LICENSE beside this file). Chromium and the libraries in it, among them FFmpeg\n(LGPL-2.1-or-later): LICENSES.chromium.html beside this file.`,
  `Inter 4.1 (the typeface of Ember's windows, ${fonts}): OFL-1.1\n\n--- LICENSE.txt ---\n${fs.readFileSync(path.join(root, "assets/fonts/LICENSE.txt"), "utf8").trim()}`,
  ...sections,
].join(`\n\n${"=".repeat(78)}\n\n`) + "\n");

// 6. macOS: Info.plist, the icon, then the ad hoc signature over every byte above (mac-bundle.mjs).
if (layout.signing === "adhoc") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-bundle-"));
  try {
    await finishMacBundle({ app, version, svg: path.join(root, "assets/ember.svg"), tmp, writeIconset, log: line => console.log(line) });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

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

/** Renames, retrying for a moment: on Windows an antivirus scan can hold a freshly copied executable. */
function renameRetrying(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); } catch (err) {
      if (i >= 20 || !["EBUSY", "EPERM", "EACCES"].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

/** The size of everything under `p`, as `du -sh` would put it (no du on Windows). */
function size(p) {
  let bytes = 0;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q);
      else if (e.isFile()) bytes += fs.statSync(q).size;
    }
  };
  walk(p);
  const units = ["B", "K", "M", "G"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes < 10 && i ? bytes.toFixed(1) : Math.round(bytes)}${units[i]}`;
}

console.log(`staged ${rel(app)} (${size(app)}): Ember ${version}, Electron ${electronVersion}, ${layout.target}`);
if (exeIdentity) console.log(`  ${exeIdentity}`);
console.log(`  fuses: ${Object.entries(fuses).map(([k, v]) => `${k} ${v === true ? "on" : v === false ? "off" : v}`).join(", ")}`);
console.log(`  production modules: ${prod.map(p => path.relative(path.join(root, "node_modules"), p)).join(", ")}`);
if (modelsDest && fs.existsSync(modelsDest)) console.log(`staged ${rel(modelsDest)} (${size(modelsDest)})`);
else if (layout.voiceModels === "beside" && !fs.existsSync(models)) console.log("no speech models in .cache/voice (run scripts/voice/prepare.mjs to include them)");
else if (layout.voiceModels === "inside" && !withModels) console.log("speech models not bundled (Ember downloads them when “Hey Ember” is turned on; --with-models bundles them)");
for (const f of notStaged) console.warn(`warning: ${f} isn't staged (--allow-missing-sidecar): this package can't read or act in apps`);
