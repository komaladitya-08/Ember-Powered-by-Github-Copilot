/** Actual catch-only observer tests; no native tool or alternate reader is used. */
import fs from "node:fs";
import { expect, it } from "vitest";
// @ts-expect-error -- host-only JavaScript source build diagnostics
import { createWindowsNodePosixToolIdentityObserver, windowsNodePosixToolIdentityObservation } from "../../scripts/experimental/build-windows-node-posix-source.mjs";

it("preserves successful return identity and existing nested evaluation order", () => {
  const observed = createWindowsNodePosixToolIdentityObserver(), trace: number[] = [], value = {};
  expect(observed.step(8, () => { observed.step(6, () => trace.push(6)); trace.push(60); observed.step(7, () => trace.push(7)); trace.push(8); return value; })).toBe(value);
  expect(trace).toEqual([6, 60, 7, 8]); expect(observed.failure()).toBeUndefined();
});
it.each([[1, 1], [2, 1], [3, 1], [4, 2], [5, 2], [6, 3], [7, 4], [8, 0]])("maps checkpoint %i to tool %i without reading pure-guard errors", (checkpoint, tool) => {
  const observed = createWindowsNodePosixToolIdentityObserver(), error = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("private access"); } });
  let caught: unknown; try { observed.step(checkpoint, () => { throw error; }); } catch (value) { caught = value; }
  expect(caught).toBe(error); expect(observed.failure()).toEqual({ schema: 1, checkpoint, tool, childOutcome: 0, exitCode: null });
});
it.each([
  [{ status: 1 }, 1, 1], [{ status: 0 }, 1, 0], [{ status: 0xffffffff }, 1, 0xffffffff],
  [{ code: "ETIMEDOUT", status: null }, 2, null], [{ code: "ETIMEDOUT" }, 2, null],
  [{ code: "ETIMEDOUT", status: 1 }, 3, 1], [{ code: "ENOENT", status: null }, 3, null],
  [{ status: "private", signal: "private" }, 3, null], [{ status: -1 }, 3, null], [{ status: 0x100000000 }, 3, null], [{ status: 1.5 }, 3, null],
])("projects only fixed child outcome and primitive DWORD for injected result %#", (result, childOutcome, exitCode) => {
  const value = windowsNodePosixToolIdentityObservation(1, result, true);
  expect(value).toEqual({ schema: 1, checkpoint: 1, tool: 1, childOutcome, exitCode }); expect(Object.isFrozen(value)).toBe(true);
  expect(JSON.stringify(value)).not.toMatch(/private|ENOENT|ETIMEDOUT|signal/);
});
it.each([[6, 3], [7, 4]])("records child checkpoint %i before outer validation with tool %i", (checkpoint, tool) => {
  const observed = createWindowsNodePosixToolIdentityObserver(), original = new Error("private original"), trace: number[] = [];
  let caught: unknown;
  try { observed.step(8, () => { trace.push(8); return observed.step(checkpoint, (note: (error: unknown) => void) => { trace.push(checkpoint); note({ status: 2, stdout: "private banner", stderr: "private values" }); throw original; }); }); } catch (error) { caught = error; }
  expect(caught).toBe(original); expect(trace).toEqual([8, checkpoint]);
  expect(observed.failure()).toEqual({ schema: 1, checkpoint, tool, childOutcome: 1, exitCode: 2 });
});
it("keeps a later final-version refusal distinct from successful version calls", () => {
  const observed = createWindowsNodePosixToolIdentityObserver(), original = new Error("private versions");
  expect(() => observed.step(8, () => { observed.step(6, () => "17.14.1"); observed.step(7, () => "17.14.2"); throw original; })).toThrow(original);
  expect(observed.failure()).toEqual({ schema: 1, checkpoint: 8, tool: 0, childOutcome: 0, exitCode: null });
});
it("freezes the first failure and never inspects a later child result", () => {
  const observed = createWindowsNodePosixToolIdentityObserver(), original = new Error("private first");
  expect(() => observed.step(3, () => { throw original; })).toThrow(original);
  const first = observed.failure(); let inspected = 0;
  const later = new Proxy({}, { getOwnPropertyDescriptor() { inspected++; throw new Error("private later"); } });
  expect(() => observed.step(7, (note: (error: unknown) => void) => { note(later); throw original; })).toThrow(original);
  expect(inspected).toBe(0); expect(observed.failure()).toBe(first); expect(Object.isFrozen(first)).toBe(true);
});
it("does not invoke getters, primitive coercion or raw output fields", () => {
  let touched = 0;
  const result = { get status() { touched++; throw new Error("private status"); }, get code() { touched++; throw new Error("private code"); }, get stdout() { touched++; throw new Error("private stdout"); }, get signal() { touched++; throw new Error("private signal"); } };
  expect(windowsNodePosixToolIdentityObservation(4, result, true)).toEqual({ schema: 1, checkpoint: 4, tool: 2, childOutcome: 3, exitCode: null });
  const invalid = { valueOf() { touched++; throw new Error("private coercion"); } };
  expect(windowsNodePosixToolIdentityObservation(invalid, { status: invalid }, true)).toEqual({ schema: 1, checkpoint: 0, tool: 0, childOutcome: 3, exitCode: null });
  expect(touched).toBe(0);
});
it("survives descriptor traps without changing the original operation error", () => {
  const observed = createWindowsNodePosixToolIdentityObserver(), original = new Error("private operation"), hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("private descriptor"); } });
  expect(() => observed.step(1, (note: (error: unknown) => void) => { note(hostile); throw original; })).toThrow(original);
  expect(observed.failure()).toEqual({ schema: 1, checkpoint: 1, tool: 1, childOutcome: 3, exitCode: null });
});
it("includes the actual observer contracts in both workflow test gates", () => {
  const text = fs.readFileSync(new URL("../../.github/workflows/experimental-windows-node-posix-source.yml", import.meta.url), "utf8");
  expect(text.match(/test\/unit\/windows-node-posix-tool-identity\.test\.ts/g)).toHaveLength(2);
});

it("does not replace a successful operation return when observation sees hostile data", () => {
  const observed = createWindowsNodePosixToolIdentityObserver(), value = {}, hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("private descriptor"); } });
  expect(observed.step(1, (note: (error: unknown) => void) => { note(hostile); return value; })).toBe(value);
  expect(observed.failure()).toEqual({ schema: 1, checkpoint: 1, tool: 1, childOutcome: 3, exitCode: null });
});
it("ignores inherited child fields", () => {
  expect(windowsNodePosixToolIdentityObservation(1, Object.create({ status: 1, code: "ETIMEDOUT" }), true)).toEqual({ schema: 1, checkpoint: 1, tool: 1, childOutcome: 3, exitCode: null });
});

it("reserves the first note before descriptor traps can reenter the observer", () => {
  const observed = createWindowsNodePosixToolIdentityObserver(), original = new Error("private original"), later = new Error("private nested");
  let inside: unknown = "not-called", nested = 0, inspected = 0;
  const child = new Proxy({}, { getOwnPropertyDescriptor(_target, key) {
    if (key === "status") {
      try { observed.step(7, () => { nested++; throw later; }); } catch (error) { expect(error).toBe(later); }
      inside = observed.failure(); return { configurable: true, enumerable: true, value: 9 };
    }
    return undefined;
  } });
  expect(() => observed.step(1, (note: (error: unknown) => void) => { note(child); throw original; })).toThrow(original);
  expect(nested).toBe(1); expect(inside).toBeUndefined();
  const first = observed.failure(); expect(first).toEqual({ schema: 1, checkpoint: 1, tool: 1, childOutcome: 1, exitCode: 9 }); expect(Object.isFrozen(first)).toBe(true);
  const next = new Proxy({}, { getOwnPropertyDescriptor() { inspected++; throw new Error("private later descriptor"); } });
  expect(() => observed.step(8, (note: (error: unknown) => void) => { note(next); throw later; })).toThrow(later);
  expect(inspected).toBe(0); expect(observed.failure()).toBe(first);
});
