/** Regression for the actual global test teardown: uncertain native scratch must live outside its deletion tree. */
import { describe, expect, it } from "vitest";
import { requireWindowsCommandCopyScratchParent } from "../fixtures/windows-command-copy-proof";

describe("native root-only witness scratch lifetime", () => {
  it.each([
    ["D:\\runner-temp", "C:\\Users\\runner\\Temp\\ember-run-123"],
    ["C:\\temp\\native", "C:\\temp\\ember-run-123"],
    ["C:\\temp2", "C:\\temp"],
  ])("accepts disjoint canonical scratch %s", (parent, managed) => {
    expect(() => requireWindowsCommandCopyScratchParent(parent, managed)).not.toThrow();
  });
  it.each([
    ["C:\\temp\\ember-run-123", "C:\\temp\\ember-run-123"],
    ["c:\\TEMP\\EMBER-RUN-123\\native", "C:\\temp\\ember-run-123"],
    ["C:\\temp", "C:\\temp\\ember-run-123"],
    ["C:\\temp\\ember-run-123\\native", "C:\\temp\\ember-run-123"],
    ["relative", "C:\\temp"],
    ["C:\\native", "relative"],
    ["\\\\server\\scratch", "C:\\temp"],
    ["C:\\native\\..\\temp", "D:\\managed"],
    ["C:\\native\n", "D:\\managed"],
  ])("refuses managed teardown overlap or unsupported scratch %s", (parent, managed) => {
    expect(() => requireWindowsCommandCopyScratchParent(parent, managed)).toThrow("native scratch parent");
  });
});
