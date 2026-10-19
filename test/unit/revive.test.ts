import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { revive } from "../../app/main/revive";

/** A window whose webContents behaves like an EventEmitter, so tests can make it crash or finish loading. */
function fake() {
  const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  const webContents = {
    on(event: string, fn: (...a: unknown[]) => void) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); return webContents; },
    emit(event: string, ...args: unknown[]) { for (const fn of handlers.get(event) ?? []) fn(...args); },
    reload: vi.fn(),
  };
  return { webContents, isDestroyed: vi.fn(() => false) };
}

type Fake = ReturnType<typeof fake>;
const reviveWin = (win: Fake, onGone?: (reason: string) => void) => revive(win as unknown as BrowserWindow, onGone);
const crash = (win: Fake, reason = "crashed") => win.webContents.emit("render-process-gone", {}, { reason });
const load = (win: Fake) => win.webContents.emit("did-finish-load");

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe("revive", () => {
  it("reloads half a second after a crash, not before", () => {
    const win = fake();
    reviveWin(win);
    crash(win);
    vi.advanceTimersByTime(499);
    expect(win.webContents.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it("backs off 500, 1000, 2000 … capped at 60000 after quick crashes", () => {
    const win = fake();
    reviveWin(win);
    let reloads = 0;
    for (const wait of [500, 1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]) {
      crash(win);
      vi.advanceTimersByTime(wait - 1);
      expect(win.webContents.reload).toHaveBeenCalledTimes(reloads);
      vi.advanceTimersByTime(1);
      expect(win.webContents.reload).toHaveBeenCalledTimes(++reloads);
    }
  });

  it("starts the count again when a load finished and it ran a minute without crashing", () => {
    const win = fake();
    reviveWin(win);
    crash(win);
    vi.advanceTimersByTime(500);
    load(win);
    vi.advanceTimersByTime(61_000);
    crash(win);
    vi.advanceTimersByTime(499);
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(win.webContents.reload).toHaveBeenCalledTimes(2);
  });

  it("keeps backing off when a crash happens while still loading", () => {
    const win = fake();
    reviveWin(win);
    crash(win);
    vi.advanceTimersByTime(500);
    crash(win);
    vi.advanceTimersByTime(999);
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(win.webContents.reload).toHaveBeenCalledTimes(2);
    crash(win);
    vi.advanceTimersByTime(1999);
    expect(win.webContents.reload).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(win.webContents.reload).toHaveBeenCalledTimes(3);
  });

  it("tells onGone why the page went away", () => {
    const win = fake();
    const reasons: string[] = [];
    reviveWin(win, reason => reasons.push(reason));
    crash(win, "oom");
    crash(win, "crashed");
    expect(reasons).toEqual(["oom", "crashed"]);
  });

  it("doesn't reload a window that was destroyed before the timer fires", () => {
    const win = fake();
    reviveWin(win);
    crash(win);
    win.isDestroyed.mockReturnValue(true);
    vi.advanceTimersByTime(500);
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });
});
