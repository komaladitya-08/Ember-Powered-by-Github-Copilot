/**
 * Built Home in Chromium, its panes as a person reads and moves through them (2026-11-07 product audit): Task activity
 * while a task works, Search settings, What Ember did, Apps & privacy, and the layout at zoom and in contrast themes.
 * Only the preload boundary (window.ember) is replaced; nothing is read, sent or kept.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import { unbrokenRuns } from "../../app/renderer/home/computers-copy";
import type { TaskEntry, ActivityItem } from "../../app/shared/activity";
import type { ActivityEntry } from "../../app/shared/ipc";

declare global {
  interface Window {
    __pane: {
      calls: string[];
      emit(name: string, value: unknown): void;
      activity: ActivityEntry[] | "fail";
      reads: number;
    };
  }
}

const gate = process.env.EMBER_UIUX_TEST !== "1";

interface Seed { settings?: Record<string, unknown>; activity?: ActivityEntry[] | "fail"; viewport?: { width: number; height: number } }

let browser: Browser;
let server: http.Server;
let port = 0;

beforeAll(async () => {
  if (gate) return;
  browser = await chromium.launch({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const dist = path.resolve("dist");
  server = http.createServer((req, res) => {
    const file = path.resolve(dist, `.${decodeURIComponent((req.url ?? "/").split("?")[0])}`);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
    res.setHeader("content-type", mime[path.extname(file)] ?? "application/octet-stream");
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => { if (gate) return; await browser.close(); server.close(); });

/** Home after first run, on `pane`. */
async function open(pane: string, seed: Seed = {}): Promise<Page & { errors: string[] }> {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...seed.settings };
  settings.onboarded = true;
  settings.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
  const admin = { source: null, error: null, managed: [], features: {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [] };
  const page = await browser.newPage({ viewport: seed.viewport ?? { width: 1000, height: 900 } }) as Page & { errors: string[] };
  page.errors = [];
  page.on("pageerror", e => page.errors.push(e.message));
  await page.addInitScript(({ settings, admin, activity }) => {
    const subs: Record<string, ((v: unknown) => void)[]> = {};
    // Main's list as last pushed: what a read after a task control gets.
    let tasks: unknown = [];
    const h = window.__pane = {
      calls: [] as string[],
      emit: (name: string, value: unknown) => { if (name === "onTasks") tasks = value; for (const fn of subs[name] ?? []) fn(value); },
      activity: activity as ActivityEntry[] | "fail",
      reads: 0,
    };
    const status = () => ({ appVersion: "0.1.1", settings, environment: { checks: [], versions: { node: "24", electron: "44", chrome: "152" } }, logFile: "/test/ember.log", settingsNotice: null, admin });
    window.ember = new Proxy({}, { get: (_t, name: string) => {
      if (name.startsWith("on")) return (fn: (v: unknown) => void) => { (subs[name] ??= []).push(fn); return () => undefined; };
      if (name === "getStatus") return async () => status();
      if (name === "updateSettings") return async (patch: Record<string, unknown>) => { h.calls.push(`save:${JSON.stringify(patch)}`); };
      if (name === "conversation") return async () => [];
      if (name === "tasks") return async () => tasks;
      if (name === "taskControl") return async (id: string, kind: string) => { h.calls.push(`taskControl:${id}:${kind}`); return true; };
      // As main answers: the newest `limit` entries (500 unless Home asks for more).
      if (name === "activity") return async (limit?: number) => { h.reads++; if (h.activity === "fail") throw new Error("EACCES: permission denied"); return h.activity.slice(0, limit ?? 500); };
      return () => new Promise(() => undefined);
    } }) as never;
  }, { settings, admin, activity: seed.activity ?? [] });
  await page.goto(`http://127.0.0.1:${port}/app/renderer/home/index.html`);
  await page.waitForSelector(`a[href='#${pane}-h']`);
  await page.evaluate(() => document.body.classList.remove("loading", "first-run"));
  await page.locator(`a[href='#${pane}-h']`).first().click();
  return page;
}

/** With EMBER_UI_EVIDENCE set, a screenshot for the render check (in light, then dark). */
async function evidence(p: Page, name: string): Promise<void> {
  const dir = process.env.EMBER_UI_EVIDENCE;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(dir, `${name}-${scheme}.png`), fullPage: true });
  }
}

/** Marks the groups drawn now, then waits until main's next list has drawn each again. */
async function redrawn(p: Page, push: () => Promise<unknown>): Promise<void> {
  await p.evaluate(() => { for (const g of document.querySelectorAll("#tasks .task-group")) g.setAttribute("data-old", ""); });
  await push();
  await expect.poll(() => p.locator("#tasks .task-group[data-old]").count()).toBe(0);
}

const focusedName = (p: Page) => p.evaluate(() => {
  const a = document.activeElement as HTMLElement | null;
  return a ? a.getAttribute("aria-label") ?? a.textContent?.trim().slice(0, 80) ?? a.tagName : "";
});

const step = (i: number, words: string): ActivityItem => ({ id: `s${i}`, kind: "step", at: i * 500, endedAt: i * 500 + 200, state: "done", words, group: "click", app: "Text Editor" });
const task = (id: string, title: string, items: ActivityItem[], status: TaskEntry["status"] = "running"): TaskEntry => ({
  id, title, status, controls: { stop: status === "running" || status === "waiting", retry: status === "failed", window: true },
  activity: { startedAt: Date.now() - 5000, items, dropped: 0, steps: items.length, failedSteps: 0, counts: {}, questions: 0, approvals: 0, asking: status === "waiting", retry: 0, slow: false, nearLimit: false, live: "Working in Text Editor" },
});

describe.skipIf(gate)("Home's Task activity, while a task works (2026-11-07 product audit)", () => {
  it("keeps keyboard focus on a running task's control when the task does its next step (home-2)", async () => {
    const page = await open("home");
    const one = [step(1, "Clicked in Text Editor")];
    await page.evaluate(t => window.__pane.emit("onTasks", t), [task("1-aaaa", "Write a note", one)]);
    const stop = page.getByRole("button", { name: "Stop task: Write a note", exact: true });
    await stop.focus();
    expect(await focusedName(page)).toBe("Stop task: Write a note");
    // The same task, one step on: its group is drawn again.
    const two = [...one, step(2, "Typed in Text Editor")];
    await redrawn(page, () => page.evaluate(t => window.__pane.emit("onTasks", t), [task("1-aaaa", "Write a note", two)]));
    expect(await focusedName(page)).toBe("Stop task: Write a note");
    // Enter still reaches it.
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.__pane.calls)).toContain("taskControl:1-aaaa:stop");
    // Show app, the next control, keeps focus the same way.
    const show = page.getByRole("button", { name: "Show app: Write a note", exact: true });
    await show.focus();
    await redrawn(page, () => page.evaluate(t => window.__pane.emit("onTasks", t), [task("1-aaaa", "Write a note", [...two, step(3, "Saved in Text Editor")])]));
    expect(await focusedName(page)).toBe("Show app: Write a note");
    await evidence(page, "tasks-focus");
    expect(page.errors).toEqual([]);
    await page.close();
  });

  it("keeps focus on the waiting task's Open approval when the task's group is drawn again (home-2)", async () => {
    const page = await open("home");
    const ask: ActivityItem = { id: "q1", kind: "question", at: 900, state: "waiting", words: "Asked to click in Text Editor", app: "Text Editor", askedIn: "bubble" };
    await page.evaluate(t => window.__pane.emit("onTasks", t), [task("2-bbbb", "Save a file", [step(1, "Clicked in Text Editor"), ask], "waiting")]);
    const approval = page.locator("#tasks-open-approval");
    await expect.poll(() => approval.isVisible()).toBe(true);
    await approval.focus();
    const again = task("2-bbbb", "Save a file", [step(1, "Clicked in Text Editor"), ask], "waiting");
    await redrawn(page, () => page.evaluate(t => window.__pane.emit("onTasks", t), [{ ...again, activity: { ...again.activity, questions: 1 } }]));
    expect(await approval.isVisible()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("tasks-open-approval");
    await page.close();
  });
});

const results = (p: Page, q: string) => p.evaluate(async query => {
  const field = document.getElementById("search") as HTMLInputElement;
  field.value = query;
  field.dispatchEvent(new Event("input"));
  await new Promise(r => setTimeout(r, 20));
  return [...document.querySelectorAll("#search-results .search-result")].map(b => b.textContent ?? "");
}, q);

describe.skipIf(gate)("Home's Search settings, as the person reads the results (2026-11-07 product audit)", () => {
  it("shows each result as the words on the page, once, without hidden alternatives or a pop-up's options (home-6)", async () => {
    const page = await open("home");
    const reader = await results(page, "screen reader");
    expect(reader.length).toBeGreaterThan(0);
    for (const r of reader) {
      expect(r.length, r).toBeLessThan(200);
      expect(r.split("May I?").length - 1, r).toBeLessThanOrEqual(1);
      // The alternatives for a key another app holds never show beside the one in force.
      expect(r, r).not.toContain("another app has the key");
    }
    for (const r of [...await results(page, "source"), ...await results(page, "dark")]) {
      expect(r).not.toMatch(/SourceAll sources|You told meFrom/);
      expect(r).not.toContain("Match this computer Light Dark");
    }
    // A pop-up's choice still finds its setting, named by its label alone.
    expect(await results(page, "when a screen reader runs")).toContain("Voice: Speak replies, questions and results out loud");
    expect(page.errors).toEqual([]);
    await page.close();
  });

  it("finds the conversation's history, deleting, starting at log-in and the shortcuts by everyday words (home-13)", async () => {
    const page = await open("home");
    for (const q of ["history", "clear history", "chat"]) expect((await results(page, q))[0], q).toMatch(/^Home: /);
    for (const q of ["start at login", "login", "autostart"]) expect((await results(page, q))[0], q).toMatch(/^Your Ember: /);
    for (const q of ["shortcut", "keyboard shortcut", "hotkeys"]) expect((await results(page, q)).length, q).toBeGreaterThan(0);
    expect((await results(page, "delete")).some(r => r.startsWith("Memory: "))).toBe(true);
    expect(await page.locator("#search-none").isHidden()).toBe(true);
    await page.close();
  });
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const clickEntry = (m: number): ActivityEntry => ({ t: minutesAgo(m), event: "action", kind: "click", app: "gedit", ok: true, element: { role: "push button", name: "Save" } });
/** 120 actions in the last hour (or `today`), then yesterday's task with an allowed Send. */
const seeded = (today = 120): ActivityEntry[] => [
  ...Array.from({ length: today }, (_, i) => clickEntry(i * (50 / today))),
  { t: minutesAgo(24 * 60), event: "confirm", kind: "click", app: "thunderbird", answer: "once", element: { role: "push button", name: "Send" } },
  { t: minutesAgo(24 * 60 + 1), event: "decision", kind: "click", app: "thunderbird", verdict: "confirm", reason: "it sends", element: { role: "push button", name: "Send" } },
  { t: minutesAgo(24 * 60 + 2), event: "task", phase: "asked", goal: "Send the report" },
];
const lineCount = (p: Page) => p.locator("#activity li:not(.day):not(.more)").count();

describe.skipIf(gate)("Home's What Ember did, as the person looks back (2026-11-07 product audit)", () => {
  it("counts all of today, and shows earlier lines a page at a time with focus on the first new one (safety-privacy-5)", async () => {
    // Skip a run that would cross midnight: "today" must stay today for the hour seeded.
    if (new Date().getHours() === 0) return;
    const page = await open("home", { activity: seeded() });
    await page.locator("#activity-fold > summary").click();
    await expect.poll(() => lineCount(page)).toBe(80);
    expect(await page.locator("#activity-note").innerText()).toBe("120 today");
    expect(await page.locator("#activity").innerText()).not.toContain("Yesterday");
    const earlier = page.getByRole("button", { name: "Show earlier" });
    await earlier.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => lineCount(page)).toBe(123);
    // Focus is on the first line it added, not lost to the page.
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.line)).toBe("80");
    expect(await page.locator("#activity li.day").allInnerTexts()).toEqual(["Today", "Yesterday"]);
    expect(await page.locator("#activity").innerText()).toContain("Click “Send” in Thunderbird");
    // Everything read is showing, and the record held no more: no Show earlier.
    expect(await earlier.count()).toBe(0);
    await evidence(page, "activity-earlier");
    expect(page.errors).toEqual([]);
    await page.close();
  });

  it("reads further back in the record when the lines read run out (safety-privacy-5)", async () => {
    if (new Date().getHours() === 0) return;
    // 600 today: the first read (500) can't hold them all.
    const page = await open("home", { activity: seeded(600) });
    await page.locator("#activity-fold > summary").click();
    await expect.poll(() => lineCount(page)).toBe(80);
    expect(await page.locator("#activity-note").innerText()).toBe("At least 500 today");
    for (let i = 0; i < 7; i++) await page.getByRole("button", { name: "Show earlier" }).click();
    await expect.poll(() => lineCount(page)).toBe(603);
    expect(await page.locator("#activity-note").innerText()).toBe("600 today");
    await page.close();
  });

  it("keeps what it showed when a read of the record fails, says so, and clears that on the next good read (home-10)", async () => {
    if (new Date().getHours() === 0) return;
    const page = await open("home", { activity: seeded(3) });
    await page.locator("#activity-fold > summary").click();
    await expect.poll(() => lineCount(page)).toBe(6);
    expect(await page.locator("#activity-note").innerText()).toBe("3 today");
    await page.evaluate(() => { window.__pane.activity = "fail"; });
    const problem = page.locator("#activity-problem");
    await expect.poll(() => problem.isVisible(), { timeout: 8000 }).toBe(true);
    expect(await problem.innerText()).toBe("Ember couldn't read its record just now, so this list may be out of date. It tries again every few seconds; the whole record is in the folder below.");
    expect(await lineCount(page)).toBe(6);
    expect(await page.locator("#activity-note").innerText()).toBe("3 today");
    await page.evaluate(() => { window.__pane.activity = []; });
    await expect.poll(() => problem.isVisible(), { timeout: 8000 }).toBe(false);
    await page.close();
  }, 30_000);

  it("shows every tag whole at each text size, and an Always in an app as a lasting grant (safety-privacy-10)", async () => {
    const at = minutesAgo(1);
    const thunderbird = { app: "thunderbird", kind: "click", element: { role: "push button", name: "Send" } };
    const entries: ActivityEntry[] = [
      { t: at, event: "decision", verdict: "allow", autonomy: true, ...thunderbird },
      { t: at, event: "confirm", answer: "always", ...thunderbird },
      { t: at, event: "confirm", answer: "once", ...thunderbird },
      { t: at, event: "confirm", answer: "deny", ...thunderbird },
      { t: at, event: "confirm", answer: "expired", ...thunderbird },
      { t: at, event: "action", ok: false, error: "it didn't work", ...thunderbird },
      { t: at, event: "decision", verdict: "deny", kind: "read", app: "keepassxc", reason: "this app is on the user's never-look list" },
      { t: at, event: "command", phase: "decided", verdict: "announce", shell: "bash", target: "local", reason: "r" },
      { t: at, event: "remote", step: "connected", host: "build-01" },
    ];
    const page = await open("home", { activity: entries, viewport: { width: 700, height: 900 } });
    await page.locator("#activity-fold > summary").click();
    await expect.poll(() => lineCount(page)).toBe(entries.length);
    const tags = await page.locator("#activity .tag").allInnerTexts();
    expect(tags).toEqual(expect.arrayContaining(["Without asking", "Always allowed", "You allowed", "You said no", "No answer", "Didn't work", "Refused", "Announced", "Connected"]));
    expect(await page.locator("#activity").innerText()).toContain("Read in KeePassXC");
    expect(await page.locator("#activity").innerText()).toContain("From now on Ember may act in Thunderbird without asking first");
    for (const size of ["", "large", "larger"]) {
      await page.evaluate(sz => { if (sz) document.documentElement.dataset.textSize = sz; else delete document.documentElement.dataset.textSize; }, size);
      const cut = await page.locator("#activity .tag").evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth).map(e => e.textContent));
      expect(cut, size || "default").toEqual([]);
    }
    await evidence(page, "activity-tags");
    await page.close();
  });

  it("never says Ember did nothing when its first read of the record fails (home-10)", async () => {
    const page = await open("home", { activity: "fail" });
    await page.locator("#activity-fold > summary").click();
    const problem = page.locator("#activity-problem");
    await expect.poll(() => problem.isVisible(), { timeout: 8000 }).toBe(true);
    expect(await problem.innerText()).toContain("so nothing can show here yet");
    expect(await page.locator("#activity").isVisible()).toBe(false);
    await page.close();
  }, 30_000);
});

describe.skipIf(gate)("Home's Apps & privacy, as the person edits its lists (2026-11-07 product audit)", () => {
  it("says what removing an entry from Never look at or an app's Always changed, with focus on the next Remove (safety-privacy-11)", async () => {
    const neverLook = [...DEFAULT_SETTINGS.privacy.neverLook];
    const page = await open("privacy", { settings: { grants: { thunderbird: "act", gedit: "act" } } });
    const removeKeePass = page.getByRole("button", { name: "Remove KeePassXC", exact: true });
    await expect.poll(() => removeKeePass.isVisible()).toBe(true);
    await removeKeePass.click();
    // Main saves it and sends the settings back: the list is drawn again without it.
    await page.evaluate(async list => {
      const st = await (window as unknown as { ember: { getStatus(): Promise<{ settings: Record<string, unknown> }> } }).ember.getStatus();
      window.__pane.emit("onSettingsChanged", { ...st.settings, privacy: { ...(st.settings.privacy as object), neverLook: list } });
    }, neverLook.filter(x => x !== "keepassxc"));
    await expect.poll(() => page.locator("#never-look-msg").innerText()).toBe("Removed KeePassXC. Ember may read its windows now; Restore defaults puts it back.");
    expect(await focusedName(page)).toBe(`Remove ${"Seahorse"}`);
    await page.getByRole("button", { name: "Remove Thunderbird", exact: true }).click();
    await expect.poll(() => page.locator("#grants-msg").innerText()).toBe("Removed Thunderbird. Ember asks again before its first action there.");
    expect(await page.evaluate(() => window.__pane.calls)).toContain(`save:${JSON.stringify({ grants: { gedit: "act" } })}`);
    await page.close();
  });
});

describe.skipIf(gate)("Home's Apps & privacy, after setup (2026-11-07 product audit)", () => {
  it("shows what Ember reads, sends and keeps, word for word as before it started, and Search finds it (safety-privacy-9)", async () => {
    const page = await open("privacy");
    const fold = page.locator("#privacy-terms-fold");
    expect(await fold.isVisible()).toBe(true);
    await fold.locator("summary").click();
    const shown = await page.locator("#privacy-terms").evaluate(e => e.textContent);
    const consent = await page.locator("#w-full ul.terms").evaluate(e => e.textContent);
    expect(shown).toBe(consent);
    expect(shown).toContain("It sends no usage statistics.");
    expect(shown).toContain("~/.config/ember");
    // The copy keeps no ids: each still names one element.
    expect(await page.locator("#privacy-terms [id]").count()).toBe(0);
    await fold.locator("summary").click();
    // The switch that sends screenshots is found by its own words, so it comes first (safety-privacy-7); the
    // disclosure follows it, and is the first result for the words only it has.
    const shots = await results(page, "screenshot");
    expect(shots[0]).toBe("Apps & privacy: Send screenshots for tasks");
    expect(shots).toContain("Apps & privacy: What Ember reads, sends and keeps");
    expect((await results(page, "usage statistics"))[0]).toBe("Apps & privacy: What Ember reads, sends and keeps");
    expect(await fold.evaluate(d => (d as HTMLDetailsElement).open)).toBe(false);
    await page.locator("#search").press("Enter");
    await expect.poll(() => fold.evaluate(d => (d as HTMLDetailsElement).open)).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.closest("details")?.id)).toBe("privacy-terms-fold");
    await evidence(page, "privacy-terms");
    expect(page.errors).toEqual([]);
    await page.close();
  });
});

describe.skipIf(gate)("Home's Projects and Memory panes, as laid out (2026-11-07 product audit)", () => {
  /** Visible buttons as wide as their parent's box, and visible empty children of a group that still take height. */
  const layout = (p: Page) => p.evaluate(() => {
    const shown = (e: Element) => (e as HTMLElement).offsetParent !== null && !e.closest(".off-pane");
    const wide = [...document.querySelectorAll<HTMLElement>(".home button.btn")].filter(b => shown(b) && b.parentElement && b.getBoundingClientRect().width >= b.parentElement.getBoundingClientRect().width - 1 && b.getBoundingClientRect().width > 200).map(b => b.id || b.textContent);
    const blank = [...document.querySelectorAll<HTMLElement>(".home .group > *")].filter(e => shown(e) && !e.textContent?.trim() && !e.matches("input, select, textarea, button, canvas, progress") && !e.querySelector("input, select, textarea, button, canvas, progress") && e.getBoundingClientRect().height > 0).map(e => e.id || e.className);
    return { wide, blank };
  });

  it("keeps lone buttons their own size and leaves no blank rows in Projects (accessibility-visual-4, home-12, accessibility-visual-3)", async () => {
    const page = await open("project");
    await page.locator("#project-commands > summary").click();
    await page.locator("#project-workspaces > summary").click();
    expect(await layout(page)).toEqual({ wide: [], blank: [] });
    // The fold's chevron, not the browser's triangle; one filled button in Saved workspaces.
    for (const id of ["project-commands", "project-workspaces"]) {
      expect(await page.locator(`#${id} > summary`).evaluate(s => getComputedStyle(s).display)).toBe("flex");
      expect(await page.locator(`#${id} > summary`).evaluate(s => getComputedStyle(s, "::before").content)).toContain('""');
    }
    const accent = await page.locator("#project-workspaces .btn").evaluateAll(bs => bs.filter(b => !b.classList.contains("quiet")).map(b => b.id));
    expect(accent).toEqual(["project-workspace-save"]);
    await evidence(page, "projects-layout");
    await page.close();
  });

  it("keeps Refresh list its own size, and puts the routines footnote under its switch (accessibility-visual-4, integrations-14)", async () => {
    const page = await open("memory");
    await expect.poll(() => page.locator("#reminders-refresh").isVisible()).toBe(true);
    expect((await layout(page)).wide).toEqual([]);
    const box = async (id: string) => (await page.locator(`#${id}`).boundingBox())!;
    expect((await box("routines-hint")).y).toBeLessThan((await box("reminders-h")).y);
    // No empty footnote leaves a gap under Memory's switches.
    const under = await page.evaluate(() => {
      const group = document.getElementById("memory-on")!.closest(".group")!;
      let next = group.nextElementSibling as HTMLElement | null;
      while (next && (getComputedStyle(next).display === "none" || getComputedStyle(next).position === "absolute")) next = next.nextElementSibling as HTMLElement | null;
      return next ? next.getBoundingClientRect().top - group.getBoundingClientRect().bottom : 0;
    });
    expect(under).toBeLessThanOrEqual(8);
    await evidence(page, "memory-layout");
    await page.close();
  });
});

describe.skipIf(gate)("the Computers pane's status line", () => {
  it("wraps a long hyphenated host name instead of scrolling the pane sideways, at 304 px and Larger text (commands-remote-r3, WCAG 1.4.10)", async () => {
    const page = await open("home", { viewport: { width: 304, height: 700 } });
    await page.evaluate(() => { document.getElementById("jump-computers")!.hidden = false; document.getElementById("computers")!.hidden = false; });
    await page.locator('.jump a[href="#computers-h"]').first().click();
    const over: string[] = [];
    for (const host of ["jenkins-agent-prod-eu-west-1a.build-farm.internal.example-corp.com", "ip-10-0-12-34.eu-west-1.compute.internal"]) {
      const runs = unbrokenRuns(`Ember can't find ${host}. Check the name, or add it to your SSH config. It wasn't added to Computers.`);
      for (const size of ["", "larger"]) {
        for (const width of [304, 400, 760]) {
          await page.setViewportSize({ width, height: 700 });
          const d = await page.evaluate(({ runs, size }) => {
            if (size) document.documentElement.dataset.textSize = size; else delete document.documentElement.dataset.textSize;
            // The line as Home's say() draws it: each run whole in its own span.
            const line = document.getElementById("computers-msg")!;
            line.textContent = "";
            for (const r of runs) {
              if (!r.whole) { line.append(document.createTextNode(r.text)); continue; }
              const s = document.createElement("span");
              s.className = "whole";
              s.textContent = r.text;
              line.append(s);
            }
            return document.documentElement.scrollWidth - document.documentElement.clientWidth;
          }, { runs, size });
          if (d > 0) over.push(`${host} at ${width} px ${size || "default"}: +${d}`);
        }
      }
    }
    expect(over).toEqual([]);
    await page.setViewportSize({ width: 304, height: 700 });
    await page.locator("#computers-msg").scrollIntoViewIfNeeded();
    await evidence(page, "computers-long-host-304-larger");
    await page.close();
  }, 60_000);
});

describe.skipIf(gate)("Home at 200% zoom and more (2026-11-07 product audit)", () => {
  it("never scrolls a pane sideways at 304 to 420 px wide, at Default and Larger text (accessibility-visual-v1, WCAG 1.4.10)", async () => {
    const page = await open("home", { viewport: { width: 320, height: 700 } });
    const panes = await page.locator(".jump a[href]").evaluateAll(as => as.filter(a => !(a as HTMLElement).hidden).map(a => a.getAttribute("href")!));
    const over: string[] = [];
    for (const size of ["", "larger"]) {
      await page.evaluate(sz => { if (sz) document.documentElement.dataset.textSize = sz; else delete document.documentElement.dataset.textSize; }, size);
      for (const width of [304, 320, 380, 420]) {
        await page.setViewportSize({ width, height: 700 });
        for (const href of panes) {
          await page.locator(`.jump a[href="${href}"]`).first().click();
          const d = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (d > 0) over.push(`${href} at ${width} px ${size || "default"}: +${d}`);
        }
      }
    }
    expect(over).toEqual([]);
    await page.setViewportSize({ width: 380, height: 700 });
    await page.locator('.jump a[href="#privacy-h"]').first().click();
    await evidence(page, "privacy-380-larger");
    await page.close();
  }, 60_000);
});
