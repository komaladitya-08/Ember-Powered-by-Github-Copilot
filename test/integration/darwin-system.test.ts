/**
 * Ember's macOS system integration on a real Mac (design §9, §8.2): the app catalogue lists TextEdit, Finder and
 * System Settings and LaunchServices opens TextEdit (launchd's child, never Ember's), VoiceOver's probe answers, the
 * administrator's policy is absent where its folder is, Dark Mode switches and switches back through System Events
 * (CI grants Ember's Apple Events to System Events in the user's TCC database), and inside a real Electron the
 * desktopCapturer capture of a pure red window comes back at one pixel per point in BGRA (THUMBNAIL_ORDER), through
 * electronCapture itself and through the macOS platform's window system, with Screen Recording granted. Skipped off
 * macOS; with EMBER_MACSYS_TEST=1 every check runs and fails instead of skipping when a facility is missing (off
 * macOS, no Electron binary, a missing grant), printing what was missing so CI learns which client TCC wanted. Without it, the Electron checks skip on a Mac where
 * Electron isn't installed or the app that started the run has no Screen Recording grant.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { darwinApps } from "../../app/main/platform/darwin/system/apps";
import { isPlistDict, parsePlist, parseStringsFile } from "../../app/main/platform/darwin/system/plist";
import { darwinSettings } from "../../app/main/platform/darwin/system/settings";
import { darwinAdminPolicy, POLICY_FOLDER } from "../../app/main/platform/darwin/system/admin-policy";
import { voiceOverRunning } from "../../app/main/platform/darwin/system/a11y";
import { execRun } from "../../app/main/platform/darwin/system/exec";
import { THUMBNAIL_ORDER } from "../../app/main/platform/darwin/electron-capture";
import type { DesktopApp } from "../../app/main/hands/system";
import { appWindow, waitFor, whyNoWindow } from "./darwin-support";

const required = process.env.EMBER_MACSYS_TEST === "1";
const onMac = process.platform === "darwin";
const root = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pidsOf = (name: string) => (spawnSync("/usr/bin/pgrep", ["-x", name], { encoding: "utf8" }).stdout ?? "").split("\n").filter(Boolean).map(Number);

/** What the Electron child reports (see CHILD). */
interface ChildReport {
  screenAccess: string;
  trusted: boolean;
  window: { x: number; y: number; width: number; height: number };
  direct: Capture | null;
  platform: Capture | null;
  platformError?: string;
  mac?: Record<string, unknown>;
}
interface Capture { x: number; y: number; width: number; height: number; bytes: number; centre: number[]; corner: number[] }

/**
 * The Electron child: a frameless pure-red window above everything, then the capture of a rectangle inside it, once
 * through electronCapture and once through the platform's window system (captureRect's permission check and clipping
 * included). It prints one line, "EMBER_RESULT <json>", and quits.
 */
const CHILD = `
import { app, BrowserWindow, desktopCapturer, screen, shell, systemPreferences, powerMonitor } from "electron";
import { electronCapture } from "./app/main/platform/darwin/electron-capture";
import { darwinPlatform } from "./app/main/platform/darwin/platform";
import type { X11Image } from "./app/main/platform/types";

app.commandLine.appendSwitch("force-color-profile", "srgb");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const summary = (img: X11Image | null) => {
  if (!img) return null;
  const at = (x: number, y: number) => [...img.bgra.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
  return { x: img.x, y: img.y, width: img.width, height: img.height, bytes: img.bgra.length, centre: at(img.width >> 1, img.height >> 1), corner: at(1, 1) };
};
const quiet = { debug() {}, info() {}, warn: (m: string, f: unknown) => console.error(m, f), error: (m: string, f: unknown) => console.error(m, f), child() { return quiet; }, file: "" };

app.whenReady().then(async () => {
  const out: Record<string, unknown> = {
    screenAccess: systemPreferences.getMediaAccessStatus("screen"),
    trusted: systemPreferences.isTrustedAccessibilityClient(false),
  };
  const w = new BrowserWindow({ x: 160, y: 160, width: 260, height: 180, frame: false, show: false, hasShadow: false, backgroundColor: "#FF0000",
    type: "panel", focusable: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await w.loadURL("data:text/html,<body style='margin:0;background:%23FF0000'></body>");
  w.setAlwaysOnTop(true, "screen-saver");
  w.showInactive();
  await sleep(1500);
  const b = w.getBounds();
  out.window = b;
  const rect = { x: b.x + 60, y: b.y + 50, width: 40, height: 30 };
  out.direct = summary(await electronCapture({ desktopCapturer, screen, log: quiet as never })(rect));
  try {
    const platform = darwinPlatform({
      electron: { app, screen, desktopCapturer, systemPreferences, shell, powerMonitor, browserWindow: BrowserWindow } as never,
      packaged: false, execPath: process.execPath, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, env: process.env,
    });
    const ws = platform.openWindows(quiet as never);
    out.mac = platform.system.environment({ windows: ws }).mac;
    out.platform = ws ? summary(await ws.capture(rect.x, rect.y, rect.width, rect.height)) : null;
    if (!ws) out.platformError = "openWindows returned null";
    ws?.close();
  } catch (err) {
    out.platformError = String(err);
  }
  process.stdout.write("EMBER_RESULT " + JSON.stringify(out) + "\\n");
  app.exit(0);
});
`;

/**
 * The keychain child (review #241): seals a sign-in with safeStorage.encryptString, as TokenStore.save does, and opens
 * it with decryptStringAsync, as TokenStore.load does on macOS (so the keychain prompt after an update holds no main
 * thread), directly and through TokenStore itself. It prints "EMBER_RESULT <json>" and quits. It adds an
 * "ember-darwin-system-keychain Safe Storage" item to the login keychain.
 */
const KEYCHAIN_CHILD = `
import { app, safeStorage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TokenStore } from "./app/main/agent/auth";

app.whenReady().then(async () => {
  const out: Record<string, unknown> = {};
  try {
    out.available = safeStorage.isEncryptionAvailable();
    out.asyncAvailable = await safeStorage.isAsyncEncryptionAvailable();
    const opened = await safeStorage.decryptStringAsync(safeStorage.encryptString("gho_EmberKeychainCheck1"));
    out.result = opened.result;
    out.shouldReEncrypt = opened.shouldReEncrypt;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-keychain-"));
    try {
      const store = new TokenStore(path.join(dir, "github-token.bin"), safeStorage, { version: "0.0.0-test", asyncDecrypt: true });
      out.saved = store.save("gho_EmberKeychainCheck2");
      out.loaded = await store.load();
      out.unreadable = store.unreadable;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    out.error = String(err);
  }
  process.stdout.write("EMBER_RESULT " + JSON.stringify(out) + "\\n");
  app.exit(0);
});
`;

/** What the keychain child reports (see KEYCHAIN_CHILD). */
interface KeychainReport {
  available?: boolean; asyncAvailable?: boolean; result?: string; shouldReEncrypt?: boolean;
  saved?: boolean; loaded?: string | null; unreadable?: boolean; error?: string;
}

/** The Electron binary the electron package installed (its main export is the path). */
const electronBinary = () => createRequire(import.meta.url)("electron") as unknown as string;

/**
 * Builds a child (CHILD by default) into .cache/test/<folder> (so it loads koffi from the repository's node_modules)
 * and runs it under Electron as the app `name`.
 */
async function runChild<R = ChildReport>(source = CHILD, folder = "darwin-system-electron", name = "ember-darwin-system-test"): Promise<R> {
  const dir = path.join(root, ".cache", "test", folder);
  fs.mkdirSync(dir, { recursive: true });
  buildSync({
    stdin: { contents: source, loader: "ts", resolveDir: root, sourcefile: `${folder}-child.ts` },
    bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron", "koffi"], outfile: path.join(dir, "main.cjs"), logLevel: "silent",
  });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, main: "main.cjs" }));
  const electron = electronBinary();
  return new Promise<R>((resolve, reject) => {
    // ELECTRON_RUN_AS_NODE from the caller would start a plain Node instead of the app.
    const child = spawn(electron, [dir], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0", ELECTRON_RUN_AS_NODE: undefined } });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Electron didn't report within 60 s\n${stderr}`)); }, 60_000);
    child.on("exit", code => {
      clearTimeout(timer);
      const line = stdout.split("\n").find(l => l.startsWith("EMBER_RESULT "));
      if (!line) return reject(new Error(`Electron exited ${code} without a report\n${stderr}`));
      if (stderr.trim()) console.log(`Electron child's stderr:\n${stderr}`);
      resolve(JSON.parse(line.slice("EMBER_RESULT ".length)) as R);
    });
  });
}

describe.skipIf(!onMac && !required)("macOS system integration on a real Mac", () => {
  beforeAll(() => {
    if (!onMac) throw new Error("EMBER_MACSYS_TEST=1, but this isn't macOS");
  });

  describe("the app catalogue", () => {
    const launched: number[] = [];
    let apps: DesktopApp[] = [];
    const catalogue = darwinApps();

    beforeAll(() => {
      const started = Date.now();
      apps = catalogue.list();
      console.log(`listed ${apps.length} apps in ${Date.now() - started} ms`);
    });

    afterAll(() => {
      for (const pid of launched) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    });

    it("lists TextEdit, Finder and System Settings with their bundle ids and executables", () => {
      const byId = (id: string) => apps.find(a => a.id.toLowerCase() === id);
      for (const [id, name] of [["com.apple.textedit", "TextEdit"], ["com.apple.finder", "Finder"], ["com.apple.systempreferences", "System Settings"]] as const) {
        const app = byId(id);
        expect(app, `${name} (${id}) in the catalogue`).toBeDefined();
        expect(app!.name).toBe(name);
        expect(fs.existsSync(app!.argv![0]!), app!.argv![0]).toBe(true);
        expect(app!.programs).toContain(name.toLowerCase());
      }
    });

    it("finds TextEdit as the text editor and Finder as the file manager", () => {
      expect(catalogue.find(apps, "text editor")?.name).toBe("TextEdit");
      expect(catalogue.find(apps, "file manager")?.name).toBe("Finder");
      expect(catalogue.find(apps, "System Settings")?.name).toBe("System Settings");
    });

    // Apple's own bundles, as macOS ships them (review #239): their German names come from InfoPlist.loctable or
    // de.lproj/InfoPlist.strings, so open_app("Rechner") finds Calculator and its window's owner name matches.
    it("knows Apple's apps by the names a German Mac shows", () => {
      const german = darwinApps({ languages: () => ["de-DE"] });
      const list = german.list();
      /** What the bundle has for German, so a miss says which layout this macOS uses and what each file holds. */
      const layout = (bundle: string | undefined) => {
        const said: string[] = [];
        const note = (what: string, read: () => unknown) => {
          try {
            said.push(`${what}: ${JSON.stringify(read())}`);
          } catch (err) {
            said.push(`${what}: ${String(err)}`);
          }
        };
        const resources = path.join(bundle ?? "", "Contents", "Resources");
        note("German resources", () => fs.readdirSync(resources).filter(n => /^(de|German)([._-]|$)|loctable$/i.test(n)));
        note("Info.plist names", () => {
          const info = parsePlist(fs.readFileSync(path.join(bundle ?? "", "Contents", "Info.plist")));
          return isPlistDict(info) ? { CFBundleName: info.CFBundleName, CFBundleDisplayName: info.CFBundleDisplayName, CFBundleExecutable: info.CFBundleExecutable } : typeof info;
        });
        note("InfoPlist.loctable", () => {
          const file = path.join(resources, "InfoPlist.loctable");
          const table = parsePlist(fs.readFileSync(file));
          if (!isPlistDict(table)) return typeof table;
          const keys = Object.keys(table);
          const german = keys.filter(k => /^(de|German)([._-]|$)/i.test(k));
          return { bytes: fs.statSync(file).size, languages: keys.length, sample: keys.slice(0, 8), german: Object.fromEntries(german.map(k => [k, isPlistDict(table[k]) ? Object.keys(table[k]) : typeof table[k]])) };
        });
        for (const folder of ["de.lproj", "German.lproj"]) {
          note(folder, () => fs.readdirSync(path.join(resources, folder)));
          note(`${folder}/InfoPlist.strings`, () => {
            const strings = parseStringsFile(fs.readFileSync(path.join(resources, folder, "InfoPlist.strings")));
            return isPlistDict(strings) ? Object.keys(strings) : typeof strings;
          });
        }
        return said.join("; ");
      };
      for (const [id, name] of [["com.apple.calculator", "rechner"], ["com.apple.systempreferences", "systemeinstellungen"]] as const) {
        const app = list.find(a => a.id.toLowerCase() === id);
        expect(app, `${id} in the catalogue`).toBeDefined();
        if (!(app!.programs ?? []).includes(name)) console.log(`${id}: programs ${JSON.stringify(app!.programs)}; ${layout(app!.file)}`);
        expect(app!.programs, `${id}'s names`).toContain(name);
        expect(app!.keywords).toContain(name);
      }
      expect(german.find(list, "Rechner")?.id.toLowerCase()).toBe("com.apple.calculator");
    });

    // Needs the macOS terminal vocabulary (package V, hands/terminals.ts), which Ember can't be switched on without.
    it("refuses Terminal", () => {
      const terminal = apps.find(a => a.id.toLowerCase() === "com.apple.terminal");
      expect(terminal).toBeDefined();
      expect(() => catalogue.launch(terminal!)).toThrow(/terminals/);
    });

    it("opens TextEdit through LaunchServices, as launchd's child rather than Ember's, and it stays up with a window", async () => {
      const before = new Set(pidsOf("TextEdit"));
      const since = Date.now();
      let failed: unknown;
      darwinApps({ onLaunchError: e => { failed = e; } }).launch(apps.find(a => a.id.toLowerCase() === "com.apple.textedit")!);
      // A TextEdit that already runs (a developer's) is only brought forward: then that one is checked, and left running.
      let pid: number | undefined;
      for (let i = 0; i < 100 && pid === undefined && !failed && !(before.size && i > 20); i++) {
        pid = pidsOf("TextEdit").find(p => !before.has(p));
        if (pid === undefined) await sleep(150);
      }
      expect(failed, "open -a's failure").toBeUndefined();
      if (pid !== undefined) launched.push(pid);
      pid ??= [...before][0];
      expect(pid, `a TextEdit process:\n  ${whyNoWindow("TextEdit", since)}`).toBeDefined();
      const ppid = Number(spawnSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());
      expect(ppid).toBe(1);
      // Up a while later, with a window of its own (a document or its open panel): an app that dies at launch (TextEdit
      // did on CI runs 114 to 116) leaves only a crash report behind.
      const shown = await waitFor("a window of TextEdit's", () => appWindow(pid!) ?? (pidsOf("TextEdit").includes(pid!) ? null : "gone"), 15_000).catch(() => null);
      const window = shown && shown !== "gone" ? shown : null;
      console.log(`TextEdit ${pid}: window ${JSON.stringify(window)}`);
      expect(window, `TextEdit's window (${shown === "gone" ? "the process ended" : "none yet"}):\n  ${whyNoWindow("TextEdit", since)}`).not.toBeNull();
    }, 45_000);
  });

  it("asks whether VoiceOver runs and gets an answer", async () => {
    const on = await voiceOverRunning(execRun);
    expect(on === true || on === false).toBe(true);
    console.log(`VoiceOver running: ${on}`);
  });

  it("has no administrator's policy where its folder isn't there", () => {
    if (fs.existsSync(POLICY_FOLDER)) {
      console.log(`${POLICY_FOLDER} exists here: not testable on this machine`);
      return;
    }
    expect(darwinAdminPolicy().load()).toMatchObject({ source: null });
  });

  // Toggling the appearance of a developer's own Mac (and its Automation prompt) only where asked for, as CI does.
  it.runIf(required)("switches Dark Mode through System Events and back", async () => {
    const s = darwinSettings();
    const read = spawnSync("/usr/bin/defaults", ["read", "-g", "AppleInterfaceStyle"], { encoding: "utf8" });
    const was = read.status === 0 && read.stdout.trim() === "Dark";
    try {
      const first = await s.change("dark_style", was ? "off" : "on");
      expect(first).toEqual({ before: String(was), after: String(!was) });
    } catch (err) {
      throw new Error(`${(err as Error).message} (grant kTCCServiceAppleEvents for com.apple.systemevents to this process's responsible client)`, { cause: err });
    } finally {
      const back = await s.change("dark_style", was ? "on" : "off").catch(() => null);
      if (back) expect(back.after).toBe(String(was));
    }
  }, 40_000);

  // Writes an item to the login keychain: only where asked for, as CI does.
  it.runIf(required)("opens a sign-in sealed with encryptString through decryptStringAsync, as TokenStore does on macOS (review #241)", async () => {
    const r = await runChild<KeychainReport>(KEYCHAIN_CHILD, "darwin-system-keychain", "ember-darwin-system-keychain");
    console.log(`keychain child: ${JSON.stringify(r)}`);
    expect(r.error).toBeUndefined();
    expect({ available: r.available, asyncAvailable: r.asyncAvailable }).toEqual({ available: true, asyncAvailable: true });
    // The same key either way: a token TokenStore.save sealed opens, and needn't be sealed again.
    expect({ result: r.result, shouldReEncrypt: r.shouldReEncrypt }).toEqual({ result: "gho_EmberKeychainCheck1", shouldReEncrypt: false });
    expect({ saved: r.saved, loaded: r.loaded, unreadable: r.unreadable }).toEqual({ saved: true, loaded: "gho_EmberKeychainCheck2", unreadable: false });
  }, 90_000);

  describe("inside Electron", () => {
    let report: ChildReport | null = null;
    let missing = "";

    beforeAll(async () => {
      const electron = electronBinary();
      if (!fs.existsSync(electron)) {
        missing = `no Electron binary at ${electron} (npx install-electron)`;
        if (required) throw new Error(missing);
        return;
      }
      report = await runChild<ChildReport>();
      console.log(`Electron child: ${JSON.stringify(report)}`);
      // On a developer's Mac the grant belongs to whichever app started the run (Terminal, an editor): skip without it.
      if (report.screenAccess !== "granted") missing = `Screen Recording is ${report.screenAccess} for the app that started this run`;
    }, 90_000);

    /** The Electron child's report, or a skip (only without EMBER_MACSYS_TEST=1) when Electron or the grant is missing. */
    const reportOrSkip = (ctx: { skip: (note?: string) => never }): ChildReport => {
      if (missing && !required) ctx.skip(missing);
      if (!report) throw new Error(missing || "the Electron child didn't run");
      return report;
    };

    it("has Screen Recording under the CI grants", ctx => {
      const report = reportOrSkip(ctx);
      expect(report.screenAccess).toBe("granted");
      expect(report.mac?.screen).toBe("granted");
    });

    it("captures the red window through desktopCapturer at one pixel per point, in BGRA", ctx => {
      const report = reportOrSkip(ctx);
      const c = report.direct;
      expect(c, "electronCapture's image").not.toBeNull();
      expect({ width: c!.width, height: c!.height, bytes: c!.bytes }).toEqual({ width: 40, height: 30, bytes: 40 * 30 * 4 });
      // Pure red is B≈0 G≈0 R≈255 in BGRA. Colour management may move it a little; a byte-order mix-up moves it all the way.
      const [b, g, r, a] = c!.centre;
      expect(r, `centre pixel ${c!.centre} (THUMBNAIL_ORDER ${THUMBNAIL_ORDER}: flip it if red and blue are swapped)`).toBeGreaterThan(190);
      expect(b).toBeLessThan(60);
      expect(g).toBeLessThan(60);
      expect(a).toBe(255);
    });

    it("captures the same through the macOS platform's window system", ctx => {
      const report = reportOrSkip(ctx);
      expect(report.platformError).toBeUndefined();
      const c = report.platform;
      expect(c, "WindowSystem.capture's image").not.toBeNull();
      expect({ width: c!.width, height: c!.height, x: c!.x, y: c!.y }).toEqual({ width: 40, height: 30, x: report.window.x + 60, y: report.window.y + 50 });
      expect(c!.centre[2]).toBeGreaterThan(190);
      expect(c!.centre[0]).toBeLessThan(60);
    });
  });
});
