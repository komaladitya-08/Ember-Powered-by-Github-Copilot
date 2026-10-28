import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  NEVER_LOOK_DEFAULTS, dayLabel, describeEntry, forUser, friendlyApp, keyLabel, missingDefaults, neverLookLabel, progressStep, retryMessage, tagline, tokens, usageLine,
} from "../../app/renderer/home/copy";
import { cardTask, cardText } from "../../app/renderer/handle/card";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import { HOST_OS } from "../../app/main/platform/os";
import { NEVER_LOOK_DEFAULTS as NEVER_LOOK_BY_OS } from "../../app/shared/never-look";
import { IDLE_BUBBLE, type BubbleState, type TaskCard } from "../../app/shared/overlay";
import * as commandCopy from "../../app/renderer/command/copy";
import * as promptCopy from "../../app/renderer/prompt/copy";
import * as computersCopy from "../../app/renderer/home/computers-copy";
import { cardBadge, shortWhere, targetBadge, targetChip, whereText } from "../../app/renderer/handle/badge";
import { radioLabel, targetMenu } from "../../app/renderer/handle/menu-copy";
import * as bubbleCopy from "../../app/renderer/overlay/target-copy";
import type { TargetSummary } from "../../app/shared/targets";
import type { Settings } from "../../app/main/settings";
import type { PromptCard } from "../../app/shared/remote-ui";

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

  it("offers more time to read and answer, beside Calm mode (review #51)", () => {
    const page = readFileSync(new URL("../../app/renderer/home/index.html", import.meta.url), "utf8");
    expect(page).toContain('<label class="switch-row"><input type="checkbox" id="more-time" role="switch"><span>More time to read and answer: messages stay ten times as long, and questions wait 20 minutes</span></label>');
    expect(DEFAULT_SETTINGS.moreTime).toBe(false);
  });

  it("keeps the tagline in step with setup, Copilot and where Ember is", () => {
    const base = { failing: 0, onboarded: true, phase: "ready", hidden: false, overlay: true };
    expect(tagline({ ...base, onboarded: false, phase: "signed-out" })).toBe("Read how Ember works, pick who keeps you company, then agree and press Start.");
    expect(tagline({ ...base, phase: "signed-out" })).toBe("Ember is beside your cursor. Connect Copilot below to start asking.");
    expect(tagline({ ...base, phase: "starting" })).toBe("Ember is beside your cursor. Connecting to Copilot…");
    expect(tagline(base)).toBe("Ember is beside your cursor. Press Ctrl+Alt+Space to ask it anything.");
    expect(tagline({ ...base, hidden: true })).toMatch(/^Ember is hidden for now\./);
    expect(tagline({ ...base, overlay: false })).toMatch(/^Ember is in the bottom-right corner\./);
    expect(tagline({ ...base, failing: 2 })).toBe("Ember needs 2 things fixed before it can work on this computer.");
    expect(tagline({ ...base, failing: 1 })).toBe("Ember needs 1 thing fixed before it can work on this computer.");
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
    expect([...NEVER_LOOK_BY_OS[HOST_OS]]).toEqual(DEFAULT_SETTINGS.privacy.neverLook);
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
    // A task waiting its turn is under way too: its card shows it, with its Stop (review #19), and its symbol is a
    // neutral clock, never the purple question of a task that needs the user.
    expect(cardTask([task("q", "queued", [{ id: "task:q:stop", label: "Stop" }]), task("d", "done")])?.id).toBe("q");
    const css = readFileSync(new URL("../../app/renderer/shared/ember.css", import.meta.url), "utf8");
    expect(css).toMatch(/\[data-status="queued"\] \{ --sym-tint: var\(--gray\); --sym: var\(--sym-queued\); \}/);
    expect(css).toMatch(/--sym-queued: url\("data:image\/svg\+xml,/);
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

// ───── SSH, WSL and commands (§8): every new string, sentence case, British spelling ─────

const NEW_STRINGS: string[] = [];
const keep = <T extends string>(s: T): T => { NEW_STRINGS.push(s); return s; };
/** Words that keep their capital inside a sentence. */
const PROPER = /^(Ember|Ember's|WSL|SSH|GitHub|Copilot|PowerShell|Windows|Windows'|Linux|Ubuntu|Ubuntu's|Mac|Mac's|Desktop|Documents|Downloads|System|Settings|General|Sharing|Remote|Login|Podman|Stop|Allow|Ctrl\+Alt\+X\.?|Win\+Alt\+X\.?|Control\+Shift\+Command\+X\.?|Ctrl\+Alt\+Y|Ctrl\+Alt\+N|Ctrl\+Alt\+E|Alt\+Tab|Computers\.?|Commands\.?|U\+[0-9A-F]+|I|I'll|OK|SHA256:abc|RLO|ZWSP|NBSP|ⓘ\)?\.?)$/;

describe("the command window's words (§8.5)", () => {
  const exit = (e: Partial<Parameters<typeof commandCopy.statusLine>[0]>) => ({ code: 0, signal: null, ended: "exit" as const, ms: 3200, ...e });
  const say = (e: Partial<Parameters<typeof commandCopy.statusLine>[0]>, os: "linux" | "win32" | "darwin" = "linux") => keep(commandCopy.statusLine(exit(e), { label: "build-01", os }));

  it("names the window, its empty state, the card and its buttons exactly", () => {
    expect(keep(commandCopy.WINDOW_TITLE)).toBe("Ember commands");
    expect(keep(commandCopy.EMPTY_TEXT)).toBe("No commands yet.");
    expect(keep(commandCopy.ASK_HEADING)).toBe("Ember wants to run this command");
    expect(keep(commandCopy.ANNOUNCE_HEADING)).toBe("Running this, as you asked");
    expect([commandCopy.ALLOW_LABEL, commandCopy.NOT_NOW_LABEL, commandCopy.STOP_LABEL, commandCopy.CLOSE_LABEL].map(keep)).toEqual(["Allow", "Not now", "Stop", "Close"]);
    expect(keep(commandCopy.READ_ALL_HINT)).toBe("Read the whole command to allow it.");
    expect(keep(commandCopy.LEGEND_TOKENS)).toBe("Characters you wouldn't see are shown in ⟨ ⟩.");
    expect(keep(commandCopy.LEGEND_MIXED)).toBe("Letters from another alphabet are underlined.");
    // A unit never wraps away from its number (review #227).
    expect(keep(commandCopy.countdownText(10_000, 6_000))).toBe("Starts in 4\u00a0s.");
    expect(commandCopy.countdownText(10_000, 9_001)).toBe("Starts in 1\u00a0s.");
    expect(commandCopy.countdownText(10_000, 12_000)).toBe("Starts in 0\u00a0s.");
  });

  it("says where a command runs in the header", () => {
    const base = { shell: "bash" as const, cwd: "~/src/app" };
    expect(keep(commandCopy.headerLine({ ...base, target: "ssh:build-01", targetLabel: "build-01", login: "deploy" }))).toBe("On build-01 as deploy · bash · in ~/src/app");
    expect(keep(commandCopy.headerLine({ target: "local", targetLabel: "This computer", shell: "powershell", cwd: "C:\\Users\\ana\\project" }))).toBe("On this computer · PowerShell · in C:\\Users\\ana\\project");
    expect(keep(commandCopy.headerLine({ target: "wsl:Ubuntu", targetLabel: "Ubuntu (WSL)", shell: "bash", cwd: "~/project" }))).toBe("In Ubuntu (WSL) · bash · in ~/project");
  });

  it("says how a run ended in its status line", () => {
    expect(keep(commandCopy.RUNNING_STATUS)).toBe("Running…");
    expect(say({ ms: 3200 })).toBe("Finished in 3.2\u00a0s.");
    expect(say({ code: 2, ms: 1100 })).toBe("Ended with exit code 2 after 1.1\u00a0s.");
    expect(say({ ended: "stopped-user", code: null, ms: 12_000 })).toBe("You stopped it after 12\u00a0s. What it already changed stays.");
    expect(say({ ended: "killswitch", code: null, ms: 2000 })).toBe("Stopped by Ctrl+Alt+X after 2\u00a0s. What it already changed stays.");
    expect(say({ ended: "timeout", code: null, ms: 120_000 })).toBe("Stopped after 2\u00a0min: it took too long.");
    expect(say({ ended: "lost", code: null })).toBe("The connection to build-01 dropped; the command was stopped there.");
    expect(say({ ended: "failed-to-start", code: null, error: "bash isn't installed on build-01." })).toBe("Couldn't start: bash isn't installed on build-01.");
    expect(say({ ended: "refused-remote", code: null, error: "its policy turns commands off" })).toBe("build-01 refused it: its policy turns commands off.");
    expect(say({ ended: "stopped-task", code: null, ms: 900 })).toBe("Stopped with its task after 0.9\u00a0s. What it already changed stays.");
    expect(say({ ended: "exit", code: null, signal: "SIGKILL", ms: 61_000 })).toBe("Ended by SIGKILL after 1\u00a0min 1\u00a0s.");
    expect(say({ ms: 500, ...{ stragglers: ["make"] } } as never)).toBe("Finished in 0.5\u00a0s. 1 program it started is still running: make.");
    expect(keep(commandCopy.stragglerText(["a", "b"]))).toBe("2 programs it started are still running: a, b.");
    expect(commandCopy.durationText(9_960)).toBe("10\u00a0s");
    expect(commandCopy.durationText(59_600)).toBe("1\u00a0min");
    expect(commandCopy.durationText(2_000)).toBe("2\u00a0s");
  });

  it("says whether typing reaches the command, and what it waits for", () => {
    expect(keep(commandCopy.typingHint({ interactive: true, ended: false }))).toBe("Type here to answer the command. Ember never sees what you type.");
    expect(keep(commandCopy.typingHint({ interactive: false, ended: false }))).toBe("This command can't take typing here.");
    expect(commandCopy.typingHint({ interactive: true, ended: true })).toBe("");
    expect(keep(commandCopy.startingText("Ubuntu"))).toBe("Starting Ubuntu…");
    // In a sentence the unit is a word (review #227).
    expect(keep(commandCopy.stalledText("build-01", 20))).toBe("build-01 isn't answering. This command stops in 20 seconds unless it answers again.");
    expect(commandCopy.stalledText("build-01", 1)).toBe("build-01 isn't answering. This command stops in 1 second unless it answers again.");
  });

  it("labels a tab with the first 40 characters of its command", () => {
    expect(commandCopy.tabLabel("git status")).toBe("git status");
    expect(commandCopy.tabLabel("x".repeat(41))).toBe(`${"x".repeat(40)}…`);
    expect(commandCopy.tabLabel("make\n  test")).toBe("make test");
  });

  it("puts \"You didn't ask for this.\" where §3.8.4 puts it, and the model's reason apart", () => {
    expect(commandCopy.cardLines({ says: ["Deletes build and everything in it."], unasked: true }))
      .toEqual({ lines: ["Deletes build and everything in it.", "You didn't ask for this."], why: null });
    expect(commandCopy.cardLines({ says: ["Deletes x.", "This can reach your Windows files.", "Why: \"tidy up\""], unasked: true }))
      .toEqual({ lines: ["Deletes x.", "You didn't ask for this.", "This can reach your Windows files."], why: "Why: \"tidy up\"" });
    expect(commandCopy.cardLines({ says: ["You didn't ask for this."], unasked: true }).lines).toEqual(["You didn't ask for this."]);
    expect(keep(commandCopy.UNASKED_LINE)).toBe("You didn't ask for this.");
  });
});

describe("the prompt window's words (§8.6)", () => {
  const text = (card: PromptCard) => {
    const v = promptCopy.promptView(card);
    const body = v.body.map(b => (b.kind === "p" ? promptCopy.partsText(b.parts) : b.text));
    return { title: keep(promptCopy.partsText(v.title)), body: body.map(keep), field: v.field?.label ?? null, buttons: v.buttons.map(b => keep(b.label)) };
  };

  it("asks about a new host key, and refuses a changed one", () => {
    expect(text({ id: "1", kind: "host-key", host: "build-01", address: "203.0.113.7", fingerprint: "SHA256:abc" })).toEqual({
      title: "Is this really build-01?",
      body: ["This computer hasn't connected to build-01 (203.0.113.7) before. Its key's fingerprint is:", "SHA256:abc", "Check it with whoever looks after build-01 before you trust it."],
      field: null, buttons: ["Trust and connect", "Cancel"],
    });
    expect(text({ id: "2", kind: "host-key-changed", host: "build-01" })).toEqual({
      title: "build-01's identity changed",
      body: ["The key build-01 shows isn't the one this computer knows. Someone may be pretending to be build-01, or it was reinstalled. Ember won't connect. If you know why it changed, remove the old key in a terminal with ssh-keygen -R build-01, then connect again."],
      field: null, buttons: ["Close"],
    });
  });

  it("asks for a password, on the way through a jump host too, and a key's passphrase", () => {
    expect(text({ id: "3", kind: "secret", secret: "password", host: "build-01", login: "deploy", prompt: "deploy@build-01's password: " })).toEqual({
      title: "Sign in to build-01",
      body: ["Password for deploy on build-01. Ember hands it to SSH only: it's never saved, logged or sent to Copilot."],
      field: "Password", buttons: ["Sign in", "Cancel"],
    });
    expect(text({ id: "4", kind: "secret", secret: "password", host: "build-01", via: "bastion", prompt: "ana@bastion's password: " }).title).toBe("Sign in to bastion on the way to build-01");
    expect(text({ id: "5", kind: "secret", secret: "passphrase", host: "build-01", prompt: "Enter passphrase for key '~/.ssh/id_ed25519': " })).toEqual({
      title: "Unlock your SSH key",
      body: ["Passphrase for ~/.ssh/id_ed25519. Ember hands it to SSH only: it's never saved, logged or sent to Copilot."],
      field: "Passphrase", buttons: ["Unlock", "Cancel"],
    });
    expect(promptCopy.keyFileOf("Enter passphrase for /home/ana/.ssh/id_rsa:")).toBe("/home/ana/.ssh/id_rsa");
    expect(promptCopy.keyFileOf("Password:")).toBeNull();
  });

  it("asks for a code, a touch, or anything else ssh asks, quoting it", () => {
    expect(text({ id: "6", kind: "secret", secret: "code", host: "build-01", prompt: "Verification code: " })).toEqual({
      title: "Verification code for build-01", body: ["build-01 asks:", "Verification code: "], field: "Code", buttons: ["Send", "Cancel"],
    });
    expect(text({ id: "7", kind: "touch", host: "build-01" })).toEqual({
      title: "Touch your security key", body: ["Touch your security key to connect to build-01."], field: null, buttons: ["Cancel"],
    });
    expect(text({ id: "8", kind: "secret", secret: "other", host: "build-01", prompt: "PIN for token:" })).toEqual({
      title: "build-01 asks", body: ["PIN for token:"], field: "Answer", buttons: ["Send", "Cancel"],
    });
    expect(promptCopy.promptView({ id: "8", kind: "secret", secret: "other", host: "build-01", prompt: "x" }).field?.masked).toBe(true);
  });
});

describe("the first-use consent cards (§8.4)", () => {
  it("asks about WSL in exactly these words", () => {
    const c = promptCopy.consentText({ feature: "wsl", os: "win32", target: "wsl:Ubuntu", targetLabel: "Ubuntu (WSL)" });
    expect(keep(c.title)).toBe("Use Ember with WSL?");
    expect(c.body.map(keep)).toEqual([
      "Ember will start a small helper inside each WSL distro that has a Linux app open, so it can read and use those apps the way it reads your other windows. It runs only while a Linux app is open, and never starts a distro on its own.",
      "When you ask something, what Ember read goes to GitHub Copilot, as it does for your other windows.",
      "Ember can also run commands in WSL if you turn commands on for it. Commands in WSL can reach your Windows files and programs.",
    ]);
    expect([c.yes, c.no].map(keep)).toEqual(["Turn on", "Not now"]);
  });

  const ssh = (over: Partial<promptCopy.SshConsentFacts> = {}) => promptCopy.consentText({
    feature: "ssh", os: "linux", target: "ssh:build-01", targetLabel: "build-01",
    ssh: { login: "deploy", hostname: "build-01.example.com", port: 22, jump: ["jump-host"], desktop: "screen", ...over },
  });

  it("asks to bring Ember to a host, naming how it connects and what it leaves there", () => {
    const c = ssh();
    expect(keep(c.title)).toBe("Bring Ember to build-01?");
    expect(c.body.map(keep)).toEqual([
      "Ember will connect to build-01 as deploy (deploy@build-01.example.com, port 22, through jump-host) with your own SSH settings and keys.",
      "It copies a small helper there: about 31 MB, unpacked to about 125 MB in ~/.local/share/ember-remote. It runs only while Ember is connected and stops when you disconnect, quit Ember or press Ctrl+Alt+X. If the connection drops, a command running there stops within 20 seconds.",
      "Your voice and your GitHub sign-in stay on this computer. Ember sends build-01 only the steps it takes there and the commands it runs. What it reads there goes to GitHub Copilot from this computer when you ask something.",
      "On build-01's screen it reads and uses apps only when deploy is the person logged in there, and shows a notice with a Stop button while it does. You'll be asked before every step it takes there.",
      "build-01 keeps its own record of what Ember does there.",
    ]);
    expect([c.yes, c.no]).toEqual(["Connect", "Not now"]);
  });

  it("names the options carried over from the user's own ssh, and a connection through WSL", () => {
    expect(keep(ssh({ jump: [], identityFiles: ["~/.ssh/work_ed25519"], configFile: "~/.ssh/work_config" }).body[0]))
      .toBe("Ember will connect to build-01 as deploy (deploy@build-01.example.com, port 22) with your own SSH settings and keys. It uses the key ~/.ssh/work_ed25519 and the settings file ~/.ssh/work_config, as your own ssh did.");
    expect(ssh({ jump: ["a", "b"], identityFiles: ["k1", "k2"] }).body[0]).toContain("through a and b) with your own SSH settings and keys. It uses the keys k1 and k2, as your own ssh did.");
    expect(keep(ssh({ jump: [], viaDistro: "Ubuntu" }).body[0])).toMatch(/ It connects from Ubuntu \(WSL\), with Ubuntu's SSH keys\.$/);
  });

  it("says what Ember can do with each kind of remote screen", () => {
    expect(keep(ssh({ desktop: "headless" }).body[3])).toBe("build-01 has no desktop, so Ember will only run commands there.");
    expect(keep(ssh({ desktop: "remote-session" }).body[3])).toBe("build-01's desktop is a remote session: Ember will run commands only.");
    expect(keep(ssh({ desktop: "wsl" }).body[3])).toBe("build-01 is WSL on another computer: its Linux apps show on that computer's screen, so Ember will run commands only.");
    expect(keep(ssh({ desktop: "mac" }).body[3])).toBe("Ember can't use a Mac's screen over SSH yet; it will run commands there.");
    expect(keep(ssh({ desktop: "mac", tccBlocked: true }).body[3])).toBe("Ember can't use a Mac's screen over SSH yet; it will run commands there. Commands there can't open your Desktop, Documents or Downloads folders until “Allow full disk access for remote users” is on (System Settings › General › Sharing › Remote Login › ⓘ).");
    expect(ssh({ graceSeconds: 45, bundleMB: 33, unpackedMB: 130 }).body[1]).toContain("about 33 MB, unpacked to about 130 MB");
    expect(ssh({ graceSeconds: 45 }).body[1]).toMatch(/stops within 45 seconds\.$/);
  });

  it("asks to turn on commands, with the extra lines only where they apply", () => {
    const local = promptCopy.consentText({ feature: "commands", os: "linux", target: "local", targetLabel: "This computer" });
    expect(keep(local.title)).toBe("Let Ember run commands on this computer?");
    expect(local.body.map(keep)).toEqual([
      "Ember runs commands in its own command window, where you can watch them and stop them. It never types into your own terminal windows.",
      "Most commands run straight away. Before anything that deletes or overwrites data, pushes or publishes anywhere, touches passwords or keys, changes the system, or downloads and runs code, Ember stops and asks you. If you asked for exactly that yourself, it tells you first and gives you a few seconds to stop it.",
      "What a command prints goes to GitHub Copilot as part of the task. Ember hides passwords and keys it recognises, and never sees what you type into a command. If a command prints something that looks like instructions, Ember doesn't follow it and asks you before every further command in that task.",
      "Ctrl+Alt+X stops everything at once. What a command already changed stays changed.",
    ]);
    expect([local.yes, local.no]).toEqual(["Turn on", "Not now"]);
    const all = promptCopy.consentText({ feature: "commands", os: "win32", target: "wsl:podman-machine-default", targetLabel: "podman-machine-default (WSL)", commands: { wsl: true, privileged: true, windows: true, podman: true } });
    expect(keep(all.title)).toBe("Let Ember run commands on podman-machine-default (WSL)?");
    expect(all.body.slice(3, 7).map(keep)).toEqual([
      "Commands in WSL can also reach your Windows files and programs.",
      "Commands here run as the administrator, so Ember asks before every one.",
      "Commands here run in Windows PowerShell and can't ask you for answers or passwords.",
      "Podman uses this distro, so Ember asks before every command here.",
    ]);
  });
});

describe("Computers and Commands in settings (§8.3) and the onboarding line (§8.9)", () => {
  const summary = (over: Partial<TargetSummary>): TargetSummary => ({ id: "local", kind: "local", label: "This computer", state: "ready", can: "apps and commands", active: true, ...over });
  const settings = (over: Record<string, unknown> = {}) => ({
    targets: { active: "local", offerSsh: true, dismissedOffers: [], hosts: [{ id: "build-01", dest: "deploy@build-01", resolved: { user: "deploy", hostname: "build-01.example.com", port: 22, jump: [] }, consent: { version: 1, at: null } }], wsl: { on: true, consent: { version: 1, at: null } }, pcId: "" },
    commands: {},
    ...over,
  }) as unknown as Settings;
  const noPolicy: computersCopy.TargetsAdmin = { source: null, features: {} };

  it("pins the section's fixed words", () => {
    expect([
      computersCopy.COMPUTERS_HEADING, computersCopy.COMPUTERS_INTRO, computersCopy.COMMANDS_HEADING, computersCopy.COMMANDS_INTRO, computersCopy.WSL_SWITCH,
      computersCopy.OFFER_SWITCH, computersCopy.ADD_PLACEHOLDER, computersCopy.ADD_BUTTON, computersCopy.ASK_EVERY_SWITCH, computersCopy.OPEN_COMMANDS,
      computersCopy.WSL_MANAGED, computersCopy.SSH_MANAGED, computersCopy.SSH_LIMITED, computersCopy.ASK_EVERY_MANAGED, computersCopy.ADD_INVALID, computersCopy.ACT_FAILED,
    ].map(keep)).toEqual([
      "Computers", "Ember can work on this computer, in WSL, and on computers you reach over SSH. Your voice and your GitHub sign-in always stay here.",
      "Commands", "Ember runs commands in its own command window, where you can watch and stop them. It asks first before anything that deletes, publishes, touches secrets or changes the system.",
      "Let Ember work in WSL", "Offer to bring Ember along when I connect with ssh", "An SSH host, e.g. build-01 or deploy@build-01.example.com", "Connect",
      "Ask me before every command", "Open the command window", "Your organisation doesn't allow Ember to work in WSL.",
      "Your organisation doesn't allow Ember on other computers.", "Your organisation lets Ember connect only to some computers.",
      "Your organisation asks you to approve every command here.", "Type a host name, or user@host.", "That didn't work. Try again.",
    ]);
  });

  it("lists this computer, the distros on Windows and each host with its state and buttons", () => {
    const v = computersCopy.computersView({
      os: "win32", settings: settings({ commands: { local: { on: true, askEvery: false, consent: { version: 1, at: null } } } }), admin: noPolicy,
      summaries: [summary({}), summary({ id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)", state: "off", can: "commands only" }), summary({ id: "ssh:build-01", kind: "ssh", label: "build-01", state: "ready", can: "apps and commands" })],
    });
    expect(keep(v.local.status)).toBe("Apps and commands");
    expect(v.wsl?.rows.map(r => [r.name, keep(r.status), r.note])).toEqual([["Ubuntu (WSL)", "Stopped", "Commands only"]]);
    expect(v.wsl?.toggle).toEqual({ label: "Let Ember work in WSL", checked: true, disabled: false });
    expect(v.ssh.rows[0]).toMatchObject({ name: "build-01", detail: "deploy@build-01.example.com", status: "Connected: apps and commands" });
    expect(v.ssh.rows[0].actions.map(a => keep(a.label))).toEqual(["Disconnect", "Forget", "Remove Ember from build-01"]);
    expect(keep(v.ssh.rows[0].actions[2].confirm!)).toBe("Remove Ember's helper from build-01? Its record of what Ember did there stays on build-01.");
    const statusOf = (state: TargetSummary["state"]) => computersCopy.computersView({ os: "linux", settings: settings(), admin: noPolicy, summaries: [summary({ id: "ssh:build-01", kind: "ssh", label: "build-01", state, can: "commands only" })] }).ssh.rows[0].status;
    expect(["connecting", "lost", "off"].map(s => keep(statusOf(s as TargetSummary["state"])))).toEqual(["Connecting…", "Lost: trying again", "Not connected"]);
    expect(statusOf("ready")).toBe("Connected: commands only");
    // Why the last connection failed stays on the row once the bubble has gone (review #183).
    const failed = (state: TargetSummary["state"]) => computersCopy.computersView({ os: "linux", settings: settings(), admin: noPolicy, summaries: [summary({ id: "ssh:build-01", kind: "ssh", label: "build-01", state, can: "", problem: "Ember can't find build-01." })] }).ssh.rows[0].note;
    expect(failed("off")).toBe("Ember can't find build-01.");
    expect(failed("ready")).toBeNull();
    const linux = computersCopy.computersView({ os: "linux", settings: settings(), admin: noPolicy, summaries: [summary({})] });
    expect(linux.wsl).toBeNull();
    expect(keep(linux.local.status)).toBe("Apps");
  });

  it("says what the organisation turned off, and offers nothing it doesn't allow", () => {
    const v = computersCopy.computersView({ os: "win32", settings: settings(), admin: { source: "/etc/ember/policy.json", features: { wsl: false, ssh: false } }, summaries: [summary({})] });
    expect(v.wsl).toEqual({ rows: [], toggle: null, managed: "Your organisation doesn't allow Ember to work in WSL." });
    expect(v.ssh).toMatchObject({ add: false, offer: null, managed: ["Your organisation doesn't allow Ember on other computers."] });
    expect(v.ssh.rows[0].actions.map(a => a.label)).toEqual(["Forget"]);
    const limited = computersCopy.computersView({ os: "linux", settings: settings(), admin: { source: "p", features: {}, sshHostsLimited: true }, summaries: [] });
    expect(limited.ssh.managed).toEqual(["Your organisation lets Ember connect only to some computers."]);
  });

  it("gives every target its commands switch, and the organisation's lines", () => {
    const summaries = [summary({}), summary({ id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)" }), summary({ id: "ssh:build-01", kind: "ssh", label: "build-01" })];
    const on = { on: true, askEvery: false, consent: { version: 1, at: null } };
    const v = computersCopy.commandsView({ summaries, settings: settings({ commands: { local: on, "ssh:build-01": { ...on, askEvery: true } } }), admin: noPolicy });
    expect(v.rows.map(r => keep(r.run.label))).toEqual(["Run commands on this computer", "Run commands in Ubuntu (WSL)", "Run commands on build-01"]);
    expect(v.rows.map(r => [r.run.checked, r.askEvery.shown, r.askEvery.checked])).toEqual([[true, true, false], [false, false, false], [true, true, true]]);
    expect(v.managed).toEqual([]);
    const managed = computersCopy.commandsView({ summaries, settings: settings({ commands: { local: on } }), admin: { source: "p", features: {}, commands: { local: "ask", wsl: "off", ssh: "off" } } });
    expect(managed.managed.map(keep)).toEqual(["Your organisation has turned off commands in WSL.", "Your organisation has turned off commands on computers reached over SSH."]);
    expect(managed.rows[0]).toMatchObject({ managed: "Your organisation asks you to approve every command here.", askEvery: { checked: true, disabled: true } });
    expect(managed.rows[1].run.disabled).toBe(true);
    const local = computersCopy.commandsView({ summaries: [summary({})], settings: settings({ targets: { hosts: [], wsl: { on: false } } }), admin: { source: "p", features: {}, commands: { local: "off" } } });
    expect(keep(local.managed[0])).toBe("Your organisation has turned off commands on this computer.");
    // WSL distros are listed for commands only once WSL is on.
    expect(computersCopy.commandsView({ summaries, settings: settings({ targets: { hosts: [], wsl: { on: false } } }), admin: noPolicy }).rows.map(r => r.id)).toEqual(["local", "ssh:build-01"]);
  });

  it("knows the commands mode only from what main sent, or from there being no policy at all (R5)", () => {
    expect(computersCopy.modeFor(noPolicy, "local")).toBe("on");
    expect(computersCopy.modeFor({ source: "p", features: {} }, "local")).toBeNull();
    expect(computersCopy.modeFor({ source: "p", features: { ssh: false }, commands: { ssh: "on" } }, "ssh")).toBe("off");
    expect(computersCopy.hostInput(" deploy@build-01 ")).toBe("deploy@build-01");
    for (const bad of ["", "a b", "-oProxyCommand=x", "x".repeat(256)]) expect(computersCopy.hostInput(bad)).toBeNull();
    expect(computersCopy.actMessage({ ok: false, message: "build-01 isn't connected." })).toBe("build-01 isn't connected.");
    expect(computersCopy.actMessage(undefined)).toBeNull();
  });

  it("adds the onboarding line to \"Before Ember starts\" exactly", () => {
    const page = readFileSync(new URL("../../app/renderer/home/index.html", import.meta.url), "utf8");
    const l = computersCopy.ONBOARDING_LINE;
    expect(page).toContain(`<li data-icon="plug"><b>${l.lead}</b>${l.rest}</li>`);
    expect(keep(`${l.lead}${l.rest}`)).toBe("Other computers and commands are off until you turn them on: Ember can work in WSL, on computers you reach over SSH, and run commands in its own window. Each asks you first.");
    for (const s of [computersCopy.COMPUTERS_INTRO, computersCopy.COMMANDS_INTRO, computersCopy.WSL_SWITCH, computersCopy.OFFER_SWITCH, computersCopy.ADD_PLACEHOLDER, computersCopy.OPEN_COMMANDS]) {
      expect(page).toContain(s);
    }
  });
});

describe("where Ember works, on the floating layer (§8.1, §2.4)", () => {
  const t = (over: Partial<TargetSummary>): TargetSummary => ({ id: "ssh:build-01", kind: "ssh", label: "build-01", state: "ready", can: "", active: true, ...over });

  it("badges the handle only for another computer, naming it and its state", () => {
    expect(targetBadge(undefined)).toBeNull();
    expect(targetBadge(t({ id: "local", kind: "local", label: "This computer" }))).toBeNull();
    expect(targetBadge(t({}))).toEqual({ text: "build-01", state: "ready", label: "Working on build-01" });
    expect(keep(targetBadge(t({ state: "connecting" }))!.label)).toBe("Working on build-01 (connecting…)");
    expect(targetBadge(t({ state: "lost" }))).toMatchObject({ state: "lost", label: "Working on build-01 (lost)" });
    expect(targetBadge(t({ state: "off" }))?.state).toBe("off");
    expect(targetBadge(t({ state: "unavailable" }))?.state).toBe("off");
  });

  it("puts \"On build-01\" or \"In Ubuntu (WSL)\" in the ask box, and the where words on cards as given", () => {
    expect(keep(targetChip(t({}))!)).toBe("On build-01");
    expect(keep(targetChip(t({ id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)" }))!)).toBe("In Ubuntu (WSL)");
    expect(targetChip(t({ id: "local", kind: "local", label: "This computer" }))).toBeNull();
    expect(targetChip(null)).toBeNull();
    expect(whereText("on  build-01 ")).toBe("on build-01");
    expect(whereText("")).toBeNull();
    expect(whereText(undefined)).toBeNull();
  });

  it("shortens a long place in the bubble's badge from the middle, keeping the host's start and end (review #16)", () => {
    expect(shortWhere("on build-01")).toBe("on build-01");
    expect(shortWhere("on ip-10-0-12-34.eu-west-1.compute.internal")).toBe("on ip-10-0-…internal");
    expect(shortWhere("in Ubuntu-22.04 (WSL)")).toBe("in Ubuntu-2…04 (WSL)");
    expect(shortWhere(undefined)).toBeNull();
  });

  it("badges the corner card with where the bubble's work is, before the picker's choice (review #13)", () => {
    expect(cardBadge({ where: "on build-01", task: true }, null)).toEqual({ text: "on build-01", state: "ready", label: "Working on build-01" });
    // A task bound to this computer says nothing, whatever the picker's choice: never "build-01" beside a question about this PC.
    expect(cardBadge({ task: true }, t({}))).toBeNull();
    // The conversation's bubble (no task) keeps the picker's badge.
    expect(cardBadge({ task: false }, t({}))).toEqual(targetBadge(t({})));
  });
});

describe("the handle menu's computers (§8.1)", () => {
  const t = (over: Partial<TargetSummary>): TargetSummary => ({ id: "local", kind: "local", label: "This computer", state: "ready", can: "", active: false, ...over });
  const labels = (items: ReturnType<typeof targetMenu>): unknown[] => items.map(i => (i.type === "separator" ? "—" : i.type === "submenu" ? [i.label, labels(i.submenu)] : i.label));

  it("adds nothing with only this computer and SSH off, so the menu is as it was", () => {
    expect(targetMenu({ summaries: [t({ active: true })], sshAllowed: false })).toEqual([]);
  });

  it("offers \"Bring Ember to a computer…\" while SSH is allowed, and \"Work on\" once there are two targets", () => {
    expect(labels(targetMenu({ summaries: [t({ active: true })], sshAllowed: true })).map(x => keep(x as string))).toEqual(["Bring Ember to a computer…"]);
    const items = targetMenu({
      sshAllowed: true,
      summaries: [t({ id: "ssh:build-01", kind: "ssh", label: "build-01", state: "ready", active: true }), t({}), t({ id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)", state: "off" }), t({ id: "ssh:db", kind: "ssh", label: "db", state: "lost" })],
    });
    expect(labels(items)).toEqual([["Work on", ["This computer", "build-01", "Ubuntu (WSL)", "db (lost)"]], "—", "Bring Ember to a computer…", "Disconnect build-01"]);
    keep("Work on");
    keep("Disconnect build-01");
    const sub = (items[0] as Extract<(typeof items)[number], { type: "submenu" }>).submenu as Extract<(typeof items)[number], { type: "radio" }>[];
    expect(sub.map(r => [r.checked, r.enabled, r.activate])).toEqual([[false, true, "local"], [true, true, "ssh:build-01"], [false, true, "wsl:Ubuntu"], [false, false, "ssh:db"]]);
    expect(items.at(-1)).toEqual({ type: "normal", label: "Disconnect build-01", action: "disconnect", hostId: "build-01" });
    expect(keep(radioLabel({ label: "build-01", state: "connecting" }))).toBe("build-01 (connecting…)");
  });
});

describe("the bubble's words for computers and commands (§8.2)", () => {
  const all = (w: bubbleCopy.BubbleWords) => [keep(w.title), keep(w.text), ...w.actions.map(a => keep(a.label))].filter(Boolean);

  it("holds only words the app shows: the targets runtime and the presenter build their bubbles from every one (review #24)", () => {
    const [runtime, presenter] = ["main/targets/runtime.ts", "main/agent/presenter.ts"].map(f => readFileSync(new URL(`../../app/${f}`, import.meta.url), "utf8"));
    const imported = /import \{([^}]*)\} from "\.\.\/\.\.\/renderer\/overlay\/target-copy"/.exec(presenter)?.[1] ?? "";
    expect(runtime).toContain('import * as words from "../../renderer/overlay/target-copy"');
    for (const name of Object.keys(bubbleCopy)) {
      expect(runtime.includes(`words.${name}(`) || (new RegExp(`\\b${name}\\b`).test(imported) && presenter.includes(`${name}(`)), name).toBe(true);
    }
  });

  it("offers to bring Ember along, and says how connecting goes", () => {
    expect(all(bubbleCopy.sshSeen("build-01"))).toEqual(["You're connected to build-01", "Bring me there too? I'll open my own connection with your SSH settings.", "Bring Ember", "Not now", "Don't offer again"]);
    expect(bubbleCopy.sshSeen("build-01").actions[0].primary).toBe(true);
    expect(all(bubbleCopy.sshSeenInWsl("build-01", "Ubuntu"))).toEqual(["You're connected to build-01 from Ubuntu", "I connect with Windows' SSH. Add your key to Windows' ssh-agent, or connect once from PowerShell, then bring me there.", "Not now", "Don't offer again"]);
    expect(all(bubbleCopy.offerConnect("build-01"))).toEqual(["Connect to build-01?", "You asked for build-01. I'm not connected to it yet.", "Connect", "Not now"]);
    expect(all(bubbleCopy.connecting("build-01", { step: "checking" }))).toEqual(["Connecting to build-01…", "Checking build-01…", "Cancel"]);
    expect(keep(bubbleCopy.connecting("build-01", { step: "downloading", doneMB: 12, totalMB: 29 }).text)).toBe("Downloading what I need for build-01 (12 of 29 MB)…");
    expect(keep(bubbleCopy.connecting("build-01", { step: "copying", doneMB: 5.2, totalMB: 31 }).text)).toBe("Copying what I need to build-01 (5 of 31 MB)…");
    expect(keep(bubbleCopy.connecting("build-01", { step: "starting" }).text)).toBe("Starting up on build-01…");
    expect(all(bubbleCopy.connected("build-01", "desktop"))).toEqual(["I'm on build-01", "Ask away: I'll work there. Your voice and your sign-in stay on this computer."]);
    expect(keep(bubbleCopy.connected("build-01", "commands").text)).toBe("build-01 has no desktop, so I'll run commands there.");
    expect(all(bubbleCopy.connected("build-01", "commands-off"))).toEqual(["I'm on build-01", "build-01 has no desktop, and commands are off there. Turn them on so I can work there.", "Turn on commands"]);
    expect(keep(bubbleCopy.connected("build-01", "commands-off-by-admin").text)).toBe("build-01 has no desktop, and your organisation has turned off commands there, so I can't work on it.");
    expect(all(bubbleCopy.commandsOn("build-01"))).toEqual(["Commands are on for build-01", "Ask away: I'll run commands there."]);
    expect(all(bubbleCopy.commandsStayOff("build-01", "Not allowed."))).toEqual(["Commands stay off on build-01", "Not allowed."]);
    expect(all(bubbleCopy.cantConnect("build-01", "Ember can't reach build-01.", true))).toEqual(["Can't connect to build-01", "Ember can't reach build-01.", "Try again", "Close"]);
    expect(bubbleCopy.cantConnect("build-01", "x", false).actions).toEqual([{ label: "Close" }]);
    expect(keep(bubbleCopy.identityChanged("build-01"))).toBe("build-01's identity changed, so I won't connect. The window that opened says what to do.");
  });

  it("says when a connection stalls, drops or ends, and when Ember is back here", () => {
    expect(all(bubbleCopy.stalled("build-01", 15))).toEqual(["build-01 isn't answering", "Commands running there stop in 15 seconds unless it answers again. I'll send nothing new until then.", "Disconnect"]);
    expect(keep(bubbleCopy.stalled("build-01", 1).text)).toBe("Commands running there stop in 1 second unless it answers again. I'll send nothing new until then.");
    expect(all(bubbleCopy.lost("build-01", false))).toEqual(["Lost build-01", "The connection dropped, so everything there stopped. I'll try to reconnect.", "Reconnect", "Stop trying"]);
    expect(keep(bubbleCopy.lost("build-01", true).text)).toBe("The connection dropped, so everything there stopped. I'll try to reconnect; until then I'll work on this computer.");
    expect(all(bubbleCopy.backThere("build-01", true))).toEqual(["build-01 is back", "The connection came back, so I'll work there again."]);
    expect(keep(bubbleCopy.backThere("build-01", false).text)).toBe("The connection came back.");
    expect((["dropped", "closed", "stopped-there", "locked", "inactive"] as const).map(c => keep(bubbleCopy.stoppedTask("build-01", c)))).toEqual([
      "build-01's connection dropped, so I stopped this.", "build-01 isn't connected any more, so I stopped this.", "Someone at build-01 pressed Stop.",
      "build-01's screen locked, so I stopped this.", "build-01's desktop session isn't active any more, so I stopped this.",
    ]);
    expect(all(bubbleCopy.signInAgain("build-01"))).toEqual(["build-01 needs you to sign in again", "Reconnect to sign in.", "Reconnect"]);
    expect(all(bubbleCopy.cameBackDifferent("build-01"))).toEqual(["Lost build-01", "build-01 came back as a different computer, so I didn't use it. Reconnect to check it.", "Reconnect"]);
    expect(all(bubbleCopy.cantReconnect("build-02", "Ember can't reach build-02 (no route)."))).toEqual(["Can't reconnect to build-02", "Ember can't reach build-02 (no route).", "Reconnect"]);
    expect(all(bubbleCopy.stoppedFromRemote("build-01"))).toEqual(["Stopped on build-01", "Someone at build-01 pressed Stop."]);
    expect(all(bubbleCopy.screenLocked("build-01"))).toEqual(["Stopped on build-01", "build-01's screen locked, so I stopped working on its screen."]);
    expect(all(bubbleCopy.sessionInactive("build-01"))).toEqual(["Stopped on build-01", "build-01's desktop session isn't active any more, so I stopped working on its screen."]);
    expect(all(bubbleCopy.backHere("build-01"))).toEqual(["Back on this computer", "build-01 isn't connected any more, so I'll work here."]);
  });

  it("says a command never in the bubble, only where it runs, and counts an announcement down", () => {
    // The badge says where (and screen readers hear it): only this computer, which has none, is said.
    expect(all(bubbleCopy.announcement("Pushing to GitHub, as you asked.", "on build-01"))).toEqual(["Pushing to GitHub, as you asked", "It starts in a few seconds.", "Stop"]);
    expect(bubbleCopy.announcement("Pushing to GitHub, as you asked", undefined).text).toBe("On this computer. It starts in a few seconds.");
    expect(all(bubbleCopy.wslFirstSeen())).toEqual(["I can work in WSL", "I can read and use your Linux apps and run commands there. Turn this on in settings?", "Open settings", "Not now"]);
    expect(keep(bubbleCopy.commandSpoken("ssh", "build-01"))).toBe("Ember wants to run a command on build-01.");
    // One voice in the bubble (review #22): a connection's or the settings window's "Ember can't…" is said as Ember.
    expect(bubbleCopy.firstPerson("Ember can't reach build-01 (no route). Check you're on the right network or VPN.")).toBe("I can't reach build-01 (no route). Check you're on the right network or VPN.");
    expect(bubbleCopy.firstPerson("The key changed. Ember won't connect.")).toBe("The key changed. I won't connect.");
    expect(bubbleCopy.firstPerson("Your organisation doesn't allow Ember to connect to build-01.")).toBe("Your organisation doesn't allow Ember to connect to build-01.");
    // The keyboard's way to what the floating layer's buttons do (review #47).
    expect(keep(bubbleCopy.keyboardRoute("Ctrl+Alt+E"))).toBe("Or press Ctrl+Alt+E and go to Computers.");
    expect(keep(bubbleCopy.keyboardRoute(null, "Commands"))).toBe("Or open Ember's settings and go to Commands.");
    // How to get to the window that shows it whole, from the keyboard (review #52): Alt+Tab where that reaches it.
    expect(keep(bubbleCopy.panelHint("command", "linux"))).toBe("The command is in Ember's command window: press Alt+Tab to go there.");
    expect(keep(bubbleCopy.panelHint("consent", "win32"))).toBe("It's in the window that opened: press Alt+Tab to go there.");
    expect(keep(bubbleCopy.panelHint("command", "darwin"))).toBe("The command is in Ember's command window.");
    expect(bubbleCopy.commandSpoken("local", "This computer")).toBe("Ember wants to run a command on this computer.");
  });
});

describe("every new SSH, WSL and commands string", () => {
  it("is in sentence case: a capital first, and capitals inside only for names", () => {
    expect(NEW_STRINGS.length).toBeGreaterThan(100);
    for (const s of NEW_STRINGS) {
      if (!s) continue;
      // A host's or distro's name may start a sentence in its own case ("build-01 asks").
      const first = s.split(" ")[0];
      expect(/^[A-Z0-9⟨]/.test(s) || /^(build-01|deploy|podman)/.test(first), s).toBe(true);
      for (const w of s.split(/\s+/).slice(1)) {
        const word = w.replace(/^[(“"‘]+|[)”"’.,:;?!…]+$/g, "");
        if (/^[A-Z][a-z]/.test(word)) {
          const afterStop = new RegExp(`[.:?!] ${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(s);
          expect(afterStop || PROPER.test(word) || /^(Ubuntu|Remove)$/.test(word), `${word} in: ${s}`).toBe(true);
        }
      }
    }
  });

  it("uses British spelling", () => {
    const american = /\b(organiz\w*|recogniz\w*|behavior\w*|color\w*|favorite\w*|center\w*|canceled|cancelation|analyz\w*|minimiz\w*|customiz\w*|authoriz\w*|licens(e|es)\b(?! file)|gray)\b/i;
    for (const s of NEW_STRINGS) expect(s, s).not.toMatch(american);
    expect(NEW_STRINGS.join(" ")).toMatch(/organisation/);
    expect(NEW_STRINGS.join(" ")).toMatch(/recognises/);
  });
});
