/** Shared real guest/runtime/public-cache fixture; no positive capability is mocked. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { buildSync } from "esbuild";
import { expect } from "vitest";
import { WslCodingConnection } from "../../../app/main/agent/wsl-coding-connection";
import { WslCodingWorkspace } from "../../../app/main/agent/wsl-coding-workspace";
import { publicNpmHttpsPort, type PublicNpmDownloadPort } from "../../../app/main/agent/public-npm-fetch";
import { LinuxCodingArtifactStore } from "../../../app/main/agent/linux-coding-artifact-store";
import { createCodingReviewExport } from "../../../app/main/agent/coding-result-export";
import { trustedCodingTestNodeOrSkip, codingTestIsolationSupported } from "./trusted-node";

const pico = { version: "1.1.1", resolved: "https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz", integrity: "sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==" };
const yocto = { version: "0.1.0", resolved: "https://registry.npmjs.org/yocto-queue/-/yocto-queue-0.1.0.tgz", integrity: "sha512-rVksvsnNCdJ/ohGc6xgPwyN8eheCxsiLM8mxuE/t/mOVqJewPuO1miLpTHQiRgTKCLexL4MeAFVagts7HmNZ2Q==" };
export function publicDependencyProject(changed = false) {
  const dependencies = { picocolors: "1.1.1", ...(changed ? { "yocto-queue": "0.1.0" } : {}) };
  const pkg = { name: "public-offline-proof", version: "1.0.0", private: true, scripts: { postinstall: "node hook.cjs", build: "tsc -p tsconfig.json", test: "node --test test.cjs" }, dependencies };
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { "": { name: pkg.name, version: pkg.version, dependencies }, "node_modules/picocolors": pico, ...(changed ? { "node_modules/yocto-queue": yocto } : {}) } };
  return { pkg: JSON.stringify(pkg), lock: JSON.stringify(lock) };
}
export async function createWslPublicDependencyFixture(ctx: { skip(note?: string): never }, options: { read?: PublicNpmDownloadPort["read"] } = {}) {
  const readArchive = options.read ?? publicNpmHttpsPort.read;
  const node = await trustedCodingTestNodeOrSkip(ctx); if (!codingTestIsolationSupported()) throw new Error("Required isolated engine is unavailable.");
  const archive = process.env.EMBER_WSL_TYPESCRIPT_ARCHIVE; if (!archive || !path.isAbsolute(archive)) throw new Error("The authenticated TypeScript archive is required.");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-public-dependency-test-")), script = path.join(root, "guest.cjs");
  const privacy = buildSync({ entryPoints: ["app/main/agent/coding-privacy-worker.ts"], bundle: true, platform: "node", format: "cjs", target: "node22", write: false }).outputFiles[0].text;
  fs.writeFileSync(script, buildSync({ entryPoints: ["app/wsl-coding/main.ts"], bundle: true, platform: "node", format: "cjs", target: "node22", write: false,
    define: { __EMBER_CODING_PRIVACY_WORKER_SOURCE__: JSON.stringify(privacy) } }).outputFiles[0].contents);
  const binding = { owner: "a".repeat(64), session: randomUUID(), snapshot: randomUUID() }, baseline = publicDependencyProject();
  const original = new Map([
    ["package.json", baseline.pkg], ["package-lock.json", baseline.lock],
    ["tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "CommonJS", outDir: "dist", strict: true, esModuleInterop: true }, include: ["src/*.ts"] })],
    ["src/result.ts", "import colors from 'picocolors'; export const result = colors.createColors(false).green('wrong');\n"],
    ["hook.cjs", "require('node:fs').writeFileSync('hook-ran','inside');\n"],
    ["test.cjs", "const {test}=require('node:test');const a=require('node:assert/strict');test('public dependency value',()=>a.equal(require('./dist/result.js').result,'ready'));\n"],
  ]);
  const source = { binding, entries: [{ path: "src", kind: "directory" as const }, ...[...original].map(([file, text]) => ({ path: file, kind: "file" as const, bytes: Buffer.from(text), executable: false }))] };
  const sourceDir = path.join(root, "host-source"), reviews = path.join(root, "host-reviews"); fs.mkdirSync(sourceDir, { mode: 0o700 }); fs.mkdirSync(reviews, { mode: 0o700 }); fs.mkdirSync(path.join(sourceDir, "src"));
  for (const [file, text] of original) fs.writeFileSync(path.join(sourceDir, file), text);
  const store = await LinuxCodingArtifactStore.create(reviews), sourceBoundary = await store.sourceBoundary(sourceDir, () => undefined); if (!sourceBoundary) throw new Error("Host source identity is unavailable.");
  const child = spawn(node.nodePath, [script], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } });
  const connection = new WslCodingConnection(child), task = new AbortController(), events: string[] = [];
  let workspace: WslCodingWorkspace | undefined, closed = false, fetches = 0;
  try {
    workspace = await WslCodingWorkspace.create({ connection, source, typescriptArchive: fs.readFileSync(archive), signal: task.signal, current: () => true,
      scope: { version: 1, source: { excludedRoots: [".git", "node_modules"], omitted: [], byteLimit: 10 * 1024 * 1024 }, dependencies: null },
      publicDependencies: { current: () => true, port: { async read(artifact, signal, current, maximum) { fetches++; events.push("fetch:" + artifact.name); return readArchive(artifact, signal, current, maximum); } } },
      review: { base: reviews, sourceBoundary, current: () => true, captureCurrent: async () => ({ binding: { ...binding }, entries: source.entries.map(entry => entry.kind === "file" ? { ...entry, bytes: Buffer.from(entry.bytes) } : { ...entry }) }),
        async write(input) { expect(fs.readdirSync(root).some(n => n.startsWith("ember-wsl-coding-"))).toBe(false); const rendered = createCodingReviewExport(input); const artifact = await store.write({ "review.json": Buffer.from(rendered.json), "changes.patch": Buffer.from(rendered.review.textPatch) }, () => undefined); return { ...artifact, review: rendered.review, cleanup: "complete" }; }, discard: output => store.discard(output) } });
  } catch (error) { try { await connection.close(); } catch { child.kill("SIGKILL"); } await store.close(); throw error; }
  return { workspace, connection, task, events, store, reviews, binding, root, sourceDir, original, get fetches() { return fetches; },
    async close() { try { await workspace!.close(); closed = true; } finally { if (!closed) child.kill("SIGKILL"); await store.close(); if (closed) fs.rmSync(root, { recursive: true, force: true }); } } };
}
