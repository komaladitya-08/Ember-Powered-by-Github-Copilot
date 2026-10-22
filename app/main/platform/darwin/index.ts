/**
 * The macOS backend of Ember's platform layer: the window system (CGWindowList, CGEvent state, AX, capture through
 * an injected desktopCapturer function) and synthetic input (CGEvent), in points. Both factories return null off
 * macOS, and every module here imports cleanly on any OS: native libraries load only when a factory runs on macOS.
 * cf.ts, cg.ts and ax.ts are also the bindings the macOS accessibility provider builds on.
 */

export { openDarwinWindows, createDarwinWindows, darwinWindowsError } from "./windows";
export type { DarwinWindowSystem, DarwinWindowsDeps, DarwinWindowsOptions, DarwinKeysDown } from "./windows";
export { openDarwinInput, createDarwinInput, darwinInputError, ACCESSIBILITY_REASON } from "./input";
export type { DarwinInput, DarwinInputDeps, DarwinInputOptions } from "./input";
export { composePoints } from "./capture";
export type { DarwinCapture, DisplayBitmap } from "./capture";
