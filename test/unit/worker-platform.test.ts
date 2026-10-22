/**
 * A worker on another OS (design §4.9), through the WorkerSystem main passes: its tools follow what the OS offers
 * (change_setting only with settings to change, open_on_desk only with a desk), apps are matched as the OS names
 * programs, the keys Ember presses itself are the OS's (⌘A, Delete, ⌘V on macOS), the authentication-prompt guard
 * uses the OS's vocabulary, and its words and shortcuts reach what the model and the user read. Without a system the
 * worker is Linux's, as before. The clipboard around its paste follows the OS's formats (§4.10).
 */

import { describe, expect, it } from "vitest";
import { LINUX_WORKER_SYSTEM, Worker, afterKeys, dialogNote, type WorkerDeps, type WorkerSystem } from "../../app/main/agent/worker";
import { electronClipboard, holdsPassword } from "../../app/main/agent/clipboard";
import { CLIPBOARD_FORMATS } from "../../app/main/agent/clipboard-formats";
import type { ClipboardFormats } from "../../app/main/platform/types";
import { Presenter } from "../../app/main/agent/presenter";
import { PolicyEngine } from "../../app/main/policy/policy";
import { KEYS, SHORTCUTS } from "../../app/shared/shortcuts";
import { PLATFORM_WORDS } from "../../app/shared/words";
import type { DesktopApp } from "../../app/main/hands/system";
import type { AxNode, Bounds } from "../../app/main/perception/sidecar";
import type { Hand } from "../../app/main/hands/borrow";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const FRAME: Bounds = { x: 0, y: 0, width: 800, height: 600 };

/** A Mac's system as main would pass it: its keys, words and shortcuts; apps and settings faked. */
function fakeSystem(os: "win32" | "darwin", o: { apps?: DesktopApp[]; available?: WorkerSystem["settings"]["available"]; launched?: string[]; changed?: string[]; security?: (w: { app?: string }) => boolean } = {}): WorkerSystem {
  const apps = o.apps ?? [];
  return {
    os, keys: KEYS[os], words: PLATFORM_WORDS[os], shortcuts: SHORTCUTS[os],
    apps: {
      list: () => apps,
      find: (list, query) => list.find(a => a.name.toLowerCase() === query.toLowerCase()) ?? null,
      launch: app => { o.launched?.push(app.name); },
      isTerminalApp: app => /terminal|powershell|cmd/i.test(app.name),
      programsOf: app => new Set(app.programs ?? [app.id.toLowerCase()]),
      appKey: name => (os === "win32" ? name.toLowerCase().replace(/\.exe$/, "") : name.toLowerCase()),
    },
    settings: {
      available: o.available ?? {},
      change: async (name, value) => { o.changed?.push(`${name}=${value}`); return { before: "false", after: value === "on" ? "true" : "false" }; },
    },
    privacy: { isSecurityWindow: w => o.security?.(w) ?? false },
  };
}

interface Field { role: string; name: string; text?: string; states: string[]; bounds: Bounds }

/**
 * A window with one text field that takes no text by accessibility (a Chromium field): Ember's hands type into it.
 * The pretend hand records keys; Delete empties the field and the paste key puts in what was written to the clipboard.
 */
function harness(o: { system?: WorkerSystem; desk?: boolean; noCursor?: boolean; model?: string | null; activeWindow?: () => { app: string; title: string } | null;
  windows?: () => { app: string; pid: number | null; name: string; role: string; active: boolean; bounds: Bounds }[] } = {}) {
  const st = { keys: [] as string[], borrows: 0, asked: [] as string[], audit: [] as Record<string, unknown>[] };
  const field: Field = { role: "text", name: "Search", text: "old words", bounds: { x: 10, y: 60, width: 300, height: 30 }, states: ["enabled", "sensitive", "editable", "focusable", "focused"] };
  const frame: AxNode = { id: 1, parent: null, depth: 0, role: "frame", name: "Notes", states: [], bounds: FRAME };
  const nodes = (): AxNode[] => [frame, { id: 2, parent: 1, depth: 1, ...field }];
  const window = { app: "notes", pid: 7, path: "/org/a11y/atspi/accessible/9", name: "Notes", role: "frame", active: true, bounds: FRAME };
  const seen = () => ({ window, x11Window: null, nodes: nodes(), blocked: false, busy: false, truncated: null, others: [], ms: 0, axScale: 1 });
  const clip = { written: [] as string[] };
  const sys = o.system ?? LINUX_WORKER_SYSTEM;
  const hand: Hand = {
    glideTo: async () => undefined,
    click: async () => undefined,
    keys: async (k: string) => {
      st.keys.push(k);
      if (k === "Delete") field.text = "";
      if (k === sys.keys.edit.paste) field.text = clip.written.at(-1) ?? "";
    },
    type: async () => undefined,
    checkTyping: () => undefined,
    scroll: async () => undefined,
  };
  const w = new Worker({
    client: {} as never, log: quiet, model: o.model === undefined ? "m" : o.model, vision: false, workDir: "/tmp",
    perception: {
      perceive: async () => ({ ...seen(), text: "<screen>", capture: null }),
      read: async () => seen(),
      windows: async () => o.windows?.() ?? [window],
      systemDialogOpen: async () => false,
    } as never,
    sidecar: {
      readElement: async (id: number) => {
        const n = nodes().find(x => x.id === id);
        return n ? { role: n.role, name: n.name, states: n.states, bounds: n.bounds, ...(n.text !== undefined ? { text: n.text } : {}) } : null;
      },
      setText: async () => { throw new Error("background_unavailable: this app takes no text this way"); },
      doAction: async () => { throw new Error("background_unavailable: no accessible action"); },
    } as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({ notes: "act" }), keys: sys.keys, os: sys.os }),
    confirmer: { ask: async (q: { prompt: string }) => { st.asked.push(q.prompt); return "once"; } } as never,
    audit: { write: (e: Record<string, unknown>) => st.audit.push(e) } as never,
    settings: { get: () => ({ grants: {} }), update: () => undefined } as never,
    presenter: new Presenter(() => undefined),
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
    cursor: o.noCursor ? undefined : {
      borrow: { borrow: async (fn: (h: Hand) => Promise<void>, b: { onStart?: () => void }) => { st.borrows++; b.onStart?.(); await fn(hand); } } as never,
      findWindow: () => 1, setBorrowing: () => undefined,
      ...(o.activeWindow ? { activeWindow: o.activeWindow } : {}),
    },
    clipboard: {
      save: async () => ({ items: [{ "text/plain": "the user's" }], look: "x" }),
      unchanged: async () => true,
      writeText: async (t: string) => { clip.written.push(t); },
      restore: async () => undefined,
    },
    ...(o.desk ? { desk: async () => { throw new Error("no desk in this test"); } } : {}),
    ...(o.system ? { system: o.system } : {}),
  } as unknown as WorkerDeps, { id: "t1", goal: "write hello in the notes", target: { title: "Notes" } });
  const tools = () => w.tools();
  const call = (name: string, args: Record<string, unknown>) => tools().find(t => t.name === name)!.handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
  return { w, st, field, clip, tools, call };
}
const names = (h: ReturnType<typeof harness>) => h.tools().map(t => t.name);
const description = (h: ReturnType<typeof harness>, name: string) => String((h.tools().find(t => t.name === name) as unknown as { description: string }).description);

describe("a worker's tools follow what the OS offers", () => {
  it("has change_setting only where there are settings to change, and open_on_desk only with a desk", () => {
    expect(names(harness({ desk: true }))).toEqual(expect.arrayContaining(["change_setting", "open_on_desk", "open_app", "press_keys"]));
    const bare = names(harness({ system: fakeSystem("win32") }));
    expect(bare).toEqual(expect.arrayContaining(["open_app", "press_keys", "type_text"]));
    expect(bare).not.toContain("change_setting");
    expect(bare).not.toContain("open_on_desk");
  });

  it("offers and changes only the settings the OS has, through its own change", async () => {
    const changed: string[] = [];
    const h = harness({ system: fakeSystem("darwin", { available: { dark_style: "Dark appearance for apps" }, changed }) });
    expect(description(h, "change_setting")).toBe("Change a desktop setting directly: dark_style (Dark appearance for apps).");
    expect((await h.call("change_setting", { setting: "night_light", value: "on" })).resultType).toBe("failure");
    const r = await h.call("change_setting", { setting: "dark_style", value: "on" });
    expect(r.textResultForLlm).toContain("Dark appearance for apps: was false, now true.");
    expect(changed).toEqual(["dark_style=on"]);
  });

  it("describes apps and keys in the OS's words, and keeps Linux's descriptions as they were", () => {
    const mac = harness({ system: fakeSystem("darwin") });
    expect(description(mac, "open_app")).toBe("Start an application by name (for example TextEdit, Finder, System Settings).");
    expect(description(mac, "press_keys")).toContain("e.g. \"cmd+s\", \"Return\", \"cmd+shift+t\".");
    const linux = harness({ desk: true });
    expect(description(linux, "open_app")).toBe("Start an application by name (for example Text Editor, Files, Settings).");
    expect(description(linux, "press_keys")).toBe("Press a key or shortcut in the window you are working in, e.g. \"ctrl+s\", \"Return\", \"ctrl+shift+t\". Borrows the user's keyboard, so the user is asked first; prefer element tools when they work.");
    expect(description(linux, "change_setting")).toBe("Change a desktop setting directly: night_light (Night Light (warmer screen colours)); dark_style (Dark style for apps); do_not_disturb (Do Not Disturb (hide notification banners)); text_size (Text size, as a scale factor 0.5-3 (1 is normal)); battery_percentage (Show battery percentage in the top bar); clock_seconds (Show seconds in the top-bar clock).");
  });

  it("names the OS's settings shortcut when there is no model, and suggests the desk only where there is one", async () => {
    const mac = harness({ system: fakeSystem("darwin"), model: null });
    expect((await mac.w.run(new AbortController().signal)).summary).toBe("No model is available for tasks. Pick one in settings (Control+Shift+Command+E).");
    const linux = harness({ model: null });
    expect((await linux.w.run(new AbortController().signal)).summary).toBe("No model is available for tasks. Pick one in settings (Ctrl+Alt+E).");
    const noDesk = harness({ system: fakeSystem("win32"), noCursor: true });
    expect((await noDesk.call("type_text", { cell: "B5", text: "1", mode: "replace" })).textResultForLlm).toBe("Filling a cell needs the keyboard, which isn't available here. Tell the user in finish_task.");
    const desk = harness({ noCursor: true, desk: true });
    expect((await desk.call("type_text", { cell: "B5", text: "1", mode: "replace" })).textResultForLlm).toBe("Filling a cell needs the keyboard, which isn't available here. Try open_on_desk.");
  });
});

describe("opening an app on another OS", () => {
  it("finds its new window by the program as the OS names it (appKey), not by its title", async () => {
    const launched: string[] = [];
    const notepad: DesktopApp = { id: "notepad", name: "Notepad", file: "", keywords: [], programs: ["notepad"] };
    let open = false;
    const h = harness({
      system: fakeSystem("win32", { apps: [notepad], launched }),
      windows: () => (open ? [{ app: "Notepad.exe", pid: 9, name: "Untitled", role: "frame", active: true, bounds: FRAME }] : []),
    });
    const sys = (h.w as unknown as { sys: WorkerSystem }).sys;
    const launch = sys.apps.launch;
    sys.apps.launch = app => { launch(app); open = true; };
    const r = await h.call("open_app", { name: "Notepad" });
    expect(launched).toEqual(["Notepad"]);
    expect(r.textResultForLlm).toBe("Opened Notepad; now working in its window \"Untitled\". Call perceive_window.");
  });

  it("refuses a terminal by the OS's own test", async () => {
    const launched: string[] = [];
    const h = harness({ system: fakeSystem("win32", { apps: [{ id: "powershell", name: "Windows PowerShell", file: "", keywords: [] }], launched }) });
    const r = await h.call("open_app", { name: "Windows PowerShell" });
    expect(r.resultType).toBe("denied");
    expect(launched).toEqual([]);
  });
});

describe("the keys Ember presses itself", () => {
  it("are ⌘A, Delete and ⌘V on macOS when text is pasted into a field", async () => {
    const h = harness({ system: fakeSystem("darwin") });
    await h.call("perceive_window", {});
    const r = await h.call("type_text", { id: 2, text: "hello", mode: "replace" });
    expect(r.textResultForLlm).toMatch(/^Done/);
    expect(h.st.keys).toEqual(["cmd+a", "Delete", "cmd+v"]);
    expect(h.field.text).toBe("hello");
  });

  it("are still Ctrl+A, Delete and Ctrl+V on Linux, and Ctrl+End to append", async () => {
    const h = harness();
    await h.call("perceive_window", {});
    await h.call("type_text", { id: 2, text: "hello", mode: "replace" });
    expect(h.st.keys).toEqual(["ctrl+a", "Delete", "ctrl+v"]);
    const mac = harness({ system: fakeSystem("darwin") });
    await mac.call("perceive_window", {});
    await mac.call("type_text", { id: 2, text: " more", mode: "append" });
    expect(mac.st.keys).toEqual(["cmd+down", "cmd+v"]);
  });

  it("know on macOS that ⌘A then ⌘V replaces what the field held (afterKeys with the Mac's keys)", () => {
    const all = afterKeys("cmd+a", "abc", null, KEYS.darwin);
    expect(all).toEqual({ typed: "abc", selected: "all" });
    expect(afterKeys("cmd+v", "abc", all.selected, KEYS.darwin)).toEqual({ typed: "", selected: null });
    expect(afterKeys("shift+cmd+left", "abc", null, KEYS.darwin).selected).toBe("some");
    expect(afterKeys("alt+shift+right", "abc", null, KEYS.darwin).selected).toBe("some");
    // Read as Linux reads it, ⌘A is the logo key with A: nothing selected.
    expect(afterKeys("cmd+a", "abc", null)).toEqual({ typed: "abc", selected: null });
    expect(afterKeys("ctrl+a", "abc", null)).toEqual({ typed: "abc", selected: "all" });
  });
});

describe("an authentication prompt on another OS", () => {
  const prompt = () => ({ app: "credentialuibroker", title: "Windows Security" });

  it("stops press_keys before anything is borrowed, by the OS's security vocabulary (L9)", async () => {
    const h = harness({ system: fakeSystem("win32", { security: w => w.app === "credentialuibroker" }), activeWindow: prompt });
    await h.call("perceive_window", {});
    const r = await h.call("press_keys", { keys: "ctrl+s" });
    expect(r.resultType).toBe("denied");
    expect(r.textResultForLlm).toMatch(/^An authentication prompt is open on the user's screen/);
    expect(h.st.borrows).toBe(0);
    expect(h.st.keys).toEqual([]);
    expect(h.st.audit.some(e => e.reason === "an authentication prompt has the keyboard")).toBe(true);
  });

  it("is judged by the Linux vocabulary when the worker has no system (which doesn't know that program)", async () => {
    const h = harness({ activeWindow: prompt });
    await h.call("perceive_window", {});
    await h.call("press_keys", { keys: "ctrl+s" });
    expect(h.st.borrows).toBe(1);
  });
});

describe("a Save dialog's note on another OS", () => {
  it("reads the OS's file-path words (Linux's by default)", () => {
    const dialog = { name: "Save As", role: "dialog" };
    expect(dialogNote(dialog, [], "save it as notes.txt")).toBe("");
    expect(dialogNote(dialog, [], "save it as notes.txt", "darwin")).toBe("");
    expect(dialogNote(dialog, [], "save it", "win32")).toMatch(/^\nNote: the user named no file/);
  });
});

describe("the clipboard around a paste on another OS", () => {
  class Item { constructor(readonly data: Record<string, unknown>) {} }
  /** A clipboard as Electron lists it, read and written through `formats` (Linux's by default). */
  function board(initial: Record<string, unknown>[], formats?: ClipboardFormats) {
    const entry = (d: Record<string, unknown>) => ({ types: Object.keys(d), getType: async (t: string) => d[t] });
    const state = { items: initial.map(entry), writes: [] as Record<string, unknown>[][], texts: [] as string[] };
    const cb = electronClipboard<Item>({
      read: async () => state.items,
      write: async items => { state.writes.push(items.map(i => i.data)); state.items = items.map(i => entry(i.data)); },
      writeText: async t => { state.texts.push(t); state.items = [entry({ "text/plain": t })]; },
      clear: () => { state.items = []; },
    }, Item as unknown as new (d: Record<string, never>) => Item, 200, formats);
    return { state, cb };
  }
  /** A Mac's rules as V plans them while rich formats are unverified: MIME types saved, the concealed marker not. */
  const mac: ClipboardFormats = {
    savable: t => /^[\w.+-]+\/[\w.+-]+/.test(t),
    passwordMarker: t => t === "org.nspasteboard.ConcealedType",
    ownTextMarkers: ["org.nspasteboard.TransientType"],
  };

  it("never puts back a password manager's copy marked in a format the OS doesn't save (fails closed)", async () => {
    const b = board([{ "text/plain": "hunter2", "org.nspasteboard.ConcealedType": "" }], mac);
    const saved = await b.cb.save();
    expect(saved.items).toEqual([{ "text/plain": "hunter2" }]);
    expect(holdsPassword(saved)).toBe(true);
  });

  it("marks Ember's own text with the OS's markers, and writes plain text on Linux as before", async () => {
    const b = board([], mac);
    await b.cb.writeText("hello");
    expect(b.state.writes).toEqual([[{ "text/plain": "hello", "org.nspasteboard.TransientType": "1" }]]);
    const linux = board([], CLIPBOARD_FORMATS.linux);
    await linux.cb.writeText("hello");
    expect([linux.state.texts, linux.state.writes]).toEqual([["hello"], []]);
  });

  it("judges Linux's password marker as before, with or without the formats given", async () => {
    for (const formats of [undefined, CLIPBOARD_FORMATS.linux]) {
      const b = board([{ "text/plain": "hunter2", "x-kde-passwordManagerHint": "secret" }], formats);
      expect(holdsPassword(await b.cb.save())).toBe(true);
      const plain = board([{ "text/plain": "notes" }], formats);
      const saved = await plain.cb.save();
      expect([holdsPassword(saved), "password" in saved]).toEqual([false, false]);
    }
  });
});
