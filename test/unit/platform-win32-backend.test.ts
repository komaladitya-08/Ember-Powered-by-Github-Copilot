/**
 * The Windows window system and input backends on a fake Win32 desktop (so they run on Linux): the stack and the
 * apps' windows as Ember sees them, UWP frames named after their app, focus, capture that fails closed, window ids,
 * the documented foreground order, and input that ends exactly where asked, presses logical buttons, tracks and lets
 * go of everything Ember holds (also at exit), reports only the user's keys, types any character, refuses elevated
 * windows and knows where a click lands. Both factories give null off Windows without a fake.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { Rect, ScreenLike } from "../../app/main/platform/types";
import type { Win32Api } from "../../app/main/platform/win32/ffi";
import { openWin32Input, openWin32Windows } from "../../app/main/platform/win32";
import { FAKE_CONTROL_GRACE_MS, VK } from "../../app/main/platform/win32/keys";
import { EMBER_INPUT_TAG, INPUT_SIZE, KEYEVENTF, MOUSEEVENTF } from "../../app/main/platform/win32/layouts";
import { WS, WS_EX } from "../../app/main/platform/win32/rules";
import { ELEVATED_REASON, UNCHECKED_REASON, type TokenFacts } from "../../app/main/platform/win32/security";

const OWN = process.pid;
const OVERLAPPED = 0x14cf0000;

interface FakeWindow {
  hwnd: number;
  pid: number;
  tid?: number;
  cls: string;
  title: string;
  style?: number;
  exStyle?: number;
  owner?: number;
  visible?: boolean;
  iconic?: boolean;
  cloaked?: boolean;
  hung?: boolean;
  frame: Rect;
  rect?: Rect;
  client?: Rect;
  alpha?: number | null;
  /** A child window (not in the z-order): its parent. */
  parent?: number;
  /** The focused child, for GetGUIThreadInfo. */
  focus?: number;
}

type Decoded =
  | { kind: "mouse"; dx: number; dy: number; mouseData: number; flags: number; tag: bigint }
  | { kind: "key"; vk: number; scan: number; flags: number; tag: bigint };

const GENERIC: Record<number, number> = { [VK.LSHIFT]: VK.SHIFT, [VK.RSHIFT]: VK.SHIFT, [VK.LCONTROL]: VK.CONTROL, [VK.RCONTROL]: VK.CONTROL, [VK.LMENU]: VK.MENU, [VK.RMENU]: VK.MENU };
const US: Record<string, [number, number]> = { "/": [0xbf, 0], "?": [0xbf, 1], "1": [0x31, 0], "!": [0x31, 1] };

/** A Win32 desktop in memory: windows in z-order, processes, the key state, the pointer and the foreground lock. */
class FakeDesktop implements Win32Api {
  canSendInput = true;
  windows: FakeWindow[] = [];
  images = new Map<number, string>();
  tokens = new Map<number, TokenFacts | null>();
  own: TokenFacts | null = { elevated: false, integrity: 0x2000 };
  keys = new Set<number>();
  cursor: { x: number; y: number } | null = { x: 10, y: 10 };
  fg = 0;
  virtual: Rect = { x: -1920, y: 0, width: 3840, height: 1080 };
  monitors: Rect[] = [{ x: -1920, y: 0, width: 1920, height: 1000 }, { x: 0, y: 0, width: 1920, height: 1080 }];
  swapped = false;
  desktop: string | null = "Default";
  /** Does the layout make right Alt into AltGr (Windows then adds a fake left Ctrl)? */
  altGr = true;
  /** When SetForegroundWindow works: always, only after Ember's input or with the threads attached, or never. */
  lock: "open" | "input" | "attach" | "closed" = "open";
  lastInputEmber = false;
  attached = false;
  sent: Decoded[] = [];
  calls: string[] = [];
  blitResult: "ok" | "fail" | "short" = "ok";
  titleReads: { hwnd: number; own: boolean }[] = [];

  add(...ws: FakeWindow[]): this {
    this.windows.push(...ws);
    return this;
  }
  win(hwnd: number) {
    return this.windows.find(w => w.hwnd === hwnd);
  }
  top() {
    return this.windows.filter(w => !w.parent);
  }

  cursorPos() { return this.cursor ? { ...this.cursor } : null; }
  asyncKeyDown(vk: number) { return this.keys.has(vk); }
  systemMetric(index: number) {
    return ({ 23: this.swapped ? 1 : 0, 76: this.virtual.x, 77: this.virtual.y, 78: this.virtual.width, 79: this.virtual.height } as Record<number, number>)[index] ?? 0;
  }
  foregroundWindow() { return this.fg; }
  topWindow() { return this.top()[0]?.hwnd ?? 0; }
  nextWindow(hwnd: number) {
    const tops = this.top();
    const i = tops.findIndex(w => w.hwnd === hwnd);
    return i >= 0 ? tops[i + 1]?.hwnd ?? 0 : 0;
  }
  owner(hwnd: number) { return this.win(hwnd)?.owner ?? 0; }
  root(hwnd: number) {
    let w = this.win(hwnd);
    while (w?.parent) w = this.win(w.parent);
    return w?.hwnd ?? 0;
  }
  isWindow(hwnd: number) { return !!this.win(hwnd); }
  isVisible(hwnd: number) { return this.win(hwnd)?.visible ?? false; }
  isIconic(hwnd: number) { return this.win(hwnd)?.iconic ?? false; }
  isHung(hwnd: number) { return this.win(hwnd)?.hung ?? false; }
  style(hwnd: number) { return (this.win(hwnd)?.style ?? OVERLAPPED) >>> 0; }
  exStyle(hwnd: number) { return (this.win(hwnd)?.exStyle ?? 0) >>> 0; }
  className(hwnd: number) { return this.win(hwnd)?.cls ?? ""; }
  title(hwnd: number, own: boolean) {
    this.titleReads.push({ hwnd, own });
    return this.win(hwnd)?.title ?? "";
  }
  threadProcess(hwnd: number) {
    const w = this.win(hwnd);
    return w ? { tid: w.tid ?? w.pid * 10, pid: w.pid } : { tid: 0, pid: 0 };
  }
  windowRect(hwnd: number) { const w = this.win(hwnd); return w ? w.rect ?? w.frame : null; }
  clientRect(hwnd: number) { const w = this.win(hwnd); return w ? w.client ?? w.frame : null; }
  frameBounds(hwnd: number) { return this.win(hwnd)?.frame ?? null; }
  cloaked(hwnd: number) { return this.win(hwnd)?.cloaked ?? false; }
  layeredAlpha(hwnd: number) { return this.win(hwnd)?.alpha ?? null; }
  findWindow(parent: number, after: number, className: string) {
    const pool = this.windows.filter(w => (parent ? w.parent === parent : !w.parent) && w.cls === className);
    const i = after ? pool.findIndex(w => w.hwnd === after) + 1 : 0;
    return pool[i]?.hwnd ?? 0;
  }
  guiThreadInfo(tid: number) {
    const fg = this.win(this.fg);
    return fg && this.threadProcess(fg.hwnd).tid === tid ? { active: fg.hwnd, focus: fg.focus ?? 0 } : null;
  }
  windowFromPoint(x: number, y: number) {
    const hit = this.top().find(w => (w.visible ?? false) && !w.iconic && !w.cloaked
      && !((w.exStyle ?? 0) & WS_EX.LAYERED && (w.exStyle ?? 0) & WS_EX.TRANSPARENT)
      && x >= w.frame.x && y >= w.frame.y && x < w.frame.x + w.frame.width && y < w.frame.y + w.frame.height);
    // A child under the point, as WindowFromPoint returns the deepest window.
    return hit ? this.windows.find(c => c.parent === hit.hwnd)?.hwnd ?? hit.hwnd : 0;
  }
  onMonitor(x: number, y: number) {
    return this.monitors.some(m => x >= m.x && y >= m.y && x < m.x + m.width && y < m.y + m.height);
  }
  processImage(pid: number) { return this.images.get(pid) ?? null; }
  processToken(pid: number | null) {
    if (pid === null) return this.own;
    return this.tokens.has(pid) ? this.tokens.get(pid)! : { elevated: false, integrity: 0x2000 };
  }
  sendInput(inputs: Buffer, count: number) {
    expect(inputs.length).toBe(count * INPUT_SIZE);
    this.calls.push("sendInput");
    for (let i = 0; i < count; i++) {
      const at = i * INPUT_SIZE;
      const ev: Decoded = inputs.readUInt32LE(at) === 0
        ? { kind: "mouse", dx: inputs.readInt32LE(at + 8), dy: inputs.readInt32LE(at + 12), mouseData: inputs.readInt32LE(at + 16), flags: inputs.readUInt32LE(at + 20), tag: inputs.readBigUInt64LE(at + 32) }
        : { kind: "key", vk: inputs.readUInt16LE(at + 8), scan: inputs.readUInt16LE(at + 10), flags: inputs.readUInt32LE(at + 12), tag: inputs.readBigUInt64LE(at + 24) };
      this.sent.push(ev);
      this.apply(ev);
    }
    this.lastInputEmber = true;
    return count;
  }
  /** What the real system would do with an event: move the pointer, change the key and button state. */
  private apply(ev: Decoded) {
    const set = (vk: number, down: boolean) => {
      if (down) this.keys.add(vk); else this.keys.delete(vk);
      const generic = GENERIC[vk];
      if (generic) {
        const pair = Object.entries(GENERIC).filter(([, g]) => g === generic).map(([k]) => Number(k));
        if (pair.some(k => this.keys.has(k))) this.keys.add(generic); else this.keys.delete(generic);
      }
    };
    if (ev.kind === "mouse") {
      const f = ev.flags;
      if (f & MOUSEEVENTF.MOVE && f & MOUSEEVENTF.ABSOLUTE && f & MOUSEEVENTF.VIRTUALDESK) {
        this.cursor = { x: this.virtual.x + Math.floor((ev.dx * this.virtual.width) / 65536), y: this.virtual.y + Math.floor((ev.dy * this.virtual.height) / 65536) };
      }
      if (f & MOUSEEVENTF.LEFTDOWN) set(VK.LBUTTON, true);
      if (f & MOUSEEVENTF.LEFTUP) set(VK.LBUTTON, false);
      if (f & MOUSEEVENTF.RIGHTDOWN) set(VK.RBUTTON, true);
      if (f & MOUSEEVENTF.RIGHTUP) set(VK.RBUTTON, false);
      if (f & MOUSEEVENTF.MIDDLEDOWN) set(VK.MBUTTON, true);
      if (f & MOUSEEVENTF.MIDDLEUP) set(VK.MBUTTON, false);
      return;
    }
    const down = !(ev.flags & KEYEVENTF.KEYUP);
    if (ev.flags & KEYEVENTF.UNICODE) return set(VK.PACKET, down);
    set(ev.vk, down);
    if (ev.vk === VK.RMENU && this.altGr) set(VK.LCONTROL, down);
  }
  keyboardLayout(tid: number) { return `hkl:${tid}`; }
  vkKeyScan(ch: number, layout: unknown) {
    this.calls.push(`vkKeyScan:${String(layout)}`);
    const hit = US[String.fromCharCode(ch)];
    return hit ? (hit[1] << 8) | hit[0] : -1;
  }
  scanCode(vk: number) { return vk + 0x100; }
  /** Dead keys on this layout, as "vk" or "vk+shift". */
  dead = new Set<string>();
  deadKey(vk: number, shift: boolean, layout: unknown) {
    this.calls.push(`deadKey:${String(layout)}`);
    return this.dead.has(shift ? `${vk}+shift` : `${vk}`);
  }
  currentThreadId() { return 1; }
  attachThreadInput(from: number, to: number, attach: boolean) {
    this.calls.push(`attach:${from}->${to}:${attach}`);
    this.attached = attach;
    return true;
  }
  setForeground(hwnd: number) {
    this.calls.push(`setForeground:${hwnd}`);
    const fgPid = this.win(this.fg)?.pid;
    const ok = this.lock === "open" || fgPid === OWN || (this.lock === "input" && this.lastInputEmber) || (this.lock === "attach" && this.attached);
    if (ok) this.fg = hwnd;
    return ok;
  }
  bringToTopAsync(hwnd: number) { this.calls.push(`bringToTopAsync:${hwnd}`); return true; }
  showWindowAsync(hwnd: number, command: number) {
    this.calls.push(`showWindowAsync:${hwnd}:${command}`);
    const w = this.win(hwnd);
    if (w) w.iconic = false;
    return true;
  }
  setFocus(hwnd: number) { this.calls.push(`setFocus:${hwnd}`); }
  inputDesktopName() { return this.desktop; }
  blit(x: number, y: number, width: number, height: number) {
    this.calls.push(`blit:${x},${y},${width},${height}`);
    if (this.blitResult === "fail") return null;
    const buf = Buffer.alloc(width * height * 4 - (this.blitResult === "short" ? 4 : 0));
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width && (row * width + col) * 4 < buf.length; col++) {
        buf.writeUInt8((x + col) & 0xff, (row * width + col) * 4);
        buf.writeUInt8((y + row) & 0xff, (row * width + col) * 4 + 1);
      }
    }
    return buf;
  }
}

const screen: ScreenLike = {
  getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 }),
  getAllDisplays: () => [],
  screenToDipRect: (_w, r) => ({ x: r.x / 1.5, y: r.y / 1.5, width: r.width / 1.5, height: r.height / 1.5 }),
  screenToDipPoint: p => ({ x: p.x / 2, y: p.y / 2 }),
};

/** A typical desktop: the taskbar on top, Ember's overlay, a menu, Notepad and its dialog, Calculator, the desktop. */
function desktop(): FakeDesktop {
  const d = new FakeDesktop().add(
    { hwnd: 0x10, pid: 4, cls: "Shell_TrayWnd", title: "", visible: true, exStyle: WS_EX.TOOLWINDOW, frame: { x: 0, y: 1040, width: 1920, height: 40 } },
    { hwnd: 0x20, pid: OWN, cls: "Chrome_WidgetWin_1", title: "Ember overlay", visible: true, style: WS.POPUP, exStyle: WS_EX.TOOLWINDOW | WS_EX.LAYERED | WS_EX.TRANSPARENT, frame: { x: 0, y: 0, width: 1920, height: 1080 } },
    { hwnd: 0x21, pid: OWN, cls: "Chrome_WidgetWin_1", title: "Ember", visible: true, style: WS.POPUP, exStyle: WS_EX.TOOLWINDOW, frame: { x: 1700, y: 900, width: 120, height: 120 } },
    { hwnd: 0x30, pid: 200, cls: "#32768", title: "", visible: true, style: WS.POPUP, exStyle: WS_EX.TOOLWINDOW, frame: { x: 120, y: 140, width: 200, height: 300 } },
    { hwnd: 0x31, pid: 200, cls: "#32770", title: "Save as", visible: true, style: WS.POPUP | WS.CAPTION, owner: 0x40, frame: { x: 300, y: 200, width: 500, height: 400 } },
    { hwnd: 0x40, pid: 200, cls: "Notepad", title: "Untitled - Notepad", visible: true, frame: { x: 100, y: 100, width: 800, height: 600 }, rect: { x: 93, y: 100, width: 814, height: 607 }, client: { x: 101, y: 160, width: 798, height: 539 }, focus: 0x41 },
    { hwnd: 0x41, pid: 200, cls: "Edit", title: "", visible: true, parent: 0x40, frame: { x: 101, y: 160, width: 798, height: 539 } },
    { hwnd: 0x50, pid: 300, cls: "ApplicationFrameWindow", title: "Calculator", visible: true, frame: { x: -1500, y: 100, width: 400, height: 600 } },
    { hwnd: 0x51, pid: 301, cls: "Windows.UI.Core.CoreWindow", title: "Calculator", visible: true, parent: 0x50, frame: { x: -1500, y: 130, width: 400, height: 570 } },
    { hwnd: 0x60, pid: 300, cls: "ApplicationFrameWindow", title: "Settings", visible: true, cloaked: true, frame: { x: 0, y: 0, width: 900, height: 700 } },
    { hwnd: 0x70, pid: 400, cls: "Chrome_WidgetWin_1", title: "Inbox - Mail", visible: true, iconic: true, frame: { x: -32000, y: -32000, width: 160, height: 28 } },
    { hwnd: 0x80, pid: 500, cls: "GDI+ Hook Window Class", title: "GDI+ Window", visible: false, frame: { x: 0, y: 0, width: 1, height: 1 } },
    { hwnd: 0x90, pid: 600, cls: "NVOverlay", title: "NVIDIA GeForce Overlay", visible: true, exStyle: WS_EX.LAYERED | WS_EX.TOOLWINDOW, alpha: 0, frame: { x: 0, y: 0, width: 1920, height: 1080 } },
    { hwnd: 0xa0, pid: 4, cls: "Progman", title: "Program Manager", visible: true, frame: { x: -1920, y: 0, width: 3840, height: 1080 } },
  );
  d.images.set(4, "C:\\Windows\\explorer.exe").set(OWN, "C:\\Ember\\Ember.exe").set(200, "C:\\Windows\\System32\\notepad.exe")
    .set(300, "C:\\Windows\\System32\\ApplicationFrameHost.exe").set(301, "C:\\Program Files\\WindowsApps\\Calc\\CalculatorApp.exe")
    .set(400, "C:\\Program Files\\Mail\\msedge.exe").set(600, "C:\\Program Files\\NVIDIA\\nvcontainer.exe");
  d.fg = 0x40;
  return d;
}

const opened: { close(): void }[] = [];
const windowsOn = (d: FakeDesktop) => { const ws = openWin32Windows({ screen, api: d })!; opened.push(ws); return ws; };
const inputOn = (d: FakeDesktop, now?: () => number) => { const x = openWin32Input({ api: d, now })!; opened.push(x); return x; };
afterEach(() => { for (const o of opened.splice(0)) o.close(); });

describe("opening the Windows backends", () => {
  it("gives null off Windows, or when the Win32 calls aren't there", () => {
    if (process.platform !== "win32") {
      expect(openWin32Windows({ screen })).toBeNull();
      expect(openWin32Input()).toBeNull();
    }
    expect(openWin32Windows({ screen, api: null })).toBeNull();
    expect(openWin32Input({ api: null })).toBeNull();
  });

  it("refuses input when koffi's INPUT layout isn't the expected one, but still opens the window system", () => {
    const d = desktop();
    d.canSendInput = false;
    expect(openWin32Input({ api: d })).toBeNull();
    expect(windowsOn(d).kind).toBe("win32");
  });
});

describe("the Windows window system", () => {
  it("reports DWM as an always-on compositor", () => {
    const ws = windowsOn(desktop());
    expect(ws.hasCompositor()).toBe(true);
    expect(ws.compositorMayChange).toBe(false);
  });

  it("stacks the windows that cover something, bottom to top, with X11's fields", () => {
    const stack = windowsOn(desktop()).stack();
    // Hidden, minimised, cloaked, click-through and fully transparent windows cover nothing.
    expect(stack.map(w => w.id)).toEqual([0xa0, 0x50, 0x40, 0x31, 0x30, 0x21, 0x10]);
    const notepad = stack.find(w => w.id === 0x40)!;
    expect(notepad).toEqual({
      id: 0x40, client: 0x40, pid: 200, title: "Untitled - Notepad", wmClass: "notepad",
      x: 100, y: 100, width: 800, height: 600,
      outer: { x: 93, y: 100, width: 814, height: 607 }, inner: { x: 101, y: 160, width: 798, height: 539 },
      overrideRedirect: false,
    });
    expect(stack.find(w => w.id === 0x30)?.overrideRedirect).toBe(true); // a menu
    expect(stack.find(w => w.id === 0x31)?.overrideRedirect).toBe(false); // a dialog is a frame of its own
    expect(stack.find(w => w.id === 0x21)).toMatchObject({ pid: OWN, title: "Ember", wmClass: "Ember", overrideRedirect: true });
  });

  it("names a UWP frame after the app it hosts, keeping the frame's own process id", () => {
    const calc = windowsOn(desktop()).stack().find(w => w.id === 0x50)!;
    expect(calc).toMatchObject({ pid: 300, wmClass: "CalculatorApp", x: -1500 });
  });

  it("finds a minimised UWP app's window among the top-level windows by title", () => {
    const d = desktop();
    d.win(0x51)!.parent = undefined; // Windows moves the CoreWindow out of a minimised frame
    d.windows.splice(d.windows.findIndex(w => w.hwnd === 0x51), 1);
    d.add({ hwnd: 0x51, pid: 301, cls: "Windows.UI.Core.CoreWindow", title: "Calculator", visible: false, frame: { x: 0, y: 0, width: 0, height: 0 } });
    expect(windowsOn(d).stack().find(w => w.id === 0x50)?.wmClass).toBe("CalculatorApp");
  });

  it("reads Ember's own titles without sending its own windows a message", () => {
    const d = desktop();
    windowsOn(d).stack();
    expect(d.titleReads.filter(r => r.hwnd === 0x21)).toEqual([{ hwnd: 0x21, own: true }]);
    expect(d.titleReads.filter(r => r.hwnd === 0x40).every(r => !r.own)).toBe(true);
  });

  it("lists the apps' windows as Alt+Tab would, minimised ones included, with the window class", () => {
    const list = windowsOn(desktop()).clientWindows();
    // Not the taskbar, the desktop, Ember's tool windows, the menu, the owned dialog, the cloaked or hidden windows.
    expect(list.map(w => w.id)).toEqual([0x40, 0x50, 0x70]);
    expect(list.find(w => w.id === 0x40)).toEqual({ id: 0x40, pid: 200, title: "Untitled - Notepad", x: 100, y: 100, width: 800, height: 600, wmClass: "notepad", wmClassName: "Notepad" });
    expect(list.find(w => w.id === 0x50)).toMatchObject({ wmClass: "CalculatorApp", wmClassName: "ApplicationFrameWindow" });
    expect(list.find(w => w.id === 0x70)).toMatchObject({ wmClass: "msedge", title: "Inbox - Mail" });
  });

  it("lists an app window whose program the system won't name with an empty name, never another app's", () => {
    const d = desktop();
    d.images.delete(200);
    expect(windowsOn(d).clientWindows().find(w => w.id === 0x40)?.wmClass).toBe("");
  });

  it("reports the foreground window as active and the focused child's top-level as focused", () => {
    const d = desktop();
    const ws = windowsOn(d);
    expect(ws.activeWindow()).toMatchObject({ id: 0x40, pid: 200, title: "Untitled - Notepad", wmClass: "notepad" });
    expect(ws.focusWindow()?.id).toBe(0x40); // GetGUIThreadInfo's hwndFocus (the Edit child) mapped to GA_ROOT
    d.win(0x40)!.focus = 0;
    expect(ws.focusWindow()?.id).toBe(0x40); // no focused child: the active window
    d.fg = 0;
    expect(ws.activeWindow()).toBeNull();
    expect(ws.focusWindow()).toBeNull();
  });

  it("reads the pointer with X's button bits for the logical buttons", () => {
    const d = desktop();
    const ws = windowsOn(d);
    d.cursor = { x: -100, y: 50 };
    d.keys.add(VK.LBUTTON);
    expect(ws.pointer()).toEqual({ x: -100, y: 50, mask: 256 });
    d.swapped = true;
    expect(ws.pointer()).toEqual({ x: -100, y: 50, mask: 1024 });
    d.cursor = null;
    expect(ws.pointer()).toBeNull(); // the secure desktop
  });

  it("reports the Ctrl, Alt and Space chord from either side of each modifier", () => {
    const d = desktop();
    const ws = windowsOn(d);
    expect(ws.keysDown()).toEqual({ control: false, alt: false, space: false });
    d.keys = new Set([VK.RCONTROL, VK.LMENU, VK.SPACE]);
    expect(ws.keysDown()).toEqual({ control: true, alt: true, space: true });
  });

  it("captures a rectangle as BGRA, clipped to the virtual desktop with its negative origin", () => {
    const d = desktop();
    const img = windowsOn(d).capture(-2000, -10, 100, 30)!;
    expect(img).toMatchObject({ x: -1920, y: 0, width: 20, height: 20 });
    expect(img.bgra.length).toBe(20 * 20 * 4);
    expect(img.bgra[0]).toBe(-1920 & 0xff);
    expect(d.calls).toContain("blit:-1920,0,20,20");
  });

  it("captures nothing off screen, on the secure desktop, or when BitBlt fails or comes back short", () => {
    const d = desktop();
    const ws = windowsOn(d);
    expect(ws.capture(5000, 0, 10, 10)).toBeNull();
    d.desktop = "Winlogon";
    expect(ws.capture(0, 0, 10, 10)).toBeNull();
    d.desktop = null;
    expect(ws.capture(0, 0, 10, 10)).toBeNull();
    d.desktop = "Default";
    d.blitResult = "fail";
    expect(ws.capture(0, 0, 10, 10)).toBeNull();
    d.blitResult = "short";
    expect(ws.capture(0, 0, 10, 10)).toBeNull();
    expect(d.calls.filter(c => c.startsWith("blit"))).toHaveLength(2); // no BitBlt off screen or on the secure desktop
  });

  it("gives Ember's own window its HWND as id, and 0 for a destroyed one", () => {
    const ws = windowsOn(desktop());
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(0x2bn);
    expect(ws.windowId({ getNativeWindowHandle: () => handle, getMediaSourceId: () => "window:43:0" })).toBe(0x2b);
    expect(ws.windowId({ getNativeWindowHandle: () => { throw new Error("Object has been destroyed"); }, getMediaSourceId: () => "" })).toBe(0);
  });

  it("converts to DIP through Electron's screen, and reports the virtual desktop as the screen", () => {
    const ws = windowsOn(desktop());
    expect(ws.toDip({ x: 150, y: 300, width: 30, height: 60 })).toEqual({ x: 100, y: 200, width: 20, height: 40 });
    expect(ws.toDipPoint({ x: -100, y: 40 })).toEqual({ x: -50, y: 20 });
    expect(ws.screenBounds()).toEqual({ x: -1920, y: 0, width: 3840, height: 1080 });
  });

  it("is a harmless no-op after close()", () => {
    const d = desktop();
    const ws = openWin32Windows({ screen, api: d })!;
    ws.close();
    ws.close();
    expect(ws.hasCompositor()).toBe(true);
    expect([ws.pointer(), ws.keysDown(), ws.activeWindow(), ws.focusWindow(), ws.capture(0, 0, 10, 10)]).toEqual([null, null, null, null, null]);
    expect(ws.stack()).toEqual([]);
    expect(ws.clientWindows()).toEqual([]);
    ws.activate(0x40);
    expect(d.calls).toEqual([]);
  });
});

describe("activating a window (the documented foreground order)", () => {
  it("does nothing when the window already has the foreground", () => {
    const d = desktop();
    windowsOn(d).activate(0x40);
    expect(d.calls).toEqual([]);
  });

  it("hands the foreground over directly while Ember has it", () => {
    const d = desktop();
    d.fg = 0x21;
    d.lock = "closed";
    windowsOn(d).activate(0x40);
    expect(d.calls).toEqual(["setForeground:64"]);
    expect(d.fg).toBe(0x40);
  });

  it("sends an empty input event first when another app has the foreground, then asks for it", () => {
    const d = desktop();
    d.fg = 0x50;
    d.lock = "input";
    inputOn(d).activate(0x40);
    expect(d.calls).toEqual(["sendInput", "setForeground:64"]);
    expect(d.sent).toEqual([{ kind: "mouse", dx: 0, dy: 0, mouseData: 0, flags: 0, tag: BigInt(EMBER_INPUT_TAG) }]);
    expect(d.fg).toBe(0x40);
  });

  it("joins the foreground thread's input as a last resort, and always detaches", () => {
    const d = desktop();
    d.fg = 0x50;
    d.lock = "attach";
    windowsOn(d).activate(0x40);
    expect(d.calls).toEqual(["sendInput", "setForeground:64", "attach:1->3000:true", "bringToTopAsync:64", "setForeground:64", "attach:1->3000:false"]);
    expect(d.fg).toBe(0x40);
    expect(d.attached).toBe(false);
  });

  it("never attaches to a hung foreground thread, and never taps Alt", () => {
    const d = desktop();
    d.fg = 0x50;
    d.lock = "closed";
    d.win(0x50)!.hung = true;
    windowsOn(d).activate(0x40);
    expect(d.calls).toEqual(["sendInput", "setForeground:64"]);
    expect(d.sent.filter(e => e.kind === "key")).toEqual([]);
    expect(d.fg).toBe(0x50);
  });

  it("restores a minimised window without waiting on its thread", () => {
    const d = desktop();
    windowsOn(d).activate(0x70);
    expect(d.calls[0]).toBe("showWindowAsync:112:9");
    expect(d.fg).toBe(0x70);
  });

  it("ignores windows that no longer exist", () => {
    const d = desktop();
    windowsOn(d).activate(0x999);
    expect(d.calls).toEqual([]);
  });

  it("never waits for another app's thread: only ShowWindowAsync, async SetWindowPos, SetForegroundWindow and a hung-guarded attach", () => {
    // Every Win32 call activate() may make on a foreign window, in every foreground-lock state: reads that never
    // touch the window's thread, and the four actions that don't wait for it (plus the empty input event).
    const reads = new Set(["foregroundWindow", "isWindow", "isIconic", "isHung", "threadProcess", "currentThreadId"]);
    const actions = new Set(["showWindowAsync", "bringToTopAsync", "setForeground", "attachThreadInput", "sendInput"]);
    const cases: { name: string; set(d: FakeDesktop): void; target?: number }[] = [
      { name: "already in front", set: d => { d.fg = 0x40; } },
      { name: "Ember in front", set: d => { d.fg = 0x21; d.lock = "closed"; } },
      { name: "after Ember's input", set: d => { d.fg = 0x50; d.lock = "input"; } },
      { name: "needing the attach", set: d => { d.fg = 0x50; d.lock = "attach"; } },
      { name: "refused", set: d => { d.fg = 0x50; d.lock = "closed"; } },
      { name: "hung foreground", set: d => { d.fg = 0x50; d.lock = "attach"; d.win(0x50)!.hung = true; } },
      { name: "hung target", set: d => { d.fg = 0x50; d.lock = "attach"; d.win(0x40)!.hung = true; } },
      { name: "minimised target", set: d => { d.fg = 0x50; d.lock = "attach"; }, target: 0x70 },
    ];
    for (const c of cases) {
      const d = desktop();
      c.set(d);
      const used: string[] = [];
      const api = new Proxy(d, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            used.push(String(prop));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      const ws = openWin32Windows({ screen, api })!;
      opened.push(ws);
      ws.activate(c.target ?? 0x40);
      for (const name of used) expect(reads.has(name) || actions.has(name), `${c.name}: ${name}`).toBe(true);
      const hung = c.name.startsWith("hung");
      // The attach is the last resort: only when SetForegroundWindow failed and neither thread is hung.
      expect(used.includes("attachThreadInput"), `${c.name}: attach`).toBe(["needing the attach", "refused", "minimised target"].includes(c.name));
      if (hung) expect(d.calls.some(call => call.startsWith("attach")), c.name).toBe(false);
      // Raised only while attached (the foreground lock allows it then), and always detached afterwards.
      const raise = d.calls.indexOf(`bringToTopAsync:${c.target ?? 0x40}`);
      if (raise >= 0) expect(d.calls.slice(0, raise).filter(call => call.startsWith("attach")).pop(), c.name).toMatch(/:true$/);
      expect(d.attached, `${c.name}: detached`).toBe(false);
    }
  });
});

describe("Windows input: the pointer", () => {
  it("moves exactly where asked, also on a monitor left of the primary", () => {
    const d = desktop();
    const x = inputOn(d);
    for (const [px, py] of [[-1920, 0], [-1, 999], [0, 0], [1919, 1079], [-777, 333], [960.4, 540.6]]) {
      x.move(px, py);
      expect(x.pointer()).toEqual({ x: Math.round(px), y: Math.round(py) });
    }
    expect(d.sent.every(e => e.tag === BigInt(EMBER_INPUT_TAG))).toBe(true);
  });

  it("clicks the logical primary button with swapped buttons, and lets go of the button that went down", () => {
    const d = desktop();
    const x = inputOn(d);
    d.swapped = true;
    x.button(1, true);
    expect(d.keys.has(VK.RBUTTON)).toBe(true); // the physical right button is the primary one now
    expect(x.pointerState()?.mask).toBe(256);
    d.swapped = false; // the setting changes while the button is down
    x.button(1, false);
    expect(d.keys.has(VK.RBUTTON)).toBe(false);
    expect(x.pointerState()?.mask).toBe(0);
  });

  it("scrolls one notch per press, never holding a wheel 'button'", () => {
    const d = desktop();
    const x = inputOn(d);
    x.button(5, true);
    x.button(5, false);
    x.button(6, true);
    x.button(6, false);
    expect(d.sent).toEqual([
      expect.objectContaining({ kind: "mouse", flags: MOUSEEVENTF.WHEEL, mouseData: -120 }),
      expect.objectContaining({ kind: "mouse", flags: MOUSEEVENTF.HWHEEL, mouseData: -120 }),
    ]);
    d.sent = [];
    x.releaseAll();
    expect(d.sent).toEqual([]);
  });

  it("knows which points are on a monitor: negative ones are, the dead zone between monitors isn't", () => {
    const x = inputOn(desktop());
    expect(x.onScreen!(-1500, 500)).toBe(true);
    expect(x.onScreen!(-500, 1040)).toBe(false); // below the shorter left monitor, inside the bounding box
    expect(x.onScreen!(5000, 10)).toBe(false);
    expect(x.screenSize()).toEqual({ width: 3840, height: 1080 });
  });
});

describe("Windows input: keys", () => {
  it("presses keysyms as virtual keys with their scan codes, extended where needed", () => {
    const d = desktop();
    const x = inputOn(d);
    expect(x.keysym(x.keysymOf("Delete"), true)).toBe(true);
    expect(x.keysym(x.keysymOf("Delete"), false)).toBe(true);
    expect(d.sent).toEqual([
      { kind: "key", vk: 0x2e, scan: 0x12e, flags: KEYEVENTF.EXTENDEDKEY, tag: BigInt(EMBER_INPUT_TAG) },
      { kind: "key", vk: 0x2e, scan: 0x12e, flags: KEYEVENTF.EXTENDEDKEY | KEYEVENTF.KEYUP, tag: BigInt(EMBER_INPUT_TAG) },
    ]);
    expect(x.keysym(x.keysymOf("F25"), true)).toBe(false);
    expect(x.keysym(0, true)).toBe(false);
  });

  it("looks punctuation up on the foreground app's layout, and says when it needs Shift", () => {
    const d = desktop();
    const x = inputOn(d);
    expect(x.keycodeOf(x.keysymOf("question"))).toBe(0xbf);
    expect(x.needsShift(x.keysymOf("question"))).toBe(true);
    expect(x.needsShift(x.keysymOf("slash"))).toBe(false);
    expect(x.needsShift(x.keysymOf("A"))).toBe(true);
    expect(x.keycodeOf(x.keysymOf("at"))).toBe(0); // not on this layout
    expect(d.calls).toContain("vkKeyScan:hkl:2000"); // Notepad's thread's layout
    expect(d.calls).toContain("deadKey:hkl:2000");
  });

  it("never presses a dead key for a character: it would type nothing, then change the next one", () => {
    const d = desktop();
    d.dead.add(`${0xbf}+shift`); // "?" is a dead key here; "/" on the same key isn't
    const x = inputOn(d);
    expect(x.keycodeOf(x.keysymOf("question"))).toBe(0);
    expect(x.keysym(x.keysymOf("question"), true)).toBe(false);
    expect(x.keycodeOf(x.keysymOf("slash"))).toBe(0xbf);
    expect(d.sent).toEqual([]);
  });

  it("hands out key codes that are never 0 and match what keysDown reports", () => {
    const d = desktop();
    const x = inputOn(d);
    const codes = ["Return", "KP_Enter", "space", "Shift_L", "Control_L", "a"].map(n => x.keycodeOf(x.keysymOf(n)));
    expect(codes).toEqual([0x0d, 0x0d, 0x20, VK.LSHIFT, VK.LCONTROL, 0x41]);
    x.keysym(x.keysymOf("Shift_L"), true);
    x.keysym(x.keysymOf("a"), true);
    expect(x.keysDown()).toEqual([0x41, VK.LSHIFT]); // Ember's own keys show (the borrow filters them), not VK_SHIFT
    x.releaseAll();
    expect(x.keysDown()).toEqual([]);
  });

  it("lets a numpad Enter go as the extended key it went down as", () => {
    const d = desktop();
    const x = inputOn(d);
    x.keysym(x.keysymOf("KP_Enter"), true);
    x.keycode(0x0d, false);
    expect(d.sent.map(e => e.kind === "key" && e.flags)).toEqual([KEYEVENTF.EXTENDEDKEY, KEYEVENTF.EXTENDEDKEY | KEYEVENTF.KEYUP]);
  });

  it("ignores key codes keycodeOf never hands out", () => {
    const d = desktop();
    const x = inputOn(d);
    for (const code of [0, VK.LBUTTON, VK.SHIFT, VK.PACKET, 0x1ff]) x.keycode(code, true);
    expect(d.sent).toEqual([]);
  });

  it("doesn't report the fake left Ctrl of AltGr while Ember holds right Alt, nor just after", () => {
    const d = desktop();
    let t = 1000;
    const x = inputOn(d, () => t);
    x.keysym(x.keysymOf("Alt_R"), true);
    expect(d.keys.has(VK.LCONTROL)).toBe(true); // Windows' synthetic Ctrl
    expect(x.keysDown()).toEqual([VK.RMENU]);
    x.keysym(x.keysymOf("Alt_R"), false);
    d.keys.add(VK.LCONTROL); // its "up" trails the key's
    expect(x.keysDown()).toEqual([]);
    t += FAKE_CONTROL_GRACE_MS;
    expect(x.keysDown()).toEqual([VK.LCONTROL]); // later, a left Ctrl is the user's
  });

  it("types any character as KEYEVENTF_UNICODE, astral ones as two units, and Enter as the key", () => {
    const d = desktop();
    const x = inputOn(d);
    expect(x.textKey!("é", true)).toBe(true);
    expect(x.textKey!("é", false)).toBe(true);
    expect(x.textKey!("😀", true)).toBe(true);
    expect(x.textKey!("😀", false)).toBe(true);
    expect(x.textKey!("\n", true)).toBe(true);
    expect(x.textKey!("\n", false)).toBe(true);
    const keys = d.sent.map(e => e.kind === "key" ? [e.vk, e.scan, e.flags] : null);
    const U = KEYEVENTF.UNICODE, UP = KEYEVENTF.KEYUP;
    expect(keys).toEqual([
      [0, 0xe9, U], [0, 0xe9, U | UP],
      [0, 0xd83d, U], [0, 0xde00, U], [0, 0xd83d, U | UP], [0, 0xde00, U | UP],
      [0x0d, 0x10d, 0], [0x0d, 0x10d, UP],
    ]);
    expect(x.keysDown()).toEqual([]); // VK_PACKET is never someone's key
  });

  it("refuses text it can't type exactly, sending nothing", () => {
    const d = desktop();
    const x = inputOn(d);
    for (const ch of ["", "ab", "\u0007", "\ud83d"]) expect(x.textKey!(ch, true)).toBe(false);
    expect(d.sent).toEqual([]);
  });
});

describe("Windows input: letting go", () => {
  it("lets go of every key, character and button Ember holds, once", () => {
    const d = desktop();
    const x = inputOn(d);
    x.keysym(x.keysymOf("Control_L"), true);
    x.keysym(x.keysymOf("Alt_R"), true);
    x.textKey!("ß", true);
    x.button(1, true);
    x.button(3, true);
    d.sent = [];
    x.releaseAll();
    expect(d.keys.size).toBe(0);
    expect(d.sent).toHaveLength(5);
    expect(d.sent.every(e => e.kind === "mouse" ? !!(e.flags & (MOUSEEVENTF.LEFTUP | MOUSEEVENTF.RIGHTUP)) : !!(e.flags & KEYEVENTF.KEYUP))).toBe(true);
    d.sent = [];
    x.releaseAll();
    expect(d.sent).toEqual([]);
  });

  it("lets go when the process exits, and stops listening after close()", () => {
    const d = desktop();
    const before = process.listeners("exit");
    const x = openWin32Input({ api: d })!;
    const added = process.listeners("exit").filter(l => !before.includes(l));
    expect(added).toHaveLength(1);
    x.keysym(x.keysymOf("Shift_L"), true);
    // Only the backend's own listener: emitting "exit" would also run the test runner's.
    added[0].call(process, 0);
    expect(d.keys.size).toBe(0);
    x.close();
    expect(process.listeners("exit")).not.toContain(added[0]);
  });

  it("lets go on close() and is a harmless no-op afterwards", () => {
    const d = desktop();
    const x = openWin32Input({ api: d })!;
    x.keysym(x.keysymOf("a"), true);
    x.close();
    expect(d.keys.size).toBe(0);
    d.sent = [];
    d.calls = [];
    x.close();
    x.move(1, 1);
    x.button(1, true);
    x.keycode(0x41, true);
    expect(x.keysym(0x61, true)).toBe(false);
    expect(x.textKey!("a", true)).toBe(false);
    expect([x.pointer(), x.pointerState(), x.keysDown(), x.keycodeOf(0x61), x.activeWindow(), x.focusedWindow(), x.findWindow("Untitled - Notepad")])
      .toEqual([null, null, [], 0, 0, 0, 0]);
    expect(x.screenSize()).toEqual({ width: 0, height: 0 });
    expect(x.keyboardGrabbed!()).toBe(false);
    expect(x.screenLocked!()).toBe(false);
    expect(x.blockedReason!(0x40)).toBe(UNCHECKED_REASON);
    x.activate(0x50);
    expect(d.sent).toEqual([]);
    expect(d.calls).toEqual([]);
  });
});

describe("Windows input: windows", () => {
  it("reports the foreground window as active and the focused child's top-level as focused", () => {
    const d = desktop();
    const x = inputOn(d);
    expect(x.activeWindow()).toBe(0x40);
    expect(x.focusedWindow()).toBe(0x40);
    d.fg = 0x31;
    expect(x.focusedWindow()).toBe(0x31); // a dialog is its own top-level, as on X11
  });

  it("finds windows by title like XInput does, dialogs and minimised windows included", () => {
    const x = inputOn(desktop());
    expect(x.findWindow("Untitled - Notepad", 200)).toBe(0x40);
    expect(x.findWindow("Save as", 200)).toBe(0x31);
    expect(x.findWindow("notepad", 200)).toBe(0x40); // no exact title: the one window whose title contains it
    expect(x.findWindow("a", 200)).toBe(0); // "Save as" and "Untitled - Notepad" both contain it
    expect(x.findWindow("Inbox - Mail")).toBe(0x70);
    expect(x.findWindow("Calculator", 301)).toBe(0x50); // the hosted app's pid has no top-level: exact title
    expect(x.findWindow("Calculator", undefined, "CalculatorApp")).toBe(0x50);
    expect(x.findWindow("Calculator", undefined, "notepad")).toBe(0);
    expect(x.findWindow("Settings")).toBe(0); // cloaked: on another desktop or suspended
    expect(x.findWindow("Program Manager")).toBe(0);
  });

  it("gives one of Ember's own windows the keyboard, and only Ember's", () => {
    const d = desktop();
    const x = inputOn(d);
    x.focusInput!(0x40);
    expect(d.calls).toEqual([]);
    x.focusInput!(0x21);
    expect(d.calls).toEqual(["sendInput", "setForeground:33", "setFocus:33"]);
    d.calls = [];
    x.focusInput!(0x21); // already in front: only the keyboard focus
    expect(d.calls).toEqual(["setFocus:33"]);
  });

  it("refuses windows of elevated programs, and windows it can't check", () => {
    const d = desktop();
    const x = inputOn(d);
    expect(x.blockedReason!(0x40)).toBeNull();
    expect(x.blockedReason!(0x21)).toBeNull(); // Ember's own
    d.tokens.set(200, { elevated: true, integrity: 0x3000 });
    expect(x.blockedReason!(0x40)).toBe(ELEVATED_REASON);
    d.tokens.set(200, null);
    expect(x.blockedReason!(0x40)).toBe(UNCHECKED_REASON);
    expect(x.blockedReason!(0x999)).toBe(UNCHECKED_REASON);
    expect(x.blockedReason!(0)).toBe(UNCHECKED_REASON);
  });

  it("lets an elevated Ember use elevated windows", () => {
    const d = desktop();
    d.own = { elevated: true, integrity: 0x3000 };
    d.tokens.set(200, { elevated: true, integrity: 0x3000 });
    expect(inputOn(d).blockedReason!(0x40)).toBeNull();
  });

  it("treats the secure desktop as a grabbed keyboard and a locked screen", () => {
    const d = desktop();
    const x = inputOn(d);
    expect(x.keyboardGrabbed!()).toBe(false);
    expect(x.screenLocked!()).toBe(false);
    d.desktop = "Winlogon";
    expect(x.keyboardGrabbed!()).toBe(true);
    expect(x.screenLocked!()).toBe(true);
    d.desktop = null;
    expect(x.screenLocked!()).toBe(true);
  });

  it("knows whether a click at the pointer lands in the window, its menu, or a dialog over it", () => {
    const d = desktop();
    const x = inputOn(d);
    d.cursor = { x: 850, y: 650 }; // Notepad's Edit child, below the dialog
    expect(x.pointerOn!(0x40)).toBe(true);
    d.cursor = { x: 400, y: 300 }; // the Save as dialog over Notepad
    expect(x.pointerOn!(0x40)).toBe(false);
    expect(x.pointerOn!(0x40, 0x31)).toBe(true); // unless the element is in the dialog
    d.cursor = { x: 150, y: 150 }; // Notepad's open menu
    expect(x.pointerOn!(0x40)).toBe(true);
    d.cursor = { x: 1750, y: 950 }; // Ember's handle
    expect(x.pointerOn!(0x40)).toBe(false);
    d.cursor = { x: 1000, y: 500 }; // the desktop (Progman): click-through and transparent overlays don't count
    expect(x.pointerOn!(0x40)).toBe(false);
    d.cursor = null;
    expect(x.pointerOn!(0x40)).toBe(false);
  });
});
