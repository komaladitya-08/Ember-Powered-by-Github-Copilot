/**
 * The desk view tells screen-reader users where their keys go once they take over, and how to hand back: every key
 * (Tab and Escape too) goes to the desk then, and only Ctrl+Alt+End comes back (review #54).
 */

import { describe, expect, it } from "vitest";
import { modeNews, screenName } from "../../app/renderer/desk/a11y";

describe("the desk picture for assistive technology", () => {
  it("while taken over, is named with where the keys go and the way back", () => {
    expect(screenName(true)).toBe("Ember's desk. Your keys go to the desk. Press Ctrl+Alt+End to hand back.");
  });

  it("while Ember has it, is named for what it shows", () => {
    expect(screenName(false)).toBe("What Ember is doing on its desk");
  });

  it("says once when the keyboard moves to the desk or back, and nothing otherwise", () => {
    expect(modeNews(true, false)).toBe("You have the keyboard on the desk. Press Ctrl+Alt+End to hand back.");
    expect(modeNews(false, true)).toBe("You handed the desk back to Ember.");
    expect(modeNews(true, true)).toBeNull();
    expect(modeNews(false, false)).toBeNull();
  });
});
