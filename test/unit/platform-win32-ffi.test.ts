/**
 * The Win32 bindings (ffi.ts) on Linux: every C declaration parses with koffi's own parser, and the wrappers do the
 * right thing with what the system hands back, checked against fake DLLs and real koffi memory: handles normalised,
 * styles unsigned, UTF-16 titles (Ember's own read without a message), out-parameters, DWM attributes, process
 * images and tokens (the integrity SID read through its pointer), handles always closed, raising a window without
 * waiting for its thread (and no binding that would wait), the GDI capture sequence cleaned up even when BitBlt
 * fails, and the DPI awareness fixed for plain Node. Missing optional pieces degrade; missing required ones refuse
 * to bind. Off Windows, loadWin32() is null.
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { LibraryHandle } from "koffi";
import { bindWin32, defineWin32Types, functionName, loadWin32, RAISE_ASYNC_FLAGS, WIN32_FUNCTIONS } from "../../app/main/platform/win32/ffi";
import { INPUT_SIZE } from "../../app/main/platform/win32/layouts";

const requireCjs = createRequire(import.meta.url);
const koffi = requireCjs("koffi") as typeof import("koffi");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake DLL functions take what koffi would pass
type Impl = (...args: any[]) => unknown;
const ALL_NAMES = Object.values(WIN32_FUNCTIONS).flat().map(functionName);

/** Fake DLLs: every function returns 0 (FALSE / NULL) unless `impls` says otherwise; `missing` ones aren't there. */
function fakeLoad(impls: Record<string, Impl> = {}, missing: { libraries?: string[]; functions?: string[] } = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const load = (library: string): Pick<LibraryHandle, "func"> => {
    if (missing.libraries?.includes(library)) throw new Error(`${library} not found`);
    return {
      func: ((declaration: string) => {
        const name = functionName(declaration);
        if (missing.functions?.includes(name)) throw new Error(`${name} not found`);
        return (...args: unknown[]) => {
          calls.push({ name, args });
          return impls[name] ? impls[name](...args) : 0;
        };
      }) as LibraryHandle["func"],
    };
  };
  return { load, calls, called: (name: string) => calls.filter(c => c.name === name) };
}

describe("the Win32 declarations", () => {
  it("all parse with koffi's prototype parser, each function named once", () => {
    defineWin32Types(koffi);
    defineWin32Types(koffi); // a second call must not redefine the type
    for (const declaration of Object.values(WIN32_FUNCTIONS).flat()) expect(() => koffi.proto(declaration), declaration).not.toThrow();
    expect(new Set(ALL_NAMES).size).toBe(ALL_NAMES.length);
    expect(ALL_NAMES).not.toContain("");
  });

  it("bind no call that waits for another app's thread to handle a window message", () => {
    // Ember calls these on its main thread: a busy app would freeze the overlay and the stop shortcut (W16).
    const waiting = [
      "SendMessageW", "SendMessageA", "SendMessageTimeoutW", "SendNotifyMessageW", "BringWindowToTop", "ShowWindow",
      "MoveWindow", "SetWindowPlacement", "SetActiveWindow", "SwitchToThisWindow", "GetWindowTextLengthW", "PrintWindow",
    ];
    for (const name of waiting) expect(ALL_NAMES, name).not.toContain(name);
  });

  it("names the function in a prototype", () => {
    expect(functionName("int __stdcall GetCursorPos(void *point)")).toBe("GetCursorPos");
    expect(functionName("void * __stdcall GetForegroundWindow()")).toBe("GetForegroundWindow");
  });

  it.skipIf(process.platform === "win32")("aren't loaded off Windows", () => {
    expect(loadWin32()).toBeNull();
  });
});

describe("binding the Win32 API", () => {
  it("binds every function and allows SendInput when koffi's INPUT layout matches", () => {
    const f = fakeLoad();
    const api = bindWin32(koffi, f.load);
    expect(api.canSendInput).toBe(true);
  });

  it("refuses to bind without a required function or library", () => {
    expect(() => bindWin32(koffi, fakeLoad({}, { functions: ["SendInput"] }).load)).toThrow(/SendInput/);
    expect(() => bindWin32(koffi, fakeLoad({}, { libraries: ["user32.dll"] }).load)).toThrow(/user32/);
    expect(() => bindWin32(koffi, fakeLoad({}, { libraries: ["gdi32.dll"] }).load)).toThrow(/gdi32/);
  });

  it("degrades without DWM, the token calls or the optional functions, failing closed", () => {
    const f = fakeLoad({ GetWindowTextW: (_h: number, buf: Buffer) => { buf.write("Ember", "utf16le"); return 5; } }, {
      libraries: ["dwmapi.dll", "advapi32.dll"], functions: ["InternalGetWindowText", "SetThreadDpiAwarenessContext", "ToUnicodeEx"],
    });
    const api = bindWin32(koffi, f.load);
    expect(api.deadKey(0xbf, false, null)).toBe(true); // can't ask: no punctuation key is pressed for a character
    expect(api.frameBounds(0x10)).toBeNull();
    expect(api.cloaked(0x10)).toBe(false);
    expect(api.processToken(null)).toBeNull(); // every window is then "unchecked", so refused for input
    expect(api.title(0x10, true)).toBe("Ember"); // GetWindowTextW in place of InternalGetWindowText
  });

  it("makes plain Node per-monitor DPI aware, and leaves Electron's awareness alone", () => {
    const unaware = fakeLoad({ GetThreadDpiAwarenessContext: () => 0x11n, GetAwarenessFromDpiAwarenessContext: () => 0 });
    bindWin32(koffi, unaware.load);
    expect(unaware.called("SetThreadDpiAwarenessContext").map(c => c.args)).toEqual([[-4]]);
    const aware = fakeLoad({ GetThreadDpiAwarenessContext: () => 0x22n, GetAwarenessFromDpiAwarenessContext: () => 2 });
    bindWin32(koffi, aware.load);
    expect(aware.called("SetThreadDpiAwarenessContext")).toEqual([]);
  });
});

describe("the Win32 wrappers", () => {
  it("reads the cursor as a POINT, and null when GetCursorPos fails", () => {
    let ok = 1;
    const api = bindWin32(koffi, fakeLoad({ GetCursorPos: (buf: Buffer) => { buf.writeInt32LE(-640, 0); buf.writeInt32LE(12, 4); return ok; } }).load);
    expect(api.cursorPos()).toEqual({ x: -640, y: 12 });
    ok = 0;
    expect(api.cursorPos()).toBeNull();
  });

  it("reads a key as down from GetAsyncKeyState's high bit only", () => {
    const state: Record<number, number> = { 0x41: -32768, 0x42: 1, 0x43: -32767 };
    const api = bindWin32(koffi, fakeLoad({ GetAsyncKeyState: (vk: number) => state[vk] ?? 0 }).load);
    expect([0x41, 0x42, 0x43, 0x44].map(vk => api.asyncKeyDown(vk))).toEqual([true, false, true, false]);
  });

  it("normalises window handles and passes them back as numbers", () => {
    const f = fakeLoad({ GetForegroundWindow: () => 0xffffffff80001234n, GetTopWindow: () => null, GetAncestor: (h: number) => BigInt(h) + 1n });
    const api = bindWin32(koffi, f.load);
    expect(api.foregroundWindow()).toBe(0x80001234);
    expect(api.topWindow()).toBe(0);
    expect(api.root(0x40)).toBe(0x41);
    expect(f.called("GetAncestor")[0].args).toEqual([0x40, 2]); // GA_ROOT
    expect(api.root(0)).toBe(0);
    expect(f.called("GetAncestor")).toHaveLength(1); // no call for a null window
  });

  it("reads styles as unsigned numbers (WS_POPUP is the sign bit)", () => {
    const api = bindWin32(koffi, fakeLoad({ GetWindowLongW: (_h: number, index: number) => (index === -16 ? -2147483648 : 0x80) }).load);
    expect(api.style(1)).toBe(0x80000000);
    expect(api.exStyle(1)).toBe(0x80);
  });

  it("reads titles as UTF-16, Ember's own without sending its windows a message", () => {
    const write = (text: string) => (_h: number, buf: Buffer, max: number) => { expect(max).toBe(1024); buf.write(text, "utf16le"); return text.length; };
    const f = fakeLoad({ GetWindowTextW: write("Café – Notepad"), InternalGetWindowText: write("Ember"), GetClassNameW: write("Notepad") });
    const api = bindWin32(koffi, f.load);
    expect(api.title(0x40, false)).toBe("Café – Notepad");
    expect(api.title(0x21, true)).toBe("Ember");
    expect(api.className(0x40)).toBe("Notepad");
    expect(f.called("InternalGetWindowText").map(c => c.args[0])).toEqual([0x21]);
    expect(api.title(0, false)).toBe("");
  });

  it("reads a window's thread and process through the out-parameter, {0, 0} when it is gone", () => {
    const api = bindWin32(koffi, fakeLoad({ GetWindowThreadProcessId: (h: number, pid: number[]) => { if (h !== 0x40) return 0; pid[0] = 4242; return 77; } }).load);
    expect(api.threadProcess(0x40)).toEqual({ tid: 77, pid: 4242 });
    expect(api.threadProcess(0x41)).toEqual({ tid: 0, pid: 0 });
  });

  it("reads the window rectangle, and the client area in screen coordinates", () => {
    const rect = (buf: Buffer, l: number, t: number, r: number, b: number) => { [l, t, r, b].forEach((v, i) => buf.writeInt32LE(v, i * 4)); return 1; };
    const api = bindWin32(koffi, fakeLoad({
      GetWindowRect: (_h: number, buf: Buffer) => rect(buf, -1927, 93, -1113, 700),
      GetClientRect: (_h: number, buf: Buffer) => rect(buf, 0, 0, 798, 539),
      ClientToScreen: (_h: number, buf: Buffer) => { buf.writeInt32LE(-1919, 0); buf.writeInt32LE(160, 4); return 1; },
    }).load);
    expect(api.windowRect(0x40)).toEqual({ x: -1927, y: 93, width: 814, height: 607 });
    expect(api.clientRect(0x40)).toEqual({ x: -1919, y: 160, width: 798, height: 539 });
    expect(api.windowRect(0)).toBeNull();
  });

  it("reads DWM's frame bounds and cloaking, and treats a failed call as no answer", () => {
    let hr = 0;
    const f = fakeLoad({
      DwmGetWindowAttribute: (_h: number, attribute: number, buf: Buffer, size: number) => {
        if (attribute === 9) { expect(size).toBe(16); [10, 20, 110, 220].forEach((v, i) => buf.writeInt32LE(v, i * 4)); }
        if (attribute === 14) { expect(size).toBe(4); buf.writeUInt32LE(2, 0); } // DWM_CLOAKED_SHELL
        return hr;
      },
    });
    const api = bindWin32(koffi, f.load);
    expect(api.frameBounds(0x40)).toEqual({ x: 10, y: 20, width: 100, height: 200 });
    expect(api.cloaked(0x40)).toBe(true);
    hr = -2147024809; // E_INVALIDARG
    expect(api.frameBounds(0x40)).toBeNull();
    expect(api.cloaked(0x40)).toBe(false);
  });

  it("reads a layered window's constant alpha only when it has one", () => {
    let flags = 0x2;
    const api = bindWin32(koffi, fakeLoad({ GetLayeredWindowAttributes: (_h: number, _k: number[], alpha: number[], f: number[]) => { alpha[0] = 0; f[0] = flags; return 1; } }).load);
    expect(api.layeredAlpha(1)).toBe(0);
    flags = 0x1; // LWA_COLORKEY only
    expect(api.layeredAlpha(1)).toBeNull();
  });

  it("asks GetGUIThreadInfo with cbSize set and reads the active and focused windows", () => {
    const api = bindWin32(koffi, fakeLoad({
      GetGUIThreadInfo: (tid: number, buf: Buffer) => {
        expect(buf.readUInt32LE(0)).toBe(72);
        buf.writeBigUInt64LE(0x40n, 8);
        buf.writeBigUInt64LE(0x41n, 16);
        return tid === 7 ? 1 : 0;
      },
    }).load);
    expect(api.guiThreadInfo(7)).toEqual({ active: 0x40, focus: 0x41 });
    expect(api.guiThreadInfo(8)).toBeNull();
    expect(api.guiThreadInfo(0)).toBeNull();
  });

  it("passes rounded points by value to WindowFromPoint and MonitorFromPoint (MONITOR_DEFAULTTONULL)", () => {
    const f = fakeLoad({ WindowFromPoint: () => 0x40n, MonitorFromPoint: (p: { x: number }) => (p.x < 0 ? 0x99n : null) });
    const api = bindWin32(koffi, f.load);
    expect(api.windowFromPoint(10.4, 20.6)).toBe(0x40);
    expect(f.called("WindowFromPoint")[0].args).toEqual([{ x: 10, y: 21 }]);
    expect(api.onMonitor(-5, 0)).toBe(true);
    expect(api.onMonitor(5, 0)).toBe(false);
    expect(f.called("MonitorFromPoint")[0].args).toEqual([{ x: -5, y: 0 }, 0]);
  });

  it("reads a process's image path with limited access, and always closes the handle", () => {
    let query = 1;
    const f = fakeLoad({
      OpenProcess: (access: number, _inherit: number, pid: number) => { expect(access).toBe(0x1000); return pid === 9 ? 0x500n : null; },
      QueryFullProcessImageNameW: (_p: bigint, flags: number, buf: Buffer, size: number[]) => {
        expect(flags).toBe(0);
        const path = "C:\\Windows\\System32\\notepad.exe";
        buf.write(path, "utf16le");
        size[0] = path.length;
        return query;
      },
    });
    const api = bindWin32(koffi, f.load);
    expect(api.processImage(9)).toBe("C:\\Windows\\System32\\notepad.exe");
    query = 0;
    expect(api.processImage(9)).toBeNull();
    expect(f.called("CloseHandle").map(c => c.args[0])).toEqual([0x500n, 0x500n]);
    expect(api.processImage(10)).toBeNull(); // OpenProcess refused: nothing to close
    expect(api.processImage(0)).toBeNull();
    expect(f.called("CloseHandle")).toHaveLength(2);
  });

  it("reads elevation and the integrity level through the label's SID pointer, closing what it opened", () => {
    let label = true;
    const f = fakeLoad({
      GetCurrentProcess: () => 0xffffffffffffffffn,
      OpenProcess: () => 0x600n,
      OpenProcessToken: (_p: bigint, access: number, token: unknown[]) => { expect(access).toBe(8); token[0] = 0x700n; return 1; },
      GetTokenInformation: (_t: bigint, kind: number, buf: Buffer, size: number) => {
        if (kind === 20) { buf.writeUInt32LE(1, 0); return 1; }
        if (kind !== 25 || !label) return 0;
        // TOKEN_MANDATORY_LABEL: Label.Sid points at S-1-16-12288 further into the same buffer.
        expect(size).toBeGreaterThanOrEqual(28);
        buf.writeBigUInt64LE(koffi.address(buf) + 16n, 0);
        Buffer.from([1, 1, 0, 0, 0, 0, 0, 16, 0x00, 0x30, 0, 0]).copy(buf, 16);
        return 1;
      },
    });
    const api = bindWin32(koffi, f.load);
    expect(api.processToken(1234)).toEqual({ elevated: true, integrity: 0x3000 });
    expect(f.called("CloseHandle").map(c => c.args[0])).toEqual([0x700n, 0x600n]);
    expect(api.processToken(null)).toEqual({ elevated: true, integrity: 0x3000 });
    expect(f.called("CloseHandle").map(c => c.args[0])).toEqual([0x700n, 0x600n, 0x700n]); // never the pseudo-handle
    label = false;
    expect(api.processToken(1234)).toEqual({ elevated: true, integrity: null });
  });

  it("gives no token facts when the token can't be opened or read", () => {
    const closed = fakeLoad({ OpenProcess: () => 0x600n, OpenProcessToken: () => 0 });
    expect(bindWin32(koffi, closed.load).processToken(5)).toBeNull();
    expect(closed.called("CloseHandle").map(c => c.args[0])).toEqual([0x600n]);
    const unread = fakeLoad({ OpenProcess: () => 0x600n, OpenProcessToken: (_p: bigint, _a: number, t: unknown[]) => { t[0] = 0x700n; return 1; } });
    expect(bindWin32(koffi, unread.load).processToken(5)).toBeNull();
    expect(bindWin32(koffi, fakeLoad().load).processToken(5)).toBeNull(); // OpenProcess refused
  });

  it("asks ToUnicodeEx whether a key is dead with Shift as asked, never changing the keyboard state", () => {
    const f = fakeLoad({
      MapVirtualKeyExW: (vk: number, type: number) => (type === 0 ? vk + 0x100 : 0),
      ToUnicodeEx: (vk: number, scan: number, state: Buffer, _buf: Buffer, size: number, flags: number, layout: bigint) => {
        expect([scan, size, flags, layout]).toEqual([vk + 0x100, 8, 4, 0x4070407n]);
        expect(state.length).toBe(256);
        const shift = state[0x10] === 0x80 && state[0xa0] === 0x80;
        return vk === 0xdc && !shift ? -1 : 1;
      },
    });
    const api = bindWin32(koffi, f.load);
    expect(api.deadKey(0xdc, false, 0x4070407n)).toBe(true);
    expect(api.deadKey(0xdc, true, 0x4070407n)).toBe(false);
    expect(api.deadKey(0xbb, false, 0x4070407n)).toBe(false);
  });

  it("raises a window with SetWindowPos(HWND_TOP, SWP_NOMOVE | SWP_NOSIZE | SWP_ASYNCWINDOWPOS), never waiting for it", () => {
    let ok = 1;
    const f = fakeLoad({ SetWindowPos: () => ok });
    const api = bindWin32(koffi, f.load);
    expect(RAISE_ASYNC_FLAGS).toBe(0x4003);
    expect(api.bringToTopAsync(0x40)).toBe(true);
    expect(f.called("SetWindowPos")[0].args).toEqual([0x40, null, 0, 0, 0, 0, 0x4003]);
    ok = 0;
    expect(api.bringToTopAsync(0x40)).toBe(false);
    expect(api.bringToTopAsync(0)).toBe(false);
    expect(f.called("SetWindowPos")).toHaveLength(2); // no call for a null window
  });

  it("sends the INPUT array with its count and INPUT's size", () => {
    const f = fakeLoad({ SendInput: (count: number) => count });
    const buf = Buffer.alloc(2 * INPUT_SIZE);
    expect(bindWin32(koffi, f.load).sendInput(buf, 2)).toBe(2);
    expect(f.called("SendInput")[0].args).toEqual([2, buf, 40]);
  });

  it("reads the input desktop's name and closes it, or null when it can't be opened", () => {
    let open: bigint | null = 0x800n;
    const f = fakeLoad({
      OpenInputDesktop: (_f: number, _i: number, access: number) => { expect(access).toBe(1); return open; },
      GetUserObjectInformationW: (_d: bigint, index: number, buf: Buffer) => { expect(index).toBe(2); buf.write("Default\0", "utf16le"); return 1; },
    });
    const api = bindWin32(koffi, f.load);
    expect(api.inputDesktopName()).toBe("Default");
    expect(f.called("CloseDesktop").map(c => c.args[0])).toEqual([0x800n]);
    open = null;
    expect(api.inputDesktopName()).toBeNull();
  });

  it("captures through a top-down DIB section with SRCCOPY | CAPTUREBLT, copying the pixels before freeing them", () => {
    const pixels = Buffer.from(Array.from({ length: 3 * 2 * 4 }, (_, i) => i));
    let blt = 1;
    const f = fakeLoad({
      GetDC: () => 0x1n, CreateCompatibleDC: () => 0x2n, SelectObject: () => 0x4n,
      CreateDIBSection: (_dc: bigint, info: Buffer, usage: number, bits: unknown[]) => {
        expect([info.readInt32LE(4), info.readInt32LE(8), info.readUInt16LE(14), usage]).toEqual([3, -2, 32, 0]);
        bits[0] = koffi.address(pixels);
        return 0x3n;
      },
      BitBlt: () => blt,
    });
    const api = bindWin32(koffi, f.load);
    const out = api.blit(-5, 7, 3, 2)!;
    expect(out.equals(pixels)).toBe(true);
    pixels.fill(0);
    expect(out[5]).toBe(5); // a copy: what GDI frees afterwards doesn't change it
    expect(f.called("BitBlt")[0].args).toEqual([0x2n, 0, 0, 3, 2, 0x1n, -5, 7, 0x40cc0020]);
    const cleanup = () => ["SelectObject", "DeleteObject", "DeleteDC", "ReleaseDC"].map(n => f.called(n).length);
    expect(cleanup()).toEqual([2, 1, 1, 1]);
    blt = 0;
    expect(api.blit(0, 0, 3, 2)).toBeNull();
    expect(cleanup()).toEqual([4, 2, 2, 2]);
    expect(api.blit(0, 0, 0, 2)).toBeNull();
    expect(f.called("GetDC")).toHaveLength(2);
  });

  it("frees the bitmap and never reads an untouched DIB when the bitmap can't be selected or has no bits", () => {
    let selected: bigint | null = null, bits = true;
    const f = fakeLoad({
      GetDC: () => 0x1n, CreateCompatibleDC: () => 0x2n, BitBlt: () => 1,
      CreateDIBSection: (_dc: bigint, _info: Buffer, _usage: number, out: unknown[]) => { out[0] = bits ? 0x9n : null; return 0x3n; },
      SelectObject: () => selected,
    });
    const api = bindWin32(koffi, f.load);
    expect(api.blit(0, 0, 3, 2)).toBeNull(); // SelectObject failed: BitBlt would have drawn into the stock bitmap
    expect(f.called("BitBlt")).toHaveLength(0);
    selected = 0x4n;
    bits = false;
    expect(api.blit(0, 0, 3, 2)).toBeNull();
    expect(["DeleteObject", "DeleteDC", "ReleaseDC"].map(n => f.called(n).length)).toEqual([2, 2, 2]);
  });
});
