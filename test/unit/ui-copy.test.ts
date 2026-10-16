import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  NEVER_LOOK_DEFAULTS, dayLabel, describeEntry, friendlyApp, missingDefaults, neverLookLabel, progressStep, retryMessage, tagline, tokens, usageLine,
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
    expect(describeEntry({ t, event: "decision", verdict: "allow" })).toBeNull();
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

  it("keeps keyboard focus clear of the sticky section links", () => {
    expect(home).toMatch(/@media \(min-width: 640px\) \{[^}]*\.jump \{ position: sticky[^}]*\}\s*html \{ scroll-padding-top: calc\(var\(--jump-h, 46px\) \+ 10px\); \}/);
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
    expect(home).toMatch(/\.fold > summary::before \{ content: "▸" \/ "";/);
    for (const id of ["activity", "checks", "about"]) expect(page).toContain(`<details class="fold" id="${id}-fold" aria-labelledby="${id}-h">`);
  });
});
