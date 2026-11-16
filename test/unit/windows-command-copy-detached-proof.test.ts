/** Exercises the detached witness's real setup boundary without acquiring Windows authority or releasing retained owners. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  events: [] as string[], fault: "", exports: {} as Record<string, unknown>, api: {} as Record<string, unknown>,
  error: new Error("Private synthetic setup material"),
  baseline: vi.fn(), detached: vi.fn(),
}));
vi.mock("node:module", () => ({ createRequire: vi.fn((file: string) => {
  boundary.events.push("require-factory"); expect(file).toBe("D:\\fixed\\root-only.cjs");
  if (boundary.fault === "require-factory") throw boundary.error;
  return (selected: string) => {
    boundary.events.push("require-module"); expect(selected).toBe(file);
    if (boundary.fault === "require-module") throw boundary.error;
    return boundary.exports;
  };
}) }));
vi.mock("../fixtures/windows-command-copy-detached-loader", () => ({ loadWindowsRootCopyDetachedApi: boundary.detached }));
vi.mock("../../app/main/agent/experimental-windows-lpac-api", async importOriginal => ({
  ...await importOriginal<typeof import("../../app/main/agent/experimental-windows-lpac-api")>(),
  loadExperimentalWindowsLpacApi: boundary.baseline,
}));

import { observeWindowsCommandCopyDetached, WindowsCommandCopyObservationError } from "../fixtures/windows-command-copy-detached-proof";

class CopyCleanup extends Error {}
class StopCleanup extends Error {}
class TreeCleanup extends Error {}
class ProofCleanup extends Error {}
class FileFailure extends Error { constructor(readonly code: string) { super("Private synthetic file material"); } }

const asset = Object.freeze({ executable: "D:\\fixed\\root-only.exe", module: "D:\\fixed\\root-only.cjs" });
const required = ["WindowsRootOnlyCommandCopy", "createWindowsCommandRootOnlyStopOwner", "requireWindowsCommandRootOnlyStopped", "createFreshWindowsCommandTree",
  "loadWindowsCommandCopyProofNative", "WindowsCommandCopyProofCleanupError", "WindowsCommandCopyCleanupError", "WindowsCommandRootOnlyCleanupError",
  "WindowsRootOnlyCommandCopyCleanupError", "windowsCommandCopyNativeFailure", "windowsCommandRootOnlyFailure", "ScopedCodingFileError"] as const;
const prefix = ["verify:1", "require-factory", "require-module", "native", "pin:module", "pin:image", "verify:2", "unchanged:module", "unchanged:image"];

function setup() {
  let verification = 0;
  const hit = (event: string) => { boundary.events.push(event); if (boundary.fault === event) throw boundary.error; };
  const verify = vi.fn(() => hit(`verify:${++verification}`));
  const modulePin = { unchanged: vi.fn(() => hit("unchanged:module")), read: vi.fn(), close: vi.fn() };
  const imagePin = { unchanged: vi.fn(() => hit("unchanged:image")), read: vi.fn(), close: vi.fn() };
  const native = {
    pin: vi.fn((file: string, maximum: number) => {
      expect(maximum).toBe(16 * 1024 * 1024); expect([asset.module, asset.executable]).toContain(file);
      hit(file === asset.module ? "pin:module" : "pin:image"); return file === asset.module ? modulePin : imagePin;
    }),
    guard: vi.fn(<T>(operation: () => T): T => { hit("guard"); return operation(); }),
    close: vi.fn(), deleteProfile: vi.fn(), image: vi.fn(), unsafe: false,
  };
  const profile = Object.freeze({ sidText: "S-1-15-2-1", sid: 10n });
  const api = {
    createProfile: vi.fn((name: string) => { expect(name).toMatch(/^Ember\.RootOnly\.[\da-f-]{36}$/); hit("create-profile"); return profile; }),
    ownerSid: vi.fn(() => { hit("owner"); throw boundary.error; }),
    deleteProfile: vi.fn(), close: vi.fn(), terminateJob: vi.fn(), terminateProcess: vi.fn(),
  };
  boundary.api = api;
  boundary.exports = Object.fromEntries(required.map(key => [key, vi.fn(() => { throw new Error("Unexpected emitted operation"); })]));
  Object.assign(boundary.exports, {
    loadWindowsCommandCopyProofNative: vi.fn(() => { hit("native"); return native; }),
    WindowsRootOnlyCommandCopyCleanupError: CopyCleanup, WindowsCommandRootOnlyCleanupError: StopCleanup,
    WindowsCommandCopyCleanupError: TreeCleanup, WindowsCommandCopyProofCleanupError: ProofCleanup, ScopedCodingFileError: FileFailure,
  });
  boundary.detached.mockImplementation(() => { hit("detached-loader"); return boundary.api; });
  boundary.baseline.mockImplementation(() => { throw new Error("The baseline default loader must never be selected."); });
  return { verify, native, modulePin, imagePin, api, profile, emitted: { ...boundary.exports } };
}
type State = ReturnType<typeof setup>;
async function refused(state: State) {
  let caught: unknown;
  try { await observeWindowsCommandCopyDetached(asset, state.verify, "D:\\native-scratch"); }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(WindowsCommandCopyObservationError);
  if (!(caught instanceof WindowsCommandCopyObservationError)) throw new Error("The observation did not refuse safely.");
  expect(caught.subphase).toBe(0); expect(caught.boundary).toBe(0);
  expect(caught.native).toBeUndefined(); expect(caught.stop).toBeUndefined(); expect(caught.exit).toBeUndefined(); expect(caught.failedReport).toBeUndefined();
  expect(caught.stack).toBe(`${caught.name}: ${caught.message}`);
  expect(caught.message).not.toContain("Private"); expect(caught.message).not.toContain("D:\\");
  return caught;
}
function held(state: State) {
  expect(boundary.baseline).not.toHaveBeenCalled();
  for (const pin of [state.modulePin, state.imagePin]) { expect(pin.read).not.toHaveBeenCalled(); expect(pin.close).not.toHaveBeenCalled(); }
  for (const call of [state.native.close, state.native.deleteProfile, state.native.image, state.api.deleteProfile, state.api.close,
    state.api.terminateJob, state.api.terminateProcess]) expect(call).not.toHaveBeenCalled();
  for (const key of ["WindowsRootOnlyCommandCopy", "createWindowsCommandRootOnlyStopOwner", "requireWindowsCommandRootOnlyStopped", "createFreshWindowsCommandTree",
    "windowsCommandCopyNativeFailure", "windowsCommandRootOnlyFailure"] as const) expect(state.emitted[key]).not.toHaveBeenCalled();
}
beforeEach(() => {
  boundary.events.length = 0; boundary.fault = ""; boundary.error = new Error("Private synthetic setup material");
  boundary.detached.mockReset(); boundary.baseline.mockReset();
});

describe("detached root-copy proof's actual default-loader boundary", () => {
  it("verifies the emitted module and image twice and holds both unchanged pins before selecting only the dedicated loader", async () => {
    const state = setup(), failure = await refused(state);
    expect(boundary.events).toEqual([...prefix, "detached-loader", "guard", "create-profile", "guard", "owner"]);
    expect(failure.phase).toBe(2); expect(failure.ownership).toBe(0); expect(failure.fileCode).toBe(0);
    expect(state.native.pin.mock.calls).toEqual([[asset.module, 16 * 1024 * 1024], [asset.executable, 16 * 1024 * 1024]]);
    expect(boundary.detached).toHaveBeenCalledExactlyOnceWith(); expect(state.api.createProfile).toHaveBeenCalledTimes(1);
    expect(state.api.ownerSid).toHaveBeenCalledExactlyOnceWith(); held(state);
  });
  it.each(prefix)("never selects either native loader when the existing %s check fails", async event => {
    boundary.fault = event; const state = setup(), failure = await refused(state);
    expect(boundary.events).toEqual(prefix.slice(0, prefix.indexOf(event) + 1));
    expect(failure.phase).toBe(1); expect(failure.ownership).toBe(0);
    expect(boundary.detached).not.toHaveBeenCalled(); expect(state.api.createProfile).not.toHaveBeenCalled(); held(state);
  });
  it.each(required)("requires emitted export %s before loading native owners or the detached API", async key => {
    const state = setup(); boundary.exports[key] = {};
    const failure = await refused(state);
    expect(boundary.events).toEqual(prefix.slice(0, 3)); expect(failure.phase).toBe(1);
    expect(state.native.pin).not.toHaveBeenCalled(); expect(boundary.detached).not.toHaveBeenCalled(); held(state);
  });
  it("retains both verified pins when the dedicated default loader refuses, without a baseline fallback or profile acquisition", async () => {
    boundary.fault = "detached-loader"; const state = setup(), failure = await refused(state);
    expect(boundary.events).toEqual([...prefix, "detached-loader"]); expect(failure.phase).toBe(2);
    expect(state.api.createProfile).not.toHaveBeenCalled(); expect(state.native.guard).not.toHaveBeenCalled(); held(state);
  });
  it("does not continue or attempt disposal after guarded profile acquisition refuses", async () => {
    boundary.fault = "create-profile"; const state = setup(), failure = await refused(state);
    expect(boundary.events).toEqual([...prefix, "detached-loader", "guard", "create-profile"]);
    expect(failure.phase).toBe(2); expect(state.api.ownerSid).not.toHaveBeenCalled(); held(state);
  });
  it("does not call profile creation after the native ownership guard refuses", async () => {
    boundary.fault = "guard"; const state = setup(), failure = await refused(state);
    expect(boundary.events).toEqual([...prefix, "detached-loader", "guard"]);
    expect(failure.phase).toBe(2); expect(state.api.createProfile).not.toHaveBeenCalled(); held(state);
  });
  it.each([CopyCleanup, StopCleanup, TreeCleanup, ProofCleanup])("retains the same setup graph and reports only its emitted cleanup constructor class %#", async Constructor => {
    const state = setup(); boundary.error = new Constructor("Private synthetic ownership material");
    const failure = await refused(state);
    expect(failure.phase).toBe(2); expect(failure.ownership).toBe([CopyCleanup, StopCleanup, TreeCleanup, ProofCleanup].indexOf(Constructor) + 1);
    expect(boundary.events.at(-1)).toBe("owner"); held(state);
  });
  it("does not classify a foreign error by name or inspect private error getters", async () => {
    const state = setup(), getter = vi.fn(() => { throw new Error("Private error getter was read."); });
    boundary.error = Object.defineProperties(Object.create(null) as Error, {
      name: { value: "WindowsCommandCopyProofCleanupError" }, message: { get: getter }, stack: { get: getter }, code: { get: getter },
    });
    const failure = await refused(state);
    expect(failure.ownership).toBe(0); expect(failure.fileCode).toBe(0); expect(getter).not.toHaveBeenCalled(); held(state);
  });
  it("preserves the closed emitted file code at the actual setup boundary without exposing its message", async () => {
    const state = setup(); boundary.error = new FileFailure("boundary");
    const failure = await refused(state); expect(failure.fileCode).toBe(4); expect(failure.ownership).toBe(0); held(state);
  });
});
