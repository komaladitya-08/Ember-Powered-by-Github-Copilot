/**
 * The ask box's quick look on Windows and macOS (cross-review P1): the box shows before the screen is read, so by the
 * time the accessibility host reads the user's window the box has the keyboard and nothing there says it has it (UI
 * Automation's HasKeyboardFocus is the whole system's). Main tells the read what had the keyboard then (`focusBefore`):
 * on Windows the focused child window it took just before the box showed, on macOS nothing, and the host asks the app,
 * which keeps its own focus (AXFocusedUIElement). The host takes that element for the one with the keyboard, reads its
 * selection, and the ask context says "Focused:" and "Selected text:" again, as on Linux.
 */

import { describe, expect, it, vi } from "vitest";
import { Host } from "../../app/sidecar-host/host";
import { FakeProvider, type FakeElementSpec, type FakeWindowSpec } from "../../app/sidecar-host/providers/fake";
import { ProviderError } from "../../app/sidecar-host/provider";
import { Perception } from "../../app/main/perception";
import type { AtspiSidecar, AxNode, ReadWindowResult } from "../../app/main/perception/sidecar";
import type { PerceptionWindows, X11Window } from "../../app/main/platform/types";
import type { Logger } from "../../app/main/logger";

const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const PID = 30;
const EDITOR = 0x41;
const SELECTED = "the meeting moved to Friday";

/**
 * Notepad, not the active window (Ember's ask box is): its text area is a child window of its own (EDITOR) holding a
 * selection, and a password field beside it in another; nothing says it has the keyboard. `body`: the text area's
 * spec on top of that, `extra`: more of the window's elements.
 */
function notepad(body: Partial<FakeElementSpec> = {}, extra: FakeElementSpec[] = []): FakeWindowSpec[] {
  return [{
    role: "Window", name: "notes.txt - Notepad", pid: PID, app: "notepad", bounds: at(0, 0, 800, 600), native: 0x40, children: [
      { role: "MenuItem", name: "File", bounds: at(0, 30, 40, 20), actions: ["expand"] },
      {
        role: "Edit", name: "Text editor", native: EDITOR, multiLine: true, editable: true, focusable: true,
        value: `Dear Sam, ${SELECTED}.`, selectionText: SELECTED, bounds: at(0, 50, 800, 500), actions: ["setValue", "focus"], ...body,
      },
      { role: "Edit", name: "Vault key", native: 0x42, password: true, editable: true, focusable: true, bounds: at(0, 560, 300, 24) },
      ...extra,
    ],
  }];
}

function harness(windows: FakeWindowSpec[]) {
  const fake = new FakeProvider(windows);
  const host = new Host(fake, { env: { EMBER_ATSPI_ID_BASE: "10000000" }, settleMs: 0 });
  let n = 1;
  const call = async <T = ReadWindowResult>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const msg = JSON.parse((await host.handle(JSON.stringify({ jsonrpc: "2.0", id: n++, method, params })))!);
    if (msg.error) throw new Error(msg.error.message);
    return msg.result as T;
  };
  const read = (params: Record<string, unknown> = {}) => call("read_window", { pid: PID, title: "notes.txt - Notepad", ...params });
  return { fake, host, call, read };
}
const focused = (r: { nodes: AxNode[] }) => r.nodes.filter(n => n.states.includes("focused"));
const named = (r: { nodes: AxNode[] }, name: string) => r.nodes.find(n => n.name === name)!;

describe("the host's read for the ask box, once the box has the keyboard (cross-review P1)", () => {
  it("knows nothing had the keyboard when it isn't told (the read before this fix)", async () => {
    const r = await harness(notepad()).read();
    expect(focused(r)).toEqual([]);
    expect(named(r, "Text editor").selection).toBeUndefined();
  });

  it("takes the element whose own window had the keyboard (Windows) for the one with it, and reads its selection", async () => {
    const r = await harness(notepad()).read({ focusBefore: { native: EDITOR } });
    expect(focused(r).map(n => n.name)).toEqual(["Text editor"]);
    expect(named(r, "Text editor").selection).toBe(SELECTED);
  });

  it("leaves the read as it is where something says it has the keyboard", async () => {
    const find: FakeElementSpec = { role: "Edit", name: "Find what", focused: true, editable: true, value: "Friday", bounds: at(400, 30, 200, 20) };
    const r = await harness(notepad({}, [find])).read({ focusBefore: { native: EDITOR } });
    expect(focused(r).map(n => n.name)).toEqual(["Find what"]);
    expect(named(r, "Text editor").selection).toBeUndefined();
  });

  it("never takes the window itself, nor an element of another window", async () => {
    const h = harness(notepad());
    expect(focused(await h.read({ focusBefore: { native: 0x40 } }))).toEqual([]);
    expect(focused(await h.read({ focusBefore: { native: 0x99 } }))).toEqual([]);
    expect(focused(await h.read({ focusBefore: { native: "65" } }))).toEqual([]);
  });

  it("names a secret field that had the keyboard as one, and reads nothing of it", async () => {
    const r = await harness(notepad()).read({ focusBefore: { native: 0x42 } });
    const key = named(r, "Vault key");
    expect(focused(r)).toEqual([key]);
    expect(key.secret).toBe(true);
    expect(key.selection).toBeUndefined();
    expect(key.text).toBeUndefined();
  });

  it("asks the app what has its keyboard where main couldn't tell (macOS), only when told to", async () => {
    const h = harness(notepad({ native: undefined, appFocus: true }));
    const asked = vi.spyOn(h.fake, "focusedKey");
    expect(focused(await h.read())).toEqual([]);
    expect(asked).not.toHaveBeenCalled();
    const r = await h.read({ focusBefore: {} });
    expect(asked).toHaveBeenCalledWith(PID);
    expect(focused(r).map(n => n.name)).toEqual(["Text editor"]);
    expect(named(r, "Text editor").selection).toBe(SELECTED);
  });

  it("reads the window as before when the app can't say (busy, or no answer)", async () => {
    const h = harness(notepad({ native: undefined, appFocus: true }));
    vi.spyOn(h.fake, "focusedKey").mockRejectedValueOnce(new ProviderError("busy", "its app is busy"));
    const r = await h.read({ focusBefore: {} });
    expect(r.window?.name).toBe("notes.txt - Notepad");
    expect(focused(r)).toEqual([]);
    vi.spyOn(h.fake, "focusedKey").mockRejectedValueOnce(new Error("AX said no"));
    expect(focused(await h.read({ focusBefore: {} }))).toEqual([]);
  });
});

describe("the ask context on Windows and macOS, end to end through Perception and the host (cross-review P1)", () => {
  const OWN = 999;
  const user: X11Window & { wmClass: string } = { id: 0x40, pid: PID, title: "notes.txt - Notepad", wmClass: "notepad", x: 0, y: 0, width: 800, height: 600 };
  const box: X11Window & { wmClass: string } = { id: 0x50, pid: OWN, title: "Ask Ember", wmClass: "ember", x: 0, y: 0, width: 560, height: 92 };

  function perceptionOver(windows: FakeWindowSpec[]) {
    const { call } = harness(windows);
    const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } } as unknown as Logger;
    const sidecar = {
      readWindow: (p: Record<string, unknown>) => call("read_window", p),
      markSecret: async () => undefined,
      scaleElements: () => undefined,
    } as unknown as AtspiSidecar;
    // The box has the keyboard now: the window system names it as active.
    const ws: PerceptionWindows = { stack: () => [], activeWindow: () => box, focusWindow: () => box, clientWindows: () => [], capture: () => null };
    return new Perception({ sidecar, x11: ws, log, neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }), ownPid: OWN });
  }

  it("says what had the keyboard and what was selected there (Windows)", async () => {
    const p = perceptionOver(notepad());
    const before = await p.quickContext(user);
    expect(before?.text).toContain("App: \"notepad\", window: \"notes.txt - Notepad\".");
    expect(before?.text).not.toContain("Selected text:");
    const ctx = await p.quickContext(user, { native: EDITOR });
    expect(ctx?.text).toContain("Focused: text \"Text editor\".");
    expect(ctx?.text).toContain(`Selected text: "${SELECTED}".`);
  });

  it("says so on macOS too, where the app keeps its own focus", async () => {
    const ctx = await perceptionOver(notepad({ native: undefined, appFocus: true })).quickContext(user, {});
    expect(ctx?.text).toContain(`Selected text: "${SELECTED}".`);
  });
});
