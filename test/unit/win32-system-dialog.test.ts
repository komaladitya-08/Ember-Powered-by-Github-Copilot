/**
 * systemDialogOpen on Windows (win32/system/system-dialog.ts) with fake window stacks and a fake Win32 API: true for
 * the secure desktop (or an input desktop that can't be opened), a security program's window, a credential dialog's
 * window class, a security title, and a topmost window over a whole monitor whose program Ember can't name; false for
 * ordinary desktops; and true whenever something can't be checked (fail closed).
 */

import { describe, expect, it } from "vitest";
import type { Rect, StackedWindow } from "../../app/main/platform/types";
import { securityWindow, win32SystemDialog, type SecurityVocabulary } from "../../app/main/platform/win32/system/system-dialog";
import { isSecurityClass, isSecurityWindow } from "../../app/main/platform/win32/system/interim";

const VOCAB: SecurityVocabulary = { isSecurityWindow: w => isSecurityWindow(w, "win32"), isSecurityClass };
const MONITOR: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

const win = (id: number, wmClass: string, title = "", r: Rect = { x: 100, y: 100, width: 800, height: 600 }): StackedWindow => ({
  id, client: id, pid: 1000 + id, title, wmClass, ...r, outer: r, inner: r, overrideRedirect: false,
});

function api(o: { desktop?: string | null; classes?: Record<number, string>; topmost?: number[] } = {}) {
  return {
    inputDesktopName: () => (o.desktop === undefined ? "Default" : o.desktop),
    className: (h: number) => o.classes?.[h] ?? "Notepad",
    exStyle: (h: number) => (o.topmost?.includes(h) ? 0x8 : 0),
  };
}

const check = (stack: StackedWindow[], a = api(), monitorRect: ((h: number) => Rect | null) | null = () => MONITOR) =>
  win32SystemDialog({ stack: () => stack }, a, monitorRect, VOCAB);

describe("win32SystemDialog", () => {
  it("is false on the user's desktop with ordinary windows", () => {
    expect(check([win(1, "notepad", "notes.txt - Notepad"), win(2, "explorer", "")])).toBe(false);
  });

  it("is true while the secure desktop, or an input desktop that can't be opened, has the screen", () => {
    expect(check([], api({ desktop: "Winlogon" }))).toBe(true);
    expect(check([], api({ desktop: null }))).toBe(true);
    expect(check([], api({ desktop: "default" }))).toBe(false);
  });

  it("is true for a security program's window, by program name", () => {
    for (const program of ["credentialuibroker", "consent", "LogonUI", "lockapp", "CredentialUIBroker.exe"]) expect(check([win(1, program)]), program).toBe(true);
  });

  it("is true for a credential or consent dialog's window class, even when its program can't be named", () => {
    expect(check([win(5, "", "", { x: 10, y: 10, width: 400, height: 300 })], api({ classes: { 5: "Credential Dialog Xaml Host" } }))).toBe(true);
    expect(check([win(5, "explorer")], api({ classes: { 5: "$$$Secure UAP Dummy Window Class For Interim Dialog" } }))).toBe(true);
  });

  it("is true for a security title", () => {
    expect(check([win(1, "someapp", "Windows Security")])).toBe(true);
    expect(check([win(1, "mmc", "User Account Control")])).toBe(true);
    expect(check([win(1, "notepad", "Windows Security notes.txt - Notepad")])).toBe(false);
  });

  it("is true for a topmost window over a whole monitor whose program can't be named, and only then", () => {
    const full = win(9, "", "", { x: -2, y: -2, width: 1924, height: 1084 });
    expect(check([full], api({ topmost: [9] }))).toBe(true);
    expect(check([full], api())).toBe(false); // not topmost
    expect(check([win(9, "", "", { x: 0, y: 0, width: 300, height: 200 })], api({ topmost: [9] }))).toBe(false); // doesn't cover it
    expect(check([{ ...full, wmClass: "game" }], api({ topmost: [9] }))).toBe(false); // a full-screen app Ember can name
  });

  it("fails closed when the monitor of such a window can't be read", () => {
    expect(check([win(9, "", "", { x: 0, y: 0, width: 300, height: 200 })], api({ topmost: [9] }), () => null)).toBe(true);
  });

  it("fails closed without the Win32 API, or when anything throws", () => {
    expect(win32SystemDialog({ stack: () => [] }, null, () => MONITOR, VOCAB)).toBe(true);
    expect(check([], api(), null)).toBe(true);
    expect(win32SystemDialog({ stack: () => { throw new Error("gone"); } }, api(), () => MONITOR, VOCAB)).toBe(true);
    const throwing = { ...api(), className: () => { throw new Error("no"); } };
    expect(check([win(1, "notepad")], throwing)).toBe(true);
  });
});

describe("securityWindow", () => {
  it("decides one window", () => {
    expect(securityWindow(win(1, "consent"), api(), () => MONITOR, VOCAB)).toBe(true);
    expect(securityWindow(win(1, "notepad"), api(), () => MONITOR, VOCAB)).toBe(false);
  });
});
