/**
 * loadPlatform() (platform/index.ts): the one place that picks the OS backend, by the OS alone (never by $DISPLAY), and
 * that imports and builds on any OS without loading a native library (they load when a window system or input opens).
 * koffi is a fake here, put in Node's require cache, so a load anywhere in the graph would show.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { ElectronParts, PlatformDeps } from "../../app/main/platform/types";

const loads: string[] = [];
const requireCjs = createRequire(import.meta.url);
const koffiPath = requireCjs.resolve("koffi");
let realKoffi: NodeModule | undefined;

beforeAll(() => {
  realKoffi = requireCjs.cache[koffiPath];
  const fake = { load(name: string) { loads.push(name); throw new Error(`${name} isn't here`); } };
  requireCjs.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: fake } as unknown as NodeModule;
});

afterAll(() => {
  if (realKoffi) requireCjs.cache[koffiPath] = realKoffi;
  else delete requireCjs.cache[koffiPath];
});

function deps(env: NodeJS.ProcessEnv): PlatformDeps {
  const nothing = new Proxy({}, { get(_t, key) { throw new Error(`${String(key)} touched while building the platform`); } });
  const electron = {
    app: { isPackaged: false, getPath: () => { throw new Error("app.getPath before ready"); }, getAppPath: () => "/repo", getVersion: () => "0", isAccessibilitySupportEnabled: () => false, setLoginItemSettings: () => undefined, getLoginItemSettings: () => ({ openAtLogin: false }), focus: () => undefined },
    screen: nothing, desktopCapturer: nothing, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) },
    shell: { openExternal: async () => undefined }, powerMonitor: nothing, browserWindow: nothing,
  } as unknown as ElectronParts;
  return { electron, packaged: false, execPath: "/repo/electron", appPath: "/repo", resourcesPath: "/repo/resources", env };
}

describe("loadPlatform", () => {
  it("imports without loading a native library", async () => {
    await import("../../app/main/platform");
    expect(loads).toEqual([]);
  });

  it("picks Linux's platform for Linux, whatever $DISPLAY says (a Wayland or headless session is still Linux)", async () => {
    const { loadPlatform } = await import("../../app/main/platform");
    expect(loadPlatform(deps({ DISPLAY: ":0" }), "linux").os).toBe("linux");
    expect(loadPlatform(deps({ WAYLAND_DISPLAY: "wayland-0" }), "linux").os).toBe("linux");
    expect(loadPlatform(deps({}), "linux").os).toBe("linux");
    expect(loads).toEqual([]);
  });

  it("picks Windows' and macOS's own platforms for those OSes, building each without touching Electron or loading a library", async () => {
    const { loadPlatform } = await import("../../app/main/platform");
    const win = loadPlatform(deps({}), "win32");
    expect(win.os).toBe("win32");
    expect(win.desk).toBeNull();
    const mac = loadPlatform(deps({}), "darwin");
    expect(mac.os).toBe("darwin");
    expect(mac.desk).toBeNull();
    expect(loads).toEqual([]);
  });

  it("gives an OS it has no backend for Linux's platform, which fails the setup check's platform row (as today)", async () => {
    const { loadPlatform } = await import("../../app/main/platform");
    for (const os of ["freebsd", "openbsd", "aix", "sunos"] as const) expect(loadPlatform(deps({}), os).os).toBe("linux");
    expect(loads).toEqual([]);
  });

  it("asks the process's own OS when none is given", async () => {
    const { loadPlatform } = await import("../../app/main/platform");
    const p = loadPlatform(deps({}));
    expect(p.os).toBe(process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux");
  });
});
