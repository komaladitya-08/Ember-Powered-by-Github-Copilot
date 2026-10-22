/**
 * The Carbon-era pieces the macOS input backend needs, through koffi: the keyboard layout in use (Text Input Sources
 * and UCKeyTranslate, so Ember presses the key that gives a character on this layout, not on a US one) and whether
 * secure keyboard entry is on (IsSecureEventInputEnabled). macOS 14 and later abort a process that calls the TIS
 * functions off the main thread, so the layout is only read on a process's main thread (Electron's main process
 * and a node-mode child are; a worker thread is not, and gets no layout). Binds nothing until used on macOS.
 */

import { isMainThread } from "node:worker_threads";
import { bindOptional, framework, globalPointer, koffiModule, onMacOS } from "./native";
import type { Ref } from "./native";
import type { CF } from "./cf";

export const CARBON_PATH = framework("Carbon");
export const CORE_SERVICES_PATH = framework("CoreServices");

/** UCKeyTranslate's modifier state (EventModifiers >> 8): cmdKey, shiftKey, alphaLock, optionKey, controlKey. */
export const UC_MODIFIER = { command: 1, shift: 2, alphaLock: 4, option: 8, control: 16 } as const;
const UC_KEY_ACTION_DOWN = 0;

export const HITOOLBOX_PROTOTYPES = {
  TISCopyCurrentKeyboardLayoutInputSource: "void *TISCopyCurrentKeyboardLayoutInputSource(void)",
  TISGetInputSourceProperty: "void *TISGetInputSourceProperty(void *source, void *key)",
  LMGetKbdType: "uint8_t LMGetKbdType(void)",
  IsSecureEventInputEnabled: "bool IsSecureEventInputEnabled(void)",
} as const;

export const UC_KEY_TRANSLATE_PROTOTYPE =
  "int32_t UCKeyTranslate(const void *layout, uint16_t code, uint16_t action, uint32_t modifiers, uint32_t keyboardType, uint32_t options, _Inout_ uint32_t *deadKeyState, unsigned long maxLength, _Out_ unsigned long *actualLength, void *chars)";

interface HIRaw {
  TISCopyCurrentKeyboardLayoutInputSource(): Ref | null;
  TISGetInputSourceProperty(source: Ref, key: Ref): Ref | null;
  LMGetKbdType(): number;
  IsSecureEventInputEnabled(): boolean;
  UCKeyTranslate(layout: Ref, code: number, action: number, modifiers: number, keyboardType: number, options: number, deadKeyState: number[], maxLength: number, actualLength: number[], chars: Buffer): number;
  kTISPropertyUnicodeKeyLayoutData: Ref | null;
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
  /** Is secure keyboard entry on (a password field has the keyboard, or Terminal's "Secure Keyboard Entry")? */
  secureInput(): boolean;
  /** The current layout, reusing `previous` when it is still the one in use; null where it can't be read. */
  keyboardLayout(previous: KeyboardLayoutSource | null): KeyboardLayoutSource | null;
}

/** Why the last openHIToolbox() returned null (for the log). */
export let hiToolboxError: unknown = null;
let boundRaw: HIRaw | null | undefined;

function bind(): HIRaw | null {
  if (boundRaw !== undefined) return boundRaw;
  try {
    const koffi = koffiModule();
    // HIToolbox comes through Carbon and UCKeyTranslate through CoreServices; each is looked up in both, in case a
    // macOS moves one behind the other umbrella.
    const libs = [koffi.load(CARBON_PATH), koffi.load(CORE_SERVICES_PATH)];
    const fns: Record<string, unknown> = {};
    for (const [name, prototype] of Object.entries({ ...HITOOLBOX_PROTOTYPES, UCKeyTranslate: UC_KEY_TRANSLATE_PROTOTYPE })) {
      const fn = libs.map(lib => bindOptional(lib, prototype)).find(Boolean);
      if (!fn) throw new Error(`cannot bind ${name}`);
      fns[name] = fn;
    }
    const key = libs.map(lib => globalPointer(koffi, lib, "kTISPropertyUnicodeKeyLayoutData")).find(Boolean) ?? null;
    boundRaw = { ...(fns as unknown as Omit<HIRaw, "kTISPropertyUnicodeKeyLayoutData">), kTISPropertyUnicodeKeyLayoutData: key };
  } catch (err) {
    hiToolboxError = err;
    boundRaw = null;
  }
  return boundRaw;
}

interface Source extends KeyboardLayoutSource {
  readonly source: Ref;
}

/** HIToolbox over `cf`; null off macOS or when Carbon can't be bound (hiToolboxError says why). */
export function openHIToolbox(cf: CF): HIToolbox | null {
  if (!onMacOS()) return null;
  const raw = bind();
  if (!raw) return null;
  return {
    secureInput() {
      return !!raw.IsSecureEventInputEnabled();
    },
    keyboardLayout(previous) {
      const prev = previous as Source | null;
      const none = () => {
        prev?.release();
        return null;
      };
      // TIS asserts it runs on the main thread (macOS 14+ abort the process otherwise).
      if (!isMainThread || !raw.kTISPropertyUnicodeKeyLayoutData) return none();
      const source = raw.TISCopyCurrentKeyboardLayoutInputSource();
      if (!source) return none();
      if (prev && cf.equal(prev.source, source)) {
        cf.release(source);
        return prev;
      }
      // Get rule: the layout data belongs to the source, which this object keeps until release().
      const data = raw.TISGetInputSourceProperty(source, raw.kTISPropertyUnicodeKeyLayoutData);
      const bytes = data && cf.kind(data) === "data" ? cf.raw.CFDataGetBytePtr(data) : null;
      if (!bytes) {
        cf.release(source);
        return none();
      }
      const keyboardType = raw.LMGetKbdType();
      let released = false;
      const next: Source = {
        source,
        translate(code, modifiers) {
          if (released) return null;
          const dead = [0], length = [0], chars = Buffer.alloc(16);
          const status = raw.UCKeyTranslate(bytes, code, UC_KEY_ACTION_DOWN, modifiers & 0xff, keyboardType, 0, dead, 8, length, chars);
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
