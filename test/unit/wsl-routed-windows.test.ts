/**
 * The routed window system (design §4.4, §4.6; critique wsl-2): an identified RAIL window is named
 * "wsl:<distro>:<app>" in every list, so Perception stops blacking it out and the policy judges it as that Linux app;
 * every RAIL window the router hasn't identified (now, within 2 s) keeps "msrdc": masked in every picture and refused.
 * Popups take their window's name in the stack only. Off Windows, or with WSL off, it is the window system itself.
 * OS-neutral fakes.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Perception } from "../../app/main/perception";
import { remoteSurfaceCheck } from "../../app/main/policy/remote-surface";
import { PolicyEngine } from "../../app/main/policy/policy";
import { KEYS } from "../../app/shared/shortcuts";
import type { AtspiSidecar } from "../../app/main/perception/sidecar";
import { wrapWindowsWith } from "../../app/main/wsl/routed-windows";
import { wrapWith } from "../../app/main/wsl/routed-sidecar";
import { dropRouter, routerFor, IDENTITY_MS } from "../../app/main/wsl/router";
import { geditScene, harness, quiet, stacked } from "./wsl-fakes";

const made: ReturnType<typeof harness>[] = [];
afterEach(() => { for (const h of made.splice(0)) dropRouter(routerFor(h.options)); });

/** Ubuntu with gedit (HWND 11) identified, an xterm (HWND 12) nobody can read, and Notepad. */
async function scene(o: { refresh?: boolean; owners?: Record<number, number> } = {}) {
  const h = harness({ owners: o.owners });
  made.push(h);
  h.wsl.add("Ubuntu");
  const s = geditScene(h);
  h.windows.stack.unshift(stacked(1, 300, "todo.txt - Notepad", "notepad", { x: 0, y: 0, width: 90, height: 90 }));
  h.windows.stack.push(stacked(12, 4242, "xterm (Ubuntu)", "msrdc", { x: 950, y: 0, width: 600, height: 400 }));
  h.setups.set("Ubuntu", x => { x.frames = [s.frame]; });
  const ws = wrapWindowsWith(h.windows.ws, h.options, h.deps);
  if (o.refresh !== false) await routerFor(h.options).refresh();
  return { h, s, ws };
}

describe("off Windows and with WSL off", () => {
  it("is the window system itself off Windows", () => {
    const h = harness({ os: "linux" });
    expect(wrapWindowsWith(h.windows.ws, h.options)).toBe(h.windows.ws);
    expect(wrapWindowsWith(h.windows.ws, {} as never)).toBe(h.windows.ws);
  });

  it("lists exactly what the backend lists with WSL off", async () => {
    const h = harness({ on: false });
    made.push(h);
    h.wsl.add("Ubuntu");
    geditScene(h);
    const ws = wrapWindowsWith(h.windows.ws, h.options, h.deps);
    await routerFor(h.options).refresh();
    expect(ws.stack()).toEqual(h.windows.ws.stack());
    expect(ws.clientWindows()).toEqual(h.windows.ws.clientWindows());
    expect(h.created).toEqual([]);
  });
});

describe("renaming identified windows", () => {
  it("names an identified RAIL window wsl:<distro>:<app> in the stack, the app list and as the active window; others keep msrdc", async () => {
    const { ws, h } = await scene();
    expect(ws.stack().map(w => [w.id, w.wmClass])).toEqual([[1, "notepad"], [11, "wsl:Ubuntu:gedit"], [12, "msrdc"]]);
    expect(ws.clientWindows().map(w => [w.id, w.wmClass, w.wmClassName])).toEqual([[12, "msrdc", "RAIL_WINDOW"], [11, "wsl:Ubuntu:gedit", "wsl:Ubuntu:gedit"], [1, "notepad", "RAIL_WINDOW"]]);
    h.windows.foreground = 11;
    expect(ws.activeWindow()?.wmClass).toBe("wsl:Ubuntu:gedit");
    expect(ws.focusWindow()?.wmClass).toBe("wsl:Ubuntu:gedit");
    h.windows.foreground = 12;
    expect(ws.activeWindow()?.wmClass).toBe("msrdc");
  });

  it("names nothing before the router has looked, nor after 2 s without a new look (fail closed: msrdc)", async () => {
    const { ws, h } = await scene({ refresh: false });
    expect(ws.stack().find(w => w.id === 11)?.wmClass).toBe("msrdc");
    await routerFor(h.options).refresh();
    expect(ws.stack().find(w => w.id === 11)?.wmClass).toBe("wsl:Ubuntu:gedit");
    h.state.now += IDENTITY_MS + 1;
    expect(ws.stack().find(w => w.id === 11)?.wmClass).toBe("msrdc");
  });

  it("gives a popup its window's name in the stack only (masking and covering), never as the active window", async () => {
    const { ws, h } = await scene({ refresh: false, owners: { 13: 11 } });
    h.windows.stack.push(stacked(13, 4242, "", "msrdc", { x: 150, y: 260, width: 200, height: 200 }, { overrideRedirect: true }));
    await routerFor(h.options).refresh();
    expect(ws.stack().find(w => w.id === 13)?.wmClass).toBe("wsl:Ubuntu:gedit");
    h.windows.foreground = 13;
    expect(ws.activeWindow()?.wmClass).toBe("msrdc");
  });

  it("renames both windows of a backend's focusAndActive, and adds none to a backend without one (review #78)", async () => {
    const { ws, h } = await scene();
    expect("focusAndActive" in ws && ws.focusAndActive).toBeFalsy();
    const raw = h.windows.ws;
    const both = { ...raw, focusAndActive: () => ({ focus: raw.focusWindow(), active: raw.activeWindow() }) };
    // The same router as the scene's (one per options object), which has looked already.
    const seen = wrapWindowsWith(both, h.options, h.deps);
    h.windows.foreground = 11;
    expect(raw.activeWindow()?.wmClass).toBe("msrdc");
    const r = seen.focusAndActive!();
    expect([r.focus?.wmClass, r.active?.wmClass]).toEqual(["wsl:Ubuntu:gedit", "wsl:Ubuntu:gedit"]);
    h.windows.foreground = 12;
    expect(seen.focusAndActive!().active?.wmClass).toBe("msrdc");
  });

  it("keeps every other member the backend's own, called on the backend (I-win's extras survive)", async () => {
    const { ws, h } = await scene();
    expect((ws as typeof h.windows.ws).extra).toBe("I-win's");
    (ws as typeof h.windows.ws).activate(11);
    expect(h.windows.activated).toEqual([11]);
    expect(ws.screenBounds()).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(ws.kind).toBe("win32");
  });
});

describe("what Perception and the policy make of it (critique wsl-2)", () => {
  it("blacks out only the RAIL windows nobody identified", async () => {
    const { h, ws } = await scene();
    const sidecar = wrapWith({ listWindows: async () => ({ windows: [] }) } as unknown as AtspiSidecar, h.options);
    const perception = new Perception({ sidecar, x11: ws, log: quiet, neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }), ownPid: 999, isRemoteSurface: remoteSurfaceCheck("win32") });
    expect(await perception.privateWindows()).toEqual([{ x: 950, y: 0, width: 600, height: 400 }]);
    // A never-look entry matches the identified app by its new name.
    const careful = new Perception({ sidecar, x11: ws, log: quiet, neverLook: () => ["gedit"], screenBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }), ownPid: 999, isRemoteSurface: remoteSurfaceCheck("win32") });
    expect(await careful.privateWindows()).toEqual(expect.arrayContaining([{ x: 950, y: 0, width: 600, height: 400 }, { x: 100, y: 200, width: 800, height: 600 }]));
  });

  it("refuses acting in an unidentified one and judges an identified one as its Linux app", async () => {
    const { ws } = await scene();
    const engine = new PolicyEngine({ neverLook: () => [], grants: () => ({}), keys: KEYS.win32, os: "win32" });
    const act = (app: string) => engine.decide({ taskId: "t", kind: "click", app, window: "x", element: { role: "push button", name: "Save" } });
    const [gedit, xterm] = [ws.stack().find(w => w.id === 11)!, ws.stack().find(w => w.id === 12)!];
    expect(act(xterm.wmClass)).toMatchObject({ tier: "never", verdict: "deny" });
    expect(act(gedit.wmClass).verdict).toBe("confirm");
  });
});
