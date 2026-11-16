import { describe, expect, it, vi } from "vitest";
import { parseWindowsLpacChildSdDiagnostic, readWindowsLpacChildSdDiagnostic, WindowsLpacChildSdDiagnosticError,
  WINDOWS_LPAC_CHILD_SD_BYTES, WINDOWS_LPAC_CHILD_SD_MAGIC } from "../fixtures/windows-lpac-child-sd-diagnostic";

const ALL = 0x1fffff;
function receipt(change: Record<number, number> = {}): Buffer {
  const words = [WINDOWS_LPAC_CHILD_SD_MAGIC, 1, 8, 0, ALL, 1, 1, ALL, 0, ALL, 1, 1, ALL, 0, 4, 5, 3, 1, 1, 0];
  for (const [index, value] of Object.entries(change)) words[Number(index)] = value;
  const bytes = Buffer.alloc(WINDOWS_LPAC_CHILD_SD_BYTES); words.forEach((value, index) => bytes.writeUInt32LE(value, index * 4)); return bytes;
}
describe("stopped child-object AccessCheck diagnostic ABI", () => {
  it("decodes the fixed process/thread fields and actual TokenOwner/PrimaryGroup source classes without mutating bytes", () => {
    const bytes = receipt(), before = Buffer.from(bytes);
    expect(parseWindowsLpacChildSdDiagnostic(bytes)).toEqual({ setup: { stage: 8, error: 0 },
      process: { requested: ALL, checked: true, allowed: true, granted: ALL, error: 0 },
      thread: { requested: ALL, checked: true, allowed: true, granted: ALL, error: 0 },
      defaults: { ownerSourceClass: 4, groupSourceClass: 5 }, copiedDacls: 3, cleanup: { primaryClosed: true, duplicateClosed: true } });
    expect(bytes.equals(before)).toBe(true);
  });
  it("keeps API failure separate from a completed denied AccessCheck", () => {
    const failed = parseWindowsLpacChildSdDiagnostic(receipt({ 5: 0, 6: 0, 7: 0, 8: 1360 }));
    const denied = parseWindowsLpacChildSdDiagnostic(receipt({ 6: 0, 7: 0 }));
    expect(failed.process).toEqual({ requested: ALL, checked: false, allowed: false, granted: 0, error: 1360 });
    expect(denied.process).toEqual({ requested: ALL, checked: true, allowed: false, granted: 0, error: 0 });
  });
  it("reports numeric granted masks without treating the report as an authorization predicate", () => {
    expect(parseWindowsLpacChildSdDiagnostic(receipt({ 7: 0x10000000 })).process.granted).toBe(0x10000000);
  });
  it("represents a closed setup failure using its real last stage and source classes", () => {
    const value = parseWindowsLpacChildSdDiagnostic(receipt({ 2: 4, 3: 5, 5: 0, 6: 0, 7: 0, 10: 0, 11: 0, 12: 0, 15: 0, 16: 0, 18: 0 }));
    expect(value.setup).toEqual({ stage: 4, error: 5 }); expect(value.defaults).toEqual({ ownerSourceClass: 4, groupSourceClass: 0 });
    expect(value.cleanup).toEqual({ primaryClosed: true, duplicateClosed: false });
  });
  it.each([0, 79, 81, 160])("rejects incomplete or extended framing (%s bytes)", length => {
    expect(() => parseWindowsLpacChildSdDiagnostic(Buffer.alloc(length))).toThrow(WindowsLpacChildSdDiagnosticError);
  });
  const malformed: Record<number, number>[] = [
    { 0: 0 }, { 1: 2 }, { 2: 0 }, { 2: 9 }, { 3: 5 }, { 4: 0x10000000 }, { 9: 0x10000000 }, { 14: 1 }, { 15: 1 }, { 16: 4 },
    { 17: 0 }, { 18: 0 }, { 19: 1 }, { 5: 2 }, { 6: 2 }, { 10: 2 }, { 11: 2 }, { 17: 2 }, { 18: 2 },
    { 5: 0, 6: 1, 7: 0 }, { 5: 0, 6: 0, 7: 1 }, { 8: 5 }, { 13: 5 }, { 2: 4 },
  ];
  it.each(malformed)("refuses malformed, inconsistent or substituted identity/default metadata (%#)", change => {
    expect(() => parseWindowsLpacChildSdDiagnostic(receipt(change))).toThrow("fixed child-object access diagnostic");
  });
  it("never includes invalid diagnostic bytes in its error", () => {
    const bytes = Buffer.alloc(80, 0x41);
    expect(() => parseWindowsLpacChildSdDiagnostic(bytes)).toThrow("The fixed child-object access diagnostic was invalid.");
  });
  it("never invokes the diagnostic reader after a known writer failure, even for valid-looking bytes", () => {
    const read = vi.fn(() => parseWindowsLpacChildSdDiagnostic(receipt()));
    expect(() => readWindowsLpacChildSdDiagnostic(33, read)).toThrow(WindowsLpacChildSdDiagnosticError); expect(read).not.toHaveBeenCalled();
  });
  it.each([0, 30, 31, 32, 125])("skips diagnostic payload for an outcome that did not complete this producer (%s)", code => {
    const read = vi.fn(() => 42); expect(readWindowsLpacChildSdDiagnostic(code, read)).toBeNull(); expect(read).not.toHaveBeenCalled();
  });
  it("permits the stopped ordinary-denial producer's completed payload", () => {
    const read = vi.fn(() => 42); expect(readWindowsLpacChildSdDiagnostic(18, read)).toBe(42); expect(read).toHaveBeenCalledOnce();
  });
});
