/**
 * The never-look list a fresh install starts with, per OS, and how its entries read on screen. Shared by the
 * settings defaults (main) and the settings window (renderer), so the two can't drift apart. Entries are matched
 * case-insensitively as substrings of "<app> <title>" (perception/elements.ts isNeverLook), so they are specific app
 * names (everyday words too, NEVER_LOOK_APP_ONLY, against the app and the start of a word in the title), never
 * generic words such as "passwords" or "windows security" (those are exact matches in the
 * security-window vocabulary, policy/vocabulary.ts). The Linux row is today's list. Windows and macOS (design §9.11)
 * start with the password managers people use there, as their programs and windows name them ("keepass" also covers
 * KeePassXC), and the system's own password prompt: Windows' CredentialUIBroker, macOS's SecurityAgent, and Keychain
 * Access.
 */

import type { OS } from "./shortcuts";

/** What a fresh install never looks at, stored lower case as matched. */
export const NEVER_LOOK_DEFAULTS: Readonly<Record<OS, readonly string[]>> = {
  linux: ["keepassxc", "seahorse", "passwords and keys", "1password", "bitwarden", "polkit"],
  win32: ["keepass", "1password", "bitwarden", "lastpass", "dashlane", "nordpass", "roboform", "enpass", "keeper", "credentialuibroker"],
  darwin: ["keepassxc", "1password", "bitwarden", "lastpass", "dashlane", "enpass", "strongbox", "macpass", "keychain access", "securityagent"],
};

/**
 * Entries that are everyday words ("Housekeeper wanted"): they name a password manager, so perception/elements.ts
 * isNeverLook matches them against the window's app, and its title only where a word there starts with them (Keeper's
 * web vault, "My Vault | Keeper"), as a default or typed by the user alike (cross-review S3).
 */
export const NEVER_LOOK_APP_ONLY: ReadonlySet<string> = new Set(["keeper", "seahorse", "strongbox"]);

/** How the defaults read on screen (any OS's entry; the user's own entries read as typed). */
export const NEVER_LOOK_NAMES: Readonly<Record<string, string>> = {
  keepassxc: "KeePassXC",
  seahorse: "Seahorse",
  "passwords and keys": "Passwords and Keys",
  "1password": "1Password",
  bitwarden: "Bitwarden",
  polkit: "Password prompts (polkit)",
  keepass: "KeePass",
  lastpass: "LastPass",
  dashlane: "Dashlane",
  nordpass: "NordPass",
  roboform: "RoboForm",
  enpass: "Enpass",
  keeper: "Keeper",
  credentialuibroker: "Password prompts (Windows Security)",
  strongbox: "Strongbox",
  macpass: "MacPass",
  "keychain access": "Keychain Access",
  securityagent: "Password prompts (SecurityAgent)",
};

/** An entry as the settings window shows it. */
export function neverLookLabel(item: string): string {
  return NEVER_LOOK_NAMES[item.trim().toLowerCase()] ?? item;
}

/** The defaults of `os` that are missing from `list` (case-insensitive), so the settings window can offer them back. */
export function missingDefaults(list: readonly string[], os: OS): string[] {
  const have = new Set(list.map(x => x.trim().toLowerCase()));
  return NEVER_LOOK_DEFAULTS[os].filter(d => !have.has(d));
}
