/** Portable Windows runtime lifecycle with a storage boundary fake; no Windows native enforcement is claimed. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CopilotClient, CopilotClientOptions } from "@github/copilot-sdk";
import type { PrivateControllerStorage } from "../../app/main/agent/private-controller-storage";

const roots: string[] = [];
afterEach(() => {
  vi.doUnmock("../../app/main/platform/os"); vi.doUnmock("../../app/main/agent/windows-controller-storage"); vi.restoreAllMocks(); vi.resetModules();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function setup() {
  vi.resetModules(); vi.doMock("../../app/main/platform/os", () => ({ HOST_PLATFORM: "win32", HOST_ARCH: "x64" }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-controller-windows-model-")); roots.push(root);
  const controller = path.join(root, "controller"), paths = { root: controller, cwd: path.join(controller, "cwd"), home: path.join(controller, "home"), state: path.join(controller, "state"), temporary: path.join(controller, "tmp") };
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true });
  const events: string[] = []; let retired = false, cleanupFails = false;
  const actual = await import("../../app/main/agent/windows-controller-storage");
  const storage: PrivateControllerStorage = { paths,
    verify: vi.fn(() => { events.push("verify"); for (const directory of Object.values(paths)) if (!fs.statSync(directory).isDirectory()) throw new Error("synthetic fixed path changed"); }),
    retire: vi.fn(() => { retired = true; events.push("retire"); }),
    close: vi.fn(async () => { retired = true; events.push("storage-close"); if (cleanupFails) throw new actual.WindowsControllerStorageCleanupError(); fs.rmSync(controller, { recursive: true }); }),
  };
  const allocate = vi.fn(async () => { events.push("allocate"); if (retired) throw new actual.WindowsControllerStorageCleanupError(); return storage; });
  vi.doMock("../../app/main/agent/windows-controller-storage", () => ({ ...actual, allocateWindowsControllerStorage: allocate }));
  const runtime = await import("../../app/main/agent/private-controller-runtime");
  const input = { userData: root, runtimePath: path.join(root, "synthetic-runtime"), env: { PATH: "/trusted/bin", HOME: "/ambient/home", NODE_OPTIONS: "--require=bad-loader" } };
  return { ...runtime, input, paths, storage, events, allocate, failCleanup: () => { cleanupFails = true; } };
}

it("retires Windows storage before waiting for SDK stop and removes it only after actual stop completion", async () => {
  const f = await setup(), gate = deferred(); let captured: CopilotClientOptions | undefined;
  const client = { start: vi.fn(async () => { f.events.push("start"); }), stop: vi.fn(async () => { f.events.push("stop"); await gate.promise; return []; }) };
  const owner = await f.PrivateControllerRuntime.start(f.input, undefined, options => { captured = options; return client as unknown as CopilotClient; });
  expect(captured?.workingDirectory).toBe(f.paths.cwd); expect(captured?.baseDirectory).toBe(f.paths.state);
  expect(captured?.env).toMatchObject({ HOME: f.paths.home, USERPROFILE: f.paths.home, APPDATA: f.paths.home, TEMP: f.paths.temporary }); expect(captured?.env).not.toHaveProperty("NODE_OPTIONS");
  const closing = owner.close(); expect(owner.close()).toBe(closing);
  expect(f.events.at(-1)).toBe("retire"); await vi.waitFor(() => expect(client.stop).toHaveBeenCalledTimes(1));
  expect(f.events.indexOf("retire")).toBeLessThan(f.events.indexOf("stop")); expect(f.storage.close).not.toHaveBeenCalled(); expect(fs.existsSync(f.paths.root)).toBe(true);
  await expect(f.PrivateControllerRuntime.start(f.input, undefined, () => client as unknown as CopilotClient)).rejects.toBeInstanceOf(f.PrivateControllerCleanupError);
  gate.resolve(); await closing;
  expect(f.events.at(-1)).toBe("storage-close"); expect(client.stop).toHaveBeenCalledTimes(1); expect(f.storage.close).toHaveBeenCalledTimes(1); expect(fs.existsSync(f.paths.root)).toBe(false);
});

it("drains a late SDK startup and its stop after startup abort before releasing private storage", async () => {
  const f = await setup(), started = deferred(), stopped = deferred(), signal = new AbortController();
  const client = { start: vi.fn(() => started.promise), stop: vi.fn(async () => { await stopped.promise; return []; }) };
  let settled = false;
  const pending = f.PrivateControllerRuntime.start(f.input, signal.signal, () => client as unknown as CopilotClient);
  const outcome = pending.then(value => ({ value }), error => ({ error })); void outcome.then(() => { settled = true; });
  await vi.waitFor(() => expect(client.start).toHaveBeenCalledTimes(1)); signal.abort();
  await Promise.resolve(); expect(settled).toBe(false); expect(f.storage.close).not.toHaveBeenCalled();
  started.resolve(); await vi.waitFor(() => expect(client.stop).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false); expect(f.storage.close).not.toHaveBeenCalled(); stopped.resolve();
  expect(await outcome).toMatchObject({ error: { name: "AbortError" } }); expect(f.storage.close).toHaveBeenCalledTimes(1);
});

it("retains a failed SDK startup when stop cannot be verified and keeps later starts typed as cleanup failures", async () => {
  const f = await setup(), client = { start: async () => { throw new Error("synthetic SDK startup failure"); }, stop: async () => [new Error("synthetic SDK stop failure")] } as unknown as CopilotClient;
  await expect(f.PrivateControllerRuntime.start(f.input, undefined, () => client)).rejects.toBeInstanceOf(f.PrivateControllerCleanupError);
  expect(f.storage.retire).toHaveBeenCalledTimes(1); expect(f.storage.close).not.toHaveBeenCalled(); expect(fs.existsSync(f.paths.root)).toBe(true);
  const create = vi.fn(() => client);
  await expect(f.PrivateControllerRuntime.start(f.input, undefined, create)).rejects.toMatchObject({ code: "private-controller-cleanup-unverified" });
  expect(create).not.toHaveBeenCalled(); expect(f.storage.close).not.toHaveBeenCalled();
});

it("preserves typed uncertain cleanup before a runtime owner is assigned", async () => {
  const f = await setup(); f.failCleanup();
  await expect(f.PrivateControllerRuntime.start(f.input, undefined, () => { throw new Error("synthetic SDK factory failure"); })).rejects.toBeInstanceOf(f.PrivateControllerCleanupError);
  expect(f.storage.close).toHaveBeenCalledTimes(1); expect(fs.existsSync(f.paths.root)).toBe(true);
  await expect(f.PrivateControllerRuntime.start(f.input, undefined, vi.fn())).rejects.toMatchObject({ code: "private-controller-cleanup-unverified" });
});

it("waits for successful SDK stop but retains storage when its owned cleanup fails", async () => {
  const f = await setup(), client = { start: async () => undefined, stop: vi.fn(async () => []) } as unknown as CopilotClient;
  const owner = await f.PrivateControllerRuntime.start(f.input, undefined, () => client); f.failCleanup();
  const closing = owner.close(); await expect(closing).rejects.toBeInstanceOf(f.PrivateControllerCleanupError); expect(owner.close()).toBe(closing);
  expect(client.stop).toHaveBeenCalledTimes(1); expect(f.storage.close).toHaveBeenCalledTimes(1); expect(fs.existsSync(f.paths.root)).toBe(true);
});
