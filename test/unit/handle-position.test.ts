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
import { handleCornerText, tagline } from "../../app/renderer/home/copy";

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

describe("the handle menu's Move to the other side", () => {
  const main = fs.readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
  const menuStart = main.indexOf("const menu = Menu.buildFromTemplate([");
  const menu = main.slice(menuStart, main.indexOf("]);", menuStart));

  it("is in the handle's menu, with Hide Ember and Stay put, whether or not Ember can follow the cursor", () => {
    const item = /\{ label: "Move to the other side", click: moveHandle \}/.exec(menu);
    expect(item).not.toBeNull();
    // After Hide Ember (the things that change where Ember is on screen), before the separator above Quit Ember.
    expect(menu.indexOf("\"Move to the other side\"")).toBeGreaterThan(menu.indexOf("\"Hide Ember\""));
    expect(menu.indexOf("\"Move to the other side\"")).toBeLessThan(menu.indexOf("\"Quit Ember\""));
  });

  it("flips Handle position, keeping a failed save to the log (the handle stays where it is then)", () => {
    expect(main).toContain(
      "const moveHandle = () => {\n    try { settings.update({ handlePosition: otherSide(settings.get().handlePosition) }); } catch (err) { log.warn(\"handle.move_not_saved\", { err }); }\n  };",
    );
  });

  it("moves the handle before the overlays hear the change, so its task cards follow it at once", () => {
    const at = main.indexOf("settings.onChange((s) => {");
    const body = main.slice(at, main.indexOf("});", at));
    expect(body.indexOf("if (handle?.sendSettings(s)) deskViewRef?.handleMoved();")).toBeGreaterThan(-1);
    expect(body.indexOf("if (handle?.sendSettings(s)) deskViewRef?.handleMoved();")).toBeLessThan(body.indexOf("overlay?.broadcastSettings(s);"));
  });

  it("moves the handle through the settings, so a restart keeps the side and Settings shows it", () => {
    const s = new SettingsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-handle-move-")), "settings.json"));
    s.load();
    const seen: string[] = [];
    s.onChange(v => seen.push(v.handlePosition));
    s.update({ handlePosition: otherSide(s.get().handlePosition) });
    s.update({ handlePosition: otherSide(s.get().handlePosition) });
    expect(seen).toEqual(["bottom-left", "bottom-right"]);
  });
});

describe("the task card stack on the handle's side", () => {
  const css = fs.readFileSync(new URL("../../app/renderer/overlay/styles.css", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../../app/renderer/overlay/main.ts", import.meta.url), "utf8");

  it("is anchored bottom right, or bottom left with the .left class", () => {
    expect(css).toMatch(/\n\.tasks \{\n {2}position: absolute; right: 12px; bottom: 80px;/);
    expect(css).toContain("\n.tasks.left { right: auto; left: 12px; }\n");
  });

  it("takes the side and its distance in from the handle, and the class with it", () => {
    const place = page.slice(page.indexOf("function placeTasks(): void {"), page.indexOf("\n}\n", page.indexOf("function placeTasks(): void {")));
    expect(place).toContain("const { inset, bottom } = stackPlace(handleRect, viewport, PILL_INSET, CARD_GAP);");
    expect(place).toContain("tasksEl.classList.toggle(\"left\", side === \"left\");");
    expect(place).toContain("tasksEl.style.right = side === \"left\" ? \"auto\" : `${inset}px`;");
    expect(place).toContain("tasksEl.style.left = side === \"left\" ? `${inset}px` : \"auto\";");
    // Where the handle is now (its pill on this display), else Handle position.
    expect(page).toContain("const homeSide = (): HandleSide => handleSide(handleRect, viewport.width, settings?.handlePosition);");
  });

  it("makes way for the ring round a control to the other bottom corner, whichever side is the handle's", () => {
    const corner = page.slice(page.indexOf("function cornerTasks(): boolean {"), page.indexOf("\n}\n", page.indexOf("function cornerTasks(): boolean {")));
    expect(corner).toContain("viewport.width, home) !== home;");
  });

  it("comes back to the handle's side when the setting changes while the handle is on another display", () => {
    const apply = page.slice(page.indexOf("function applySettings(s: Settings): void {"), page.indexOf("\n}\n", page.indexOf("function applySettings(s: Settings): void {")));
    expect(apply).toContain("if (homeSide() !== placedSide) placeTasks();");
  });
});

describe("Settings › Comfort & access › Handle position", () => {
  const page = fs.readFileSync(new URL("../../app/renderer/home/index.html", import.meta.url), "utf8");
  const home = fs.readFileSync(new URL("../../app/renderer/home/main.ts", import.meta.url), "utf8");
  const access = page.slice(page.indexOf('<h2 id="access-h"'), page.indexOf("</section>", page.indexOf('<h2 id="access-h"')));

  it("is a pop-up button under Ember on screen: Bottom right or Bottom left, named by its label", () => {
    const onScreen = access.slice(access.indexOf("Ember on screen"), access.indexOf('<h3 class="sub">Text</h3>'));
    expect(onScreen).toContain([
      '<label class="switch-row"><span>Handle position</span><select id="handle-position">',
      '            <option value="bottom-right">Bottom right</option>',
      '            <option value="bottom-left">Bottom left</option>',
      "          </select></label>",
    ].join("\n"));
    expect(onScreen).toContain('<p class="hint">Ember\'s handle and its task cards sit in this corner of your main screen. “Move to the other side” in the handle\'s menu switches it too.</p>');
  });

  it("shows the setting in use and saves a change at once", () => {
    expect(home).toContain('($("handle-position") as HTMLSelectElement).value = s.handlePosition;');
    expect(home).toContain('$("handle-position").addEventListener("change", e => { void save({ handlePosition: (e.target as HTMLSelectElement).value as Settings["handlePosition"] }); });');
  });
});

describe("copy that says where the handle is", () => {
  const page = fs.readFileSync(new URL("../../app/renderer/home/index.html", import.meta.url), "utf8");
  const home = fs.readFileSync(new URL("../../app/renderer/home/main.ts", import.meta.url), "utf8");
  const base = { failing: 0, onboarded: true, phase: "ready", hidden: false, overlay: true } as const;

  it("names the corner Handle position puts it in", () => {
    expect(handleCornerText("bottom-right")).toBe("bottom-right corner");
    expect(handleCornerText("bottom-left")).toBe("bottom-left corner");
    expect(handleCornerText(undefined)).toBe("bottom-right corner");
  });

  it("in the line at the top of settings, while Ember lives in the corner card", () => {
    expect(tagline({ ...base, overlay: false })).toMatch(/^Ember is in the bottom-right corner\./);
    expect(tagline({ ...base, overlay: false, corner: "bottom-left" })).toMatch(/^Ember is in the bottom-left corner\./);
    expect(tagline({ ...base, overlay: false, corner: "bottom-right" })).toMatch(/^Ember is in the bottom-right corner\./);
    // Beside the cursor, the corner isn't named.
    expect(tagline({ ...base, corner: "bottom-left" })).toMatch(/^Ember is beside your cursor\./);
    expect(home).toContain("hidden: presence?.hidden ?? false, overlay: presence?.overlay ?? true, corner: settings?.handlePosition,");
  });

  it("in the way back to settings under Your Ember, and in Ember on screen without a compositor", () => {
    expect(page).toContain("or click Ember's handle in the <span id=\"handle-corner\">bottom-right corner</span>.</p>");
    expect(home).toContain('if ($("handle-corner").textContent !== corner) $("handle-corner").textContent = corner;');
    expect(home).toContain("const corner = handleCornerText(s.handlePosition);");
    // Ember on screen's line follows a change too (said again only when its words change: it is a live region).
    expect(home).toContain("if (presence) renderPresence(presence);");
    expect(home).toContain('if ($("presence-text").textContent !== line) $("presence-text").textContent = line;');
    expect(home).toContain("`This desktop session can't show Ember beside your cursor, so it lives in the card in the ${handleCornerText(settings?.handlePosition)}.`");
    // Neither says bottom-right on its own any more.
    expect(home).not.toMatch(/bottom-right corner/);
  });
});
