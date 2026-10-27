/**
 * Which Windows top-level windows count for what (pure): the apps' windows as Alt+Tab shows them, the windows
 * findWindow may pick, the windows that cover the screen (not click-through overlays), the popups that belong to
 * another window, a z-order walk that survives windows moving under it, findWindow's "exact title, or nothing"
 * rules, and where a click at the pointer would land.
 */

import { describe, expect, it } from "vitest";
import {
  coversScreen, isAppWindow, isFindable, isPopup, pickWindow, pointerLandsOn, walkZOrder, WS, WS_EX, type FindCandidate,
  type WindowFacts,
} from "../../app/main/platform/win32/rules";

const OVERLAPPED = 0x14cf0000; // WS_OVERLAPPEDWINDOW | WS_VISIBLE | WS_CLIPSIBLINGS…
const window = (o: Partial<WindowFacts> = {}): WindowFacts => ({
  visible: true, iconic: false, cloaked: false, style: OVERLAPPED, exStyle: 0, className: "Notepad", title: "Untitled - Notepad",
  owner: 0, ownerVisible: false, width: 800, height: 600, ...o,
});

describe("the apps' windows (clientWindows)", () => {
  it("lists a normal, titled, visible window, and a minimised one", () => {
    expect(isAppWindow(window())).toBe(true);
    expect(isAppWindow(window({ iconic: true, width: 160, height: 28 }))).toBe(true);
    expect(isAppWindow(window({ iconic: true, width: 0, height: 0 }))).toBe(true);
  });

  it("leaves out hidden, cloaked (other virtual desktop, suspended UWP), untitled and zero-size windows", () => {
    expect(isAppWindow(window({ visible: false }))).toBe(false);
    expect(isAppWindow(window({ cloaked: true }))).toBe(false);
    expect(isAppWindow(window({ title: "" }))).toBe(false);
    expect(isAppWindow(window({ width: 0 }))).toBe(false);
  });

  it("leaves out the desktop and the taskbars", () => {
    for (const className of ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"]) {
      expect(isAppWindow(window({ className, title: "Program Manager" }))).toBe(false);
    }
  });

  it("leaves out tool windows and windows that can't be activated, unless they ask for a taskbar button", () => {
    expect(isAppWindow(window({ exStyle: WS_EX.TOOLWINDOW }))).toBe(false);
    expect(isAppWindow(window({ exStyle: WS_EX.NOACTIVATE }))).toBe(false);
    expect(isAppWindow(window({ exStyle: WS_EX.TOOLWINDOW | WS_EX.APPWINDOW }))).toBe(true);
  });

  it("leaves out a dialog owned by a visible window, but not one whose owner is hidden", () => {
    expect(isAppWindow(window({ owner: 0x20, ownerVisible: true, title: "Save as" }))).toBe(false);
    expect(isAppWindow(window({ owner: 0x20, ownerVisible: false }))).toBe(true);
    expect(isAppWindow(window({ owner: 0x20, ownerVisible: true, exStyle: WS_EX.APPWINDOW }))).toBe(true);
  });
});

describe("the windows findWindow may pick", () => {
  it("includes dialogs and tool windows the user can see or restore", () => {
    expect(isFindable(window({ owner: 0x20, ownerVisible: true, title: "Save as" }))).toBe(true);
    expect(isFindable(window({ exStyle: WS_EX.TOOLWINDOW, title: "Find" }))).toBe(true);
    expect(isFindable(window({ iconic: true, width: 0, height: 0 }))).toBe(true);
  });

  it("excludes what nobody can type into: hidden, cloaked, untitled, shell and zero-size windows", () => {
    expect(isFindable(window({ visible: false }))).toBe(false);
    expect(isFindable(window({ cloaked: true }))).toBe(false);
    expect(isFindable(window({ title: "" }))).toBe(false);
    expect(isFindable(window({ className: "Shell_TrayWnd" }))).toBe(false);
    expect(isFindable(window({ height: 0 }))).toBe(false);
  });
});

describe("the windows that cover the screen (stack)", () => {
  const noAlpha = () => null;

  it("counts visible windows bigger than a pixel, popups and topmost windows too", () => {
    expect(coversScreen(window(), noAlpha)).toBe(true);
    expect(coversScreen(window({ className: "#32768", title: "", style: WS.POPUP }), noAlpha)).toBe(true);
  });

  it("leaves out minimised, cloaked, hidden and tiny windows", () => {
    expect(coversScreen(window({ iconic: true }), noAlpha)).toBe(false);
    expect(coversScreen(window({ cloaked: true }), noAlpha)).toBe(false);
    expect(coversScreen(window({ visible: false }), noAlpha)).toBe(false);
    expect(coversScreen(window({ width: 1 }), noAlpha)).toBe(false);
  });

  it("leaves out click-through layered overlays and fully transparent ones, which would make every window look covered", () => {
    expect(coversScreen(window({ exStyle: WS_EX.LAYERED | WS_EX.TRANSPARENT }), noAlpha)).toBe(false);
    expect(coversScreen(window({ exStyle: WS_EX.LAYERED }), () => 0)).toBe(false);
    expect(coversScreen(window({ exStyle: WS_EX.LAYERED }), () => 200)).toBe(true);
    expect(coversScreen(window({ exStyle: WS_EX.LAYERED }), noAlpha)).toBe(true); // per-pixel alpha: it may paint
    expect(coversScreen(window({ exStyle: WS_EX.TRANSPARENT }), noAlpha)).toBe(true); // not layered: it takes clicks
  });
});

describe("popups (overrideRedirect)", () => {
  it("marks menus, tooltips and menu shadows", () => {
    for (const className of ["#32768", "tooltips_class32", "SysShadow"]) expect(isPopup({ className, style: 0, exStyle: 0, owner: 0 })).toBe(true);
  });

  it("marks a captionless WS_POPUP that is owned, a tool window or not activatable (Chromium's dropdowns)", () => {
    const style = WS.POPUP;
    expect(isPopup({ className: "Chrome_WidgetWin_1", style, exStyle: 0, owner: 0x30 })).toBe(true);
    expect(isPopup({ className: "Chrome_WidgetWin_1", style, exStyle: WS_EX.TOOLWINDOW, owner: 0 })).toBe(true);
    expect(isPopup({ className: "ComboLBox", style, exStyle: WS_EX.NOACTIVATE, owner: 0 })).toBe(true);
  });

  it("doesn't mark an app's captionless main window, a window with a caption, or one with a taskbar button", () => {
    expect(isPopup({ className: "Chrome_WidgetWin_1", style: WS.POPUP, exStyle: 0, owner: 0 })).toBe(false);
    expect(isPopup({ className: "#32770", style: WS.POPUP | WS.CAPTION, exStyle: 0, owner: 0x30 })).toBe(false); // a dialog
    expect(isPopup({ className: "X", style: WS.POPUP, exStyle: WS_EX.TOOLWINDOW | WS_EX.APPWINDOW, owner: 0 })).toBe(false);
    expect(isPopup({ className: "Notepad", style: OVERLAPPED, exStyle: 0, owner: 0 })).toBe(false);
  });
});

describe("walking the z-order", () => {
  it("lists windows top to bottom until there are no more", () => {
    const next = new Map([[3, 2], [2, 1], [1, 0]]);
    expect(walkZOrder(3, h => next.get(h) ?? 0)).toEqual([3, 2, 1]);
    expect(walkZOrder(0, () => 1)).toEqual([]);
  });

  it("stops when a window raised during the walk would make it loop, and at the limit", () => {
    const next = new Map([[3, 2], [2, 1], [1, 3]]);
    expect(walkZOrder(3, h => next.get(h) ?? 0)).toEqual([3, 2, 1]);
    expect(walkZOrder(1, h => h + 1, 5)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("findWindow's choice", () => {
  const all: FindCandidate[] = [
    { id: 1, title: "Report.docx - Word", pid: 10, names: ["WINWORD", "OpusApp"] },
    { id: 2, title: "Budget.docx - Word", pid: 10, names: ["WINWORD", "OpusApp"] },
    { id: 3, title: "Untitled - Notepad", pid: 20, names: ["notepad", "Notepad"] },
    { id: 4, title: "Untitled - Notepad", pid: 21, names: ["notepad", "Notepad"] },
    { id: 5, title: "Calculator", pid: 30, names: ["CalculatorApp", "ApplicationFrameWindow"] },
  ];

  it("takes the process's window with the exact title, else the one whose title contains it", () => {
    expect(pickWindow(all, "Budget.docx - Word", 10)).toBe(2);
    expect(pickWindow(all, "report.docx", 10)).toBe(1);
    expect(pickWindow(all, "Untitled - Notepad", 21)).toBe(4);
  });

  it("returns 0 when several of the process's windows match", () => {
    expect(pickWindow(all, "word", 10)).toBe(0);
  });

  it("without the process's windows, takes only an exact title, of the named app when given", () => {
    expect(pickWindow(all, "Calculator", 999)).toBe(5); // a UWP frame belongs to ApplicationFrameHost, not the app
    expect(pickWindow(all, "Calculator")).toBe(5);
    expect(pickWindow(all, "Calc")).toBe(0);
    expect(pickWindow(all, "Calculator", undefined, "calculatorapp.exe")).toBe(5);
    expect(pickWindow(all, "Calculator", undefined, "ApplicationFrameWindow")).toBe(5);
    expect(pickWindow(all, "Calculator", undefined, "notepad")).toBe(0);
    expect(pickWindow(all, "Untitled - Notepad")).toBe(0); // two Notepads: input to a guess could go anywhere
    expect(pickWindow(all, "")).toBe(0);
  });
});

describe("where a click at the pointer lands", () => {
  const at = (o: Partial<Parameters<typeof pointerLandsOn>[0]> = {}) => ({ top: 7, className: "Notepad", pid: 20, popup: false, owners: [], ...o });

  it("lands on the window itself, or on the window the element is in", () => {
    expect(pointerLandsOn(at({ top: 3 }), [3], 20)).toBe(true);
    expect(pointerLandsOn(at({ top: 9 }), [3, 9], 20)).toBe(true);
  });

  it("lands on the app's own open menu or a popup it owns, not on another app's", () => {
    expect(pointerLandsOn(at({ className: "#32768", pid: 20 }), [3], 20)).toBe(true);
    expect(pointerLandsOn(at({ className: "#32768", pid: 99 }), [3], 20)).toBe(false);
    expect(pointerLandsOn(at({ popup: true, pid: 99, owners: [3] }), [3], 20)).toBe(true);
    expect(pointerLandsOn(at({ popup: true, pid: 20, owners: [] }), [3], 20)).toBe(true);
    expect(pointerLandsOn(at({ popup: true, pid: 99, owners: [44] }), [3], 20)).toBe(false);
  });

  it("doesn't land on a tooltip, another window of the app (a dialog), or nothing", () => {
    expect(pointerLandsOn(at({ className: "tooltips_class32", popup: true, pid: 20 }), [3], 20)).toBe(false);
    expect(pointerLandsOn(at({ popup: false, pid: 20, owners: [3] }), [3], 20)).toBe(false);
    expect(pointerLandsOn(at({ top: 0 }), [3], 20)).toBe(false);
    expect(pointerLandsOn(at({ className: "#32768", pid: null }), [3], null)).toBe(false);
  });
});
