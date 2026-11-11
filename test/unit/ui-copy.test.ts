import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
  NEVER_LOOK_DEFAULTS, conversationContextLine, dayLabel, describeEntry, forUser, friendlyApp, keyLabel, missingDefaults, neverLookLabel, progressStep, retryMessage, tagline, tokens, usageLine,
} from "../../app/renderer/home/copy";
import { cardTask, cardText } from "../../app/renderer/handle/card";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import { memoryOwnerOffersErase, memoryOwnerText, memoryPausedReply } from "../../app/shared/memory-owner";
import { HOST_OS } from "../../app/main/platform/os";
import { NEVER_LOOK_DEFAULTS as NEVER_LOOK_BY_OS } from "../../app/shared/never-look";
import { IDLE_BUBBLE, type BubbleState, type TaskCard } from "../../app/shared/overlay";
import * as commandCopy from "../../app/renderer/command/copy";
import { LINES } from "../../app/main/commands/decide";
import { CARD_LINES, OUTPUT_TAINT_LINE, WAITING_BUBBLE } from "../../app/main/commands/flow";
import * as promptCopy from "../../app/renderer/prompt/copy";
import * as computersCopy from "../../app/renderer/home/computers-copy";
import * as matchCopy from "../../app/renderer/home/match-copy";
import { cardBadge, shortWhere, targetBadge, targetChip, whereText } from "../../app/renderer/handle/badge";
import { targetMenu } from "../../app/main/targets/menu";
import type { TargetEntry } from "../../app/main/targets/registry";
import type { MenuItemLike } from "../../app/main/targets/types";
import * as bubbleCopy from "../../app/renderer/overlay/target-copy";
import type { TargetSummary } from "../../app/shared/targets";
import type { Settings } from "../../app/main/settings";
import type { PromptCard } from "../../app/shared/remote-ui";
import * as conv from "../../app/renderer/home/copy";
import { composerRefusal, composerSendRefusal } from "../../app/main/agent/composer-refusal";
import { friendlyError, lostWords } from "../../app/main/agent/presenter";
import { PROVIDER_NO_KEYRING, PROVIDER_WORDS, reminderDeleteScope, betterRecallDownloadLabel, betterRecallProgress, betterRecallText, modelDestination, providerAgreedText, providerAgreedUnlisted, providerCardShown, providerConsentText, providerHeldChecking, providerHeldHint, providerHeldKept, providerHeldKey, providerHeldShown, recipientWords, providerHint, providerTestText, providerTestWaits } from "../../app/renderer/home/copy";

describe("settings window words", () => {
  it("counts model calls and tokens the way people say them", () => {
    expect(usageLine({ calls: 0, inputTokens: 0, outputTokens: 0 })).toBe("");
    expect(usageLine({ calls: 1, inputTokens: 312, outputTokens: 40 })).toBe("This session: 1 model call, 312 tokens in, 40 tokens out.");
    expect(usageLine({ calls: 10, inputTokens: 1234, outputTokens: 212 })).toBe("This session: 10 model calls, 1.2k tokens in, 212 tokens out.");
    expect(tokens(2000)).toBe("2k");
    expect(tokens(48_400)).toBe("48k");
    expect(usageLine({ calls: 3, inputTokens: 40, outputTokens: 12 })).not.toMatch(/0\.0k/);
  });

  it("labels conversation context separately from usage and leaves an unknown limit unknown", () => {
    expect(conversationContextLine(undefined)).toBe("");
    expect(conversationContextLine({ kind: "usage", currentTokens: 18_000, tokenLimit: 128_000 }))
      .toBe("The current conversation context uses 18k of 128k tokens.");
    expect(conversationContextLine({ kind: "usage", currentTokens: 500 }))
      .toBe("The current conversation context uses 500 tokens. Its limit is unknown.");
    expect(conversationContextLine({ kind: "compacting" })).toBe("Making room in the conversation…");
  });

  it("says what Check again found", () => {
    expect(retryMessage({ found: false, source: null })).toBe("No GitHub sign-in found on this computer. Run “gh auth login” in a terminal, then press Check again.");
    // A model provider in force: what was checked is that provider, never a GitHub sign-in (integrations-c1-1).
    expect(retryMessage({ found: false, source: null, provider: { host: "127.0.0.1:18408", ready: false } })).toBe("Checked again: Ember still can't connect to 127.0.0.1:18408.");
    expect(retryMessage({ found: false, source: null, provider: { host: "127.0.0.1:18408", ready: true } })).toBe("");
    expect(retryMessage({ found: false, source: null, provider: { host: "127.0.0.1:18408", ready: false, reason: "network" } })).toBe("Checked again: Ember still can't connect to 127.0.0.1:18408.");
  });

  it("says Check again still can't connect only when the provider couldn't be reached, never when only a model or key is missing (integrations-c2-2)", () => {
    for (const reason of ["models", "sign-in", "no-access", "runtime", "not-answering", "other"]) {
      expect(retryMessage({ found: false, source: null, provider: { host: "127.0.0.1:18408", ready: false, reason } }), reason)
        .toBe("Checked again: Ember still can't use 127.0.0.1:18408. The line above says why.");
    }
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
    expect(tagline({ ...base, phase: "signed-out" })).toBe("Beside your cursor. Connect Copilot to start asking.");
    // Signed out while my own provider's note waits: agreeing is the way on, not Copilot (integrations-r3-1).
    expect(tagline({ ...base, phase: "signed-out", waitingFor: "127.0.0.1:18308" })).toBe("Beside your cursor. Agree to use 127.0.0.1:18308 in Models & connections to start asking.");
    expect(tagline({ ...base, phase: "starting" })).toBe("Beside your cursor. Connecting to Copilot…");
    expect(tagline(base)).toBe("Beside your cursor. Press Ctrl+Alt+Space to ask anything.");
    expect(tagline({ ...base, hidden: true })).toMatch(/^Hidden for now\./);
    expect(tagline({ ...base, overlay: false })).toMatch(/^In the bottom-right corner\./);
    expect(tagline({ ...base, failing: 2 })).toBe("Needs 2 things fixed before it can work on this computer.");
    expect(tagline({ ...base, failing: 1 })).toBe("Needs 1 thing fixed before it can work on this computer.");
    // Copilot stopped answering with tasks at work: no "connect" (signing in again isn't the fix).
    expect(tagline({ ...base, phase: "error", waitingForTasks: true })).toBe("Beside your cursor. Copilot isn't answering: reconnecting once the tasks that are running finish.");
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
      .toEqual({ tag: "Asked you", cls: "ask", what: "Fill 3 cells (your keyboard) in LibreOffice", why: "Ember needs your mouse or keyboard for this." });
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
    // In the user's words (review #217): a capital first and a full stop.
    expect(failed("background_unavailable: this app takes no text this way")).toBe("This app takes no text this way.");
    // A file name with underscores is the user's, and stays.
    expect(forUser("Couldn't open my_report.txt.")).toBe("Couldn't open my_report.txt.");
    expect(forUser("Call perceive_window and try again.")).toBeUndefined();
  });
});

// ───── SSH, WSL and commands (§8): every new string, sentence case, British spelling ─────

const NEW_STRINGS: string[] = [];
const keep = <T extends string>(s: T): T => { NEW_STRINGS.push(s); return s; };
/** Words that keep their capital inside a sentence. */
const PROPER = /^(Ember|Ember's|WSL|SSH|GitHub|Copilot|PowerShell|Windows|Windows'|Linux|Ubuntu|Ubuntu's|Mac|Mac's|Desktop|Documents|Downloads|System|Settings|General|Sharing|Remote|Login|Support\/Ember|Podman|Stop|Allow|Ctrl\+Alt\+X\.?|Win\+Alt\+X\.?|Control\+Shift\+Command\+X\.?|Ctrl\+Alt\+Y|Ctrl\+Alt\+N|Ctrl\+Alt\+E|Alt\+Tab|Computers\.?|Commands\.?|Ctrl\+V\.?|Command\+V\.?|U\+[0-9A-F]+|I|I'll|OK|SHA256:abc|RLO|ZWSP|NBSP|ⓘ\)?\.?)$/;

describe("the command window's words (§8.5)", () => {
  const exit = (e: Partial<Parameters<typeof commandCopy.statusLine>[0]>) => ({ code: 0, signal: null, ended: "exit" as const, ms: 3200, ...e });
  const say = (e: Partial<Parameters<typeof commandCopy.statusLine>[0]>, os: "linux" | "win32" | "darwin" = "linux") => keep(commandCopy.statusLine(exit(e), { label: "build-01", os }));

  it("names the window, its empty state, the card and its buttons exactly", () => {
    expect(keep(commandCopy.WINDOW_TITLE)).toBe("Ember commands");
    expect(keep(commandCopy.EMPTY_TEXT)).toBe("Commands Ember runs show here. You can watch them, type into them and stop them.");
    expect(keep(commandCopy.ASK_HEADING)).toBe("Ember wants to run this command");
    expect(keep(commandCopy.askHeading({ target: "local", targetLabel: "This computer" }))).toBe("Ember wants to run this command");
    expect(keep(commandCopy.askHeading({ target: "ssh:build-01", targetLabel: "build-01" }))).toBe("Ember wants to run this command on build-01");
    expect(keep(commandCopy.askHeading({ target: "wsl:Ubuntu", targetLabel: "Ubuntu (WSL)" }))).toBe("Ember wants to run this command in Ubuntu (WSL)");
    expect(commandCopy.isRiskyCard({ classes: ["destroy"] })).toBe(true);
    expect(commandCopy.isRiskyCard({ classes: ["remote-delete", "publish"] })).toBe(true);
    // Every danger class, as the bubble tags it "Risky step" (commands-remote-v3); a card asked only by policy has none.
    for (const c of ["publish", "secret", "system", "escape", "unclear"] as const) expect(commandCopy.isRiskyCard({ classes: [c] }), c).toBe(true);
    expect(commandCopy.isRiskyCard({ classes: [] })).toBe(false);
    expect(commandCopy.isRiskyCard({})).toBe(false);
    expect(keep(commandCopy.ANNOUNCE_HEADING)).toBe("About to run this, as you asked");
    // A command the review cleared (the user didn't ask for exactly it) says so in the announcement's heading.
    expect(keep(commandCopy.REVIEWED_HEADING)).toBe("About to run this: Ember checked it against your request");
    const commandMain = readFileSync(new URL("../../app/renderer/command/main.ts", import.meta.url), "utf8");
    expect(commandMain).toMatch(/function buildAnnounce\([^]*?el\("h1", "heading", card\.reviewed \? REVIEWED_HEADING : ANNOUNCE_HEADING\)/);
    expect(keep(commandCopy.announceKeyText("linux"))).toBe("Or press Ctrl+Alt+X to stop everything.");
    expect(keep(commandCopy.announceKeyText("win32"))).toBe("Or press Win+Alt+X to stop everything.");
    expect(keep(commandCopy.announceKeyText("darwin"))).toBe("Or press Control+Shift+Command+X to stop everything.");
    expect([commandCopy.ALLOW_LABEL, commandCopy.NOT_NOW_LABEL, commandCopy.STOP_LABEL, commandCopy.CLOSE_LABEL].map(keep)).toEqual(["Allow", "Not now", "Stop", "Close"]);
    expect(keep(commandCopy.READ_ALL_HINT)).toBe("Read the whole command to allow it.");
    expect(keep(commandCopy.ANSWER_RETRY_HINT)).toBe("Ember couldn't take that answer just now. Try again.");
    expect(keep(commandCopy.closeHeading(1))).toBe("A command is still running");
    expect(keep(commandCopy.closeHeading(2))).toBe("2 commands are still running");
    expect(keep(commandCopy.closeLine(1))).toBe("Closing this window stops it. What it already changed stays.");
    expect(keep(commandCopy.closeLine(3))).toBe("Closing this window stops them. What they already changed stays.");
    expect([commandCopy.STOP_AND_CLOSE_LABEL, commandCopy.KEEP_OPEN_LABEL].map(keep)).toEqual(["Stop and close", "Keep it open"]);
    expect(keep(commandCopy.LEGEND_TOKENS)).toBe("Characters you wouldn't see are shown in ⟨ ⟩.");
    expect(keep(commandCopy.LEGEND_MIXED)).toBe("Letters from another alphabet are underlined.");
    expect(keep(commandCopy.LEGEND_RTL)).toBe("Right-to-left text is shown in the order it runs.");
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

  it("says the home folder as ~ in a POSIX shell's header, and every other folder whole (commands-remote-8)", () => {
    const h = (cwd: string, home: string | undefined, shell: "bash" | "zsh" | "sh" | "powershell" = "bash") =>
      keep(commandCopy.headerLine({ target: "local", targetLabel: "This computer", shell, cwd, ...(home !== undefined ? { home } : {}) }));
    expect(h("/home/ana/src/app", "/home/ana")).toBe("On this computer · bash · in ~/src/app");
    expect(h("/home/ana", "/home/ana")).toBe("On this computer · bash · in ~");
    expect(h("/home/ana/x", "/home/ana/")).toBe("On this computer · bash · in ~/x");
    expect(h("/home/anabel/x", "/home/ana")).toBe("On this computer · bash · in /home/anabel/x");
    expect(h("/srv/app", "/home/ana", "zsh")).toBe("On this computer · zsh · in /srv/app");
    expect(h("/home/ana/x", undefined)).toBe("On this computer · bash · in /home/ana/x");
    expect(h("/x", "/")).toBe("On this computer · bash · in /x");
    expect(h("C:\\Users\\ana\\p", "C:\\Users\\ana", "powershell")).toBe("On this computer · PowerShell · in C:\\Users\\ana\\p");
  });

  it("says how a run ended in its status line", () => {
    expect(keep(commandCopy.RUNNING_STATUS)).toBe("Running…");
    expect(keep(commandCopy.WAITING_STATUS)).toBe("Waiting for you to type in this window.");
    expect(keep(commandCopy.waitingTimeoutText(120_000))).toBe("Stopped after 2\u00a0min: it was waiting for you to type, and took too long.");
    expect(keep(WAITING_BUBBLE)).toBe("A command is waiting for you to type in the command window.");
    expect(say({ ms: 3200 })).toBe("Finished in 3.2\u00a0s.");
    expect(say({ code: 2, ms: 1100 })).toBe("Ended with exit code 2 after 1.1\u00a0s.");
    expect(say({ ended: "stopped-user", code: null, ms: 12_000 })).toBe("You stopped it after 12\u00a0s. What it already changed stays.");
    // The kill switch has more ways than its chord (the handle, settings, "Ember, stop", a policy change), and the chord
    // may be another app's: the line names none (cross-review X5).
    expect(say({ ended: "killswitch", code: null, ms: 2000 })).toBe("Stopped with everything else after 2\u00a0s. What it already changed stays.");
    expect(say({ ended: "timeout", code: null, ms: 120_000 })).toBe("Stopped after 2\u00a0min: it took too long.");
    expect(say({ ended: "lost", code: null })).toBe("The connection to build-01 dropped; the command was stopped there.");
    expect(say({ ended: "failed-to-start", code: null, error: "bash isn't installed on build-01." })).toBe("Couldn't start: bash isn't installed on build-01.");
    expect(say({ ended: "refused-remote", code: null, error: "its policy turns commands off" })).toBe("build-01 refused it: its policy turns commands off.");
    // A reason that ends in a quoted sentence gets no stray full stop inside and out (review #215).
    expect(say({ ended: "refused-remote", code: null, error: "it said \"no commands.\"" })).toBe("build-01 refused it: it said \"no commands\".");
    expect(say({ ended: "stopped-task", code: null, ms: 900 })).toBe("Stopped with its task after 0.9\u00a0s. What it already changed stays.");
    expect(say({ ended: "exit", code: null, signal: "SIGKILL", ms: 61_000 })).toBe("Ended by SIGKILL after 1\u00a0min 1\u00a0s.");
    expect(say({ ms: 500, ...{ stragglers: ["make"] } } as never)).toBe("Finished in 0.5\u00a0s. 1 program it started is still running: make. Ask Ember to stop it, or end it yourself.");
    expect(keep(commandCopy.stragglerText(["a", "b"]))).toBe("2 programs it started are still running: a, b. Ask Ember to stop them, or end them yourself.");
    expect(keep(commandCopy.reaskText("build-01"))).toBe("Not run: build-01's own check asks for your OK first.");
    expect(keep(commandCopy.reaskEndText("no"))).toBe("Not run: you didn't allow it.");
    expect(keep(commandCopy.reaskEndText("stopped"))).toBe("Not run: the task was stopped.");
    expect(commandCopy.durationText(9_960)).toBe("10\u00a0s");
    expect(commandCopy.durationText(59_600)).toBe("1\u00a0min");
    expect(commandCopy.durationText(2_000)).toBe("2\u00a0s");
  });

  it("says a run that took under 0.05 s took less than 0.1 s, never 0 s (commands-remote-5)", () => {
    for (const ms of [0, 20, 49]) expect(commandCopy.durationText(ms), String(ms)).toBe("less than 0.1\u00a0s");
    expect(commandCopy.durationText(50)).toBe("0.1\u00a0s");
    expect(say({ ms: 20 })).toBe("Finished in less than 0.1\u00a0s.");
    expect(say({ code: 2, ms: 20 })).toBe("Ended with exit code 2 after less than 0.1\u00a0s.");
  });

  it("says whether typing reaches the command, and what it waits for", () => {
    expect(keep(commandCopy.typingHint({ interactive: true, ended: false }))).toBe("Type here to answer the command; paste with Ctrl+V. Ember never sees what you type.");
    expect(keep(commandCopy.typingHint({ interactive: true, ended: false }, "win32"))).toBe("Type here to answer the command; paste with Ctrl+V. Ember never sees what you type.");
    expect(keep(commandCopy.typingHint({ interactive: true, ended: false }, "darwin"))).toBe("Type here to answer the command; paste with Command+V. Ember never sees what you type.");
    expect([commandCopy.COPY_OUTPUT_LABEL, commandCopy.COPIED_LABEL].map(keep)).toEqual(["Copy output", "Copied"]);
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

  it("speaks of Ember in the third person on every fixed line of the card (bubbles are first person, the card isn't)", () => {
    const lines: string[] = [...Object.values(LINES), ...Object.values(CARD_LINES as Record<string, unknown>).filter((l): l is string => typeof l === "string"), OUTPUT_TAINT_LINE];
    for (const l of lines) expect(l, l).not.toMatch(/(^|\s)I('m|'ll|'ve|'d)?\s/);
    expect(keep(LINES.tainted)).toBe("Ember is checking each step: a step came up that you didn't ask for.");
    expect(CARD_LINES.tainted).toBe(LINES.tainted);
    expect(keep(OUTPUT_TAINT_LINE)).toBe("Ember is checking each step: an earlier command printed text that looked like instructions.");
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

  it("on an SSH before 8.5, names no asker, says to read the question first and that the answer is never kept (commands-remote-3)", () => {
    for (const prompt of ["deploy@build-01.example.com's password: ", "Enter passphrase for key '/home/ana/.ssh/id_ed25519': "]) {
      const v = text({ id: "9", kind: "secret", secret: "other", host: "build-01", prompt, unmarked: true });
      expect(v, prompt).toEqual({
        title: "A question while connecting to build-01",
        body: [
          "This computer's SSH can't show whether this question comes from SSH itself or from build-01, so read it before you answer: what you type goes to whoever asked.",
          prompt,
          "Ember hands your answer to SSH only: it's never saved, logged or sent to Copilot.",
        ],
        field: "Answer", buttons: ["Send", "Cancel"],
      });
      expect(v.title).not.toMatch(/ asks$/);
      // The question itself stays quoted: it is the text ssh printed, not Ember's words.
      expect(promptCopy.promptView({ id: "9", kind: "secret", secret: "other", host: "build-01", prompt, unmarked: true }).body[1]).toEqual({ kind: "quote", text: prompt });
    }
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
      "On build-01's screen it reads and uses apps only when deploy is the person logged in there, and shows a notice with a Stop button while it does. You'll be asked before every step it takes there.",
      "Your voice and your GitHub sign-in stay on this computer. Ember sends build-01 only the steps it takes there and the commands it runs. What it reads there goes to GitHub Copilot from this computer when you ask something.",
      "It copies a helper there: about 33 MB (up to about 60 MB where that computer can't unpack the smaller download, as is usual on a Mac), unpacked to about 130 MB in its own folder (~/.local/share/ember-remote, or ~/Library/Application Support/Ember Remote on a Mac). It runs only while Ember is connected and stops when you disconnect, quit Ember or press Ctrl+Alt+X. If the connection drops, a command running there stops within 20 seconds.",
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
    expect(keep(ssh({ desktop: "headless" }).body[1])).toBe("build-01 has no desktop, so Ember will only run commands there.");
    expect(keep(ssh({ desktop: "remote-session" }).body[1])).toBe("build-01's desktop is a remote session: Ember will run commands only.");
    expect(keep(ssh({ desktop: "wsl" }).body[1])).toBe("build-01 is WSL on another computer: its Linux apps show on that computer's screen, so Ember will run commands only.");
    expect(keep(ssh({ desktop: "mac" }).body[1])).toBe("Ember can't use a Mac's screen over SSH yet; it will run commands there.");
    expect(keep(ssh({ desktop: "mac", tccBlocked: true }).body[1])).toBe("Ember can't use a Mac's screen over SSH yet; it will run commands there. Commands there can't open your Desktop, Documents or Downloads folders until “Allow full disk access for remote users” is on (System Settings › General › Sharing › Remote Login › ⓘ).");
    expect(ssh({ graceSeconds: 45, bundleMB: 34, unpackedMB: 131 }).body[3]).toContain("about 34 MB (up to about 60 MB where that computer can't unpack the smaller download, as is usual on a Mac), unpacked to about 131 MB");
    expect(ssh({ graceSeconds: 45 }).body[3]).toMatch(/stops within 45 seconds\.$/);
  });

  it("asks to turn on commands, with the extra lines only where they apply", () => {
    const local = promptCopy.consentText({ feature: "commands", os: "linux", target: "local", targetLabel: "This computer" });
    expect(keep(local.title)).toBe("Let Ember run commands on this computer?");
    expect(local.body.map(keep)).toEqual([
      "Ember runs commands in its own command window, where you can watch them and stop them. Ctrl+Alt+X stops everything at once; what a command already changed stays changed. It never types into your own terminal windows.",
      "Most commands run straight away. Before anything that deletes or overwrites data, pushes or publishes anywhere, touches passwords or keys, changes the system, or downloads and runs code, Ember stops and asks you. If you asked for exactly that yourself, it tells you first and gives you a few seconds to stop it.",
      "What a command prints goes to GitHub Copilot as part of the task. Ember hides passwords and keys it recognises, and never sees what you type into a command. If a command prints something that looks like instructions, Ember doesn't follow it and asks you before every further command in that task.",
    ]);
    expect([local.yes, local.no]).toEqual(["Turn on", "Not now"]);
    const all = promptCopy.consentText({ feature: "commands", os: "win32", target: "wsl:podman-machine-default", targetLabel: "podman-machine-default (WSL)", commands: { wsl: true, privileged: true, windows: true, podman: true } });
    expect(keep(all.title)).toBe("Let Ember run commands on podman-machine-default (WSL)?");
    // What the computer's commands can reach comes right after how to stop them (review #270).
    expect(all.body.slice(1, 5).map(keep)).toEqual([
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
      computersCopy.COMPUTERS_INTRO_WINDOWS,
    ].map(keep)).toEqual([
      // WSL only on Windows (review #198): the page's own intro is Linux's and macOS's.
      "Computers", "Ember can work on this computer and on computers you reach over SSH. Your voice and your GitHub sign-in always stay here.",
      "Commands", "Ember runs commands in its own command window, where you can watch and stop them. It asks first before anything that deletes, publishes, touches secrets or changes the system.",
      "Let Ember work in WSL", "Offer to bring Ember along when I connect with SSH", "Host name or user@host", "Connect",
      "Ask me before every command", "Open the command window", "Your organisation doesn't allow Ember to work in WSL.",
      "Your organisation doesn't allow Ember on other computers.", "Your organisation lets Ember connect only to some computers.",
      "Your organisation asks you to approve every command here.", "Type a host name, or user@host.", "That didn't work. Try again.",
      "Ember can work on this computer, in WSL, and on computers you reach over SSH. Your voice and your GitHub sign-in always stay here.",
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
    expect(v.ssh.rows[0].actions.map(a => keep(a.label))).toEqual(["Disconnect", "Forget", "Remove helper"]);
    // What Remove does, before it does it (review #191), and Forget asks too (review #163).
    expect(keep(v.ssh.rows[0].actions[2].confirm!)).toBe("Remove Ember's helper from build-01? This stops anything Ember is running there and forgets build-01 here. Its record of what Ember did there stays on build-01.");
    expect(keep(v.ssh.rows[0].actions[1].confirm!)).toBe("Forget build-01? Ember disconnects, removes it from this list and forgets your OKs for it. Ember's helper stays on build-01.");
    expect([v.ssh.rows[0].actions[2].pending!, v.ssh.rows[0].actions[2].done!].map(keep)).toEqual(["Removing Ember's helper from build-01…", "Removed. build-01 is no longer in your list."]);
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

  it("shows the ssh offer switch only once a computer is added: Ember doesn't look for ssh before that (review #33)", () => {
    const none = computersCopy.computersView({ os: "linux", settings: settings({ targets: { ...settings().targets, hosts: [] } }), admin: noPolicy, summaries: [summary({})] });
    expect(none.ssh.offer).toBeNull();
    expect(none.ssh.add).toBe(true);
    const one = computersCopy.computersView({ os: "linux", settings: settings(), admin: noPolicy, summaries: [summary({})] });
    expect(one.ssh.offer).toEqual({ label: "Offer to bring Ember along when I connect with SSH", checked: true, disabled: false });
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
    expect(page).toContain(`<li data-icon="plug"><b>${l.lead}</b><span id="targets-note">${l.rest}</span></li>`);
    expect(keep(`${l.lead}${l.rest}`)).toBe("Other computers and commands are off until you turn them on: Ember can work on computers you reach over SSH, and run commands in its own window. Each asks you first.");
    // WSL is Windows' alone (review #221).
    expect(keep(`${l.lead}${computersCopy.onboardingRest("win32")}`)).toBe("Other computers and commands are off until you turn them on: Ember can work in WSL, on computers you reach over SSH, and run commands in its own window. Each asks you first.");
    for (const s of [computersCopy.COMPUTERS_INTRO, computersCopy.COMMANDS_INTRO, computersCopy.WSL_SWITCH, computersCopy.OFFER_SWITCH, computersCopy.ADD_PLACEHOLDER, computersCopy.OPEN_COMMANDS]) {
      expect(page).toContain(s);
    }
  });

  it("says in Apps & privacy what the person turned on and what the organisation turned off, never that what is on is off (safety-privacy-r4-2)", () => {
    const l = computersCopy.ONBOARDING_LINE;
    const rest = computersCopy.targetsFoldRest;
    const agreed = { version: 1, at: "2026-11-04T12:00:00Z" };
    const base = structuredClone(DEFAULT_SETTINGS) as Settings;
    const host = { id: "build-01", dest: "deploy@build-01", resolved: { user: "deploy", hostname: "build-01", port: 22, jump: [] }, consent: agreed };
    const none = { source: null, features: {} };
    const allOff = { source: "error", features: { ssh: false, wsl: false }, commands: { local: "off", wsl: "off", ssh: "off" } } as const;
    const noCommands = { source: "/etc/ember/policy.json", features: {}, commands: { local: "off", wsl: "off", ssh: "off" } } as const;
    // Nothing turned on, nothing turned off: first run's own words, on each OS.
    expect(rest(base, none)).toBe(l.rest);
    expect(rest(base, none, "win32")).toBe(l.restWindows);
    // Commands on this computer, turned on with their card (the re-rater's probe).
    const local = { ...base, commands: { local: { on: true, askEvery: false, consent: agreed } } } as Settings;
    expect(keep(`${l.lead}${rest(local, none)}`)).toBe("Other computers and commands: you let Ember run commands on this computer. It runs commands only in its own window, where you can watch and stop them. Other computers are off until you turn them on.");
    expect(keep(`${l.lead}${rest(local, none, "win32")}`)).toBe("Other computers and commands: you let Ember run commands on this computer. It runs commands only in its own window, where you can watch and stop them. Other computers and WSL are off until you turn them on.");
    // A computer reached over SSH, with and without commands there.
    const ssh = { ...base, targets: { ...base.targets, hosts: [host] } } as Settings;
    expect(keep(`${l.lead}${rest(ssh, none)}`)).toBe("Other computers and commands: you let Ember work on computers you reach over SSH. Commands on this computer are off until you turn them on.");
    const both = { ...ssh, commands: { local: local.commands.local, "ssh:build-01": { on: true, askEvery: false, consent: agreed } } } as Settings;
    expect(keep(`${l.lead}${rest(both, none)}`)).toBe("Other computers and commands: you let Ember run commands on this computer, and work and run commands on computers you reach over SSH. It runs commands only in its own window, where you can watch and stop them.");
    // WSL on Windows (elsewhere it isn't Ember's to use).
    const wsl = { ...base, targets: { ...base.targets, wsl: { on: true, consent: agreed } } } as Settings;
    // Never "other computers and commands on this computer", which reads as both on this computer (safety-privacy-r4-2).
    expect(keep(`${l.lead}${rest(wsl, none, "win32")}`)).toBe("Other computers and commands: you let Ember work in WSL. Other computers are off until you turn them on, and so are commands on this computer.");
    expect(rest(wsl, none, "linux")).toBe(l.rest);
    // Under the organisation's lockdown nothing is offered, and nothing the person turned on is said to be on.
    expect(keep(`${l.lead}${rest(both, allOff)}`)).toBe("Other computers and commands are turned off by your organisation.");
    expect(rest(both, allOff, "win32")).toBe(" are turned off by your organisation.");
    // A policy that doesn't mention commands turns them off; other computers may still be turned on.
    expect(keep(`${l.lead}${rest(base, noCommands)}`)).toBe("Other computers and commands: other computers are off until you turn them on. Your organisation has turned off commands on this computer and on computers you reach over SSH.");
    expect(keep(`${l.lead}${rest(both, noCommands, "win32")}`)).toBe("Other computers and commands: you let Ember work on computers you reach over SSH. WSL is off until you turn it on. Your organisation has turned off commands on this computer, in WSL and on computers you reach over SSH.");
    // A policy that lets commands run only on this computer, with nothing turned on yet: first run's opening, then what the
    // organisation turned off, never "other computers and commands on this computer are off" (safety-privacy-r4-2).
    const localOnly = { source: "/etc/ember/policy.json", features: {}, commands: { local: "on", wsl: "off", ssh: "off" } } as const;
    expect(keep(`${l.lead}${rest(base, localOnly)}`)).toBe("Other computers and commands are off until you turn them on. Your organisation has turned off commands on computers you reach over SSH.");
    expect(keep(`${l.lead}${rest(base, localOnly, "win32")}`)).toBe("Other computers and commands are off until you turn them on. Your organisation has turned off commands in WSL and on computers you reach over SSH.");
    expect(keep(`${l.lead}${rest(ssh, localOnly)}`)).toBe("Other computers and commands: you let Ember work on computers you reach over SSH. Commands on this computer are off until you turn them on. Your organisation has turned off commands on computers you reach over SSH.");
    expect(keep(`${l.lead}${rest(local, { source: "/etc/ember/policy.json", features: { ssh: false }, commands: { local: "on" } })}`)).toBe("Other computers and commands: you let Ember run commands on this computer. It runs commands only in its own window, where you can watch and stop them. Your organisation has turned off working on other computers.");
    // A switch whose card isn't agreed to at its version isn't on, as main counts it.
    expect(rest({ ...base, commands: { local: { on: true, askEvery: false, consent: { version: 0, at: null } } } } as Settings, none)).toBe(l.rest);
    expect(rest({ ...base, targets: { ...base.targets, hosts: [{ ...host, consent: { version: 0, at: null } }] } } as Settings, none)).toBe(l.rest);
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

  it("calls a stopped WSL distro stopped, never not connected: it starts on the first command (review #189)", () => {
    const ubuntu = t({ id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)", state: "off" });
    expect(targetBadge(ubuntu)).toEqual({ text: "Ubuntu (WSL)", state: "off", label: "Working on Ubuntu (WSL) (stopped)" });
    expect(targetBadge({ ...ubuntu, state: "ready" })!.label).toBe("Working on Ubuntu (WSL)");
    // An SSH computer that is off is still not connected.
    expect(targetBadge(t({ state: "off" }))!.label).toBe("Working on build-01 (not connected)");
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
  // The live menu's words (targets/menu.ts); its rules are pinned in target-menu.test.ts.
  const e = (over: Partial<TargetEntry>): TargetEntry => ({ id: "local", kind: "local", label: "This computer", state: "ready", can: "", usable: true, listedOnly: false, names: [], ...over });
  const ssh = (id: string, state: TargetEntry["state"]) => e({ id: `ssh:${id}`, kind: "ssh", label: id, state, host: { id } as TargetEntry["host"] });
  const labels = (items: MenuItemLike[]): unknown[] => items.map(i => (i.type === "separator" ? "—" : i.submenu ? [i.label, labels(i.submenu)] : i.label));
  const menu = (entries: TargetEntry[], active: TargetEntry["id"], sshAllowed = true) => targetMenu({ entries, active, sshAllowed, pick() {}, bring() {}, disconnect() {} });

  it("adds nothing with only this computer and SSH off, so the menu is as it was", () => {
    expect(menu([e({})], "local", false)).toEqual([]);
  });

  it("says \"Bring Ember to a computer…\", \"Work on\", the targets' states, \"Disconnect\" and \"Cancel connecting\"", () => {
    expect(labels(menu([e({})], "local")).map(x => (x === "—" ? x : keep(x as string)))).toEqual(["—", "Bring Ember to a computer…"]);
    const items = menu([e({}), ssh("deploy", "ready"), e({ id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)", state: "off" }), ssh("podman", "lost"), ssh("build-01", "connecting")], "ssh:deploy");
    expect(labels(items)).toEqual([
      ["Work on", ["This computer", "deploy", "Ubuntu (WSL)", "podman (lost)", "build-01 (connecting…)"]], "—", "Bring Ember to a computer…", "Disconnect deploy", "Cancel connecting to build-01",
    ]);
    for (const w of ["Work on", "This computer", "podman (lost)", "build-01 (connecting…)", "Disconnect deploy", "Cancel connecting to build-01"]) keep(w);
    expect(items[0].submenu!.map(r => [r.checked, r.enabled])).toEqual([[false, true], [true, true], [false, true], [false, false], [false, true]]);
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
    expect(all(bubbleCopy.checkKeyAgain("build-01"))).toEqual(["build-01 needs you to check its key again", "Reconnect to check it.", "Reconnect"]);
    expect(all(bubbleCopy.cameBackDifferent("build-01"))).toEqual(["Lost build-01", "build-01 came back as a different computer, so I didn't use it. Reconnect to check it.", "Reconnect"]);
    expect(all(bubbleCopy.cantReconnect("build-02", "Ember can't reach build-02 (no route)."))).toEqual(["Can't reconnect to build-02", "Ember can't reach build-02 (no route).", "Reconnect"]);
    expect(all(bubbleCopy.stoppedFromRemote("build-01"))).toEqual(["Stopped on build-01", "Someone at build-01 pressed Stop."]);
    expect(all(bubbleCopy.screenLocked("build-01"))).toEqual(["Stopped on build-01", "build-01's screen locked, so I stopped working on its screen."]);
    expect(all(bubbleCopy.sessionInactive("build-01"))).toEqual(["Stopped on build-01", "build-01's desktop session isn't active any more, so I stopped working on its screen."]);
    expect(all(bubbleCopy.backHere("build-01"))).toEqual(["Back on this computer", "build-01 isn't connected any more, so I'll work here."]);
    expect(all(bubbleCopy.alreadyAdded("build-01"))).toEqual(["Already added as build-01", "I'm on build-01 already, so I'll work there."]);
  });

  it("says a command never in the bubble, only where it runs, and counts an announcement down", () => {
    // The badge says where (and screen readers hear it): only this computer, which has none, is said. Then the time it
    // is given and the stop chord (review #46).
    expect(all(bubbleCopy.announcement("Pushing to GitHub, as you asked.", "on build-01", 4, "Ctrl+Alt+X"))).toEqual(["Pushing to GitHub, as you asked", "It starts in 4 seconds. Ctrl+Alt+X stops everything at once.", "Stop"]);
    expect(bubbleCopy.announcement("Pushing to GitHub, as you asked", undefined, 15, "Win+Alt+X").text).toBe("On this computer. It starts in 15 seconds. Win+Alt+X stops everything at once.");
    // Another app holds the stop chord: none is named, in the bubble or the command window; Stop is the way, as the
    // spoken "Press Stop to cancel." says (cross-review X0).
    expect(all(bubbleCopy.announcement("Deleting build, as you asked.", undefined, 4, null))).toEqual(["Deleting build, as you asked", "On this computer. It starts in 4 seconds.", "Stop"]);
    expect(bubbleCopy.announcement("Deleting build, as you asked.", "on build-01", 15, null).text).toBe("It starts in 15 seconds.");
    for (const os of ["linux", "win32", "darwin"] as const) expect(commandCopy.announceKeyText(os, null), os).toBe("");
    expect(commandCopy.announceKeyText("linux", "Ctrl+Alt+X")).toBe("Or press Ctrl+Alt+X to stop everything.");
    expect(all(bubbleCopy.wslFirstSeen())).toEqual(["I can work in WSL", "I can read and use your Linux apps and run commands there. Turn this on in settings?", "Open settings", "Not now"]);
    expect(keep(bubbleCopy.commandSpoken("ssh", "build-01"))).toBe("Ember wants to run a command on build-01.");
    // Under a waiting command's Show (review #263): Alt+Tab where it reaches the command window.
    expect(keep(commandCopy.typingRouteText("linux")!)).toBe("Or press Alt+Tab to go there.");
    expect(commandCopy.typingRouteText("win32")).toBe("Or press Alt+Tab to go there.");
    expect(commandCopy.typingRouteText("darwin")).toBeNull();
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

describe("Voice Match and When Ember asks first in settings", () => {
  it("passes every fixed line and each state's words through the same copy rules", () => {
    const flat = (o: object): string[] => Object.values(o).flatMap(v => (typeof v === "string" ? [v] : flat(v as object)));
    flat(matchCopy.MATCH_TEXT).forEach(keep);
    flat(matchCopy.TRUST_TEXT).forEach(keep);
    keep(matchCopy.MANAGED_TEXT);
    const e = (got: number, again?: "short" | "unlike" | "failed") => ({ enrolled: false, on: false, enrolling: { got, of: 4, phrase: "Ember, open my calendar", again } });
    for (const m of [e(0), e(2), e(1, "short"), { enrolled: true, on: true, enrolling: null }]) {
      const v = matchCopy.matchView(m, { listening: true, managed: false });
      [v.text, v.prompt, v.teach.label, v.progress?.text ?? ""].forEach(keep);
    }
    for (const [a, b, cancelled] of [[e(0), e(1)], [e(3), { enrolled: true, on: true, enrolling: null }], [e(1), { enrolled: false, on: false, enrolling: null }, true], [{ enrolled: true, on: false, enrolling: null }, { enrolled: false, on: false, enrolling: null }]] as const) {
      keep(matchCopy.matchAnnouncement(a, b, cancelled) ?? "");
    }
    // One level of quotes: a quote inside a quote reads badly aloud and on screen.
    for (const s of flat(matchCopy.MATCH_TEXT)) expect(s, s).not.toMatch(/“[^”]*“/);
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
          expect(afterStop || PROPER.test(word) || /^(Ubuntu|Remove|Voice|Match)$/.test(word), `${word} in: ${s}`).toBe(true);
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

describe("Comfort & access › Glass (the Glass setting)", () => {
  it("names the three glasses and says what each does, in Ember's words", async () => {
    const { GLASS_CHOICES, GLASS_HINT, GLASS_LABEL } = await import("../../app/renderer/home/copy");
    expect(GLASS_LABEL).toBe("How much shows through");
    expect(GLASS_CHOICES).toEqual([{ value: "clear", label: "Clear" }, { value: "regular", label: "Regular" }, { value: "solid", label: "Solid" }]);
    expect(GLASS_HINT).toBe("How much of your screen shows through Ember's bubble, task cards, handle and ask box. Clear is an even, lighter tint, with Ember's words kept easy to read; Solid shows nothing through. Calm mode, and your desktop's settings to reduce transparency or increase contrast, make it solid.");
  });
});

describe("the Model provider group's words (Copilot section)", () => {
  it("names the endpoint's host in the card, with screenshots and the key's destination, in sentence case and British spelling", () => {
    // First run has no switch: its last sentence is the step's Back, and every word about what is sent is the same (first-run-10).
    const home = providerConsentText("models.example.com");
    const firstRun = providerConsentText("models.example.com", "first-run");
    expect(firstRun.endsWith(" Back takes you to GitHub Copilot instead.")).toBe(true);
    expect(firstRun.replace(" Back takes you to GitHub Copilot instead.", "")).toBe(home.replace(" Turn this off to go back to Copilot.", ""));
    // A provider already in use as its first-run step opens: Back leaves it on, so the card says nothing of going back;
    // its own button switches it off (first-run-c1-2).
    expect(providerConsentText("models.example.com", "in-use")).toBe(firstRun.replace(" Back takes you to GitHub Copilot instead.", ""));
    expect(readFileSync("app/renderer/home/welcome.ts", "utf8")).toContain('providerConsentText(host, visitInUse ? "in-use" : "first-run")');
    expect(providerConsentText("models.example.com")).toBe("Ember will send what it would send to GitHub Copilot to models.example.com instead: your requests, what it reads from your screen and apps, what it remembers that bears on them, what commands print, and for tasks, screenshots of the windows it works in, with password fields and never-look windows blacked out. That service's own terms and privacy rules apply, and it may keep what it gets. Your API key is kept encrypted on this computer and goes only to models.example.com. Turn this off to go back to Copilot.");
  });

  it("says what the switch does now, and when the organisation decides it", () => {
    expect(providerHint({ managed: null, inForce: false, on: false, host: null })).toBe("Use a model service of your own instead of GitHub Copilot: OpenAI, Azure OpenAI, Anthropic, or a model server on this computer such as Ollama or LM Studio.");
    expect(providerHint({ managed: null, inForce: false, on: true, host: null })).toBe("Enter the service's address to use it.");
    expect(providerHint({ managed: null, inForce: false, on: true, host: "models.example.com" })).toBe("Ember uses GitHub Copilot until you agree to use models.example.com.");
    // With no GitHub sign-in there's no Copilot to use meanwhile (integrations-r3-1).
    expect(providerHint({ managed: null, inForce: false, on: true, host: "models.example.com", signedOut: true })).toBe("Ember can't answer until you agree to use models.example.com.");
    expect(providerHint({ managed: null, inForce: true, on: true, host: "localhost:11434" })).toBe("Ember sends your requests to localhost:11434 instead of Copilot. A change applies from your next message; tasks already running finish where they started.");
    expect(providerHint({ managed: "organisation", inForce: false, on: false, host: null })).toBe("Managed by your organisation: Ember uses its model service.");
    expect(providerHint({ managed: "off", inForce: false, on: true, host: "x.example.com" })).toBe("Managed by your organisation: Ember uses GitHub Copilot.");
  });

  it("says, while an edit of my provider in use to another host waits for its note, that the one in use still answers, and that a failed check changed nothing (integrations-c3-1)", () => {
    expect(providerHeldHint("127.0.0.1:18308", "127.0.0.1:18309")).toBe("Ember still uses 127.0.0.1:18308. Agree to use 127.0.0.1:18309 to switch.");
    expect(providerHeldHint("127.0.0.1:18308", null)).toBe("Ember still uses 127.0.0.1:18308. Enter the new address to switch.");
    expect(providerHeldShown("127.0.0.1:18308", "127.0.0.1:18309")).toBe("Read the note above: Ember still uses 127.0.0.1:18308, and sends nothing to 127.0.0.1:18309 until you agree.");
    expect(providerHeldChecking("127.0.0.1:18309")).toBe("Checking 127.0.0.1:18309…");
    expect(providerHeldKept("127.0.0.1:18308", "Ember can't reach 127.0.0.1:18309. Check the address and the network.")).toBe("Ember can't reach 127.0.0.1:18309. Check the address and the network. Nothing has changed: Ember still uses 127.0.0.1:18308.");
    expect(providerHeldKept("127.0.0.1:18308")).toBe("Nothing has changed: Ember still uses 127.0.0.1:18308.");
    expect(providerHeldKey("api.example.com")).toBe("Ember saves this key with the new address once you agree to use api.example.com.");
    expect(providerHeldKey(null)).toBe("Enter the service's address first.");
  });

  it("says the note came up for an address just entered, and why Test connection waits (integrations-7)", () => {
    expect(providerCardShown("127.0.0.1:18108")).toBe("Read the note above: Ember sends nothing to 127.0.0.1:18108 until you agree.");
    // Once agreed, the line says where requests go now, never that nothing goes there (integrations-r4).
    expect(providerAgreedText("127.0.0.1:18108")).toBe("Agreed. Ember now sends your requests to 127.0.0.1:18108.");
    // A held edit adopted though the new host lists no models: what Ember will ask it for (integrations-r4-2).
    expect(providerAgreedUnlisted("gw.example.com", "gpt-4.1")).toBe("Agreed. gw.example.com answered but lists no models, so Ember asks it for gpt-4.1 as typed.");
    expect(providerAgreedUnlisted("gw.example.com", null)).toBe("Agreed. gw.example.com answered but lists no models, so Ember asks it for the models as typed.");
    expect(providerTestWaits({ host: null, agreed: false, managed: false })).toBe("Enter the endpoint to test it.");
    expect(providerTestWaits({ host: "models.example.com", agreed: false, managed: false })).toBe("Test connection works once you agree to the note above for models.example.com.");
    expect(providerTestWaits({ host: "models.example.com", agreed: true, managed: false })).toBeNull();
    expect(providerTestWaits({ host: "models.example.com", agreed: false, managed: true })).toBeNull();
  });

  it("reports a connection test in one sentence, and says why a key can't be kept", () => {
    expect(providerTestText({ ok: true, host: "models.example.com", models: 3 })).toBe("Connected to models.example.com. It lists 3 models.");
    expect(providerTestText({ ok: true, host: "models.example.com", models: 1 })).toBe("Connected to models.example.com. It lists 1 model.");
    expect(providerTestText({ ok: true, host: "localhost:1234", models: null })).toBe("Connected to localhost:1234.");
    // The models it names, so the exact id can be chosen (integrations-9).
    expect(providerTestText({ ok: true, host: "localhost:11434", models: 1, ids: ["llama3.2:3b"] })).toBe("Connected to localhost:11434. It lists 1 model: llama3.2:3b.");
    expect(providerTestText({ ok: true, host: "models.example.com", models: 12, ids: ["gpt-4.1", "gpt-4o", "o3"] })).toBe("Connected to models.example.com. It lists 12 models, such as gpt-4.1 and gpt-4o.");
    expect(providerTestText({ ok: true, host: "models.example.com", models: 12, ids: ["gpt-4.1"] })).toBe("Connected to models.example.com. It lists 12 models, such as gpt-4.1.");
    expect(providerTestText({ ok: false, why: "models.example.com needs an API key." })).toBe("models.example.com needs an API key.");
    // With the way forward (integrations-13).
    expect(PROVIDER_NO_KEYRING).toBe("This computer has no keyring for passwords, so Ember can't keep a key safely here. Set up a keyring (GNOME Keyring or KWallet), then come back to save one. A model server on this computer that needs no key still works.");
    expect(PROVIDER_WORDS).toEqual({
      keySaved: "Key saved.", keyRemoved: "Key removed.", pasteKey: "Paste the API key first.", testing: "Testing…",
      testFailed: "Ember couldn't test the connection. Try again.",
      badModel: "A model name has no spaces in it, such as gpt-4.1 or llama3.2:3b.",
      badAddress: "Enter the service's full address, starting with https://.",
      readAgain: "The address changed: read the note again for the new one, then agree.",
      badAzure: "Enter the API version as Azure writes it, such as 2024-10-21.",
    });
  });

  it("labels the group's rows in sentence case, with the key in a password field that is never filled from main", () => {
    const html = readFileSync("app/renderer/home/index.html", "utf8");
    for (const words of ["Use my own model provider", ">Provider<", ">Endpoint<", ">API key<", "Conversation model", "Model for tasks (must understand images)", ">Advanced<", ">Wire API<", "Azure API version", "Test connection", "Key saved", ">Replace<", ">Remove<", "I agree, use this provider", "Not now"]) {
      expect(html).toContain(words);
    }
    expect(html).toMatch(/<input id="byok-key" type="password"[^>]*autocomplete="off"/);
    const page = readFileSync("app/renderer/home/provider.ts", "utf8");
    // The page writes the key field only to empty it after a save.
    expect(page).not.toContain('fill("byok-key"');
    expect(page.match(/ field\.value = /g)).toHaveLength(1);
    expect(page).toContain('field.value = ""');
  });
});

describe("Better recall's download prompt (Settings › Memory, docs/MEMORY.md §2)", () => {
  const bytes = 23_203_878;
  it("says what the download is, how big, and that it runs on this computer", () => {
    expect(betterRecallText({ state: "absent", bytes })).toBe("Download a 23 MB language model that runs on this computer, so Ember finds what you told it when you ask in other words.");
    expect(betterRecallDownloadLabel(bytes)).toBe("Download (23 MB)");
  });

  it("says how it is going, that it is on, and why a download failed, in one plain sentence", () => {
    expect(betterRecallText({ state: "downloading", bytes, done: 1000 })).toBe("Downloading the language model…");
    expect(betterRecallText({ state: "ready", bytes })).toBe("On: a language model on this computer matches what you ask with what Ember remembers, even in other words.");
    expect(betterRecallText({ state: "absent", bytes, failed: "network" })).toBe("The download didn't finish. Check the network and try again.");
    expect(betterRecallText({ state: "absent", bytes, failed: "checksum" })).toBe("The download didn't match what Ember expects, so it wasn't used.");
  });

  it("announces the download to screen readers only every quarter", () => {
    expect(betterRecallProgress(0)).toBe("Language model 0% downloaded");
    expect(betterRecallProgress(0.49)).toBe("Language model 25% downloaded");
    expect(betterRecallProgress(1)).toBe("Language model 100% downloaded");
  });
});

describe("approval card risk and task context", () => {
  const card: PromptCard = { id: "approval-3", kind: "approval", n: 3, title: "May I?", prompt: "Click “Send”?", context: "Email Ana the report",
    options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }] };
  it("shows Risky step and Your task on a risky question, as the bubble does", () => {
    const v = promptCopy.promptView({ ...card, risky: true });
    expect(v.risky).toBe(true);
    expect(promptCopy.RISKY_STEP_TAG).toBe("Risky step");
    expect(JSON.stringify(v.body)).toContain("Your task: Email Ana the report");
    expect(promptCopy.promptView(card).risky).toBeUndefined();
  });
  it("says that press was refused, never that nothing was approved, when a press wasn't taken", () => {
    expect(promptCopy.approvalNotTaken("not-yet")).toMatch(/too soon.*didn't count/);
    // "Gone" may mean it was already answered with a yes, so it must not claim nothing was approved (review of #183).
    expect(promptCopy.approvalNotTaken("gone")).toMatch(/didn't count.*answered, replaced or timed out/);
    expect(promptCopy.APPROVAL_NOT_SENT).toMatch(/couldn't confirm/);
    for (const t of [promptCopy.APPROVAL_NOT_TAKEN, promptCopy.approvalNotTaken("not-yet"), promptCopy.approvalNotTaken("gone"), promptCopy.APPROVAL_NOT_SENT]) expect(t).not.toMatch(/nothing was approved/);
    expect(new Set([promptCopy.approvalNotTaken("not-yet"), promptCopy.approvalNotTaken("gone"), promptCopy.approvalNotTaken(), promptCopy.APPROVAL_NOT_SENT]).size).toBe(4);
  });
});

describe("modelDestination and recipientWords (microphone consent names the real recipient, audit FE #19)", () => {
  const base = { locked: false, adminProvider: null, own: { known: true as const, host: null } };
  it("says Copilot when no provider is in force", () => {
    expect(modelDestination(base)).toEqual({ kind: "copilot" });
    expect(recipientWords(modelDestination(base))).toBe("Copilot");
    expect(recipientWords(modelDestination(base), true)).toBe("GitHub Copilot");
  });
  it("names the user's own provider by host only once it is in force", () => {
    const d = modelDestination({ ...base, own: { known: true, host: "models.example.com:8443" } });
    expect(recipientWords(d)).toBe("your own model provider (models.example.com:8443)");
  });
  it("names the organisation's service by host only, never the path or credentials, and it wins over a personal one", () => {
    const d = modelDestination({ ...base, adminProvider: "https://user:secret@llm.corp.example/v1/path?k=1", own: { known: true, host: "x.example" } });
    expect(recipientWords(d)).toBe("your organisation's model service (llm.corp.example)");
    expect(recipientWords(d)).not.toMatch(/secret|path|v1/);
  });
  it("never says Copilot while the user's provider is unknown: it is its own destination, in short and long form", () => {
    const d = modelDestination({ ...base, own: { known: false } });
    expect(d).toEqual({ kind: "unknown" });
    for (const long of [false, true]) expect(recipientWords(d, long)).not.toMatch(/Copilot/);
    expect(recipientWords(d)).toMatch(/can't tell|can't yet/);
  });
  it("lets the organisation's service and lockdown answer even while the user's provider is unknown", () => {
    expect(modelDestination({ locked: false, adminProvider: "https://a.example", own: { known: false } })).toEqual({ kind: "organisation", host: "a.example" });
    expect(modelDestination({ locked: true, adminProvider: null, own: { known: false } }).kind).toBe("none");
  });
  it("sends nothing anywhere while locked down, or when the organisation's address can't be read", () => {
    expect(modelDestination({ ...base, locked: true, adminProvider: "https://a.example" }).kind).toBe("none");
    expect(modelDestination({ ...base, adminProvider: "not a url" }).kind).toBe("none");
  });
});

/** Every file under `dir`, as repository paths. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? listFiles(`${dir}/${d.name}`) : [`${dir}/${d.name}`]));
}

describe("Home's conversation words (2026-11-07 product audit)", () => {
  it("counts a long message near the limit, and says how much to shorten one over it (home-5)", () => {
    expect(conv.composerCount(0)).toBe("");
    expect(conv.composerCount(1799)).toBe("");
    expect(conv.composerCount(1800)).toBe("1,800 of 2,000 characters.");
    expect(conv.composerCount(2000)).toBe("2,000 of 2,000 characters.");
    expect(conv.composerCount(2001)).toBe("2,001 of 2,000 characters, 1 too many.");
    expect(conv.composerCount(3240)).toBe("3,240 of 2,000 characters, 1,240 too many.");
    expect(conv.COMPOSER_OVER).toBe("This message is longer than 2,000 characters. Shorten it to send it.");
  });

  it("marks where the messages kept from before a restart end, and searches the conversation, not a session (home-8)", () => {
    expect(conv.CONVERSATION_RESTORED_END).toBe("The messages above are from before Ember restarted, for you to read. Ember doesn't remember them: it starts afresh below.");
    expect(conv.conversationSearchCount(1)).toBe("1 matching message in this conversation.");
    expect(conv.conversationSearchCount(3)).toBe("3 matching messages in this conversation.");
    // A restored line from another day says which; today's keep the time alone.
    const now = new Date(2026, 10, 7, 15, 0);
    expect(conv.conversationWhen(new Date(2026, 10, 7, 9, 5).toISOString(), "9:05 AM", now)).toBe("9:05 AM");
    expect(conv.conversationWhen(new Date(2026, 10, 6, 9, 5).toISOString(), "9:05 AM", now)).toBe("Yesterday, 9:05 AM");
  });

  it("names the composer's send key the way each OS does (accessibility-visual-7, home-11)", () => {
    expect(conv.composerSendHint("linux")).toBe("Up to 2,000 characters. Enter adds a new line. Ctrl+Enter sends.");
    expect(conv.composerSendHint("win32")).toBe("Up to 2,000 characters. Enter adds a new line. Ctrl+Enter sends.");
    expect(conv.composerSendHint("darwin")).toBe("Up to 2,000 characters. Enter adds a new line. Command+Enter sends.");
    for (const os of ["linux", "win32", "darwin"] as const) expect(conv.composerSendHint(os)).not.toContain("⌘");
  });

  it("says in Home that the speech models' Download is right below Listen once, not \"in Settings\" (home-11)", () => {
    // Main words it for Settings itself (listenOnceInSettings, voice-listening-8), so Home shows what it is sent.
    const main = readFileSync("app/main/main.ts", "utf8");
    expect(main).toContain('return source === "home" ? listenOnceInSettings(heard) : heard;');
    expect(readFileSync("app/main/voice.ts", "utf8")).toContain('if (s.reason === "needs-models") return { ...s, detail: "Download the speech models below first." };');
    const home = readFileSync("app/renderer/home/main.ts", "utf8");
    expect(home).toContain("if (v !== voice) showListenOnce(v.listenOnce);");
    expect(home).not.toContain("Download speech models in Settings first.");
  });

  it("writes every apostrophe Ember shows straight, never U+2019 (accessibility-visual-6, home-11)", () => {
    const files = [...listFiles("app"), ...listFiles("packages")].filter(f => /\.(ts|html)$/.test(f) && !f.endsWith(".test.ts"));
    // Matching data, not words Ember shows: a quote character set and an app's own localised name.
    const MATCHING: Record<string, RegExp> = { "app/main/commands/lex-powershell.ts": /SINGLE_QUOTES = /, "app/main/policy/vocabulary.ts": /trousseaux d’accès/ };
    const curly: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const t = line.trim();
        if (!t.includes("’") || /^(\/\/|\*|\/\*)/.test(t) || MATCHING[f]?.test(t)) return;
        // Inside a regex character class ([‘’]) it matches what others write.
        if (t.replace(/\[[^\]]*\]/g, "").replace(/\s\/\/ .*$/, "").includes("’")) curly.push(`${f}:${i + 1}`);
      });
    }
    expect(curly).toEqual([]);
  });

  it("keeps the composer's statuses as tested words, in the house style (home-11)", () => {
    expect(conv.COMPOSER_SAYS).toEqual({
      copied: "Copied message.",
      copyFailed: "Couldn't copy this message. Select its text and copy it manually.",
      replyFailed: "This reply couldn't be finished. Review the message above; you can edit your request and send again.",
      notAnswered: "This request got no answer. Review the message above; you can edit your request and send again.",
      replied: "Reply received.",
      loadFailed: "Couldn't load this conversation. New replies will still appear here.",
      started: "Started a new conversation. Memory, reminders and running tasks are untouched.",
      startFailed: "Couldn't start a new conversation. Try again.",
      sending: "Sending request…",
      sendFailed: "Couldn't send. Your draft is still here; try again.",
      editCancelled: "Edit cancelled. Your previous draft is restored.",
      stopFailed: "Couldn't stop this response. Try again, or use Stop everything.",
      empty: "Enter a request of up to 2,000 characters.",
      noReply: "No reply was written. Task activity shows any task this request started.",
      replyStopped: "The reply was stopped before it finished.",
      stoppedAll: "Stopped everything, running tasks included.",
      readOut: "Reading the last answer out.",
    });
    expect(conv.CONVERSATION_STOPPED).toBe("Response stopped. Running tasks continue.");
    expect(conv.CONVERSATION_NOTHING_TO_STOP).toBe("Nothing is being answered right now, so there was nothing to stop.");
    // Home's main.ts writes none of them inline any more.
    const home = readFileSync("app/renderer/home/main.ts", "utf8");
    for (const said of Object.values(conv.COMPOSER_SAYS)) expect(home).not.toContain(`"${said}"`);
  });

  it("refuses a message sent while Ember isn't connected by why, and says it is still there (reliability-performance-v2)", () => {
    expect(composerRefusal({ phase: "signed-out" })).toBe("Connect Copilot in Models & connections, then send again.");
    expect(composerRefusal({ phase: "starting" })).toBe("Still connecting to Copilot. Your message is still here: send it again in a moment.");
    expect(composerRefusal({ phase: "error", reason: "network" })).toBe("Copilot can't be reached right now. Your message is still here: send it again once you're online.");
    expect(composerRefusal({ phase: "error", reason: "not-answering" })).toBe("Reconnecting to Copilot. Your message is still here: send it again in a moment.");
    expect(composerRefusal({ phase: "error", reason: "not-answering", waitingForTasks: true })).toBe("Copilot isn't answering: reconnecting once the tasks that are running finish. Your message is still here.");
    expect(composerRefusal({ phase: "error", reason: "policy" })).toBe("Your organisation's Ember policy has a problem, so Ember can't answer until it's fixed.");
    for (const reason of ["sign-in", "no-access", "models", "runtime", "other"] as const) {
      expect(composerRefusal({ phase: "error", reason })).toBe("Can't connect to Copilot yet: Models & connections says why. Your message is still here.");
    }
    // Copilot stopped and Ember is reconnecting by itself: nothing in Models & connections helps (reliability-performance-v2).
    expect(composerRefusal({ phase: "error", reason: "runtime", detail: "Copilot stopped unexpectedly. Reconnecting…" })).toBe("Reconnecting to Copilot. Your message is still here: send it again in a moment.");
    expect(composerRefusal({ phase: "error", reason: "runtime", detail: "Copilot keeps stopping. Press Check again to retry, or restart Ember." })).toBe("Can't connect to Copilot yet: Models & connections says why. Your message is still here.");
    // The service in use is named, never Copilot when it isn't the one.
    expect(composerRefusal({ phase: "starting", service: { kind: "user", host: "llm.local" } })).toBe("Still connecting to your model provider. Your message is still here: send it again in a moment.");
    expect(composerRefusal({ phase: "error", reason: "network", service: { kind: "admin", host: "llm.example.com" } })).toBe("The model service can't be reached right now. Your message is still here: send it again once you're online.");
    expect(composerRefusal({ phase: "error", reason: "not-answering", waitingForTasks: true, service: { kind: "user", host: "llm.local" } })).toBe("Your model provider isn't answering: reconnecting once the tasks that are running finish. Your message is still here.");
  });

  it("lets a typed \"stop\" that stops everything through while Ember isn't connected, as the Ask box does (home-c2-1)", () => {
    const waiting = { phase: "error" as const, reason: "not-answering" as const, waitingForTasks: true };
    // Waiting for the running task before it reconnects: that task is what "stop" stops.
    expect(composerSendRefusal(waiting, true)).toBeNull();
    expect(composerSendRefusal({ phase: "starting" }, true)).toBeNull();
    // Anything else is refused as before, and so is a ready Ember's nothing.
    expect(composerSendRefusal(waiting, false)).toBe("Copilot isn't answering: reconnecting once the tasks that are running finish. Your message is still here.");
    expect(composerSendRefusal({ phase: "ready" }, false)).toBeNull();
    // Signed out while my own provider's note waits for its host: agreeing is the way on, and the host is named (integrations-r4-3).
    expect(composerSendRefusal({ phase: "signed-out" }, false, "127.0.0.1:18308")).toBe("Agree to use 127.0.0.1:18308 in Models & connections, then send again.");
    expect(composerSendRefusal({ phase: "signed-out" }, false, null)).toBe("Connect Copilot in Models & connections, then send again.");
    expect(composerSendRefusal({ phase: "starting" }, false, "127.0.0.1:18308")).toBe("Still connecting to Copilot. Your message is still here: send it again in a moment.");
    // main.ts decides the stop before the refusal, after consent and the locked screen.
    const main = readFileSync("app/main/main.ts", "utf8").replace(/\s+/g, " ");
    const at = (s: string) => { const i = main.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    const consent = at('if (!consented()) throw new Error("Finish setup before sending a request.");');
    const locked = at('if (screenLock?.locked) throw new Error("Unlock your screen before sending a request.");');
    const stops = at("const stops = agent?.stopsWith(text) === true;");
    const refused = at("const refusal = composerSendRefusal(status, stops, status.phase === \"signed-out\" && !fixedProvider ? providerWaitingHost(settings.get(), admin) : null);");
    expect(consent).toBeLessThan(locked);
    expect(locked).toBeLessThan(stops);
    expect(stops).toBeLessThan(refused);
    expect(main).not.toContain("if (status?.phase !== \"ready\") throw new Error(composerRefusal(");
  });

  it("names Models & connections in a Problem line Home shows, where it said Ember's settings, and offers it only where settings can help (home-7)", () => {
    expect(conv.problemInHome("The model service reported a problem. Try again; if it keeps happening, check the model service in Ember's settings (Ctrl+Alt+E).")).toEqual({
      text: "The model service reported a problem. Try again; if it keeps happening, check the model service in Models & connections.", settings: true,
    });
    expect(conv.problemInHome("The model I'm set to use isn't available. Pick another one in settings (Ctrl+Alt+E).").text).toBe("The model I'm set to use isn't available. Pick another one in Models & connections.");
    expect(conv.problemInHome("Copilot didn't accept the sign-in. Open settings to sign in again.").text).toBe("Copilot didn't accept the sign-in. Open Models & connections to sign in again.");
    expect(conv.problemInHome("Not connected: Connect your GitHub account in settings, then ask me again.").text).toBe("Not connected: Connect your GitHub account in Models & connections, then ask me again.");
    // Nothing in settings helps: the line as it was, and no button.
    expect(conv.problemInHome("Copilot had a problem on its side. Try again in a moment.")).toEqual({ text: "Copilot had a problem on its side. Try again in a moment.", settings: false });
    expect(conv.PROBLEM_SETTINGS).toBe("Models & connections…");
  });

  it("offers Models & connections… on the line that says Ember stopped reconnecting, whose Check again is there (reliability-performance-r3-2)", () => {
    for (const w of [lostWords(false), lostWords("user")]) {
      expect(conv.problemInHome(w.gaveUp)).toEqual({ text: w.gaveUp, settings: true });
      // Reconnecting by itself, or connected again: nothing in Models & connections helps.
      expect(conv.problemInHome(w.reconnecting).settings).toBe(false);
      expect(conv.problemInHome(w.reconnected).settings).toBe(false);
    }
  });

  it("says a Stop ended my messages before they were sent, and that their words are back, above any draft, to edit or send again (home-r3-1, home-v4-2)", () => {
    expect(conv.composerGivenBack(conv.CONVERSATION_STOPPED)).toBe("Response stopped. Running tasks continue. Your message wasn't sent, so it's back here to edit or send again.");
    expect(conv.composerGivenBack(conv.COMPOSER_SAYS.stoppedAll)).toBe("Stopped everything, running tasks included. Your message wasn't sent, so it's back here to edit or send again.");
    // Every message a Stop dropped, and above what was typed since (home-v4-2).
    expect(conv.composerGivenBack(conv.CONVERSATION_STOPPED, 2)).toBe("Response stopped. Running tasks continue. Your 2 messages weren't sent, so they're back here to edit or send again.");
    expect(conv.composerGivenBack(conv.CONVERSATION_STOPPED, 1, true)).toBe("Response stopped. Running tasks continue. Your message wasn't sent, so it's back here, above what you were writing, to edit or send again.");
    expect(conv.composerGivenBack(conv.COMPOSER_SAYS.stoppedAll, 3, true)).toBe("Stopped everything, running tasks included. Your 3 messages weren't sent, so they're back here, above what you were writing, to edit or send again.");
    // A line about the draft: another request's wait leaves it be.
    expect(conv.composerLineYields(conv.composerGivenBack(conv.CONVERSATION_STOPPED))).toBe(false);
    expect(conv.composerLineYields(conv.composerGivenBack(conv.CONVERSATION_STOPPED, 2, true))).toBe(false);
  });

  it("keeps Edit's caution when a Stop gives my message back above the request I'm editing, and Cancel edit keeps it (home-r4-1)", () => {
    expect(conv.composerGivenBack(conv.CONVERSATION_STOPPED, 1, true, { editing: true })).toBe("Response stopped. Running tasks continue. Your message wasn't sent, so it's back here, above the request you're editing. Sending that request again may repeat actions.");
    expect(conv.composerEditCancelled(0, true)).toBe("Edit cancelled. Your previous draft is restored.");
    expect(conv.composerEditCancelled(1, false)).toBe("Edit cancelled. The message that wasn't sent is back here to edit or send again.");
    expect(conv.composerEditCancelled(2, false)).toBe("Edit cancelled. The 2 messages that weren't sent are back here to edit or send again.");
    expect(conv.composerEditCancelled(1, true)).toBe("Edit cancelled. Your previous draft is restored, below the message that wasn't sent.");
    // Notes about the draft: another request's wait leaves them be.
    expect(conv.composerLineYields(conv.composerGivenBack(conv.CONVERSATION_STOPPED, 1, true, { editing: true }))).toBe(false);
    expect(conv.composerLineYields(conv.composerEditCancelled(1, false))).toBe(false);
  });

  it("says when the messages a Stop gave back are together too long to send, never \"send again\" (home-c4-2)", () => {
    expect(conv.composerGivenBack(conv.CONVERSATION_STOPPED, 2, false, { over: true })).toBe("Response stopped. Running tasks continue. Your 2 messages weren't sent, so they're back here. Together they're over 2,000 characters: send them one at a time.");
    expect(conv.composerGivenBack(conv.COMPOSER_SAYS.stoppedAll, 1, true, { over: true })).toBe("Stopped everything, running tasks included. Your message wasn't sent, so it's back here, above what you were writing. Together they're over 2,000 characters: send them one at a time.");
    expect(conv.composerGivenBack(conv.CONVERSATION_STOPPED, 1, true, { editing: true, over: true })).toBe("Response stopped. Running tasks continue. Your message wasn't sent, so it's back here, above the request you're editing. Together they're over 2,000 characters: send them one at a time. Sending that request again may repeat actions.");
    expect(conv.composerEditCancelled(2, false, true)).toBe("Edit cancelled. The 2 messages that weren't sent are back here. Together they're over 2,000 characters: send them one at a time.");
    expect(conv.composerEditCancelled(1, true, true)).toBe("Edit cancelled. Your previous draft is restored, below the message that wasn't sent. Together they're over 2,000 characters: send them one at a time.");
    // Each goes, as the over-limit note does, once what is there fits: with no edit open, for an empty line; with one,
    // for Edit's caution (home-v5-2).
    for (const line of [conv.COMPOSER_OVER, conv.composerGivenBack(conv.CONVERSATION_STOPPED, 2, false, { over: true }), conv.composerGivenBack(conv.CONVERSATION_STOPPED, 1, true, { editing: true, over: true }), conv.composerEditCancelled(2, false, true)]) {
      expect(conv.composerSaysOver(line), line).toBe(true);
      expect(conv.composerLineFits(line, false), line).toBe("");
    }
    for (const line of ["", conv.composerGivenBack(conv.CONVERSATION_STOPPED, 2), conv.composerGivenBack(conv.CONVERSATION_STOPPED, 1, true, { editing: true }), conv.composerEditCancelled(2, false), conv.CONVERSATION_EDIT]) {
      expect(conv.composerSaysOver(line), line).toBe(false);
      expect(conv.composerLineFits(line, true), line).toBeNull();
    }
  });

  it("keeps Edit's caution when what a Stop gave back above my edit fits again, and clears the line only with no edit open (home-v5-2)", () => {
    for (const line of [conv.COMPOSER_OVER, conv.composerGivenBack(conv.CONVERSATION_STOPPED, 1, true, { editing: true, over: true }), conv.composerGivenBack(conv.CONVERSATION_STOPPED, 1, true, { editing: true, over: true, draftOver: true })]) {
      expect(conv.composerLineFits(line, true), line).toBe(conv.CONVERSATION_EDIT);
      expect(conv.composerLineFits(line, false), line).toBe("");
    }
  });

  it("says to shorten the draft or edited request that is over the limit by itself, never to send one at a time (home-v5-3)", () => {
    expect(conv.composerGivenBack(conv.CONVERSATION_STOPPED, 1, true, { over: true, draftOver: true })).toBe("Response stopped. Running tasks continue. Your message wasn't sent, so it's back here, above what you were writing, which is longer than 2,000 characters: shorten it to send it.");
    expect(conv.composerGivenBack(conv.COMPOSER_SAYS.stoppedAll, 2, true, { editing: true, over: true, draftOver: true })).toBe("Stopped everything, running tasks included. Your 2 messages weren't sent, so they're back here, above the request you're editing, which is longer than 2,000 characters: shorten it to send it. Sending that request again may repeat actions.");
    // With no draft under them, each of the messages fits by itself: one at a time.
    expect(conv.composerGivenBack(conv.CONVERSATION_STOPPED, 2, false, { over: true, draftOver: true })).toBe(conv.composerGivenBack(conv.CONVERSATION_STOPPED, 2, false, { over: true }));
    expect(conv.composerEditCancelled(1, true, true, { draftOver: true })).toBe("Edit cancelled. Your previous draft is restored, below the message that wasn't sent. That draft is longer than 2,000 characters: shorten it to send it.");
    // Said over the limit: it goes once what is there fits, and another request's wait leaves it be.
    for (const line of [conv.composerGivenBack(conv.CONVERSATION_STOPPED, 1, true, { over: true, draftOver: true }), conv.composerEditCancelled(1, true, true, { draftOver: true })]) {
      expect(conv.composerSaysOver(line), line).toBe(true);
      expect(conv.composerLineYields(line), line).toBe(false);
    }
  });

  it("says Cancel edit kept the messages a Stop gave back as I left them (home-v5-1)", () => {
    expect(conv.composerEditCancelled(1, true, false, { changed: true })).toBe("Edit cancelled. The message that wasn't sent stays here with your changes, and your previous draft is restored below it.");
    expect(conv.composerEditCancelled(2, true, false, { changed: true })).toBe("Edit cancelled. The 2 messages that weren't sent stay here with your changes, and your previous draft is restored below them.");
    expect(conv.composerEditCancelled(1, false, false, { changed: true })).toBe("Edit cancelled. The message that wasn't sent stays here with your changes, to edit or send again.");
    expect(conv.composerEditCancelled(2, false, true, { changed: true })).toBe("Edit cancelled. The 2 messages that weren't sent stay here with your changes. Together they're over 2,000 characters: send them one at a time.");
    // None kept (the person deleted them): only the draft from before Edit (home-w5-2).
    expect(conv.composerEditCancelled(0, true, false, { changed: true })).toBe("Edit cancelled. Your previous draft is restored.");
    for (const line of [conv.composerEditCancelled(1, true, false, { changed: true }), conv.composerEditCancelled(2, false, true, { changed: true })]) {
      expect(conv.composerLineYields(line), line).toBe(false);
    }
  });

  it("says a second Edit keeps the messages a Stop gave back above it, and when they're over the limit with it (home-w5-3)", () => {
    expect(conv.composerEditAgain(1)).toBe("Review this as a new request, then choose Send. The message that wasn't sent stays above it. Sending again may repeat actions; nothing is sent by choosing Edit.");
    expect(conv.composerEditAgain(2, true)).toBe("Review this as a new request, then choose Send. The 2 messages that weren't sent stay above it. Together they're over 2,000 characters: send them one at a time. Sending again may repeat actions; nothing is sent by choosing Edit.");
    // A note about the draft: another request's wait leaves it be; once what is there fits, Edit's caution stays.
    for (const line of [conv.composerEditAgain(1), conv.composerEditAgain(2, true)]) expect(conv.composerLineYields(line), line).toBe(false);
    expect(conv.composerLineFits(conv.composerEditAgain(2, true), true)).toBe(conv.CONVERSATION_EDIT);
    expect(conv.composerLineFits(conv.composerEditAgain(1), true)).toBeNull();
  });

  it("never says the request I edited stayed after Cancel edit, since it never does (home-w5-4)", () => {
    for (const messages of [0, 1, 2]) for (const draft of [false, true]) for (const over of [false, true]) for (const changed of [false, true]) {
      const line = conv.composerEditCancelled(messages, draft, over, { changed });
      expect(line, line).not.toMatch(/request you edited|repeat actions/);
      // Said over the limit, it goes once what is there fits, as no edit is open: nothing it said is left unsaid.
      expect(conv.composerLineFits(line, false), line).toBe(over && messages ? "" : null);
    }
  });

  it("lets another request's wait take the composer's line only from an earlier outcome, never from a note about my draft (home-c3-1)", () => {
    for (const line of ["", conv.COMPOSER_SAYS.replied, conv.COMPOSER_SAYS.replyFailed, conv.COMPOSER_SAYS.notAnswered, conv.COMPOSER_SAYS.noReply, conv.COMPOSER_SAYS.stoppedAll, conv.COMPOSER_SAYS.copied, conv.COMPOSER_SAYS.editCancelled, conv.CONVERSATION_STOPPED, conv.CONVERSATION_NOTHING_TO_STOP]) {
      expect(conv.composerLineYields(line), line).toBe(true);
    }
    for (const line of [conv.CONVERSATION_EDIT, conv.COMPOSER_OVER, conv.COMPOSER_SAYS.empty, conv.COMPOSER_SAYS.sendFailed, conv.COMPOSER_SAYS.sending, "The model service can't be reached right now. Your message is still here: send it again once you're online."]) {
      expect(conv.composerLineYields(line), line).toBe(false);
    }
  });

  it("offers Models & connections only on a Problem line that sends me there, never one for my administrator or GitHub, and names it once (home-r3-2, accessibility-visual-c3-2)", () => {
    // Ember's own lines, as friendlyError and the connection write them.
    const org = friendlyError("401 Unauthorized", undefined, { provider: true, statusCode: 401 });
    expect(org).toBe("Your organisation's model service refused the request. Ask your administrator to check Ember's model service settings.");
    expect(conv.problemInHome(org)).toEqual({ text: org, settings: false });
    const github = "No Copilot model I can use: None of the models Copilot lists are enabled for this account. Turn one on in your Copilot settings on GitHub.";
    expect(conv.problemInHome(github)).toEqual({ text: github, settings: false });
    expect(conv.problemInHome("Copilot isn't available to this account: This GitHub account doesn't have Copilot. Add Copilot to it, or ask whoever manages your GitHub plan.").settings).toBe(false);
    // The user's own provider with no model set: the section named once, with the way there.
    expect(conv.problemInHome("No model set for your provider: Enter the model your provider should use in Ember's settings, under Models & connections.")).toEqual({
      text: "No model set for your provider: Enter the model your provider should use in Models & connections.", settings: true,
    });
    // Ember gave up reconnecting: Check again is in Models & connections, so the line that names it has the way there.
    for (const w of [lostWords(false), lostWords("user"), lostWords(true)]) expect(conv.problemInHome(w.gaveUp)).toEqual({ text: w.gaveUp, settings: true });
    expect(conv.problemInHome("Copilot isn't running: Ember's Copilot runtime stopped while connecting. Press Check again.").settings).toBe(true);
    // Lines the user can act on in Models & connections keep it.
    expect(conv.problemInHome(friendlyError("401", "authentication")).settings).toBe(true);
    expect(conv.problemInHome(friendlyError("401", undefined, { provider: "user", statusCode: 401 })).settings).toBe(true);
    expect(conv.problemInHome(friendlyError("model_not_supported")).settings).toBe(true);
    expect(conv.problemInHome(friendlyError("something odd")).settings).toBe(true);
    // Nothing there helps: a hiccup, the network, ending a conversation, a reconnect under way.
    for (const said of [friendlyError("502 Bad Gateway"), friendlyError("ECONNRESET"), friendlyError("prompt token count exceeds the limit"), lostWords(false).reconnecting]) {
      expect(conv.problemInHome(said).settings, said).toBe(false);
    }
  });

  it("asks whether my model server on this computer is running, never to wait until I'm online (integrations-r2-2)", () => {
    for (const host of ["127.0.0.1:11434", "localhost:1234", "[::1]:8080"]) {
      expect(composerRefusal({ phase: "error", reason: "network", service: { kind: "user", host } }), host)
        .toBe("The model server on this computer can't be reached. Is it running? Your message is still here: send it again once it is.");
    }
    // A provider elsewhere, and the organisation's service on this computer, are still out of reach over the network.
    expect(composerRefusal({ phase: "error", reason: "network", service: { kind: "user", host: "api.example.com" } })).toBe("Your model provider can't be reached right now. Your message is still here: send it again once you're online.");
    expect(composerRefusal({ phase: "error", reason: "network", service: { kind: "admin", host: "127.0.0.1:11434" } })).toBe("The model service can't be reached right now. Your message is still here: send it again once you're online.");
  });

  it("asks before New conversation clears the messages, and names the saved copy when there is one (home-9)", () => {
    expect(conv.conversationNewQuestion(1, false)).toBe("Start a new conversation? This clears the message here.");
    expect(conv.conversationNewQuestion(12, false)).toBe("Start a new conversation? This clears the 12 messages here.");
    expect(conv.conversationNewQuestion(12, true)).toBe("Start a new conversation? This clears the 12 messages here and deletes the copy saved on this computer.");
  });

  it("says what removing an entry from Never look at or an app's Always changes (safety-privacy-11)", () => {
    expect(conv.neverLookRemovedText("keepassxc", "linux")).toBe("Removed KeePassXC. Ember may read its windows now; Restore defaults puts it back.");
    expect(conv.neverLookRemovedText("Thunderbird", "linux")).toBe("Removed Thunderbird. Ember may read its windows now.");
    // A password prompt stays unread whatever the list says.
    expect(conv.neverLookRemovedText("polkit", "linux")).toBe("Removed Password prompts (polkit). Ember still never reads password prompts; Restore defaults puts it back.");
    expect(conv.neverLookRemovedText("credentialuibroker", "win32")).toBe("Removed Password prompts (Windows Security). Ember still never reads password prompts; Restore defaults puts it back.");
    expect(conv.grantRemovedText("Thunderbird")).toBe("Removed Thunderbird. Ember asks again before its first action there.");
  });

  it("names what deleting all routines and reminders deletes, with each plural right and no count of zero (integrations-10)", () => {
    expect(reminderDeleteScope(1, 0)).toBe("Delete your routine? This removes saved reminders too.");
    expect(reminderDeleteScope(3, 0)).toBe("Delete all 3 routines? This removes saved reminders too.");
    expect(reminderDeleteScope(0, 1)).toBe("Delete your waiting reminder? This removes saved reminders too.");
    expect(reminderDeleteScope(0, 2)).toBe("Delete all 2 waiting reminders? This removes saved reminders too.");
    expect(reminderDeleteScope(2, 1)).toBe("Delete 2 routines and 1 waiting reminder? This removes saved reminders too.");
    expect(reminderDeleteScope(1, 1)).toBe("Delete 1 routine and 1 waiting reminder? This removes saved reminders too.");
    expect(reminderDeleteScope(0, 0)).toBe("Delete your saved reminders?");
  });
});

describe("what Memory says while saved memory can't be opened (memory-2, integrations-2)", () => {
  it("names the reason, and never tells someone to erase memory that is only waiting", () => {
    expect(memoryOwnerText("checking", true)).toBe("Checking your GitHub account…");
    expect(memoryOwnerText("own-provider", true)).toBe("Memory works only with GitHub Copilot, so it's paused while Ember uses your own model provider. What Ember remembers stays on this computer. Turn off “Use my own model provider” in Models & connections to use it again.");
    expect(memoryOwnerText("org-provider", false)).toBe("Memory works only with GitHub Copilot, so it's paused while Ember uses your organisation's model service. What Ember remembers stays on this computer.");
    expect(memoryOwnerText("unverified", true)).toBe("Ember couldn't check your GitHub account, so memory is paused. It comes back when Ember reconnects.");
    expect(memoryOwnerText("signed-out", false)).toBe("Sign in with GitHub to use saved memory.");
    expect(memoryOwnerText("signed-out", true)).toBe("Sign in with GitHub to use saved memory. Until then it stays hidden on this computer, and Forget everything clears it.");
    expect(memoryOwnerText("other-account", true)).toBe("This saved memory belongs to another GitHub account, so Ember keeps it hidden. Use Forget everything to clear it.");
    expect(memoryOwnerText("unowned", true)).toBe("Ember can't tell which GitHub account this saved memory belongs to, so it stays hidden. Use Forget everything to clear it.");
    // An older main that sends no reason: what it said before.
    expect(memoryOwnerText(undefined, true)).toBe(memoryOwnerText("unowned", true));
    expect(memoryOwnerText(undefined, false)).toBe("Sign in with GitHub to use saved memory.");
    for (const r of ["checking", "own-provider", "org-provider", "unverified"] as const) {
      expect(memoryOwnerOffersErase(r, true)).toBe(false);
      expect(memoryOwnerText(r, true)).not.toContain("Forget everything");
    }
    for (const r of ["signed-out", "other-account", "unowned", undefined] as const) expect(memoryOwnerOffersErase(r, true)).toBe(true);
    expect(memoryOwnerOffersErase("signed-out", false)).toBe(false);
  });

  it("answers in Ember's own words when memory is on but paused, opening Memory only where the answer is there", () => {
    expect(memoryPausedReply("checking")).toEqual({ text: "I'm still checking your GitHub account, so memory isn't ready yet. Ask me again in a moment.", open: false });
    expect(memoryPausedReply("own-provider")).toEqual({ text: "Memory works only with GitHub Copilot, so it's paused while I use your own model provider, and I can't keep what you tell me.", open: false });
    expect(memoryPausedReply("org-provider")).toEqual({ text: "Memory works only with GitHub Copilot, so it's paused while I use your organisation's model service, and I can't keep what you tell me.", open: false });
    expect(memoryPausedReply("unverified")).toEqual({ text: "I couldn't check your GitHub account, so memory is paused. It comes back when I reconnect.", open: false });
    expect(memoryPausedReply("signed-out")).toEqual({ text: "Memory needs you signed in with GitHub, so I can't keep what you tell me yet.", open: false });
    expect(memoryPausedReply("other-account")).toEqual({ text: "The memory saved on this computer isn't matched to your GitHub account, so memory is paused. I've opened Memory in Settings.", open: true });
    expect(memoryPausedReply("unowned")).toEqual(memoryPausedReply("other-account"));
  });
});

describe("Apps & privacy's screenshot switch (safety-privacy-7)", () => {
  const page = readFileSync(new URL("../../app/renderer/home/index.html", import.meta.url), "utf8");
  const main = readFileSync(new URL("../../app/renderer/home/main.ts", import.meta.url), "utf8");

  it("lets the person stop tasks sending screenshots, saying what that costs, in their own row", async () => {
    const { SCREEN_IMAGES_TEXT } = await import("../../app/renderer/home/copy");
    expect(SCREEN_IMAGES_TEXT).toEqual({
      heading: "What tasks may send",
      label: "Send screenshots for tasks",
      hint: "A task may send a picture of the window it works in, with password fields and never-look windows blacked out. With this off, Ember works only from what apps tell it through accessibility, so some tasks may be harder.",
    });
    expect(page).toContain(`<h3 class="sub">${SCREEN_IMAGES_TEXT.heading}</h3>`);
    expect(page).toContain(`<label class="switch-row"><input type="checkbox" id="screen-images" role="switch" aria-describedby="screen-images-hint"><span>${SCREEN_IMAGES_TEXT.label}</span></label>`);
    expect(page).toContain(`<p class="row-note" id="screen-images-hint">${SCREEN_IMAGES_TEXT.hint}</p>`);
    // Saved as the user's own switch, shown as applied (the organisation's off wins, a held lockdown's too:
    // safety-privacy-w5-2), and dimmed when it manages it.
    expect(main).toContain(`void save({ screenImages: (e.target as HTMLInputElement).checked });`);
    expect(main).toContain(`($("screen-images") as HTMLInputElement).checked = s.screenImages && !managed.has("screenImages");`);
    expect(main).toContain(`["screen-images", "screenImages"]`);
  });

  it("is what Apps & privacy's copy of the consent says, where first run's words no longer fit there (safety-privacy-r4)", async () => {
    const { privacyFoldWords } = await import("../../app/renderer/home/copy");
    const first = "It reads the window you're working in through the desktop's accessibility service, and for tasks it may take a screenshot of it. App windows on your never-look list and password prompts are never read. The list is in settings, and common password managers are on it already.";
    // The words are first run's own, as the page has them.
    expect(page.replace(/<[^>]+>/g, "")).toContain(first);
    expect(privacyFoldWords(first, { screenImages: true })).toBe(
      "It reads the window you're working in through the desktop's accessibility service, and for tasks it may take a screenshot of it. App windows on your never-look list and password prompts are never read. The list is below, under Never look at, and common password managers are on it already.");
    expect(privacyFoldWords(first, { screenImages: false })).toBe(
      "It reads the window you're working in through the desktop's accessibility service. Send screenshots for tasks is off (below), so it takes no screenshots for tasks. App windows on your never-look list and password prompts are never read. The list is below, under Never look at, and common password managers are on it already.");
    // Any other text is left as it is.
    expect(privacyFoldWords("It sends no usage statistics.", { screenImages: false })).toBe("It sends no usage statistics.");
  });

  it("says ordinary steps go ahead without asking while Work without asking is on, and which apps never ask (safety-privacy-c4-1)", async () => {
    const { privacyFoldWords } = await import("../../app/renderer/home/copy");
    const hand = " in an app, and always before anything hard to undo. It never types passwords. ";
    // The words are first run's own, after the line's bold lead, as the page has them.
    expect(page).toContain(`<b>It asks before acting</b>${hand}<span`);
    expect(privacyFoldWords(hand, { screenImages: true })).toBe(hand);
    expect(`It asks before acting${privacyFoldWords(hand, { screenImages: true, autonomy: true, grants: true })}`).toBe(
      "It asks before acting on anything risky or hard to undo. Work without asking is on (below), so for ordinary steps it tells you what it's doing instead. It never types passwords. ");
    expect(`It asks before acting${privacyFoldWords(hand, { screenImages: true, grants: true })}`).toBe(
      "It asks before acting in an app, except those you let it act in without asking (below), and always before anything hard to undo. It never types passwords. ");
    // The onboarding line's words after its lead, on either OS, are the ones the settings and the policy leave.
    const { onboardingRest } = await import("../../app/renderer/home/computers-copy");
    for (const os of ["linux", "win32"] as const) expect(privacyFoldWords(onboardingRest(os), { screenImages: true, targets: ": now" })).toBe(": now");
    expect(privacyFoldWords(onboardingRest("darwin"), { screenImages: true })).toBe(onboardingRest("darwin"));
  });

  it("is found by searching for screenshots, by its own words, and by \"pictures\"", async () => {
    const { SCREEN_IMAGES_TEXT } = await import("../../app/renderer/home/copy");
    const { SEARCH_ALIASES } = await import("../../app/renderer/home/search-copy");
    // Its own label carries "screenshots" (a setting's own words rank first); the pane's alias, the other words.
    expect(SCREEN_IMAGES_TEXT.label).toMatch(/\bscreenshots\b/);
    expect(SEARCH_ALIASES["privacy-h"]).toMatch(/\bpictures\b/);
  });
});

describe("What Ember did for a command the review cleared (safety-privacy-v1)", () => {
  it("still says the review's words from the user's own audit file, now kept apart from the reason", async () => {
    const { describeEntry } = await import("../../app/renderer/home/copy");
    const v = describeEntry({ t: "2026-11-07T10:00:00Z", event: "command", phase: "decided", verdict: "announce", reason: "Reviewed: routine for the request.", review: "asked to clean the build" });
    expect(v?.why).toBe("Reviewed: routine for the request (asked to clean the build).");
    expect(describeEntry({ t: "2026-11-07T10:00:00Z", event: "command", phase: "decided", verdict: "announce", reason: "Reviewed: routine for the request." })?.why).toBe("Reviewed: routine for the request.");
  });
});

describe("Home after the last run ended unexpectedly (rp-5)", () => {
  it("says Ember closed unexpectedly and where its log is, in a status note that has words only then (accessibility-visual-c1-1)", async () => {
    const { closedUnexpectedlyText } = await import("../../app/renderer/home/copy");
    expect(closedUnexpectedlyText("/home/ada/.config/ember/logs/ember.log")).toBe("Ember closed unexpectedly last time. Its log shows what it was doing until then: /home/ada/.config/ember/logs/ember.log");
    const page = readFileSync(new URL("../../app/renderer/home/index.html", import.meta.url), "utf8");
    // On the page while empty, so a screen reader announces it as it fills.
    expect(page).toContain(`<p id="run-notice" class="managed" role="status"></p>`);
    const main = readFileSync(new URL("../../app/renderer/home/main.ts", import.meta.url), "utf8");
    expect(main).toContain(`$("run-notice").textContent = status.unexpectedExit ? closedUnexpectedlyText(status.logFile) : "";`);
  });
});

describe("the log file in About this build (rp-8)", () => {
  it("can be copied and shown in the file manager, as the address beside it can be copied", async () => {
    const { showLogLabel } = await import("../../app/renderer/home/copy");
    expect(showLogLabel("linux")).toBe("Show in Files");
    expect(showLogLabel("win32")).toBe("Show in File Explorer");
    expect(showLogLabel("darwin")).toBe("Show in Finder");
    const main = readFileSync(new URL("../../app/renderer/home/main.ts", import.meta.url), "utf8");
    expect(main).toContain(`["Log file", status.logFile, "log"],`);
    expect(main).toContain(`copy.setAttribute("aria-label", kind === "log" ? "Copy the log file's path" : \`Copy the address \${val}\`);`);
    expect(main).toContain(`window.ember.showLogFile().catch(() => { show.textContent = "Couldn't open it"; });`);
  });

  it("is shown by a channel that opens only Ember's own log file, whatever the page sends", () => {
    const main = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    expect(main).toContain(`ipcMain.handle(IPC.showLogFile, guard(() => { shell.showItemInFolder(log.file); }));`);
    const preload = readFileSync(new URL("../../app/preload/home.ts", import.meta.url), "utf8");
    expect(preload).toContain(`showLogFile: () => ipcRenderer.invoke(IPC.showLogFile),`);
  });
});
