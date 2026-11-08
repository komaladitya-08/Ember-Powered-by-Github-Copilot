/**
 * Home's status panel and its search (app/renderer/home/status-copy.ts, search-copy.ts), its panes, and main's
 * Task activity channel: what the panel says comes from the same tasks Task activity lists, so the two never disagree
 * (owner review of the first render), and the setup counts agree everywhere (UI audit #6).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { connectLabel, memoryWhatsOn, setupLinkText, statusWord, taskCounts, todayCounts, todaySummary, whatsOnText } from "../../app/renderer/home/status-copy";
import { SEARCH_ALIASES, searchFold, searchMatches, searchMessage, shownText, type ShownNode } from "../../app/renderer/home/search-copy";
import { checksNote, COMPOSER_THINKING, composerStillWaiting, settingsResultText, setupBadge, setupView, tagline } from "../../app/renderer/home/copy";
import { formatDoctor } from "../../app/main/doctor";
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
    expect(COMPOSER_THINKING).toBe("Thinking… Ember's reply will appear above.");
    expect(composerStillWaiting()).toBe("Still waiting for Copilot… Stop response ends this reply.");
    expect(composerStillWaiting("user")).toBe("Still waiting for your model provider… Stop response ends this reply.");
    expect(composerStillWaiting("admin")).toBe("Still waiting for the model service… Stop response ends this reply.");
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
    expect(fs.readFileSync("app/renderer/home/main.ts", "utf8")).toContain("setText(\"p-connect\", connectLabel(agent?.service?.kind));");
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
