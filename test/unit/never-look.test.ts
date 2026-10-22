/** The never-look defaults and their names, shared by the settings defaults and the settings window (design §4.18, §9.11). */

import { describe, expect, it } from "vitest";
import { NEVER_LOOK_DEFAULTS, NEVER_LOOK_NAMES, missingDefaults, neverLookLabel } from "../../app/shared/never-look";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import { HOST_OS } from "../../app/main/platform/os";

describe("never-look defaults", () => {
  it("keep today's Linux list, in today's order", () => {
    expect(NEVER_LOOK_DEFAULTS.linux).toEqual(["keepassxc", "seahorse", "passwords and keys", "1password", "bitwarden", "polkit"]);
  });

  it("start Windows and macOS with their own password managers and the system's password prompt (design §9.11)", () => {
    expect(NEVER_LOOK_DEFAULTS.win32).toEqual(["keepass", "1password", "bitwarden", "lastpass", "dashlane", "nordpass", "roboform", "enpass", "keeper", "credentialuibroker"]);
    expect(NEVER_LOOK_DEFAULTS.darwin).toEqual(["keepassxc", "1password", "bitwarden", "lastpass", "dashlane", "enpass", "strongbox", "macpass", "keychain access", "securityagent"]);
  });

  it("are what a fresh install on this OS starts with", () => {
    expect(DEFAULT_SETTINGS.privacy.neverLook).toEqual([...NEVER_LOOK_DEFAULTS[HOST_OS]]);
  });

  it("are stored lower case and read as specific names, never a generic word that would hide ordinary documents", () => {
    for (const os of ["linux", "win32", "darwin"] as const) {
      for (const d of NEVER_LOOK_DEFAULTS[os]) {
        expect(d, d).toBe(d.trim().toLowerCase());
        expect(["password", "passwords", "windows security", "security"]).not.toContain(d);
      }
    }
  });
});

describe("never-look names", () => {
  it("read each default as the settings window always has", () => {
    expect(NEVER_LOOK_DEFAULTS.linux.map(neverLookLabel)).toEqual(["KeePassXC", "Seahorse", "Passwords and Keys", "1Password", "Bitwarden", "Password prompts (polkit)"]);
    expect(neverLookLabel(" KeePassXC ")).toBe("KeePassXC");
    expect(neverLookLabel("Thunderbird")).toBe("Thunderbird");
  });

  it("name every default of every OS", () => {
    for (const os of ["linux", "win32", "darwin"] as const) for (const d of NEVER_LOOK_DEFAULTS[os]) expect(NEVER_LOOK_NAMES[d], `${os} ${d}`).toBeTruthy();
  });
});

describe("missingDefaults", () => {
  it("offers back the OS's defaults the user removed (case-insensitive), as the settings window did", () => {
    expect(missingDefaults(["KeePassXC", "Signal"], "linux")).toEqual(["seahorse", "passwords and keys", "1password", "bitwarden", "polkit"]);
    expect(missingDefaults(NEVER_LOOK_DEFAULTS.linux, "linux")).toEqual([]);
    expect(missingDefaults([" Polkit "], "linux")).not.toContain("polkit");
  });

  it("offers only that OS's defaults", () => {
    expect(missingDefaults([], "win32")).toEqual([...NEVER_LOOK_DEFAULTS.win32]);
    expect(missingDefaults([], "darwin")).toEqual([...NEVER_LOOK_DEFAULTS.darwin]);
  });
});
