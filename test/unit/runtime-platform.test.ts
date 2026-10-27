/** locateRuntime per OS (design §4.17, §9.7): each OS's Copilot SDK package and runtime file name; Linux unchanged. */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { locateRuntime, runtimeFor, runtimeRelative } from "../../app/main/agent/runtime";

const app = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-app-"));
const place = (root: string, rel: string, mode = 0o644) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "", { mode });
  return p;
};

describe("runtimeFor", () => {
  it("names each OS's SDK package and file as the SDK's resolver does", () => {
    expect(runtimeFor("linux", "x64")).toEqual({ id: "linux-x64", exe: "copilot-runtime" });
    expect(runtimeFor("linux", "arm64")).toEqual({ id: "linux-x64", exe: "copilot-runtime" });
    expect(runtimeFor("win32", "x64")).toEqual({ id: "win32-x64", exe: "copilot-runtime.exe" });
    expect(runtimeFor("win32", "arm64")).toEqual({ id: "win32-arm64", exe: "copilot-runtime.exe" });
    expect(runtimeFor("darwin", "arm64")).toEqual({ id: "darwin-arm64", exe: "copilot-runtime" });
    expect(runtimeFor("darwin", "x64")).toEqual({ id: "darwin-x64", exe: "copilot-runtime" });
  });
});

describe("locateRuntime", () => {
  it("defaults to today's Linux path", () => {
    expect(runtimeRelative()).toBe(path.join("node_modules", "@github", "copilot-sdk-linux-x64", "prebuilds", "linux-x64", "copilot-runtime"));
    const root = app();
    const p = place(root, runtimeRelative(), 0o755);
    expect(locateRuntime({ appPath: root, env: {} })).toEqual({ path: p, exists: true });
  });

  it("finds the Windows runtime by its id and .exe name", () => {
    const root = app();
    const rel = path.join("node_modules", "@github", "copilot-sdk-win32-x64", "prebuilds", "win32-x64", "copilot-runtime.exe");
    expect(runtimeRelative("win32-x64", "copilot-runtime.exe")).toBe(rel);
    const p = place(root, rel);
    expect(locateRuntime({ appPath: root, env: {}, runtimeId: "win32-x64", exe: "copilot-runtime.exe" })).toEqual({ path: p, exists: true });
    // Only the read-only bit exists on Windows: an .exe is never chmodded.
    if (process.platform !== "win32") expect(fs.statSync(p).mode & 0o111).toBe(0);
  });

  it("finds the macOS runtime unpacked beside a packaged app's asar, and makes it executable", () => {
    const res = app();
    const rel = runtimeRelative("darwin-arm64", "copilot-runtime");
    const p = place(path.join(res, "app.asar.unpacked"), rel, 0o644);
    expect(locateRuntime({ appPath: path.join(res, "app.asar"), resourcesPath: res, env: {}, runtimeId: "darwin-arm64", exe: "copilot-runtime" })).toEqual({ path: p, exists: true });
    if (process.platform !== "win32") expect(fs.statSync(p).mode & 0o111).not.toBe(0);
  });

  it("reports the app folder's path when it is missing (for the doctor), and still honours EMBER_COPILOT_RUNTIME", () => {
    const root = app();
    expect(locateRuntime({ appPath: root, env: {}, runtimeId: "win32-arm64", exe: "copilot-runtime.exe" }))
      .toEqual({ path: path.join(root, runtimeRelative("win32-arm64", "copilot-runtime.exe")), exists: false });
    const fake = place(app(), "copilot-runtime.exe");
    expect(locateRuntime({ appPath: root, env: { EMBER_COPILOT_RUNTIME: fake }, runtimeId: "win32-x64", exe: "copilot-runtime.exe" })).toEqual({ path: fake, exists: true });
  });
});
