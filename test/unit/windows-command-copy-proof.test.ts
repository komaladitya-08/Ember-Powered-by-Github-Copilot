/** Regression for the actual global test teardown: uncertain native scratch must live outside its deletion tree. */
import { describe, expect, it } from "vitest";
import { beginWindowsCommandCopyProof, observeWindowsCommandCopyFactory, observeWindowsCommandCopyTree, requireWindowsCommandCopyScratchParent } from "../fixtures/windows-command-copy-proof";
import type { FreshWindowsCommandTree, FreshWindowsCommandTreeInput } from "../../app/main/agent/windows-command-copy-native";
import type { CodingExportEntry } from "../../app/main/agent/coding-result-export";

describe("native root-only witness scratch lifetime", () => {
  it.each([
    ["D:\\runner-temp", "C:\\Users\\runner\\Temp\\ember-run-123"],
    ["C:\\temp\\native", "C:\\temp\\ember-run-123"],
    ["C:\\temp2", "C:\\temp"],
  ])("accepts disjoint canonical scratch %s", (parent, managed) => {
    expect(() => requireWindowsCommandCopyScratchParent(parent, managed)).not.toThrow();
  });
  it.each([
    ["C:\\temp\\ember-run-123", "C:\\temp\\ember-run-123"],
    ["c:\\TEMP\\EMBER-RUN-123\\native", "C:\\temp\\ember-run-123"],
    ["C:\\temp", "C:\\temp\\ember-run-123"],
    ["C:\\temp\\ember-run-123\\native", "C:\\temp\\ember-run-123"],
    ["relative", "C:\\temp"],
    ["C:\\native", "relative"],
    ["\\\\server\\scratch", "C:\\temp"],
    ["C:\\native\\..\\temp", "D:\\managed"],
    ["C:\\native\n", "D:\\managed"],
  ])("refuses managed teardown overlap or unsupported scratch %s", (parent, managed) => {
    expect(() => requireWindowsCommandCopyScratchParent(parent, managed)).toThrow("native scratch parent");
  });
});

describe("first copy phase failure witness", () => {
  it.each([0, 1, 2, 3])("preserves original boundary %i and never advances after its failure", async refused => {
    const entries: CodingExportEntry[] = Array.from({ length: 6 }, (_, i) => ({ path: `fixed-${i}`, kind: "directory" })), phases: number[] = [], calls: string[] = [];
    const error = new Error("Fixed synthetic boundary rejection");
    const actual = { selected: { async files<T>(operation: (entries: readonly CodingExportEntry[]) => Promise<T>): Promise<T> {
      calls.push("snapshot"); if (refused === 2) throw error; return operation(entries);
    } } };
    const running = beginWindowsCommandCopyProof(async () => { calls.push("factory"); if (refused === 1) throw error; return actual; }, async copy => {
      expect(copy).toBe(actual); calls.push("launch"); if (refused === 3) throw error;
    }, value => { phases.push(value); });
    if (refused) await expect(running).rejects.toBe(error); else await expect(running).resolves.toBe(actual);
    expect(phases).toEqual(Array.from({ length: refused || 3 }, (_, i) => i + 1));
    expect(calls).toEqual(["factory", "snapshot", "launch"].slice(0, refused || 3));
  });
});

describe("actual tree error observation", () => {
  const check = () => undefined, sid = "S-1-15-2-100-200";
  const rows = [
    { name: "assertPrivate", invoke: (tree: FreshWindowsCommandTree) => tree.assertPrivate(), args: [] },
    { name: "grant", invoke: (tree: FreshWindowsCommandTree) => tree.grant(sid, check), args: [sid, check] },
    { name: "revoke", invoke: (tree: FreshWindowsCommandTree) => tree.revoke(sid), args: [sid] },
    { name: "snapshot", invoke: (tree: FreshWindowsCommandTree) => tree.snapshot(check), args: [check] },
    { name: "close", invoke: (tree: FreshWindowsCommandTree) => tree.close(), args: [] },
  ];
  function setup(failed?: string, synchronous = false, observationFails = false) {
    const calls: { name: string; args: unknown[] }[] = [], observations: unknown[] = [], error = new Error("Fixed private synthetic error"), entries = Object.freeze([]);
    const call = (name: string, args: unknown[]) => {
      calls.push({ name, args });
      if (name === failed) { if (synchronous) throw error; return Promise.reject(error); }
      return Promise.resolve(name === "snapshot" ? entries : undefined);
    };
    const actual = { directory: "C:\\fixed-synthetic-work", assertPrivate: () => call("assertPrivate", []), grant: (value: string, guard?: () => void) => call("grant", [value, guard]),
      revoke: (value: string) => call("revoke", [value]), snapshot: (guard?: () => void) => call("snapshot", [guard]), close: () => call("close", []) } as FreshWindowsCommandTree;
    const observed = observeWindowsCommandCopyTree(actual, value => { observations.push(value); if (observationFails) throw new Error("Fixed rejected diagnostic"); });
    return { observed, actual, calls, observations, error, entries };
  }
  it("preserves each exact delegate argument and resolved snapshot without an additional operation", async () => {
    const state = setup(); expect(state.observed.directory).toBe(state.actual.directory);
    for (const row of rows) {
      const result = await row.invoke(state.observed);
      expect(result).toBe(row.name === "snapshot" ? state.entries : undefined);
    }
    expect(state.calls).toEqual(rows.map(row => ({ name: row.name, args: row.args }))); expect(state.observations).toEqual([]);
  });
  it.each(rows)("observes the original $name rejection once without retrying or invoking cleanup", async row => {
    const state = setup(row.name); await expect(row.invoke(state.observed)).rejects.toBe(state.error);
    expect(state.calls).toEqual([{ name: row.name, args: row.args }]); expect(state.observations).toEqual([state.error]);
  });
  it("preserves synchronous throws and performs no speculative close", () => {
    const state = setup("grant", true); let caught: unknown;
    try { state.observed.grant(sid, check); } catch (error) { caught = error; }
    expect(caught).toBe(state.error);
    expect(state.calls).toEqual([{ name: "grant", args: [sid, check] }]); expect(state.observations).toEqual([state.error]);
  });
  it("preserves the native failure when diagnostic observation itself fails", async () => {
    const state = setup("snapshot", false, true); await expect(state.observed.snapshot(check)).rejects.toBe(state.error);
    expect(state.calls).toEqual([{ name: "snapshot", args: [check] }]); expect(state.observations).toEqual([state.error]);
  });
  it.each([false, true])("preserves an actual factory failure when its observer throws, synchronous=%s", async synchronous => {
    const state = setup(), input: FreshWindowsCommandTreeInput = { parent: "C:\\scratch", protectedPaths: ["C:\\source"], entries: [], current: () => true };
    let factories = 0;
    await expect(observeWindowsCommandCopyFactory(input, actual => {
      expect(actual).toBe(input); factories++;
      if (synchronous) throw state.error; return Promise.reject(state.error);
    }, error => { expect(error).toBe(state.error); throw new Error("Fixed failed diagnostic"); })).rejects.toBe(state.error);
    expect(factories).toBe(1); expect(state.calls).toEqual([]);
  });
  it("wraps the exact successful factory without reading or invoking a native method", async () => {
    const state = setup(), input: FreshWindowsCommandTreeInput = { parent: "C:\\scratch", protectedPaths: ["C:\\source"], entries: [], current: () => true };
    const observed = await observeWindowsCommandCopyFactory(input, async actual => { expect(actual).toBe(input); return state.actual; }, error => { state.observations.push(error); });
    expect(observed.directory).toBe(state.actual.directory); expect(state.calls).toEqual([]); expect(state.observations).toEqual([]);
    expect(await observed.snapshot(check)).toBe(state.entries); expect(state.calls).toEqual([{ name: "snapshot", args: [check] }]);
  });
});
