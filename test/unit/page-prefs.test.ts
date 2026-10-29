/**
 * Calm mode and the text size in every window of Ember's: main applies both to each of its pages as it loads and when
 * the settings change, since the Ask box, the command and prompt windows and the desk view are sent no settings
 * (review #248, #57).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyPagePrefs, pageOf, pagePrefs, prefsScript, rescaledBounds, scaledSize, textScale, type PrefsPage } from "../../app/main/page-prefs";

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
const url = (page: string) => `file:///opt/Ember/resources/app/dist/app/renderer/${page}/index.html`;

/** A page of Ember's: runs the script it is sent against a small document, as the renderer would. */
function fakePage(u: string, opts: { destroyed?: boolean; fails?: boolean } = {}) {
  const classes = new Set<string>();
  const dataset: Record<string, string> = {};
  const document = { documentElement: { classList: { toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c); } }, dataset } };
  const sent: string[] = [];
  const page: PrefsPage = {
    isDestroyed: () => opts.destroyed === true,
    getURL: () => u,
    executeJavaScript: async (code: string) => {
      sent.push(code);
      if (opts.fails) throw new Error("navigated");
      new Function("document", code)(document);
    },
  };
  return { page, classes, dataset, sent };
}

describe("Ember's display settings in every window", () => {
  it("puts Calm mode on the Ask box, the command and prompt windows and the desk view too (review #248)", async () => {
    for (const p of ["ask", "command", "prompt", "desk", "overlay", "handle", "home"]) {
      const f = fakePage(url(p));
      expect(await applyPagePrefs(f.page, pagePrefs({ reduceMotion: true, textSize: "default" })), p).toBe(true);
      expect(f.classes.has("calm"), p).toBe(true);
      await applyPagePrefs(f.page, pagePrefs({ reduceMotion: false, textSize: "default" }));
      expect(f.classes.has("calm"), p).toBe(false);
    }
  });

  it("sets the text size where the window can grow with it, the Ask box's included, and leaves the desk's bar at its own (review #57)", async () => {
    for (const p of ["home", "command", "prompt", "overlay", "handle", "ask"]) {
      const f = fakePage(url(p));
      await applyPagePrefs(f.page, pagePrefs({ reduceMotion: false, textSize: "larger" }));
      expect(f.dataset.textSize, p).toBe("larger");
      await applyPagePrefs(f.page, pagePrefs({ reduceMotion: false, textSize: "default" }));
      expect(f.dataset.textSize, p).toBeUndefined();
    }
    for (const p of ["desk", "mic"]) {
      const f = fakePage(url(p));
      await applyPagePrefs(f.page, pagePrefs({ reduceMotion: false, textSize: "large" }));
      expect(f.dataset.textSize, p).toBeUndefined();
    }
  });

  it("runs only in Ember's own bundled pages, and only code built from a switch and one of three sizes", async () => {
    const web = fakePage("https://example.com/renderer/home/index.html");
    expect(await applyPagePrefs(web.page, pagePrefs({ reduceMotion: true, textSize: "large" }))).toBe(false);
    expect(web.sent).toEqual([]);
    expect(pageOf("file:///C:/Program%20Files/Ember/resources/app/dist/app/renderer/command/index.html")).toBe("command");
    expect(pageOf("about:blank")).toBeNull();
    // Whatever reaches it, only the three words do.
    const odd = pagePrefs({ reduceMotion: true, textSize: "\"); alert(1); (\"" as never });
    expect(odd.textSize).toBe("default");
    expect(prefsScript(odd, "home")).not.toContain("alert");
  });

  it("skips a window that has gone, and a page that went away during the call is no error (it gets them again as it loads)", async () => {
    const gone = fakePage(url("command"), { destroyed: true });
    expect(await applyPagePrefs(gone.page, pagePrefs({ reduceMotion: true, textSize: "default" }))).toBe(false);
    expect(gone.sent).toEqual([]);
    const moving = fakePage(url("command"), { fails: true });
    expect(await applyPagePrefs(moving.page, pagePrefs({ reduceMotion: true, textSize: "default" }))).toBe(false);
  });

  it("is applied by main to each page as it loads and to every window when the settings change", () => {
    const main = read("app/main/main.ts");
    expect(main).toMatch(/contents\.on\("dom-ready", \(\) => void applyPagePrefs\(contents, pagePrefs\(settings\.get\(\)\)\)\)/);
    expect(main).toMatch(/for \(const w of BrowserWindow\.getAllWindows\(\)\) void applyPagePrefs\(w\.webContents, prefs\)/);
  });
});

/**
 * The selectors in `css` that set a font size in px (not through a token or the scale) and have no scaled twin
 * (`html[data-text-size] <selector>` with the same size times var(--text-scale)), the rules inside its media queries
 * included.
 */
function unscaled(css: string): string[] {
  let plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // Media queries (and @supports) unwrapped, nested ones too: their rules are checked like the others.
  for (let m; (m = /@(media|supports)[^{]*\{/.exec(plain)); ) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < plain.length && depth > 0; i++) depth += plain[i] === "{" ? 1 : plain[i] === "}" ? -1 : 0;
    plain = plain.slice(0, m.index) + plain.slice(m.index + m[0].length, i - 1) + plain.slice(i);
  }
  // A selector list split at its own commas, not at those inside :is(…) or :not(…).
  const list = (sel: string) => sel.split(/,(?![^(]*\))/);
  // The rules that set a size in px (not through a token), outside the text-size rules themselves, with that size.
  const px = (d: string) => /(?:font: [\d ]*?|font-size: )(\d+(?:\.\d+)?)px/.exec(d)?.[1];
  const literal = [...plain.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, sel, d]) => px(d) && !sel.includes("data-text-size") && !/^\s*@/.test(sel))
    .flatMap(([, sel, d]) => list(sel.trim().replace(/^.*\}\s*/s, "")).map(s => ({ sel: s.trim(), size: px(d)! })));
  // Their twins: the same selector under html[data-text-size], the same size times the scale.
  const scaled = [...plain.matchAll(/([^{}]+)\{([^}]*var\(--text-scale[^}]*)\}/g)]
    .flatMap(([, sel, d]) => list(sel.trim()).map(s => `${s.trim()} ${/font-size: calc\((\d+(?:\.\d+)?)px \* var\(--text-scale(?:, 1)?\)\)/.exec(d)?.[1]}`));
  return literal.filter(l => !scaled.includes(`html[data-text-size] ${l.sel} ${l.size}`)).map(l => l.sel);
}

/**
 * The selectors in `css` of the controls that hold words (buttons, tabs, pop-up buttons and text fields) whose height or
 * min-height is a px length the text size doesn't scale, the rules inside its media queries included: a control that
 * keeps its height while its words grow is cramped round them, or cuts them. `ids`: the page's own controls by id
 * (controlIds). Switches, check boxes, sliders and pseudo-elements hold no words.
 */
function fixedControlHeights(css: string, ids: string[] = []): string[] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@(media|supports)[^{]*\{/g, "");
  const byId = ids.map(id => `|#${id}(?![\\w-])`).join("");
  const control = new RegExp(`(^|[\\s>+~(])(button|select|textarea)(?![\\w-])|(^|[\\s>+~(])input(?![\\w-])(?!\\[type="(checkbox|radio|range|hidden)"\\])|\\.(btn|tab|start)(?![\\w-])${byId}`);
  return [...plain.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, , d]) => /(^|[;\s])(min-)?height: \d+(\.\d+)?px/.test(d))
    .flatMap(([, sel]) => sel.trim().split(/,(?![^(]*\))/).map(x => x.trim()))
    .filter(sel => !sel.includes("::") && control.test(sel));
}

/**
 * The selectors in `css` whose scroll padding keeps a fixed px length of 24 px or more: room that big is kept clear for
 * a part of the page that holds words (first run's sticky Start row), which grow with the text size and wrap onto more
 * lines in a narrower or zoomed window. Such room is the part's measured height (a var() it falls back from) or scaled
 * by --text-scale. A few px for a focus ring are left.
 */
function fixedClearances(css: string): string[] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@(media|supports)[^{]*\{/g, "");
  return [...plain.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, , d]) => [...d.matchAll(/scroll-padding[\w-]*: ([^;]+)/g)]
      .some(([, v]) => [...v.replace(/\d+(\.\d+)?px \* var\(--text-scale(, 1)?\)/g, "").matchAll(/(\d+(?:\.\d+)?)px/g)].some(([, n]) => Number(n) >= 24)))
    .map(([, sel]) => sel.trim());
}

/** The ids of a page's controls that hold words, from its index.html: buttons, pop-ups, text areas and text fields. */
function controlIds(html: string): string[] {
  return [...html.matchAll(/<(button|select|textarea|input)\b([^>]*)>/g)]
    .filter(([, tag, attrs]) => tag !== "input" || !/\btype="(checkbox|radio|range|hidden)"/.test(attrs))
    .flatMap(([, , attrs]) => /\bid="([\w-]+)"/.exec(attrs)?.[1] ?? []);
}

describe("the text size", () => {
  const shared = read("app/renderer/shared/ember.css");

  it("scales every type token, from a scale the text size sets on the page (review #57)", () => {
    const tokens = [...shared.matchAll(/--type-[\w-]+: ([^;]+);/g)].map(m => m[1]);
    expect(tokens.length).toBe(8);
    for (const t of tokens) expect(t).toMatch(/^\d00 calc\(\d+px \* var\(--text-scale\)\)\/calc\(\d+px \* var\(--text-scale\)\) var\(--ember-font\)$/);
    expect(shared).toMatch(/:root \{[^}]*--text-scale: 1;/);
    expect(shared).toContain('html[data-text-size="large"] { --text-scale: 1.15; }');
    expect(shared).toContain('html[data-text-size="larger"] { --text-scale: 1.3; }');
  });

  it("grows every literal font size too, in each window that scales and in the bubble (review #57)", async () => {
    const { BUBBLE_CSS } = await import("@ember/bubble");
    const sheets: [string, string][] = [
      ["shared", shared], ["bubble", BUBBLE_CSS],
      ...["home", "command", "prompt", "overlay", "handle", "ask"].map(p => [p, read(`app/renderer/${p}/styles.css`)] as [string, string]),
    ];
    for (const [name, css] of sheets) expect(unscaled(css), name).toEqual([]);
  });

  it("grows the height of every control with words with them: card buttons, the bubble's and the task cards', Settings' pop-ups and fields; the same px at the default size", async () => {
    const { BUBBLE_CSS } = await import("@ember/bubble");
    const sheets: [string, string, string[]][] = [
      ["shared", shared, []], ["bubble", BUBBLE_CSS, []],
      ...["home", "command", "prompt", "overlay", "handle", "ask"].map(p => [p, read(`app/renderer/${p}/styles.css`), controlIds(read(`app/renderer/${p}/index.html`))] as [string, string, string[]]),
    ];
    for (const [name, css, ids] of sheets) expect(fixedControlHeights(css, ids), name).toEqual([]);
    // The usual heights are kept at the default size (--text-scale 1): 28 px buttons, 24 px small ones, a 36 px Start,
    // 28 px pop-up buttons and fields in Settings, the password card's 30 px field.
    const rule = (prop: string) => (css: string, sel: string) => new RegExp(`(?:^|\\})\\s*${sel.replace(/[.()[\]]/g, "\\$&")} \\{[^}]*(?:^|[;\\s])${prop}: ([^;]+);`, "m").exec(css)?.[1];
    const minHeight = rule("min-height"), height = rule("height");
    const home = read("app/renderer/home/styles.css");
    expect(minHeight(shared, ".btn")).toBe("calc(28px * var(--text-scale))");
    expect(minHeight(shared, ".btn.small")).toBe("calc(24px * var(--text-scale))");
    expect(minHeight(BUBBLE_CSS, ".eb-actions button")).toBe("calc(28px * var(--text-scale, 1))");
    expect(minHeight(read("app/renderer/overlay/styles.css"), ".task-actions button")).toBe("calc(24px * var(--text-scale))");
    expect(minHeight(read("app/renderer/overlay/styles.css"), ".task-actions button.stop")).toBe("calc(28px * var(--text-scale))");
    expect(minHeight(home, ".start")).toBe("calc(36px * var(--text-scale))");
    expect(height(home, ".models select, .choice select, #text-size")).toBe("calc(28px * var(--text-scale))");
    expect(height(home, ".add-row input")).toBe("calc(28px * var(--text-scale))");
    expect(minHeight(read("app/renderer/prompt/styles.css"), ".form input")).toBe("calc(30px * var(--text-scale))");
    // The guard sees them wherever they are, by element, class or the page's ids, and leaves what holds no words.
    expect(fixedControlHeights(".btn { min-height: 28px; } @media (hover: hover) { .x button { min-height: 20px; } } .tab-where { min-height: 9px; }")).toEqual([".btn", ".x button"]);
    expect(fixedControlHeights(".row { min-height: 48px; } .btn { min-height: calc(28px * var(--text-scale)); }")).toEqual([]);
    expect(fixedControlHeights(".m select, #size { height: 28px; } .add input { height: 28px; } .f textarea { min-height: 40px; }", ["size"]))
      .toEqual([".m select", "#size", ".add input", ".f textarea"]);
    expect(fixedControlHeights('input[type="checkbox"] { height: 20px; } .p input[type="range"] { height: 22px; } .p input[type="range"]::-webkit-slider-thumb { height: 22px; } .tab::before { height: 12px; } #face { height: 46px; } .r { line-height: 20px; max-height: 9px; }', ["size"]))
      .toEqual([]);
    expect(controlIds('<select id="text-size"></select><input id="host-add" type="text"><input type="checkbox" id="agree"><button id="go">Go</button><div id="buddy"></div>'))
      .toEqual(["text-size", "host-add", "go"]);
  });

  it("keeps focus clear of first run's Start row at every text size: no scroll padding is a fixed px length", async () => {
    const { BUBBLE_CSS } = await import("@ember/bubble");
    const sheets: [string, string][] = [
      ["shared", shared], ["bubble", BUBBLE_CSS],
      ...["home", "command", "prompt", "overlay", "handle", "ask"].map(p => [p, read(`app/renderer/${p}/styles.css`)] as [string, string]),
    ];
    for (const [name, css] of sheets) expect(fixedClearances(css), name).toEqual([]);
    // The guard sees a fixed length wherever it is, and leaves a focus ring's few px, a scaled length and a measured one.
    expect(fixedClearances("html:has(> body.x) { scroll-padding-bottom: 150px; } @media (min-width: 9px) { html { scroll-padding: 0 0 40px; } }"))
      .toEqual(["html:has(> body.x)", "html"]);
    expect(fixedClearances("html { scroll-padding-top: 16px; } .a { scroll-padding-bottom: calc(150px * var(--text-scale)); } .b { scroll-padding-bottom: calc(var(--h, 138px * var(--text-scale)) + 12px); } .c { scroll-margin: 120px; }"))
      .toEqual([]);
  });

  it("keeps as many lines in the bubble at every size: its heights are counted in lines, not px (review #57)", async () => {
    const { BUBBLE_CSS } = await import("@ember/bubble");
    const heights = [...BUBBLE_CSS.matchAll(/max-height: ([^;]+);/g)].map(m => m[1]);
    // Six lines of an answer, three while it streams or for commentary, ten for a question, sixteen once opened in full.
    expect(heights.filter(h => /^\d+lh$/.test(h)).sort()).toEqual(["10lh", "16lh", "3lh", "3lh", "6lh"]);
    expect(BUBBLE_CSS).not.toMatch(/max-height: calc\(\d+px \* \d+\)/);
  });

  it("checks the rules inside a media query too, against their scaled twins there", () => {
    expect(unscaled("@media (min-width: 640px) { .jump a { font-size: 15px; } }")).toEqual([".jump a"]);
    expect(unscaled("@media (min-width: 640px) { .a { color: red; } .jump a, .b { font: 600 15px/20px x; } }")).toEqual([".jump a", ".b"]);
    expect(unscaled("@media (min-width: 640px) { .jump a { font-size: 15px; } html[data-text-size] .jump a { font-size: calc(15px * var(--text-scale)); } }")).toEqual([]);
    expect(unscaled("@media (forced-colors: active) { @media (min-width: 1px) { .deep { font-size: 9px; } } }")).toEqual([".deep"]);
    expect(unscaled(".a { font-size: 12px; } @keyframes k { 50% { opacity: 1; } }")).toEqual([".a"]);
    expect(unscaled(".a { font: var(--type-body); }")).toEqual([]);
    // A twin with another size (the one outside the media query) doesn't count.
    expect(unscaled(".j { font-size: 13px; } html[data-text-size] .j { font-size: calc(13px * var(--text-scale)); } @media (min-width: 640px) { .j { font: 500 14px/20px x; } }")).toEqual([".j"]);
    // A selector with :is(…) is one selector, and its twin is the whole of it.
    expect(unscaled('.b:is([m="a"], [m="e"]) .s { font-size: 12px; }')).toEqual(['.b:is([m="a"], [m="e"]) .s']);
    expect(unscaled('.b:is([m="a"], [m="e"]) .s, .t { font-size: 12px; } html[data-text-size] .b:is([m="a"], [m="e"]) .s, html[data-text-size] .t { font-size: calc(12px * var(--text-scale, 1)); }')).toEqual([]);
  });

  it("grows the windows sized for their words by the same scale as the type, inside the work area (review #57)", () => {
    // The same numbers as ember.css's --text-scale.
    for (const size of ["large", "larger"] as const) {
      const css = new RegExp(`html\\[data-text-size="${size}"\\] \\{ --text-scale: ([\\d.]+); \\}`).exec(shared)![1];
      expect(textScale(size), size).toBe(Number(css));
    }
    expect(textScale("default")).toBe(1);
    expect(textScale(undefined)).toBe(1);
    expect(textScale("huge" as never)).toBe(1);
    const usual = { width: 760, height: 480, minWidth: 480, minHeight: 280 };
    expect(scaledSize(usual, 1)).toEqual(usual);
    expect(scaledSize(usual, 1.3)).toEqual({ width: 988, height: 624, minWidth: 624, minHeight: 364 });
    // No larger than the work area, and never smaller than the usual size (a small screen keeps today's window).
    expect(scaledSize(usual, 1.3, { width: 1024, height: 560 })).toEqual({ width: 988, height: 560, minWidth: 624, minHeight: 364 });
    expect(scaledSize(usual, 1.3, { width: 700, height: 400 })).toEqual({ width: 760, height: 480, minWidth: 624, minHeight: 364 });
  });

  it("grows an open window when the text size changes, keeping a size the user chose in proportion (review #57)", () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    // Centred where it was: Default to Large, and back to exactly the usual size.
    const large = rescaledBounds({ x: 580, y: 280, width: 760, height: 480 }, 1, 1.15, area);
    expect(large).toEqual({ x: 523, y: 244, width: 874, height: 552 });
    expect(rescaledBounds(large, 1.15, 1, area)).toEqual({ x: 580, y: 280, width: 760, height: 480 });
    expect(rescaledBounds(large, 1.15, 1.3, area)).toMatchObject({ width: 988, height: 624 });
    // A size the user chose grows by the same factor; never below the smallest size at the new scale.
    expect(rescaledBounds({ x: 0, y: 0, width: 1000, height: 300 }, 1, 1.3, area, { width: 624, height: 364 })).toMatchObject({ width: 1300, height: 390 });
    expect(rescaledBounds({ x: 0, y: 0, width: 400, height: 250 }, 1, 1.3, area, { width: 624, height: 364 })).toMatchObject({ width: 624, height: 364 });
    // Kept inside the work area of its display (another display's origin too), however near its edge it was.
    const side = { x: 1920, y: 0, width: 1280, height: 680 };
    expect(rescaledBounds({ x: 2900, y: 400, width: 760, height: 480 }, 1, 1.3, side)).toEqual({ x: 2212, y: 56, width: 988, height: 624 });
    expect(rescaledBounds({ x: 1920, y: 0, width: 1200, height: 600 }, 1, 1.3, side)).toEqual({ x: 1920, y: 0, width: 1280, height: 680 });
  });

  it("is a setting in Comfort & access", () => {
    const html = read("app/renderer/home/index.html");
    expect(html).toMatch(/<select id="text-size">\s*<option value="default">Default<\/option>\s*<option value="large">Large<\/option>\s*<option value="larger">Larger<\/option>\s*<\/select>/);
    expect(read("app/main/settings.ts")).toMatch(/textSize: z\.enum\(\["default", "large", "larger"\]\)\.default\("default"\)/);
    // Its hint says, in a sentence, where the size reaches: the Ask box, the one command window, and the prompt window's
    // cards too.
    const hint = /<\/select><\/label>\s*<\/div>\s*<p class="hint">([^<]*)<\/p>/.exec(html.slice(html.indexOf('id="text-size"')))![1];
    expect(hint).toBe("Changes the text in this window, Ember's bubble, task cards and handle, the Ask box, the command window, and Ember's password and consent cards.");
  });
});
