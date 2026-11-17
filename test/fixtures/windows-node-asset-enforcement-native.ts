/** Read-only native pins for the fixed asset-enforcement witness. Raw identities and security bytes stay private. */
import path from "node:path/win32";
import { createRequire } from "node:module";
import { types } from "node:util";
import type * as Koffi from "koffi";

type Fn = (...args: unknown[]) => unknown;
type Loader = (name: string) => { func(prototype: string): unknown };
type Allocation = { raw: bigint; length?: number; attempted: boolean };
type Handle = { raw: bigint; attempted: boolean; closed: boolean };
type Security = { owner: Buffer; dacl: Buffer; sacl: Buffer; control: number };
type Pin = { file: string; directory: boolean; handle: Handle; metadata: Buffer; security: Security };
type Universe = { failure?: WindowsNodeAssetEnforcementNativeCleanupError; busy: boolean; operation: boolean; guarding: boolean;
  handles: Map<bigint, Handle>; allocations: Map<bigint, Allocation>; borrowed: Map<bigint, object>; owners: Set<object> };

/** A failed native contract permanently retains this witness's private owners, without exposing native details. */
export class WindowsNodeAssetEnforcementNativeCleanupError extends Error {
  constructor() {
    super("The asset-enforcement witness could not verify its native pins; retain its private scratch and owners.");
    this.name = "WindowsNodeAssetEnforcementNativeCleanupError"; this.stack = `${this.name}: ${this.message}`;
  }
}
/** Injectable failure fence; the private universe remains authoritative if this outward object is changed. */
export interface WindowsNodeAssetEnforcementNativeFence { failure?: WindowsNodeAssetEnforcementNativeCleanupError; retained: unknown[] }
/** Fixed paths selected by the trusted witness, with identities obtained from its genuine profile and host API. */
export interface WindowsNodeAssetEnforcementTargets {
  parent: string; root: string; image: string; lowOwner: string; lowFullDirectory: string; lowFullFile: string;
  mediumFullDirectory: string; mediumFullFile: string;
  ownerSid: string; packageSid: string; parentLabel: "explicit" | "default";
}
declare const tokenObservationBrand: unique symbol;
/** Private Native observation identity only. It contains no token, process, Stop or cleanup authority. */
export interface WindowsNodeAssetTokenObservationRef {
  readonly scope: "windows-node-asset-token-observation"; readonly [tokenObservationBrand]: true;
}
/** Closed enums only; zero is a valid observed OFF policy and is distinguished by the caller's observed flag. */
export interface WindowsNodeAssetTokenObservation {
  readonly integrity: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  readonly attributes: 0 | 1 | 2;
  readonly policy: 0 | 1 | 2 | 3 | 4;
}
/** No pin, security or token readback is a process Stop or publication receipt. */
export interface WindowsNodeAssetEnforcementPins {
  recheck(): void; close(): void;
  observeHeldToken(process: bigint, thread: bigint, pid: number, binding: object): WindowsNodeAssetTokenObservationRef;
  requireTokenObservation(ref: WindowsNodeAssetTokenObservationRef, binding: object): Readonly<WindowsNodeAssetTokenObservation>;
}
/** Only fixed, read-only native inspection is available to the witness. */
export interface WindowsNodeAssetEnforcementNative {
  readonly unsafe: boolean;
  guard<T>(operation: () => T): T;
  pinTargets(input: WindowsNodeAssetEnforcementTargets): WindowsNodeAssetEnforcementPins;
}

const processFence: WindowsNodeAssetEnforcementNativeFence = { retained: [] };
const universes = new WeakMap<object, Universe>(), retained = new Set<object>();
const MAX_SECURITY = 65536, MAX_IMAGE = 128 * 1024 * 1024, ALL = 0x1f01ff, RX = 0x1200a9, RC = 0x20000;
const SPECIAL = 0x5640 | 0x40000 | 0x400000;
const pointer = (value: unknown): value is bigint => typeof value === "bigint" && value > 0n && value < 0x8000000000000000n;
const uint = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const bool = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff && value !== 0;
const own = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
};

/** Exact Win64 prototypes; no security setter, impersonation, process launch or target-writing function is bound. */
export const WINDOWS_NODE_ASSET_ENFORCEMENT_FUNCTIONS = {
  kernel32: [
    "void * __stdcall CreateFileW(const char16_t *file, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
    "uint32_t __stdcall GetFileType(void *file)", "int __stdcall GetHandleInformation(void *file, _Out_ uint32_t *flags)",
    "int __stdcall GetFileInformationByHandle(void *file, void *information)",
    "uint32_t __stdcall GetFinalPathNameByHandleW(void *file, void *name, uint32_t length, uint32_t flags)",
    "uint32_t __stdcall GetProcessId(void *process)", "void * __stdcall LocalAlloc(uint32_t flags, size_t bytes)",
    "int __stdcall CloseHandle(void *handle)", "void * __stdcall LocalFree(void *memory)",
  ],
  advapi32: [
    "uint32_t __stdcall GetSecurityInfo(void *file, int kind, uint32_t information, _Out_ void **owner, void *group, _Out_ void **dacl, _Out_ void **sacl, _Out_ void **descriptor)",
    "uint32_t __stdcall GetSecurityDescriptorLength(void *descriptor)",
    "int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
    "int __stdcall GetTokenInformation(void *token, int kind, void *information, uint32_t length, _Out_ uint32_t *returned)",
  ],
} as const;

/** Injectable ABI seam. One uncertain call fences every sibling binding using the same process/test fence. */
export function bindWindowsNodeAssetEnforcementNative(native: Pick<typeof Koffi, "sizeof" | "decode">, load: Loader,
  fence: WindowsNodeAssetEnforcementNativeFence = processFence): WindowsNodeAssetEnforcementNative {
  if (!fence || typeof fence !== "object") throw new WindowsNodeAssetEnforcementNativeCleanupError();
  let universe = universes.get(fence);
  if (!universe) {
    universe = { busy: false, operation: false, guarding: false, handles: new Map(), allocations: new Map(), borrowed: new Map(), owners: new Set() };
    universes.set(fence, universe);
  }
  const shared = universe, functions: Record<string, Fn> = {}, libraries: unknown[] = [], records: unknown[] = [], owners = new Set<object>();
  const binding = { native, load, functions, libraries, records, owners, fence, shared };
  const fail = (): never => {
    shared.failure ??= new WindowsNodeAssetEnforcementNativeCleanupError(); retained.add(binding);
    for (const owner of shared.owners) retained.add(owner);
    try { fence.failure ??= shared.failure; fence.retained.push(binding); } catch { /* Private retention does not depend on outward diagnostics. */ }
    throw shared.failure;
  };
  const outwardFailure = (): boolean => {
    try { const descriptor = Object.getOwnPropertyDescriptor(fence, "failure");
      if (descriptor && !Object.hasOwn(descriptor, "value")) return fail(); return !!descriptor?.value;
    } catch { return fail(); }
  };
  const usable = () => { if (shared.failure || shared.busy || outwardFailure()) fail(); };
  const boundary = <T>(operation: () => T, capture?: () => void): T => {
    usable(); shared.busy = true;
    const record = { operation, value: undefined as unknown, failed: false }; records.push(record);
    try { record.value = operation(); } catch { record.failed = true; }
    finally { try { capture?.(); } catch { record.failed = true; } shared.busy = false; }
    if (record.failed || shared.failure || outwardFailure()) return fail();
    return record.value as T;
  };
  const call = (name: string, args: unknown[], capture?: () => void) => {
    records.push(args); return boundary(() => functions[name](...args), capture);
  };
  const requireBool = (name: string, args: unknown[]) => { if (!bool(call(name, args))) fail(); };
  const operation = <T>(work: () => T): T => {
    usable(); if (shared.operation) return fail(); shared.operation = true;
    try { const result = work(); usable(); return result; } catch { return fail(); }
    finally { shared.operation = false; }
  };
  const close = (handle: Handle) => {
    if (handle.attempted || handle.closed || shared.handles.get(handle.raw) !== handle) fail();
    handle.attempted = true; requireBool("CloseHandle", [handle.raw]); shared.handles.delete(handle.raw); handle.closed = true;
  };
  const acquire = (file: string, directory: boolean, access: number, share: number): Handle => {
    const output = call("CreateFileW", [file, access, share, null, 3, 0x00200000 | (directory ? 0x02000000 : 0), null]);
    if (!pointer(output) || shared.handles.has(output) || shared.borrowed.has(output) || [...shared.allocations.values()].some(a => output >= a.raw && output < a.raw + BigInt(a.length ?? 1))) return fail();
    const handle = { raw: output, attempted: false, closed: false }; shared.handles.set(output, handle); return handle;
  };
  const metadata = (handle: Handle, file: string, directory: boolean): Buffer => {
    if (handle.closed || shared.handles.get(handle.raw) !== handle || call("GetFileType", [handle.raw]) !== 1) return fail();
    const flags: unknown[] = [undefined], bytes = Buffer.alloc(52), name = Buffer.alloc(65536); records.push(bytes, name, flags);
    requireBool("GetHandleInformation", [handle.raw, flags]); if (own(flags, "0") !== 0) return fail();
    requireBool("GetFileInformationByHandle", [handle.raw, bytes]);
    const attributes = bytes.readUInt32LE(0), size = bytes.readUInt32LE(32) * 0x100000000 + bytes.readUInt32LE(36);
    if (attributes & SPECIAL || !!(attributes & 16) !== directory || bytes.readUInt32LE(40) !== 1 ||
        bytes.readBigUInt64LE(44) === 0n || !directory && (!Number.isSafeInteger(size) || size < 1 || size > MAX_IMAGE)) return fail();
    const count = call("GetFinalPathNameByHandleW", [handle.raw, name, 32768, 0]);
    if (!uint(count) || count < 1 || count > 32767 || name.readUInt16LE(count * 2) !== 0 ||
        name.toString("utf16le", 0, count * 2).toLowerCase() !== `\\\\?\\${file}`.toLowerCase()) return fail();
    const detached = Buffer.from(bytes); records.push(detached); return detached;
  };
  const same = (before: Buffer, after: Buffer, directory: boolean) => directory
    ? before.subarray(0, 12).equals(after.subarray(0, 12)) && before.subarray(28, 32).equals(after.subarray(28, 32)) && before.subarray(40).equals(after.subarray(40))
    : before.subarray(0, 12).equals(after.subarray(0, 12)) && before.subarray(20).equals(after.subarray(20));
  const copy = (raw: bigint, length: number): Buffer => {
    const value = boundary(() => native.decode(raw, "uint8_t", length));
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      if (value.byteLength !== length || value.buffer instanceof SharedArrayBuffer) return fail();
      const bytes = Buffer.from(value); records.push(bytes); return bytes;
    }
    if (!Array.isArray(value) || value.length !== length) return fail();
    const bytes = Buffer.alloc(length); records.push(bytes);
    for (let i = 0; i < length; i++) { const byte = own(value, String(i)); if (!uint(byte) || byte > 255) return fail(); bytes[i] = byte; }
    return bytes;
  };
  const security = (pin: Pick<Pin, "handle" | "directory">, ownerSid: string, packageSid: string, kind: "private" | "asset" | "full", medium: boolean, defaultMedium = false): Security => {
    const owner: unknown[] = [undefined], dacl: unknown[] = [undefined], sacl: unknown[] = [undefined], output: unknown[] = [undefined];
    let allocation: Allocation | undefined, aliased = false;
    const status = call("GetSecurityInfo", [pin.handle.raw, 1, 0x15, owner, null, dacl, sacl, output], () => {
      const raw = own(output, "0");
      if (pointer(raw)) {
        if (shared.handles.has(raw) || shared.borrowed.has(raw) || [...shared.allocations.values()].some(a => raw >= a.raw && raw < a.raw + BigInt(a.length ?? 1))) aliased = true;
        else { allocation = { raw, attempted: false }; shared.allocations.set(raw, allocation); }
      }
    });
    if (status !== 0 || !allocation || aliased || allocation.raw % 4n !== 0n) return fail();
    const sd = allocation, length = call("GetSecurityDescriptorLength", [sd.raw]);
    if (!uint(length) || length < 20 || length > MAX_SECURITY || sd.raw + BigInt(length) >= 0x8000000000000000n) return fail();
    sd.length = length;
    if ([...shared.handles.keys(), ...shared.borrowed.keys()].some(raw => raw >= sd.raw && raw < sd.raw + BigInt(length)) ||
        [...shared.allocations.values()].some(a => a !== sd && sd.raw < a.raw + BigInt(a.length ?? 1) && a.raw < sd.raw + BigInt(length))) return fail();
    const bytes = copy(sd.raw, length), control = bytes.readUInt16LE(2), spans: { start: number; end: number }[] = [];
    const requiredControl = defaultMedium ? 0x9004 : 0x9014;
    if (bytes[0] !== 1 || bytes[1] !== 0 || (control & requiredControl) !== requiredControl || control & ~0xbf14) return fail();
    const span = (start: number, size: number) => {
      if (!Number.isInteger(start) || start < 20 || start % 4 || size < 8 || start + size > length || spans.some(s => start < s.end && s.start < start + size)) return fail();
      spans.push({ start, end: start + size });
    };
    const sid = (at: number, limit: number): { text: string; size: number } => {
      if (at < 20 || at % 4 || at + 8 > limit || limit > length || bytes[at] !== 1 || bytes[at + 1] > 15) return fail();
      const size = 8 + bytes[at + 1] * 4; if (at + size > limit) return fail();
      let authority = 0n; for (let i = 2; i < 8; i++) authority = authority * 256n + BigInt(bytes[at + i]);
      const parts: number[] = []; for (let i = 0; i < bytes[at + 1]; i++) parts.push(bytes.readUInt32LE(at + 8 + i * 4));
      return { text: `S-1-${authority}${parts.map(part => `-${part}`).join("")}`, size };
    };
    const ownerAt = bytes.readUInt32LE(4), daclAt = bytes.readUInt32LE(16), saclAt = bytes.readUInt32LE(12);
    if (own(owner, "0") !== sd.raw + BigInt(ownerAt) || own(dacl, "0") !== sd.raw + BigInt(daclAt)) return fail();
    if (control & 0x10) { if (own(sacl, "0") !== sd.raw + BigInt(saclAt)) return fail(); }
    else if (!defaultMedium || saclAt !== 0 || own(sacl, "0") !== null && own(sacl, "0") !== 0n) return fail();
    const ownerValue = sid(ownerAt, length); if (ownerValue.text !== ownerSid) return fail(); span(ownerAt, ownerValue.size);
    const groupAt = bytes.readUInt32LE(8);
    if (groupAt) { const group = sid(groupAt, length); if (group.text !== ownerSid) return fail(); if (groupAt !== ownerAt) span(groupAt, group.size); }
    const flags = pin.directory ? 3 : 0;
    const acl = (at: number, expected: readonly { sid: string; mask: number; type: number }[]): Buffer => {
      if (at < 20 || at % 4 || at + 8 > length || bytes[at] !== 2 && bytes[at] !== 4 || bytes[at + 1] !== 0 || bytes.readUInt16LE(at + 6) !== 0) return fail();
      const size = bytes.readUInt16LE(at + 2), count = bytes.readUInt16LE(at + 4); span(at, size);
      if (count !== expected.length) return fail();
      const observed: string[] = []; let cursor = at + 8;
      for (let i = 0; i < count; i++) {
        if (cursor + 8 > at + size || bytes[cursor + 1] !== flags) return fail();
        const aceSize = bytes.readUInt16LE(cursor + 2);
        if (aceSize < 16 || aceSize > 76 || aceSize % 4 || cursor + aceSize > at + size) return fail();
        const value = sid(cursor + 8, cursor + aceSize); if (aceSize !== value.size + 8) return fail();
        observed.push(`${bytes[cursor]}:${bytes.readUInt32LE(cursor + 4)}:${value.text}`); cursor += aceSize;
      }
      if (bytes.subarray(cursor, at + size).some(byte => byte !== 0) || observed.sort().join("|") !== expected.map(ace => `${ace.type}:${ace.mask}:${ace.sid}`).sort().join("|")) return fail();
      return Buffer.from(bytes.subarray(at, at + size));
    };
    const expected = [{ sid: ownerSid, mask: ALL, type: 0 }, { sid: "S-1-5-18", mask: ALL, type: 0 },
      ...(kind === "private" ? [] : [{ sid: packageSid, mask: kind === "asset" ? RX : ALL, type: 0 }]),
      ...(kind === "asset" ? [{ sid: "S-1-3-4", mask: RC, type: 0 }] : [])];
    // No mandatory label means Medium/no-write-up. This fixed case positively distinguishes absent/null from
    // a present valid empty ACL; an explicit label, defaulted bit or unknown pointer is never treated as absence.
    const result = { owner: Buffer.from(bytes.subarray(ownerAt, ownerAt + ownerValue.size)), dacl: acl(daclAt, expected),
      sacl: !(control & 0x10) ? Buffer.alloc(0) : acl(saclAt, defaultMedium ? [] : [{ sid: `S-1-16-${medium ? 8192 : 4096}`, mask: 1, type: 17 }]), control };
    records.push(result);
    if (sd.attempted || shared.allocations.get(sd.raw) !== sd) return fail(); sd.attempted = true;
    const freed = call("LocalFree", [sd.raw]); if (freed !== null && freed !== 0n) return fail(); shared.allocations.delete(sd.raw);
    return result;
  };
  const expectedKinds = ["private", "asset", "asset", "private", "full", "full", "full", "full"] as const;
  const sameSecurity = (a: Security, b: Security) => a.control === b.control && a.owner.equals(b.owner) && a.dacl.equals(b.dacl) && a.sacl.equals(b.sacl);
  try {
    if (shared.operation || shared.guarding) return fail();
    if (boundary(() => native.sizeof("void *")) !== 8) fail();
    for (const [library, prototypes] of Object.entries(WINDOWS_NODE_ASSET_ENFORCEMENT_FUNCTIONS)) {
      const dll = boundary(() => load(`${library}.dll`)); libraries.push(dll);
      for (const prototype of prototypes) {
        const fn = boundary(() => dll.func(prototype)); if (typeof fn !== "function") return fail(); functions[/\b(\w+)\s*\(/.exec(prototype)![1]] = fn as Fn;
      }
    }
  } catch { return fail(); }
  return Object.freeze({
    get unsafe() { try { return !!shared.failure || outwardFailure(); } catch { return true; } },
    guard<T>(work: () => T): T {
      usable(); if (shared.operation || shared.guarding || typeof work !== "function") return fail(); shared.guarding = true;
      const issued = { work, value: undefined as unknown }; records.push(issued);
      try {
        issued.value = work(); const value = issued.value as T; usable(); if (types.isPromise(value)) return fail();
        let object: object | null = value !== null && (typeof value === "object" || typeof value === "function") ? value : null;
        for (let depth = 0; object !== null; depth++) {
          if (depth >= 32 || types.isProxy(object)) return fail();
          const then = Object.getOwnPropertyDescriptor(object, "then");
          if (then) { if (!Object.hasOwn(then, "value") || typeof then.value === "function") return fail(); break; }
          object = Object.getPrototypeOf(object) as object | null;
        }
        usable(); return value;
      } catch { return fail(); }
      finally { shared.guarding = false; }
    },
    pinTargets(input: WindowsNodeAssetEnforcementTargets): WindowsNodeAssetEnforcementPins {
      return operation(() => {
        const pins: Pin[] = [], borrowed = new Map<bigint, object>(), observations = new WeakMap<object, { binding: object; facts: Readonly<WindowsNodeAssetTokenObservation> }>(),
          tokenRecords: object[] = [], record = { input, pins, binding, borrowed, observations, tokenRecords }; owners.add(record); shared.owners.add(record);
        if (!input || typeof input !== "object" || Object.keys(input).sort().join(",") !== "image,lowFullDirectory,lowFullFile,lowOwner,mediumFullDirectory,mediumFullFile,ownerSid,packageSid,parent,parentLabel,root") return fail();
        const names = ["parent", "root", "image", "lowOwner", "lowFullDirectory", "lowFullFile", "mediumFullDirectory", "mediumFullFile"] as const;
        const files = names.map(key => own(input, key)); const ownerSid = own(input, "ownerSid"), packageSid = own(input, "packageSid"), parentLabel = own(input, "parentLabel");
        if (parentLabel !== "explicit" && parentLabel !== "default") return fail();
        const validSid = (value: unknown, prefix: string) => typeof value === "string" && value.length <= 184 && value.startsWith(prefix) &&
          /^S-1-\d+(?:-\d+){1,15}$/.test(value) && value.split("-").slice(2).every(part => uint(Number(part)) && String(Number(part)) === part);
        if (!validSid(ownerSid, "S-1-5-") || ownerSid === "S-1-5-18" || !validSid(packageSid, "S-1-15-2-") || packageSid === "S-1-15-2-1") return fail();
        const checked = files.map(file => {
          if (typeof file !== "string" || file.length > 4096 || !/^[A-Za-z]:\\/.test(file) || file.includes("/") || path.normalize(file) !== file ||
              /[\p{Cc}\p{Cf}]/u.test(file) || file.slice(3).split("\\").some(part => !part || /[:<>"|?*]/.test(part) || /[. ]$/.test(part))) return fail();
          return file;
        });
        if (new Set(checked.map(file => file.toLowerCase())).size !== 8 || path.dirname(checked[1]).toLowerCase() !== checked[0].toLowerCase() ||
            checked[2].toLowerCase() !== path.join(checked[1], "node.exe").toLowerCase() || checked.some(file => file.slice(0, 2).toLowerCase() !== checked[0].slice(0, 2).toLowerCase())) return fail();
        let closed = false;
        for (let i = 0; i < checked.length; i++) {
          const directory = i !== 2 && i !== 5 && i !== 7, handle = acquire(checked[i], directory, RC | 0x80, directory || i === 5 || i === 7 ? 3 : 1);
          const pin = { file: checked[i], directory, handle, metadata: metadata(handle, checked[i], directory), security: undefined as unknown as Security };
          pins.push(pin); pin.security = security(pin, ownerSid as string, packageSid as string, expectedKinds[i], i === 0 || i >= 6, i === 0 && parentLabel === "default");
          if (pins.slice(0, -1).some(other => other.metadata.readUInt32LE(28) !== pin.metadata.readUInt32LE(28) ||
              other.metadata.subarray(44, 52).equals(pin.metadata.subarray(44, 52)))) return fail();
        }
        for (const [first, second] of [[0, 3], [4, 6], [5, 7]])
          if (!pins[first].security.owner.equals(pins[second].security.owner) || !pins[first].security.dacl.equals(pins[second].security.dacl)) return fail();
        // Attribute reads let each host security-access positive prove its own ordinary identity as well.
        for (const pin of pins.slice(0, 3)) for (const access of [0x40080, 0x80080]) {
          const probe = acquire(pin.file, pin.directory, access, 7);
          if (!same(pin.metadata, metadata(probe, pin.file, pin.directory), false)) return fail(); close(probe);
        }
        const recheck = () => {
          if (closed) return fail();
          for (let i = 0; i < pins.length; i++) {
            const pin = pins[i]; if (!same(pin.metadata, metadata(pin.handle, pin.file, pin.directory), i === 4) ||
                !sameSecurity(pin.security, security(pin, ownerSid as string, packageSid as string, expectedKinds[i], i === 0 || i >= 6, i === 0 && parentLabel === "default"))) return fail();
          }
        };
        return Object.freeze({ recheck() { operation(recheck); },
          observeHeldToken(process: bigint, thread: bigint, pid: number, observationBinding: object): WindowsNodeAssetTokenObservationRef {
            return operation(() => {
              if (closed || tokenRecords.length || !observationBinding || typeof observationBinding !== "object" || !pointer(process) || !pointer(thread) || process === thread || !uint(pid) || pid === 0 ||
                  [process, thread].some(raw => shared.handles.has(raw) || shared.borrowed.has(raw) || [...shared.allocations.values()].some(a => raw >= a.raw && raw < a.raw + BigInt(a.length ?? 1)))) return fail();
              const pending = { process, thread, pid, binding: observationBinding, token: undefined as Handle | undefined, allocation: undefined as Allocation | undefined };
              tokenRecords.push(pending); for (const raw of [process, thread]) { borrowed.set(raw, pending); shared.borrowed.set(raw, pending); }
              if (call("GetProcessId", [process]) !== pid) return fail();
              const output: unknown[] = [undefined]; let aliased = false;
              const opened = call("OpenProcessToken", [process, 8, output], () => {
                const raw = own(output, "0");
                if (pointer(raw)) {
                  if (shared.handles.has(raw) || shared.borrowed.has(raw) || [...shared.allocations.values()].some(a => raw >= a.raw && raw < a.raw + BigInt(a.length ?? 1))) aliased = true;
                  else { pending.token = { raw, attempted: false, closed: false }; shared.handles.set(raw, pending.token); }
                }
              });
              if (!bool(opened) || !pending.token || aliased) return fail();
              const token = pending.token, flags: unknown[] = [undefined];
              requireBool("GetHandleInformation", [token.raw, flags]); if (own(flags, "0") !== 0) return fail();
              const raw = call("LocalAlloc", [0x40, 256]);
              if (!pointer(raw) || raw % 8n || raw + 256n >= 0x8000000000000000n ||
                  [...shared.handles.keys(), ...shared.borrowed.keys()].some(value => value >= raw && value < raw + 256n) ||
                  [...shared.allocations.values()].some(a => raw < a.raw + BigInt(a.length ?? 1) && a.raw < raw + 256n)) return fail();
              const allocation = { raw, length: 256, attempted: false }; pending.allocation = allocation; shared.allocations.set(raw, allocation);
              const integrityLength: unknown[] = [undefined]; requireBool("GetTokenInformation", [token.raw, 25, raw, 256, integrityLength]);
              const length = own(integrityLength, "0"); if (!uint(length) || length < 28 || length > 256) return fail();
              const integrity = copy(raw, length), sidPointer = integrity.readBigUInt64LE(0), attributesRaw = integrity.readUInt32LE(8);
              if (sidPointer % 4n || sidPointer < raw + 16n || sidPointer + 12n > raw + BigInt(length)) return fail();
              const at = Number(sidPointer - raw);
              if (integrity[at] !== 1 || integrity[at + 1] !== 1 || !integrity.subarray(at + 2, at + 8).equals(Buffer.from([0, 0, 0, 0, 0, 16]))) return fail();
              const rid = integrity.readUInt32LE(at + 8), levels = new Map<number, WindowsNodeAssetTokenObservation["integrity"]>([
                [0, 1], [4096, 2], [8192, 3], [8448, 4], [12288, 5], [16384, 6], [20480, 7],
              ]);
              const policyLength: unknown[] = [undefined]; requireBool("GetTokenInformation", [token.raw, 27, raw, 256, policyLength]);
              if (own(policyLength, "0") !== 4) return fail(); const policy = copy(raw, 4), policyRaw = policy.readUInt32LE(0);
              const facts: Readonly<WindowsNodeAssetTokenObservation> = Object.freeze({ integrity: levels.get(rid) ?? 0,
                attributes: attributesRaw === 0x20 ? 1 : attributesRaw === 0x60 ? 2 : 0, policy: policyRaw <= 3 ? policyRaw as 0 | 1 | 2 | 3 : 4 });
              if (allocation.attempted || shared.allocations.get(raw) !== allocation) return fail(); allocation.attempted = true;
              const freed = call("LocalFree", [raw]); if (freed !== null && freed !== 0n) return fail(); shared.allocations.delete(raw);
              close(token); integrity.fill(0); policy.fill(0);
              const ref = Object.freeze({ scope: "windows-node-asset-token-observation" as const }) as WindowsNodeAssetTokenObservationRef;
              observations.set(ref, { binding: observationBinding, facts }); return ref;
            });
          },
          requireTokenObservation(ref: WindowsNodeAssetTokenObservationRef, observationBinding: object): Readonly<WindowsNodeAssetTokenObservation> {
            return operation(() => {
              const value = ref && typeof ref === "object" ? observations.get(ref) : undefined;
              if (!value || value.binding !== observationBinding) return fail(); return value.facts;
            });
          }, close() {
          if (closed) { usable(); return; }
          operation(() => {
            recheck(); for (const pin of pins.slice().reverse()) close(pin.handle);
            for (const [raw, value] of borrowed) { if (shared.borrowed.get(raw) !== value) return fail(); shared.borrowed.delete(raw); }
            borrowed.clear(); closed = true; owners.delete(record); shared.owners.delete(record);
          });
        } });
      });
    },
  });
}

/** The real witness binds Win64 DLLs lazily; portable unit tests use the injected ABI seam above. */
export function loadWindowsNodeAssetEnforcementNative(): WindowsNodeAssetEnforcementNative {
  if (process.platform !== "win32" || process.arch !== "x64") throw new WindowsNodeAssetEnforcementNativeCleanupError();
  const failure = universes.get(processFence)?.failure ?? processFence.failure; if (failure) throw failure;
  try {
    const native = createRequire(__filename)("koffi") as typeof Koffi;
    return bindWindowsNodeAssetEnforcementNative(native, name => native.load(name));
  } catch {
    processFence.failure ??= new WindowsNodeAssetEnforcementNativeCleanupError(); throw processFence.failure;
  }
}
