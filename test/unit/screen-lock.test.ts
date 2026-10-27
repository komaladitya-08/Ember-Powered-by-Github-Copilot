/**
 * Whether this computer's screen is locked (review #81): Electron's lock events where it has them (Windows, macOS),
 * logind's LockedHint and Active polled on Linux (GNOME's lock shield sets LockedHint; the X screensaver doesn't see it).
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenLock, loginctlLocked, parseLoginctl } from "../../app/main/screen-lock";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("logind's session state", () => {
  it.each([
    ["LockedHint=yes\nActive=yes\n", true],
    ["Active=no\nLockedHint=no\n", true], // another user's session, or the login screen, is in front
    ["LockedHint=no\nActive=yes\n", false],
    ["Active=yes\n", null], // no LockedHint: can't tell
    ["", null],
  ] as const)("%j is locked: %s", (text, locked) => expect(parseLoginctl(text)).toBe(locked));

  it("asks about the session Ember runs in, or else the user's graphical one", async () => {
    const asked: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      asked.push([cmd, ...args]);
      return args[0] === "show-user" ? "Display=c2\n" : "LockedHint=yes\nActive=yes\n";
    };
    expect(await loginctlLocked(run, { sessionId: "3", uid: 1000 })).toBe(true);
    expect(await loginctlLocked(run, { sessionId: undefined, uid: 1000 })).toBe(true);
    expect(asked).toEqual([
      ["loginctl", "show-session", "3", "-p", "LockedHint", "-p", "Active"],
      ["loginctl", "show-user", "1000", "-p", "Display"],
      ["loginctl", "show-session", "c2", "-p", "LockedHint", "-p", "Active"],
    ]);
    expect(await loginctlLocked(async () => null, { sessionId: "3", uid: 1000 })).toBeNull();
  });
});

describe("ScreenLock", () => {
  it("follows Electron's lock and unlock events, and says each change once", () => {
    const events = new EventEmitter();
    const changes: boolean[] = [];
    const lock = new ScreenLock({ events, initial: () => false, onChange: on => changes.push(on) });
    lock.start();
    expect(lock.locked).toBe(false);
    events.emit("lock-screen");
    events.emit("lock-screen");
    expect(lock.locked).toBe(true);
    events.emit("unlock-screen");
    expect(changes).toEqual([true, false]);
  });

  it("starts locked when the screen already is", () => {
    const lock = new ScreenLock({ events: new EventEmitter(), initial: () => true, onChange: () => undefined });
    lock.start();
    expect(lock.locked).toBe(true);
  });

  it("polls where there are no events (Linux), and keeps what it knew when it can't tell", async () => {
    const answers: (boolean | null)[] = [false, true, null, true, false];
    const changes: boolean[] = [];
    const lock = new ScreenLock({ poll: async () => (answers.length ? answers.shift()! : false), pollMs: 2000, onChange: on => changes.push(on) });
    /** The clock moves on, and each poll's answer comes in. */
    const after = async (ms: number) => { for (let t = 0; t < ms; t += 1000) { await vi.advanceTimersByTimeAsync(1000); for (let i = 0; i < 5; i++) await Promise.resolve(); } };
    lock.start();
    await after(1000);
    expect(lock.locked).toBe(false);
    await after(2000);
    expect(lock.locked).toBe(true);
    await after(2000); // can't tell: still locked
    expect(lock.locked).toBe(true);
    await after(4000);
    expect(changes).toEqual([true, false]);
    lock.stop();
    answers.push(true);
    await after(10_000);
    expect(changes).toEqual([true, false]);
  });
});
