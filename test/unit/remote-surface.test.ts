/**
 * Remote surfaces on Windows (wsl.md §1.3, §6.4, §11 item 1): a WSLg app's window and a remote desktop's are one
 * program to Ember ("msrdc", "mstsc"), whatever runs inside, so every action in one is refused, whatever the grant, and
 * every screenshot blacks it out. Linux and macOS, and every other Windows app, decide and capture as before.
 */

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { KEYS } from "../../app/shared/shortcuts";
import { PolicyEngine, type ActionKind, type ActionRequest } from "../../app/main/policy/policy";
import { REMOTE_SURFACE, isRemoteSurface, isWindowsXServer, isWslgImage, remoteSurfaceCheck } from "../../app/main/policy/remote-surface";
import { runningXServer } from "../../app/main/wsl/doctor";
import { Perception } from "../../app/main/perception";
import type { AtspiSidecar, AxWindow, Bounds } from "../../app/main/perception/sidecar";
import type { PerceptionWindows, StackedWindow, X11Image } from "../../app/main/platform/types";
import type { Logger } from "../../app/main/logger";
import type { OS } from "../../app/shared/shortcuts";

const REASON = "Ember can't tell what's inside a remote window (a remote desktop, a virtual machine, or a Linux app under WSL), so it never acts in one";

/** Every kind of action that acts in a window: accessibility, typing, clicks and the borrowed cursor. */
const IN_WINDOW: ActionKind[] = ["click", "toggle", "text", "select", "value", "cursor_click", "cursor_text", "keys", "scroll"];

const engine = (os: OS, grants: Record<string, "observe" | "act"> = {}) =>
  new PolicyEngine({ neverLook: () => [], grants: () => grants, keys: KEYS[os], os });

/** A request of `kind` in `app`'s window `window`, with what that kind needs. */
const request = (kind: ActionKind, app: string, window = "Untitled"): ActionRequest => ({
  taskId: "t", kind, app, window,
  element: { role: kind === "text" || kind === "cursor_text" ? "text" : "push button", name: kind === "text" || kind === "cursor_text" ? "Message" : "Open" },
  ...(kind === "text" || kind === "cursor_text" ? { value: "hello", mode: "replace" as const } : {}),
  ...(kind === "keys" ? { value: "a" } : {}),
  ...(kind === "scroll" ? { value: "down" } : {}),
  ...(kind === "value" ? { value: "5" } : {}),
  ...(kind === "select" ? { value: "Large" } : {}),
});

describe("which windows are remote surfaces", () => {
  it("knows WSLg's and Windows' Remote Desktop clients' programs on Windows, with or without .exe and any case", () => {
    for (const p of ["msrdc", "MSRDC.EXE", "mstsc", "mstsc.exe", " Mstsc ", "msrdcw", "Windows365", "RdClient.Windows", "rdclient.windows.exe"]) {
      expect(isRemoteSurface(p, "win32"), p).toBe(true);
    }
  });

  it("knows the X servers for Windows, whose windows are Linux apps nobody can tell apart (critique wsl-15)", () => {
    for (const p of ["vcxsrv", "VcXsrv.exe", "x410", "X410.EXE", "xming", "Xming.exe", "xwin", "XWin.exe", "gwsl", "GWSL.exe"]) {
      expect(isRemoteSurface(p, "win32"), p).toBe(true);
      expect(isWindowsXServer(p, "win32"), p).toBe(true);
    }
    for (const p of ["msrdc", "mstsc", "xwinwrap", "x4100", "notepad", "gwslx", "gwsl-notes"]) expect(isWindowsXServer(p, "win32"), p).toBe(false);
    for (const os of ["linux", "darwin"] as const) for (const p of ["vcxsrv", "xwin", "gwsl"]) {
      expect(isRemoteSurface(p, os), `${os} ${p}`).toBe(false);
      expect(isWindowsXServer(p, os), `${os} ${p}`).toBe(false);
    }
  });

  it("knows GWSL's own X server by its real program names (GWSL_vcxsrv, GWSL_vcxsrv_lowdpi), as the WSL doctor does", () => {
    // GWSL shows Linux apps through its bundled VcXsrv, VCXSRV/GWSL_vcxsrv{,_lowdpi}.exe: the Windows backend names their
    // windows' app by the program's file name.
    for (const p of ["GWSL_vcxsrv", "GWSL_vcxsrv.exe", "gwsl_vcxsrv_lowdpi", "GWSL_vcxsrv_lowdpi.exe", "GWSL_service"]) {
      expect(isRemoteSurface(p, "win32"), p).toBe(true);
      expect(isWindowsXServer(p, "win32"), p).toBe(true);
      expect(runningXServer([`${p.replace(/\.exe$/i, "")}.exe`]), p).toBe("GWSL");
    }
    for (const os of ["linux", "darwin"] as const) expect(isRemoteSurface("GWSL_vcxsrv", os), os).toBe(false);
  });

  it("takes no ordinary Windows app for one, nor a name that only contains one", () => {
    for (const p of ["", "notepad", "msedge", "explorer", "winword", "Code", "WindowsTerminal", "msrdcx", "xmstsc", "mstsc-notes", "Windows365Setup", "RdClient"]) {
      expect(isRemoteSurface(p, "win32"), p).toBe(false);
    }
  });

  it("knows none of Windows' clients on Linux and macOS (their own viewers are theirs: remote-surface-viewers.test.ts, review #118)", () => {
    for (const os of ["linux", "darwin"] as const) {
      expect(REMOTE_SURFACE[os]).not.toBeNull();
      for (const p of ["msrdc", "mstsc", "msrdcw", "Windows365", "RdClient.Windows"]) expect(isRemoteSurface(p, os), `${os} ${p}`).toBe(false);
    }
    expect(remoteSurfaceCheck("win32")?.("msrdc.exe")).toBe(true);
    expect(remoteSurfaceCheck("win32")?.("notepad")).toBe(false);
  });

  it("tells WSLg's msrdc from a Remote Desktop client's by its folder (the WSL router identifies only WSLg's)", () => {
    expect(isWslgImage("C:\\Program Files\\WSL\\msrdc.exe")).toBe(true);
    expect(isWslgImage("\\Device\\HarddiskVolume3\\Program Files\\WSL\\MSRDC.EXE")).toBe(true);
    expect(isWslgImage("C:\\Program Files\\WindowsApps\\MicrosoftCorporationII.WindowsSubsystemForLinux_1.2.5.0_x64__8wekyb3d8bbwe\\msrdc.exe")).toBe(true);
    expect(isWslgImage("C:\\Program Files\\Remote Desktop\\msrdc.exe")).toBe(false);
    expect(isWslgImage("C:\\Program Files\\WindowsApps\\MicrosoftCorporationII.Windows365_2.0.505.0_x64__8wekyb3d8bbwe\\msrdc.exe")).toBe(false);
    expect(isWslgImage("C:\\Program Files\\WSL\\wslg.exe")).toBe(false);
    expect(isWslgImage("")).toBe(false);
  });
});

describe("the policy in a remote surface on Windows", () => {
  it("refuses every kind of action in a WSLg app's or a remote desktop's window, with the reason in plain words", () => {
    // A Linux terminal and a polkit prompt under WSLg pass the Windows terminal and security checks by name.
    for (const [app, title] of [["msrdc", "ada@laptop: ~"], ["msrdc", "Authentication Required"], ["mstsc", "build-server - Remote Desktop Connection"],
      ["msrdc.exe", "gedit"], ["Windows365", "Windows App"], ["vcxsrv", "xterm"], ["x410", "gedit"], ["GWSL", "Authentication Required"], ["GWSL_vcxsrv", "ana@pc: ~"], ["GWSL_vcxsrv_lowdpi", "pinentry"]]) {
      for (const kind of IN_WINDOW) {
        const d = engine("win32").decide(request(kind, app, title));
        expect(d, `${kind} in ${app}`).toMatchObject({ tier: "never", verdict: "deny", reason: REASON });
      }
    }
  });

  it("can't be granted: no \"Always\" is offered, and a grant kept from before covers nothing", () => {
    const granted = engine("win32", { msrdc: "act", mstsc: "act" });
    for (const app of ["msrdc", "mstsc"]) {
      for (const kind of IN_WINDOW) {
        const d = granted.decide(request(kind, app));
        expect(d.verdict, `${kind} in ${app}`).toBe("deny");
        expect(d.reason).toBe(REASON);
        expect(d.needsGrant).toBeUndefined();
        expect(d.remember).toBeUndefined();
      }
    }
  });

  it("leaves reading its title and launching the client as they were", () => {
    expect(engine("win32").decide(request("read", "msrdc"))).toMatchObject({ tier: "read", verdict: "allow" });
    expect(engine("win32").decide({ taskId: "t", kind: "open_app", app: "mstsc", window: "", value: "mstsc" })).toMatchObject({ verdict: "allow" });
  });

  it("leaves every other Windows app as it was: the first action asks to work there, a grant allows", () => {
    for (const app of ["notepad", "msedge", "msrdcx"]) {
      const first = engine("win32").decide(request("click", app));
      expect(first, app).toMatchObject({ tier: "reversible", verdict: "confirm", needsGrant: true });
      expect(engine("win32", { [app]: "act" }).decide(request("click", app)), app).toMatchObject({ tier: "reversible", verdict: "allow" });
    }
  });

  it("decides the same names on Linux and macOS as before: an app like any other", () => {
    for (const os of ["linux", "darwin"] as const) {
      for (const app of ["msrdc", "mstsc"]) {
        for (const kind of IN_WINDOW) expect(engine(os, { [app]: "act" }).decide(request(kind, app)).tier, `${os} ${kind} in ${app}`).not.toBe("never");
        expect(engine(os).decide(request("click", app)), `${os} ${app}`).toMatchObject({ tier: "reversible", verdict: "confirm", needsGrant: true });
        expect(engine(os, { [app]: "act" }).decide(request("click", app)), `${os} ${app}`).toMatchObject({ tier: "reversible", verdict: "allow" });
      }
    }
  });
});

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const SCREEN: Bounds = { x: 0, y: 0, width: 300, height: 200 };
const top = (id: number, pid: number, wmClass: string, r: Bounds, title = ""): StackedWindow =>
  ({ id, client: id, pid, title, wmClass, ...r, outer: r, inner: r, overrideRedirect: false });
/** Notepad on the left, a WSLg app (msrdc) on the right. */
const NOTEPAD = top(1, 42, "notepad", { x: 0, y: 0, width: 150, height: 200 }, "notes.txt - Notepad");
const RAIL = top(2, 77, "msrdc", { x: 150, y: 0, width: 150, height: 200 }, "ada@laptop: ~");

/** A pretend Windows desktop: the sidecar's answers, and a window system whose stack is `stack()`. */
function desktop(o: { stack: () => StackedWindow[]; remote?: (app: string) => boolean; neverLook?: string[] }) {
  const notepad: AxWindow = { app: "notepad", pid: 42, name: "notes.txt - Notepad", role: "frame", active: true, bounds: { x: 0, y: 0, width: 150, height: 200 } };
  let captured = false;
  const sidecar = {
    readWindow: async () => ({ window: notepad, nodes: [], ms: 1 }),
    listWindows: async () => ({ windows: [notepad] }),
    scaleElements: () => undefined,
    markSecret: async () => undefined,
    readElement: async () => ({ role: "text", name: "", states: [], bounds: null }),
    shellOverlays: async () => ({ overlays: [] }),
    secretFields: async () => ({ fields: [], complete: true, ms: 1 }),
  } as unknown as AtspiSidecar;
  const ws = {
    stack: () => o.stack(),
    activeWindow: () => ({ id: 1, pid: 42, title: NOTEPAD.title, wmClass: "notepad", x: 0, y: 0, width: 150, height: 200 }),
    focusWindow: () => null,
    clientWindows: () => [],
    capture: (x: number, y: number, width: number, height: number): X11Image => {
      captured = true;
      return { x, y, width, height, bgra: Buffer.alloc(width * height * 4, 200) };
    },
  } as unknown as PerceptionWindows;
  const perception = new Perception({
    sidecar, x11: ws, log: quiet, neverLook: () => o.neverLook ?? [], screenBounds: () => SCREEN, ownPid: 999,
    ...(o.remote ? { isRemoteSurface: o.remote } : {}),
  });
  return { perception, captured: () => captured };
}

/** The colour at screen point x, y of a capture (scale 1 here). */
async function at(c: { data: Buffer; rect: Bounds }, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(c.data).raw().toBuffer({ resolveWithObject: true });
  const i = ((y - c.rect.y) * info.width + (x - c.rect.x)) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}
const isBlack = (p: number[]) => p.every(v => v < 40);
const isGrey = (p: number[]) => p.every(v => v > 160 && v < 240);

describe("screenshots with a remote surface on screen", () => {
  it("blacks out a WSLg app's window on Windows even with nothing on the never-look list", async () => {
    const { perception } = desktop({ stack: () => [NOTEPAD, RAIL], remote: remoteSurfaceCheck("win32") });
    expect(await perception.privateWindows()).toEqual([{ x: 150, y: 0, width: 150, height: 200 }]);
    const p = await perception.perceive({ image: true, scope: "screen" });
    expect(p.capture).not.toBeNull();
    expect(isBlack(await at(p.capture!, 220, 100))).toBe(true);
    expect(isGrey(await at(p.capture!, 60, 100))).toBe(true);
  });

  it("blacks out an X server's window (VcXsrv) the same way", async () => {
    const xserver = top(4, 88, "vcxsrv", { x: 150, y: 0, width: 150, height: 200 }, "xterm");
    const { perception } = desktop({ stack: () => [NOTEPAD, xserver], remote: remoteSurfaceCheck("win32") });
    expect(await perception.privateWindows()).toEqual([{ x: 150, y: 0, width: 150, height: 200 }]);
  });

  it("blacks it out beside the never-look windows", async () => {
    const vault = top(3, 50, "KeePassXC", { x: 0, y: 0, width: 50, height: 50 }, "vault");
    const { perception } = desktop({ stack: () => [NOTEPAD, vault, RAIL], remote: remoteSurfaceCheck("win32"), neverLook: ["keepassxc"] });
    expect(await perception.privateWindows()).toEqual(expect.arrayContaining([{ x: 150, y: 0, width: 150, height: 200 }, { x: 0, y: 0, width: 50, height: 50 }]));
  });

  it("blacks out one that opens while the picture is taken", async () => {
    const d = desktop({ stack: () => (d.captured() ? [NOTEPAD, RAIL] : [NOTEPAD]), remote: remoteSurfaceCheck("win32") });
    const p = await d.perception.perceive({ image: true, scope: "screen" });
    expect(p.capture).not.toBeNull();
    expect(isBlack(await at(p.capture!, 220, 100))).toBe(true);
    expect(isGrey(await at(p.capture!, 60, 100))).toBe(true);
  });

  it("takes no picture on Windows when the windows can't be listed (fail closed)", async () => {
    const { perception } = desktop({ stack: () => { throw new Error("no windows"); }, remote: remoteSurfaceCheck("win32") });
    expect(await perception.privateWindows()).toBeNull();
    const p = await perception.perceive({ image: true, scope: "screen" });
    expect(p.capture).toBeNull();
  });

  it("captures as before without the check (Linux and macOS): nothing blacked out, nothing more asked", async () => {
    const { perception } = desktop({ stack: () => [NOTEPAD, RAIL], remote: remoteSurfaceCheck("linux") });
    expect(await perception.privateWindows()).toEqual([]);
    const p = await perception.perceive({ image: true, scope: "screen" });
    expect(isGrey(await at(p.capture!, 220, 100))).toBe(true);
    // An unreadable stack with nothing on the never-look list didn't stop a picture before, and doesn't now.
    const failing = desktop({ stack: () => { throw new Error("no windows"); } });
    expect(await failing.perception.privateWindows()).toEqual([]);
  });
});
