/**
 * The typed-ahead probe's verdict (review #78), which the real Windows and macOS suites print and fail on: letters lost
 * at the start are a finding to report, not a failure; letters out of order or something else in the box are.
 */

import { describe, expect, it } from "vitest";
import { PROBE_TEXT, probeVerdict } from "../integration/typeahead-probe";

describe("probeVerdict (review #78)", () => {
  it("says nothing was lost when the box holds all that was typed", () => {
    const v = probeVerdict("Windows", PROBE_TEXT, PROBE_TEXT);
    expect(v).toMatchObject({ lost: 0, inOrder: true });
    expect(v.line).toContain("nothing lost");
  });

  it("counts the leading letters that went elsewhere, and passes", () => {
    const v = probeVerdict("macOS", PROBE_TEXT, PROBE_TEXT.slice(3));
    expect(v).toMatchObject({ lost: 3, inOrder: true });
    expect(v.line).toContain("(3 of 15 letters lost)");
    expect(v.line).toContain("needs a typed-ahead hold");
  });

  it("counts an empty box as every letter lost, and passes", () => {
    expect(probeVerdict("Windows", PROBE_TEXT, "")).toMatchObject({ lost: PROBE_TEXT.length, inOrder: true });
  });

  it("fails when the box holds letters out of order or something else", () => {
    expect(probeVerdict("Windows", PROBE_TEXT, "quick brwon fox").inOrder).toBe(false);
    expect(probeVerdict("macOS", PROBE_TEXT, "earlier words").inOrder).toBe(false);
  });
});
