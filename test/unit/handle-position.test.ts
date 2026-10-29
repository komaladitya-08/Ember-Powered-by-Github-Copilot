/**
 * Where Ember's handle sits (review #75, owner decision D-75): Settings › Comfort & access › Handle position puts it in
 * the bottom-right (the default, where it always was) or the bottom-left corner of the primary display's work area,
 * inside the taskbar, the Dock or the panel on every OS; the handle's menu flips it; settings.json keeps it, and a file
 * from before the setting reads as the bottom right.
 */

import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HANDLE_MARGIN, HANDLE_POSITIONS, handleCorner, otherSide, sideOf } from "../../app/shared/handle-place";
import { DEFAULT_SETTINGS, SettingsStore, repairSettings } from "../../app/main/settings";

const PILL = { width: 200, height: 56 };
const TAB = { width: 56, height: 56 };
const CARD = { width: 360, height: 150 };

describe("the handle's corner", () => {
  it("is the bottom right by default, 12 px in from the work area's edges", () => {
    const wa = { x: 0, y: 0, width: 1920, height: 1040 };
    expect(HANDLE_MARGIN).toBe(12);
    expect(handleCorner("bottom-right", PILL, wa)).toEqual({ x: 1920 - 200 - 12, y: 1040 - 56 - 12 });
    // Anything unknown (a renderer given settings from before the setting) is the bottom right, as it always was.
    expect(handleCorner(undefined, PILL, wa)).toEqual(handleCorner("bottom-right", PILL, wa));
  });

  it("is the bottom left with the setting, for the pill, the hidden-state tab and the card alike", () => {
    const wa = { x: 0, y: 0, width: 1920, height: 1040 };
    for (const size of [PILL, TAB, CARD]) {
      expect(handleCorner("bottom-left", size, wa)).toEqual({ x: 12, y: 1040 - size.height - 12 });
      expect(handleCorner("bottom-right", size, wa)).toEqual({ x: 1920 - size.width - 12, y: 1040 - size.height - 12 });
    }
  });

  it("keeps inside the work area on every OS: a taskbar or Dock on the left, a panel at the top, a second screen", () => {
    const areas = {
      // Windows with the taskbar on the left (48 px), and at the bottom (the work area stops above it).
      "taskbar left": { x: 48, y: 0, width: 1872, height: 1080 },
      "taskbar bottom": { x: 0, y: 0, width: 1920, height: 1032 },
      // macOS: the menu bar on top, the Dock on the left; GNOME's top bar.
      "Dock left": { x: 70, y: 25, width: 1370, height: 875 },
      "GNOME top bar": { x: 0, y: 27, width: 1280, height: 773 },
      // A primary display that isn't at the origin.
      "display at -1280": { x: -1280, y: 200, width: 1280, height: 984 },
    };
    for (const [name, wa] of Object.entries(areas)) {
      for (const p of HANDLE_POSITIONS) {
        const at = handleCorner(p, PILL, wa);
        expect(at.x, `${name} ${p}`).toBeGreaterThanOrEqual(wa.x + 12);
        expect(at.x + PILL.width, `${name} ${p}`).toBeLessThanOrEqual(wa.x + wa.width - 12);
        expect(at.y + PILL.height, `${name} ${p}`).toBe(wa.y + wa.height - 12);
      }
      expect(handleCorner("bottom-left", PILL, wa).x, name).toBe(wa.x + 12);
      expect(handleCorner("bottom-right", PILL, wa).x, name).toBe(wa.x + wa.width - 212);
    }
  });

  it("is on the side the position names, and the other side is the other corner", () => {
    expect(sideOf("bottom-right")).toBe("right");
    expect(sideOf("bottom-left")).toBe("left");
    expect(sideOf(undefined)).toBe("right");
    expect(otherSide("bottom-right")).toBe("bottom-left");
    expect(otherSide("bottom-left")).toBe("bottom-right");
    expect(otherSide(undefined)).toBe("bottom-left");
  });
});

describe("the Handle position setting", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-handle-position-"));
    file = path.join(dir, "settings.json");
  });

  it("defaults to the bottom right", () => {
    expect(DEFAULT_SETTINGS.handlePosition).toBe("bottom-right");
  });

  it("is saved in settings.json and read back", () => {
    const s = new SettingsStore(file);
    s.load();
    s.update({ handlePosition: "bottom-left" });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).handlePosition).toBe("bottom-left");
    expect(new SettingsStore(file).load().settings.handlePosition).toBe("bottom-left");
  });

  it("reads a settings.json from before the setting as the bottom right, keeping everything else and writing nothing", () => {
    const before = { version: 1, character: "wisp", textSize: "large", reduceMotion: true, onboarded: false };
    fs.writeFileSync(file, JSON.stringify(before));
    const r = new SettingsStore(file).load();
    expect(r.settings).toMatchObject({ ...before, handlePosition: "bottom-right" });
    expect(r.recoveredFrom).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(before);
  });

  it("puts a value it doesn't know back to the bottom right, and only that", () => {
    for (const bad of ["top-left", "left", 1, null, { side: "left" }]) {
      const s = repairSettings({ handlePosition: bad, character: "glint", textSize: "larger" });
      expect(s.handlePosition, JSON.stringify(bad)).toBe("bottom-right");
      expect(s).toMatchObject({ character: "glint", textSize: "larger" });
    }
    expect(repairSettings({ handlePosition: "bottom-left" }).handlePosition).toBe("bottom-left");
  });

  it("refuses an update to a corner that isn't one, keeping the one in use", () => {
    const s = new SettingsStore(file);
    s.load();
    s.update({ handlePosition: "bottom-left" });
    expect(() => s.update({ handlePosition: "top-right" as never })).toThrow();
    expect(s.get().handlePosition).toBe("bottom-left");
  });

  it("isn't one the organisation's policy manages, as the other comfort settings aren't", () => {
    const admin = fs.readFileSync(new URL("../../app/main/admin.ts", import.meta.url), "utf8");
    expect(admin).not.toMatch(/handlePosition/);
    for (const comfort of ["textSize", "reduceMotion", "moreTime"]) expect(admin).not.toMatch(new RegExp(`\\b${comfort}\\b`));
  });
});
