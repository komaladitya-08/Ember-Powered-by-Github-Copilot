/**
 * An update that replaces Ember's files under a running Ember (an RPM upgrade, also from GNOME Software or a
 * dnf-automatic timer) is noticed when the next window opens, and Ember offers to restart (install-watch.ts). Review #203.
 */

import { describe, expect, it, vi } from "vitest";
import { UPDATED_QUESTION, createUpdateCheck, installStamp, updatedDetail, type StatLike } from "../../app/main/install-watch";

vi.mock("electron", () => ({ BrowserWindow: class {} }));
const { quitQuestion } = await import("../../app/main/windows");

/** A stand-in package.json: its inode, size and modification time, or gone (mid-upgrade). */
function fakeFile() {
  let now: { ino: number; size: number; mtimeMs: number } | null = { ino: 100, size: 2048, mtimeMs: 1_700_000_000_000 };
  const stat: StatLike = () => { if (!now) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return now; };
  return { stat, set: (v: typeof now) => { now = v; } };
}

function setUp(file = fakeFile(), answer = false) {
  const asked: number[] = [];
  let restarts = 0;
  let pending: Promise<unknown> = Promise.resolve();
  const check = createUpdateCheck({
    file: "/opt/ember/resources/app/package.json", stat: file.stat,
    ask: () => { asked.push(asked.length); const p = Promise.resolve(answer); pending = p; return p; },
    restart: () => { restarts++; },
  });
  return { file, check, asked, restarts: () => restarts, settled: () => pending.then(() => new Promise(r => setImmediate(r))) };
}

describe("installStamp", () => {
  it("is the file's inode, size and modification time, or null when it can't be read", () => {
    const f = fakeFile();
    expect(installStamp("/x", f.stat)).toBe("100:2048:1700000000000");
    f.set(null);
    expect(installStamp("/x", f.stat)).toBeNull();
  });
});

describe("the update check before a window opens", () => {
  it("asks nothing while Ember's files are the ones it started with", () => {
    const s = setUp();
    s.check.beforeWindow();
    s.check.beforeWindow();
    expect(s.asked).toEqual([]);
  });

  it("offers a restart once the files were replaced, and restarts when asked to", async () => {
    const s = setUp(fakeFile(), true);
    // rpm writes a new file and renames it over the old one: a new inode, even for a rebuild of the same version.
    s.file.set({ ino: 101, size: 2048, mtimeMs: 1_700_000_000_000 });
    s.check.beforeWindow();
    await s.settled();
    expect(s.asked).toHaveLength(1);
    expect(s.restarts()).toBe(1);
  });

  it("asks once per update: \"Not now\" isn't asked again until the files change again", async () => {
    const s = setUp(fakeFile(), false);
    s.file.set({ ino: 101, size: 2100, mtimeMs: 1_700_000_100_000 });
    s.check.beforeWindow();
    await s.settled();
    s.check.beforeWindow();
    s.check.beforeWindow();
    await s.settled();
    expect(s.asked).toHaveLength(1);
    expect(s.restarts()).toBe(0);
    s.file.set({ ino: 102, size: 2200, mtimeMs: 1_700_000_200_000 });
    s.check.beforeWindow();
    await s.settled();
    expect(s.asked).toHaveLength(2);
  });

  it("never asks two questions at once, and waits while the file is missing (the upgrade is still writing)", async () => {
    const f = fakeFile();
    const asked: number[] = [];
    let answer: (yes: boolean) => void = () => undefined;
    const check = createUpdateCheck({ file: "/p", stat: f.stat, ask: () => { asked.push(1); return new Promise<boolean>(r => { answer = r; }); }, restart: () => undefined });
    f.set(null);
    check.beforeWindow();
    expect(asked).toHaveLength(0);
    f.set({ ino: 101, size: 1, mtimeMs: 1 });
    check.beforeWindow();
    f.set({ ino: 102, size: 1, mtimeMs: 2 });
    check.beforeWindow();
    expect(asked).toHaveLength(1);
    answer(false);
    await new Promise(r => setImmediate(r));
    check.beforeWindow();
    expect(asked).toHaveLength(2);
  });

  it("asks nothing when the file couldn't be read at start-up", () => {
    const f = fakeFile();
    f.set(null);
    const asked: number[] = [];
    const check = createUpdateCheck({ file: "/p", stat: f.stat, ask: () => { asked.push(1); return Promise.resolve(true); }, restart: () => undefined });
    f.set({ ino: 1, size: 1, mtimeMs: 1 });
    check.beforeWindow();
    expect(asked).toEqual([]);
  });
});

describe("the question's words", () => {
  it("say what restarting would stop, in the quit question's words", () => {
    expect(UPDATED_QUESTION).toMatchObject({ title: "Ember was updated", message: "Restart Ember to finish the update.", buttons: ["Restart Ember", "Not now"] });
    expect(updatedDetail(null)).toBe("Until it starts again, some of its windows may not work as they should.");
    expect(updatedDetail(quitQuestion(1, { commands: 0, connections: 0 }))).toMatch(/^Ember is still .+\. Restarting stops it where it is\.$/);
    expect(updatedDetail(quitQuestion(0, { commands: 0, connections: 1 }, ["build-01"]))).toBe("Ember is connected to build-01. Restarting disconnects.");
  });
});
