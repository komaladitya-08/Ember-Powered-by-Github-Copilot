/**
 * Home's status panel and its search (app/renderer/home/status-copy.ts, search-copy.ts), its panes, and main's
 * Task activity channel: what the panel says comes from the same tasks Task activity lists, so the two never disagree
 * (owner review of the first render), and the setup counts agree everywhere (UI audit #6).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { connectLabel, memoryWhatsOn, runtimeState, setupLinkText, statusWord, taskCounts, todayCounts, todaySummary, whatsOn, whatsOnText } from "../../app/renderer/home/status-copy";
import { SEARCH_ALIASES, searchFold, searchMatches, searchMessage, shownText, type ShownNode } from "../../app/renderer/home/search-copy";
import { checksNote, COMPOSER_HELD, COMPOSER_THINKING, composerStillWaiting, settingsResultText, setupBadge, setupView, tagline } from "../../app/renderer/home/copy";
import { formatDoctor } from "../../app/main/doctor";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import type { TaskEntry, TaskActivity } from "../../app/shared/activity";
import { IPC, TASKS_PUSH_MS } from "../../app/shared/ipc";

const activity = (o: Partial<TaskActivity> = {}): TaskActivity => ({
  startedAt: new Date(2026, 10, 2, 9, 0).getTime(), items: [], dropped: 0, steps: 0, failedSteps: 0, counts: {}, questions: 0, approvals: 0,
  asking: false, retry: 0, slow: false, nearLimit: false, live: "Working…", ...o,
});
const task = (status: TaskEntry["status"], o: Partial<TaskActivity> = {}): TaskEntry => ({ id: status, title: status, status, activity: activity(o) });
const NOW = new Date(2026, 10, 2, 15, 0);

describe("Home's status panel", () => {
  it("names the most urgent state first: setup, Copilot, a task that needs you, the work, then Ready", () => {
    const base = { phase: "ready", failing: 0, running: 0, asking: 0 };
    expect(statusWord(base)).toEqual({ word: "Ready", ring: "ready" });
    expect(statusWord({ ...base, running: 2 })).toEqual({ word: "Working on 2 tasks", ring: "acting" });
    expect(statusWord({ ...base, running: 1, asking: 1 })).toEqual({ word: "A task needs you", ring: "needs" });
    expect(statusWord({ ...base, running: 2, asking: 2 }).word).toBe("2 tasks need you");
    expect(statusWord({ ...base, phase: "starting" })).toEqual({ word: "Connecting…", ring: "starting" });
    expect(statusWord({ ...base, phase: "signed-out", asking: 1 })).toEqual({ word: "Not connected", ring: "error" });
    expect(statusWord({ ...base, phase: "error", waitingForTasks: true }).word).toBe("Waiting for Copilot");
    expect(statusWord({ ...base, failing: 1, asking: 1 })).toEqual({ word: "Needs setting up", ring: "error" });
  });

  it("says Ember is thinking while it answers a message sent from Home, after a task that needs you or tasks at work (home-7)", () => {
    const base = { phase: "ready", failing: 0, running: 0, asking: 0 };
    expect(statusWord({ ...base, answering: true })).toEqual({ word: "Thinking…", ring: "acting" });
    expect(statusWord({ ...base, answering: true, running: 1 }).word).toBe("Working on 1 task");
    expect(statusWord({ ...base, answering: true, asking: 1 }).word).toBe("A task needs you");
    expect(statusWord({ ...base, answering: true, phase: "starting" }).word).toBe("Connecting…");
    // The composer's own line: thinking, then (while the bubble says it: main's "slow") still waiting for the service in use, and how to stop.
    expect(COMPOSER_THINKING).toBe("Thinking… The reply will appear above.");
    expect(composerStillWaiting()).toBe("Still waiting for Copilot… Stop response ends this reply.");
    expect(composerStillWaiting("user")).toBe("Still waiting for your model provider… Stop response ends this reply.");
    expect(composerStillWaiting("admin")).toBe("Still waiting for the model service… Stop response ends this reply.");
  });

  it("says a message held for a new model service waits for the switch, never that Ember is thinking (home-r4-4)", () => {
    const base = { phase: "ready", failing: 0, running: 0, asking: 0 };
    expect(statusWord({ ...base, answering: true, switching: true })).toEqual({ word: "Switching model service…", ring: "starting" });
    // A task at work, or one that needs you, is what it waits for: said first.
    expect(statusWord({ ...base, answering: true, switching: true, running: 1 }).word).toBe("Working on 1 task");
    expect(statusWord({ ...base, answering: true, switching: true, asking: 1 }).word).toBe("A task needs you");
    expect(COMPOSER_HELD).toBe("This goes to the new model service once what's under way now has finished. Stop response cancels it.");
  });

  it("under the organisation's lockdown says Ember is locked, never \"Not connected\" or to connect Copilot (safety-privacy-4)", () => {
    const base = { phase: "error", failing: 0, running: 0, asking: 0 };
    expect(statusWord({ ...base, locked: true })).toEqual({ word: "Locked by your organisation", ring: "error" });
    expect(statusWord({ ...base, phase: "ready", locked: true, held: true })).toEqual({ word: "Locked until a restart", ring: "error" });
    const t = { failing: 0, onboarded: true, phase: "error", hidden: false, overlay: true };
    expect(tagline({ ...t, locked: true })).toBe("Your organisation's Ember policy has a problem, so Ember can't answer or act until it's fixed.");
    expect(tagline({ ...t, locked: true, held: true })).toBe("Your organisation changed Ember's policy, so Ember can't answer or act until you restart it.");
    for (const w of [tagline({ ...t, locked: true }), statusWord({ ...base, locked: true }).word]) expect(w).not.toMatch(/Connect|Not connected|Copilot/);
    expect(fs.readFileSync("app/renderer/home/main.ts", "utf8")).toContain("$(\"p-connect\").hidden = !notConnected || locked;");
  });

  it("labels the connect button by the service that isn't connected, never Copilot for another (first-run-r1)", () => {
    expect(connectLabel()).toBe("Connect Copilot…");
    expect(connectLabel("user")).toBe("Check my provider…");
    expect(connectLabel("admin")).toBe("Models & connections…");
    // Signed out while my own provider's note waits: its details, never Copilot's sign-in (integrations-r3-1).
    expect(connectLabel(undefined, true)).toBe("Check my provider…");
    expect(fs.readFileSync("app/renderer/home/main.ts", "utf8")).toContain("setText(\"p-connect\", connectLabel(agent?.service?.kind, !!waitingFor(), runtimeState(agent)));");
  });

  it("says Ember is reconnecting while its model connection starts again, as the handle and Ask do, and never sends the person to a provider that is fine (accessibility-visual-c1-2)", () => {
    // The runtime stopped under the user's own provider (lost(): runtimeWords("user").stopped), then gave up.
    const crashed = { phase: "error", reason: "runtime", detail: "Ember's model connection stopped unexpectedly. Reconnecting…" };
    const gaveUp = { phase: "error", reason: "runtime", detail: "Ember's model connection keeps stopping. Press Check again to retry, or restart Ember." };
    expect(runtimeState(crashed)).toBe("reconnecting");
    expect(runtimeState({ ...crashed, detail: "Copilot stopped unexpectedly. Reconnecting…" })).toBe("reconnecting");
    expect(runtimeState({ phase: "error", reason: "not-answering", detail: "Your model provider isn't answering. Reconnecting…" })).toBe("reconnecting");
    expect(runtimeState(gaveUp)).toBe("stopped");
    for (const other of [{ phase: "error", reason: "network", detail: "" }, { phase: "error", reason: "not-answering", detail: "Your model provider isn't answering." }, { phase: "signed-out", detail: "" }, { phase: "ready", detail: "" }, null]) expect(runtimeState(other)).toBeNull();
    const base = { phase: "error", failing: 0, running: 0, asking: 0, service: "user" };
    // Before, "Not connected" (the error ring) whatever the reason, while the handle and Ask said "Reconnecting…".
    expect(statusWord({ ...base, runtime: "reconnecting" })).toEqual({ word: "Reconnecting…", ring: "starting" });
    expect(statusWord({ ...base, runtime: "stopped" })).toEqual({ word: "Not connected", ring: "error" });
    // Still the most urgent things first, and the wait for running tasks as before.
    expect(statusWord({ ...base, runtime: "reconnecting", failing: 1 }).word).toBe("Needs setting up");
    expect(statusWord({ ...base, runtime: "reconnecting", locked: true }).word).toBe("Locked by your organisation");
    expect(statusWord({ ...base, runtime: "reconnecting", waitingForTasks: true }).word).toBe("Waiting for the model service");
    // The button goes where Check again and the true line are, never "Check my provider…" or Copilot's sign-in.
    for (const service of ["user", "admin", undefined]) for (const state of ["reconnecting", "stopped"] as const) expect(connectLabel(service, false, state)).toBe("Models & connections…");
    expect(connectLabel("user", false, null)).toBe("Check my provider…");
    const source = fs.readFileSync("app/renderer/home/main.ts", "utf8");
    expect(source).toContain("setText(\"p-connect\", connectLabel(agent?.service?.kind, !!waitingFor(), runtimeState(agent)));");
  });

  it("counts the tasks at work and those waiting from Task activity's list", () => {
    expect(taskCounts([task("running"), task("waiting"), task("done"), task("failed")])).toEqual({ running: 2, asking: 1 });
  });

  it("says today from the same tasks Task activity shows, so the two never disagree", () => {
    const list = [task("waiting"), task("done", { approvals: 1 }), task("failed")];
    expect(todaySummary(list, { tasks: 0, approvals: 0 }, NOW)).toBe("1 needs you · 1 done · 1 didn't finish · 1 approval");
    // Tasks of an earlier run today are only in the audit: counted as earlier.
    expect(todaySummary([task("running")], { tasks: 3, approvals: 2 }, NOW)).toBe("1 working · 2 earlier tasks · 2 approvals");
    // Yesterday's task (kept in memory overnight) isn't today's.
    expect(todaySummary([task("done", { startedAt: new Date(2026, 10, 1, 22, 0).getTime() })], { tasks: 0, approvals: 0 }, NOW)).toBe("No tasks yet");
    expect(todaySummary([], { tasks: 0, approvals: 0 }, NOW)).toBe("No tasks yet");
  });

  it("never counts a task whose question went unanswered as one I stopped, as its row says, in a count that reads as one (tasks-approvals-r3-1, accessibility-visual-r4-1)", () => {
    const unanswered: TaskEntry = { ...task("stopped"), unanswered: true };
    expect(todaySummary([unanswered], { tasks: 0, approvals: 0 }, NOW)).toBe("1 got no answer in time");
    expect(todaySummary([unanswered, task("stopped"), { ...unanswered, id: "again" }], { tasks: 0, approvals: 0 }, NOW)).toBe("1 stopped · 2 got no answer in time");
    expect(todaySummary([task("done", { approvals: 1 }), unanswered, { ...unanswered, id: "again" }], { tasks: 0, approvals: 0 }, NOW)).toBe("1 done · 2 got no answer in time · 1 approval");
  });

  it("counts today's tasks and approvals in the audit", () => {
    const t = NOW.toISOString();
    const entries = [{ t, event: "task", phase: "asked" }, { t, event: "confirm", answer: "once" }, { t, event: "confirm", answer: "deny" }, { t: new Date(2026, 9, 1).toISOString(), event: "task", phase: "asked" }];
    expect(todayCounts(entries, NOW)).toEqual({ tasks: 1, approvals: 1 });
  });

  it("names whether listening, memory and commands are on, and the other computers when there are any", () => {
    const off = { voice: "off" as const, memory: false, commands: 0, computers: 0, wsl: false };
    expect(whatsOnText(off)).toBe("Listening off · Memory off · Commands off");
    expect(whatsOnText({ ...off, voice: "listening", memory: true, commands: 2, computers: 2, wsl: true })).toBe("Listening on · Memory on · Commands on · 2 computers over SSH · WSL");
    expect(whatsOnText({ ...off, voice: "muted", computers: 1 })).toBe("Microphone off · Memory off · Commands off · 1 computer over SSH");
  });

  it("says what is in force, not what the settings ask for: policy, a lockdown, missing speech models and a microphone error turn the line off (home-r6-1)", () => {
    const settings = {
      ...DEFAULT_SETTINGS, wakeWord: true, voice: { ...DEFAULT_SETTINGS.voice, consent: true },
      commands: { local: { ...DEFAULT_SETTINGS.commands.local, on: true }, "ssh:build-01": { on: true } },
      targets: { ...DEFAULT_SETTINGS.targets, wsl: { ...DEFAULT_SETTINGS.targets.wsl, on: true }, hosts: [{ id: "build-01" }] },
    } as unknown as typeof DEFAULT_SETTINGS;
    const admin = { source: null, error: null, features: {}, commands: { local: "on", wsl: "on", ssh: "on" } } as const;
    const line = (o: Partial<Parameters<typeof whatsOn>[0]> = {}) => whatsOnText(whatsOn({ settings, admin, mic: "waiting", memory: true, ...o }));
    expect(line()).toBe("Listening on · Memory on · Commands on · 1 computer over SSH · WSL");
    expect(line({ mic: "active" })).toContain("Listening on");
    // The organisation turned commands and SSH off: neither is on, whatever the user's switches say.
    expect(line({ admin: { ...admin, source: "/etc/ember/policy.json", features: { ssh: false, wsl: false }, commands: { local: "off", wsl: "off", ssh: "off" } } })).toBe("Listening on · Memory on · Commands off");
    // Commands off on this computer only: the SSH host's still count.
    expect(line({ admin: { ...admin, commands: { local: "off", wsl: "on", ssh: "ask" } } })).toBe("Listening on · Memory on · Commands on · 1 computer over SSH · WSL");
    expect(line({ admin: { ...admin, commands: { local: "on", wsl: "on", ssh: "off" } }, settings: { ...settings, commands: { "ssh:build-01": { on: true } } } as unknown as typeof settings })).toContain("Commands off");
    expect(line({ admin: { ...admin, features: { voice: false, memory: false } } })).toBe("Listening off · Memory off · Commands on · 1 computer over SSH · WSL");
    // Locked down, fresh or held until a restart (no settings push comes with a held one): nothing is on.
    expect(line({ admin: { ...admin, error: "policy.json has a mistake" } })).toBe("Listening off · Memory off · Commands off");
    expect(line({ admin: { ...admin, error: "The policy changed", held: true } })).toBe("Listening off · Memory off · Commands off");
    // Listening is wanted and can't run: never "Listening on".
    expect(line({ mic: "needs-models" })).toMatch(/^Listening needs its speech models · /);
    expect(line({ mic: "downloading" })).toMatch(/^Listening needs its speech models · /);
    expect(line({ mic: "error" })).toMatch(/^Microphone problem · /);
    expect(line({ mic: "off" })).toMatch(/^Listening off · /);
    expect(line({ mic: "muted" })).toMatch(/^Microphone off · /);
    expect(line({ mic: "starting" })).toMatch(/^Listening starting… · /);
    expect(line({ mic: null })).toMatch(/^Listening starting… · /);
    // Listening not turned on or not agreed to is off whatever the microphone's state.
    expect(line({ settings: { ...settings, wakeWord: false } })).toMatch(/^Listening off · /);
    expect(line({ settings: { ...settings, voice: { ...settings.voice, consent: false } } })).toMatch(/^Listening off · /);
    // Memory paused stays paused; before the first status nothing is on.
    expect(line({ memory: "paused" })).toContain("Memory paused");
    expect(line({ settings: null, admin: null, mic: null, memory: false })).toBe("Listening off · Memory off · Commands off");
  });

  it("says memory is paused, not on, while its owner isn't verified (memory-2)", () => {
    expect(memoryWhatsOn(true, false, "ready")).toBe(true);
    expect(memoryWhatsOn(true, false, "locked")).toBe("paused");
    expect(memoryWhatsOn(true, false, "waiting")).toBe("paused");
    expect(memoryWhatsOn(false, false, "locked")).toBe(false);
    expect(memoryWhatsOn(false, true, "ready")).toBe("paused");
  });

  it("says memory is paused while its saved memory can't be read, as Settings › Memory does (memory-r2)", () => {
    expect(memoryWhatsOn(true, false, "ready", "unreadable")).toBe("paused");
    // Saving that failed this run, or a broken file set aside: memory still works now, and Settings says the rest.
    expect(memoryWhatsOn(true, false, "ready", "unsaved")).toBe(true);
    expect(memoryWhatsOn(true, false, "ready", "reset")).toBe(true);
    expect(memoryWhatsOn(false, false, "ready", "unreadable")).toBe(false);
  });
});

describe("the setup counts (UI audit #6)", () => {
  it("are the same in the tagline, the sidebar's badge and the setup check's note", () => {
    const rows = [
      { id: "location", label: "Applications folder", status: "warn" as const, fix: "move-to-applications" },
      { id: "os", label: "Operating system", status: "warn" as const },
      { id: "desktop", label: "Desktop", status: "warn" as const },
      { id: "ssh", label: "SSH client", status: "warn" as const },
    ];
    const v = setupView(rows, { opened: false, beforeStart: false });
    // Four rows warn, one needs the user: every place says one.
    expect(v.note).toBe("1 thing worth a look");
    expect(setupBadge(v.needing, v.failing)?.label).toBe(", 1 thing worth a look");
    expect(tagline({ failing: 0, look: v.needing - v.failing, onboarded: true, phase: "ready", hidden: false, overlay: true })).toMatch(/The setup check has 1 thing worth a look\.$/);
    expect(checksNote(0, 0)).toBe("All good");
    // Home's link to the check says the same count, and goes there.
    expect(setupLinkText(0, v.needing)).toBe("The setup check has 1 thing worth a look");
    expect(setupLinkText(2, 0)).toBe("Open the setup check");
    expect(setupLinkText(0, 0)).toBeNull();
  });

  it("call a row that holds Ember back one to fix, everywhere first run and the doctor do (first-run-5)", () => {
    const rows = [
      { id: "accessibility", label: "Screen reading", status: "warn" as const, detail: "Python accessibility bindings are missing." },
      { id: "os", label: "Operating system", status: "warn" as const, detail: "Another Linux." },
      { id: "ssh", label: "SSH client", status: "warn" as const, detail: "No SSH client found." },
    ];
    const v = setupView(rows, { opened: false, beforeStart: false });
    expect(v).toMatchObject({ failing: 0, held: 1, needing: 1, note: "1 thing to fix" });
    expect(setupBadge(v.needing, v.failing, v.held)).toEqual({ text: "1", label: ", 1 thing to fix", tone: "warn" });
    expect(setupLinkText(v.failing, v.needing - v.failing, v.held)).toBe("The setup check has 1 thing to fix");
    // The doctor names it and stops calling Ember fine; only a failure makes it say Ember can't work.
    const end = formatDoctor(rows).split("\n").at(-1);
    expect(end).toBe("1 thing to fix so Ember can read and use your apps (Screen reading), and 2 worth a look.");
    expect(formatDoctor(rows.slice(1)).split("\n").at(-1)).toBe("Ember can work. 2 things worth a look.");
  });
});

describe("Search settings", () => {
  const items = [{ pane: "voice", text: "Listen for “Hey Ember”" }, { pane: "access", text: "Text size" }, { pane: "pick", text: "Handle position" }, { pane: "voice", text: "Speak replies, questions and results out loud" }];

  it("finds a setting by every word typed, in any order, ignoring case, accents and quotes", () => {
    expect(searchMatches("hey ember", items).map(i => i.pane)).toEqual(["voice"]);
    expect(searchMatches("SIZE text", items)).toEqual([items[1]]);
    expect(searchMatches("  ", items)).toEqual([]);
    expect(searchMatches("nothing like this", items)).toEqual([]);
    expect(searchFold("Écran “Ember”")).toBe("ecran ember");
  });

  it("finds a pane by the other words people use for it, after the settings named by their own words (HIG search fields)", () => {
    const panes = [{ pane: "voice", text: "Voice", alias: SEARCH_ALIASES["voice-h"] }, { pane: "access", text: "Comfort & access", alias: SEARCH_ALIASES["access-h"] }, { pane: "access", text: "Glass" }];
    expect(searchMatches("mic", panes).map(i => i.text)).toEqual(["Voice"]);
    expect(searchMatches("microphone", panes).map(i => i.text)).toEqual(["Voice"]);
    // "glass" names a setting: it comes first (Enter goes there), and the pane found by its other words after it.
    expect(searchMatches("glass", panes).map(i => i.text)).toEqual(["Glass", "Comfort & access"]);
    for (const id of Object.keys(SEARCH_ALIASES)) expect(id).toMatch(/-h$/);
  });

  it("finds the Model provider group by the words people use for bringing their own key", () => {
    const items = [{ pane: "copilot", text: "Model provider", alias: SEARCH_ALIASES["byok-h"] }, { pane: "voice", text: "Voice", alias: SEARCH_ALIASES["voice-h"] }];
    for (const q of ["byok", "api key", "provider", "openai", "ollama", "LM Studio"]) expect(searchMatches(q, items).map(i => i.text), q).toEqual(["Model provider"]);
    expect(fs.readFileSync("app/renderer/home/index.html", "utf8")).toContain('<h3 class="sub" id="byok-h">Model provider</h3>');
  });

  /** A small element tree, shaped as the DOM gives it (text nodes 3, elements 1). */
  const text = (t: string): ShownNode => ({ nodeType: 3, nodeValue: t, childNodes: [] });
  const elem = (tagName: string, children: ShownNode[], o: { hidden?: boolean; aria?: string; cls?: string } = {}): ShownNode => ({
    nodeType: 1, nodeValue: null, tagName: tagName.toUpperCase(), hidden: o.hidden ?? false, childNodes: children,
    getAttribute: (n: string) => (n === "aria-hidden" ? o.aria ?? null : null), classList: { contains: (c: string) => c === o.cls },
  });

  it("reads a result's words as shown: no hidden alternatives, no pop-up's options, no words for screen readers only (home-6)", () => {
    const hint = elem("p", [
      elem("span", [text("When Ember asks “May I?”, press "), elem("kbd", [text("Ctrl")]), text("+"), elem("kbd", [text("Y")]), text(" to allow.")]),
      elem("span", [text("When Ember asks “May I?”, another app has the key for Allow.")], { hidden: true }),
      elem("span", [text("Decorative")], { aria: "true" }),
      elem("span", [text("Working: ")], { cls: "sr" }),
    ]);
    expect(shownText(hint)).toBe("When Ember asks “May I?”, press Ctrl+Y to allow.");
    const label = elem("label", [elem("span", [text("Appearance")]), elem("select", [elem("option", [text("Match this computer")]), elem("option", [text("Light")]), elem("option", [text("Dark")])])]);
    expect(shownText(label)).toBe("Appearance");
    expect(shownText(elem("div", [text("Source")]))).toBe("Source");
  });

  it("shows a long result as its sentence that holds the words typed, else its first (home-6)", () => {
    const hint = "Every decision and action is also in the audit folder. Ember keeps no usage statistics, and sends none. Nothing else is kept.";
    expect(settingsResultText("Apps & privacy", hint, "usage statistics")).toBe("Apps & privacy: Ember keeps no usage statistics, and sends none.");
    expect(settingsResultText("Apps & privacy", hint, "privacy")).toBe("Apps & privacy: Every decision and action is also in the audit folder.");
    expect(settingsResultText("Apps & privacy", hint)).toBe("Apps & privacy: Every decision and action is also in the audit folder.");
    // A short one stays whole, with its spaces tidied.
    expect(settingsResultText("Memory", "  Better\n recall  ", "recall")).toBe("Memory: Better recall");
    // One long sentence is cut at a word, with an ellipsis.
    const long = settingsResultText("Voice", `${"word ".repeat(60)}end`, "word");
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("…")).toBe(true);
  });

  it("finds the conversation's history, deleting, starting at log-in and the shortcuts by everyday words (home-13)", () => {
    const panes = ["conversation-h", "pick-h", "memory-h", "privacy-h", "access-h", "checks-h", "voice-h"].map(id => ({ pane: id, text: id, alias: SEARCH_ALIASES[id] }));
    const first = (q: string) => searchMatches(q, panes)[0]?.pane;
    for (const q of ["history", "clear history", "chat history", "transcript", "new chat", "delete messages"]) expect(first(q), q).toBe("conversation-h");
    for (const q of ["start at login", "login", "log in", "startup", "autostart"]) expect(first(q), q).toBe("pick-h");
    for (const q of ["shortcut", "keyboard shortcut", "hotkeys", "keys"]) expect(first(q), q).toBe("checks-h");
    for (const q of ["erase", "delete"]) expect(searchMatches(q, panes).map(p => p.pane), q).toEqual(expect.arrayContaining(["conversation-h", "memory-h"]));
  });

  it("finds the log file in Setup & about by the words people use for it, and still log-in in Your Ember (home-r2)", () => {
    const panes = ["pick-h", "checks-h"].map(id => ({ pane: id, text: id, alias: SEARCH_ALIASES[id] }));
    for (const q of ["log", "logs", "log file"]) expect(searchMatches(q, panes).map(p => p.pane), q).toContain("checks-h");
    for (const q of ["log in", "login"]) expect(searchMatches(q, panes).map(p => p.pane), q).toEqual(["pick-h"]);
  });

  it("finds what Ember reads, sends and keeps by the words people look for it with (safety-privacy-9)", () => {
    const panes = ["conversation-h", "privacy-h", "privacy-terms-h", "activity-h"].map(id => ({ pane: id, text: id, alias: SEARCH_ALIASES[id] }));
    for (const q of ["screenshot", "data", "usage statistics", "privacy policy", "kept", "audit"]) expect(searchMatches(q, panes)[0]?.pane, q).toBe("privacy-terms-h");
    expect(fs.readFileSync("app/renderer/home/index.html", "utf8")).toContain('<details class="fold" id="privacy-terms-fold" aria-labelledby="privacy-terms-h">');
  });

  it("says how many it found and where, for a screen reader", () => {
    expect(searchMessage("", 0, 0)).toBe("");
    expect(searchMessage("zzz", 0, 0)).toBe("Nothing found. Try another word.");
    expect(searchMessage("out", 2, 1)).toBe("2 matches in 1 section. Press Enter for the first, or choose a result.");
    expect(searchMessage("a", 1, 1)).toBe("1 match in 1 section. Press Enter for the first, or choose a result.");
  });
});

describe("Home's style sheet", () => {
  it("closes every block it opens, so a rule after a merge isn't swallowed (first run showed Home's panes once)", () => {
    const css = fs.readFileSync(path.resolve("app/renderer/home/styles.css"), "utf8").replace(/\/\*[^]*?\*\//g, "");
    let depth = 0;
    for (const ch of css) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    // First run shows only its steps and the organisation's notices, at the top level of the sheet.
    expect(css).toMatch(/(?:^|\n)body\.first-run \.home > :not\(#welcome, #managed, #settings-notice, #provider-off\) \{ display: none; \}/);
  });
});

describe("Home's panes and its Task activity channel", () => {
  const page = fs.readFileSync(path.resolve("app/renderer/home/index.html"), "utf8");
  const MAIN = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8");
  const preload = fs.readFileSync(path.resolve("app/preload/home.ts"), "utf8");

  it("puts every section after the first run on a pane a sidebar link opens (UI audit #1)", () => {
    // The page's own sections (first run's steps use the same attribute inside #welcome, and aren't panes).
    const panes = new Set([...page.matchAll(/<section[^>]*data-pane="(\w+)"/g)].map(m => m[1]));
    const links = [...page.matchAll(/<a href="#([\w-]+)-h"/g)].map(m => m[1]);
    for (const l of links) expect(page, l).toMatch(new RegExp(`<section[^>]*data-pane="\\w+"[^>]*>\\s*(?:<[^>]+>\\s*)*?<h[12] id="${l}-h"`));
    expect(links[0]).toBe("home");
    expect(panes).toEqual(new Set(["home", "projects", "pick", "copilot", "voice", "memory", "privacy", "computers", "commands", "extensions", "access", "checks"]));
    expect(page).toContain('<a href="#project-h">Projects</a>');
    expect(page).toContain('<a href="#copilot-h">Models &amp; connections</a>');
    // The status panel, the conversation, Task activity and What Ember did are Home's.
    for (const h of ["home-h", "conversation-h", "tasks-h", "activity-h"]) expect(page).toMatch(new RegExp(`data-pane="home"[^>]*>[^]*?id="${h}"`));
  });

  it("asks main for the tasks only from the settings window, and pushes them only there, at most every half second", () => {
    expect(IPC.tasks).toBe("tasks:activity");
    expect(IPC.tasksChanged).toBe("tasks:activity-changed");
    expect(TASKS_PUSH_MS).toBe(500);
    expect(MAIN).toContain("ipcMain.handle(IPC.tasks, guard(() => agent?.taskActivities() ?? []));");
    expect(MAIN).toContain("const pushTasks = pushLater(TASKS_PUSH_MS, () => { if (home && !home.isDestroyed()) home.webContents.send(IPC.tasksChanged, agent?.taskActivities() ?? []); });");
    expect(MAIN).toContain("tasksShown = () => { if (home && !home.isDestroyed()) pushTasks(); };");
    expect(MAIN).toContain("if (next.tasks) tasksShown();");
    expect(preload).toContain("tasks: () => ipcRenderer.invoke(IPC.tasks),");
    expect(preload).toContain("onTasks: fn => listen<TaskEntry[]>(IPC.tasksChanged, fn),");
  });
});
