/**
 * Crashes of Ember's own processes reach ember.log, and a card window whose page crashed doesn't stay on screen blank
 * (review #91): app "child-process-gone" (the GPU process on a VM) and every page's "render-process-gone" are logged
 * with their reason; the command and prompt windows close on a crash (their controllers then answer as if the user had
 * closed them: an SSH prompt no, a countdown cancelled), and the desk view lets go of held keys and reloads.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pageName, watchCrashes, type CrashSource } from "../../app/main/crash-log";

const made: { destroyed: boolean; emit(e: string, ...a: unknown[]): void }[] = [];
vi.mock("electron", () => {
  class BrowserWindow {
    destroyed = false;
    private handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    webContents = { on: (e: string, fn: (...a: unknown[]) => void) => { this.handlers.set(e, [...(this.handlers.get(e) ?? []), fn]); } };
    constructor() { made.push(this); }
    emit(e: string, ...a: unknown[]): void { for (const fn of this.handlers.get(e) ?? []) fn(...a); }
    setAlwaysOnTop(): void {}
    setContentProtection(): void {}
    loadFile(): Promise<void> { return Promise.resolve(); }
    isDestroyed(): boolean { return this.destroyed; }
    destroy(): void { this.destroyed = true; }
    on(): void { /* the command window's close guard listens (review #262) */ }
  }
  // The command window's close guard also listens for Ember quitting (#262); placement reads the screen (#272).
  return { BrowserWindow, app: { getAppPath: () => "/app", on: () => undefined, removeListener: () => undefined }, screen: {} };
});

describe("crashes in ember.log (review #91)", () => {
  function setup() {
    const app = new EventEmitter();
    const lines: [string, Record<string, unknown>][] = [];
    const log = { warn: (m: string, f?: Record<string, unknown>) => lines.push([m, f ?? {}]), error: (m: string, f?: Record<string, unknown>) => lines.push([m, f ?? {}]) };
    watchCrashes(app as unknown as CrashSource, log);
    return { app, lines };
  }

  it("logs a GPU or utility process that went, with its reason, and not a clean exit", () => {
    const { app, lines } = setup();
    app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 139 });
    app.emit("child-process-gone", {}, { type: "Utility", reason: "killed", exitCode: 9, serviceName: "network.mojom.NetworkService", name: "Network Service" });
    app.emit("child-process-gone", {}, { type: "Utility", reason: "clean-exit", exitCode: 0 });
    expect(lines).toEqual([
      ["app.child_process_gone", { type: "GPU", reason: "crashed", exitCode: 139 }],
      ["app.child_process_gone", { type: "Utility", reason: "killed", exitCode: 9, service: "network.mojom.NetworkService", name: "Network Service" }],
    ]);
  });

  it("logs any page's renderer that went, named by its page", () => {
    const { app, lines } = setup();
    const contents = Object.assign(new EventEmitter(), { getURL: () => "file:///opt/ember/resources/app.asar/dist/app/renderer/prompt/index.html" });
    app.emit("web-contents-created", {}, contents);
    contents.emit("render-process-gone", {}, { reason: "oom", exitCode: 0 });
    expect(lines).toEqual([["window.renderer_gone", { page: "prompt", reason: "oom", exitCode: 0 }]]);
  });

  it("names pages without the user's paths", () => {
    expect(pageName("file:///home/ada/Ember/dist/app/renderer/command/index.html")).toBe("command");
    expect(pageName("file:///C:/Users/ada/AppData/Local/ember/app/renderer/home/index.html#x")).toBe("home");
    expect(pageName("file:///C:\\Users\\ada\\renderer\\desk\\index.html")).toBe("desk");
    expect(pageName("file:///tmp/other.html")).toBe("file");
    expect(pageName("")).toBe("none");
  });
});

describe("card windows whose page crashed (review #91)", () => {
  it("the command and prompt windows close instead of staying on screen blank", async () => {
    const { createCommandWindow, createPromptWindow } = await import("../../app/main/windows");
    for (const make of [() => createCommandWindow("linux"), () => createPromptWindow("linux")]) {
      made.length = 0;
      make();
      const win = made[0];
      expect(win.destroyed).toBe(false);
      win.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
      expect(win.destroyed).toBe(true);
    }
  });

  it("main watches every crash, and the desk view comes back from one", () => {
    const main = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8");
    expect(main).toMatch(/watchCrashes\(app, log\);/);
    const view = fs.readFileSync(path.resolve("app/main/desk/view.ts"), "utf8");
    expect(view).toMatch(/revive\(win, \(\) => \{ this\.releaseAll\(\); this\.setControl\(false\); \}\);/);
  });
});
