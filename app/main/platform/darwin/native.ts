/**
 * The koffi plumbing every macOS binding module shares: where the system frameworks are, loading one with a guard,
 * binding a table of C prototypes in one go, reading an exported global, and koffi's process-wide named types.
 * Nothing here loads a library by itself: the binding modules (cf.ts, cg.ts, ax.ts, hitoolbox.ts) call it only when
 * their factory runs on macOS, so every module imports cleanly on Linux and Windows (the unit tests import them
 * there). koffi 3 hands pointers over as BigInt (null for NULL), which is what `Ref` is.
 */

import { createRequire } from "node:module";

/** A native pointer as koffi 3 passes it: an address. NULL is `null` wherever a pointer may be absent. */
export type Ref = bigint;

export type Koffi = typeof import("koffi");
export type Library = import("koffi").LibraryHandle;
export type KoffiType = import("koffi").TypeObject;

const requireCjs = createRequire(__filename);

/** True when this process runs on macOS: the only OS where the bindings may load anything. */
export const onMacOS = (): boolean => process.platform === "darwin";

/** The binary of a system framework (dlopen finds it in the dyld shared cache although no file is there). */
export function framework(name: string, sub?: string): string {
  const root = `/System/Library/Frameworks/${name}.framework`;
  return sub ? `${root}/Frameworks/${sub}.framework/${sub}` : `${root}/${name}`;
}

/** koffi itself, loaded on first use (a failure here is a missing native package: callers return null). */
export function koffiModule(): Koffi {
  return requireCjs("koffi") as Koffi;
}

/** Loads the first library of `paths` that opens; throws the last error when none does. */
export function loadFirst(koffi: Koffi, paths: readonly string[]): Library {
  let last: unknown = new Error("no library path given");
  for (const path of paths) {
    try {
      return koffi.load(path);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/** The C name in a koffi prototype ("void *CGEventCreate(void *source)" → "CGEventCreate"). */
export function functionName(prototype: string): string {
  const m = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(prototype);
  if (!m) throw new Error(`not a C prototype: ${prototype}`);
  return m[1]!;
}

/**
 * Binds every prototype of `table` from `lib` (keys are the C names). Throws, naming the function, when one is
 * missing: a binding that half works would fail later at a worse moment.
 */
export function bindFunctions<T>(lib: Library, table: Readonly<Record<string, string>>): T {
  const out: Record<string, unknown> = {};
  for (const [name, prototype] of Object.entries(table)) {
    try {
      out[name] = lib.func(prototype);
    } catch (err) {
      throw new Error(`cannot bind ${name}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
  return out as T;
}

/** Binds one prototype, or undefined when the library doesn't export it (private or newer API). */
export function bindOptional<F>(lib: Library, prototype: string): F | undefined {
  try {
    return lib.func(prototype) as unknown as F;
  } catch {
    return undefined; // not exported by this macOS: callers have a fallback
  }
}

/** The value of an exported pointer global (a CFStringRef constant, kCFBooleanTrue…), or null when absent. */
export function globalPointer(koffi: Koffi, lib: Library, name: string): Ref | null {
  try {
    const address = lib.symbol(name) as Ref | null;
    if (!address) return null;
    return (koffi.decode(address, "void *") as Ref | null) ?? null;
  } catch {
    return null; // not exported: callers treat the constant as unavailable
  }
}

/** The address of an exported global itself (a struct passed by address, like kCFTypeArrayCallBacks). */
export function globalAddress(lib: Library, name: string): Ref | null {
  try {
    return (lib.symbol(name) as Ref | null) ?? null;
  } catch {
    return null; // not exported: callers treat it as unavailable
  }
}

/**
 * A named koffi struct, defined once per process. koffi's type names are process-wide and a second definition
 * throws, so a module loaded twice (two test files in one worker, or a bundle and a test) reuses the first.
 */
export function namedStruct(koffi: Koffi, name: string, members: Record<string, string>): KoffiType {
  try {
    return koffi.type(name);
  } catch {
    return koffi.struct(name, members);
  }
}

/** Copies `n` bytes of native memory into a Buffer (koffi.view would make an external buffer, which aborts Electron). */
export function copyBytes(koffi: Koffi, ptr: Ref, n: number): Buffer {
  if (n <= 0) return Buffer.alloc(0);
  const a = koffi.decode(ptr, "uint8_t", n) as Uint8Array;
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}
