import { describe, expect, it } from "vitest";
import { parseWindowsNodeSourceReport } from "../fixtures/windows-node-source-report";

const complete = [0x46534e45, 1, 0, 7, 1, 0, 31, 24, 24, 24, 1, 1, 1, 6, 22023005, 0];
function report(words = complete) { const bytes = Buffer.alloc(64); words.forEach((value, i) => bytes.writeUInt32LE(value, i * 4)); return bytes; }

describe("stopped source-Node fixed reports", () => {
  it("accepts only complete fixed useful-work witnesses for the selected role", () => {
    expect(parseWindowsNodeSourceReport(report(), 0)).toEqual({ role: 0, stage: 7, status: 1, error: 0, features: 31,
      payloadBytes: 24, syncBytes: 24, asyncBytes: 24, fsCallbacks: 1, timerCallbacks: 1, fileRemoved: 1, checkpoints: 6, runtimeVersion: 22023005 });
    const words = [...complete]; words[2] = 1;
    expect(parseWindowsNodeSourceReport(report(words), 1).role).toBe(1);
    expect(() => parseWindowsNodeSourceReport(report(words), 0)).toThrow("fixed numeric contract");
  });
  it.each([0, 1, 63, 65, 65536])("refuses an incorrectly sized report before decoding (%i)", size => {
    expect(() => parseWindowsNodeSourceReport(Buffer.alloc(size), 0)).toThrow("fixed numeric contract");
  });
  it.each(complete.map((_, index) => index))("refuses a corrupted completed field (%i)", index => {
    const words = [...complete]; words[index] = words[index] === 0 ? 1 : words[index] + 1;
    expect(() => parseWindowsNodeSourceReport(report(words), 0)).toThrow("fixed numeric contract");
  });
  it("preserves a bounded failed checkpoint without exposing an exception or path", () => {
    const words = [0x46534e45, 1, 1, 2, 2, 1, 3, 24, 24, 0, 0, 0, 1, 3, 22023005, 0];
    expect(parseWindowsNodeSourceReport(report(words), 1)).toMatchObject({ status: 2, error: 1, fileRemoved: 1 });
    expect(JSON.stringify(parseWindowsNodeSourceReport(report(words), 1))).not.toMatch(/message|stack|path|S-1-/);
  });
  it("refuses contradictory progress counts and unknown stages", () => {
    const words = [0x46534e45, 1, 0, 3, 0, 0, 3, 24, 24, 0, 0, 0, 0, 3, 22023005, 0];
    expect(parseWindowsNodeSourceReport(report(words), 0).status).toBe(0);
    for (const [index, value] of [[6, 7], [11, 1], [12, 1], [3, 6], [3, 7]]) {
      const bad = [...words]; bad[index] = value;
      expect(() => parseWindowsNodeSourceReport(report(bad), 0)).toThrow("fixed numeric contract");
    }
  });
});
