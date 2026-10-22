import { describe, expect, it } from "vitest";
import { Host } from "../../app/sidecar-host/host";
import { FakeProvider, benchDesktop, type FakeWindowSpec } from "../../app/sidecar-host/providers/fake";
import { UnsupportedProvider, isPackaged, openProvider, providerKind } from "../../app/sidecar-host/providers";
import { BUSY, asciiJson, encodeResult, pyFloat } from "../../app/sidecar-host/protocol";
import type { AxNode, AxWindow, ReadWindowResult } from "../../app/main/perception/sidecar";

const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

function harness(windows: FakeWindowSpec[] = benchDesktop(), deadlineMs = 300) {
  const fake = new FakeProvider(windows, { deadlineMs });
  const host = new Host(fake, { env: { EMBER_ATSPI_ID_BASE: "10000000" }, settleMs: 0 });
  let n = 1;
  const raw = async (method: string, params: Record<string, unknown> = {}) => JSON.parse((await host.handle(JSON.stringify({ jsonrpc: "2.0", id: n++, method, params })))!);
  const call = async <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const msg = await raw(method, params);
    if (msg.error) throw new Error(msg.error.message);
    return msg.result as T;
  };
  const fails = (method: string, params: Record<string, unknown> = {}) => call(method, params).then(() => "resolved", (e: Error) => e.message);
  return { fake, host, call, raw, fails };
}
type Read = ReadWindowResult & { secretKeys: [string, string][]; withheldKeys: [string, string][] };
const byName = (r: { nodes: AxNode[] }, name: string) => r.nodes.find(n => n.name === name)!;

/** Two apps: an editor with a main window and a modal Find dialog, and a password manager. */
function twoApps(): FakeWindowSpec[] {
  return [
    { role: "Window", name: "notes.txt - Editor", pid: 10, app: "editor", bounds: at(0, 0, 800, 600), native: 101, children: [
      { role: "Document", name: "", editable: true, value: "Hello", bounds: at(10, 40, 780, 550), hasText: undefined } as never,
    ] },
    { role: "Window", name: "Find", pid: 10, app: "editor", modal: true, active: true, bounds: at(200, 200, 300, 120), native: 102, children: [
      { role: "Edit", name: "Find what", value: "needle", bounds: at(210, 230, 200, 24), editable: true, actions: ["setValue"] },
    ] },
    { role: "Window", name: "Vault - KeePassXC", pid: 20, app: "keepassxc", bounds: at(900, 0, 600, 600), native: 201, children: [
      { role: "Button", name: "Unlock", bounds: at(910, 40, 80, 30), actions: ["invoke"] },
    ] },
  ];
}

describe("sidecar host protocol framing", () => {
  it("answers ping without starting its provider, and everything else after starting it", async () => {
    const { fake, call } = harness();
    expect(await call("ping")).toEqual({ version: 3 });
    expect(fake.started).toBe(0);
    await call("list_windows", {});
    expect(fake.started).toBe(1);
  });

  it("answers an unknown method and a bad line with the Python sidecar's errors", async () => {
    const { host, raw } = harness();
    expect((await raw("frobnicate")).error.message).toBe("'unknown method: frobnicate'");
    const bad = JSON.parse((await host.handle("not json"))!);
    expect(bad.id).toBeNull();
    expect(typeof bad.error.message).toBe("string");
    expect(await host.handle("   ")).toBeNull();
  });

  it("escapes every character past ASCII, as Python's json.dumps does", () => {
    const line = encodeResult(7, { name: "Café ✓ 😀\u2028" });
    expect(line).toBe('{"jsonrpc":"2.0","id":7,"result":{"name":"Caf\\u00e9 \\u2713 \\ud83d\\ude00\\u2028"}}');
    expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
    expect(JSON.parse(line).result.name).toBe("Café ✓ 😀\u2028");
    expect(asciiJson("é")).toBe('"\\u00e9"');
  });

  it("turns an answer JSON can't carry into an error instead of a silent null", () => {
    const msg = JSON.parse(encodeResult(3, { value: NaN }));
    expect(msg.error.message).toMatch(/^the answer could not be encoded: /);
    expect(msg.id).toBe(3);
  });

  it("prints floats in messages as Python does", () => {
    expect([pyFloat(150), pyFloat(0.5), pyFloat(-2), pyFloat(NaN)]).toEqual(["150.0", "0.5", "-2.0", "nan"]);
  });

  it("says why when its provider can't start, without crashing", async () => {
    const fake = new FakeProvider(benchDesktop(), { failStart: "Windows PowerShell is missing" });
    const host = new Host(fake, { settleMs: 0 });
    const msg = JSON.parse((await host.handle('{"jsonrpc":"2.0","id":1,"method":"list_windows","params":{}}'))!);
    expect(msg.error.message).toBe("Windows PowerShell is missing");
    expect(JSON.parse((await host.handle('{"jsonrpc":"2.0","id":2,"method":"ping"}'))!).result).toEqual({ version: 3 });
  });
});

describe("choosing the provider", () => {
  it("uses the fake desktop only when asked for in a development tree", () => {
    expect(providerKind({ EMBER_AX_PROVIDER: "fake" }, "linux", false)).toBe("fake");
    expect(providerKind({ EMBER_AX_PROVIDER: "fake" }, "win32", true)).toBe("uia");
    expect(providerKind({}, "win32", false)).toBe("uia");
    expect(providerKind({}, "darwin", false)).toBe("ax");
    expect(providerKind({}, "linux", false)).toBe("none");
    expect(isPackaged("/opt/ember/resources/app/dist/app/ax-sidecar.cjs")).toBe(true);
    expect(isPackaged("C:\\Ember\\resources\\app.asar\\dist\\app\\ax-sidecar.cjs")).toBe(true);
    expect(isPackaged("/home/dev/ember/dist/app/ax-sidecar.cjs")).toBe(false);
  });

  it("says plainly that macOS isn't read yet (every request but ping)", async () => {
    const p = openProvider({}, "darwin", "/x/dist/app/ax-sidecar.cjs");
    expect(p).toBeInstanceOf(UnsupportedProvider);
    const host = new Host(p, { settleMs: 0 });
    const msg = JSON.parse((await host.handle('{"jsonrpc":"2.0","id":1,"method":"read_window","params":{}}'))!);
    expect(msg.error.message).toMatch(/macOS accessibility provider/);
    expect(JSON.parse((await host.handle('{"jsonrpc":"2.0","id":2,"method":"ping"}'))!).result.version).toBe(3);
  });
});

describe("status and list_windows", () => {
  it("reports the version, whether accessibility is on, and how many apps have windows", async () => {
    const { call } = harness(twoApps());
    const s = await call<{ version: number; python: string; toolkitAccessibility: boolean | null; apps: number }>("status");
    expect(s).toMatchObject({ version: 3, toolkitAccessibility: true, apps: 2 });
    expect(typeof s.python).toBe("string");
  });

  it("lists every showing window except Ember's own, as the protocol describes them", async () => {
    const { call } = harness(twoApps());
    const { windows } = await call<{ windows: AxWindow[] }>("list_windows", { ownPid: 20 });
    expect(windows.map(w => w.name)).toEqual(["Find", "notes.txt - Editor"]);
    expect(windows[0]).toEqual({ app: "editor", pid: 10, path: "102", name: "Find", role: "dialog", active: true, bounds: at(200, 200, 300, 120) });
  });

  it("keeps a busy app's windows listed as last seen, busy and not active, after the rest", async () => {
    const { fake, call } = harness(twoApps());
    await call("list_windows", {});
    (fake.window("Vault - KeePassXC").spec as FakeWindowSpec).busy = true;
    const { windows } = await call<{ windows: AxWindow[] }>("list_windows", {});
    expect(windows[windows.length - 1]).toMatchObject({ name: "Vault - KeePassXC", busy: true, active: false });
  });
});

describe("read_window", () => {
  it("reads the active window with no pid or title, and never Ember's own", async () => {
    const { call } = harness(twoApps());
    const r = await call<Read>("read_window", {});
    expect(r.window!.name).toBe("Find");
    const none = await call<Read>("read_window", { ownPid: 10 });
    expect(none).toMatchObject({ window: null, nodes: [], busy: false });
  });

  it("reads exactly the window a pid and path name, or none", async () => {
    const { call } = harness(twoApps());
    expect((await call<Read>("read_window", { pid: 10, path: "101" })).window!.name).toBe("notes.txt - Editor");
    expect((await call<Read>("read_window", { pid: 10, path: "999" })).window).toBeNull();
  });

  it("finds a window by title, its own app's first", async () => {
    const { call } = harness(twoApps());
    expect((await call<Read>("read_window", { title: "vault" })).window!.app).toBe("keepassxc");
    expect((await call<Read>("read_window", { pid: 10, title: "notes" })).window!.name).toBe("notes.txt - Editor");
    // With a pid and no title, that app's active window.
    expect((await call<Read>("read_window", { pid: 10 })).window!.name).toBe("Find");
  });

  it("finds a never-look window but doesn't read it", async () => {
    const { fake, call } = harness(twoApps());
    const live = fake.live;
    const r = await call<Read>("read_window", { title: "vault", neverLook: [" KeePass "] });
    expect(r).toMatchObject({ blocked: true, nodes: [] });
    expect(r.window!.name).toBe("Vault - KeePassXC");
    expect((await call<Read>("read_window", { pid: 20, skipPids: [20] })).blocked).toBe(true);
    // Nothing inside it was asked, and every handle went back.
    expect(fake.log).toEqual([]);
    expect(fake.live).toBe(live);
  });

  it("answers with every key the Python sidecar sends, the window first in its nodes", async () => {
    const { call } = harness();
    const r = await call<Read>("read_window", { title: "Ember Bench" });
    expect(Object.keys(r).sort()).toEqual(["cut", "ms", "nodes", "others", "secretKeys", "truncated", "window", "withheldKeys"]);
    expect(r.nodes[0]).toMatchObject({ parent: null, depth: 0, role: "frame", name: "Ember Bench (Windows)" });
    expect(r.truncated).toBe(false);
    expect(r.cut).toEqual([]);
    for (const n of r.nodes.slice(1)) expect(r.nodes.findIndex(p => p.id === n.parent)).toBeLessThan(r.nodes.indexOf(n));
  });

  it("names the app's other windows the user is in or must answer first", async () => {
    const { call } = harness(twoApps());
    const r = await call<Read>("read_window", { pid: 10, path: "101" });
    expect(r.others).toEqual([{ name: "Find", role: "dialog", active: true, modal: true }]);
  });

  it("says busy, not gone, when the window's app doesn't answer", async () => {
    const { fake, call } = harness(twoApps());
    await call("list_windows", {});
    (fake.window("Vault - KeePassXC").spec as FakeWindowSpec).busy = true;
    expect(await call<Read>("read_window", { title: "vault" })).toMatchObject({ window: null, busy: true });
    expect(await call<Read>("read_window", { title: "nothing like it" })).toMatchObject({ window: null, busy: false });
  });

  it("says busy when the app stops answering partway, and slow when the time ran out", async () => {
    const slow = benchDesktop();
    slow[0].children![5].slowMs = 1000;
    const busy = await harness(slow, 100).call<Read>("read_window", {});
    expect(busy.busy).toBe(true);
    expect(busy.nodes.map(n => n.name)).toContain("Name");
    expect(busy.nodes.map(n => n.name)).not.toContain("Save");
    const late = benchDesktop();
    late[0].children![5].slowMs = 2000;
    const timed = await harness(late, 5000).call<Read>("read_window", {});
    expect(timed).toMatchObject({ truncated: true, slow: true });
    expect(timed.busy).toBeUndefined();
  });

  it("stops at maxNodes and says what was left out", async () => {
    const { call } = harness();
    const r = await call<Read>("read_window", { maxNodes: 5 });
    expect(r.nodes).toHaveLength(5);
    expect(r).toMatchObject({ truncated: true, cut: ["nodes"] });
    const deep = await call<Read>("read_window", { maxDepth: 0 });
    expect(deep.nodes).toHaveLength(1);
    expect(deep.cut).toEqual(["depth"]);
  });
});

describe("remember_secrets and mark_secret", () => {
  it("takes keys an earlier process knew, ignoring junk, and counts them", async () => {
    const { call } = harness();
    expect(await call("remember_secrets", { keys: [["fake", "1:2"], "junk", [1], ["a", "b", "c"]], withheld: [["fake", "1:3"]] })).toEqual({ count: 1 });
  });

  it("marks fields Ember found secret, ignoring ids it doesn't know", async () => {
    const { call } = harness();
    const r = await call<Read>("read_window", {});
    const name = byName(r, "Name");
    const out = await call<{ keys: [string, string][]; withheldKeys: [string, string][] }>("mark_secret", { ids: [name.id, 999, "x"] });
    expect(out.keys).toHaveLength(1);
    expect(out.keys[0][0]).toBe("fake");
    expect(out.withheldKeys).toEqual([]);
    const again = await call<Read>("read_window", {});
    expect(byName(again, "Name").secret).toBe(true);
  });
});

describe("shell_overlays", () => {
  const prompt: FakeWindowSpec = { role: "Window", name: "Windows Security", pid: 66, app: "CredentialUIBroker", className: "Credential Dialog Xaml Host", bounds: at(400, 300, 456, 400) };

  it("reports a credential prompt over the desktop as a dialog, and nothing otherwise", async () => {
    expect(await harness(twoApps()).call("shell_overlays")).toEqual({ overlays: [], complete: true });
    expect(await harness([...twoApps(), prompt]).call("shell_overlays")).toEqual({
      overlays: [{ role: "dialog", name: "Windows Security", text: "", bounds: at(400, 300, 456, 400) }], complete: true,
    });
  });

  it("reports Task View and the Alt+Tab switcher as an overview", async () => {
    const view: FakeWindowSpec = { role: "Window", name: "Task View", pid: 5, app: "explorer", className: "XamlExplorerHostIslandWindow", bounds: at(0, 0, 1920, 1080) };
    const r = await harness([view]).call<{ overlays: { role: string }[] }>("shell_overlays");
    expect(r.overlays.map(o => o.role)).toEqual(["overview"]);
  });

  it("is incomplete (no picture) when the windows can't be listed", async () => {
    const { fake, call } = harness();
    fake.topWindows = async () => { throw new Error("bridge gone"); };
    expect(await call("shell_overlays")).toEqual({ overlays: [], complete: false });
  });
});

describe("secret_fields", () => {
  it("needs a pid and a path: without them it is incomplete", async () => {
    const { call } = harness();
    expect(await call("secret_fields", { pid: 4242 })).toMatchObject({ fields: [], complete: false, busy: false });
    expect(await call("secret_fields", { pid: 4242, path: "nope" })).toMatchObject({ fields: [], complete: false });
  });

  it("finds every secret field in the window, with ids for Ember to look at again", async () => {
    const { call } = harness();
    const r = await call<{ fields: { id: number; role: string; bounds: unknown }[]; complete: boolean; busy: boolean; secretKeys: unknown[] }>("secret_fields", { pid: 4242, path: "172210" });
    expect(r.complete).toBe(true);
    expect(r.busy).toBe(false);
    expect(r.fields).toEqual([{ id: expect.any(Number), role: "password text", bounds: at(210, 186, 240, 26) }]);
    expect(r.secretKeys).toHaveLength(1);
    const info = await call<{ secret?: boolean; text?: string }>("read_element", { id: r.fields[0].id });
    expect(info.secret).toBe(true);
    expect(info.text).toBeUndefined();
  });

  it("finds unnamed fields under a secret label too", async () => {
    const w: FakeWindowSpec = { role: "Window", name: "Pay", pid: 7, app: "shop", native: 70, bounds: at(0, 0, 500, 300), children: [
      { role: "Text", name: "Card number", bounds: at(10, 10, 100, 18) },
      { role: "Edit", name: "", value: "4111", bounds: at(10, 30, 200, 24), actions: ["setValue"] },
      { role: "Text", name: "Name on card", bounds: at(10, 70, 100, 18) },
    ] };
    const r = await harness([w]).call<{ fields: { role: string }[]; complete: boolean }>("secret_fields", { pid: 7, path: "70" });
    expect(r.fields.map(f => f.role)).toEqual(["entry"]);
  });

  it("is incomplete when the window couldn't all be looked through", async () => {
    const big = benchDesktop();
    big[0].children![2].slowMs = 3000;
    const r = await harness(big, 5000).call<{ complete: boolean }>("secret_fields", { pid: 4242, path: "172210" });
    expect(r.complete).toBe(false);
  });
});

describe("read_element", () => {
  it("needs an id that a recent read gave", async () => {
    const { fails } = harness();
    expect(await fails("read_element", {})).toBe("'id'");
    expect(await fails("read_element", { id: 5 })).toBe("'element 5 is no longer known; read the window again'");
  });

  it("reads an element as it is now, its text up to 2000 characters", async () => {
    const { fake, call } = harness();
    const r = await call<Read>("read_window", {});
    fake.el("Name").spec.value = "x".repeat(2500);
    const info = await call<{ role: string; name: string; text: string; states: string[] }>("read_element", { id: byName(r, "Name").id });
    expect(info).toMatchObject({ role: "entry", name: "Name" });
    expect(info.text).toHaveLength(2000);
    expect(info.states).toEqual(expect.arrayContaining(["sensitive", "enabled", "editable"]));
    const combo = await call<{ selected: string; text?: string }>("read_element", { id: byName(r, "Theme").id });
    expect(combo.selected).toBe("Light");
    expect(combo.text).toBeUndefined();
    expect(await call("read_element", { id: byName(r, "Volume").id })).toMatchObject({ value: 50 });
  });

  it("says gone for an element that went away, and busy (the exact words) for an app that didn't answer", async () => {
    const { fake, call, fails } = harness();
    const r = await call<Read>("read_window", {});
    fake.remove(fake.el("Save"));
    expect(await fails("read_element", { id: byName(r, "Save").id })).toBe(`element ${byName(r, "Save").id} is gone (the window changed); read the window again`);
    fake.el("Volume").spec.slowMs = 1000;
    expect(await fails("read_element", { id: byName(r, "Volume").id })).toBe(BUSY);
    expect(BUSY).toMatch(/\bbusy\b|did not (receive a reply|answer)|timeout was reached/i);
  });

  it("gives the part of an element its list lets show, where asked", async () => {
    const w: FakeWindowSpec = { role: "Window", name: "Files", pid: 8, app: "files", native: 80, active: true, bounds: at(0, 0, 400, 400), children: [
      { role: "List", name: "Files", bounds: at(10, 10, 200, 100), selection: { multiple: false }, children: [
        { role: "ListItem", name: "half.txt", bounds: at(10, 90, 200, 40), actions: ["select"] },
      ] },
    ] };
    const { call } = harness([w]);
    const r = await call<Read>("read_window", {});
    expect(byName(r, "half.txt").shown).toEqual(at(10, 90, 200, 20));
    const info = await call<{ shown?: unknown; bounds: unknown }>("read_element", { id: byName(r, "half.txt").id, shown: true });
    expect(info.shown).toEqual(at(10, 90, 200, 20));
    expect((await call<{ shown?: unknown }>("read_element", { id: byName(r, "half.txt").id })).shown).toBeUndefined();
  });

  it("says whether a menu is open, and that a closed menu's item is offscreen", async () => {
    const w: FakeWindowSpec = { role: "Window", name: "App", pid: 9, app: "app", native: 90, active: true, bounds: at(0, 0, 400, 400), children: [
      { role: "MenuBar", name: "", bounds: at(0, 0, 400, 20), children: [
        { role: "MenuItem", name: "File", expanded: false, bounds: at(0, 0, 40, 20), actions: ["expand", "collapse"], children: [
          { role: "MenuItem", name: "Open", bounds: at(0, 20, 100, 20) },
        ] },
      ] },
    ] };
    const { fake, call } = harness([w]);
    const r = await call<Read>("read_window", {});
    const file = byName(r, "File");
    expect(file.role).toBe("menu");
    expect((await call<{ open: boolean }>("read_element", { id: file.id })).open).toBe(false);
    fake.el("File").spec.expanded = true;
    expect((await call<{ open: boolean }>("read_element", { id: file.id })).open).toBe(true);
    const open = byName(r, "Open");
    fake.el("Open").spec.offscreen = true;
    expect((await call<{ offscreen?: boolean }>("read_element", { id: open.id })).offscreen).toBe(true);
    const save = await harness().call<Read>("read_window", {});
    expect(save.nodes.every(n => !("offscreen" in n))).toBe(true);
  });
});

describe("at_point", () => {
  it("needs the window, then x and y", async () => {
    const { call, fails } = harness();
    expect(await call("at_point", { pid: 1, path: "1", x: 0, y: 0 })).toMatchObject({ chain: [], found: false });
    expect(await fails("at_point", { pid: 4242, path: "172210", y: 3 })).toBe("'x'");
  });

  it("finds a never-look window but doesn't look at it", async () => {
    const { call } = harness();
    expect(await call("at_point", { pid: 4242, path: "172210", x: 250, y: 360, neverLook: ["bench"] })).toMatchObject({ chain: [], blocked: true });
  });

  it("gives what shows at a point outermost first, below the window, with the bounds a read gives", async () => {
    const { call } = harness();
    const r = await call<Read>("read_window", {});
    const res = await call<{ chain: { role: string; name: string; bounds: unknown }[] }>("at_point", { pid: 4242, path: "172210", x: 250, y: 360 });
    expect(res.chain).toEqual([{ role: "push button", name: "Save", bounds: byName(r, "Save").bounds }]);
  });

  it("ends at a secret field, nameless", async () => {
    const { call } = harness();
    const res = await call<{ chain: { role: string; name: string; secret?: boolean }[] }>("at_point", { pid: 4242, path: "172210", x: 300, y: 195 });
    expect(res.chain).toEqual([{ role: "password text", name: "", bounds: at(210, 186, 240, 26), secret: true }]);
  });

  it("starts with the app's popup when one lies over the window", async () => {
    const menu: FakeWindowSpec = { role: "Menu", name: "Context", pid: 4242, app: "powershell", className: "#32768", bounds: at(240, 340, 120, 60), children: [
      { role: "MenuItem", name: "Copy", bounds: at(240, 350, 120, 20), actions: ["invoke"] },
    ] };
    const { call } = harness([menu, ...benchDesktop()].reverse());
    const res = await call<{ chain: { role: string; name: string }[] }>("at_point", { pid: 4242, path: "172210", x: 250, y: 355 });
    expect(res.chain.map(c => [c.role, c.name])).toEqual([["menu", "Context"], ["menu item", "Copy"]]);
  });

  it("looks through the window itself where another app's window lies over it", async () => {
    const cover: FakeWindowSpec = { role: "Window", name: "Notification", pid: 77, app: "toast", bounds: at(200, 340, 300, 60) };
    const { call } = harness([cover, ...benchDesktop()].reverse());
    const res = await call<{ chain: { role: string; name: string }[] }>("at_point", { pid: 4242, path: "172210", x: 250, y: 360 });
    expect(res.chain.map(c => c.name)).toEqual(["Save"]);
  });

  it("marks an empty grouping container at the end as telling nothing", async () => {
    const w: FakeWindowSpec = { role: "Window", name: "App", pid: 9, app: "app", native: 90, bounds: at(0, 0, 400, 400), children: [
      { role: "Pane", name: "", bounds: at(0, 0, 400, 400) },
    ] };
    const res = await harness([w]).call<{ chain: { role: string; empty?: boolean }[] }>("at_point", { pid: 9, path: "90", x: 5, y: 5 });
    expect(res.chain).toEqual([{ role: "panel", name: "", bounds: at(0, 0, 400, 400), empty: true }]);
  });
});
