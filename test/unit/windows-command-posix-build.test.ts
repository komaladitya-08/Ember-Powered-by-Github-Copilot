import fs from "node:fs";
import path from "node:path";
import win from "node:path/win32";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { classifyWindowsCommandCopyFileFailure } from "../fixtures/windows-command-copy-proof";
import { ScopedCodingFileError } from "../../app/main/agent/coding-platform";
// @ts-expect-error -- fixed CI-only JavaScript builder, portable injected contract tests
import { bindWindowsCommandPosixProofBuild, windowsCommandPosixBuildImage, windowsCommandPosixBuildPath, windowsCommandPosixBuildEnvironment, windowsCommandPosixCompileRecipe, windowsCommandPosixBundleRecipe, windowsCommandPosixSourceCapture, validateWindowsCommandPosixProofPe, WindowsCommandPosixBuildError } from "../../scripts/experimental/build-windows-command-posix-proof.mjs";
// @ts-expect-error -- the old observed build has a separate private issuer and is never invoked here
import { verifyWindowsCommandCopyProof } from "../../scripts/experimental/build-windows-command-copy-proof.mjs";

const SECRET = "PRIVATE_SECRET arbitrary-path SID credential compiler stdout stderr";
const ROOT = "D:\\repo", DEST = `${ROOT}\\.ember-creator-posix-build-12345678-1234-1234-1234-123456789abc`, COMMIT = "a".repeat(40);
const INSTALL = "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise", VERSION = "14.44.35207";
const VSWHERE = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
function pe() {
  const bytes = Buffer.alloc(1024), at = 128, optional = at + 24, section = optional + 240;
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(at, 0x3c); bytes.writeUInt32LE(0x4550, at); bytes.writeUInt16LE(0x8664, at + 4);
  bytes.writeUInt16LE(1, at + 6); bytes.writeUInt16LE(240, at + 20); bytes.writeUInt16LE(2, at + 22); bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(0x1000, optional + 16); bytes.writeUInt32LE(0x2000, optional + 56); bytes.writeUInt32LE(512, optional + 60);
  bytes.writeUInt16LE(3, optional + 68); bytes.writeUInt32LE(16, optional + 108); bytes.writeUInt32LE(100, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(512, section + 16); bytes.writeUInt32LE(512, section + 20); bytes.writeUInt32LE(0x60000020, section + 36);
  return bytes;
}
type RecordFile = { file: string; bytes?: Buffer; dir: boolean; ino: number; links: number; version: number; alias?: string; symlink?: boolean };
function fixture() {
  const entries = new Map<string, RecordFile>(), descriptors = new Map<number, RecordFile>(); let next = 10;
  const key = (value: string) => value.toLowerCase(), exists = (file: string) => entries.has(key(file));
  const addDirectory = (file: string) => { if (exists(file)) return; const parent = win.dirname(file); if (parent !== file) addDirectory(parent); entries.set(key(file), { file, dir: true, ino: next++, links: 1, version: 1 }); };
  const add = (file: string, value: Buffer | string) => { addDirectory(win.dirname(file)); const record = { file, dir: false, bytes: Buffer.from(value), ino: next++, links: 1, version: 1 }; entries.set(key(file), record); return record; };
  const get = (file: string) => { const value = entries.get(key(file)); if (!value) throw Object.assign(new Error(SECRET), { code: "ENOENT" }); return value; };
  const stat = (record: RecordFile) => ({ dev: 1, ino: record.ino, size: record.bytes?.length ?? 0, nlink: record.links, mtimeMs: record.version, ctimeMs: record.version,
    isFile: () => !record.dir, isDirectory: () => record.dir, isSymbolicLink: () => record.symlink === true });
  const files = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0 }, lstatSync: (file: string) => stat(get(file)),
    realpathSync: { native: (file: string) => get(file).alias ?? get(file).file },
    mkdirSync(file: string) { if (exists(file) || !get(win.dirname(file)).dir) throw new Error(SECRET); addDirectory(file); },
    openSync(file: string) { const descriptor = next++; descriptors.set(descriptor, get(file)); return descriptor; },
    fstatSync(descriptor: number) { return stat(descriptors.get(descriptor)!); },
    readSync(descriptor: number, buffer: Buffer, offset: number, length: number, position: number) { return descriptors.get(descriptor)!.bytes!.copy(buffer, offset, position, position + length); },
    closeSync(descriptor: number) { if (!descriptors.delete(descriptor)) throw new Error(SECRET); },
    writeFileSync(file: string, bytes: Buffer | string, options: { flag: string }) { if (options.flag !== "wx" || exists(file)) throw new Error(SECRET); get(win.dirname(file)); add(file, bytes); },
  };
  addDirectory(ROOT); add(VSWHERE, "observed-vswhere"); add("C:\\Windows\\System32\\cmd.exe", "observed-cmd");
  add(`${INSTALL}\\VC\\Auxiliary\\Build\\vcvars64.bat`, "trusted-vcvars");
  add(`${INSTALL}\\VC\\Auxiliary\\Build\\Microsoft.VCToolsVersion.default.txt`, VERSION + "\r\n");
  const compiler = `${INSTALL}\\VC\\Tools\\MSVC\\${VERSION}\\bin\\Hostx64\\x64\\cl.exe`;
  add(compiler, "observed-cl"); add(win.join(win.dirname(compiler), "link.exe"), "observed-link");
  const sources = ["test/fixtures/windows-command-posix-proof.c", "scripts/experimental/build-windows-command-posix-proof.mjs",
    "app/main/agent/windows-command-copy.ts", "app/main/agent/windows-command-stop.ts", "app/main/agent/windows-command-copy-native.ts", "app/main/agent/windows-command-creator-profile.ts", "app/main/agent/windows-command-creator-token.ts", "app/main/agent/coding-platform.ts", "test/fixtures/windows-command-copy-proof-native.ts", "package.json", "package-lock.json", "tsconfig.json"];
  for (const name of sources) add(win.join(ROOT, name), `fixed source ${name}`);
  const calls: { program: string; args: string[]; options: Record<string, unknown> }[] = [], bundles: Record<string, unknown>[] = [];
  const hooks = { compile: undefined as undefined | (() => void), discovery: undefined as undefined | (() => string), bundle: undefined as undefined | (() => void) };
  const execute = (program: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ program, args, options });
    if (program === VSWHERE) return hooks.discovery?.() ?? INSTALL + "\r\n";
    expect(program).toBe("C:\\Windows\\System32\\cmd.exe"); hooks.compile?.(); add(win.join(DEST, "creator-posix-proof.exe"), pe()); return "captured compiler output " + SECRET;
  };
  const bundle = async (options: Record<string, unknown>) => {
    bundles.push(options); const inputs: Record<string, { bytes: number }> = { "creator-posix-fixed-entry.ts": { bytes: 0 } };
    let read: ((input: { path: string }) => { contents: Buffer }) | undefined;
    for (const plugin of options.plugins as { setup(builder: { onLoad(input: unknown, callback: typeof read): void }): void }[]) plugin.setup({ onLoad(_input, callback) { read = callback; } });
    for (const source of sources.filter(name => name.startsWith("app/") || name.startsWith("test/fixtures/") && name.endsWith(".ts"))) { const bytes = read!({ path: win.join(ROOT, source) }).contents; inputs[source] = { bytes: bytes.length }; }
    hooks.bundle?.(); return { metafile: { inputs }, outputFiles: [{ path: options.outfile, contents: Buffer.from('"use strict"; module.exports={};') }] };
  };
  const environment = { SystemRoot: "C:\\Windows", GITHUB_SHA: COMMIT, GH_TOKEN: SECRET, CL: SECRET, _CL_: SECRET, INCLUDE: SECRET, LIB: SECRET, NODE_OPTIONS: SECRET, NODE_PATH: SECRET };
  const api = bindWindowsCommandPosixProofBuild({ files, execute, bundle, root: ROOT, platform: "win32", arch: "x64", environment });
  const input = { destination: DEST, image: "windows-2022", commit: COMMIT };
  return { files, entries, get, add, addDirectory, calls, bundles, hooks, environment, compiler, api, input, descriptors };
}
async function refusal(promise: Promise<unknown>, stage?: number) {
  const error = await promise.catch((error: unknown) => error); expect(error).toBeInstanceOf(WindowsCommandPosixBuildError);
  const value = error as { observation: { stage: number; domain: number; code: number }; stack: string };
  if (stage !== undefined) expect(value.observation.stage).toBe(stage);
  expect(Object.isFrozen(value.observation)).toBe(true); expect(JSON.stringify(error)).not.toContain(SECRET); expect(value.stack).not.toContain(SECRET);
  expect(Object.values(value.observation).every(Number.isInteger)).toBe(true); return value;
}

describe("fixed Windows proof build boundaries", () => {
  it.each(["windows-2022", "windows-2025"])("selects only the explicit image %s", image => {
    const selected = windowsCommandPosixBuildImage(image); expect(selected.range).toBe(image === "windows-2022" ? "[17.0,18.0)" : "[18.0,19.0)"); expect(Object.isFrozen(selected)).toBe(true);
  });
  it.each([undefined, "windows-latest", "windows-2019", "Windows-2025", "2025", SECRET])("refuses undeclared image %s", value => expect(() => windowsCommandPosixBuildImage(value)).toThrow(WindowsCommandPosixBuildError));
  it.each(["\\\\server\\share", "C:relative", "C:\\repo\\..\\file", "C:\\repo\\file:stream", "C:\\repo\\file.", "C:\\repo\\file ", "C:\\repo\\a%PATH%", "C:\\repo\\a&other", "C:\\repo\\x\n", "C:\\PROGRA~1\\x", "C:\\repo\\nul.exe", "C:/repo/file"])("refuses alias/control/shell path %#", value => expect(() => windowsCommandPosixBuildPath(value)).toThrow());
  it("accepts quoted ordinary drive paths including the actual VS installer directory", () => { expect(windowsCommandPosixBuildPath(VSWHERE)).toBe(VSWHERE); expect(windowsCommandPosixBuildPath(DEST)).toBe(DEST); });
  it("supplies fresh profiles and excludes every ambient selector, credential and node hook", () => {
    const f = fixture(), env = windowsCommandPosixBuildEnvironment(f.environment, DEST);
    expect(JSON.stringify(env)).not.toContain(SECRET); expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Windows"); expect(env.USERPROFILE).toBe(win.join(DEST, "profile"));
    for (const name of ["CL", "_CL_", "LINK", "_LINK_", "INCLUDE", "LIB", "LIBPATH", "NODE_PATH", "NODE_OPTIONS", "GH_TOKEN", "GITHUB_SHA"]) expect(env).not.toHaveProperty(name);
    expect(Object.isFrozen(env)).toBe(true);
  });
  it("refuses case-folded environment aliases even when values agree", () => expect(() => windowsCommandPosixBuildEnvironment({ SystemRoot: "C:\\Windows", SYSTEMROOT: "C:\\Windows" }, DEST)).toThrow());
  it("uses captured bounded compiler/discovery IO and fixed tool/component/flags without inherited shell hooks", async () => {
    const f = fixture(), result = await f.api.prepareWindowsCommandPosixProof(f.input);
    expect(f.calls).toHaveLength(2); expect(f.calls[0].program).toBe(VSWHERE); expect(f.calls[0].args).toEqual(["-latest", "-version", "[17.0,18.0)", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"]);
    for (const call of f.calls) { expect(call.options.stdio).toEqual(["ignore", "pipe", "pipe"]); expect(call.options.cwd).toBe(DEST); expect(JSON.stringify(call.options.env)).not.toContain(SECRET); expect(call.options.timeout).toBeLessThanOrEqual(120000); expect(call.options.maxBuffer).toBeLessThanOrEqual(512 * 1024); }
    expect(f.calls[1].args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]); expect(f.calls[1].options.windowsVerbatimArguments).toBe(true);
    const recipe = f.get(win.join(DEST, "compile.cmd")).bytes!.toString(); expect(recipe).toContain(`"${f.compiler}" /nologo /W4 /WX /O2 /MT /utf-8 /TC`); expect(recipe).toContain("/MACHINE:X64"); expect(recipe).not.toContain(SECRET);
    expect(result.receipt).toMatchObject({ schema: 1, issuer: "ember-root-only-creator-posix-observed-build-v1", scope: 2, image: 2022, commit: COMMIT, tools: 6 }); expect(JSON.stringify(result.receipt)).not.toMatch(/D:\\|C:\\|PRIVATE|stdout|stderr/);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.receipt)).toBe(true); expect(f.descriptors.size).toBe(0);
    expect(f.api.verifyWindowsCommandPosixProof(result, f.input)).toBe(result.receipt);
  });
  it.each(["consumed", "unconsumed"])("permanently refuses verify and prepare IO after an unknown %s descriptor close", async disposition => {
    const f = fixture(), result = await f.api.prepareWindowsCommandPosixProof(f.input), originalClose = f.files.closeSync;
    let attempts = 0; f.files.closeSync = descriptor => { attempts++; if (disposition === "consumed") originalClose(descriptor); throw new Error(SECRET); };
    await refusal(Promise.resolve().then(() => f.api.verifyWindowsCommandPosixProof(result, f.input)), 8); expect(attempts).toBe(1);
    f.files.closeSync = originalClose;
    const open = vi.spyOn(f.files, "openSync"), stat = vi.spyOn(f.files, "lstatSync"), calls = f.calls.length;
    await refusal(Promise.resolve().then(() => f.api.verifyWindowsCommandPosixProof(result, f.input)), 8);
    await refusal(f.api.prepareWindowsCommandPosixProof(f.input), 1);
    expect(open).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(calls); expect(attempts).toBe(1);
  });
  it("retires an in-flight prepare poisoned by a verify close during its awaited bundle", async () => {
    const f = fixture(), result = await f.api.prepareWindowsCommandPosixProof(f.input), originalClose = f.files.closeSync;
    const destination = DEST.replace(/abc$/, "abd"), write = vi.spyOn(f.files, "writeFileSync"), calls = f.calls.length;
    let failure: unknown, writesAtPoison = -1, callsAtPoison = -1;
    f.hooks.bundle = () => {
      f.files.closeSync = descriptor => { originalClose(descriptor); throw new Error(SECRET); };
      try { f.api.verifyWindowsCommandPosixProof(result, f.input); } catch (error) { failure = error; }
      finally { f.files.closeSync = originalClose; }
      writesAtPoison = write.mock.calls.length; callsAtPoison = f.calls.length;
    };
    await refusal(f.api.prepareWindowsCommandPosixProof({ ...f.input, destination }));
    expect(failure).toBeInstanceOf(WindowsCommandPosixBuildError); expect(writesAtPoison).toBe(0); expect(write).toHaveBeenCalledTimes(writesAtPoison);
    expect(f.calls).toHaveLength(callsAtPoison); expect(f.calls).toHaveLength(calls + 1); expect(f.entries.has(destination.toLowerCase())).toBe(true);
    expect(f.entries.has(win.join(destination, "creator-posix.cjs").toLowerCase())).toBe(false);
  });
  it.each(["image", "commit", "destination"])("refuses bad %s before any tool invocation", async key => {
    const f = fixture(); const input = { ...f.input, [key]: key === "image" ? "windows-latest" : key === "commit" ? "b".repeat(40) : "D:\\outside\\.ember-creator-posix-build-12345678-1234-1234-1234-123456789abc" };
    await refusal(f.api.prepareWindowsCommandPosixProof(input), 1); expect(f.calls).toHaveLength(0);
  });
  it("refuses preexisting destination without changing it", async () => { const f = fixture(); f.addDirectory(DEST); await refusal(f.api.prepareWindowsCommandPosixProof(f.input), 1); expect(f.calls).toHaveLength(0); });
  it.each(["tool-symlink", "tool-alias", "parent-symlink"])("refuses tool path authority %s before its launch", async mode => {
    const f = fixture(); if (mode === "tool-symlink") f.get(VSWHERE).symlink = true; if (mode === "tool-alias") f.get(VSWHERE).alias = "C:\\other\\vswhere.exe";
    if (mode === "parent-symlink") f.get(win.dirname(VSWHERE)).symlink = true;
    await refusal(f.api.prepareWindowsCommandPosixProof(f.input), 2); expect(f.calls).toHaveLength(0);
  });
  it("allows observed OS tool hardlinks while refusing hardlinks for freshly emitted assets", async () => {
    const f = fixture(); f.get("C:\\Windows\\System32\\cmd.exe").links = 2; const result = await f.api.prepareWindowsCommandPosixProof(f.input);
    f.get(result.module).links = 2; await refusal(Promise.resolve().then(() => f.api.verifyWindowsCommandPosixProof(result, f.input)), 8);
  });
  it.each(["multi-line", "short-alias", "compiler-flags"])("refuses malformed discovery metadata %s", async mode => {
    const f = fixture(); f.hooks.discovery = () => mode === "multi-line" ? INSTALL + "\r\nC:\\other\r\n" : mode === "short-alias" ? "C:\\PROGRA~1\\VS\r\n" : INSTALL + " & bad\r\n";
    await refusal(f.api.prepareWindowsCommandPosixProof(f.input), 2); expect(f.calls).toHaveLength(1);
  });
  it("captures numeric compiler failure and never forwards compiler text/cause/path", async () => {
    const f = fixture(); f.hooks.compile = () => { throw Object.assign(new Error(SECRET), { status: 2, stdout: SECRET, stderr: SECRET, cause: new Error(SECRET) }); };
    const error = await refusal(f.api.prepareWindowsCommandPosixProof(f.input), 4); expect(error.observation).toEqual({ stage: 4, domain: 2, code: 2 });
  });
  it.each(["source", "compiler", "module", "clone"])("refuses %s mutation across the compiler boundary", async kind => {
    const f = fixture(); f.hooks.compile = () => { const target = kind === "source" ? win.join(ROOT, "app/main/agent/windows-command-stop.ts") : kind === "compiler" ? f.compiler : win.join(DEST, kind === "module" ? "creator-posix.cjs" : "fixed-creator-posix.c"); f.get(target).bytes = Buffer.from(SECRET); f.get(target).version++; };
    await refusal(f.api.prepareWindowsCommandPosixProof(f.input), kind === "module" ? 6 : 5);
  });
  it.each(["source", "tool", "executable", "module"])("verify refuses post-build %s mutation", async kind => {
    const f = fixture(), result = await f.api.prepareWindowsCommandPosixProof(f.input), target = kind === "source" ? win.join(ROOT, "app/main/agent/windows-command-stop.ts") : kind === "tool" ? f.compiler : kind === "executable" ? result.executable : result.module;
    f.get(target).bytes = Buffer.from(SECRET); f.get(target).version++; await refusal(Promise.resolve().then(() => f.api.verifyWindowsCommandPosixProof(result, f.input)));
  });
  it("rejects result/receipt copies, foreign builder brands and wrong expected image/commit", async () => {
    const f = fixture(), result = await f.api.prepareWindowsCommandPosixProof(f.input);
    for (const copied of [{ ...result }, { ...result, receipt: { ...result.receipt } }, {}, null]) await refusal(Promise.resolve().then(() => f.api.verifyWindowsCommandPosixProof(copied, f.input)), 8);
    const other = fixture(); await refusal(Promise.resolve().then(() => other.api.verifyWindowsCommandPosixProof(result, f.input)), 8);
    for (const expected of [{ ...f.input, image: "windows-2025" }, { ...f.input, commit: "b".repeat(40) }]) await refusal(Promise.resolve().then(() => f.api.verifyWindowsCommandPosixProof(result, expected)), 8);
  });
  it("does not let the old builder authenticate the distinct creator-owner executable or receipt", async () => {
    const f = fixture(), result = await f.api.prepareWindowsCommandPosixProof(f.input);
    expect(() => verifyWindowsCommandCopyProof(result, f.input)).toThrow("The fixed Windows root-only proof build was refused.");
    const oldDestination = { ...f.input, destination: f.input.destination.replace(".ember-creator-posix-build-", ".ember-root-copy-build-") };
    await refusal(f.api.prepareWindowsCommandPosixProof(oldDestination), 1);
  });
  it("snapshot acquisition and unknown close failures leave no receipt and expose fixed fields only", async () => {
    const f = fixture(); f.files.closeSync = () => { throw new Error(SECRET); }; await refusal(f.api.prepareWindowsCommandPosixProof(f.input), 2); expect(f.calls).toHaveLength(0); expect(f.descriptors.size).toBe(1);
  });
  it("refuses a file identity/timestamp change during its bounded descriptor read before tool launch", async () => {
    const f = fixture(), read = f.files.readSync; let changed = false;
    f.files.readSync = (...args) => { const count = read(...args); if (!changed) { changed = true; f.get(VSWHERE).version++; } return count; };
    await refusal(f.api.prepareWindowsCommandPosixProof(f.input), 2); expect(f.calls).toHaveLength(0); expect(f.descriptors.size).toBe(0);
  });
});

describe("bounded x64 console PE admission", () => {
  it("accepts a bounded executable entry and returns only immutable bytes/hash metadata", () => { const info = validateWindowsCommandPosixProofPe(pe()); expect(info.bytes).toBe(1024); expect(info.sha256).toMatch(/^[a-f0-9]{64}$/); expect(Object.isFrozen(info)).toBe(true); });
  it.each(["dos", "offset", "signature", "machine", "optional", "dll", "subsystem", "entry", "section", "raw", "directories", "header"])("refuses malformed PE %s", mode => {
    const bytes = pe(), at = 128, optional = at + 24, section = optional + 240;
    if (mode === "dos") bytes[0] = 0; if (mode === "offset") bytes.writeUInt32LE(1000, 0x3c); if (mode === "signature") bytes.writeUInt32LE(0, at);
    if (mode === "machine") bytes.writeUInt16LE(0x14c, at + 4); if (mode === "optional") bytes.writeUInt16LE(224, at + 20); if (mode === "dll") bytes.writeUInt16LE(0x2002, at + 22);
    if (mode === "subsystem") bytes.writeUInt16LE(2, optional + 68); if (mode === "entry") bytes.writeUInt32LE(0, optional + 16); if (mode === "section") bytes.writeUInt32LE(0x40000040, section + 36);
    if (mode === "raw") bytes.writeUInt32LE(900, section + 20); if (mode === "directories") bytes.writeUInt32LE(17, optional + 108); if (mode === "header") bytes.writeUInt32LE(100, optional + 60);
    expect(() => validateWindowsCommandPosixProofPe(bytes)).toThrow(WindowsCommandPosixBuildError);
  });
  it.each([Buffer.alloc(0), Buffer.alloc(511), Buffer.alloc(16 * 1024 * 1024 + 1), "MZ", new Uint8Array(1024)])("refuses unbounded/non-Buffer PE %#", bytes => expect(() => validateWindowsCommandPosixProofPe(bytes)).toThrow());
  it("refuses concurrently mutable shared-backed PE input", () => { const shared = Buffer.from(new SharedArrayBuffer(1024)); pe().copy(shared); expect(() => validateWindowsCommandPosixProofPe(shared)).toThrow(); });
});

it("captures and reconciles the actual graph, excludes node_modules, and bundles exactly nineteen original creator-owner exports", async () => {
  const repo = fs.realpathSync.native(fileURLToPath(new URL("../../", import.meta.url))), directory = fs.mkdtempSync(path.join(repo, ".ember-creator-posix-build-unit-")), output = path.join(directory, "proof.cjs");
  try {
    const snapshot = (file: string) => { const bytes = fs.readFileSync(file); return { path: file, bytes, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; };
    const records = ["package.json", "package-lock.json", "tsconfig.json"].map(file => snapshot(path.join(repo, file)));
    const capture = windowsCommandPosixSourceCapture({ root: repo, records, snapshot, paths: path, validate(file: string) { if (fs.realpathSync.native(file) !== file) throw new Error("Source alias refused."); return file; } });
    const recipe = windowsCommandPosixBundleRecipe(repo, output, capture.plugin), built = await build(recipe);
    expect(recipe).toMatchObject({ target: "node22", format: "cjs", external: ["koffi", "zod"], nodePaths: [], write: false });
    const reconciliation = capture.reconcile(built), inputs = Object.keys(built.metafile!.inputs);
    expect(reconciliation.inputs).toBe(inputs.length - 1); expect(reconciliation.captured).toBe(reconciliation.inputs);
    expect(inputs.some(file => file.startsWith("packages/bubble/") && file.endsWith(".ts"))).toBe(true);
    expect(inputs.some(file => file.includes("node_modules"))).toBe(false);
    expect(inputs.filter(file => file.endsWith("app/main/agent/windows-command-creator-profile.ts"))).toHaveLength(1);
    expect(inputs.filter(file => file.endsWith("app/main/agent/windows-command-creator-token.ts"))).toHaveLength(1);
    const captured = capture.records() as { path: string; sha256: string }[];
    for (const file of inputs.filter(file => file !== "creator-posix-fixed-entry.ts")) expect(captured.some(record => record.path === path.resolve(repo, file))).toBe(true);
    expect(captured.some(record => record.path === path.join(repo, "package-lock.json"))).toBe(true);
    const uncaptured = { ...built, metafile: { ...built.metafile!, inputs: { ...built.metafile!.inputs, "node_modules/unapproved/index.js": { bytes: 1, imports: [] } } } };
    expect(() => capture.reconcile(uncaptured)).toThrow(WindowsCommandPosixBuildError);
    expect(built.outputFiles).toHaveLength(1); fs.writeFileSync(output, built.outputFiles![0].contents, { flag: "wx" });
    const actual = createRequire(import.meta.url)(output);
    expect(Object.keys(actual).sort()).toEqual(["WindowsCommandCopyCleanupError", "WindowsCommandRootOnlyCleanupError", "WindowsRootOnlyCommandCopy", "WindowsRootOnlyCommandCopyCleanupError", "createWindowsCommandRootOnlyStopOwner", "requireWindowsCommandRootOnlyStopped", "loadWindowsCommandCopyProofNative", "WindowsCommandCopyProofCleanupError", "createFreshWindowsCommandTree", "windowsCommandCopyNativeFailure", "windowsCommandRootOnlyFailure", "ScopedCodingFileError", "createFreshWindowsCommandCreatorProfile", "windowsCommandCreatorProfile", "closeWindowsCommandCreatorProfile", "WindowsCommandCreatorProfileCleanupError", "requireWindowsCommandRootOnlyCompletion", "requireWindowsCommandRootOnlyAttestingCurrent", "takeWindowsCommandRootOnlyAttesting"].sort());
    expect(typeof actual.WindowsRootOnlyCommandCopy.create).toBe("function"); expect(typeof actual.createWindowsCommandRootOnlyStopOwner).toBe("function");
    expect(typeof actual.loadWindowsCommandCopyProofNative).toBe("function");
    expect(typeof actual.createFreshWindowsCommandTree).toBe("function");
    expect(typeof actual.createFreshWindowsCommandCreatorProfile).toBe("function");
    expect(() => actual.windowsCommandCreatorProfile(Object.freeze({}))).toThrow();
    expect(typeof actual.windowsCommandCopyNativeFailure).toBe("function");
    expect(actual.windowsCommandCopyNativeFailure(new Error(SECRET))).toBeUndefined();
    expect(actual.windowsCommandCopyNativeFailure(new actual.WindowsCommandCopyCleanupError())).toBeUndefined();
    expect(typeof actual.windowsCommandRootOnlyFailure).toBe("function");
    expect(actual.windowsCommandRootOnlyFailure(new Error(SECRET))).toBeUndefined();
    expect(actual.windowsCommandRootOnlyFailure(new actual.WindowsCommandRootOnlyCleanupError())).toBeUndefined();
    expect(classifyWindowsCommandCopyFileFailure(new actual.ScopedCodingFileError("cancelled"), actual.ScopedCodingFileError)).toBe(2);
    expect(classifyWindowsCommandCopyFileFailure(new ScopedCodingFileError("cancelled"), actual.ScopedCodingFileError)).toBe(0);
    expect(() => actual.requireWindowsCommandRootOnlyStopped({}, {})).toThrow();
    expect(() => actual.requireWindowsCommandRootOnlyCompletion({}, {})).toThrow();
    expect(() => actual.requireWindowsCommandRootOnlyAttestingCurrent({}, {})).toThrow();
    expect(() => actual.takeWindowsCommandRootOnlyAttesting({}, {})).toThrow();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

it("compile recipe rejects an injected path before producing any shell command", () => {
  expect(() => windowsCommandPosixCompileRecipe({ vcvars: "C:\\bad&other.bat", compiler: "C:\\cl.exe", source: "C:\\source.c", executable: "C:\\out.exe", object: "C:\\out.obj" })).toThrow();
});
