/**
 * Matching WSLg's RAIL windows to a distro's AT-SPI frames and mapping coordinates (design §4.9, critique wsl-10,
 * wsl-11): GTK3 and GTK4 client-side decorations, Weston's frames around X11 apps, scales of 100/125/150/200 % and
 * .wslgconfig's 1.25, monitors left of and above the primary one, "[WARN:COPY MODE]" titles, titles RDP cut short,
 * popups, and every ambiguity failing closed (title only, or not at all). Pure: no window system, no sidecar.
 */

import { describe, expect, it } from "vitest";
import {
  contentBox, distroOfTitles, fitTransform, mapBounds, matchWindows, normaliseTitle, popupOwners, railTitle, unmapPoint,
  type LinuxFrame, type RailWindow,
} from "../../app/main/wsl/match";

const rail = (hwnd: number, title: string, inner: { x: number; y: number; width: number; height: number }, more: Partial<RailWindow> = {}): RailWindow => ({
  hwnd, pid: 4242, title, inner, frame: { ...inner }, popup: false, owner: 0, ...more,
});

const frame = (name: string, bounds: LinuxFrame["bounds"], children: LinuxFrame["children"], more: Partial<LinuxFrame> = {}): LinuxFrame => ({
  pid: 700, path: `/org/a11y/atspi/accessible/${name.length}`, app: "gedit", name, role: "frame", active: false, bounds, children, ...more,
});

describe("titles", () => {
  it("normalises both sides: NFC, whitespace collapsed", () => {
    expect(normaliseTitle("  Café   menu \t")).toBe("Café menu");
  });

  it("drops WSLg's [WARN:…] bracket and one trailing (<distro>) from a RAIL title", () => {
    expect(railTitle("[WARN:COPY MODE] notes.txt - gedit", ["Ubuntu"])).toBe("notes.txt - gedit");
    expect(railTitle("notes.txt - gedit (Ubuntu)", ["Ubuntu"])).toBe("notes.txt - gedit");
    expect(railTitle("[WARN:COPY MODE]   notes.txt (Ubuntu-22.04)", ["Ubuntu", "Ubuntu-22.04"])).toBe("notes.txt");
    // Only the distro's own name, and only once; another bracket stays.
    expect(railTitle("Report (draft)", ["Ubuntu"])).toBe("Report (draft)");
    expect(railTitle("x (Ubuntu) (Ubuntu)", ["Ubuntu"])).toBe("x (Ubuntu)");
    expect(railTitle("[Draft] notes", ["Ubuntu"])).toBe("[Draft] notes");
  });
});

describe("the content box", () => {
  it("is the union of the frame's direct children, without GTK's shadows", () => {
    expect(contentBox({ x: 0, y: 0, width: 852, height: 646 }, [{ x: 26, y: 23, width: 800, height: 40 }, { x: 26, y: 63, width: 800, height: 560 }]))
      .toEqual({ x: 26, y: 23, width: 800, height: 600 });
  });

  it("leaves out what no toolkit means (GTK's INT_MIN, empty, NaN), and falls back to the frame", () => {
    expect(contentBox({ x: 5, y: 6, width: 100, height: 50 }, [{ x: -2147483648, y: -2147483648, width: 0, height: 0 }, { x: Number.NaN, y: 0, width: 1, height: 1 }]))
      .toEqual({ x: 5, y: 6, width: 100, height: 50 });
    expect(contentBox(null, [])).toBeNull();
  });
});

describe("the transform (k, insets, self-check)", () => {
  it("maps a GTK3 client-side-decorated window at 100 % (toplevel at 0,0 with its shadow margins)", () => {
    const kids = [{ x: 26, y: 23, width: 800, height: 600 }];
    const t = fitTransform({ x: 100, y: 200, width: 800, height: 600 }, contentBox({ x: 0, y: 0, width: 852, height: 646 }, kids)!, kids)!;
    expect(t).toEqual({ k: 1, dx: 74, dy: 177 });
    expect(mapBounds(t, { x: 36, y: 73, width: 80, height: 30 })).toEqual({ x: 110, y: 250, width: 80, height: 30 });
    expect(unmapPoint(t, { x: 110, y: 250 })).toEqual({ x: 36, y: 73 });
  });

  it("maps a GTK4 window at 150 % on a monitor left of the primary (visible size, children carrying the shadow offset)", () => {
    const kids = [{ x: 12, y: 12, width: 800, height: 46 }, { x: 12, y: 58, width: 800, height: 554 }];
    const inner = { x: -1620, y: -300, width: 1200, height: 900 };
    const t = fitTransform(inner, contentBox({ x: 0, y: 0, width: 800, height: 600 }, kids)!, kids)!;
    expect(t.k).toBe(1.5);
    expect(mapBounds(t, kids[0])).toEqual({ x: -1620, y: -300, width: 1200, height: 69 });
    const back = unmapPoint(t, { x: -1620 + 150, y: -300 + 90 });
    expect(back).toEqual({ x: 112, y: 72 });
  });

  it("maps an X11 app inside Weston's frame (title bar on top, borders at the sides and bottom)", () => {
    const kids = [{ x: 300, y: 200, width: 640, height: 25 }, { x: 300, y: 225, width: 640, height: 455 }];
    const t = fitTransform({ x: 500, y: 300, width: 648, height: 516 }, contentBox({ x: 300, y: 200, width: 640, height: 480 }, kids)!, kids)!;
    expect(t).toEqual({ k: 1, dx: 204, dy: 132 });
    expect(mapBounds(t, kids[0])).toEqual({ x: 504, y: 332, width: 640, height: 25 });
  });

  it.each([
    [1, 800, 600], [1.25, 1000, 750], [1.5, 1200, 900], [2, 1600, 1200], [1.375, 1100, 825],
  ])("finds k = %s (scales from Windows and .wslgconfig, snapped to 1/8)", (k, w, h) => {
    const kids = [{ x: 0, y: 0, width: 800, height: 600 }];
    const t = fitTransform({ x: 10, y: 20, width: w, height: h }, kids[0], kids)!;
    expect(t.k).toBe(k);
    const x = Math.round(10 + 400 * k), y = Math.round(20 + 300 * k);
    expect(mapBounds(t, { x: 400, y: 300, width: 8, height: 8 })).toEqual({ x, y, width: Math.round(10 + 408 * k) - x, height: Math.round(20 + 308 * k) - y });
  });

  it("rounds a pixel or two of the client area away (integer HiDPI rounding)", () => {
    const kids = [{ x: 0, y: 0, width: 801, height: 599 }];
    expect(fitTransform({ x: 0, y: 0, width: 1002, height: 750 }, kids[0], kids)?.k).toBe(1.25);
  });

  it("refuses a scale outside [0.5, 4], axes that disagree, and boxes too far inside their window", () => {
    const box = { x: 0, y: 0, width: 800, height: 600 };
    expect(fitTransform({ x: 0, y: 0, width: 300, height: 225 }, box)).toBeNull(); // k 0.375
    expect(fitTransform({ x: 0, y: 0, width: 3600, height: 2700 }, box)).toBeNull(); // k 4.5
    expect(fitTransform({ x: 0, y: 0, width: 800, height: 900 }, box)).toBeNull(); // 300 px more height than any title bar
    expect(fitTransform({ x: 0, y: 0, width: 800, height: 590 }, box)).toBeNull(); // shorter than the content
    expect(fitTransform({ x: 0, y: 0, width: 860, height: 600 }, box)).toBeNull(); // 30 px side borders
  });

  it("refuses when two scales both fit (a tiny window: clicks could land in two places)", () => {
    const box = { x: 0, y: 0, width: 150, height: 100 };
    expect(fitTransform({ x: 0, y: 0, width: 225, height: 150 }, box)).toBeNull();
  });

  it("refuses when the self-check fails: a child outside the client area, or a box its topmost child doesn't start", () => {
    const box = { x: 0, y: 0, width: 800, height: 600 };
    expect(fitTransform({ x: 0, y: 0, width: 800, height: 600 }, box, [box, { x: 900, y: 10, width: 20, height: 20 }])).toBeNull();
    expect(fitTransform({ x: 0, y: 0, width: 800, height: 600 }, box, [{ x: 0, y: 300, width: 800, height: 300 }])).toBeNull();
    expect(fitTransform({ x: 0, y: 0, width: 800, height: 600 }, box, [{ x: 0, y: 0, width: 800, height: 300 }, { x: 0, y: 300, width: 800, height: 300 }])).not.toBeNull();
  });
});

describe("matching RAIL windows to frames", () => {
  const kids = [{ x: 26, y: 23, width: 800, height: 600 }];
  const gedit = frame("notes.txt - gedit", { x: 0, y: 0, width: 852, height: 646 }, kids);
  const opts = { distro: "Ubuntu", foreground: 0 };

  it("matches by normalised title and shape, with the transform", () => {
    const m = matchWindows([rail(1, "[WARN:COPY MODE] notes.txt - gedit (Ubuntu)", { x: 100, y: 200, width: 800, height: 600 })], [gedit], opts);
    expect(m.get(1)).toEqual({ hwnd: 1, frame: gedit, transform: { k: 1, dx: 74, dy: 177 } });
  });

  it("matches a long title RDP cut short when it starts exactly one frame's name", () => {
    const long = `${"A very long document title ".repeat(5)}end - gedit`;
    const cut = long.slice(0, 120);
    const f = frame(long, { x: 0, y: 0, width: 852, height: 646 }, kids);
    expect(matchWindows([rail(1, cut, { x: 0, y: 0, width: 800, height: 600 })], [f], opts).get(1)?.transform).not.toBeNull();
    // A short title is never matched as a prefix, and a long one that starts two frames' names matches neither.
    expect(matchWindows([rail(1, "notes", { x: 0, y: 0, width: 800, height: 600 })], [gedit], opts).size).toBe(0);
    const twin = frame(`${long} copy`, { x: 0, y: 0, width: 852, height: 646 }, kids);
    expect(matchWindows([rail(1, cut, { x: 0, y: 0, width: 800, height: 600 })], [f, twin], opts).size).toBe(0);
  });

  it("identifies by title only (no transform) when the title is unique on both sides but the shape doesn't fit", () => {
    const m = matchWindows([rail(1, "notes.txt - gedit", { x: 0, y: 0, width: 500, height: 900 })], [gedit], opts);
    expect(m.get(1)).toEqual({ hwnd: 1, frame: gedit, transform: null });
  });

  it("leaves windows unidentified when two frames fit one window, or one frame fits two windows", () => {
    const twin = { ...gedit, path: "/org/a11y/atspi/accessible/99", pid: 701 };
    expect(matchWindows([rail(1, "notes.txt - gedit", { x: 0, y: 0, width: 800, height: 600 })], [gedit, twin], opts).size).toBe(0);
    const two = [rail(1, "notes.txt - gedit", { x: 0, y: 0, width: 800, height: 600 }), rail(2, "notes.txt - gedit", { x: 900, y: 0, width: 800, height: 600 })];
    expect(matchWindows(two, [gedit], opts).size).toBe(0);
  });

  it("tells same-titled windows apart by shape when each fits exactly one frame, and not when a scale could swap them", () => {
    const small = { ...gedit, path: "/org/a11y/atspi/accessible/5", children: [{ x: 26, y: 23, width: 500, height: 300 }] };
    const m = matchWindows([rail(1, "notes.txt - gedit", { x: 0, y: 0, width: 800, height: 600 }), rail(2, "notes.txt - gedit", { x: 0, y: 0, width: 500, height: 300 })], [gedit, small], opts);
    expect(m.get(1)?.frame).toBe(gedit);
    expect(m.get(2)?.frame).toBe(small);
    // Half the size each way: at 200 % the small one would fill the big window, so neither is placed.
    const half = { ...gedit, path: "/org/a11y/atspi/accessible/6", children: [{ x: 26, y: 23, width: 400, height: 300 }] };
    expect(matchWindows([rail(1, "notes.txt - gedit", { x: 0, y: 0, width: 800, height: 600 }), rail(2, "notes.txt - gedit", { x: 0, y: 0, width: 400, height: 300 })], [gedit, half], opts).size).toBe(0);
  });

  it("gives a window without a title the active frame only when it is the foreground window", () => {
    const active = { ...gedit, name: "", active: true };
    expect(matchWindows([rail(7, "", { x: 100, y: 200, width: 800, height: 600 })], [active], { distro: "Ubuntu", foreground: 7 }).get(7)?.transform).not.toBeNull();
    expect(matchWindows([rail(7, "", { x: 100, y: 200, width: 800, height: 600 })], [active], { distro: "Ubuntu", foreground: 8 }).size).toBe(0);
  });

  it("never places a busy app's frame (its bounds are as last seen), but may identify it by title", () => {
    const busy = { ...gedit, busy: true };
    expect(matchWindows([rail(1, "notes.txt - gedit", { x: 100, y: 200, width: 800, height: 600 })], [busy], opts).get(1)?.transform).toBeNull();
  });

  it("never matches a popup on its own", () => {
    expect(matchWindows([rail(1, "notes.txt - gedit", { x: 100, y: 200, width: 800, height: 600 }, { popup: true })], [gedit], opts).size).toBe(0);
  });
});

describe("popups (critique wsl-11)", () => {
  const main = rail(1, "notes.txt - gedit", { x: 100, y: 100, width: 800, height: 600 });
  const other = rail(2, "Terminal", { x: 1000, y: 100, width: 600, height: 400 });

  it("belong to the identified window their owner chain leads to", () => {
    const menu = rail(3, "", { x: 120, y: 130, width: 200, height: 300 }, { popup: true, owner: 9 });
    const owners = new Map([[9, 1]]);
    expect(popupOwners([main, other, menu], new Set([1]), h => owners.get(h) ?? 0)).toEqual(new Map([[3, 1]]));
  });

  it("else to the same msrdc's window right under them, when they lie within it", () => {
    const tip = rail(3, "", { x: 300, y: 300, width: 100, height: 20 }, { popup: true });
    expect(popupOwners([main, tip], new Set([1]), () => 0)).toEqual(new Map([[3, 1]]));
    // Over another window (not within it), under an unidentified one, or another msrdc's: nobody's.
    expect(popupOwners([other, main, { ...tip, frame: { x: 1050, y: 150, width: 50, height: 20 } }], new Set([1]), () => 0).size).toBe(0);
    expect(popupOwners([main, other, { ...tip, frame: { x: 1050, y: 150, width: 50, height: 20 } }], new Set([1]), () => 0).size).toBe(0);
    expect(popupOwners([main, { ...tip, pid: 99 }], new Set([1]), () => 0).size).toBe(0);
  });

  it("never take a window's identity by where they lie when their owner is a Linux window nobody identified", () => {
    // KeePassXC (never-look, so unidentified) under gedit; its menu, owned by it, lies within gedit: still KeePassXC's.
    const keepass = rail(4, "Passwords.kdbx - KeePassXC", { x: 100, y: 100, width: 800, height: 600 });
    const menu = rail(3, "", { x: 300, y: 300, width: 100, height: 20 }, { popup: true, owner: 4 });
    expect(popupOwners([keepass, main, menu], new Set([1]), () => 0).size).toBe(0);
    // Through a popup it opened from (a submenu): the same.
    const sub = rail(5, "", { x: 310, y: 310, width: 100, height: 20 }, { popup: true, owner: 3 });
    expect(popupOwners([keepass, main, menu, sub], new Set([1]), h => (h === 3 ? 4 : 0)).size).toBe(0);
    // An owner that isn't a Linux window on screen (unknown) still lets where it lies decide.
    expect(popupOwners([main, { ...menu, owner: 77 }], new Set([1]), () => 0)).toEqual(new Map([[3, 1]]));
  });

  it("follow an owner chain only so far (a loop can't hang)", () => {
    const loop = rail(3, "", { x: 0, y: 0, width: 10, height: 10 }, { popup: true, owner: 5 });
    expect(popupOwners([loop], new Set([1]), h => (h === 5 ? 6 : 5)).size).toBe(0);
  });
});

describe("which distro a msrdc's windows belong to", () => {
  const f = (name: string) => frame(name, null, []);

  it("is the one distro whose frames name them, else none", () => {
    const frames = new Map([["Ubuntu", [f("notes.txt - gedit")]], ["Debian", [f("xeyes")]]]);
    expect(distroOfTitles(["notes.txt - gedit (Ubuntu)"], frames)).toBe("Ubuntu");
    expect(distroOfTitles(["xeyes"], frames)).toBe("Debian");
    expect(distroOfTitles(["Calculator"], frames)).toBeNull();
    expect(distroOfTitles(["xeyes"], new Map([["Ubuntu", [f("xeyes")]], ["Debian", [f("xeyes")]]]))).toBeNull();
  });
});
