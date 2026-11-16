/** Regression for the actual global test teardown: uncertain native scratch must live outside its deletion tree. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginWindowsCommandCopyProof, classifyWindowsCommandCopyFileFailure, observeWindowsCommandCopyBoundary, observeWindowsCommandCopyFactory, observeWindowsCommandCopyStopOwner,
  observeWindowsCommandCopyTree, observeWindowsCommandCopyFailedUsefulExit, requireWindowsCommandCopyNaturalExit, requireWindowsCommandCopyScratchParent } from "../fixtures/windows-command-creator-owner-proof";
import type { FreshWindowsCommandTree, FreshWindowsCommandTreeInput, WindowsCommandCreatorGrantRef } from "../../app/main/agent/windows-command-copy-native";
import type { CodingExportEntry } from "../../app/main/agent/coding-result-export";
import type { WindowsCommandRootOnlyStoppedRef, WindowsCommandRootOnlyStopOwner } from "../../app/main/agent/windows-command-stop";
import { ScopedCodingFileError, type ScopedCodingFileFailure } from "../../app/main/agent/coding-platform";
import { WINDOWS_COMMAND_CREATOR_OWNER_REPORT_MAGIC } from "../fixtures/windows-command-creator-owner-report";

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
  it.each([1, 101, 211, 212, 0xc0000142, 0xffffffff])("captures returned DWORD%s while retaining the original refusal", value => {
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

describe("failed useful report has only post-Stop diagnostic authority", () => {
  function failed(mode = 1, status = 2, operation = 5, features = 0xf00) {
    const bytes = Buffer.alloc(128), words = [WINDOWS_COMMAND_CREATOR_OWNER_REPORT_MAGIC, 2, mode, status, operation, features, 5, 5, 5, 5, 0, 0, 0, 5, 0, 0,
      3, 15, 0, 15, 5, 5, 5, 5, 15, 3, 0, 0, 0, 0, 0, 0];
    words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4)); return bytes;
  }
  it("waits for fulfilled Stop/revoke before unchanged pins, acquisition, read and positive close before publishing", async () => {
    const events: string[] = [], seen: unknown[] = [], bytes = failed(), original = new Error("Fixed natural-exit refusal");
    let release!: () => void;
    const stopped = new Promise<void>(resolve => { release = resolve; });
    const running = observeWindowsCommandCopyFailedUsefulExit(original, { phase: 1, code: 1 }, async () => {
      events.push("stop"); await stopped; events.push("revoked");
    }, () => { events.push("unchanged"); }, () => { events.push("acquire"); return {
      read() { events.push("read"); return bytes; }, close() { events.push("close"); expect(bytes.every(byte => byte === 0)).toBe(true); },
    }; }, value => { events.push("observed"); seen.push(value); });
    const rejection = running.catch(error => error);
    await Promise.resolve(); expect(events).toEqual(["stop"]); release(); expect(await rejection).toBe(original);
    expect(events).toEqual(["stop", "revoked", "unchanged", "acquire", "read", "close", "observed"]);
    expect(seen).toEqual([{ mode: 1, status: 2, operation: 5, features: 0xf00, code: 5 }]); expect(Object.isFrozen(seen[0])).toBe(true);
  });
  it.each([undefined, { phase: 1 as const }, ...[1, 211, 212].map(code => ({ phase: 2 as const, code })), ...[0, 101, 210, 213, 0xc0000142, 0xffffffff].map(code => ({ phase: 1 as const, code }))])(
    "does not start Stop or a native report operation for an unmatched exit %#", async exit => {
      const original = new Error("Fixed unmatched refusal"), calls: string[] = [];
      await expect(observeWindowsCommandCopyFailedUsefulExit(original, exit, async () => { calls.push("stop"); }, () => { calls.push("unchanged"); },
        () => { calls.push("acquire"); return { read: () => failed(), close() { calls.push("close"); } }; }, () => { calls.push("observed"); })).rejects.toBe(original);
      expect(calls).toEqual([]);
    });
  it.each(["stop", "unchanged", "acquire", "read", "close", "observed"])("keeps the initial refusal and stops diagnostic work at %s uncertainty", async fault => {
    const original = new Error("Fixed natural-exit refusal"), diagnostic = new Error("Fixed private diagnostic failure"), calls: string[] = [], bytes = failed();
    const at = (stage: string) => { calls.push(stage); if (stage === fault) throw diagnostic; };
    await expect(observeWindowsCommandCopyFailedUsefulExit(original, { phase: 1, code: 1 }, async () => { at("stop"); }, () => { at("unchanged"); },
      () => { at("acquire"); return { read() { at("read"); return bytes; }, close() { at("close"); } }; }, () => { at("observed"); })).rejects.toBe(original);
    expect(calls).toEqual(["stop", "unchanged", "acquire", "read", "close", "observed"].slice(0, ["stop", "unchanged", "acquire", "read", "close", "observed"].indexOf(fault) + 1));
    if (["close", "observed"].includes(fault)) expect(bytes.every(byte => byte === 0)).toBe(true);
  });
  it.each(["complete", "wrong mode", "partial", "bad schema"])("refuses %s as failed-useful evidence, wipes bytes and keeps the initial failure", async fault => {
    const original = new Error("Fixed natural-exit refusal"), calls: string[] = [];
    let bytes = failed();
    if (fault === "complete") {
      bytes.writeUInt32LE(1, 12); bytes.writeUInt32LE(19, 16); bytes.writeUInt32LE(0xfff, 20); bytes.writeUInt32LE(0, 52);
    } else if (fault === "wrong mode") bytes = failed(3);
    else if (fault === "partial") bytes = bytes.subarray(0, 127);
    else bytes.writeUInt32LE(3, 4);
    await expect(observeWindowsCommandCopyFailedUsefulExit(original, { phase: 1, code: 1 }, async () => { calls.push("stop"); }, () => { calls.push("unchanged"); },
      () => { calls.push("acquire"); return { read() { calls.push("read"); return bytes; }, close() { calls.push("close"); } }; }, () => { calls.push("observed"); })).rejects.toBe(original);
    expect(calls).toEqual(["stop", "unchanged", "acquire", "read", "close"]); expect(bytes.every(byte => byte === 0)).toBe(true);
  });
  it.each([211, 212])("classifies only the fixed replacement exit%s after full Stop/revoke and a matching strict report", async code => {
    const original = new Error("Fixed replacement refusal"), calls: string[] = [], seen: unknown[] = [], bytes = failed(1, 2, 9, 0xf0f);
    let release!: () => void; const stopped = new Promise<void>(resolve => { release = resolve; });
    const running = observeWindowsCommandCopyFailedUsefulExit(original, { phase: 1, code }, async () => { calls.push("stop"); await stopped; calls.push("revoked"); },
      () => { calls.push("unchanged"); }, () => { calls.push("acquire"); return { read() { calls.push("read"); return bytes; },
        close() { calls.push("close"); expect(bytes.every(byte => byte === 0)).toBe(true); } }; }, value => { calls.push("observed"); seen.push(value); });
    const result = running.catch(error => error); await Promise.resolve(); expect(calls).toEqual(["stop"]); release();
    expect(await result).toBe(original); expect(calls).toEqual(["stop", "revoked", "unchanged", "acquire", "read", "close", "observed"]);
    expect(seen).toEqual([{ mode: 1, status: 2, operation: 9, features: 0xf0f, code: 5, replacementStage: code === 211 ? 1 : 2 }]);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });
  it("reads the captured replacement code once and preserves a trapping foreign observation without inspecting its error", async () => {
    const original = new Error("Fixed replacement refusal"), seen: unknown[] = []; let reads = 0;
    const exit = { phase: 1 as const, get code() { reads++; if (reads > 1) throw new Error("Private duplicate status read"); return 211; } };
    await expect(observeWindowsCommandCopyFailedUsefulExit(original, exit, async () => undefined, () => undefined,
      () => ({ read: () => failed(1, 2, 9, 0xf0f), close() {} }), value => { seen.push(value); })).rejects.toBe(original);
    expect(reads).toBe(1); expect(seen).toHaveLength(1);
    const calls: string[] = []; let foreignErrorReads = 0;
    const foreign = new Proxy({}, { get() { throw new Proxy({}, { get() { foreignErrorReads++; throw new Error("Private foreign error getter"); } }); } });
    await expect(observeWindowsCommandCopyFailedUsefulExit(original, foreign as never, async () => { calls.push("stop"); }, () => { calls.push("unchanged"); },
      () => { calls.push("acquire"); return { read: () => failed(), close() { calls.push("close"); } }; }, () => { calls.push("observed"); })).rejects.toBe(original);
    expect(calls).toEqual([]); expect(foreignErrorReads).toBe(0);
  });
  it.each(["other operation", "wrong progress", "ACL grant", "ACL incomplete", "complete", "wrong mode", "short"])("does not classify a replacement phase from %s", async fault => {
    const original = new Error("Fixed replacement refusal"), calls: string[] = []; let bytes = failed(1, 2, 9, 0xf0f);
    if (fault === "other operation") bytes = failed();
    else if (fault === "wrong progress") bytes.writeUInt32LE(0xf07, 20);
    else if (fault === "ACL grant") bytes.writeUInt32LE(1, 18 * 4);
    else if (fault === "ACL incomplete") bytes.writeUInt32LE(7, 17 * 4);
    else if (fault === "complete") { bytes.writeUInt32LE(1, 12); bytes.writeUInt32LE(19, 16); bytes.writeUInt32LE(0xfff, 20); bytes.writeUInt32LE(0, 52); }
    else if (fault === "wrong mode") bytes.writeUInt32LE(3, 8);
    else bytes = bytes.subarray(0, 127);
    await expect(observeWindowsCommandCopyFailedUsefulExit(original, { phase: 1, code: 212 }, async () => { calls.push("stop"); }, () => { calls.push("unchanged"); },
      () => { calls.push("acquire"); return { read() { calls.push("read"); return bytes; }, close() { calls.push("close"); } }; }, () => { calls.push("observed"); })).rejects.toBe(original);
    expect(calls).toEqual(["stop", "unchanged", "acquire", "read", "close"]); expect(bytes.every(byte => byte === 0)).toBe(true);
  });
  it.each(["stop", "unchanged", "acquire", "read", "close", "observed"])("preserves the replacement refusal and stops at %s diagnostic uncertainty", async fault => {
    const original = new Error("Fixed replacement refusal"), calls: string[] = [], bytes = failed(1, 2, 9, 0xf0f);
    const at = (stage: string) => { calls.push(stage); if (stage === fault) throw new Error("Private replacement diagnostic uncertainty"); };
    await expect(observeWindowsCommandCopyFailedUsefulExit(original, { phase: 1, code: 211 }, async () => { at("stop"); }, () => { at("unchanged"); },
      () => { at("acquire"); return { read() { at("read"); return bytes; }, close() { at("close"); } }; }, () => { at("observed"); })).rejects.toBe(original);
    expect(calls).toEqual(["stop", "unchanged", "acquire", "read", "close", "observed"].slice(0, ["stop", "unchanged", "acquire", "read", "close", "observed"].indexOf(fault) + 1));
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


const boundary = vi.hoisted(() => ({
  events: [] as string[], fault: "", exports: {} as Record<string, unknown>, api: {} as Record<string, unknown>,
  error: new Error("Private synthetic setup material"),
  baseline: vi.fn(), detached: vi.fn(), host: vi.fn(),
}));
vi.mock("node:module", () => ({ createRequire: vi.fn((file: string) => {
  boundary.events.push("require-factory"); expect(file).toBe("D:\\fixed\\creator-owner.cjs");
  if (boundary.fault === "require-factory") throw boundary.error;
  return (selected: string) => {
    boundary.events.push("require-module"); expect(selected).toBe(file);
    if (boundary.fault === "require-module") throw boundary.error;
    return boundary.exports;
  };
}) }));
vi.mock("../fixtures/windows-command-copy-detached-loader", () => ({ loadWindowsRootCopyDetachedApi: boundary.detached }));
vi.mock("../fixtures/windows-command-creator-owner-host", () => ({ observeWindowsCommandCreatorOwnerHost: boundary.host, windowsCommandCreatorOwnerHostFailure: () => undefined }));
vi.mock("../../app/main/agent/experimental-windows-lpac-api", async importOriginal => ({
  ...await importOriginal<typeof import("../../app/main/agent/experimental-windows-lpac-api")>(),
  loadExperimentalWindowsLpacApi: boundary.baseline,
}));

import { observeWindowsCommandCreatorOwner, WindowsCommandCreatorOwnerObservationError } from "../fixtures/windows-command-creator-owner-proof";

class CopyCleanup extends Error {}
class StopCleanup extends Error {}
class TreeCleanup extends Error {}
class ProofCleanup extends Error {}
class ProfileCleanup extends Error {}
class FileFailure extends Error { constructor(readonly code: string) { super("Private synthetic file material"); } }

const asset = Object.freeze({ executable: "D:\\fixed\\creator-owner.exe", module: "D:\\fixed\\creator-owner.cjs" });
const required = ["WindowsRootOnlyCommandCopy", "createWindowsCommandRootOnlyStopOwner", "requireWindowsCommandRootOnlyStopped", "createFreshWindowsCommandTree",
  "loadWindowsCommandCopyProofNative", "WindowsCommandCopyProofCleanupError", "WindowsCommandCopyCleanupError", "WindowsCommandRootOnlyCleanupError",
  "WindowsRootOnlyCommandCopyCleanupError", "windowsCommandCopyNativeFailure", "windowsCommandRootOnlyFailure", "ScopedCodingFileError", "createFreshWindowsCommandCreatorProfile", "windowsCommandCreatorProfile", "closeWindowsCommandCreatorProfile",
  "WindowsCommandCreatorProfileCleanupError", "requireWindowsCommandRootOnlyCompletion", "requireWindowsCommandRootOnlyAttestingCurrent", "takeWindowsCommandRootOnlyAttesting"] as const;
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
  const profileRef = Object.freeze({}), profile = Object.freeze({ name: "Ember.Creator.Synthetic", sidText: "S-1-15-2-100", sid: 10n });
  const api = {
    createProfile: vi.fn(() => { throw new Error("The old API must never issue a creator profile."); }),
    ownerSid: vi.fn(() => { hit("owner"); throw boundary.error; }),
    deleteProfile: vi.fn(), close: vi.fn(), terminateJob: vi.fn(), terminateProcess: vi.fn(),
  };
  boundary.api = api;
  boundary.exports = Object.fromEntries(required.map(key => [key, vi.fn(() => { throw new Error("Unexpected emitted operation"); })]));
  Object.assign(boundary.exports, {
    loadWindowsCommandCopyProofNative: vi.fn(() => { hit("native"); return native; }),
    WindowsRootOnlyCommandCopyCleanupError: CopyCleanup, WindowsCommandRootOnlyCleanupError: StopCleanup,
    WindowsCommandCopyCleanupError: TreeCleanup, WindowsCommandCopyProofCleanupError: ProofCleanup, ScopedCodingFileError: FileFailure,
    WindowsCommandCreatorProfileCleanupError: ProfileCleanup,
    createFreshWindowsCommandCreatorProfile: vi.fn(() => { hit("create-profile-ref"); return profileRef; }),
    windowsCommandCreatorProfile: vi.fn((selected: object) => { expect(selected).toBe(profileRef); hit("profile"); return profile; }),
    closeWindowsCommandCreatorProfile: vi.fn(() => { throw new Error("Uncertain setup must not delete or free a profile."); }),
  });
  boundary.host.mockImplementation(async () => { hit("host-control"); return { aclHostPositive: 4 }; });
  boundary.detached.mockImplementation(() => { hit("detached-loader"); return boundary.api; });
  boundary.baseline.mockImplementation(() => { throw new Error("The baseline default loader must never be selected."); });
  return { verify, native, modulePin, imagePin, api, profile, profileRef, emitted: { ...boundary.exports } };
}
type State = ReturnType<typeof setup>;
async function refused(state: State) {
  let caught: unknown;
  try { await observeWindowsCommandCreatorOwner(asset, state.verify, "D:\\native-scratch"); }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(WindowsCommandCreatorOwnerObservationError);
  if (!(caught instanceof WindowsCommandCreatorOwnerObservationError)) throw new Error("The observation did not refuse safely.");
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
  boundary.detached.mockReset(); boundary.baseline.mockReset(); boundary.host.mockReset();
});

describe("creator-owner proof's actual default-loader boundary", () => {
  it("requires the ordinary host's four permission controls before issuing a profile or loading LPAC authority", async () => {
    boundary.fault = "host-control"; const state = setup(), failure = await refused(state);
    expect(failure.phase).toBe(2); expect(boundary.events).toEqual([...prefix, "host-control"]);
    expect(boundary.detached).not.toHaveBeenCalled(); expect(state.emitted.createFreshWindowsCommandCreatorProfile).not.toHaveBeenCalled(); held(state);
  });
  it("refuses incomplete host controls without falling through to profile creation", async () => {
    const state = setup(); boundary.host.mockResolvedValue({ aclHostPositive: 3 });
    const failure = await refused(state); expect(failure.phase).toBe(2); expect(boundary.events).toEqual(prefix);
    expect(boundary.detached).not.toHaveBeenCalled(); expect(state.emitted.createFreshWindowsCommandCreatorProfile).not.toHaveBeenCalled(); held(state);
  });
  it("verifies the emitted module and image twice and holds both unchanged pins before selecting only the dedicated loader", async () => {
    const state = setup(), failure = await refused(state);
    expect(boundary.events).toEqual([...prefix, "host-control", "detached-loader", "guard", "create-profile-ref", "guard", "profile", "guard", "owner"]);
    expect(failure.phase).toBe(2); expect(failure.ownership).toBe(0); expect(failure.fileCode).toBe(0);
    expect(state.native.pin.mock.calls).toEqual([[asset.module, 16 * 1024 * 1024], [asset.executable, 16 * 1024 * 1024]]);
    expect(boundary.detached).toHaveBeenCalledExactlyOnceWith(); expect(state.api.createProfile).not.toHaveBeenCalled(); expect(state.emitted.createFreshWindowsCommandCreatorProfile).toHaveBeenCalledTimes(1);
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
    expect(boundary.events).toEqual([...prefix, "host-control", "detached-loader"]); expect(failure.phase).toBe(2);
    expect(state.api.createProfile).not.toHaveBeenCalled(); expect(state.native.guard).not.toHaveBeenCalled(); held(state);
  });
  it("does not continue or attempt disposal after guarded profile acquisition refuses", async () => {
    boundary.fault = "create-profile-ref"; const state = setup(), failure = await refused(state);
    expect(boundary.events).toEqual([...prefix, "host-control", "detached-loader", "guard", "create-profile-ref"]);
    expect(failure.phase).toBe(2); expect(state.api.ownerSid).not.toHaveBeenCalled(); held(state);
  });
  it("holds the exact emitted profile reference if its trusted accessor refuses without invoking the old profile API", async () => {
    boundary.fault = "profile"; const state = setup(), failure = await refused(state);
    expect(failure.phase).toBe(2); expect(boundary.events).toEqual([...prefix, "host-control", "detached-loader", "guard", "create-profile-ref", "guard", "profile"]);
    expect(state.api.ownerSid).not.toHaveBeenCalled(); expect(state.api.createProfile).not.toHaveBeenCalled(); expect(state.emitted.closeWindowsCommandCreatorProfile).not.toHaveBeenCalled(); held(state);
  });
  it("does not call profile creation after the native ownership guard refuses", async () => {
    boundary.fault = "guard"; const state = setup(), failure = await refused(state);
    expect(boundary.events).toEqual([...prefix, "host-control", "detached-loader", "guard"]);
    expect(failure.phase).toBe(2); expect(state.api.createProfile).not.toHaveBeenCalled(); held(state);
  });
  it.each([CopyCleanup, StopCleanup, TreeCleanup, ProofCleanup, ProfileCleanup])("retains the same setup graph and reports only its emitted cleanup constructor class %#", async Constructor => {
    const state = setup(); boundary.error = new Constructor("Private synthetic ownership material");
    const failure = await refused(state);
    expect(failure.phase).toBe(2); expect(failure.ownership).toBe([CopyCleanup, StopCleanup, TreeCleanup, ProofCleanup, ProfileCleanup].indexOf(Constructor) + 1);
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
  it("keeps a foreign prototype trap inside the fixed refusal without reading or disposing native owners", async () => {
    const state = setup(); boundary.error = new Proxy({} as Error, { getPrototypeOf() { throw new Error("Private prototype trap"); } });
    const failure = await refused(state); expect(failure.ownership).toBe(0); expect(failure.fileCode).toBe(0); held(state);
  });
  it("preserves the closed emitted file code at the actual setup boundary without exposing its message", async () => {
    const state = setup(); boundary.error = new FileFailure("boundary");
    const failure = await refused(state); expect(failure.fileCode).toBe(4); expect(failure.ownership).toBe(0); held(state);
  });
});

describe("creator tree observation preserves the exact synchronous capture and stopped revocation contracts", () => {
  function creatorTree(fault?: "prepare" | "capture" | "revoke", observerThrows = false) {
    const ref = Object.freeze({ scope: "root-only-creator-grant" }) as WindowsCommandCreatorGrantRef;
    const binding = Object.freeze({}), witness = Object.freeze({}), stopped = Object.freeze({});
    const error = new Error("Fixed private creator failure"), calls: unknown[] = [], observed: unknown[] = [];
    const tree: FreshWindowsCommandTree = {
      directory: "C:\\synthetic-creator", async assertPrivate() {}, async grant() {}, async revoke() {}, async snapshot() { return []; }, async close() {},
      prepareCreator(value) { calls.push(["prepare", value, this === tree]); if (fault === "prepare") throw error; return ref; },
      captureCreator(value, proof) { calls.push(["capture", value, proof, this === tree]); if (fault === "capture") throw error; },
      async revokeCreator(value, proof) { calls.push(["revoke", value, proof, this === tree]); if (fault === "revoke") throw error; },
    };
    const wrapped = observeWindowsCommandCopyTree(tree, value => { observed.push(value); if (observerThrows) throw new Error("Fixed observer failure"); });
    return { ref, binding, witness, stopped, error, calls, observed, wrapped };
  }
  it("forwards all three new methods with original receiver, arguments, result and no extra work", async () => {
    const f = creatorTree(); expect(f.wrapped.prepareCreator!(f.binding)).toBe(f.ref);
    expect(f.wrapped.captureCreator!(f.ref, f.witness)).toBeUndefined(); await f.wrapped.revokeCreator!(f.ref, f.stopped);
    expect(f.calls).toEqual([["prepare", f.binding, true], ["capture", f.ref, f.witness, true], ["revoke", f.ref, f.stopped, true]]); expect(f.observed).toEqual([]);
  });
  it.each([false, true])("preserves original prepare and capture throws when observerThrows=%s", observerThrows => {
    for (const fault of ["prepare", "capture"] as const) {
      const f = creatorTree(fault, observerThrows); let caught: unknown;
      try { if (fault === "prepare") f.wrapped.prepareCreator!(f.binding); else f.wrapped.captureCreator!(f.ref, f.witness); } catch (error) { caught = error; }
      expect(caught).toBe(f.error); expect(f.calls).toHaveLength(1); expect(f.observed).toEqual([f.error]);
    }
  });
  it.each([false, true])("preserves stopped revocation rejection without retry or cleanup when observerThrows=%s", async observerThrows => {
    const f = creatorTree("revoke", observerThrows); await expect(f.wrapped.revokeCreator!(f.ref, f.stopped)).rejects.toBe(f.error);
    expect(f.calls).toEqual([["revoke", f.ref, f.stopped, true]]); expect(f.observed).toEqual([f.error]);
  });
});
