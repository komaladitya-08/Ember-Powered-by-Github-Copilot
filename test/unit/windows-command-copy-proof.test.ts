/** Regression for the actual global test teardown: uncertain native scratch must live outside its deletion tree. */
import { describe, expect, it } from "vitest";
import { beginWindowsCommandCopyProof, classifyWindowsCommandCopyFileFailure, observeWindowsCommandCopyBoundary, observeWindowsCommandCopyFactory, observeWindowsCommandCopyStopOwner,
  observeWindowsCommandCopyTree, requireWindowsCommandCopyNaturalExit, requireWindowsCommandCopyScratchParent } from "../fixtures/windows-command-copy-proof";
import type { FreshWindowsCommandTree, FreshWindowsCommandTreeInput } from "../../app/main/agent/windows-command-copy-native";
import type { CodingExportEntry } from "../../app/main/agent/coding-result-export";
import type { WindowsCommandRootOnlyStoppedRef, WindowsCommandRootOnlyStopOwner } from "../../app/main/agent/windows-command-stop";
import { ScopedCodingFileError, type ScopedCodingFileFailure } from "../../app/main/agent/coding-platform";

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

describe("real Stop/creator/attester error observation", () => {
  it.each([1, 3, 4] as const)("preserves synchronous boundary%i success/error identity even when observation fails", boundary => {
    const result = Object.freeze({ synthetic: true }), error = new Error("Fixed private synthetic error"), seen: unknown[] = [];
    expect(observeWindowsCommandCopyBoundary(boundary, () => result, () => { throw new Error("Success must not notify."); })).toBe(result);
    let caught: unknown;
    try { observeWindowsCommandCopyBoundary(boundary, () => { throw error; }, (kind, original) => { seen.push([kind, original]); throw new Error("Fixed diagnostic failure"); }); }
    catch (value) { caught = value; }
    expect(caught).toBe(error); expect(seen).toEqual([[boundary, error]]);
  });
  function setup(fault?: "launch" | "stop" | "retainStop", synchronous = false, observerFails = false) {
    const calls: { method: string; args: unknown[]; sameReceiver: boolean }[] = [], seen: unknown[] = [], error = new Error("Fixed Stop failure");
    const receipt = Object.freeze({ scope: "root-only" }) as WindowsCommandRootOnlyStoppedRef;
    const actual: WindowsCommandRootOnlyStopOwner = {
      scope: "root-only",
      launch(...args) { calls.push({ method: "launch", args, sameReceiver: this === actual }); if (fault === "launch") { if (synchronous) throw error; return Promise.reject(error); } return Promise.resolve(7); },
      stop(...args) { calls.push({ method: "stop", args, sameReceiver: this === actual }); if (fault === "stop") return Promise.reject(error); return Promise.resolve(receipt); },
      retainStop() { calls.push({ method: "retainStop", args: [], sameReceiver: this === actual }); if (fault === "retainStop") throw error; },
    };
    const observed = observeWindowsCommandCopyStopOwner(actual, (boundary, original) => { seen.push([boundary, original]); if (observerFails) throw new Error("Fixed diagnostic failure"); });
    return { actual, observed, calls, seen, receipt, error };
  }
  const create = () => ({ process: 10n, thread: 11n, pid: 7 }), attest = () => undefined, current = () => true;
  it("preserves exact receiver/arguments, numeric result and the same opaque receipt with no speculative call", async () => {
    const state = setup(); expect(await state.observed.launch(create, attest, current)).toBe(7);
    expect(await state.observed.stop(15000)).toBe(state.receipt); expect(await state.observed.stop()).toBe(state.receipt);
    expect(state.observed.retainStop()).toBeUndefined(); expect(state.observed.scope).toBe("root-only");
    expect(state.calls).toEqual([{ method: "launch", args: [create, attest, current], sameReceiver: true }, { method: "stop", args: [15000], sameReceiver: true },
      { method: "stop", args: [], sameReceiver: true }, { method: "retainStop", args: [], sameReceiver: true }]); expect(state.seen).toEqual([]);
  });
  it.each([false, true])("preserves original launch rejection when observerThrows=%s", async observerFails => {
    const state = setup("launch", false, observerFails); await expect(state.observed.launch(create, attest, current)).rejects.toBe(state.error);
    expect(state.calls).toEqual([{ method: "launch", args: [create, attest, current], sameReceiver: true }]); expect(state.seen).toEqual([[2, state.error]]);
  });
  it("preserves a synchronous launch error without an extra Stop or close", () => {
    const state = setup("launch", true, true); let caught: unknown;
    try { state.observed.launch(create, attest, current); } catch (error) { caught = error; }
    expect(caught).toBe(state.error); expect(state.calls).toHaveLength(1); expect(state.seen).toEqual([[2, state.error]]);
  });
  it("records a stopped-owner rejection without inventing a launch boundary or consuming the receipt", async () => {
    const state = setup("stop", false, true); await expect(state.observed.stop(15000)).rejects.toBe(state.error);
    expect(state.calls).toEqual([{ method: "stop", args: [15000], sameReceiver: true }]); expect(state.seen).toEqual([[0, state.error]]);
  });
  it("preserves a retainStop error without retry or another native operation", () => {
    const state = setup("retainStop", false, true); let caught: unknown;
    try { state.observed.retainStop(); } catch (error) { caught = error; }
    expect(caught).toBe(state.error); expect(state.calls).toEqual([{ method: "retainStop", args: [], sameReceiver: true }]); expect(state.seen).toEqual([[0, state.error]]);
  });
  it.each([3, 4] as const)("keeps inner boundary%i before the outer launch rejection", async boundary => {
    const error = new Error("Fixed inner boundary error"), seen: unknown[] = []; let first = 0;
    const capture = (kind: number, original: unknown) => { if (!first && kind) first = kind; seen.push([kind, original]); };
    const actual: WindowsCommandRootOnlyStopOwner = { scope: "root-only", async launch(create, attest) { const root = create(); attest(root); return root.pid; },
      async stop() { throw new Error("The observer must not stop a failed launch."); }, retainStop() { throw new Error("The observer must not retain a failed launch."); } };
    const observed = observeWindowsCommandCopyStopOwner(actual, capture);
    await expect(observed.launch(() => boundary === 3 ? observeWindowsCommandCopyBoundary(3, () => { throw error; }, capture) : create(),
      root => { expect(root.pid).toBe(7); observeWindowsCommandCopyBoundary(4, () => { throw error; }, capture); }, current)).rejects.toBe(error);
    expect(first).toBe(boundary); expect(seen).toEqual([[boundary, error], [2, error]]);
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
    expect(phases).toEqual(Array.from({ length: refused || 4 }, (_, i) => i + 1));
    expect(calls).toEqual(["factory", "snapshot", "launch"].slice(0, refused || 3));
  });
  it.each([false, true])("enters postlaunch subphase4 only after successful launch settlement, rejects=%s", async rejects => {
    let resolve!: () => void, reject!: (error: Error) => void, entered!: () => void;
    const launch = new Promise<void>((yes, no) => { resolve = yes; reject = no; }), atLaunch = new Promise<void>(yes => { entered = yes; });
    const phases: number[] = [], error = new Error("Fixed launch failure");
    const selected = { async files<T>(operation: (entries: readonly CodingExportEntry[]) => Promise<T>): Promise<T> {
      return operation(Array.from({ length: 6 }, (_, i) => ({ path: `fixed-${i}`, kind: "directory" })));
    } };
    const running = beginWindowsCommandCopyProof(async () => ({ selected }), () => launch, phase => { phases.push(phase); if (phase === 3) entered(); });
    await atLaunch; expect(phases).toEqual([1, 2, 3]);
    if (rejects) { reject(error); await expect(running).rejects.toBe(error); expect(phases).toEqual([1, 2, 3]); }
    else { resolve(); await running; expect(phases).toEqual([1, 2, 3, 4]); }
  });
});

describe("closed exact-constructor file failure classification", () => {
  const codes: ScopedCodingFileFailure[] = ["unavailable", "cancelled", "path", "boundary", "unsupported", "privacy", "binary", "secret", "limit", "missing", "exists", "conflict", "ambiguous", "not-empty", "io"];
  it.each(codes)("classifies only the known own data code %s", code => {
    expect(classifyWindowsCommandCopyFileFailure(new ScopedCodingFileError(code), ScopedCodingFileError)).toBe(codes.indexOf(code) + 1);
  });
  it.each([null, undefined, 1, "boundary", {}, { name: "ScopedCodingFileError", code: "boundary" }, Object.assign(new Error("Fixed secret"), { name: "ScopedCodingFileError", code: "boundary" })])("refuses structural/foreign error values %#", value => {
    expect(classifyWindowsCommandCopyFileFailure(value, ScopedCodingFileError)).toBe(0);
  });
  it.each(["unknown-private-code", "__proto__", "constructor", "toString"])("does not forward unknown code %s", value => {
    const error = new ScopedCodingFileError("boundary"); Object.defineProperty(error, "code", { value });
    expect(classifyWindowsCommandCopyFileFailure(error, ScopedCodingFileError)).toBe(0);
  });
  it("does not invoke code/message getters or coerce a malformed code", () => {
    let reads = 0; const error = new ScopedCodingFileError("boundary");
    Object.defineProperty(error, "message", { get() { reads++; throw new Error("Private message"); } });
    expect(classifyWindowsCommandCopyFileFailure(error, ScopedCodingFileError)).toBe(4);
    Object.defineProperty(error, "code", { get() { reads++; throw new Error("Private code"); }, configurable: true });
    expect(classifyWindowsCommandCopyFileFailure(error, ScopedCodingFileError)).toBe(0);
    Object.defineProperty(error, "code", { value: { toString() { reads++; return "boundary"; } } });
    expect(classifyWindowsCommandCopyFileFailure(error, ScopedCodingFileError)).toBe(0); expect(reads).toBe(0);
  });
  it("refuses trapping proxies without replacing the authoritative original error", () => {
    const prototypeTrap = new Proxy({}, { getPrototypeOf() { throw new Error("Private prototype"); } });
    const descriptorTrap = new Proxy(new ScopedCodingFileError("boundary"), { getOwnPropertyDescriptor() { throw new Error("Private descriptor"); } });
    expect(classifyWindowsCommandCopyFileFailure(prototypeTrap, ScopedCodingFileError)).toBe(0);
    expect(classifyWindowsCommandCopyFileFailure(descriptorTrap, ScopedCodingFileError)).toBe(0);
  });
});

describe("existing exact-zero natural exit gate", () => {
  it.each([0, -0])("preserves zero acceptance and the single returned value %#", value => {
    let calls = 0; const seen: number[] = [];
    expect(() => requireWindowsCommandCopyNaturalExit(() => { calls++; return value; }, code => { seen.push(code); })).not.toThrow();
    expect(calls).toBe(1); expect(seen).toHaveLength(1); expect(Object.is(seen[0], value)).toBe(true);
  });
  it.each([1, 101, 0xc0000142, 0xffffffff])("captures returned DWORD%s while retaining the original refusal", value => {
    let calls = 0; const seen: number[] = [];
    expect(() => requireWindowsCommandCopyNaturalExit(() => { calls++; return value; }, code => { seen.push(code); })).toThrow("fixed root-only observation");
    expect(calls).toBe(1); expect(seen).toEqual([value]);
  });
  it.each([undefined, null, true, false, "0", 0n, -1, 0.5, NaN, Infinity, 0x100000000, {}, new Proxy({}, { get() { throw new Error("Private getter"); } })])("omits malformed status without coercion or altered acceptance %#", value => {
    let calls = 0; const seen: number[] = [];
    expect(() => requireWindowsCommandCopyNaturalExit(() => { calls++; return value; }, code => { seen.push(code); })).toThrow("fixed root-only observation");
    expect(calls).toBe(1); expect(seen).toEqual([]);
  });
  it("preserves a query/getter exception exactly without recording a guessed status", () => {
    const error = new Error("Fixed private query failure"), record = { get code(): number { throw error; } }, seen: number[] = []; let caught: unknown;
    try { requireWindowsCommandCopyNaturalExit(() => record.code, code => { seen.push(code); }); } catch (failure) { caught = failure; }
    expect(caught).toBe(error); expect(seen).toEqual([]);
  });
  it.each([0, 1])("diagnostic callback failure cannot change the zero gate for%s", value => {
    const run = () => requireWindowsCommandCopyNaturalExit(() => value, () => { throw new Error("Fixed observer failure"); });
    if (value === 0) expect(run).not.toThrow(); else expect(run).toThrow("fixed root-only observation");
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
