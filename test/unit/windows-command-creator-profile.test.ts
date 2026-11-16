/** Opaque profile authority and native ownership fault injection; no Windows API executes. */
import { describe, expect, it } from "vitest";
import { bindWindowsCommandCreatorProfileNative, bindWindowsCommandCreatorTree, closeWindowsCommandCreatorProfile,
  requireWindowsCommandCreatorTree, releaseWindowsCommandCreatorTree, windowsCommandCreatorProfile,
  WindowsCommandCreatorProfileCleanupError, type WindowsCommandCreatorProfileRef } from "../../app/main/agent/windows-command-creator-profile";

const SID = 0x9000n;
const PRIVATE = "private native path S-1-15-2-9999";
const sidBytes = (subauthorities = [2, 101, 102, 103, 104, 105, 106, 107]) => {
  const bytes = Buffer.alloc(8 + subauthorities.length * 4);
  bytes[0] = 1; bytes[1] = subauthorities.length; bytes[7] = 15;
  subauthorities.forEach((value, index) => bytes.writeUInt32LE(value, 8 + index * 4));
  return bytes;
};
function setup() {
  const calls: { name: string; args: unknown[] }[] = [], libraries: string[] = [], outputs: unknown[][] = [];
  let allocations = 0;
  const control = { status: 0 as unknown, sid: SID as unknown, valid: 1 as unknown, length: 40 as unknown,
    decoded: sidBytes() as unknown, deleteStatus: 0 as unknown, freeResult: null as unknown,
    hook: {} as Record<string, ((...args: unknown[]) => unknown) | undefined> };
  const fence = { retained: [] as unknown[], failure: undefined as WindowsCommandCreatorProfileCleanupError | undefined };
  let defaultDecoded = control.decoded;
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    CreateAppContainerProfile: (...args) => {
      const index = allocations++, out = args[5] as unknown[]; outputs.push(out);
      out[0] = control.sid === SID ? SID + BigInt(index) * 0x1000n : control.sid;
      if (control.decoded === defaultDecoded) { defaultDecoded = sidBytes([2, 101, 102, 103, 104, 105, 106, 107 + index]); control.decoded = defaultDecoded; }
      return control.status;
    },
    DeleteAppContainerProfile: () => control.deleteStatus,
    IsValidSid: () => control.valid,
    GetLengthSid: () => control.length,
    FreeSid: () => control.freeResult,
  };
  const native = { sizeof: () => 8, decode: (...args: unknown[]) => { calls.push({ name: "decode", args }); return control.hook.decode ? control.hook.decode(...args) : control.decoded; } } as unknown as Parameters<typeof bindWindowsCommandCreatorProfileNative>[0];
  const load = (name: string) => {
    libraries.push(name);
    return { func(prototype: string) {
      const found = /\b(\w+)\s*\(/.exec(prototype)?.[1];
      if (!found || !handlers[found]) throw new Error("Unexpected native test declaration.");
      return (...args: unknown[]) => { calls.push({ name: found, args }); return control.hook[found] ? control.hook[found]!(...args) : handlers[found](...args); };
    } };
  };
  const binding = bindWindowsCommandCreatorProfileNative(native, load, fence);
  return { binding, native, load, fence, control, calls, libraries, outputs };
}
const names = (s: ReturnType<typeof setup>) => s.calls.map(call => call.name);
function thrown(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error("Expected the profile ownership boundary to refuse.");
}
function containsDataReference(root: unknown, target: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (root === target) return true;
  if (root === null || typeof root !== "object" && typeof root !== "function" || depth > 8 || seen.has(root as object)) return false;
  seen.add(root as object);
  return Object.values(Object.getOwnPropertyDescriptors(root)).some(descriptor => "value" in descriptor && containsDataReference(descriptor.value, target, seen, depth + 1));
}

describe("Fresh creator-only AppContainer profile authority", () => {
  it("uses a genuinely fresh native profile name, no capabilities and only the fixed native API set", () => {
    const s = setup(), first = s.binding.create(), second = s.binding.create();
    const a = windowsCommandCreatorProfile(first), b = windowsCommandCreatorProfile(second);
    expect(a.name).toMatch(/^ember-creator-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b.name).not.toBe(a.name); expect(a.sid).toBe(SID); expect(b.sid).not.toBe(a.sid); expect(b.sidText).not.toBe(a.sidText);
    expect(a.sidText).toBe("S-1-15-2-101-102-103-104-105-106-107");
    for (const create of s.calls.filter(call => call.name === "CreateAppContainerProfile")) {
      expect(create.args).toHaveLength(6); expect(create.args[1]).toBe(create.args[0]); expect(create.args[2]).toBeTypeOf("string");
      expect(create.args[3]).toBeNull(); expect(create.args[4]).toBe(0); expect(create.args[5]).toHaveLength(1);
    }
    expect(new Set(s.libraries)).toEqual(new Set(["userenv.dll", "advapi32.dll"]));
    expect(names(s)).toEqual(["CreateAppContainerProfile", "IsValidSid", "GetLengthSid", "decode", "CreateAppContainerProfile", "IsValidSid", "GetLengthSid", "decode"]);
    expect(Object.isFrozen(a)).toBe(true); expect(Reflect.set(a, "sidText", "S-1-15-2-1")).toBe(false);
    closeWindowsCommandCreatorProfile(first); closeWindowsCommandCreatorProfile(second);
  });

  it.each(["buffer", "uint8", "array"])("copies an exact %s SID before deriving detached bounded text", kind => {
    const s = setup(), bytes = sidBytes(); s.control.decoded = kind === "buffer" ? bytes : kind === "uint8" ? new Uint8Array(bytes) : Array.from(bytes);
    const ref = s.binding.create(), info = windowsCommandCreatorProfile(ref);
    if (kind === "buffer") bytes.fill(0);
    else (s.control.decoded as number[] | Uint8Array).fill(0);
    expect(info.sidText).toBe("S-1-15-2-101-102-103-104-105-106-107");
    expect(windowsCommandCreatorProfile(ref).sidText).toBe(info.sidText);
    closeWindowsCommandCreatorProfile(ref);
  });

  it.each([{ subauthorities: [2, 1] }, { subauthorities: [2, 2] }, { subauthorities: [2, 100] },
    { subauthorities: [2, ...Array.from({ length: 11 }, (_, index) => index + 100)] },
    { subauthorities: [2, ...Array.from({ length: 14 }, (_, index) => index + 100)] }])("rejects builtin, child and other non-top-level package SID shape $subauthorities", ({ subauthorities }) => {
    const s = setup(); s.control.decoded = sidBytes(subauthorities); s.control.length = (s.control.decoded as Buffer).length;
    expect(() => s.binding.create()).toThrow(WindowsCommandCreatorProfileCleanupError);
    expect(names(s)).toEqual(["CreateAppContainerProfile", "IsValidSid", "GetLengthSid"]);
    expect(containsDataReference(s.fence.retained, s.outputs[0])).toBe(true);
    expect(names(s)).not.toContain("DeleteAppContainerProfile"); expect(names(s)).not.toContain("FreeSid");
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15])("rejects a false forty-byte top-level SID with subauthority count %i", count => {
    const s = setup(), bytes = sidBytes(); bytes[1] = count; s.control.decoded = bytes;
    expect(() => s.binding.create()).toThrow(WindowsCommandCreatorProfileCleanupError);
    expect(names(s).at(-1)).toBe("decode"); expect(s.fence.retained.length).toBeGreaterThan(0);
    expect(names(s)).not.toContain("DeleteAppContainerProfile"); expect(names(s)).not.toContain("FreeSid");
  });

  it.each([2, -1, 0x7fffffff, -0x80000000])("accepts the documented nonzero int32 SID-valid result %i", valid => {
    const s = setup(); s.control.valid = valid; const ref = s.binding.create(); closeWindowsCommandCreatorProfile(ref);
  });

  it("binds one exact object tree key, permits release/reuse, and closes the native profile only once", () => {
    const s = setup(), ref = s.binding.create(), key = {}, next = {};
    expect(bindWindowsCommandCreatorTree(ref, key)).toBe(windowsCommandCreatorProfile(ref).sidText);
    expect(requireWindowsCommandCreatorTree(ref, key)).toBe(windowsCommandCreatorProfile(ref).sidText);
    releaseWindowsCommandCreatorTree(ref, key);
    expect(bindWindowsCommandCreatorTree(ref, next)).toBe(windowsCommandCreatorProfile(ref).sidText);
    releaseWindowsCommandCreatorTree(ref, next);
    closeWindowsCommandCreatorProfile(ref); closeWindowsCommandCreatorProfile(ref);
    expect(names(s).slice(-2)).toEqual(["DeleteAppContainerProfile", "FreeSid"]);
    expect(s.calls.filter(call => call.name === "DeleteAppContainerProfile")).toHaveLength(1);
    expect(s.calls.filter(call => call.name === "FreeSid")[0].args).toEqual([SID]);
    expect(() => windowsCommandCreatorProfile(ref)).toThrow(); expect(() => bindWindowsCommandCreatorTree(ref, {})).toThrow();
  });

  it("refuses close while a tree owns the profile without touching native cleanup or retiring that owner", () => {
    const s = setup(), ref = s.binding.create(), key = {}; bindWindowsCommandCreatorTree(ref, key); const count = s.calls.length;
    expect(() => closeWindowsCommandCreatorProfile(ref)).toThrow(); expect(s.calls).toHaveLength(count); expect(s.fence.failure).toBeUndefined();
    expect(requireWindowsCommandCreatorTree(ref, key)).toBe(windowsCommandCreatorProfile(ref).sidText);
    releaseWindowsCommandCreatorTree(ref, key); closeWindowsCommandCreatorProfile(ref);
  });

  it("rejects foreign and structurally cloned refs without granting tree authority", () => {
    const s = setup(), ref = s.binding.create(), key = {};
    for (const foreign of [{}, { ...ref }, { name: "ember-creator-forged", sid: SID, sidText: "S-1-15-2-101" }] as WindowsCommandCreatorProfileRef[]) {
      expect(() => windowsCommandCreatorProfile(foreign)).toThrow(); expect(() => bindWindowsCommandCreatorTree(foreign, key)).toThrow();
      expect(() => requireWindowsCommandCreatorTree(foreign, key)).toThrow(); expect(() => releaseWindowsCommandCreatorTree(foreign, key)).toThrow(); expect(() => closeWindowsCommandCreatorProfile(foreign)).toThrow();
    }
    expect(s.fence.failure).toBeUndefined(); closeWindowsCommandCreatorProfile(ref);
  });

  it("does not equate different object tree keys or another fresh profile with the active owner", () => {
    const s = setup(), ref = s.binding.create(), other = s.binding.create(), key = {}, foreignKey = {};
    bindWindowsCommandCreatorTree(ref, key);
    expect(() => bindWindowsCommandCreatorTree(ref, foreignKey)).toThrow();
    expect(() => requireWindowsCommandCreatorTree(ref, foreignKey)).toThrow();
    expect(() => releaseWindowsCommandCreatorTree(ref, foreignKey)).toThrow();
    expect(() => requireWindowsCommandCreatorTree(other, key)).toThrow();
  });

  it.each([1, -2147024713, 0x800700b7, false, null, undefined, "0", 0n, NaN, Infinity, {}, 0.5])("rejects non-S_OK CreateAppContainerProfile result %s", status => {
    const s = setup(); s.control.status = status; const error = thrown(() => s.binding.create());
    expect(error).toBeInstanceOf(WindowsCommandCreatorProfileCleanupError); expect(s.fence.failure).toBe(error); expect(names(s)).toEqual(["CreateAppContainerProfile"]);
    expect(containsDataReference(s.fence.retained, s.outputs[0])).toBe(true);
  });

  it.each([0n, -1n, 0x8000000000000000n, 1, "36864", null, undefined])("rejects an invalid native SID pointer %s without trying to free it", pointer => {
    const s = setup(); s.control.sid = pointer; expect(() => s.binding.create()).toThrow(WindowsCommandCreatorProfileCleanupError);
    expect(names(s)).toEqual(["CreateAppContainerProfile"]); expect(s.fence.retained.length).toBeGreaterThan(0);
  });

  it.each([0, false, null, "1", 1n, NaN, Infinity, 0.5, 0x80000000, -0x80000001])("rejects malformed native SID validity %s", valid => {
    const s = setup(); s.control.valid = valid; expect(() => s.binding.create()).toThrow(WindowsCommandCreatorProfileCleanupError);
    expect(names(s)).toEqual(["CreateAppContainerProfile", "IsValidSid"]);
  });

  it.each([0, 7, 8, 12, 16, 36, 44, 56, 68, 69, 40.5, NaN, Infinity, 40n, "40", null])("rejects any non-forty-byte native top-level SID length %s", length => {
    const s = setup(); s.control.length = length; expect(() => s.binding.create()).toThrow(WindowsCommandCreatorProfileCleanupError);
    expect(names(s)).toEqual(["CreateAppContainerProfile", "IsValidSid", "GetLengthSid"]);
  });

  it.each(["revision", "authority", "high authority", "base RID", "zero count", "one count", "large count", "AAP", "short", "long"])("rejects a malformed or capability SID: %s", fault => {
    const s = setup(); let bytes = sidBytes();
    if (fault === "revision") bytes[0] = 2;
    if (fault === "authority") bytes[7] = 5;
    if (fault === "high authority") bytes[2] = 1;
    if (fault === "base RID") bytes.writeUInt32LE(3, 8);
    if (fault === "zero count") bytes[1] = 0;
    if (fault === "one count") bytes = sidBytes([2]);
    if (fault === "large count") bytes[1] = 16;
    if (fault === "AAP") bytes = sidBytes([2, 1]);
    if (fault === "short") bytes = bytes.subarray(0, 39);
    if (fault === "long") bytes = Buffer.concat([bytes, Buffer.alloc(1)]);
    s.control.decoded = bytes;
    if (fault === "AAP" || fault === "one count") s.control.length = bytes.length;
    expect(() => s.binding.create()).toThrow(WindowsCommandCreatorProfileCleanupError);
    expect(names(s).at(-1)).toBe(fault === "AAP" || fault === "one count" ? "GetLengthSid" : "decode");
  });

  it.each([undefined, null, "private", {}, new Uint16Array(40), Array(40).fill(256), Array(40).fill(-1), Array(40).fill(1.5)])("rejects a non-byte SID decode %s", decoded => {
    const s = setup(); s.control.decoded = decoded; expect(() => s.binding.create()).toThrow(WindowsCommandCreatorProfileCleanupError);
    expect(s.fence.retained.length).toBeGreaterThan(0);
  });

  it.each(["CreateAppContainerProfile", "IsValidSid", "GetLengthSid", "decode"])("retains captured output after %s throws and never retries or cleans uncertain ownership", name => {
    const s = setup();
    s.control.hook[name] = (...args) => {
      if (name === "CreateAppContainerProfile") { const out = args[5] as unknown[]; s.outputs.push(out); out[0] = SID; }
      throw new Error(PRIVATE);
    };
    const error = thrown(() => s.binding.create()); expect(error).toBeInstanceOf(WindowsCommandCreatorProfileCleanupError);
    expect((error as Error).message).not.toContain(PRIVATE); expect(containsDataReference(s.fence.retained, s.outputs[0])).toBe(true);
    const count = s.calls.length; expect(thrown(() => s.binding.create())).toBe(error); expect(s.calls).toHaveLength(count);
    expect(names(s)).not.toContain("DeleteAppContainerProfile"); expect(names(s)).not.toContain("FreeSid");
  });

  it("retains a fallible output accessor without calling it again or freeing an invented SID", () => {
    const s = setup(); let reads = 0;
    s.control.hook.CreateAppContainerProfile = (...args) => {
      const out = args[5] as unknown[]; s.outputs.push(out);
      Object.defineProperty(out, "0", { get() { reads++; throw new Error(PRIVATE); }, configurable: true });
      return 0;
    };
    expect(() => s.binding.create()).toThrow(WindowsCommandCreatorProfileCleanupError); expect(reads).toBe(0);
    expect(containsDataReference(s.fence.retained, s.outputs[0])).toBe(true); expect(names(s)).toEqual(["CreateAppContainerProfile"]);
  });

  it("keeps an internally terminal owner fenced after the public failure property is cleared", () => {
    const s = setup(); s.control.status = 1; const error = thrown(() => s.binding.create()), count = s.calls.length;
    s.fence.failure = undefined; s.control.status = 0;
    expect(thrown(() => s.binding.create())).toBe(error); expect(s.calls).toHaveLength(count);
    const libraries = s.libraries.length;
    expect(thrown(() => bindWindowsCommandCreatorProfileNative(s.native, s.load, s.fence))).toBe(error);
    expect(s.calls).toHaveLength(count); expect(s.libraries).toHaveLength(libraries);
  });

  it("retires an already issued peer binder when its shared private fence fails, even after the public property is cleared", () => {
    const s = setup(), peer = bindWindowsCommandCreatorProfileNative(s.native, s.load, s.fence);
    const first = s.binding.create(), second = peer.create(); s.control.valid = 0;
    const error = thrown(() => s.binding.create()), count = s.calls.length;
    s.fence.failure = undefined;
    expect(thrown(() => peer.create())).toBe(error);
    expect(thrown(() => windowsCommandCreatorProfile(second))).toBe(error);
    expect(thrown(() => closeWindowsCommandCreatorProfile(first))).toBe(error);
    expect(thrown(() => closeWindowsCommandCreatorProfile(second))).toBe(error);
    expect(s.calls).toHaveLength(count);
  });

  it("retains both allocations and makes no validation or cleanup calls when a second live SID aliases the first", () => {
    const s = setup(), first = s.binding.create();
    s.control.hook.CreateAppContainerProfile = (...args) => { const out = args[5] as unknown[]; s.outputs.push(out); out[0] = SID; return 0; };
    const before = s.calls.length, error = thrown(() => s.binding.create());
    expect(error).toBeInstanceOf(WindowsCommandCreatorProfileCleanupError);
    expect(names(s).slice(before)).toEqual(["CreateAppContainerProfile"]);
    expect(containsDataReference(s.fence.retained, s.outputs[0])).toBe(true);
    expect(containsDataReference(s.fence.retained, s.outputs[1])).toBe(true);
    expect(thrown(() => closeWindowsCommandCreatorProfile(first))).toBe(error);
    expect(names(s)).not.toContain("DeleteAppContainerProfile"); expect(names(s)).not.toContain("FreeSid");
  });

  it("detects a live SID alias across separate binders of the same fence", () => {
    const s = setup(), peer = bindWindowsCommandCreatorProfileNative(s.native, s.load, s.fence), first = s.binding.create();
    s.control.hook.CreateAppContainerProfile = (...args) => { (args[5] as unknown[])[0] = SID; return 0; };
    const before = s.calls.length, error = thrown(() => peer.create());
    expect(names(s).slice(before)).toEqual(["CreateAppContainerProfile"]);
    expect(thrown(() => requireWindowsCommandCreatorTree(first, {}))).toBe(error);
  });

  it("permits the native allocator to reuse a SID address only after its prior positive FreeSid", () => {
    const s = setup(), first = s.binding.create(); closeWindowsCommandCreatorProfile(first);
    s.control.hook.CreateAppContainerProfile = (...args) => { (args[5] as unknown[])[0] = SID; return 0; };
    const second = s.binding.create(); expect(windowsCommandCreatorProfile(second).sid).toBe(SID); closeWindowsCommandCreatorProfile(second);
    expect(s.calls.filter(call => call.name === "FreeSid")).toHaveLength(2);
  });

  it.each([1, false, null, undefined, "0", 0n, NaN, -1])("does not free the SID or retry after DeleteAppContainerProfile returns %s", status => {
    const s = setup(), ref = s.binding.create(); s.control.deleteStatus = status;
    const error = thrown(() => closeWindowsCommandCreatorProfile(ref)), count = s.calls.length;
    expect(error).toBeInstanceOf(WindowsCommandCreatorProfileCleanupError); expect(names(s).at(-1)).toBe("DeleteAppContainerProfile");
    expect(names(s)).not.toContain("FreeSid"); expect(thrown(() => closeWindowsCommandCreatorProfile(ref))).toBe(error);
    expect(() => windowsCommandCreatorProfile(ref)).toThrow(); expect(s.calls).toHaveLength(count);
  });

  it.each([SID, 0n, 0, false, undefined, {}, "0"])("does not retry cleanup after FreeSid returns non-null %s", result => {
    const s = setup(), ref = s.binding.create(); s.control.freeResult = result;
    const error = thrown(() => closeWindowsCommandCreatorProfile(ref)), count = s.calls.length;
    expect(error).toBeInstanceOf(WindowsCommandCreatorProfileCleanupError); expect(names(s).slice(-2)).toEqual(["DeleteAppContainerProfile", "FreeSid"]);
    expect(thrown(() => closeWindowsCommandCreatorProfile(ref))).toBe(error); expect(s.calls).toHaveLength(count);
    expect(() => bindWindowsCommandCreatorTree(ref, {})).toThrow();
  });

  it.each(["DeleteAppContainerProfile", "FreeSid"])("revokes admission before %s and terminally retains a swallowed reentrant failure", name => {
    const s = setup(), ref = s.binding.create(); let nested: unknown;
    s.control.hook[name] = () => { nested = thrown(() => bindWindowsCommandCreatorTree(ref, {})); return name === "FreeSid" ? null : 0; };
    const error = thrown(() => closeWindowsCommandCreatorProfile(ref)); expect(error).toBeInstanceOf(WindowsCommandCreatorProfileCleanupError);
    expect(nested).toBeDefined(); expect(s.fence.failure).toBe(error); expect(() => windowsCommandCreatorProfile(ref)).toThrow();
    if (name === "DeleteAppContainerProfile") expect(names(s)).not.toContain("FreeSid");
  });

  it.each(["CreateAppContainerProfile", "IsValidSid", "GetLengthSid", "decode"])("does not let a swallowed reentrant create during %s restore the outer owner", name => {
    const s = setup(); let nested: unknown;
    s.control.hook[name] = (...args) => {
      if (name === "CreateAppContainerProfile") { const out = args[5] as unknown[]; s.outputs.push(out); out[0] = SID; }
      nested = thrown(() => s.binding.create());
      return name === "decode" ? sidBytes() : name === "IsValidSid" ? 1 : name === "GetLengthSid" ? 40 : 0;
    };
    const error = thrown(() => s.binding.create()); expect(error).toBeInstanceOf(WindowsCommandCreatorProfileCleanupError); expect(nested).toBe(error);
    expect(s.fence.failure).toBe(error); expect(names(s).filter(call => call === "CreateAppContainerProfile")).toHaveLength(1);
  });
});
