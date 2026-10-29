/**
 * App names with characters that show nothing (cross-review X15): macOS reports a window's app by its name in the
 * user's language, and Apple writes some of those with a soft hyphen (German System Settings is "System" + U+00AD +
 * "einstellungen", as its bundle has it). The policy's Settings-app and security-app checks and the never-look list
 * match such a name as the one without it, whichever side holds the invisible character.
 */

import { describe, expect, it } from "vitest";
import { KEYS } from "../../app/shared/shortcuts";
import { PolicyEngine, appNameOf, isSecurityWindow, type ActionRequest } from "../../app/main/policy/policy";
import { isNeverLook } from "../../app/main/perception/elements";

const SHY = "­";
const GERMAN_SETTINGS = `System${SHY}einstellungen`;

const engine = (grants: Record<string, "act">, neverLook: string[] = []) =>
  new PolicyEngine({ neverLook: () => neverLook, grants: () => grants, os: "darwin", keys: KEYS.darwin, ownPid: 1, rateLimit: 1e6 });
const toggle = (app: string, window: string, name: string): ActionRequest => ({
  taskId: "t", kind: "toggle", app, window, windowId: { pid: 9, role: "frame" }, element: { role: "switch", name }, value: "on",
});

describe("an app's name for the vocabulary's lists", () => {
  it("is trimmed and loses format characters, soft hyphens and zero-width characters, and nothing else", () => {
    expect(appNameOf(` ${GERMAN_SETTINGS} `)).toBe("Systemeinstellungen");
    expect(appNameOf("Pass​wörter")).toBe("Passwörter");
    expect(appNameOf("System Settings")).toBe("System Settings");
  });
});

describe("German System Settings, named with its soft hyphen", () => {
  it("asks about every setting changed there, even with an Always grant saved under that name", () => {
    // The grant as the worker saves it: the window's app in lower case, soft hyphen and all.
    const e = engine({ [GERMAN_SETTINGS.toLowerCase()]: "act", systemeinstellungen: "act" });
    for (const [pane, name] of [["Kamera", "Terminal"], ["Anmeldeobjekte", "Terminal"], ["Bedienungshilfen", "Terminal"]]) {
      expect(e.decide(toggle(GERMAN_SETTINGS, pane, name)), pane).toMatchObject({ verdict: "confirm", risky: true });
    }
    // As without it.
    expect(e.decide(toggle("Systemeinstellungen", "Kamera", "Terminal"))).toMatchObject({ verdict: "confirm", risky: true });
  });

  it("is an authentication or security window where its name is one, with or without invisible characters", () => {
    for (const app of [`Schlüssel${SHY}bund${SHY}verwaltung`, "Schlüsselbund​verwaltung", `Pass${SHY}wörter`]) {
      expect(isSecurityWindow({ app, title: "" }, "darwin"), app).toBe(true);
      expect(engine({}).decide({ taskId: "t", kind: "read", app, window: "Anmeldung" }).verdict, app).toBe("deny");
    }
    expect(isSecurityWindow({ app: "Text­Edit", title: "" }, "darwin")).toBe(false);
  });
});

describe("the never-look list", () => {
  it("keeps Ember out of an app whose name holds a soft hyphen, whichever side holds it", () => {
    expect(isNeverLook({ app: GERMAN_SETTINGS, name: "Kamera" }, ["Systemeinstellungen"])).toBe(true);
    expect(isNeverLook({ app: "Systemeinstellungen", name: "Kamera" }, [GERMAN_SETTINGS])).toBe(true);
    // An entry that is an everyday word is still matched against the app, and the title only where a word starts with it.
    expect(isNeverLook({ app: "Notes", name: `Babysea${SHY}horse notes` }, ["seahorse"])).toBe(false);
    expect(isNeverLook({ app: "Notes", name: `Sea${SHY}horse notes` }, ["seahorse"])).toBe(true);
    expect(isNeverLook({ app: `sea${SHY}horse`, name: "Passwords" }, ["seahorse"])).toBe(true);
    expect(engine({}, ["Systemeinstellungen"]).decide({ taskId: "t", kind: "read", app: GERMAN_SETTINGS, window: "Kamera" })).toMatchObject({ verdict: "deny" });
  });

  it("matches a name macOS gives decomposed (a letter and its accent apart) as the one typed composed", () => {
    expect(isNeverLook({ app: "Schlüsselbundverwaltung", name: "" }, ["Schlüsselbundverwaltung"])).toBe(true);
    expect(isNeverLook({ app: "Schlüsselbundverwaltung", name: "" }, ["Schlüsselbundverwaltung"])).toBe(true);
  });

  it("matches as before otherwise", () => {
    expect(isNeverLook({ app: "KeePassXC", name: "Passwords.kdbx" }, ["keepassxc"])).toBe(true);
    expect(isNeverLook({ app: "gedit", name: "notes" }, ["keepassxc", " "])).toBe(false);
  });
});
