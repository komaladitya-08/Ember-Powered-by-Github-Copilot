// Packs the app stage.mjs staged into the archives people download, on the same OS, and checks each one:
//   Windows: dist/package/Ember-<version>-win-<arch>.zip   the Ember folder, zipped by Windows's own tar.exe (bsdtar,
//            in System32 since Windows 10 1803; Git's GNU tar can't write zip files and reads C: as a host name)
//   macOS:   dist/package/Ember-<version>-mac-<arch>.zip   ditto, which keeps the frameworks' symlinks and the
//                                                          signature (plain zip -r breaks both)
//            dist/package/Ember-<version>-mac-<arch>.dmg   hdiutil: Ember.app beside a link to /Applications
// The RPM and the AppImage come from rpm.sh and appimage.sh instead.
// usage: node scripts/package/archive.mjs   (after node scripts/package/stage.mjs)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactNames, layoutFor } from "./layout.mjs";

/**
 * The commands that make and check the archives for `layout`, in order. A step with `expect` passes only if its
 * output names every one of those entries; `retries` is for hdiutil, which sometimes fails on CI with
 * "Resource busy" when creating the image and "Resource temporarily unavailable" when verifying it. `dmgRoot` is the folder that must hold Ember.app and the Applications link while hdiutil runs.
 * @param {import("./layout.d.mts").Layout} layout
 * @param {{ version: string; out: string; systemRoot?: string }} o
 */
export function archivePlan(layout, o) {
  const names = artifactNames(layout, o.version).map(n => path.join(o.out, n));
  const app = path.join(o.out, layout.appDir);
  if (layout.platform === "win32") {
    const tar = path.win32.join(o.systemRoot || "C:\\Windows", "System32", "tar.exe");
    return {
      archives: names, dmgRoot: null,
      steps: [
        // -a picks the format from the .zip suffix; -C keeps "Ember/" as the archive's top folder.
        { what: "zipping the app", file: tar, args: ["-a", "-c", "-f", names[0], "-C", o.out, layout.appDir] },
        { what: "listing the zip", file: tar, args: ["-t", "-f", names[0]], expect: [`${layout.appDir}/${layout.exe}`, `${layout.appDir}/${layout.resourcesDir}/app/package.json`, `${layout.appDir}/THIRD_PARTY_NOTICES`] },
      ],
    };
  }
  if (layout.platform === "darwin") {
    const dmgRoot = path.join(o.out, ".dmg-root");
    return {
      archives: names, dmgRoot,
      steps: [
        { what: "zipping the app", file: "ditto", args: ["-c", "-k", "--sequesterRsrc", "--keepParent", app, names[0]] },
        { what: "listing the zip", file: "zipinfo", args: ["-1", names[0]], expect: [`${layout.appDir}/${layout.exe}`, `${layout.appDir}/Contents/Info.plist`, `${layout.appDir}/Contents/_CodeSignature/CodeResources`, `${layout.appDir}/${layout.resourcesDir}/app/package.json`] },
        { what: "making the disk image", file: "hdiutil", args: ["create", "-volname", "Ember", "-srcfolder", dmgRoot, "-ov", "-format", "UDZO", names[1]], retries: 3 },
        { what: "verifying the disk image", file: "hdiutil", args: ["verify", names[1]], retries: 3 },
      ],
    };
  }
  throw new Error(`no archives for ${layout.target}: the RPM and the AppImage come from scripts/package/rpm.sh and appimage.sh`);
}

/** Runs one step of the plan, retrying as it says; throws with the command's output if it fails. */
function runStep(step) {
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync(step.file, step.args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (r.status === 0) {
      const lines = new Set((r.stdout ?? "").split(/\r?\n/).map(l => l.trim()));
      const absent = (step.expect ?? []).filter(e => !lines.has(e));
      if (absent.length) throw new Error(`${step.what}: ${absent.join(", ")} not in the archive`);
      return;
    }
    if (attempt > (step.retries ?? 0)) throw new Error(`${step.what} failed (${step.file} ${step.args.join(" ")}): ${r.error?.message ?? output.trim()}`);
    console.log(`${step.what} failed (attempt ${attempt}), trying again in 5 s: ${output.trim().split("\n").pop()}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const out = path.join(root, "dist/package");
  const layout = layoutFor(process.platform, process.arch);
  let plan;
  try { plan = archivePlan(layout, { version, out, systemRoot: process.env.SystemRoot }); } catch (err) { console.error(err.message); process.exit(2); }
  const app = path.join(out, layout.appDir);
  if (!fs.existsSync(path.join(app, layout.exe))) { console.error(`stage first (node scripts/package/stage.mjs): ${path.relative(root, path.join(app, layout.exe))} is missing`); process.exit(1); }
  if (layout.platform === "win32" && !fs.existsSync(plan.steps[0].file)) { console.error(`${plan.steps[0].file} is missing (Windows 10 1803 or later has it)`); process.exit(1); }
  for (const a of plan.archives) fs.rmSync(a, { force: true });
  for (const step of plan.steps) {
    if (step.file !== "hdiutil" || step.args[0] !== "create") { runStep(step); continue; }
    // The disk image's window shows Ember.app beside /Applications, to drag it across. The app is moved in and back
    // (a rename: nothing is copied, and the signature is untouched).
    fs.rmSync(plan.dmgRoot, { recursive: true, force: true });
    fs.mkdirSync(plan.dmgRoot);
    fs.symlinkSync("/Applications", path.join(plan.dmgRoot, "Applications"));
    fs.renameSync(app, path.join(plan.dmgRoot, layout.appDir));
    try { runStep(step); } finally {
      fs.renameSync(path.join(plan.dmgRoot, layout.appDir), app);
      fs.rmSync(plan.dmgRoot, { recursive: true, force: true });
    }
  }
  for (const a of plan.archives) console.log(`${path.relative(root, a)} (${(fs.statSync(a).size / 1024 / 1024).toFixed(1)} MB)`);
}
