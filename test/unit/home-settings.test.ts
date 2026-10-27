/**
 * The settings window's page and styles, read as text (vitest runs without a DOM): what hides, what each control is
 * called, and how the sections fit the window. Each block names the review finding it pins.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { STARTED_TEXT, fixButtonName, fixFailedText } from "../../app/renderer/home/copy";

const read = (f: string) => readFileSync(new URL(`../../app/renderer/home/${f}`, import.meta.url), "utf8");
const css = read("styles.css");
const page = read("index.html");

describe("hidden means hidden (review #154)", () => {
  it("never lets a display rule show an element the page hid", () => {
    // `.add-row { display: flex }` and `section { display: grid }` beat the browser's own [hidden] rule.
    expect(css).toMatch(/(^|\n)\[hidden\] \{ display: none !important; \}/);
  });
});

describe("setup check fix buttons (review #155, #49)", () => {
  it("names each button after its row, starting with the words it shows", () => {
    expect(fixButtonName("Open System Settings", "Screen Recording")).toBe("Open System Settings: Screen Recording");
    expect(fixButtonName("Turn on", "Accessibility in Ubuntu")).toBe("Turn on: Accessibility in Ubuntu");
  });

  it("says a refused fix where a screen reader hears it, and names the row", () => {
    expect(fixFailedText("Screen reading", "gsettings isn't installed")).toBe("Screen reading: couldn't change it. gsettings isn't installed");
    // A live region that is there from the start (one made with its text is often not read).
    expect(page).toMatch(/<ul class="checks" id="checks"><\/ul>\s*<p class="sr" id="checks-msg" role="status"><\/p>/);
  });
});

describe("the sidebar says what the sections are called (review #162)", () => {
  it("names each link with its section's heading", () => {
    const decode = (s: string) => s.replace(/&amp;/g, "&");
    const links = [...page.matchAll(/<a href="#([\w-]+-h)"[^>]*>([^<]+)<\/a>/g)].map(m => [m[1], decode(m[2])] as const);
    expect(links.length).toBe(11);
    for (const [id, text] of links) {
      const heading = decode(new RegExp(`<h2 id="${id}"[^>]*>([^<]+)</h2>`).exec(page)?.[1] ?? "");
      // "About" opens "About this build": the heading may say more after the link's words, never something else.
      expect(heading === text || heading.startsWith(`${text} `), `${text} → ${heading}`).toBe(true);
    }
  });
});

describe("the sidebar shows that it scrolls (review #250)", () => {
  it("keeps the slim scrollbar on the wide sidebar, hiding it only in the narrow row of links", () => {
    const wide = css.slice(css.indexOf("@media (min-width: 640px) {"));
    const sidebar = /body:not\(\.first-run\) \.home > \.jump \{([^}]*)\}/.exec(wide)?.[1] ?? "";
    // scrollbar-width: none (the narrow row's) would be inherited by the sidebar: 11 links need 438 px, the window may be 420.
    expect(sidebar).toMatch(/scrollbar-width: auto;/);
  });
});

describe("the Size slider says its value once (review #56)", () => {
  it("leaves the value to the slider's own aria-valuetext: the number beside it isn't a live region", () => {
    expect(page).not.toMatch(/<output/);
    expect(page).toContain('<label for="size">Size <span id="size-out" class="size-out" aria-hidden="true">60 px</span></label>');
    expect(page).toMatch(/<input type="range" id="size"[^>]*aria-valuetext="60 pixels">/);
    expect(css).toMatch(/\.pick-row \.size-out \{/);
  });
});

describe("Start hands focus on when it goes (review #50)", () => {
  it("has a status line that says Ember started, there from the start", () => {
    expect(STARTED_TEXT).toBe("Ember has started.");
    expect(page).toMatch(/<p id="tagline" role="status">Starting…<\/p>\s*<p class="sr" id="home-live" role="status"><\/p>/);
  });
});
