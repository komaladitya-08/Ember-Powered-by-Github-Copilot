import { expect, it, vi } from "vitest";
import { WslCodingGuestCleanupError, type WslCodingConnection } from "../../app/main/agent/wsl-coding-connection";
import { CodingArtifactCleanupError } from "../../app/main/agent/coding-artifact-store";
import { CodingPrivacyCleanupError } from "../../app/main/agent/coding-privacy-scanner";
import { WindowsCodingCleanupError } from "../../app/main/agent/windows-coding-native";
import { observeResourceWorkspaceCalls, resourceOuterKind, sourceCommandKind, sourceSummaryKind } from "../fixtures/wsl-coding-product-observation";

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

it("forwards exact arguments, this binding, identity and promises without observing cleanup calls", async () => {
  const first = deferred(), second = deferred();
  type Call = WslCodingConnection["call"];
  const call = vi.fn(function(this: Pick<WslCodingConnection, "call">, ...args: Parameters<Call>) {
    expect(this).toBe(connection);
    return args[0] === "hello" ? first.promise : second.promise;
  });
  const connection = { call };
  const alias: Pick<WslCodingConnection, "call"> = connection;
  const snapshot = observeResourceWorkspaceCalls(alias);
  const params = Object.freeze({ data: "PRIVATE" });
  const options = Object.freeze({ timeoutMs: 19, output: vi.fn() });
  expect(snapshot()).toEqual({ rpc: 0, edge: 0, refusal: 0, reply: 0 });
  const returned = alias.call("hello", params, options);
  expect(returned).toBe(first.promise);
  expect(call).toHaveBeenCalledExactlyOnceWith("hello", params, options);
  expect(call.mock.calls[0][1]).toBe(params);
  expect(call.mock.calls[0][2]).toBe(options);
  expect(snapshot()).toEqual({ rpc: 1, edge: 1, refusal: 0, reply: 0 });
  const payload = Object.freeze({ protocol: 1, kind: "linux-helper", noNetwork: true, provisioned: false, opened: false, retired: false, uid: 1000, data: "PRIVATE" });
  first.resolve(payload);
  expect(await returned).toBe(payload);
  expect(snapshot()).toEqual({ rpc: 1, edge: 2, refusal: 0, reply: 1 });
  const cleanup = alias.call("close");
  expect(cleanup).toBe(second.promise);
  expect(call).toHaveBeenLastCalledWith("close");
  second.resolve(payload);
  await cleanup;
  expect(snapshot()).toEqual({ rpc: 1, edge: 2, refusal: 0, reply: 1 });
  expect(JSON.stringify(snapshot())).not.toContain("PRIVATE");
  expect(observeResourceWorkspaceCalls({ call: () => Promise.resolve() })()).toEqual({ rpc: 0, edge: 0, refusal: 0, reply: 0 });
});

it.each([
  [new Error("The isolated WSL coding connection could not be verified."), 1],
  [new WslCodingGuestCleanupError(), 2],
  [new Error("PRIVATE refusal"), 3],
  [Object.defineProperty(new Error(), "message", { get() { throw new Error("PRIVATE getter"); } }), 3],
  [new Proxy(new Error(), { getPrototypeOf() { throw new Error("PRIVATE proxy"); } }), 3],
] as const)("records only a closed rejection classification and keeps it across later calls (%#)", async (error, refusal) => {
  const pending = deferred();
  const connection = { call: vi.fn((..._args: Parameters<WslCodingConnection["call"]>) => pending.promise) };
  const snapshot = observeResourceWorkspaceCalls(connection);
  const original = connection.call("provision");
  expect(original).toBe(pending.promise);
  pending.reject(error);
  await original.catch(value => expect(value).toBe(error));
  expect(snapshot()).toEqual({ rpc: 2, edge: 3, refusal, reply: 0 });
  const cleanup = connection.call("close");
  const later = connection.call("open");
  expect(cleanup).toBe(pending.promise);
  expect(later).toBe(pending.promise);
  expect(snapshot()).toEqual({ rpc: 2, edge: 3, refusal, reply: 0 });
  expect(JSON.stringify(snapshot())).not.toContain("PRIVATE");
});

it("classifies only safe cleanup and message observations", () => {
  expect(resourceOuterKind(new WindowsCodingCleanupError())).toBe(1);
  expect(resourceOuterKind(new CodingArtifactCleanupError())).toBe(1);
  expect(resourceOuterKind(new CodingPrivacyCleanupError())).toBe(1);
  expect(resourceOuterKind(new Error("The private Windows coding copy could not be created under its current project grant."))).toBe(2);
  const getter = vi.fn(() => { throw new Error("PRIVATE"); });
  expect(resourceOuterKind(Object.defineProperty(new Error(), "message", { get: getter }))).toBe(3);
  expect(getter).not.toHaveBeenCalled();
  expect(sourceSummaryKind("The coding worker did not report an explicit completed result.")).toBe(6);
  expect(sourceSummaryKind("The coding worker did not report an explicit completed result.\n")).toBe(1);
  expect(sourceSummaryKind(undefined)).toBe(0);
});

it("requires the anchored host command prefix and never searches through output or objects", () => {
  const frame = '\n<coding_command_result untrusted="true">';
  const good = "Observed command exited successfully." + frame;
  const failed = "Observed command exited unsuccessfully. Fix the copy and rerun this exact check before reporting success." + frame;
  expect(sourceCommandKind(good + "PRIVATE output")).toBe(1);
  expect(sourceCommandKind(failed + "PRIVATE output")).toBe(2);
  expect(sourceCommandKind(frame + good)).toBe(3);
  expect(sourceCommandKind({ text: good })).toBe(3);
  expect(sourceCommandKind(undefined)).toBe(0);
});

it("distinguishes replies without reading getters, changing payloads or querying the connection again", async () => {
  const getter = vi.fn(() => { throw new Error("PRIVATE"); });
  const unreadable = Object.defineProperty({}, "opened", { get: getter });
  const call = vi.fn<(method: Parameters<WslCodingConnection["call"]>[0]) => Promise<unknown>>()
    .mockResolvedValueOnce({ typescript: "PRIVATE version" }).mockResolvedValueOnce(unreadable);
  const connection = { call }, snapshot = observeResourceWorkspaceCalls(connection);
  await connection.call("provision");
  expect(snapshot()).toEqual({ rpc: 2, edge: 2, refusal: 0, reply: 2 });
  expect(await connection.call("open")).toBe(unreadable);
  expect(snapshot()).toEqual({ rpc: 3, edge: 2, refusal: 0, reply: 3 });
  expect(getter).not.toHaveBeenCalled();
  expect(call).toHaveBeenCalledTimes(2);
});

it("does not read arbitrary call, then, constructor or species accessors", async () => {
  const get = vi.fn(() => { throw new Error("PRIVATE getter"); });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor: get, getPrototypeOf: get, defineProperty: get });
  const accessor = Object.defineProperty({}, "call", { get });
  for (const value of [proxy, accessor]) {
    expect(() => observeResourceWorkspaceCalls(value as Pick<WslCodingConnection, "call">)).toThrow("WSL fixture connection observation unavailable.");
  }
  const frozenReturn = Promise.resolve({ opened: true });
  const frozenCall = vi.fn(() => frozenReturn);
  const frozen: Pick<WslCodingConnection, "call"> = Object.freeze({ call: frozenCall });
  expect(() => observeResourceWorkspaceCalls(frozen)).toThrow();
  expect(frozen.call).toBe(frozenCall);
  expect(frozen.call("open")).toBe(frozenReturn);
  expect(frozenCall).toHaveBeenCalledExactlyOnceWith("open");
  const ownThen = Object.defineProperty(Promise.resolve({ opened: true }), "then", { get });
  const ownConstructor = Object.defineProperty(Promise.resolve({ opened: true }), "constructor", { get });
  class ForeignSpecies extends Promise<unknown> {
    static override get [Symbol.species](): PromiseConstructor { return get(); }
  }
  const foreign = new ForeignSpecies(resolve => resolve({ opened: true }));
  const original = [ownThen, ownConstructor, foreign];
  let calls = 0;
  const connection: Pick<WslCodingConnection, "call"> = { call: () => original[calls++] };
  const snapshot = observeResourceWorkspaceCalls(connection);
  expect(connection.call("open")).toBe(ownThen);
  await Promise.resolve();
  expect(snapshot()).toEqual({ rpc: 3, edge: 2, refusal: 0, reply: 1 });
  for (const promise of [ownConstructor, foreign]) {
    expect(connection.call("open")).toBe(promise);
    await Promise.resolve();
    expect(snapshot()).toEqual({ rpc: 3, edge: 1, refusal: 0, reply: 0 });
  }
  expect(get).not.toHaveBeenCalled();
  expect(calls).toBe(3);
});

it("returns the original promise when the native species descriptor changes", async () => {
  const pending = Promise.resolve({ opened: true });
  const descriptor = Object.getOwnPropertyDescriptor(Promise, Symbol.species)!;
  const get = vi.fn(() => { throw new Error("PRIVATE species"); });
  let calls = 0;
  const connection: Pick<WslCodingConnection, "call"> = { call: () => { calls++; return pending; } };
  const snapshot = observeResourceWorkspaceCalls(connection);
  let returned: Promise<unknown>;
  Object.defineProperty(Promise, Symbol.species, { get, configurable: true });
  try {
    returned = connection.call("open");
  } finally {
    Object.defineProperty(Promise, Symbol.species, descriptor);
  }
  expect(returned).toBe(pending);
  await pending;
  expect(calls).toBe(1);
  expect(get).not.toHaveBeenCalled();
  expect(snapshot()).toEqual({ rpc: 3, edge: 1, refusal: 0, reply: 0 });
});
