/** Creator-only Win32 inheritance grant fault logic; all DLL calls use the existing synthetic object model. */
import path from "node:path/win32";
import { expect, it } from "vitest";
import { WindowsRootOnlyCommandCopy } from "../../app/main/agent/windows-command-copy";
import { WindowsCommandCopyCleanupError, windowsCommandCopyNativeFailure } from "../../app/main/agent/windows-command-copy-native";
import { bindWindowsCommandCreatorProfileNative, windowsCommandCreatorProfile, closeWindowsCommandCreatorProfile } from "../../app/main/agent/windows-command-creator-profile";
import { createWindowsCommandRootOnlyStopOwner, type WindowsCommandRootOnlyStopNative } from "../../app/main/agent/windows-command-stop";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
import { setup, OWNER, PACKAGE, type ObjectRow } from "../fixtures/windows-command-creator-native-fake";

type Model = ReturnType<typeof setup>;
const rejected = async (work: Promise<unknown>): Promise<unknown> => { try { await work; } catch (error) { return error; } throw new Error("The fixed inheritance fault must refuse."); };
function profile(text: string) {
  const parts = text.split("-").slice(3).map(Number), bytes = Buffer.alloc(8 + parts.length * 4);
  bytes[0] = 1; bytes[1] = parts.length; bytes[7] = 15;
  parts.forEach((value, index) => bytes.writeUInt32LE(value, 8 + index * 4));
  return bindWindowsCommandCreatorProfileNative({ sizeof: () => 8, decode: () => Buffer.from(bytes) } as unknown as Parameters<typeof bindWindowsCommandCreatorProfileNative>[0], () => ({ func(signature) {
    const name = /\b(\w+)\s*\(/.exec(signature)![1]; return (...args: unknown[]) => {
      if (name === "CreateAppContainerProfile") { (args[5] as unknown[])[0] = 0x900000n; return 0; }
      if (name === "IsValidSid") return 1; if (name === "GetLengthSid") return bytes.length;
      if (name === "DeleteAppContainerProfile") return 0; if (name === "FreeSid") return null;
      throw new Error("Unexpected fixed profile declaration.");
    };
  } }), { retained: [] }).create();
}
function stop() {
  const root = { process: 50001n, thread: 50002n, pid: 50003 }, events: string[] = [];
  let assigned = false, ended = false;
  const api = { createJob() { assigned = false; ended = false; return 50000n; }, assign() { assigned = true; }, resume() { events.push("resume"); },
    terminateProcess() { ended = true; }, terminateJob() { ended = true; } } as unknown as WindowsLpacApi;
  const native: WindowsCommandRootOnlyStopNative = { configure() {}, assertLimits() {}, state: () => ({ total: assigned ? 1 : 0, active: assigned && !ended ? 1 : 0, pids: assigned && !ended ? [root.pid] : [] }),
    processId: () => root.pid, threadProcessId: () => root.pid, member: () => assigned, wait: () => ended ? 0 : 258, close() { events.push("closed"); } };
  return { root, api, events, owner: (binding: object) => createWindowsCommandRootOnlyStopOwner(binding, api, native, () => 100, { retained: [] }) };
}
async function prepared() {
  const s = setup(), ref = profile(s.control.tokenPackage), pkg = windowsCommandCreatorProfile(ref).sidText;
  const tree = await s.binding.createFreshWindowsCommandTree({ ...s.input(), creatorProfile: ref });
  const h = stop(), binding = {}, owner = h.owner(binding), creator = tree.prepareCreator!(binding);
  return { s, ref, pkg, tree, h, owner, creator,
    async finish() { await tree.revokeCreator!(creator, await owner.stop()); await tree.close(); closeWindowsCommandCreatorProfile(ref); } };
}
async function coordinated(s = setup()) {
  const ref = profile(s.control.tokenPackage), pkg = windowsCommandCreatorProfile(ref).sidText, h = stop();
  const copy = await WindowsRootOnlyCommandCopy.create({ ...s.input(), creatorProfile: ref, packageSid: pkg, packageCurrent: () => true, reviewCurrent: () => true }, {
    api: h.api, fence: { retained: [] }, createTree: input => s.binding.createFreshWindowsCommandTree(input), createStopOwner: binding => h.owner(binding),
  });
  return { s, ref, pkg, h, copy };
}
const setters = (s: Model, name: "SetSecurityInfo" | "NtSetSecurityObject") => s.calls.filter(call => call.name === name);
const inputViews = (s: Model) => {
  const pointers = new Map<bigint, "dacl" | "sacl">();
  for (const [name, kind] of [["GetSecurityDescriptorDacl", "dacl"], ["GetSecurityDescriptorSacl", "sacl"]] as const) {
    const original = s.handlers[name];
    s.handlers[name] = (...args) => { const result = original(...args), pointer = (args[2] as unknown[])[0]; if (typeof pointer === "bigint") pointers.set(pointer, kind); return result; };
  }
  return pointers;
};
function controlReadback(s: Model, output: (value: number) => unknown) {
  const info = s.handlers.GetSecurityInfo, control = s.handlers.GetSecurityDescriptorControl, rows = new Map<unknown, ObjectRow>();
  s.handlers.GetSecurityInfo = (...args) => { const result = info(...args), row = s.handles.get(args[0] as bigint)?.object; if (row) rows.set((args[7] as unknown[])[0], row); return result; };
  s.handlers.GetSecurityDescriptorControl = (...args) => {
    const result = control(...args);
    if (rows.get(args[0])?.security.package) { const values = args[1] as unknown[]; values[0] = output(values[0] as number); }
    return result;
  };
}

it("uses Win32 inheritance only for creator grants with null owner/group and bounded borrowed ACLs", async () => {
  const v = await prepared(), views = inputViews(v.s), before = v.s.calls.length;
  const set = v.s.handlers.SetSecurityInfo, held: boolean[] = [];
  v.s.handlers.SetSecurityInfo = (...args) => { held.push(v.s.handles.has(args[0] as bigint)); return set(...args); };
  await v.tree.grant(v.pkg);
  const calls = v.s.calls.slice(before), grants = setters(v.s, "SetSecurityInfo");
  expect(grants).toHaveLength(2); expect(calls.some(call => call.name === "NtSetSecurityObject")).toBe(false);
  for (const call of grants) {
    expect(call.args[1]).toBe(1); expect(call.args[2]).toBe(0x80000014); expect(call.args[3]).toBeNull(); expect(call.args[4]).toBeNull();
    expect(views.get(call.args[5] as bigint)).toBe("dacl"); expect(views.get(call.args[6] as bigint)).toBe("sacl");
  }
  expect(held).toEqual([true, true]);
  const aclPointers = new Set(views.keys());
  expect(calls.filter(call => call.name === "LocalFree").some(call => aclPointers.has(call.args[0] as bigint))).toBe(false);
  expect(calls.some(call => call.name === "GetLastError" || call.name === "AdjustTokenPrivileges" || call.name === "SetTokenInformation")).toBe(false);
  await v.finish();
});

it("leaves default grant and revoke paths on the original NT setter", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE); await tree.revoke(PACKAGE); await tree.close();
  expect(setters(s, "SetSecurityInfo")).toHaveLength(0); expect(setters(s, "NtSetSecurityObject").length).toBeGreaterThan(0);
  expect(setters(s, "NtSetSecurityObject").every(call => Number(call.args[1]) === 0x80000014)).toBe(true);
  expect(s.calls.some(call => /^GetSecurityDescriptor(?:Length|Dacl|Sacl)$/.test(call.name))).toBe(false);
});

it.each(["GetSecurityDescriptorDacl", "GetSecurityDescriptorSacl"] as const)("refuses absent, malformed or foreign borrowed views from %s before a setter", async api => {
  for (const fault of ["unwritten", "null", "zero", "negative", "high", "inside-header", "outside", "present-zero", "present-unwritten", "present-bool", "present-large", "defaulted-one", "defaulted-unwritten", "defaulted-bool", "defaulted-large"] as const) {
    const v = await prepared(), original = v.s.handlers[api];
    v.s.handlers[api] = (...args) => {
      const result = original(...args), present = args[1] as unknown[], pointer = args[2] as unknown[], defaulted = args[3] as unknown[];
      if (fault === "unwritten") pointer[0] = undefined;
      if (fault === "null") pointer[0] = null;
      if (fault === "zero") pointer[0] = 0n;
      if (fault === "negative") pointer[0] = -1n;
      if (fault === "high") pointer[0] = 0x8000000000000000n;
      if (fault === "inside-header") pointer[0] = (args[0] as bigint) + 4n;
      if (fault === "outside") pointer[0] = (args[0] as bigint) + 0x100000n;
      if (fault === "present-zero") present[0] = 0;
      if (fault === "present-unwritten") present[0] = undefined;
      if (fault === "present-bool") present[0] = true;
      if (fault === "present-large") present[0] = 0x100000000;
      if (fault === "defaulted-one") defaulted[0] = 1;
      if (fault === "defaulted-unwritten") defaulted[0] = undefined;
      if (fault === "defaulted-bool") defaulted[0] = false;
      if (fault === "defaulted-large") defaulted[0] = 0x100000000;
      return result;
    };
    expect(await rejected(v.tree.grant(v.pkg))).toBeInstanceOf(WindowsCommandCopyCleanupError);
    expect(setters(v.s, "SetSecurityInfo")).toHaveLength(0); expect(v.s.fence.retained.length).toBeGreaterThan(0);
    const count = v.s.calls.length; await rejected(v.tree.close()); expect(v.s.calls).toHaveLength(count);
  }
});

it.each(["GetSecurityDescriptorDacl", "GetSecurityDescriptorSacl"] as const)("refuses genuinely unwritten present/pointer/defaulted outputs from %s", async api => {
  for (const index of [1, 2, 3]) {
    const v = await prepared(), original = v.s.handlers[api];
    v.s.handlers[api] = (...args) => { const supplied = args.slice(); supplied[index] = [undefined]; return original(...supplied); };
    await rejected(v.tree.grant(v.pkg)); expect(setters(v.s, "SetSecurityInfo")).toHaveLength(0);
  }
});

it.each([0n, 4n])("refuses overlapping valid DACL/SACL extents with offset %s", async offset => {
  const v = await prepared(); let dacl: unknown;
  let sacl: unknown;
  let readingSacl = false;
  const decode = v.s.native.decode, call = decode as unknown as (...args: unknown[]) => unknown;
  Object.defineProperty(v.s.native, "decode", { configurable: true, value: Object.assign((...args: unknown[]) => {
    if (readingSacl && args[0] === sacl) { const bytes = Buffer.alloc(8); bytes[0] = 2; bytes.writeUInt16LE(56, 2); bytes.writeUInt16LE(1, 4); return bytes; }
    return call(...args);
  }, decode) });
  const getDacl = v.s.handlers.GetSecurityDescriptorDacl, getSacl = v.s.handlers.GetSecurityDescriptorSacl;
  v.s.handlers.GetSecurityDescriptorDacl = (...args) => { const result = getDacl(...args); dacl = (args[2] as unknown[])[0]; return result; };
  v.s.handlers.GetSecurityDescriptorSacl = (...args) => { const result = getSacl(...args); sacl = (dacl as bigint) + offset; (args[2] as unknown[])[0] = sacl; readingSacl = true; return result; };
  const error = await rejected(v.tree.grant(v.pkg)); expect(windowsCommandCopyNativeFailure(error)).toMatchObject({ operation: 31, predicate: 4 });
  expect(setters(v.s, "SetSecurityInfo")).toHaveLength(0);
});

it.each([0, 19, 65537, 0x100000000, -1, 20.5, NaN, Infinity, "128", 128n])("refuses malformed or impossible converted SD extent %s", async length => {
  const v = await prepared(); v.s.handlers.GetSecurityDescriptorLength = () => length;
  await rejected(v.tree.grant(v.pkg)); expect(setters(v.s, "SetSecurityInfo")).toHaveLength(0);
});

it.each(["GetSecurityDescriptorLength", "GetSecurityDescriptorDacl", "GetSecurityDescriptorSacl", "SetSecurityInfo"] as const)("retains every owner after %s throws without another native close", async name => {
  const v = await prepared(); v.s.handlers[name] = () => { throw new Error("fixed native uncertainty"); };
  const error = await rejected(v.tree.grant(v.pkg)), count = v.s.calls.length;
  expect(error).toBeInstanceOf(WindowsCommandCopyCleanupError);
  await expect(v.tree.close()).rejects.toBe(error); await expect(v.tree.snapshot()).rejects.toBe(error); await expect(v.tree.grant(v.pkg)).rejects.toBe(error);
  expect(v.s.calls).toHaveLength(count); expect(v.s.control.dataReads).toBe(0); expect(v.s.fence.retained.length).toBeGreaterThan(0);
});

it.each(["GetSecurityDescriptorDacl", "GetSecurityDescriptorSacl"] as const)("refuses an existing false return from %s without using error state", async name => {
  const v = await prepared(); v.s.handlers[name] = () => 0;
  await rejected(v.tree.grant(v.pkg)); expect(setters(v.s, "SetSecurityInfo")).toHaveLength(0); expect(v.s.calls.some(call => call.name === "GetLastError")).toBe(false);
});

it.each([5, 0x80000000, 0xffffffff])("records only the already returned bounded Win32 setter status %s in domain3", async status => {
  const v = await prepared(); v.s.handlers.SetSecurityInfo = () => status;
  const error = await rejected(v.tree.grant(v.pkg)); expect(windowsCommandCopyNativeFailure(error)).toMatchObject({ domain: 3, code: status });
  expect(v.s.calls.at(-1)?.name).toBe("SetSecurityInfo"); expect(v.s.calls.some(call => call.name === "GetLastError")).toBe(false);
});

it.each([false, null, undefined, -1, 0.5, 0x100000000, NaN, "5", 0n, 5n])("does not invent a DWORD status from malformed setter return %s", async status => {
  const v = await prepared(); v.s.handlers.SetSecurityInfo = () => status;
  const error = await rejected(v.tree.grant(v.pkg)); expect(windowsCommandCopyNativeFailure(error)).toMatchObject({ domain: 0, code: 0 });
  expect(v.s.calls.at(-1)?.name).toBe("SetSecurityInfo");
});

it.each(["dacl", "sacl"] as const)("bounds every borrowed %s ACL header before the Win32 setter", async target => {
  for (const fault of ["short", "oversized", "revision", "padding1", "padding2", "count", "too-small", "below-min", "outside-extent", "throw"] as const) {
    const v = await prepared(), views = inputViews(v.s), decode = v.s.native.decode, call = decode as unknown as (...args: unknown[]) => unknown;
    Object.defineProperty(v.s.native, "decode", { configurable: true, value: Object.assign((...args: unknown[]) => {
      const value = call(...args);
      if (views.get(args[0] as bigint) !== target) return value;
      if (fault === "throw") throw new Error("fixed borrowed header uncertainty");
      const bytes = Buffer.from(value as Uint8Array);
      if (fault === "short") return bytes.subarray(0, 7);
      if (fault === "oversized") return Buffer.concat([bytes, Buffer.alloc(1)]);
      if (fault === "revision") bytes[0] = 3;
      if (fault === "padding1") bytes[1] = 1;
      if (fault === "padding2") bytes.writeUInt16LE(1, 6);
      if (fault === "count") bytes.writeUInt16LE(target === "dacl" ? 2 : 0, 4);
      if (fault === "too-small") bytes.writeUInt16LE(8, 2);
      if (fault === "below-min") bytes.writeUInt16LE(target === "dacl" ? 43 : 19, 2);
      if (fault === "outside-extent") bytes.writeUInt16LE(0xffff, 2);
      return bytes;
    }, decode) });
    await rejected(v.tree.grant(v.pkg)); expect(setters(v.s, "SetSecurityInfo")).toHaveLength(0); expect(v.s.control.dataReads).toBe(0);
  }
});

it.each([0, 0x400, 0x800])("rejects missing automatic-inheritance control bits %i before constructing or resuming a root", async bits => {
  const v = await coordinated(); controlReadback(v.s, value => value & ~0xc00 | bits);
  let creates = 0;
  await rejected(v.copy.launchRootOnly(() => { creates++; return v.h.root; }, () => undefined));
  expect(creates).toBe(0); expect(v.h.events).not.toContain("resume"); expect(v.s.control.dataReads).toBe(0);
  expect(v.s.calls.some(call => call.name === "GetTokenInformation" && call.args[1] === 4)).toBe(false);
});

it.each([0, 0x400, 0x800])("exposes only the bounded already returned WORD for missing auto-control mask %i", async bits => {
  const v = await prepared(); controlReadback(v.s, value => value & ~0xc00 | bits);
  const receipt = windowsCommandCopyNativeFailure(await rejected(v.tree.grant(v.pkg)));
  expect(receipt).toMatchObject({ operation: 25, predicate: 7, autoControl: 0x1014 | bits, nodeKind: 2, nodeRoot: 1, nodeAcl: 2, nodeDetached: 0 });
  expect(Object.isFrozen(receipt)).toBe(true); expect(JSON.stringify(receipt)).not.toMatch(/S-1-|C:|pointer|path|handle/i);
});

it.each([true, "7188", -1, 65536, 1.5, NaN])("does not publish malformed native auto-control output %s", async value => {
  const v = await prepared(); controlReadback(v.s, () => value);
  const receipt = windowsCommandCopyNativeFailure(await rejected(v.tree.grant(v.pkg)));
  expect(receipt).toMatchObject({ operation: 25, predicate: 3 }); expect(receipt?.autoControl).toBeUndefined();
});

it("retains a setter that partially mutates then reports a Win32 failure, without reading or releasing its tree", async () => {
  const v = await coordinated(), set = v.s.handlers.SetSecurityInfo;
  v.s.handlers.SetSecurityInfo = (...args) => { set(...args); return 5; };
  let creates = 0; const error = await rejected(v.copy.launchRootOnly(() => { creates++; return v.h.root; }, () => undefined));
  expect(v.s.root().security.package).toBe(v.pkg); expect(creates).toBe(0); const count = v.s.calls.length;
  await expect(v.copy.close()).rejects.toBe(error); expect(v.s.calls).toHaveLength(count); expect(v.s.control.dataReads).toBe(0);
});

it("unwinds a known cancelled partial grant using the empty Stop owner and the unchanged NT revocation path", async () => {
  const v = await coordinated(); v.s.control.retireOnSet = 1; let creates = 0;
  await rejected(v.copy.launchRootOnly(() => { creates++; return v.h.root; }, () => undefined));
  expect(creates).toBe(0); expect(v.h.events).not.toContain("resume"); expect(v.s.control.current).toBe(false);
  expect(v.s.root().security.package).toBeUndefined(); expect(setters(v.s, "NtSetSecurityObject").length).toBeGreaterThan(0);
  expect(setters(v.s, "NtSetSecurityObject").every(call => (Number(call.args[1]) & 1) === 0)).toBe(true);
  await v.copy.close(); closeWindowsCommandCreatorProfile(v.ref);
});

it.each(["new", "replaced", "reparse"] as const)("catches a %s object during the complete post-grant rewalk before root admission", async kind => {
  const v = await coordinated(), query = v.s.handlers.NtQueryDirectoryFile; let mutated = false, creates = 0;
  v.s.handlers.NtQueryDirectoryFile = (...args) => {
    if (!mutated && setters(v.s, "SetSecurityInfo").length === 2) {
      mutated = true; const name = path.join(v.s.root().name, "a.ts"), old = v.s.objects.get(name)!;
      if (kind === "reparse") old.attributes |= 0x400;
      else {
        if (kind === "replaced") { old.removed = true; old.links = 0; old.deletePending = true; }
        v.s.add(kind === "new" ? path.join(v.s.root().name, "new.txt") : name, "file", Buffer.from("fixed"),
          { ...v.s.root().security, owner: OWNER, aclOwner: OWNER, package: v.pkg, inherited: true, low: true });
      }
    }
    return query(...args);
  };
  await rejected(v.copy.launchRootOnly(() => { creates++; return v.h.root; }, () => undefined));
  expect(mutated).toBe(true); expect(creates).toBe(0); expect(v.h.events).not.toContain("resume"); expect(v.s.control.dataReads).toBe(0);
});

it.each(["owner", "mask", "label", "flags"] as const)("keeps the original exact %s check after automatic propagation", async kind => {
  const v = await coordinated(), set = v.s.handlers.SetSecurityInfo; let creates = 0;
  if (kind === "flags") {
    const decode = v.s.native.decode, call = decode as unknown as (...args: unknown[]) => unknown;
    Object.defineProperty(v.s.native, "decode", { configurable: true, value: Object.assign((...args: unknown[]) => {
      const value = call(...args);
      if (setters(v.s, "SetSecurityInfo").length && Buffer.isBuffer(value) && value.length === 8 && value[0] === 0) { const header = Buffer.from(value); header[1] = 0; return header; }
      return value;
    }, decode) });
  }
  v.s.handlers.SetSecurityInfo = (...args) => {
    const result = set(...args), row = v.s.handles.get(args[0] as bigint)!.object!;
    if (kind === "owner") row.security.owner = "S-1-5-18";
    if (kind === "mask") row.security.badMask = true;
    if (kind === "label") row.security.low = false;
    return result;
  };
  await rejected(v.copy.launchRootOnly(() => { creates++; return v.h.root; }, () => undefined));
  expect(creates).toBe(0); expect(v.h.events).not.toContain("resume"); expect(v.s.control.dataReads).toBe(0);
});

it("keeps post-Stop normalization on NT and sets OWNER only for the exact captured new creator object", async () => {
  const v = await prepared(); await v.tree.grant(v.pkg);
  await v.owner.launch(() => v.h.root, () => undefined, () => true, witness => v.tree.captureCreator!(v.creator, witness));
  const row = v.s.add(path.join(v.s.root().name, "new.txt"), "file", Buffer.from("fixed"),
    { owner: v.s.control.tokenOwner, aclOwner: OWNER, package: v.pkg, inherited: true, low: true });
  const before = v.s.calls.length; await v.tree.revokeCreator!(v.creator, await v.owner.stop());
  const calls = v.s.calls.slice(before); expect(calls.some(call => call.name === "SetSecurityInfo")).toBe(false);
  expect(calls.filter(call => call.name === "NtSetSecurityObject" && (Number(call.args[1]) & 1) !== 0)).toHaveLength(1);
  expect(row.security.owner).toBe(OWNER); expect(row.security.package).toBeUndefined();
  await v.tree.close(); closeWindowsCommandCreatorProfile(v.ref);
});
