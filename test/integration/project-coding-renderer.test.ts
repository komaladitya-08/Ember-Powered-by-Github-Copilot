/** Project coding controls in Chromium, replacing only the preload boundary; no task or original-folder write runs. */
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CODING_REVIEW_PATCH_LIMIT, type CodingResultReview, type CodingResultSummary, type ProjectCodingWorkspaceState } from "../../app/shared/project-coding";

interface CodingHarness {
  selected: string | null;
  workspaces: Record<string, ProjectCodingWorkspaceState>;
  results: Record<string, CodingResultSummary[]>;
  reviews: Record<string, CodingResultReview>;
  calls: { method: string; args: unknown[] }[];
  deferred: Record<string, boolean>;
  resolve: Record<string, (value: unknown) => void>;
  reject: Record<string, (reason: unknown) => void>;
  emit(name: string, value?: unknown): void;
}
declare global { interface Window { __codingBoard: CodingHarness } }

const workspace = (projectId: string, extra: Partial<ProjectCodingWorkspaceState> = {}): ProjectCodingWorkspaceState => ({ projectId, folder: null, available: false, canChoose: true, message: "Coding is unavailable on this computer. Folder preparation is available.", ...extra });
const availableWorkspace = (projectId = "one") => workspace(projectId, { available: true, folder: { path: "/work/original-app", label: "Original app", valid: true }, message: "Isolated coding is ready." });
const result = (projectId = "one", id = "result-one"): CodingResultReview => ({
  id, projectId, taskId: `task-${id}`, title: "Improve the app", sourcePath: "/work/original-app", status: "done", files: 1, conflicts: 1, patchComplete: false,
  checks: { ran: 2, passed: 1, failed: 1 }, message: "Review the proposed changes.",
  changes: [{ path: "src/app.ts", kind: "modify", conflicts: ["Original file changed since the copy was made."], patchUnsupported: [] }],
  textPatch: "--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new", limitations: ["Original files were left unchanged."], previewMessage: "Text patch preview. Export to keep the review.",
});

describe.skipIf(process.env.EMBER_UIUX_TEST !== "1")("Project coding folders and results in Chromium", () => {
  let browser: Browser, script: string, markup: string;
  beforeAll(async () => {
    script = (await build({ stdin: { contents: 'import { mountProjectCoding } from "./app/renderer/home/project-coding"; mountProjectCoding();', resolveDir: process.cwd() }, bundle: true, platform: "browser", write: false })).outputFiles[0].text;
    const html = fs.readFileSync("app/renderer/home/index.html", "utf8");
    markup = html.slice(html.indexOf('<div class="group" id="project-coding"'), html.indexOf('<div class="group" id="coding-workspace"'));
    browser = await chromium.launch({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  async function open(seed: Partial<CodingHarness> = {}): Promise<Page> {
    const page = await browser.newPage();
    await page.setContent(`<html><body><button id="navigation">Another section</button>${markup}<div id="coding-workspace">Legacy coding workspace</div></body></html>`);
    await page.evaluate(seed => {
      const listeners: Record<string, ((value: unknown) => void)[]> = {};
      const h: CodingHarness = window.__codingBoard = {
        selected: "one", results: {}, reviews: {}, calls: [], deferred: {}, resolve: {}, reject: {},
        emit: (name, value) => { for (const fn of listeners[name] ?? []) fn(value); }, ...seed, workspaces: seed.workspaces ?? {},
      };
      const answer = (key: string, value: unknown) => h.deferred[key] ? new Promise((resolve, reject) => { h.resolve[key] = resolve; h.reject[key] = reject; }) : Promise.resolve(structuredClone(value));
      window.ember = new Proxy({}, { get: (_target, method: string) => {
        if (method.startsWith("on")) return (fn: (value: unknown) => void) => { (listeners[method] ??= []).push(fn); return () => undefined; };
        if (method === "agentStatus") return async () => ({ phase: "ready" });
        if (method === "projectSessionsState") return () => answer("initial", { projects: [], selectedProjectId: h.selected });
        return (...args: string[]) => {
          h.calls.push({ method, args });
          if (method === "projectCodingWorkspaceState") return answer(`workspace:${args[0]}`, h.workspaces[args[0]]);
          if (method === "projectCodingWorkspaceChoose" || method === "projectCodingWorkspaceForget") return answer(method, h.workspaces[args[0]]);
          if (method === "codingResultsState") return answer(`results:${args[0]}`, h.results[args[0]] ?? []);
          if (method === "codingResultReview") return answer("review", h.reviews[args[0]]);
          if (method === "codingResultExport") return answer("export", { ok: true, message: "Review exported. The original project is unchanged." });
          if (method === "codingResultContinue") return answer("continue", { ok: true, message: "Your new coding request was queued. Your original project stays unchanged." });
          if (method === "codingResultForget") {
            for (const key of Object.keys(h.results)) h.results[key] = h.results[key].filter(result => result.id !== args[0]);
            return answer("forget", { ok: true, message: "Private coding review forgotten. Exported copies and project history are unchanged." });
          }
          throw new Error(`Unexpected preload call: ${method}`);
        };
      } }) as never;
    }, { workspaces: { one: workspace("one"), two: workspace("two") }, ...seed });
    await page.addScriptTag({ content: script });
    return page;
  }
  const selected = (page: Page, id: string | null) => page.evaluate(id => window.dispatchEvent(new CustomEvent("ember-project-changed", { detail: { projectId: id } })), id);

  it("guides project creation without reading a folder and allows preparation while execution remains unavailable", async () => {
    const page = await open({ selected: null });
    expect(await page.locator("#project-coding").isVisible()).toBe(true);
    expect(await page.locator("#project-coding-folder").textContent()).toContain("Create or select a project above");
    expect(await page.locator("#project-coding-choose").isDisabled()).toBe(true);
    expect(await page.locator("#coding-workspace").isHidden()).toBe(true);
    expect(await page.evaluate(() => window.__codingBoard.calls)).toEqual([]);
    await selected(page, "one");
    await expect.poll(() => page.locator("#project-coding-choose").isEnabled()).toBe(true);
    expect(await page.locator("#coding-workspace").isHidden()).toBe(true);
    expect(await page.locator("#project-coding-state").textContent()).toContain("unavailable");
    await page.evaluate(() => { window.__codingBoard.workspaces.one.folder = { path: "/work/app", label: "App folder", valid: true }; });
    await page.locator("#project-coding-choose").click();
    await expect.poll(() => page.locator("#project-coding-folder").textContent()).toContain("/work/app");
    expect(await page.evaluate(() => window.__codingBoard.calls.filter(c => c.method === "projectCodingWorkspaceChoose"))).toEqual([{ method: "projectCodingWorkspaceChoose", args: ["one"] }]);
    await page.evaluate(() => { window.__codingBoard.workspaces.one.canChoose = false; window.__codingBoard.workspaces.one.message = "Stop project work before changing folders."; window.__codingBoard.emit("onTasks"); });
    await expect.poll(() => page.locator("#project-coding-choose").isDisabled()).toBe(true);
    expect(await page.locator("#project-coding-forget").isDisabled()).toBe(true);
    await page.evaluate(() => { window.__codingBoard.workspaces.one.canChoose = true; window.__codingBoard.emit("onTasks"); });
    await expect.poll(() => page.locator("#project-coding-forget").isEnabled()).toBe(true);
    await page.evaluate(() => { window.__codingBoard.workspaces.one.folder = null; });
    await page.locator("#project-coding-forget").click();
    await expect.poll(() => page.locator("#project-coding-folder").textContent()).toContain("No coding folder");
    await page.close();
  }, 30_000);

  it("reviews conflicts, checks and patch limitations as plain text, exporting only on an explicit click", async () => {
    const hostile = '<img src=x onerror="window.injected=true">';
    const review = result(); review.title = hostile; review.changes[0].path = hostile; review.changes[0].patchUnsupported = ["Binary changes need the exported review."];
    review.textPatch = hostile + "x".repeat(CODING_REVIEW_PATCH_LIMIT + 20);
    const page = await open({ results: { one: [review] }, reviews: { [review.id]: review } });
    const button = page.getByRole("button", { name: `Review result: ${hostile}`, exact: true });
    await expect.poll(() => button.isEnabled()).toBe(true);
    expect(await page.locator("#project-coding-results").innerText()).toContain("2 run, 1 passed, 1 failed");
    expect(await page.evaluate(() => window.__codingBoard.calls.some(c => /Review|Export/.test(c.method)))).toBe(false);
    await button.click();
    await expect.poll(() => page.locator("#project-coding-review").isVisible()).toBe(true);
    expect(await page.locator("#project-coding-changes").innerText()).toContain("Original file changed");
    expect(await page.locator("#project-coding-changes").innerText()).toContain("Binary changes");
    expect(await page.locator("#project-coding-review-title").textContent()).toBe(hostile);
    expect(await page.locator("#project-coding-review-source").textContent()).toBe("From /work/original-app");
    expect(await page.locator("#project-coding img").count()).toBe(0);
    expect((await page.locator("#project-coding-patch").textContent())!.length).toBe(CODING_REVIEW_PATCH_LIMIT);
    expect(await page.locator("#project-coding-limitations").innerText()).toContain("preview is shortened");
    await page.locator("#project-coding-export").click();
    await expect.poll(() => page.locator("#project-coding-status").textContent()).toContain("Review exported");
    expect(await page.evaluate(() => window.__codingBoard.calls.filter(c => c.method === "codingResultExport"))).toEqual([{ method: "codingResultExport", args: ["result-one"] }]);
    expect(await page.evaluate(() => window.__codingBoard.calls.every(c => ["projectCodingWorkspaceState", "codingResultsState", "codingResultReview", "codingResultExport"].includes(c.method)))).toBe(true);
    await page.locator("#project-coding-close").click();
    expect(await page.locator("#project-coding-review").isHidden()).toBe(true);
    expect(await button.evaluate(element => element === document.activeElement)).toBe(true);
    await page.evaluate(() => { const review = window.__codingBoard.reviews["result-one"]; review.textPatch = null; review.previewMessage = "This patch exceeds the preview limit. Export the review for the complete result."; });
    await button.click();
    await expect.poll(() => page.locator("#project-coding-preview-message").textContent()).toContain("exceeds the preview limit");
    expect(await page.locator("#project-coding-patch").isHidden()).toBe(true);
    await page.close();
  }, 30_000);

  it("rejects old folder/results reads after project selection and a late review after account erasure", async () => {
    const old = result();
    const page = await open({ deferred: { "workspace:one": true, "results:one": true }, results: { one: [old], two: [] }, reviews: { [old.id]: old } });
    await page.waitForFunction(() => !!window.__codingBoard.resolve["workspace:one"]);
    await selected(page, "two");
    await page.evaluate(old => {
      const h = window.__codingBoard;
      h.resolve["workspace:one"]({ projectId: "one", folder: { path: "/private/old", label: "Old account", valid: true }, available: true, canChoose: true, message: "old" });
      h.resolve["results:one"]([old]);
    }, old);
    await expect.poll(() => page.locator("#project-coding-choose").isEnabled()).toBe(true);
    expect(await page.locator("#project-coding").innerText()).not.toContain("/private/old");
    expect(await page.locator("#project-coding-results h4").count()).toBe(0);
    await page.evaluate(old => { const h = window.__codingBoard; h.deferred = {}; h.results.two = [{ ...old, projectId: "two" }]; h.reviews[old.id] = { ...old, projectId: "two" }; h.emit("onTasks"); }, old);
    const button = page.getByRole("button", { name: "Review result: Improve the app", exact: true });
    await expect.poll(() => button.isEnabled()).toBe(true);
    await page.evaluate(() => { window.__codingBoard.deferred.review = true; });
    await button.click();
    await page.waitForFunction(() => !!window.__codingBoard.resolve.review);
    await page.evaluate(old => { const h = window.__codingBoard; h.emit("onConversationForgotten"); h.resolve.review({ ...old, projectId: "two", title: "Previous account private review" }); }, old);
    expect(await page.locator("#project-coding-choose").isDisabled()).toBe(true);
    expect(await page.locator("#project-coding-review-title").textContent()).toBe("");
    expect(await page.locator("#project-coding-results").textContent()).not.toContain("Previous account");
    await page.close();
  }, 30_000);

  it("does not restore an old initial selection or a late folder choice", async () => {
    const page = await open({ deferred: { initial: true } });
    await page.waitForFunction(() => !!window.__codingBoard.resolve.initial);
    await selected(page, null);
    await page.evaluate(() => window.__codingBoard.resolve.initial({ projects: [], selectedProjectId: "one" }));
    expect(await page.locator("#project-coding-choose").isDisabled()).toBe(true);
    await selected(page, "one");
    await expect.poll(() => page.locator("#project-coding-choose").isEnabled()).toBe(true);
    await page.evaluate(() => { window.__codingBoard.deferred.projectCodingWorkspaceChoose = true; });
    await page.locator("#project-coding-choose").click();
    await page.waitForFunction(() => !!window.__codingBoard.resolve.projectCodingWorkspaceChoose);
    await page.evaluate(() => { const h = window.__codingBoard; h.emit("onConversationForgotten"); h.resolve.projectCodingWorkspaceChoose({ projectId: "one", folder: { path: "/private/source", label: "Private", valid: true }, available: true, canChoose: true, message: "Private folder" }); });
    expect(await page.locator("#project-coding-choose").isDisabled()).toBe(true);
    expect(await page.locator("#project-coding-folder").textContent()).not.toContain("/private/source");
    await page.close();
  }, 30_000);

  it("preserves result control focus on refresh and respects navigation during a delayed review", async () => {
    const review = result();
    const page = await open({ results: { one: [review] }, reviews: { [review.id]: review } });
    const button = page.getByRole("button", { name: "Review result: Improve the app", exact: true });
    await expect.poll(() => button.isEnabled()).toBe(true);
    await button.focus();
    await page.evaluate(() => { window.__codingBoard.results.one[0].message = "Updated result detail"; window.__codingBoard.emit("onTasks"); });
    await expect.poll(() => page.locator("#project-coding-results").textContent()).toContain("Updated result detail");
    expect(await button.evaluate(element => element === document.activeElement)).toBe(true);
    await page.evaluate(() => { window.__codingBoard.deferred.review = true; });
    await button.click();
    await page.waitForFunction(() => !!window.__codingBoard.resolve.review);
    await page.locator("#navigation").click();
    await page.evaluate(review => window.__codingBoard.resolve.review(review), review);
    await expect.poll(() => page.locator("#project-coding-review").isVisible()).toBe(true);
    expect(await page.locator("#navigation").evaluate(element => element === document.activeElement)).toBe(true);
    await page.close();
  }, 30_000);

  it("does not show a late export message after switching projects", async () => {
    const review = result();
    const page = await open({ results: { one: [review] }, reviews: { [review.id]: review }, deferred: { export: true } });
    await expect.poll(() => page.getByRole("button", { name: /^Review result:/ }).isEnabled()).toBe(true);
    await page.getByRole("button", { name: /^Review result:/ }).click();
    await expect.poll(() => page.locator("#project-coding-export").isEnabled()).toBe(true);
    await page.locator("#project-coding-export").click();
    await page.waitForFunction(() => !!window.__codingBoard.resolve.export);
    await selected(page, "two");
    await page.evaluate(() => window.__codingBoard.resolve.export({ ok: true, message: "Exported /previous/private/source" }));
    await expect.poll(() => page.locator("#project-coding-choose").isEnabled()).toBe(true);
    expect(await page.locator("#project-coding-status").textContent()).toBe("");
    expect(await page.locator("#project-coding-review").isHidden()).toBe(true);
    expect(await page.locator("#project-coding-review-source").textContent()).toBe("");
    await page.close();
  }, 30_000);

  it("forgets a private result explicitly, clears its open preview and preserves other results and keyboard focus", async () => {
    const first = result(), second = result("one", "result-two"); second.title = "Another result";
    const page = await open({ results: { one: [first, second] }, reviews: { [first.id]: first, [second.id]: second } });
    const review = page.getByRole("button", { name: "Review result: Improve the app", exact: true });
    await expect.poll(() => review.isEnabled()).toBe(true); await review.click();
    await expect.poll(() => page.locator("#project-coding-review").isVisible()).toBe(true);
    await page.getByRole("button", { name: "Forget private result: Improve the app", exact: true }).click();
    await expect.poll(() => page.locator("#project-coding-status").textContent()).toContain("Private coding review forgotten");
    expect(await page.locator("#project-coding-review").isHidden()).toBe(true);
    expect(await page.locator("#project-coding-review-source").textContent()).toBe("");
    expect(await page.getByRole("button", { name: "Review result: Improve the app", exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Forget private result: Another result", exact: true }).evaluate(element => element === document.activeElement)).toBe(true);
    expect(await page.evaluate(() => window.__codingBoard.calls.filter(c => /Forget|Export/.test(c.method)))).toEqual([{ method: "codingResultForget", args: [first.id] }]);
    expect(await page.locator("#project-coding-status").textContent()).toContain("Exported copies and project history are unchanged");
    await page.close();
  }, 30_000);

  it.each(["review", "export"])("does not restore a forgotten result through a late %s reply", async operation => {
    const original = result();
    const page = await open({ results: { one: [original] }, reviews: { [original.id]: original }, deferred: { [operation]: true } });
    const button = page.getByRole("button", { name: /^Review result:/ });
    await expect.poll(() => button.isEnabled()).toBe(true); await button.click();
    if (operation === "export") {
      await expect.poll(() => page.locator("#project-coding-export").isEnabled()).toBe(true);
      await page.locator("#project-coding-export").click();
    }
    await page.waitForFunction(operation => !!window.__codingBoard.resolve[operation], operation);
    await page.getByRole("button", { name: /^Forget private result:/ }).click();
    await expect.poll(() => page.locator("#project-coding-status").textContent()).toContain("Private coding review forgotten");
    await page.evaluate(({ operation, original }) => window.__codingBoard.resolve[operation](operation === "review" ? original : { ok: true, message: "OLD private export" }), { operation, original });
    expect(await page.locator("#project-coding-review").isHidden()).toBe(true);
    expect(await page.locator("#project-coding-review-title").textContent()).toBe("");
    expect(await page.locator("#project-coding-results h4").count()).toBe(0);
    expect(await page.locator("#project-coding-status").textContent()).toContain("Private coding review forgotten");
    await page.close();
  }, 30_000);

  it("does not publish a late Forget message into another account", async () => {
    const original = result();
    const page = await open({ results: { one: [original] }, deferred: { forget: true } });
    const button = page.getByRole("button", { name: /^Forget private result:/ });
    await expect.poll(() => button.isEnabled()).toBe(true); await button.click();
    await page.waitForFunction(() => !!window.__codingBoard.resolve.forget);
    await page.evaluate(() => { const h = window.__codingBoard; h.emit("onConversationForgotten"); h.resolve.forget({ ok: true, message: "OLD account result title" }); });
    expect(await page.locator("#project-coding-status").textContent()).toBe("");
    expect(await page.locator("#project-coding-choose").isDisabled()).toBe(true);
    await page.close();
  }, 30_000);

  it("continues only after an explicit new request and preserves its exact words without truncating", async () => {
    const review = result(), request = "  Add logging.\nKeep the existing behavior.  ";
    const page = await open({ workspaces: { one: availableWorkspace() }, results: { one: [review] }, reviews: { [review.id]: review } });
    const original = page.getByRole("button", { name: /^Review result:/ });
    await expect.poll(() => original.isEnabled()).toBe(true); await original.click();
    const continueButton = page.locator("#project-coding-continue"), form = page.locator("#project-coding-continue-form"), input = page.locator("#project-coding-continue-request"), send = page.locator("#project-coding-continue-send");
    await expect.poll(() => continueButton.isEnabled()).toBe(true);
    expect(await page.evaluate(() => window.__codingBoard.calls.some(call => call.method === "codingResultContinue"))).toBe(false);
    await continueButton.click(); expect(await form.isVisible()).toBe(true);
    expect(await input.evaluate(element => element === document.activeElement)).toBe(true); expect(await send.isDisabled()).toBe(true);
    await input.fill(request); await page.locator("#project-coding-continue-cancel").click();
    expect(await form.isHidden()).toBe(true); expect(await input.inputValue()).toBe("");
    expect(await continueButton.evaluate(element => element === document.activeElement)).toBe(true);
    expect(await page.evaluate(() => window.__codingBoard.calls.some(call => call.method === "codingResultContinue"))).toBe(false);
    await continueButton.click();
    await input.fill("A valid request before the field changes.");
    await input.evaluate(element => { (element as HTMLTextAreaElement).value = "x".repeat(2001); });
    await form.evaluate(element => element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(await send.isDisabled()).toBe(true);
    expect(await page.evaluate(() => window.__codingBoard.calls.some(call => call.method === "codingResultContinue"))).toBe(false);
    expect((await input.inputValue()).length).toBe(2001);
    await input.fill(request); await send.click();
    await expect.poll(() => page.locator("#project-coding-status").textContent()).toContain("new coding request was queued");
    expect(await page.evaluate(() => window.__codingBoard.calls.filter(call => call.method === "codingResultContinue"))).toEqual([{ method: "codingResultContinue", args: [review.id, "one", request] }]);
    expect(await form.isHidden()).toBe(true); expect(await input.inputValue()).toBe("");
    expect(await page.locator("#project-coding-review-source").textContent()).toBe("From /work/original-app");
    await page.close();
  }, 30_000);

  it("requires available coding and a valid current folder before opening or submitting continuation", async () => {
    const review = result(), page = await open({ results: { one: [review] }, reviews: { [review.id]: review } });
    const original = page.getByRole("button", { name: /^Review result:/ });
    await expect.poll(() => original.isEnabled()).toBe(true); await original.click();
    const button = page.locator("#project-coding-continue"), send = page.locator("#project-coding-continue-send");
    expect(await button.isDisabled()).toBe(true);
    await page.evaluate(() => { const h = window.__codingBoard; h.workspaces.one.available = true; h.emit("onTasks"); });
    await expect.poll(() => page.locator("#project-coding-state").textContent()).toContain("unavailable");
    expect(await button.isDisabled()).toBe(true);
    await page.evaluate(() => { const h = window.__codingBoard; h.workspaces.one.folder = { path: "/work/original-app", label: "Original", valid: true }; h.emit("onTasks"); });
    await expect.poll(() => button.isEnabled()).toBe(true); await button.click();
    await page.locator("#project-coding-continue-request").fill("Fix the next issue.");
    await page.evaluate(() => { const h = window.__codingBoard; h.workspaces.one.available = false; h.emit("onTasks"); });
    await expect.poll(() => send.isDisabled()).toBe(true);
    await page.locator("#project-coding-continue-form").evaluate(element => element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(await page.evaluate(() => window.__codingBoard.calls.some(call => call.method === "codingResultContinue"))).toBe(false);
    await page.close();
  }, 30_000);

  it("keeps a continuation draft and its focus while results refresh", async () => {
    const review = result(), page = await open({ workspaces: { one: availableWorkspace() }, results: { one: [review] }, reviews: { [review.id]: review } });
    const original = page.getByRole("button", { name: /^Review result:/ });
    await expect.poll(() => original.isEnabled()).toBe(true); await original.click();
    const input = page.locator("#project-coding-continue-request");
    await expect.poll(() => page.locator("#project-coding-continue").isEnabled()).toBe(true); await page.locator("#project-coding-continue").click();
    await input.fill("Continue the private edits."); await input.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(3, 7));
    await page.evaluate(() => { const h = window.__codingBoard; h.results.one[0].message = "A refreshed result"; h.emit("onTasks"); h.emit("onConversation"); });
    await expect.poll(() => page.locator("#project-coding-results").textContent()).toContain("A refreshed result");
    expect(await input.inputValue()).toBe("Continue the private edits.");
    expect(await input.evaluate(element => ({ focused: element === document.activeElement, start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd }))).toEqual({ focused: true, start: 3, end: 7 });
    expect(await page.evaluate(() => window.__codingBoard.calls.some(call => call.method === "codingResultContinue"))).toBe(false);
    await page.close();
  }, 30_000);

  it("keeps navigation focus while a continuation acknowledgement is pending", async () => {
    const review = result(), page = await open({ workspaces: { one: availableWorkspace() }, results: { one: [review] }, reviews: { [review.id]: review }, deferred: { continue: true } });
    const original = page.getByRole("button", { name: /^Review result:/ });
    await expect.poll(() => original.isEnabled()).toBe(true); await original.click();
    await expect.poll(() => page.locator("#project-coding-continue").isEnabled()).toBe(true); await page.locator("#project-coding-continue").click();
    await page.locator("#project-coding-continue-request").fill("Fix the next issue."); await page.locator("#project-coding-continue-send").click();
    await page.waitForFunction(() => !!window.__codingBoard.resolve.continue);
    for (const id of ["continue", "continue-request", "continue-send", "continue-cancel"]) expect(await page.locator(`#project-coding-${id}`).isDisabled()).toBe(true);
    await page.locator("#navigation").click();
    await page.evaluate(() => window.__codingBoard.resolve.continue({ ok: false, message: "The source changed. Choose its original folder and send a new request." }));
    await expect.poll(() => page.locator("#project-coding-status").textContent()).toContain("The source changed");
    expect(await page.locator("#navigation").evaluate(element => element === document.activeElement)).toBe(true);
    expect(await page.locator("#project-coding-continue-request").inputValue()).toBe("Fix the next issue.");
    await page.close();
  }, 30_000);

  it.each(["project", "account", "close", "forget"])("clears continuation and ignores a late error after %s changes", async change => {
    const review = result(), page = await open({ workspaces: { one: availableWorkspace(), two: availableWorkspace("two") }, results: { one: [review] }, reviews: { [review.id]: review }, deferred: { continue: true } });
    const original = page.getByRole("button", { name: /^Review result:/ });
    await expect.poll(() => original.isEnabled()).toBe(true); await original.click();
    await expect.poll(() => page.locator("#project-coding-continue").isEnabled()).toBe(true); await page.locator("#project-coding-continue").click();
    await page.locator("#project-coding-continue-request").fill("Old private request."); await page.locator("#project-coding-continue-send").click();
    await page.waitForFunction(() => !!window.__codingBoard.reject.continue);
    if (change === "project") await selected(page, "two");
    else if (change === "account") await page.evaluate(() => window.__codingBoard.emit("onConversationForgotten"));
    else if (change === "close") await page.locator("#project-coding-close").click();
    else await page.getByRole("button", { name: /^Forget private result:/ }).click();
    await page.evaluate(() => window.__codingBoard.reject.continue(new Error("OLD private continuation failure")));
    await expect.poll(() => page.locator("#project-coding-continue-form").isHidden()).toBe(true);
    expect(await page.locator("#project-coding-continue-request").inputValue()).toBe("");
    expect(await page.locator("#project-coding-review").isHidden()).toBe(true);
    expect(await page.locator("#project-coding-status").textContent()).not.toContain("OLD private");
    await page.close();
  }, 30_000);

  it("keeps long paths and patch previews within a narrow window using the actual Home styles", async () => {
    const review = result(); review.changes[0].path = "src/" + "a".repeat(250) + ".ts";
    review.textPatch = "+" + "x".repeat(2000);
    const page = await open({ workspaces: { one: availableWorkspace() }, results: { one: [review] }, reviews: { [review.id]: review } });
    await expect.poll(() => page.getByRole("button", { name: /^Review result:/ }).isEnabled()).toBe(true);
    await page.getByRole("button", { name: /^Review result:/ }).click();
    await expect.poll(() => page.locator("#project-coding-review").isVisible()).toBe(true);
    await page.locator("#project-coding-continue").click();
    await page.locator("#project-coding-continue-request").fill("Keep the private edits and " + "a".repeat(1000));
    await page.evaluate(() => {
      document.documentElement.classList.add("content"); document.documentElement.dataset.textSize = "larger";
      document.getElementById("navigation")!.hidden = true;
      const main = document.createElement("main"); main.className = "home";
      const section = document.createElement("section"); section.dataset.pane = "projects";
      section.append(document.getElementById("project-coding")!); main.append(section); document.body.append(main);
    });
    const shared = fs.readFileSync("app/renderer/shared/ember.css", "utf8").replace('../fonts/InterVariable.woff2', `data:font/woff2;base64,${fs.readFileSync("assets/fonts/InterVariable.woff2").toString("base64")}`);
    await page.addStyleTag({ content: shared + fs.readFileSync("app/renderer/home/styles.css", "utf8") });
    for (const width of [900, 420]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.EMBER_UI_EVIDENCE) {
        await page.locator("#project-coding-patch").scrollIntoViewIfNeeded();
        await page.evaluate(() => { scrollTo(0, 0); return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
        fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
        await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, `project-coding-${width}.png`), fullPage: true });
      }
    }
    await page.close();
  }, 30_000);
});
