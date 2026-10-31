/**
 * This computer's screen locked while a turn or a task is still running (cross-review X9 on review #81): describe_screen
 * doesn't read it, and opening an app or changing a desktop setting doesn't act on it, as the hands' reads and steps
 * don't. A task's commands (their own window) go on. Main's wiring is read from main.ts's source (it is Electron's
 * entry point and can't be loaded here).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { localTargetHands, type Hands } from "../../app/main/agent/host";
import { LINUX_WORKER_SYSTEM, Worker, type WorkerDeps, type WorkerSystem } from "../../app/main/agent/worker";
import { Presenter } from "../../app/main/agent/presenter";
import { PolicyEngine } from "../../app/main/policy/policy";
import { LOCKED_DESCRIBE, LOCKED_SCREEN, lockedOutHands, lockedOutSystem } from "../../app/main/screen-lock";
import { localBinding, refusingPerception, refusingSidecar, screenHands, wslBinding } from "../../app/main/targets/hands";
import type { DesktopApp } from "../../app/main/hands/system";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const FIREFOX = { id: "firefox.desktop", name: "Firefox", exec: "firefox", keywords: [] } as unknown as DesktopApp;

/** A system whose launcher and settings record what they did. */
function recordingSystem() {
  const launch = vi.fn(async (_app: DesktopApp) => undefined);
  const change = vi.fn(async (_name: string, _value: string) => ({ before: "off", after: "on" }));
  const system: WorkerSystem = {
    ...LINUX_WORKER_SYSTEM,
    apps: {
      ...LINUX_WORKER_SYSTEM.apps, list: () => [FIREFOX], isTerminalApp: () => false, launch,
      find: (list, name) => list.find(a => a.name.toLowerCase().includes(name.toLowerCase())) ?? null,
    },
    settings: { available: { dark_style: "Dark style for apps" }, change: change as WorkerSystem["settings"]["change"] },
  };
  return { system, launch, change };
}

describe("describe_screen while this screen is locked", () => {
  // AgentHost refuses to read it then (host.test.ts and host-targets.test.ts, "cross-review X9"); main tells it when.
  it("is refused by the conversation's host, which main tells whether this screen is locked", () => {
    const main = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8").replace(/\s+/g, " ");
    expect(main).toMatch(/describeScreen: \(\) => seeing\.describe\(\), screenLocked: \(\) => screenLock\?\.locked \?\? false/);
    expect(LOCKED_DESCRIBE).toMatch(/locked/);
  });
});

describe("opening an app and changing a setting while this screen is locked", () => {
  it("refuse in the system's own steps, and leave listing the apps and the settings as they are", async () => {
    let locked = true;
    const { system, launch, change } = recordingSystem();
    const gated = lockedOutSystem(system, () => locked);
    await expect(Promise.resolve(gated.apps.launch(FIREFOX))).rejects.toThrow(LOCKED_SCREEN);
    await expect(gated.settings.change("dark_style", "on")).rejects.toThrow(LOCKED_SCREEN);
    expect(launch).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
    expect(gated.apps.list()).toEqual([FIREFOX]);
    expect(gated.settings.available).toBe(system.settings.available);
    expect(gated.os).toBe(system.os);
    locked = false;
    await gated.apps.launch(FIREFOX);
    await expect(gated.settings.change("dark_style", "on")).resolves.toEqual({ before: "off", after: "on" });
    expect(launch).toHaveBeenCalledWith(FIREFOX);
    expect(change).toHaveBeenCalledWith("dark_style", "on");
  });

  it("refuse through this screen's hands for a local or WSL task, which counts a setting changed as using it", async () => {
    let locked = true;
    const { system, launch, change } = recordingSystem();
    const hands = { perception: refusingPerception("no"), sidecar: refusingSidecar("no"), policy: {}, audit: {}, confirmer: {}, flyTo: vi.fn(), currentWindow: () => null } as unknown as Hands;
    const mine = lockedOutHands(hands, () => locked);
    expect(mine.screenLocked?.()).toBe(true);
    for (const binding of [localBinding("linux", true), wslBinding({ name: "Ubuntu", version: 2 }, true)]) {
      const task = screenHands({ hands: mine, base: null, binding, system, commands: null })!;
      await expect(Promise.resolve(task.system.apps.launch(FIREFOX))).rejects.toThrow(LOCKED_SCREEN);
      await expect(task.system.settings.change("dark_style", "on")).rejects.toThrow(LOCKED_SCREEN);
      // Tried on this screen: the lock's sweep stops such a task too.
      expect(task.usedDesktop?.()).toBe(true);
    }
    // So do a host's own hands without a targets runtime (tests, the eval).
    const own = localTargetHands(mine, system);
    await expect(Promise.resolve(own.system.apps.launch(FIREFOX))).rejects.toThrow(LOCKED_SCREEN);
    await expect(own.system.settings.change("dark_style", "on")).rejects.toThrow(LOCKED_SCREEN);
    expect(localTargetHands({ ...hands }, system).system).toBe(system);
    expect(launch).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
    locked = false;
    const task = screenHands({ hands: mine, base: null, binding: localBinding("linux", true), system, commands: null })!;
    expect(task.usedDesktop?.()).toBe(false);
    await task.system.settings.change("dark_style", "on");
    expect(change).toHaveBeenCalledTimes(1);
    expect(task.usedDesktop?.()).toBe(true);
  });
});

/** A worker on this screen's hands as main and the targets runtime build them, with a real policy. */
function workerOn(o: { gateSystem: boolean }) {
  let locked = false;
  const audit: Record<string, unknown>[] = [];
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  const window = { app: "gedit", pid: 1, name: "notes.txt", role: "frame", active: true, bounds };
  const { system, launch, change } = recordingSystem();
  // Firefox's window appears once it has been started.
  const windows = vi.fn(async () => (launch.mock.calls.length ? [window, { app: "firefox", pid: 2, name: "Mozilla Firefox", role: "frame", active: true, bounds }] : [window]));
  const perception = { ...refusingPerception("raw"), describe: async () => "screen text", windows };
  const base = {
    perception, sidecar: refusingSidecar("raw"), policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}) }),
    audit: { write: (e: Record<string, unknown>) => audit.push(e) }, confirmer: { ask: vi.fn(async () => "once") },
    flyTo: () => undefined, currentWindow: () => null,
  } as unknown as Hands;
  const gated = lockedOutHands(base, () => locked);
  // Without the system's gate, only the worker's own check (a screen that refuses to be read) stands in the way.
  const h = screenHands({ hands: o.gateSystem ? gated : { ...gated, screenLocked: undefined }, base: null, binding: localBinding("linux", true), system, commands: null })!;
  const w = new Worker({
    client: {} as never, log: quiet, model: "m", vision: false, workDir: "/tmp",
    perception: h.perception, sidecar: h.sidecar, policy: h.policy, confirmer: h.confirmer, audit: h.audit,
    settings: { get: () => ({ grants: {} }), update: () => undefined } as never,
    presenter: new Presenter(() => undefined),
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
    target: h.binding, system: h.system, commands: null,
  } as unknown as WorkerDeps, { id: "t1", goal: "open firefox and turn on dark style", userWords: "open firefox and turn on dark style", target: {} } as never);
  const call = (name: string, args: Record<string, unknown>) =>
    w.tools().find(t => t.name === name)!.handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
  return { call, launch, change, windows, audit, lock: (on: boolean) => { locked = on; } };
}

describe("a task on this screen when it locks", () => {
  it("doesn't start the app or change the setting it was asked for, and says the screen is locked", async () => {
    const t = workerOn({ gateSystem: true });
    t.lock(true);
    const opened = await t.call("open_app", { name: "firefox" });
    expect(opened.resultType).toBe("failure");
    expect(opened.textResultForLlm).toContain(LOCKED_SCREEN);
    const changed = await t.call("change_setting", { setting: "dark_style", value: "on" });
    expect(changed.resultType).toBe("failure");
    expect(changed.textResultForLlm).toContain(LOCKED_SCREEN);
    expect(t.launch).not.toHaveBeenCalled();
    expect(t.change).not.toHaveBeenCalled();
    expect(t.windows).not.toHaveBeenCalled();
    expect(t.audit.filter(e => e.event === "action")).toEqual([
      expect.objectContaining({ kind: "open_app", ok: false, error: LOCKED_SCREEN }),
      expect.objectContaining({ kind: "setting", ok: false, error: LOCKED_SCREEN }),
    ]);
  }, 20_000);

  it("opens the app and changes the setting while the screen is unlocked, as before", async () => {
    const t = workerOn({ gateSystem: true });
    const opened = await t.call("open_app", { name: "firefox" });
    expect(opened.resultType).toBe("success");
    expect(t.launch).toHaveBeenCalledTimes(1);
    await t.call("change_setting", { setting: "dark_style", value: "on" });
    expect(t.change).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("doesn't start an app on a screen that refuses to be read for being locked, even where opening apps isn't gated itself", async () => {
    const t = workerOn({ gateSystem: false });
    t.lock(true);
    const opened = await t.call("open_app", { name: "firefox" });
    expect(opened.resultType).toBe("failure");
    expect(opened.textResultForLlm).toContain(LOCKED_SCREEN);
    expect(t.launch).not.toHaveBeenCalled();
  }, 20_000);
});
