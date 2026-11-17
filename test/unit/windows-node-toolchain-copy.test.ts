/** Actual copy/filter and unchanged strict stager over temporary files; only fixed pin bytes are a small test model. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import * as url from "node:url";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, expect, it } from "vitest";
import manifest from "../../app/shared/windows-node-toolchain.json";

const roots: string[] = [], refusal = "The development Windows coding resources could not be separated for packaging.";
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const bodies = [Buffer.from("fixed test Node image"), Buffer.from("fixed test licence"), Buffer.from("fixed test receipt"), Buffer.from("fixed test bootstrap")];
const pins = { ...manifest, files: manifest.files.map((file, index) => ({ ...file, bytes: bodies[index].length,
  sha256: createHash("sha256").update(bodies[index]).digest("hex") })) };

function load(file: string, dependencies: Record<string, unknown>): unknown {
  const selected = url.fileURLToPath(new URL("../../scripts/package/" + file, import.meta.url));
  const source = transformSync(fs.readFileSync(selected, "utf8"), { loader: "js", format: "cjs", target: "node22",
    define: { "import.meta.url": JSON.stringify(url.pathToFileURL(selected).href) } }).code;
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, Buffer, process: { argv: [] }, require(name: string) {
    if (name === "node:fs") return fs;
    if (name === "node:path") return path;
    if (name === "node:crypto") return { createHash };
    if (name === "node:url") return url;
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error("Unexpected fixed packaging fixture dependency.");
  } }, { timeout: 1000 });
  return module.exports;
}
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ember-node-release-copy-"))); roots.push(root);
  const producer = path.join(root, "producer"), electron = path.join(root, "electron"), resources = path.join(electron, "resources");
  const development = path.join(resources, "coding", "windows-node-x64"), packaged = path.join(root, "package");
  fs.mkdirSync(producer); fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(electron, "electron.exe"), "unrelated Electron fixture");
  fs.writeFileSync(path.join(resources, "default_app.asar"), "unchanged ordinary resource");
  pins.files.forEach((pin, index) => fs.writeFileSync(path.join(producer, pin.source), bodies[index]));
  const strict = load("windows-node-toolchain.mjs", { "../../app/shared/windows-node-toolchain.json": pins }) as typeof import("../../scripts/package/windows-node-toolchain.mjs");
  const candidate = load("windows-node-toolchain-copy.mjs", { "./windows-node-toolchain.mjs": strict }) as typeof import("../../scripts/package/windows-node-toolchain-copy.mjs");
  const stageDevelopment = () => { fs.mkdirSync(path.dirname(development), { recursive: true }); strict.stageWindowsNodeToolchain(producer, development); };
  const copy = (filter = candidate.prepareWindowsNodeElectronCopyFilter(electron)) => fs.cpSync(electron, packaged,
    { recursive: true, verbatimSymlinks: true, filter });
  return { root, producer, electron, resources, development, packaged, strict, candidate, stageDevelopment, copy };
}

it("reproduces the original recursive-copy conflict with the unchanged strict fresh-leaf stager", () => {
  const f = fixture(); f.stageDevelopment();
  fs.cpSync(f.electron, f.packaged, { recursive: true, verbatimSymlinks: true });
  const destination = path.join(f.packaged, "resources", "coding", "windows-node-x64");
  expect(f.strict.verifyWindowsNodeToolchain(destination).files).toBe(3);
  expect(() => f.strict.stageWindowsNodeToolchain(f.producer, destination)).toThrow("could not be verified");
  expect(f.strict.verifyWindowsNodeToolchain(destination).files).toBe(3);
});

it.each([false, true])("omits verified development assets before a real copy; release flag=%s stages only a fresh producer copy", withNode => {
  const f = fixture(); f.stageDevelopment();
  expect(f.strict.verifyWindowsNodeToolchain(f.development).files).toBe(3);
  f.copy();
  const destination = path.join(f.packaged, "resources", "coding", "windows-node-x64");
  expect(fs.existsSync(path.dirname(destination))).toBe(false);
  expect(fs.readFileSync(path.join(f.packaged, "electron.exe"), "utf8")).toBe("unrelated Electron fixture");
  expect(fs.readFileSync(path.join(f.packaged, "resources", "default_app.asar"), "utf8")).toBe("unchanged ordinary resource");
  if (withNode) {
    fs.mkdirSync(path.dirname(destination));
    expect(f.strict.stageWindowsNodeToolchain(f.producer, destination).files).toBe(3);
    expect(f.strict.verifyWindowsNodeToolchain(destination).files).toBe(3);
    expect(fs.readdirSync(destination).sort()).toEqual(["LICENSE", "build-receipt.json", "node.exe"]);
    expect(() => f.strict.stageWindowsNodeToolchain(f.producer, destination)).toThrow("could not be verified");
  } else expect(fs.existsSync(destination)).toBe(false);
  expect(f.strict.verifyWindowsNodeToolchain(f.development).files).toBe(3);
});
it("copies ordinary Electron resources when no development container exists", () => {
  const f = fixture(); f.copy();
  expect(fs.readdirSync(path.join(f.packaged, "resources"))).toEqual(["default_app.asar"]);
});
it("omits an ordinary empty development container without manufacturing packaged assets", () => {
  const f = fixture(); fs.mkdirSync(path.dirname(f.development)); f.copy();
  expect(fs.existsSync(path.join(f.packaged, "resources", "coding"))).toBe(false);
});
it("cannot fall back to valid development bytes if the producer changes before fresh release staging", () => {
  const f = fixture(); f.stageDevelopment(); f.copy();
  const destination = path.join(f.packaged, "resources", "coding", "windows-node-x64"); fs.mkdirSync(path.dirname(destination));
  fs.writeFileSync(path.join(f.producer, "source-node.exe"), "invalid producer");
  expect(() => f.strict.stageWindowsNodeToolchain(f.producer, destination)).toThrow("could not be verified");
  expect(fs.existsSync(destination)).toBe(false); expect(f.strict.verifyWindowsNodeToolchain(f.development).files).toBe(3);
});
it("refuses an arbitrary existing release destination without deleting or repairing its contents", () => {
  const f = fixture(); f.stageDevelopment(); f.copy();
  const destination = path.join(f.packaged, "resources", "coding", "windows-node-x64"); fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "keep"), "untouched destination");
  expect(() => f.strict.stageWindowsNodeToolchain(f.producer, destination)).toThrow("could not be verified");
  expect(fs.readdirSync(destination)).toEqual(["keep"]); expect(fs.readFileSync(path.join(destination, "keep"), "utf8")).toBe("untouched destination");
});
it.each(["extra", "truncated", "tampered", "hardlinked", "incomplete", "foreign child"])("refuses %s development state before a copy, preserving existing destinations and input bytes", fault => {
  const f = fixture(); f.stageDevelopment();
  if (fault === "extra") fs.writeFileSync(path.join(f.development, "extra"), "foreign");
  if (fault === "truncated") fs.writeFileSync(path.join(f.development, "node.exe"), "short");
  if (fault === "tampered") { const bytes = Buffer.from(bodies[0]); bytes[0] ^= 1; fs.writeFileSync(path.join(f.development, "node.exe"), bytes); }
  if (fault === "hardlinked") fs.linkSync(path.join(f.development, "node.exe"), path.join(f.root, "hardlink"));
  if (fault === "incomplete") fs.unlinkSync(path.join(f.development, "LICENSE"));
  if (fault === "foreign child") fs.mkdirSync(path.join(path.dirname(f.development), "foreign"));
  fs.mkdirSync(f.packaged); fs.writeFileSync(path.join(f.packaged, "keep"), "untouched");
  expect(() => f.copy()).toThrow(refusal);
  expect(fs.readdirSync(f.packaged)).toEqual(["keep"]);
  expect(fs.readFileSync(path.join(f.packaged, "keep"), "utf8")).toBe("untouched");
  expect(fs.existsSync(f.development)).toBe(true);
});
it.each(["resources", "coding", "windows-node-x64"])("refuses a %s directory alias without following, deleting or repairing it", selected => {
  const f = fixture(); f.stageDevelopment();
  const target = selected === "resources" ? f.resources : selected === "coding" ? path.dirname(f.development) : f.development;
  const moved = path.join(f.root, "moved"); fs.renameSync(target, moved);
  fs.symlinkSync(moved, target, process.platform === "win32" ? "junction" : "dir");
  expect(() => f.copy()).toThrow(refusal); expect(fs.existsSync(f.packaged)).toBe(false);
  expect(fs.lstatSync(target).isSymbolicLink()).toBe(true); expect(fs.existsSync(moved)).toBe(true);
});
it.each(["resources", "coding", "windows-node-x64"])("refuses a %s case alias rather than copying a Windows-equivalent development path", selected => {
  const f = fixture(); f.stageDevelopment();
  const target = selected === "resources" ? f.resources : selected === "coding" ? path.dirname(f.development) : f.development;
  const renamed = path.join(path.dirname(target), path.basename(target).toUpperCase());
  // The intermediate name makes this an actual case-only rename on Windows too.
  const temporary = path.join(path.dirname(target), "case-rename"); fs.renameSync(target, temporary); fs.renameSync(temporary, renamed);
  expect(() => f.copy()).toThrow(refusal); expect(fs.existsSync(f.packaged)).toBe(false);
  expect(fs.existsSync(renamed)).toBe(true);
});
it("refuses a coding container that appears after preflight before copying its bytes", () => {
  const f = fixture(), filter = f.candidate.prepareWindowsNodeElectronCopyFilter(f.electron);
  fs.mkdirSync(path.dirname(f.development)); fs.writeFileSync(path.join(path.dirname(f.development), "foreign"), "do not copy");
  expect(() => f.copy(filter)).toThrow(refusal);
  expect(fs.existsSync(path.join(f.packaged, "resources", "coding"))).toBe(false);
  expect(fs.readFileSync(path.join(path.dirname(f.development), "foreign"), "utf8")).toBe("do not copy");
});
it.each(["container", "payload", "namespace", "bytes"])("rechecks %s at the real copy omission boundary", fault => {
  const f = fixture(); f.stageDevelopment();
  const filter = f.candidate.prepareWindowsNodeElectronCopyFilter(f.electron);
  if (fault === "container" || fault === "payload") {
    const target = fault === "container" ? path.dirname(f.development) : f.development;
    fs.renameSync(target, path.join(f.root, "original")); fs.mkdirSync(target);
  }
  if (fault === "namespace") fs.writeFileSync(path.join(path.dirname(f.development), "foreign"), "not copied");
  if (fault === "bytes") { const bytes = Buffer.from(bodies[0]); bytes[0] ^= 1; fs.writeFileSync(path.join(f.development, "node.exe"), bytes); }
  expect(() => f.copy(filter)).toThrow(refusal);
  expect(fs.existsSync(path.join(f.packaged, "resources", "coding"))).toBe(false);
});
it("keeps the release caller's preflight before its existing output reset and its producer-only fresh staging behind the flag", () => {
  const stage = fs.readFileSync(new URL("../../scripts/package/stage.mjs", import.meta.url), "utf8");
  expect(stage).toContain('const electronCopyFilter = layout.target === "win32-x64" ? prepareWindowsNodeElectronCopyFilter(electronSource) : null;');
  expect(stage.indexOf("prepareWindowsNodeElectronCopyFilter(electronSource)")).toBeLessThan(stage.indexOf('for (const d of [layout.appDir, "voice-models"])'));
  expect(stage).toContain("if (electronCopyFilter) fs.cpSync(electronSource, app, { recursive: true, verbatimSymlinks: true, filter: electronCopyFilter });");
  expect(stage).toContain("else fs.cpSync(path.join(electronDist, layout.electronSource), app, { recursive: true, verbatimSymlinks: true });");
  expect(stage).toContain('if (withWindowsNode) {\n  fs.mkdirSync(path.join(resources, "coding"), { recursive: true });\n  stageWindowsNodeToolchain(windowsNodeSource, path.join(resources, WINDOWS_NODE_TOOLCHAIN_DIRECTORY));\n}');
  expect(stage).not.toMatch(/rmSync\([^\n]*(?:coding|windows-node)/);
});
