/**
 * Byte layouts of the Win32 structures the Windows backend fills or reads, for 64-bit Windows (x64 and arm64, where
 * pointers are 8 bytes and INPUT is 40 bytes). They are encoded and decoded by hand, so every offset lives in one
 * place and is unit-tested on Linux; ffi.ts checks at load that koffi lays INPUT out the same way and refuses to send
 * input if it doesn't. Pure: no koffi, no Electron.
 */

import type { Rect } from "../types";

/** sizeof(INPUT) on 64-bit Windows: type (4), padding (4), then the union, whose largest arm (MOUSEINPUT) is 32. */
export const INPUT_SIZE = 40;
export const INPUT_MOUSE = 0;
export const INPUT_KEYBOARD = 1;

/** Byte offsets inside one INPUT (the union starts at 8: it holds a ULONG_PTR, so it is 8-byte aligned). */
export const INPUT_OFFSETS = {
  type: 0,
  union: 8,
  mouse: { dx: 8, dy: 12, mouseData: 16, dwFlags: 20, time: 24, dwExtraInfo: 32 },
  key: { wVk: 8, wScan: 10, dwFlags: 12, time: 16, dwExtraInfo: 24 },
} as const;

/**
 * dwExtraInfo of every event Ember injects ("EMBR"): a low-level hook, GetMessageExtraInfo or Raw Input can then
 * tell Ember's input from the user's (and from other programs' SendInput, such as the On-Screen Keyboard).
 */
export const EMBER_INPUT_TAG = 0x454d4252;

/** MOUSEINPUT.dwFlags. */
export const MOUSEEVENTF = {
  MOVE: 0x0001, LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010, MIDDLEDOWN: 0x0020,
  MIDDLEUP: 0x0040, XDOWN: 0x0080, XUP: 0x0100, WHEEL: 0x0800, HWHEEL: 0x1000, VIRTUALDESK: 0x4000, ABSOLUTE: 0x8000,
} as const;

/** KEYBDINPUT.dwFlags. */
export const KEYEVENTF = { EXTENDEDKEY: 0x0001, KEYUP: 0x0002, UNICODE: 0x0004 } as const;

/** One notch of a mouse wheel. */
export const WHEEL_DELTA = 120;

/** One mouse INPUT: `dx`/`dy` absolute (0..65535) or relative, `mouseData` a signed wheel delta or an X button. */
export interface MouseInput { kind: "mouse"; dx: number; dy: number; mouseData: number; flags: number }
/** One keyboard INPUT: a virtual key with its scan code, or a UTF-16 code unit in `scan` with KEYEVENTF.UNICODE. */
export interface KeyInput { kind: "key"; vk: number; scan: number; flags: number }
export type InputEvent = MouseInput | KeyInput;

/**
 * An INPUT that does nothing but makes Ember "the process that sent the last input event", which the foreground
 * lock lets take the foreground (input.md §7.6; PowerToys does the same).
 */
export const EMPTY_MOUSE_INPUT: MouseInput = { kind: "mouse", dx: 0, dy: 0, mouseData: 0, flags: 0 };

/** The INPUT array SendInput takes, every event tagged with EMBER_INPUT_TAG. */
export function encodeInputs(events: readonly InputEvent[]): Buffer {
  const buf = Buffer.alloc(events.length * INPUT_SIZE);
  events.forEach((e, i) => {
    const at = i * INPUT_SIZE;
    if (e.kind === "mouse") {
      const m = INPUT_OFFSETS.mouse;
      buf.writeUInt32LE(INPUT_MOUSE, at + INPUT_OFFSETS.type);
      buf.writeInt32LE(Math.trunc(e.dx), at + m.dx);
      buf.writeInt32LE(Math.trunc(e.dy), at + m.dy);
      // A DWORD that carries a signed wheel delta (-120 scrolls down): written as int32, read back as two's complement.
      buf.writeInt32LE(Math.trunc(e.mouseData), at + m.mouseData);
      buf.writeUInt32LE(e.flags >>> 0, at + m.dwFlags);
      buf.writeBigUInt64LE(BigInt(EMBER_INPUT_TAG), at + m.dwExtraInfo);
    } else {
      const k = INPUT_OFFSETS.key;
      buf.writeUInt32LE(INPUT_KEYBOARD, at + INPUT_OFFSETS.type);
      buf.writeUInt16LE(e.vk & 0xffff, at + k.wVk);
      buf.writeUInt16LE(e.scan & 0xffff, at + k.wScan);
      buf.writeUInt32LE(e.flags >>> 0, at + k.dwFlags);
      buf.writeBigUInt64LE(BigInt(EMBER_INPUT_TAG), at + k.dwExtraInfo);
    }
  });
  return buf;
}

/**
 * Normalised absolute coordinate (0..65535) for a pixel of the virtual desktop. Windows maps a value n back to the
 * pixel floor(n × size / 65536), so floor(rel × 65536 / size) + 1 lands inside pixel `rel` exactly (the "+1" makes
 * up for that truncation; without it a move can end one pixel short). Off-screen values clamp to the edge.
 */
export function absoluteCoordinate(value: number, origin: number, size: number): number {
  if (!(size > 0)) return 0;
  const rel = Math.round(value) - origin;
  return Math.min(65535, Math.max(0, Math.floor((rel * 65536) / size) + 1));
}

/** A pointer move to (x, y) in virtual-desktop pixels (which may be negative), as an absolute virtual-desk event. */
export function moveInput(x: number, y: number, screen: Rect): MouseInput {
  return {
    kind: "mouse",
    dx: absoluteCoordinate(x, screen.x, screen.width),
    dy: absoluteCoordinate(y, screen.y, screen.height),
    mouseData: 0,
    flags: MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK,
  };
}

/**
 * The event for X button `button` (1 left, 2 middle, 3 right, 4/5 wheel up/down, 6/7 wheel left/right, 8/9 back
 * and forward) going down or up. Buttons 1 and 3 are logical: SendInput's buttons are physical, so with the buttons
 * swapped (SM_SWAPBUTTON) the primary click is the physical right button. A wheel notch is all in the "down" event:
 * its "up" is null, as is any other button.
 */
export function buttonInput(button: number, down: boolean, swapped: boolean): MouseInput | null {
  const ev = (flags: number, mouseData = 0): MouseInput => ({ kind: "mouse", dx: 0, dy: 0, mouseData, flags });
  const physicalLeft = down ? MOUSEEVENTF.LEFTDOWN : MOUSEEVENTF.LEFTUP;
  const physicalRight = down ? MOUSEEVENTF.RIGHTDOWN : MOUSEEVENTF.RIGHTUP;
  switch (button) {
    case 1: return ev(swapped ? physicalRight : physicalLeft);
    case 2: return ev(down ? MOUSEEVENTF.MIDDLEDOWN : MOUSEEVENTF.MIDDLEUP);
    case 3: return ev(swapped ? physicalLeft : physicalRight);
    case 4: return down ? ev(MOUSEEVENTF.WHEEL, WHEEL_DELTA) : null;
    case 5: return down ? ev(MOUSEEVENTF.WHEEL, -WHEEL_DELTA) : null;
    case 6: return down ? ev(MOUSEEVENTF.HWHEEL, -WHEEL_DELTA) : null;
    case 7: return down ? ev(MOUSEEVENTF.HWHEEL, WHEEL_DELTA) : null;
    case 8: return ev(down ? MOUSEEVENTF.XDOWN : MOUSEEVENTF.XUP, 1); // XBUTTON1
    case 9: return ev(down ? MOUSEEVENTF.XDOWN : MOUSEEVENTF.XUP, 2); // XBUTTON2
    default: return null;
  }
}

/** A virtual key going down or up (EXTENDEDKEY for the keys that have it, or apps that read scan codes see the numpad). */
export function keyInput(vk: number, scan: number, extended: boolean, down: boolean): KeyInput {
  return { kind: "key", vk, scan, flags: (extended ? KEYEVENTF.EXTENDEDKEY : 0) | (down ? 0 : KEYEVENTF.KEYUP) };
}

/** UTF-16 code units typed whatever the layout (KEYEVENTF_UNICODE; apps get VK_PACKET, then WM_CHAR). */
export function unicodeInputs(units: readonly number[], down: boolean): KeyInput[] {
  return units.map(scan => ({ kind: "key", vk: 0, scan, flags: KEYEVENTF.UNICODE | (down ? 0 : KEYEVENTF.KEYUP) }));
}

/**
 * A window handle as Ember's window id. Only the low 32 bits of an HWND are significant (handles are shared with
 * 32-bit processes, and Windows sign-extends them when it widens one), so ids compare equal however a handle came
 * back. 0 for none.
 */
export function hwndOf(value: unknown): number {
  if (typeof value === "bigint") return Number(BigInt.asUintN(32, value));
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value) >>> 0;
  return 0;
}

/** The HWND in a BrowserWindow's getNativeWindowHandle() buffer (8 bytes in a 64-bit process). */
export function hwndFromNativeHandle(buf: Buffer): number {
  if (buf.length >= 8) return hwndOf(buf.readBigUInt64LE(0));
  if (buf.length >= 4) return buf.readUInt32LE(0);
  return 0;
}

/** RECT {left, top, right, bottom} (four int32) as a Rect. */
export function readRect(buf: Buffer, at = 0): Rect {
  const left = buf.readInt32LE(at), top = buf.readInt32LE(at + 4);
  return { x: left, y: top, width: buf.readInt32LE(at + 8) - left, height: buf.readInt32LE(at + 12) - top };
}

/** POINT {x, y} (two int32). */
export function readPoint(buf: Buffer, at = 0): { x: number; y: number } {
  return { x: buf.readInt32LE(at), y: buf.readInt32LE(at + 4) };
}

/** sizeof(GUITHREADINFO) on 64-bit Windows: cbSize, flags, six HWNDs from offset 8, then RECT rcCaret. */
export const GUI_THREAD_INFO_SIZE = 72;

/** A GUITHREADINFO buffer with cbSize set, for GetGUIThreadInfo. */
export function guiThreadInfoBuffer(): Buffer {
  const buf = Buffer.alloc(GUI_THREAD_INFO_SIZE);
  buf.writeUInt32LE(GUI_THREAD_INFO_SIZE, 0);
  return buf;
}

/** hwndActive (offset 8) and hwndFocus (offset 16) of a filled GUITHREADINFO. */
export function readGuiThreadInfo(buf: Buffer): { active: number; focus: number } {
  return { active: hwndOf(buf.readBigUInt64LE(8)), focus: hwndOf(buf.readBigUInt64LE(16)) };
}

/**
 * BITMAPINFO for a top-down 32-bit BI_RGB DIB section: BITMAPINFOHEADER (40 bytes; a negative biHeight makes row 0
 * the top row) plus one unused RGBQUAD. Its rows are width × 4 bytes, with no padding.
 */
export function bitmapInfo(width: number, height: number): Buffer {
  const buf = Buffer.alloc(44);
  buf.writeUInt32LE(40, 0); // biSize
  buf.writeInt32LE(width, 4); // biWidth
  buf.writeInt32LE(-height, 8); // biHeight: top-down
  buf.writeUInt16LE(1, 12); // biPlanes
  buf.writeUInt16LE(32, 14); // biBitCount
  buf.writeUInt32LE(0, 16); // biCompression: BI_RGB
  return buf;
}

/** A UTF-16LE string of at most `units` code units, cut at the first NUL. */
export function readUtf16(buf: Buffer, units: number): string {
  const s = buf.toString("utf16le", 0, Math.max(0, Math.min(units * 2, buf.length - (buf.length % 2))));
  const nul = s.indexOf("\0");
  return nul >= 0 ? s.slice(0, nul) : s;
}

/**
 * The relative id (last sub-authority) of a SID: for a mandatory-label SID (S-1-16-…) that is the integrity level
 * (0x1000 low, 0x2000 medium, 0x3000 high, 0x4000 system). null when the bytes aren't a whole SID.
 */
export function sidRid(sid: Uint8Array): number | null {
  if (sid.length < 8 || sid[0] !== 1) return null;
  const count = sid[1];
  if (count < 1 || sid.length < 8 + 4 * count) return null;
  const at = 8 + 4 * (count - 1);
  return (sid[at] | (sid[at + 1] << 8) | (sid[at + 2] << 16) | (sid[at + 3] << 24)) >>> 0;
}
