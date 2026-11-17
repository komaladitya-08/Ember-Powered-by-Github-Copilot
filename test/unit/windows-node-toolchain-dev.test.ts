import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import { bindWindowsNodeToolchainDevelopment } from "../../scripts/package/windows-node-toolchain-dev.mjs";
import { verifyWindowsNodeToolchain, stageWindowsNodeToolchain } from "../../scripts/package/windows-node-toolchain.mjs";

const owned: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const file of owned.splice(0)) fs.rmSync(file, { recursive: true, force: true }); });
const model = [
  { source: "source-node.exe", name: "node.exe", bytes: Buffer.from("fixed model Node bytes"), ship: true },
  { source: "LICENSE", name: "LICENSE", bytes: Buffer.from("fixed model licence"), ship: true },
  { source: "build-receipt.json", name: "build-receipt.json", bytes: Buffer.from("fixed model producer receipt"), ship: true },
  { source: "bootstrap.exe", name: "bootstrap.exe", bytes: Buffer.from("fixed model unshipped bootstrap"), ship: false },
];
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ember-dev-node-"))); owned.push(root);
  const cache = path.join(root, ".cache", "windows-node-toolchain"), electron = path.join(root, "node_modules", "electron"), resources = path.join(electron, "dist", "resources");
  const destination = path.join(resources, "coding", "windows-node-x64");
  fs.mkdirSync(cache, { recursive: true }); fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixed-stager-model", devDependencies: { electron: "44.9.3" } }));
  fs.writeFileSync(path.join(electron, "package.json"), JSON.stringify({ name: "electron", version: "44.9.3", main: "index.js" }));
  fs.writeFileSync(path.join(electron, "index.js"), 'throw new Error("The Electron index must not execute or download during staging");');
  fs.writeFileSync(path.join(electron, "path.txt"), "electron.exe"); fs.writeFileSync(path.join(resources, "default_app.asar"), "unrelated Electron resource");
  const pe = Buffer.alloc(1024), at = 128; pe.write("MZ"); pe.writeUInt32LE(at, 0x3c); pe.writeUInt32LE(0x4550, at); pe.writeUInt16LE(0x8664, at + 4); pe.writeUInt16LE(0x20b, at + 24); pe.writeUInt16LE(2, at + 24 + 68);
  fs.writeFileSync(path.join(electron, "dist", "electron.exe"), pe);
  for (const file of model) fs.writeFileSync(path.join(cache, file.source), file.bytes);
  const verifications: { directory: string; kind: string }[] = [], stages: { source: string; destination: string }[] = [], fence = {};
  const verify = (directory: string, kind: "producer" | "package") => {
    verifications.push({ directory, kind }); const wanted = model.filter(file => kind === "producer" || file.ship), names = wanted.map(file => kind === "producer" ? file.source : file.name).sort();
    if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(names)) throw new Error("The fixed model member set refused.");
    for (const file of wanted) {
      const selected = path.join(directory, kind === "producer" ? file.source : file.name), info = fs.lstatSync(selected);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !fs.readFileSync(selected).equals(file.bytes)) throw new Error("The fixed model bytes refused.");
    }
    return Object.freeze({ files: wanted.length });
  };
  const stage = (source: string, target: string) => {
    stages.push({ source, destination: target }); verify(source, "producer"); fs.mkdirSync(target);
    for (const file of model) if (file.ship) fs.copyFileSync(path.join(source, file.source), path.join(target, file.name), fs.constants.COPYFILE_EXCL);
    return verify(target, "package");
  };
  const dependencies = { root, platform: "win32" as const, arch: "x64", verifyToolchain: verify, stageToolchain: stage, fence };
  const bind = (changes: Parameters<typeof bindWindowsNodeToolchainDevelopment>[0] = {}) => bindWindowsNodeToolchainDevelopment({ ...dependencies, ...changes });
  return { root, cache, electron, resources, destination, verifications, stages, fence, verify, stage, bind };
}

it("stages exactly three model members into installed Electron resources without executing its index", () => {
  const f = fixture(), stage = f.bind();
  expect(stage()).toEqual({ status: "staged", files: 3 });
  expect(fs.readdirSync(f.destination).sort()).toEqual(["LICENSE", "build-receipt.json", "node.exe"]);
  expect(fs.readFileSync(path.join(f.resources, "default_app.asar"), "utf8")).toBe("unrelated Electron resource");
  expect(f.stages).toEqual([{ source: f.cache, destination: f.destination }]);
  expect(f.verifications[0]).toEqual({ directory: f.cache, kind: "producer" });
  expect(stage()).toEqual({ status: "verified", files: 3 }); expect(f.stages).toHaveLength(1);
});
it("ignores Electron's executable override and never calls its download-capable index", () => {
  const f = fixture(), other = path.join(f.root, "other-electron"); fs.mkdirSync(other); vi.stubEnv("ELECTRON_OVERRIDE_DIST_PATH", other);
  expect(f.bind()()).toEqual({ status: "staged", files: 3 }); expect(fs.readdirSync(other)).toHaveLength(0);
});
it("normal Windows builds skip only a genuinely absent cache, while the strict gate refuses it", () => {
  const f = fixture(); fs.rmSync(f.cache, { recursive: true });
  const stage = f.bind({ resolvePackage: () => { throw new Error("No Electron discovery for absent optional cache."); } });
  expect(stage({ required: false })).toEqual({ status: "skipped-absent", files: 0 }); expect(f.verifications).toHaveLength(0);
  expect(() => stage()).toThrow("could not be staged"); expect(fs.existsSync(f.destination)).toBe(false);
});
it("non-Windows builds do no filesystem, cache or Electron work", () => {
  const broken = new Proxy({}, { get() { throw new Error("No non-Windows filesystem access."); } }) as typeof fs;
  const stage = bindWindowsNodeToolchainDevelopment({ files: broken, platform: "linux", arch: "x64", fence: {} });
  expect(stage({ required: false })).toEqual({ status: "skipped-platform", files: 0 }); expect(() => stage()).toThrow("could not be staged");
});
it("a present invalid producer refuses before creating any destination with the real fixed verifier", () => {
  const f = fixture(), stage = f.bind({ verifyToolchain: verifyWindowsNodeToolchain, stageToolchain: stageWindowsNodeToolchain });
  expect(() => stage({ required: false })).toThrow("could not be staged"); expect(fs.existsSync(f.destination)).toBe(false);
});
it("does not replace, remove or repair a supplied preexisting destination", () => {
  const f = fixture(); fs.mkdirSync(f.destination, { recursive: true }); fs.writeFileSync(path.join(f.destination, "keep"), "keep this exact content");
  expect(() => f.bind()()).toThrow("could not be staged"); expect(f.stages).toHaveLength(0);
  expect(fs.readdirSync(f.destination)).toEqual(["keep"]); expect(fs.readFileSync(path.join(f.destination, "keep"), "utf8")).toBe("keep this exact content");
});
it("verifies the producer even when a complete destination already exists", () => {
  const f = fixture(), stage = f.bind(); stage(); fs.writeFileSync(path.join(f.cache, "source-node.exe"), "changed");
  expect(() => stage()).toThrow("could not be staged"); expect(f.stages).toHaveLength(1);
  expect(fs.readFileSync(path.join(f.destination, "node.exe")).equals(model[0].bytes)).toBe(true);
});
it.each(["cache", "resources", "executable", "destination"])("refuses a symlink at %s instead of staging through it", selected => {
  const f = fixture(), target = selected === "cache" ? f.cache : selected === "resources" ? f.resources : selected === "executable" ? path.join(f.electron, "dist", "electron.exe") : f.destination;
  if (selected === "destination") fs.mkdirSync(path.dirname(target), { recursive: true });
  const moved = path.join(f.root, `moved-${selected}`);
  if (fs.existsSync(target)) fs.renameSync(target, moved); else fs.mkdirSync(moved);
  fs.symlinkSync(moved, target, selected === "executable" ? "file" : process.platform === "win32" ? "junction" : "dir");
  expect(() => f.bind()()).toThrow("could not be staged"); expect(f.stages).toHaveLength(0);
});
it.each(["producer", "electron", "metadata"])("refuses hardlinked %s bytes", selected => {
  const f = fixture(), file = selected === "producer" ? path.join(f.cache, "source-node.exe") : selected === "electron" ? path.join(f.electron, "dist", "electron.exe") : path.join(f.electron, "path.txt");
  fs.linkSync(file, path.join(f.root, "hardlink")); expect(() => f.bind()()).toThrow("could not be staged"); expect(f.stages).toHaveLength(0);
});
it.each(["electron", "../outside/electron.exe", "electron.exe\n", "C:\\other\\electron.exe"])("refuses an installed path marker %j", marker => {
  const f = fixture(); fs.writeFileSync(path.join(f.electron, "path.txt"), marker); expect(() => f.bind()()).toThrow("could not be staged"); expect(f.stages).toHaveLength(0);
});
it("refuses package-resolution fallback and a different npm package version", () => {
  const a = fixture(); expect(() => a.bind({ resolvePackage: () => path.join(a.root, "outside", "package.json") })()).toThrow("could not be staged");
  const b = fixture(); fs.writeFileSync(path.join(b.electron, "package.json"), JSON.stringify({ name: "electron", version: "0.0.0" }));
  expect(() => b.bind()()).toThrow("could not be staged"); expect(b.stages).toHaveLength(0);
});
it("refuses a non-x64 Electron image before copying any toolchain file", () => {
  const f = fixture(), binary = path.join(f.electron, "dist", "electron.exe"), bytes = fs.readFileSync(binary); bytes.writeUInt16LE(0x14c, 132); fs.writeFileSync(binary, bytes);
  expect(() => f.bind()()).toThrow("could not be staged"); expect(f.stages).toHaveLength(0);
});
it("preserves a known partial staging leaf after the helper refuses", () => {
  const f = fixture();
  expect(() => f.bind({ stageToolchain: (_source, destination) => { fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, "node.exe"), "partial"); throw new Error("Fixed partial staging refusal."); } })()).toThrow("could not be staged");
  expect(fs.readFileSync(path.join(f.destination, "node.exe"), "utf8")).toBe("partial");
});
it("compares named and descriptor clocks independently, preserving the corrected Windows contract", () => {
  const f = fixture(), info = (stat: fs.BigIntStats, ctimeNs: bigint) => Object.assign(Object.create(stat) as fs.BigIntStats, { ctimeNs });
  const files = { ...fs,
    lstatSync: ((file: fs.PathLike, options: { bigint: true }) => info(fs.lstatSync(file, options), 100n)) as typeof fs.lstatSync,
    fstatSync: ((fd: number, options: { bigint: true }) => info(fs.fstatSync(fd, options), 200n)) as typeof fs.fstatSync,
  };
  expect(f.bind({ files })()).toEqual({ status: "staged", files: 3 });
});
it("an uncertain metadata close blocks this and another bound stager sharing its private fence", () => {
  const f = fixture(); let opened = 0, closed = 0;
  const files = { ...fs, openSync: ((...args: Parameters<typeof fs.openSync>) => { opened++; return fs.openSync(...args); }) as typeof fs.openSync,
    closeSync(fd: number) { closed++; fs.closeSync(fd); throw new Error("Unknown close completion."); } };
  const stage = f.bind({ files }); expect(() => stage()).toThrow("could not be staged"); expect(opened).toBe(1); expect(closed).toBe(1);
  expect(() => stage()).toThrow("could not be staged"); expect(() => f.bind()()).toThrow("could not be staged");
  expect(opened).toBe(1); expect(closed).toBe(1); expect(f.stages).toHaveLength(0); expect(fs.existsSync(f.destination)).toBe(false);
});
it("retains an outer descriptor without closing it after a nested stager poisons their shared fence", () => {
  const f = fixture(); let outerFd: number | undefined, outerClosed = 0, innerClosed = 0, nested = false;
  const inner = f.bind({ files: { ...fs, closeSync(fd: number) { innerClosed++; fs.closeSync(fd); throw new Error("Nested unknown close completion."); } } });
  const files = { ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => { outerFd = fs.openSync(...args); return outerFd; }) as typeof fs.openSync,
    fstatSync: ((fd: number, options: { bigint: true }) => {
      const info = fs.fstatSync(fd, options);
      if (!nested) { nested = true; expect(() => inner()).toThrow("could not be staged"); }
      return info;
    }) as typeof fs.fstatSync,
    closeSync(fd: number) { outerClosed++; fs.closeSync(fd); },
  };
  try {
    const outer = f.bind({ files }); expect(() => outer()).toThrow("could not be staged");
    expect(outerClosed).toBe(0); expect(innerClosed).toBe(1); expect(f.stages).toHaveLength(0);
    expect(() => outer()).toThrow("could not be staged"); expect(outerClosed).toBe(0); expect(innerClosed).toBe(1);
    expect(fs.readFileSync(path.join(f.resources, "default_app.asar"), "utf8")).toBe("unrelated Electron resource");
  } finally { if (outerFd !== undefined) fs.closeSync(outerFd); } // The model fixture owns this never-close-attempted descriptor.
});
it("strict CLI rejects arguments with only fixed output", () => {
  const script = fileURLToPath(new URL("../../scripts/package/windows-node-toolchain-dev.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--override-path"], { encoding: "utf8", timeout: 5000 });
  expect(result.status).toBe(1); expect(result.stdout.length).toBe(0); expect(result.stderr === "The fixed Windows development coding toolchain could not be staged. (development stage 0, object 0, operation 0).\n").toBe(true);
});

// Evaluate the actual CLI with fixed model imports; no Windows executable or Electron index is executed.
function emitted(f: ReturnType<typeof fixture>, options: {
  files?: typeof fs; verify?: typeof f.verify; stage?: typeof f.stage; resolve?: () => string;
  globals?: Record<string, unknown>;
} = {}) {
  const file = path.join(f.root, "scripts", "package", "windows-node-toolchain-dev.mjs");
  const source = fs.readFileSync(new URL("../../scripts/package/windows-node-toolchain-dev.mjs", import.meta.url), "utf8");
  const code = transformSync(source, { format: "cjs", target: "node22", define: { "import.meta.url": JSON.stringify(pathToFileURL(file).href) } }).code;
  const module = { exports: {} as typeof import("../../scripts/package/windows-node-toolchain-dev.mjs") };
  const stdout: string[] = [], stderr: string[] = [], processModel = { platform: "win32", arch: "x64", argv: ["node", file], exitCode: 0 };
  runInNewContext(code, { module, exports: module.exports, Buffer, process: processModel,
    console: { log: (value: string) => stdout.push(value), error: (value: string) => stderr.push(value) },
    require: (name: string) => {
      if (name === "node:fs") return options.files ?? fs;
      if (name === "node:path") return path;
      if (name === "node:url") return { fileURLToPath };
      if (name === "node:module") return { createRequire: options.resolve ? () => ({ resolve: options.resolve }) : createRequire };
      if (name === "./windows-node-toolchain.mjs") return { verifyWindowsNodeToolchain: options.verify ?? f.verify,
        stageWindowsNodeToolchain: options.stage ?? f.stage, WINDOWS_NODE_TOOLCHAIN_DIRECTORY: "coding/windows-node-x64" };
      throw new Error("The fixed CLI model requested an unsupported import.");
    }, ...options.globals });
  return { stdout, stderr, process: processModel, api: module.exports };
}
const fixedFailure = "The fixed Windows development coding toolchain could not be staged.";
const projected = (stage: number, object: number, operation: number) => `${fixedFailure} (development stage ${stage}, object ${object}, operation ${operation}).`;

it("the emitted CLI stages once despite expected missing parent and destination probes", () => {
  const f = fixture(), result = emitted(f);
  expect(result.process.exitCode).toBe(0); expect(result.stderr).toEqual([]);
  expect(result.stdout).toEqual(["Pinned Windows coding Node development resources staged (3 files)."]);
  expect(f.stages).toEqual([{ source: f.cache, destination: f.destination }]);
});
it.each([
  ["producer", 3, 1, 8], ["project", 4, 2, 0], ["resolver", 5, 3, 7], ["package", 6, 3, 0],
  ["marker", 7, 4, 0], ["PE", 8, 5, 0], ["resources", 9, 6, 1], ["parent", 10, 7, 9],
  ["destination", 11, 8, 1], ["copy", 12, 8, 10], ["package-verify", 13, 8, 8], ["resources-recheck", 14, 6, 2],
] as const)("the emitted CLI projects only fixed provenance for %s", (selected, stage, object, operation) => {
  const f = fixture(), secret = new Error("PRIVATE model failure"), files = { ...fs }; let rechecking = false;
  const options: Parameters<typeof emitted>[1] = { files };
  if (selected === "producer") options.verify = () => { throw secret; };
  if (selected === "project") fs.writeFileSync(path.join(f.root, "package.json"), "{");
  if (selected === "resolver") options.resolve = () => { throw secret; };
  if (selected === "package") fs.writeFileSync(path.join(f.electron, "package.json"), JSON.stringify({ name: "electron", version: "0.0.0" }));
  if (selected === "marker") fs.writeFileSync(path.join(f.electron, "path.txt"), "other.exe");
  if (selected === "PE") fs.writeFileSync(path.join(f.electron, "dist", "electron.exe"), Buffer.alloc(1024));
  if (selected === "resources") fs.rmSync(f.resources, { recursive: true });
  if (selected === "parent") files.mkdirSync = (() => { throw secret; }) as typeof fs.mkdirSync;
  if (selected === "destination" || selected === "resources-recheck") files.lstatSync = ((file: fs.PathLike, options: { bigint: true }) => {
    if (selected === "destination" && file === f.destination) throw secret;
    const value = fs.lstatSync(file, options);
    return selected === "resources-recheck" && file === f.resources && rechecking ? Object.assign(Object.create(value) as fs.BigIntStats, { ino: value.ino + 1n }) : value;
  }) as typeof fs.lstatSync;
  if (selected === "copy") options.stage = () => { throw secret; };
  if (selected === "package-verify") options.verify = (directory, kind) => { if (kind === "package") throw secret; return f.verify(directory, kind); };
  if (selected === "resources-recheck") options.verify = (directory, kind) => { const value = f.verify(directory, kind); if (kind === "package") rechecking = true; return value; };
  const result = emitted(f, options);
  expect(result.process.exitCode).toBe(1); expect(result.stdout).toEqual([]); expect(result.stderr).toEqual([projected(stage, object, operation)]);
  expect(result.stderr.join()).not.toContain(secret.message); expect(result.stderr.join()).not.toContain(f.root);
});
it("first read failure survives a later uncertain close without new queries, retries or changed fence error", () => {
  const f = fixture(), calls: string[] = []; let opened: number | undefined;
  const realpath = Object.assign(((...args: Parameters<typeof fs.realpathSync>) => fs.realpathSync(...args)) as typeof fs.realpathSync,
    { native: ((...args: Parameters<typeof fs.realpathSync.native>) => { calls.push("realpath"); return fs.realpathSync.native(...args); }) as typeof fs.realpathSync.native });
  const files = { ...fs,
    lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => { calls.push("lstat"); return fs.lstatSync(...args); }) as typeof fs.lstatSync,
    realpathSync: realpath,
    openSync: ((...args: Parameters<typeof fs.openSync>) => { calls.push("open"); opened = fs.openSync(...args); return opened; }) as typeof fs.openSync,
    fstatSync: (() => { calls.push("fstat"); throw new Error("PRIVATE read metadata"); }) as typeof fs.fstatSync,
    closeSync: (() => { calls.push("close"); throw new Error("PRIVATE uncertain close"); }) as typeof fs.closeSync,
  };
  try {
    const result = emitted(f, { files }); expect(result.stderr).toEqual([projected(4, 2, 4)]);
    const ancestors = (selected: string) => { let count = 1; for (let parent = path.dirname(selected); parent !== selected; parent = path.dirname(selected)) { count++; selected = parent; } return count; };
    const expected = [...Array.from({ length: ancestors(f.cache) + ancestors(f.root) }, () => ["lstat", "realpath"]).flat(), "lstat", "realpath", "open", "fstat", "close"];
    expect(calls).toEqual(expected); expect(f.stages).toHaveLength(0);
    let first: unknown, second: unknown;
    try { result.api.stageWindowsNodeToolchainDevelopment(); } catch (error) { first = error; }
    try { result.api.stageWindowsNodeToolchainDevelopment(); } catch (error) { second = error; }
    expect(first).toBe(second); expect((first as Error).message).toBe(fixedFailure); expect(calls).toEqual(expected);
  } finally { if (opened !== undefined) fs.closeSync(opened); } // Only the model owns this never-completed close.
});
it("an uncertain close itself is recorded only after all earlier read checks passed", () => {
  const f = fixture(); let opened: number | undefined, closes = 0;
  try {
    const files = { ...fs, openSync: ((...args: Parameters<typeof fs.openSync>) => { opened = fs.openSync(...args); return opened; }) as typeof fs.openSync,
      closeSync: (() => { closes++; throw new Error("PRIVATE uncertain close"); }) as typeof fs.closeSync };
    const result = emitted(f, { files }); expect(result.stderr).toEqual([projected(4, 2, 6)]); expect(closes).toBe(1); expect(f.stages).toHaveLength(0);
  } finally { if (opened !== undefined) fs.closeSync(opened); }
});
it.each(["store", "projection", "snapshot", "shape", "bounds"] as const)("a diagnostic %s fault cannot replace the original error or release an unknown descriptor", selected => {
  const f = fixture(); let instances = 0, opened: number | undefined, closes = 0; const issued: unknown[] = [];
  class DiagnosticFault extends WeakMap<object, unknown> {
    index = ++instances;
    override set(key: object, value: unknown) { if (this.index === 1) issued.push(value); if (this.index === 3 && selected === "store") throw new Error("PRIVATE observer"); return super.set(key, value); }
    override get(key: object) {
      if (this.index === 3 && selected === "projection") throw new Error("PRIVATE projection");
      if (this.index === 3 && selected === "shape") return { stage: "PRIVATE", object: 2, operation: 6 };
      if (this.index === 3 && selected === "bounds") return { stage: 4, object: 2, operation: 11 };
      return super.get(key);
    }
  }
  const globals: Record<string, unknown> = { WeakMap: DiagnosticFault };
  if (selected === "snapshot") globals.Object = new Proxy(Object, { get(target, key, receiver) { if (key === "freeze") return () => { throw new Error("PRIVATE snapshot"); }; return Reflect.get(target, key, receiver); } });
  try {
    const result = emitted(f, { globals, files: { ...fs,
      openSync: ((...args: Parameters<typeof fs.openSync>) => { opened = fs.openSync(...args); return opened; }) as typeof fs.openSync,
      closeSync: (() => { closes++; throw new Error("PRIVATE uncertain close"); }) as typeof fs.closeSync,
    } });
    expect(result.stderr).toEqual([projected(0, 0, 0)]); expect(closes).toBe(1); expect(issued).toHaveLength(1);
    let error: unknown; try { result.api.stageWindowsNodeToolchainDevelopment(); } catch (value) { error = value; }
    expect(error).toBe(issued[0]); expect((error as Error).message).toBe(fixedFailure); expect(closes).toBe(1); expect(f.stages).toHaveLength(0);
  } finally { if (opened !== undefined) fs.closeSync(opened); }
});
it("normal build stages optionally and the Windows packaging recipe requires the fixed toolchain", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url)), build = fs.readFileSync(path.join(root, "scripts/build-app.mjs"), "utf8"), pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  expect(build.includes('stageWindowsNodeToolchainDevelopment({ required: false })')).toBe(true);
  expect(pkg.scripts["package:win"]).toBe("npm run build && node scripts/package/remote-parts.mjs && node scripts/package/stage.mjs --with-windows-node-toolchain && node scripts/package/archive.mjs");
});
