import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { WINDOWS_HOME_OFF_SUMMARY_PHRASES, observeWindowsHomeOffStatus, observeWindowsHomeOffFailure, windowsHomeOffFailureTuple,
  type WindowsHomeOffFailureState } from "../fixtures/windows-home-off-continuation-observer";

const state = (): WindowsHomeOffFailureState => ({ index: 2, status: 5, summaryCategory: 6, actions: 8, dispatched: 3,
  steps: [3, 3, 2], firstReads: ["export const answer = 41;", "export const answer = 41;", "export const answer = 43;"] });

describe("files-only Home failure observations", () => {
  it("projects only fixed counts and public fixture value flags, never arbitrary source, paths, IDs or error text", () => {
    const privateText = "PRIVATE window/path/user/model text";
    const input = { ...state(), firstReads: [privateText + " export const answer = 41;", privateText, "export const answer = 42; export const answer = 44;"] };
    const result = windowsHomeOffFailureTuple(input);
    expect(result).toEqual([2, 5, 6, 8, 3, 3, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1]);
    expect(Object.isFrozen(result)).toBe(true); expect(JSON.stringify(result)).not.toContain(privateText);
    expect(result.every(value => typeof value === "number" && Number.isSafeInteger(value))).toBe(true);
  });

  it.each([NaN, Infinity, -1, 1.5, "PRIVATE", null, undefined])("bounds invalid count inputs without reflecting %s", value => {
    const projected = windowsHomeOffFailureTuple({ index: value, status: value, summaryCategory: value, actions: value, dispatched: value, steps: [value, value, value], firstReads: [value, value, value] });
    expect(projected).toEqual(Array(20).fill(0));
  });

  it("saturates excessive integer counts at the closed tuple's explicit maxima", () => {
    expect(windowsHomeOffFailureTuple({ index: 100, status: 100, summaryCategory: 100, actions: 100, dispatched: 100, steps: [100, 100, 100], firstReads: [] }))
      .toEqual([0, 0, 0, 9, 3, 3, 3, 3, ...Array(12).fill(0)]);
  });

  it.each([undefined, "queued", "running", "waiting", "done", "failed", "stopped", "PRIVATE status"])("returns the exact original poll value %s and caches only enums", status => {
    const record = vi.fn();
    expect(observeWindowsHomeOffStatus(status, 6, record)).toBe(status);
    expect(record).toHaveBeenCalledWith({ status: ["queued", "running", "waiting", "done", "failed", "stopped"].indexOf(status as string) + 1, summaryCategory: 6 });
    expect(Object.isFrozen(record.mock.calls[0][0])).toBe(true);
    expect(observeWindowsHomeOffStatus(status, 6, () => { throw new Error("PRIVATE observer error"); })).toBe(status);
  });

  it("does not inspect unknown poll values, original error fields or exception getters", () => {
    const getter = vi.fn(() => { throw new Error("PRIVATE getter"); });
    const opaque = new Proxy({}, { get: getter });
    expect(observeWindowsHomeOffStatus(opaque, undefined, () => {})).toBe(opaque);
    const emitted = vi.fn(); let caught: unknown;
    try { observeWindowsHomeOffFailure(opaque, state, emitted); } catch (error) { caught = error; }
    expect(caught).toBe(opaque); expect(getter).not.toHaveBeenCalled();
    expect(emitted).toHaveBeenCalledWith("Windows files-only continuation checkpoint " + JSON.stringify(windowsHomeOffFailureTuple(state())));
  });

  it("preserves the same original failure when snapshot access or emission fails", () => {
    const original = new Error("original poll failure"), emitted = vi.fn(() => { throw new Error("PRIVATE logger error"); });
    for (const snapshot of [state, () => { throw new Error("PRIVATE snapshot error"); }, () => Object.defineProperty(state(), "steps", { get() { throw new Error("PRIVATE map getter"); } })]) {
      let caught: unknown;
      try { observeWindowsHomeOffFailure(original, snapshot, emitted); } catch (error) { caught = error; }
      expect(caught).toBe(original);
    }
  });

  it("keeps the same query count, original 45-second done predicate, later checks and normal cleanup", () => {
    const file = fs.readFileSync(fileURLToPath(new URL("../integration/project-coding-windows-electron.test.ts", import.meta.url)), "utf8");
    const awaitResult = file.slice(file.indexOf("const awaitResult = async"), file.indexOf("const run = async"));
    expect(awaitResult.match(/window\.ember\.projectSessionsState\(\)/g)).toHaveLength(2);
    expect(awaitResult.match(/timeout: 45_000/g)).toHaveLength(1);
    expect(awaitResult).toContain('.toBe("done")');
    expect(awaitResult.match(/timeout: 15_000/g)).toHaveLength(2);
    expect(awaitResult).not.toContain('status === "failed"');
    expect(file).toContain("}, 180_000);"); expect(file).toContain("await closeTestElectron(app)");
    expect(WINDOWS_HOME_OFF_SUMMARY_PHRASES[5]).toBe("The coding task ended, but its review could not be published. The original folder is unchanged.");
    expect(file).toContain('firstReads.get(scenarios[2].goal)).not.toContain("export const answer = 41;")');
  });

  it("runs the preservation workflow for independent observer changes without adding another trigger", () => {
    const file = fs.readFileSync(fileURLToPath(new URL("../../.github/workflows/experimental-windows-controller.yml", import.meta.url)), "utf8");
    const triggers = file.slice(file.indexOf("\non:"), file.indexOf("\npermissions:"));
    expect(triggers.match(/^ {2}[a-z_]+:/gm)).toEqual(["  workflow_dispatch:", "  pull_request:"]);
    for (const path of ["test/fixtures/windows-home-off-continuation-observer.ts", "test/unit/windows-home-off-continuation-observer.test.ts"]) {
      expect(triggers.split(`      - "${path}"`)).toHaveLength(2);
    }
    expect(file).toContain("node scripts/run-integration.mjs test/integration/project-coding-windows-electron.test.ts --maxWorkers=1");
    expect(file).toContain("EMBER_ELECTRON_WINDOWS_CODING_TEST:");
  });
});
