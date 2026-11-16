import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { createCodingSnapshot } from "../../app/main/agent/coding-snapshot";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ember-snapshot-test-")); roots.push(root);
  const source = path.join(root, "project"), base = path.join(root, "copies"), secret = path.join(root, "private");
  await Promise.all([fs.mkdir(source, { mode: 0o700 }), fs.mkdir(base, { mode: 0o700 }), fs.mkdir(secret)]);
  await fs.writeFile(path.join(secret, "token"), "private canary");
  return { root, source, base, secret };
}

describe.skipIf(process.platform !== "linux")("isolated coding snapshot primitive", () => {
  it("omits only explicitly declared root metadata/dependencies and records types without following omitted links", async () => {
    const { source, base, secret } = await fixture();
    await fs.writeFile(path.join(source, "main.js"), "ordinary source");
    await fs.mkdir(path.join(source, ".git")); await fs.writeFile(path.join(source, ".git", "HEAD"), "private repository metadata");
    await fs.symlink(secret, path.join(source, "node_modules"));
    await expect(createCodingSnapshot(source, base, [secret])).rejects.toThrow("symbolic link");
    const result = await createCodingSnapshot(source, base, [secret], {}, [".git", "node_modules"]);
    try {
      expect(result.entries.map(entry => entry.path)).toEqual(["main.js"]); expect(result.directories).toEqual([]);
      expect(result.excluded).toEqual([{ path: ".git", kind: "directory" }, { path: "node_modules", kind: "link" }]);
      expect(await fs.readdir(result.directory)).toEqual(["main.js"]);
    } finally { await result.dispose(); }
    await expect(createCodingSnapshot(source, base, [secret], {}, ["dist"] as never)).rejects.toThrow("exclusions");
  });

  it("copies ordinary files to independent inodes with hashes and removes the copy", async () => {
    const { source, base, secret } = await fixture();
    await fs.mkdir(path.join(source, ".git"));
    await fs.writeFile(path.join(source, ".git", "HEAD"), "ref: main\n");
    const original = path.join(source, "run.sh");
    await fs.writeFile(original, "#!/bin/sh\necho hi\n", { mode: 0o755 });
    const snap = await createCodingSnapshot(source, base, [secret]);
    try {
      const copy = path.join(snap.directory, "run.sh");
      expect(await fs.readFile(copy, "utf8")).toBe("#!/bin/sh\necho hi\n");
      expect((await fs.stat(copy)).ino).not.toBe((await fs.stat(original)).ino);
      expect((await fs.stat(copy)).mode & 0o777).toBe(0o700);
      expect(snap.entries.find(e => e.path === "run.sh")).toEqual({ path: "run.sh", size: 18,
        digest: crypto.createHash("sha256").update("#!/bin/sh\necho hi\n").digest("hex"), executable: true });
      await fs.writeFile(copy, "changed");
      expect(await fs.readFile(original, "utf8")).toBe("#!/bin/sh\necho hi\n");
    } finally { await snap.dispose(); await snap.dispose(); }
    await expect(fs.stat(snap.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects private files linked into the project without retaining a partial copy", async () => {
    const { source, base, secret } = await fixture();
    await fs.writeFile(path.join(source, "ordinary"), "hello");
    await fs.link(path.join(secret, "token"), path.join(source, "alias"));
    await expect(createCodingSnapshot(source, base, [secret])).rejects.toThrow(/linked or changed/);
    expect(await fs.readdir(base)).toEqual([]);
    expect(await fs.readFile(path.join(secret, "token"), "utf8")).toBe("private canary");
  });

  it("rejects symlinks rather than following them, even when they point inside the project", async () => {
    const { source, base, secret } = await fixture();
    await fs.writeFile(path.join(source, "real"), "hello");
    await fs.symlink("real", path.join(source, "alias"));
    await expect(createCodingSnapshot(source, base, [secret])).rejects.toThrow(/symbolic link/);
    expect(await fs.readdir(base)).toEqual([]);
  });

  it("rejects filenames that cannot round-trip through UTF-8", async () => {
    const { source, base, secret } = await fixture();
    await fs.writeFile(Buffer.concat([Buffer.from(source + "/"), Buffer.from([0xff])]), "data");
    await expect(createCodingSnapshot(source, base, [secret])).rejects.toThrow(/unsupported filename/);
    expect(await fs.readdir(base)).toEqual([]);
  });

  it("rejects a project containing protected data and refuses unverifiable roots", async () => {
    const { root, source, base, secret } = await fixture();
    await expect(createCodingSnapshot(secret, base, [secret])).rejects.toThrow(/protected/);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ember-snapshot-outer-")); roots.push(outside);
    await expect(createCodingSnapshot(root, outside, [secret])).rejects.toThrow(/protected/);
    await expect(createCodingSnapshot(source, base, [path.join(root, "missing")])).rejects.toMatchObject({ code: "ENOENT" });
    await expect(createCodingSnapshot(source, base, [])).rejects.toThrow(/protected/);
  });

  it("rejects the copy destination within the source", async () => {
    const { source, secret } = await fixture();
    await expect(createCodingSnapshot(source, source, [secret])).rejects.toThrow(/outside the project/);
    expect(await fs.readdir(source)).toEqual([]);
  });

  it("refuses a base directory accessible to other users", async () => {
    const { source, base, secret } = await fixture();
    await fs.chmod(base, 0o755);
    await expect(createCodingSnapshot(source, base, [secret])).rejects.toThrow(/private and owned/);
    expect(await fs.readdir(base)).toEqual([]);
  });

  it("enforces file count, byte, file-size and directory-depth limits and cleans partial copies", async () => {
    const { source, base, secret } = await fixture();
    await fs.mkdir(path.join(source, "a"));
    await fs.mkdir(path.join(source, "a", "b"));
    await fs.writeFile(path.join(source, "a", "b", "file"), "12345");
    for (const limits of [{ files: 2 }, { bytes: 4 }, { fileBytes: 4 }, { depth: 1 }]) {
      await expect(createCodingSnapshot(source, base, [secret], limits)).rejects.toThrow();
      expect(await fs.readdir(base)).toEqual([]);
    }
  });

  it("rejects special files without opening a FIFO", async ctx => {
    const { source, base, secret } = await fixture();
    const result = spawnSync("mkfifo", [path.join(source, "pipe")]);
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") { ctx.skip(); return; }
    expect(result.status).toBe(0);
    await expect(createCodingSnapshot(source, base, [secret])).rejects.toThrow(/special file/);
    expect(await fs.readdir(base)).toEqual([]);
  });

  it("rejects bind-mounted children even on the same filesystem", async ctx => {
    const { root, source, base, secret } = await fixture();
    const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--", process.execPath, "-e", "process.exit(0)"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) { ctx.skip(); return; }
    const mountSource = path.join(root, "external"), mountTarget = path.join(source, "mounted");
    await fs.mkdir(mountSource); await fs.mkdir(mountTarget);
    await fs.writeFile(path.join(mountSource, "file"), "external data");
    const bundle = path.join(root, "snapshot.cjs");
    await build({ entryPoints: [path.resolve("app/main/agent/coding-snapshot.ts")], outfile: bundle, platform: "node", format: "cjs", bundle: true, logLevel: "silent" });
    const script = "require(process.argv[1]).createCodingSnapshot(process.argv[2],process.argv[3],[process.argv[4]])" +
      ".then(()=>{process.stderr.write('unexpected success');process.exitCode=1},e=>process.stdout.write(e.message))";
    const result = spawnSync("bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--ro-bind", source, source,
      "--ro-bind", mountSource, mountTarget, "--bind", base, base, "--", process.execPath, "-e", script, bundle, source, base, secret], { encoding: "utf8", timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/filesystem boundary/);
    expect(await fs.readdir(base)).toEqual([]);
  }, 30_000);

  it("rejects a protected subdirectory bind-mounted as either source or dependency root", async ctx => {
    const { root, source, base, secret } = await fixture();
    const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--", process.execPath, "-e", "process.exit(0)"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) { ctx.skip(); return; }
    const child = path.join(secret, "nested"); await fs.mkdir(child); await fs.writeFile(path.join(child, "ordinary.js"), "private directory bytes");
    const snapshotBundle = path.join(root, "source-reader.cjs"), dependenciesBundle = path.join(root, "dependency-reader.cjs");
    await build({ entryPoints: [path.resolve("app/main/agent/coding-snapshot.ts")], outfile: snapshotBundle, platform: "node", format: "cjs", bundle: true, logLevel: "silent" });
    await build({ entryPoints: [path.resolve("app/main/agent/coding-dependency-snapshot.ts")], outfile: dependenciesBundle, platform: "node", format: "cjs", bundle: true, logLevel: "silent" });
    const script = "const [snapshot,deps,source,base,protectedRoot]=process.argv.slice(1);" +
      "Promise.allSettled([require(snapshot).createCodingSnapshot(source,base,[protectedRoot]),require(deps).createCodingDependencySnapshot({source:{path:source,current:()=>true},baseDir:base,protectedPaths:[protectedRoot]})])" +
      ".then(results=>{for(const r of results){if(r.status==='fulfilled'){process.exitCode=1;process.stderr.write('unexpected accepted protected alias')}else process.stdout.write(r.reason.message+'\\n')}})";
    const result = spawnSync("bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--ro-bind", secret, secret, "--ro-bind", child, source,
      "--bind", base, base, "--", process.execPath, "-e", script, snapshotBundle, dependenciesBundle, source, base, secret], { encoding: "utf8", timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(2);
    expect(result.stdout).toMatch(/protected/); expect(await fs.readdir(base)).toEqual([]);
  }, 30_000);
});
