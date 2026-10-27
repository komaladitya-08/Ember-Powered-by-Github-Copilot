/**
 * Calm mode in every window of Ember's: main applies it to each of its pages as it loads and when the settings change,
 * since the Ask box, the command and prompt windows and the desk view are sent no settings (review #248).
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
      expect(await applyPagePrefs(f.page, pagePrefs({ reduceMotion: true })), p).toBe(true);
      expect(f.classes.has("calm"), p).toBe(true);
      await applyPagePrefs(f.page, pagePrefs({ reduceMotion: false }));
      expect(f.classes.has("calm"), p).toBe(false);
    }
  });

  it("runs only in Ember's own bundled pages, and only code built from a switch", async () => {
    const web = fakePage("https://example.com/renderer/home/index.html");
    expect(await applyPagePrefs(web.page, pagePrefs({ reduceMotion: true }))).toBe(false);
    expect(web.sent).toEqual([]);
    expect(pageOf("file:///C:/Program%20Files/Ember/resources/app/dist/app/renderer/command/index.html")).toBe("command");
    expect(pageOf("about:blank")).toBeNull();
    // A value that isn't a switch reaches no page as code.
    const odd = pagePrefs({ reduceMotion: "\"); alert(1); (\"" as never });
    expect(prefsScript(odd, "home")).not.toContain("alert");
  });

  it("skips a window that has gone, and a page that went away during the call is no error (it gets them again as it loads)", async () => {
    const gone = fakePage(url("command"), { destroyed: true });
    expect(await applyPagePrefs(gone.page, pagePrefs({ reduceMotion: true }))).toBe(false);
    expect(gone.sent).toEqual([]);
    const moving = fakePage(url("command"), { fails: true });
    expect(await applyPagePrefs(moving.page, pagePrefs({ reduceMotion: true }))).toBe(false);
  });

  it("is applied by main to each page as it loads and to every window when the settings change", () => {
    const main = read("app/main/main.ts");
    expect(main).toMatch(/contents\.on\("dom-ready", \(\) => void applyPagePrefs\(contents, pagePrefs\(settings\.get\(\)\)\)\)/);
    expect(main).toMatch(/for \(const w of BrowserWindow\.getAllWindows\(\)\) void applyPagePrefs\(w\.webContents, prefs\)/);
  });
});
