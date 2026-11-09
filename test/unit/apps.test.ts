import { afterEach, describe, expect, it } from "vitest";
import { friendlyApp, useAppNames } from "../../app/shared/apps";
import { NEVER_LOOK_DEFAULTS, neverLookLabel } from "../../app/shared/never-look";
import type { OS } from "../../app/shared/shortcuts";

describe("friendlyApp, for the apps Ember never looks at (safety-privacy-v2)", () => {
  afterEach(() => useAppNames("linux"));
  /** Where an app's own name differs from its never-look entry's label (a list names prompts as a kind). */
  const SAID_AS = { seahorse: "Passwords and Keys", polkit: "Password prompt (polkit)", credentialuibroker: "Windows Security", securityagent: "Password prompt (SecurityAgent)" } as Record<string, string>;

  it("names each password manager and password prompt on every OS's never-look list as people say it", () => {
    for (const os of ["linux", "win32", "darwin"] as OS[]) {
      useAppNames(os);
      for (const entry of NEVER_LOOK_DEFAULTS[os]) expect(friendlyApp(entry), `${os}: ${entry}`).toBe(SAID_AS[entry] ?? neverLookLabel(entry));
    }
    useAppNames("linux");
    expect(friendlyApp("org.keepassxc.KeePassXC")).toBe("KeePassXC");
    expect(friendlyApp("org.gnome.seahorse.Application")).toBe("Passwords and Keys");
    expect(friendlyApp("KeePassXC")).toBe("KeePassXC");
  });
});

describe("friendlyApp", () => {
  it("keeps the familiar names people already know", () => {
    expect(friendlyApp("gnome-control-center")).toBe("Settings");
    expect(friendlyApp("org.gnome.Nautilus")).toBe("Files");
    expect(friendlyApp("org.example.Notes")).toBe("Notes");
    expect(friendlyApp("mousepad")).toBe("Mousepad");
    expect(friendlyApp("Mousepad")).toBe("Mousepad");
    expect(friendlyApp("LibreOffice Writer")).toBe("LibreOffice");
    expect(friendlyApp("libreoffice-writer")).toBe("LibreOffice");
  });

  it("strips a desktop file name before looking the program up", () => {
    expect(friendlyApp("firefox.desktop")).toBe("Firefox");
    expect(friendlyApp("org.gnome.Nautilus.desktop")).toBe("Files");
    expect(friendlyApp("Firefox.DESKTOP")).toBe("Firefox");
  });

  it("takes the last part of a desktop id, however many it has", () => {
    expect(friendlyApp("org.mozilla.firefox")).toBe("Firefox");
    expect(friendlyApp("org.mozilla.Thunderbird")).toBe("Thunderbird");
    expect(friendlyApp("com.github.johnfactotum.Foliate")).toBe("Foliate");
    expect(friendlyApp("io.github.some.App")).toBe("App");
  });

  it("returns nothing for empty or whitespace-only input", () => {
    expect(friendlyApp("")).toBe("");
    expect(friendlyApp("   ")).toBe("");
    expect(friendlyApp("\t\n")).toBe("");
  });

  it("leaves names it doesn't know alone", () => {
    expect(friendlyApp("My App")).toBe("My App");
  });
});
