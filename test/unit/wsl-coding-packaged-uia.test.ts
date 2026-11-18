/** Modeled UIA/input ports prove guard/order conservation only; no Windows process, input or authority is issued. */
import { expect, it, vi } from "vitest";
import { WslPackagedUi, wslUiId, wslUiName, type WslUiPorts } from "../fixtures/wsl-coding-packaged-uia";
import type { RawNode } from "../integration/uia-client";

function fixture() {
  const target: RawNode = { h: 17, pid: 7, runtimeId: "stable", controlType: "Button", automationId: "target", name: "Choose", isEnabled: true,
    isOffscreen: false, hasKeyboardFocus: true, bounds: { x: 10, y: 20, width: 30, height: 40 }, patterns: {} };
  const state = { current: true, blocked: false, focused: false, replace: false, disable: false, relabel: false, loseAfterMove: false, retireDuringFocus: false, foreground: 123 };
  const refused = new Error("Fixed UI proof refusal."), events: string[] = [];
  const input = { blockedReason: () => state.blocked ? "protected" : null, activeWindow: () => state.foreground,
    activate: vi.fn(() => { events.push("activate"); state.foreground = 123; }),
    move: vi.fn(() => { events.push("move"); if (state.loseAfterMove) state.foreground = 456; }),
    button: vi.fn((_button: number, down: boolean) => { events.push(down ? "down" : "up"); }), releaseAll: vi.fn(() => { events.push("release"); }),
    keysymOf: vi.fn(() => 1), keysym: vi.fn(() => true), textKey: vi.fn((_character: string, _down: boolean) => true) };
  const bridge = {
    request: vi.fn(async () => ({ result: { busy: false, truncated: false, cut: [], nodes: [{ ...target,
      runtimeId: state.focused && state.replace ? "replacement" : target.runtimeId, isEnabled: !(state.focused && state.disable), name: state.focused && state.relabel ? "Different action" : target.name }] } })),
    call: vi.fn(async (method: string) => {
      events.push(method);
      if (method === "perform") { state.focused = true; if (state.retireDuringFocus) state.current = false; return {}; }
      return { hwnd: 123, element: target };
    }),
  };
  const ports = { bridge, input, pid: 7, deadline: Date.now() + 30_000, refuse: () => refused,
    current: () => { if (!state.current) throw refused; } } as unknown as WslUiPorts;
  return { state, target, events, input, bridge, refused, ui: new WslPackagedUi(ports) };
}
it("preserves the real void-returning input contract and checks identity before the pointer gesture", async () => {
  const f = fixture(); await f.ui.click(123, wslUiId("target"));
  expect(f.events).toEqual(["activate", "perform", "focused", "move", "down", "up", "release"]);
  expect(f.input.move).toHaveBeenCalledExactlyOnceWith(25, 40);
});
it.each(["replace", "disable", "retireDuringFocus"] as const)("refuses %s after focus without sending pointer input", async kind => {
  const f = fixture(); f.state[kind] = true;
  await expect(f.ui.click(123, wslUiId("target"))).rejects.toBe(f.refused);
  expect(f.input.move).not.toHaveBeenCalled(); expect(f.input.button).not.toHaveBeenCalled();
});
it("keeps a protected foreground out of the input path", async () => {
  const f = fixture(); f.state.blocked = true;
  await expect(f.ui.click(123, wslUiId("target"))).rejects.toBe(f.refused);
  expect(f.input.activate).not.toHaveBeenCalled(); expect(f.bridge.call).not.toHaveBeenCalled(); expect(f.input.button).not.toHaveBeenCalled();
});
it("checks the selected action again when the same control changes its label during focus", async () => {
  const f = fixture(); f.state.relabel = true;
  await expect(f.ui.click(123, wslUiName("Choose"))).rejects.toBe(f.refused);
  expect(f.input.move).not.toHaveBeenCalled(); expect(f.input.button).not.toHaveBeenCalled();
});
it("does not press after foreground loss during movement and still releases held input", async () => {
  const f = fixture(); f.state.loseAfterMove = true;
  await expect(f.ui.click(123, wslUiId("target"))).rejects.toBe(f.refused);
  expect(f.input.button.mock.calls).toEqual([[1, false]]); expect(f.input.releaseAll).toHaveBeenCalledOnce();
});
it("preserves an input exception while releasing the pointer in finally", async () => {
  const f = fixture(), original = new Error("Fixed synthetic input fault.");
  f.input.button.mockImplementation((_button, down) => { if (down) throw original; });
  await expect(f.ui.click(123, wslUiId("target"))).rejects.toBe(original);
  expect(f.input.button.mock.calls).toEqual([[1, true], [1, false]]); expect(f.input.releaseAll).toHaveBeenCalledOnce();
});
it("does not query or input after retirement at entry", async () => {
  const f = fixture(); f.state.current = false;
  await expect(f.ui.click(123, wslUiId("target"))).rejects.toBe(f.refused);
  expect(f.bridge.request).not.toHaveBeenCalled(); expect(f.bridge.call).not.toHaveBeenCalled(); expect(f.input.activate).not.toHaveBeenCalled();
});
it.each(["blocked", "foreground"] as const)("stops normal folder-path typing after %s changes between characters", kind => {
  const f = fixture();
  f.input.textKey.mockImplementation((_character: string, down: boolean) => { if (!down) { if (kind === "blocked") f.state.blocked = true; else f.state.foreground = 456; } return true; });
  expect(() => f.ui.type(123, "ab")).toThrow(f.refused);
  expect(f.input.textKey.mock.calls).toEqual([["a", true], ["a", false]]); expect(f.input.releaseAll).toHaveBeenCalledOnce();
});
it("reads a control's text again when the control did not answer in time, and refuses any other error (WSL packaged, Server 2022 phase 52)", async () => {
  const f = fixture(), request = f.bridge.request as unknown as ReturnType<typeof vi.fn>; let asked = 0;
  request.mockImplementation(async (...args: unknown[]) => {
    if (args[0] !== "textInfo") return { result: { busy: false, truncated: false, cut: [], nodes: [f.target] } };
    return ++asked === 1 ? { error: { code: "busy" } } : { result: { text: "npm test" } };
  });
  await expect(f.ui.text(123, wslUiId("target"))).resolves.toBe("npm test"); expect(asked).toBe(2); expect(f.ui.textStage).toBe(0);
  request.mockImplementation(async (...args: unknown[]) => args[0] === "textInfo" ? { error: { code: "stale" } }
    : { result: { busy: false, truncated: false, cut: [], nodes: [f.target] } });
  await expect(f.ui.text(123, wslUiId("target"))).rejects.toBe(f.refused); expect(f.ui.textStage).toBe(2);
});
it("takes a just-opened window that lists nothing as not ready only where asked, and never a read cut short", async () => {
  const f = fixture(), request = f.bridge.request as unknown as ReturnType<typeof vi.fn>; request.mockResolvedValue({ result: { busy: false, truncated: false, cut: [], nodes: [] } });
  await expect(f.ui.nodes(123, false, true)).resolves.toEqual([]);
  await expect(f.ui.nodes(123)).rejects.toBe(f.refused); expect(f.ui.readRefusal).toBe(3);
  request.mockResolvedValue({ result: { busy: false, truncated: true, cut: [], nodes: [f.target] } });
  await expect(f.ui.nodes(123, false, true)).rejects.toBe(f.refused); expect(f.ui.readRefusal).toBe(2);
});
it("takes a read the bridge cut short by time alone as a busy one, and refuses a read cut any other way (WSL packaged, Server 2022 phase 38)", async () => {
  const f = fixture(), request = f.bridge.request as unknown as ReturnType<typeof vi.fn>;
  request.mockResolvedValue({ result: { busy: false, truncated: true, cut: ["time"], nodes: [f.target] } });
  await expect(f.ui.nodes(123)).resolves.toEqual([]); expect(f.ui.readRefusal).toBe(0);
  for (const cut of [["nodes"], ["time", "nodes"], ["depth"], ["offscreen"]]) {
    request.mockResolvedValue({ result: { busy: false, truncated: true, cut, nodes: [f.target] } });
    await expect(f.ui.nodes(123)).rejects.toBe(f.refused); expect(f.ui.readRefusal).toBe(2);
  }
});
