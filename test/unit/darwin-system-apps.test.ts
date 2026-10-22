/**
 * The macOS app catalogue (design §9.2) over a bundle tree built in a temporary folder: which bundles are listed
 * (agents, background-only and executable-less bundles aren't; vendor folders one level down are; the first bundle
 * of an id wins), what each DesktopApp holds (id, name, keywords, generic, argv, programs), the cache (5 minutes,
 * dropped when a folder changes, each Info.plist parsed once per mtime), and the launch: terminals refused before
 * anything runs, only catalogue bundles, and `/usr/bin/open -a <bundle>` with Ember's tokens left out.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CACHE_MS, appRoots, bundleApp, darwinApps, type BundleFs } from "../../app/main/platform/darwin/system/apps";
import type { DesktopApp } from "../../app/main/hands/system";
import { fakeRun, tool } from "./darwin-system-fakes";

const FIXTURES = path.join(__dirname, "../fixtures/plist");

/** An XML Info.plist with these string (or boolean) keys. */
function infoXml(keys: Record<string, string | boolean>): string {
  const body = Object.entries(keys).map(([k, v]) => `  <key>${k}</key>\n  ${typeof v === "boolean" ? (v ? "<true/>" : "<false/>") : `<string>${v}</string>`}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

function bundle(dir: string, name: string, info: string | Buffer): string {
  const b = path.join(dir, name);
  fs.mkdirSync(path.join(b, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(b, "Contents", "Info.plist"), info);
  return b;
}

describe("the macOS app catalogue", () => {
  let root: string, apps: string, system: string, home: string, finder: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-apps-"));
    apps = path.join(root, "Applications");
    system = path.join(root, "System", "Applications");
    home = path.join(root, "home");
    fs.mkdirSync(path.join(home, "Applications"), { recursive: true });
    fs.mkdirSync(system, { recursive: true });
    bundle(apps, "TextEdit.app", fs.readFileSync(path.join(FIXTURES, "textedit.bplist")));
    bundle(apps, "Helper.app", fs.readFileSync(path.join(FIXTURES, "agent.bplist")));
    bundle(apps, "Daemon.app", infoXml({ CFBundleExecutable: "Daemon", CFBundleIdentifier: "com.example.daemon", LSBackgroundOnly: "1" }));
    bundle(apps, "Shell.app", infoXml({ CFBundleIdentifier: "com.example.noexe" }));
    bundle(apps, "Sneaky.app", infoXml({ CFBundleExecutable: "../../bin/sh", CFBundleIdentifier: "com.example.sneaky" }));
    bundle(apps, "Broken.app", "not a plist at all");
    bundle(apps, ".Hidden.app", infoXml({ CFBundleExecutable: "H", CFBundleIdentifier: "com.example.hidden" }));
    bundle(path.join(apps, "Microsoft Office"), "Microsoft Word.app",
      infoXml({ CFBundleExecutable: "Microsoft Word", CFBundleIdentifier: "com.microsoft.Word", CFBundleName: "Microsoft Word", LSApplicationCategoryType: "public.app-category.productivity" }));
    bundle(path.join(apps, "Utilities"), "Terminal.app", infoXml({ CFBundleExecutable: "Terminal", CFBundleIdentifier: "com.apple.Terminal", CFBundleName: "Terminal" }));
    bundle(apps, "Notes Copy.app", infoXml({ CFBundleExecutable: "Notes", CFBundleIdentifier: "com.apple.Notes", CFBundleName: "Notes" }));
    bundle(system, "Notes.app", infoXml({ CFBundleExecutable: "Notes", CFBundleIdentifier: "com.apple.Notes", CFBundleName: "Notes" }));
    bundle(system, "Calculator.app", infoXml({ CFBundleExecutable: "Calculator", CFBundleDisplayName: "Calculator" }));
    bundle(path.join(home, "Applications"), "Cafe.app", fs.readFileSync(path.join(FIXTURES, "unicode.bplist")));
    finder = bundle(path.join(root, "CoreServices"), "Finder.app", fs.readFileSync(path.join(FIXTURES, "finder.plist")));
    // A link to a bundle elsewhere (as /Applications/Safari.app links into a cryptex) is listed like a bundle.
    const cryptex = bundle(path.join(root, "Cryptexes"), "Safari.app", infoXml({ CFBundleExecutable: "Safari", CFBundleIdentifier: "com.apple.Safari", CFBundleName: "Safari" }));
    // A junction on Windows, where a directory link needs no privilege then (the unit tests run there too).
    fs.symlinkSync(cryptex, path.join(apps, "Safari.app"), process.platform === "win32" ? "junction" : "dir");
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const catalogue = (extra: Partial<Parameters<typeof darwinApps>[0]> = {}) => darwinApps({
    roots: [{ dir: apps, vendors: true }, { dir: path.join(apps, "Utilities") }, { dir: system }, { dir: path.join(home, "Applications") }],
    extraBundles: [finder], home: () => home, ...extra,
  });
  const byName = (list: DesktopApp[], name: string) => list.find(a => a.name === name);

  it("lists apps from every folder, vendor folders one level down, and Finder from CoreServices", () => {
    const names = catalogue().list().map(a => a.name).sort();
    expect(names).toEqual(["Cafe", "Calculator", "Finder", "Microsoft Word", "Notes Copy", "Safari", "Terminal", "TextEdit"]);
  });

  it("leaves out agents, background-only bundles, bundles without a plain executable name and unreadable plists", () => {
    const names = catalogue().list().map(a => a.name);
    for (const n of ["Helper", "Daemon", "Shell", "Sneaky", "Broken", ".Hidden"]) expect(names).not.toContain(n);
  });

  it("keeps the first bundle of a bundle id (an earlier folder wins)", () => {
    const list = catalogue().list();
    expect(list.filter(a => a.id === "com.apple.Notes").map(a => a.file)).toEqual([path.join(apps, "Notes Copy.app")]);
  });

  it("describes a bundle as the model and the worker need it", () => {
    const te = byName(catalogue().list(), "TextEdit")!;
    expect(te).toEqual({
      id: "com.apple.TextEdit", name: "TextEdit", file: path.join(apps, "TextEdit.app"),
      keywords: ["text editor", "textedit"], generic: "text editor", categories: ["public.app-category.productivity"],
      argv: [path.join(apps, "TextEdit.app", "Contents", "MacOS", "TextEdit")],
      programs: ["textedit", "com.apple.textedit"],
    });
    expect(te.exec).toBeUndefined();
  });

  it("falls back to the bundle's path for an app without a bundle id, and names it by its file", () => {
    const calc = byName(catalogue().list(), "Calculator")!;
    expect(calc.id).toBe(path.join(system, "Calculator.app"));
    expect(calc.generic).toBe("calculator");
    expect(calc.programs).toEqual(["calculator"]);
  });

  it("keeps non-ASCII names, and every program name a window may report", () => {
    const cafe = byName(catalogue().list(), "Cafe")!;
    expect(cafe.keywords).toEqual(["カフェ 🙂", "café über ✓"]);
    expect(cafe.programs).toEqual(["cafe", "café über ✓", "com.example.cafe"]);
    const word = byName(catalogue().list(), "Microsoft Word")!;
    expect(word.programs).toEqual(["microsoft word", "com.microsoft.word"]);
  });

  it("finds an app by name, generic word and bundle id", () => {
    const c = catalogue();
    const list = c.list();
    expect(c.find(list, "TextEdit")?.name).toBe("TextEdit");
    expect(c.find(list, "text editor")?.name).toBe("TextEdit");
    expect(c.find(list, "file manager")?.name).toBe("Finder");
  });

  it("compares window app names in lower case", () => {
    const c = catalogue();
    expect(c.appKey("TextEdit")).toBe("textedit");
    expect([...c.programsOf(byName(c.list(), "TextEdit")!)].sort()).toEqual(["com.apple.textedit", "textedit"]);
  });

  describe("cache", () => {
    /** The real file system, counting Info.plist reads. */
    function countingFs() {
      let reads = 0;
      const bfs: BundleFs = {
        readdir: d => fs.readdirSync(d),
        stat: p => { try { return fs.statSync(p); } catch { return null; } },
        readFile: p => { reads++; return fs.readFileSync(p); },
      };
      return { bfs, reads: () => reads };
    }

    it("reads each Info.plist once, and serves the list again from memory while nothing changes", () => {
      const { bfs, reads } = countingFs();
      let t = 0;
      const c = catalogue({ fs: bfs, now: () => t });
      const first = c.list();
      const n = reads();
      expect(n).toBeGreaterThan(5);
      t = CACHE_MS - 1;
      expect(c.list()).toEqual(first);
      expect(reads()).toBe(n);
      // After five minutes the folders are walked again, but unchanged plists aren't parsed again.
      t = CACHE_MS + 1;
      expect(c.list()).toEqual(first);
      expect(reads()).toBe(n);
    });

    it("lists again as soon as a folder changes", () => {
      const { bfs } = countingFs();
      const c = catalogue({ fs: bfs, now: () => 0 });
      expect(byName(c.list(), "Maps")).toBeUndefined();
      const b = bundle(system, "Maps.app", infoXml({ CFBundleExecutable: "Maps", CFBundleIdentifier: "com.apple.Maps" }));
      // A folder's mtime has one-second granularity on some file systems: make the change visible.
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(system, later, later);
      try {
        expect(byName(c.list(), "Maps")?.file).toBe(b);
      } finally {
        fs.rmSync(b, { recursive: true, force: true });
      }
    });

    it("returns a copy, so a caller can't change the cached list", () => {
      const c = catalogue();
      c.list().length = 0;
      expect(c.list().length).toBeGreaterThan(0);
    });
  });

  describe("launch", () => {
    const env = { PATH: "/usr/bin:/bin", HOME: "/Users/ada", LANG: "en_GB.UTF-8", GH_TOKEN: "secret", COPILOT_API_KEY: "k", EMBER_LOG_LEVEL: "debug", EMBER_USER_DATA: "/tmp/x" };

    it("opens the bundle with /usr/bin/open -a, from the home folder, without Ember's tokens", async () => {
      const { run, calls } = fakeRun([{ match: tool("/usr/bin/open"), result: { code: 0 } }]);
      const c = catalogue({ run, env });
      c.launch(byName(c.list(), "TextEdit")!);
      await Promise.resolve();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.file).toBe("/usr/bin/open");
      expect(calls[0]!.args).toEqual(["-a", path.join(apps, "TextEdit.app")]);
      expect(calls[0]!.o?.cwd).toBe(home);
      expect(calls[0]!.o?.timeout).toBe(10_000);
      const childEnv = calls[0]!.o?.env ?? {};
      expect(childEnv.LANG).toBe("en_GB.UTF-8");
      for (const k of Object.keys(childEnv)) expect(k).not.toMatch(/^(GH_|COPILOT_|EMBER_)|_TOKEN$|_KEY$/);
    });

    it("refuses what the terminal check refuses, before anything runs", () => {
      // Which Mac apps are terminals is the macOS vocabulary's (hands/terminals.ts); an app flagged as one is refused on any OS.
      const { run, calls } = fakeRun();
      const c = catalogue({ run });
      expect(() => c.launch({ ...byName(c.list(), "Terminal")!, terminal: true })).toThrow(/terminals/);
      expect(() => c.launch({ ...byName(c.list(), "TextEdit")!, categories: ["TerminalEmulator"] })).toThrow(/terminals/);
      expect(calls).toHaveLength(0);
    });

    it("opens only an app bundle that is still there", () => {
      const { run, calls } = fakeRun();
      const c = catalogue({ run });
      const fake = (file: string): DesktopApp => ({ id: "x", name: "Tool", file, keywords: [] });
      expect(() => c.launch(fake("/usr/bin/osascript"))).toThrow(/only opens installed apps/);
      expect(() => c.launch(fake("relative/Thing.app"))).toThrow(/only opens installed apps/);
      expect(() => c.launch(fake(path.join(apps, "Gone.app")))).toThrow(/isn't installed/);
      expect(calls).toHaveLength(0);
    });

    it("reports an open that failed after the call returned, without throwing", async () => {
      const errors: unknown[] = [];
      const { run } = fakeRun([{ match: tool("/usr/bin/open"), result: { code: 1, stderr: "Unable to find application\n" } }]);
      const c = catalogue({ run, onLaunchError: e => errors.push(e) });
      expect(() => c.launch(byName(c.list(), "TextEdit")!)).not.toThrow();
      await new Promise(r => setTimeout(r, 0));
      expect(errors).toEqual([{ code: 1, stderr: "Unable to find application" }]);
    });
  });
});

describe("bundleApp", () => {
  it("takes truthy LSUIElement spellings as an agent", () => {
    for (const v of [true, 1, "1", "YES", "true"]) expect(bundleApp("/A/X.app", { CFBundleExecutable: "X", LSUIElement: v })).toBeNull();
    expect(bundleApp("/A/X.app", { CFBundleExecutable: "X", LSUIElement: false })?.name).toBe("X");
    expect(bundleApp("/A/X.app", { CFBundleExecutable: "X", LSUIElement: "0" })?.name).toBe("X");
  });

  it("gives the generic words of the design's table", () => {
    const g = (name: string) => bundleApp(`/Applications/${name}.app`, { CFBundleExecutable: name })?.generic;
    expect([g("Finder"), g("TextEdit"), g("Safari"), g("Mail"), g("System Settings"), g("Numbers"), g("Pages"), g("Keynote"), g("Preview"), g("Calculator")])
      .toEqual(["file manager", "text editor", "web browser", "email", "settings", "spreadsheet", "word processor", "presentation", "document viewer", "calculator"]);
    expect(g("Chess")).toBeUndefined();
  });
});

describe("appRoots", () => {
  it("lists the Applications folders in the design's order, the user's own last", () => {
    expect(appRoots("/Users/ada").map(r => r.dir)).toEqual(["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", "/Users/ada/Applications"]);
    expect(appRoots("/Users/ada").filter(r => r.vendors).map(r => r.dir)).toEqual(["/Applications"]);
  });
});
