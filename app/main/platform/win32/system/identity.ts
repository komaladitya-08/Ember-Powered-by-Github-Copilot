/**
 * Ember's identity on Windows: the AppUserModelId main sets before ready. Toasts need it on the Start Menu shortcut,
 * and Electron names the login item's Run value after it. A module of its own so the login item (autostart.ts) and the
 * life cycle share one value without pulling in each other's dependencies.
 */

/** Ember's AppUserModelId: the bundle identifier macOS uses too. */
export const AUMID = "io.github.komaladitya08.ember";
