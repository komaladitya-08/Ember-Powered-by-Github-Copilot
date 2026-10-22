/**
 * Telling WSLg's RAIL windows from a Remote Desktop client's (design §4.6): by the msrdc.exe's image, read once per
 * process and forgotten when it is gone; a probe that can't say leaves the windows remote surfaces. OS-neutral: the
 * probe is a fake (the real one binds kernel32 and user32 only on Windows).
 */

import { describe, expect, it } from "vitest";
import type { StackedWindow } from "../../app/main/platform/types";
import { isMsrdcWindow, openRailProbe, railWindows, WslgPids, type RailProbe } from "../../app/main/wsl/rail";

const win = (id: number, pid: number | null, wmClass: string, more: Partial<StackedWindow> = {}): StackedWindow => {
  const r = { x: 10 * id, y: 20, width: 300, height: 200 };
  return { id, client: id, pid, title: `w${id}`, wmClass, ...r, outer: r, inner: r, overrideRedirect: false, ...more };
};

const probe = (images: Record<number, string | null>, owners: Record<number, number> = {}) => {
  const asked: number[] = [];
  const p: RailProbe = { imagePath: pid => { asked.push(pid); return images[pid] ?? null; }, owner: h => owners[h] ?? 0 };
  return { p, asked };
};

describe("msrdc's windows", () => {
  it("are msrdc's, with or without .exe, any case", () => {
    for (const c of ["msrdc", "MSRDC.EXE", " msrdc "]) expect(isMsrdcWindow({ wmClass: c })).toBe(true);
    for (const c of ["mstsc", "msrdcw", "wsl:Ubuntu:gedit", "notepad"]) expect(isMsrdcWindow({ wmClass: c })).toBe(false);
  });
});

describe("WslgPids", () => {
  const stack = [win(1, 100, "msrdc"), win(2, 100, "msrdc"), win(3, 200, "msrdc"), win(4, 300, "notepad"), win(5, null, "msrdc")];

  it("takes an msrdc for WSLg's by its image, reading each process's once", () => {
    const { p, asked } = probe({ 100: "C:\\Program Files\\WSL\\msrdc.exe", 200: "C:\\Program Files\\Remote Desktop\\msrdc.exe" });
    const pids = new WslgPids(p);
    expect(pids.of(stack)).toEqual(new Set([100]));
    expect(pids.of(stack)).toEqual(new Set([100]));
    expect(asked).toEqual([100, 200]);
  });

  it("forgets a process the stack no longer shows (pids are reused), and asks again after a failed read", () => {
    const images: Record<number, string | null> = { 100: null };
    const { p, asked } = probe(images);
    const pids = new WslgPids(p);
    expect(pids.of(stack.slice(0, 1))).toEqual(new Set());
    images[100] = "C:\\Program Files\\WSL\\msrdc.exe";
    expect(pids.of(stack.slice(0, 1))).toEqual(new Set([100]));
    expect(pids.of([])).toEqual(new Set());
    images[100] = "C:\\Program Files\\Remote Desktop\\msrdc.exe";
    expect(pids.of(stack.slice(0, 1))).toEqual(new Set());
    expect(asked).toEqual([100, 100, 100]);
  });

  it("takes none for WSLg's without a probe, or when it throws (fail closed)", () => {
    expect(new WslgPids(null).of(stack)).toEqual(new Set());
    expect(new WslgPids({ imagePath: () => { throw new Error("gone"); }, owner: () => 0 }).of(stack)).toEqual(new Set());
  });
});

describe("railWindows", () => {
  it("keeps WSLg's msrdc windows in stacking order, with their client areas and their popups' owners", () => {
    const { p } = probe({}, { 3: 1 });
    const stack = [win(1, 100, "msrdc", { inner: { x: 12, y: 50, width: 280, height: 160 } }), win(2, 200, "msrdc"), win(3, 100, "msrdc", { overrideRedirect: true }), win(4, 300, "notepad")];
    const rails = railWindows(stack, new Set([100]), p);
    expect(rails.map(r => [r.hwnd, r.popup, r.owner])).toEqual([[1, false, 0], [3, true, 1]]);
    expect(rails[0]).toMatchObject({ pid: 100, title: "w1", inner: { x: 12, y: 50, width: 280, height: 160 }, frame: { x: 10, y: 20, width: 300, height: 200 } });
  });

  it("takes a popup's owner as unknown when it can't be read", () => {
    const rails = railWindows([win(3, 100, "msrdc", { overrideRedirect: true })], new Set([100]), { imagePath: () => null, owner: () => { throw new Error("x"); } });
    expect(rails[0].owner).toBe(0);
  });
});

describe("the real probe", () => {
  it("exists only on Windows (nothing is loaded anywhere else)", () => {
    expect(openRailProbe("linux")).toBeNull();
    expect(openRailProbe("darwin")).toBeNull();
  });
});
