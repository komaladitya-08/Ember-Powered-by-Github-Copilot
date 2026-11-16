/** Two real command namespaces: later sessions receive proposed files while cumulative review retains the original. */
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { IsolatedCommandWorkspace, type IsolatedCommandWorkspaceInput } from "../../app/main/agent/isolated-command-workspace";
import { decodeCodingReviewExport, type CodingExportEntry, type CodingExportTree } from "../../app/main/agent/coding-result-export";
import { codingTestIsolationSupported, trustedCodingTestNodeOrSkip } from "../fixtures/coding/trusted-node";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-continuation-native-")); roots.push(root);
  const source = path.join(root, "source"), baseDir = path.join(root, "copies"), protectedPath = path.join(root, "private"), exports = path.join(root, "exports");
  for (const value of [source, baseDir, protectedPath, exports]) fs.mkdirSync(value, { mode: 0o700 });
  const input: IsolatedCommandWorkspaceInput = { source, baseDir, protectedPaths: [protectedPath], binding: { owner: "a".repeat(64), session: randomUUID(), snapshot: randomUUID() } };
  return { root, source, baseDir, exports, input };
}
const signal = () => new AbortController().signal;
const file = (path: string, text: string): CodingExportEntry => ({ path, kind: "file", bytes: Buffer.from(text), executable: false });

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("continues real private edits through a second test/repair session with fresh dependencies and cumulative baseline", async ctx => {
  if (!codingTestIsolationSupported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx), f = fixture();
  fs.writeFileSync(path.join(f.source, "value.cjs"), "module.exports=1;\n");
  fs.writeFileSync(path.join(f.source, "check.cjs"), "require('node:assert/strict').equal(require('./value.cjs'),3);\n");
  fs.mkdirSync(path.join(f.source, "empty")); fs.writeFileSync(path.join(f.source, "binary"), Buffer.from([0, 255, 7]));
  fs.writeFileSync(path.join(f.source, "run.sh"), "echo okay\n", { mode: 0o700 });
  fs.mkdirSync(path.join(f.source, ".git")); fs.writeFileSync(path.join(f.source, ".git", "HEAD"), "ref: refs/heads/main\n");
  const modules = path.join(f.source, "node_modules"); fs.mkdirSync(modules); fs.mkdirSync(path.join(modules, "example"));
  fs.writeFileSync(path.join(modules, "example", "index.js"), "module.exports=1;\n");
  f.input.nodePath = asset.nodePath; f.input.scope = { excludeRoots: [".git", "node_modules"], dependencies: { path: modules, current: () => true } };
  const first = await IsolatedCommandWorkspace.create(f.input); let second: IsolatedCommandWorkspace | undefined;
  try {
    expect(await first.run("node -e \"require('fs').writeFileSync('value.cjs','module.exports=2;\\n')\"", "/work", () => undefined, signal(), "bash")).toMatchObject({ exitCode: 0, observed: true });
    const result = await first.exportReview(f.exports); await first.close();
    const decoded = decodeCodingReviewExport(fs.readFileSync(path.join(result.directory, "review.json")), f.input.binding);
    fs.writeFileSync(path.join(modules, "example", "index.js"), "module.exports=2;\n");
    const freshBinding = { ...f.input.binding, session: randomUUID(), snapshot: randomUUID() };
    second = await IsolatedCommandWorkspace.create({ ...f.input, binding: freshBinding,
      continuation: { baseline: decoded.baseline, proposed: decoded.proposed, scope: decoded.scope, current: () => true } });
    const seeded = await second.files(async root => ({ text: fs.readFileSync(path.join(root, "value.cjs"), "utf8"), inode: fs.statSync(path.join(root, "value.cjs")).ino,
      binary: fs.readFileSync(path.join(root, "binary")), executable: fs.statSync(path.join(root, "run.sh")).mode & 0o777, empty: fs.readdirSync(path.join(root, "empty")) }));
    expect(seeded).toMatchObject({ text: "module.exports=2;\n", binary: Buffer.from([0, 255, 7]), executable: 0o700, empty: [] });
    expect(seeded.inode).not.toBe(fs.statSync(path.join(f.source, "value.cjs")).ino);
    expect(await second.run("node -p \"require('example')\"", "/work", () => undefined, signal(), "bash")).toMatchObject({ exitCode: 0, output: "2\n" });
    expect(await second.run("node check.cjs", "/work", () => undefined, signal(), "bash")).toMatchObject({ exitCode: 1, observed: true });
    expect(await second.run("node -e \"require('fs').writeFileSync('value.cjs','module.exports=3;\\n')\" && node check.cjs", "/work", () => undefined, signal(), "bash")).toMatchObject({ exitCode: 0, observed: true });
    const final = await second.exportReview(f.exports);
    expect(final.review.binding).toEqual(freshBinding);
    expect(final.review.baseline.find(entry => entry.path === "value.cjs")).toMatchObject({ base64: Buffer.from("module.exports=1;\n").toString("base64") });
    expect(final.review.proposed.find(entry => entry.path === "value.cjs")).toMatchObject({ base64: Buffer.from("module.exports=3;\n").toString("base64") });
    expect(final.review.current?.find(entry => entry.path === "value.cjs")).toMatchObject({ base64: Buffer.from("module.exports=1;\n").toString("base64") });
    expect(final.review.textPatch).toContain("-module.exports=1;\n+module.exports=3;\n");
    expect(final.review.scope?.dependencies?.sha256).not.toBe(result.review.scope?.dependencies?.sha256);
    expect(final.review.proposed.some(entry => entry.path === ".git" || entry.path.startsWith("node_modules/"))).toBe(false);
    expect(fs.readFileSync(path.join(f.source, "value.cjs"), "utf8")).toBe("module.exports=1;\n");
    await second.close(); expect(fs.readdirSync(f.baseDir)).toEqual([]);
  } finally { await first.close(); await second?.close(); }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("rejects credential-bearing proposed or baseline trees before admitting a command copy", async ctx => {
  if (!codingTestIsolationSupported()) { ctx.skip(); return; }
  const f = fixture(); fs.writeFileSync(path.join(f.source, "ordinary"), "safe");
  const old = { ...f.input.binding, session: randomUUID(), snapshot: randomUUID() };
  const tree = (...entries: CodingExportEntry[]): CodingExportTree => ({ binding: old, entries });
  for (const [baseline, proposed] of [[tree(file("ordinary", "safe")), tree(file("notes.txt", "the password is hunter2"))],
    [tree(file("notes.txt", "the password is hunter2")), tree(file("ordinary", "safe"))], [tree(), tree(file(".env", "ordinary=value"))]]) {
    await expect(IsolatedCommandWorkspace.create({ ...f.input, continuation: { baseline, proposed, current: () => true } })).rejects.toThrow("credential");
    expect(fs.readdirSync(f.baseDir)).toEqual([]);
  }
}, 30_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("drains both fresh copies when the predecessor is revoked during materialization", async ctx => {
  if (!codingTestIsolationSupported()) { ctx.skip(); return; }
  const f = fixture(); fs.writeFileSync(path.join(f.source, "a"), "original");
  const old = { ...f.input.binding, session: randomUUID(), snapshot: randomUUID() };
  let revoked = false;
  await expect(IsolatedCommandWorkspace.create({ ...f.input, continuation: {
    baseline: { binding: old, entries: [file("a", "original")] }, proposed: { binding: old, entries: [file("a", "proposed")] },
    current: () => { if (fs.readdirSync(f.baseDir).some(name => name.startsWith("ember-coding-seed-"))) revoked = true; return !revoked; },
  } })).rejects.toThrow("no longer current");
  expect(revoked).toBe(true); expect(fs.readdirSync(f.baseDir)).toEqual([]);
  expect(fs.readFileSync(path.join(f.source, "a"), "utf8")).toBe("original");
}, 30_000);
