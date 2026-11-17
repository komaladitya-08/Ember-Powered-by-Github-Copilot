/** Both actual Home boards in Chromium; only preload replies are replaced, and no task or source write runs. */
import fs from "node:fs";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodingResultReview, CodingResultSummary } from "../../app/shared/project-coding";
import type { ProjectSession, ProjectSessionsAction, ProjectSessionsState } from "../../app/shared/project-sessions";

interface SessionReviewHarness {
  state: ProjectSessionsState;
  results: Record<string, CodingResultSummary[]>;
  reviews: Record<string, CodingResultReview>;
  calls: { method: string; args: string[] }[];
  deferred: boolean;
  deferResults: boolean;
  resolveReview?: (review: CodingResultReview) => void;
  resolveResults?: (results: CodingResultSummary[]) => void;
  rejectResults?: () => void;
  oldButton?: HTMLButtonElement;
  emit(name: string, value?: unknown): void;
}
declare global { interface Window { __sessionReviews: SessionReviewHarness } }

const session = (extra: Partial<ProjectSession> = {}): ProjectSession => ({ id: "named-session", taskId: "task-one", title: "Review the API", kind: "coding", status: "done", detail: "", startedAt: 1, ...extra });
const result = (extra: Partial<CodingResultReview> = {}): CodingResultReview => ({
  id: "review-one", projectId: "one", taskId: "task-one", title: "Worker outcome", sourcePath: "/original/private-app", status: "done", files: 1, conflicts: 0,
  patchComplete: true, checks: { ran: 0, passed: 0, failed: 0 }, message: "Private copy ready.", changes: [{ path: "src/api.ts", kind: "modify", conflicts: [], patchUnsupported: [] }],
  textPatch: "--- a/src/api.ts\n+++ b/src/api.ts\n-old\n+new", limitations: [], previewMessage: "Text patch preview.", ...extra,
});
const state = (sessions = [session()]): ProjectSessionsState => ({ selectedProjectId: "one", projects: [
  { id: "one", name: "API project", goal: "Review the API", createdAt: 1, sessions },
  { id: "two", name: "Another project", goal: "Other work", createdAt: 1, sessions: [] },
] });

describe.skipIf(process.env.EMBER_UIUX_TEST !== "1")("Named session to coding review in Chromium", () => {
  let browser: Browser, script: string, markup: string;
  beforeAll(async () => {
    script = (await build({ stdin: { contents: 'import { mountProjectCoding } from "./app/renderer/home/project-coding"; import { mountProjectSessions } from "./app/renderer/home/project-sessions"; mountProjectSessions(mountProjectCoding());', resolveDir: process.cwd() }, bundle: true, platform: "browser", write: false })).outputFiles[0].text;
    browser = await chromium.launch({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
    const template = await browser.newPage();
    try {
      markup = await template.evaluate(html => {
        const dom = new DOMParser().parseFromString(html, "text/html");
        return ["project-sessions", "project-coding"].map(id => dom.getElementById(id)!.outerHTML).join("");
      }, fs.readFileSync("app/renderer/home/index.html", "utf8"));
    } finally { await template.close(); }
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  const reviewButton = (page: Page) => page.getByRole("button", { name: "Review changes: Review the API", exact: true });
  async function open(seed: Partial<Pick<SessionReviewHarness, "state" | "results" | "reviews" | "deferred">> = {}): Promise<Page> {
    const page = await browser.newPage();
    await page.setContent(`<html><body><button id="navigation">Another section</button>${markup}</body></html>`);
    await page.evaluate(seed => {
      const listeners: Record<string, ((value: unknown) => void)[]> = {};
      const h: SessionReviewHarness = window.__sessionReviews = { ...seed, calls: [], emit: (name, value) => { for (const fn of listeners[name] ?? []) fn(value); } };
      window.ember = new Proxy({}, { get: (_target, method: string) => {
        if (method.startsWith("on")) return (fn: (value: unknown) => void) => { (listeners[method] ??= []).push(fn); return () => undefined; };
        if (method === "agentStatus") return async () => ({ phase: "ready" });
        if (method === "projectSessionsState") return async () => structuredClone(h.state);
        if (method === "projectSessionsAction") return async (action: ProjectSessionsAction) => {
          if (action.action === "select") h.state.selectedProjectId = action.id;
          return structuredClone(h.state);
        };
        if (method === "projectSessionsCheckpoint") return async () => ({ state: structuredClone(h.state), message: "Checkpoint opened without resuming work." });
        return (...args: string[]) => {
          h.calls.push({ method, args });
          if (method === "projectCodingWorkspaceState") return Promise.resolve({ projectId: args[0], available: false, canChoose: true, folder: { path: "/later/folder", label: "Later folder", valid: true }, message: "Coding unavailable; retained reviews remain available." });
          if (method === "codingResultsState") return h.deferResults ? new Promise<CodingResultSummary[]>((resolve, reject) => { h.resolveResults = resolve; h.rejectResults = () => reject(new Error("Fixture result read failed")); }) : Promise.resolve(structuredClone(h.results[args[0]] ?? []));
          if (method === "codingResultReview") return h.deferred ? new Promise<CodingResultReview>(resolve => { h.resolveReview = resolve; }) : Promise.resolve(structuredClone(h.reviews[args[0]]));
          if (method === "codingResultForget") {
            for (const project of Object.keys(h.results)) h.results[project] = h.results[project].filter(result => result.id !== args[0]);
            return Promise.resolve({ ok: true, message: "Private coding review forgotten." });
          }
          throw new Error(`Unexpected preload call: ${method}`);
        };
      } }) as never;
    }, { state: state(), results: { one: [result()] }, reviews: { "review-one": result() }, deferred: false, deferResults: false, ...seed });
    await page.addScriptTag({ content: script });
    await expect.poll(() => page.locator("#project-sessions-add").isEnabled()).toBe(true);
    return page;
  }

  it("opens the exact named session's existing review, retains the original source and returns keyboard focus", async () => {
    const page = await open();
    await expect.poll(() => reviewButton(page).isEnabled()).toBe(true);
    expect(await reviewButton(page).textContent()).toBe("Review changes");
    expect(await reviewButton(page).evaluate(button => button.outerHTML)).not.toContain("/original/");
    await reviewButton(page).click();
    await expect.poll(() => page.locator("#project-coding-review").isVisible()).toBe(true);
    expect(await page.locator("#project-coding-review-title").textContent()).toBe("Worker outcome");
    expect(await page.locator("#project-coding-review-source").textContent()).toBe("From /original/private-app");
    expect(await page.locator("#project-coding-review-title").evaluate(title => document.activeElement === title)).toBe(true);
    expect(await page.evaluate(() => window.__sessionReviews.calls.filter(call => call.method === "codingResultReview"))).toEqual([{ method: "codingResultReview", args: ["review-one"] }]);
    expect(await page.evaluate(() => window.__sessionReviews.calls.some(call => /Continue|Export|Send/.test(call.method)))).toBe(false);
    await page.evaluate(() => window.__sessionReviews.emit("onTasks"));
    await expect.poll(() => reviewButton(page).isEnabled()).toBe(true);
    await page.locator("#project-coding-close").click();
    expect(await reviewButton(page).evaluate(button => document.activeElement === button)).toBe(true);
    await page.close();
  });

  it("offers only an unambiguous terminal coding task match, independent of misleading titles", async () => {
    const misleading = result({ id: "other", taskId: "other-task", title: "Review the API" });
    const page = await open({ state: state([session({ status: "running" })]), results: { one: [misleading, result()] } });
    expect(await reviewButton(page).count()).toBe(0);
    await page.evaluate(() => { window.__sessionReviews.state.projects[0].sessions[0].status = "done"; window.__sessionReviews.emit("onTasks"); });
    await expect.poll(() => reviewButton(page).isEnabled()).toBe(true);
    await reviewButton(page).focus();
    await page.evaluate(() => { window.__sessionReviews.results.one[1].message = "Updated summary"; window.__sessionReviews.emit("onTasks"); });
    await expect.poll(() => reviewButton(page).isEnabled()).toBe(true);
    expect(await reviewButton(page).evaluate(button => document.activeElement === button)).toBe(true);
    await page.evaluate(() => { const h = window.__sessionReviews; h.results.one.push({ ...h.results.one[1], id: "ambiguous" }); h.emit("onTasks"); });
    await expect.poll(() => reviewButton(page).count()).toBe(0);
    await page.close();
  });

  it("removes forgotten reviews and never lets an old session control open a later result", async () => {
    const page = await open();
    await expect.poll(() => reviewButton(page).isEnabled()).toBe(true);
    await page.evaluate(() => { window.__sessionReviews.oldButton = document.querySelector<HTMLButtonElement>("[data-session-review]")!; });
    await reviewButton(page).click();
    await expect.poll(() => page.locator("#project-coding-review").isVisible()).toBe(true);
    await page.getByRole("button", { name: "Forget private result: Worker outcome", exact: true }).click();
    await expect.poll(() => reviewButton(page).count()).toBe(0);
    expect(await page.locator("#project-coding-review").isHidden()).toBe(true);
    await page.evaluate(review => { const h = window.__sessionReviews; h.results.one = [review]; h.reviews[review.id] = review; h.emit("onTasks"); }, result({ id: "later" }));
    await expect.poll(() => reviewButton(page).isEnabled()).toBe(true);
    await page.evaluate(() => window.__sessionReviews.oldButton!.dispatchEvent(new MouseEvent("click")));
    expect(await page.evaluate(() => window.__sessionReviews.calls.filter(call => call.method === "codingResultReview").length)).toBe(1);
    await reviewButton(page).click();
    await expect.poll(() => page.evaluate(() => window.__sessionReviews.calls.filter(call => call.method === "codingResultReview").map(call => call.args[0]))).toEqual(["review-one", "later"]);
    await page.close();
  });

  it.each(["id", "projectId", "taskId", "sourcePath"] as const)("rejects a review reply with changed %s", async field => {
    const page = await open({ deferred: true });
    await expect.poll(() => reviewButton(page).isEnabled()).toBe(true); await reviewButton(page).click();
    await page.waitForFunction(() => !!window.__sessionReviews.resolveReview);
    await page.evaluate(review => window.__sessionReviews.resolveReview!(review), result({ [field]: "foreign-value", textPatch: "FOREIGN PRIVATE PATCH" }));
    await expect.poll(() => reviewButton(page).isEnabled()).toBe(true);
    expect(await page.locator("#project-coding-review").isHidden()).toBe(true);
    expect(await page.locator("#project-coding-patch").textContent()).not.toContain("FOREIGN PRIVATE PATCH");
    await page.close();
  });

  it.each(["project", "forget", "account"])("discards a pending session review after %s retirement", async retirement => {
    const page = await open({ deferred: true });
    await expect.poll(() => reviewButton(page).isEnabled()).toBe(true); await reviewButton(page).click();
    await page.waitForFunction(() => !!window.__sessionReviews.resolveReview);
    if (retirement === "project") await page.locator("#project-sessions-select").selectOption("two");
    else if (retirement === "forget") await page.getByRole("button", { name: "Forget private result: Worker outcome", exact: true }).click();
    else await page.evaluate(() => { const h = window.__sessionReviews; h.state = { projects: [], selectedProjectId: null }; h.results = {}; h.emit("onConversationForgotten"); });
    await page.evaluate(review => window.__sessionReviews.resolveReview!(review), result({ textPatch: "RETIRED PRIVATE PATCH" }));
    await expect.poll(() => page.locator("#project-coding-review").isHidden()).toBe(true);
    expect(await page.locator("#project-coding-patch").textContent()).not.toContain("RETIRED PRIVATE PATCH");
    await page.close();
  });

  it.each(["removed", "replaced", "source"])("invalidates a pending review when its current result is %s", async change => {
    const page = await open({ deferred: true });
    await expect.poll(() => reviewButton(page).isEnabled()).toBe(true); await reviewButton(page).click();
    await page.waitForFunction(() => !!window.__sessionReviews.resolveReview);
    await page.evaluate(change => {
      const h = window.__sessionReviews;
      h.results.one = change === "removed" ? [] : [{ ...h.results.one[0], ...(change === "replaced" ? { id: "replacement" } : { sourcePath: "/replacement/source" }) }];
      h.emit("onTasks");
    }, change);
    await page.evaluate(review => window.__sessionReviews.resolveReview!(review), result());
    await expect.poll(() => page.locator("#project-coding-status").textContent()).toContain("changed");
    expect(await page.locator("#project-coding-review").isHidden()).toBe(true);
    if (change === "removed") await expect.poll(() => reviewButton(page).count()).toBe(0);
    else await expect.poll(() => reviewButton(page).isEnabled()).toBe(true);
    await page.close();
  });

  it("keeps navigation focus when a session review finishes later", async () => {
    const page = await open({ deferred: true });
    await page.locator("#project-coding-review").evaluate(panel => { panel.style.marginTop = "1800px"; });
    await expect.poll(() => reviewButton(page).isEnabled()).toBe(true); await reviewButton(page).click();
    await page.waitForFunction(() => !!window.__sessionReviews.resolveReview);
    await page.locator("#navigation").click();
    const scroll = await page.evaluate(() => scrollY);
    await page.evaluate(review => window.__sessionReviews.resolveReview!(review), result());
    await expect.poll(() => page.locator("#project-coding-review").isVisible()).toBe(true);
    expect(await page.locator("#navigation").evaluate(button => document.activeElement === button)).toBe(true);
    expect(await page.evaluate(() => scrollY)).toBe(scroll);
    await page.close();
  });

  it.each(["onTasks", "onConversation"])("preserves one pointer gesture across an unchanged-identity %s refresh", async notification => {
    const page = await open();
    try {
      await expect.poll(() => reviewButton(page).isEnabled()).toBe(true);
      await reviewButton(page).scrollIntoViewIfNeeded();
      const bounds = (await reviewButton(page).boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.evaluate(notification => { const h = window.__sessionReviews; h.deferResults = true; h.emit(notification); }, notification);
      await page.waitForFunction(() => !!window.__sessionReviews.resolveResults);
      await page.mouse.up();
      await page.waitForFunction(() => window.__sessionReviews.calls.some(call => call.method === "codingResultReview"));
      expect(await page.locator("#project-coding-review").isHidden()).toBe(true);
      expect(await page.locator("#project-coding-patch").textContent()).toBe("");
      await page.evaluate(() => { const h = window.__sessionReviews; h.deferResults = false; h.resolveResults!(h.results.one); });
      await expect.poll(() => reviewButton(page).isEnabled()).toBe(true);
      await expect.poll(() => page.evaluate(() => window.__sessionReviews.calls.filter(call => call.method === "codingResultReview")), { timeout: 1000 })
        .toEqual([{ method: "codingResultReview", args: ["review-one"] }]);
      await expect.poll(() => page.locator("#project-coding-review").isVisible()).toBe(true);
      expect(await page.locator("#project-coding-patch").textContent()).toContain("+new");
    } finally { await page.mouse.up(); await page.close(); }
  });

  it("preserves one pointer gesture across a metadata-only session-detail refresh", async () => {
    const page = await open();
    try {
      await expect.poll(() => reviewButton(page).isEnabled()).toBe(true);
      await reviewButton(page).scrollIntoViewIfNeeded();
      const bounds = (await reviewButton(page).boundingBox())!;
      await page.evaluate(() => { window.__sessionReviews.oldButton = document.querySelector<HTMLButtonElement>("[data-session-review]")!; });
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.evaluate(() => { const h = window.__sessionReviews; h.state.projects[0].sessions[0].detail = "Updated completion detail"; h.emit("onTasks"); });
      await expect.poll(() => page.locator("#project-sessions-list").textContent()).toContain("Updated completion detail");
      await expect.poll(() => reviewButton(page).isEnabled()).toBe(true);
      expect(await reviewButton(page).evaluate(button => button === window.__sessionReviews.oldButton)).toBe(true);
      await page.mouse.up();
      await expect.poll(() => page.evaluate(() => window.__sessionReviews.calls.filter(call => call.method === "codingResultReview")), { timeout: 1000 })
        .toEqual([{ method: "codingResultReview", args: ["review-one"] }]);
      await expect.poll(() => page.locator("#project-coding-review").isVisible()).toBe(true);
      expect(await page.locator("#project-coding-patch").textContent()).toContain("+new");
    } finally { await page.mouse.up(); await page.close(); }
  });

  it.each(["removed", "replaced", "source", "ambiguous", "running", "account", "project"])("does not retarget a pressed review control after %s retirement", async change => {
    const page = await open();
    try {
      await expect.poll(() => reviewButton(page).isEnabled()).toBe(true);
      await reviewButton(page).scrollIntoViewIfNeeded();
      const bounds = (await reviewButton(page).boundingBox())!;
      await page.evaluate(() => { window.__sessionReviews.oldButton = document.querySelector<HTMLButtonElement>("[data-session-review]")!; });
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.evaluate(change => {
        const h = window.__sessionReviews;
        if (change === "account") { h.state = { projects: [], selectedProjectId: null }; h.results = {}; h.emit("onConversationForgotten"); return; }
        if (change === "project") h.state.selectedProjectId = "two";
        else if (change === "running") h.state.projects[0].sessions[0].status = "running";
        else if (change === "removed") h.results.one = [];
        else if (change === "ambiguous") h.results.one.push({ ...h.results.one[0], id: "another-review" });
        else h.results.one = [{ ...h.results.one[0], ...(change === "replaced" ? { id: "another-review" } : { sourcePath: "/replacement/source" }) }];
        h.emit("onTasks");
      }, change);
      await page.waitForFunction(() => !window.__sessionReviews.oldButton!.isConnected);
      await page.mouse.up();
      expect(await page.evaluate(() => window.__sessionReviews.calls.filter(call => call.method === "codingResultReview"))).toEqual([]);
      expect(await page.locator("#project-coding-review").isHidden()).toBe(true);
      expect(await page.locator("#project-coding-patch").textContent()).toBe("");
    } finally { await page.mouse.up(); await page.close(); }
  });

  it.each(["removed", "replaced", "source", "failure"])("requires fresh matching metadata when a pressed review meets %s", async change => {
    const page = await open();
    try {
      await expect.poll(() => reviewButton(page).isEnabled()).toBe(true);
      await reviewButton(page).scrollIntoViewIfNeeded();
      const bounds = (await reviewButton(page).boundingBox())!;
      const reads = await page.evaluate(() => window.__sessionReviews.calls.filter(call => call.method === "codingResultsState").length);
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.evaluate(() => { const h = window.__sessionReviews; h.deferResults = true; h.emit("onTasks"); });
      await page.waitForFunction(() => !!window.__sessionReviews.resolveResults);
      await page.mouse.up();
      await page.waitForFunction(reads => window.__sessionReviews.calls.filter(call => call.method === "codingResultsState").length >= reads + 2, reads);
      expect(await page.locator("#project-coding-review").isHidden()).toBe(true);
      expect(await page.locator("#project-coding-patch").textContent()).toBe("");
      await page.evaluate(change => {
        const h = window.__sessionReviews; h.deferResults = false;
        if (change === "failure") { h.rejectResults!(); return; }
        h.results.one = change === "removed" ? [] : [{ ...h.results.one[0], ...(change === "replaced" ? { id: "another-review" } : { sourcePath: "/replacement/source" }) }];
        h.resolveResults!(h.results.one);
      }, change);
      await expect.poll(() => page.locator("#project-coding-status").textContent()).toContain("changed");
      expect(await page.evaluate(() => window.__sessionReviews.calls.filter(call => call.method === "codingResultReview"))).toEqual([{ method: "codingResultReview", args: ["review-one"] }]);
      expect(await page.locator("#project-coding-review").isHidden()).toBe(true);
      expect(await page.locator("#project-coding-patch").textContent()).toBe("");
    } finally { await page.mouse.up(); await page.close(); }
  });

  it("accepts unchanged review identity through real notification churn and logical-control replacement", async () => {
    const page = await open({ deferred: true });
    await expect.poll(() => reviewButton(page).isEnabled()).toBe(true); await reviewButton(page).click();
    await page.waitForFunction(() => !!window.__sessionReviews.resolveReview);
    await page.evaluate(() => { const h = window.__sessionReviews; h.state.projects[0].sessions[0].detail = "Updated completion detail"; h.emit("onTasks"); h.emit("onConversation"); });
    await expect.poll(() => page.locator("#project-sessions-list").textContent()).toContain("Updated completion detail");
    await page.evaluate(review => window.__sessionReviews.resolveReview!(review), result());
    await expect.poll(() => page.locator("#project-coding-review").isVisible()).toBe(true);
    expect(await page.locator("#project-coding-review-title").evaluate(title => document.activeElement === title)).toBe(true);
    await page.locator("#project-coding-close").click();
    expect(await reviewButton(page).evaluate(button => document.activeElement === button)).toBe(true);
    await page.close();
  });

  it("accepts harmless notifications during its fresh post-reply metadata read", async () => {
    const page = await open({ deferred: true });
    await expect.poll(() => reviewButton(page).isEnabled()).toBe(true); await reviewButton(page).click();
    await page.waitForFunction(() => !!window.__sessionReviews.resolveReview);
    await page.evaluate(review => { const h = window.__sessionReviews; h.deferResults = true; h.resolveReview!(review); }, result());
    await page.waitForFunction(() => !!window.__sessionReviews.resolveResults);
    await page.evaluate(() => { const h = window.__sessionReviews; h.emit("onTasks"); h.emit("onConversation"); h.deferResults = false; h.resolveResults!(h.results.one); });
    await expect.poll(() => page.locator("#project-coding-review").isVisible()).toBe(true);
    expect(await page.locator("#project-coding-review-title").evaluate(title => document.activeElement === title)).toBe(true);
    await page.close();
  });

  it.each(["failure", "forget"])("refuses a review when its fresh result read meets %s", async change => {
    const page = await open({ deferred: true });
    await expect.poll(() => reviewButton(page).isEnabled()).toBe(true); await reviewButton(page).click();
    await page.waitForFunction(() => !!window.__sessionReviews.resolveReview);
    await page.evaluate(review => { const h = window.__sessionReviews; h.deferResults = true; h.resolveReview!(review); }, result());
    await page.waitForFunction(() => !!window.__sessionReviews.resolveResults);
    if (change === "failure") await page.evaluate(() => { const h = window.__sessionReviews; h.deferResults = false; h.rejectResults!(); });
    else {
      await page.evaluate(() => { window.__sessionReviews.deferResults = false; });
      await page.getByRole("button", { name: "Forget private result: Worker outcome", exact: true }).click();
      await page.evaluate(review => window.__sessionReviews.resolveResults!([review]), result());
    }
    await expect.poll(async () => await reviewButton(page).count() > 0 && await reviewButton(page).isEnabled()).toBe(change === "failure");
    expect(await page.locator("#project-coding-review").isHidden()).toBe(true);
    expect(await page.locator("#project-coding-patch").textContent()).toBe("");
    await page.close();
  });

  it("rejects a delayed review after a same-project checkpoint removes the session", async () => {
    const page = await open({ deferred: true });
    await expect.poll(() => reviewButton(page).isEnabled()).toBe(true); await reviewButton(page).click();
    await page.waitForFunction(() => !!window.__sessionReviews.resolveReview);
    await page.evaluate(() => { window.__sessionReviews.state.projects[0].sessions = []; });
    await page.locator("#project-sessions-open").click();
    await expect.poll(() => reviewButton(page).count()).toBe(0);
    await page.evaluate(review => window.__sessionReviews.resolveReview!(review), result());
    await expect.poll(() => page.locator("#project-coding-status").textContent()).toContain("changed");
    expect(await page.locator("#project-coding-review").isHidden()).toBe(true);
    await page.close();
  });
});
