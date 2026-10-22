import { describe, expect, it } from "vitest";
import { AX_ERROR } from "../../app/main/platform/darwin/ax";
import { Host } from "../../app/sidecar-host/host";
import type { RawNode, RawWindow } from "../../app/sidecar-host/provider";
import { AxDarwinProvider, KEY_MODE, answerKeys, coversDisplay } from "../../app/sidecar-host/providers/ax-darwin";
import { NEEDS_PERMISSION } from "../../app/sidecar-host/providers/ax-darwin-read";
import { axOverlayRole } from "../../app/sidecar-host/roles";
import { windowRole } from "../../app/sidecar-host/windows";
import type { AxNode, AxWindow, ElementInfo, ReadWindowResult as ClientRead } from "../../app/main/perception/sidecar";
import { FakeAx, benchApp, type AppSpec } from "./sidecar-host-ax-darwin-fake";

const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
/** A read_window answer as the host gives it (the client keeps the secret keys to itself). */
type ReadWindowResult = ClientRead & { secretKeys?: [string, string][] };
const BENCH = 4300;
const EMBER = 777;
/** Ember itself, with its home window and a floating panel (its overlay). */
const emberApp = (): AppSpec => ({
  pid: EMBER, owner: "Ember", windows: [
    { role: "AXWindow", title: "Ember", frame: at(900, 100, 400, 500), windowId: 5001, children: [{ role: "AXButton", title: "Settings", frame: at(910, 110, 80, 20) }] },
  ],
});

function setup(apps: AppSpec[] = [benchApp(), emberApp()], o: { open?: boolean } = {}) {
  const fake = new FakeAx(apps);
  const notes: [string, Record<string, unknown> | undefined][] = [];
  let slept = 0;
  const p = new AxDarwinProvider({
    // `self`: the pretend apps' pids may be this test process's own.
    open: () => (o.open === false ? null : fake), openError: () => new Error("koffi is missing"), owner: EMBER, self: 0,
    note: (e, f) => notes.push([e, f]), now: fake.now, sleep: async ms => { slept += ms; },
  });
  return { fake, p, notes, slept: () => slept };
}
/** A started provider and its window list. */
async function started(apps?: AppSpec[]) {
  const s = setup(apps);
  await s.p.start();
  return { ...s, windows: await s.p.topWindows() };
}
const bench = (ws: RawWindow[]) => ws.find(w => w.title === "Ember Bench (macOS)")!;

describe("starting the macOS AX provider", () => {
  it("says the Accessibility permission is missing until it is granted, and status says why (fail closed)", async () => {
    const { fake, p, notes } = setup();
    fake.trustedAnswer = false;
    expect(p.health()).toEqual({ ok: null });
    await expect(p.start()).rejects.toMatchObject({ code: "denied", message: NEEDS_PERMISSION });
    expect(p.health()).toEqual({ ok: false, detail: "macOS hasn't given Ember the Accessibility permission" });
    await expect(p.topWindows()).rejects.toThrow();
    const host = new Host(p, { settleMs: 0, ownerPid: EMBER });
    const status = JSON.parse((await host.handle('{"id":1,"method":"status","params":{}}'))!).result;
    expect(status).toMatchObject({ toolkitAccessibility: false, apps: 0, detail: "macOS hasn't given Ember the Accessibility permission" });
    const read = JSON.parse((await host.handle('{"id":2,"method":"read_window","params":{}}'))!);
    expect(read.error.message).toBe(NEEDS_PERMISSION);
    expect(fake.calls).toEqual([]);
    expect(notes.filter(([e]) => e === "ax.untrusted")).toHaveLength(1);
    fake.trustedAnswer = true;
    await p.start();
    expect(p.health()).toEqual({ ok: true });
    expect(await p.accessibility()).toBe(true);
  });

  it("fails closed, saying why, when the AX API can't be loaded", async () => {
    const { p } = setup(undefined, { open: false });
    await expect(p.start()).rejects.toMatchObject({ code: "failed", message: "the macOS accessibility API couldn't be loaded (koffi is missing)" });
    expect(p.health()).toMatchObject({ ok: false });
    expect(await p.accessibility()).toBeNull();
  });
});

describe("the macOS AX provider's window list", () => {
  it("lists an app's windows by CGWindowID, with the window server's owner name, and the one the user is in", async () => {
    const { windows } = await started();
    expect(bench(windows)).toMatchObject({
      key: "9001", native: 9001, pid: BENCH, app: "osascript", platformRole: "AXWindow", platformSubrole: "AXStandardWindow",
      bounds: at(100, 100, 480, 600), active: true, offscreen: false,
    });
    expect(bench(windows).handle).toBeGreaterThan(0);
    expect(windowRole(bench(windows), "ax")).toBe("frame");
  });

  it("lists Ember's own windows from the window list alone, and never asks Ember's process anything", async () => {
    const { fake, p, windows } = await started();
    const own = windows.filter(w => w.pid === EMBER);
    expect(own).toEqual([expect.objectContaining({ handle: 0, key: "5001", app: "Ember", native: 5001 })]);
    await p.snapshot(bench(windows).handle, { maxDepth: 64, maxNodes: 1000, deadlineMs: 1500 });
    expect(await p.elementsAt(950, 120, EMBER)).toEqual([]);
    expect(fake.pidsAsked.has(EMBER)).toBe(false);
  });

  it("never asks its own process anything either", async () => {
    const fake = new FakeAx([benchApp()]);
    const p = new AxDarwinProvider({ open: () => fake, owner: EMBER, self: BENCH, now: fake.now });
    await p.start();
    expect((await p.topWindows()).find(w => w.pid === BENCH)).toMatchObject({ handle: 0, key: "9001", app: "osascript" });
    expect(await p.elementsAt(380, 670, BENCH)).toEqual([]);
    expect(fake.pidsAsked.has(BENCH)).toBe(false);
  });

  it("lists the system's credential prompts, the lock screen and Mission Control without asking them anything, for shell_overlays", async () => {
    const s = setup();
    s.fake.extraWindows = [
      { id: 1, pid: 88, owner: "SecurityAgent", title: "", bounds: at(500, 300, 440, 280), layer: 1000, alpha: 1 },
      { id: 2, pid: 89, owner: "Dock", title: "", bounds: at(0, 0, 1440, 900), layer: 20, alpha: 1 },
      { id: 3, pid: 89, owner: "Dock", title: "", bounds: at(0, 860, 1440, 40), layer: 20, alpha: 1 },
      { id: 4, pid: 90, owner: "loginwindow", title: "", bounds: at(0, 0, 1440, 900), layer: 2000, alpha: 1 },
      { id: 5, pid: 90, owner: "loginwindow", title: "", bounds: at(600, 400, 200, 100), layer: 0, alpha: 1 },
      { id: 6, pid: 91, owner: "Control Center", title: "", bounds: at(1200, 0, 100, 24), layer: 0, alpha: 1 },
    ];
    await s.p.start();
    const ws = await s.p.topWindows();
    const system = ws.filter(w => [88, 89, 90, 91].includes(w.pid));
    expect(system.map(w => [w.key, axOverlayRole(w), windowRole(w, "ax"), w.handle])).toEqual([
      ["1", "dialog", "dialog", 0], ["2", "overview", "window", 0], ["4", "dialog", "dialog", 0],
    ]);
    expect(axOverlayRole(bench(ws))).toBeNull();
    for (const pid of [88, 89, 90, 91]) expect(s.fake.pidsAsked.has(pid)).toBe(false);
    expect(coversDisplay(at(0, 0, 1440, 899.5), [at(0, 0, 1440, 900)])).toBe(true);
    expect(coversDisplay(at(0, 0, 1000, 900), [at(0, 0, 1440, 900)])).toBe(false);
  });

  it("lists a hung app's windows as busy, leaves it alone for 5 s while the rest answer, then asks again", async () => {
    const other: AppSpec = { pid: 5500, owner: "Other", windows: [{ role: "AXWindow", title: "Other", frame: at(0, 0, 300, 300), windowId: 7001 }] };
    const s = setup([benchApp(), other]);
    s.fake.apps[1]!.hung = true;
    await s.p.start();
    const first = await s.p.topWindows();
    expect(first.find(w => w.pid === 5500)).toMatchObject({ busy: true, handle: 0, key: "7001" });
    expect(bench(first).busy).toBeUndefined();
    const asked = s.fake.calls.filter(c => c.pid === 5500).length;
    await s.p.topWindows();
    expect(s.fake.calls.filter(c => c.pid === 5500).length).toBe(asked);
    s.fake.apps[1]!.hung = false;
    s.fake.clock += 5000;
    const later = await s.p.topWindows();
    expect(later.find(w => w.pid === 5500)).toMatchObject({ title: "Other" });
    expect(later.find(w => w.pid === 5500)!.busy).toBeUndefined();
    expect(later.find(w => w.pid === 5500)!.handle).toBeGreaterThan(0);
  });

  it("keeps nothing of an app that stops answering between its windows (no handle is left behind)", async () => {
    const app: AppSpec = { pid: 5800, owner: "Two", windows: [
      { role: "AXWindow", title: "One", frame: at(0, 0, 300, 300), windowId: 9201 },
      { role: "AXWindow", title: "Two", frame: at(400, 0, 300, 300), windowId: 9202, failOn: { attrs: AX_ERROR.cannotComplete } },
    ] };
    const { fake, p, windows } = await started([app]);
    expect(windows.map(w => [w.key, w.busy, w.handle])).toEqual([["9201", true, 0], ["9202", true, 0]]);
    expect(p.live).toBe(0);
    expect(fake.outstanding).toBe(0);
  });

  it("matches a window to its CGWindowID by frame, then title, when _AXUIElementGetWindow can't say", async () => {
    const twin: AppSpec = { pid: 5600, owner: "Twins", windows: [
      { role: "AXWindow", title: "Left", frame: at(10, 10, 300, 200), windowId: 8001, noWindowId: true, cgTitle: "Left" },
      { role: "AXWindow", title: "Right", frame: at(10, 10, 300, 200), windowId: 8002, noWindowId: true, cgTitle: "Right" },
      { role: "AXWindow", title: "Alone", frame: at(400, 10, 300, 200.4), windowId: 8003, noWindowId: true },
    ] };
    const { windows } = await started([twin]);
    expect(windows.map(w => [w.title, w.key, w.native])).toEqual([["Left", "8001", 8001], ["Right", "8002", 8002], ["Alone", "8003", 8003]]);
  });

  it("says a minimised window is offscreen, and lists an on-screen window AX doesn't know with nothing to read", async () => {
    const app: AppSpec = { pid: 5700, owner: "Doc", windows: [
      { role: "AXWindow", title: "Shown", frame: at(0, 0, 300, 300), windowId: 9101, main: true },
      { role: "AXWindow", title: "Docked", frame: at(0, 0, 300, 300), windowId: 9102, minimized: true },
    ] };
    const s = setup([app]);
    s.fake.extraWindows = [{ id: 9103, pid: 5700, owner: "Doc", title: "", bounds: at(500, 0, 200, 200), layer: 0, alpha: 1 }];
    await s.p.start();
    const ws = await s.p.topWindows();
    expect(ws.find(w => w.title === "Docked")).toMatchObject({ offscreen: true, key: "9102" });
    expect(ws.find(w => w.key === "9103")).toMatchObject({ handle: 0, offscreen: false, app: "Doc" });
    await expect(s.p.snapshot(0, { maxDepth: 4, maxNodes: 10, deadlineMs: 1500 })).rejects.toMatchObject({ code: "gone" });
  });
});

describe("the macOS AX provider's keys", () => {
  it("keys elements by pid and the exact CFHash, which a new host process reads the same", async () => {
    expect(KEY_MODE).toBe("hash");
    const a = await started();
    const snap = await a.p.snapshot(bench(a.windows).handle, { maxDepth: 64, maxNodes: 1000, deadlineMs: 1500 });
    const pw = snap.nodes.find(n => n.platformSubrole === "AXSecureTextField")!;
    expect(pw.key).toMatch(/^4300:hf[0-9a-f]{15}$/);
    expect(new Set(snap.nodes.map(n => n.key)).size).toBe(snap.nodes.length);
    const b = await started();
    const again = await b.p.snapshot(bench(b.windows).handle, { maxDepth: 64, maxNodes: 1000, deadlineMs: 1500 });
    expect(again.nodes.find(n => n.platformSubrole === "AXSecureTextField")!.key).toBe(pw.key);
  });

  it("gives elements of one answer that share a CFHash index-path keys instead, and says so in the log", async () => {
    const app = benchApp();
    const kids = app.windows[0]!.children!;
    kids.find(k => k.id === "save")!.hash = "abc";
    kids.find(k => k.id === "remember")!.hash = "abc";
    const { p, notes, windows } = await started([app]);
    const snap = await p.snapshot(bench(windows).handle, { maxDepth: 64, maxNodes: 1000, deadlineMs: 1500 });
    const keyOf = (name: string) => snap.nodes.find(n => n.name === name)!.key;
    expect(keyOf("Save")).toBe("4300:p9001/10:AXButton");
    expect(keyOf("Remember me")).toBe("4300:p9001/5:AXCheckBox");
    expect(snap.nodes.find(n => n.platformRole === "AXSlider")!.key).toMatch(/^4300:h/);
    expect(notes).toContainEqual(["ax.key_collision", { count: 2 }]);
    // A look later says the key the answer gave.
    const save = snap.nodes.find(n => n.name === "Save")!;
    expect((await p.element(save.handle))!.key).toBe("4300:p9001/10:AXButton");
  });

  it("keys every element by its index path in the \"path\" mode, the hash only where the path isn't known (R4's fallback)", () => {
    const items = [
      { ref: 1n, pid: 4300, path: [], windowId: 9001, role: "AXWindow" },
      { ref: 2n, pid: 4300, path: [3, 0], windowId: 9001, role: "AXTextField" },
      { ref: 3n, pid: 4300, path: null, windowId: 9001, role: "AXButton" },
    ];
    const hash = (ref: bigint) => `f${ref}`;
    expect(answerKeys(items, hash, "path")).toEqual({ keys: ["4300:p9001/:AXWindow", "4300:p9001/3.0:AXTextField", "4300:hf3"], collisions: 0 });
    expect(answerKeys(items, hash, "hash")).toEqual({ keys: ["4300:hf1", "4300:hf2", "4300:hf3"], collisions: 0 });
    const same = () => "abc";
    expect(answerKeys(items, same, "hash")).toEqual({ keys: ["4300:p9001/:AXWindow", "4300:p9001/3.0:AXTextField", "4300:habc:2"], collisions: 3 });
  });

  it("reads a 200-row list's children by range with no two keys alike", async () => {
    const { fake, p, windows } = await started();
    const snap = await p.snapshot(bench(windows).handle, { maxDepth: 64, maxNodes: 1000, deadlineMs: 1500 });
    const list = snap.nodes.find(n => n.platformRole === "AXTable")!;
    const rows = await p.children(list.handle, 5000);
    expect(rows).toHaveLength(200);
    expect(new Set(rows.map(r => r.key)).size).toBe(200);
    expect(rows.slice(0, 13).map(r => !!r.offscreen)).toEqual([...Array(12).fill(false), true]);
    expect(fake.callsAbout("list").filter(c => c.op === "range").map(c => c.name)).toEqual(["AXVisibleRows", "AXChildren"]);
    const before = fake.outstanding;
    p.release(rows.map(r => r.handle));
    expect(fake.outstanding).toBe(before - 200);
  });
});

describe("the macOS AX provider's hit tests, looks and actions", () => {
  it("hit-tests in the app asked about, and climbs from the element there to its window", async () => {
    const { fake, p } = await started();
    const chain = await p.elementsAt(380, 670, BENCH);
    expect(fake.calls.filter(c => c.op === "at")).toEqual([{ op: "at", uid: 0, pid: BENCH }]);
    expect(chain.map(n => [n.platformRole, n.name, n.depth, n.parent])).toEqual([["AXWindow", "Ember Bench (macOS)", 0, -1], ["AXButton", "Save", 1, 0]]);
    expect(chain[0]!.native).toBe(9001);
  });

  it("never hit-tests system-wide, and not at all where Ember's own window is at the point (AX would ask Ember)", async () => {
    const { fake, p } = await started();
    expect(await p.elementsAt(950, 120)).toEqual([]);
    expect(fake.calls.filter(c => c.op === "at")).toEqual([]);
    const chain = await p.elementsAt(380, 670);
    expect(chain[chain.length - 1]!.name).toBe("Save");
    // Without a pid, the app whose window is drawn there is asked, app-scoped.
    expect(fake.calls.filter(c => c.op === "at")).toEqual([{ op: "at", uid: 0, pid: BENCH }]);
    expect(fake.pidsAsked.has(EMBER)).toBe(false);
  });

  it("says busy for a hit test in an app that doesn't answer", async () => {
    const s = setup();
    s.fake.apps[0]!.hung = true;
    await s.p.start();
    await expect(s.p.elementsAt(380, 670, BENCH)).rejects.toMatchObject({ code: "busy" });
  });

  it("looks at an element as it is now, with its actions from its action names and what may be set", async () => {
    const { fake, p, windows } = await started();
    const snap = await p.snapshot(bench(windows).handle, { maxDepth: 64, maxNodes: 1000, deadlineMs: 1500 });
    const look = async (pred: (n: RawNode) => boolean) => (await p.element(snap.nodes.find(pred)!.handle))!;
    expect((await look(n => n.platformSubrole === "AXSecureTextField")).actions).toEqual(["focus"]);
    expect(await look(n => n.platformRole === "AXTextField" && !n.password)).toMatchObject({ actions: ["setValue", "focus"], editable: true, labelledBy: "Name" });
    expect((await look(n => n.platformRole === "AXSlider")).range).toEqual({ value: 50, min: 0, max: 100 });
    fake.el("volume").spec.settable = [];
    expect((await look(n => n.platformRole === "AXSlider")).actions).toEqual(["setRange"]);
    fake.el("volume").spec.actions = [];
    expect((await look(n => n.platformRole === "AXSlider")).range).toMatchObject({ readOnly: true });
    const save = snap.nodes.find(n => n.name === "Save")!;
    fake.remove("save");
    expect(await p.element(save.handle)).toBeNull();
  });

  it("gives a pop-up's options only while its menu exists", async () => {
    const app = benchApp();
    const theme = app.windows[0]!.children!.find(k => k.id === "theme")!;
    const { fake, p, windows } = await started([app]);
    const snap = await p.snapshot(bench(windows).handle, { maxDepth: 64, maxNodes: 1000, deadlineMs: 1500 });
    const popup = snap.nodes.find(n => n.platformRole === "AXPopUpButton")!;
    expect(await p.children(popup.handle, 50)).toEqual([]);
    const el = fake.el("theme");
    // The menu is drawn in a window of its own: an item past the bottom of the pop-up's window (y 700) still shows.
    const tops = [266, 288, 702];
    theme.children = [{ role: "AXMenu", frame: at(210, 266, 160, 458), children: ["Light", "Dark", "System"].map((t, i) => ({ role: "AXMenuItem", title: t, frame: at(210, tops[i]!, 160, 22), actions: ["AXPress", "AXPick"] })) }];
    el.children = new FakeAx([{ ...app, windows: [{ role: "AXWindow", children: [theme] }] }]).appOf(BENCH)!.children[0]!.children[0]!.children;
    for (const c of el.children) c.parent = el;
    const items = await p.children(popup.handle, 50);
    expect(items.map(i => [i.platformRole, i.name, i.actions, !!i.offscreen])).toEqual([
      ["AXMenuItem", "Light", ["invoke", "select"], false], ["AXMenuItem", "Dark", ["invoke", "select"], false], ["AXMenuItem", "System", ["invoke", "select"], false],
    ]);
  });

  it("tells the element with the keyboard and its window, never asking Ember when Ember is in front", async () => {
    const { fake, p } = await started();
    const f = await p.focused();
    expect(f.element).toMatchObject({ platformRole: "AXTextField", name: "Name" });
    expect(f.window).toBeGreaterThan(0);
    fake.frontmost = EMBER;
    expect(await p.focused()).toEqual({ element: null, window: null });
    expect(fake.pidsAsked.has(EMBER)).toBe(false);
  });

  it("reads nothing of a secure field's text", async () => {
    const { fake, p, windows } = await started();
    const snap = await p.snapshot(bench(windows).handle, { maxDepth: 64, maxNodes: 1000, deadlineMs: 1500 });
    const pw = snap.nodes.find(n => n.platformSubrole === "AXSecureTextField")!;
    const calls = fake.calls.length;
    expect(await p.textInfo(pw.handle, 100)).toEqual({ secret: true });
    await expect(p.perform(pw.handle, "setValue", "x")).rejects.toMatchObject({ code: "denied" });
    expect(fake.calls.length).toBe(calls);
  });

  it("turns Chromium's accessibility on once per app, at its first read, and waits a moment for its tree", async () => {
    const app = benchApp();
    const s = setup([app, emberApp()]);
    s.fake.appOf(BENCH)!.spec.settable = ["AXManualAccessibility"];
    await s.p.start();
    const ws = await s.p.topWindows();
    await s.p.snapshot(bench(ws).handle, { maxDepth: 2, maxNodes: 50, deadlineMs: 1500 });
    await s.p.snapshot(bench(ws).handle, { maxDepth: 2, maxNodes: 50, deadlineMs: 1500 });
    expect(s.fake.done.filter(d => d.startsWith("set AXManualAccessibility"))).toEqual(["set AXManualAccessibility=true on AXApplication"]);
    expect(s.notes).toContainEqual(["ax.manual_accessibility", { pid: BENCH }]);
    expect(s.slept()).toBe(200);
    expect(s.fake.done.some(d => d.includes("AXEnhancedUserInterface"))).toBe(false);
  });

  it("gives every element back when the host releases its handles, and all of them when it stops", async () => {
    const { fake, p, windows } = await started();
    const snap = await p.snapshot(bench(windows).handle, { maxDepth: 64, maxNodes: 1000, deadlineMs: 1500 });
    expect(p.live).toBe(windows.filter(w => w.handle > 0).length + snap.nodes.length);
    p.release(snap.nodes.map(n => n.handle));
    p.release([snap.nodes[0]!.handle, 999_999]);
    expect(p.live).toBe(windows.filter(w => w.handle > 0).length);
    p.stop();
    expect(p.live).toBe(0);
    expect(fake.outstanding).toBe(0);
    await expect(p.start()).rejects.toThrow("stopped");
  });
});

/** The host over the macOS AX provider and a fake desktop, driven by protocol lines. */
function hostOn(apps?: AppSpec[]) {
  const s = setup(apps);
  const host = new Host(s.p, { settleMs: 0, ownerPid: EMBER, env: {} });
  let id = 0;
  const call = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const r = JSON.parse((await host.handle(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })))!);
    if (r.error) throw new Error(r.error.message);
    return r.result as T;
  };
  return { ...s, host, call };
}

describe("the sidecar host on the macOS AX provider (the bench as AX describes it)", () => {
  it("reads the bench with AT-SPI roles, never the password, and acts in it", async () => {
    const { fake, call } = hostOn();
    expect(await call("status")).toMatchObject({ version: 3, toolkitAccessibility: true, apps: 2 });
    const { windows } = await call<{ windows: AxWindow[] }>("list_windows", { ownPid: EMBER });
    const win = windows.find(w => w.name === "Ember Bench (macOS)")!;
    expect(win).toMatchObject({ app: "osascript", pid: BENCH, path: "9001", role: "frame", active: true });
    expect(windows.some(w => w.pid === EMBER)).toBe(false);
    const read = await call<ReadWindowResult>("read_window", { pid: BENCH, path: "9001", ownPid: EMBER });
    const node = (name: string, role: string): AxNode => {
      const n = read.nodes.find(x => x.name === name && x.role === role);
      expect(n, `${role} "${name}" in ${JSON.stringify(read.nodes.map(x => [x.role, x.name]))}`).toBeTruthy();
      return n!;
    };
    expect(read.nodes[0]).toMatchObject({ role: "frame", depth: 0, states: expect.arrayContaining(["active"]) });
    expect(node("Name", "label")).toBeTruthy();
    expect(node("Name", "entry").states).toEqual(expect.arrayContaining(["focused", "editable", "enabled", "sensitive", "focusable"]));
    const pw = node("Password", "password text");
    expect(pw.secret).toBe(true);
    expect(pw.text).toBeUndefined();
    expect(node("Remember me", "check box").actions).toEqual(["toggle"]);
    expect(node("Theme", "combo box").selected).toBe("Light");
    expect(node("Volume", "slider").value).toBe(50);
    expect(node("Notes", "text")).toMatchObject({ text: "First line\nSecond line", states: expect.arrayContaining(["multi line"]) });
    expect(node("Save", "push button").actions).toEqual(["click"]);
    expect(read.nodes.filter(n => n.role === "list item")).toHaveLength(12);
    expect(read.secretKeys).toEqual([["ax", expect.stringMatching(/^4300:h/)]]);
    expect(JSON.stringify(read)).not.toContain("hunter2");

    const set = await call<{ ok: boolean; after: ElementInfo }>("set_text", { id: node("Name", "entry").id, text: "Ember 1" });
    expect(set).toMatchObject({ ok: true, after: { text: "Ember 1" } });
    expect(fake.el("name").spec.value).toBe("Ember 1");
    await expect(call("set_text", { id: pw.id, text: "hunter3" })).rejects.toThrow("password fields are off limits to Ember");
    expect(fake.done.some(d => d.includes("on password"))).toBe(false);

    expect(await call("can_do", { id: node("Save", "push button").id, kind: "click" })).toMatchObject({ tier1: true, action: "click" });
    expect(await call("do_action", { id: node("Save", "push button").id, action: "click" })).toMatchObject({ ok: true, action: "click" });
    expect(fake.done).toContain("perform AXPress on save");
    const toggled = await call<{ ok: boolean; after: ElementInfo }>("do_action", { id: node("Remember me", "check box").id, action: "toggle" });
    expect(toggled.after.states).toContain("checked");

    await expect(call("set_value", { id: node("Volume", "slider").id, value: 150 })).rejects.toThrow("value 150.0 is outside 0.0..100.0");
    expect(await call("set_value", { id: node("Volume", "slider").id, value: 70 })).toMatchObject({ ok: true, after: { role: "slider", value: 70 } });

    const save = node("Save", "push button").bounds!;
    const here = await call<{ chain: { role: string; name: string }[] }>("at_point", { pid: BENCH, path: "9001", x: save.x + 10, y: save.y + 10, ownPid: EMBER });
    expect(here.chain[here.chain.length - 1]).toMatchObject({ role: "push button", name: "Save" });

    const secrets = await call<{ fields: { role: string }[]; complete: boolean }>("secret_fields", { pid: BENCH, path: "9001" });
    expect(secrets).toMatchObject({ complete: true, fields: [{ role: "password text" }] });

    const rows = await call<{ options: string[] }>("list_options", { id: node("Rows", "table").id });
    expect(rows.options).toHaveLength(200);
    expect(rows.options.slice(0, 2)).toEqual(["Row 1", "Row 2"]);
    expect(await call("select_option", { id: node("Rows", "table").id, option: "Row 5" })).toMatchObject({ ok: true, option: "Row 5" });
    expect(fake.el("row5").spec.selected).toBe(true);

    expect(fake.pidsAsked.has(EMBER)).toBe(false);
  });

  it("finds the same secret key from a second host process (the password field stays secret across restarts)", async () => {
    const one = hostOn();
    const two = hostOn();
    const a = await one.call<ReadWindowResult>("read_window", { pid: BENCH, path: "9001" });
    const b = await two.call<ReadWindowResult>("read_window", { pid: BENCH, path: "9001" });
    expect(a.secretKeys).toHaveLength(1);
    expect(b.secretKeys).toEqual(a.secretKeys);
  });

  it("answers busy, not late, for an app that stops answering, while the others keep answering", async () => {
    const other: AppSpec = { pid: 5500, owner: "Other", windows: [{ role: "AXWindow", title: "Other", frame: at(0, 0, 300, 300), windowId: 7001, children: [{ role: "AXButton", title: "Go", frame: at(10, 10, 50, 20) }] }] };
    const { fake, call } = hostOn([benchApp(), other, emberApp()]);
    await call("list_windows");
    fake.apps[0]!.hung = true;
    expect(await call("read_window", { pid: BENCH, path: "9001" })).toMatchObject({ busy: true });
    const go = await call<ReadWindowResult>("read_window", { pid: 5500, path: "7001" });
    expect(go.nodes.map(n => n.name)).toContain("Go");
    const listed = await call<{ windows: AxWindow[] }>("list_windows");
    expect(listed.windows.find(w => w.pid === BENCH)).toMatchObject({ busy: true, name: "Ember Bench (macOS)" });
  });
});
