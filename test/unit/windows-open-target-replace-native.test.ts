/** Real parameter-equivalent binder with native-issued profile and genuine Stop provenance; synthetic FFI only. */
import path from "node:path/win32";
import { describe, expect, it } from "vitest";
import { bindWindowsOpenTargetReplaceNative, WindowsOpenTargetReplaceCleanupError, type WindowsOpenTargetReplaceFixture } from "../fixtures/windows-open-target-replace-native";
import { setup as originalSetup, OWNER, SYSTEM, type ObjectRow, type Security } from "../fixtures/windows-command-creator-native-fake";
import { bindWindowsCommandCreatorProfileNative, closeWindowsCommandCreatorProfile, requireWindowsCommandCreatorTree, windowsCommandCreatorProfile } from "../../app/main/agent/windows-command-creator-profile";
import { createWindowsCommandRootOnlyStopOwner, type WindowsCommandRootOnlyStopNative } from "../../app/main/agent/windows-command-stop";
import type { WindowsLpacApi, WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import { WINDOWS_OPEN_TARGET_REPLACE_REPORT_MAGIC } from "../fixtures/windows-open-target-replace-report";

const OLD = Buffer.from("EMBER_OPEN_TARGET_OLD\n"), NEW = Buffer.from("EMBER_OPEN_TARGET_NEW\n"), META = 0x1e0080;
function sidBytes(text: string) {
  const parts = text.split("-"), subs = parts.slice(3).map(Number), bytes = Buffer.alloc(8 + subs.length * 4);
  bytes[0] = 1; bytes[1] = subs.length; let authority = BigInt(parts[2]);
  for (let index = 5; index >= 0; index--) { bytes[2 + index] = Number(authority & 255n); authority >>= 8n; }
  subs.forEach((value, index) => bytes.writeUInt32LE(value, 8 + index * 4)); return bytes;
}
function profile(text: string, calls?: string[]) {
  const bytes = sidBytes(text);
  return bindWindowsCommandCreatorProfileNative({ sizeof: () => 8, decode: () => Buffer.from(bytes) } as unknown as Parameters<typeof bindWindowsCommandCreatorProfileNative>[0], () => ({
    func(prototype) { const name = /\b(\w+)\s*\(/.exec(prototype)![1]; return (...args: unknown[]) => {
      calls?.push(name);
      if (name === "CreateAppContainerProfile") { (args[5] as unknown[])[0] = 0x900000n; return 0; }
      if (name === "IsValidSid") return 1; if (name === "GetLengthSid") return bytes.length;
      if (name === "DeleteAppContainerProfile") return 0; if (name === "FreeSid") return null;
      throw new Error("Unexpected fixed profile declaration.");
    }; },
  }), { retained: [] }).create();
}
type JobState = { assigned: boolean; ended: boolean; resumed: number; closes: bigint[]; stop: string[] };
function job(binding = {}, createApi?: (state: JobState) => WindowsLpacApi) {
  const state: JobState = { assigned: false, ended: false, resumed: 0, closes: [], stop: [] };
  const api = createApi?.(state) ?? { createJob: () => 70000n, assign() { state.assigned = true; }, resume() { state.resumed++; },
    terminateJob() { state.stop.push("job"); state.ended = true; }, terminateProcess() { state.stop.push("root"); state.ended = true; } } as unknown as WindowsLpacApi;
  const native: WindowsCommandRootOnlyStopNative = { configure() {}, assertLimits() {},
    state: () => ({ total: state.assigned ? 1 : 0, active: state.assigned && !state.ended ? 1 : 0, pids: state.assigned && !state.ended ? [1] : [] }),
    processId: () => 1, threadProcessId: () => 1, member: () => state.assigned, wait: () => state.ended ? 0 : 258,
    close(raw) { state.closes.push(raw); } };
  const owner = createWindowsCommandRootOnlyStopOwner(binding, api, native, () => 100, { retained: [] });
  const launch = (create: () => WindowsSuspendedProcess = () => ({ process: 70001n, thread: 70002n, pid: 1 })) => owner.launch(create, () => {}, () => true);
  return { binding, owner, state, launch, native };
}
type Descriptor = { bytes: Buffer; security: Security; directory: boolean };
function setup(hostJob = false) {
  const s = originalSetup(), profileCalls: string[] = [], ref = profile(s.control.tokenPackage, profileCalls), pkg = windowsCommandCreatorProfile(ref).sidText;
  const memory = new Map<bigint, Descriptor>(), buffers = new Map<bigint, Buffer>(), fence = { retained: [] as unknown[] };
  const originalAddress = s.native.address as (bytes: Buffer) => bigint, originalDecode = s.native.decode as unknown as (raw: bigint, type: string, count: number) => unknown;
  const address = (bytes: Buffer) => { const raw = originalAddress(bytes); buffers.set(raw, bytes); return raw; };
  let nextDescriptor = 0x10000000n;
  const control = { security: undefined as ((row: ObjectRow, sec: Security) => void) | undefined,
    descriptor: undefined as ((raw: bigint, bytes: Buffer, sec: Security) => void) | undefined,
    decode: undefined as ((raw: bigint, count: number, bytes: Buffer) => Buffer) | undefined };
  function acl(rows: readonly { sid: string; mask: number; type: number; flags: number }[]) {
    const aces = rows.map(row => { const who = sidBytes(row.sid), ace = Buffer.alloc(8 + who.length); ace[0] = row.type; ace[1] = row.flags;
      ace.writeUInt16LE(ace.length, 2); ace.writeUInt32LE(row.mask, 4); who.copy(ace, 8); return ace; });
    const header = Buffer.alloc(8); header[0] = 2; header.writeUInt16LE(8 + aces.reduce((sum, row) => sum + row.length, 0), 2); header.writeUInt16LE(aces.length, 4);
    return Buffer.concat([header, ...aces]);
  }
  function descriptor(raw: bigint, security: Security, directory: boolean) {
    const sec = { ...security }, bytes = Buffer.alloc(512), flags = (directory ? 3 : 0) | (sec.inherited ? 16 : 0), owner = sidBytes(sec.owner);
    owner.copy(bytes, 20);
    const rows = [{ sid: sec.aclOwner ?? sec.owner, mask: 0x1f01ff, type: 0, flags }, { sid: SYSTEM, mask: 0x1f01ff, type: 0, flags },
      ...(sec.package ? [{ sid: sec.package, mask: sec.badMask ? 0x1f01ff : 0x1301bf, type: 0, flags }] : []),
      ...(sec.extra ? [{ sid: "S-1-5-32-545", mask: 1, type: 0, flags }] : [])];
    acl(rows).copy(bytes, 64); acl([{ sid: sec.low ? "S-1-16-4096" : "S-1-16-8192", mask: 1, type: 17, flags }]).copy(bytes, 384);
    control.descriptor?.(raw, bytes, sec); memory.set(raw, { bytes, security: sec, directory }); return raw;
  }
  const converted = s.handlers.ConvertStringSecurityDescriptorToSecurityDescriptorW;
  s.handlers.ConvertStringSecurityDescriptorToSecurityDescriptorW = (...args) => {
    const value = converted(...args), text = args[0] as string, raw = (args[2] as bigint[])[0];
    descriptor(raw, { owner: OWNER, aclOwner: OWNER, package: /0x1301bf;;;([^)]*)/.exec(text)?.[1], inherited: false, low: true }, text.includes("OICI"));
    return value;
  };
  const free = s.handlers.LocalFree;
  s.handlers.LocalFree = (...args) => { const value = free(...args); if (value === null) memory.delete(args[0] as bigint); return value; };
  s.handlers.GetTokenInformation = (...args) => {
    const kind = Number(args[1]), bytes = args[2] as Buffer, header = kind === 1 ? 16 : 8, text = kind === 1 ? s.control.tokenUser : s.control.tokenOwner;
    if (kind === 29) { bytes.fill(0); (args[4] as number[])[0] = 4; return 1; }
    const who = sidBytes(text); bytes.fill(0); who.copy(bytes, header); bytes.writeBigUInt64LE(address(bytes) + BigInt(header));
    (args[4] as number[])[0] = header + who.length; s.control.tokenHook?.(kind); return 1;
  };
  s.handlers.GetSecurityInfo = (...args) => {
    const row = s.handles.get(args[0] as bigint)?.object; if (!row) throw new Error("Unexpected fixed security handle.");
    const sec = { ...row.security }; control.security?.(row, sec);
    const raw = nextDescriptor; nextDescriptor += 0x1000n; descriptor(raw, sec, row.kind === "directory");
    (args[3] as unknown[])[0] = raw + 20n; (args[5] as unknown[])[0] = raw + 64n; (args[6] as unknown[])[0] = raw + 384n; (args[7] as unknown[])[0] = raw; return 0;
  };
  const length = s.handlers.GetSecurityDescriptorLength;
  s.handlers.GetSecurityDescriptorLength = (...args) => memory.get(args[0] as bigint)?.bytes.length ?? length(...args);
  const descriptorControl = s.handlers.GetSecurityDescriptorControl;
  s.handlers.GetSecurityDescriptorControl = (...args) => {
    const saved = memory.get(args[0] as bigint); if (!saved) return descriptorControl(...args);
    (args[1] as number[])[0] = 4 | 16 | (saved.security.inherited ? 0 : 0x1000) | (saved.security.automatic ? 0xc00 : 0); return 1;
  };
  const deletion = s.handlers.NtSetInformationFile;
  s.handlers.NtSetInformationFile = (...args) => { const result = deletion(...args); (args[1] as Buffer).writeUInt32LE(0); return result; };
  const native = { sizeof: () => 8, address, decode(raw: bigint, type: string, count: number) {
    for (const [base, saved] of memory) if (raw >= base && raw + BigInt(count) <= base + BigInt(saved.bytes.length)) {
      const bytes = Buffer.from(saved.bytes.subarray(Number(raw - base), Number(raw - base) + count)); return control.decode?.(raw, count, bytes) ?? bytes;
    }
    return originalDecode(raw, type, count);
  } } as unknown as Parameters<typeof bindWindowsOpenTargetReplaceNative>[0];
  const load = () => ({ func(prototype: string) { const name = /\b(\w+)\s*\(/.exec(prototype)![1]; return (...args: unknown[]) => {
    s.calls.push({ name, args }); const handler = s.handlers[name]; if (!handler) throw new Error("Unexpected fixed native call."); return handler(...args);
  }; } });
  const binding = bindWindowsOpenTargetReplaceNative(native, load, fence);
  const stop = hostJob ? job({}, state => {
    binding.host.original();
    s.handlers.CreateJobObjectW = () => 70000n;
    s.handlers.CreateProcessW = (...args) => { const pi = args[9] as Buffer; pi.writeBigUInt64LE(70001n, 0); pi.writeBigUInt64LE(70002n, 8); pi.writeUInt32LE(1, 16); return 1; };
    s.handlers.AssignProcessToJobObject = () => { state.assigned = true; return 1; };
    s.handlers.ResumeThread = () => { state.resumed++; return 1; };
    s.handlers.TerminateJobObject = () => { state.stop.push("job"); state.ended = true; return 1; };
    s.handlers.TerminateProcess = () => { state.stop.push("root"); state.ended = true; return 1; };
    return binding.host.api as WindowsLpacApi;
  }) : job();
  let fixture: WindowsOpenTargetReplaceFixture | undefined;
  const create = () => fixture = binding.create("C:\\scratch", ref, stop.binding, () => s.control.current);
  function complete(bSuccess: 0 | 1) {
    if (!fixture) throw new Error("The fixed tree must be prepared.");
    const root = fixture.directory, a = s.objects.get(path.join(root, "a-old.txt"))!, b = s.objects.get(path.join(root, "b-old.txt"))!;
    const inherited = { owner: s.control.tokenOwner, aclOwner: OWNER, package: pkg, inherited: true, low: true, automatic: true };
    a.links = 0; a.removed = true; s.add(a.name, "file", NEW, inherited);
    if (bSuccess) { b.links = 0; b.removed = true; s.add(b.name, "file", NEW, inherited); }
    else s.add(path.join(root, "b-temp.txt"), "file", NEW, inherited);
    const report = Buffer.alloc(64); [WINDOWS_OPEN_TARGET_REPLACE_REPORT_MAGIC, 1, 1, 3, 3, 3, 3, 3, bSuccess ? 3 : 1, 0, bSuccess ? 0 : 5].forEach((word, index) => report.writeUInt32LE(word, index * 4));
    s.add(path.join(root, "report.bin"), "file", report, inherited); stop.state.ended = true;
    return { a, b, report };
  }
  return { s, ref, pkg, profileCalls, stop, fence, memory, control, native, load, binding, create, complete };
}
function thrown(operation: () => unknown) {
  try { operation(); } catch (error) { return error; }
  throw new Error("The fixed native contract must refuse.");
}
function terminal(v: ReturnType<typeof setup>, operation: () => unknown) {
  const error = thrown(operation); expect(error).toBeInstanceOf(WindowsOpenTargetReplaceCleanupError);
  const count = v.s.calls.length; expect(thrown(() => v.binding.guard(() => true))).toBe(error);
  expect(v.s.calls).toHaveLength(count); expect(v.fence.retained.length).toBeGreaterThan(0); return error;
}

describe("Parameter-equivalent ordinary-host open-target ownership", () => {
  it("binds declarations without querying the host during construction", () => { const v = setup(); expect(v.s.calls).toEqual([]); expect(v.binding.host).toBeDefined(); });
  it.each([0, 1] as const)("holds only B's exact metadata pin until genuine Stop and closes the valid B=%i fixture", async bSuccess => {
    const v = setup(), fixture = v.create(), opens = [...v.s.opened], a = opens.find(row => row.fresh && row.object.name.endsWith("a-old.txt"))!, b = opens.find(row => row.fresh && row.object.name.endsWith("b-old.txt"))!;
    const bPins = opens.filter(row => !row.fresh && row.object === b.object && row.access === META), bPin = bPins[0];
    expect(bPins).toHaveLength(1); expect(opens.filter(row => row.object === a.object)).toEqual([a]);
    expect(a.access).toBe(0x1f01ff); expect(b.access).toBe(0x1f01ff); expect(a.share).toBe(7); expect(b.share).toBe(7);
    expect(a.object.bytes.equals(OLD)).toBe(true); expect(b.object.bytes.equals(OLD)).toBe(true);
    expect(a.parent).toBe(b.parent); expect(bPin.parent).toBe(a.parent); expect(bPin.share).toBe(7);
    expect(v.s.handles.has(a.raw)).toBe(false); expect(v.s.handles.has(b.raw)).toBe(false); expect(v.s.handles.has(bPin.raw)).toBe(true);
    const pinCall = v.s.calls.find(call => call.name === "NtCreateFile" && call.args[1] === META)!;
    expect(pinCall.args.slice(4)).toEqual([null, 0, 7, 1, 0x200060, null, 0]); expect((pinCall.args[2] as Buffer).readUInt32LE(24)).toBe(0x1040);
    const pinIndex = v.s.calls.indexOf(pinCall); for (const raw of [a.raw, b.raw]) expect(v.s.calls.findIndex(call => call.name === "CloseHandle" && call.args[0] === raw)).toBeLessThan(pinIndex);
    expect(v.s.calls.filter(call => call.name === "SetSecurityInfo")).toHaveLength(3);
    for (const call of v.s.calls.filter(call => call.name === "SetSecurityInfo")) expect(call.args.slice(1, 5)).toEqual([1, 0x80000014, null, null]);
    const originalClose = v.stop.native.close; v.stop.native.close = raw => { expect(v.s.handles.has(bPin.raw)).toBe(true); originalClose(raw); };
    await v.stop.launch(); const completed = v.complete(bSuccess), receipt = await v.stop.owner.stop();
    expect(v.s.handles.has(bPin.raw)).toBe(true); const bytes = fixture.readReport(receipt); expect(bytes.equals(completed.report)).toBe(true); bytes.fill(0);
    expect(fixture.verifyAndClose(receipt, bSuccess)).toEqual({ equalInitialState: 1, aNeverPinned: 1, bHeldThroughStop: 1, privateCleanup: 1 });
    expect(v.s.handles.size).toBe(0); expect(v.memory.size).toBe(0); closeWindowsCommandCreatorProfile(v.ref);
  });
  it.each(["mask", "owner", "LOW", "inheritance", "extra"] as const)("rejects two byte-equal but wrong target security states (%s)", field => {
    const v = setup(); v.control.security = (row, sec) => { if (row.kind !== "file") return;
      if (field === "mask") sec.badMask = true; if (field === "owner") sec.owner = "S-1-5-21-9-8-7-1001";
      if (field === "LOW") sec.low = false; if (field === "inheritance") sec.inherited = true; if (field === "extra") sec.extra = true;
    }; terminal(v, v.create); expect(v.s.opened.some(row => row.access === META)).toBe(false);
  });
  it.each(["root", "a", "b"] as const)("requires complete private security before the first setter (%s)", target => {
    const v = setup(); v.control.security = (row, sec) => { if (target === "root" ? row.name.includes("ember-open-target-") && row.kind === "directory" : row.name.endsWith(`${target}-old.txt`)) {
      if (!sec.package) sec.low = false;
    } }; terminal(v, v.create); expect(v.s.calls.filter(call => call.name === "SetSecurityInfo")).toHaveLength(0);
  });
  it("compares raw ACL bytes after both individually valid expected-set checks", () => {
    const v = setup(); let selected = false;
    v.control.security = row => { selected = row.name.endsWith("b-old.txt"); };
    v.control.descriptor = (_raw, bytes) => {
      if (!selected) return;
      const first = bytes.readUInt16LE(74), second = bytes.readUInt16LE(74 + first), total = bytes.readUInt16LE(66);
      const reordered = Buffer.concat([bytes.subarray(64, 72), bytes.subarray(72 + first, 72 + first + second),
        bytes.subarray(72, 72 + first), bytes.subarray(72 + first + second, 64 + total)]);
      reordered.copy(bytes, 64);
    };
    terminal(v, v.create); expect(v.s.calls.filter(call => call.name === "SetSecurityInfo")).toHaveLength(3);
    expect(v.s.opened.some(row => row.access === META)).toBe(false);
  });
  it.each(["attributes", "bytes", "ID", "volume"] as const)("requires equal initial target construction (%s)", field => {
    const v = setup(), original = v.s.handlers.NtWriteFile;
    v.s.handlers.NtWriteFile = (...args) => { const result = original(...args), row = v.s.handles.get(args[0] as bigint)?.object;
      if (row?.name.endsWith("b-old.txt")) {
        if (field === "attributes") row.attributes = 32; if (field === "bytes") row.bytes.fill(0);
        if (field === "ID") row.id = v.s.objects.get(path.join(path.dirname(row.name), "a-old.txt"))!.id;
        if (field === "volume") row.serial = 2;
      } return result;
    }; terminal(v, v.create); expect(v.s.opened.some(row => row.access === META)).toBe(false);
  });
  it.each([5, 87, 0xffffffff, true, -1])("retains the descriptor after a nonzero or malformed setter result %s", status => {
    const v = setup(); v.s.handlers.SetSecurityInfo = () => status; terminal(v, v.create);
    expect(v.s.calls.at(-1)?.name).toBe("SetSecurityInfo"); expect(v.memory.size).toBeGreaterThan(0);
  });
  it.each(["auto", "owner-SID", "owner-pointer", "DACL-count", "DACL-size", "DACL-revision", "SACL-pointer"] as const)("refuses malformed security readback (%s)", kind => {
    const v = setup();
    if (kind === "auto") { const original = v.s.handlers.GetSecurityDescriptorControl; v.s.handlers.GetSecurityDescriptorControl = (...args) => { const value = original(...args); (args[1] as number[])[0] &= ~0xc00; return value; }; }
    else if (kind === "owner-pointer" || kind === "SACL-pointer") { const original = v.s.handlers.GetSecurityInfo; v.s.handlers.GetSecurityInfo = (...args) => { const value = original(...args); (args[kind === "owner-pointer" ? 3 : 6] as bigint[])[0] = (args[7] as bigint[])[0] + 512n; return value; }; }
    else v.control.descriptor = (_raw, bytes) => {
      if (kind === "owner-SID") bytes[20] = 2; if (kind === "DACL-count") bytes.writeUInt16LE(100, 68);
      if (kind === "DACL-size") bytes.writeUInt16LE(7, 66); if (kind === "DACL-revision") bytes[64] = 1;
    };
    terminal(v, v.create);
  });
  it.each([19, 65537, Number.NaN])("refuses descriptor length %s before any native setter", length => {
    const v = setup(); v.s.handlers.GetSecurityDescriptorLength = () => length; terminal(v, v.create);
    expect(v.s.calls.some(call => call.name === "SetSecurityInfo")).toBe(false);
  });
  it.each(["present", "defaulted", "overlap", "alignment"] as const)("refuses malformed borrowed ACL views (%s)", kind => {
    const v = setup(), original = v.s.handlers.GetSecurityDescriptorDacl;
    v.s.handlers.GetSecurityDescriptorDacl = (...args) => { const value = original(...args);
      if (kind === "present") (args[1] as unknown[])[0] = true; if (kind === "defaulted") (args[3] as number[])[0] = 1;
      if (kind === "overlap") (args[2] as bigint[])[0] = (args[0] as bigint) + 384n;
      if (kind === "alignment") (args[2] as bigint[])[0] += 1n; return value;
    }; terminal(v, v.create); expect(v.s.calls.some(call => call.name === "SetSecurityInfo")).toBe(false);
  });
  it.each(["status", "throw", "extra-rights", "short-rights", "inherited", "close", "free"] as const)("retains the first acquisition/disposal uncertainty (%s)", kind => {
    const v = setup();
    if (kind === "status" || kind === "throw") { const original = v.s.handlers.NtCreateFile; v.s.handlers.NtCreateFile = (...args) => { const value = original(...args); if (kind === "throw") throw new Error("private native path"); return value === 0 ? 0xc0000022 : value; }; }
    if (kind === "extra-rights") v.s.control.fault = "extra handle rights";
    if (kind === "short-rights") { const original = v.s.handlers.NtQueryObject; v.s.handlers.NtQueryObject = (...args) => { const value = original(...args); (args[4] as number[])[0] = 55; return value; }; }
    if (kind === "inherited") v.s.handlers.GetHandleInformation = (...args) => { (args[1] as number[])[0] = 1; return 1; };
    if (kind === "close") v.s.control.fault = "close"; if (kind === "free") v.s.control.fault = "free";
    const error = terminal(v, v.create); expect(String(error)).not.toContain("private native path");
  });
  it("refuses another filesystem before allocating a tree", () => {
    const v = setup(); v.s.handlers.GetVolumeInformationW = (...args) => { (args[6] as Buffer).write("FAT32\0", "utf16le"); return 1; };
    terminal(v, v.create); expect(v.s.calls.some(call => call.name === "NtCreateFile")).toBe(false);
  });
  it("refuses alternate streams before mutating the private tree", () => {
    const v = setup(), original = v.s.handlers.NtWriteFile;
    v.s.handlers.NtWriteFile = (...args) => { const value = original(...args), row = v.s.handles.get(args[0] as bigint)?.object; if (row) row.streams = true; return value; };
    terminal(v, v.create); expect(v.s.calls.some(call => call.name === "SetSecurityInfo")).toBe(false);
  });
  it("checks cancellation after a returned query before any later native call", () => {
    const v = setup(), original = v.s.handlers.GetTokenInformation; v.s.handlers.GetTokenInformation = (...args) => { const value = original(...args); v.s.control.current = false; return value; };
    terminal(v, v.create); expect(v.s.calls.at(-1)?.name).toBe("GetTokenInformation");
  });
  it("does not open a token after the preceding native call revokes current authority", () => {
    const v = setup(); v.s.handlers.GetCurrentProcess = () => { v.s.control.current = false; return -1n; };
    terminal(v, v.create); expect(v.s.calls.map(call => call.name)).toEqual(["GetCurrentProcess"]);
  });
  it.each(["user-count", "owner-pointer", "owner-revision"] as const)("refuses malformed returned token evidence (%s)", kind => {
    const v = setup(), original = v.s.handlers.GetTokenInformation;
    v.s.handlers.GetTokenInformation = (...args) => { const result = original(...args), type = Number(args[1]), bytes = args[2] as Buffer;
      if (kind === "user-count" && type === 1) (args[4] as number[])[0] = 15;
      if (kind === "owner-pointer" && type === 4) bytes.writeBigUInt64LE(v.native.address(bytes) + BigInt(bytes.length));
      if (kind === "owner-revision" && type === 4) bytes[8] = 2; return result;
    }; terminal(v, v.create); expect(v.s.calls.some(call => call.name === "NtCreateFile")).toBe(false);
  });
  it("requires a native-issued profile before querying any host authority", () => {
    const v = setup(); terminal(v, () => v.binding.create("C:\\scratch", {} as typeof v.ref, v.stop.binding, () => true)); expect(v.s.calls).toEqual([]);
  });
  it("requires a still-preparing Stop owner before the first token query", async () => {
    const v = setup(); await v.stop.owner.stop(); terminal(v, v.create); expect(v.s.calls).toEqual([]);
  });
  it("permits one newly owned incarnation of a previously positively closed numeric handle", async () => {
    const v = setup(), original = v.s.handlers.NtCreateFile; let reused = false;
    v.s.handlers.NtCreateFile = (...args) => {
      const result = original(...args);
      if (!reused) { reused = true; const old = (args[0] as bigint[])[0], row = v.s.handles.get(old)!;
        expect(v.s.handles.has(100n)).toBe(false); v.s.handles.delete(old); v.s.handles.set(100n, row); (args[0] as bigint[])[0] = 100n; v.s.opened.at(-1)!.raw = 100n;
      } return result;
    };
    const fixture = v.create(); await v.stop.launch(); v.complete(0); const receipt = await v.stop.owner.stop(); fixture.readReport(receipt).fill(0); fixture.verifyAndClose(receipt, 0);
    expect(v.s.calls.filter(call => call.name === "CloseHandle" && call.args[0] === 100n)).toHaveLength(2); closeWindowsCommandCreatorProfile(v.ref);
  });
  it("retains a partial successful setter when current authority retires during that call", () => {
    const v = setup(), original = v.s.handlers.SetSecurityInfo;
    v.s.handlers.SetSecurityInfo = (...args) => { const result = original(...args); v.s.control.current = false; return result; };
    terminal(v, v.create); expect(v.s.calls.filter(call => call.name === "SetSecurityInfo")).toHaveLength(1);
    expect(v.s.calls.at(-1)?.name).toBe("SetSecurityInfo"); expect(v.s.handles.size).toBeGreaterThan(0);
  });
  it("detects a peer's shared fence after a current callback returns true", () => {
    const v = setup(), peer = bindWindowsOpenTargetReplaceNative(v.native, v.load, v.fence);
    terminal(v, () => v.binding.create("C:\\scratch", v.ref, v.stop.binding, () => {
      try { peer.guard(() => { throw new Error("private callback source"); }); } catch { /* The shared private fence must still reject this true result. */ }
      return true;
    })); expect(v.s.calls).toEqual([]);
  });
  it("rejects an allocation alias into a held root without querying or freeing that alias", () => {
    const v = setup(), original = v.s.handlers.GetSecurityInfo; let aliased: bigint | undefined;
    v.s.handlers.GetSecurityInfo = (...args) => { const result = original(...args); aliased = args[0] as bigint; (args[7] as bigint[])[0] = aliased; return result; };
    terminal(v, v.create); expect(v.s.calls.at(-1)?.name).toBe("GetSecurityInfo");
    expect(v.s.calls.some(call => (call.name === "CloseHandle" || call.name === "LocalFree") && call.args[0] === aliased)).toBe(false);
  });
  it.each(["forged", "wrong", "empty"] as const)("refuses %s Stop before a report open", async kind => {
    const v = setup(), fixture = v.create(); let receipt: unknown = { scope: "root-only" };
    if (kind === "wrong") { const other = job(); await other.launch(); other.state.ended = true; receipt = await other.owner.stop(); }
    if (kind === "empty") receipt = await v.stop.owner.stop();
    const count = v.s.calls.length; terminal(v, () => fixture.readReport(receipt)); expect(v.s.calls).toHaveLength(count);
  });
  it("refuses repeated reads without native work and preserves the private fence", async () => {
    const v = setup(), fixture = v.create(); await v.stop.launch(); v.complete(0); const receipt = await v.stop.owner.stop(); fixture.readReport(receipt).fill(0);
    const count = v.s.calls.length, error = terminal(v, () => fixture.readReport(receipt)); expect(v.s.calls).toHaveLength(count);
    expect(thrown(() => fixture.verifyAndClose(receipt, 0))).toBe(error); expect(v.s.calls).toHaveLength(count);
  });
  it("refuses final verification before its one report read", async () => {
    const v = setup(), fixture = v.create(); await v.stop.launch(); v.complete(0); const receipt = await v.stop.owner.stop(), count = v.s.calls.length;
    terminal(v, () => fixture.verifyAndClose(receipt, 0)); expect(v.s.calls).toHaveLength(count);
  });
  it.each(["wrong-owner", "wrong-ACE-owner", "LOW", "old-id"] as const)("requires exact stopped new-object postconditions (%s)", async kind => {
    const v = setup(), fixture = v.create(), pin = v.s.opened.find(row => row.access === META)!;
    await v.stop.launch(); const original = v.complete(0), a = v.s.objects.get(path.join(fixture.directory, "a-old.txt"))!;
    if (kind === "wrong-owner") a.security.owner = OWNER;
    if (kind === "wrong-ACE-owner") a.security.aclOwner = v.s.control.tokenOwner;
    if (kind === "LOW") a.security.low = false; if (kind === "old-id") a.id = original.a.id;
    const receipt = await v.stop.owner.stop(); fixture.readReport(receipt).fill(0);
    terminal(v, () => fixture.verifyAndClose(receipt, 0)); expect(v.s.handles.has(pin.raw)).toBe(true);
    expect(v.s.calls.some(call => call.name === "NtSetInformationFile")).toBe(false);
  });
  it("retains the report read owner when current authority disappears during the existing read", async () => {
    const v = setup(), fixture = v.create(); await v.stop.launch(); v.complete(0); const receipt = await v.stop.owner.stop(), original = v.s.handlers.NtReadFile;
    v.s.handlers.NtReadFile = (...args) => { const result = original(...args); v.s.control.current = false; return result; };
    terminal(v, () => fixture.readReport(receipt)); expect(v.s.calls.at(-1)?.name).toBe("NtReadFile");
    expect([...v.s.handles.values()].some(handle => handle.object?.name.endsWith("report.bin"))).toBe(true);
  });
  it("refuses an oversized stopped report before its payload read", async () => {
    const v = setup(), fixture = v.create(); await v.stop.launch(); v.complete(0);
    v.s.objects.get(path.join(fixture.directory, "report.bin"))!.reportedSize = 65;
    const receipt = await v.stop.owner.stop(), reads = v.s.calls.filter(call => call.name === "NtReadFile").length;
    terminal(v, () => fixture.readReport(receipt)); expect(v.s.calls.filter(call => call.name === "NtReadFile")).toHaveLength(reads);
  });
  it("requires bounded complete final enumeration before any deletion", async () => {
    const v = setup(), fixture = v.create(); await v.stop.launch(); v.complete(0); const receipt = await v.stop.owner.stop(); fixture.readReport(receipt).fill(0);
    v.s.control.directoryBytes = 1025; terminal(v, () => fixture.verifyAndClose(receipt, 0));
    expect(v.s.calls.some(call => call.name === "NtSetInformationFile")).toBe(false);
  });
  it.each([
    ["process", 1, 90002n, 1], ["process", 0, 90002n, 1], ["process", 1, 0n, 1],
    ["thread", 1, 90001n, 1], ["thread", 0, 90001n, 1], ["thread", 1, 90001n, 0],
  ] as const)("rejects a live file alias in the %s PI field (BOOL%s/other%s/pid%s) before partial-created handling", (field, result, other, pid) => {
    const v = setup(); v.create(); const alias = v.s.opened.find(row => row.access === META)!.raw;
    v.binding.host.original();
    v.s.handlers.CreateProcessW = (...args) => { const pi = args[9] as Buffer;
      pi.writeBigUInt64LE(field === "process" ? alias : other, 0); pi.writeBigUInt64LE(field === "thread" ? alias : other, 8); pi.writeUInt32LE(pid, 16); return result;
    };
    const before = v.s.calls.length;
    terminal(v, () => v.binding.guard(() => v.binding.host.create("C:\\build\\open-target.exe", Buffer.alloc(2), "C:\\scratch", Buffer.alloc(4))));
    expect(v.s.calls.slice(before).map(call => call.name)).toEqual(["CreateProcessW"]); expect(v.s.handles.has(alias)).toBe(true);
  });
  it("rejects a live file alias returned as a host job without a query, termination or close", () => {
    const v = setup(); v.create(); const alias = v.s.opened.find(row => row.access === META)!.raw;
    v.s.handlers.CreateJobObjectW = () => alias; const before = v.s.calls.length;
    terminal(v, () => v.binding.guard(() => v.binding.host.api.createJob()));
    expect(v.s.calls.slice(before).map(call => call.name)).toEqual(["CreateJobObjectW"]); expect(v.s.handles.has(alias)).toBe(true);
  });
  it.each(["job", "process", "thread"] as const)("rejects a borrowed live descriptor alias in a host %s return", role => {
    const v = setup(); v.binding.host.original(); let alias: bigint | undefined;
    v.s.handlers.SetSecurityInfo = (...args) => {
      alias = (args[5] as bigint) - 64n;
      if (role === "job") { v.s.handlers.CreateJobObjectW = () => alias!; v.binding.host.api.createJob(); }
      else {
        v.s.handlers.CreateProcessW = (...argv) => { const pi = argv[9] as Buffer;
          pi.writeBigUInt64LE(role === "process" ? alias! : 90001n, 0); pi.writeBigUInt64LE(role === "thread" ? alias! : 90002n, 8); pi.writeUInt32LE(1, 16); return role === "thread" ? 0 : 1;
        };
        v.binding.host.create("C:\\build\\open-target.exe", Buffer.alloc(2), "C:\\scratch", Buffer.alloc(4));
      }
      throw new Error("The aliased return must never be accepted.");
    };
    terminal(v, v.create); expect(alias).toBeDefined(); expect(v.memory.has(alias!)).toBe(true);
    expect(v.s.calls.at(-1)?.name).toBe(role === "job" ? "CreateJobObjectW" : "CreateProcessW");
    expect(v.s.calls.some(call => ["CloseHandle", "LocalFree", "TerminateProcess", "TerminateJobObject", "GetProcessId"].includes(call.name) && call.args[0] === alias)).toBe(false);
  });
  it("rejects a Native file acquisition that aliases a still-live host job before handle queries", () => {
    const v = setup(true), original = v.s.handlers.NtCreateFile; let returned = false;
    v.s.handlers.NtCreateFile = (...args) => { const result = original(...args);
      if (!returned) { returned = true; (args[0] as bigint[])[0] = 70000n; } return result;
    };
    terminal(v, v.create); expect(v.s.calls.at(-1)?.name).toBe("NtCreateFile");
    expect(v.s.calls.some(call => ["CloseHandle", "TerminateProcess", "TerminateJobObject", "GetProcessId"].includes(call.name) && call.args[0] === 70000n)).toBe(false);
  });
  it.each([70000n, 70001n, 70002n])("allows handle number %s to become a report file only after exact host Stop", async reused => {
    const v = setup(true), fixture = v.create();
    await v.stop.launch(() => v.binding.host.create("C:\\build\\open-target.exe", Buffer.alloc(2), fixture.directory, Buffer.alloc(4)));
    v.complete(0); const receipt = await v.stop.owner.stop(), original = v.s.handlers.NtCreateFile; let changed = false;
    v.s.handlers.NtCreateFile = (...args) => { const result = original(...args), opened = v.s.opened.at(-1)!;
      if (!changed && opened.object.name.endsWith("report.bin")) {
        changed = true; const old = (args[0] as bigint[])[0], state = v.s.handles.get(old)!;
        v.s.handles.delete(old); v.s.handles.set(reused, state); (args[0] as bigint[])[0] = reused; opened.raw = reused;
      } return result;
    };
    fixture.readReport(receipt).fill(0); expect(changed).toBe(true); fixture.verifyAndClose(receipt, 0);
    expect(v.s.handles.size).toBe(0); closeWindowsCommandCreatorProfile(v.ref);
  });
  it("does not clear the host ledger after a foreign genuine Stop receipt", async () => {
    const v = setup(true), fixture = v.create(); await v.stop.launch(() => v.binding.host.create("C:\\build\\open-target.exe", Buffer.alloc(2), fixture.directory, Buffer.alloc(4)));
    const other = job(); await other.launch(); other.state.ended = true; const foreignReceipt = await other.owner.stop(), count = v.s.calls.length;
    terminal(v, () => fixture.readReport(foreignReceipt)); expect(v.s.calls).toHaveLength(count);
    const record = v.fence.retained.find(value => value !== null && typeof value === "object" && "foreign" in value) as { foreign: Set<bigint> };
    expect(record.foreign).toEqual(new Set([70000n, 70001n, 70002n]));
  });
  it("retains the exact bound profile/key/binding when its borrowed SID aliases an issued host job", () => {
    const v = setup(), borrowed = windowsCommandCreatorProfile(v.ref).sid;
    v.s.handlers.CreateJobObjectW = () => borrowed;
    expect(v.binding.host.api.createJob()).toBe(borrowed); const before = v.s.calls.length;
    const error = terminal(v, v.create); expect(v.s.calls).toHaveLength(before);
    const record = v.fence.retained.find(value => value !== null && typeof value === "object" && "pending" in value) as { pending: Set<unknown>; selected?: unknown };
    expect(record.selected).toBeUndefined();
    const issued = [...record.pending].find(value => value !== null && typeof value === "object" && "profile" in value && value.profile === v.ref) as { profile: typeof v.ref; key: object; binding: object };
    expect(issued.profile).toBe(v.ref); expect(issued.binding).toBe(v.stop.binding); expect(issued.key).toBeTypeOf("object");
    expect(issued.key).not.toBe(v.ref); expect(issued.key).not.toBe(v.stop.binding);
    expect(requireWindowsCommandCreatorTree(v.ref, issued.key)).toBe(v.pkg);
    const profileCount = v.profileCalls.length; expect(() => closeWindowsCommandCreatorProfile(v.ref)).toThrow();
    expect(v.profileCalls).toHaveLength(profileCount); expect(v.profileCalls).not.toContain("DeleteAppContainerProfile"); expect(v.profileCalls).not.toContain("FreeSid");
    v.fence.retained.length = 0; expect(thrown(() => v.binding.guard(() => true))).toBe(error); expect(v.s.calls).toHaveLength(before);
    expect(record.pending.has(issued)).toBe(true);
  });
  it.each(["file", "root"] as const)("requires positively written deletion IO status for the %s", async target => {
    for (const status of [5, -1073741790, undefined]) {
      const v = setup(), fixture = v.create(); await v.stop.launch(); v.complete(0); const receipt = await v.stop.owner.stop(); fixture.readReport(receipt).fill(0);
      const original = v.s.handlers.NtSetInformationFile; let failed: bigint | undefined;
      v.s.handlers.NtSetInformationFile = (...args) => {
        const raw = args[0] as bigint, row = v.s.handles.get(raw)!.object!, io = args[1] as Buffer;
        if ((target === "root") === (row.name === fixture.directory)) {
          expect(io.readUInt32LE(0)).toBe(0xffffffff); failed = raw;
          if (status === undefined) { row.removed = true; return 0; }
          const result = original(...args); if (status < 0) io.writeInt32LE(status); else io.writeUInt32LE(status); return result;
        }
        return original(...args);
      };
      terminal(v, () => fixture.verifyAndClose(receipt, 0)); expect(failed).toBeDefined(); expect(v.s.handles.has(failed!)).toBe(true);
      expect(v.s.calls.at(-1)?.name).toBe("NtSetInformationFile");
      const call = v.s.calls.findLastIndex(value => value.name === "NtSetInformationFile"); expect(v.s.calls.slice(call + 1)).toEqual([]);
    }
  });
});
