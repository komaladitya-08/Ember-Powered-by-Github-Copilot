/**
 * An update that replaces Ember's files under a running Ember (an RPM upgrade, also from GNOME Software or a
 * dnf-automatic timer) is noticed when the next window opens, and Ember offers to restart (install-watch.ts). Review #203.
 * The restart starts an AppImage again from the AppImage, not from its mount (the release follow-up on relaunching),
 * and never with a launcher's --ask, which opened the ask box once (final review P3).
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { UPDATED_QUESTION, createUpdateCheck, installStamp, restartAfterUpdate, updatedDetail, type StatLike } from "../../app/main/install-watch";
import { wantsAsk } from "../../app/main/launcher";

vi.mock("electron", () => ({ BrowserWindow: class {} }));
const { quitQuestion } = await import("../../app/main/windows");

/** A stand-in package.json: its inode, size and modification time, or gone (mid-upgrade). */
function fakeFile() {
  let now: { ino: number; size: number; mtimeMs: number } | null = { ino: 100, size: 2048, mtimeMs: 1_700_000_000_000 };
  const stat: StatLike = () => { if (!now) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return now; };
  return { stat, set: (v: typeof now) => { now = v; } };
}

function setUp(file = fakeFile(), answer = false) {
  const asked: number[] = [];
  let restarts = 0;
  let pending: Promise<unknown> = Promise.resolve();
  const check = createUpdateCheck({
    file: "/opt/ember/resources/app/package.json", stat: file.stat,
    ask: () => { asked.push(asked.length); const p = Promise.resolve(answer); pending = p; return p; },
    restart: () => { restarts++; },
  });
  return { file, check, asked, restarts: () => restarts, settled: () => pending.then(() => new Promise(r => setImmediate(r))) };
}

describe("installStamp", () => {
  it("is the file's inode, size and modification time, or null when it can't be read", () => {
    const f = fakeFile();
    expect(installStamp("/x", f.stat)).toBe("100:2048:1700000000000");
    f.set(null);
    expect(installStamp("/x", f.stat)).toBeNull();
  });
});

describe("the update check before a window opens", () => {
  it("asks nothing while Ember's files are the ones it started with", () => {
    const s = setUp();
    s.check.beforeWindow();
    s.check.beforeWindow();
    expect(s.asked).toEqual([]);
  });

  it("offers a restart once the files were replaced, and restarts when asked to", async () => {
    const s = setUp(fakeFile(), true);
    // rpm writes a new file and renames it over the old one: a new inode, even for a rebuild of the same version.
    s.file.set({ ino: 101, size: 2048, mtimeMs: 1_700_000_000_000 });
    s.check.beforeWindow();
    await s.settled();
    expect(s.asked).toHaveLength(1);
    expect(s.restarts()).toBe(1);
  });

  it("asks once per update: \"Not now\" isn't asked again until the files change again", async () => {
    const s = setUp(fakeFile(), false);
    s.file.set({ ino: 101, size: 2100, mtimeMs: 1_700_000_100_000 });
    s.check.beforeWindow();
    await s.settled();
    s.check.beforeWindow();
    s.check.beforeWindow();
    await s.settled();
    expect(s.asked).toHaveLength(1);
    expect(s.restarts()).toBe(0);
    s.file.set({ ino: 102, size: 2200, mtimeMs: 1_700_000_200_000 });
    s.check.beforeWindow();
    await s.settled();
    expect(s.asked).toHaveLength(2);
  });

  it("never asks two questions at once, and waits while the file is missing (the upgrade is still writing)", async () => {
    const f = fakeFile();
    const asked: number[] = [];
    let answer: (yes: boolean) => void = () => undefined;
    const check = createUpdateCheck({ file: "/p", stat: f.stat, ask: () => { asked.push(1); return new Promise<boolean>(r => { answer = r; }); }, restart: () => undefined });
    f.set(null);
    check.beforeWindow();
    expect(asked).toHaveLength(0);
    f.set({ ino: 101, size: 1, mtimeMs: 1 });
    check.beforeWindow();
    f.set({ ino: 102, size: 1, mtimeMs: 2 });
    check.beforeWindow();
    expect(asked).toHaveLength(1);
    answer(false);
    await new Promise(r => setImmediate(r));
    check.beforeWindow();
    expect(asked).toHaveLength(2);
  });

  it("asks nothing when the file couldn't be read at start-up", () => {
    const f = fakeFile();
    f.set(null);
    const asked: number[] = [];
    const check = createUpdateCheck({ file: "/p", stat: f.stat, ask: () => { asked.push(1); return Promise.resolve(true); }, restart: () => undefined });
    f.set({ ino: 1, size: 1, mtimeMs: 1 });
    check.beforeWindow();
    expect(asked).toEqual([]);
  });
});

describe("the question's words", () => {
  it("say what restarting would stop, in the quit question's words", () => {
    expect(UPDATED_QUESTION).toMatchObject({ title: "Ember was updated", message: "Restart Ember to finish the update.", buttons: ["Restart Ember", "Not now"] });
    expect(updatedDetail(null)).toBe("Until it starts again, some of its windows may not work as they should.");
    expect(updatedDetail(quitQuestion(1, { commands: 0, connections: 0 }))).toMatch(/^Ember is still .+\. Restarting stops it where it is\.$/);
    expect(updatedDetail(quitQuestion(0, { commands: 0, connections: 1 }, ["build-01"]))).toBe("Ember is connected to build-01. Restarting disconnects.");
  });
});

describe("restarting after an update", () => {
  /** Electron's app as restartAfterUpdate uses it: what relaunch was given (its argument list), then quit. */
  function fakeApp() {
    const calls: unknown[][] = [];
    return { calls, relaunch: (...a: unknown[]) => { calls.push(["relaunch", ...a]); }, quit: () => { calls.push(["quit"]); } };
  }

  it("starts the AppImage itself again, not the copy in its mount that goes away once Ember quits", () => {
    const app = fakeApp();
    const argv = ["/tmp/.mount_EmberAb12/ember/ember", "--ozone-platform=x11", "--show-settings"];
    restartAfterUpdate(app, { APPIMAGE: "/home/ada/Apps/Ember-0.1.0-x86_64.AppImage", APPDIR: "/tmp/.mount_EmberAb12" }, argv, "/tmp/.mount_EmberAb12/ember/ember");
    expect(app.calls).toEqual([
      ["relaunch", { execPath: "/home/ada/Apps/Ember-0.1.0-x86_64.AppImage", args: ["--ozone-platform=x11", "--show-settings"] }],
      ["quit"],
    ]);
  });

  it("leaves the RPM, Windows and macOS restart as Electron's own: the same program and arguments, no options", () => {
    for (const [env, argv] of [
      [{}, ["/opt/ember/ember", "--autostart"]],
      [{ LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" }, ["C:\\Users\\ada\\AppData\\Local\\Programs\\Ember\\Ember.exe"]],
      [{ HOME: "/Users/ada" }, ["/Applications/Ember.app/Contents/MacOS/Ember"]],
      [{ APPIMAGE: "" }, ["/opt/ember/ember"]],
      // An RPM Ember started from a shell in another AppImage app's terminal, which passes on its APPIMAGE and APPDIR:
      // restarting it must start Ember again, not that app.
      [{ APPIMAGE: "/home/ada/Apps/SomeTerminal-x86_64.AppImage", APPDIR: "/tmp/.mount_SomeTeXy12" }, ["/opt/ember/ember", "--autostart"]],
      // APPIMAGE without APPDIR: nothing says Ember runs from it.
      [{ APPIMAGE: "/home/ada/Apps/Ember-0.1.0-x86_64.AppImage" }, ["/opt/ember/ember"]],
    ] as const) {
      const app = fakeApp();
      restartAfterUpdate(app, env, argv, argv[0]);
      expect(app.calls, JSON.stringify(env)).toEqual([["relaunch"], ["quit"]]);
    }
  });

  it("never starts Ember again with a launcher's --ask: the ask box was asked for once, by the start that had it", () => {
    // Ember was started by Ask Ember (the Linux desktop entry's action, the Windows jump list) while it wasn't running,
    // so --ask stays in its arguments for as long as it runs.
    const appImage = { APPIMAGE: "/home/ada/Apps/Ember-0.1.0-x86_64.AppImage", APPDIR: "/tmp/.mount_EmberAb12" };
    for (const [env, argv, relaunched] of [
      [{}, ["/opt/ember/ember", "--ozone-platform=x11", "--ask"], { args: ["--ozone-platform=x11"] }],
      [{}, ["C:\\Users\\ada\\AppData\\Local\\Programs\\Ember\\Ember.exe", "--ask"], { args: [] }],
      // A development run: Electron is given the app's folder first.
      [{}, ["/home/ada/ember/node_modules/electron/dist/electron", "/home/ada/ember", "--ask"], { args: ["/home/ada/ember"] }],
      [appImage, ["/tmp/.mount_EmberAb12/ember/ember", "--ozone-platform=x11", "--ask"], { execPath: appImage.APPIMAGE, args: ["--ozone-platform=x11"] }],
    ] as const) {
      const app = fakeApp();
      restartAfterUpdate(app, env, argv, argv[0]);
      expect(app.calls, argv.join(" ")).toEqual([["relaunch", relaunched], ["quit"]]);
      expect(wantsAsk([argv[0], ...relaunched.args])).toBe(false);
    }
  });

  it("is how main.ts restarts once the user says \"Restart Ember\", and both restarts tell restartOptions which program runs", () => {
    const main = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8");
    const check = main.slice(main.indexOf("createUpdateCheck({"), main.indexOf("app.on(\"browser-window-created\""));
    expect(check).toContain("restartAfterUpdate(app, process.env, process.argv, process.execPath)");
    // No restart in main.ts starts the program in an AppImage's mount, or an AppImage Ember doesn't run from: each
    // passes restartOptions' answer for this program.
    expect(main).not.toMatch(/app\.relaunch\(\)/);
    const policyRestarts = main.match(/restartOptions\([^)]*\)/g) ?? [];
    expect(policyRestarts.length).toBeGreaterThan(0);
    for (const call of policyRestarts) expect(call).toBe("restartOptions(process.env, process.argv, process.execPath)");
  });
});
