import { describe, expect, it, vi } from "vitest";
import type { ListenOnceStatus } from "../../app/shared/ipc";
import { boxRows } from "../../app/renderer/ask/field";
import { mountListenOnce } from "../../app/renderer/shared/listen-once";

function control(request: (on: boolean) => Promise<ListenOnceStatus>) {
  const button = Object.assign(new EventTarget(), { textContent: "", setAttribute: vi.fn() });
  const detail = { textContent: "" };
  const update = mountListenOnce(button as unknown as HTMLButtonElement, detail as HTMLElement, request, "Speak one request.");
  const click = async () => { button.dispatchEvent(new Event("click")); await Promise.resolve(); };
  return { button, detail, update, click };
}

describe("Listen once controls", () => {
  it("shows why listening is blocked, lets main recheck, and switches to Cancel during capture", async () => {
    const request = vi.fn(async (on: boolean): Promise<ListenOnceStatus> => on
      ? { phase: "listening", detail: "Listening for one request…" }
      : { phase: "ready", detail: "" });
    const ui = control(request);
    await ui.click();
    expect(request).not.toHaveBeenCalled();
    ui.update({ phase: "blocked", detail: "The microphone is muted." });
    expect(ui.detail.textContent).toBe("The microphone is muted.");
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

  it("adds room for the control and a wrapped explanation alongside the existing rows", () => {
    expect(boxRows(1, false, false, 0, 1)).toBe(2);
    expect(boxRows(4, true, true, 1, 2)).toBe(9);
  });
});
