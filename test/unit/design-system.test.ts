/** The shared design system (app/renderer/shared/ember.css): what every window keeps to. */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { BUBBLE_CSS } from "@ember/bubble";

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
const shared = read("app/renderer/shared/ember.css");
/** Views' own sheet (app/renderer/shared/view.css), linked by every page that shows views. */
const viewCss = read("app/renderer/shared/view.css");
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
  // Every forced-colours block in the sheet (a page may keep one beside each part, as Home does for first run).
  const rules: [string[], string][] = [];
  for (let at = css.indexOf("@media (forced-colors: active) {"); at >= 0; at = css.indexOf("@media (forced-colors: active) {", at + 1)) {
    const open = css.indexOf("{", at);
    let depth = 0, end = open;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) { end = i; break; }
    }
    const body = css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
    rules.push(...[...body.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(m => [selectors(m[1]), m[2]] as [string[], string]));
  }
  return rules;
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
    const sources = [shared, viewCss, BUBBLE_CSS, ...PAGES.map(p => read(`app/renderer/${p}/styles.css`))];
    // A capsule's half grows with the text size too, as the field it rounds does (the ask box's: review #57).
    const ok = /^(var\(--r-[a-z]+(, \d+px)?\)( var\(--r-[a-z]+\))*|calc\(var\(--r-[a-z]+\) \+ \d+px\)|calc\(\(var\(--r-[a-z]+\) \+ \d+px\) \* var\(--text-scale\)\)|50%|0|inherit|1px)$/;
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
    for (const css of [BUBBLE_CSS, shared, viewCss, ...PAGES.map(p => read(`app/renderer/${p}/styles.css`))]) {
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
      // The overlay has endless pulses (the handle's steady microphone halo has none left).
      if (p === "overlay") expect(endless.length, p).toBeGreaterThan(0);
      for (const sel of endless) {
        const el = sel.split(",").pop()!.trim().replace(/\[data-state="active"\]/, "");
        expect(css, `${p}: ${sel}`).toMatch(new RegExp(`html\\.calm [^{]*${el.replace(/[.[\]()*:"=]/g, "\\$&").replace(/^\\\./, "\\.")}`));
      }
    }
    expect(shared).toMatch(/html\.calm \*, html\.calm \*::before, html\.calm \*::after \{[^}]*animation: none !important/);
  });

  it("lists every keyframe, and lets only small opacity pulses run forever (the HUD's lock-on, ring glow and done are finite)", () => {
    const sheets = [BUBBLE_CSS, shared, viewCss, ...PAGES.map(p => read(`app/renderer/${p}/styles.css`))];
    const names = sheets.flatMap(css => [...css.matchAll(/@keyframes ([\w-]+)/g)].map(m => m[1])).sort();
    expect(names).toEqual(["dot-fill", "eb-blink", "eb-glow", "eb-lock", "eb-pulse", "focus-glow", "pulse", "ring-done", "ring-glow", "ring-pulse", "tick-pop"]);
    const endless = sheets.flatMap(css => [...css.matchAll(/animation: ([\w-]+) [^;]*infinite/g)].map(m => m[1])).sort();
    // The handle's microphone halo holds steady while it hears you (R6): a pulse on silence read as a meter.
    expect(endless).toEqual(["eb-blink", "eb-pulse", "focus-glow", "pulse", "ring-pulse"]);
    const overlay = read("app/renderer/overlay/styles.css");
    for (const [name, css] of [["eb-lock", BUBBLE_CSS], ["ring-glow", overlay], ["ring-done", overlay], ["dot-fill", overlay], ["tick-pop", overlay]] as const) {
      expect(css, name).toMatch(new RegExp(`animation: ${name} [^;]* [1-3]( forwards)?;`));
    }
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

  it("draws any cover spread across the window as it is, in the window's colour, so nothing shows round it", () => {
    // What covers the window round a sticky part is a shadow spread across it (a shadow, so the window never scrolls
    // sideways), and the system drops every shadow: each such cover is drawn as it is there, in the window's colour.
    const covers: [string, string][] = [];
    for (const page of PAGES) {
      const plain = css(page).replace(/\/\*[\s\S]*?\*\//g, "");
      const inForced = new Set(forcedRules(plain).map(([s, d]) => `${s.join(", ")}{${d}`));
      for (const m of plain.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const sel = m[1].trim().replace(/^@media \(forced-colors: active\) \{\s*/, "");
        if (inForced.has(`${selectors(sel).join(", ")}{${m[2]}`) || !/box-shadow:[^;]*\d+vmax/.test(m[2])) continue;
        covers.push(...selectors(sel).map(s => [page, s] as [string, string]));
      }
    }
    for (const [page, sel] of covers) {
      const d = forced(css(page), sel);
      expect(d, `${page}: ${sel}`).toContain("forced-color-adjust: none");
      expect(d, `${page}: ${sel}`).toMatch(/box-shadow: [^;]*\d+vmax Canvas[;,]/);
    }
  });

  it("keeps first run's step indicator, groups and marks apart in system colours (UI audit #7)", () => {
    const home = css("home");
    // The step you are on and those before it in the highlight, those to come in grey text: shape and colour, not tint.
    expect(forced(home, ".w-arc i")).toContain("forced-color-adjust: none");
    expect(forced(home, ".w-arc i")).toContain("background: GrayText;");
    expect(forced(home, ".w-arc i.on")).toContain("background: Highlight;");
    for (const sel of [".w-checks", ".w-tries", ".w-card", ".w-code"]) expect(forced(home, sel), sel).toMatch(/outline: 1px solid CanvasText/);
    for (const sel of [".w-status::before", ".w-sym", ".w-tick::after", ".w-state::before"]) expect(forced(home, sel), sel).toContain("background: CanvasText;");
    expect(forced(home, ".w-tick")).toContain("border: 1.5px solid CanvasText;");
  });
});

describe("Liquid Glass on the floating layer (see-through, measured over a white page)", () => {
  const WHITE = "#ffffff";
  const alpha = (name: string) => Number(token(name));
  /** The regular glass's lightest stop (its top) at --glass-a, with the sheen at its brightest inside the body. */
  const regular = (bg = WHITE) => {
    const m = /--glass-fill: linear-gradient\(180deg, rgba\((\d+), (\d+), (\d+), var\(--glass-a\)\)/.exec(shared)!;
    const body = over(`rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha("glass-a")})`, bg);
    // The sheen peaks above the top edge: where the first line of text starts (12 px in) it is at most 0.03 (a 300 px
    // card; 0.022 on a 130 px bubble, 0.009 on the status line).
    return over("rgba(255, 255, 255, 0.03)", `rgba(${body.map(Math.round).join(", ")}, 1)`);
  };
  /** The clear glass's plate (behind words) over `bg`. */
  const plate = (bg = WHITE) => {
    const m = /rgba\((\d+), (\d+), (\d+), var\(--glass-plate-a\)\)/.exec(shared)!;
    return over(`rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha("glass-plate-a")})`, bg);
  };
  const hex = (c: RGB) => `rgba(${c.map(Math.round).join(", ")}, 1)`;

  it("lets the screen show through: regular glass at 0.88, clear at 0.55, never mixed (Apple's regular and clear)", () => {
    expect(alpha("glass-a")).toBe(0.88);
    expect(alpha("glass-clear-a")).toBe(0.55);
    // Words never sit on less than 0.82 (the localised plate).
    expect(alpha("glass-plate-a")).toBeGreaterThanOrEqual(0.82);
    // The body is painted once (in the padding box): painted twice, 0.88 became 0.99 and nothing showed through.
    expect(token("glass")).toBe("var(--glass-sheen) padding-box, var(--glass-fill) padding-box, var(--glass-edge) border-box, var(--glass-under) border-box");
    expect(token("glass-under")).toBe("linear-gradient(transparent, transparent)");
  });

  it("keeps every label on glass readable with a white page behind it (WCAG 1.4.3: 4.5:1)", () => {
    for (const [surface, g] of [["regular", regular()], ["the handle's plate", plate()]] as const) {
      for (const label of ["label", "glass-label-2", "glass-label-3"]) expect(contrast(over(token(label), hex(g)), g), `${label} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      for (const c of ["accent", "green", "yellow", "green-text", "red-text", "purple-text", "accent-2"]) expect(contrast(solid(token(c)), g), `${c} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      for (const c of ["red", "blue", "purple", "gray"]) expect(contrast(solid(token(c)), g), `${c} on ${surface}`).toBeGreaterThanOrEqual(3);
      // "Without asking" (#127) and "Working": words in Ember's warmer light on the accent's tint.
      const auto = over(`rgba(${solid(token("accent")).join(", ")}, 0.16)`, hex(g));
      expect(contrast(solid(token("accent-2")), auto), `the "Without asking" tag on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(BUBBLE_CSS).toContain('.ember-bubble[data-mood="acting"] { --eb-chip-text: var(--accent-2, #ffb340); }');
      // A tag: its tint at 16 % behind its word.
      for (const [text, tint] of [["green-text", "green"], ["red-text", "red"], ["purple-text", "purple"]]) {
        const tag = over(`rgba(${solid(token(tint)).join(", ")}, 0.16)`, hex(g));
        expect(contrast(solid(token(text)), tag), `${text} on its tint on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  /** The Glass setting's Clear: its own tokens, and its body (an even tint, the sheen included) over `bg`. */
  const clearRule = () => /:root:where\(\[data-glass="clear"\]\) \{([^}]*)\}/.exec(shared)![1];
  const clearToken = (name: string) => new RegExp(`--${name}: ([^;]+);`).exec(clearRule())?.[1].trim() ?? token(name);
  const clearGlass = (bg = WHITE) => {
    const m = /--glass-fill: linear-gradient\(180deg, rgba\((\d+), (\d+), (\d+), var\(--glass-a\)\)/.exec(shared)!;
    const body = over(`rgba(${m[1]}, ${m[2]}, ${m[3]}, ${Number(clearToken("glass-a"))})`, bg);
    return over("rgba(255, 255, 255, 0.03)", hex(body));
  };

  it("makes Clear an even smoky tint, the same everywhere, with no plates or halos behind the words (the Glass setting)", () => {
    const a = Number(clearToken("glass-a"));
    expect(a).toBeGreaterThan(0.55);
    expect(a).toBeLessThan(alpha("glass-a"));
    // Even: the handle's face end and the words' density are the same tint.
    expect(clearToken("glass-clear-a")).toBe(String(a));
    expect(clearToken("glass-plate-a")).toBe(String(a));
    for (const css of [shared, BUBBLE_CSS, ...["overlay", "handle", "ask"].map(p => read(`app/renderer/${p}/styles.css`))]) {
      expect(css).not.toMatch(/--glass-plate:|text-shadow:/);
    }
  });

  it("keeps every label, word colour, mark and control edge on Clear readable with a white page behind it (WCAG 1.4.3, 1.4.11)", () => {
    const g = clearGlass();
    for (const label of ["label", "glass-label-2", "glass-label-3", "accent-text-on-glass"]) {
      expect(contrast(over(clearToken(label), hex(g)), g), label).toBeGreaterThanOrEqual(4.5);
    }
    // Marks (state symbols, a tag's dot, the ring): 3:1, in Clear's light tints.
    for (const c of ["accent-2", "green", "red", "purple", "blue", "gray", "yellow", "accent-text-on-glass"]) expect(contrast(solid(clearToken(c)), g), c).toBeGreaterThanOrEqual(3);
    expect(contrast(over(clearToken("control-edge"), hex(g)), g)).toBeGreaterThanOrEqual(3);
    // Stop's label on its red tint.
    const fill = /html\[data-glass="clear"\] \.task-actions button\.stop \{ background: (rgba\([^)]*\)); \}/.exec(read("app/renderer/overlay/styles.css"))![1];
    const stop = over(fill, hex(g));
    expect(contrast(solid(token("label")), stop)).toBeGreaterThanOrEqual(4.5);
    // The tags' words take the label's colour there (the state's colours fall under 4.5:1); their dots keep the colour.
    expect(BUBBLE_CSS).toContain('html[data-glass="clear"] .ember-bubble .eb-chip, html[data-glass="clear"] .ember-bubble .eb-risk, html[data-glass="clear"] .ember-bubble .eb-auto { color: var(--label, #f5f2ef); }');
    // ("Without asking" in the label's colour on its accent tint, there.)
    // The tags' tints darken a little on Clear; each word in the label's colour passes on every tint.
    for (const tint of ["accent", "accent-2", "yellow", "purple", "red", "green"]) {
      const tag = over("rgba(0, 0, 0, 0.2)", hex(over(`rgba(${solid(clearToken(tint)).join(", ")}, 0.16)`, hex(g))));
      expect(contrast(solid(token("label")), tag), tint).toBeGreaterThanOrEqual(4.5);
    }
    expect(BUBBLE_CSS).toContain('html[data-glass="clear"] .ember-bubble :is(.eb-chip, .eb-risk, .eb-auto) { background-image: linear-gradient(rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.2)); }');
    expect(BUBBLE_CSS).toMatch(/\.eb-auto \{[^}]*color: var\(--accent-2, #ffb340\);/);
    // Ember's accent as words and marks on glass goes through the token.
    expect(read("app/renderer/overlay/styles.css")).toContain(".task[data-cursor] .hand { color: var(--accent-text-on-glass);");
    expect(shared).toContain("[data-status] { --sym-tint: var(--accent-text-on-glass, var(--accent));");
    expect(token("accent-text-on-glass")).toBe("var(--accent)");
    // And a system colour in contrast themes, as every word colour is.
    expect(forced(shared, ":root")).toContain("--accent-text-on-glass: CanvasText;");
    // The Ask box's note of a cut paste takes the label's colour on Clear.
    expect(read("app/renderer/ask/styles.css")).toContain('html[data-glass="clear"] .cut { color: var(--label); }');
  });

  it("keeps a view's words and marks readable on a card's glass, Regular and Clear, with a white page behind (views v2)", () => {
    // view.css: each tone's ink (its words) and mark, on the view's faint tile, a badge's tint (16 %) and a callout's (10 %).
    const TONES: [string, string][] = [["gray", "glass-label-2"], ["blue", "label"], ["green", "green-text"], ["yellow", "yellow"], ["red", "red-text"], ["purple", "purple-text"]];
    expect(viewCss).toContain("--vw-fill: color-mix(in srgb, var(--fill) 55%, transparent);");
    expect(viewCss).toContain('html[data-glass="clear"] :is(.vw-badge, .vw-callout) { background-image: linear-gradient(rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.2)); }');
    for (const [glass, g, tok] of [["regular", regular(), token], ["clear", clearGlass(), clearToken]] as const) {
      const fill = parse(tok("fill"));
      const tile = over(`rgba(${fill.rgb.join(", ")}, ${fill.a * 0.55})`, hex(g));
      for (const [tone, ink] of TONES) {
        const inkC = (bg: RGB) => contrast(over(tok(ink), hex(bg)), bg);
        // (On Clear the tints darken by 0.2 black under their words.)
        const tint = (a: number) => { const t = over(`rgba(${solid(tok(tone)).join(", ")}, ${a})`, hex(g)); return glass === "clear" ? over("rgba(0, 0, 0, 0.2)", hex(t)) : t; };
        const badge = tint(0.16), callout = tint(0.1);
        for (const [where, bg] of [["glass", g], ["tile", tile], ["badge", badge], ["callout", callout]] as const) expect(inkC(bg), `${tone} words on ${where} (${glass})`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(solid(tok(tone)), g), `${tone} mark (${glass})`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("lets Increase Contrast, Reduce Transparency and Calm win over Clear (they always make it solid)", () => {
    // :root:where(…) has :root's weight, so the media blocks after it win; html.calm outweighs it.
    expect(shared.indexOf(':root:where([data-glass="clear"])')).toBeLessThan(shared.indexOf("@media (prefers-contrast: more)"));
    expect(shared.indexOf(':root:where([data-glass="clear"])')).toBeLessThan(shared.indexOf("@media (prefers-reduced-transparency: reduce)"));
    expect(/:root:where\(\[data-glass="solid"\]\) \{([^}]*)\}/.exec(shared)![1]).toContain("--glass-a: 1;");
  });

  it("keeps control edges on glass at 3:1 over a white page (WCAG 1.4.11)", () => {
    for (const g of [regular(), plate()]) expect(contrast(over(token("control-edge"), hex(g)), g)).toBeGreaterThanOrEqual(3);
  });

  it("keeps the page's own text behind the glass faint, so it never competes with Ember's words (≤ 1.5:1)", () => {
    // Black text on the white page, seen through the glass, against the white around it.
    expect(contrast(regular("#000000"), regular())).toBeLessThanOrEqual(1.5);
  });

  it("uses the glass labels on every floating page and in the bubble, never the dimmer window labels", () => {
    for (const p of ["overlay", "handle", "ask"]) expect(read(`app/renderer/${p}/styles.css`), p).toContain(":root { --label-2: var(--glass-label-2); --label-3: var(--glass-label-3); }");
    expect(BUBBLE_CSS).toContain("--label-2: var(--glass-label-2, rgba(245, 240, 236, 0.74));");
    expect(BUBBLE_CSS).toContain("--label-3: var(--glass-label-3, rgba(245, 240, 236, 0.66));");
  });

  it("turns solid under Reduce Transparency and Calm, and solid with a light border under Increase Contrast (Apple's glass settings)", () => {
    const rt = /@media \(prefers-reduced-transparency: reduce\) \{\s*:root \{([^}]*)\}/.exec(shared)![1];
    const calm = /html\.calm \{([^}]*)\}/.exec(shared)![1];
    const ic = /@media \(prefers-contrast: more\) \{\s*:root \{([^}]*)\}/.exec(shared)![1];
    for (const block of [rt, calm, ic]) {
      for (const a of ["glass-a", "glass-clear-a", "glass-plate-a"]) expect(block, a).toContain(`--${a}: 1;`);
      expect(block).toMatch(/--glass-under: linear-gradient\((#\w+|var\(--glass-solid\)), \1\);/);
    }
    expect(ic).toContain("--glass-edge: linear-gradient(rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.5));");
  });

  it("gives every system colour and Ember's lights an Increase Contrast value (Apple's increased-contrast palette)", () => {
    const ic = /@media \(prefers-contrast: more\) \{\s*:root \{([^}]*)\}/.exec(shared)![1];
    for (const [t, v] of [["yellow", "#fedf43"], ["blue", "#5cb8ff"], ["gray", "#aeaeb2"], ["accent", "#ffa056"], ["red", "#ff6165"], ["green", "#4ad968"], ["purple", "#ea8dff"]]) expect(ic, t).toContain(`--${t}: ${v};`);
    for (const t of ["accent-2", "glow"]) expect(ic, t).toMatch(new RegExp(`--${t}: #[0-9a-f]{6};`));
  });

  it("draws hairlines of one device pixel, not 0.5 px smeared over two at 125 % and 150 %", () => {
    // The bubble's every shadow, its thinking and listening bloom too, takes the glass's edges and hairline.
    for (const [, shadow] of BUBBLE_CSS.matchAll(/\.ember-bubble[^{]*\{[^}]*?box-shadow: ([^;]+);/g)) {
      if (/0 0 0 0\.5px/.test(shadow)) expect(shadow.startsWith("var(--glass-spec, ") && shadow.includes("var(--glass-hairline, "), shadow).toBe(true);
    }
    expect(BUBBLE_CSS).not.toMatch(/box-shadow: inset 0 1px 0 rgba\(255, 255, 255, 0\.08\), 0 0 0 0\.5px/);
    expect(token("glass-hairline")).toBe("0 0 0 var(--dpx, 0.5px) rgba(0, 0, 0, 0.6)");
    expect(token("glass-depth")).toMatch(/^var\(--glass-hairline\),/);
    for (const p of ["overlay", "handle", "ask"]) expect(read(`app/renderer/${p}/styles.css`), p).not.toMatch(/0 0 0 0\.5px/);
    for (const p of ["overlay", "handle", "ask"]) expect(read(`app/renderer/${p}/main.ts`), p).toMatch(/watchPixels\(/);
  });

  it("nests corners concentrically: the bubble's whole-text panel is its 18 px corner less its 14 px padding, at least 6 px", () => {
    expect(/\.eb-whole \{[^}]*border-radius: ([^;]+);/.exec(BUBBLE_CSS)![1]).toBe("var(--r-xs, 6px)");
  });
});

describe("the motion system (docs/DESIGN.md \"Motion\")", () => {
  const ms = (t: string) => Number(/^(\d+)ms$/.exec(token(t))![1]);

  it("has Apple's three springs and the durations, each paired curve ending at rest", () => {
    for (const s of ["spring-smooth-0", "spring-brisk", "spring-reward", "spring-snappy", "spring-smooth", "spring-bouncy"]) expect(token(s), s).toMatch(/^linear\(0, .*, 1\)$/);
    // Bounce: none for smooth, a little for brisk, a reward's 0.3 at most (it overshoots under 5 %).
    const peak = (s: string) => Math.max(...[...token(s).matchAll(/(?:^linear\(|, )([\d.]+)/g)].map(m => Number(m[1])));
    expect(peak("spring-smooth-0")).toBe(1);
    expect(peak("spring-brisk")).toBeLessThan(1.01);
    expect(peak("spring-reward")).toBeLessThan(1.05);
    expect(ms("t-fade-out")).toBeLessThan(ms("t-fade-in"));
    expect(ms("t-press")).toBeLessThan(ms("t-fast"));
    expect(ms("t-fast")).toBeLessThan(ms("t-move"));
    expect(ms("t-move")).toBeLessThan(ms("t-glide"));
  });

  it("keeps one fade in Calm, opacity only and no longer than 150 ms (R1)", () => {
    expect(ms("t-calm-fade")).toBeLessThanOrEqual(150);
    const rules = [...shared.matchAll(/\.calm-fade \{([^}]*)\}/g), ...BUBBLE_CSS.matchAll(/html\.calm \.ember-bubble \{([^}]*)\}/g)].map(m => m[1]);
    expect(rules.length).toBeGreaterThanOrEqual(3);
    for (const r of rules) {
      const list = /transition: ([^;]+?) !important;/.exec(r)![1];
      for (const part of selectors(list)) expect(part, r).toMatch(/^(opacity|visibility|display) var\(--t-calm-fade(, 150ms)?\)( ease| allow-discrete)?$/);
      expect(r).toMatch(/translate: none !important;/);
      expect(r).toMatch(/scale: none !important;/);
    }
    // The surfaces that come and go carry it.
    expect(read("app/renderer/overlay/index.html")).toContain('class="status calm-fade"');
    expect(read("app/renderer/ask/index.html")).toContain('class="ask grow calm-fade"');
    expect(read("app/renderer/overlay/main.ts")).toContain('li.className = "task calm-fade";');
  });

  it("grows the bubble out of Ember, but brings a question in by its opacity alone (nothing near a decision moves)", () => {
    expect(BUBBLE_CSS).toMatch(/\.ember-bubble\[data-hidden="true"\] \{[^}]*scale: 0\.96;/);
    expect(BUBBLE_CSS).toMatch(/transition: [^;]*scale var\(--t-move, 420ms\) var\(--spring-brisk, ease-out\);/);
    expect(BUBBLE_CSS).toContain('.ember-bubble[data-mood="attention"], .ember-bubble[data-mood="attention"][data-hidden="true"] { translate: none; scale: none; }');
    // A card waiting for you doesn't fill its plan's dot; a question's dot never pulses.
    expect(read("app/renderer/overlay/styles.css")).toContain('.task:not([data-status="waiting"]) .plan li[data-state="now"]::before { animation: dot-fill');
    expect(BUBBLE_CSS).toMatch(/:not\(\[data-mood="attention"\]\) \.eb-dot \{\s*animation: eb-pulse/);
  });
});

describe("views (app/renderer/shared/view.css)", () => {
  const plain = viewCss.replace(/\/\*[\s\S]*?\*\//g, "");

  it("are linked after the design system and before the page's own styles, wherever views are drawn", () => {
    const html = read("app/renderer/overlay/index.html");
    const at = html.indexOf('href="../shared/view.css"');
    expect(at).toBeGreaterThan(html.indexOf('href="../shared/ember.css"'));
    expect(at).toBeLessThan(html.indexOf('href="styles.css"'));
  });

  it("never take Ember's accent, its glass, a blur or its status symbols: a view is the task's, read-only", () => {
    expect(plain).not.toMatch(/--accent|--glow|--glass|backdrop-filter|--sym-(working|waiting|queued|done|failed|stopped)|--r-capsule/);
  });

  it("don't move: no animation, and the one transition is the fade of a replaced node, which Calm stops", () => {
    expect(plain).not.toMatch(/animation|@keyframes/);
    const transitions = [...plain.matchAll(/([^{}]+)\{[^}]*transition: ([^;]+);/g)].map(m => [m[1].trim(), m[2]]);
    expect(transitions.map(([, v]) => v)).toEqual(["opacity 120ms ease", "none"]);
    for (const [sel] of transitions) expect(sel).toMatch(/\.vw-fresh$|prefers-reduced-motion/);
    expect(shared).toMatch(/html\.calm \*, html\.calm \*::before, html\.calm \*::after \{[^}]*transition-duration: 0s !important/);
  });

  it("keep every group and mark visible in forced colours, the tones as the text colour (WCAG 1.4.1, 1.4.11)", () => {
    expect(forced(viewCss, ".vw [data-tone]")).toContain("--vw-tone: CanvasText;");
    for (const sel of [".vw-card", ".vw-metric", ".vw-callout", ".vw-badge"]) expect(forced(viewCss, sel), sel).toMatch(/border: 1px solid CanvasText/);
    expect(forced(viewCss, ".vw-sym")).toContain("background: CanvasText;");
    expect(forced(viewCss, ".vw-fill")).toContain("fill: Highlight;");
  });

  it("tell a chart's series apart by a dash as well as a tone (never colour alone)", () => {
    expect(viewCss).toContain('[data-series="1"].vw-line { stroke-dasharray: 5 3; }');
    expect(viewCss).toContain('[data-series="2"].vw-line { stroke-dasharray: 1.5 3; }');
  });
});

describe("HIG pass (Apple's Human Interface Guidelines, checked surface by surface)", () => {
  const page = (p: string) => read(`app/renderer/${p}/styles.css`);

  it("gives every floating glass surface the window's colour in contrast themes, as the bubble has (its gradients are dropped)", () => {
    expect(forced(page("overlay"), ".task")).toContain("background: Canvas;");
    expect(forced(page("overlay"), ".status")).toContain("background: Canvas;");
    expect(forced(page("handle"), ".handle")).toContain("background: Canvas;");
    for (const sel of ["textarea", ".meta", ".cut", ".tip"]) expect(forced(page("ask"), sel), sel).toContain("background: Canvas;");
    expect(forced(BUBBLE_CSS, ".ember-bubble")).toContain("background: Canvas;");
    // A view's coloured timeline rule is a shadow, which the system drops: a real border instead.
    expect(forced(viewCss, ".vw-timeline li[data-tone] .vw-what")).toContain("border-left: 2px solid CanvasText;");
  });

  it("keeps line heights on whole pixels at every text size, in every window but the Ask box (which main sizes exactly)", () => {
    for (const p of ["home", "overlay", "handle", "desk", "command", "prompt"]) expect(page(p), p).not.toMatch(/line-height: calc\(/);
  });

  it("puts a tone's words in the label on Clear glass, where no state colour is both a colour and 4.5:1, and its mark in the colour", () => {
    expect(viewCss).toContain('html[data-glass="clear"]:not(.calm) .vw [data-tone]:not([data-tone="neutral"]) { --vw-ink: var(--label); }');
    expect(viewCss).toContain('html[data-glass="clear"]:not(.calm) .vw-delta[data-good="false"] .vw-sym { background: var(--red); }');
    // Only while the glass is see-through: Increase Contrast and Reduce Transparency make it solid, where the inks pass.
    expect(viewCss).toContain("@media (prefers-contrast: no-preference) and (prefers-reduced-transparency: no-preference) {");
  });

  /**
   * A small cascade over a stylesheet, enough to say which declaration wins for one element: top-level rules and those in
   * `@media (forced-colors: active)` or `@media not (forced-colors: active)` blocks, by whether forced colours are on
   * (other blocks are left out); selectors of type, class, attribute and `:is()` parts with descendant combinators;
   * specificity, then source order.
   */
  type El = { tag: string; classes: string[]; attrs: Record<string, string> };
  const cascade = (css: string, forcedOn: boolean, chain: El[], prop: string): string | undefined => {
    const rules: { selector: string; decls: string; order: number }[] = [];
    const walk = (text: string, active: boolean) => {
      let i = 0;
      while (i < text.length) {
        const open = text.indexOf("{", i);
        if (open < 0) break;
        const prelude = text.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, "").trim();
        let depth = 1, j = open + 1;
        while (depth && j < text.length) { if (text[j] === "{") depth++; else if (text[j] === "}") depth--; j++; }
        const body = text.slice(open + 1, j - 1);
        if (prelude.startsWith("@media")) {
          const q = prelude.slice(6).trim();
          const on = q === "(forced-colors: active)" ? forcedOn : q === "not (forced-colors: active)" ? !forcedOn : false;
          walk(body, active && on);
        } else if (!prelude.startsWith("@") && active) {
          for (const sel of selectors(prelude)) rules.push({ selector: sel, decls: body, order: rules.length });
        }
        i = j;
      }
    };
    walk(css, true);
    const simple = /^([a-z]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|:is\(([^)]*)\)|:([\w-]+)(\([^)]*\))?/g;
    /** Whether a compound matches an element, and its specificity (classes, attributes and pseudo-classes; types). */
    const compound = (c: string, el: El): [boolean, number, number] => {
      let ok = true, b = 0, t = 0;
      for (const m of c.matchAll(simple)) {
        if (m[1]) { t++; ok &&= el.tag === m[1]; }
        else if (m[2]) { b++; ok &&= el.classes.includes(m[2]); }
        else if (m[3]) { b++; ok &&= m[4] === undefined ? m[3] in el.attrs : el.attrs[m[3]] === m[4]; }
        else if (m[5] !== undefined) { const any = m[5].split(",").map(x => compound(x.trim(), el)).find(r => r[0]); b += any ? any[1] : 1; ok &&= !!any; }
        else { b++; ok = false; } // :hover, :focus-visible and the like: not the state checked
      }
      return [ok, b, t];
    };
    const matches = (sel: string): number | null => {
      const parts = sel.replace(/\s*>\s*/g, " ").split(/\s+/).filter(Boolean);
      let at = chain.length - 1, spec = 0;
      for (let k = parts.length - 1; k >= 0; k--) {
        let found = false;
        for (; at >= 0; at--) {
          const [ok, b, t] = compound(parts[k], chain[at]);
          if (ok) { spec += b * 1000 + t; found = true; at--; break; }
          if (k === parts.length - 1) return null;
        }
        if (!found) return null;
      }
      return spec;
    };
    let best: { spec: number; order: number; value: string } | undefined;
    for (const r of rules) {
      const value = new RegExp(`(?:^|;)\\s*${prop}: ([^;]+);`).exec(r.decls)?.[1].trim();
      if (value === undefined) continue;
      const spec = matches(r.selector);
      if (spec === null) continue;
      if (!best || spec > best.spec || (spec === best.spec && r.order > best.order)) best = { spec, order: r.order, value };
    }
    return best?.value;
  };
  const riskyTag = (glass: string): El[] => [
    { tag: "html", classes: [], attrs: { "data-glass": glass } },
    { tag: "div", classes: ["ember-bubble"], attrs: { "data-mood": "attention", "data-risky": "true" } },
    { tag: "div", classes: ["eb-head"], attrs: {} },
    { tag: "span", classes: ["eb-risk"], attrs: {} },
  ];

  it("fills a risky question's tag with the caution colour on Clear, so it stays unmistakably yellow, but never in a contrast theme", () => {
    expect(BUBBLE_CSS).toContain('@media not (forced-colors: active) {\n  html[data-glass="clear"] .ember-bubble .eb-risk { color: var(--on-accent, #1d1204); background: var(--yellow, #fff0a0); }\n}');
    // Clear, no contrast theme: the fill wins over the tags' darkening and the label's colour.
    expect(cascade(BUBBLE_CSS, false, riskyTag("clear"), "background")).toBe("var(--yellow, #fff0a0)");
    expect(cascade(BUBBLE_CSS, false, riskyTag("clear"), "color")).toBe("var(--on-accent, #1d1204)");
    // A contrast theme (review of #135): the tag's words in the text colour on the window's, in every Glass setting,
    // not the highlight's text on a pill of the text colour (both tokens are system colours there: invisible words).
    for (const glass of ["clear", "regular", "solid"]) {
      expect(cascade(BUBBLE_CSS, true, riskyTag(glass), "color"), glass).toBe("CanvasText");
      expect(cascade(BUBBLE_CSS, true, riskyTag(glass), "background"), glass).toBe("Canvas");
    }
    // Regular, no contrast theme: the caution colour as words on its tint, as before.
    expect(cascade(BUBBLE_CSS, false, riskyTag("regular"), "color")).toBe("var(--yellow, #ffd600)");
  });

  it("keeps Home's sidebar selection off when its link is out of a search, and grows the sidebar with the text only as far as the window allows (HIG sidebars)", () => {
    const home = page("home");
    expect(home).toContain(".jump:not(.has-hl) .jump-hl { display: none; }");
    // Larger text widens the sidebar, never below 200 px nor past what leaves a pane its 460 px (it scrolled sideways
    // at 648-700 px with Larger, review of #135); the content starts 28 px past it.
    expect(home).toContain("html[data-text-size] body:not(.first-run) { --sidebar: min(calc(200px * var(--text-scale)), max(200px, calc(100vw - 460px))); }");
    expect(home).toContain("html[data-text-size] body:not(.first-run) .home > .jump { width: var(--sidebar); }");
    expect(home).toContain("html[data-text-size] body:not(.first-run) .home { padding-left: calc(var(--sidebar) + 28px); }");
    const sidebar = (vw: number, scale: number) => Math.min(200 * scale, Math.max(200, vw - 460));
    // Up to 660 px it stays the default 200 px; then it grows a pixel for a pixel, leaving a pane its 460 px, until the
    // text size's own width (measured in real renders at Larger: no pane scrolls sideways at 648, 660, 700 or 720 px).
    for (const vw of [640, 648, 660]) expect(sidebar(vw, 1.3), `${vw} px`).toBe(200);
    for (const vw of [700, 720]) expect(vw - sidebar(vw, 1.3), `${vw} px`).toBe(460);
    expect(sidebar(1100, 1.3)).toBe(260);
    expect(sidebar(1100, 1)).toBe(200);
    expect(read("app/renderer/home/index.html")).toContain('<p class="search-none" id="search-none" aria-hidden="true" hidden></p>');
  });

  it("centres first run's steps in the window's height in a box of one size, so the title stays put from step to step (HIG onboarding)", () => {
    const home = page("home");
    expect(home).toMatch(/body\.first-run \.home \{[^}]*min-height: 100vh;[^}]*justify-content: center;/);
    expect(home).toContain("body.first-run #welcome { min-height: min(560px, calc(100vh - 60px)); }");
  });

  it("rounds an inner corner concentrically: the command card's command at 6 px inside its 14 px card (HIG concentricity)", () => {
    expect(page("command")).toMatch(/\.command \{\n {2}margin: 0; padding: 8px 10px; border-radius: var\(--r-xs\);/);
  });
});
