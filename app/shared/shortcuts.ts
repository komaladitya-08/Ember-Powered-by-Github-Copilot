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

/**
 * The fallback chord of each shortcut (owner decision D-45b): Ember registers it when another app already holds the
 * default, and names it wherever it would name the default. It is the default with one more modifier, so it is the same
 * key with the same hand: Shift on Linux and Windows, Option on macOS (written between Control and Shift, as the Mac
 * writes it). Nothing on these systems uses them: GNOME's Shift+Ctrl+Alt chords are R and the arrows, Windows has no
 * Win+Alt+Shift chord (PowerToys' Command Palette and Xbox Game Bar take Win+Alt+Space and Win+Alt+M, defaults these
 * stand in for), and macOS's only Control+Option+Shift+Command one is Period. Each is a key only the user presses with
 * no change to the policy: Ctrl+Alt with these keys on Linux, the Win key on Windows, Control+Shift+Command on macOS.
 */
export const FALLBACK_SHORTCUTS: Readonly<Record<OS, ShortcutTable>> = {
  linux: table(k => ({ accel: `Control+Alt+Shift+${k}`, label: `Ctrl+Alt+Shift+${k}`, keys: ["Ctrl", "Alt", "Shift", k], say: `Control Alt Shift ${k}`, chord: `ctrl+alt+shift+${lower(k)}` })),
  win32: table(k => ({ accel: `Super+Alt+Shift+${k}`, label: `Win+Alt+Shift+${k}`, keys: ["Win", "Alt", "Shift", k], say: `Windows key, Alt, Shift, ${k}`, chord: `alt+shift+super+${lower(k)}` })),
  darwin: table(k => ({
    accel: `Control+Alt+Shift+Command+${k}`, label: `Control+Option+Shift+Command+${k}`, keys: ["Control", "Option", "Shift", "Command", k],
    say: `Control Option Shift Command ${k}`, chord: `ctrl+alt+shift+cmd+${lower(k)}`,
  })),
};

/** What each shortcut does, as a sentence names it ("so Ask Ember is Ctrl+Alt+Shift+Space"): the handle menu's words. */
export const SHORTCUT_NAMES: Readonly<Record<ShortcutId, string>> = {
  ask: "Ask Ember", stop: "Stop everything", settings: "Settings", mute: "Mute microphone", allow: "Allow", deny: "Not now",
};

/** The shortcuts Ember holds while it runs (Allow and Not now are held only while a question is up). */
export const ALWAYS_HELD: readonly ShortcutId[] = ["ask", "stop", "settings", "mute"];

/** The chord Ember holds for each shortcut: its default, its fallback (another app holds the default), or null (both). */
export type HeldShortcuts = Readonly<Record<ShortcutId, ShortcutDef | null>>;

/**
 * Which chord Ember holds for each shortcut, from the accelerators another app holds (`taken`). Ember tries a default's
 * fallback as soon as the default is refused, so a default alone in `taken` means its fallback is Ember's.
 */
export function heldShortcuts(sc: ShortcutTable, fallback: ShortcutTable, taken: readonly string[]): HeldShortcuts {
  const held = (id: ShortcutId) => (!taken.includes(sc[id].accel) ? sc[id] : !taken.includes(fallback[id].accel) ? fallback[id] : null);
  return Object.fromEntries((Object.keys(sc) as ShortcutId[]).map(id => [id, held(id)])) as HeldShortcuts;
}

/** A shortcut as the settings window shows it (StatusPlatform.shortcuts). */
export interface ShownShortcut {
  /** As the copy writes the chord Ember holds ("Ctrl+Alt+Space", or its fallback); "" while it holds neither. */
  readonly label: string;
  /** Key caps of the chord Ember holds (the default's while it holds neither: the sentence around them is hidden then). */
  readonly keys: readonly string[];
  /** Another app holds the default and its fallback: the window says how to do it without the key. */
  readonly taken?: true;
}

/** Each shortcut as the settings window shows it: the chord Ember holds, or taken (D-45b). */
export function shownShortcuts(sc: ShortcutTable, held: HeldShortcuts): Record<ShortcutId, ShownShortcut> {
  return Object.fromEntries((Object.keys(sc) as ShortcutId[]).map(id => {
    const now = held[id];
    return [id, now ? { label: now.label, keys: now.keys } : { label: "", keys: sc[id].keys, taken: true }];
  })) as Record<ShortcutId, ShownShortcut>;
}

/** Where the user opens Ember again on each OS: a second start brings up its settings, which have Ask Ember…. */
export const OPEN_AGAIN: Readonly<Record<OS, string>> = { linux: "from your apps", win32: "from the Start menu", darwin: "from Applications" };

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
    // "Command", as the shortcut table and macOS itself name the key (never "Cmd" in one place and "Command" in another).
    labels: { ctrl: "Control", alt: "Option", shift: "Shift", cmd: "Command" },
    // Cocoa text: ⌘↓ is the end of the document; LibreOffice for Mac: ⌘Home and ⌘⇧F5 (verify in CI).
    edit: { selectAll: "cmd+a", paste: "cmd+v", textEnd: "cmd+down", sheetHome: "cmd+home", nameBox: "shift+cmd+f5" },
    // App switcher, Spotlight, Force Quit, lock screen, log out, screenshots, Mission Control and Spaces.
    systemKeys: ["cmd+tab", "shift+cmd+tab", "cmd+space", "alt+cmd+escape", "ctrl+cmd+q", "shift+cmd+q", "alt+shift+cmd+q",
      "shift+cmd+3", "shift+cmd+4", "shift+cmd+5", "ctrl+shift+cmd+3", "ctrl+shift+cmd+4", "ctrl+up", "ctrl+down", "ctrl+left", "ctrl+right"],
  },
};
