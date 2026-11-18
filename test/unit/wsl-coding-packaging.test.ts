/** Packaging authentication is independent of WSL native admission and never grants execution. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WSL_CODING_TOOLS, readWslCodingTypeScriptArchive, stageWslCodingTools, verifyWslCodingTools } from "../../scripts/package/wsl-coding-tools.mjs";
import { layoutFor } from "../../scripts/package/layout.mjs";
import { readWslCodingTypeScriptArchive as readRuntimeArchive } from "../../app/main/agent/wsl-coding-archive";

const roots: string[] = [];
const root = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ember-wsl-tools-test-")); roots.push(directory); return directory; };
afterEach(() => { for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
it("pins the exact existing lockfile artifact, byte count and Apache-2.0 license", () => {
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")).packages["node_modules/typescript"];
  expect(WSL_CODING_TOOLS).toMatchObject({ version: lock.version, url: lock.resolved, integrity: lock.integrity, bytes: 4377468, license: "Apache-2.0", licenseBytes: 9197, noticeBytes: 37824 });
  expect(Object.isFrozen(WSL_CODING_TOOLS)).toBe(true);
});
it.each(["missing", "directory", "short", "wrong-digest", "symlink", "hardlink"])("rejects %s before creating any destination", kind => {
  const directory = root(), source = path.join(directory, "input.tgz"), destination = path.join(directory, "output");
  if (kind === "directory") fs.mkdirSync(source);
  else if (kind === "short") fs.writeFileSync(source, "small");
  else if (kind !== "missing") {
    const backing = path.join(directory, "backing"); fs.writeFileSync(backing, Buffer.alloc(WSL_CODING_TOOLS.bytes));
    if (kind === "symlink") fs.symlinkSync(backing, source);
    else if (kind === "hardlink") fs.linkSync(backing, source);
    else fs.renameSync(backing, source);
  }
  expect(() => stageWslCodingTools(source, destination)).toThrow(); expect(fs.existsSync(destination)).toBe(false);
  expect(() => readRuntimeArchive(source)).toThrow();
});
it("requires the guest bundle only on Windows and keeps it out of other platforms", () => {
  expect(layoutFor("win32", "x64").requiredDist).toContain("wsl-coding.cjs");
  for (const [platform, arch] of [["linux", "x64"], ["darwin", "arm64"]]) {
    expect(layoutFor(platform, arch).requiredDist).not.toContain("wsl-coding.cjs");
    expect(layoutFor(platform, arch).excludeDist).toContain("wsl-coding.cjs");
  }
});
const selected = process.env.EMBER_WSL_TYPESCRIPT_ARCHIVE;
it.skipIf(!selected)("stages the authenticated real archive and exact license, refuses overwrites and changed bytes", () => {
  const directory = root(), source = path.join(directory, WSL_CODING_TOOLS.filename), destination = path.join(directory, "output");
  fs.copyFileSync(selected!, source); expect(verifyWslCodingTools(source)).toMatchObject({ files: 1, version: "5.9.3" });
  expect(stageWslCodingTools(source, destination)).toMatchObject({ files: 3 });
  expect(fs.readdirSync(destination).sort()).toEqual(["LICENSE.txt", "ThirdPartyNoticeText.txt", WSL_CODING_TOOLS.filename]);
  expect(fs.readFileSync(path.join(destination, "LICENSE.txt"), "utf8")).toContain("Apache License");
  expect(fs.readFileSync(path.join(destination, "ThirdPartyNoticeText.txt"), "utf8")).toContain("W3C Community Final Specification Agreement");
  const bytes = readWslCodingTypeScriptArchive(path.join(destination, WSL_CODING_TOOLS.filename));
  expect(bytes.equals(fs.readFileSync(source))).toBe(true); bytes.fill(0);
  const runtime = readRuntimeArchive(source); expect(runtime.equals(fs.readFileSync(source))).toBe(true); runtime.fill(0);
  expect(() => stageWslCodingTools(source, destination)).toThrow();
  const changed = fs.readFileSync(source); changed[changed.length - 1] ^= 1; fs.writeFileSync(source, changed);
  expect(() => verifyWslCodingTools(source)).toThrow();
});

it("stages a task's coding tools read back and compared, without a disk sync per file (WSL workspace open, Windows Server 2025)", () => {
  const source = fs.readFileSync("app/main/agent/wsl-coding-tools.ts", "utf8");
  const loop = source.slice(source.indexOf('for (const [name, files] of [["npm", value.npm], ["typescript", value.typescript]] as const)'), source.indexOf('await fs.symlink("bash"'));
  expect(loop).toContain('const out = await fs.open(target, "wx", 0o600);');
  expect(loop).toContain("await out.writeFile(f.bytes); const read = await fs.readFile(target); if (!read.equals(f.bytes)) throw bad();");
  expect(loop).not.toMatch(/\.sync\(|\.datasync\(/);
});
