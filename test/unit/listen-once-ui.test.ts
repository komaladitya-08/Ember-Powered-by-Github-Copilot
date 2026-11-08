import { describe, expect, it, vi } from "vitest";
import { listenOnceShown, type ListenOnceStatus } from "../../app/shared/ipc";
import { boxRows } from "../../app/renderer/ask/field";
import { mountListenOnce } from "../../app/renderer/shared/listen-once";

vi.mock("electron", () => ({ BrowserWindow: class {}, Menu: {}, screen: {}, ipcMain: { on() {} } }));
const { askOpeningRows } = await import("../../app/main/ask");

function control(request: (on: boolean) => Promise<ListenOnceStatus>) {
  const button = Object.assign(new EventTarget(), { textContent: "", setAttribute: vi.fn() });
  const detail = { textContent: "" };
  const update = mountListenOnce(button as unknown as HTMLButtonElement, detail as HTMLElement, request, "Speak one request.");
  const click = async () => { button.dispatchEvent(new Event("click")); await Promise.resolve(); };
  return { button, detail, update, click };
}

describe("Listen once controls", () => {
  it("shows why listening is blocked as a control that can't be used now, takes no press, and switches to Cancel during capture (companion-3)", async () => {
    const request = vi.fn(async (on: boolean): Promise<ListenOnceStatus> => on
      ? { phase: "listening", detail: "Listening for one request…" }
      : { phase: "ready", detail: "" });
    const ui = control(request);
    await ui.click();
    expect(request).not.toHaveBeenCalled();
    ui.update({ phase: "blocked", detail: "The microphone is muted." });
    expect(ui.detail.textContent).toBe("The microphone is muted.");
    // Announced as unavailable (WCAG 4.1.2), not as a button that flashes "Checking the microphone…" and does nothing.
    expect(ui.button.setAttribute).toHaveBeenLastCalledWith("aria-disabled", "true");
    await ui.click();
    expect(request).not.toHaveBeenCalled();
    expect(ui.detail.textContent).toBe("The microphone is muted.");
    // Main says when the block lifts (it pushes the status): then a press listens.
    ui.update({ phase: "ready", detail: "" });
    expect(ui.button.setAttribute).toHaveBeenLastCalledWith("aria-disabled", "false");
    await ui.click();
    expect(request).toHaveBeenLastCalledWith(true);
    expect(ui.button.textContent).toBe("Cancel listening");
    expect(ui.detail.textContent).toBe("Listening for one request…");
    await ui.click();
    expect(request).toHaveBeenLastCalledWith(false);
    expect(ui.button.textContent).toBe("Listen once");
    expect(ui.detail.textContent).toBe("Speak one request.");
  });

  it("ignores repeat clicks in flight and keeps the latest pushed status over a late reply", async () => {
    let finish!: (s: ListenOnceStatus) => void;
    const request = vi.fn(() => new Promise<ListenOnceStatus>(resolve => { finish = resolve; }));
    const ui = control(request);
    ui.update({ phase: "ready", detail: "" });
    await ui.click();
    expect(ui.button.setAttribute).toHaveBeenLastCalledWith("aria-disabled", "true");
    await ui.click();
    expect(request).toHaveBeenCalledTimes(1);
    ui.update({ phase: "ready", detail: "Listening ended." });
    finish({ phase: "starting", detail: "Starting the microphone…" });
    await Promise.resolve();
    expect(ui.button.setAttribute).toHaveBeenLastCalledWith("aria-disabled", "false");
    expect(ui.button.textContent).toBe("Listen once");
    expect(ui.detail.textContent).toBe("Listening ended.");
  });

  it("keeps Cancel available when the request fails while listening", async () => {
    const ui = control(async () => { throw new Error("internal detail"); });
    ui.update({ phase: "checking", detail: "Checking your voice…" });
    await ui.click();
    expect(ui.button.textContent).toBe("Cancel listening");
    expect(ui.detail.textContent).toBe("Couldn't update the microphone. Try again.");
    expect(ui.button.setAttribute).toHaveBeenLastCalledWith("aria-disabled", "false");
  });

  it("tells screen readers each new line but never that Ember is already listening, nor the line it comes back to (voice-listening-c3-1)", async () => {
    // The line changed as a wake's window opened ("Ember is already listening.") and back as it closed: a screen reader
    // said it over the microphone, into the request, or into the conversation as a request of its own.
    const said: string[] = [];
    const live = { set textContent(t: string) { said.push(t); }, get textContent() { return said.at(-1) ?? ""; } };
    const button = Object.assign(new EventTarget(), { textContent: "", setAttribute: vi.fn() });
    const detail = { textContent: "" };
    const update = mountListenOnce(button as unknown as HTMLButtonElement, detail as HTMLElement, async () => ({ phase: "listening", detail: "Listening for one request…" }), "Speak one request.", undefined, live as unknown as HTMLElement);
    update({ phase: "ready", detail: "" });
    expect(said.at(-1)).toBe("Speak one request.");
    const before = said.length;
    for (const s of [{ phase: "blocked", detail: "Ember is already listening.", reason: "listening" }, { phase: "ready", detail: "" }, { phase: "blocked", detail: "Ember is already listening.", reason: "listening" }, { phase: "ready", detail: "" }] as const) {
      update(s);
      // Shown all the same, and the control is unavailable while it says so.
      expect(detail.textContent).toBe(s.detail || "Speak one request.");
    }
    expect(said.slice(before)).toEqual([]);
    // Anything else is said as it comes, a press's own lines with it.
    update({ phase: "blocked", detail: "The microphone is muted.", reason: undefined });
    update({ phase: "ready", detail: "" });
    button.dispatchEvent(new Event("click"));
    await Promise.resolve(); await Promise.resolve();
    expect(said.slice(before)).toEqual(["The microphone is muted.", "Speak one request.", "Checking the microphone…", "Listening for one request…"]);
  });

  it("adds room for the control and a wrapped explanation alongside the existing rows", () => {
    expect(boxRows(1, false, false, 0, 1)).toBe(2);
    expect(boxRows(4, true, true, 1, 2)).toBe(9);
  });

  it("is left out of Ask only where the organisation turned voice off, and Ask opens without its rows then (companion-3)", () => {
    expect(listenOnceShown(undefined)).toBe(true);
    expect(listenOnceShown({ phase: "ready", detail: "" })).toBe(true);
    expect(listenOnceShown({ phase: "blocked", detail: "Answer Ember's question first." })).toBe(true);
    expect(listenOnceShown({ phase: "blocked", detail: "Download speech models in Settings first.", fix: "settings" })).toBe(true);
    expect(listenOnceShown({ phase: "blocked", detail: "Your organisation has turned voice off.", fix: "admin" })).toBe(false);
    const context = (listenOnce?: ListenOnceStatus) => ({ sees: null, history: [], ...(listenOnce ? { listenOnce } : {}) });
    expect(askOpeningRows(context())).toBe(3);
    expect(askOpeningRows({ ...context({ phase: "blocked", detail: "", fix: "settings" }), tip: true, suggestions: ["What's next?"] })).toBe(5);
    expect(askOpeningRows(context({ phase: "blocked", detail: "Your organisation has turned voice off.", fix: "admin" }))).toBe(1);
    expect(askOpeningRows({ ...context({ phase: "blocked", detail: "", fix: "admin" }), suggestions: ["What's next?"] })).toBe(2);
  });
});
