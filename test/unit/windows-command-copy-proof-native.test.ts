/** ABI/ownership tests with injected functions only; no Windows DLL or native process is called. */
import { expect, it } from "vitest";
import { bindWindowsCommandCopyProofNative, WindowsCommandCopyProofCleanupError, type WindowsCommandCopyProofNative } from "../fixtures/windows-command-copy-proof-native";
const FILE = "C:\\fixture\\report.bin", IMAGE = "C:\\fixture\\tools\\fixed.exe";
const profile = { name: "Ember.Fixed.Fresh", sid: 55n, sidText: "S-1-15-2-1234" };
function setup() {
  const calls: { name: string; args: unknown[] }[] = [], returns = new Map<string, unknown>();
  const control = { content: Buffer.from("data"), handle: 10n as unknown, type: 1 as unknown, flags: 0 as unknown,
    setFlags: true, setPosition: true, position: 0n as unknown, setRead: true, read: 4 as unknown, info: true,
    attributes: 128, links: 1, volume: 7, id: 9, created: 100n, written: 200n, accessed: 150n, sizeHigh: 0,
    pid: 40 as unknown, image: IMAGE, setImageCount: true, imageCount: IMAGE.length as unknown,
    after: undefined as ((name: string, args: unknown[]) => void) | undefined };
  const sentinels: { name: string; value: unknown }[] = [];
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    CreateFileW: () => control.handle,
    GetFileType: () => control.type,
    GetHandleInformation: (...args) => { sentinels.push({ name: "inherit", value: (args[1] as unknown[])[0] }); if (control.setFlags) (args[1] as unknown[])[0] = control.flags; return 1; },
    GetFileInformationByHandle: (...args) => {
      if (!control.info) return 1;
      const b = args[1] as Buffer; b.writeUInt32LE(control.attributes); b.writeBigUInt64LE(control.created, 4); b.writeBigUInt64LE(control.accessed, 12); b.writeBigUInt64LE(control.written, 20);
      b.writeUInt32LE(control.volume, 28); b.writeUInt32LE(control.sizeHigh, 32); b.writeUInt32LE(control.content.length, 36); b.writeUInt32LE(control.links, 40); b.writeUInt32LE(control.id, 48); return 1;
    },
    SetFilePointerEx: (...args) => { sentinels.push({ name: "seek", value: (args[2] as unknown[])[0] }); if (control.setPosition) (args[2] as unknown[])[0] = control.position; return 1; },
    ReadFile: (...args) => { sentinels.push({ name: "read", value: (args[3] as unknown[])[0] }); control.content.copy(args[1] as Buffer); if (control.setRead) (args[3] as unknown[])[0] = control.read; return 1; },
    CloseHandle: () => 1,
    GetProcessId: () => control.pid,
    QueryFullProcessImageNameW: (...args) => { (args[2] as Buffer).write(control.image, "utf16le"); if (control.setImageCount) (args[3] as unknown[])[0] = control.imageCount; return 1; },
    DeleteAppContainerProfile: () => 0,
    FreeSid: () => null,
  };
  const load = () => ({ func(prototype: string) { const name = /\b(\w+)\s*\(/.exec(prototype)![1]; return (...args: unknown[]) => {
    calls.push({ name, args }); let value: unknown;
    if (returns.has(name)) value = returns.get(name); else value = handlers[name](...args);
    control.after?.(name, args); return value;
  }; } });
  const api = bindWindowsCommandCopyProofNative(load);
  return { api, calls, returns, control, sentinels };
}
function pin() { const s = setup(); return { ...s, pin: s.api.pin(FILE, 1024) }; }
const count = (s: ReturnType<typeof setup>, name: string) => s.calls.filter(call => call.name === name).length;
function fenced(api: WindowsCommandCopyProofNative, calls: unknown[]) {
  const before = calls.length; let entered = false;
  for (const operation of [() => api.pin(FILE, 1024), () => api.image(30n, 40, IMAGE), () => api.close(999n), () => api.deleteProfile(profile), () => api.guard(() => { entered = true; })]) expect(operation).toThrow(WindowsCommandCopyProofCleanupError);
  expect(entered).toBe(false); expect(calls).toHaveLength(before); expect(api.unsafe).toBe(true);
}

it("opens only a nonshared-write ordinary read pin and returns detached repeatable bytes", () => {
  const s = pin(); expect(s.pin.bytes).toBe(4);
  expect(s.calls[0]).toEqual({ name: "CreateFileW", args: [FILE, 0x80000080, 1, null, 3, 0x200000, null] });
  const result = s.pin.read(); expect(result).toEqual(Buffer.from("data")); result.fill(0); expect(s.pin.read()).toEqual(Buffer.from("data"));
  expect(s.sentinels.filter(value => ["seek", "read", "inherit"].includes(value.name)).every(value => value.value === undefined)).toBe(true);
  s.pin.close(); s.pin.close(); expect(count(s, "CloseHandle")).toBe(1);
});
it.each([0, 0n])("accepts only the explicit seek zero representation %s", value => {
  const s = pin(); s.control.position = value; expect(s.pin.read()).toEqual(Buffer.from("data")); s.pin.close();
});
it.each([undefined, null, false, true, "0", 1, -1, NaN, 1n])("rejects malformed/nonzero seek output %s without reading data", value => {
  const s = pin(); s.control.position = value;
  expect(() => s.pin.read()).toThrow(WindowsCommandCopyProofCleanupError); expect(count(s, "ReadFile")).toBe(0); fenced(s.api, s.calls);
});
it("does not accept a successful seek whose output slot was never written", () => {
  const s = pin(); s.control.setPosition = false; expect(() => s.pin.read()).toThrow(WindowsCommandCopyProofCleanupError);
  expect(s.sentinels.find(value => value.name === "seek")!.value).toBeUndefined(); expect(count(s, "ReadFile")).toBe(0);
});
it.each([undefined, null, false, true, "4", 0, 3, 5, 4n, NaN])("refuses a nonexact ReadFile byte count %s", value => {
  const s = pin(); s.control.read = value; expect(() => s.pin.read()).toThrow(WindowsCommandCopyProofCleanupError); fenced(s.api, s.calls);
});
it("does not infer zero bytes from an unset output when reading an empty marker", () => {
  const s = setup(); s.control.content = Buffer.alloc(0); s.control.read = 0; const owned = s.api.pin(FILE, 1);
  expect(owned.read()).toEqual(Buffer.alloc(0)); s.control.setRead = false;
  expect(() => owned.read()).toThrow(WindowsCommandCopyProofCleanupError); expect(s.sentinels.filter(value => value.name === "read").every(value => value.value === undefined)).toBe(true);
});
it.each([0, false, true, undefined, null, "1", NaN, 1.5, 0x80000000, -0x80000001])("refuses non-ABI BOOL %s for metadata without continuing", value => {
  const s = setup(); s.returns.set("GetFileInformationByHandle", value); expect(() => s.api.pin(FILE, 1024)).toThrow(WindowsCommandCopyProofCleanupError);
  expect(s.calls.at(-1)!.name).toBe("GetFileInformationByHandle"); fenced(s.api, s.calls);
});
it.each([1, 2, -1, -0x80000000, 0x7fffffff])("accepts a documented nonzero signed BOOL %s", value => {
  const s = setup(); s.control.after = (name, args) => { if (name === "GetFileInformationByHandle") { const b = args[1] as Buffer; b.writeUInt32LE(128); b.writeUInt32LE(1, 40); } };
  s.returns.set("GetFileInformationByHandle", value); const owned = s.api.pin(FILE, 1024); owned.close(); expect(s.api.unsafe).toBe(false);
});
it.each([0x10, 0x40, 0x200, 0x400, 0x1000, 0x4000])("refuses special/dir file attributes0x%s", attribute => {
  const s = setup(); s.control.attributes |= attribute; expect(() => s.api.pin(FILE, 1024)).toThrow(WindowsCommandCopyProofCleanupError); expect(count(s, "ReadFile")).toBe(0);
});
it.each([0, 2, 0xffffffff])("refuses nonunit file link count %s", links => { const s = setup(); s.control.links = links; expect(() => s.api.pin(FILE, 1024)).toThrow(WindowsCommandCopyProofCleanupError); });
it.each([undefined, 0n, false, 1, 2])("requires an explicitly written noninheritable flag0, refusing %s", flags => {
  const s = setup(); s.control.flags = flags; expect(() => s.api.pin(FILE, 1024)).toThrow(WindowsCommandCopyProofCleanupError);
});
it("refuses metadata TRUE with no output or unset inheritance output", () => {
  for (const fault of ["info", "flags"]) { const s = setup(); if (fault === "info") s.control.info = false; else s.control.setFlags = false;
    expect(() => s.api.pin(FILE, 1024)).toThrow(WindowsCommandCopyProofCleanupError); expect(count(s, "ReadFile")).toBe(0); }
});
it.each([0n, -1n, 0xffffffffffffffffn, 0x8000000000000000n, 10, null, undefined])("refuses invalid/ambiguous file handles %s before querying", handle => {
  const s = setup(); s.control.handle = handle; expect(() => s.api.pin(FILE, 1024)).toThrow(WindowsCommandCopyProofCleanupError); expect(s.calls.map(call => call.name)).toEqual(["CreateFileW"]);
});
it("refuses an aliased live handle but permits a new owned lifetime after a known close", () => {
  const s = pin(); expect(() => s.api.pin(FILE, 1024)).toThrow(WindowsCommandCopyProofCleanupError);
  const fresh = pin(); fresh.pin.close(); const next = fresh.api.pin(FILE, 1024); next.close(); expect(count(fresh, "CloseHandle")).toBe(2);
});
it.each(["attributes", "links", "volume", "id", "created", "written", "size"])("detects held metadata mutation: %s", field => {
  const s = pin();
  if (field === "attributes") s.control.attributes |= 1;
  else if (field === "links") s.control.links = 2;
  else if (field === "volume") s.control.volume++;
  else if (field === "id") s.control.id++;
  else if (field === "created") s.control.created++;
  else if (field === "written") s.control.written++;
  else s.control.content = Buffer.from("changed");
  expect(() => s.pin.unchanged()).toThrow(WindowsCommandCopyProofCleanupError); fenced(s.api, s.calls);
});
it("tolerates only access-time changes and catches a write during the bounded read", () => {
  const s = pin(); s.control.accessed++; expect(s.pin.read()).toEqual(Buffer.from("data"));
  s.control.after = name => { if (name === "ReadFile") s.control.written++; };
  expect(() => s.pin.read()).toThrow(WindowsCommandCopyProofCleanupError); fenced(s.api, s.calls);
});
it.each([0, true, undefined, "1"])("first uncertain close %s fences every later call and is never retried", value => {
  const s = pin(); s.returns.set("CloseHandle", value); expect(() => s.pin.close()).toThrow(WindowsCommandCopyProofCleanupError);
  expect(count(s, "CloseHandle")).toBe(1); expect(() => s.pin.close()).toThrow(WindowsCommandCopyProofCleanupError); fenced(s.api, s.calls); expect(count(s, "CloseHandle")).toBe(1);
});
it("fences a thrown close even when it might already have completed", () => {
  const s = pin(); s.control.after = name => { if (name === "CloseHandle") throw new Error("private native completion"); };
  expect(() => s.pin.close()).toThrow(WindowsCommandCopyProofCleanupError); fenced(s.api, s.calls); expect(count(s, "CloseHandle")).toBe(1);
});
it("does not return success from a guard that catches its own reentrant native uncertainty", () => {
  const s = setup(); s.returns.set("CloseHandle", 0);
  expect(() => s.api.guard(() => { try { s.api.close(900n); } catch { /* Simulate an older API swallowing its cleanup error. */ } return 123; })).toThrow(WindowsCommandCopyProofCleanupError);
  expect(count(s, "CloseHandle")).toBe(1); fenced(s.api, s.calls);
});
it.each(["CreateFileW", "ReadFile", "QueryFullProcessImageNameW"])("refuses later pin/image queries after a swallowed reentrant failure inside %s", target => {
  const s = setup(); const owned = target === "ReadFile" ? s.api.pin(FILE, 1024) : undefined; s.returns.set("CloseHandle", 0); let after = -1;
  s.control.after = name => { if (name === target) { try { s.api.close(900n); } catch { /* The outer native callback returns an apparently valid result. */ } after = s.calls.length; } };
  expect(() => target === "CreateFileW" ? s.api.pin(FILE, 1024) : target === "ReadFile" ? owned!.read() : s.api.image(30n, 40, IMAGE)).toThrow(WindowsCommandCopyProofCleanupError);
  expect(s.calls).toHaveLength(after); fenced(s.api, s.calls);
});
it.each([0, -2147024894, 1, false, undefined, "0"])("requires exact zero DeleteAppContainerProfile HRESULT, observing %s", value => {
  const s = setup(); s.returns.set("DeleteAppContainerProfile", value);
  if (value === 0) { s.api.deleteProfile(profile); expect(count(s, "FreeSid")).toBe(1); expect(s.api.unsafe).toBe(false); }
  else { expect(() => s.api.deleteProfile(profile)).toThrow(WindowsCommandCopyProofCleanupError); expect(count(s, "FreeSid")).toBe(0); fenced(s.api, s.calls); }
});
it.each([null, 0n])("accepts only the documented successful FreeSid pointer return %s", value => {
  const s = setup(); s.returns.set("FreeSid", value); s.api.deleteProfile(profile); expect(count(s, "DeleteAppContainerProfile")).toBe(1); expect(count(s, "FreeSid")).toBe(1);
});
it.each([0, false, undefined, 55n, 1, "0"])("never retries a FreeSid with unverified return %s", value => {
  const s = setup(); s.returns.set("FreeSid", value); expect(() => s.api.deleteProfile(profile)).toThrow(WindowsCommandCopyProofCleanupError); const before = s.calls.length;
  expect(() => s.api.deleteProfile({ ...profile })).toThrow(WindowsCommandCopyProofCleanupError); expect(s.calls).toHaveLength(before); expect(count(s, "FreeSid")).toBe(1);
});
it.each(["same object", "same SID clone", "same name casefold"])("allows no second profile deletion/free through %s", alias => {
  const s = setup(); s.api.deleteProfile(profile); const before = s.calls.length;
  const next = alias === "same object" ? profile : alias === "same SID clone" ? { ...profile, name: "Another.Name" } : { ...profile, sid: 66n, name: profile.name.toUpperCase() };
  expect(() => s.api.deleteProfile(next)).toThrow(WindowsCommandCopyProofCleanupError); expect(s.calls).toHaveLength(before); expect(count(s, "FreeSid")).toBe(1);
});
it("matches an exact PID and case-insensitive exact image without accepting path aliases", () => {
  const s = setup(); s.api.image(30n, 40, IMAGE.toUpperCase()); expect(s.api.unsafe).toBe(false);
  s.control.image = "C:\\fixture\\tools\\..\\tools\\fixed.exe"; s.control.imageCount = s.control.image.length;
  expect(() => s.api.image(30n, 40, IMAGE)).toThrow(WindowsCommandCopyProofCleanupError); fenced(s.api, s.calls);
});
it.each([0, 41, 40n, "40", undefined])("refuses a wrong/non-DWORD process-ID result %s without querying image bytes", value => {
  const s = setup(); s.control.pid = value; expect(() => s.api.image(30n, 40, IMAGE)).toThrow(WindowsCommandCopyProofCleanupError); expect(count(s, "QueryFullProcessImageNameW")).toBe(0);
});
it.each([undefined, 0, -1, 32768, "4", 4n, NaN])("refuses invalid image character output %s", value => {
  const s = setup(); s.control.imageCount = value; expect(() => s.api.image(30n, 40, IMAGE)).toThrow(WindowsCommandCopyProofCleanupError);
});
it("refuses image success that leaves its in/out capacity unchanged", () => {
  const s = setup(); s.control.setImageCount = false; expect(() => s.api.image(30n, 40, IMAGE)).toThrow(WindowsCommandCopyProofCleanupError);
});
