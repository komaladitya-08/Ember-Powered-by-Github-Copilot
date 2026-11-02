/**
 * Home's status panel and its search (app/renderer/home/status-copy.ts, search-copy.ts), its panes, and main's
 * Task activity channel: what the panel says comes from the same tasks Task activity lists, so the two never disagree
 * (owner review of the first render), and the setup counts agree everywhere (UI audit #6).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setupLinkText, statusWord, taskCounts, todayCounts, todaySummary, whatsOnText } from "../../app/renderer/home/status-copy";
import { SEARCH_ALIASES, searchFold, searchMatches, searchMessage } from "../../app/renderer/home/search-copy";
import { checksNote, setupBadge, setupView, tagline } from "../../app/renderer/home/copy";
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
});

describe("the setup counts (UI audit #6)", () => {
  it("are the same in the tagline, the sidebar's badge and the setup check's note", () => {
    const rows = [
      { id: "accessibility", label: "Screen reading", status: "warn" as const, fix: "a11y" },
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

  it("says how many it found and where, for a screen reader", () => {
    expect(searchMessage("", 0, 0)).toBe("");
    expect(searchMessage("zzz", 0, 0)).toBe("Nothing found. Try another word.");
    expect(searchMessage("out", 2, 1)).toBe("2 matches in 1 section. Press Enter to go to the first.");
    expect(searchMessage("a", 1, 1)).toBe("1 match in 1 section. Press Enter to go to the first.");
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
    expect(css).toMatch(/(?:^|\n)body\.first-run \.home > :not\(#welcome, #managed, #settings-notice\) \{ display: none; \}/);
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
    expect(panes).toEqual(new Set(["home", "pick", "copilot", "voice", "memory", "privacy", "computers", "commands", "extensions", "access", "checks"]));
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
