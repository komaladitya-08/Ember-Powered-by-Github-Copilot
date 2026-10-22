/**
 * Every Win32 call the Windows backend makes, through koffi (no compiled addon): user32, gdi32, dwmapi, kernel32 and
 * advapi32. The libraries are bound once per process, lazily, and only on Windows, so this module imports cleanly on
 * every OS; anything missing gives null instead of throwing. The calls are wrapped as `Win32Api`, small synchronous
 * functions with plain JS values (window handles as numbers, see hwndOf), which is what windows.ts, input.ts and
 * capture.ts are written against (and what their tests fake).
 *
 * Rules kept here:
 * - Native memory is copied with koffi.decode; koffi.view() would abort Electron (V8 memory cage).
 * - Structures go in Buffers passed as `void *`, which koffi hands over in place (no copy), so pointers the system
 *   writes into them (a token label's SID) stay valid while the Buffer lives.
 * - Win32 BOOL is `int` (koffi's `bool` is one byte).
 * - Nothing here sends a message to another process's window (a hung app would hang Ember): titles come from
 *   GetWindowTextW, which reads the stored caption of another process's window, or InternalGetWindowText for
 *   Ember's own; restoring a window uses ShowWindowAsync.
 * - Only 64-bit processes: the structure layouts (layouts.ts) are the 64-bit ones, and SendInput is refused unless
 *   koffi agrees on INPUT's layout.
 */

import { createRequire } from "node:module";
import type { Rect } from "../types";
import {
  bitmapInfo, guiThreadInfoBuffer, hwndOf, INPUT_OFFSETS, INPUT_SIZE, readGuiThreadInfo, readPoint, readRect,
  readUtf16, sidRid,
} from "./layouts";
import type { TokenFacts } from "./security";

/** The Win32 calls the backend needs, with plain values. Window handles are numbers (hwndOf); 0 means none. */
export interface Win32Api {
  /** False when koffi lays INPUT out differently from layouts.ts: SendInput must not be called then. */
  readonly canSendInput: boolean;
  /** GetCursorPos, in physical pixels; null when it fails (the secure desktop). */
  cursorPos(): { x: number; y: number } | null;
  /** GetAsyncKeyState's high bit: is the key (or physical mouse button) down now? */
  asyncKeyDown(vk: number): boolean;
  systemMetric(index: number): number;
  foregroundWindow(): number;
  /** GetTopWindow(NULL): the topmost top-level window. */
  topWindow(): number;
  /** GetWindow(GW_HWNDNEXT): the top-level window below. */
  nextWindow(hwnd: number): number;
  /** GetWindow(GW_OWNER). */
  owner(hwnd: number): number;
  /** GetAncestor(GA_ROOT): the top-level window that holds it. */
  root(hwnd: number): number;
  isWindow(hwnd: number): boolean;
  isVisible(hwnd: number): boolean;
  isIconic(hwnd: number): boolean;
  isHung(hwnd: number): boolean;
  /** GWL_STYLE as an unsigned number. */
  style(hwnd: number): number;
  /** GWL_EXSTYLE as an unsigned number. */
  exStyle(hwnd: number): number;
  className(hwnd: number): string;
  /** The window's title without sending it a message (`own`: the window is Ember's own process's). */
  title(hwnd: number, own: boolean): string;
  /** The thread and process that own the window ({0, 0} when it is gone). */
  threadProcess(hwnd: number): { tid: number; pid: number };
  windowRect(hwnd: number): Rect | null;
  /** The client area in screen coordinates. */
  clientRect(hwnd: number): Rect | null;
  /** DWMWA_EXTENDED_FRAME_BOUNDS: what the window visibly covers (no invisible resize borders, no shadow). */
  frameBounds(hwnd: number): Rect | null;
  /** DWMWA_CLOAKED: hidden by DWM though visible (another virtual desktop, a suspended UWP frame). */
  cloaked(hwnd: number): boolean;
  /** A layered window's constant alpha when it has one (LWA_ALPHA), else null. */
  layeredAlpha(hwnd: number): number | null;
  /** FindWindowExW by class: the next window of `className` among `parent`'s children (0: the top-level windows). */
  findWindow(parent: number, after: number, className: string): number;
  /** GetGUIThreadInfo: the thread's active and focused windows; null when it fails. */
  guiThreadInfo(tid: number): { active: number; focus: number } | null;
  windowFromPoint(x: number, y: number): number;
  /** Is the point on some monitor (MonitorFromPoint with MONITOR_DEFAULTTONULL)? */
  onMonitor(x: number, y: number): boolean;
  /** QueryFullProcessImageNameW of the process (limited-information access), or null. */
  processImage(pid: number): string | null;
  /** The process's token facts (null: Ember's own process), or null when they can't be read. */
  processToken(pid: number | null): TokenFacts | null;
  /** SendInput: how many of the encoded INPUTs went in. */
  sendInput(inputs: Buffer, count: number): number;
  /** GetKeyboardLayout of a thread (an opaque HKL). */
  keyboardLayout(tid: number): unknown;
  /** VkKeyScanExW: VK in the low byte, shift state in the high byte, -1 for none. */
  vkKeyScan(ch: number, layout: unknown): number;
  /** MapVirtualKeyExW(MAPVK_VK_TO_VSC): the key's scan code on that layout. */
  scanCode(vk: number, layout: unknown): number;
  currentThreadId(): number;
  attachThreadInput(from: number, to: number, attach: boolean): boolean;
  setForeground(hwnd: number): boolean;
  bringToTop(hwnd: number): boolean;
  /** ShowWindowAsync: never waits for the window's thread. */
  showWindowAsync(hwnd: number, command: number): boolean;
  setFocus(hwnd: number): void;
  /** The input desktop's name ("Default", "Winlogon"…), or null when it can't be opened (the secure desktop). */
  inputDesktopName(): string | null;
  /** BitBlt of a screen rectangle (virtual-desktop pixels) into a top-down 32-bit DIB: BGRA, stride width × 4. */
  blit(x: number, y: number, width: number, height: number): Buffer | null;
}

/** GetSystemMetrics indices. */
export const SM = { SWAPBUTTON: 23, XVIRTUALSCREEN: 76, YVIRTUALSCREEN: 77, CXVIRTUALSCREEN: 78, CYVIRTUALSCREEN: 79 } as const;

const GW_HWNDNEXT = 2, GW_OWNER = 4, GA_ROOT = 2, GWL_STYLE = -16, GWL_EXSTYLE = -20;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14, LWA_ALPHA = 0x2, MONITOR_DEFAULTTONULL = 0;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, TOKEN_QUERY = 0x0008, TOKEN_ELEVATION = 20, TOKEN_INTEGRITY_LEVEL = 25;
const DESKTOP_READOBJECTS = 0x0001, UOI_NAME = 2, MAPVK_VK_TO_VSC = 0;
const SRCCOPY = 0x00cc0020, CAPTUREBLT = 0x40000000, DIB_RGB_COLORS = 0;
/** DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, and DPI_AWARENESS_PER_MONITOR_AWARE. */
const PER_MONITOR_AWARE_V2 = -4, PER_MONITOR_AWARE = 2;
/** Longest title or class read (UTF-16 units): longer titles are cut, which only matters for exact-title matching. */
const TEXT_UNITS = 1024;

const requireCjs = createRequire(__filename);
type Koffi = typeof import("koffi");

/**
 * Does koffi lay INPUT out as layouts.ts encodes it (sizeof 40, union at 8, dwExtraInfo at 32 and 24)? Checked
 * before any SendInput: a wrong layout would inject garbage. True on 64-bit processes; false on 32-bit (28 bytes).
 */
export function inputLayoutMatches(koffi: Koffi): boolean {
  const mouse = koffi.struct({ dx: "int32_t", dy: "int32_t", mouseData: "uint32_t", dwFlags: "uint32_t", time: "uint32_t", dwExtraInfo: "uintptr_t" });
  const key = koffi.struct({ wVk: "uint16_t", wScan: "uint16_t", dwFlags: "uint32_t", time: "uint32_t", dwExtraInfo: "uintptr_t" });
  const hardware = koffi.struct({ uMsg: "uint32_t", wParamL: "uint16_t", wParamH: "uint16_t" });
  const input = koffi.struct({ type: "uint32_t", u: koffi.union({ mi: mouse, ki: key, hi: hardware }) });
  const u = koffi.offsetof(input, "u");
  const m = INPUT_OFFSETS.mouse, k = INPUT_OFFSETS.key;
  return koffi.sizeof(input) === INPUT_SIZE && u === INPUT_OFFSETS.union
    && u + koffi.offsetof(mouse, "dx") === m.dx && u + koffi.offsetof(mouse, "mouseData") === m.mouseData
    && u + koffi.offsetof(mouse, "dwFlags") === m.dwFlags && u + koffi.offsetof(mouse, "dwExtraInfo") === m.dwExtraInfo
    && u + koffi.offsetof(key, "wVk") === k.wVk && u + koffi.offsetof(key, "wScan") === k.wScan
    && u + koffi.offsetof(key, "dwFlags") === k.dwFlags && u + koffi.offsetof(key, "dwExtraInfo") === k.dwExtraInfo;
}

/** The bound API, once per process (undefined: not tried yet; null: not available). */
let loaded: Win32Api | null | undefined;
/** Why the last loadWin32() gave null (for the log). */
export let win32Error: unknown = null;

/** The Win32 API, or null when not on 64-bit Windows or koffi or a system library can't be loaded. */
export function loadWin32(): Win32Api | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (process.platform !== "win32") return null;
  try {
    loaded = bind(requireCjs("koffi") as Koffi);
  } catch (err) {
    win32Error = err;
  }
  return loaded;
}

function bind(koffi: Koffi): Win32Api {
  if (koffi.sizeof("void *") !== 8) throw new Error("the Windows backend needs a 64-bit process");
  const user32 = koffi.load("user32.dll"), gdi32 = koffi.load("gdi32.dll"), kernel32 = koffi.load("kernel32.dll");
  const optional = (name: string) => { try { return koffi.load(name); } catch { return null; } };
  const dwmapi = optional("dwmapi.dll"), advapi32 = optional("advapi32.dll");
  const maybe = (lib: import("koffi").LibraryHandle | null, decl: string) => {
    try { return lib ? lib.func(decl) : null; } catch { return null; }
  };
  const POINT = koffi.struct({ x: "int32_t", y: "int32_t" });

  const GetCursorPos = user32.func("int __stdcall GetCursorPos(void *point)");
  const GetAsyncKeyState = user32.func("int16_t __stdcall GetAsyncKeyState(int vk)");
  const GetSystemMetrics = user32.func("int __stdcall GetSystemMetrics(int index)");
  const GetForegroundWindow = user32.func("void * __stdcall GetForegroundWindow()");
  const GetTopWindow = user32.func("void * __stdcall GetTopWindow(void *hwnd)");
  const GetWindow = user32.func("void * __stdcall GetWindow(void *hwnd, uint32_t cmd)");
  const GetAncestor = user32.func("void * __stdcall GetAncestor(void *hwnd, uint32_t flags)");
  const IsWindow = user32.func("int __stdcall IsWindow(void *hwnd)");
  const IsWindowVisible = user32.func("int __stdcall IsWindowVisible(void *hwnd)");
  const IsIconic = user32.func("int __stdcall IsIconic(void *hwnd)");
  const IsHungAppWindow = user32.func("int __stdcall IsHungAppWindow(void *hwnd)");
  // GetWindowLongW is enough for the style words (only GWLP_ pointer values need the Ptr variant).
  const GetWindowLongW = user32.func("int32_t __stdcall GetWindowLongW(void *hwnd, int index)");
  const GetClassNameW = user32.func("int __stdcall GetClassNameW(void *hwnd, void *buf, int max)");
  const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(void *hwnd, void *buf, int max)");
  const InternalGetWindowText = maybe(user32, "int __stdcall InternalGetWindowText(void *hwnd, void *buf, int max)");
  const GetWindowThreadProcessId = user32.func("uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)");
  const GetWindowRect = user32.func("int __stdcall GetWindowRect(void *hwnd, void *rect)");
  const GetClientRect = user32.func("int __stdcall GetClientRect(void *hwnd, void *rect)");
  const ClientToScreen = user32.func("int __stdcall ClientToScreen(void *hwnd, void *point)");
  const FindWindowExW = user32.func("void * __stdcall FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *title)");
  const GetLayeredWindowAttributes = user32.func("int __stdcall GetLayeredWindowAttributes(void *hwnd, _Out_ uint32_t *key, _Out_ uint8_t *alpha, _Out_ uint32_t *flags)");
  const GetGUIThreadInfo = user32.func("int __stdcall GetGUIThreadInfo(uint32_t tid, void *info)");
  const WindowFromPoint = user32.func("__stdcall", "WindowFromPoint", "void *", [POINT]);
  const MonitorFromPoint = user32.func("__stdcall", "MonitorFromPoint", "void *", [POINT, "uint32_t"]);
  const SendInput = user32.func("uint32_t __stdcall SendInput(uint32_t count, void *inputs, int size)");
  const GetKeyboardLayout = user32.func("void * __stdcall GetKeyboardLayout(uint32_t tid)");
  const VkKeyScanExW = user32.func("int16_t __stdcall VkKeyScanExW(uint16_t ch, void *layout)");
  const MapVirtualKeyExW = user32.func("uint32_t __stdcall MapVirtualKeyExW(uint32_t code, uint32_t type, void *layout)");
  const AttachThreadInput = user32.func("int __stdcall AttachThreadInput(uint32_t from, uint32_t to, int attach)");
  const SetForegroundWindow = user32.func("int __stdcall SetForegroundWindow(void *hwnd)");
  const BringWindowToTop = user32.func("int __stdcall BringWindowToTop(void *hwnd)");
  const ShowWindowAsync = user32.func("int __stdcall ShowWindowAsync(void *hwnd, int command)");
  const SetFocus = user32.func("void * __stdcall SetFocus(void *hwnd)");
  const OpenInputDesktop = user32.func("void * __stdcall OpenInputDesktop(uint32_t flags, int inherit, uint32_t access)");
  const GetUserObjectInformationW = user32.func("int __stdcall GetUserObjectInformationW(void *obj, int index, void *buf, uint32_t size, _Out_ uint32_t *needed)");
  const CloseDesktop = user32.func("int __stdcall CloseDesktop(void *desktop)");
  const GetDC = user32.func("void * __stdcall GetDC(void *hwnd)");
  const ReleaseDC = user32.func("int __stdcall ReleaseDC(void *hwnd, void *hdc)");
  const GetThreadDpiAwarenessContext = maybe(user32, "void * __stdcall GetThreadDpiAwarenessContext()");
  const GetAwarenessFromDpiAwarenessContext = maybe(user32, "int __stdcall GetAwarenessFromDpiAwarenessContext(void *context)");
  const SetThreadDpiAwarenessContext = maybe(user32, "void * __stdcall SetThreadDpiAwarenessContext(void *context)");

  const CreateCompatibleDC = gdi32.func("void * __stdcall CreateCompatibleDC(void *hdc)");
  const CreateDIBSection = gdi32.func("void * __stdcall CreateDIBSection(void *hdc, void *info, uint32_t usage, _Out_ void **bits, void *section, uint32_t offset)");
  const SelectObject = gdi32.func("void * __stdcall SelectObject(void *hdc, void *object)");
  const BitBlt = gdi32.func("int __stdcall BitBlt(void *dst, int x, int y, int width, int height, void *src, int sx, int sy, uint32_t rop)");
  const DeleteObject = gdi32.func("int __stdcall DeleteObject(void *object)");
  const DeleteDC = gdi32.func("int __stdcall DeleteDC(void *hdc)");
  const GdiFlush = gdi32.func("int __stdcall GdiFlush()");

  const DwmGetWindowAttribute = maybe(dwmapi, "int32_t __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t attribute, void *value, uint32_t size)");

  const OpenProcess = kernel32.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const CloseHandle = kernel32.func("int __stdcall CloseHandle(void *handle)");
  const QueryFullProcessImageNameW = kernel32.func("int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *buf, _Inout_ uint32_t *size)");
  const GetCurrentThreadId = kernel32.func("uint32_t __stdcall GetCurrentThreadId()");
  const GetCurrentProcess = kernel32.func("void * __stdcall GetCurrentProcess()");

  const OpenProcessToken = maybe(advapi32, "int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)");
  const GetTokenInformation = maybe(advapi32, "int __stdcall GetTokenInformation(void *token, int kind, void *buf, uint32_t size, _Out_ uint32_t *returned)");

  // Physical pixels everywhere: Electron's main process is per-monitor aware already (nothing changes there), but
  // plain Node (the integration tests) isn't, and Windows would then scale every coordinate on a high-DPI monitor.
  try {
    if (GetThreadDpiAwarenessContext && GetAwarenessFromDpiAwarenessContext && SetThreadDpiAwarenessContext
      && GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) !== PER_MONITOR_AWARE) {
      SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2);
    }
  } catch {
    // Older than Windows 10 1607: coordinates stay as the process's awareness makes them.
  }

  const rectOf = (fn: (hwnd: number, buf: Buffer) => number, hwnd: number): Rect | null => {
    const buf = Buffer.alloc(16);
    return hwnd && fn(hwnd, buf) ? readRect(buf) : null;
  };
  const textOf = (fn: (hwnd: number, buf: Buffer, max: number) => number, hwnd: number): string => {
    if (!hwnd) return "";
    const buf = Buffer.alloc(TEXT_UNITS * 2);
    const n = fn(hwnd, buf, TEXT_UNITS);
    return n > 0 ? readUtf16(buf, n) : "";
  };
  const dwm = (hwnd: number, attribute: number, size: number): Buffer | null => {
    if (!DwmGetWindowAttribute || !hwnd) return null;
    const buf = Buffer.alloc(size);
    return DwmGetWindowAttribute(hwnd, attribute, buf, size) === 0 ? buf : null;
  };
  const tokenFacts = (token: unknown): TokenFacts | null => {
    if (!GetTokenInformation) return null;
    const returned = [0];
    const elevation = Buffer.alloc(4);
    if (!GetTokenInformation(token, TOKEN_ELEVATION, elevation, 4, returned)) return null;
    // TOKEN_MANDATORY_LABEL: a SID_AND_ATTRIBUTES whose Sid points further into this same buffer.
    const label = Buffer.alloc(128);
    let integrity: number | null = null;
    if (GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, label, label.length, returned)) {
      const sid = label.readBigUInt64LE(0);
      if (sid) {
        const head = koffi.decode(sid, "uint8_t", 8) as Uint8Array;
        if (head[1] >= 1 && head[1] <= 15) integrity = sidRid(Uint8Array.from(koffi.decode(sid, "uint8_t", 8 + 4 * head[1]) as Uint8Array));
      }
    }
    return { elevated: elevation.readUInt32LE(0) !== 0, integrity };
  };

  return {
    canSendInput: inputLayoutMatches(koffi),
    cursorPos() {
      const buf = Buffer.alloc(8);
      return GetCursorPos(buf) ? readPoint(buf) : null;
    },
    asyncKeyDown: vk => (GetAsyncKeyState(vk) & 0x8000) !== 0,
    systemMetric: index => GetSystemMetrics(index),
    foregroundWindow: () => hwndOf(GetForegroundWindow()),
    topWindow: () => hwndOf(GetTopWindow(null)),
    nextWindow: hwnd => (hwnd ? hwndOf(GetWindow(hwnd, GW_HWNDNEXT)) : 0),
    owner: hwnd => (hwnd ? hwndOf(GetWindow(hwnd, GW_OWNER)) : 0),
    root: hwnd => (hwnd ? hwndOf(GetAncestor(hwnd, GA_ROOT)) : 0),
    isWindow: hwnd => !!hwnd && IsWindow(hwnd) !== 0,
    isVisible: hwnd => !!hwnd && IsWindowVisible(hwnd) !== 0,
    isIconic: hwnd => !!hwnd && IsIconic(hwnd) !== 0,
    isHung: hwnd => !!hwnd && IsHungAppWindow(hwnd) !== 0,
    style: hwnd => (hwnd ? GetWindowLongW(hwnd, GWL_STYLE) >>> 0 : 0),
    exStyle: hwnd => (hwnd ? GetWindowLongW(hwnd, GWL_EXSTYLE) >>> 0 : 0),
    className: hwnd => textOf(GetClassNameW, hwnd),
    // GetWindowTextW sends WM_GETTEXT to windows of the calling process (it reads the stored caption only for other
    // processes' windows): Ember's own are read with InternalGetWindowText, which never sends a message.
    title: (hwnd, own) => textOf(own && InternalGetWindowText ? InternalGetWindowText : GetWindowTextW, hwnd),
    threadProcess(hwnd) {
      if (!hwnd) return { tid: 0, pid: 0 };
      const pid = [0];
      const tid = GetWindowThreadProcessId(hwnd, pid);
      return tid ? { tid, pid: pid[0] } : { tid: 0, pid: 0 };
    },
    windowRect: hwnd => rectOf(GetWindowRect, hwnd),
    clientRect(hwnd) {
      const r = rectOf(GetClientRect, hwnd);
      const origin = Buffer.alloc(8);
      if (!r || !ClientToScreen(hwnd, origin)) return null;
      const p = readPoint(origin);
      return { x: p.x, y: p.y, width: r.width, height: r.height };
    },
    frameBounds(hwnd) {
      const buf = dwm(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, 16);
      return buf ? readRect(buf) : null;
    },
    cloaked(hwnd) {
      // A failed call (the window just went away) reads as not cloaked: it is then judged like any other window.
      const buf = dwm(hwnd, DWMWA_CLOAKED, 4);
      return !!buf && buf.readUInt32LE(0) !== 0;
    },
    layeredAlpha(hwnd) {
      const key = [0], alpha = [0], flags = [0];
      return hwnd && GetLayeredWindowAttributes(hwnd, key, alpha, flags) && (flags[0] & LWA_ALPHA) ? alpha[0] : null;
    },
    findWindow: (parent, after, className) => hwndOf(FindWindowExW(parent || null, after || null, className, null)),
    guiThreadInfo(tid) {
      const buf = guiThreadInfoBuffer();
      return tid && GetGUIThreadInfo(tid, buf) ? readGuiThreadInfo(buf) : null;
    },
    windowFromPoint: (x, y) => hwndOf(WindowFromPoint({ x: Math.round(x), y: Math.round(y) })),
    onMonitor: (x, y) => MonitorFromPoint({ x: Math.round(x), y: Math.round(y) }, MONITOR_DEFAULTTONULL) !== null,
    processImage(pid) {
      if (!pid) return null;
      const process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (!process) return null;
      try {
        const units = 4096, buf = Buffer.alloc(units * 2), size = [units];
        return QueryFullProcessImageNameW(process, 0, buf, size) ? readUtf16(buf, size[0]) : null;
      } finally {
        CloseHandle(process);
      }
    },
    processToken(pid) {
      if (!OpenProcessToken) return null;
      const process = pid === null ? GetCurrentProcess() : pid ? OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) : null;
      if (!process) return null;
      try {
        const token: unknown[] = [null];
        if (!OpenProcessToken(process, TOKEN_QUERY, token) || !token[0]) return null;
        try {
          return tokenFacts(token[0]);
        } finally {
          CloseHandle(token[0]);
        }
      } finally {
        if (pid !== null) CloseHandle(process); // GetCurrentProcess() is a pseudo-handle: nothing to close
      }
    },
    sendInput: (inputs, count) => SendInput(count, inputs, INPUT_SIZE),
    keyboardLayout: tid => GetKeyboardLayout(tid),
    vkKeyScan: (ch, layout) => VkKeyScanExW(ch, layout),
    scanCode: (vk, layout) => MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC, layout),
    currentThreadId: () => GetCurrentThreadId(),
    attachThreadInput: (from, to, attach) => AttachThreadInput(from, to, attach ? 1 : 0) !== 0,
    setForeground: hwnd => !!hwnd && SetForegroundWindow(hwnd) !== 0,
    bringToTop: hwnd => !!hwnd && BringWindowToTop(hwnd) !== 0,
    showWindowAsync: (hwnd, command) => !!hwnd && ShowWindowAsync(hwnd, command) !== 0,
    setFocus(hwnd) {
      if (hwnd) SetFocus(hwnd);
    },
    inputDesktopName() {
      const desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
      if (!desktop) return null;
      try {
        const buf = Buffer.alloc(512), needed = [0];
        return GetUserObjectInformationW(desktop, UOI_NAME, buf, buf.length, needed) ? readUtf16(buf, buf.length / 2) : null;
      } finally {
        CloseDesktop(desktop);
      }
    },
    blit(x, y, width, height) {
      if (width <= 0 || height <= 0) return null;
      // The screen DC covers the whole virtual desktop, with the primary monitor's top-left at (0, 0).
      const screen = GetDC(null);
      if (!screen) return null;
      const memory = CreateCompatibleDC(screen);
      try {
        if (!memory) return null;
        const bits: unknown[] = [null];
        const bitmap = CreateDIBSection(screen, bitmapInfo(width, height), DIB_RGB_COLORS, bits, null, 0);
        if (!bitmap || !bits[0]) return null;
        const old = SelectObject(memory, bitmap);
        try {
          // CAPTUREBLT includes layered windows the way they are composed on screen.
          if (!BitBlt(memory, 0, 0, width, height, screen, x, y, SRCCOPY | CAPTUREBLT)) return null;
          GdiFlush();
          const pixels = koffi.decode(bits[0], "uint8_t", width * height * 4) as Uint8Array;
          return Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength); // a copy: safe after DeleteObject
        } finally {
          SelectObject(memory, old);
          DeleteObject(bitmap);
        }
      } finally {
        if (memory) DeleteDC(memory);
        ReleaseDC(null, screen);
      }
    },
  };
}
