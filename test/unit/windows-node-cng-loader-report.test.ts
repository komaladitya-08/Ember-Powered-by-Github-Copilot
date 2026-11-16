import { expect, it } from "vitest";
import { parseWindowsNodeCngLoaderReport } from "../fixtures/windows-node-cng-loader-report";
const good = (role = 1) => {
  const bytes = Buffer.alloc(96), words = [0x4c534e45,1,role,5,1,1,22023005,7,7,0,1,0,21,1,0,1,1,0,42,5,0,0,0,0];
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4)); return bytes;
};
it.each([0, 1] as const)("admits only the closed completed role%i report and deep-freezes its bounded rows", role => {
  const value = parseWindowsNodeCngLoaderReport(good(role), role); expect(value).toMatchObject({ role, complete: true, successful: true });
  expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.operations)).toBe(true); expect(value.operations.every(Object.isFrozen)).toBe(true);
});
it.each(Array.from({ length: 24 }, (_, index) => index))("refuses altered successful word%i", index => {
  const bytes = good(); bytes.writeUInt32LE(index === 2 ? 0 : 0xffffffff, index * 4); expect(() => parseWindowsNodeCngLoaderReport(bytes, 1)).toThrow("fixed numeric contract");
});
it.each([0, 95, 97, 128])("refuses wrong length%i", size => { expect(() => parseWindowsNodeCngLoaderReport(Buffer.alloc(size), 1)).toThrow("fixed numeric contract"); });
it("preserves known failures and rejects fabricated success masks/unknown-code combinations", () => {
  const bytes = good(); bytes.writeUInt32LE(0, 20); bytes.writeUInt32LE(1, 32); bytes.writeUInt32LE(6, 36);
  for (const offset of [52, 64]) { bytes.writeUInt32LE(2, offset); bytes.writeUInt32LE(1, offset + 4); bytes.writeUInt32LE(0, offset + 8); }
  expect(parseWindowsNodeCngLoaderReport(bytes, 1)).toMatchObject({ successful: false });
  const forged = Buffer.from(bytes); forged.writeUInt32LE(1, 20); expect(() => parseWindowsNodeCngLoaderReport(forged, 1)).toThrow("fixed numeric contract");
  bytes.writeUInt32LE(3, 52); expect(() => parseWindowsNodeCngLoaderReport(bytes, 1)).toThrow("fixed numeric contract");
});
