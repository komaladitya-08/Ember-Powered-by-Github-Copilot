/**
 * Is a Windows authentication surface up, or may one be (WindowSystem.systemDialogOpen on Windows, §7.2)? Perception
 * then takes no screenshot and the worker borrows nothing. True when:
 * (a) the input desktop isn't the user's own ("Default"): UAC on the secure desktop, Ctrl+Alt+Del, the lock screen;
 * (b) a window on screen belongs to a security program (credentialuibroker, consent, logonui…), has a credential or
 *     consent dialog's window class, or a security title ("Windows Security", "User Account Control"…);
 * (c) a topmost window covering a whole monitor belongs to a program Ember can't name (wmClass ""), as consent.exe and
 *     LogonUI.exe are to a standard user when UAC doesn't use the secure desktop;
 * (d) anything can't be checked: no Win32 API, or a call throws (fail closed).
 * It reuses port/win32's bindings (the input desktop, class names, extended styles); only the monitor rectangle comes
 * from this package's own. The vocabulary is policy/vocabulary.ts's, the one list perception and policy also read.
 */

import type { Rect, StackedWindow, WindowSystem } from "../../types";
import type { Win32Api } from "../ffi";
import { onUsersDesktop } from "../security";

/** WS_EX_TOPMOST. */
const WS_EX_TOPMOST = 0x8;

/** The Windows security vocabulary (§9.11: SECURITY_APP, SECURITY_TITLE and SECURITY_CLASS for win32). */
export interface SecurityVocabulary {
  /** By program (`app`, the window's wmClass) or title. */
  isSecurityWindow(w: { app?: string; title?: string }): boolean;
  /** By Win32 window class. */
  isSecurityClass(className: string): boolean;
}

/** Does `w` cover all of `m`? */
const covers = (w: Rect, m: Rect) => w.x <= m.x && w.y <= m.y && w.x + w.width >= m.x + m.width && w.y + w.height >= m.y + m.height;

/** One window's verdict (exported for tests): is it, or may it be, an authentication surface? */
export function securityWindow(
  w: StackedWindow, api: Pick<Win32Api, "className" | "exStyle">, monitorRect: (hwnd: number) => Rect | null, vocab: SecurityVocabulary,
): boolean {
  if (vocab.isSecurityWindow({ app: w.wmClass, title: w.title })) return true;
  const cls = api.className(w.id);
  if (cls && vocab.isSecurityClass(cls)) return true;
  if (w.wmClass === "" && (api.exStyle(w.id) & WS_EX_TOPMOST) !== 0) {
    const m = monitorRect(w.id);
    // A monitor that can't be read could be covered: fail closed.
    return !m || covers(w, m);
  }
  return false;
}

/** systemDialogOpen for the Windows window system (see the module comment). */
export function win32SystemDialog(
  ws: Pick<WindowSystem, "stack">,
  api: Pick<Win32Api, "inputDesktopName" | "className" | "exStyle"> | null,
  monitorRect: ((hwnd: number) => Rect | null) | null,
  vocab: SecurityVocabulary,
): boolean {
  try {
    if (!api || !monitorRect) return true;
    if (!onUsersDesktop(api.inputDesktopName())) return true;
    return ws.stack().some(w => securityWindow(w, api, monitorRect, vocab));
  } catch {
    return true;
  }
}
