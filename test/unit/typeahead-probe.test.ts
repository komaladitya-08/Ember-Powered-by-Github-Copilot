/**
 * The typed-ahead probe's verdict (review #78), which the real Windows and macOS suites print and fail on: letters lost
 * at the start are a finding to report, not a failure; letters out of order or something else in the box are.
 */

import { describe, expect, it } from "vitest";
import { PROBE_TEXT, probeTimeline, probeVerdict } from "../integration/typeahead-probe";

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
    expect(v.line).toContain("users must wait for the box");
  });

  it("counts an empty box as every letter lost, and passes", () => {
    expect(probeVerdict("Windows", PROBE_TEXT, "")).toMatchObject({ lost: PROBE_TEXT.length, inOrder: true });
  });

  it("fails when the box holds letters out of order or something else", () => {
    expect(probeVerdict("Windows", PROBE_TEXT, "quick brwon fox").inOrder).toBe(false);
    expect(probeVerdict("macOS", PROBE_TEXT, "earlier words").inOrder).toBe(false);
  });
});

describe("probeTimeline (review #78)", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 9, 29, 12, 0, 0) + ms).toISOString();
  const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);
  const lines = (...e: Record<string, unknown>[]) => e.map(x => JSON.stringify(x)).join("\n");
  const typed = [5, 45, 85, 125, 165].map(ms => T0 + ms);

  it("says when Ember heard the chord, showed the box and had the keyboard, and how many letters came before", () => {
    const log = lines(
      { msg: "ask.open", source: "hotkey", ms: 20, t: at(-5000) },
      { msg: "ask.open", source: "hotkey", ms: 12, t: at(30) },
      { msg: "ask.reveal", source: "hotkey", t: at(31) },
      { msg: "ask.keyboard", ms: 70, t: at(88) },
    );
    const v = probeTimeline("macOS", log, T0, typed, 3);
    expect(v).toMatchObject({ heardMs: 18, shownMs: 30, keyboardMs: 88, typedBefore: 3 });
    expect(v.line).toContain("heard the chord 18 ms after it was pressed, showed the box at 30 ms and had the keyboard at 88 ms");
    expect(v.line).toContain("3 of the 5 letters were typed before that, and 3 were lost: no more than were typed before, so they went to the app underneath");
  });

  it("says so when more letters were lost than were typed before the box had the keyboard", () => {
    const log = lines({ msg: "ask.open", source: "hotkey", ms: 2, t: at(10) }, { msg: "ask.keyboard", ms: 12, t: at(20) });
    expect(probeTimeline("Windows", log, T0, typed, 2).line).toContain("1 of the 5 letters were typed before that, and 2 were lost: letters were lost inside the box");
  });

  it("says nothing went elsewhere when nothing was lost", () => {
    const log = lines({ msg: "ask.open", source: "hotkey", ms: 2, t: at(10) }, { msg: "ask.keyboard", ms: 3, t: at(11) });
    expect(probeTimeline("Windows", log, T0, typed, 0).line).toContain("1 of the 5 letters were typed before that, and 0 were lost: nothing went elsewhere");
  });

  it("says what is missing from Ember's log, never a time it doesn't have", () => {
    expect(probeTimeline("Windows", "", T0, typed, 1)).toMatchObject({ shownMs: null, keyboardMs: null, typedBefore: null });
    expect(probeTimeline("Windows", "", T0, typed, 1).line).toContain("Ember's log has no opening from the chord");
    const noFocus = probeTimeline("Windows", lines({ msg: "ask.open", source: "hotkey", ms: 2, t: at(10) }, { msg: "not json" }), T0, typed, 1);
    expect(noFocus).toMatchObject({ shownMs: 10, keyboardMs: null });
    expect(noFocus.line).toContain("Electron never said it had the keyboard");
  });
});
