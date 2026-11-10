import { describe, expect, it } from "vitest";
import { StatusFence } from "../../app/renderer/home/status-fence";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import type { Status } from "../../app/shared/ipc";
import fs from "node:fs";

const withSize = (size: number) => ({ ...structuredClone(DEFAULT_SETTINGS), size });
const status = (size: number, notice: string | null = null) => ({ appVersion: "1", settings: withSize(size), settingsNotice: notice }) as unknown as Status;

describe("StatusFence (the startup snapshot against newer pushes)", () => {
  it("applies a snapshot as it is when nothing was pushed meanwhile (normal first load)", () => {
    const f = new StatusFence();
    const snap = status(1);
    expect(f.apply(f.begin(), snap)).toBe(snap);
  });
  it("keeps settings pushed after the request when the older snapshot arrives late", () => {
    const f = new StatusFence();
    const t = f.begin();
    f.pushedSettings(withSize(2));
    expect(f.apply(t, status(1)).settings.size).toBe(2);
  });
  it("keeps the last of several pushes", () => {
    const f = new StatusFence();
    const t = f.begin();
    f.pushedSettings(withSize(2)); f.pushedSettings(withSize(3));
    expect(f.apply(t, status(1)).settings.size).toBe(3);
  });
  it("lets a snapshot requested after the push stand (recovery after a failure)", () => {
    const f = new StatusFence();
    f.pushedSettings(withSize(2));
    const t = f.begin();
    expect(f.apply(t, status(5)).settings.size).toBe(5);
  });
  it("keeps a pushed settings notice, including a pushed clear, over the snapshot's", () => {
    const f = new StatusFence();
    const t = f.begin();
    f.pushedNotice(null);
    expect(f.apply(t, status(1, "old notice")).settingsNotice).toBeNull();
  });
  it("leaves the snapshot's other fields alone", () => {
    const f = new StatusFence();
    const t = f.begin();
    f.pushedSettings(withSize(2));
    expect(f.apply(t, status(1)).appVersion).toBe("1");
  });
});

describe("getStatus in main", () => {
  it("reads settings and the notice after awaiting the environment, not before", () => {
    const src = fs.readFileSync("app/main/main.ts", "utf8");
    const start = src.indexOf("ipcMain.handle(IPC.getStatus");
    const body = src.slice(start, src.indexOf("ipcMain.handle(IPC.activity", start));
    const awaited = body.indexOf("await environmentNow()");
    expect(awaited).toBeGreaterThan(0);
    expect(body.indexOf("settings.get()")).toBeGreaterThan(awaited);
    expect(body.indexOf("settingsNotice,")).toBeGreaterThan(awaited);
  });
});

describe("Home's startup status consumers", () => {
  it("fences the Project card's own getStatus too, so a late snapshot cannot undo a pushed commands setting", () => {
    const src = fs.readFileSync("app/renderer/home/project.ts", "utf8");
    expect(src).toContain("const ticket = statusFence.begin();");
    expect(src).toContain("getStatus().then(st => statusFence.apply(ticket, st))");
  });
});
