/** Separate fixed ordinary-host open-target control build. No project input, old issuer, download or product gate. */
import fs from "node:fs";
import path from "node:path/win32";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const repository = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
const VSWHERE = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
const C_SOURCE = "test/fixtures/windows-open-target-replace.c";
const BUILDER = "scripts/experimental/build-windows-open-target-replace.mjs";
const PROOF_NATIVE = "test/fixtures/windows-command-copy-proof-native.ts";
const NATIVE = "test/fixtures/windows-open-target-replace-native.ts";
const HOST = "test/fixtures/windows-command-creator-owner-host.ts";
const MODULES = [NATIVE, "app/main/agent/windows-command-stop.ts", "app/main/agent/windows-command-creator-profile.ts",
  "app/main/agent/windows-command-creator-token.ts", HOST, PROOF_NATIVE];
const FIXTURE_MODULES = new Set([NATIVE, HOST, PROOF_NATIVE, "test/fixtures/windows-open-target-replace-report.ts",
  "test/fixtures/windows-command-creator-owner-report.ts", "test/fixtures/windows-command-copy-report.ts"]);
const FIXED_INPUTS = [C_SOURCE, BUILDER, ...MODULES, "package.json", "package-lock.json", "tsconfig.json"];
const WRAPPER = 'export { loadWindowsOpenTargetReplaceNative, WindowsOpenTargetReplaceCleanupError } from "./test/fixtures/windows-open-target-replace-native.ts";\n' +
  'export { createWindowsCommandRootOnlyStopOwner, requireWindowsCommandRootOnlyPreparing, requireWindowsCommandRootOnlyCompletion, WindowsCommandRootOnlyCleanupError, windowsCommandRootOnlyFailure } from "./app/main/agent/windows-command-stop.ts";\n' +
  'export { createFreshWindowsCommandCreatorProfile, windowsCommandCreatorProfile, closeWindowsCommandCreatorProfile, WindowsCommandCreatorProfileCleanupError } from "./app/main/agent/windows-command-creator-profile.ts";\n' +
  'export { loadWindowsCommandCopyProofNative, WindowsCommandCopyProofCleanupError } from "./test/fixtures/windows-command-copy-proof-native.ts";\n';
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const brands = new WeakMap(), retainedDescriptors = [];
export class WindowsOpenTargetReplaceBuildError extends Error {
  constructor(stage, domain = 0, code = 0) {
    super("The fixed Windows open-target control build was refused."); this.name = "WindowsOpenTargetReplaceBuildError";
    this.stack = `${this.name}: ${this.message}`;
    this.observation = Object.freeze({ stage: Number.isInteger(stage) && stage >= 1 && stage <= 9 ? stage : 1,
      domain: Number.isInteger(domain) && domain >= 0 && domain <= 3 ? domain : 0,
      code: Number.isInteger(code) && code >= 0 && code <= 0xffffffff ? code : 0 });
  }
}
const refusal = stage => new WindowsOpenTargetReplaceBuildError(stage);
const fixedFailure = (stage, error) => {
  try {
    if (error instanceof WindowsOpenTargetReplaceBuildError) return new WindowsOpenTargetReplaceBuildError(stage, error.observation.domain, error.observation.code);
    if (Number.isInteger(error?.status) && error.status >= 0 && error.status <= 0xffffffff) return new WindowsOpenTargetReplaceBuildError(stage, 2, error.status);
    const codes = { ENOENT: 1, EACCES: 2, ETIMEDOUT: 3, ENOBUFS: 4 };
    if (typeof error?.code === "string" && Object.hasOwn(codes, error.code)) return new WindowsOpenTargetReplaceBuildError(stage, 3, codes[error.code]);
  } catch { /* Unknown properties never become outward metadata. */ }
  return refusal(stage);
};
export function windowsOpenTargetReplaceBuildImage(image) {
  if (image !== "windows-2022" && image !== "windows-2025") throw refusal(1);
  return Object.freeze({ image, ordinal: image === "windows-2022" ? 2022 : 2025, range: image === "windows-2022" ? "[17.0,18.0)" : "[18.0,19.0)" });
}
export function windowsOpenTargetReplaceBuildPath(value) {
  if (typeof value !== "string" || value.length < 4 || value.length > 4096 || !/^[A-Za-z]:\\/.test(value) || path.normalize(value) !== value ||
      /[/~%!^&|<>";\p{Cc}\p{Cf}]/u.test(value) || value.slice(3).split("\\").some(part => !part || part.includes(":") || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw refusal(1);
  return value;
}
/** Only OS bootstrap metadata is retained. Compiler flags, SDK selectors, profiles, credentials and hooks are absent. */
export function windowsOpenTargetReplaceBuildEnvironment(base, destination) {
  windowsOpenTargetReplaceBuildPath(destination);
  const seen = new Set();
  for (const key of Object.keys(base)) { const folded = key.toLowerCase(); if (seen.has(folded)) throw refusal(1); seen.add(folded); }
  const key = Object.keys(base).find(name => name.toLowerCase() === "systemroot");
  const windows = windowsOpenTargetReplaceBuildPath(key ? base[key] : "C:\\Windows");
  return Object.freeze({ SystemRoot: windows, WINDIR: windows, ComSpec: path.join(windows, "System32", "cmd.exe"),
    SystemDrive: windows.slice(0, 2), ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramW6432: "C:\\Program Files",
    PATH: `${path.join(windows, "System32")};${windows}`, PATHEXT: ".COM;.EXE;.BAT;.CMD", PROCESSOR_ARCHITECTURE: "AMD64", NUMBER_OF_PROCESSORS: "2",
    USERPROFILE: path.join(destination, "profile"), LOCALAPPDATA: path.join(destination, "profile", "Local"), APPDATA: path.join(destination, "profile", "Roaming"),
    TEMP: path.join(destination, "temporary"), TMP: path.join(destination, "temporary"), VSCMD_SKIP_SENDTELEMETRY: "1" });
}
/** No arbitrary compiler arguments. The installed trusted vcvars script supplies its own SDK/include/library configuration. */
export function windowsOpenTargetReplaceCompileRecipe({ vcvars, compiler, source, executable, object }) {
  for (const value of [vcvars, compiler, source, executable, object]) windowsOpenTargetReplaceBuildPath(value);
  return `@echo off\r\ncall "${vcvars}" >nul 2>nul\r\nif errorlevel 1 exit /b 1\r\n` +
    `"${compiler}" /nologo /W4 /WX /O2 /MT /utf-8 /TC /DUNICODE /D_UNICODE /Fo"${object}" /Fe"${executable}" "${source}" /link /SUBSYSTEM:CONSOLE /MACHINE:X64 /INCREMENTAL:NO kernel32.lib\r\nexit /b %errorlevel%\r\n`;
}
/** Fixed module exports/options, reusable by the portable real-esbuild contract test. No arbitrary entry point is accepted. */
export function windowsOpenTargetReplaceBundleRecipe(root, outfile, plugin) {
  return { stdin: { contents: WRAPPER, resolveDir: root, sourcefile: "open-target-fixed-entry.ts", loader: "ts" }, absWorkingDir: root,
    bundle: true, platform: "node", format: "cjs", target: "node22", external: ["koffi", "zod"], nodePaths: [], write: false,
    sourcemap: false, metafile: true, logLevel: "silent", outfile, ...(plugin ? { plugins: [plugin] } : {}) };
}
/** Actual production capture and reconciliation; path rules alone are injectable for the portable real-esbuild test. */
export function windowsOpenTargetReplaceSourceCapture({ root, records, snapshot, paths = path, validate = windowsOpenTargetReplaceBuildPath }) {
  const key = file => paths.resolve(root, file).replaceAll("\\", "/").toLowerCase();
  const loaded = new Map(records.map(record => [key(record.path), record])), consumed = new Set();
  let total = records.reduce((count, record) => count + record.size, 0);
  const plugin = { name: "open-target-fixed-host-source-bytes", setup(builder) { builder.onLoad({ filter: /\.(?:ts|json)$/ }, args => {
    const file = validate(args.path), relative = paths.relative(root, file).replaceAll("\\", "/").toLowerCase();
    if (!(relative.startsWith("app/") || relative.startsWith("packages/") && relative.endsWith(".ts") || FIXTURE_MODULES.has(relative))) throw refusal(3);
    const identifier = key(file); let record = loaded.get(identifier);
    if (!record) { record = snapshot(file, 4 * 1024 * 1024); total += record.size; loaded.set(identifier, record); }
    if (loaded.size > 256 || total > 16 * 1024 * 1024) throw refusal(3);
    consumed.add(identifier); return { contents: record.bytes, loader: file.endsWith(".json") ? "json" : "ts" };
  }); } };
  return Object.freeze({ plugin,
    records: () => [...loaded.values()],
    reconcile(output) {
      if (!output.metafile || !output.metafile.inputs || typeof output.metafile.inputs !== "object") throw refusal(3);
      const inputs = new Set();
      for (const [name, input] of Object.entries(output.metafile.inputs)) {
        if (name === "open-target-fixed-entry.ts") continue;
        const file = key(name), record = loaded.get(file);
        if (!record || record.size !== input.bytes || !consumed.has(file)) throw refusal(3); inputs.add(file);
      }
      if (MODULES.some(name => !inputs.has(key(name)))) throw refusal(3);
      return Object.freeze({ inputs: inputs.size, captured: consumed.size });
    },
  });
}
export function validateWindowsOpenTargetReplaceProofPe(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.buffer instanceof SharedArrayBuffer || bytes.length < 512 || bytes.length > 16 * 1024 * 1024 || bytes.readUInt16LE(0) !== 0x5a4d) throw refusal(6);
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 64 || pe > bytes.length - 264 || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) throw refusal(6);
  const sections = bytes.readUInt16LE(pe + 6), size = bytes.readUInt16LE(pe + 20), flags = bytes.readUInt16LE(pe + 22), optional = pe + 24;
  if (sections < 1 || sections > 32 || size !== 240 || (flags & 0x2000) || !(flags & 2) || bytes.readUInt16LE(optional) !== 0x20b ||
      bytes.readUInt16LE(optional + 68) !== 3 || bytes.readUInt32LE(optional + 16) === 0 || bytes.readUInt32LE(optional + 108) !== 16 ||
      optional + size + sections * 40 > bytes.length) throw refusal(6);
  const headers = bytes.readUInt32LE(optional + 60), imageSize = bytes.readUInt32LE(optional + 56), entry = bytes.readUInt32LE(optional + 16);
  if (headers < optional + size + sections * 40 || headers > bytes.length || !imageSize || entry >= imageSize) throw refusal(6);
  let executableEntry = false; const intervals = [];
  for (let index = 0; index < sections; index++) {
    const section = optional + size + index * 40, virtualSize = bytes.readUInt32LE(section + 8), address = bytes.readUInt32LE(section + 12),
      rawSize = bytes.readUInt32LE(section + 16), raw = bytes.readUInt32LE(section + 20), characteristics = bytes.readUInt32LE(section + 36);
    if (address >= imageSize || Math.max(virtualSize, rawSize) > imageSize - address || (rawSize && (raw < headers || raw > bytes.length || rawSize > bytes.length - raw))) throw refusal(6);
    if (rawSize) { if (intervals.some(([start, end]) => raw < end && raw + rawSize > start)) throw refusal(6); intervals.push([raw, raw + rawSize]); }
    if ((characteristics & 0x20000000) && entry >= address && entry - address < Math.min(virtualSize, rawSize)) executableEntry = true;
  }
  if (!executableEntry) throw refusal(6);
  return Object.freeze({ bytes: bytes.length, sha256: digest(bytes) });
}

/** Test seam only. Production always uses the real filesystem, host facts, captured execFileSync and esbuild below. */
export function bindWindowsOpenTargetReplaceProofBuild({ files = fs, execute = execFileSync, bundle = build, root = repository,
  platform = process.platform, arch = process.arch, environment = process.env } = {}) {
  let stage = 1, unknownClose = false;
  const live = () => { if (unknownClose) throw refusal(stage); };
  const io = operation => { live(); const value = operation(); live(); return value; };
  const ordinary = file => {
    live();
    windowsOpenTargetReplaceBuildPath(file);
    let parent = path.dirname(file);
    for (;;) { const info = io(() => files.lstatSync(parent)); if (!info.isDirectory() || info.isSymbolicLink()) throw refusal(stage); const next = path.dirname(parent); if (next === parent) break; parent = next; }
    const info = io(() => files.lstatSync(file));
    if (info.isSymbolicLink() || io(() => files.realpathSync.native(file)).toLowerCase() !== file.toLowerCase()) throw refusal(stage);
    return info;
  };
  const snapshot = (file, maximum = 64 * 1024 * 1024, singleLink = false) => {
    live();
    const before = ordinary(file); let fd, bytes, failure;
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > maximum || !Number.isInteger(before.nlink) || before.nlink < 1 || (singleLink && before.nlink !== 1)) throw refusal(stage);
    const same = value => value.isFile() && value.dev === before.dev && value.ino === before.ino && value.size === before.size && value.mtimeMs === before.mtimeMs && value.ctimeMs === before.ctimeMs && value.nlink === before.nlink;
    try {
      live(); fd = files.openSync(file, files.constants.O_RDONLY | (files.constants.O_NOFOLLOW ?? 0)); live();
      if (!same(io(() => files.fstatSync(fd)))) throw refusal(stage);
      bytes = Buffer.alloc(before.size + 1); let offset = 0;
      while (offset < bytes.length) { const count = io(() => files.readSync(fd, bytes, offset, bytes.length - offset, offset)); if (!Number.isInteger(count) || count < 0 || count > bytes.length - offset) throw refusal(stage); if (!count) break; offset += count; }
      if (offset !== before.size || !same(io(() => files.fstatSync(fd))) || !same(ordinary(file))) throw refusal(stage);
      bytes = bytes.subarray(0, offset);
    } catch (error) { failure = error; }
    if (fd !== undefined) {
      if (unknownClose) { retainedDescriptors.push({ files, descriptor: fd, bytes }); throw refusal(stage); }
      try { files.closeSync(fd); } catch { unknownClose = true; retainedDescriptors.push({ files, descriptor: fd, bytes }); throw refusal(stage); }
      live();
    }
    if (failure) { bytes?.fill(0); throw failure; }
    return { path: file, bytes, sha256: digest(bytes), size: bytes.length, dev: before.dev, ino: before.ino };
  };
  const recheck = records => { for (const before of records) { const after = snapshot(before.path); if (after.sha256 !== before.sha256 || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino) throw refusal(stage); } };
  const run = (program, args, env, cwd, timeout, maximum = 512 * 1024, verbatim = false) => {
    const output = io(() => execute(program, args, { cwd, env, encoding: "utf8", timeout, maxBuffer: maximum, windowsHide: true,
      windowsVerbatimArguments: verbatim, stdio: ["ignore", "pipe", "pipe"] }));
    if (typeof output !== "string" || Buffer.byteLength(output) > maximum) throw refusal(stage);
    return output;
  };
  const verify = (result, expected) => {
    stage = 8;
    try {
      live();
      const record = brands.get(result);
      if (!record || record.owner !== verify || !expected || expected.image !== record.image || expected.commit !== record.commit ||
          result.receipt !== record.receipt || result.executable !== record.executable || result.module !== record.module) throw refusal(stage);
      recheck([...record.sources, ...record.tools, ...record.buildInputs]);
      const exe = snapshot(record.executable, 16 * 1024 * 1024, true), module = snapshot(record.module, 16 * 1024 * 1024, true);
      validateWindowsOpenTargetReplaceProofPe(exe.bytes);
      if (exe.sha256 !== record.receipt.executableSha256 || module.sha256 !== record.receipt.moduleSha256) throw refusal(stage);
      return record.receipt;
    } catch (error) { throw fixedFailure(stage, error); }
  };
  return Object.freeze({
    verifyWindowsOpenTargetReplaceProof: verify,
    async prepareWindowsOpenTargetReplaceProof({ destination, image, commit } = {}) {
      stage = 1;
      try {
        live();
        const selected = windowsOpenTargetReplaceBuildImage(image);
        if (platform !== "win32" || arch !== "x64" || typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit) || environment.GITHUB_SHA !== commit) throw refusal(stage);
        windowsOpenTargetReplaceBuildPath(root); windowsOpenTargetReplaceBuildPath(destination);
        if (path.dirname(destination).toLowerCase() !== root.toLowerCase() || !/^\.ember-open-target-build-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(path.basename(destination))) throw refusal(stage);
        ordinary(root);
        try { io(() => files.lstatSync(destination)); throw refusal(stage); } catch (error) { if (error?.code !== "ENOENT") throw error; }
        // Windows inherits the host checkout ACL here; mode is not an owner/SYSTEM DACL attestation. No package grant is made.
        io(() => files.mkdirSync(destination, { mode: 0o700 })); ordinary(destination);
        const env = windowsOpenTargetReplaceBuildEnvironment(environment, destination);
        for (const directory of [env.TEMP, env.USERPROFILE, env.LOCALAPPDATA, env.APPDATA]) io(() => files.mkdirSync(directory, { mode: 0o700 }));
        stage = 2;
        const tools = [snapshot(VSWHERE), snapshot(env.ComSpec)];
        const found = run(VSWHERE, ["-latest", "-version", selected.range, "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], env, destination, 15_000, 32 * 1024);
        const installation = windowsOpenTargetReplaceBuildPath(found.replace(/\r?\n$/, "")); ordinary(installation);
        const vcvars = path.join(installation, "VC", "Auxiliary", "Build", "vcvars64.bat"), versionFile = path.join(installation, "VC", "Auxiliary", "Build", "Microsoft.VCToolsVersion.default.txt");
        tools.push(snapshot(vcvars), snapshot(versionFile, 128));
        const version = tools.at(-1).bytes.toString("utf8").replace(/\r?\n$/, ""); if (!/^14\.\d{2}\.\d{5}$/.test(version)) throw refusal(stage);
        const toolRoot = path.join(installation, "VC", "Tools", "MSVC", version, "bin", "Hostx64", "x64"), compiler = path.join(toolRoot, "cl.exe");
        tools.push(snapshot(compiler), snapshot(path.join(toolRoot, "link.exe")));
        stage = 3;
        const sources = FIXED_INPUTS.map(name => snapshot(path.join(root, name), 4 * 1024 * 1024));
        const capture = windowsOpenTargetReplaceSourceCapture({ root, records: sources, snapshot });
        const module = path.join(destination, "open-target.cjs"), executable = path.join(destination, "open-target.exe"), source = path.join(destination, "fixed-open-target.c");
        live(); const output = await bundle(windowsOpenTargetReplaceBundleRecipe(root, module, capture.plugin)); live(); capture.reconcile(output);
        if (!output.metafile || !Array.isArray(output.outputFiles) || output.outputFiles.length !== 1 || output.outputFiles[0].path.toLowerCase() !== module.toLowerCase()) throw refusal(stage);
        const moduleBytes = Buffer.from(output.outputFiles[0].contents); if (!moduleBytes.length || moduleBytes.length > 16 * 1024 * 1024) throw refusal(stage);
        io(() => files.writeFileSync(module, moduleBytes, { flag: "wx", mode: 0o600 })); io(() => files.writeFileSync(source, sources[0].bytes, { flag: "wx", mode: 0o600 }));
        stage = 4;
        const recipe = windowsOpenTargetReplaceCompileRecipe({ vcvars, compiler, source, executable, object: path.join(destination, "fixed-open-target.obj") });
        const command = path.join(destination, "compile.cmd"); io(() => files.writeFileSync(command, recipe, { flag: "wx", mode: 0o600 }));
        const buildInputs = [snapshot(source, 4 * 1024 * 1024, true), snapshot(command, 64 * 1024, true)];
        recheck(tools);
        run(env.ComSpec, ["/d", "/s", "/v:off", "/c", `""${command}""`], env, destination, 120_000, 512 * 1024, true);
        stage = 5; recheck([...capture.records(), ...tools, ...buildInputs]);
        const exe = snapshot(executable, 16 * 1024 * 1024, true), emitted = snapshot(module, 16 * 1024 * 1024, true);
        stage = 6; const pe = validateWindowsOpenTargetReplaceProofPe(exe.bytes); if (!moduleBytes.equals(emitted.bytes)) throw refusal(stage);
        stage = 7;
        const allSources = capture.records().sort((a, b) => a.path.localeCompare(b.path));
        const receipt = Object.freeze({ schema: 1, issuer: "ember-ordinary-host-open-target-build-v1", scope: 1, image: selected.ordinal, commit,
          sourceSha256: digest(JSON.stringify(allSources.map(record => [path.relative(root, record.path).replaceAll("\\", "/"), record.sha256, record.size]))),
          recipeSha256: digest(WRAPPER + recipe.replaceAll(destination, "<fresh>").replaceAll(installation, "<installed-vs>")),
          toolsSha256: digest(JSON.stringify(tools.map(record => [record.sha256, record.size]))), sources: allSources.length, tools: tools.length,
          executableSha256: pe.sha256, executableBytes: pe.bytes, moduleSha256: emitted.sha256, moduleBytes: emitted.size });
        const result = Object.freeze({ executable, module, receipt });
        brands.set(result, { owner: verify, image, commit, receipt, executable, module, sources: allSources, tools, buildInputs });
        return result;
      } catch (error) { throw fixedFailure(stage, error); }
    },
  });
}
const defaultBuilder = bindWindowsOpenTargetReplaceProofBuild();
export const prepareWindowsOpenTargetReplaceProof = defaultBuilder.prepareWindowsOpenTargetReplaceProof;
export const verifyWindowsOpenTargetReplaceProof = defaultBuilder.verifyWindowsOpenTargetReplaceProof;
