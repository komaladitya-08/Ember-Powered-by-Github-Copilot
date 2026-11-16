import { expect, it } from "vitest";
import { parseWindowsCommandCopyReport, WINDOWS_COMMAND_COPY_REPORT_BYTES, WINDOWS_COMMAND_COPY_REPORT_MAGIC, type WindowsCommandCopyProofMode } from "../fixtures/windows-command-copy-report";
function report(mode: WindowsCommandCopyProofMode = "useful") {
  const numeric = mode === "useful" ? 1 : mode === "writer" ? 2 : 3;
  const words = [WINDOWS_COMMAND_COPY_REPORT_MAGIC, 1, numeric, 1, numeric === 2 ? 13 : 19, numeric === 1 ? 0xfff : numeric === 2 ? 0xf01 : 0xf07,
    5, 5, 5, 5, numeric === 3 ? 5 : 0, numeric === 3 ? 5 : 0, numeric === 3 ? 5 : 0, 0, numeric === 2 ? 1 : 0, 0];
  const bytes = Buffer.alloc(WINDOWS_COMMAND_COPY_REPORT_BYTES); words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4)); return bytes;
}
it.each(["useful", "writer", "revoked"] as const)("decodes only closed immutable %s numeric facts", mode => {
  const bytes = report(mode), decoded = parseWindowsCommandCopyReport(bytes, mode);
  expect(decoded.status).toBe(1); expect(Object.isFrozen(decoded)).toBe(true); expect(decoded.sourceReadError).toBe(5);
  bytes.fill(0); expect(decoded.sourceReadError).toBe(5); expect(Object.values(decoded).every(value => typeof value === "number")).toBe(true);
});
it.each([0, 63, 65, 65536])("refuses nonexact report bytes %i", length => expect(() => parseWindowsCommandCopyReport(Buffer.alloc(length), "useful")).toThrow("numeric contract"));
it.each([[0, 0], [1, 2], [2, 0], [3, 0], [3, 3], [4, 20], [4, 13], [5, 0xffe], [5, 0x1fff], [6, 0], [7, 32], [8, 3], [9, 0], [10, 5], [11, 5], [12, 5], [13, 1], [14, 1], [15, 1]])("refuses forged completed useful word %i=%i", (offset, value) => {
  const bytes = report(); bytes.writeUInt32LE(value, offset * 4); expect(() => parseWindowsCommandCopyReport(bytes, "useful")).toThrow();
});
it.each(["useful", "writer", "revoked"] as const)("refuses another mode's report as %s", mode => {
  for (const other of ["useful", "writer", "revoked"] as const) if (other !== mode) expect(() => parseWindowsCommandCopyReport(report(other), mode)).toThrow();
});
it.each([10, 11, 12])("requires revoked denial code5 in work slot %i", offset => {
  const bytes = report("revoked"); bytes.writeUInt32LE(0, offset * 4); expect(() => parseWindowsCommandCopyReport(bytes, "revoked")).toThrow();
});
it.each([[4, 19], [5, 0xf00], [5, 0xf03], [14, 0], [14, 2]])("requires the static writer-started shape word %i=%i", (offset, value) => {
  const bytes = report("writer"); bytes.writeUInt32LE(value, offset * 4); expect(() => parseWindowsCommandCopyReport(bytes, "writer")).toThrow();
});
it("preserves a finite failed operation and immediate error without private native text", () => {
  const bytes = report(); bytes.writeUInt32LE(2, 12); bytes.writeUInt32LE(6, 16); bytes.writeUInt32LE(0xf01, 20); bytes.writeUInt32LE(32, 52);
  expect(parseWindowsCommandCopyReport(bytes, "useful")).toMatchObject({ status: 2, operation: 6, features: 0xf01, failedOperationError: 32 });
  bytes.writeUInt32LE(0, 52); expect(parseWindowsCommandCopyReport(bytes, "useful").failedOperationError).toBe(0);
});
it("permits a failed protected probe with no data operation or invented denial bit", () => {
  const bytes = report(); const words = [WINDOWS_COMMAND_COPY_REPORT_MAGIC, 1, 1, 2, 2, 0x100, 5, 0, 0, 0, 0, 0, 0, 13, 0, 0];
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4)); expect(parseWindowsCommandCopyReport(bytes, "useful").features).toBe(0x100);
});
it.each([[3, 2], [5, 0xf00], [14, 0]])("does not certify a partial writer as a started report for changed slot %i", (offset, value) => {
  const bytes = report("writer"); bytes.writeUInt32LE(value, offset * 4); expect(() => parseWindowsCommandCopyReport(bytes, "writer")).toThrow();
});
it("refuses impossible work progress, unknown modes and out-of-band reserved payload", () => {
  const bytes = report(); bytes.writeUInt32LE(2, 12); bytes.writeUInt32LE(5, 16); expect(() => parseWindowsCommandCopyReport(bytes, "useful")).toThrow();
  expect(() => parseWindowsCommandCopyReport(report(), "foreign" as WindowsCommandCopyProofMode)).toThrow();
});


it.each(["missing earlier protected probe", "future protected error", "skipped useful operation", "future revoked probe"])("rejects impossible failed progress: %s", shape => {
  const mode = shape === "future revoked probe" ? "revoked" : "useful", bytes = report(mode);
  bytes.writeUInt32LE(2, 12); bytes.writeUInt32LE(13, 52);
  if (shape === "missing earlier protected probe") { bytes.writeUInt32LE(3, 16); bytes.writeUInt32LE(0x200, 20); bytes.writeUInt32LE(0, 24); bytes.writeUInt32LE(0, 32); bytes.writeUInt32LE(0, 36); }
  if (shape === "future protected error") { bytes.writeUInt32LE(2, 16); bytes.writeUInt32LE(0x100, 20); bytes.writeUInt32LE(0, 28); bytes.writeUInt32LE(32, 32); bytes.writeUInt32LE(0, 36); }
  if (shape === "skipped useful operation") { bytes.writeUInt32LE(8, 16); bytes.writeUInt32LE(0xf01, 20); }
  if (shape === "future revoked probe") { bytes.writeUInt32LE(16, 16); bytes.writeUInt32LE(0xf00, 20); bytes.writeUInt32LE(0, 40); bytes.writeUInt32LE(32, 44); bytes.writeUInt32LE(0, 48); }
  expect(() => parseWindowsCommandCopyReport(bytes, mode)).toThrow();
});
