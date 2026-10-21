import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  NEVER_LOOK_DEFAULTS, dayLabel, describeEntry, forUser, friendlyApp, keyLabel, missingDefaults, neverLookLabel, progressStep, retryMessage, tagline, tokens, usageLine,
} from "../../app/renderer/home/copy";
import { cardTask, cardText } from "../../app/renderer/handle/card";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import { IDLE_BUBBLE, type BubbleState, type TaskCard } from "../../app/shared/overlay";

describe("settings window words", () => {
  it("counts model calls and tokens the way people say them", () => {
    expect(usageLine({ calls: 0, inputTokens: 0, outputTokens: 0 })).toBe("");
    expect(usageLine({ calls: 1, inputTokens: 312, outputTokens: 40 })).toBe("This session: 1 model call, 312 tokens in, 40 tokens out.");
    expect(usageLine({ calls: 10, inputTokens: 1234, outputTokens: 212 })).toBe("This session: 10 model calls, 1.2k tokens in, 212 tokens out.");
    expect(tokens(2000)).toBe("2k");
    expect(tokens(48_400)).toBe("48k");
    expect(usageLine({ calls: 3, inputTokens: 40, outputTokens: 12 })).not.toMatch(/0\.0k/);
  });

  it("says what Check again found", () => {
    expect(retryMessage({ found: false, source: null })).toBe("No GitHub sign-in found on this computer. Run “gh auth login” in a terminal, then press Check again.");
    expect(retryMessage({ found: true, source: "github-cli" })).toBe("Found your GitHub CLI sign-in; connecting…");
    expect(retryMessage({ found: true, source: "environment" }, true)).toBe("Found a GitHub token in the environment; connected.");
    expect(retryMessage({ found: true, source: "stored" })).toBe("Found Ember's saved sign-in; connecting…");
  });

  it("keeps the tagline in step with setup, Copilot and where Ember is", () => {
    const base = { failing: 0, onboarded: true, phase: "ready", hidden: false, overlay: true };
    expect(tagline({ ...base, onboarded: false, phase: "signed-out" })).toBe("Read how Ember works, pick who keeps you company, then agree and press Start.");
    expect(tagline({ ...base, phase: "signed-out" })).toBe("Ember is beside your cursor. Connect Copilot below to start asking.");
    expect(tagline({ ...base, phase: "starting" })).toBe("Ember is beside your cursor. Connecting to Copilot…");
    expect(tagline(base)).toBe("Ember is beside your cursor. Press Ctrl+Alt+Space to ask it anything.");
    expect(tagline({ ...base, hidden: true })).toMatch(/^Ember is hidden for now\./);
    expect(tagline({ ...base, overlay: false })).toMatch(/^Ember is in the bottom-right corner\./);
    expect(tagline({ ...base, failing: 2 })).toMatch(/fixed/);
    // Copilot stopped answering with tasks at work: no "connect" (signing in again isn't the fix).
    expect(tagline({ ...base, phase: "error", waitingForTasks: true })).toBe("Ember is beside your cursor. Copilot isn't answering: Ember reconnects once the tasks running are done.");
  });

  it("names days Today and Yesterday", () => {
    const now = new Date(2026, 9, 15, 20, 0);
    expect(dayLabel(new Date(2026, 9, 15, 8, 0).toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 14, 23, 59).toISOString(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 12, 9, 0).toISOString(), now)).not.toMatch(/Today|Yesterday/);
  });

  it("announces a download only every 25 %", () => {
    expect([0, 0.1, 0.24, 0.25, 0.49, 0.5, 0.74, 0.99, 1].map(progressStep)).toEqual([0, 0, 0, 25, 25, 50, 50, 75, 100]);
  });

  it("keeps the never-look defaults the same as the settings defaults, with readable names", () => {
    expect([...NEVER_LOOK_DEFAULTS]).toEqual(DEFAULT_SETTINGS.privacy.neverLook);
    expect(neverLookLabel("keepassxc")).toBe("KeePassXC");
    expect(neverLookLabel("polkit")).toBe("Password prompts (polkit)");
    expect(neverLookLabel("Thunderbird")).toBe("Thunderbird");
    expect(missingDefaults(["KeePassXC", "Signal"])).toEqual(["seahorse", "passwords and keys", "1password", "bitwarden", "polkit"]);
    expect(missingDefaults(NEVER_LOOK_DEFAULTS)).toEqual([]);
  });

  it("calls apps by familiar names", () => {
    expect(friendlyApp("gnome-control-center")).toBe("Settings");
    expect(friendlyApp("org.gnome.Nautilus")).toBe("Files");
    expect(friendlyApp("org.example.Notes")).toBe("Notes");
    expect(friendlyApp("mousepad")).toBe("Mousepad");
    expect(friendlyApp("Mousepad")).toBe("Mousepad");
    expect(friendlyApp("LibreOffice Writer")).toBe("LibreOffice");
  });

  it("names a control once in What Ember did", () => {
    const t = "2026-10-15T20:00:00.000Z";
    expect(describeEntry({ t, event: "action", kind: "toggle", ok: true, element: { role: "switch", name: "Night Light" }, app: "gnome-control-center" })?.what)
      .toBe("Switch “Night Light” in Settings");
    expect(describeEntry({ t, event: "action", kind: "click", ok: true, element: { role: "push button", name: "" } })?.what).toBe("Click a button");
    expect(describeEntry({ t, event: "action", kind: "keys", ok: true, value: "ctrl+s", element: { role: "text", name: "" }, app: "mousepad" })?.what).toBe("Press Ctrl+S in Mousepad");
    expect(describeEntry({ t, event: "decision", kind: "keys", verdict: "confirm", value: "Return", app: "soffice" })?.what).toBe("Press Enter in LibreOffice");
    expect(describeEntry({ t, event: "action", kind: "keys", ok: true, app: "mousepad" })?.what).toBe("Press keys in Mousepad");
    expect(describeEntry({ t, event: "action", kind: "user_clicked", ok: true, element: { role: "push button", name: "Save draft" }, app: "electron" })?.what)
      .toBe("You used “Save draft” in Electron");
    expect(describeEntry({ t, event: "action", kind: "select", ok: true, value: "Vegetarian", element: { role: "combo box", name: "Meal" }, app: "firefox" })?.what)
      .toBe("Choose “Vegetarian” for “Meal” in Firefox");
    expect(describeEntry({ t, event: "confirm", kind: "select", answer: "once", value: "Deutsch", element: { role: "list", name: "" } })?.what)
      .toBe("Choose “Deutsch”");
    expect(keyLabel("shift+F10")).toBe("Shift+F10");
    expect(describeEntry({ t, event: "decision", verdict: "allow" })).toBeNull();
  });

  it("one question for several cells is one line, however many cells it covered (UI10-1)", () => {
    const t = "2026-10-15T20:00:00.000Z";
    const cell = (at: number, more: Record<string, unknown> = {}) => describeEntry({ t, event: "decision", kind: "cursor_text", verdict: "confirm", reason: "Ember needs your mouse or keyboard for this",
      element: { role: "table cell", name: `A${at + 2}` }, app: "soffice", batch: 3, at, ...more });
    expect([cell(0), cell(1)]).toEqual([null, null]);
    expect(cell(2, { batchVerdict: "ask", batchReason: "Ember needs your mouse or keyboard for this" }))
      .toEqual({ tag: "Asked you", cls: "ask", what: "Fill 3 cells (your keyboard) in LibreOffice", why: "Ember needs your mouse or keyboard for this" });
    expect(cell(2, { batchVerdict: "deny", batchReason: "this app is read-only for Ember" })).toMatchObject({ tag: "Refused", cls: "no", what: "Fill 3 cells (your keyboard) in LibreOffice" });
    // No question for the batch (each cell is asked on its own, or none needed): those lines say it.
    expect(cell(2, { batchVerdict: "none" })).toBeNull();
  });

  it("on Ember's desk the lines don't say “your keyboard” or “your mouse” (AC11-4)", () => {
    const t = "2026-10-15T20:00:00.000Z";
    expect(describeEntry({ t, event: "decision", kind: "cursor_text", verdict: "confirm", reason: "r", element: { role: "table cell", name: "A4" }, app: "soffice", batch: 3, at: 2,
      batchVerdict: "ask", onDesk: true })?.what).toBe("Fill 3 cells in LibreOffice");
    expect(describeEntry({ t, event: "action", kind: "cursor_click", ok: true, tier: 2, element: { role: "push button", name: "Send" }, app: "thunderbird" })?.what)
      .toBe("Click “Send” in Thunderbird (on Ember's desk)");
    expect(describeEntry({ t, event: "confirm", kind: "cursor_text", answer: "once", onDesk: true, element: { role: "text", name: "To" }, app: "thunderbird" })?.what)
      .toBe("Type “To” in Thunderbird");
    // On the user's screen they still do.
    expect(describeEntry({ t, event: "action", kind: "cursor_click", ok: true, element: { role: "push button", name: "Send" }, app: "thunderbird" })?.what)
      .toBe("Click (your mouse) “Send” in Thunderbird");
  });
});

describe("corner card (no compositor)", () => {
  const bubble = (b: Partial<BubbleState>): BubbleState => ({ ...IDLE_BUBBLE, visible: true, ...b });

  it("puts an answer's words in the text area and a short label in the bold line", () => {
    expect(cardText(bubble({ title: "Cinder", thought: "Here is how…", streaming: true }), "Cinder", null)).toEqual({ line: "Answering…", thought: "Here is how…" });
    expect(cardText(bubble({ title: "Cinder", thought: "Done it." }), "Cinder", null)).toEqual({ line: "Answer", thought: "Done it." });
    expect(cardText(bubble({ title: "Cinder", mood: "error", thought: "No network." }), "Cinder", null).line).toBe("Problem");
    expect(cardText(bubble({ title: "Cinder", mood: "thinking", thought: "Hmm" }), "Cinder", null).line).toBe("Thinking…");
  });

  it("keeps a real title (a question, a task, a greeting)", () => {
    expect(cardText(bubble({ title: "May I?", mood: "attention", thought: "Type “Hi”?" }), "Cinder", null)).toEqual({ line: "May I?", thought: "Type “Hi”?" });
    expect(cardText(bubble({ title: "Tidy the desktop", mood: "acting", thought: "Looking…" }), "Cinder", "Working in Files").line).toBe("Tidy the desktop");
  });

  it("shows the status or Ready when nothing is said", () => {
    expect(cardText(IDLE_BUBBLE, "Cinder", null)).toEqual({ line: "Ready", thought: "" });
    expect(cardText(IDLE_BUBBLE, "Cinder", "Working in Settings")).toEqual({ line: "Working in Settings", thought: "" });
  });

  it("shows the newest running task (with Stop), else one with Close", () => {
    const task = (id: string, status: TaskCard["status"], actions: TaskCard["actions"] = []): TaskCard => ({ id, title: id, status, detail: "", actions });
    expect(cardTask([])).toBeNull();
    expect(cardTask([task("a", "running", [{ id: "task:a:stop", label: "Stop" }]), task("b", "done")])?.id).toBe("a");
    expect(cardTask([task("a", "running"), task("b", "running")])?.id).toBe("b");
    expect(cardTask([task("a", "failed", [{ id: "task:a:dismiss", label: "Close" }]), task("b", "done")])?.id).toBe("a");
    expect(cardTask([task("b", "done")])).toBeNull();
  });
  it("shows the running task whose work the bubble shows, so its Stop stops what the user sees", () => {
    const task = (id: string, status: TaskCard["status"]): TaskCard => ({ id, title: `Task ${id}`, status, detail: "", actions: [] });
    const both = [task("a", "running"), task("b", "running")];
    expect(cardTask(both, { title: "Task a" })?.id).toBe("a");
    expect(cardTask(both, { title: "Cinder" })?.id).toBe("b");
    expect(cardTask([task("a", "done"), task("b", "running")], { title: "Task a" })?.id).toBe("b");
  });
  it("a question from the older of two tasks shows with that task's row and Stop, not the newer one's", () => {
    const task = (id: string, title: string): TaskCard => ({ id, title, status: "running", detail: "", actions: [{ id: `task:${id}:stop`, label: "Stop" }] });
    const both = [task("1", "Reply to Ana in Thunderbird"), task("2", "Fill in the Beta form")];
    // "May I?" names no task: the bubble's own task id says whose question it is.
    expect(cardTask(both, { title: "May I?", task: "1" })?.id).toBe("1");
    expect(cardTask(both, { title: "Reply to Ana in Thunderbird", task: "1" })?.id).toBe("1");
    // A bubble of a task that has finished: the newest one still under way, as before.
    expect(cardTask([{ ...both[0], status: "done" }, both[1]], { title: "May I?", task: "1" })?.id).toBe("2");
  });
});

describe("corner card with a task", () => {
  it("doesn't repeat the task's title in the bold line", () => {
    const b: BubbleState = { ...IDLE_BUBBLE, visible: true, mood: "acting", title: "Turn on Night Light", thought: "Opening Settings", streaming: true };
    expect(cardText(b, "Cinder", "Working in Settings", "Turn on Night Light")).toEqual({ line: "Working…", thought: "Opening Settings" });
    expect(cardText(b, "Cinder", null, "Something else").line).toBe("Turn on Night Light");
  });
});

describe("page styles that keep things readable and reachable", () => {
  const read = (f: string) => readFileSync(new URL(`../../app/renderer/${f}`, import.meta.url), "utf8");
  const home = read("home/styles.css"), page = read("home/index.html"), overlay = read("overlay/styles.css");
  /** WCAG contrast ratio of two #rrggbb colours. */
  const contrast = (a: string, b: string) => {
    const lum = (h: string) => {
      const [r, g, bl] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };

  it("keeps keyboard focus clear of the section links (WCAG 2.4.11)", () => {
    // Wide: the links are a fixed sidebar and the content starts past it, so nothing scrolls under them.
    const wide = home.slice(home.indexOf("@media (min-width: 640px) {"));
    const sidebar = Number(/\.home > \.jump \{\s*position: fixed; left: 0; top: 0; bottom: 0; width: (\d+)px;/.exec(wide)![1]);
    const inset = Number(/body:not\(\.first-run\) \.home \{[^}]*padding: \d+px \d+px \d+px (\d+)px;/.exec(wide)![1]);
    expect(inset).toBeGreaterThan(sidebar);
    // Narrow: one row that scrolls away with the page (never sticky).
    expect(home.slice(0, home.indexOf("@media (min-width: 640px) {"))).not.toMatch(/\.jump \{[^}]*position: sticky/);
  });

  it("wraps long names instead of widening the window or a task card", () => {
    expect(home).toMatch(/\.home > \* \{ min-width: 0; \}/);
    expect(home).toMatch(/\.plain-list li > span \{ min-width: 0; overflow-wrap: anywhere; \}/);
    expect(overlay).toMatch(/\.task \{[^}]*min-width: 0;/);
    expect(overlay).toMatch(/\.task b, \.task span \{ overflow-wrap: anywhere; \}/);
  });

  it("gives the never-look placeholder enough contrast and the folds clean names", () => {
    const bg = /--bg: (#[0-9a-f]{6})/.exec(home)![1];
    const placeholder = /\.add-row input::placeholder \{ color: (#[0-9a-f]{6})/.exec(home)![1];
    expect(contrast(placeholder, bg)).toBeGreaterThanOrEqual(4.5);
    expect(home).toMatch(/\.fold > summary::before \{\s*content: "" \/ "";/);
    for (const id of ["activity", "checks", "about"]) expect(page).toContain(`<details class="fold" id="${id}-fold" aria-labelledby="${id}-h">`);
  });
});

describe("What Ember did, review round 11", () => {
  it("says why a step didn't work without what Ember's model was told to do next (UI11-4, PR11-4)", () => {
    const t = "2026-10-16T12:00:00.000Z";
    const failed = (error: string) => describeEntry({ t, event: "action", kind: "cursor_text", ok: false, element: { role: "table cell", name: "A6" }, app: "soffice", error })?.why;
    expect(failed("Ember couldn't type into A6: A6 is protected (the sheet doesn't take changes there), so nothing was typed. Tell the user in finish_task. The cells after it (B6, A7) weren't typed."))
      .toBe("Ember couldn't type into A6: A6 is protected (the sheet doesn't take changes there), so nothing was typed. The cells after it (B6, A7) weren't typed.");
    expect(failed("The spreadsheet was too busy to be read in time, so Ember couldn't tell which cell has the keyboard, and nothing was typed. Call perceive_window and try again."))
      .toBe("The spreadsheet was too busy to be read in time, so Ember couldn't tell which cell has the keyboard, and nothing was typed.");
    expect(failed("Ember typed into B2. A cell may still be being edited: press Escape, call perceive_window, and try again.")).toBe("Ember typed into B2. A cell may still be being edited.");
    expect(failed("background_unavailable: this app takes no text this way")).toBe("this app takes no text this way");
    // A file name with underscores is the user's, and stays.
    expect(forUser("Couldn't open my_report.txt.")).toBe("Couldn't open my_report.txt.");
    expect(forUser("Call perceive_window and try again.")).toBeUndefined();
  });
});
