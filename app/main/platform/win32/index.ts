/**
 * The Windows backends: the window system (windows, pointer, capture) and synthetic input, through koffi and the
 * system DLLs. Both factories return null off Windows, so this module imports cleanly on every OS; nothing native is
 * loaded until one of them runs on Windows.
 */

export { openWin32Windows, type Win32WindowSystem, type Win32WindowsDeps } from "./windows";
export { openWin32Input, type Win32InputDeps } from "./input";
export { win32Error, type Win32Api } from "./ffi";
