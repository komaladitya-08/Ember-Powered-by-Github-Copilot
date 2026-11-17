/** Real supported Windows resource journey. No issuing API, DLL, credential or executable-path substitution. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { transformSync } from "esbuild";
import type { WindowsProjectCodingResources } from "../../app/main/agent/windows-coding-resources";
import type { CodingCommandWorkspace, CodingFileBroker, CodingWorkspaceReview } from "../../app/main/agent/coding-platform";
import type { CodingExportTree } from "../../app/main/agent/coding-result-export";
import type { TaskSpec } from "../../app/main/agent/worker";
import type { ObservedCodingCommand } from "../../app/main/agent/isolated-coding-command-runner";

export const WINDOWS_NODE_PRODUCT_NATIVE_CASES = Object.freeze(["natural-repair", "stopped"] as const);
export type WindowsNodeProductNativeCase = typeof WINDOWS_NODE_PRODUCT_NATIVE_CASES[number];
export const WINDOWS_NODE_PRODUCT_NATIVE_ARGV = Object.freeze(["--preserve-symlinks", "--preserve-symlinks-main", "product-native.cjs", "exercise"]);
export const WINDOWS_NODE_PRODUCT_NATIVE_CWD = "\\work";
/** Reviewed literal producer and independently qualified current-source asset proof; callers cannot override either identity. */
export const WINDOWS_NODE_PRODUCT_NATIVE_PREREQUISITE = Object.freeze({ ready: true as boolean,
  manifestSha256: "d6137e7afb434adfe04ce9454aa65e1891e6e4fdaffb248e6303a2fe14cfe89f" as string | null,
  assetProofCommit: "aa5345a934d75d9a7924a4b7984c3b27c9521020" as string | null,
  assetProofManifestSha256: "91f162e84a22f199606acee94131bcb605761d2796e57d9148c77311e09e8db6" as string | null,
  verifierFileSha256: "9674e7b019cf736024b00593e0a73cfa4c8a30ed57f8135baf749b15b21e2a97" as string | null });
const OWNER = "b".repeat(64), PROJECT = "22222222-2222-4222-8222-222222222222";
const PROGRAM = fileURLToPath(new URL("./windows-node-product-native-program.cjs", import.meta.url));
const stdout = Buffer.concat([Buffer.from("PRODUCT-OUT\n"), Buffer.alloc(72 * 1024, 79), Buffer.from("\nPRODUCT-EOF\n")]);
const stderr = Buffer.concat([Buffer.from("PRODUCT-ERR\n"), Buffer.alloc(66 * 1024, 69), Buffer.from("\nPRODUCT-DONE\n")]);
const readyOut = Buffer.from("PRODUCT-READY-OUT\n"), readyErr = Buffer.from("PRODUCT-READY-ERR\n");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Phase = "admission" | "prerequisite" | "installed-toolchain" | "fresh-fixture" | "resource" | "source-grant" | "workspace" |
  "failed-check" | "canonical-adoption" | "repair" | "rerun" | "ready" | "stop" | "retirement" | "seal" | "review" | "publish" | "export" | "forget" | "close" | "canaries" | "known-cleanup";
const refusal = (phase: Phase) => { const error = new Error(`The native Windows Node product proof refused its ${phase} phase; private state was retained.`);
  error.stack = `${error.name}: ${error.message}`; return error; };
const requireFact = (value: unknown) => { if (value !== true) throw new Error("A fixed native product invariant failed."); };

/** Pure guard only; its return value grants no resource, profile, process or cleanup authority. */
export function requireWindowsNodeProductNativeAdmission(input: { required: boolean; platform: string; arch: string; image: unknown; commit: unknown }) {
  if (input.required !== true || input.platform !== "win32" || input.arch !== "x64" ||
      input.image !== "windows-2022" && input.image !== "windows-2025" || typeof input.commit !== "string" || !/^[0-9a-f]{40}$/.test(input.commit)) throw refusal("admission");
  return Object.freeze({ image: input.image === "windows-2022" ? 2022 : 2025, commit: input.commit });
}
interface Snapshot { relative: string; info: fs.BigIntStats; bytes?: Buffer }
interface PrivateCase {
  phase: Phase; root?: string; source?: string; destination?: string; common?: string; userData?: string; protectedFile?: string;
  resource?: WindowsProjectCodingResources; workspace?: CodingCommandWorkspace; broker?: CodingFileBroker; output?: CodingWorkspaceReview;
  run?: Promise<ObservedCodingCommand>; pending: Set<Promise<unknown>>; metadataFiles: Set<number>; buffers: Buffer[]; snapshots: Snapshot[][];
  sourceVerifier?: object;
}
// Outside Vitest's auto-removed temp tree, with exact native owners/IRPs retained after the first failure.
const retained = new Set<PrivateCase>();
let terminal = false, active: PrivateCase | undefined;
function captureTree(root: string): Snapshot[] {
  const result: Snapshot[] = [];
  const visit = (relative: string) => {
    requireFact(result.length < 32); const target = path.join(root, relative), info = fs.lstatSync(target, { bigint: true });
    requireFact(!info.isSymbolicLink() && (info.isDirectory() || info.isFile() && info.nlink === 1n && info.size <= 256n * 1024n));
    const bytes = info.isFile() ? fs.readFileSync(target) : undefined; result.push({ relative, info, bytes });
    if (info.isDirectory()) for (const name of fs.readdirSync(target).sort()) { requireFact(/^[A-Za-z0-9._-]+$/.test(name)); visit(path.join(relative, name)); }
  };
  visit(""); return result;
}
function sameSnapshot(a: Snapshot[], b: Snapshot[]): boolean {
  return a.length === b.length && a.every((x, index) => { const y = b[index]; return x.relative === y.relative &&
    x.info.dev === y.info.dev && x.info.ino === y.info.ino && x.info.mode === y.info.mode && x.info.nlink === y.info.nlink &&
    x.info.mtimeNs === y.info.mtimeNs && x.info.ctimeNs === y.info.ctimeNs && x.info.size === y.info.size &&
    (x.bytes === undefined ? y.bytes === undefined : y.bytes !== undefined && x.bytes.equals(y.bytes)); });
}
function removeKnownTree(root: string, snapshot: Snapshot[]): void {
  requireFact(sameSnapshot(snapshot, captureTree(root)));
  for (const entry of snapshot.slice().reverse()) {
    const target = path.join(root, entry.relative);
    if (entry.info.isDirectory()) fs.rmdirSync(target); else fs.unlinkSync(target);
  }
}
/** Installed metadata only. Never execute Electron's index, installer or environment-selected executable. */
function fixedInstalledElectronResources(repository: string, graph: PrivateCase): string {
  const samePath = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
  const directory = (selected: string) => {
    requireFact(path.isAbsolute(selected) && path.normalize(selected) === selected && !/[\p{Cc}\p{Cf}]/u.test(selected));
    const chain: string[] = []; let current = selected;
    for (;;) { chain.push(current); const parent = path.dirname(current); if (parent === current) break; current = parent; }
    for (const name of chain.reverse()) {
      const info = fs.lstatSync(name, { bigint: true });
      requireFact(info.isDirectory() && !info.isSymbolicLink() && samePath(fs.realpathSync.native(name), name));
    }
  };
  const identity = (left: fs.BigIntStats, right: fs.BigIntStats) => left.dev === right.dev && left.ino === right.ino &&
    left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink() && left.nlink === 1n && right.nlink === 1n && left.size === right.size;
  const clock = (left: fs.BigIntStats, right: fs.BigIntStats) => identity(left, right) && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
  const read = (file: string, maximum: number, prefix = false): Buffer => {
    directory(path.dirname(file)); const before = fs.lstatSync(file, { bigint: true });
    requireFact(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(maximum) &&
      samePath(fs.realpathSync.native(file), file));
    const bytes = Buffer.alloc(Number(prefix && before.size > 4096n ? 4096n : before.size)); graph.buffers.push(bytes);
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); graph.metadataFiles.add(fd);
      const opened = fs.fstatSync(fd, { bigint: true }); requireFact(identity(before, opened));
      let offset = 0;
      while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); requireFact(Number.isInteger(count) && count > 0 && count <= bytes.length - offset); offset += count; }
      if (!prefix) requireFact(fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) === 0);
      const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
      // Keep Windows pathname and handle clock comparisons within their respective APIs.
      requireFact(clock(opened, after) && clock(before, named) && identity(after, named) && samePath(fs.realpathSync.native(file), file));
    } finally {
      // A failed close leaves the exact descriptor in the retained graph and is never retried.
      if (fd !== undefined) { requireFact(fs.closeSync(fd) === undefined); graph.metadataFiles.delete(fd); }
    }
    return bytes;
  };
  const json = (file: string) => {
    const bytes = read(file, 1024 * 1024), text = bytes.toString("utf8"); requireFact(Buffer.from(text, "utf8").equals(bytes));
    return JSON.parse(text) as { name?: unknown; version?: unknown; devDependencies?: { electron?: unknown } };
  };
  directory(repository);
  const owner = json(path.join(repository, "package.json")), expected = owner.devDependencies?.electron;
  requireFact(owner.name === "ember" && typeof expected === "string" && /^\d+\.\d+\.\d+$/.test(expected));
  const known = path.join(repository, "node_modules", "electron", "package.json");
  const installed = createRequire(path.join(repository, "package.json")).resolve("electron/package.json");
  requireFact(path.isAbsolute(installed) && path.normalize(installed) === installed && samePath(installed, known));
  const pkg = json(installed); requireFact(pkg.name === "electron" && pkg.version === expected);
  const packageRoot = path.dirname(installed);
  requireFact(read(path.join(packageRoot, "path.txt"), 64).equals(Buffer.from("electron.exe")));
  const binary = path.join(packageRoot, "dist", "electron.exe"), header = read(binary, 512 * 1024 * 1024, true);
  requireFact(header.length >= 512 && header.toString("ascii", 0, 2) === "MZ"); const pe = header.readUInt32LE(0x3c);
  requireFact(pe >= 64 && pe <= header.length - 96 && header.readUInt32LE(pe) === 0x4550 && header.readUInt16LE(pe + 4) === 0x8664 &&
    header.readUInt16LE(pe + 24) === 0x20b && header.readUInt16LE(pe + 24 + 68) === 2);
  const resourcesPath = path.join(path.dirname(binary), "resources"); directory(resourcesPath); return resourcesPath;
}
/** Pure reviewed-source binding only. A matching catalog grants no process, native reference or cleanup authority. */
function requireReviewedAssetProof(repository: string, image: string, prerequisite: typeof WINDOWS_NODE_PRODUCT_NATIVE_PREREQUISITE,
  graph: Pick<PrivateCase, "metadataFiles" | "buffers" | "sourceVerifier">): void {
  try {
    requireFact(prerequisite.ready && /^[0-9a-f]{40}$/.test(prerequisite.assetProofCommit ?? "") &&
      /^[0-9a-f]{64}$/.test(prerequisite.assetProofManifestSha256 ?? "") && /^[0-9a-f]{64}$/.test(prerequisite.verifierFileSha256 ?? "") &&
      (image === "windows-2022" || image === "windows-2025"));
    const file = path.join(repository, "test/fixtures/windows-node-asset-enforcement-run.ts");
    const same = (a: fs.BigIntStats, b: fs.BigIntStats) => a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink() &&
      a.nlink === 1n && b.nlink === 1n && a.dev === b.dev && a.ino === b.ino && a.size === b.size;
    const clock = (a: fs.BigIntStats, b: fs.BigIntStats) => same(a, b) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
    const before = fs.lstatSync(file, { bigint: true });
    requireFact(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= 1024n * 1024n &&
      fs.realpathSync.native(file).toLowerCase() === file.toLowerCase());
    const bytes = Buffer.alloc(Number(before.size) + 1); graph.buffers.push(bytes);
    let fd: number | undefined, count = 0;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)); graph.metadataFiles.add(fd);
      const opened = fs.fstatSync(fd, { bigint: true }); requireFact(same(before, opened));
      while (count < bytes.length) {
        const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
        requireFact(Number.isInteger(read) && read >= 0 && read <= bytes.length - count);
        if (!read) break; count += read;
      }
      const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
      requireFact(count === Number(before.size) && clock(opened, after) && clock(before, named) && same(after, named));
    } finally {
      if (fd !== undefined) { requireFact(fs.closeSync(fd) === undefined); graph.metadataFiles.delete(fd); }
    }
    const captured = bytes.subarray(0, count);
    requireFact(digest(captured) === prerequisite.verifierFileSha256);
    const source = captured.toString("utf8"); requireFact(Buffer.from(source, "utf8").equals(captured));
    const compiled = transformSync(source, { loader: "ts", format: "cjs", target: "node22", sourcemap: false, logLevel: "silent" }).code;
    const module = { exports: {} as { verifyWindowsNodeAssetEnforcementRun(root: string, input: { commit: string; image: string }): {
      compileCommit: string; sourceManifestSha256: string } } };
    const allowed: Record<string, unknown> = { "node:fs": fs, "node:path": path, "node:crypto": { createHash } };
    const context = { module, exports: module.exports, Buffer, repository, input: { commit: prerequisite.assetProofCommit, image },
      require: (name: string) => { if (!Object.hasOwn(allowed, name)) throw new Error(); return allowed[name]; } };
    // The curated reader retains exact FD/buffer records privately on uncertainty. Keep its VM and export closures
    // in the case graph before initialization or verification; a failed reader must never lose those owners.
    graph.sourceVerifier = { module, context };
    const facts = new Script(compiled + "\nmodule.exports.verifyWindowsNodeAssetEnforcementRun(repository, input);",
      { filename: "reviewed-native-source-catalog.cjs" }).runInNewContext(context,
        { timeout: 10_000, contextCodeGeneration: { strings: false, wasm: false } }) as { compileCommit: string; sourceManifestSha256: string };
    requireFact(facts.compileCommit === prerequisite.assetProofCommit && facts.sourceManifestSha256 === prerequisite.assetProofManifestSha256);
    graph.sourceVerifier = undefined;
  } catch { throw refusal("prerequisite"); }
}
function treeMatches(tree: CodingExportTree | undefined, expected: ReadonlyMap<string, string | null>): boolean {
  return !!tree && tree.entries.length === expected.size && tree.entries.every(entry => expected.has(entry.path) &&
    (entry.kind === "directory" ? expected.get(entry.path) === null : expected.get(entry.path) === entry.bytes.toString("utf8")));
}
function collector(graph: PrivateCase, mode: WindowsNodeProductNativeCase) {
  const out: Buffer[] = [], err: Buffer[] = []; let outBytes = 0, errBytes = 0, settled = false;
  let ready!: () => void; const observedReady = new Promise<void>(resolve => { ready = resolve; });
  return { out, err, observedReady, output(bytes: Uint8Array, stream: "stdout" | "stderr") {
    requireFact(!terminal && active === graph && bytes.byteLength > 0 && (stream === "stdout" || stream === "stderr")); const copy = Buffer.from(bytes); graph.buffers.push(copy);
    if (stream === "stdout") { outBytes += copy.length; out.push(copy); } else { errBytes += copy.length; err.push(copy); }
    requireFact(outBytes + errBytes <= 256 * 1024);
    if (mode === "stopped") {
      const a = Buffer.concat(out), b = Buffer.concat(err);
      requireFact(a.length <= readyOut.length && b.length <= readyErr.length && readyOut.subarray(0, a.length).equals(a) && readyErr.subarray(0, b.length).equals(b));
      if (!settled && a.equals(readyOut) && b.equals(readyErr)) { settled = true; ready(); }
    }
  }, assertComplete() {
    requireFact(Buffer.concat(out).equals(mode === "stopped" ? readyOut : stdout) && Buffer.concat(err).equals(mode === "stopped" ? readyErr : stderr));
    return { stdoutBytes: outBytes, stderrBytes: errBytes };
  } };
}
async function bounded<T>(pending: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("The fixed native product deadline elapsed.")), milliseconds); timer.unref?.(); })]); }
  finally { if (timer) clearTimeout(timer); }
}

export async function runWindowsNodeProductNativeCase(mode: WindowsNodeProductNativeCase) {
  if (terminal || active) { terminal = true; if (active) retained.add(active); throw refusal("admission"); }
  const graph: PrivateCase = { phase: "admission", pending: new Set(), metadataFiles: new Set(), buffers: [], snapshots: [] };
  active = graph;
  let expire!: (error: Error) => void;
  const expired = new Promise<never>((_resolve, reject) => { expire = reject; });
  const deadline = setTimeout(() => { terminal = true; retained.add(graph); expire(refusal(graph.phase)); }, 180_000); deadline.unref?.();
  const known = async <T>(pending: Promise<T>): Promise<T> => {
    graph.pending.add(pending); const result = await Promise.race([pending, expired]); requireFact(!terminal && active === graph);
    graph.pending.delete(pending); return result;
  };
  try {
    requireFact(WINDOWS_NODE_PRODUCT_NATIVE_CASES.includes(mode));
    const admission = requireWindowsNodeProductNativeAdmission({ required: process.env.EMBER_WINDOWS_NODE_PRODUCT_TEST === "1", platform: process.platform,
      arch: process.arch, image: process.env.EMBER_WINDOWS_NODE_PRODUCT_IMAGE, commit: process.env.GITHUB_SHA });
    graph.phase = "prerequisite";
    const prerequisite = WINDOWS_NODE_PRODUCT_NATIVE_PREREQUISITE;
    requireFact(prerequisite.ready && /^[0-9a-f]{64}$/.test(prerequisite.manifestSha256 ?? "") && /^[0-9a-f]{40}$/.test(prerequisite.assetProofCommit ?? "") &&
      /^[0-9a-f]{64}$/.test(prerequisite.assetProofManifestSha256 ?? "") && /^[0-9a-f]{64}$/.test(prerequisite.verifierFileSha256 ?? ""));
    const repository = fs.realpathSync.native(fileURLToPath(new URL("../..", import.meta.url)));
    requireFact(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8", timeout: 10_000, maxBuffer: 128, stdio: ["ignore", "pipe", "pipe"] }).trim() === admission.commit);
    requireFact(execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: repository, encoding: "utf8", timeout: 10_000,
      maxBuffer: 65_536, stdio: ["ignore", "pipe", "pipe"] }).trim() === "");
    const manifest = fs.readFileSync(path.join(repository, "app", "shared", "windows-node-toolchain.json"));
    requireFact(digest(manifest) === prerequisite.manifestSha256);
    requireReviewedAssetProof(repository, admission.image === 2022 ? "windows-2022" : "windows-2025", prerequisite, graph);
    graph.phase = "installed-toolchain";
    const resourcesPath = fixedInstalledElectronResources(repository, graph);
    const packaging = await known(import("../../scripts/package/windows-node-toolchain.mjs"));
    requireFact(packaging.verifyWindowsNodeToolchain(path.join(resourcesPath, packaging.WINDOWS_NODE_TOOLCHAIN_DIRECTORY), "package").files === 3);
    const program = fs.readFileSync(PROGRAM, "utf8");
    graph.phase = "fresh-fixture";
    // Parent of the Vitest temp directory: automatic teardown must never remove uncertain native state.
    const root = fs.mkdtempSync(path.join(path.dirname(os.tmpdir()), "ember-node-product-native-")); graph.root = root;
    const source = path.join(root, "source"), destination = path.join(root, "destination"), common = path.join(root, "private");
    const userData = path.join(root, "userdata"), protectedFile = path.join(root, "application.bin");
    Object.assign(graph, { source, destination, common, userData, protectedFile });
    for (const directory of [source, destination, userData]) fs.mkdirSync(directory);
    const baseline = new Map<string, string | null>([["product-native.cjs", program], ["root-marker.txt", "fixed-product-root\n"], ["app.txt", "answer=41\n"],
      ["phase.txt", "original\n"], ["check.txt", "3\n"], ["deleted.txt", "delete-from-copy\n"], ["rename-target.txt", "original-target\n"]]);
    for (const [name, content] of baseline) fs.writeFileSync(path.join(source, name), content!, { flag: "wx" });
    for (const directory of [".git", "node_modules"]) { fs.mkdirSync(path.join(source, directory)); fs.writeFileSync(path.join(source, directory, "canary.txt"), `excluded-${directory}\n`, { flag: "wx" }); }
    fs.writeFileSync(path.join(userData, "protected.txt"), "fixed-protected-userdata\n", { flag: "wx" });
    fs.writeFileSync(protectedFile, "fixed-protected-application\n", { flag: "wx" });
    const sourceBefore = captureTree(source), userBefore = captureTree(userData), protectedBefore = captureTree(protectedFile);
    graph.snapshots.push(sourceBefore, userBefore, protectedBefore);
    graph.phase = "resource";
    const [{ createProjectCodingBackend }, { WindowsProjectCodingResources }, { decodeCodingReviewExport }, { ScopedCodingFileError }] = await known(Promise.all([
      import("../../app/main/agent/project-coding-backend"), import("../../app/main/agent/windows-coding-resources"), import("../../app/main/agent/coding-result-export"),
      import("../../app/main/agent/coding-platform")]));
    const selected = await known(createProjectCodingBackend({ userData, protectedPaths: [protectedFile], resourcesPath, currentOwner: () => OWNER,
      projectExists: project => project === PROJECT, env: {}, execPath: process.execPath, isElectron: false,
      storage: Object.freeze({ common, protectedPaths: Object.freeze([common]) }) }).ready);
    requireFact(selected instanceof WindowsProjectCodingResources); const resource = selected as WindowsProjectCodingResources; graph.resource = resource;
    requireFact(resource.availability().available && resource.availability().mode === "commands");
    graph.phase = "source-grant";
    const folder = await known(resource.validateSource({ path: source, current: () => true }));
    resource.folders.bind(PROJECT, folder, resource.folders.ownerCurrent(PROJECT));
    const grant = resource.workspace(PROJECT); requireFact(grant !== null);
    const spec: TaskSpec = { id: randomUUID(), goal: "Run the fixed native product check and prepare its private review", target: {}, codingWorkspace: grant! };
    const task = new AbortController();
    graph.phase = "workspace";
    const workspace = await known(resource.createNodeWorkspace(spec, task.signal, () => true)); graph.workspace = workspace;
    requireFact(workspace.nodeAvailable && workspace.executionRoot === "/work" && typeof workspace.runNode === "function");
    const observations: ObservedCodingCommand[] = []; let counts = { stdoutBytes: 0, stderrBytes: 0 };
    const proposed = new Map(baseline);
    if (mode === "natural-repair") {
      graph.broker = await known(resource.nodePlatform.files(workspace, task.signal));
      requireFact((await known(graph.broker.readText("product-native.cjs"))).text === program);
      graph.phase = "failed-check"; const first = collector(graph, mode);
      graph.run = workspace.runNode!(WINDOWS_NODE_PRODUCT_NATIVE_ARGV, WINDOWS_NODE_PRODUCT_NATIVE_CWD, first.output, task.signal);
      const failed = await known(bounded(graph.run, 90_000)); observations.push(failed); counts = first.assertComplete();
      requireFact(failed.observed && failed.exitCode === 17 && !failed.stopped && !failed.timedOut && !failed.outputLimited && workspace.nodeAvailable);
      graph.phase = "canonical-adoption";
      const broker = graph.broker;
      requireFact((await known(broker.readText("app.txt"))).text === "answer=42\n" && (await known(broker.readText("created.txt"))).text === "created-by-fixed-node\n" &&
        (await known(broker.readText("rename-target.txt"))).text === "replacement-target\n" && (await known(broker.readText("phase.txt"))).text === "exercised\n");
      const facts = await known(broker.inspect(["deleted.txt", "created-dir", "rename-new.txt"], WINDOWS_NODE_PRODUCT_NATIVE_CWD));
      requireFact(facts.length === 3 && facts[0].exists === false && facts[1].exists === true && facts[1].dir === true && facts[2].exists === false);
      graph.phase = "repair"; const broken = await known(broker.readText("check.txt"));
      requireFact(broken.text === "3\n"); await known(broker.replaceText("check.txt", "3", "2", { expectedSha256: broken.sha256 }));
      requireFact((await known(broker.readText("product-native.cjs"))).text === program);
      graph.phase = "rerun"; const second = collector(graph, mode);
      graph.run = workspace.runNode!(WINDOWS_NODE_PRODUCT_NATIVE_ARGV, WINDOWS_NODE_PRODUCT_NATIVE_CWD, second.output, task.signal);
      const passed = await known(bounded(graph.run, 90_000)); observations.push(passed); const secondCounts = second.assertComplete();
      requireFact(passed.observed && passed.exitCode === 0 && !passed.stopped && !passed.timedOut && !passed.outputLimited && workspace.nodeAvailable &&
        secondCounts.stdoutBytes === counts.stdoutBytes && secondCounts.stderrBytes === counts.stderrBytes);
      await known(broker.close()); graph.broker = undefined;
      proposed.set("app.txt", "answer=42\n"); proposed.set("check.txt", "2\n"); proposed.set("phase.txt", "exercised\n");
      proposed.set("rename-target.txt", "replacement-target\n"); proposed.delete("deleted.txt"); proposed.set("created.txt", "created-by-fixed-node\n"); proposed.set("created-dir", null);
      graph.phase = "stop"; await known(workspace.stop());
    } else {
      const held = collector(graph, mode); graph.phase = "ready";
      graph.run = workspace.runNode!(["--preserve-symlinks", "--preserve-symlinks-main", "product-native.cjs", "hold"], WINDOWS_NODE_PRODUCT_NATIVE_CWD, held.output, task.signal);
      await known(bounded(Promise.race([held.observedReady, graph.run.then(() => { throw new Error("The held product child exited before Stop."); })]), 30_000));
      requireFact(workspace.nodeAvailable); graph.phase = "stop"; await known(workspace.stop());
      const stopped = await known(bounded(graph.run, 30_000)); observations.push(stopped); counts = held.assertComplete();
      requireFact(stopped.observed && stopped.stopped && !stopped.timedOut && !stopped.outputLimited); proposed.set("held.txt", "stopped-proposal\n");
    }
    graph.phase = "retirement"; requireFact(!workspace.nodeAvailable);
    const retiredAttempt = workspace.runNode!(WINDOWS_NODE_PRODUCT_NATIVE_ARGV, WINDOWS_NODE_PRODUCT_NATIVE_CWD, () => undefined, task.signal);
    let refused = false; try { await known(retiredAttempt); }
    catch (error) { if (!(error instanceof ScopedCodingFileError) || error.code !== "cancelled") throw error; graph.pending.delete(retiredAttempt); refused = true; }
    requireFact(!terminal);
    requireFact(refused);
    graph.phase = "seal"; requireFact(typeof workspace.sealForReview === "function"); await known(workspace.sealForReview!());
    graph.phase = "review"; const output = await known(workspace.exportReview(resource.reviewBase)); graph.output = output;
    requireFact(output.cleanup === "complete" && fs.readdirSync(path.join(path.dirname(resource.reviewBase), "copies")).length === 0 &&
      fs.readdirSync(path.join(path.dirname(resource.reviewBase), "assets")).length === 0);
    const checks = { ran: mode === "natural-repair" ? observations.length : 0, passed: observations.filter(value => !value.stopped && value.exitCode === 0).length,
      failed: observations.filter(value => !value.stopped && value.exitCode !== 0).length };
    graph.phase = "publish"; const status = mode === "natural-repair" ? "done" : "stopped";
    const published = await known(resource.publish(spec, output, status, checks)), results = await known(resource.results()), review = await known(results.review(published.id));
    requireFact(review?.status === status && review.checks.ran === checks.ran && review.checks.passed === checks.passed && review.checks.failed === checks.failed && results.state(PROJECT).length === 1);
    graph.phase = "export"; const exported = await known(results.export(published.id, destination, () => true));
    requireFact(exported.ok && typeof exported.directory === "string" && path.dirname(exported.directory) === destination);
    const exportDirectory = exported.directory!, exportedNames = fs.readdirSync(exportDirectory).sort();
    requireFact(JSON.stringify(exportedNames) === JSON.stringify(["changes.patch", "review.json"]));
    const decoded = decodeCodingReviewExport(fs.readFileSync(path.join(exportDirectory, "review.json")), output.review.binding);
    requireFact(treeMatches(decoded.baseline, baseline) && treeMatches(decoded.current, baseline) && treeMatches(decoded.proposed, proposed));
    const exportSnapshot = captureTree(exportDirectory); graph.snapshots.push(exportSnapshot);
    graph.phase = "forget"; await known(results.forgetResult(published.id));
    requireFact(results.state(PROJECT).length === 0 && await known(results.review(published.id)) === null && fs.readdirSync(resource.reviewBase).length === 0);
    graph.phase = "close"; await known(workspace.close()); await known(resource.close()); requireFact(!fs.existsSync(common));
    graph.phase = "canaries";
    requireFact(sameSnapshot(sourceBefore, captureTree(source)) && sameSnapshot(userBefore, captureTree(userData)) && sameSnapshot(protectedBefore, captureTree(protectedFile)));
    graph.phase = "known-cleanup";
    requireFact(graph.pending.size === 0 && graph.metadataFiles.size === 0 && graph.sourceVerifier === undefined && JSON.stringify(fs.readdirSync(destination)) === JSON.stringify([path.basename(exportDirectory)]) &&
      JSON.stringify(fs.readdirSync(root).sort()) === JSON.stringify(["application.bin", "destination", "source", "userdata"]));
    removeKnownTree(exportDirectory, exportSnapshot); fs.rmdirSync(destination); removeKnownTree(source, sourceBefore); removeKnownTree(userData, userBefore);
    removeKnownTree(protectedFile, protectedBefore); fs.rmdirSync(root);
    for (const bytes of graph.buffers) bytes.fill(0); for (const snapshot of graph.snapshots) for (const entry of snapshot) entry.bytes?.fill(0);
    return Object.freeze({ schema: 1, commit: admission.commit, image: admission.image, case: mode, runs: observations.length,
      firstExit: observations[0].exitCode, finalExit: observations.at(-1)!.exitCode, checksRan: checks.ran, checksPassed: checks.passed, checksFailed: checks.failed,
      stdoutBytes: counts.stdoutBytes, stderrBytes: counts.stderrBytes, stdinEof: 1, fileEdit: mode === "natural-repair" ? 1 : 0, fileCreate: 1,
      fileDelete: mode === "natural-repair" ? 1 : 0, directoryCreate: mode === "natural-repair" ? 1 : 0,
      heldTargetRename: mode === "natural-repair" ? 1 : 0, stopped: mode === "stopped" ? 1 : 0, retired: 1, adopted: 1, published: 1, exported: 1, forgotten: 1,
      sourceUnchanged: 1, protectedUnchanged: 1, outputClosed: 1, completeCleanup: 1 });
  } catch {
    terminal = true; retained.add(graph); throw refusal(graph.phase);
  } finally { clearTimeout(deadline); if (active === graph) active = undefined; }
}
