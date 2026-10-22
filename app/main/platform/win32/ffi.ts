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
 * - No synchronous cross-thread window call: nothing here sends a message to another process's window or waits for
 *   another thread to handle one, because Ember calls these on its main thread and a busy app (not only a hung one)
 *   would then freeze the overlay and the stop shortcut. Titles come from GetWindowTextW, which reads the stored
 *   caption of another process's window, or InternalGetWindowText for Ember's own; restoring a window uses
 *   ShowWindowAsync and raising one SetWindowPos with SWP_ASYNCWINDOWPOS (BringWindowToTop, ShowWindow and a plain
 *   SetWindowPos wait for the window's thread, so none of them is bound).
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
  /**
   * Is the key (with Shift, or without) a dead key on that layout (ToUnicodeEx gives -1)? Asked without changing any
   * keyboard state; true when it can't be asked, so a key that may be dead is never pressed for a character.
   */
  deadKey(vk: number, shift: boolean, layout: unknown): boolean;
  currentThreadId(): number;
  attachThreadInput(from: number, to: number, attach: boolean): boolean;
  setForeground(hwnd: number): boolean;
  /**
   * Puts a top-level window at the top of the z-order without waiting for its thread: SetWindowPos(HWND_TOP) with
   * SWP_NOMOVE | SWP_NOSIZE | SWP_ASYNCWINDOWPOS, which posts the request to the window's thread (BringWindowToTop is
   * the same call made synchronously, which waits for a busy app).
   */
  bringToTopAsync(hwnd: number): boolean;
  /** ShowWindowAsync: never waits for the window's thread. */
  showWindowAsync(hwnd: number, command: number): boolean;
  /** SetFocus, for Ember's own windows only: they live on the calling (main) thread, so nothing waits on another. */
  setFocus(hwnd: number): void;
  /** The input desktop's name ("Default", "Winlogon"…), or null when it can't be opened (the secure desktop). */
  inputDesktopName(): string | null;
  /** BitBlt of a screen rectangle (virtual-desktop pixels) into a top-down 32-bit DIB: BGRA, stride width × 4. */
  blit(x: number, y: number, width: number, height: number): Buffer | null;
}

/** GetSystemMetrics indices. */
export const SM = { SWAPBUTTON: 23, XVIRTUALSCREEN: 76, YVIRTUALSCREEN: 77, CXVIRTUALSCREEN: 78, CYVIRTUALSCREEN: 79 } as const;

const GW_HWNDNEXT = 2, GW_OWNER = 4, GA_ROOT = 2, GWL_STYLE = -16, GWL_EXSTYLE = -20;
/** SetWindowPos's flags for "raise it, nothing else, and don't wait": SWP_NOSIZE | SWP_NOMOVE | SWP_ASYNCWINDOWPOS. */
export const RAISE_ASYNC_FLAGS = 0x0001 | 0x0002 | 0x4000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14, LWA_ALPHA = 0x2, MONITOR_DEFAULTTONULL = 0;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, TOKEN_QUERY = 0x0008, TOKEN_ELEVATION = 20, TOKEN_INTEGRITY_LEVEL = 25;
const DESKTOP_READOBJECTS = 0x0001, UOI_NAME = 2, MAPVK_VK_TO_VSC = 0, VK_SHIFT = 0x10, VK_LSHIFT = 0xa0;
/** ToUnicodeEx's flag that leaves the keyboard state (a pending dead key) alone: Windows 10 1607 and newer. */
const TO_UNICODE_KEEP_STATE = 0x4;
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

/** The struct passed by value to WindowFromPoint and MonitorFromPoint (koffi type names are process-wide). */
const POINT_TYPE = "EmberWin32Point";
let pointType: unknown = null;

/** Defines the named types WIN32_FUNCTIONS uses (once per process; later calls do nothing). */
export function defineWin32Types(koffi: Koffi): void {
  pointType ??= koffi.struct(POINT_TYPE, { x: "int32_t", y: "int32_t" });
}

/**
 * Every Win32 function the backend calls, by DLL, in koffi's prototype syntax: the one place their C types live.
 * HWND, HDC and other handles are `void *` (koffi accepts numbers and BigInts for them, and returns BigInt or null);
 * structures are Buffers passed as `void *`.
 */
export const WIN32_FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
  "user32.dll": [
    "int __stdcall GetCursorPos(void *point)",
    "int16_t __stdcall GetAsyncKeyState(int vk)",
    "int __stdcall GetSystemMetrics(int index)",
    "void * __stdcall GetForegroundWindow()",
    "void * __stdcall GetTopWindow(void *hwnd)",
    "void * __stdcall GetWindow(void *hwnd, uint32_t cmd)",
    "void * __stdcall GetAncestor(void *hwnd, uint32_t flags)",
    "int __stdcall IsWindow(void *hwnd)",
    "int __stdcall IsWindowVisible(void *hwnd)",
    "int __stdcall IsIconic(void *hwnd)",
    "int __stdcall IsHungAppWindow(void *hwnd)",
    // GetWindowLongW is enough for the style words (only GWLP_ pointer values need the Ptr variant).
    "int32_t __stdcall GetWindowLongW(void *hwnd, int index)",
    "int __stdcall GetClassNameW(void *hwnd, void *buf, int max)",
    "int __stdcall GetWindowTextW(void *hwnd, void *buf, int max)",
    "int __stdcall InternalGetWindowText(void *hwnd, void *buf, int max)",
    "uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)",
    "int __stdcall GetWindowRect(void *hwnd, void *rect)",
    "int __stdcall GetClientRect(void *hwnd, void *rect)",
    "int __stdcall ClientToScreen(void *hwnd, void *point)",
    "void * __stdcall FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *title)",
    "int __stdcall GetLayeredWindowAttributes(void *hwnd, _Out_ uint32_t *key, _Out_ uint8_t *alpha, _Out_ uint32_t *flags)",
    "int __stdcall GetGUIThreadInfo(uint32_t tid, void *info)",
    `void * __stdcall WindowFromPoint(${POINT_TYPE} point)`,
    `void * __stdcall MonitorFromPoint(${POINT_TYPE} point, uint32_t flags)`,
    "uint32_t __stdcall SendInput(uint32_t count, void *inputs, int size)",
    "void * __stdcall GetKeyboardLayout(uint32_t tid)",
    "int16_t __stdcall VkKeyScanExW(uint16_t ch, void *layout)",
    "uint32_t __stdcall MapVirtualKeyExW(uint32_t code, uint32_t type, void *layout)",
    "int __stdcall ToUnicodeEx(uint32_t vk, uint32_t scan, const uint8_t *state, void *buf, int size, uint32_t flags, void *layout)",
    "int __stdcall AttachThreadInput(uint32_t from, uint32_t to, int attach)",
    "int __stdcall SetForegroundWindow(void *hwnd)",
    "int __stdcall SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, uint32_t flags)",
    "int __stdcall ShowWindowAsync(void *hwnd, int command)",
    "void * __stdcall SetFocus(void *hwnd)",
    "void * __stdcall OpenInputDesktop(uint32_t flags, int inherit, uint32_t access)",
    "int __stdcall GetUserObjectInformationW(void *obj, int index, void *buf, uint32_t size, _Out_ uint32_t *needed)",
    "int __stdcall CloseDesktop(void *desktop)",
    "void * __stdcall GetDC(void *hwnd)",
    "int __stdcall ReleaseDC(void *hwnd, void *hdc)",
    "void * __stdcall GetThreadDpiAwarenessContext()",
    "int __stdcall GetAwarenessFromDpiAwarenessContext(void *context)",
    "void * __stdcall SetThreadDpiAwarenessContext(void *context)",
  ],
  "gdi32.dll": [
    "void * __stdcall CreateCompatibleDC(void *hdc)",
    "void * __stdcall CreateDIBSection(void *hdc, void *info, uint32_t usage, _Out_ void **bits, void *section, uint32_t offset)",
    "void * __stdcall SelectObject(void *hdc, void *object)",
    "int __stdcall BitBlt(void *dst, int x, int y, int width, int height, void *src, int sx, int sy, uint32_t rop)",
    "int __stdcall DeleteObject(void *object)",
    "int __stdcall DeleteDC(void *hdc)",
    "int __stdcall GdiFlush()",
  ],
  "dwmapi.dll": [
    "int32_t __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t attribute, void *value, uint32_t size)",
  ],
  "kernel32.dll": [
    "void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
    "int __stdcall CloseHandle(void *handle)",
    "int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *buf, _Inout_ uint32_t *size)",
    "uint32_t __stdcall GetCurrentThreadId()",
    "void * __stdcall GetCurrentProcess()",
  ],
  "advapi32.dll": [
    "int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
    "int __stdcall GetTokenInformation(void *token, int kind, void *buf, uint32_t size, _Out_ uint32_t *returned)",
  ],
};

/**
 * What may be missing without the backend failing: DWM's attributes (windows then count as uncloaked, framed by
 * their window rectangle), the token calls (every window is then "unchecked": refused for input), the internal
 * title read (GetWindowTextW is used), the DPI calls (older than Windows 10 1607) and ToUnicodeEx (every punctuation
 * key then counts as possibly dead: no key for it).
 */
const OPTIONAL_LIBRARIES: ReadonlySet<string> = new Set(["dwmapi.dll", "advapi32.dll"]);
const OPTIONAL_FUNCTIONS: ReadonlySet<string> = new Set([
  "InternalGetWindowText", "GetThreadDpiAwarenessContext", "GetAwarenessFromDpiAwarenessContext", "SetThreadDpiAwarenessContext",
  "ToUnicodeEx",
]);

/** The function name in a prototype ("int __stdcall GetCursorPos(void *point)" → "GetCursorPos"). */
export function functionName(declaration: string): string {
  return /(\w+)\s*\(/.exec(declaration)?.[1] ?? "";
}

/** A bound function, or null for an optional one that isn't there. */
type Bound = ((...args: unknown[]) => any) | null; // eslint-disable-line @typescript-eslint/no-explicit-any -- koffi's results are untyped

/** Binds WIN32_FUNCTIONS from the libraries `load` opens; throws when a required library or function is missing. */
function bindFunctions(load: (name: string) => Pick<import("koffi").LibraryHandle, "func">): Record<string, Bound> {
  const fns: Record<string, Bound> = {};
  for (const [library, declarations] of Object.entries(WIN32_FUNCTIONS)) {
    let lib: Pick<import("koffi").LibraryHandle, "func"> | null = null;
    try {
      lib = load(library);
    } catch (err) {
      if (!OPTIONAL_LIBRARIES.has(library)) throw err;
    }
    for (const declaration of declarations) {
      const name = functionName(declaration);
      try {
        fns[name] = lib ? (lib.func(declaration) as Bound) : null;
      } catch (err) {
        if (!OPTIONAL_FUNCTIONS.has(name) && !OPTIONAL_LIBRARIES.has(library)) throw err;
        fns[name] = null;
      }
    }
  }
  return fns;
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
    const koffi = requireCjs("koffi") as Koffi;
    loaded = bindWin32(koffi, name => koffi.load(name));
  } catch (err) {
    win32Error = err;
  }
  return loaded;
}

/**
 * Binds the Win32 API with `koffi` (its types, sizes and memory decoding) from the libraries `load` opens. Exported
 * for tests, which pass fake libraries; everything else goes through loadWin32().
 */
export function bindWin32(koffi: Koffi, load: (name: string) => Pick<import("koffi").LibraryHandle, "func">): Win32Api {
  if (koffi.sizeof("void *") !== 8) throw new Error("the Windows backend needs a 64-bit process");
  defineWin32Types(koffi);
  const fn = bindFunctions(load);
  const need = (name: string) => {
    const f = fn[name];
    if (!f) throw new Error(`${name} isn't available`);
    return f;
  };
  const GetCursorPos = need("GetCursorPos"), GetAsyncKeyState = need("GetAsyncKeyState"), GetSystemMetrics = need("GetSystemMetrics");
  const GetForegroundWindow = need("GetForegroundWindow"), GetTopWindow = need("GetTopWindow"), GetWindow = need("GetWindow");
  const GetAncestor = need("GetAncestor"), IsWindow = need("IsWindow"), IsWindowVisible = need("IsWindowVisible");
  const IsIconic = need("IsIconic"), IsHungAppWindow = need("IsHungAppWindow"), GetWindowLongW = need("GetWindowLongW");
  const GetClassNameW = need("GetClassNameW"), GetWindowTextW = need("GetWindowTextW"), InternalGetWindowText = fn.InternalGetWindowText;
  const GetWindowThreadProcessId = need("GetWindowThreadProcessId"), GetWindowRect = need("GetWindowRect");
  const GetClientRect = need("GetClientRect"), ClientToScreen = need("ClientToScreen"), FindWindowExW = need("FindWindowExW");
  const GetLayeredWindowAttributes = need("GetLayeredWindowAttributes"), GetGUIThreadInfo = need("GetGUIThreadInfo");
  const WindowFromPoint = need("WindowFromPoint"), MonitorFromPoint = need("MonitorFromPoint"), SendInput = need("SendInput");
  const GetKeyboardLayout = need("GetKeyboardLayout"), VkKeyScanExW = need("VkKeyScanExW"), MapVirtualKeyExW = need("MapVirtualKeyExW");
  const ToUnicodeEx = fn.ToUnicodeEx;
  const AttachThreadInput = need("AttachThreadInput"), SetForegroundWindow = need("SetForegroundWindow");
  const SetWindowPos = need("SetWindowPos"), ShowWindowAsync = need("ShowWindowAsync"), SetFocus = need("SetFocus");
  const OpenInputDesktop = need("OpenInputDesktop"), GetUserObjectInformationW = need("GetUserObjectInformationW");
  const CloseDesktop = need("CloseDesktop"), GetDC = need("GetDC"), ReleaseDC = need("ReleaseDC");
  const GetThreadDpiAwarenessContext = fn.GetThreadDpiAwarenessContext, SetThreadDpiAwarenessContext = fn.SetThreadDpiAwarenessContext;
  const GetAwarenessFromDpiAwarenessContext = fn.GetAwarenessFromDpiAwarenessContext;
  const CreateCompatibleDC = need("CreateCompatibleDC"), CreateDIBSection = need("CreateDIBSection"), SelectObject = need("SelectObject");
  const BitBlt = need("BitBlt"), DeleteObject = need("DeleteObject"), DeleteDC = need("DeleteDC"), GdiFlush = need("GdiFlush");
  const DwmGetWindowAttribute = fn.DwmGetWindowAttribute;
  const OpenProcess = need("OpenProcess"), CloseHandle = need("CloseHandle"), QueryFullProcessImageNameW = need("QueryFullProcessImageNameW");
  const GetCurrentThreadId = need("GetCurrentThreadId"), GetCurrentProcess = need("GetCurrentProcess");
  const OpenProcessToken = fn.OpenProcessToken, GetTokenInformation = fn.GetTokenInformation;

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

  const rectOf = (call: (hwnd: number, buf: Buffer) => number, hwnd: number): Rect | null => {
    const buf = Buffer.alloc(16);
    return hwnd && call(hwnd, buf) ? readRect(buf) : null;
  };
  const textOf = (call: (hwnd: number, buf: Buffer, max: number) => number, hwnd: number): string => {
    if (!hwnd) return "";
    const buf = Buffer.alloc(TEXT_UNITS * 2);
    const n = call(hwnd, buf, TEXT_UNITS);
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
    deadKey(vk, shift, layout) {
      if (!ToUnicodeEx) return true;
      const state = Buffer.alloc(256);
      if (shift) state[VK_SHIFT] = state[VK_LSHIFT] = 0x80;
      const out = Buffer.alloc(16);
      return ToUnicodeEx(vk, MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC, layout), state, out, out.length / 2, TO_UNICODE_KEEP_STATE, layout) < 0;
    },
    currentThreadId: () => GetCurrentThreadId(),
    attachThreadInput: (from, to, attach) => AttachThreadInput(from, to, attach ? 1 : 0) !== 0,
    setForeground: hwnd => !!hwnd && SetForegroundWindow(hwnd) !== 0,
    // HWND_TOP is NULL; with SWP_ASYNCWINDOWPOS the call returns once the request is posted.
    bringToTopAsync: hwnd => !!hwnd && SetWindowPos(hwnd, null, 0, 0, 0, 0, RAISE_ASYNC_FLAGS) !== 0,
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
        if (!bitmap) return null;
        try {
          if (!bits[0]) return null;
          // A bitmap that didn't go in would leave the DC's 1×1 stock bitmap as the target: the copy would then
          // "succeed" and hand back the DIB's untouched (black) pixels.
          const old = SelectObject(memory, bitmap);
          if (!old) return null; // NULL is SelectObject's failure for a bitmap
          try {
            // CAPTUREBLT includes layered windows the way they are composed on screen.
            if (!BitBlt(memory, 0, 0, width, height, screen, x, y, SRCCOPY | CAPTUREBLT)) return null;
            GdiFlush();
            const pixels = koffi.decode(bits[0], "uint8_t", width * height * 4) as Uint8Array;
            return Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength); // a copy: safe after DeleteObject
          } finally {
            SelectObject(memory, old);
          }
        } finally {
          DeleteObject(bitmap);
        }
      } finally {
        if (memory) DeleteDC(memory);
        ReleaseDC(null, screen);
      }
    },
  };
}
