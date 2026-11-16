import { expect, it } from "vitest";
import { parseWindowsNodeCngInprocessReport } from "../fixtures/windows-node-cng-inprocess-report";

const good = (role = 1) => {
  const bytes = Buffer.alloc(64), words = [0x49534e45, 1, role, 4, 1, 0, 15, 1, 42, 21, 1, 1, 22023005, 3, 0, 0];
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4)); return bytes;
};
it.each([0, 1] as const)("admits exactly the stopped fixed success for role%i and freezes its numeric projection", role => {
  const result = parseWindowsNodeCngInprocessReport(good(role), role); expect(result).toMatchObject({ role, status: 1, tests: 1, features: 15 }); expect(Object.isFrozen(result)).toBe(true);
});
it.each(Array.from({ length: 16 }, (_, index) => index))("refuses a mutated successful field%i", index => {
  const bytes = good(); bytes.writeUInt32LE(index === 2 ? 0 : 0xffffffff, index * 4);
  expect(() => parseWindowsNodeCngInprocessReport(bytes, 1)).toThrow("fixed numeric contract");
});
it.each([0, 1, 63, 65, 128])("refuses a report of length%i", size => { expect(() => parseWindowsNodeCngInprocessReport(Buffer.alloc(size), 1)).toThrow("fixed numeric contract"); });
it("never treats a bounded failed checkpoint as success", () => {
  const bytes = good(); bytes.writeUInt32LE(5, 12); bytes.writeUInt32LE(2, 16); bytes.writeUInt32LE(1, 20); bytes.writeUInt32LE(0, 28); bytes.writeUInt32LE(4, 52);
  expect(parseWindowsNodeCngInprocessReport(bytes, 1)).toMatchObject({ status: 2, error: 1, tests: 0 });
});
