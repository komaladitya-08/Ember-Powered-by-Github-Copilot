import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { stageWindowsNodeToolchain, verifyWindowsNodeToolchain, WINDOWS_NODE_TOOLCHAIN } from "../../scripts/package/windows-node-toolchain.mjs";

const owned: string[] = [];
const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-node-assets-")); owned.push(dir); return dir; };
afterEach(() => { vi.doUnmock("node:fs"); vi.resetModules(); for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
it("cannot turn a foreign manifest, directory or file set into a packaged toolchain", () => {
  const dir = root(), destination = path.join(dir, "package");
  expect(() => verifyWindowsNodeToolchain(dir)).toThrow("could not be verified");
  expect(() => stageWindowsNodeToolchain(dir, destination)).toThrow("could not be verified");
  expect(fs.existsSync(destination)).toBe(false);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ ...WINDOWS_NODE_TOOLCHAIN, files: [] }));
  expect(() => verifyWindowsNodeToolchain(dir)).toThrow("could not be verified");
});
it("rejects truncated runtime files before creating or replacing a destination", () => {
  const dir = root(), source = path.join(dir, "source"), destination = path.join(dir, "package"); fs.mkdirSync(source);
  for (const file of WINDOWS_NODE_TOOLCHAIN.files) fs.writeFileSync(path.join(source, file.source), Buffer.from("MZ"));
  fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, "keep"), "untouched");
  expect(() => stageWindowsNodeToolchain(source, destination)).toThrow("could not be verified");
  expect(fs.readdirSync(destination)).toEqual(["keep"]); expect(fs.readFileSync(path.join(destination, "keep"), "utf8")).toBe("untouched");
});
it("refuses aliases and never accepts an unknown kind or a relative selection", () => {
  const dir = root(), link = path.join(dir, "alias"), selected = path.join(dir, "selected"); fs.mkdirSync(selected);
  fs.symlinkSync(selected, link, process.platform === "win32" ? "junction" : "dir");
  expect(() => verifyWindowsNodeToolchain(link)).toThrow("could not be verified");
  expect(() => verifyWindowsNodeToolchain(dir, "other" as "package")).toThrow("could not be verified");
  expect(() => verifyWindowsNodeToolchain("relative")).toThrow("could not be verified");
});
it("keeps compatibility facts immutable and enables no execution authority", () => {
  expect(Object.isFrozen(WINDOWS_NODE_TOOLCHAIN)).toBe(true);
  expect(Object.isFrozen(WINDOWS_NODE_TOOLCHAIN.files[0])).toBe(true);
  expect(Object.isFrozen(WINDOWS_NODE_TOOLCHAIN.compatibility.moduleResolutionFlags)).toBe(true);
  expect(Reflect.set(WINDOWS_NODE_TOOLCHAIN.compatibility, "children", true)).toBe(false);
  expect(WINDOWS_NODE_TOOLCHAIN.compatibility.implicitArguments).toBe(false);
});
it("an unknown descriptor close permanently blocks further reads and staging in that host module", async () => {
  const source = root(), destination = path.join(source, "new-package");
  for (const file of WINDOWS_NODE_TOOLCHAIN.files) fs.writeFileSync(path.join(source, file.source), "");
  let opened = 0, closed = 0;
  const size = BigInt(WINDOWS_NODE_TOOLCHAIN.files[0].bytes);
  const information = (stat: fs.BigIntStats) => Object.assign(Object.create(stat) as fs.BigIntStats, { size });
  vi.resetModules();
  vi.doMock("node:fs", () => ({ default: { ...fs,
    lstatSync: (target: fs.PathLike, options: { bigint: true }) => {
      const stat = fs.lstatSync(target, options); return String(target).endsWith("source-node.exe") ? information(stat) : stat;
    },
    openSync: (target: fs.PathLike, flags: number) => { opened++; return fs.openSync(target, flags); },
    fstatSync: (fd: number) => information(fs.fstatSync(fd, { bigint: true })),
    readSync: () => 0,
    closeSync: (fd: number) => { closed++; fs.closeSync(fd); throw Error("Unknown descriptor closure"); },
  } }));
  const candidate = await import("../../scripts/package/windows-node-toolchain.mjs");
  expect(() => candidate.verifyWindowsNodeToolchain(source, "producer")).toThrow("could not be verified");
  expect(opened).toBe(1); expect(closed).toBe(1);
  expect(() => candidate.verifyWindowsNodeToolchain(source, "producer")).toThrow("could not be verified");
  expect(() => candidate.stageWindowsNodeToolchain(source, destination)).toThrow("could not be verified");
  expect(opened).toBe(1); expect(closed).toBe(1); expect(fs.existsSync(destination)).toBe(false);
});
