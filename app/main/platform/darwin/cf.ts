/**
 * CoreFoundation for the macOS backends, through koffi: CFString, CFNumber, CFBoolean, CFArray, CFDictionary and
 * CFData to and from JS, with the ownership rule made explicit. What a Create or Copy function returns is owned and
 * released exactly once by its caller (`own()` does that around a callback); what a Get function returns is borrowed
 * and never released. Written to be shared: the window-system and input backends use it in Electron's main process,
 * and the macOS accessibility provider will use it in a node-mode child, so it imports no Electron and loads nothing
 * until openCoreFoundation() runs on macOS. The conversions live in makeCF(), over the raw functions, so they are
 * unit-tested on any OS with a fake.
 */

import { bindFunctions, copyBytes, framework, globalAddress, globalPointer, koffiModule, namedStruct, onMacOS } from "./native";
import type { Koffi, Ref } from "./native";

export type { Ref } from "./native";

export const CF_PATH = framework("CoreFoundation");

/** CFNumberType values (CFNumber.h). */
export const CF_NUMBER_SINT64 = 4;
export const CF_NUMBER_FLOAT64 = 6;

/** The koffi prototypes, by C name. `EmberCFRange` is { location, length } as two CFIndex (long). */
export const CF_PROTOTYPES = {
  CFRelease: "void CFRelease(void *cf)",
  CFRetain: "void *CFRetain(void *cf)",
  CFGetTypeID: "unsigned long CFGetTypeID(void *cf)",
  CFEqual: "bool CFEqual(void *a, void *b)",
  CFHash: "unsigned long CFHash(void *cf)",
  CFStringGetTypeID: "unsigned long CFStringGetTypeID(void)",
  CFNumberGetTypeID: "unsigned long CFNumberGetTypeID(void)",
  CFBooleanGetTypeID: "unsigned long CFBooleanGetTypeID(void)",
  CFArrayGetTypeID: "unsigned long CFArrayGetTypeID(void)",
  CFDictionaryGetTypeID: "unsigned long CFDictionaryGetTypeID(void)",
  CFDataGetTypeID: "unsigned long CFDataGetTypeID(void)",
  CFStringGetLength: "long CFStringGetLength(void *s)",
  CFStringGetCharacters: "void CFStringGetCharacters(void *s, EmberCFRange range, void *buffer)",
  CFStringCreateWithCharacters: "void *CFStringCreateWithCharacters(void *alloc, const void *chars, long n)",
  CFNumberGetValue: "bool CFNumberGetValue(void *n, long type, _Out_ double *value)",
  CFNumberCreate: "void *CFNumberCreate(void *alloc, long type, const void *value)",
  CFBooleanGetValue: "bool CFBooleanGetValue(void *b)",
  CFArrayGetCount: "long CFArrayGetCount(void *a)",
  CFArrayGetValueAtIndex: "void *CFArrayGetValueAtIndex(void *a, long index)",
  CFArrayCreate: "void *CFArrayCreate(void *alloc, const void *values, long n, void *callbacks)",
  CFDictionaryGetValue: "void *CFDictionaryGetValue(void *d, void *key)",
  CFDictionaryCreate: "void *CFDictionaryCreate(void *alloc, const void *keys, const void *values, long n, void *keyCallbacks, void *valueCallbacks)",
  CFDataGetLength: "long CFDataGetLength(void *d)",
  CFDataGetBytePtr: "void *CFDataGetBytePtr(void *d)",
} as const;

/** The CoreFoundation functions and constants makeCF() needs, as koffi binds them (a fake in the tests). */
export interface CFRaw {
  CFRelease(cf: Ref): void;
  CFRetain(cf: Ref): Ref | null;
  CFGetTypeID(cf: Ref): number | bigint;
  CFEqual(a: Ref, b: Ref): boolean;
  CFHash(cf: Ref): number | bigint;
  CFStringGetTypeID(): number | bigint;
  CFNumberGetTypeID(): number | bigint;
  CFBooleanGetTypeID(): number | bigint;
  CFArrayGetTypeID(): number | bigint;
  CFDictionaryGetTypeID(): number | bigint;
  CFDataGetTypeID(): number | bigint;
  CFStringGetLength(s: Ref): number;
  CFStringGetCharacters(s: Ref, range: { location: number; length: number }, buffer: Buffer): void;
  CFStringCreateWithCharacters(alloc: null, chars: Buffer, n: number): Ref | null;
  CFNumberGetValue(n: Ref, type: number, value: number[]): boolean;
  CFNumberCreate(alloc: null, type: number, value: Buffer): Ref | null;
  CFBooleanGetValue(b: Ref): boolean;
  CFArrayGetCount(a: Ref): number;
  CFArrayGetValueAtIndex(a: Ref, index: number): Ref | null;
  CFArrayCreate(alloc: null, values: Buffer, n: number, callbacks: Ref | null): Ref | null;
  CFDictionaryGetValue(d: Ref, key: Ref): Ref | null;
  CFDictionaryCreate(alloc: null, keys: Buffer, values: Buffer, n: number, keyCallbacks: Ref | null, valueCallbacks: Ref | null): Ref | null;
  CFDataGetLength(d: Ref): number;
  CFDataGetBytePtr(d: Ref): Ref | null;
  /** kCFBooleanTrue and kCFBooleanFalse (exported CFBooleanRef globals, read once with lib.symbol + decode). */
  readonly kCFBooleanTrue: Ref | null;
  readonly kCFBooleanFalse: Ref | null;
  /** Addresses of kCFTypeArrayCallBacks, kCFTypeDictionaryKeyCallBacks and kCFTypeDictionaryValueCallBacks. */
  readonly arrayCallBacks: Ref | null;
  readonly dictionaryKeyCallBacks: Ref | null;
  readonly dictionaryValueCallBacks: Ref | null;
  /** Copies native bytes into a Buffer (koffi.decode; never koffi.view). */
  copyBytes(ptr: Ref, n: number): Buffer;
}

/** What kind of CoreFoundation object a reference is. */
export type CFKind = "string" | "number" | "boolean" | "array" | "dictionary" | "data" | "other";

/** CoreFoundation, the JS way round. Every `Ref` argument may be null (NULL) and then gives the empty answer. */
export interface CF {
  readonly raw: CFRaw;
  /** CFRelease, ignoring NULL. */
  release(ref: Ref | null | undefined): void;
  /** CFRetain (+1), or null for NULL. */
  retain(ref: Ref | null | undefined): Ref | null;
  /** Calls `fn` with an owned reference (from a Create or Copy call) and releases it afterwards, even on a throw. */
  own<T>(ref: Ref | null | undefined, fn: (ref: Ref) => T): T | null;
  kind(ref: Ref | null | undefined): CFKind | null;
  /** A CFString as a JS string (null when it isn't one). `max` caps the UTF-16 units read (a pair is never split). */
  string(ref: Ref | null | undefined, max?: number): string | null;
  /** A CFNumber as a JS number (null when it isn't one). */
  number(ref: Ref | null | undefined): number | null;
  /** A CFBoolean as a JS boolean (null when it isn't one). */
  boolean(ref: Ref | null | undefined): boolean | null;
  /** The values of a CFArray, borrowed (Get rule: don't release them); [] when it isn't one. */
  array(ref: Ref | null | undefined): Ref[];
  /** A CFDictionary's value for a CFString key spelled `key`, borrowed; null when absent or not a dictionary. */
  get(dict: Ref | null | undefined, key: string): Ref | null;
  /** The bytes of a CFData (copied), or null when it isn't one. */
  data(ref: Ref | null | undefined): Buffer | null;
  /**
   * An interned CFString for a constant name (dictionary keys, AX attribute names), created once and kept for the
   * life of the process: never release it. Only for a fixed set of names, so the cache stays small.
   */
  key(name: string): Ref;
  /** New CFString (+1: release it). */
  createString(s: string): Ref | null;
  /** New CFNumber (+1): SInt64 for safe integers, Float64 otherwise. */
  createNumber(n: number): Ref | null;
  /** New CFArray of CF objects (+1; retains its values). */
  createArray(values: readonly Ref[]): Ref | null;
  /** New CFDictionary of CF objects (+1; retains its keys and values). */
  createDictionary(entries: readonly (readonly [Ref, Ref])[]): Ref | null;
  /** kCFBooleanTrue / kCFBooleanFalse (constants: never release). */
  readonly kTrue: Ref | null;
  readonly kFalse: Ref | null;
  equal(a: Ref | null | undefined, b: Ref | null | undefined): boolean;
  hash(ref: Ref | null | undefined): number;
}

/** UTF-16 code units → string, dropping a lone high surrogate left at the end by a cap. */
export function utf16ToString(units: Buffer): string {
  let n = units.length >> 1;
  if (n > 0) {
    const last = units.readUInt16LE((n - 1) * 2);
    if (last >= 0xd800 && last <= 0xdbff) n -= 1;
  }
  return units.toString("utf16le", 0, n * 2);
}

/** Pointer values packed as a C array of `void *` (8 bytes each on every macOS Ember supports). */
export function pointerArray(values: readonly Ref[]): Buffer {
  const buf = Buffer.alloc(Math.max(8, values.length * 8));
  values.forEach((v, i) => buf.writeBigUInt64LE(BigInt.asUintN(64, v), i * 8));
  return buf;
}

/** The JS side of CoreFoundation over raw functions (koffi's in openCoreFoundation(), a fake in the tests). */
export function makeCF(raw: CFRaw): CF {
  let ids: Record<CFKind, number> | null = null;
  const typeIds = () => (ids ??= {
    string: Number(raw.CFStringGetTypeID()),
    number: Number(raw.CFNumberGetTypeID()),
    boolean: Number(raw.CFBooleanGetTypeID()),
    array: Number(raw.CFArrayGetTypeID()),
    dictionary: Number(raw.CFDictionaryGetTypeID()),
    data: Number(raw.CFDataGetTypeID()),
    other: -1,
  });
  const kind = (ref: Ref | null | undefined): CFKind | null => {
    if (!ref) return null;
    const id = Number(raw.CFGetTypeID(ref));
    const t = typeIds();
    for (const k of ["string", "number", "boolean", "array", "dictionary", "data"] as const) if (t[k] === id) return k;
    return "other";
  };
  const keys = new Map<string, Ref>();
  const createString = (s: string): Ref | null => {
    const units = Buffer.from(s, "utf16le");
    return raw.CFStringCreateWithCharacters(null, units, units.length >> 1) ?? null;
  };
  const cf: CF = {
    raw,
    release(ref) {
      if (ref) raw.CFRelease(ref);
    },
    retain(ref) {
      return ref ? raw.CFRetain(ref) ?? null : null;
    },
    own(ref, fn) {
      if (!ref) return null;
      try {
        return fn(ref);
      } finally {
        raw.CFRelease(ref);
      }
    },
    kind,
    string(ref, max) {
      if (kind(ref) !== "string") return null;
      const length = raw.CFStringGetLength(ref!);
      const n = Math.max(0, Math.min(length, max ?? length));
      if (n === 0) return "";
      const units = Buffer.alloc(n * 2);
      raw.CFStringGetCharacters(ref!, { location: 0, length: n }, units);
      return n < length ? utf16ToString(units) : units.toString("utf16le");
    },
    number(ref) {
      if (kind(ref) !== "number") return null;
      const out = [0];
      raw.CFNumberGetValue(ref!, CF_NUMBER_FLOAT64, out); // false only means "lossy": the value is still written
      return Number.isFinite(out[0]) ? out[0]! : null;
    },
    boolean(ref) {
      if (kind(ref) !== "boolean") return null;
      return !!raw.CFBooleanGetValue(ref!);
    },
    array(ref) {
      if (kind(ref) !== "array") return [];
      const n = raw.CFArrayGetCount(ref!);
      const out: Ref[] = [];
      for (let i = 0; i < n; i++) {
        const v = raw.CFArrayGetValueAtIndex(ref!, i);
        if (v) out.push(v);
      }
      return out;
    },
    get(dict, name) {
      if (kind(dict) !== "dictionary") return null;
      return raw.CFDictionaryGetValue(dict!, cf.key(name)) ?? null;
    },
    data(ref) {
      if (kind(ref) !== "data") return null;
      const n = raw.CFDataGetLength(ref!);
      const ptr = n > 0 ? raw.CFDataGetBytePtr(ref!) : null;
      return ptr ? raw.copyBytes(ptr, n) : Buffer.alloc(0);
    },
    key(name) {
      let k = keys.get(name);
      if (k === undefined) {
        const made = createString(name);
        if (!made) throw new Error(`cannot create the CFString "${name}"`);
        keys.set(name, (k = made));
      }
      return k;
    },
    createString,
    createNumber(n) {
      const buf = Buffer.alloc(8);
      if (Number.isSafeInteger(n)) {
        buf.writeBigInt64LE(BigInt(n));
        return raw.CFNumberCreate(null, CF_NUMBER_SINT64, buf) ?? null;
      }
      buf.writeDoubleLE(n);
      return raw.CFNumberCreate(null, CF_NUMBER_FLOAT64, buf) ?? null;
    },
    createArray(values) {
      return raw.CFArrayCreate(null, pointerArray(values), values.length, raw.arrayCallBacks) ?? null;
    },
    createDictionary(entries) {
      const ks = pointerArray(entries.map(e => e[0])), vs = pointerArray(entries.map(e => e[1]));
      return raw.CFDictionaryCreate(null, ks, vs, entries.length, raw.dictionaryKeyCallBacks, raw.dictionaryValueCallBacks) ?? null;
    },
    get kTrue() {
      return raw.kCFBooleanTrue;
    },
    get kFalse() {
      return raw.kCFBooleanFalse;
    },
    equal(a, b) {
      return !!a && !!b && !!raw.CFEqual(a, b);
    },
    hash(ref) {
      return ref ? Number(raw.CFHash(ref)) : 0;
    },
  };
  return cf;
}

/** koffi's named types for CoreFoundation's structs (defined once per process). */
export function cfTypes(koffi: Koffi): void {
  namedStruct(koffi, "EmberCFRange", { location: "long", length: "long" });
}

/** Why the last openCoreFoundation() returned null (for the log). */
export let cfError: unknown = null;
let bound: CF | null | undefined;

/**
 * CoreFoundation, bound once per process on first use. null off macOS or when the framework can't be bound
 * (cfError says why).
 */
export function openCoreFoundation(): CF | null {
  if (bound !== undefined) return bound;
  if (!onMacOS()) return null;
  try {
    const koffi = koffiModule();
    cfTypes(koffi);
    const lib = koffi.load(CF_PATH);
    const fns = bindFunctions<Omit<CFRaw, "kCFBooleanTrue" | "kCFBooleanFalse" | "arrayCallBacks" | "dictionaryKeyCallBacks" | "dictionaryValueCallBacks" | "copyBytes">>(lib, CF_PROTOTYPES);
    const raw: CFRaw = {
      ...fns,
      kCFBooleanTrue: globalPointer(koffi, lib, "kCFBooleanTrue"),
      kCFBooleanFalse: globalPointer(koffi, lib, "kCFBooleanFalse"),
      arrayCallBacks: globalAddress(lib, "kCFTypeArrayCallBacks"),
      dictionaryKeyCallBacks: globalAddress(lib, "kCFTypeDictionaryKeyCallBacks"),
      dictionaryValueCallBacks: globalAddress(lib, "kCFTypeDictionaryValueCallBacks"),
      copyBytes: (ptr, n) => copyBytes(koffi, ptr, n),
    };
    bound = makeCF(raw);
  } catch (err) {
    cfError = err;
    bound = null;
  }
  return bound;
}
