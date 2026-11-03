/**
 * The natural voice's row in Home (Voice): what became of turning it on, in words, so the switch never stays on with
 * nothing happening and nothing said (owner report of 2026-11-03: on Windows it did nothing).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NATURAL_HINT, naturalVoiceView } from "../../app/renderer/home/copy";

describe("naturalVoiceView", () => {
  it("says what became of turning the natural voice on, for every outcome", () => {
    expect(naturalVoiceView(undefined)).toEqual({ text: NATURAL_HINT, retry: false, busy: false });
    expect(naturalVoiceView({ state: "off" }).text).toBe(NATURAL_HINT);
    expect(naturalVoiceView({ state: "downloading", percent: 45 })).toEqual({ text: "Downloading the natural voice… 45%", retry: false, busy: true });
    expect(naturalVoiceView({ state: "ready" }).text).toBe("Ready: Ember will use it from its next reply.");
    expect(naturalVoiceView({ state: "on" }).text).toBe("On: Ember speaks in the natural voice.");
    expect(naturalVoiceView({ state: "too-slow" }).text).toBe("This computer is too slow for the natural voice, so Ember keeps its usual voice.");
    expect(naturalVoiceView({ state: "needs-native" }).text).toBe("Needs Ember's faster speech, which didn't load on this computer, so Ember keeps its usual voice.");
    expect(naturalVoiceView({ state: "wont-load" }).text).toBe("The natural voice wouldn't load on this computer, so Ember keeps its usual voice.");
    expect(naturalVoiceView({ state: "checking" })).toEqual({ text: "Checking whether this computer is fast enough for the natural voice…", retry: false, busy: true });
    expect(naturalVoiceView({ state: "later" }).text).toBe("On: Ember switches to it the next time it speaks, if this computer is fast enough for it.");
    expect(naturalVoiceView({ state: "needs-voice" }).text).toBe("Ember's own voice needs to be downloaded first (Download the speech models, above).");
  });

  it("offers Try again only after the download failed, saying why", () => {
    const failed = naturalVoiceView({ state: "failed", detail: "Ember can't reach the download site (github.com) right now. Check the network or proxy, then try again." });
    expect(failed).toEqual({ text: "Couldn't download the natural voice. Ember can't reach the download site (github.com) right now. Check the network or proxy, then try again.", retry: true, busy: false });
    for (const state of ["off", "later", "checking", "ready", "on", "too-slow", "wont-load", "needs-native", "needs-voice"] as const) expect(naturalVoiceView({ state }).retry, state).toBe(false);
  });

  it("never shows more than 99% while the download is under way (100% is “Ready”)", () => {
    expect(naturalVoiceView({ state: "downloading", percent: 100 }).text).toBe("Downloading the natural voice… 99%");
  });

  it("has a Try again button in the page, described by the row's words, and the page starts with the hint", () => {
    const html = fs.readFileSync(path.resolve("app/renderer/home/index.html"), "utf8");
    expect(html).toContain(`<button type="button" id="natural-retry" class="btn quiet" aria-describedby="natural-text" hidden>Try again</button>`);
    expect(html).toContain(`<p class="hint" id="natural-text">${NATURAL_HINT}</p>`);
  });
});
