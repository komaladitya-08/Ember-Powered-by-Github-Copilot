/**
 * First run and the setup check (release review, package "onboard"): what the settings window shows before Start,
 * which setup rows need the user, and what Ember says once it starts. Pure functions are called directly; the page's
 * own markup, style sheet and script are read as text where the behaviour is theirs (there is no DOM in these tests).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SPEAK_NO_VOICE, checksNote, homePatches, setupBadge, setupView, tagline, type HomePatch } from "../../app/renderer/home/copy";
import { holdsBack, needsUser, settingsSection, setupHello, setupIdle, type SetupRow } from "../../app/shared/setup-attention";
import { hello, type HelloInputs } from "../../app/main/hello";
import * as computersCopy from "../../app/renderer/home/computers-copy";
import type { StatusPlatform } from "../../app/shared/ipc";
import { SHORTCUTS, type OS } from "../../app/shared/shortcuts";
import { PLATFORM_WORDS } from "../../app/shared/words";
import { MAC_REGRANT, MAC_RESET_NOTE, afterFix, inspectEnvironment, type EnvInputs, type MacEnvInputs } from "../../app/main/environment";
import { darwinDoctorRows } from "../../app/main/platform/darwin/system/doctor";
import type { PermissionDeps } from "../../app/main/platform/darwin/system/permissions";
import { speechWatch } from "../../app/renderer/mic/speech-watch";
import { ISSUES_URL } from "../../app/shared/support";
import { doctorChecks, formatDoctor, type DoctorProbes } from "../../app/main/doctor";
import { AdminPolicySchema } from "../../app/main/admin";
import { NEVER_LOOK_DEFAULTS } from "../../app/shared/never-look";

const read = (f: string) => readFileSync(new URL(`../../app/${f}`, import.meta.url), "utf8");
const PAGE = read("renderer/home/index.html");
const STYLES = read("renderer/home/styles.css");
const SCRIPT = read("renderer/home/main.ts");
const MAIN = read("main/main.ts");

/** The element with `id` in the page: its tag and attributes, in whatever order the markup writes them. */
const tagOf = (id: string): { tag: string; attrs: Record<string, string> } => {
  const m = new RegExp(`<([a-z0-9]+)((?:\\s+[a-z-]+(?:="[^"]*")?)*?\\s+id="${id}"(?:\\s+[a-z-]+(?:="[^"]*")?)*)\\s*>`).exec(PAGE);
  if (!m) throw new Error(`no element #${id} in the page`);
  return { tag: m[1], attrs: Object.fromEntries([...m[2].matchAll(/([a-z-]+)(?:="([^"]*)")?/g)].map(a => [a[1], a[2] ?? ""])) };
};
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
    // The first settings applied lift the gate (applySettings), and so does the 1.5 s cap: two places.
    expect(SCRIPT.split("document.body.classList.remove(\"loading\")").length - 1).toBe(2);
  });
});

describe("the microphone consent", () => {
  it("is read once, with the button that agrees to it, so a screen reader user hears what they agree to (review #153)", () => {
    // Turning on "Hey Ember" moves focus straight to the button: its description is the whole note, whatever element
    // carries the note's words (fix/voice rewrites them). The panel is named, but doesn't describe itself with the
    // same note too, or NVDA and JAWS read it twice as focus enters the group.
    const note = tagOf("consent-text");
    expect(note.attrs).toBeDefined();
    expect(PAGE.indexOf("id=\"consent-text\"")).toBeGreaterThan(PAGE.indexOf("id=\"consent\""));
    expect(tagOf("consent").attrs).toMatchObject({ role: "group", "aria-label": "Before Ember listens" });
    expect(tagOf("consent").attrs["aria-describedby"]).toBeUndefined();
    expect(tagOf("consent-yes")).toMatchObject({ tag: "button", attrs: { "aria-describedby": "consent-text" } });
    expect(SCRIPT).toContain("$(\"consent-yes\").focus()");
  });
});

describe("WSL in the onboarding line", () => {
  it("is named only on Windows, the one OS that has it (review #221)", () => {
    // The page's own markup is Linux's: no WSL. Linux's and macOS's statuses keep it so; Windows' adds WSL.
    const note = /<li data-icon="plug"><b>Other computers and commands<\/b><span id="targets-note">([^<]*)<\/span><\/li>/.exec(PAGE)?.[1];
    expect(note).toBe(" are off until you turn them on: Ember can work on computers you reach over SSH, and run commands in its own window. Each asks you first.");
    for (const os of ["linux", "darwin"] as const) expect(patchedText(homePatches(platformOf(os)), "#targets-note"), os).toBe(note);
    expect(patchedText(homePatches(platformOf("win32")), "#targets-note")).toBe(" are off until you turn them on: Ember can work in WSL, on computers you reach over SSH, and run commands in its own window. Each asks you first.");
    // The Computers intro is the settings package's (review #198: computers.ts writes it from the status), not a patch.
    for (const os of ["linux", "darwin", "win32"] as const) expect(homePatches(platformOf(os)).some(x => x.selector === "#computers-intro"), os).toBe(false);
  });

  it("leaves WSL out of what an organisation turned off, except on Windows (review #221)", () => {
    expect(computersCopy.targetFeatureApplies("wsl", "linux")).toBe(false);
    expect(computersCopy.targetFeatureApplies("wsl", "darwin")).toBe(false);
    expect(computersCopy.targetFeatureApplies("wsl", "win32")).toBe(true);
    expect(computersCopy.targetFeatureApplies("wsl")).toBe(false);
    for (const os of ["linux", "darwin", "win32"] as const) expect(computersCopy.targetFeatureApplies("ssh", os)).toBe(true);
    expect(computersCopy.targetFeatureApplies("voice", "darwin")).toBe(true);
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
    // Nothing shows around it from its top down, across the whole window: a shadow moved down by its spread, so it
    // starts at the card's top (a shadow, so no sideways scrolling), behind the card's content.
    const band = /body\.first-run \.start-row::before \{([^}]*)\}/.exec(STYLES)?.[1] ?? "";
    expect(band).toContain("0 100vmax 0 100vmax var(--bg)");
    expect(band).toContain("z-index: -1");
    // The card's edge (--group-edge's ring, its only edge in increased contrast) is drawn over that background, so it
    // shows all round; the card itself no longer draws it, where the background would cover it at the sides and foot.
    expect(band).toMatch(/box-shadow: var\(--group-edge\), 0 100vmax/);
    expect(/body\.first-run \.start-row \{([^}]*)\}/.exec(STYLES)?.[1]).not.toContain("--group-edge");
    // Its box lies a pixel inside the card's, so where the two rounded edges meet, nothing behind the card shows through.
    expect(band).toContain("inset: 1px");
  });

  it("doesn't point to sections that aren't shown before Start (review #104)", () => {
    const welcome = flat.slice(flat.indexOf("<section id=\"welcome\""), flat.indexOf("</section>", flat.indexOf("<section id=\"welcome\"")));
    expect(welcome).not.toMatch(/\bbelow\b/);
    // The list is in settings, and the sentence promises only what it does (review #104): password prompts, and the
    // apps on the list, which starts with common password managers on every OS (not every one there is).
    expect(welcome).toContain("App windows on your never-look list and password prompts are never read. The list is in settings, and common password managers are on it already.");
    for (const os of ["linux", "win32", "darwin"] as const) expect(NEVER_LOOK_DEFAULTS[os], os).toEqual(expect.arrayContaining(["1password", "bitwarden"]));
    // Settings' own pin (review #164) holds within it.
    expect(welcome).toContain("App windows on your never-look list and password prompts are never read.");
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
    expect(v2).toMatchObject({ failing: 0, needing: 2, open: false, beforeStart: true, note: "2 things worth a look" });
    // Everything allowed: the list (all OK) stays where the user was working until Start.
    expect(setupView(allowed(MAC_FIRST, "accessibility", "screen-recording", "input-monitoring"), { opened: true, beforeStart: v2.beforeStart }))
      .toMatchObject({ needing: 0, beforeStart: true, note: "All good" });
  });

  it("opens and shows before Start for a warning with a fix, such as Linux's accessibility switch (review #161)", () => {
    expect(setupView(LINUX_A11Y_OFF, first)).toMatchObject({ failing: 0, needing: 1, open: true, beforeStart: true, note: "1 thing worth a look" });
    // A warning with nothing to do keeps the fold shut and the first-run screen as it was.
    const other = LINUX_A11Y_OFF.map(r => (r.id === "accessibility" ? { id: r.id, label: r.label, status: "ok" as const } : r.id === "os" ? { ...r, status: "warn" as const } : r));
    expect(setupView(other, first)).toMatchObject({ needing: 0, open: false, beforeStart: false, note: "1 thing worth a look" });
    // Opened by itself once: a user who closes it isn't overruled by the next status.
    expect(setupView(LINUX_A11Y_OFF, { opened: true, beforeStart: true }).open).toBe(false);
  });

  it("counts the rows in words by the heading (review #160)", () => {
    expect(checksNote(1, 0)).toBe("1 thing to fix");
    expect(checksNote(2, 3)).toBe("2 things to fix");
    expect(checksNote(0, 1)).toBe("1 thing worth a look");
    expect(checksNote(0, 2)).toBe("2 things worth a look");
    expect(checksNote(0, 0)).toBe("All good");
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
    // The sentence fix/bubble pins too (ui-copy.test.ts), word for word.
    expect(tagline({ ...base, failing: 1 })).toBe("Ember needs 1 thing fixed before it can work on this computer.");
    expect(tagline({ ...base, failing: 2 })).toBe("Ember needs 2 things fixed before it can work on this computer.");
  });
});

describe("pressing Start while something holds Ember back", () => {
  it("keeps settings open at the setup check instead of closing it and greeting as if ready (review #95)", () => {
    expect(settingsSection("ready", MAC_FIRST)).toBe("checks");
    expect(settingsSection("ready", LINUX_A11Y_OFF)).toBe("checks");
    expect(settingsSection("ready", [{ id: "session", label: "Desktop session", status: "fail" }])).toBe("checks");
    // Copilot isn't connected: its sign-in comes first, as before.
    expect(settingsSection("signed-out", MAC_FIRST)).toBe("copilot");
    expect(settingsSection("error", [])).toBe("copilot");
    // Nothing holds Ember back (a fix button for a nicety doesn't count): the window closes and Ember says hello.
    expect(settingsSection("ready", allowed(MAC_FIRST, "accessibility", "screen-recording", "input-monitoring"))).toBeNull();
    expect(settingsSection("ready", [{ id: "location", label: "Applications folder", status: "warn", fix: "move-to-applications" }])).toBeNull();
    expect(settingsSection(undefined, [])).toBeNull();
  });

  it("names what isn't set up (review #95)", () => {
    expect(setupHello(MAC_FIRST, false)).toBe("Still to set up: “Reading and using apps”, “Screen Recording” and “Input Monitoring”. The setup check in settings shows how.");
    expect(setupHello(LINUX_A11Y_OFF, true)).toBe("Still to set up: “Screen reading”. The setup check in this window shows how.");
    const four = [...MAC_FIRST, { id: "session", label: "Desktop session", status: "fail" as const }];
    expect(setupHello(four, false)).toBe("Still to set up: “Reading and using apps”, “Screen Recording” and 2 more. The setup check in settings shows how.");
    expect(setupHello(allowed(MAC_FIRST, "accessibility", "screen-recording", "input-monitoring"), false)).toBeNull();
  });
});

describe("Ember's hello once it starts", () => {
  const keys = "Press Ctrl+Alt+Space to ask me anything; Ctrl+Alt+X stops me.";
  const at = (more: Partial<HelloInputs>): HelloInputs => ({ phase: "ready", waiting: false, overlay: true, keys, settingsKey: "Ctrl+Alt+E", settingsOpen: false, rows: [], ...more });
  const settingsButton = [{ id: "ui:settings", label: "Open settings" }];

  it("says where Ember is and how to ask when everything is set up", () => {
    expect(hello(at({}))).toEqual({ thought: `I'll stay by your cursor. ${keys}`, mood: "idle", actions: [], holdMs: 7000 });
    expect(hello(at({ overlay: false })).thought).toBe(`This session can't show me beside your cursor, so I'll wait here. ${keys}`);
    // Still connecting is said as ready is (the handle shows the connecting).
    expect(hello(at({ phase: "starting" }))).toEqual(hello(at({})));
    expect(hello(at({ phase: undefined }))).toEqual(hello(at({})));
    // A warning that holds nothing back changes nothing.
    expect(hello(at({ rows: [{ id: "os", label: "Operating system", status: "warn" }] }))).toEqual(hello(at({})));
  });

  it("names a setup row that holds Ember back, with Open settings while settings is closed, for longer (review #95)", () => {
    expect(hello(at({ rows: MAC_FIRST }))).toEqual({
      thought: `I'll stay by your cursor. Still to set up: “Reading and using apps”, “Screen Recording” and “Input Monitoring”. The setup check in settings shows how. ${keys}`,
      mood: "attention", actions: settingsButton, holdMs: 15000,
    });
    // Settings is open (Start kept it at the setup check): no button, and "this window".
    expect(hello(at({ rows: LINUX_A11Y_OFF, settingsOpen: true }))).toEqual({
      thought: `I'll stay by your cursor. Still to set up: “Screen reading”. The setup check in this window shows how. ${keys}`,
      mood: "attention", actions: [], holdMs: 15000,
    });
  });

  it("asks to connect Copilot first, and doesn't name setup rows then", () => {
    expect(hello(at({ phase: "signed-out", rows: MAC_FIRST }))).toEqual({
      thought: "I'm not connected to Copilot yet. Open settings (Ctrl+Alt+E) to connect me.", mood: "attention", actions: settingsButton, holdMs: 15000,
    });
    // Another app holds the settings shortcut: not named.
    expect(hello(at({ phase: "error", settingsKey: null })).thought).toBe("I'm not connected to Copilot yet. Open settings to connect me.");
    expect(hello(at({ phase: "signed-out", settingsOpen: true }))).toEqual({
      thought: "I'm not connected to Copilot yet: connect me in the settings window.", mood: "attention", actions: [], holdMs: 15000,
    });
  });

  it("waits for the network without a button when offline at start", () => {
    expect(hello(at({ phase: "error", waiting: true, rows: MAC_FIRST }))).toEqual({
      thought: "I can't reach GitHub yet: I'll connect as soon as the network is back.", mood: "error", actions: [], holdMs: 15000,
    });
  });

  it("says first why Ember can't work here at all, in place of everything else", () => {
    // main's reason (a desktop session Ember can't use, the organisation's lockdown) comes before Copilot and the rows.
    const why = "This is a Wayland session, so I can't see your screen or use your mouse here.";
    for (const more of [{}, { rows: MAC_FIRST }, { phase: "signed-out" }, { phase: "error", waiting: true }]) {
      expect(hello(at({ ...more, cannotWork: why })), JSON.stringify(more)).toEqual({ thought: why, mood: "attention", actions: settingsButton, holdMs: 15000 });
    }
    expect(hello(at({ cannotWork: why, settingsOpen: true }))).toEqual({ thought: why, mood: "attention", actions: [], holdMs: 15000 });
    // None: as before.
    expect(hello(at({ cannotWork: null }))).toEqual(hello(at({})));
  });
});

describe("Ember's handle while a setup row holds it back", () => {
  it("says Setup needed instead of Ready, until the row is fixed (review #95)", () => {
    expect(setupIdle("ready", MAC_FIRST)).toBe("Setup needed");
    expect(setupIdle("ready", LINUX_A11Y_OFF)).toBe("Setup needed");
    expect(setupIdle("ready", allowed(MAC_FIRST, "accessibility", "screen-recording", "input-monitoring"))).toBeNull();
    // A fix button for a nicety isn't "needed".
    expect(setupIdle("ready", [{ id: "location", label: "Applications folder", status: "warn", fix: "move-to-applications" }])).toBeNull();
    // Copilot's own state says more while it isn't ready (Connecting…, Not connected, Offline…).
    for (const phase of ["starting", "signed-out", "error", undefined]) expect(setupIdle(phase, MAC_FIRST), String(phase)).toBeNull();
  });
});

describe("the settings window's setup badge and line", () => {
  it("badges the sidebar's Setup link and mentions what is worth a look in the tagline (review #95)", () => {
    expect(setupBadge(0)).toBeNull();
    // Failing rows are counted as the heading counts them; else the rows that need a look.
    expect(setupBadge(3, 1)).toEqual({ text: "1", label: ", 1 thing to fix", tone: "fail" });
    expect(setupBadge(2, 0)).toEqual({ text: "2", label: ", 2 things worth a look", tone: "warn" });
    const base = { failing: 0, onboarded: true, phase: "ready", hidden: false, overlay: true };
    expect(tagline({ ...base, look: 1 })).toBe("Ember is beside your cursor. Press Ctrl+Alt+Space to ask it anything. The setup check has 1 thing worth a look.");
    expect(tagline({ ...base, look: 2 }, "Win+Alt+Space")).toBe("Ember is beside your cursor. Press Win+Alt+Space to ask it anything. The setup check has 2 things worth a look.");
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
  });

  it("gives the same advice in the setup check and in ember doctor (review #98)", () => {
    const off = linux({ accessibility: { enabled: false, pyatspi: true } });
    expect(row(off, "accessibility")?.detail).toBe("Accessibility is off, so Ember can only see screenshots. Turn it on, then restart apps that were already open, or log out and in.");
    expect(doctorRow(off, "accessibility")?.fix).toBe("gsettings set org.gnome.desktop.interface toolkit-accessibility true   (then restart apps that were already open, or log out and in)");
    // The command stands apart on the report's fix line, so copying it copies a command gsettings takes.
    const line = formatDoctor([doctorRow(off, "accessibility")!]).split("\n").find(l => l.includes("→"))!;
    expect(line).toMatch(/→ gsettings set org\.gnome\.desktop\.interface toolkit-accessibility true {3}\(then restart apps that were already open, or log out and in\)$/);
    expect(line.split("→ ")[1].split(/ {2,}/)[0]).toBe("gsettings set org.gnome.desktop.interface toolkit-accessibility true");
  });
});

const macIn = (m: Partial<MacEnvInputs> = {}, more: Partial<EnvInputs> = {}): EnvInputs => ({
  env: {}, osRelease: null, glibc: null, versions, platform: "darwin", arch: "arm64",
  mac: { version: "14.6.1", accessibility: false, screen: "denied", microphone: "denied", inputMonitoring: false, inApplications: true, root: false, ...m }, ...more,
});

describe("macOS permissions that stay off", () => {
  it("say nothing about removing and re-adding Ember until the user has pressed the row's button (review #99)", () => {
    // A brand-new install: Ember isn't listed anywhere yet, so the advice about a listed copy is noise.
    for (const id of ["accessibility", "screen-recording", "input-monitoring", "microphone"]) {
      const c = row(macIn(), id)!;
      expect(c.detail, id).not.toContain(MAC_REGRANT);
      expect(c.detail, id).not.toContain(MAC_RESET_NOTE);
      expect(c.alt, id).toBeUndefined();
    }
    expect(row(macIn(), "accessibility")?.detail).toBe("Ember needs the Accessibility permission to read and use apps.");
  });

  it("offer Reset Ember's permissions on a row whose System Settings button didn't take (review #99)", () => {
    const pressed = macIn({}, { applied: ["open-accessibility-settings", "open-screen-recording-settings", "open-input-monitoring-settings", "open-microphone-settings"] });
    expect(row(pressed, "accessibility")).toMatchObject({ status: "fail", fix: "open-accessibility-settings", alt: "reset-permissions",
      detail: `Ember needs the Accessibility permission to read and use apps. ${MAC_RESET_NOTE}` });
    expect(row(pressed, "screen-recording")).toMatchObject({ fix: "open-screen-recording-settings", alt: "reset-permissions" });
    expect(row(pressed, "input-monitoring")).toMatchObject({ fix: "open-input-monitoring-settings", alt: "reset-permissions" });
    // The reset doesn't cover the microphone: its row keeps the switch-it-again advice instead.
    expect(row(pressed, "microphone")).toMatchObject({ fix: "open-microphone-settings", detail: expect.stringContaining(MAC_REGRANT) });
    expect(row(pressed, "microphone")?.alt).toBeUndefined();
    // Allowed after all: no note, no second button.
    expect(row(macIn({ accessibility: true }, { applied: ["open-accessibility-settings"] }), "accessibility")).toEqual({ id: "accessibility", label: "Reading and using apps", status: "ok", detail: "Accessibility is allowed" });
    // The reset takes Ember off all three lists, so pressing it on one row also undoes a grant that worked: said.
    expect(MAC_RESET_NOTE).toBe("Already switched on? macOS ties the permission to this exact copy of Ember: reset Ember's permissions, which takes Ember off the Accessibility, Screen Recording and Input Monitoring lists, then switch each on again.");
  });

  it("start the advice again after a reset, which took Ember off every list (review #99)", () => {
    const pressed = afterFix(afterFix(afterFix(["open-microphone-settings"], "open-accessibility-settings"), "open-screen-recording-settings"), "open-input-monitoring-settings");
    expect(afterFix(pressed, "reset-permissions")).toEqual(["open-microphone-settings", "reset-permissions"]);
  });

  it("say the re-grant sentence once in ember doctor, not under every permission (review #99)", () => {
    const d: PermissionDeps = {
      app: { isInApplicationsFolder: () => true }, systemPreferences: { getMediaAccessStatus: () => "denied", isTrustedAccessibilityClient: () => false },
      windows: () => null, uid: () => 501, systemVersion: () => "14.6.1",
    };
    const rows = darwinDoctorRows(d);
    expect(rows.filter(r => r.status !== "ok").map(r => r.id)).toEqual(["accessibility-permission", "screen-recording", "microphone-permission"]);
    expect(rows.filter(r => r.fix?.includes(MAC_REGRANT)).map(r => r.id)).toEqual(["accessibility-permission"]);
    // Every one still says where to switch Ember on.
    for (const r of rows.filter(x => x.status !== "ok")) expect(r.fix, r.id).toMatch(/^System Settings › Privacy & Security › .+: switch Ember on/);
  });
});

describe("speaking with no voice on the computer", () => {
  /** Fake timers: what is pending, and a way to fire them. */
  const timers = () => {
    let next = 1;
    const pending = new Map<number, () => void>();
    return {
      setTimer: (fn: () => void) => { const id = next++; pending.set(id, fn); return id; },
      clearTimer: (id: unknown) => { pending.delete(id as number); },
      fire: () => { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } },
      get count() { return pending.size; },
    };
  };

  it("tells main when speech never starts, and when it works again (review #101)", () => {
    const t = timers();
    const said: boolean[] = [];
    const w = speechWatch({ timeoutMs: 8000, setTimer: t.setTimer, clearTimer: t.clearTimer, report: ok => said.push(ok) });
    // No voice: the utterance never starts.
    w.utterance();
    t.fire();
    expect(said).toEqual([false]);
    // The next one doesn't start either: said once.
    w.utterance();
    t.fire();
    expect(said).toEqual([false]);
    // A voice was added: speech starts, and main hears it works.
    w.utterance().started();
    expect(said).toEqual([false, true]);
    expect(t.count).toBe(0);
  });

  it("counts a start after the wait, and ignores replies cut off by the next one or by a stop (review #101)", () => {
    const t = timers();
    const said: boolean[] = [];
    const w = speechWatch({ timeoutMs: 8000, setTimer: t.setTimer, clearTimer: t.clearTimer, report: ok => said.push(ok) });
    const slow = w.utterance();
    t.fire();
    slow.started();
    expect(said).toEqual([false, true]);
    // Replaced or hushed: nothing is known about the voice.
    const cut = w.utterance();
    cut.failed("interrupted");
    w.utterance().failed("canceled");
    w.utterance().cancelled();
    expect(t.count).toBe(0);
    expect(said).toEqual([false, true]);
    // The synthesiser itself failed: that counts.
    w.utterance().failed("synthesis-failed");
    expect(said).toEqual([false, true, false]);
  });

  it("says no voice only for the synthesiser's no-voice errors; any other error tells nothing (review #101)", () => {
    // Each case starts from "speech works", then one reply fails with that error.
    const after = (error: string) => {
      const t = timers();
      const said: boolean[] = [];
      const w = speechWatch({ timeoutMs: 8000, setTimer: t.setTimer, clearTimer: t.clearTimer, report: ok => said.push(ok) });
      w.utterance().started();
      w.utterance().failed(error);
      // The failed reply's wait is over too: it doesn't turn into "no voice" 8 s later.
      t.fire();
      return said.slice(1);
    };
    for (const error of ["synthesis-unavailable", "synthesis-failed", "language-unavailable", "voice-unavailable"]) expect(after(error), error).toEqual([false]);
    // A reply too long, a busy or broken sound device, a refused or bad request: the computer may well have a voice.
    for (const error of ["text-too-long", "audio-busy", "audio-hardware", "not-allowed", "invalid-argument", "network", "interrupted", "canceled", "something-new"]) {
      expect(after(error), error).toEqual([]);
    }
  });
});

describe("the settings window when no voice speaks", () => {
  const win = (more: Partial<EnvInputs> = {}): EnvInputs => ({ env: {}, osRelease: null, glibc: null, versions, platform: "win32", arch: "x64",
    windows: { build: 22631, elevated: false, session: "console", powershell: "full", dpiMixed: false }, ...more });

  it("adds a Speaking row with the OS's way to add a voice, only once Ember has found none (review #101)", () => {
    expect(row(linux(), "speech")).toBeUndefined();
    expect(row(linux({ speech: true }), "speech")).toBeUndefined();
    expect(row(linux({ speech: false }), "speech")).toEqual({ id: "speech", label: "Speaking", status: "warn",
      detail: "Ember couldn't speak: this computer has no speech voice. Install one with sudo dnf install speech-dispatcher speech-dispatcher-espeak-ng, then restart Ember." });
    expect(row(win({ speech: false }), "speech")?.detail).toBe("Ember couldn't speak: Windows has no voice it can use. Add one in Settings › Time & language › Speech, then restart Ember.");
    expect(row(macIn({ accessibility: true, screen: "granted", inputMonitoring: true, microphone: "granted" }, { speech: false }), "speech")?.detail)
      .toBe("Ember couldn't speak: macOS has no voice it can use. Choose one in System Settings › Accessibility › Spoken Content, then restart Ember.");
  });

  it("says so under the Speak switch, and reads the setup check again when it changes (review #101)", () => {
    expect(SPEAK_NO_VOICE).toBe("Ember couldn't speak: this computer has no voice it can use. The setup check says how to add one.");
    // Under the Speak control in the Voice section, whatever that control is (fix/voice makes it a <select>).
    const at = PAGE.indexOf("aria-labelledby=\"voice-h\"");
    const voice = PAGE.slice(at, PAGE.indexOf("</section>", at));
    expect(voice.indexOf("id=\"speak-note\"")).toBeGreaterThan(voice.indexOf("id=\"speak\""));
    expect(voice.indexOf("id=\"speak\"")).toBeGreaterThan(0);
    expect(tagOf("speak-note")).toEqual({ tag: "p", attrs: { class: "hint", id: "speak-note", role: "status", hidden: "" } });
  });
});

describe("setup check and doctor wording", () => {
  const doctorWith = (over: Partial<DoctorProbes>) => doctorChecks({
    env: inspectEnvironment(linux()), compositor: true, xtest: true, speechDispatcher: true, microphones: ["mic"], voiceModels: "bundled", runtime: true,
    auth: { kind: "github", source: "stored" }, admin: { policy: AdminPolicySchema.parse({}), source: null }, desk: null, sandbox: null, ...over,
  });

  it("names the doctor's own rows in plain words, not Compositor, Sandbox or File watchers (review #105)", () => {
    const label = (checks: ReturnType<typeof doctorChecks>, id: string) => checks.find(c => c.id === id)?.label;
    const linuxRows = doctorWith({ sandbox: { userNamespaces: false, suidHelper: true }, fileWatchers: { used: 3, max: 128 } });
    expect(label(linuxRows, "compositor")).toBe("Transparent windows");
    expect(label(linuxRows, "sandbox")).toBe("Window sandbox");
    expect(label(linuxRows, "file-watchers")).toBe("Copilot's file watchers");
    // Every state of each row, and Windows' and macOS' compositor row, use the same name.
    const states = [
      doctorWith({ compositor: false, sandbox: { userNamespaces: false, suidHelper: false }, fileWatchers: { used: 128, max: 128 } }),
      doctorWith({ compositor: null, fileWatchers: { used: 125, max: 128 } }),
      doctorWith({ os: "win32", env: inspectEnvironment({ env: {}, osRelease: null, glibc: null, versions, platform: "win32", arch: "x64" }), microphones: null }),
      doctorWith({ os: "darwin", env: inspectEnvironment(macIn()), compositor: null, microphones: null }),
    ];
    for (const checks of [linuxRows, ...states]) {
      expect(checks.map(c => c.label)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(Compositor|Sandbox|File watchers)$/)]));
    }
    expect(states.map(c => label(c, "compositor"))).toEqual(["Transparent windows", "Transparent windows", "Transparent windows", "Transparent windows"]);
    expect(label(states[0], "sandbox")).toBe("Window sandbox");
    expect(states.slice(0, 2).map(c => label(c, "file-watchers"))).toEqual(["Copilot's file watchers", "Copilot's file watchers"]);
  });

  it("says why another Linux is only a warning (review #105)", () => {
    const ubuntu = linux({ osRelease: 'ID="ubuntu"\nVERSION_ID="22.04"\nPRETTY_NAME="Ubuntu 22.04.4 LTS"' });
    expect(row(ubuntu, "os")).toEqual({ id: "os", label: "Operating system", status: "warn",
      detail: "Ubuntu 22.04.4 LTS. Ember is tested on RHEL 8 and its family (Rocky, Alma and Oracle Linux 8): it may work here, but it isn't supported." });
    expect(row(linux({ osRelease: null }), "os")?.detail).toMatch(/^This Linux\. Ember is tested on RHEL 8/);
    expect(row(linux(), "os")).toEqual({ id: "os", label: "Operating system", status: "ok", detail: "Red Hat Enterprise Linux 8.4 (Ootpa)" });
    // ember doctor shows the same row.
    expect(doctorRow(ubuntu, "os")?.detail).toBe(row(ubuntu, "os")?.detail);
  });

  it("gives a place to report problems in the About section, the issue address platform's advice names too (review #105)", () => {
    // One address for both packages (app/shared/support.ts, review #223 names it in the display-scaling advice).
    expect(ISSUES_URL).toBe("https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/issues");
    expect(SCRIPT).toContain("[\"Report a problem\", ISSUES_URL]");
  });
});

/**
 * Where the main process and the settings window use the decisions tested above: one check per call site, of the call
 * alone, so a reformat or a merge around it doesn't break them. The speaking page's and VoiceService's part is tested as
 * behaviour (onboard-speech.test.ts).
 */
describe("the call sites", () => {
  it("in main.ts", () => {
    for (const call of [
      "applied: fixesApplied, speech: speechHeard", // every read of the setup check (#98, #101)
      "fixesApplied = afterFix(fixesApplied", // the setup check's fix handler (#98, #99)
      "hello({", // greet (#95)
      "settingsSection(phase, setupRows())", // after Start (#95)
      "settingsSection(agent?.getStatus().phase, setupRows())", // Open settings (#95)
      "idle: idleNow(status)", // the agent's status (#95)
      "sawSetup(env.checks)", // every status the settings window reads, and the fix handler's (#95)
      "onSpeech: ok =>", // the speaking page's finding (#101)
      "speechMissing: speechHeard === false", // the voice status (#101)
    ]) expect(MAIN, call).toContain(call);
  });

  it("in the settings window", () => {
    for (const call of [
      "setupView(environment.checks", // renderChecks (#94, #160, #161)
      "toggle(\"after-setup\", !checksBeforeStart)", // the check before Start (#94)
      "renderSetupBadge(view.needing, failing)", // the sidebar's badge (#95)
      "[c.fix, c.alt]", // a row's second button (#99)
      "targetFeatureApplies(k, platform?.os)", // the policy line (#221)
      "v.speechMissing === true", // the note under Speak (#101)
    ]) expect(SCRIPT, call).toContain(call);
  });
});
