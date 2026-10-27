/**
 * Calm mode and the text size in every window of Ember's: main applies both to each of its pages as it loads and when
 * the settings change, since the Ask box, the command and prompt windows and the desk view are sent no settings
 * (review #248, #57).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyPagePrefs, pageOf, pagePrefs, prefsScript, scaledSize, textScale, type PrefsPage } from "../../app/main/page-prefs";

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

  it("sets the text size where the window can grow with it, and leaves the Ask box and the desk's bar at theirs (review #57)", async () => {
    for (const p of ["home", "command", "prompt", "overlay", "handle"]) {
      const f = fakePage(url(p));
      await applyPagePrefs(f.page, pagePrefs({ reduceMotion: false, textSize: "larger" }));
      expect(f.dataset.textSize, p).toBe("larger");
      await applyPagePrefs(f.page, pagePrefs({ reduceMotion: false, textSize: "default" }));
      expect(f.dataset.textSize, p).toBeUndefined();
    }
    for (const p of ["ask", "desk"]) {
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
  // The rules that set a size in px (not through a token), outside the text-size rules themselves, with that size.
  const px = (d: string) => /(?:font: [\d ]*?|font-size: )(\d+(?:\.\d+)?)px/.exec(d)?.[1];
  const literal = [...plain.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, sel, d]) => px(d) && !sel.includes("data-text-size") && !/^\s*@/.test(sel))
    .flatMap(([, sel, d]) => sel.trim().replace(/^.*\}\s*/s, "").split(",").map(s => ({ sel: s.trim(), size: px(d)! })));
  // Their twins: the same selector under html[data-text-size], the same size times the scale.
  const scaled = [...plain.matchAll(/([^{}]+)\{([^}]*var\(--text-scale[^}]*)\}/g)]
    .flatMap(([, sel, d]) => sel.trim().split(",").map(s => `${s.trim()} ${/font-size: calc\((\d+(?:\.\d+)?)px \* var\(--text-scale(?:, 1)?\)\)/.exec(d)?.[1]}`));
  return literal.filter(l => !scaled.includes(`html[data-text-size] ${l.sel} ${l.size}`)).map(l => l.sel);
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
      ...["home", "command", "prompt", "overlay", "handle"].map(p => [p, read(`app/renderer/${p}/styles.css`)] as [string, string]),
    ];
    for (const [name, css] of sheets) expect(unscaled(css), name).toEqual([]);
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

  it("is a setting in Comfort & access", () => {
    const html = read("app/renderer/home/index.html");
    expect(html).toMatch(/<select id="text-size">\s*<option value="default">Default<\/option>\s*<option value="large">Large<\/option>\s*<option value="larger">Larger<\/option>\s*<\/select>/);
    expect(read("app/main/settings.ts")).toMatch(/textSize: z\.enum\(\["default", "large", "larger"\]\)\.default\("default"\)/);
    // Its hint says, in a sentence, where the size reaches: the one command window, and the prompt window's cards too.
    const hint = /<\/select><\/label>\s*<\/div>\s*<p class="hint">([^<]*)<\/p>/.exec(html.slice(html.indexOf('id="text-size"')))![1];
    expect(hint).toBe("Changes the text in this window, Ember's bubble, task cards and handle, the command window, and Ember's password and consent cards. The Ask box keeps its size.");
  });
});
