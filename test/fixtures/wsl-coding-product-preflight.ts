/** Shared actual qualification preflight; no environment/IPC/readiness substitution is accepted. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { Script } from "node:vm";
import { transformSync } from "esbuild";
import { WSL_CODING_READINESS } from "../../app/shared/wsl-coding-readiness";
import { WINDOWS_NODE_PRODUCT_NATIVE_PREREQUISITE } from "./windows-node-product-native";
import { verifyWindowsNodeToolchain } from "../../scripts/package/windows-node-toolchain.mjs";
import { runtimeFor, locateRuntime } from "../../app/main/agent/runtime";
import { requireWslProductAdmission } from "./wsl-coding-product-contract";

export function wslProductRefusal(phase: number): Error {
  const value = Number.isInteger(phase) && phase >= 1 && phase <= 40 ? phase : 0;
  const error = new Error("Windows WSL product journey refused (phase " + value + ")."); error.stack = "Error: " + error.message; return error;
}
const refusal = (_phase: string) => wslProductRefusal(1);
const requireFact = (value: unknown) => { if (value !== true) throw wslProductRefusal(1); };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
interface ReaderGraph { metadataFiles: Set<number>; buffers: Buffer[]; sourceVerifier?: unknown }
const retained = new Set<ReaderGraph>();
let terminal = false;
function requireReviewedAssetProof(repository: string, image: string, prerequisite: typeof WINDOWS_NODE_PRODUCT_NATIVE_PREREQUISITE,
  graph: ReaderGraph): void {
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
/** Qualification uses only the staged SDK; development override variables cannot select its executable. */
export function fixedWslProductRuntime(repository: string) {
  const runtime = runtimeFor("win32", "x64");
  return locateRuntime({ appPath: repository, runtimeId: runtime.id, exe: runtime.exe, env: {} });
}
export function wslProductChildEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...input };
  for (const key of Object.keys(env)) if (/^EMBER_COPILOT_RUNTIME$/i.test(key)) delete env[key];
  return env;
}
export function wslProductPreflight(required: boolean) {
  const identity = requireWslProductAdmission({ required, platform: process.platform, arch: process.arch,
    image: process.env.EMBER_WSL_CODING_PRODUCT_IMAGE, commit: process.env.GITHUB_SHA, readiness: WSL_CODING_READINESS });
  if (terminal) throw wslProductRefusal(1);
  const graph: ReaderGraph = { metadataFiles: new Set(), buffers: [] }; retained.add(graph);
  try {
    const repository = fs.realpathSync.native(process.cwd());
    requireFact(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8", timeout: 10_000, maxBuffer: 128 }).trim() === identity.commit);
    requireFact(execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: repository, encoding: "utf8", timeout: 10_000, maxBuffer: 65_536 }).trim() === "");
    const prerequisite = WINDOWS_NODE_PRODUCT_NATIVE_PREREQUISITE;
    requireFact(prerequisite.ready && digest(fs.readFileSync(path.join(repository, "app/shared/windows-node-toolchain.json"))) === prerequisite.manifestSha256);
    requireReviewedAssetProof(repository, identity.image, prerequisite, graph);
    const owner = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8"));
    const requireCjs = createRequire(path.join(repository, "package.json")), electronPackage = requireCjs.resolve("electron/package.json");
    requireFact(path.resolve(electronPackage).toLowerCase() === path.join(repository, "node_modules/electron/package.json").toLowerCase());
    const installed = JSON.parse(fs.readFileSync(electronPackage, "utf8")), packageRoot = path.dirname(electronPackage);
    requireFact(installed.version === owner.devDependencies.electron && fs.readFileSync(path.join(packageRoot, "path.txt"), "utf8") === "electron.exe");
    const executable = path.join(packageRoot, "dist/electron.exe"), info = fs.lstatSync(executable), resourcesPath = path.join(packageRoot, "dist/resources");
    requireFact(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
    requireFact(verifyWindowsNodeToolchain(path.join(resourcesPath, "coding/windows-node-x64"), "package").files === 3);
    requireFact(fixedWslProductRuntime(repository).exists);
    const distro = process.env.EMBER_WSL_CODING_TEST_DISTRO;
    requireFact(typeof distro === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(distro));
    requireFact(graph.metadataFiles.size === 0 && graph.sourceVerifier === undefined);
    for (const bytes of graph.buffers) bytes.fill(0); retained.delete(graph);
    return Object.freeze({ ...identity, repository, executable, resourcesPath, distro: distro!, target: `wsl:${distro}` as const, targetLabel: `${distro} (WSL)` });
  } catch { terminal = true; throw wslProductRefusal(1); }
}
/** Keep uncertain test owners outside Vitest's unconditional temporary-directory cleanup. */
export function wslProductScratchParent(): string {
  const temporary = fs.realpathSync.native(os.tmpdir()); return path.basename(temporary).startsWith("ember-run-") ? path.dirname(temporary) : temporary;
}
