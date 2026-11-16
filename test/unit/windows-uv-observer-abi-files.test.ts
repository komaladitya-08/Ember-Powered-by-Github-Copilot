import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error -- bounded trusted-CI file helper outside application build
import { ordinaryAbiWindowsPath, readWindowsUvObserverAbiFile as read } from "../../scripts/experimental/windows-uv-observer-abi-files.mjs";
afterEach(() => vi.restoreAllMocks());
const file = "D:\\fixed\\object.obj";
function setup(mode = "stable") {
  const info = (clock: number) => ({ isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, nlink: 1, size: 4, dev: 1, ino: 2, mtimeMs: clock, ctimeMs: clock });
  let named = 0, held = 0;
  vi.spyOn(fs, "lstatSync").mockImplementation(((value: unknown) => value === file ? info(++named > 1 && mode === "path-clock" ? 3 : 1) : info(1)) as unknown as typeof fs.lstatSync);
  vi.spyOn(fs.realpathSync, "native").mockImplementation((value => value) as typeof fs.realpathSync.native);
  vi.spyOn(fs, "openSync").mockReturnValue(7);
  vi.spyOn(fs, "fstatSync").mockImplementation((() => info(++held > 1 && mode === "held-clock" ? 3 : 2)) as unknown as typeof fs.fstatSync);
  const close = vi.spyOn(fs, "closeSync").mockImplementation(() => { if (mode === "close") throw new Error("private"); });
  vi.spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
    const buffer = args[1] as Buffer, offset = args[2] as number, position = args[4] as number;
    if (position) return 0; buffer.write(mode === "growing" ? "grow!" : "test", offset); return mode === "growing" ? 5 : 4;
  }) as typeof fs.readSync);
  return close;
}
it("keeps path and held-handle clocks in their own domains and returns a detached bounded read", () => {
  const close = setup(); expect(read(file, 32)).toEqual(Buffer.from("test")); expect(close).toHaveBeenCalledExactlyOnceWith(7);
});
it.each(["path-clock", "held-clock", "close", "growing"])("refuses uncertain or changed file proof: %s", mode => {
  const close = setup(mode); expect(() => read(file, 32)).toThrow("fixed observer ABI file contract was refused"); expect(close).toHaveBeenCalledTimes(1);
});
it.each(["relative", "\\\\server\\object.obj", "D:\\fixed\\..\\object.obj", "D:\\object.obj:stream", "D:\\object.obj ", "D:\\object&other.obj"])("refuses unsupported path before reading: %s", value => {
  expect(() => ordinaryAbiWindowsPath(value)).toThrow("fixed observer ABI file contract was refused");
});
