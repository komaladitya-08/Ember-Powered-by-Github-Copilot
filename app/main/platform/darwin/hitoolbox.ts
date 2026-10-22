/**
 * The Carbon-era pieces the macOS input backend needs, through koffi: the keyboard layout in use (Text Input Sources
 * and UCKeyTranslate, so Ember presses the key that gives a character on this layout, not on a US one), whether the
 * current input source is a keyboard layout at all (an input method composes from the keys Ember posts), whether
 * secure keyboard entry is on (IsSecureEventInputEnabled) and every key's state in one call (GetKeys).
 *
 * Each of those is bound on its own, from Carbon, then HIToolbox, then CoreServices. The layout needs its four
 * functions together (half a layout would press wrong keys), but a macOS that moves one layout symbol must not
 * switch off the secure-input check: that check has its own lookup and answers null ("can't tell") when its symbol
 * is missing, which callers treat as on (fail closed). macOS 14 and later abort a process that calls the TIS
 * functions off the main thread, so the layout and the input source are read only on a process's main thread
 * (Electron's main process and a node-mode child are; a worker thread is not, and gets null). Binds nothing until
 * used on macOS; makeHIToolbox() holds the logic over the raw functions, so it is unit-tested with fakes.
 */

import { isMainThread } from "node:worker_threads";
import { bindOptional, framework, globalPointer, koffiModule, onMacOS, type Library } from "./native";
import type { Ref } from "./native";
import type { CF } from "./cf";

export const CARBON_PATH = framework("Carbon");
export const HITOOLBOX_PATH = framework("Carbon", "HIToolbox");
export const CORE_SERVICES_PATH = framework("CoreServices");
/** Where every function and constant is looked for, in this order (a macOS may move one behind another umbrella). */
export const HITOOLBOX_PATHS: readonly string[] = [CARBON_PATH, HITOOLBOX_PATH, CORE_SERVICES_PATH];

/** UCKeyTranslate's modifier state (EventModifiers >> 8): cmdKey, shiftKey, alphaLock, optionKey, controlKey. */
export const UC_MODIFIER = { command: 1, shift: 2, alphaLock: 4, option: 8, control: 16 } as const;
const UC_KEY_ACTION_DOWN = 0;

/** Every function this module binds but UCKeyTranslate, by C name. GetKeys fills a 16-byte KeyMap (BigEndianUInt32[4]). */
export const HITOOLBOX_PROTOTYPES = {
  TISCopyCurrentKeyboardLayoutInputSource: "void *TISCopyCurrentKeyboardLayoutInputSource(void)",
  TISCopyCurrentKeyboardInputSource: "void *TISCopyCurrentKeyboardInputSource(void)",
  TISGetInputSourceProperty: "void *TISGetInputSourceProperty(void *source, void *key)",
  LMGetKbdType: "uint8_t LMGetKbdType(void)",
  IsSecureEventInputEnabled: "bool IsSecureEventInputEnabled(void)",
  GetKeys: "void GetKeys(void *keyMap)",
} as const;

export const UC_KEY_TRANSLATE_PROTOTYPE =
  "int32_t UCKeyTranslate(const void *layout, uint16_t code, uint16_t action, uint32_t modifiers, uint32_t keyboardType, uint32_t options, _Inout_ uint32_t *deadKeyState, unsigned long maxLength, _Out_ unsigned long *actualLength, void *chars)";

/** kTISTypeKeyboardLayout's value (TextInputSources.h), compared with when the constant itself can't be read. */
export const TIS_TYPE_KEYBOARD_LAYOUT = "TISTypeKeyboardLayout";

/** The size of GetKeys' KeyMap: 128 keys, one bit each. */
export const KEY_MAP_BYTES = 16;

/** The raw functions and constants, each absent (or null) where this macOS doesn't export it. */
export interface HIRaw {
  TISCopyCurrentKeyboardLayoutInputSource?(): Ref | null;
  TISCopyCurrentKeyboardInputSource?(): Ref | null;
  TISGetInputSourceProperty?(source: Ref, key: Ref): Ref | null;
  LMGetKbdType?(): number;
  IsSecureEventInputEnabled?(): boolean;
  GetKeys?(keyMap: Buffer): void;
  UCKeyTranslate?(layout: Ref, code: number, action: number, modifiers: number, keyboardType: number, options: number, deadKeyState: number[], maxLength: number, actualLength: number[], chars: Buffer): number;
  readonly kTISPropertyUnicodeKeyLayoutData: Ref | null;
  readonly kTISPropertyInputSourceType: Ref | null;
  readonly kTISTypeKeyboardLayout: Ref | null;
}

/**
 * The keyboard layout in use: what each key types with a given UCKeyTranslate modifier state. `translate` gives ""
 * for a dead key or a key that types nothing, and null when the call failed. Pass it back to keyboardLayout() to
 * reuse it while the layout is unchanged; `release()` lets go of the input source.
 */
export interface KeyboardLayoutSource {
  translate(code: number, modifiers: number): string | null;
  release(): void;
}

export interface HIToolbox {
  /**
   * Is secure keyboard entry on (a password field has the keyboard, or Terminal's "Secure Keyboard Entry")? null when
   * IsSecureEventInputEnabled can't be called: callers then fall back to the session's secure-input pid, and fail
   * closed when that can't be read either.
   */
  secureInput(): boolean | null;
  /**
   * Is the current keyboard input source a keyboard layout (true), or an input method such as Japanese, Pinyin or
   * Korean (false), which would compose from the key code Ember's text events carry? null when it can't be read
   * (off the main thread, or the symbols are missing).
   */
  inputSourceIsLayout(): boolean | null;
  /** GetKeys' 16-byte KeyMap (key k is down when bit k & 7 of byte k >> 3 is set), or null when GetKeys isn't bound. */
  keyMap(): Buffer | null;
  /** The current layout, reusing `previous` when it is still the one in use; null where it can't be read. */
  keyboardLayout(previous: KeyboardLayoutSource | null): KeyboardLayoutSource | null;
}

interface Source extends KeyboardLayoutSource {
  readonly source: Ref;
}

/** HIToolbox over raw functions (koffi's in openHIToolbox(), a fake in the tests). */
export function makeHIToolbox(raw: HIRaw, cf: CF, mainThread: boolean = isMainThread): HIToolbox {
  return {
    secureInput() {
      return raw.IsSecureEventInputEnabled ? !!raw.IsSecureEventInputEnabled() : null;
    },

    inputSourceIsLayout() {
      const { TISCopyCurrentKeyboardInputSource: current, TISGetInputSourceProperty: property, kTISPropertyInputSourceType: typeKey } = raw;
      // TIS asserts it runs on the main thread (macOS 14+ abort the process otherwise).
      if (!mainThread || !current || !property || !typeKey) return null;
      return cf.own(current(), source => {
        // Get rule: the type belongs to the source, which is released after this read.
        const type = property(source, typeKey);
        if (cf.kind(type) !== "string") return null;
        return raw.kTISTypeKeyboardLayout ? cf.equal(type, raw.kTISTypeKeyboardLayout) : cf.string(type) === TIS_TYPE_KEYBOARD_LAYOUT;
      });
    },

    keyMap() {
      if (!raw.GetKeys) return null;
      const map = Buffer.alloc(KEY_MAP_BYTES);
      raw.GetKeys(map);
      return map;
    },

    keyboardLayout(previous) {
      const prev = previous as Source | null;
      const none = () => {
        prev?.release();
        return null;
      };
      const {
        TISCopyCurrentKeyboardLayoutInputSource: current, TISGetInputSourceProperty: property, LMGetKbdType: kbdType,
        UCKeyTranslate: translateKey, kTISPropertyUnicodeKeyLayoutData: layoutKey,
      } = raw;
      // The four functions together or no layout; and TIS only on the main thread.
      if (!mainThread || !current || !property || !kbdType || !translateKey || !layoutKey) return none();
      const source = current();
      if (!source) return none();
      if (prev && cf.equal(prev.source, source)) {
        cf.release(source);
        return prev;
      }
      // Get rule: the layout data belongs to the source, which this object keeps until release().
      const data = property(source, layoutKey);
      const bytes = data && cf.kind(data) === "data" ? cf.raw.CFDataGetBytePtr(data) : null;
      if (!bytes) {
        cf.release(source);
        return none();
      }
      const keyboardType = kbdType();
      let released = false;
      const next: Source = {
        source,
        translate(code, modifiers) {
          if (released) return null;
          const dead = [0], length = [0], chars = Buffer.alloc(16);
          const status = translateKey(bytes, code, UC_KEY_ACTION_DOWN, modifiers & 0xff, keyboardType, 0, dead, 8, length, chars);
          if (status !== 0) return null;
          // Dead keys stay on (options 0) so a dead key reads as "types nothing yet", never as its accent.
          if (length[0] === 0) return "";
          return chars.toString("utf16le", 0, Math.min(8, length[0]!) * 2);
        },
        release() {
          if (!released) {
            released = true;
            cf.release(source);
          }
        },
      };
      prev?.release();
      return next;
    },
  };
}

/** Why the last openHIToolbox() returned null (for the log). */
export let hiToolboxError: unknown = null;
/** The functions and constants this macOS didn't export (for the log and the CI output); empty when all bound. */
export let hiToolboxMissing: readonly string[] = [];
let boundRaw: HIRaw | null | undefined;

function bind(): HIRaw | null {
  if (boundRaw !== undefined) return boundRaw;
  try {
    const koffi = koffiModule();
    const libs: Library[] = [];
    for (const path of HITOOLBOX_PATHS) {
      try {
        libs.push(koffi.load(path));
      } catch {
        // not on this macOS: the other umbrellas are tried
      }
    }
    if (!libs.length) throw new Error("none of Carbon, HIToolbox and CoreServices could be loaded");
    const fns: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const [name, prototype] of Object.entries({ ...HITOOLBOX_PROTOTYPES, UCKeyTranslate: UC_KEY_TRANSLATE_PROTOTYPE })) {
      const fn = libs.map(lib => bindOptional(lib, prototype)).find(Boolean);
      if (fn) fns[name] = fn;
      else missing.push(name);
    }
    const constant = (name: string): Ref | null => {
      const value = libs.map(lib => globalPointer(koffi, lib, name)).find(Boolean) ?? null;
      if (!value) missing.push(name);
      return value;
    };
    boundRaw = {
      ...(fns as Partial<HIRaw>),
      kTISPropertyUnicodeKeyLayoutData: constant("kTISPropertyUnicodeKeyLayoutData"),
      kTISPropertyInputSourceType: constant("kTISPropertyInputSourceType"),
      kTISTypeKeyboardLayout: constant("kTISTypeKeyboardLayout"),
    };
    hiToolboxMissing = missing;
  } catch (err) {
    hiToolboxError = err;
    boundRaw = null;
  }
  return boundRaw;
}

/**
 * HIToolbox over `cf`; null off macOS or when none of its libraries loads (hiToolboxError says why). A function this
 * macOS lacks only makes its own answer null or empty (hiToolboxMissing names it).
 */
export function openHIToolbox(cf: CF): HIToolbox | null {
  if (!onMacOS()) return null;
  const raw = bind();
  return raw ? makeHIToolbox(raw, cf) : null;
}
