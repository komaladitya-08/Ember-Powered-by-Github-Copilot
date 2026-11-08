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
import type { ActivityEntry, StatusPlatform, UpdateStatus } from "../../app/shared/ipc";
import { FALLBACK_SHORTCUTS, heldShortcuts, SHORTCUTS, shownShortcuts } from "../../app/shared/shortcuts";

declare global {
  interface Window {
    __pane: {
      calls: string[];
      emit(name: string, value: unknown): void;
      activity: ActivityEntry[] | "fail";
      reads: number;
      /** How many entries each read asked for. */
      limits: number[];
      /** With `provider` seeded: main's provider-state reads, each waiting until the test answers it. */
      providerReads: ((state: unknown) => void)[];
    };
  }
}

const gate = process.env.EMBER_UIUX_TEST !== "1";

interface Seed { settings?: Record<string, unknown>; admin?: Record<string, unknown>; activity?: ActivityEntry[] | "fail"; viewport?: { width: number; height: number }; checks?: { id: string; status: string; label: string; detail: string; fix?: string }[]; platform?: StatusPlatform; updates?: UpdateStatus; provider?: boolean }

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
  const admin = { source: null, error: null, managed: [], features: {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [], ...seed.admin };
  const page = await browser.newPage({ viewport: seed.viewport ?? { width: 1000, height: 900 } }) as Page & { errors: string[] };
  page.errors = [];
  page.on("pageerror", e => page.errors.push(e.message));
  await page.addInitScript(({ settings, admin, activity, checks, platform, updates, provider }) => {
    const subs: Record<string, ((v: unknown) => void)[]> = {};
    // Main's list as last pushed: what a read after a task control gets.
    let tasks: unknown = [];
    const h = window.__pane = {
      calls: [] as string[],
      emit: (name: string, value: unknown) => { if (name === "onTasks") tasks = value; for (const fn of subs[name] ?? []) fn(value); },
      activity: activity as ActivityEntry[] | "fail",
      reads: 0,
      limits: [] as number[],
      providerReads: [] as ((state: unknown) => void)[],
    };
    // Main's provider bridge, as in Electron: each state read answers when the test says (home-mic-recipient's pattern).
    if (provider) (window as unknown as { emberProvider: unknown }).emberProvider = { state: () => new Promise(resolve => { h.providerReads.push(resolve); }), onChanged: () => () => undefined };
    const status = () => ({ appVersion: "0.1.1", settings, environment: { checks, versions: { node: "24", electron: "44", chrome: "152" } }, logFile: "/test/ember.log", settingsNotice: null, admin, ...(platform ? { platform } : {}) });
    window.ember = new Proxy({}, { get: (_t, name: string) => {
      if (name.startsWith("on")) return (fn: (v: unknown) => void) => { (subs[name] ??= []).push(fn); return () => undefined; };
      if (name === "getStatus") return async () => status();
      if (name === "updates" && updates) return async () => updates;
      if (name === "updateSettings") return async (patch: Record<string, unknown>) => { h.calls.push(`save:${JSON.stringify(patch)}`); };
      if (name === "conversation") return async () => [];
      if (name === "tasks") return async () => tasks;
      if (name === "taskControl") return async (id: string, kind: string) => { h.calls.push(`taskControl:${id}:${kind}`); return true; };
      // As main answers: the newest `limit` entries (500 unless Home asks for more).
      if (name === "activity") return async (limit?: number) => { h.reads++; h.limits.push(limit ?? 500); if (h.activity === "fail") throw new Error("EACCES: permission denied"); return h.activity.slice(0, limit ?? 500); };
      return () => new Promise(() => undefined);
    } }) as never;
  }, { settings, admin, activity: seed.activity ?? [], checks: seed.checks ?? [], platform: seed.platform ?? null, updates: seed.updates ?? null, provider: seed.provider ?? false });
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

  it("names Setup & about plainly in its results while the sidebar's badge shows, and finds the log file (home-r2)", async () => {
    const page = await open("home", { checks: [{ id: "atspi", status: "fail", label: "Accessibility", detail: "Ember can't read apps.", fix: "Turn on assistive technologies." }] });
    // The badge is on the sidebar's link: its number for the eye, its words for a screen reader.
    await expect.poll(() => page.locator("#jump a[href='#checks-h'] .jump-badge").count()).toBe(1);
    const about = (await results(page, "version")).filter(r => r.startsWith("Setup & about"));
    expect(about.length).toBeGreaterThan(0);
    for (const r of about) expect(r, r).toMatch(/^Setup & about: [^\d]/);
    for (const r of await results(page, "shortcut")) expect(r, r).not.toMatch(/about\d|thing to fix/);
    for (const q of ["log", "log file", "logs"]) expect((await results(page, q)).some(r => r.startsWith("Setup & about: ")), q).toBe(true);
    expect(page.errors).toEqual([]);
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

  it("reads only the newest page every few seconds after Show earlier, and keeps the earlier lines (safety-privacy-r3)", async () => {
    if (new Date().getHours() === 0) return;
    const page = await open("home", { activity: seeded(600) });
    await page.locator("#activity-fold > summary").click();
    for (let i = 0; i < 7; i++) await page.getByRole("button", { name: "Show earlier" }).click();
    await expect.poll(() => lineCount(page)).toBe(603);
    // Show earlier read 1,000; the refresh after it asks for the newest 500 only.
    expect(await page.evaluate(() => Math.max(...window.__pane.limits))).toBe(1000);
    const before = await page.evaluate(() => window.__pane.limits.length);
    // Something new happens: it comes in at the top, and nothing read further back is lost.
    await page.evaluate(() => {
      const h = window.__pane;
      if (h.activity !== "fail") h.activity.unshift({ t: new Date().toISOString(), event: "action", kind: "click", app: "gedit", ok: true, element: { role: "push button", name: "Bold" } });
    });
    await expect.poll(() => page.locator("#activity-note").innerText(), { timeout: 8000 }).toBe("601 today");
    expect(await lineCount(page)).toBe(604);
    expect(await page.locator("#activity").innerText()).toContain("Click “Send” in Thunderbird");
    expect(await page.evaluate(n => window.__pane.limits.slice(n), before)).toEqual(expect.arrayContaining([500]));
    expect(await page.evaluate(n => window.__pane.limits.slice(n).every(l => l === 500), before)).toBe(true);
    expect(page.errors).toEqual([]);
    await page.close();
  }, 30_000);

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

  it("gives each entry's words the whole row in a narrow window at a large text size, and keeps one row when there is room (accessibility-visual-r1)", async () => {
    const thunderbird = { app: "thunderbird", kind: "click", element: { role: "push button", name: "Send" } };
    const entries: ActivityEntry[] = [{ t: minutesAgo(1), event: "confirm", answer: "always", ...thunderbird }];
    const page = await open("home", { activity: entries, viewport: { width: 420, height: 900 } });
    await page.locator("#activity-fold > summary").click();
    await expect.poll(() => lineCount(page)).toBe(1);
    const shape = () => page.evaluate(() => {
      const list = document.getElementById("activity")!.getBoundingClientRect();
      const [t, tag, what] = [...document.querySelectorAll("#activity li:not(.day) > *")].map(e => e.getBoundingClientRect());
      return { share: what.width / list.width, below: what.top >= Math.max(t.bottom, tag.bottom) - 1 };
    });
    for (const [width, size] of [[420, "larger"], [700, "larger"], [420, "large"], [380, ""]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(sz => { if (sz) document.documentElement.dataset.textSize = sz; else delete document.documentElement.dataset.textSize; }, size);
      const s = await shape();
      // It was 107 of about 340 px at 420 px Larger (31%), wrapping two or three words a line into a 277 px row.
      expect(s.share, `${width} px ${size || "default"}`).toBeGreaterThanOrEqual(0.4);
    }
    // With room for all three side by side, the words stay beside the time and the tag.
    for (const [width, size] of [[1000, "larger"], [1000, ""], [700, ""]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(sz => { if (sz) document.documentElement.dataset.textSize = sz; else delete document.documentElement.dataset.textSize; }, size);
      expect((await shape()).below, `${width} px ${size || "default"}`).toBe(false);
    }
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

describe.skipIf(gate)("Home's status lines, to a screen reader (2026-11-07 product audit)", () => {
  /** Chromium's accessibility node for `selector`: whether it is in the tree, and its role. */
  const axNode = async (p: Page, selector: string) => {
    const cdp = await p.context().newCDPSession(p);
    await cdp.send("Accessibility.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
    await cdp.detach();
    return { ignored: nodes[0]?.ignored ?? true, role: nodes[0]?.role?.value };
  };
  /** Every polite live region on the page that is hidden, or off the page, while it says nothing. */
  const offPage = (p: Page) => p.evaluate(() => [...document.querySelectorAll<HTMLElement>('[role="status"], [aria-live]:not([role="alert"])')]
    .filter(e => e.hidden || getComputedStyle(e).display === "none").map(e => e.id || e.className));

  it("keeps every status line on each pane in the accessibility tree while it says nothing, and takes no room for it (accessibility-visual-c1-1)", async () => {
    const page = await open("home", { activity: "fail" });
    await page.evaluate(t => window.__pane.emit("onTasks", t), [task("1-aaaa", "Write a note", [step(1, "Clicked in Text Editor")])]);
    await page.locator("#activity-fold > summary").click();
    await expect.poll(() => page.locator("#activity-problem").isVisible(), { timeout: 8000 }).toBe(true);
    for (const pane of ["home", "copilot", "memory", "voice", "privacy", "extensions", "access", "checks"]) {
      await page.locator(`a[href='#${pane}-h']`).first().click();
      expect(await offPage(page), pane).toEqual([]);
    }
    // An empty one is out of sight and out of the flow: a box of nothing.
    await page.locator("a[href='#voice-h']").first().click();
    const empty = await page.locator("#voice-hear-status").boundingBox();
    expect([empty?.width, empty?.height]).toEqual([0, 0]);
    expect(await axNode(page, "#voice-hear-status")).toEqual({ ignored: false, role: "status" });
    expect(page.errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("has Never look at's line in the accessibility tree before Remove fills it, as focus moves on to the next Remove (accessibility-visual-c1-1)", async () => {
    const page = await open("privacy");
    const removeKeePass = page.getByRole("button", { name: "Remove KeePassXC", exact: true });
    await expect.poll(() => removeKeePass.isVisible()).toBe(true);
    expect(await page.locator("#never-look-msg").innerText()).toBe("");
    // Polite live regions are spoken when their words change, not when they appear with words already in them.
    expect(await axNode(page, "#never-look-msg")).toEqual({ ignored: false, role: "status" });
    await removeKeePass.click();
    await page.evaluate(async list => {
      const st = await (window as unknown as { ember: { getStatus(): Promise<{ settings: Record<string, unknown> }> } }).ember.getStatus();
      window.__pane.emit("onSettingsChanged", { ...st.settings, privacy: { ...(st.settings.privacy as object), neverLook: list } });
    }, DEFAULT_SETTINGS.privacy.neverLook.filter(x => x !== "keepassxc"));
    await expect.poll(() => page.locator("#never-look-msg").innerText()).toBe("Removed KeePassXC. Ember may read its windows now; Restore defaults puts it back.");
    expect(await page.locator("#never-look-msg").isVisible()).toBe(true);
    expect(await axNode(page, "#never-look-msg")).toEqual({ ignored: false, role: "status" });
    await page.close();
  });

  it("lands on Stop response when the settings key opens Home on another pane while Ember still waits, so Enter stops the reply (accessibility-visual-2)", async () => {
    const page = await open("voice");
    expect(await page.locator("#conversation-stop").isVisible()).toBe(false);
    await page.evaluate(() => window.__pane.emit("onAgentStatus", { phase: "ready", detail: "", models: [], conductorModel: null, workerModel: null, usage: { calls: 0, inputTokens: 0, outputTokens: 0 } }));
    // Main: the bubble says Ember is still waiting (its step names the settings key), and the key lands here.
    await page.evaluate(() => window.__pane.emit("onConversationTurn", "slow"));
    await page.evaluate(() => window.__pane.emit("onFocusSection", "conversation:stop"));
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("conversation-stop");
    expect(await page.locator("#conversation-stop").isVisible()).toBe(true);
    expect(await page.locator("a[href='#home-h']").first().getAttribute("aria-current")).toBe("true");
    expect(await page.locator("#state-word").innerText()).toBe("Thinking…");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("#conversation-stop").getAttribute("aria-disabled")).toBe("true");
    expect(page.errors).toEqual([]);
    await page.close();
  });

  it("shows the focus ring where a key lands in Home though the mouse was used last, and none on a section a click opened (accessibility-visual-r2-1)", async () => {
    const page = await open("home");
    await page.evaluate(() => window.__pane.emit("onAgentStatus", { phase: "ready", detail: "", models: [], conductorModel: null, workerModel: null, usage: { calls: 0, inputTokens: 0, outputTokens: 0 } }));
    // The person clicks their way to Voice: the heading a click lands on shows no ring, as before.
    await page.locator("a[href='#voice-h']").first().click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("voice-h");
    expect(await page.evaluate(() => document.activeElement!.matches(":focus-visible"))).toBe(false);
    // Then the settings key while Ember still waits: Home lands on Stop response, ringed (it had no ring after a click).
    await page.evaluate(() => window.__pane.emit("onConversationTurn", "slow"));
    await page.evaluate(() => window.__pane.emit("onFocusSection", "conversation:stop"));
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("conversation-stop");
    expect(await page.evaluate(() => document.activeElement!.matches(":focus-visible"))).toBe(true);
    expect(await page.locator("#conversation-stop").evaluate(e => getComputedStyle(e).boxShadow)).not.toBe("none");
    // Ask Ember… from its key while another app holds it, after another click: ringed too.
    await page.locator("a[href='#voice-h']").first().click();
    await page.evaluate(() => window.__pane.emit("onFocusSection", "access:ask"));
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("p-ask");
    expect(await page.evaluate(() => document.activeElement!.matches(":focus-visible"))).toBe(true);
    expect(page.errors).toEqual([]);
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
    // Word for word, but for where the never-look list is: below, in this pane (safety-privacy-r4).
    expect(consent).toContain("The list is in settings");
    expect(shown).toBe(consent?.replace("The list is in settings", "The list is below, under Never look at"));
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

describe.skipIf(gate)("Home's Apps & privacy, as the person's own settings and the organisation's leave it (safety-privacy-r4)", () => {
  it("says screenshots are off once the person turned them off, and changes as the setting does", async () => {
    const page = await open("privacy", { settings: { screenImages: false } });
    const fold = page.locator("#privacy-terms-fold");
    await fold.locator("summary").click();
    const shown = () => page.locator("#privacy-terms").innerText();
    expect(await shown()).toContain("through the desktop's accessibility service. Send screenshots for tasks is off (below), so it takes no screenshots for tasks.");
    expect(await shown()).not.toContain("it may take a screenshot");
    // First run's own words are untouched.
    expect(await page.locator("#w-full ul.terms").evaluate(e => e.textContent)).toContain("and for tasks it may take a screenshot of it.");
    // Turned back on (main tells Home the settings changed): the fold says so at once, still open.
    const on = { ...structuredClone(DEFAULT_SETTINGS), onboarded: true, consent: { version: 99, at: "2026-11-04T12:00:00Z" }, screenImages: true };
    await page.evaluate(s => window.__pane.emit("onSettingsChanged", s), on);
    await expect.poll(shown).toContain("and for tasks it may take a screenshot of it.");
    expect(await fold.evaluate(d => (d as HTMLDetailsElement).open)).toBe(true);
    expect(page.errors).toEqual([]);
    await page.close();
  });

  it("keeps naming GitHub Copilot after a settings change while it is open, and isn't redrawn for an unrelated one (safety-privacy-r6)", async () => {
    const page = await open("privacy", { provider: true });
    // Main answers every read of its provider state: no provider of the user's own is in force.
    const copilot = { allowed: true, managed: null, keySaved: false, keyring: true, inForce: false, host: null, agreed: false };
    const answer = () => page.evaluate(s => { for (const r of window.__pane.providerReads.splice(0)) r(s); }, copilot);
    await expect.poll(() => page.evaluate(() => window.__pane.providerReads.length)).toBeGreaterThan(0);
    await answer();
    const fold = page.locator("#privacy-terms-fold");
    await fold.locator("summary").click();
    const send = () => page.locator("#privacy-terms li[data-icon='send']").innerText();
    await expect.poll(send).toContain("go to GitHub Copilot to work out the answer.");
    const base = { ...structuredClone(DEFAULT_SETTINGS), onboarded: true, consent: { version: 99, at: "2026-11-04T12:00:00Z" } };
    // An unrelated change (Start at log-in): the fold stays as it is, so a screen reader keeps its place in it.
    await page.locator("#privacy-terms ul").evaluate(u => u.setAttribute("data-old", ""));
    await page.evaluate(s => window.__pane.emit("onSettingsChanged", s), { ...base, startAtLogin: true });
    await answer();
    expect(await page.locator("#privacy-terms ul[data-old]").count()).toBe(1);
    expect(await send()).toContain("go to GitHub Copilot to work out the answer.");
    // Send screenshots for tasks turned off, as the fold invites: it says so, and still names where requests go once
    // main's provider state has answered (it said "a model service I can't tell yet" from then on).
    await page.evaluate(s => window.__pane.emit("onSettingsChanged", s), { ...base, startAtLogin: true, screenImages: false });
    await expect.poll(() => page.locator("#privacy-terms").innerText()).toContain("Send screenshots for tasks is off (below)");
    await answer();
    await expect.poll(send).toContain("go to GitHub Copilot to work out the answer.");
    expect(await send()).not.toContain("can't tell");
    expect(await page.locator("#privacy-terms li[data-icon='mic']").innerText()).toContain("goes to Copilot as text");
    expect(page.errors).toEqual([]);
    await page.close();
  });

  it("says nothing heard is sent anywhere while the organisation's policy has Ember locked down", async () => {
    const page = await open("privacy", { admin: { source: "/etc/ember/policy.json", error: "Unrecognized key", retentionDays: null, features: { voice: false, screenImages: false }, managed: ["screenImages"] }, settings: { screenImages: false } });
    const fold = page.locator("#privacy-terms-fold");
    await fold.locator("summary").click();
    const mic = await page.locator("#privacy-terms li[data-icon='mic']").innerText();
    expect(mic).toContain("for one request. Nothing it hears is sent anywhere until your organisation fixes its policy. Listen once processes audio");
    expect(mic).not.toMatch(/no model service|goes to|sends the request/);
    expect(mic).toContain("Listen once processes audio on this computer and closes temporary capture once it has heard the request.");
    // First run's text says the same, as its send line already does.
    expect(await page.locator("#w-full li[data-icon='mic']").evaluate(e => e.textContent)).toContain("Nothing it hears is sent anywhere until your organisation fixes its policy.");
    await evidence(page, "privacy-terms-lockdown");
    expect(page.errors).toEqual([]);
    await page.close();
  });

  it("says what the person turned on: commands on this computer, and ordinary steps without asking (safety-privacy-r4-2, safety-privacy-c4-1)", async () => {
    const agreed = { version: 1, at: "2026-11-04T12:00:00Z" };
    const on = { commands: { local: { on: true, askEvery: false, consent: agreed } }, autonomy: { on: true, scopes: { apps: true, commands: true, cursor: true, crossWindow: true }, consent: { version: 2, at: agreed.at } } };
    const page = await open("privacy", { settings: on });
    const fold = page.locator("#privacy-terms-fold");
    await fold.locator("summary").click();
    const shown = () => page.locator("#privacy-terms").innerText();
    const hand = () => page.locator("#privacy-terms li[data-icon='hand']").innerText();
    const plug = () => page.locator("#privacy-terms li[data-icon='plug']").innerText();
    expect(await page.locator("#autonomy-on").isChecked()).toBe(true);
    expect(await plug()).toBe("Other computers and commands: you let Ember run commands on this computer. It runs commands only in its own window, where you can watch and stop them. Other computers are off until you turn them on.");
    expect(await hand()).toMatch(/^It asks before acting on anything risky or hard to undo\. Work without asking is on \(below\), so for ordinary steps it tells you what it's doing instead\. It never types passwords\./);
    // First run's own words are untouched.
    expect(await page.locator("#w-full li[data-icon='plug']").evaluate(e => e.textContent)).toContain("are off until you turn them on");
    expect(await page.locator("#w-full li[data-icon='hand']").evaluate(e => e.textContent)).toContain("It asks before acting in an app, and always before anything hard to undo.");
    await evidence(page, "privacy-terms-on");
    // Both turned off again (main tells Home the settings changed): word for word as before it started, still open.
    const base = { ...structuredClone(DEFAULT_SETTINGS), onboarded: true, consent: { version: 99, at: "2026-11-04T12:00:00Z" } };
    await page.evaluate(s => window.__pane.emit("onSettingsChanged", s), base);
    await expect.poll(shown).toContain("It asks before acting in an app, and always before anything hard to undo.");
    expect(await plug()).toBe("Other computers and commands are off until you turn them on: Ember can work on computers you reach over SSH, and run commands in its own window. Each asks you first.");
    expect(await fold.evaluate(d => (d as HTMLDetailsElement).open)).toBe(true);
    expect(page.errors).toEqual([]);
    await page.close();
  });

  it("never offers what the organisation's lockdown turned off, nor says what the person turned on is on (safety-privacy-r4-2)", async () => {
    const agreed = { version: 1, at: "2026-11-04T12:00:00Z" };
    const page = await open("privacy", {
      settings: { commands: { local: { on: true, askEvery: false, consent: agreed } }, screenImages: false },
      admin: { source: "/etc/ember/policy.json", error: "Unrecognized key", retentionDays: null, confirmEveryAction: true, allowGrants: false, features: { voice: false, screenImages: false, ssh: false, wsl: false, autonomy: false }, managed: ["screenImages", "autonomy"], commands: { local: "off", wsl: "off", ssh: "off" } },
    });
    const fold = page.locator("#privacy-terms-fold");
    await fold.locator("summary").click();
    expect(await page.locator("#privacy-terms li[data-icon='plug']").innerText()).toBe("Other computers and commands are turned off by your organisation.");
    expect(await page.locator("#privacy-terms li[data-icon='hand']").innerText()).toContain("It asks before acting in an app, and always before anything hard to undo.");
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

  it("wraps a long host name without hyphens, or with user@, in the Computers and Commands lines at 304 px and Larger text (commands-remote-r2-2, WCAG 1.4.10)", async () => {
    const page = await open("home", { viewport: { width: 304, height: 700 } });
    await page.evaluate(() => {
      for (const id of ["jump-computers", "computers", "jump-commands", "commands"]) document.getElementById(id)!.hidden = false;
    });
    const over: string[] = [];
    for (const host of ["buildserver01.engineering.corporate.example.com", "deploy@buildserver01.engineering.corporate.example.com"]) {
      for (const [id, pane] of [["computers-msg", "computers-h"], ["commands-msg", "commands-h"]]) {
        await page.locator(`.jump a[href="#${pane}"]`).first().click();
        for (const size of ["", "larger"]) {
          for (const width of [304, 400, 760]) {
            await page.setViewportSize({ width, height: 700 });
            const d = await page.evaluate(({ id, size, text }) => {
              if (size) document.documentElement.dataset.textSize = size; else delete document.documentElement.dataset.textSize;
              document.getElementById(id)!.textContent = text;
              return document.documentElement.scrollWidth - document.documentElement.clientWidth;
            }, { id, size, text: `Ember can't find ${host}. Check the name, or add it to your SSH config. It wasn't added to Computers.` });
            if (d > 0) over.push(`${id} ${host} at ${width} px ${size || "default"}: +${d}`);
          }
        }
      }
    }
    expect(over).toEqual([]);
    await page.setViewportSize({ width: 304, height: 700 });
    await page.locator('.jump a[href="#computers-h"]').first().click();
    await page.evaluate(() => { document.getElementById("computers-msg")!.textContent = "Ember can't find deploy@buildserver01.engineering.corporate.example.com. Check the name, or add it to your SSH config. It wasn't added to Computers."; });
    await page.locator("#computers-msg").scrollIntoViewIfNeeded();
    await evidence(page, "computers-unhyphenated-host-304-larger");
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

describe.skipIf(gate)("Home's Updates, when a new version is out (2026-11-07 product audit)", () => {
  const linux = (install: StatusPlatform["install"]): StatusPlatform => ({
    os: "linux", shortcuts: shownShortcuts(SHORTCUTS.linux, heldShortcuts(SHORTCUTS.linux, FALLBACK_SHORTCUTS.linux, [])),
    dataDir: "~/.config/ember", settingsFile: "~/.config/ember/settings.json", auditCopy: null, micIndicator: "", permissionsNote: "",
    speakerRejection: true, outputLevel: false, fixLabels: {}, desk: false, autostartNote: null, install,
  });
  const out: UpdateStatus = { phase: "available", latest: "0.1.2", checkedAt: "2026-11-08T09:00:00.000Z" };
  const settings = { updates: { on: true, consent: { version: 99, at: "2026-11-04T12:00:00Z" }, told: "0.1.2", checkedAt: "2026-11-08T09:00:00.000Z" } };

  it("says how to update this kind of install under “Ember 0.1.2 is out.”, beside See what's new… (install-docs-11)", async () => {
    const page = await open("checks", { settings, platform: linux("rpm"), updates: out });
    await expect.poll(() => page.locator("#updates-status").textContent()).toBe("Ember 0.1.2 is out.");
    await expect.poll(() => page.locator("#updates-how").isVisible()).toBe(true);
    // The command names the downloaded file, set as code: a bare `sudo dnf upgrade` upgrades the whole system and
    // leaves Ember as it was (install-docs-r2-2).
    expect(await page.locator("#updates-how").textContent()).toBe("To update, quit Ember, download the new RPM from See what's new…, then run sudo dnf upgrade ./ember-0.1.2-1.el8.x86_64.rpm in the folder you saved it to.");
    expect(await page.locator("#updates-how code").allTextContents()).toEqual(["sudo dnf upgrade ./ember-0.1.2-1.el8.x86_64.rpm"]);
    expect(await page.locator("#updates-open").isVisible()).toBe(true);
    // A screen reader hears it: announced as it fills, and read with See what's new…, where the notification's click
    // lands (install-docs-r2-2).
    expect(await page.locator("#updates-how").getAttribute("aria-live")).toBe("polite");
    expect(await page.locator("#updates-open").getAttribute("aria-describedby")).toBe("updates-how");
    await page.locator("#updates-h").scrollIntoViewIfNeeded();
    await evidence(page, "updates-rpm-1000");
    await page.setViewportSize({ width: 380, height: 800 });
    await page.locator("#updates-h").scrollIntoViewIfNeeded();
    await evidence(page, "updates-rpm-380");
    expect(page.errors).toEqual([]);
    await page.close();
  });

  it("leaves the how-to and the status line alone when a push brings the same words, so a screen reader hears each once (install-docs-c3-2)", async () => {
    const page = await open("checks", { settings, platform: linux("rpm"), updates: out });
    await expect.poll(() => page.locator("#updates-how code").count()).toBe(1);
    await page.evaluate(() => {
      const w = window as unknown as { __muts: string[] };
      w.__muts = [];
      for (const id of ["updates-how", "updates-status"]) {
        new MutationObserver(rs => { for (const r of rs) w.__muts.push(`${id}: -${r.removedNodes.length} +${r.addedNodes.length}`); })
          .observe(document.getElementById(id)!, { childList: true, subtree: true, characterData: true });
      }
    });
    // Main's pushes during one Check now with 0.1.2 already known (checking, checking, available), then the refresh a
    // settings change brings (another available).
    for (const phase of ["checking", "checking", "available", "available"] as const) {
      await page.evaluate(s => window.__pane.emit("onUpdates", s), { ...out, phase });
    }
    await page.waitForTimeout(100);
    // The status line changes twice ("Checking…", then "Ember 0.1.2 is out."); the polite how-to is never rewritten.
    expect(await page.evaluate(() => (window as unknown as { __muts: string[] }).__muts)).toEqual(["updates-status: -1 +1", "updates-status: -1 +1"]);
    expect(await page.locator("#updates-status").textContent()).toBe("Ember 0.1.2 is out.");
    expect(await page.locator("#updates-how code").allTextContents()).toEqual(["sudo dnf upgrade ./ember-0.1.2-1.el8.x86_64.rpm"]);
    // A different version's words are written: the how-to follows what is out.
    await page.evaluate(s => window.__pane.emit("onUpdates", s), { ...out, latest: "0.1.3" });
    await expect.poll(() => page.locator("#updates-how code").allTextContents()).toEqual(["sudo dnf upgrade ./ember-0.1.3-1.el8.x86_64.rpm"]);
    expect(page.errors).toEqual([]);
    await page.close();
  });

  it("keeps the version it found, See what's new… and the how-to when a later look fails (install-docs-c2-2)", async () => {
    const page = await open("checks", { settings, platform: linux("rpm"), updates: { phase: "failed", latest: "0.1.2", checkedAt: out.checkedAt } });
    await expect.poll(() => page.locator("#updates-status").textContent()).toBe("Ember 0.1.2 is out. Ember couldn't look for anything newer just now, and will try again tomorrow.");
    await expect.poll(() => page.locator("#updates-how").isVisible()).toBe(true);
    expect(await page.locator("#updates-how code").allTextContents()).toEqual(["sudo dnf upgrade ./ember-0.1.2-1.el8.x86_64.rpm"]);
    expect(await page.locator("#updates-open").isVisible()).toBe(true);
    expect(page.errors).toEqual([]);
    await page.close();
  });

  it("says nothing of how while Ember has the latest version, or when main can't tell how it was installed (install-docs-11)", async () => {
    const current = await open("checks", { settings, platform: linux("appimage"), updates: { phase: "current", latest: null, checkedAt: out.checkedAt } });
    await expect.poll(() => current.locator("#updates-status").textContent()).toBe("You have the latest version.");
    expect(await current.locator("#updates-how").isVisible()).toBe(false);
    // Still on the page while it says nothing, so its words are announced when they come (accessibility-visual-c1-1).
    expect(await current.locator("#updates-how").evaluate(el => ({ hidden: (el as HTMLElement).hidden, text: el.textContent }))).toEqual({ hidden: false, text: "" });
    await current.close();
    const dev = await open("checks", { settings, platform: linux(null), updates: out });
    await expect.poll(() => dev.locator("#updates-status").textContent()).toBe("Ember 0.1.2 is out.");
    expect(await dev.locator("#updates-how").isVisible()).toBe(false);
    await dev.close();
  });
});
