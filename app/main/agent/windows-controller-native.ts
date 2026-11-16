/** Read-only ACL attestation and exact-object deletion for one freshly minted Windows SDK controller tree. */
import path from "node:path/win32";
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { ScopedCodingFileError } from "./coding-platform";
import { retireWindowsCodingNative, WindowsCodingCleanupError, type WindowsCodingHandle, type WindowsCodingInfo, type WindowsCodingNative } from "./windows-coding-native";

/** Unknown native resource completion is retained and fences every later controller operation. */
export class WindowsControllerNativeCleanupError extends Error {
  readonly code = "windows-controller-cleanup-unverified";
  constructor() { super("Windows controller native cleanup could not be verified."); this.name = "WindowsControllerNativeCleanupError"; }
}
export interface WindowsControllerObject {
  readonly info: Readonly<WindowsCodingInfo>;
  /** Disposes only this claimed object after reattesting its held identity, direct parent and ACL. */
  remove(): void;
}
export interface WindowsControllerBoundary {
  /** The caller keeps both native lifetime tokens open until all claimed removals have settled. */
  claim(handle: WindowsCodingHandle, parentHandle: WindowsCodingHandle): WindowsControllerObject;
}
export interface WindowsControllerNative {
  readonly ownerSid: string;
  readonly tokenOwnerSid: string;
  assertFixed(info: WindowsCodingInfo): void;
  boundary(api: WindowsCodingNative, root: WindowsCodingHandle): WindowsControllerBoundary;
}
export interface WindowsControllerAcl {
  owner: string; control: number;
  aces: readonly { type: number; flags: number; mask: number; sid: string }[];
}

const ALL = 0x1f01ff, READ_CONTROL = 0x20000, READ_ATTRIBUTES = 0x80, DELETE = 0x10000;
const SPECIAL = 0x5640 | 0x40000 | 0x400000, INVALID = 0xffffffffffffffffn, SYSTEM = "S-1-5-18";
const fold = (value: string) => value.toUpperCase().toLowerCase().normalize("NFC");
let terminal: WindowsControllerNativeCleanupError | undefined;
const fail = (): never => { throw new ScopedCodingFileError("boundary"); };
const poison = (): WindowsControllerNativeCleanupError => { retireWindowsCodingNative(); return terminal ??= new WindowsControllerNativeCleanupError(); };
const guard = (): void => { if (terminal) throw terminal; };
const sidShape = (value: string) => typeof value === "string" && value.length <= 184 && /^S-\d+(?:-\d+)+$/.test(value);

/** Pure validation oracle only. Native authority always supplies the SIDs captured from its actual process token. */
export function assertWindowsControllerAcl(acl: WindowsControllerAcl, kind: WindowsCodingInfo["kind"], user: string, tokenOwner: string, fixed = false): void {
  if (!acl || !sidShape(user) || !sidShape(tokenOwner) || !Number.isInteger(acl.control) || acl.control < 0 || acl.control > 0xffff || !(acl.control & 4) ||
      fixed && (!(acl.control & 0x1000) || acl.owner !== user) || !fixed && acl.owner !== user && acl.owner !== tokenOwner ||
      kind !== "directory" && kind !== "file" || !Array.isArray(acl.aces) || acl.aces.length !== 2) fail();
  const explicit = kind === "directory" ? 3 : 0, inherited = explicit | 0x10;
  const principals: string[] = [];
  for (const ace of acl.aces) {
    if (!ace || ace.type !== 0 || ace.mask !== ALL || ace.flags !== explicit && (fixed || ace.flags !== inherited) || !sidShape(ace.sid)) fail();
    principals.push(ace.sid);
  }
  const expected = [user, SYSTEM].sort(); principals.sort();
  if (principals.some((principal, index) => principal !== expected[index])) fail();
}

function checkedInfo(input: WindowsCodingInfo): WindowsCodingInfo {
  const info = { ...input };
  if (!info || typeof info.finalPath !== "string" || info.finalPath.length > 32768 || info.finalPath.includes("/") || /[\p{Cc}\p{Cf}]/u.test(info.finalPath) ||
      !/^\\\\\?\\Volume\{[0-9a-f-]{36}\}\\/i.test(info.finalPath) || typeof info.volume !== "string" ||
      !/^\\\\\?\\Volume\{[0-9a-f-]{36}\}\\$/i.test(info.volume) || !fold(info.finalPath).startsWith(fold(info.volume)) ||
      typeof info.id !== "string" || !/^[0-9a-f]{16}$/i.test(info.id) || /^0+$/.test(info.id) || info.kind !== "file" && info.kind !== "directory" ||
      !Number.isInteger(info.attributes) || info.attributes < 0 || info.attributes > 0xffffffff || info.attributes & SPECIAL ||
      !!(info.attributes & 0x10) !== (info.kind === "directory") || info.links !== 1 || !Number.isSafeInteger(info.size) || info.size < 0 ||
      [info.created, info.written, info.changed].some(value => typeof value !== "string" || !/^\d+$/.test(value))) fail();
  return info;
}
const same = (a: WindowsCodingInfo, b: WindowsCodingInfo, metadata = true) => a.id === b.id && fold(a.volume) === fold(b.volume) &&
  fold(a.finalPath) === fold(b.finalPath) && a.kind === b.kind && a.attributes === b.attributes && a.links === b.links &&
  (!metadata || a.size === b.size && a.created === b.created && a.written === b.written && a.changed === b.changed);

export const WINDOWS_CONTROLLER_FUNCTIONS = {
  kernel32: [
    "void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
    "int __stdcall CloseHandle(void *file)", "void * __stdcall GetCurrentProcess()", "void * __stdcall LocalFree(void *memory)",
    "uint32_t __stdcall GetFileType(void *file)", "int __stdcall GetFileInformationByHandle(void *file, void *information)",
    "int __stdcall GetFileInformationByHandleEx(void *file, int kind, void *information, uint32_t length)",
    "uint32_t __stdcall GetFinalPathNameByHandleW(void *file, void *name, uint32_t length, uint32_t flags)",
  ],
  advapi32: [
    "int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
    "int __stdcall GetTokenInformation(void *token, int kind, void *information, uint32_t length, _Out_ uint32_t *returned)",
    "int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)",
    "uint32_t __stdcall GetSecurityInfo(void *file, int objectKind, uint32_t information, _Out_ void **owner, void *group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)",
    "int __stdcall GetSecurityDescriptorControl(void *descriptor, _Out_ uint16_t *control, _Out_ uint32_t *revision)",
    "int __stdcall GetAclInformation(void *acl, void *information, uint32_t length, int kind)",
    "int __stdcall GetAce(void *acl, uint32_t index, _Out_ void **ace)",
  ],
  ntdll: ["int32_t __stdcall NtSetInformationFile(void *file, void *io, void *information, uint32_t length, int kind)"],
} as const;

/** Portable FFI ownership seam. It never accepts an injected owner; both identities come from GetTokenInformation. */
export function bindWindowsControllerNative(native: Pick<typeof Koffi, "sizeof" | "decode">,
  load: (name: string) => { func(prototype: string): unknown }): WindowsControllerNative {
  guard(); if (native.sizeof("void *") !== 8) throw new ScopedCodingFileError("unavailable");
  const functions: Record<string, (...args: unknown[]) => unknown> = {};
  for (const [name, prototypes] of Object.entries(WINDOWS_CONTROLLER_FUNCTIONS)) {
    const library = load(`${name}.dll`);
    for (const prototype of prototypes) functions[/\b(\w+)\s*\(/.exec(prototype)![1]] = library.func(prototype) as (...args: unknown[]) => unknown;
  }
  // Entries survive failed native completion; neither raw handle reuse nor a retry can clear uncertainty.
  const handles = new Map<bigint, { uncertain: boolean }>(), allocations = new Set<bigint>();
  const pointer = (value: unknown): bigint => { if (typeof value !== "bigint" || value === 0n || value === -1n || value === INVALID) return fail(); return value; };
  const optionalPointer = (value: unknown): bigint | null => typeof value === "bigint" && value !== 0n && value !== -1n && value !== INVALID ? value : null;
  const close = (raw: bigint): void => {
    const entry = handles.get(raw); if (!entry || entry.uncertain) throw poison();
    let closed = false; try { closed = !!functions.CloseHandle(raw); } catch { /* Unknown completion retains the raw handle receipt. */ }
    if (!closed) { entry.uncertain = true; throw poison(); } handles.delete(raw);
  };
  const free = (raw: bigint): void => {
    if (!allocations.has(raw)) throw poison();
    let freed = false; try { freed = !functions.LocalFree(raw); } catch { /* Unknown completion retains the allocation receipt. */ }
    if (!freed) throw poison(); allocations.delete(raw);
  };
  const managed = <T>(operation: () => T, release: () => void): T => {
    let result!: T, problem: unknown, failed = false;
    try { result = operation(); } catch (error) { failed = true; problem = error; }
    release(); if (failed) throw problem; return result;
  };
  const sid = (raw: bigint): string => {
    const out: unknown[] = [null]; let converted: unknown;
    try { converted = functions.ConvertSidToStringSidW(raw, out); } catch { /* Any returned allocation is still accounted for below. */ }
    const text = optionalPointer(out[0]); if (text !== null) allocations.add(text);
    if (text === null) return fail();
    return managed(() => {
      if (!converted) fail(); const value = native.decode.string16(text); if (!sidShape(value)) fail(); return value;
    }, () => free(text));
  };
  const tokenOutput: unknown[] = [null]; let tokenOpened: unknown, tokenThrew = false;
  try { tokenOpened = functions.OpenProcessToken(functions.GetCurrentProcess(), 8, tokenOutput); } catch { tokenThrew = true; }
  const token = optionalPointer(tokenOutput[0]);
  if (token === null) { if (tokenThrew) throw poison(); return fail(); }
  handles.set(token, { uncertain: false });
  const identities = managed(() => {
    if (!tokenOpened) fail();
    const captured = (kind: 1 | 4): string => {
      const bytes = Buffer.alloc(4096), returned = [0];
      try {
        if (!functions.GetTokenInformation(token, kind, bytes, bytes.length, returned) || !Number.isInteger(returned[0]) || returned[0] < (kind === 1 ? 16 : 8) || returned[0] > bytes.length) fail();
        return sid(pointer(bytes.readBigUInt64LE(0)));
      } finally { bytes.fill(0); }
    };
    return Object.freeze({ user: captured(1), owner: captured(4) });
  }, () => close(token));

  const info = (raw: bigint): WindowsCodingInfo => {
    if (functions.GetFileType(raw) !== 1) fail();
    const bytes = Buffer.alloc(52), basic = Buffer.alloc(40), text = Buffer.alloc(32768 * 2);
    if (!functions.GetFileInformationByHandle(raw, bytes) || !functions.GetFileInformationByHandleEx(raw, 0, basic, basic.length)) fail();
    if (bytes.readUInt32LE(0) !== basic.readUInt32LE(32) || bytes.readBigUInt64LE(4) !== basic.readBigUInt64LE(0) || bytes.readBigUInt64LE(20) !== basic.readBigUInt64LE(16)) fail();
    const count = functions.GetFinalPathNameByHandleW(raw, text, 32768, 1);
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count >= 32768) fail();
    const finalPath = text.toString("utf16le", 0, count * 2), volume = /^(\\\\\?\\Volume\{[0-9a-f-]{36}\}\\)/i.exec(finalPath)?.[1];
    if (!volume) return fail();
    const length = BigInt(bytes.readUInt32LE(32)) << 32n | BigInt(bytes.readUInt32LE(36));
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) fail();
    return checkedInfo({ id: ((BigInt(bytes.readUInt32LE(44)) << 32n) | BigInt(bytes.readUInt32LE(48))).toString(16).padStart(16, "0"), volume: volume.toLowerCase(), finalPath,
      kind: bytes.readUInt32LE(0) & 0x10 ? "directory" : "file", attributes: bytes.readUInt32LE(0), links: bytes.readUInt32LE(40), size: Number(length),
      created: basic.readBigUInt64LE(0).toString(), written: basic.readBigUInt64LE(16).toString(), changed: basic.readBigUInt64LE(24).toString() });
  };
  const acl = (raw: bigint): WindowsControllerAcl => {
    const owner: unknown[] = [null], dacl: unknown[] = [null], descriptor: unknown[] = [null]; let status: unknown;
    try { status = functions.GetSecurityInfo(raw, 1, 5, owner, null, dacl, null, descriptor); } catch { /* Any returned descriptor is accounted for before validation. */ }
    const security = optionalPointer(descriptor[0]); if (security !== null) allocations.add(security);
    if (security === null) return fail();
    return managed(() => {
      if (status !== 0) fail();
      const control = [0], revision = [0], details = Buffer.alloc(12);
      if (!functions.GetSecurityDescriptorControl(security, control, revision) || !functions.GetAclInformation(pointer(dacl[0]), details, details.length, 2) || details.readUInt32LE(0) !== 2) fail();
      const aces: WindowsControllerAcl["aces"][number][] = [];
      for (let index = 0; index < 2; index++) {
        const ace: unknown[] = [null]; if (!functions.GetAce(pointer(dacl[0]), index, ace)) fail();
        const address = pointer(ace[0]), header = Buffer.from(native.decode(address, "uint8_t", 8) as Uint8Array);
        if (header.length !== 8 || header.readUInt16LE(2) < 12 || header.readUInt16LE(2) > 76) fail();
        aces.push({ type: header[0], flags: header[1], mask: header.readUInt32LE(4), sid: sid(address + 8n) });
      }
      return { owner: sid(pointer(owner[0])), control: control[0], aces };
    }, () => free(security));
  };
  const withObject = <T>(expectedInput: WindowsCodingInfo, remove: boolean, operation: (raw: bigint) => T): T => {
    guard(); const expected = checkedInfo(expectedInput); let result: unknown;
    try { result = functions.CreateFileW(expected.finalPath, READ_CONTROL | READ_ATTRIBUTES | (remove ? DELETE : 0), 7, null, 3, 0x02000000 | 0x00200000, null); }
    catch { throw poison(); }
    const raw = pointer(result); handles.set(raw, { uncertain: false });
    return managed(() => { if (!same(expected, info(raw))) fail(); return operation(raw); }, () => close(raw));
  };
  const safe = <T>(operation: () => T): T => {
    try { guard(); return operation(); }
    catch (error) {
      if (error instanceof WindowsControllerNativeCleanupError) throw error;
      if (error instanceof WindowsCodingCleanupError) throw poison();
      if (error instanceof ScopedCodingFileError) throw error;
      return fail();
    }
  };
  return Object.freeze({ ownerSid: identities.user, tokenOwnerSid: identities.owner,
    assertFixed(expected: WindowsCodingInfo) {
      safe(() => {
        const captured = Object.freeze(checkedInfo(expected));
        withObject(captured, false, raw => {
          assertWindowsControllerAcl(acl(raw), captured.kind, identities.user, identities.owner, true);
          if (!same(captured, info(raw))) fail();
        });
      });
    },
    boundary(api: WindowsCodingNative, root: WindowsCodingHandle): WindowsControllerBoundary {
      return safe(() => {
        api.assertPrivate(root); if (api.ownerSid !== identities.user) fail();
        const fixed = Object.freeze(checkedInfo(api.info(root))); if (fixed.kind !== "directory") fail();
        withObject(fixed, false, raw => { assertWindowsControllerAcl(acl(raw), "directory", identities.user, identities.owner, true); if (!same(fixed, info(raw)) || !same(fixed, checkedInfo(api.info(root)))) fail(); });
        type Claim = { info: Readonly<WindowsCodingInfo>; parent: WindowsCodingHandle; removed: boolean; object: WindowsControllerObject };
        const claims = new Map<WindowsCodingHandle, Claim>(), ids = new Set([`${fixed.volume}:${fixed.id}`]);
        const rootCurrent = () => { api.assertPrivate(root); if (!same(fixed, checkedInfo(api.info(root)), false)) fail(); };
        const parentInfo = (parent: WindowsCodingHandle): WindowsCodingInfo => {
          rootCurrent(); if (parent === root) return checkedInfo(api.info(root));
          const claim = claims.get(parent); if (!claim || claim.removed || claim.info.kind !== "directory") return fail();
          const live = checkedInfo(api.info(parent)); if (!same(claim.info, live, false)) fail(); return live;
        };
        return Object.freeze({ claim(handle: WindowsCodingHandle, parent: WindowsCodingHandle): WindowsControllerObject {
          return safe(() => {
            const previous = claims.get(handle);
            if (previous) {
              if (previous.parent !== parent || previous.removed) fail();
              const ancestor = parentInfo(parent), live = checkedInfo(api.info(handle));
              if (!same(previous.info, live, previous.info.kind === "file") || fold(path.dirname(live.finalPath)) !== fold(ancestor.finalPath)) fail();
              withObject(live, false, raw => {
                assertWindowsControllerAcl(acl(raw), live.kind, identities.user, identities.owner);
                if (!same(live, info(raw)) || !same(live, checkedInfo(api.info(handle))) || !same(ancestor, parentInfo(parent), false)) fail();
              });
              return previous.object;
            }
            const ancestor = parentInfo(parent), expected = Object.freeze(checkedInfo(api.info(handle)));
            if (expected.volume !== fixed.volume || fold(path.dirname(expected.finalPath)) !== fold(ancestor.finalPath) || ids.has(`${expected.volume}:${expected.id}`)) fail();
            const verify = (raw: bigint, observation: WindowsCodingInfo) => {
              rootCurrent(); if (!same(ancestor, parentInfo(parent), false) || !same(observation, checkedInfo(api.info(handle))) || !same(observation, info(raw))) fail();
              assertWindowsControllerAcl(acl(raw), observation.kind, identities.user, identities.owner);
              if (!same(ancestor, parentInfo(parent), false) || !same(observation, checkedInfo(api.info(handle))) || !same(observation, info(raw))) fail();
            };
            withObject(expected, false, raw => verify(raw, expected));
            const claim: Claim = { info: expected, parent, removed: false, object: undefined! };
            claim.object = Object.freeze({ info: expected, remove() {
              safe(() => {
                if (claim.removed) fail();
                const live = checkedInfo(api.info(handle)); if (!same(expected, live, expected.kind === "file")) fail();
                withObject(live, true, raw => {
                  verify(raw, live);
                  const disposition = Buffer.alloc(4), io = Buffer.alloc(16); disposition.writeUInt32LE(1);
                  let status: unknown; try { status = functions.NtSetInformationFile(raw, io, disposition, disposition.length, 64); } catch { throw poison(); }
                  if (typeof status !== "number" || !Number.isInteger(status) || (status >>> 0) === 0x103) throw poison();
                  if (status !== 0) fail(); claim.removed = true;
                });
              });
            } });
            ids.add(`${expected.volume}:${expected.id}`); claims.set(handle, claim); return claim.object;
          });
        } });
      });
    },
  });
}

let loaded: WindowsControllerNative | undefined;
/** Captures TokenUser and TokenOwner once, before a caller can allocate controller storage. */
export function loadWindowsControllerNative(): WindowsControllerNative {
  guard(); if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") throw new ScopedCodingFileError("unavailable");
  if (loaded) return loaded;
  try { const native = createRequire(__filename)("koffi") as typeof Koffi; return loaded = bindWindowsControllerNative(native, name => native.load(name)); }
  catch (error) {
    if (error instanceof WindowsControllerNativeCleanupError || error instanceof ScopedCodingFileError) throw error;
    throw new ScopedCodingFileError("unavailable");
  }
}
