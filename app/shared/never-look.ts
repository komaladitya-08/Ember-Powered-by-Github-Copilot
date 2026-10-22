/**
 * The never-look list a fresh install starts with, per OS, and how its entries read on screen. Shared by the
 * settings defaults (main) and the settings window (renderer), so the two can't drift apart. Entries are matched
 * case-insensitively as substrings of "<app> <title>" (perception/elements.ts isNeverLook), so they are specific app
 * names, never generic words such as "passwords" (those are exact matches in the security-window vocabulary).
 * The Linux row is today's list; the Windows and macOS rows are filled by their own package (design §9.11).
 */

import type { OS } from "./shortcuts";

/** What a fresh install never looks at, stored lower case as matched. */
export const NEVER_LOOK_DEFAULTS: Readonly<Record<OS, readonly string[]>> = {
  linux: ["keepassxc", "seahorse", "passwords and keys", "1password", "bitwarden", "polkit"],
  win32: [],
  darwin: [],
};

/** How the defaults read on screen (any OS's entry; the user's own entries read as typed). */
export const NEVER_LOOK_NAMES: Readonly<Record<string, string>> = {
  keepassxc: "KeePassXC",
  seahorse: "Seahorse",
  "passwords and keys": "Passwords and Keys",
  "1password": "1Password",
  bitwarden: "Bitwarden",
  polkit: "Password prompts (polkit)",
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
