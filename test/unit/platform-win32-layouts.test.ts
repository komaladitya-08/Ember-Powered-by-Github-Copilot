/**
 * The byte layouts the Windows backend hands to Win32 (pure, so they run on Linux): INPUT events for SendInput and
 * their offsets, absolute pointer coordinates over a virtual desktop with negative origins, logical mouse buttons
 * with swapped buttons, HWND values, and the structures read back (RECT, GUITHREADINFO, DIB header, SIDs). koffi
 * itself must agree on INPUT's layout, or SendInput is refused.
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { inputLayoutMatches } from "../../app/main/platform/win32/ffi";
import {
  absoluteCoordinate, bitmapInfo, buttonInput, EMBER_INPUT_TAG, EMPTY_MOUSE_INPUT, encodeInputs, guiThreadInfoBuffer,
  GUI_THREAD_INFO_SIZE, hwndFromNativeHandle, hwndOf, INPUT_SIZE, keyInput, KEYEVENTF, MOUSEEVENTF, moveInput,
  readGuiThreadInfo, readPoint, readRect, readUtf16, sidRid, unicodeInputs,
} from "../../app/main/platform/win32/layouts";

const requireCjs = createRequire(import.meta.url);

/** Where Windows puts the pointer for a normalised absolute coordinate (it truncates n × size / 65536). */
const pixelOf = (n: number, origin: number, size: number) => origin + Math.floor((n * size) / 65536);

describe("INPUT encoding for SendInput", () => {
  it("lays a mouse event out at the 64-bit offsets, tagged as Ember's", () => {
    const buf = encodeInputs([{ kind: "mouse", dx: 1234, dy: 65535, mouseData: -120, flags: MOUSEEVENTF.WHEEL }]);
    expect(buf.length).toBe(INPUT_SIZE);
    expect(buf.readUInt32LE(0)).toBe(0); // INPUT_MOUSE
    expect(buf.readUInt32LE(4)).toBe(0); // padding before the 8-byte-aligned union
    expect(buf.readInt32LE(8)).toBe(1234);
    expect(buf.readInt32LE(12)).toBe(65535);
    expect(buf.readInt32LE(16)).toBe(-120); // a negative wheel delta in a DWORD
    expect(buf.readUInt32LE(16)).toBe(0xffffff88);
    expect(buf.readUInt32LE(20)).toBe(MOUSEEVENTF.WHEEL);
    expect(buf.readUInt32LE(24)).toBe(0); // time: the system stamps it
    expect(buf.readBigUInt64LE(32)).toBe(BigInt(EMBER_INPUT_TAG));
  });

  it("lays a key event out at the 64-bit offsets, one INPUT after another", () => {
    const buf = encodeInputs([keyInput(0x41, 0x1e, false, true), keyInput(0x2e, 0x53, true, false)]);
    expect(buf.length).toBe(2 * INPUT_SIZE);
    expect(buf.readUInt32LE(0)).toBe(1); // INPUT_KEYBOARD
    expect(buf.readUInt16LE(8)).toBe(0x41);
    expect(buf.readUInt16LE(10)).toBe(0x1e);
    expect(buf.readUInt32LE(12)).toBe(0);
    expect(buf.readBigUInt64LE(24)).toBe(BigInt(EMBER_INPUT_TAG));
    expect(buf.readUInt32LE(INPUT_SIZE)).toBe(1);
    expect(buf.readUInt16LE(INPUT_SIZE + 8)).toBe(0x2e);
    expect(buf.readUInt32LE(INPUT_SIZE + 12)).toBe(KEYEVENTF.EXTENDEDKEY | KEYEVENTF.KEYUP);
  });

  it("types a character as KEYEVENTF_UNICODE events with no virtual key, each surrogate on its own", () => {
    expect(unicodeInputs([0xd83d, 0xde00], true)).toEqual([
      { kind: "key", vk: 0, scan: 0xd83d, flags: KEYEVENTF.UNICODE },
      { kind: "key", vk: 0, scan: 0xde00, flags: KEYEVENTF.UNICODE },
    ]);
    expect(unicodeInputs([0xe9], false)).toEqual([{ kind: "key", vk: 0, scan: 0xe9, flags: KEYEVENTF.UNICODE | KEYEVENTF.KEYUP }]);
  });

  it("makes the foreground trick's event an empty mouse event", () => {
    const buf = encodeInputs([EMPTY_MOUSE_INPUT]);
    expect(buf.readUInt32LE(0)).toBe(0);
    expect(buf.readUInt32LE(20)).toBe(0); // no flags: nothing moves or clicks
  });

  it("agrees with koffi's own layout of INPUT, so SendInput gets what layouts.ts wrote", () => {
    const koffi = requireCjs("koffi") as typeof import("koffi");
    expect(inputLayoutMatches(koffi)).toBe(true);
  });
});

describe("absolute pointer coordinates over the virtual desktop", () => {
  it("lands on every pixel exactly, for common desktop widths", () => {
    for (const size of [800, 1024, 1366, 1920, 2560, 3440, 3840, 5760, 7680]) {
      for (let px = 0; px < size; px++) {
        expect(pixelOf(absoluteCoordinate(px, 0, size), 0, size)).toBe(px);
      }
    }
  });

  it("handles a monitor left of and above the primary one (negative origin)", () => {
    // Two 1920×1080 monitors: the second is left of the primary and 200 px higher.
    const screen = { x: -1920, y: -200, width: 3840, height: 1280 };
    for (const [x, y] of [[-1920, -200], [-1, 0], [0, 0], [1919, 1079], [-960, 540], [-1500, -150]]) {
      const ev = moveInput(x, y, screen);
      expect(pixelOf(ev.dx, screen.x, screen.width)).toBe(x);
      expect(pixelOf(ev.dy, screen.y, screen.height)).toBe(y);
      expect(ev.flags).toBe(MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK);
    }
  });

  it("rounds fractional positions and clamps off-screen ones to the edge", () => {
    expect(pixelOf(absoluteCoordinate(99.6, 0, 1920), 0, 1920)).toBe(100);
    expect(absoluteCoordinate(-50, 0, 1920)).toBe(0);
    expect(absoluteCoordinate(5000, 0, 1920)).toBe(65535);
    expect(absoluteCoordinate(10, 0, 0)).toBe(0);
  });
});

describe("mouse buttons as SendInput events", () => {
  it("presses the logical primary and secondary buttons, swapped or not", () => {
    expect(buttonInput(1, true, false)?.flags).toBe(MOUSEEVENTF.LEFTDOWN);
    expect(buttonInput(1, false, false)?.flags).toBe(MOUSEEVENTF.LEFTUP);
    expect(buttonInput(3, true, false)?.flags).toBe(MOUSEEVENTF.RIGHTDOWN);
    // Swapped buttons: SendInput's buttons are physical, so the primary click is the physical right button.
    expect(buttonInput(1, true, true)?.flags).toBe(MOUSEEVENTF.RIGHTDOWN);
    expect(buttonInput(1, false, true)?.flags).toBe(MOUSEEVENTF.RIGHTUP);
    expect(buttonInput(3, true, true)?.flags).toBe(MOUSEEVENTF.LEFTDOWN);
    expect(buttonInput(2, true, true)?.flags).toBe(MOUSEEVENTF.MIDDLEDOWN);
  });

  it("turns the wheel one notch on the press, in X's directions, and nothing on the release", () => {
    expect(buttonInput(4, true, false)).toMatchObject({ flags: MOUSEEVENTF.WHEEL, mouseData: 120 });
    expect(buttonInput(5, true, false)).toMatchObject({ flags: MOUSEEVENTF.WHEEL, mouseData: -120 });
    expect(buttonInput(6, true, false)).toMatchObject({ flags: MOUSEEVENTF.HWHEEL, mouseData: -120 });
    expect(buttonInput(7, true, false)).toMatchObject({ flags: MOUSEEVENTF.HWHEEL, mouseData: 120 });
    for (const b of [4, 5, 6, 7]) expect(buttonInput(b, false, false)).toBeNull();
  });

  it("presses back and forward as X buttons 8 and 9, and nothing for unknown buttons", () => {
    expect(buttonInput(8, true, false)).toMatchObject({ flags: MOUSEEVENTF.XDOWN, mouseData: 1 });
    expect(buttonInput(9, false, false)).toMatchObject({ flags: MOUSEEVENTF.XUP, mouseData: 2 });
    expect(buttonInput(0, true, false)).toBeNull();
    expect(buttonInput(10, true, false)).toBeNull();
  });
});

describe("window handles as window ids", () => {
  it("keeps the low 32 bits, so a sign-extended handle equals the plain one", () => {
    expect(hwndOf(0x000a0b2cn)).toBe(0x000a0b2c);
    expect(hwndOf(0xffffffff80001234n)).toBe(0x80001234);
    expect(hwndOf(0x0000000080001234n)).toBe(0x80001234);
    expect(hwndOf(0x80001234)).toBe(0x80001234);
    expect(hwndOf(null)).toBe(0);
    expect(hwndOf(undefined)).toBe(0);
  });

  it("reads a BrowserWindow's native handle (8 bytes in a 64-bit process)", () => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(0x1234abcdn);
    expect(hwndFromNativeHandle(b)).toBe(0x1234abcd);
    const four = Buffer.alloc(4);
    four.writeUInt32LE(0x5678);
    expect(hwndFromNativeHandle(four)).toBe(0x5678);
    expect(hwndFromNativeHandle(Buffer.alloc(0))).toBe(0);
  });
});

describe("structures read back from Win32", () => {
  it("reads RECT (left, top, right, bottom) as a rectangle, negative coordinates too", () => {
    const b = Buffer.alloc(16);
    [-1927, -8, -1, 1047].forEach((v, i) => b.writeInt32LE(v, i * 4));
    expect(readRect(b)).toEqual({ x: -1927, y: -8, width: 1926, height: 1055 });
    const p = Buffer.alloc(8);
    p.writeInt32LE(-5, 0);
    p.writeInt32LE(7, 4);
    expect(readPoint(p)).toEqual({ x: -5, y: 7 });
  });

  it("sets GUITHREADINFO's size and reads its active and focused windows at offsets 8 and 16", () => {
    const b = guiThreadInfoBuffer();
    expect(b.length).toBe(GUI_THREAD_INFO_SIZE);
    expect(b.readUInt32LE(0)).toBe(72);
    b.writeBigUInt64LE(0x10010n, 8);
    b.writeBigUInt64LE(0x20020n, 16);
    expect(readGuiThreadInfo(b)).toEqual({ active: 0x10010, focus: 0x20020 });
  });

  it("describes a top-down 32-bit BI_RGB DIB", () => {
    const b = bitmapInfo(640, 480);
    expect(b.readUInt32LE(0)).toBe(40);
    expect(b.readInt32LE(4)).toBe(640);
    expect(b.readInt32LE(8)).toBe(-480);
    expect(b.readUInt16LE(12)).toBe(1);
    expect(b.readUInt16LE(14)).toBe(32);
    expect(b.readUInt32LE(16)).toBe(0);
  });

  it("reads UTF-16 text up to its length or the first NUL", () => {
    const b = Buffer.alloc(32);
    b.write("Notepad\0junk", "utf16le");
    expect(readUtf16(b, 16)).toBe("Notepad");
    expect(readUtf16(b, 4)).toBe("Note");
    expect(readUtf16(Buffer.from("Café", "utf16le"), 4)).toBe("Café");
  });

  it("reads an integrity level from a mandatory-label SID, and refuses broken SIDs", () => {
    // S-1-16-12288 (high) and S-1-16-8192 (medium).
    expect(sidRid(Uint8Array.from([1, 1, 0, 0, 0, 0, 0, 16, 0x00, 0x30, 0, 0]))).toBe(0x3000);
    expect(sidRid(Uint8Array.from([1, 1, 0, 0, 0, 0, 0, 16, 0x00, 0x20, 0, 0]))).toBe(0x2000);
    expect(sidRid(Uint8Array.from([1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x20, 0x02, 0, 0]))).toBe(0x220);
    expect(sidRid(Uint8Array.from([1, 1, 0, 0, 0, 0, 0, 16]))).toBeNull();
    expect(sidRid(Uint8Array.from([2, 1, 0, 0, 0, 0, 0, 16, 0, 0x20, 0, 0]))).toBeNull();
    expect(sidRid(Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 16]))).toBeNull();
  });
});
