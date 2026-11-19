/** An npm-shaped source project with a real installed package, copied dependencies and real no-network commands. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { codingTestIsolationSupported, trustedCodingTestNodeOrSkip } from "../fixtures/coding/trusted-node";
import { expect, it } from "vitest";
import { IsolatedCommandWorkspace } from "../../app/main/agent/isolated-command-workspace";
import { ScopedCodingFiles } from "../../app/main/agent/scoped-coding-files";
import { projectCommandFolder } from "../../app/main/agent/project";

const supported = codingTestIsolationSupported;
it.skipIf(process.platform !== "linux" || process.arch !== "x64")("runs a real dependency from a fresh read-only copy, manifests Git/dependency omissions and exports only source changes", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-scoped-npm-project-"));
  const source = path.join(root, "project"), baseDir = path.join(root, "copies"), privateDir = path.join(root, "private"), reviews = path.join(root, "reviews");
  for (const folder of [source, baseDir, privateDir, reviews, path.join(source, ".git"), path.join(source, "node_modules"), path.join(source, "node_modules", ".bin")]) fs.mkdirSync(folder, { mode: 0o700 });
  fs.writeFileSync(path.join(source, ".git", "HEAD"), "REPOSITORY_METADATA_CANARY");
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "actual-package-check", private: true, dependencies: { picocolors: "1.1.1" }, scripts: { test: "node --test test.cjs" } }));
  fs.cpSync(fs.realpathSync(path.join(process.cwd(), "node_modules", "picocolors")), path.join(source, "node_modules", "picocolors"), { recursive: true });
  fs.symlinkSync("../picocolors/picocolors.js", path.join(source, "node_modules", ".bin", "colour.js"));
  const original = "module.exports = require('picocolors').green('old-value');\n";
  fs.writeFileSync(path.join(source, "index.cjs"), original);
  fs.writeFileSync(path.join(source, "test.cjs"), "const {test}=require('node:test');const assert=require('node:assert/strict');test('dependency-backed result',()=>assert.equal(require('./index.cjs'),'new-value'));\n");
  const task = new AbortController(); let workspace: IsolatedCommandWorkspace | undefined, broker: ScopedCodingFiles | undefined;
  try {
    workspace = await IsolatedCommandWorkspace.create({ source, baseDir, protectedPaths: [privateDir], nodePath: asset.nodePath, signal: task.signal,
      binding: { owner: "a".repeat(64), session: crypto.randomUUID(), snapshot: crypto.randomUUID() },
      scope: { excludeRoots: [".git", "node_modules"], dependencies: projectCommandFolder(path.join(source, "node_modules"), privateDir) } });
    expect(workspace.excludedRoots).toEqual([".git", "node_modules"]);
    const manifest = workspace.scopeManifest!;
    expect(manifest.source.omitted).toEqual([{ path: ".git", kind: "directory" }, { path: "node_modules", kind: "directory" }]);
    expect(manifest.dependencies?.materializedLinks).toEqual([{ path: ".bin/colour.js", target: "picocolors/picocolors.js" }]);
    broker = await ScopedCodingFiles.create({ workspace, signal: task.signal });
    await expect(broker.writeText("node_modules/picocolors/picocolors.js", "forbidden")).rejects.toThrow("privacy");
    expect(await broker.inspect(["node_modules/picocolors/picocolors.js"], "/work")).toEqual([{ exists: null, real: null }]);
    await broker.replaceText("index.cjs", "old-value", "new-value");
    const output = await workspace.run("node --test test.cjs", "/work", () => undefined, task.signal, "bash");
    expect(output).toMatchObject({ exitCode: 0, observed: true }); expect(output.output).toContain("dependency-backed result");
    const guard = await workspace.run("node -e \"const f=require('fs');for(const p of ['node_modules/picocolors/picocolors.js','.git/new']){let blocked=false;try{f.writeFileSync(p,'forbidden')}catch(e){blocked=e.code==='EROFS'||e.code==='EACCES'}if(!blocked)process.exit(12)}console.log(JSON.stringify({ino:f.statSync('node_modules/picocolors/picocolors.js').ino,metadata:f.existsSync('.git/HEAD')}))\"", "/work", () => undefined, task.signal, "bash");
    expect(guard.exitCode).toBe(0); const probed = JSON.parse(guard.output);
    expect(probed.metadata).toBe(false); expect(probed.ino).not.toBe(fs.statSync(path.join(source, "node_modules", "picocolors", "picocolors.js")).ino);
    await broker.close(); broker = undefined;
    const exported = await workspace.exportReview(reviews);
    expect(exported.review.scope).toEqual(manifest); expect(exported.review.patchComplete).toBe(true);
    expect(exported.review.changes.map(entry => entry.path)).toEqual(["index.cjs"]);
    expect(exported.review.baseline.some(entry => entry.path.startsWith("node_modules") || entry.path.startsWith(".git"))).toBe(false);
    expect(JSON.stringify(exported.review)).not.toContain("REPOSITORY_METADATA_CANARY");
    expect(fs.readFileSync(path.join(source, "index.cjs"), "utf8")).toBe(original);
    expect(fs.readdirSync(baseDir)).toEqual([]);
  } finally { await broker?.close(); await workspace?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 45_000);
