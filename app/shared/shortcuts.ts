/**
 * Ember's global shortcuts and each OS's keyboard conventions, in one table (decision D6): main registers the
 * accelerators, the policy keeps tasks from pressing them, and the settings window, bubbles and spoken hints show them,
 * all from here, so they can't drift apart. Pure data: imported by main, plain-Node modules and renderers.
 */

/** The operating systems Ember runs on. */
export type OS = "linux" | "win32" | "darwin";

/** Ember's global shortcuts by name. */
export type ShortcutId = "ask" | "stop" | "settings" | "mute" | "allow" | "deny";

/** One global shortcut, in every form Ember needs. */
export interface ShortcutDef {
  /** Electron accelerator. */
  readonly accel: string;
  /** As Ember's copy writes it ("Ctrl+Alt+Space"). */
  readonly label: string;
  /** Key caps for <kbd> chips, in order. */
  readonly keys: readonly string[];
  /** As read aloud ("Control Alt Space"). */
  readonly say: string;
  /** policy.ts canonicalKeys(accel-as-combo, KEYS[os]): what isSystemKey matches. */
  readonly chord: string;
}

/** Every global shortcut on one OS. */
export type ShortcutTable = Readonly<Record<ShortcutId, ShortcutDef>>;

const LETTERS: Record<ShortcutId, string> = { ask: "Space", stop: "X", settings: "E", mute: "M", allow: "Y", deny: "N" };
const lower = (k: string) => k.toLowerCase();

function table(f: (key: string) => ShortcutDef): ShortcutTable {
  return Object.fromEntries((Object.keys(LETTERS) as ShortcutId[]).map(id => [id, f(LETTERS[id])])) as ShortcutTable;
}

/** Linux: unchanged. Windows: Win+Alt (Ctrl+Alt is AltGr). macOS: Control+Shift+Command (⌃⌥ is VoiceOver's, ⌃⌘Space the emoji picker). */
export const SHORTCUTS: Readonly<Record<OS, ShortcutTable>> = {
  linux: table(k => ({ accel: `Control+Alt+${k}`, label: `Ctrl+Alt+${k}`, keys: ["Ctrl", "Alt", k], say: `Control Alt ${k}`, chord: `ctrl+alt+${lower(k)}` })),
  win32: table(k => ({ accel: `Super+Alt+${k}`, label: `Win+Alt+${k}`, keys: ["Win", "Alt", k], say: `Windows key, Alt, ${k}`, chord: `alt+super+${lower(k)}` })),
  darwin: table(k => ({ accel: `Control+Shift+Command+${k}`, label: `Control+Shift+Command+${k}`, keys: ["Control", "Shift", "Command", k], say: `Control Shift Command ${k}`, chord: `ctrl+shift+cmd+${lower(k)}` })),
};

/** How keys are named, parsed and labelled on an OS: the primary modifier lives here (D6). */
export interface KeyConventions {
  readonly os: OS;
  /** The policy's canonical token for the primary modifier ("mod"): "ctrl" (linux, win32) or "cmd" (darwin). */
  readonly primary: "ctrl" | "cmd";
  /** Modifier names hands/borrow.ts parseCombo accepts beyond today's, as X keysym names. */
  readonly extraModifiers: Readonly<Record<string, string>>;
  /** The canonical token for the Super_L/Super_R/Meta_* keysyms: "super" (linux, win32) or "cmd" (darwin, where they are ⌘). */
  readonly logoToken: "super" | "cmd";
  /** Spellings policy.canonicalKeys maps to the logo token before parsing (linux: today's LOGO_KEY, policy.ts:531). */
  readonly logoAliases: RegExp;
  /** Canonical modifier order (linux/win32: today's ctrl, alt, shift, super). */
  readonly modifierOrder: readonly string[];
  /** Labels of canonical modifier tokens for questions and copy (linux: today's KEY_LABELS entries). */
  readonly labels: Readonly<Record<string, string>>;
  /** Keys Ember presses itself in the worker, already canonical. linux/win32: today's exact strings (tests pin them). */
  readonly edit: { readonly selectAll: string; readonly paste: string; readonly textEnd: string; readonly sheetHome: string; readonly nameBox: string };
  /** Canonical combinations only the user may press, beyond isSystemKey's Linux rules and SHORTCUTS[os] chords. */
  readonly systemKeys: readonly string[];
}

/** Each OS's key conventions. The Linux row is today's behaviour, verbatim. */
export const KEYS: Readonly<Record<OS, KeyConventions>> = {
  linux: {
    // No new spellings on Linux or Windows: "mod+s" still fails to parse there (policy templates expand "mod" first).
    os: "linux", primary: "ctrl", extraModifiers: {}, logoToken: "super",
    logoAliases: /^\s*(win|windows|cmd|command|logo|mod4)\s*$/i, modifierOrder: ["ctrl", "alt", "shift", "super"],
    labels: { ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Super" },
    edit: { selectAll: "ctrl+a", paste: "ctrl+v", textEnd: "ctrl+End", sheetHome: "ctrl+Home", nameBox: "ctrl+shift+F5" },
    systemKeys: [],
  },
  win32: {
    os: "win32", primary: "ctrl", extraModifiers: {}, logoToken: "super",
    logoAliases: /^\s*(win|windows|cmd|command|logo|mod4)\s*$/i, modifierOrder: ["ctrl", "alt", "shift", "super"],
    labels: { ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Win" },
    edit: { selectAll: "ctrl+a", paste: "ctrl+v", textEnd: "ctrl+End", sheetHome: "ctrl+Home", nameBox: "ctrl+shift+F5" },
    // Start menu (then a typed program name), Task Manager, window switching and the window menu (super+* is already a system key).
    systemKeys: ["ctrl+escape", "ctrl+shift+escape", "alt+tab", "alt+shift+tab", "alt+escape", "alt+space"],
  },
  darwin: {
    os: "darwin", primary: "cmd",
    // Only the spellings a model is told about on a Mac ("cmd+s", "option+left"); no "mod"/"primary"/"cmdorctrl".
    extraModifiers: { cmd: "Super_L", command: "Super_L", option: "Alt_L", opt: "Alt_L" },
    logoToken: "cmd", logoAliases: /^\s*(win|windows|logo|mod4)\s*$/i, modifierOrder: ["ctrl", "alt", "shift", "cmd"],
    labels: { ctrl: "Control", alt: "Option", shift: "Shift", cmd: "Cmd" },
    // Cocoa text: ⌘↓ is the end of the document; LibreOffice for Mac: ⌘Home and ⌘⇧F5 (verify in CI).
    edit: { selectAll: "cmd+a", paste: "cmd+v", textEnd: "cmd+down", sheetHome: "cmd+home", nameBox: "shift+cmd+f5" },
    // App switcher, Spotlight, Force Quit, lock screen, log out, screenshots, Mission Control and Spaces.
    systemKeys: ["cmd+tab", "shift+cmd+tab", "cmd+space", "alt+cmd+escape", "ctrl+cmd+q", "shift+cmd+q", "alt+shift+cmd+q",
      "shift+cmd+3", "shift+cmd+4", "shift+cmd+5", "ctrl+shift+cmd+3", "ctrl+shift+cmd+4", "ctrl+up", "ctrl+down", "ctrl+left", "ctrl+right"],
  },
};
