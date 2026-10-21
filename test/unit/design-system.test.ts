/** The shared design system (app/renderer/shared/ember.css): what every window keeps to. */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { BUBBLE_CSS } from "@ember/bubble";

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
const shared = read("app/renderer/shared/ember.css");
const PAGES = ["home", "overlay", "handle", "ask", "desk"];

/** A token's value in the shared stylesheet's :root (the first one: the dark appearance). */
const token = (name: string) => {
  const m = new RegExp(`--${name}: ([^;]+);`).exec(shared);
  if (!m) throw new Error(`no --${name}`);
  return m[1].trim();
};
type RGB = [number, number, number];
const parse = (c: string): { rgb: RGB; a: number } => {
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) return { rgb: [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16)) as RGB, a: 1 };
  const m = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(c);
  if (!m) throw new Error(`can't read ${c}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: m[4] === undefined ? 1 : Number(m[4]) };
};
/** `fg` (maybe translucent) as it shows over the opaque `bg`. */
const over = (fg: string, bg: string): RGB => {
  const f = parse(fg), b = parse(bg);
  return f.rgb.map((v, i) => v * f.a + b.rgb[i] * (1 - f.a)) as RGB;
};
const contrast = (a: RGB, b: RGB) => {
  const lum = (c: RGB) => {
    const [r, g, bl] = c.map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const solid = (c: string) => parse(c).rgb;

describe("the design system's colours", () => {
  const surfaces = ["surface-0", "surface-1", "surface-2", "glass-solid"].map(token);

  it("keeps text readable on every surface (WCAG 1.4.3: 4.5:1)", () => {
    for (const bg of surfaces) {
      for (const label of ["label", "label-2", "label-3"]) expect(contrast(over(token(label), bg), solid(bg)), `${label} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      // Colours that are also text (links, the sign-in code, status words); red, blue and purple only mark things.
      for (const c of ["accent", "green", "yellow"]) expect(contrast(solid(token(c)), solid(bg)), `${c} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const c of ["red", "blue", "purple", "gray"]) expect(contrast(solid(token(c)), solid(bg)), `${c} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the system colours' text tints readable on every surface and on their own tints", () => {
    for (const [text, tint] of [["green-text", "green"], ["red-text", "red"], ["purple-text", "purple"]]) {
      for (const bg of surfaces) {
        expect(contrast(solid(token(text)), solid(bg)), `${text} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        // A tag: the tint at 18 % behind its word.
        const tag = over(`rgba(${solid(token(tint)).join(", ")}, 0.18)`, bg);
        expect(contrast(solid(token(text)), tag), `${text} on its tint over ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("puts dark text on its filled buttons (white on Apple's orange is 2.2:1)", () => {
    for (const c of ["accent", "green", "red", "purple", "yellow", "blue"]) expect(contrast(solid(token("on-accent")), solid(token(c))), c).toBeGreaterThanOrEqual(4.5);
  });

  it("outlines controls at 3:1 or more against what they sit on (WCAG 1.4.11)", () => {
    for (const bg of surfaces) expect(contrast(over(token("control-edge"), bg), solid(bg)), bg).toBeGreaterThanOrEqual(3);
  });
});

describe("shape", () => {
  it("rounds corners only from the radius tokens (or a circle, a capsule's half, or what a parent passes on)", () => {
    const sources = [shared, BUBBLE_CSS, ...PAGES.map(p => read(`app/renderer/${p}/styles.css`))];
    const ok = /^(var\(--r-[a-z]+(, \d+px)?\)( var\(--r-[a-z]+\))*|calc\(var\(--r-[a-z]+\) \+ \d+px\)|50%|0|inherit|1px)$/;
    for (const css of sources) for (const [, v] of css.matchAll(/border-radius: ([^;]+);/g)) expect(v, v).toMatch(ok);
  });
});

describe("the typeface", () => {
  it("is bundled with its licence, which the RPM and the notices name", () => {
    for (const f of ["InterVariable.woff2", "LICENSE.txt"]) expect(existsSync(new URL(`../../assets/fonts/${f}`, import.meta.url)), f).toBe(true);
    expect(read("assets/fonts/LICENSE.txt")).toContain("SIL Open Font License, Version 1.1");
    expect(shared).toContain('src: url("../fonts/InterVariable.woff2") format("woff2")');
    expect(read("scripts/build-app.mjs")).toMatch(/cp\(new URL\("assets\/fonts\/", root\), new URL\("renderer\/fonts\/", out\)/);
    expect(/^License:\s*(.+)$/m.exec(read("packaging/rpm/ember.spec"))![1].split(/\s+AND\s+/)).toContain("OFL-1.1");
    expect(read("scripts/package/stage.mjs")).toContain('path.join(root, "assets/fonts/LICENSE.txt")');
  });
});

describe("every window", () => {
  it("loads the shared design system before its own styles", () => {
    for (const p of PAGES) {
      const html = read(`app/renderer/${p}/index.html`);
      const at = html.indexOf('href="../shared/ember.css"');
      expect(at, p).toBeGreaterThan(0);
      expect(at, p).toBeLessThan(html.indexOf('href="styles.css"'));
    }
  });

  it("draws glass over other apps without a backdrop blur (software compositing: a blur costs a core)", () => {
    for (const css of [BUBBLE_CSS, ...["overlay", "handle", "ask"].map(p => read(`app/renderer/${p}/styles.css`))]) expect(css).not.toMatch(/backdrop-filter/);
  });

  it("animates only opacity and transforms, and the bubble's glow breathes a few times, not forever", () => {
    // Under software compositing anything else animated repaints its layer every frame.
    for (const css of [BUBBLE_CSS, shared, ...PAGES.map(p => read(`app/renderer/${p}/styles.css`))]) {
      for (const [, body] of css.matchAll(/@keyframes [\w-]+ \{((?:[^{}]*\{[^}]*\})*)[^}]*\}/g)) {
        for (const [, prop] of body.matchAll(/([\w-]+):/g)) expect(["opacity", "transform", "translate", "scale"], body).toContain(prop);
      }
    }
    expect(BUBBLE_CSS).toMatch(/::before \{ opacity: 1; animation: eb-glow [\d.]+s ease-in-out \d; \}/);
  });

  it("stops every endless animation in Calm mode", () => {
    for (const p of ["overlay", "handle"]) {
      const css = read(`app/renderer/${p}/styles.css`);
      const endless = [...css.matchAll(/([^{}]+)\{[^}]*animation: [\w-]+ [\d.]+s [\w-]+ infinite/g)].map(m => m[1].trim());
      expect(endless.length, p).toBeGreaterThan(0);
      for (const sel of endless) {
        const el = sel.split(",").pop()!.trim().replace(/\[data-state="active"\]/, "");
        expect(css, `${p}: ${sel}`).toMatch(new RegExp(`html\\.calm [^{]*${el.replace(/[.[\]()*:"=]/g, "\\$&").replace(/^\\\./, "\\.")}`));
      }
    }
    expect(shared).toMatch(/html\.calm \*, html\.calm \*::before, html\.calm \*::after \{[^}]*animation: none !important/);
  });

  it("fits the ask box's field and its hint line in the 92 px window", () => {
    const css = read("app/renderer/ask/styles.css");
    const inset = Number(/\.ask \{[^}]*inset: (\d+)px/.exec(css)![1]);
    const gap = Number(/\.ask \{[^}]*gap: (\d+)px/.exec(css)![1]);
    const field = Number(/\.field \{[^}]*flex: 0 0 (\d+)px/.exec(css)![1]);
    const meta = /\.meta \{[^}]*/.exec(css)![0];
    const border = Number(/border: (\d+)px/.exec(meta)?.[1] ?? 0);
    const line = Number(/line-height: (\d+)px/.exec(meta)![1]) + 2 * Number(/padding: (\d+)px/.exec(meta)![1]) + 2 * border;
    expect(/const SIZE = \{ width: 560, height: 92 \}/.test(read("app/main/ask.ts"))).toBe(true);
    expect(2 * inset + field + gap + line).toBeLessThanOrEqual(92);
  });
});
