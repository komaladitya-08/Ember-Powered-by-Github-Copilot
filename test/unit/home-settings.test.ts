/**
 * The settings window's page and styles, read as text (vitest runs without a DOM): what hides, what each control is
 * called, and how the sections fit the window. Each block names the review finding it pins.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fixButtonName, fixFailedText } from "../../app/renderer/home/copy";

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
