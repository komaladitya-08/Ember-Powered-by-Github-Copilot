/**
 * The settings window's page and styles, read as text (vitest runs without a DOM): what hides, what each control is
 * called, and how the sections fit the window. Each block names the review finding it pins.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(new URL(`../../app/renderer/home/${f}`, import.meta.url), "utf8");
const css = read("styles.css");
const page = read("index.html");

describe("hidden means hidden (review #154)", () => {
  it("never lets a display rule show an element the page hid", () => {
    // `.add-row { display: flex }` and `section { display: grid }` beat the browser's own [hidden] rule.
    expect(css).toMatch(/(^|\n)\[hidden\] \{ display: none !important; \}/);
  });
});
