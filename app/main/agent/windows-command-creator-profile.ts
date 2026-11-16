/** Fresh native profile provenance, never a caller-supplied SID/profile claim. Its opaque reference owns one active tree.
 * Delete/Free uncertainty permanently revokes admissions and retains every allocation; no existing profile is adopted.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import type { WindowsLpacProfile } from "./experimental-windows-lpac-api";

declare const profileBrand: unique symbol;
/** Opaque identity whose runtime authority lives only in this module's private WeakMap. */
export type WindowsCommandCreatorProfileRef = Readonly<{ readonly [profileBrand]: true }>;
/** Fixed failure without profile name, SID, native status, pointer or cause disclosure. */
export class WindowsCommandCreatorProfileCleanupError extends Error {
  readonly code = "windows-command-creator-profile-unverified";
  constructor() { super("Fresh creator profile ownership is unverified; retain its native owner."); this.name = "WindowsCommandCreatorProfileCleanupError"; }
}
/** Native fault-test seam; caller-visible fields cannot restore a privately retired owner. */
export interface WindowsCommandCreatorProfileFence { failure?: WindowsCommandCreatorProfileCleanupError; retained: unknown[] }
type Native = (...args: unknown[]) => unknown;
type Loader = (name: string) => { func(prototype: string): unknown };
type Owner = {
  states: Set<State>;
  release(state: State): void;
  usable(): void;
  invoke(name: string, args: unknown[]): unknown;
  create(state: State): unknown;
  poison(extra?: unknown): never;
};
type State = {
  owner: Owner; name: string; output: unknown[]; rawSid?: unknown; profile?: Readonly<WindowsLpacProfile>;
  active: boolean; closing: boolean; closed: boolean; tree?: object; deleteAttempted: boolean; freeAttempted: boolean;
};
type Universe = { failure?: WindowsCommandCreatorProfileCleanupError; busy: boolean; states: Set<State> };
const profiles = new WeakMap<object, State>();
const nativeOwners = new Set<Owner>();
const defaultFence: WindowsCommandCreatorProfileFence = { retained: [] };
const universes = new WeakMap<WindowsCommandCreatorProfileFence, Universe>();
// This factory creates top-level packages, not builtin/child package identities. The selected SDK fixes their RID count at eight.
// https://github.com/microsoft/win32metadata/blob/15fc870a5e96df7c560877ff30136c0fb5a21e9b/generation/WinSDK/RecompiledIdlHeaders/um/winnt.h#L11086-L11104
const PACKAGE_SUBAUTHORITIES = 8, PACKAGE_SID_BYTES = 8 + PACKAGE_SUBAUTHORITIES * 4;
const pointer = (value: unknown): value is bigint => typeof value === "bigint" && value > 0n && value < 0x8000000000000000n;
const refusal = () => new Error("The fresh creator profile reference is unavailable for this tree.");

function stateFor(ref: WindowsCommandCreatorProfileRef): State {
  if (ref === null || typeof ref !== "object") throw refusal();
  const state = profiles.get(ref);
  if (!state) throw refusal();
  state.owner.usable(); return state;
}
function active(ref: WindowsCommandCreatorProfileRef): State & { profile: Readonly<WindowsLpacProfile> } {
  const state = stateFor(ref);
  if (!state.active || !state.profile || state.closing || state.closed) throw refusal();
  return state as State & { profile: Readonly<WindowsLpacProfile> };
}
function treeKey(key: object): void { if (key === null || typeof key !== "object") throw refusal(); }

/** Trusted-host access only. Structural copies cannot recover the reference's fresh-native provenance. */
export function windowsCommandCreatorProfile(ref: WindowsCommandCreatorProfileRef): Readonly<WindowsLpacProfile> { return active(ref).profile; }

/** Only the Native tree's private owner-record identity may bind; at most one tree is active. */
export function bindWindowsCommandCreatorTree(ref: WindowsCommandCreatorProfileRef, key: object): string {
  const state = active(ref); treeKey(key);
  if (state.tree !== undefined) throw refusal();
  state.tree = key; return state.profile.sidText;
}
/** Exact reference and owner-record identity remain required for every package admission. */
export function requireWindowsCommandCreatorTree(ref: WindowsCommandCreatorProfileRef, key: object): string {
  const state = active(ref); treeKey(key);
  if (state.tree !== key) throw refusal();
  return state.profile.sidText;
}
/** Called only after the Native tree positively closes every owner; this function does not invent a Stop witness. */
export function releaseWindowsCommandCreatorTree(ref: WindowsCommandCreatorProfileRef, key: object): void {
  const state = active(ref); treeKey(key);
  if (state.tree !== key) throw refusal();
  state.tree = undefined;
}

/** Revoke before the first release call. Neither a failed delete nor an uncertain FreeSid can ever be retried. */
export function closeWindowsCommandCreatorProfile(ref: WindowsCommandCreatorProfileRef): void {
  const state = stateFor(ref);
  if (state.closed) return;
  if (state.closing || state.deleteAttempted || state.freeAttempted) return state.owner.poison();
  if (state.tree !== undefined || !state.active || !state.profile) throw refusal();
  state.active = false; state.closing = true; state.deleteAttempted = true;
  if (state.owner.invoke("DeleteAppContainerProfile", [state.name]) !== 0) return state.owner.poison();
  state.freeAttempted = true;
  if (state.owner.invoke("FreeSid", [state.profile.sid]) !== null) return state.owner.poison();
  state.closed = true; state.closing = false; state.owner.release(state);
}

function sidBytes(value: unknown, expected: number): Buffer {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    if (value.byteLength !== expected) throw refusal();
    return Buffer.from(value);
  }
  if (!Array.isArray(value) || value.length !== expected) throw refusal();
  const bytes = Buffer.alloc(expected);
  for (let index = 0; index < expected; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const byte: unknown = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) { bytes.fill(0); throw refusal(); }
    bytes[index] = byte;
  }
  return bytes;
}
function packageText(bytes: Buffer): string {
  const count = bytes[1];
  if (bytes[0] !== 1 || count !== PACKAGE_SUBAUTHORITIES || bytes.length !== PACKAGE_SID_BYTES ||
      !bytes.subarray(2, 8).equals(Buffer.from([0, 0, 0, 0, 0, 15])) || bytes.readUInt32LE(8) !== 2) throw refusal();
  const parts: number[] = [];
  for (let index = 0; index < count; index++) parts.push(bytes.readUInt32LE(8 + index * 4));
  const text = `S-1-15-${parts.join("-")}`;
  if (text === "S-1-15-2-1") throw refusal();
  return text;
}

/** Fixed Native FFI test seam. Its create method still calls fresh CreateAppContainerProfile with no supplied profile. */
export function bindWindowsCommandCreatorProfileNative(native: Pick<typeof Koffi, "sizeof" | "decode">, load: Loader,
  fence: WindowsCommandCreatorProfileFence = defaultFence): { create(): WindowsCommandCreatorProfileRef } {
  if (fence === null || typeof fence !== "object") throw new WindowsCommandCreatorProfileCleanupError();
  let universe = universes.get(fence);
  if (!universe) { universe = { busy: false, states: new Set<State>() }; universes.set(fence, universe); }
  const shared = universe;
  const functions: Record<string, Native> = {};
  let terminal: WindowsCommandCreatorProfileCleanupError | undefined;
  const owner: Owner = {
    states: new Set<State>(),
    release(state) { owner.states.delete(state); shared.states.delete(state); },
    poison(extra) {
      terminal ??= shared.failure ?? new WindowsCommandCreatorProfileCleanupError(); shared.failure ??= terminal;
      // This private set, not the caller-visible fence, is the lifetime/retirement authority.
      nativeOwners.add(owner);
      try { fence.failure ??= terminal; fence.retained.push({ owner, functions, states: [...shared.states], extra }); } catch { /* Keep the complete owner privately. */ }
      throw terminal;
    },
    usable() {
      if (shared.failure) { terminal ??= shared.failure; throw terminal; }
      if (terminal) throw terminal;
      if (shared.busy || fence.failure) owner.poison();
    },
    invoke(name, args) {
      owner.usable(); shared.busy = true; let value: unknown, threw = false;
      try { value = functions[name](...args); } catch { threw = true; }
      finally { shared.busy = false; }
      if (threw || terminal || shared.failure || fence.failure) return owner.poison(value);
      return value;
    },
    create(state) {
      owner.usable(); shared.busy = true; let result: unknown, threw = false;
      try { result = functions.CreateAppContainerProfile(state.name, state.name, "Disposable fixed creator-owner proof", null, 0, state.output); }
      catch { threw = true; }
      finally {
        // The fresh host array is retained before the call; never invoke a getter installed by a malformed test delegate.
        const descriptor = Object.getOwnPropertyDescriptor(state.output, "0");
        state.rawSid = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
        shared.busy = false;
      }
      if (threw || terminal || shared.failure || fence.failure) return owner.poison(result);
      return result;
    },
  };
  nativeOwners.add(owner);
  try {
    owner.usable();
    if (native.sizeof("void *") !== 8 || typeof native.decode !== "function") owner.poison();
    for (const [library, prototypes] of Object.entries({
      userenv: [
        "int32_t __stdcall CreateAppContainerProfile(const char16_t *name, const char16_t *display, const char16_t *description, void *capabilities, uint32_t count, _Out_ void **sid)",
        "int32_t __stdcall DeleteAppContainerProfile(const char16_t *name)",
      ],
      advapi32: ["int __stdcall IsValidSid(void *sid)", "uint32_t __stdcall GetLengthSid(void *sid)", "void * __stdcall FreeSid(void *sid)"],
    })) {
      const dll = load(`${library}.dll`);
      for (const prototype of prototypes) {
        const name = /\b(\w+)\s*\(/.exec(prototype)![1], call = dll.func(prototype);
        if (typeof call !== "function") owner.poison();
        functions[name] = call as Native;
      }
    }
    owner.usable();
  } catch { owner.poison(); }
  return Object.freeze({ create() {
    owner.usable();
    let suffix: string;
    try { suffix = randomUUID(); } catch { throw refusal(); }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(suffix)) throw refusal();
    const state: State = { owner, name: `ember-creator-${suffix}`, output: [null], active: false, closing: false, closed: false, deleteAttempted: false, freeAttempted: false };
    owner.states.add(state); shared.states.add(state);
    let bytes: Buffer | undefined;
    try {
      const result = owner.create(state), sid = state.rawSid;
      if (result !== 0 || !pointer(sid)) return owner.poison();
      if ([...shared.states].some(other => other !== state && !other.closed && other.rawSid === sid)) return owner.poison();
      const valid = owner.invoke("IsValidSid", [sid]);
      if (typeof valid !== "number" || !Number.isInteger(valid) || valid < -0x80000000 || valid > 0x7fffffff || valid === 0) return owner.poison();
      const length = owner.invoke("GetLengthSid", [sid]);
      if (length !== PACKAGE_SID_BYTES) return owner.poison();
      // Decoder callbacks are Native-boundary test seams too; a swallowed reentrant failure must retire this owner.
      let text: string;
      owner.usable(); shared.busy = true;
      try { bytes = sidBytes(native.decode(sid, "uint8_t", length), length); text = packageText(bytes); }
      finally { shared.busy = false; }
      owner.usable();
      state.profile = Object.freeze({ name: state.name, sid, sidText: text }); state.active = true;
      const ref = Object.freeze({}) as WindowsCommandCreatorProfileRef;
      profiles.set(ref, state); return ref;
    } catch { return owner.poison(); }
    finally { bytes?.fill(0); }
  } });
}

let production: ReturnType<typeof bindWindowsCommandCreatorProfileNative> | undefined;
/** Production has no arguments, callback or profile adoption path; only the real fixed Win64 binding mints references. */
export function createFreshWindowsCommandCreatorProfile(): WindowsCommandCreatorProfileRef {
  if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") throw refusal();
  const failure = universes.get(defaultFence)?.failure;
  if (failure) throw failure;
  if (defaultFence.failure) throw new WindowsCommandCreatorProfileCleanupError();
  if (!production) {
    try {
      const native = createRequire(__filename)("koffi") as typeof Koffi;
      production = bindWindowsCommandCreatorProfileNative(native, name => native.load(name));
    } catch {
      const failed = universes.get(defaultFence)?.failure;
      if (failed) throw failed;
      throw new WindowsCommandCreatorProfileCleanupError();
    }
  }
  return production.create();
}
