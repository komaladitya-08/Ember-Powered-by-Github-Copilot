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

interface Seed { settings?: Record<string, unknown>; activity?: ActivityEntry[]; viewport?: { width: number; height: number } }

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
      if (name === "activity") return async () => { h.reads++; if (h.activity === "fail") throw new Error("EACCES: permission denied"); return h.activity; };
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
