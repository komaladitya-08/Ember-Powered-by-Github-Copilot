/** Portable Win64 ABI models for read-only asset pins, exact security readback and permanent cleanup fences. */
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { bindWindowsNodeAssetEnforcementNative, WindowsNodeAssetEnforcementNativeCleanupError,
  WINDOWS_NODE_ASSET_ENFORCEMENT_FUNCTIONS, type WindowsNodeAssetEnforcementTargets } from "../fixtures/windows-node-asset-enforcement-native";

const ownerSid = "S-1-5-21-100-200-300-1000", packageSid = "S-1-15-2-123-456-789";
const input: WindowsNodeAssetEnforcementTargets = { parent: "C:\\case\\assets", root: "C:\\case\\assets\\ember-node-fresh",
  image: "C:\\case\\assets\\ember-node-fresh\\node.exe", lowOwner: "C:\\case\\low-owner", lowFullDirectory: "C:\\case\\low-full",
  lowFullFile: "C:\\case\\low-full\\full-file.txt", mediumFullDirectory: "C:\\case\\medium-full", mediumFullFile: "C:\\case\\medium-full\\full-file.txt",
  ownerSid, packageSid, parentLabel: "explicit" };
const paths = [input.parent, input.root, input.image, input.lowOwner, input.lowFullDirectory, input.lowFullFile, input.mediumFullDirectory, input.mediumFullFile];
type Row = { file: string; index: number; directory: boolean; identity: bigint; volume: number; write: bigint; creation: bigint; size: number; security: Buffer };
type Call = { name: string; args: unknown[] };
function sid(text: string): Buffer {
  const parts = text.split("-"), subs = parts.slice(3).map(Number), bytes = Buffer.alloc(8 + subs.length * 4);
  bytes[0] = 1; bytes[1] = subs.length; let authority = BigInt(parts[2]);
  for (let i = 7; i >= 2; i--) { bytes[i] = Number(authority & 255n); authority >>= 8n; }
  for (let i = 0; i < subs.length; i++) bytes.writeUInt32LE(subs[i], 8 + i * 4); return bytes;
}
function acl(rows: readonly { sid: string; mask: number; type?: number }[], flags: number): Buffer {
  const aces = rows.map(row => { const value = sid(row.sid), bytes = Buffer.alloc(8 + value.length); bytes[0] = row.type ?? 0;
    bytes[1] = flags; bytes.writeUInt16LE(bytes.length, 2); bytes.writeUInt32LE(row.mask, 4); value.copy(bytes, 8); return bytes; });
  const bytes = Buffer.alloc(8 + aces.reduce((size, ace) => size + ace.length, 0)); bytes[0] = 2; bytes.writeUInt16LE(bytes.length, 2); bytes.writeUInt16LE(aces.length, 4);
  let offset = 8; for (const ace of aces) { ace.copy(bytes, offset); offset += ace.length; } return bytes;
}
function descriptor(index: number, parentLabel: "explicit" | "absent" | "empty" = "explicit"): Buffer {
  const flags = index === 2 || index === 5 || index === 7 ? 0 : 3;
  const rows = [{ sid: ownerSid, mask: 0x1f01ff }, { sid: "S-1-5-18", mask: 0x1f01ff },
    ...([0, 3].includes(index) ? [] : [{ sid: packageSid, mask: index === 1 || index === 2 ? 0x1200a9 : 0x1f01ff }]),
    ...(index === 1 || index === 2 ? [{ sid: "S-1-3-4", mask: 0x20000 }] : [])];
  const owner = sid(ownerSid), dacl = acl(rows, flags), sacl = parentLabel === "absent" ? Buffer.alloc(0) : acl(parentLabel === "empty" ? [] : [{ sid: `S-1-16-${index === 0 || index >= 6 ? 8192 : 4096}`, mask: 1, type: 17 }], flags);
  const bytes = Buffer.alloc(20 + owner.length + dacl.length + sacl.length); bytes[0] = 1; bytes.writeUInt16LE(parentLabel === "absent" ? 0x9004 : 0x9014, 2);
  bytes.writeUInt32LE(20, 4); bytes.writeUInt32LE(20, 8); bytes.writeUInt32LE(20 + owner.length, 16); bytes.writeUInt32LE(parentLabel === "absent" ? 0 : 20 + owner.length + dacl.length, 12);
  owner.copy(bytes, 20); dacl.copy(bytes, 20 + owner.length); sacl.copy(bytes, 20 + owner.length + dacl.length); return bytes;
}
function setup(fault = "") {
  const calls: Call[] = [], handles = new Map<bigint, { row: Row; access: number }>(), allocations = new Map<bigint, Buffer>(), closed: bigint[] = [], freed: bigint[] = [];
  const tokens = new Set<bigint>(), local = new Set<bigint>();
  const rows = paths.map((file, index): Row => ({ file, index, directory: index !== 2 && index !== 5 && index !== 7, identity: BigInt(index + 100), volume: 7,
    write: 3000n, creation: 1000n, size: 512, security: descriptor(index) }));
  const control = { fault, faultIndex: 0, reenter: undefined as (() => void) | undefined, mutateSecurity: undefined as ((bytes: Buffer) => void) | undefined,
    threwOutput: undefined as unknown[] | undefined, freedReentry: false, decoded: 0, pid: 31415, integrityRid: 8192, integrityAttributes: 0x60, policy: 1,
    integrityLength: 28, policyLength: 4, tokenKind: 0, tokenRaw: undefined as bigint | undefined, localRaw: undefined as bigint | undefined,
    securityRaw: undefined as bigint | undefined, nextFileRaw: undefined as bigint | undefined,
    failedCloseRaw: undefined as bigint | undefined,
    mutateIntegrity: undefined as ((bytes: Buffer, raw: bigint) => void) | undefined };
  const fence = { retained: [] as unknown[], failure: undefined as WindowsNodeAssetEnforcementNativeCleanupError | undefined };
  let nextHandle = 20n, nextAllocation = 0x100000n;
  const load = () => ({ func(prototype: string) {
    const name = /\b(\w+)\s*\(/.exec(prototype)![1];
    return (...args: unknown[]) => {
      calls.push({ name, args });
      if (name === "GetProcessId") {
        if (control.fault === "pid throw") throw Error("private process diagnostic");
        if (control.fault === "pid reentry") { try { control.reenter?.(); } catch { /* Model swallowed reentry. */ } }
        return control.fault === "pid mismatch" ? control.pid + 1 : control.fault === "pid unknown" ? undefined : control.pid;
      }
      if (name === "OpenProcessToken") {
        const raw = control.tokenRaw ?? nextHandle++; (args[2] as unknown[])[0] = raw; tokens.add(raw);
        if (control.fault === "token open throw") throw Error("private partial token");
        if (control.fault === "token open reentry") { try { control.reenter?.(); } catch { /* Model swallowed reentry. */ } }
        return control.fault === "token open false" ? 0 : control.fault === "token open unknown" ? undefined : 1;
      }
      if (name === "LocalAlloc") {
        if (control.fault === "local throw") throw Error("private allocation diagnostic");
        if (control.fault === "local null") return null;
        const raw = control.localRaw ?? nextAllocation; nextAllocation += 0x10000n;
        allocations.set(raw, Buffer.alloc(args[1] as number)); local.add(raw);
        if (control.fault === "local reentry") { try { control.reenter?.(); } catch { /* Model swallowed reentry. */ } }
        return raw;
      }
      if (name === "GetTokenInformation") {
        const raw = args[2] as bigint, kind = args[1] as number, bytes = allocations.get(raw)!; control.tokenKind = kind; bytes.fill(0);
        if (kind === 25) {
          bytes.writeBigUInt64LE(raw + 16n, 0); bytes.writeUInt32LE(control.integrityAttributes, 8); sid(`S-1-16-${control.integrityRid}`).copy(bytes, 16);
          control.mutateIntegrity?.(bytes, raw); (args[4] as unknown[])[0] = control.integrityLength;
        } else { bytes.writeUInt32LE(control.policy, 0); (args[4] as unknown[])[0] = control.policyLength; }
        if (control.fault === `token query${kind} throw`) throw Error("private token query diagnostic");
        if (control.fault === `token query${kind} reentry`) { try { control.reenter?.(); } catch { /* Model swallowed reentry. */ } }
        return control.fault === `token query${kind} false` ? 0 : control.fault === `token query${kind} unknown` ? undefined : 1;
      }
      if (name === "CreateFileW") {
        if (control.fault === "open throw") throw new Error("private native path and credential");
        if (control.fault === "invalid handle") return 0xffffffffffffffffn;
        const row = rows.find(row => row.file === args[0])!;
        if (control.fault === "aliased handle" && handles.size) return [...handles.keys()][0];
        if (control.fault === "target handle alias" && row.index === control.faultIndex && handles.size) return [...handles.keys()][0];
        const raw = control.nextFileRaw ?? (control.fault === "reuse resources" && closed.length ? closed[closed.length - 1] : nextHandle++); control.nextFileRaw = undefined;
        handles.set(raw, { row, access: args[1] as number }); return raw;
      }
      if (name === "GetFileType") return control.fault === "wrong file type" ? 2 : 1;
      if (name === "GetHandleInformation") {
        const token = tokens.has(args[0] as bigint);
        (args[1] as unknown[])[0] = control.fault === "inheritable pin" || token && control.fault === "token inherit" ? 1 : 0;
        if (token && control.fault === "token flags reentry") { try { control.reenter?.(); } catch { /* Model swallowed reentry. */ } }
        return control.fault === "unknown BOOL" || token && control.fault === "token flags unknown" ? undefined : token && control.fault === "token flags false" ? 0 : 1;
      }
      if (name === "GetFileInformationByHandle") {
        const { row, access } = handles.get(args[0] as bigint)!, bytes = args[1] as Buffer;
        bytes.writeUInt32LE(row.directory ? 16 : 128, 0); bytes.writeBigUInt64LE(row.creation, 4); bytes.writeBigUInt64LE(row.write, 20);
        bytes.writeUInt32LE(control.fault === "wrong volume" && row.index === 1 ? 8 : row.volume, 28); bytes.writeUInt32LE(row.size, 36); bytes.writeUInt32LE(control.fault === "hard link" ? 2 : 1, 40);
        bytes.writeBigUInt64LE(control.fault === "probe wrong identity" && (access === 0x40080 || access === 0x80080) ? 999n : row.identity, 44);
        if (control.fault === "reparse") bytes.writeUInt32LE(bytes.readUInt32LE(0) | 0x400, 0);
        if (control.fault === "metadata reentry") { try { control.reenter?.(); } catch { /* Model a swallowed native callback failure. */ } }
        return 1;
      }
      if (name === "GetFinalPathNameByHandleW") {
        const { row } = handles.get(args[0] as bigint)!, text = `\\\\?\\${control.fault === "path alias" ? "C:\\other" : row.file}`;
        Buffer.from(text + "\0", "utf16le").copy(args[1] as Buffer); return text.length;
      }
      if (name === "GetSecurityInfo") {
        const { row } = handles.get(args[0] as bigint)!, bytes = Buffer.from(row.security);
        if (row.index === control.faultIndex) control.mutateSecurity?.(bytes);
        const raw = control.securityRaw ?? (control.fault === "allocation handle alias" || control.fault === "target allocation handle alias" && row.index === control.faultIndex ? args[0] as bigint : control.fault === "reuse resources" ? 0x100000n : nextAllocation); nextAllocation += 0x10000n;
        allocations.set(raw, bytes); (args[3] as unknown[])[0] = raw + BigInt(bytes.readUInt32LE(4));
        (args[5] as unknown[])[0] = raw + BigInt(bytes.readUInt32LE(16)); (args[6] as unknown[])[0] = bytes.readUInt32LE(12) ? raw + BigInt(bytes.readUInt32LE(12)) : null; (args[7] as unknown[])[0] = raw;
        if (control.fault === "foreign owner pointer") (args[3] as unknown[])[0] = raw + 65536n;
        if (control.fault === "foreign absent label pointer") (args[6] as unknown[])[0] = raw + 20n;
        if (control.fault === "missing present label pointer") (args[6] as unknown[])[0] = null;
        if (control.fault === "descriptor throw") { control.threwOutput = args[7] as unknown[]; throw new Error("private partial native allocation"); }
        if (control.fault === "descriptor status") return 5;
        return 0;
      }
      if (name === "GetSecurityDescriptorLength") return control.fault === "short descriptor" ? 19 : control.fault === "oversize descriptor" ? 65537 : allocations.get(args[0] as bigint)!.length;
      if (name === "LocalFree") {
        const raw = args[0] as bigint; freed.push(raw);
        if (local.has(raw) && control.fault === "token free throw") throw Error("private token buffer free");
        if (local.has(raw) && control.fault === "token free failed") return raw;
        if (local.has(raw) && control.fault === "token free reentry") { try { control.reenter?.(); } catch { /* Model swallowed reentry. */ } }
        if (control.fault === "free throw") throw new Error("private native free diagnostic");
        if (control.fault === "free reentry") { control.freedReentry = true; try { control.reenter?.(); } catch { /* Model a swallowed callback. */ } }
        if (control.fault === "free failed") return raw;
        allocations.delete(raw); local.delete(raw); return null;
      }
      if (name === "CloseHandle") {
        const raw = args[0] as bigint; closed.push(raw);
        if (raw === control.failedCloseRaw) return 0;
        if (tokens.has(raw) && control.fault === "token close throw") throw Error("private token close");
        if (tokens.has(raw) && control.fault === "token close failed") return 0;
        if (tokens.has(raw) && control.fault === "token close reentry") { try { control.reenter?.(); } catch { /* Model swallowed reentry. */ } }
        if (control.fault === "close throw") throw new Error("private close diagnostic");
        if (control.fault === "close failed") return 0;
        if (control.fault === "close reentry") { try { control.reenter?.(); } catch { /* Model a swallowed callback. */ } }
        handles.delete(raw); tokens.delete(raw); return 1;
      }
      throw new Error("unexpected ABI call");
    };
  } });
  const native = { sizeof: () => 8, decode(raw: bigint, _type: string, length: number) {
    control.decoded++;
    if (control.fault === "decode throw") throw new Error("private native decode diagnostic");
    if (control.fault === "decode short") return [1];
    if (control.fault === "decode shared") return new Uint8Array(new SharedArrayBuffer(length));
    if (control.fault === "decode reentry") { try { control.reenter?.(); } catch { /* Model a swallowed callback. */ } }
    if (local.has(raw) && control.fault === `token decode${control.tokenKind} throw`) throw Error("private token decode");
    return Array.from(allocations.get(raw)!.subarray(0, length));
  } } as unknown as Parameters<typeof bindWindowsNodeAssetEnforcementNative>[0];
  const api = bindWindowsNodeAssetEnforcementNative(native, load, fence);
  return { api, calls, handles, allocations, tokens, local, closed, freed, rows, control, fence, native, load };
}

it("pins the exact eight objects, proves host WDAC/WOWNER and preserves Low/Medium owner/DACL controls without mutation", () => {
  const s = setup(), pins = s.api.pinTargets(input);
  const held = [...s.handles.keys()]; expect(held).toHaveLength(8);
  const opens = s.calls.filter(call => call.name === "CreateFileW");
  expect(opens.slice(0, 8).map(call => call.args[0])).toEqual(paths);
  expect(opens.slice(8).map(call => [call.args[0], call.args[1], call.args[2]])).toEqual(paths.slice(0, 3).flatMap(file => [[file, 0x40080, 7], [file, 0x80080, 7]]));
  expect(s.calls.filter(call => call.name === "GetSecurityInfo").every(call => call.args[1] === 1 && call.args[2] === 0x15 && call.args[4] === null)).toBe(true);
  expect(s.calls.filter(call => call.name === "CreateFileW").every(call => call.args[4] === 3 && call.args[3] === null && call.args[6] === null)).toBe(true);
  // The full-package directory's successful CREATE_NEW control changes its timestamps and size, not its identity.
  s.rows[4].write++; s.rows[4].size++; pins.recheck(); pins.close(); pins.close();
  expect(s.api.unsafe).toBe(false); expect(s.handles.size).toBe(0); expect(s.allocations.size).toBe(0);
  expect(s.closed).toHaveLength(14); expect(new Set(s.closed).size).toBe(14);
  expect(s.closed.slice(-8)).toEqual(held.reverse());
  expect(s.freed).toHaveLength(24); expect(new Set(s.freed).size).toBe(24);
  expect(Object.keys(pins).sort()).toEqual(["close", "observeHeldToken", "recheck", "requireTokenObservation"]);
  expect(Object.values(WINDOWS_NODE_ASSET_ENFORCEMENT_FUNCTIONS).flat().join("\n")).not.toMatch(/SetSecurity|WriteFile|Impersonate|CreateProcess|DeleteFile/);
});

it.each(["invalid handle", "open throw", "aliased handle", "wrong file type", "inheritable pin", "unknown BOOL", "wrong volume", "hard link", "reparse", "path alias", "probe wrong identity",
  "allocation handle alias", "foreign owner pointer", "descriptor throw", "descriptor status", "short descriptor", "oversize descriptor", "decode throw", "decode short", "decode shared", "free throw", "free failed"])("fences every later native operation after the ABI uncertainty %s", fault => {
  const s = setup(fault); expect(() => s.api.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  const count = s.calls.length; expect(s.api.unsafe).toBe(true); expect(() => s.api.guard(() => undefined)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  expect(s.calls).toHaveLength(count); expect(s.fence.retained.length).toBeGreaterThan(0);
  expect(new Set(s.closed).size).toBe(s.closed.length); expect(new Set(s.freed).size).toBe(s.freed.length);
  if (fault === "descriptor throw") { expect(typeof s.control.threwOutput?.[0]).toBe("bigint"); expect(s.freed).toHaveLength(0); }
});

const malformed: readonly [string, (bytes: Buffer) => void][] = [
  ["descriptor revision", b => { b[0] = 2; }], ["defaulted owner", b => b.writeUInt16LE(0x9015, 2)],
  ["absolute descriptor", b => b.writeUInt16LE(0x1014, 2)], ["unprotected DACL", b => b.writeUInt16LE(0x8014, 2)],
  ["missing label", b => b.writeUInt16LE(0x9004, 2)], ["unaligned owner", b => b.writeUInt32LE(21, 4)],
  ["outside owner", b => b.writeUInt32LE(65532, 4)], ["oversized SID", b => { b[21] = 16; }],
  ["foreign group", b => b.writeUInt32LE(1, 8)], ["DACL owner overlap", b => b.writeUInt32LE(20, 16)],
  ["ACL revision", b => { b[b.readUInt32LE(16)] = 3; }], ["ACL reserved", b => { b[b.readUInt32LE(16) + 1] = 1; }],
  ["ACL outside span", b => b.writeUInt16LE(65532, b.readUInt32LE(16) + 2)], ["extra DACL ACE", b => b.writeUInt16LE(3, b.readUInt32LE(16) + 4)],
  ["deny ACE", b => { b[b.readUInt32LE(16) + 8] = 1; }], ["inherited ACE", b => { b[b.readUInt32LE(16) + 9] |= 16; }],
  ["unknown rights", b => b.writeUInt32LE(0xffffffff, b.readUInt32LE(16) + 12)], ["short ACE", b => b.writeUInt16LE(12, b.readUInt32LE(16) + 10)],
  ["oversized ACE", b => b.writeUInt16LE(65532, b.readUInt32LE(16) + 10)], ["label overlap", b => b.writeUInt32LE(b.readUInt32LE(16), 12)],
  ["wrong label type", b => { b[b.readUInt32LE(12) + 8] = 0; }], ["wrong label flags", b => { b[b.readUInt32LE(12) + 9] = 0; }],
  ["extra label policy", b => b.writeUInt32LE(3, b.readUInt32LE(12) + 12)], ["Low private parent", b => b.writeUInt32LE(4096, b.readUInt32LE(12) + 24)],
];
it.each(malformed)("refuses bounded security readback with %s", (_name, mutate) => {
  const s = setup(); s.control.mutateSecurity = mutate;
  expect(() => s.api.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.api.unsafe).toBe(true);
  expect(s.freed).toHaveLength(0);
});

it.each([1, 2, 3, 4, 5])("refuses a non-Low label on object %i", index => {
  const s = setup(); s.control.faultIndex = index; s.control.mutateSecurity = b => b.writeUInt32LE(8192, b.readUInt32LE(12) + 24);
  expect(() => s.api.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
});

it.each(["metadata reentry", "decode reentry", "free reentry"])("retains the first permanent failure when %s is swallowed", fault => {
  const s = setup(fault); s.control.reenter = () => s.api.guard(() => undefined);
  expect(() => s.api.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  const count = s.calls.length; s.fence.failure = undefined; s.fence.retained.length = 0;
  expect(() => bindWindowsNodeAssetEnforcementNative(s.native, s.load, s.fence)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  expect(s.calls).toHaveLength(count); expect(s.api.unsafe).toBe(true);
});

it.each(["close failed", "close throw", "close reentry"])("never retries an uncertain close after %s", fault => {
  const s = setup(), pins = s.api.pinTargets(input); s.control.fault = fault; s.control.reenter = () => pins.recheck();
  expect(() => pins.close()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); const count = s.calls.length;
  expect(() => pins.close()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls).toHaveLength(count);
  expect(new Set(s.closed).size).toBe(s.closed.length);
});

it.each(["identity", "creation", "write", "size", "security"])("rechecks immutable file %s after the fixed child stopped", field => {
  const s = setup(), pins = s.api.pinTargets(input);
  if (field === "identity") s.rows[2].identity++; else if (field === "creation") s.rows[2].creation++;
  else if (field === "write") s.rows[2].write++; else if (field === "size") s.rows[2].size++;
  else s.rows[2].security.writeUInt32LE(8192, s.rows[2].security.readUInt32LE(12) + 24);
  expect(() => pins.recheck()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
});

it.each([() => Promise.resolve(), () => runInNewContext("Promise.resolve()") as unknown, () => ({ then() { /* A deferred callback is never admitted. */ } }),
  () => Object.create({ then() { /* Inherited thenables are asynchronous too. */ } }) as unknown])("refuses asynchronous guard results without granting a Stop or cleanup authority", result => {
  const s = setup(); expect(() => s.api.guard(result)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.api.unsafe).toBe(true);
});

it("permits synchronous guarded pins but rejects swallowed guard reentry and leaks no native facts in errors", () => {
  const s = setup(), pins = s.api.guard(() => s.api.pinTargets(input)); pins.close();
  let caught: unknown;
  try { s.api.guard(() => { try { s.api.guard(() => undefined); } catch (error) { caught = error; } }); } catch (error) { expect(error).toBe(caught); }
  expect(caught).toBeInstanceOf(WindowsNodeAssetEnforcementNativeCleanupError);
  expect(String(caught)).not.toMatch(/C:|S-1-|credential|0x|handle|pointer/);
});

it("detaches the historical identity from writable native output", () => {
  const s = setup(), pins = s.api.pinTargets(input);
  const baseline = s.calls.find(call => call.name === "GetFileInformationByHandle" && (call.args[1] as Buffer).readBigUInt64LE(44) === s.rows[2].identity)!.args[1] as Buffer;
  s.rows[2].identity = 999n; baseline.writeBigUInt64LE(999n, 44);
  expect(() => pins.recheck()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
});

it("fences binding reentry from input capture before another ABI call", () => {
  const s = setup(); let count = 0;
  const reentrant = new Proxy(input, { ownKeys(target) {
    count = s.calls.length;
    try { bindWindowsNodeAssetEnforcementNative(s.native, s.load, s.fence); } catch { /* Swallow the inner refusal. */ }
    return Reflect.ownKeys(target);
  } });
  expect(() => s.api.pinTargets(reentrant)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls).toHaveLength(count);
});

it("keeps foreign outward fence accessors from escaping as raw errors", () => {
  const s = setup(); Object.defineProperty(s.fence, "failure", { get() { throw new Error("private credential and path"); } });
  expect(() => s.api.guard(() => undefined)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  expect(s.api.unsafe).toBe(true); expect(s.calls).toHaveLength(0);
});

it.each([0, 1, 3])("retains immutable directory clocks on object %i", index => {
  const s = setup(), pins = s.api.pinTargets(input); s.rows[index].write++;
  expect(() => pins.recheck()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
});

it("refuses a synthesized thenable Proxy without invoking its traps", () => {
  const s = setup(); let reads = 0;
  const deferred = new Proxy({}, { get(_target, key) { reads++; return key === "then" ? () => undefined : undefined; } });
  expect(() => s.api.guard(() => deferred)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(reads).toBe(0);
});

it("refuses result-inspection Proxy reentry before it can issue native work", () => {
  const s = setup(); let traps = 0;
  const deferred = new Proxy({}, { getOwnPropertyDescriptor() { traps++; s.api.pinTargets(input); return undefined; } });
  expect(() => s.api.guard(() => deferred)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  expect(traps).toBe(0); expect(s.calls).toHaveLength(0);
});

it("permits numeric reuse only after the prior handle or allocation was positively released", () => {
  const s = setup("reuse resources"), pins = s.api.pinTargets(input); pins.recheck(); pins.close();
  expect(s.api.unsafe).toBe(false); expect(s.closed).toHaveLength(14); expect(new Set(s.closed).size).toBe(9);
  expect(s.freed).toHaveLength(24); expect(new Set(s.freed).size).toBe(1); expect(s.handles.size).toBe(0); expect(s.allocations.size).toBe(0);
});

it.each([[1, packageSid, 0x1f01ff], [2, "S-1-3-4", 0x40000], [4, packageSid, 0x1200a9], [5, packageSid, 0x1200a9], [6, packageSid, 0x1200a9], [7, packageSid, 0x1200a9]] as const)("requires the exact asset/control principal rights for object %i", (index, principal, mask) => {
  const s = setup(); s.control.faultIndex = index; s.control.mutateSecurity = bytes => {
    const at = bytes.indexOf(sid(principal), bytes.readUInt32LE(16)); expect(at).toBeGreaterThan(0); bytes.writeUInt32LE(mask, at - 4);
  };
  expect(() => s.api.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
});

it("requires the Low host-owner control's DACL bytes to equal the actual Medium parent", () => {
  const s = setup(); s.control.faultIndex = 3; s.control.mutateSecurity = bytes => {
    const at = bytes.readUInt32LE(16), firstSize = bytes.readUInt16LE(at + 10), second = at + 8 + firstSize;
    const first = Buffer.from(bytes.subarray(at + 8, second)), last = Buffer.from(bytes.subarray(second, at + bytes.readUInt16LE(at + 2)));
    last.copy(bytes, at + 8); first.copy(bytes, at + 8 + last.length);
  };
  expect(() => s.api.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
});

it.each(["absent", "empty"] as const)("positively accepts a default-Medium parent only after %s label readback", label => {
  const s = setup(); s.rows[0].security = descriptor(0, label);
  const pins = s.api.pinTargets({ ...input, parentLabel: "default" }); pins.recheck(); pins.close();
  expect(s.api.unsafe).toBe(false); expect(s.allocations.size).toBe(0); expect(s.handles.size).toBe(0);
});

it.each(["absent", "empty"] as const)("does not substitute a %s label for the explicit-Medium case", label => {
  const s = setup(); s.rows[0].security = descriptor(0, label);
  expect(() => s.api.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
});

it.each(["explicit Medium", "Low", "defaulted", "absent offset", "absent pointer", "empty pointer", "empty overlap"])("refuses the default-Medium ambiguity %s", fault => {
  const s = setup(); s.rows[0].security = descriptor(0, fault === "empty pointer" || fault === "empty overlap" ? "empty" : fault === "explicit Medium" || fault === "Low" ? "explicit" : "absent");
  if (fault === "Low") s.rows[0].security.writeUInt32LE(4096, s.rows[0].security.readUInt32LE(12) + 24);
  if (fault === "defaulted") s.rows[0].security.writeUInt16LE(0x9024, 2);
  if (fault === "absent offset") s.rows[0].security.writeUInt32LE(20, 12);
  if (fault === "absent pointer") s.control.fault = "foreign absent label pointer";
  if (fault === "empty pointer") s.control.fault = "missing present label pointer";
  if (fault === "empty overlap") s.rows[0].security.writeUInt32LE(s.rows[0].security.readUInt32LE(16), 12);
  expect(() => s.api.pinTargets({ ...input, parentLabel: "default" })).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
});

it("keeps the exact default-Medium absence/presence snapshot immutable across rechecks", () => {
  const s = setup(); s.rows[0].security = descriptor(0, "absent"); const pins = s.api.pinTargets({ ...input, parentLabel: "default" });
  s.rows[0].security = descriptor(0, "empty"); expect(() => pins.recheck()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
});

it.each([1, 2, 3, 4, 5])("still requires the explicit Low label on object %i beside a default-Medium parent", index => {
  const s = setup(); s.rows[0].security = descriptor(0, "absent"); s.rows[index].security = descriptor(index, "empty");
  expect(() => s.api.pinTargets({ ...input, parentLabel: "default" })).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
});

it.each(["mediumFullDirectory", "mediumFullFile"] as const)("requires the fixed %s target before entering any native API", key => {
  const s = setup(), omitted: Partial<WindowsNodeAssetEnforcementTargets> = { ...input }; delete omitted[key];
  expect(() => s.api.pinTargets(omitted as WindowsNodeAssetEnforcementTargets)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  expect(s.calls).toHaveLength(0);
});

it.each(["mediumFullDirectory", "mediumFullFile"] as const)("rejects case aliases and foreign drives for %s before native entry", key => {
  for (const file of [input.lowFullFile.toUpperCase(), "D:\\case\\medium-control"]) {
    const s = setup(); expect(() => s.api.pinTargets({ ...input, [key]: file })).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
    expect(s.calls).toHaveLength(0);
  }
});

it.each([6, 7].flatMap(index => ["Low", "absent", "empty", "policy", "flags", "owner", "extra label"].map(fault => ({ index, fault }))))(
  "requires the exact explicit Medium/NW control on object $index for $fault", ({ index, fault }) => {
    const s = setup();
    if (fault === "absent" || fault === "empty") s.rows[index].security = descriptor(index, fault);
    else { s.control.faultIndex = index; s.control.mutateSecurity = bytes => {
      const at = bytes.readUInt32LE(12);
      if (fault === "Low") bytes.writeUInt32LE(4096, at + 24);
      else if (fault === "policy") bytes.writeUInt32LE(3, at + 12);
      else if (fault === "flags") bytes[at + 9] = index === 6 ? 0 : 3;
      else if (fault === "owner") bytes.writeUInt32LE(9999, bytes.readUInt32LE(4) + sid(ownerSid).length - 4);
      else bytes.writeUInt16LE(2, at + 4);
    }; }
    expect(() => s.api.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
    expect(s.api.unsafe).toBe(true);
  });

it.each([6, 7])("requires exact Low/Medium full-package DACL bytes for object %i", index => {
  const s = setup(); s.control.faultIndex = index; s.control.mutateSecurity = bytes => {
    const at = bytes.readUInt32LE(16), first = at + 8, second = first + bytes.readUInt16LE(first + 2), third = second + bytes.readUInt16LE(second + 2);
    const owner = Buffer.from(bytes.subarray(first, second)), system = Buffer.from(bytes.subarray(second, third));
    system.copy(bytes, first); owner.copy(bytes, first + system.length);
  };
  expect(() => s.api.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  // Both orderings individually satisfy the bounded principal/rights parser; only pair equality rejects this one.
  expect(s.freed).toHaveLength(8); expect(s.closed).toHaveLength(0);
});

it.each([6, 7].flatMap(index => ["identity", "volume"].map(field => ({ index, field }))))(
  "requires distinct same-volume object $index $field", ({ index, field }) => {
    const s = setup(); if (field === "identity") s.rows[index].identity = s.rows[4].identity; else s.rows[index].volume++;
    expect(() => s.api.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  });

it.each([6, 7].flatMap(index => ["target handle alias", "target allocation handle alias"].map(fault => ({ index, fault }))))(
  "retains and permanently fences object $index after $fault", ({ index, fault }) => {
    const s = setup(fault); s.control.faultIndex = index;
    expect(() => s.api.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
    const count = s.calls.length; expect(s.handles.size).toBeGreaterThanOrEqual(6); expect(s.fence.retained.length).toBeGreaterThan(0);
    s.fence.failure = undefined;
    expect(() => s.api.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
    expect(() => s.api.guard(() => undefined)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
    expect(s.calls).toHaveLength(count);
  });

it.each([6, 7].flatMap(index => ["identity", "creation", "write", "size", "security"].map(field => ({ index, field }))))(
  "rechecks the immutable Medium control object $index $field", ({ index, field }) => {
    const s = setup(), pins = s.api.pinTargets(input), row = s.rows[index];
    if (field === "identity") row.identity++; else if (field === "creation") row.creation++;
    else if (field === "write") row.write++; else if (field === "size") row.size++;
    else row.security.writeUInt32LE(4096, row.security.readUInt32LE(12) + 24);
    expect(() => pins.recheck()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
    const count = s.calls.length; expect(() => pins.close()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls).toHaveLength(count);
  });

const heldProcess = 0x7000n, heldThread = 0x7100n, heldPid = 31415;
const observe = (s: ReturnType<typeof setup>) => {
  const pins = s.api.pinTargets(input), binding = Object.freeze({});
  const ref = pins.observeHeldToken(heldProcess, heldThread, heldPid, binding);
  return { pins, binding, ref };
};
it("queries the exact held primary token through stable Native storage and closes auxiliaries before issuing only enums", () => {
  const s = setup(), pins = s.api.pinTargets(input), binding = Object.freeze({}), start = s.calls.length;
  const ref = pins.observeHeldToken(heldProcess, heldThread, heldPid, binding), trace = s.calls.slice(start);
  expect(trace.map(call => call.name)).toEqual(["GetProcessId", "OpenProcessToken", "GetHandleInformation", "LocalAlloc", "GetTokenInformation", "GetTokenInformation", "LocalFree", "CloseHandle"]);
  expect(trace[0].args).toEqual([heldProcess]); expect(trace[1].args.slice(0, 2)).toEqual([heldProcess, 8]); expect(trace[3].args).toEqual([0x40, 256]);
  const queries = trace.filter(call => call.name === "GetTokenInformation");
  expect(queries.map(call => [call.args[1], typeof call.args[2], call.args[3]])).toEqual([[25, "bigint", 256], [27, "bigint", 256]]);
  expect(queries[0].args[2]).toBe(queries[1].args[2]); expect(trace[6].args[0]).toBe(queries[0].args[2]);
  const at = s.calls.length, facts = pins.requireTokenObservation(ref, binding);
  expect(facts).toEqual({ integrity: 3, attributes: 2, policy: 1 }); expect(Object.isFrozen(facts)).toBe(true);
  expect(Object.keys(ref)).toEqual(["scope"]); expect(Object.isFrozen(ref)).toBe(true); expect(s.calls).toHaveLength(at);
  expect(s.tokens.size).toBe(0); expect(s.local.size).toBe(0); expect(s.handles.size).toBe(8); expect(s.allocations.size).toBe(0);
  expect(s.closed).not.toContain(heldProcess); expect(s.closed).not.toContain(heldThread); pins.close(); expect(s.closed).not.toContain(heldProcess); expect(s.closed).not.toContain(heldThread);
});
it.each([[0, 1], [4096, 2], [8192, 3], [8448, 4], [12288, 5], [16384, 6], [20480, 7], [1, 0], [0xffffffff, 0]])(
  "maps integrity RID %s to its closed enum without exposing the SID", (rid, expected) => {
    const s = setup(); s.control.integrityRid = rid; const { pins, ref, binding } = observe(s);
    expect(pins.requireTokenObservation(ref, binding).integrity).toBe(expected); pins.close();
  });
it.each([[0x20, 1], [0x60, 2], [0, 0], [0x61, 0], [0xffffffff, 0]])("maps integrity attributes %s to a closed enum", (attributes, expected) => {
  const s = setup(); s.control.integrityAttributes = attributes; const { pins, ref, binding } = observe(s);
  expect(pins.requireTokenObservation(ref, binding).attributes).toBe(expected); pins.close();
});
it.each([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [0xffffffff, 4]])("maps mandatory policy %s to a closed enum", (policy, expected) => {
  const s = setup(); s.control.policy = policy; const { pins, ref, binding } = observe(s);
  expect(pins.requireTokenObservation(ref, binding).policy).toBe(expected); pins.close();
});
it.each(["pid mismatch", "pid unknown", "pid throw", "token open false", "token open unknown", "token open throw", "token inherit", "token flags false", "token flags unknown",
  "local null", "local throw", "token query25 false", "token query25 unknown", "token query25 throw", "token query27 false", "token query27 unknown", "token query27 throw",
  "token decode25 throw", "token decode27 throw", "decode short", "decode shared", "token free failed", "token free throw", "token close failed", "token close throw"])(
  "permanently retains the query owner after %s with no later Native work", fault => {
    const s = setup(), pins = s.api.pinTargets(input), binding = Object.freeze({}); s.control.fault = fault;
    expect(() => pins.observeHeldToken(heldProcess, heldThread, heldPid, binding)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
    const count = s.calls.length; expect(s.api.unsafe).toBe(true); expect(s.fence.retained.length).toBeGreaterThan(0);
    s.control.fault = ""; s.fence.failure = undefined;
    expect(() => pins.observeHeldToken(heldProcess, heldThread, heldPid, binding)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
    expect(() => pins.recheck()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
    expect(() => pins.close()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls).toHaveLength(count);
    expect(s.closed).not.toContain(heldProcess); expect(s.closed).not.toContain(heldThread);
    if (fault.startsWith("token open")) {
      const output = s.calls.find(call => call.name === "OpenProcessToken")!.args[2] as unknown[];
      expect(typeof output[0]).toBe("bigint"); expect(s.tokens.has(output[0] as bigint)).toBe(true);
      expect(s.calls.some(call => call.name === "LocalAlloc")).toBe(false);
    }
    if (fault.startsWith("token query") || fault.startsWith("token decode") || fault.startsWith("decode ") || fault.startsWith("token free")) {
      expect(s.tokens.size).toBe(1); expect(s.local.size).toBe(1);
    }
  });
it.each(["pid reentry", "token open reentry", "token flags reentry", "local reentry", "token query25 reentry", "token query27 reentry", "token free reentry", "token close reentry", "decode reentry"])(
  "a swallowed %s permanently fences both token and pin owners", fault => {
    const s = setup(), pins = s.api.pinTargets(input), binding = Object.freeze({}); s.control.fault = fault; s.control.reenter = () => pins.recheck();
    expect(() => pins.observeHeldToken(heldProcess, heldThread, heldPid, binding)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
    const count = s.calls.length; expect(() => pins.close()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls).toHaveLength(count);
    expect(s.closed).not.toContain(heldProcess); expect(s.closed).not.toContain(heldThread); expect(s.fence.retained.length).toBeGreaterThan(0);
  });
it.each([0n, -1n, 0x8000000000000000n])("rejects invalid borrowed process %s before a Native call", process => {
  const s = setup(), pins = s.api.pinTargets(input), count = s.calls.length;
  expect(() => pins.observeHeldToken(process, heldThread, heldPid, {})).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls).toHaveLength(count);
});
it.each([0, -1, 1.5, NaN, Infinity, 0x100000000])("rejects invalid expected PID %s before a Native call", pid => {
  const s = setup(), pins = s.api.pinTargets(input), count = s.calls.length;
  expect(() => pins.observeHeldToken(heldProcess, heldThread, pid, {})).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls).toHaveLength(count);
});
it("rejects a borrowed process that aliases a live pin before querying its PID", () => {
  const s = setup(), pins = s.api.pinTargets(input), count = s.calls.length;
  expect(() => pins.observeHeldToken([...s.handles.keys()][0], heldThread, heldPid, {})).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls).toHaveLength(count);
});
it.each(["borrowed", "pin"])("a returned token may not alias the %s handle", kind => {
  const s = setup(), pins = s.api.pinTargets(input); s.control.tokenRaw = kind === "borrowed" ? heldProcess : [...s.handles.keys()][0];
  expect(() => pins.observeHeldToken(heldProcess, heldThread, heldPid, {})).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  expect(s.calls.at(-1)?.name).toBe("OpenProcessToken"); expect(s.closed).not.toContain(heldProcess); expect(s.closed).not.toContain(heldThread);
});
it.each(["borrowed exact", "borrowed interior", "pin interior", "token interior"])("rejects LocalAlloc span aliasing %s without freeing it", kind => {
  const s = setup(), pins = s.api.pinTargets(input); s.control.localRaw = kind === "borrowed exact" ? heldProcess : kind === "borrowed interior" ? heldProcess - 128n : kind === "pin interior" ? 16n : 32n;
  const freeCount = s.freed.length;
  expect(() => pins.observeHeldToken(heldProcess, heldThread, heldPid, {})).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  expect(s.calls.at(-1)?.name).toBe("LocalAlloc"); expect(s.freed).toHaveLength(freeCount); expect(s.tokens.size).toBe(1);
});
it.each([0, 16, 27, 257, 1.5, undefined])("retains stable storage after invalid integrity return length %s", length => {
  const s = setup(), pins = s.api.pinTargets(input); s.control.integrityLength = length as number;
  expect(() => pins.observeHeldToken(heldProcess, heldThread, heldPid, {})).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  expect(s.calls.filter(call => call.name === "GetTokenInformation").map(call => call.args[1])).toEqual([25]); expect(s.local.size).toBe(1); expect(s.tokens.size).toBe(1);
});
it.each([0, 3, 5, 256, 1.5, undefined])("retains stable storage after invalid policy return length %s", length => {
  const s = setup(), pins = s.api.pinTargets(input); s.control.policyLength = length as number;
  expect(() => pins.observeHeldToken(heldProcess, heldThread, heldPid, {})).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  expect(s.local.size).toBe(1); expect(s.tokens.size).toBe(1);
});
const tokenMalformed: readonly [string, (bytes: Buffer, raw: bigint) => void][] = [
  ["null SID", b => b.writeBigUInt64LE(0n, 0)], ["SID before buffer", (b, raw) => b.writeBigUInt64LE(raw - 4n, 0)],
  ["SID in header", (b, raw) => b.writeBigUInt64LE(raw + 12n, 0)], ["SID after return span", (b, raw) => b.writeBigUInt64LE(raw + 20n, 0)],
  ["unaligned SID", (b, raw) => b.writeBigUInt64LE(raw + 17n, 0)], ["wrong SID revision", b => { b[16] = 2; }],
  ["zero subauthorities", b => { b[17] = 0; }], ["multiple subauthorities", b => { b[17] = 2; }], ["wrong authority", b => { b[23] = 5; }],
];
it.each(tokenMalformed)("rejects the integrity token's %s before policy or cleanup", (_name, mutate) => {
  const s = setup(), pins = s.api.pinTargets(input); s.control.mutateIntegrity = mutate;
  expect(() => pins.observeHeldToken(heldProcess, heldThread, heldPid, {})).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  expect(s.calls.filter(call => call.name === "GetTokenInformation").map(call => call.args[1])).toEqual([25]); expect(s.local.size).toBe(1); expect(s.tokens.size).toBe(1);
});
it.each(["structural", "foreign owner", "wrong binding"])("opaque observation rejects %s without Native calls or claimed getters", mode => {
  const first = setup(), a = observe(first), read = () => { throw Error("private claimed fact"); };
  if (mode === "foreign owner") {
    const second = setup(), pins = second.api.pinTargets(input), count = second.calls.length;
    expect(() => pins.requireTokenObservation(a.ref, a.binding)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(second.calls).toHaveLength(count);
  } else {
    const candidate = mode === "structural" ? Object.defineProperty({ ...a.ref }, "integrity", { get: read }) : a.ref, count = first.calls.length;
    expect(() => a.pins.requireTokenObservation(candidate, mode === "wrong binding" ? {} : a.binding)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(first.calls).toHaveLength(count);
  }
});
it("keeps a borrowed process reserved against later handle and descriptor aliases", () => {
  const s = setup(), { pins } = observe(s); s.control.securityRaw = heldProcess - 8n; const freeCount = s.freed.length;
  expect(() => pins.recheck()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.freed).toHaveLength(freeCount);
  const count = s.calls.length; expect(() => pins.close()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls).toHaveLength(count);
});
it("keeps a borrowed process reserved against a later new-owner handle until all pin closes", () => {
  const s = setup(); observe(s); s.control.nextFileRaw = heldProcess;
  expect(() => s.api.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls.at(-1)?.name).toBe("CreateFileW");
});
it("releases only the reservation after eight positive closes, permitting later ordinary handle-number reuse", () => {
  const s = setup(), { pins, ref, binding } = observe(s), held = [...s.handles.keys()]; pins.close();
  expect(s.closed.slice(-8)).toEqual(held.reverse()); expect(s.closed).not.toContain(heldProcess); expect(s.closed).not.toContain(heldThread);
  const count = s.calls.length; expect(pins.requireTokenObservation(ref, binding)).toEqual({ integrity: 3, attributes: 2, policy: 1 }); expect(s.calls).toHaveLength(count);
  s.control.nextFileRaw = heldProcess; const next = s.api.pinTargets(input); next.close(); expect(s.api.unsafe).toBe(false);
});
it("an unknown final pin close retains the borrowed reservation and refuses all later facts or work", () => {
  const s = setup(), { pins, ref, binding } = observe(s); s.control.failedCloseRaw = [...s.handles.keys()][0];
  expect(() => pins.close()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.handles.size).toBe(1);
  const count = s.calls.length; expect(() => pins.requireTokenObservation(ref, binding)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  expect(() => pins.close()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls).toHaveLength(count); expect(s.closed).not.toContain(heldProcess); expect(s.closed).not.toContain(heldThread);
});
it("does not reissue or rebind an observation even if the same PID and process number are supplied", () => {
  const s = setup(), { pins } = observe(s), count = s.calls.length;
  expect(() => pins.observeHeldToken(heldProcess, heldThread, heldPid, {})).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls).toHaveLength(count);
});

it.each([undefined, null, 1, "binding", () => undefined])("rejects a non-object observation binding %# before Native work", binding => {
  const s = setup(), pins = s.api.pinTargets(input), count = s.calls.length;
  expect(() => pins.observeHeldToken(heldProcess, heldThread, heldPid, binding as object)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls).toHaveLength(count);
});
it.each([0n, 0xffffffffffffffffn])("rejects an invalid returned token pointer %s without issuing another Native call", raw => {
  const s = setup(), pins = s.api.pinTargets(input); s.control.tokenRaw = raw;
  expect(() => pins.observeHeldToken(heldProcess, heldThread, heldPid, {})).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  expect(s.calls.at(-1)?.name).toBe("OpenProcessToken"); expect(s.calls.some(call => call.name === "LocalAlloc")).toBe(false);
});
it("supports a padded but wholly owned integrity SID span without using the returned pointer after reuse", () => {
  const s = setup(), pins = s.api.pinTargets(input), binding = Object.freeze({}); s.control.integrityLength = 44;
  s.control.mutateIntegrity = (bytes, raw) => { bytes.copy(bytes, 32, 16, 28); bytes.fill(0, 16, 28); bytes.writeBigUInt64LE(raw + 32n, 0); };
  const ref = pins.observeHeldToken(heldProcess, heldThread, heldPid, binding);
  expect(pins.requireTokenObservation(ref, binding)).toEqual({ integrity: 3, attributes: 2, policy: 1 }); pins.close();
});
it("shares borrowed process reservations with sibling Native bindings", () => {
  const s = setup(); observe(s); const sibling = bindWindowsNodeAssetEnforcementNative(s.native, s.load, s.fence); s.control.nextFileRaw = heldProcess;
  expect(() => sibling.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  const count = s.calls.length; expect(s.api.unsafe).toBe(true); expect(() => s.api.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls).toHaveLength(count);
});

it.each([0n, -1n, 0x8000000000000000n, heldProcess])("rejects invalid or equal borrowed thread %s before Native entry", thread => {
  const s = setup(), pins = s.api.pinTargets(input), count = s.calls.length;
  expect(() => pins.observeHeldToken(heldProcess, thread, heldPid, {})).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls).toHaveLength(count);
});
it("rejects a borrowed thread that aliases a live pin before querying the process", () => {
  const s = setup(), pins = s.api.pinTargets(input), count = s.calls.length;
  expect(() => pins.observeHeldToken(heldProcess, [...s.handles.keys()][0], heldPid, {})).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls).toHaveLength(count);
});
it("does not adopt or close an output token that aliases the still-held thread", () => {
  const s = setup(), pins = s.api.pinTargets(input); s.control.tokenRaw = heldThread;
  expect(() => pins.observeHeldToken(heldProcess, heldThread, heldPid, {})).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  expect(s.calls.at(-1)?.name).toBe("OpenProcessToken"); expect(s.closed).not.toContain(heldThread); expect(s.closed).not.toContain(heldProcess);
});
it.each([heldThread, heldThread - 128n])("retains LocalAlloc storage aliasing borrowed thread at%s without freeing or closing it", raw => {
  const s = setup(), pins = s.api.pinTargets(input); s.control.localRaw = raw; const freeCount = s.freed.length;
  expect(() => pins.observeHeldToken(heldProcess, heldThread, heldPid, {})).toThrow(WindowsNodeAssetEnforcementNativeCleanupError);
  expect(s.calls.at(-1)?.name).toBe("LocalAlloc"); expect(s.freed).toHaveLength(freeCount); expect(s.closed).not.toContain(heldThread);
});
it("keeps the borrowed thread reserved against later descriptor spans", () => {
  const s = setup(), { pins } = observe(s); s.control.securityRaw = heldThread - 8n; const freeCount = s.freed.length;
  expect(() => pins.recheck()).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.freed).toHaveLength(freeCount); expect(s.closed).not.toContain(heldThread);
});
it("keeps the borrowed thread reserved against sibling handles before eight positive pin closes", () => {
  const s = setup(); observe(s); const sibling = bindWindowsNodeAssetEnforcementNative(s.native, s.load, s.fence); s.control.nextFileRaw = heldThread;
  expect(() => sibling.pinTargets(input)).toThrow(WindowsNodeAssetEnforcementNativeCleanupError); expect(s.calls.at(-1)?.name).toBe("CreateFileW"); expect(s.closed).not.toContain(heldThread);
});
it("releases the thread reservation after all eight pin closes without closing the borrowed thread", () => {
  const s = setup(), { pins } = observe(s); pins.close(); expect(s.closed).not.toContain(heldThread);
  s.control.nextFileRaw = heldThread; const next = s.api.pinTargets(input); next.close(); expect(s.api.unsafe).toBe(false);
});
