/**
 * The macOS backend's modules on any OS: they import without loading a native library, the factories answer null
 * off macOS (saying why) without touching koffi, and every C prototype they bind parses with koffi's own parser
 * against the struct types they define (a typo there would only show on a Mac otherwise).
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { CF_PROTOTYPES, cfTypes, openCoreFoundation } from "../../app/main/platform/darwin/cf";
import { CG_OPTIONAL_PROTOTYPES, CG_PROTOTYPES, cgTypes, openCoreGraphics } from "../../app/main/platform/darwin/cg";
import { AX_GET_WINDOW_PROTOTYPE, AX_PROTOTYPES } from "../../app/main/platform/darwin/ax";
import { HITOOLBOX_PROTOTYPES, UC_KEY_TRANSLATE_PROTOTYPE } from "../../app/main/platform/darwin/hitoolbox";
import { PROC_PIDPATH_PROTOTYPE } from "../../app/main/platform/darwin/desktop";
import { functionName } from "../../app/main/platform/darwin/native";
import * as darwin from "../../app/main/platform/darwin/index";
import { darwinWindowsError } from "../../app/main/platform/darwin/windows";
import { darwinInputError } from "../../app/main/platform/darwin/input";

const requireCjs = createRequire(import.meta.url);
const koffi = requireCjs("koffi") as typeof import("koffi");
const screen = { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 1 }), getAllDisplays: () => [] };

describe.skipIf(process.platform === "darwin")("the macOS backend off macOS", () => {
  it("opens nothing and says why, without loading a library", () => {
    const load = koffi.load;
    const loaded: unknown[] = [];
    koffi.load = ((...args: unknown[]) => { loaded.push(args[0]); return load.apply(koffi, args as Parameters<typeof load>); }) as typeof load;
    try {
      expect(darwin.openDarwinWindows({ screen })).toBeNull();
      expect(darwin.openDarwinInput()).toBeNull();
      expect(openCoreFoundation()).toBeNull();
      expect(openCoreGraphics()).toBeNull();
    } finally {
      koffi.load = load;
    }
    expect(loaded).toEqual([]);
    expect(String(darwinWindowsError)).toMatch(/not macOS/);
    expect(String(darwinInputError)).toMatch(/not macOS/);
  });
});

describe("the macOS bindings' C prototypes", () => {
  it("all parse with koffi against Ember's struct types", () => {
    cfTypes(koffi);
    cgTypes(koffi);
    cgTypes(koffi); // defining the types again reuses them (koffi's names are process-wide)
    const all = [
      ...Object.values(CF_PROTOTYPES), ...Object.values(CG_PROTOTYPES), ...Object.values(CG_OPTIONAL_PROTOTYPES),
      ...Object.values(AX_PROTOTYPES), AX_GET_WINDOW_PROTOTYPE, ...Object.values(HITOOLBOX_PROTOTYPES), UC_KEY_TRANSLATE_PROTOTYPE,
      PROC_PIDPATH_PROTOTYPE,
    ];
    const tag = Math.random().toString(36).slice(2, 8);
    for (const prototype of all) {
      const name = functionName(prototype);
      // A unique name: koffi registers prototypes by name for the whole process.
      expect(() => koffi.proto(prototype.replace(`${name}(`, `EmberCheck_${tag}_${name}(`)), prototype).not.toThrow();
    }
  });

  it("key each table by the C name its prototype declares", () => {
    for (const table of [CF_PROTOTYPES, CG_PROTOTYPES, CG_OPTIONAL_PROTOTYPES, AX_PROTOTYPES, HITOOLBOX_PROTOTYPES]) {
      for (const [key, prototype] of Object.entries(table)) expect(functionName(prototype)).toBe(key);
    }
    expect(functionName(AX_GET_WINDOW_PROTOTYPE)).toBe("_AXUIElementGetWindow");
    expect(functionName(UC_KEY_TRANSLATE_PROTOTYPE)).toBe("UCKeyTranslate");
    expect(functionName(PROC_PIDPATH_PROTOTYPE)).toBe("proc_pidpath");
  });

  it("bind the permission checks and the one-call key read the design names (M3, M11)", () => {
    expect(Object.keys(CG_OPTIONAL_PROTOTYPES).sort()).toEqual([
      "CGPreflightListenEventAccess", "CGPreflightPostEventAccess", "CGPreflightScreenCaptureAccess", "CGRequestListenEventAccess",
    ]);
    expect(HITOOLBOX_PROTOTYPES.GetKeys).toBe("void GetKeys(void *keyMap)");
    expect(HITOOLBOX_PROTOTYPES.TISCopyCurrentKeyboardInputSource).toBe("void *TISCopyCurrentKeyboardInputSource(void)");
  });

  it("never declare the variadic scroll-wheel call", () => {
    expect(Object.values(CG_PROTOTYPES).some(p => p.includes("..."))).toBe(false);
    expect(CG_PROTOTYPES.CGEventCreateScrollWheelEvent2).toMatch(/int32_t wheel1, int32_t wheel2, int32_t wheel3\)$/);
  });
});
