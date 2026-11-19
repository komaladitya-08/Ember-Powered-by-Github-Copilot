/** Actual private cache custody and held guest transactions; no host npm or package script runs here. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PublicNpmPlan } from "../../app/main/agent/public-npm-lock";
import { WslPublicDependencyRuntime, WslPublicDependencyCleanupError, requireWslPublicDependencyRuntime } from "../../app/main/agent/wsl-public-dependency-runtime";
import { WslPublicDependencyGuest } from "../../app/main/agent/wsl-public-dependency-guest";
import type { IsolatedCommandWorkspace } from "../../app/main/agent/isolated-command-workspace";
import { npmFixture } from "../fixtures/coding/public-npm";

const test = it.skipIf(process.platform !== "linux" || process.arch !== "x64" || !process.getuid || process.getuid() <= 0);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ember-public-runtime-unit-")); roots.push(root); await fs.chmod(root, 0o700);
  const runtime = await WslPublicDependencyRuntime.create(root, new AbortController().signal), source = path.join(root, "source"); await fs.mkdir(source, { mode: 0o700 });
  const f = npmFixture(); await fs.writeFile(path.join(source, "package.json"), f.inputs.packageJson); await fs.writeFile(path.join(source, "package-lock.json"), f.inputs.packageLock);
  // A structural file queue port models scheduling only. The real integration separately proves engine child/Stop receipts.
  let tail = Promise.resolve();
  const workspace: Pick<IsolatedCommandWorkspace, "files"> = { files<T>(operation: (root: string) => Promise<T>) { const result = tail.then(() => operation(source)); tail = result.then(() => undefined, () => undefined); return result; } };
  return { root, runtime, source, f, workspace };
}
test("requires an opaque issued runtime and retains unknown inode replacement instead of deleting another tree", async () => {
  expect(() => requireWslPublicDependencyRuntime(Object.create(WslPublicDependencyRuntime.prototype))).toThrow();
  const { runtime } = await setup(), dirs = runtime.paths(); await fs.rename(dirs.cache, dirs.cache + "-old"); await fs.mkdir(dirs.cache);
  await expect(runtime.current()).rejects.toBeInstanceOf(WslPublicDependencyCleanupError);
  await expect(runtime.close()).rejects.toBeInstanceOf(WslPublicDependencyCleanupError);
  expect((await fs.stat(dirs.cache)).isDirectory()).toBe(true);
});
test("imports only authenticated content-addressed bytes and wipes the private mounts on positive close", async () => {
  const { runtime, f } = await setup(), dirs = runtime.paths();
  await runtime.importCache(PublicNpmPlan.create(f.inputs), [f.bytes], new AbortController().signal, () => undefined);
  const hex = Buffer.from(f.artifact.integrity.slice(7), "base64").toString("hex");
  expect(await fs.readFile(path.join(dirs.cache, "_cacache/content-v2/sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)))).toEqual(f.bytes);
  const changed = Buffer.from(f.bytes); changed[10] ^= 1;
  await expect(runtime.importCache(PublicNpmPlan.create(f.inputs), [changed], new AbortController().signal, () => undefined)).rejects.toThrow();
  await runtime.close(); await expect(fs.lstat(dirs.cache)).rejects.toThrow(); expect(() => runtime.paths()).toThrow();
});
test("holds the engine queue across a lease, rejects wrong index/offset and permits the exact cache transfer", async () => {
  const { runtime, source, f, workspace } = await setup(), life = new AbortController();
  const guest = new WslPublicDependencyGuest(runtime, workspace, life.signal), begin = await guest.begin(); let wrote = false;
  const queued = workspace.files(async root => { await fs.writeFile(path.join(root, "after"), "after"); wrote = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); expect(wrote).toBe(false);
  expect(() => guest.chunk("f".repeat(32), 0, 0, f.bytes.toString("base64"))).toThrow();
  expect(() => guest.chunk(begin.lease, 1, 0, f.bytes.toString("base64"))).toThrow();
  expect(() => guest.chunk(begin.lease, 0, 1, f.bytes.toString("base64"))).toThrow();
  guest.chunk(begin.lease, 0, 0, f.bytes.toString("base64")); await guest.commit(begin.lease); await queued; expect(wrote).toBe(true);
  expect(await fs.readFile(path.join(source, "after"), "utf8")).toBe("after"); await guest.drain(); await runtime.close();
});
test.each(["missing", "wrong-identity", "symlink"])("refuses %s copied workspace package before returning a preparation lease", async kind => {
  const { runtime, source, f, workspace } = await setup();
  const pkg = { ...f.pkg, workspaces: ["packages/*"] }, lock = { ...f.lock, packages: { ...f.lock.packages, "packages/local": { name: "local", version: "1.0.0" }, "node_modules/local": { link: true, resolved: "packages/local" } } };
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify(pkg)); await fs.writeFile(path.join(source, "package-lock.json"), JSON.stringify(lock));
  await fs.mkdir(path.join(source, "packages/local"), { recursive: true });
  if (kind === "wrong-identity") await fs.writeFile(path.join(source, "packages/local/package.json"), JSON.stringify({ name: "another", version: "1.0.0" }));
  if (kind === "symlink") await fs.symlink(path.join(source, "package.json"), path.join(source, "packages/local/package.json"));
  const guest = new WslPublicDependencyGuest(runtime, workspace, new AbortController().signal); await expect(guest.begin()).rejects.toThrow(); await guest.drain(); await runtime.close();
});
test("aborts partial accepted cache data and drains the held lease without publishing it", async () => {
  const { runtime, f, workspace } = await setup(), life = new AbortController(), guest = new WslPublicDependencyGuest(runtime, workspace, life.signal);
  const begin = await guest.begin(); guest.chunk(begin.lease, 0, 0, f.bytes.subarray(0, 32).toString("base64"));
  life.abort(); guest.abort(); await guest.drain(); expect(await fs.readdir(runtime.paths().cache)).toEqual([]);
  await expect(guest.commit(begin.lease)).rejects.toThrow(); await runtime.close();
});
