/**
 * First run and the setup check (release review, package "onboard"): what the settings window shows before Start,
 * which setup rows need the user, and what Ember says once it starts. Pure functions are called directly; the page's
 * own markup, style sheet and script are read as text where the behaviour is theirs (there is no DOM in these tests).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { homePatches, type HomePatch } from "../../app/renderer/home/copy";
import * as computersCopy from "../../app/renderer/home/computers-copy";
import type { StatusPlatform } from "../../app/shared/ipc";
import { SHORTCUTS, type OS } from "../../app/shared/shortcuts";
import { PLATFORM_WORDS } from "../../app/shared/words";

const read = (f: string) => readFileSync(new URL(`../../app/${f}`, import.meta.url), "utf8");
const PAGE = read("renderer/home/index.html");
const STYLES = read("renderer/home/styles.css");
const SCRIPT = read("renderer/home/main.ts");

/** A status's OS words as main builds them (only what these tests need differs by OS). */
const platformOf = (os: OS): StatusPlatform => ({
  os, shortcuts: Object.fromEntries(Object.entries(SHORTCUTS[os]).map(([id, d]) => [id, { label: d.label, keys: d.keys }])) as StatusPlatform["shortcuts"],
  dataDir: "~/.config/ember", settingsFile: "~/.config/ember/settings.json", auditCopy: null, micIndicator: PLATFORM_WORDS[os].micIndicator,
  permissionsNote: PLATFORM_WORDS[os].permissionsNote, speakerRejection: os === "linux", fixLabels: {}, desk: os === "linux", autostartNote: null,
});
/** The text a patch puts in `selector` (its segments' words), or undefined when no patch writes it. */
const patchedText = (patches: HomePatch[], selector: string): string | undefined => {
  const p = patches.find(x => x.selector === selector && x.content);
  return p?.content?.map(s => (typeof s === "string" ? s : "kbd" in s ? s.kbd : s.code)).join("");
};

describe("the settings window's first paint", () => {
  it("shows nothing of the page until the first status says which layout it has, for at most 1.5 s (review #249)", () => {
    // The window is shown at ready-to-show, before the status (it waits up to 3 s for other computers' rows) arrives.
    expect(PAGE).toMatch(/<body class="loading">/);
    expect(STYLES).toMatch(/body\.loading \.home \{ visibility: hidden; \}/);
    // The first settings applied lift the gate, and so does the cap.
    expect(SCRIPT).toMatch(/function applySettings\(s: Settings\): void \{[\s\S]*?document\.body\.classList\.remove\("loading"\);[\s\S]*?\n\}/);
    expect(SCRIPT).toContain("setTimeout(() => document.body.classList.remove(\"loading\"), 1500);");
  });
});

describe("the microphone consent", () => {
  it("is read with the button that agrees to it, so a screen reader user hears what they agree to (review #153)", () => {
    // Turning on "Hey Ember" moves focus straight to the button: its description is the whole note.
    const panel = /<div id="consent" ([^>]*)>\s*<p id="consent-text">/.exec(PAGE);
    expect(panel, "the note is the panel's first paragraph, with an id").not.toBeNull();
    expect(panel![1]).toContain("role=\"group\"");
    expect(panel![1]).toContain("aria-describedby=\"consent-text\"");
    expect(panel![1]).toMatch(/aria-label="[^"]+"/);
    expect(PAGE).toMatch(/<button type="button" id="consent-yes" class="btn" aria-describedby="consent-text">I agree, start listening<\/button>/);
    expect(SCRIPT).toContain("$(\"consent-yes\").focus()");
  });
});

describe("WSL in the onboarding line and the Computers intro", () => {
  it("is named only on Windows, the one OS that has it (review #221)", () => {
    // The page's own markup is Linux's: no WSL. Linux's and macOS's statuses keep it so; Windows' adds WSL.
    const intro = /<p class="intro" id="computers-intro">([^<]*)<\/p>/.exec(PAGE)?.[1];
    const note = /<li data-icon="plug"><b>Other computers and commands<\/b><span id="targets-note">([^<]*)<\/span><\/li>/.exec(PAGE)?.[1];
    expect(intro).toBe("Ember can work on this computer and on computers you reach over SSH. Your voice and your GitHub sign-in always stay here.");
    expect(note).toBe(" are off until you turn them on: Ember can work on computers you reach over SSH, and run commands in its own window. Each asks you first.");
    for (const os of ["linux", "darwin"] as const) {
      const patches = homePatches(platformOf(os));
      expect(patchedText(patches, "#computers-intro"), os).toBe(intro);
      expect(patchedText(patches, "#targets-note"), os).toBe(note);
    }
    const win = homePatches(platformOf("win32"));
    expect(patchedText(win, "#computers-intro")).toBe("Ember can work on this computer, in WSL, and on computers you reach over SSH. Your voice and your GitHub sign-in always stay here.");
    expect(patchedText(win, "#targets-note")).toBe(" are off until you turn them on: Ember can work in WSL, on computers you reach over SSH, and run commands in its own window. Each asks you first.");
  });

  it("leaves WSL out of what an organisation turned off, except on Windows (review #221)", () => {
    expect(computersCopy.targetFeatureApplies("wsl", "linux")).toBe(false);
    expect(computersCopy.targetFeatureApplies("wsl", "darwin")).toBe(false);
    expect(computersCopy.targetFeatureApplies("wsl", "win32")).toBe(true);
    expect(computersCopy.targetFeatureApplies("wsl")).toBe(false);
    for (const os of ["linux", "darwin", "win32"] as const) expect(computersCopy.targetFeatureApplies("ssh", os)).toBe(true);
    expect(computersCopy.targetFeatureApplies("voice", "darwin")).toBe(true);
    expect(SCRIPT).toMatch(/\.filter\(\(\[k, v\]\) => v === false && targetFeatureApplies\(k, platform\?\.os\)\)/);
  });
});
