import { describe, expect, it, vi } from "vitest";
import { listenOnceShown, type ListenOnceStatus } from "../../app/shared/ipc";
import { boxRows } from "../../app/renderer/ask/field";
import { mountListenOnce } from "../../app/renderer/shared/listen-once";
import { LISTEN_ONCE_READY } from "../../app/renderer/home/copy";
import { calledByName } from "../../app/voice/engine";

vi.mock("electron", () => ({ BrowserWindow: class {}, Menu: {}, screen: {}, ipcMain: { on() {} } }));
const { askOpeningRows } = await import("../../app/main/ask");

function control(request: (on: boolean) => Promise<ListenOnceStatus>) {
  const button = Object.assign(new EventTarget(), { textContent: "", setAttribute: vi.fn() });
  const detail = { textContent: "" };
  const update = mountListenOnce(button as unknown as HTMLButtonElement, detail as HTMLElement, request, "Speak one request.");
  const click = async () => { button.dispatchEvent(new Event("click")); await Promise.resolve(); };
  return { button, detail, update, click };
}

/** A status line as a screen reader hears it: each line written to it is said, and an emptied one says nothing. */
function statusLine() {
  const said: string[] = [];
  let now = "";
  const live = { set textContent(t: string) { now = t; if (t) said.push(t); }, get textContent() { return now; } };
  return { said, live };
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
    const { said, live } = statusLine();
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
    // (Nor does the status line keep a line that no longer holds beside the one shown: voice-listening-v4-2.)
    expect(live.textContent).toBe("");
    // Anything else is said as it comes, a press's own lines with it.
    update({ phase: "blocked", detail: "The microphone is muted.", reason: undefined });
    update({ phase: "ready", detail: "" });
    button.dispatchEvent(new Event("click"));
    await Promise.resolve(); await Promise.resolve();
    expect(said.slice(before)).toEqual(["The microphone is muted.", "Speak one request.", "Checking the microphone…", "Listening for one request…"]);
  });

  it("says “Request heard.” once: not again when the line comes back after what a press would stop first (voice-listening-r6-4)", async () => {
    // Main keeps "Request heard." as Listen once's line. While the answer was on its way the line read "Stops the answer
    // on its way, …", and as the answer ended it came back, so a screen reader said "Request heard." a second time, after
    // the answer, into the wake word's microphone.
    const { said, live } = statusLine();
    const button = Object.assign(new EventTarget(), { textContent: "", setAttribute: vi.fn() });
    const detail = { textContent: "" };
    const heard: ListenOnceStatus = { phase: "ready", detail: "Request heard." };
    const stops: ListenOnceStatus = { phase: "ready", detail: "Stops the answer on its way, then listens for one request." };
    const update = mountListenOnce(button as unknown as HTMLButtonElement, detail as HTMLElement, async () => ({ phase: "listening", detail: "Listening for one request…" }), "Speak one request.", undefined, live as unknown as HTMLElement);
    update({ phase: "checking", detail: "Checking what was said…" });
    const before = said.length;
    for (const s of [heard, stops, heard]) update(s);
    expect(said.slice(before)).toEqual(["Request heard.", "Stops the answer on its way, then listens for one request."]);
    // Shown as before, and the status line keeps no line that no longer holds beside it (voice-listening-v4-2).
    expect(detail.textContent).toBe("Request heard.");
    expect(live.textContent).toBe("");
    // The next answer's line is said, and the old news still isn't; nor while Ember talks ("Stops speaking first, …").
    for (const s of [stops, heard, { phase: "ready", detail: "Stops speaking first, then listens for one request." } as const, heard]) update(s);
    expect(said.slice(before + 2)).toEqual(["Stops the answer on its way, then listens for one request.", "Stops speaking first, then listens for one request."]);
    // A line that comes back after the control was blocked, or after a new press, is news: said.
    update({ phase: "blocked", detail: "Unmute the microphone first." });
    update(heard);
    expect(said.slice(-2)).toEqual(["Unmute the microphone first.", "Request heard."]);
    button.dispatchEvent(new Event("click"));
    await Promise.resolve(); await Promise.resolve();
    update(heard);
    expect(said.slice(-3)).toEqual(["Checking the microphone…", "Listening for one request…", "Request heard."]);
  });

  it("says nothing more when a press finds Ember already listening, and never leaves “Checking the microphone…” to be read beside it (voice-listening-v4-2)", async () => {
    // A window opened as Listen once was pressed: its answer, "Ember is already listening.", would be said into that
    // window (voice-listening-c3-1), and the status line kept "Checking the microphone…", read in browse mode beside it.
    const { said, live } = statusLine();
    const button = Object.assign(new EventTarget(), { textContent: "", setAttribute: vi.fn() });
    const detail = { textContent: "" };
    const update = mountListenOnce(button as unknown as HTMLButtonElement, detail as HTMLElement, async () => ({ phase: "blocked", detail: "Ember is already listening.", reason: "listening" }), "Speak one request.", undefined, live as unknown as HTMLElement);
    update({ phase: "ready", detail: "" });
    button.dispatchEvent(new Event("click"));
    await Promise.resolve(); await Promise.resolve();
    expect(detail.textContent).toBe("Ember is already listening.");
    expect(button.setAttribute).toHaveBeenLastCalledWith("aria-disabled", "true");
    expect(live.textContent).toBe("");
    // The window closes: the line before the press is back, and it was said then, so it isn't said again (Home's names
    // “Hey Ember”, which would be said into the wake word's microphone).
    update({ phase: "ready", detail: "" });
    expect(said).toEqual(["Checking the microphone…", "Speak one request.", "Checking the microphone…"]);
    // What comes next is said.
    update({ phase: "blocked", detail: "The microphone is muted." });
    expect(said.at(-1)).toBe("The microphone is muted.");
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
    // Beside an answer still coming in, the row for its follow-ups is reserved too, as tall as a row of chips is in the
    // box (two of its rows), so the box opens as tall as it stays (accessibility-visual-c4-1).
    expect(askOpeningRows({ ...context(), suggestionsComing: true })).toBe(5);
  });

  it("words Home's ready line without Ember's name, which a screen reader says as the wake word's microphone opens (voice-listening-c4-2)", () => {
    // "Press Listen once, then say one request without saying “Hey Ember”." changed to ready as listening started (each
    // switch-on, unmute and restart), and read into the microphone just opened it woke Ember in 11 of 20 placements.
    expect(LISTEN_ONCE_READY).toBe("Press Listen once, then just say your request.");
    const words = LISTEN_ONCE_READY.split(/\s+/);
    for (let i = 0; i < words.length; i++) expect(calledByName(words.slice(i).join(" "))).toBe(false);
  });
});
