import { expect, it } from "vitest";
import { abiUnitImage, abiUnitObject } from "../fixtures/windows-uv-observer-abi-unit";
// @ts-expect-error -- bounded portable file-format evidence, no PE or object execution
import { inspectWindowsUvObserverAbiImage as image, inspectWindowsUvObserverAbiObject as object } from "../../scripts/experimental/windows-uv-observer-abi-image.mjs";

it("returns only image identity and bounded import counts for ordinary named imports", () => {
  const result = image(abiUnitImage()); expect(result).toMatchObject({ bytes: 2048, importModules: 1, namedImports: 1, forbiddenImports: 0, ordinalImports: 0, delayImports: 0 });
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(result)).not.toMatch(/GetLastError|KERNEL|0x|symbol|path/); expect(Object.isFrozen(result)).toBe(true);
});
it.each(["CreateNamedPipeA", "CreateFileA", "ConnectNamedPipe", "CreateIoCompletionPort", "CreateProcessW", "__imp_CreateFileA"])("refuses real target import %s from any DLL", name => {
  for (const dll of ["KERNEL32.dll", "KernelBase.dll", "api-ms-win-core-file-l1-1-0.dll"]) expect(() => image(abiUnitImage(name, dll))).toThrow("fixed observer ABI image was refused");
});
it("rejects ordinal/delay imports, unbacked names and missing descriptor/thunk terminators", () => {
  for (const mutate of [
    (b: Buffer) => b.writeBigUInt64LE(0x8000000000000001n, 0x3c0), (b: Buffer) => b.writeUInt32LE(0x1100, 0x98 + 112 + 13 * 8),
    (b: Buffer) => b.writeUInt32LE(0x70000000, 0x30c), (b: Buffer) => b.writeUInt32LE(20, 0x98 + 124),
    (b: Buffer) => b.fill(0x41, 0x402), (b: Buffer) => b.writeUInt32LE(0x70000000, 0x300),
    (b: Buffer) => b.writeUInt16LE(0x14c, 0x84), (b: Buffer) => b.writeUInt16LE(2, 0x98 + 68),
  ]) { const bytes = abiUnitImage(); mutate(bytes); expect(() => image(bytes)).toThrow("fixed observer ABI image was refused"); }
});
it("accepts a bounded AMD64 COFF object containing backed executable code without decoding symbols", () => {
  const result = object(abiUnitObject()); expect(result.bytes).toBe(128); expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(result)).toEqual(["bytes", "sha256"]); expect(Object.isFrozen(result)).toBe(true);
});
it("rejects anonymous/LTCG or malformed objects, missing machine code and unsafe ranges", () => {
  for (const mutate of [
    (b: Buffer) => b.writeUInt16LE(0, 0), (b: Buffer) => b.writeUInt16LE(0xffff, 2), (b: Buffer) => b.writeUInt16LE(1, 16),
    (b: Buffer) => b.writeUInt32LE(0, 56), (b: Buffer) => b.writeUInt32LE(127, 40), (b: Buffer) => b.writeUInt32LE(0xffffffff, 12),
    (b: Buffer) => b.writeUInt32LE(0xffffffff, 122), (b: Buffer) => b.writeUInt16LE(0xffff, 52), (b: Buffer) => b.writeUInt32LE(0x61000020, 56),
  ]) { const bytes = abiUnitObject(); mutate(bytes); expect(() => object(bytes)).toThrow("fixed observer ABI image was refused"); }
  for (const value of [null, "private", Buffer.alloc(0), Buffer.alloc(60)]) expect(() => object(value)).toThrow("fixed observer ABI image was refused");
});
