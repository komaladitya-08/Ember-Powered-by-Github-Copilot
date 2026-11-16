import { describe, expect, it } from "vitest";
import { windowsLibuvBootstrapFacts } from "../fixtures/windows-libuv-bootstrap";

describe("fixed C bootstrap receipts", () => {
  it("decodes only the selected directory, immediate native code and closed metadata predicates", () => {
    expect(windowsLibuvBootstrapFacts(0xe17d0005)).toEqual({ directory: "work", operation: "GetFileAttributesW", error: 5,
      currentDirectoryRead: true, currentDirectoryMatches: true, attributesHandleOpened: true,
      ordinaryDirectory: true, attributesHandleClosed: true });
    expect(windowsLibuvBootstrapFacts(0xe10200ce)).toEqual({ directory: "state", operation: "GetFileAttributesW", error: 206,
      currentDirectoryRead: false, currentDirectoryMatches: false, attributesHandleOpened: false,
      ordinaryDirectory: false, attributesHandleClosed: false });
  });
  it.each([0xe1ffffff, 0xe2ffffff])("keeps an out-of-range native error as a fixed refusal (%i)", code => {
    expect(windowsLibuvBootstrapFacts(code)).toEqual({ directory: code === 0xe1ffffff ? "work" : "state",
      operation: "GetFileAttributesW", error: "out-of-range" });
  });
  it.each([0, 10, 132, 0x80000003, -1, 1.5, NaN, Infinity, 0x100000000,
    0xe1000005, 0xe1030005, 0xe1810005, 0xe1090005, 0xe1210005, 0xe1410005])(
    "refuses unknown, unbounded or contradictory numeric facts (%i)", code => {
      expect(windowsLibuvBootstrapFacts(code)).toBeUndefined();
    });
});
