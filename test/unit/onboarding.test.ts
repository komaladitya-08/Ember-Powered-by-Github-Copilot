/**
 * First run and the setup check (release review, package "onboard"): what the settings window shows before Start,
 * which setup rows need the user, and what Ember says once it starts. Pure functions are called directly; the page's
 * own markup, style sheet and script are read as text where the behaviour is theirs (there is no DOM in these tests).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { checksNote, homePatches, setupBadge, setupView, tagline, type HomePatch } from "../../app/renderer/home/copy";
import { holdsBack, needsUser, setupHello, whereAfterStart, type SetupRow } from "../../app/shared/setup-attention";
import * as computersCopy from "../../app/renderer/home/computers-copy";
import type { StatusPlatform } from "../../app/shared/ipc";
import { SHORTCUTS, type OS } from "../../app/shared/shortcuts";
import { PLATFORM_WORDS } from "../../app/shared/words";
import { afterFix, inspectEnvironment, type EnvInputs } from "../../app/main/environment";
import { doctorChecks } from "../../app/main/doctor";
import { AdminPolicySchema } from "../../app/main/admin";

const read = (f: string) => readFileSync(new URL(`../../app/${f}`, import.meta.url), "utf8");
const PAGE = read("renderer/home/index.html");
const STYLES = read("renderer/home/styles.css");
const SCRIPT = read("renderer/home/main.ts");
const MAIN = read("main/main.ts");

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

describe("the first-run window", () => {
  /** The page's markup with comments and white space between tags taken out, so the order of its parts is plain. */
  const flat = PAGE.replace(/>\s+</g, "><");

  it("keeps agreeing and Start in view at the window's foot, after everything first run shows (review #104, #160)", () => {
    // The start row is the page's last part, after the setup check (whose rows can show before Start), not inside the
    // character picker, so it can stay at the window's foot while the terms scroll.
    const start = flat.indexOf("<div class=\"start-row\" id=\"start-row\" hidden>");
    expect(start).toBeGreaterThan(flat.indexOf("<details class=\"fold\" id=\"checks-fold\""));
    expect(start).toBeGreaterThan(flat.indexOf("<details class=\"fold\" id=\"about-fold\""));
    expect(flat.slice(start)).toMatch(/^<div class="start-row" id="start-row" hidden>.*?<\/div><\/main>/);
    const pick = flat.slice(flat.indexOf("<section class=\"pick\""), flat.indexOf("</section>", flat.indexOf("<section class=\"pick\"")));
    expect(pick).not.toContain("start-row");
    // In first run it sticks to the window's foot, and focus scrolls clear of it (WCAG 2.4.11).
    expect(STYLES).toMatch(/body\.first-run \.start-row \{[^}]*position: sticky; bottom: \d+px;/);
    expect(STYLES).toMatch(/html:has\(> body\.first-run\) \{ scroll-padding-bottom: \d+px; \}/);
  });

  it("doesn't point to sections that aren't shown before Start (review #104)", () => {
    const welcome = flat.slice(flat.indexOf("<section id=\"welcome\""), flat.indexOf("</section>", flat.indexOf("<section id=\"welcome\"")));
    expect(welcome).not.toMatch(/\bbelow\b/);
    expect(welcome).not.toMatch(/your never-look list/);
    expect(welcome).toContain("Password managers, password prompts and any app you add to the never-look list in settings are never read.");
    expect(welcome).toContain("<b>The microphone stays off</b> unless you turn on “Hey Ember” in settings.");
  });
});

// ───── Setup rows as each OS reports them (environment.ts) ─────
const MAC_FIRST: SetupRow[] = [
  { id: "platform", label: "Platform", status: "ok" },
  { id: "os", label: "Operating system", status: "ok" },
  { id: "accessibility", label: "Reading and using apps", status: "fail", fix: "open-accessibility-settings" },
  { id: "screen-recording", label: "Screen Recording", status: "warn", fix: "open-screen-recording-settings" },
  { id: "input-monitoring", label: "Input Monitoring", status: "warn", fix: "open-input-monitoring-settings" },
  { id: "location", label: "Applications folder", status: "ok" },
];
const allowed = (rows: SetupRow[], ...ids: string[]): SetupRow[] => rows.map(r => (ids.includes(r.id) ? { id: r.id, label: r.label, status: "ok" } : r));
const LINUX_A11Y_OFF: SetupRow[] = [
  { id: "platform", label: "Platform", status: "ok" },
  { id: "os", label: "Operating system", status: "ok" },
  { id: "session", label: "Desktop session", status: "ok" },
  { id: "accessibility", label: "Screen reading", status: "warn", fix: "enable-accessibility" },
];

describe("which setup rows need the user", () => {
  it("counts a fail, a warning about reading, seeing or using apps, and any row with a fix button (review #94, #161)", () => {
    expect(MAC_FIRST.filter(needsUser).map(r => r.id)).toEqual(["accessibility", "screen-recording", "input-monitoring"]);
    expect(LINUX_A11Y_OFF.filter(needsUser).map(r => r.id)).toEqual(["accessibility"]);
    // Linux without the Python bindings: no button, but Ember can't read apps.
    expect(needsUser({ id: "accessibility", label: "Screen reading", status: "warn" })).toBe(true);
    // Windows' helper blocked (a button), or restricted by the organisation (none): both hold Ember back.
    expect(holdsBack({ id: "accessibility", label: "Screen reading", status: "warn", fix: "unblock-helper" })).toBe(true);
    expect(holdsBack({ id: "accessibility", label: "Screen reading", status: "warn" })).toBe(true);
    // A button the user can press: worth a look, though Ember works without it.
    expect(needsUser({ id: "location", label: "Applications folder", status: "warn", fix: "move-to-applications" })).toBe(true);
    expect(holdsBack({ id: "location", label: "Applications folder", status: "warn", fix: "move-to-applications" })).toBe(false);
    expect(needsUser({ id: "wsl:Ubuntu", label: "Accessibility in Ubuntu", status: "warn", fix: "wsl-a11y:Ubuntu" })).toBe(true);
    // A warning with nothing to do and nothing held back (another Linux, shortcuts taken) doesn't.
    expect(needsUser({ id: "os", label: "Operating system", status: "warn" })).toBe(false);
    expect(needsUser({ id: "shortcuts", label: "Keyboard shortcuts", status: "warn" })).toBe(false);
    expect(needsUser({ id: "accessibility", label: "Screen reading", status: "ok", fix: "enable-accessibility" })).toBe(false);
  });
});

describe("the setup check in the settings window", () => {
  const first = { opened: false, beforeStart: false };

  it("stays on the first-run screen until Start once a row needed the user, so fixing one row never hides the others (review #94)", () => {
    const v1 = setupView(MAC_FIRST, first);
    expect(v1).toMatchObject({ failing: 1, needing: 3, open: true, beforeStart: true, note: "1 thing to fix" });
    // Accessibility allowed: Screen Recording and Input Monitoring keep their buttons on screen.
    const v2 = setupView(allowed(MAC_FIRST, "accessibility"), { opened: true, beforeStart: v1.beforeStart });
    expect(v2).toMatchObject({ failing: 0, needing: 2, open: false, beforeStart: true, note: "2 things to look at" });
    // Everything allowed: the list (all OK) stays where the user was working until Start.
    expect(setupView(allowed(MAC_FIRST, "accessibility", "screen-recording", "input-monitoring"), { opened: true, beforeStart: v2.beforeStart }))
      .toMatchObject({ needing: 0, beforeStart: true, note: "All good" });
  });

  it("opens and shows before Start for a warning with a fix, such as Linux's accessibility switch (review #161)", () => {
    expect(setupView(LINUX_A11Y_OFF, first)).toMatchObject({ failing: 0, needing: 1, open: true, beforeStart: true, note: "1 thing to look at" });
    // A warning with nothing to do keeps the fold shut and the first-run screen as it was.
    const other = LINUX_A11Y_OFF.map(r => (r.id === "accessibility" ? { id: r.id, label: r.label, status: "ok" as const } : r.id === "os" ? { ...r, status: "warn" as const } : r));
    expect(setupView(other, first)).toMatchObject({ needing: 0, open: false, beforeStart: false, note: "1 thing to look at" });
    // Opened by itself once: a user who closes it isn't overruled by the next status.
    expect(setupView(LINUX_A11Y_OFF, { opened: true, beforeStart: true }).open).toBe(false);
  });

  it("counts the rows in words by the heading (review #160)", () => {
    expect(checksNote(1, 0)).toBe("1 thing to fix");
    expect(checksNote(2, 3)).toBe("2 things to fix");
    expect(checksNote(0, 1)).toBe("1 thing to look at");
    expect(checksNote(0, 2)).toBe("2 things to look at");
    expect(checksNote(0, 0)).toBe("All good");
  });

  it("is drawn from setupView, the one place that decides it", () => {
    expect(SCRIPT).toMatch(/const view = setupView\(environment\.checks, \{ opened: checksOpened, beforeStart: checksBeforeStart \}\);/);
    expect(SCRIPT).toMatch(/\.classList\.toggle\("after-setup", !checksBeforeStart\)/);
  });
});

describe("the line under the title in first run", () => {
  const base = { failing: 0, onboarded: true, phase: "ready", hidden: false, overlay: true };

  it("keeps the first-run instruction while setup rows fail; the count is by the setup check (review #160)", () => {
    const firstRun = "Read how Ember works, pick who keeps you company, then agree and press Start.";
    expect(tagline({ ...base, onboarded: false, failing: 1 })).toBe(firstRun);
    expect(tagline({ ...base, onboarded: false, failing: 3, phase: "signed-out" })).toBe(firstRun);
  });

  it("counts what fails once Ember has started, and says computer (review #160)", () => {
    expect(tagline({ ...base, failing: 1 })).toBe("Ember needs one thing fixed before it can work on this computer: see the setup check.");
    expect(tagline({ ...base, failing: 2 })).toBe("Ember needs 2 things fixed before it can work on this computer: see the setup check.");
  });
});

describe("pressing Start while something holds Ember back", () => {
  it("keeps settings open at the setup check instead of closing it and greeting as if ready (review #95)", () => {
    expect(whereAfterStart("ready", MAC_FIRST)).toBe("checks");
    expect(whereAfterStart("ready", LINUX_A11Y_OFF)).toBe("checks");
    expect(whereAfterStart("ready", [{ id: "session", label: "Desktop session", status: "fail" }])).toBe("checks");
    // Copilot isn't connected: its sign-in comes first, as before.
    expect(whereAfterStart("signed-out", MAC_FIRST)).toBe("copilot");
    expect(whereAfterStart("error", [])).toBe("copilot");
    // Nothing holds Ember back (a fix button for a nicety doesn't count): the window closes and Ember says hello.
    expect(whereAfterStart("ready", allowed(MAC_FIRST, "accessibility", "screen-recording", "input-monitoring"))).toBeNull();
    expect(whereAfterStart("ready", [{ id: "location", label: "Applications folder", status: "warn", fix: "move-to-applications" }])).toBeNull();
    expect(whereAfterStart(undefined, [])).toBeNull();
    // main.ts decides with it, and sends the window to that section.
    expect(MAIN).toMatch(/const where = whereAfterStart\(phase, setupRows\(\)\);\s*if \(where\) \{[^}]*sendToHome\(IPC\.focusSection, where\);/);
  });

  it("has Ember's hello name what isn't set up, and settings open at the setup check (review #95)", () => {
    expect(setupHello(MAC_FIRST, false)).toBe("Still to set up: “Reading and using apps”, “Screen Recording” and “Input Monitoring”. The setup check in settings shows how.");
    expect(setupHello(LINUX_A11Y_OFF, true)).toBe("Still to set up: “Screen reading”. The setup check in this window shows how.");
    const four = [...MAC_FIRST, { id: "session", label: "Desktop session", status: "fail" as const }];
    expect(setupHello(four, false)).toBe("Still to set up: “Reading and using apps”, “Screen Recording” and 2 more. The setup check in settings shows how.");
    expect(setupHello(allowed(MAC_FIRST, "accessibility", "screen-recording", "input-monitoring"), false)).toBeNull();
    // The hello says it, offers Open settings while settings is closed, and Open settings goes to the setup check.
    expect(MAIN).toMatch(/const gaps = connected && !waiting \? setupHello\(setupRows\(\), settingsOpen\) : null;/);
    expect(MAIN).toMatch(/actions: \(connected && !gaps\) \|\| settingsOpen \|\| waiting \? \[\] : \[\{ id: "ui:settings", label: "Open settings" \}\]/);
    expect(MAIN).toMatch(/else if \(setupRows\(\)\.some\(holdsBack\)\) sendToHome\(IPC\.focusSection, "checks"\);/);
  });

  it("badges the sidebar's Setup link and mentions what to look at in the tagline (review #95)", () => {
    expect(setupBadge(0)).toBeNull();
    expect(setupBadge(1, true)).toEqual({ text: "1", label: ", 1 thing to fix", tone: "fail" });
    expect(setupBadge(2, false)).toEqual({ text: "2", label: ", 2 things to look at", tone: "warn" });
    expect(SCRIPT).toMatch(/renderSetupBadge\(view\.needing, view\.failing > 0\);/);
    const base = { failing: 0, onboarded: true, phase: "ready", hidden: false, overlay: true };
    expect(tagline({ ...base, look: 1 })).toBe("Ember is beside your cursor. Press Ctrl+Alt+Space to ask it anything. The setup check has one thing to look at.");
    expect(tagline({ ...base, look: 2 }, "Win+Alt+Space")).toBe("Ember is beside your cursor. Press Win+Alt+Space to ask it anything. The setup check has 2 things to look at.");
    expect(tagline({ ...base, look: 0 })).toBe("Ember is beside your cursor. Press Ctrl+Alt+Space to ask it anything.");
    // Before Start the instruction stays (review #160).
    expect(tagline({ ...base, onboarded: false, look: 2 })).toBe("Read how Ember works, pick who keeps you company, then agree and press Start.");
  });
});

// ───── The setup check's inputs on each OS (environment.ts) ─────
const versions = { electron: "44.5.0", chrome: "152", node: "24" };
const RHEL84 = 'NAME="Red Hat Enterprise Linux"\nVERSION_ID="8.4"\nID="rhel"\nPRETTY_NAME="Red Hat Enterprise Linux 8.4 (Ootpa)"\n';
const linux = (more: Partial<EnvInputs> = {}): EnvInputs => ({
  env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "GNOME" }, osRelease: RHEL84, glibc: "2.28", versions, platform: "linux", arch: "x64",
  accessibility: { enabled: true, pyatspi: true }, ...more,
});
const row = (i: EnvInputs, id: string) => inspectEnvironment(i).checks.find(c => c.id === id);
const doctorRow = (i: EnvInputs, id: string) => doctorChecks({
  env: inspectEnvironment(i), compositor: true, xtest: true, speechDispatcher: true, microphones: ["mic"], voiceModels: "bundled", runtime: true,
  auth: { kind: "github", source: "stored" }, admin: { policy: AdminPolicySchema.parse({}), source: null }, desk: null, sandbox: null,
}).find(c => c.id === id);

describe("Linux's accessibility switch after Turn on", () => {
  it("keeps saying that apps already open need a restart, for as long as this Ember runs (review #98)", () => {
    const on = linux({ applied: ["enable-accessibility"] });
    expect(row(on, "accessibility")).toMatchObject({ status: "ok", detail: "On. Restart apps that were already open, or log out and in, so Ember can read them." });
    // Switched on before Ember started (or by hand): nothing to restart for Ember's sake.
    expect(row(linux(), "accessibility")?.detail).toBe("Accessibility is on");
    expect(afterFix([], "enable-accessibility")).toEqual(["enable-accessibility"]);
    expect(afterFix(["enable-accessibility"], "enable-accessibility")).toEqual(["enable-accessibility"]);
    // main.ts records each fix applied through the setup check and passes them to every read.
    expect(MAIN).toMatch(/if \(!done\) fixesApplied = afterFix\(fixesApplied, fix as FixId\);/);
    expect(MAIN).toContain("inspectEnvironment({ ...sys.environment({ windows: wsState, shortcutsTaken, helper }), applied: fixesApplied");
  });

  it("gives the same advice in the setup check and in ember doctor (review #98)", () => {
    const off = linux({ accessibility: { enabled: false, pyatspi: true } });
    expect(row(off, "accessibility")?.detail).toBe("Accessibility is off, so Ember can only see screenshots. Turn it on, then restart apps that were already open (or log out and in).");
    expect(doctorRow(off, "accessibility")?.fix).toBe("gsettings set org.gnome.desktop.interface toolkit-accessibility true, then restart apps that were already open (or log out and in)");
  });
});
