/**
 * The prompt window comes up where the user is (review #272): its controller asks windows.ts's placement to move it to
 * the display nearest the pointer and onto every workspace before it shows a card. Plain Node with a fake window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPromptWindowController } from "../../app/main/remote/prompt-window";
import type { BrowserWindowLike, IpcLike, WebContentsLike } from "../../app/main/targets/types";
import type { Logger } from "../../app/main/logger";

const ipc: IpcLike = { on: () => undefined, handle: () => undefined } as unknown as IpcLike;
const log: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => log, file: "" };

class FakeWindow implements BrowserWindowLike {
  webContents = { id: 77, send: () => undefined } as unknown as WebContentsLike;
  calls: string[] = [];
  visible = false;
  show() { this.visible = true; this.calls.push("show"); }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  focus() { this.calls.push("focus"); }
  close() { /* not used */ }
  moveTop() { this.calls.push("moveTop"); }
  isVisible() { return this.visible; }
  isMinimized() { return false; }
  isDestroyed() { return false; }
  isAlwaysOnTop() { return true; }
  isFocused() { return false; }
  setAlwaysOnTop() { /* windows.ts sets it */ }
  setBounds() { /* not used */ }
  setContentProtection() { /* windows.ts sets it */ }
  on() { /* not used */ }
  placeNearUser() { this.calls.push("place"); }
  setOnAllWorkspaces(on: boolean) { this.calls.push(`workspaces:${on}`); }
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("the prompt window's placement (review #272)", () => {
  it("moves to the user's display and every workspace before it shows a card", () => {
    const w = new FakeWindow();
    const ctl = createPromptWindowController({ create: () => w, ipc, log, os: "linux" });
    void ctl.ask({ id: "h1", kind: "host-key", host: "build-01", address: "203.0.113.7", fingerprint: "SHA256:abc" });
    expect(w.calls.slice(0, 3)).toEqual(["place", "workspaces:true", "show"]);
  });
});
