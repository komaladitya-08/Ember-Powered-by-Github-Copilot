/**
 * First run and the setup check (release review, package "onboard"): what the settings window shows before Start,
 * which setup rows need the user, and what Ember says once it starts. Pure functions are called directly; the page's
 * own markup, style sheet and script are read as text where the behaviour is theirs (there is no DOM in these tests).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(new URL(`../../app/${f}`, import.meta.url), "utf8");
const PAGE = read("renderer/home/index.html");
const STYLES = read("renderer/home/styles.css");
const SCRIPT = read("renderer/home/main.ts");

describe("the settings window's first paint", () => {
  it("shows nothing of the page until the first status says which layout it has, for at most 1.5 s (review #249)", () => {
    // The window is shown at ready-to-show, before the status (it waits up to 3 s for other computers' rows) arrives.
    expect(PAGE).toMatch(/<body class="loading">/);
    expect(STYLES).toMatch(/body\.loading \.home \{ visibility: hidden; \}/);
    // The first settings applied lift the gate, and so does the cap.
    expect(SCRIPT).toMatch(/function applySettings\(s: Settings\): void \{[\s\S]*?document\.body\.classList\.remove\("loading"\);[\s\S]*?\n\}/);
    expect(SCRIPT).toContain("setTimeout(() => document.body.classList.remove(\"loading\"), 1500);");
  });
});

describe("the microphone consent", () => {
  it("is read with the button that agrees to it, so a screen reader user hears what they agree to (review #153)", () => {
    // Turning on "Hey Ember" moves focus straight to the button: its description is the whole note.
    const panel = /<div id="consent" ([^>]*)>\s*<p id="consent-text">/.exec(PAGE);
    expect(panel, "the note is the panel's first paragraph, with an id").not.toBeNull();
    expect(panel![1]).toContain("role=\"group\"");
    expect(panel![1]).toContain("aria-describedby=\"consent-text\"");
    expect(panel![1]).toMatch(/aria-label="[^"]+"/);
    expect(PAGE).toMatch(/<button type="button" id="consent-yes" class="btn" aria-describedby="consent-text">I agree, start listening<\/button>/);
    expect(SCRIPT).toContain("$(\"consent-yes\").focus()");
  });
});
