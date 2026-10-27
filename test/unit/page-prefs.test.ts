/**
 * Calm mode and the text size in every window of Ember's: main applies both to each of its pages as it loads and when
 * the settings change, since the Ask box, the command and prompt windows and the desk view are sent no settings
 * (review #248, #57).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyPagePrefs, pageOf, pagePrefs, prefsScript, type PrefsPage } from "../../app/main/page-prefs";

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
    for (const [name, css] of sheets) {
      const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
      // The rules that set a size in px (not through a token), outside the text-size rules themselves.
      const literal = [...plain.matchAll(/([^{}]+)\{([^}]*)\}/g)]
        .filter(([, sel, d]) => /(font: [\d ]*\d+(\.\d+)?px|font-size: \d+(\.\d+)?px)/.test(d) && !sel.includes("data-text-size") && !/^\s*@/.test(sel))
        .map(([, sel]) => sel.trim().replace(/^.*\}\s*/s, ""));
      const scaled = [...plain.matchAll(/([^{}]+)\{([^}]*var\(--text-scale[^}]*)\}/g)].map(([, sel]) => sel.trim());
      for (const sel of literal) {
        const each = sel.split(",").map(s => s.trim());
        for (const s of each) expect(scaled.some(x => x.split(",").map(y => y.trim()).includes(`html[data-text-size] ${s}`)) || /var\(--text-scale/.test(sel), `${name}: ${s}`).toBe(true);
      }
    }
  });

  it("is a setting in Comfort & access", () => {
    const html = read("app/renderer/home/index.html");
    expect(html).toMatch(/<select id="text-size">\s*<option value="default">Default<\/option>\s*<option value="large">Large<\/option>\s*<option value="larger">Larger<\/option>\s*<\/select>/);
    expect(read("app/main/settings.ts")).toMatch(/textSize: z\.enum\(\["default", "large", "larger"\]\)\.default\("default"\)/);
  });
});
