/** Portable admission/literal and installed-metadata contracts. No program execution or Windows DLLs. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  WINDOWS_NODE_PRODUCT_NATIVE_ARGV,
  WINDOWS_NODE_PRODUCT_NATIVE_CASES,
  WINDOWS_NODE_PRODUCT_NATIVE_CWD,
  WINDOWS_NODE_PRODUCT_NATIVE_PREREQUISITE,
  requireWindowsNodeProductNativeAdmission,
} from "../fixtures/windows-node-product-native";

const fixture = fs.readFileSync(new URL("../fixtures/windows-node-product-native.ts", import.meta.url), "utf8");
const program = fs.readFileSync(new URL("../fixtures/windows-node-product-native-program.cjs", import.meta.url), "utf8");
const integration = fs.readFileSync(new URL("../integration/windows-node-product-native.test.ts", import.meta.url), "utf8");
const commit = "0123456789abcdef0123456789abcdef01234567";
type Admission = Parameters<typeof requireWindowsNodeProductNativeAdmission>[0];
const admitted: Admission = { required: true, platform: "win32", arch: "x64", image: "windows-2022", commit };

// Re-export only the private metadata reader in memory. This does not issue resource/native references or launch code.
const metadataModule = { exports: {} as { fixedInstalledElectronResources(repository: string, graph: { metadataFiles: Set<number>; buffers: Buffer[] }): string } };
const metadataSource = transformSync(fixture + "\nexport { fixedInstalledElectronResources };", { loader: "ts", format: "cjs", target: "node24",
  define: { "import.meta.url": JSON.stringify(pathToFileURL(path.join(process.cwd(), "test/fixtures/windows-node-product-native.ts")).href) }, logLevel: "silent" }).code;
new Script(metadataSource, { filename: "fixed-installed-electron-metadata.cjs" }).runInNewContext({ module: metadataModule, exports: metadataModule.exports,
  require: createRequire(import.meta.url), Buffer, URL, process, setTimeout, clearTimeout });

function metadataFixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fixed-electron-metadata-"))), repository = path.join(root, "repository");
  const installed = path.join(repository, "node_modules/electron"), dist = path.join(installed, "dist"), resources = path.join(dist, "resources");
  fs.mkdirSync(resources, { recursive: true });
  const owner = { name: "ember", devDependencies: { electron: "44.9.3" } }, pkg = { name: "electron", version: "44.9.3", main: "index.cjs" };
  fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify(owner)); fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(installed, "path.txt"), "electron.exe");
  const marker = path.join(root, "index-executed.marker");
  fs.writeFileSync(path.join(installed, "index.cjs"), "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ",'bad');throw Error('The Electron index must never execute');\n");
  // Synthetic PE metadata only. These bytes are never executed and establish no Windows-native result.
  const pe = Buffer.alloc(8192); pe.write("MZ", "ascii"); pe.writeUInt32LE(0x80, 0x3c); pe.writeUInt32LE(0x4550, 0x80);
  pe.writeUInt16LE(0x8664, 0x84); pe.writeUInt16LE(0x20b, 0x98); pe.writeUInt16LE(2, 0xdc);
  const binary = path.join(dist, "electron.exe"); fs.writeFileSync(binary, pe);
  const graph = { metadataFiles: new Set<number>(), buffers: [] as Buffer[] };
  return { root, repository, installed, dist, resources, owner, pkg, marker, pe, binary, graph,
    read: () => metadataModule.exports.fixedInstalledElectronResources(repository, graph),
    close: () => { expect(graph.metadataFiles.size).toBe(0); for (const bytes of graph.buffers) bytes.fill(0); fs.rmSync(root, { recursive: true, force: false }); } };
}

describe("fixed installed Electron metadata", () => {
  it("uses the exact installed package metadata without executing its poison index or honoring an executable override", () => {
    const f = metadataFixture(), old = process.env.ELECTRON_OVERRIDE_DIST_PATH;
    try {
      process.env.ELECTRON_OVERRIDE_DIST_PATH = path.join(f.root, "foreign-electron");
      expect(f.read()).toBe(f.resources); expect(fs.existsSync(f.marker)).toBe(false);
      expect(f.graph.metadataFiles.size).toBe(0);
      expect(f.graph.buffers.some(bytes => bytes.length === 4096 && bytes.subarray(0, 2).toString("ascii") === "MZ")).toBe(true);
      expect(f.graph.buffers.some(bytes => bytes.length === f.pe.length)).toBe(false);
    } finally { if (old === undefined) delete process.env.ELECTRON_OVERRIDE_DIST_PATH; else process.env.ELECTRON_OVERRIDE_DIST_PATH = old; f.close(); }
  });

  it.each([
    ["owner package name", (f: ReturnType<typeof metadataFixture>) => fs.writeFileSync(path.join(f.repository, "package.json"), JSON.stringify({ ...f.owner, name: "other" }))],
    ["floating owner version", (f: ReturnType<typeof metadataFixture>) => fs.writeFileSync(path.join(f.repository, "package.json"), JSON.stringify({ ...f.owner, devDependencies: { electron: "^44.9.3" } }))],
    ["installed name", (f: ReturnType<typeof metadataFixture>) => fs.writeFileSync(path.join(f.installed, "package.json"), JSON.stringify({ ...f.pkg, name: "other" }))],
    ["installed version", (f: ReturnType<typeof metadataFixture>) => fs.writeFileSync(path.join(f.installed, "package.json"), JSON.stringify({ ...f.pkg, version: "44.9.2" }))],
    ["alternate executable", (f: ReturnType<typeof metadataFixture>) => fs.writeFileSync(path.join(f.installed, "path.txt"), "foreign.exe")],
    ["newline executable", (f: ReturnType<typeof metadataFixture>) => fs.writeFileSync(path.join(f.installed, "path.txt"), "electron.exe\n")],
    ["empty executable metadata", (f: ReturnType<typeof metadataFixture>) => fs.writeFileSync(path.join(f.installed, "path.txt"), "")],
    ["oversized executable metadata", (f: ReturnType<typeof metadataFixture>) => fs.writeFileSync(path.join(f.installed, "path.txt"), "x".repeat(65))],
    ["oversized package JSON", (f: ReturnType<typeof metadataFixture>) => fs.writeFileSync(path.join(f.repository, "package.json"), " ".repeat(1024 * 1024 + 1))],
    ["malformed UTF8", (f: ReturnType<typeof metadataFixture>) => fs.writeFileSync(path.join(f.repository, "package.json"), Buffer.from([0xff]))],
  ] as const)("refuses changed %s without index execution", (_name, change) => {
    const f = metadataFixture(); try { change(f); expect(f.read).toThrow(); expect(fs.existsSync(f.marker)).toBe(false); } finally { f.close(); }
  });

  it.each([
    ["DOS marker", (pe: Buffer) => pe.write("NO", "ascii")],
    ["PE offset", (pe: Buffer) => pe.writeUInt32LE(4096, 0x3c)],
    ["PE signature", (pe: Buffer) => pe.writeUInt32LE(0, 0x80)],
    ["machine", (pe: Buffer) => pe.writeUInt16LE(0x14c, 0x84)],
    ["optional header", (pe: Buffer) => pe.writeUInt16LE(0x10b, 0x98)],
    ["subsystem", (pe: Buffer) => pe.writeUInt16LE(3, 0xdc)],
  ] as const)("refuses invalid %s in its bounded PE prefix", (_name, change) => {
    const f = metadataFixture(); try { change(f.pe); fs.writeFileSync(f.binary, f.pe); expect(f.read).toThrow(); expect(fs.existsSync(f.marker)).toBe(false); } finally { f.close(); }
  });

  it("refuses an exported alternate metadata path instead of accepting another resolved package member", () => {
    const f = metadataFixture();
    try {
      fs.writeFileSync(path.join(f.installed, "alternate.json"), JSON.stringify(f.pkg));
      fs.writeFileSync(path.join(f.installed, "package.json"), JSON.stringify({ ...f.pkg, exports: { "./package.json": "./alternate.json" } }));
      expect(f.read).toThrow(); expect(fs.existsSync(f.marker)).toBe(false);
    } finally { f.close(); }
  });

  it("refuses a hardlinked executable before any native execution", () => {
    const f = metadataFixture(); try { fs.linkSync(f.binary, path.join(f.root, "binary-alias")); expect(f.read).toThrow(); expect(fs.existsSync(f.marker)).toBe(false); } finally { f.close(); }
  });

  it("refuses a resources-directory alias rather than following it", () => {
    const f = metadataFixture();
    try { const foreign = path.join(f.root, "foreign-resources"); fs.mkdirSync(foreign); fs.rmdirSync(f.resources); fs.symlinkSync(foreign, f.resources, "junction"); expect(f.read).toThrow(); expect(fs.existsSync(f.marker)).toBe(false); }
    finally { f.close(); }
  });

  it("keeps metadata descriptors in the private graph until positive close and does not call the Electron index", () => {
    expect(fixture).toContain('createRequire(path.join(repository, "package.json")).resolve("electron/package.json")');
    expect(fixture).not.toContain('createRequire(import.meta.url)("electron")');
    expect(fixture).not.toContain("ELECTRON_OVERRIDE_DIST_PATH");
    expect(fixture).toContain("graph.metadataFiles.add(fd)");
    expect(fixture).toContain("requireFact(fs.closeSync(fd) === undefined); graph.metadataFiles.delete(fd)");
    expect(fixture).toContain("graph.pending.size === 0 && graph.metadataFiles.size === 0");
  });
});

describe("native Windows Node product admission", () => {
  it.each([
    ["omitted required flag", { required: undefined }],
    ["disabled required flag", { required: false }],
    ["Linux", { platform: "linux" }],
    ["macOS", { platform: "darwin" }],
    ["32-bit Windows", { arch: "ia32" }],
    ["ARM Windows", { arch: "arm64" }],
    ["omitted image", { image: undefined }],
    ["floating image", { image: "windows-latest" }],
    ["numeric image", { image: 2022 }],
    ["omitted commit", { commit: undefined }],
    ["short commit", { commit: "a".repeat(39) }],
    ["long commit", { commit: "a".repeat(41) }],
    ["uppercase commit", { commit: "A".repeat(40) }],
    ["nonhex commit", { commit: "g".repeat(40) }],
  ])("refuses %s without producing admission facts", (_name, change) => {
    const input = { ...admitted, ...change } as Admission;
    let failure: unknown;
    try { requireWindowsNodeProductNativeAdmission(input); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error;
    expect(error.message).toBe("The native Windows Node product proof refused its admission phase; private state was retained.");
    expect(error.stack).toBe(`Error: ${error.message}`);
  });

  it.each([["windows-2022", 2022], ["windows-2025", 2025]])("returns immutable observations for %s only", (image, ordinal) => {
    const facts = requireWindowsNodeProductNativeAdmission({ ...admitted, image });
    expect(facts).toEqual({ image: ordinal, commit });
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.keys(facts).sort()).toEqual(["commit", "image"]);
  });

  it("keeps the authenticated producer and seven-case asset prerequisite closed", () => {
    expect(WINDOWS_NODE_PRODUCT_NATIVE_PREREQUISITE).toEqual({ ready: false,
      manifestSha256: null, assetProofCommit: null, assetProofManifestSha256: null });
    expect(Object.isFrozen(WINDOWS_NODE_PRODUCT_NATIVE_PREREQUISITE)).toBe(true);
  });

  it("uses only the fixed cases, literal argv and root cwd", () => {
    expect(WINDOWS_NODE_PRODUCT_NATIVE_CASES).toEqual(["natural-repair", "stopped"]);
    expect(WINDOWS_NODE_PRODUCT_NATIVE_ARGV).toEqual(["--preserve-symlinks", "--preserve-symlinks-main", "product-native.cjs", "exercise"]);
    expect(WINDOWS_NODE_PRODUCT_NATIVE_CWD).toBe("\\work");
    expect(Object.isFrozen(WINDOWS_NODE_PRODUCT_NATIVE_CASES)).toBe(true);
    expect(Object.isFrozen(WINDOWS_NODE_PRODUCT_NATIVE_ARGV)).toBe(true);
  });

  it("checks the actual process and closed prerequisite before filesystem setup or native imports", () => {
    const body = fixture.slice(fixture.indexOf("export async function runWindowsNodeProductNativeCase"));
    const admission = body.indexOf("requireWindowsNodeProductNativeAdmission({ required: process.env.EMBER_WINDOWS_NODE_PRODUCT_TEST");
    const prerequisite = body.indexOf("requireFact(prerequisite.ready");
    const nativeImport = body.indexOf('import("../../app/main/agent/project-coding-backend")');
    const scratch = body.indexOf("fs.mkdtempSync(");
    expect(admission).toBeGreaterThan(-1);
    expect(prerequisite).toBeGreaterThan(admission);
    expect(body.indexOf("fs.realpathSync.native(")).toBeGreaterThan(prerequisite);
    expect(scratch).toBeGreaterThan(prerequisite);
    expect(nativeImport).toBeGreaterThan(prerequisite);
    expect(body).toContain("platform: process.platform");
    expect(body).toContain("arch: process.arch");
    expect(body).toContain("image: process.env.EMBER_WINDOWS_NODE_PRODUCT_IMAGE");
    expect(body).toContain("commit: process.env.GITHUB_SHA");
    expect(integration).toContain('describe.skipIf(!required)');
    expect(integration).toContain('process.env.EMBER_WINDOWS_NODE_PRODUCT_TEST === "1"');
    expect(integration).not.toContain('skipIf(process.platform');
  });
});

describe("fixed native product program contract", () => {
  it("requires exact preserved-loader flags, bounded literal mode, root cwd and stdin EOF", () => {
    expect(program).toContain('assert.deepEqual(process.execArgv, ["--preserve-symlinks", "--preserve-symlinks-main"]);');
    expect(program).toContain('assert.deepEqual(process.argv.slice(2), [process.argv[2]]);');
    expect(program).toContain('assert.ok(process.argv[2] === "exercise" || process.argv[2] === "hold");');
    expect(program).toContain('assert.equal(path.dirname(process.argv[1]).toLowerCase(), process.cwd().toLowerCase());');
    expect(program).toContain('assert.equal(fs.readFileSync("root-marker.txt", "utf8"), "fixed-product-root\\n");');
    expect(program).toContain('assert.equal(fs.readSync(0, Buffer.alloc(1), 0, 1, null), 0);');
    for (const excluded of [".git", "node_modules"]) expect(program).toContain(`assert.equal(fs.existsSync("${excluded}"), false);`);
  });

  it("edits, creates, deletes and creates a directory before the first nonzero check", () => {
    for (const operation of [
      'fs.writeFileSync("app.txt", "answer=42\\n");',
      'fs.writeFileSync("created.txt", "created-by-fixed-node\\n", { flag: "wx" });',
      'fs.unlinkSync("deleted.txt");',
      'fs.mkdirSync("created-dir");',
      'fs.writeFileSync("phase.txt", "exercised\\n");',
    ]) expect(program).toContain(operation);
    expect(program).toContain('if (fs.readFileSync("phase.txt", "utf8") === "original\\n")');
    expect(program).toContain('const repaired = fs.readFileSync("check.txt", "utf8") === "2\\n";');
    expect(program).toContain("process.exitCode = repaired ? 0 : 17;");
  });

  it("replaces a genuinely held target, verifies old and new bytes, then closes the held descriptor", () => {
    const opened = program.indexOf('const held = fs.openSync("rename-target.txt", "r");');
    const renamed = program.indexOf('fs.renameSync("rename-new.txt", "rename-target.txt");');
    const oldRead = program.indexOf("fs.readSync(held, old, 0, old.length, 0)");
    const closed = program.indexOf("finally { fs.closeSync(held); }");
    expect(opened).toBeGreaterThan(-1);
    expect(renamed).toBeGreaterThan(opened);
    expect(oldRead).toBeGreaterThan(renamed);
    expect(closed).toBeGreaterThan(oldRead);
    expect(program).toContain('fs.writeFileSync("rename-new.txt", "replacement-target\\n", { flag: "wx" });');
    expect(program).toContain('assert.equal(old.toString("utf8"), "original-target\\n");');
    expect(program).toContain('assert.equal(fs.readFileSync("rename-target.txt", "utf8"), "replacement-target\\n");');
    expect(program).toContain('assert.equal(fs.existsSync("rename-new.txt"), false);');
  });

  it("emits exact bounded stdout/stderr and holds only after both fixed READY frames", () => {
    const outBytes = Buffer.byteLength("PRODUCT-OUT\n\nPRODUCT-EOF\n") + 72 * 1024;
    const errBytes = Buffer.byteLength("PRODUCT-ERR\n\nPRODUCT-DONE\n") + 66 * 1024;
    expect(outBytes).toBeGreaterThan(64 * 1024); expect(errBytes).toBeGreaterThan(64 * 1024);
    expect(outBytes + errBytes).toBeLessThan(256 * 1024);
    expect(program).toContain("const written = fs.writeSync(fd, value, offset, value.length - offset); assert.ok(written > 0); offset += written;");
    expect(program).toContain('writeAll(1, "PRODUCT-OUT\\n"); writeAll(1, Buffer.alloc(72 * 1024, 79)); writeAll(1, "\\nPRODUCT-EOF\\n");');
    expect(program).toContain('writeAll(2, "PRODUCT-ERR\\n"); writeAll(2, Buffer.alloc(66 * 1024, 69)); writeAll(2, "\\nPRODUCT-DONE\\n");');
    expect(program).toContain('fs.writeFileSync("held.txt", "stopped-proposal\\n", { flag: "wx" });');
    const out = program.indexOf('writeAll(1, "PRODUCT-READY-OUT\\n");');
    const err = program.indexOf('writeAll(2, "PRODUCT-READY-ERR\\n");');
    expect(out).toBeGreaterThan(-1); expect(err).toBeGreaterThan(out);
    expect(program.indexOf("setInterval(() => {}, 1000);")).toBeGreaterThan(err);
  });

  it("contains no subprocess, network, environment or caller-selected file execution", () => {
    expect([...program.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1])).toEqual(["node:fs", "node:path", "node:assert/strict"]);
    expect(program).not.toMatch(/process\.env|child_process|worker_threads|\b(?:fetch|WebSocket|eval|Function)\s*\(|import\s*\(/);
    expect(program).not.toMatch(/fs\.\w+\(\s*process\.|process\.(?:execPath|chdir)|https?:|node:(?:net|http|https|dns|vm)/);
  });
});

it("uses real resource issuers and retains uncertain owners without recursive teardown", () => {
  expect(fixture).toContain('import("../../app/main/agent/project-coding-backend")');
  expect(fixture).toContain("createProjectCodingBackend({ userData");
  expect(fixture).toContain("selected instanceof WindowsProjectCodingResources");
  expect(fixture).toContain("resource.createNodeWorkspace(spec, task.signal, () => true)");
  expect(fixture).toContain("resource.nodePlatform.files(workspace, task.signal)");
  expect(fixture).not.toMatch(/\b(?:vi|jest)\.(?:mock|doMock|spyOn)|bindWindows|native-fake|fakecredential/i);
  expect(fixture).toContain("const retained = new Set<PrivateCase>();");
  expect(fixture).toContain('if (terminal || active) { terminal = true; if (active) retained.add(active); throw refusal("admission"); }');
  expect(fixture).toContain("terminal = true; retained.add(graph); throw refusal(graph.phase);");
  expect(fixture).toContain('path.join(path.dirname(os.tmpdir()), "ember-node-product-native-")');
  expect(fixture).toContain("requireFact(sameSnapshot(snapshot, captureTree(root)));");
  expect(fixture).not.toMatch(/rmSync\(|recursive:\s*true|afterEach\s*\(/);
});

it("latches the active graph on a fixed global deadline and rejects late or foreign output", () => {
  expect(fixture).toContain("let terminal = false, active: PrivateCase | undefined;");
  expect(fixture).toContain("active = graph;");
  expect(fixture).toContain("const deadline = setTimeout(() => { terminal = true; retained.add(graph); expire(refusal(graph.phase)); }, 180_000);");
  expect(fixture).toContain("requireFact(!terminal && active === graph && bytes.byteLength > 0 && (stream === \"stdout\" || stream === \"stderr\"));");
  expect(fixture).toContain("finally { clearTimeout(deadline); if (active === graph) active = undefined; }");
});

it("retains every pending operation until resolution is verified against the same live graph", () => {
  const start = fixture.indexOf("const known = async <T>(pending: Promise<T>): Promise<T> => {");
  const end = fixture.indexOf("\n  };", start);
  const known = fixture.slice(start, end);
  const retained = known.indexOf("graph.pending.add(pending);");
  const raced = known.indexOf("await Promise.race([pending, expired]);");
  const verified = known.indexOf("requireFact(!terminal && active === graph);");
  const released = known.indexOf("graph.pending.delete(pending);");
  expect(start).toBeGreaterThan(-1);
  expect(retained).toBeGreaterThan(-1); expect(raced).toBeGreaterThan(retained);
  expect(verified).toBeGreaterThan(raced); expect(released).toBeGreaterThan(verified);
  expect(known).not.toContain("finally");
  expect(fixture).toContain("pending: Set<Promise<unknown>>;");
  const publicOperations = fixture.slice(fixture.indexOf("  try {\n    requireFact(WINDOWS_NODE_PRODUCT_NATIVE_CASES.includes(mode));"));
  expect(publicOperations.match(/\bawait\s+known\s*\(/g)!.length).toBeGreaterThan(20);
  expect(publicOperations).not.toMatch(/\bawait\s+(?!known\s*\()/);
  expect(fixture.slice(fixture.indexOf('graph.phase = "known-cleanup";'))).toContain("requireFact(graph.pending.size === 0 &&");
});

it("accepts retirement refusal only from the genuine cancelled error and rethrows every unknown failure", () => {
  expect(fixture).toContain('import("../../app/main/agent/coding-platform")');
  const retirement = fixture.slice(fixture.indexOf('graph.phase = "retirement";'), fixture.indexOf('graph.phase = "seal";'));
  expect(retirement).toContain("const retiredAttempt = workspace.runNode!(WINDOWS_NODE_PRODUCT_NATIVE_ARGV");
  expect(retirement).toContain("await known(retiredAttempt);");
  expect(retirement).toContain('catch (error) { if (!(error instanceof ScopedCodingFileError) || error.code !== "cancelled") throw error; graph.pending.delete(retiredAttempt); refused = true; }');
  expect(retirement).toContain("requireFact(!terminal);");
  expect(retirement).toContain("requireFact(refused);");
  expect(retirement).not.toMatch(/\.name\s*===|\.message\s*===|catch\s*\{\s*refused/);
});
