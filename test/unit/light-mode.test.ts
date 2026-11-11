/**
 * Light windows (owner decision of 2026-11-05): the content windows take ember.css's light tokens, every word and control
 * on them keeps its contrast (WCAG 1.4.3, 1.4.11), a contrast theme keeps its system colours, and the floating layer
 * stays dark.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsSchema } from "../../app/main/settings";

const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8").replace(/\r\n/g, "\n");
const css = read("app/renderer/shared/ember.css");

type RGB = [number, number, number];
const hex = (c: string): RGB => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)) as RGB;
/** A colour as painted on `under`. */
function paint(c: string, under: RGB): RGB {
  if (c.startsWith("#")) return hex(c);
  const m = /rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/.exec(c);
  if (!m) throw new Error(`can't read ${c}`);
  const a = Number(m[4]);
  return [1, 2, 3].map((n, i) => Number(m[n]) * a + under[i] * (1 - a)) as RGB;
}
const lum = (rgb: RGB) => {
  const [r, g, b] = rgb.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** The tokens in the html.content block of the @media rule that starts with `query`. */
function tokens(query: string): Record<string, string> {
  const at = css.indexOf(`${query} {\n  html.content {`);
  expect(at, query).toBeGreaterThan(0);
  const body = css.slice(at, css.indexOf("\n  }\n}", at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+): ([^;]+);/g)].map(m => [m[1], m[2]]));
}

const LIGHT = "@media (prefers-color-scheme: light) and (forced-colors: none)";
const MORE = "@media (prefers-color-scheme: light) and (forced-colors: none) and (prefers-contrast: more)";
const light = tokens(LIGHT);
const firm = { ...light, ...tokens(MORE) };
const WORDS = ["--label", "--label-2", "--label-3", "--accent", "--accent-2", "--green", "--yellow", "--green-text", "--red-text", "--purple-text"];
const MARKS = ["--control-edge", "--red", "--purple", "--blue", "--gray", "--scroll-thumb"];

describe.each([["light windows", light], ["light windows with Increase Contrast", firm]])("%s", (_name, t) => {
  const surfaces = ["--surface-0", "--surface-1", "--surface-2"].map(s => hex(t[s]));

  it("keep every word at 4.5:1 or more on every surface (WCAG 1.4.3)", () => {
    for (const under of surfaces) for (const word of WORDS) {
      expect(contrast(paint(t[word], under), under), `${word} on ${under.join()}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("keep every control edge and mark at 3:1 or more (WCAG 1.4.11)", () => {
    for (const under of surfaces) for (const mark of MARKS) {
      expect(contrast(paint(t[mark], under), under), `${mark} on ${under.join()}`).toBeGreaterThanOrEqual(3);
    }
  });
  it("keep words on the accent fill at 4.5:1 or more", () => {
    expect(contrast(hex(t["--on-accent"]), hex(t["--accent"]))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the approval window's “Risky step” tag", () => {
  const rule = /^\.risk \{([^}]*)\}/m.exec(read("app/renderer/prompt/styles.css"))![1];
  const tokenOf = (prop: string) => new RegExp(`(?:^|; | )${prop}: var\\((--[\\w-]+)\\);`).exec(rule)?.[1];
  /** The dark values: ember.css's first :root block, and Increase Contrast's over it. */
  const block = (open: string) => {
    const at = css.indexOf(open);
    expect(at, open).toBeGreaterThanOrEqual(0);
    return Object.fromEntries([...css.slice(at, css.indexOf("\n}", at)).matchAll(/(--[\w-]+): ([^;]+);/g)].map(m => [m[1], m[2]]));
  };
  const dark = block(":root {");
  const darkFirm = { ...dark, ...block("@media (prefers-contrast: more) {\n  :root {") };

  it("takes its words and its fill from tokens that change together, so its words read at 4.5:1 or more in dark, light and with Increase Contrast (accessibility-r7-1, WCAG 1.4.3)", () => {
    const [word, fill] = [tokenOf("color"), tokenOf("background")];
    // A literal colour here stayed dark while the light windows' --yellow became a dark text colour: 2.9:1, and 2.2:1 firm.
    expect(word, rule).toBeDefined();
    expect(fill, rule).toBe("--yellow");
    for (const [name, t] of [["dark", dark], ["dark with Increase Contrast", darkFirm], ["light", light], ["light with Increase Contrast", firm]] as const) {
      expect(contrast(hex(t[word!]), hex(t[fill!])), name).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("which windows are light", () => {
  it("is the content windows alone: the floating layer stays dark over any app", () => {
    for (const page of ["home", "command", "prompt"]) expect(read(`app/renderer/${page}/index.html`), page).toContain('<html lang="en" class="content">');
    for (const page of ["overlay", "handle", "ask", "desk", "mic"]) expect(read(`app/renderer/${page}/index.html`), page).not.toContain('class="content"');
  });
  it("gives every wash and keycap token a light value, so no white wash is left on a light window", () => {
    for (const t of [...css.matchAll(/^ {2}(--(?:wash-\d+|key-[a-z]+)):/gm)].map(m => m[1])) expect(light[t], t).toBeDefined();
    for (const page of ["home", "command"]) expect(read(`app/renderer/${page}/styles.css`), page).not.toMatch(/background: rgba\(255, 255, 255/);
  });
  it("leaves a contrast theme its system colours", () => {
    expect(css).toContain(LIGHT);
    expect(css).not.toMatch(/@media \(prefers-color-scheme: light\) \{/);
  });
  it("matches the computer unless the user chooses, and a bad value is repaired", () => {
    expect(SettingsSchema.parse({}).appearance).toBe("system");
    expect(SettingsSchema.safeParse({ appearance: "sepia" }).success).toBe(false);
  });
  it("paints the same colour before the page does", () => {
    expect(read("app/main/windows.ts")).toContain(light["--surface-0"]);
  });
});
