/** The shared design system (app/renderer/shared/ember.css): what every window keeps to. */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { BUBBLE_CSS } from "@ember/bubble";

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
const shared = read("app/renderer/shared/ember.css");
const PAGES = ["home", "overlay", "handle", "ask", "desk", "command", "prompt"];

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

/** A list split at its top-level commas (`:is(h1, h2)` and `rgba(…)` stay whole). */
const selectors = (list: string): string[] => {
  const out: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) { out.push(list.slice(from, i).trim()); from = i + 1; }
  }
  return [...out, list.slice(from).trim()];
};
/** The rules of a stylesheet's `@media (forced-colors: active)` block, as [selectors, declarations]. */
const forcedRules = (css: string): [string[], string][] => {
  const at = css.indexOf("@media (forced-colors: active) {");
  if (at < 0) return [];
  const open = css.indexOf("{", at);
  let depth = 0, end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) { end = i; break; }
  }
  const body = css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
  return [...body.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(m => [selectors(m[1]), m[2]] as [string[], string]);
};
/** Every declaration the forced-colours block gives `selector`. */
const forced = (css: string, selector: string) => forcedRules(css).filter(([s]) => s.includes(selector)).map(([, d]) => d).join(" ");

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

describe("the keyboard focus ring", () => {
  /** `--focus-ring` as the default appearance and Increase Contrast set it, with the accent each uses. */
  const contrastBlock = /@media \(prefers-contrast: more\) \{\s*:root \{([^}]*)\}/.exec(shared)![1];
  const modes = [
    { mode: "default", ring: token("focus-ring"), accent: token("accent") },
    { mode: "increase contrast", ring: /--focus-ring: ([^;]+);/.exec(contrastBlock)![1].trim(), accent: /--accent: ([^;]+);/.exec(contrastBlock)![1].trim() },
  ];
  /** A colour the ring names: a token, or the accent mixed toward transparent (as rgba). */
  const colour = (c: string, accent: string) => {
    const mix = /^color-mix\(in srgb, var\(--accent\) (\d+)%, transparent\)$/.exec(c);
    if (mix) return `rgba(${solid(accent).join(", ")}, ${Number(mix[1]) / 100})`;
    const v = /^var\(--([\w-]+)\)$/.exec(c);
    return v ? (v[1] === "accent" ? accent : token(v[1])) : c;
  };
  /** The ring's shadows, inside out: [spread px, colour]. */
  const layers = (ring: string, accent: string) => selectors(ring).map(l => {
    const m = /^0 0 0 (\d+)px (.+)$/.exec(l.trim())!;
    return [Number(m[1]), colour(m[2], accent)] as const;
  });

  it("is set off from a filled control by a gap of the window's colour, so focus on an accent button shows as a ring (review #244)", () => {
    for (const { mode, ring, accent } of modes) {
      const ls = layers(ring, accent);
      expect(ls.length, mode).toBe(2);
      const [[gap, gapColour], [outer, ringColour]] = ls;
      expect(gapColour, mode).toBe(token("surface-0"));
      expect(gap, mode).toBeGreaterThanOrEqual(2);
      expect(outer - gap, mode).toBeGreaterThanOrEqual(2);
      // The gap against the accent fill it rings, and the ring against the gap and each surface (WCAG 1.4.11: 3:1).
      expect(contrast(solid(gapColour), solid(accent)), mode).toBeGreaterThanOrEqual(3);
      for (const bg of ["surface-0", "surface-1", "surface-2", "glass-solid"].map(token)) {
        expect(contrast(over(ringColour, bg), solid(bg)), `${mode} on ${bg}`).toBeGreaterThanOrEqual(3);
        expect(contrast(over(ringColour, bg), solid(gapColour)), `${mode} against its gap`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("is the same ring in the bubble when it runs without ember.css", () => {
    const fallbacks = [...BUBBLE_CSS.matchAll(/var\(--focus-ring, ([^;]+)\);/g)].map(m => m[1].replace(/\)$/, ""));
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const f of fallbacks) expect(layers(f, token("accent")).map(([px]) => px)).toEqual(layers(token("focus-ring"), token("accent")).map(([px]) => px));
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

describe("Windows contrast themes (forced colours)", () => {
  const css = (page: string) => page === "shared" ? shared : page === "bubble" ? BUBBLE_CSS : read(`app/renderer/${page}/styles.css`);

  it("gives every window's controls and groups a real edge, as the system drops the shadows that draw them (WCAG 1.4.11; review #44, #151, #242, #267, #129)", () => {
    const edged: [string, string][] = [
      ["shared", ".btn"], ["home", ".card"], ["home", ".start"], ["home", ".models select"], ["home", ".add-row input"], ["home", ".group"],
      ["overlay", ".task-actions button"], ["overlay", ".where"], ["bubble", ".eb-actions button"], ["handle", ".actions button"],
      ["handle", ".task-actions button"], ["handle", ".target"], ["command", ".tab"], ["command", ".command"], ["command", ".card"],
      ["prompt", ".form input"], ["desk", "button"], ["command", ".tab-where"], ["home", ".jump-badge"],
    ];
    for (const [page, sel] of edged) expect(forced(css(page), sel), `${page}: ${sel}`).toMatch(/(border|outline): 1px solid (ButtonText|CanvasText)/);
    // Switches and checkboxes keep their geometry: drawn as they are, their edge token a system colour.
    expect(forced(shared, 'input[type="checkbox"]')).toContain("forced-color-adjust: none");
    expect(forced(shared, ":root")).toContain("--control-edge: ButtonText;");
    expect(forced(shared, 'input[type="checkbox"][role="switch"]::before')).toContain("background: ButtonText;");
    // The slider: a track and a thumb in system colours.
    expect(forced(css("home"), '.pick-row input[type="range"]::-webkit-slider-runnable-track')).toMatch(/Highlight .*CanvasText/);
    expect(forced(css("home"), '.pick-row input[type="range"]::-webkit-slider-thumb')).toContain("background: ButtonText;");
    // Pop-ups: the system's own chevron, and not the painted one too (an image the system keeps).
    expect(forced(css("home"), ".models select")).toMatch(/appearance: auto;.*background-image: none;/);
  });

  it("shows keyboard focus as a real outline in every window, the bubble included (WCAG 2.4.7; review #44, #151, #267)", () => {
    const ring = forcedRules(shared).find(([s]) => s.some(x => x.startsWith(":focus-visible")));
    expect(ring?.[1]).toMatch(/outline: 2px solid Highlight !important; outline-offset: 2px;/);
    expect(forced(shared, ":root")).toContain("--focus-ring: 0 0 0 0 transparent;");
    // The bubble also runs without ember.css (the character lab).
    expect(forced(BUBBLE_CSS, ".eb-actions button:focus-visible")).toContain("outline: 2px solid Highlight;");
    // The terminal's own input is hidden: the terminal shows that it has the keyboard.
    expect(forced(css("command"), ".term:focus-within")).toContain("outline: 2px solid Highlight;");
  });

  it("keeps every state symbol and status dot painted, in a system colour (WCAG 1.4.1; review #242, #129)", () => {
    const root = forced(shared, ":root");
    for (const t of ["accent", "green", "red", "yellow", "purple", "blue", "gray"]) expect(root, t).toMatch(new RegExp(`--${t}: (Highlight|CanvasText|GrayText);`));
    expect(forced(BUBBLE_CSS, ".ember-bubble[data-mood]")).toContain("--eb-mood: CanvasText;");
  });

  it("marks what is chosen by more than colour: the character, the selected tab and the section you are in (review #44, #151, #267)", () => {
    expect(forced(css("home"), '.card[aria-checked="true"]')).toMatch(/border: 3px solid Highlight/);
    expect(forced(css("command"), '.tab[aria-selected="true"]')).toMatch(/background: Highlight;/);
    expect(forced(css("home"), '.jump a[aria-current="true"]')).toMatch(/outline: 1px solid LinkText/);
  });

  it("draws a control filled with the highlight as it is, so the system's text backplate can't hide its words", () => {
    for (const page of ["shared", "bubble", ...PAGES]) {
      for (const [sel, decls] of forcedRules(css(page))) {
        if (/(^|; |\s)color: HighlightText/.test(decls)) expect(decls, `${page}: ${sel.join(", ")}`).toContain("forced-color-adjust: none");
      }
    }
    // Filled through the accent token: the prominent buttons of each window.
    for (const [page, sel] of [["shared", ".btn:not(.quiet)"], ["home", ".start"], ["handle", ".actions button.primary"], ["desk", "body.control #control"], ["bubble", ".eb-actions button.eb-primary"]]) {
      expect(forced(css(page), sel), `${page}: ${sel}`).toContain("forced-color-adjust: none");
    }
  });
});
