/**
 * The routed reader over UIA and the distros' helpers (design §4.4, §4.7, §4.9; critique integration-20): WSL paths and
 * identified RAIL windows go to their distro's helper by the Linux pid and path the router matched (never a Windows
 * pid, skipPids or ownPid), element ids to the helper that handed them out (ownsId), everything else to UIA; positions
 * come back mapped onto the screen, none for a window identified by title only. Off Windows or with WSL off it is
 * UIA's sidecar, call for call. OS-neutral fakes.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AtspiSidecar, AxNode, AxWindow } from "../../app/main/perception/sidecar";
import { RoutedSidecar, wrapWith } from "../../app/main/wsl/routed-sidecar";
import { routerFor } from "../../app/main/wsl/router";
import { geditScene, harness, stacked, type FakeHelper } from "./wsl-fakes";

const UIA_BLOCK = 900 * 10_000_000;

/** UIA's sidecar: what it was asked, and a RAIL window's frame in its list (msrdc, nothing inside). */
function uia() {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec = (method: string, answer: unknown) => (...args: unknown[]) => { calls.push({ method, args }); return Promise.resolve(answer); };
  const windows: AxWindow[] = [
    { app: "notepad", pid: 300, name: "todo.txt - Notepad", role: "frame", active: false, bounds: { x: 0, y: 0, width: 500, height: 400 } },
    { app: "msrdc", pid: 4242, name: "notes.txt - gedit (Ubuntu)", role: "frame", active: true, bounds: { x: 100, y: 200, width: 800, height: 600 } },
  ];
  const info = { role: "push button", name: "OK", states: [], bounds: { x: 1, y: 2, width: 3, height: 4 } };
  const base = {
    listWindows: rec("listWindows", { windows }),
    readWindow: rec("readWindow", { window: null, nodes: [], ms: 1 }),
    atPoint: rec("atPoint", { chain: [], ms: 1 }),
    secretFields: rec("secretFields", { fields: [], complete: true, ms: 1 }),
    markSecret: rec("markSecret", undefined),
    shellOverlays: rec("shellOverlays", { overlays: [] }),
    readElement: rec("readElement", info),
    canDo: rec("canDo", { tier1: true }),
    doAction: rec("doAction", { ok: true, after: null }),
    setText: rec("setText", { ok: true, after: null }),
    setValue: rec("setValue", { ok: true, after: null }),
    selectOption: rec("selectOption", { ok: true, after: null }),
    listOptions: rec("listOptions", { options: [] }),
    scaleElements: (...args: unknown[]) => { calls.push({ method: "scaleElements", args }); },
    scaleOf: () => 2,
    ownsId: (id: number) => id > UIA_BLOCK && id < UIA_BLOCK + 10_000_000,
    stop: () => { calls.push({ method: "stop", args: [] }); },
  };
  return { base: base as unknown as AtspiSidecar, calls };
}

const node = (id: number, role: string, name: string, bounds: AxNode["bounds"], more: Partial<AxNode> = {}): AxNode => ({ id, parent: null, depth: 1, role, name, states: [], bounds, ...more });

const routers: RoutedSidecar[] = [];
afterEach(() => { for (const r of routers.splice(0)) r.stop(); });

/** Ubuntu with gedit identified (transform k 1, dx 74, dy 177), and its helper's nodes. */
async function scene(o: { inner?: { x: number; y: number; width: number; height: number } } = {}) {
  const h = harness();
  h.wsl.add("Ubuntu");
  const s = geditScene(h, o);
  let helper!: FakeHelper;
  h.setups.set("Ubuntu", x => {
    helper = x;
    x.frames = [s.frame];
  });
  const u = uia();
  const routed = wrapWith(u.base, h.options, h.deps) as RoutedSidecar;
  routers.push(routed);
  await routerFor(h.options).refresh();
  const save = helper.id(5), name = helper.id(6), pass = helper.id(7);
  helper.nodes.set(s.frame.path, [
    node(save, "push button", "Save", { x: 36, y: 33, width: 60, height: 30 }, { shown: { x: 36, y: 33, width: 60, height: 20 } }),
    node(name, "text", "Name", { x: 126, y: 83, width: 200, height: 24 }),
    node(pass, "password text", "Password", { x: 126, y: 123, width: 200, height: 24 }, { secret: true }),
  ]);
  return { h, s, u, routed, helper, ids: { save, name, pass } };
}

/** Every request a helper got: none may carry a Windows pid (msrdc's 4242, UIA's 300), skipPids or Ember's own pid. */
function noWindowsPids(helper: FakeHelper) {
  for (const c of helper.calls) {
    expect(c.params.pid === undefined || c.params.pid === 700, JSON.stringify(c)).toBe(true);
    expect(c.params.ownPid, JSON.stringify(c)).toBeUndefined();
    expect((c.params.skipPids as number[] | undefined) ?? [], JSON.stringify(c)).not.toContain(4242);
  }
}

describe("off Windows and with WSL off", () => {
  it("is UIA's (or AT-SPI's) sidecar itself off Windows", () => {
    const u = uia();
    expect(wrapWith(u.base, { ...harness().options, os: "linux" })).toBe(u.base);
    expect(wrapWith(u.base, {} as never)).toBe(u.base);
  });

  it("passes every call to UIA unchanged with WSL off", async () => {
    const h = harness({ on: false });
    h.wsl.add("Ubuntu");
    geditScene(h);
    const u = uia();
    const routed = wrapWith(u.base, h.options, h.deps) as RoutedSidecar;
    routers.push(routed);
    const id = UIA_BLOCK + 3;
    expect((await routed.listWindows({ ownPid: 9 })).windows).toHaveLength(2);
    await routed.readWindow({ pid: 4242, title: "notes.txt - gedit (Ubuntu)", ownPid: 9 });
    await routed.readElement(id);
    await routed.doAction(id, "click");
    await routed.atPoint({ pid: 4242, path: "/x", x: 1, y: 2 });
    await routed.secretFields({ pid: 4242, path: "/x" });
    routed.scaleElements([id], 2);
    expect(routed.scaleOf(id)).toBe(2);
    expect(u.calls.map(c => c.method)).toEqual(["listWindows", "readWindow", "readElement", "doAction", "atPoint", "secretFields", "scaleElements"]);
    expect(u.calls[1].args).toEqual([{ pid: 4242, title: "notes.txt - gedit (Ubuntu)", ownPid: 9 }]);
    expect(h.created).toEqual([]);
  });
});

describe("listing windows", () => {
  it("is UIA's list minus the identified RAIL windows, plus each one as its Linux app with its client area", async () => {
    const { routed } = await scene();
    const { windows } = await routed.listWindows({ ownPid: 9 });
    expect(windows).toEqual([
      { app: "notepad", pid: 300, name: "todo.txt - Notepad", role: "frame", active: false, bounds: { x: 0, y: 0, width: 500, height: 400 } },
      { app: "wsl:Ubuntu:gedit", pid: 4242, path: "wsl:Ubuntu:700:/org/a11y/atspi/accessible/1", name: "notes.txt - gedit", role: "frame", active: false, bounds: { x: 100, y: 200, width: 800, height: 600 } },
    ]);
  });

  it("keeps a RAIL window nobody identified as UIA lists it (msrdc: refused and masked)", async () => {
    const { routed, h } = await scene();
    h.windows.stack.push(stacked(12, 4242, "xterm", "msrdc", { x: 950, y: 0, width: 600, height: 400 }));
    h.state.now += 3000;
    const u = (routed as unknown as { base: { listWindows: () => Promise<{ windows: AxWindow[] }> } }).base;
    const own = await u.listWindows();
    own.windows.push({ app: "msrdc", pid: 4242, name: "xterm", role: "frame", active: false, bounds: { x: 950, y: 0, width: 600, height: 400 } });
    const { windows } = await routed.listWindows();
    expect(windows.filter(w => w.app === "msrdc").map(w => w.name)).toEqual(["xterm"]);
  });
});

describe("reading a WSLg window", () => {
  it("reads it in its distro by the Linux pid and path, never a Windows pid, with positions mapped and its ids remembered", async () => {
    const { routed, helper, ids } = await scene();
    const res = await routed.readWindow({ pid: 4242, title: "notes.txt - gedit (Ubuntu)", ownPid: 9, neverLook: ["keepass"], skipPids: [300], maxNodes: 50 });
    const read = helper.calls.find(c => c.method === "read_window")!;
    expect(read.params).toEqual({ pid: 700, path: "/org/a11y/atspi/accessible/1", neverLook: ["keepass", "keepassxc", "seahorse", "passwords and keys", "1password", "bitwarden", "polkit"], skipPids: [], maxNodes: 50 });
    expect(res.window).toEqual({ app: "wsl:Ubuntu:gedit", pid: 4242, path: "wsl:Ubuntu:700:/org/a11y/atspi/accessible/1", name: "notes.txt - gedit", role: "frame", active: true, bounds: { x: 100, y: 200, width: 800, height: 600 } });
    expect(res.nodes.find(n => n.id === ids.save)).toMatchObject({ bounds: { x: 110, y: 210, width: 60, height: 30 }, shown: { x: 110, y: 210, width: 60, height: 20 } });
    expect(routed.scaleOf(ids.save)).toBe(1);
    noWindowsPids(helper);
  });

  it("reads by its WSL path, and finds nothing for one that has gone", async () => {
    const { routed, helper } = await scene();
    expect((await routed.readWindow({ pid: 4242, path: "wsl:Ubuntu:700:/org/a11y/atspi/accessible/1" })).window?.app).toBe("wsl:Ubuntu:gedit");
    expect(await routed.readWindow({ pid: 4242, path: "wsl:Ubuntu:700:/org/a11y/atspi/accessible/2" })).toMatchObject({ window: null, nodes: [] });
    noWindowsPids(helper);
  });

  it("reads the foreground window when it is identified and nothing is named", async () => {
    const { routed, h, helper } = await scene();
    h.windows.foreground = 11;
    h.state.now += 3000;
    await routed.readWindow({});
    expect(helper.calls.filter(c => c.method === "read_window")).toHaveLength(1);
  });

  it("leaves every other window to UIA: another program's, or a RAIL window by a title nobody identified", async () => {
    const { routed, u, helper } = await scene();
    await routed.readWindow({ pid: 300, title: "todo.txt - Notepad" });
    await routed.readWindow({ pid: 4242, title: "xterm" });
    await routed.readWindow({ title: "Calculator" });
    expect(u.calls.filter(c => c.method === "readWindow").map(c => c.args[0])).toEqual([{ pid: 300, title: "todo.txt - Notepad" }, { pid: 4242, title: "xterm" }, { title: "Calculator" }]);
    expect(helper.calls.filter(c => c.method === "read_window")).toHaveLength(0);
  });

  it("gives no positions in a window identified by its title only", async () => {
    const { routed, ids } = await scene({ inner: { x: 100, y: 200, width: 500, height: 900 } });
    const res = await routed.readWindow({ pid: 4242, title: "notes.txt - gedit (Ubuntu)" });
    expect(res.window?.bounds).toEqual({ x: 100, y: 200, width: 500, height: 900 });
    expect(res.nodes.find(n => n.id === ids.save)).toMatchObject({ bounds: null });
    expect(res.nodes.find(n => n.id === ids.save)?.shown).toBeUndefined();
  });
});

describe("elements", () => {
  it("routes each id to the helper that handed it out, maps what comes back, and refuses an id nobody knows", async () => {
    const { routed, helper, u, ids } = await scene();
    await routed.readWindow({ pid: 4242, title: "notes.txt - gedit (Ubuntu)" });
    expect(await routed.readElement(ids.name)).toMatchObject({ bounds: { x: 200, y: 260, width: 200, height: 24 } });
    expect(await routed.doAction(ids.save)).toMatchObject({ ok: true, before: { bounds: { x: 110, y: 210, width: 60, height: 30 } }, after: { bounds: { x: 110, y: 210, width: 60, height: 30 } } });
    await routed.setText(ids.name, "hello", "replace");
    await routed.setValue(ids.name, 3);
    await routed.selectOption(ids.name, "B");
    expect(await routed.canDo(ids.save, "click")).toEqual({ tier1: true });
    expect(await routed.listOptions(ids.name)).toEqual({ options: ["A", "B"] });
    expect(helper.calls.map(c => c.method).slice(-7)).toEqual(["read_element", "do_action", "set_text", "set_value", "select_option", "can_do", "list_options"]);
    // UIA's ids stay UIA's.
    await routed.readElement(UIA_BLOCK + 1);
    expect(u.calls.at(-1)).toEqual({ method: "readElement", args: [UIA_BLOCK + 1, {}] });
    await expect(routed.readElement(42)).rejects.toThrow("Element 42 is no longer known: call perceive_window again.");
    noWindowsPids(helper);
  });

  it("keeps a helper's ids out of UIA's scaling, and marks secrets where each id came from", async () => {
    const { routed, helper, u, ids } = await scene();
    routed.scaleElements([ids.save, UIA_BLOCK + 2], 2, true);
    expect(u.calls.at(-1)).toEqual({ method: "scaleElements", args: [[UIA_BLOCK + 2], 2, true] });
    await routed.markSecret([ids.pass, UIA_BLOCK + 2]);
    expect(helper.calls.at(-1)).toEqual({ method: "mark_secret", params: { ids: [ids.pass] } });
    expect(u.calls.at(-1)).toEqual({ method: "markSecret", args: [[UIA_BLOCK + 2]] });
  });

  it("refuses a helper's ids once WSL is turned off", async () => {
    const { routed, h, ids } = await scene();
    h.state.on = false;
    await expect(routed.readElement(ids.save)).rejects.toThrow("no longer known");
  });

  it("starts a helper that went again through the checks (an uncached running list first), then answers", async () => {
    const { routed, h, helper, ids } = await scene();
    await routed.readWindow({ pid: 4242, title: "notes.txt - gedit (Ubuntu)" });
    helper.crash();
    const before = h.wsl.runningNowCalls;
    await expect(routed.readElement(ids.save)).rejects.toThrow("unknown element"); // the new process doesn't know the old ids
    expect(h.wsl.runningNowCalls).toBe(before + 1);
    expect(helper.calls.filter(c => c.method === "status")).toHaveLength(2);
  });
});

describe("points and secret fields", () => {
  it("maps a point into the app's pixels and the answer back onto the screen", async () => {
    const { routed, helper } = await scene();
    helper.chain = { chain: [{ role: "push button", name: "Save", bounds: { x: 36, y: 33, width: 60, height: 30 } }], ms: 3 };
    const res = await routed.atPoint({ pid: 4242, path: "wsl:Ubuntu:700:/org/a11y/atspi/accessible/1", x: 120, y: 220, ownPid: 9, skipPids: [300], menus: false });
    expect(helper.calls.at(-1)).toEqual({ method: "at_point", params: expect.objectContaining({ pid: 700, path: "/org/a11y/atspi/accessible/1", x: 46, y: 43, skipPids: [], menus: false }) });
    expect(res.chain).toEqual([{ role: "push button", name: "Save", bounds: { x: 110, y: 210, width: 60, height: 30 } }]);
    noWindowsPids(helper);
  });

  it("refuses points in a window identified by title only", async () => {
    const { routed, helper } = await scene({ inner: { x: 100, y: 200, width: 500, height: 900 } });
    expect(await routed.atPoint({ pid: 4242, path: "wsl:Ubuntu:700:/org/a11y/atspi/accessible/1", x: 120, y: 220 })).toEqual({ chain: [], found: false, ms: 0 });
    expect(helper.calls.some(c => c.method === "at_point")).toBe(false);
  });

  it("maps secret fields; without a transform, blacks out the whole window when there is any (or it can't tell)", async () => {
    const mapped = await scene();
    mapped.helper.secrets = { fields: [{ id: mapped.ids.pass, role: "password text", bounds: { x: 126, y: 123, width: 200, height: 24 } }], complete: true, ms: 2 };
    expect((await mapped.routed.secretFields({ pid: 4242, path: "wsl:Ubuntu:700:/org/a11y/atspi/accessible/1" })).fields)
      .toEqual([{ id: mapped.ids.pass, role: "password text", bounds: { x: 200, y: 300, width: 200, height: 24 } }]);

    const whole = { x: 100, y: 200, width: 500, height: 900 };
    const titled = await scene({ inner: whole });
    const path = { pid: 4242, path: "wsl:Ubuntu:700:/org/a11y/atspi/accessible/1" };
    expect(await titled.routed.secretFields(path)).toEqual({ fields: [], complete: true, ms: 1 });
    titled.helper.secrets = { fields: [{ id: titled.ids.pass, role: "password text", bounds: { x: 1, y: 1, width: 2, height: 2 } }], complete: true, ms: 2 };
    expect((await titled.routed.secretFields(path)).fields).toEqual([{ id: titled.ids.pass, role: "password text", bounds: whole }]);
    titled.helper.secrets = { fields: [], complete: false, ms: 2 };
    expect(await titled.routed.secretFields(path)).toEqual({ fields: [{ id: 0, role: "password text", bounds: whole }], complete: true, ms: 2 });
    titled.helper.secretsError = new Error("the app is busy");
    expect((await titled.routed.secretFields(path)).fields).toEqual([{ id: 0, role: "password text", bounds: whole }]);
    // With a transform a failure stays a failure (no picture).
    mapped.helper.secretsError = new Error("the app is busy");
    await expect(mapped.routed.secretFields(path)).rejects.toThrow("busy");
  });

  it("leaves UIA's windows' points and secret fields to UIA", async () => {
    const { routed, u } = await scene();
    await routed.atPoint({ pid: 300, path: "/uia/1", x: 1, y: 1 });
    await routed.secretFields({ pid: 300, path: "/uia/1" });
    expect(u.calls.map(c => c.method).slice(-2)).toEqual(["atPoint", "secretFields"]);
  });
});

describe("a helper that runs as root", () => {
  it("is never routed to: its distro's windows stay UIA's (msrdc)", async () => {
    const h = harness();
    h.wsl.add("Ubuntu");
    const s = geditScene(h);
    h.setups.set("Ubuntu", x => { x.uid = 0; x.frames = [s.frame]; });
    const u = uia();
    const routed = wrapWith(u.base, h.options, h.deps) as RoutedSidecar;
    routers.push(routed);
    await routed.readWindow({ pid: 4242, title: "notes.txt - gedit (Ubuntu)" });
    expect(u.calls.filter(c => c.method === "readWindow")).toHaveLength(1);
    expect((await routed.listWindows()).windows.map(w => w.app)).toEqual(["notepad", "msrdc"]);
    expect(h.helpers[0].calls.map(c => c.method)).toEqual(["status"]);
  });
});

describe("stopping", () => {
  it("stops UIA's helper and every distro's", async () => {
    const { routed, helper, u } = await scene();
    routers.splice(routers.indexOf(routed), 1);
    routed.stop();
    expect(u.calls.at(-1)?.method).toBe("stop");
    expect(helper.stopped).toBe(1);
  });
});
