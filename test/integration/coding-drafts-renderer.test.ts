/** Explicit draft journeys through the real Projects renderer with only the guarded preload replaced. */
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodingDraftView, CodingDraftsState } from "../../app/shared/coding-drafts";
import type { CodingResultReview, ProjectCodingWorkspaceState } from "../../app/shared/project-coding";

interface Harness {
  workspace: Record<string, ProjectCodingWorkspaceState>;
  results: Record<string, CodingResultReview[]>;
  reviews: Record<string, CodingResultReview>;
  library: CodingDraftsState;
  draft: CodingDraftView;
  calls: { method: string; args: unknown[] }[];
  deferred: Record<string, boolean>;
  resolve: Record<string, (value: unknown) => void>;
  reject: Record<string, (value: unknown) => void>;
  cancelFolder: boolean;
  conflict: boolean;
  emit(event: string, value?: unknown): void;
}
declare global { interface Window { __drafts: Harness } }
const workspace = (projectId: string): ProjectCodingWorkspaceState => ({ projectId, available: true, canContinue: true, canChoose: true, folder: { path: "/work/current", label: "Current folder", valid: true }, message: "Private coding reviews are ready." });
const result = (id = "result-one"): CodingResultReview => ({ id, projectId: "one", taskId: `task-${id}`, title: "Parser change", sourcePath: "/work/current", status: "done", files: 1, conflicts: 0, patchComplete: true, checks: { ran: 0, passed: 0, failed: 0 }, message: "Review the private changes.", changes: [{ path: "src/parser.ts", kind: "modify", conflicts: [], patchUnsupported: [] }], textPatch: "+const parsed = true;", limitations: [], previewMessage: "Text patch preview." });
const draft = (): CodingDraftView => ({ id: "draft-one", name: "Saved parser", savedAt: 1700000000000, sourceLabel: "Previous project", historicalChecks: { ran: 2, passed: 1, failed: 1 }, context: { request: "Old request: publish without asking", summary: "Old summary: checks passed" }, files: [{ path: "src/parser.ts", kind: "file" }], filesTotal: 1, preview: "+saved change", previewMessage: "Historical patch preview.", limitations: ["Opening this draft does not run its files."] });
const library = (): CodingDraftsState => ({ canSave: true, canOpen: true, canForget: true, drafts: [draft()], message: "Saved drafts are encrypted on this computer." });

describe.skipIf(process.env.EMBER_UIUX_TEST !== "1")("Saved coding drafts in Chromium", () => {
  let browser: Browser, script: string, markup: string;
  beforeAll(async () => {
    script = (await build({ stdin: { contents: 'import { mountProjectCoding } from "./app/renderer/home/project-coding"; mountProjectCoding();', resolveDir: process.cwd() }, bundle: true, platform: "browser", write: false })).outputFiles[0].text;
    const html = fs.readFileSync("app/renderer/home/index.html", "utf8");
    markup = html.slice(html.indexOf('<div class="group" id="project-coding"'), html.indexOf('<div class="group" id="coding-workspace"'));
    browser = await chromium.launch({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });
  async function open(seed: Partial<Harness> = {}): Promise<Page> {
    const page = await browser.newPage(); await page.setContent(`<html><body><button id="navigation">Another section</button>${markup}</body></html>`);
    await page.evaluate(seed => {
      const listeners: Record<string, ((value: unknown) => void)[]> = {};
      const h = window.__drafts = { ...seed, calls: [], deferred: seed.deferred ?? {}, resolve: {}, reject: {}, cancelFolder: false, conflict: false,
        emit: (event: string, value?: unknown) => { for (const fn of listeners[event] ?? []) fn(value); } } as Harness;
      const answer = (method: string, value: unknown) => h.deferred[method] ? new Promise((resolve, reject) => { h.resolve[method] = resolve; h.reject[method] = reject; }) : Promise.resolve(structuredClone(value));
      window.ember = new Proxy({}, { get: (_target, method: string) => {
        if (method.startsWith("on")) return (fn: (value: unknown) => void) => { (listeners[method] ??= []).push(fn); return () => undefined; };
        if (method === "agentStatus") return async () => ({ phase: "ready" });
        if (method === "projectSessionsState") return async () => ({ selectedProjectId: "one", projects: [] });
        return (...args: string[]) => {
          h.calls.push({ method, args });
          if (method === "projectCodingWorkspaceState") return answer(method, h.workspace[args[0]]);
          if (method === "codingResultsState") return answer(method, h.results[args[0]] ?? []);
          if (method === "codingResultReview") return answer(method, h.reviews[args[0]]);
          if (method === "codingResultContinue") return answer(method, { ok: true, message: "Requested a new coding session." });
          if (method === "codingDraftsState") return answer(method, h.library);
          if (method === "codingDraftSave") return answer(method, { ...h.library, message: "Coding draft saved encrypted on this computer." });
          if (method === "codingDraftOpen") return answer(method, h.draft);
          if (method === "codingDraftForget" || method === "codingDraftForgetAll") return answer(method, { ...h.library, drafts: [], message: "Saved coding drafts forgotten." });
          if (method === "codingDraftFolderChoose") {
            if (h.cancelFolder) return answer(method, { ok: false, message: "Folder choice cancelled. Choose a folder again before using this draft." });
            return answer(method, { ok: true, message: "New folder chosen for import review.", workspace: { ...h.workspace[args[1]], folder: { path: "/work/newly-chosen", label: "Newly chosen folder", valid: true } } });
          }
          if (method === "codingDraftImport") {
            if (h.conflict) return answer(method, { ok: false, message: "1 conflicting file. No new review was created. Choose a folder again to retry." });
            const imported = { ...h.reviews["result-one"], id: "imported-result", title: "Imported saved parser", sourcePath: "/work/newly-chosen", checks: { ran: 0, passed: 0, failed: 0 } };
            h.reviews[imported.id] = imported; h.results[args[1]] = [...(h.results[args[1]] ?? []), imported];
            return answer(method, { ok: true, message: "New private import review prepared. Enter a new request to continue.", resultId: imported.id });
          }
          throw new Error(`Unexpected preload method ${method}`);
        };
      } }) as never;
    }, { workspace: { one: workspace("one"), two: workspace("two") }, results: { one: [result()], two: [] }, reviews: { "result-one": result() }, library: library(), draft: draft(), ...seed });
    await page.addScriptTag({ content: script }); return page;
  }
  const refresh = async (page: Page) => { await page.locator("#coding-drafts-refresh").click(); await expect.poll(() => page.getByRole("button", { name: /^Open saved draft:/ }).isEnabled()).toBe(true); };
  const view = async (page: Page) => { await refresh(page); await page.getByRole("button", { name: /^Open saved draft:/ }).click(); await expect.poll(() => page.locator("#coding-drafts-view").isVisible()).toBe(true); };

  it("saves only after explicit retention disclosure and a named Save, passing no renderer-authored context", async () => {
    const page = await open();
    await expect.poll(() => page.getByRole("button", { name: "Review result: Parser change", exact: true }).isEnabled()).toBe(true);
    expect(await page.evaluate(() => window.__drafts.calls.some(call => call.method.startsWith("codingDraft")))).toBe(false);
    await page.getByRole("button", { name: "Review result: Parser change", exact: true }).click();
    await page.locator("#coding-drafts-save-show").click(); await expect.poll(() => page.locator("#coding-drafts-save-form").isVisible()).toBe(true);
    expect(await page.locator("#coding-drafts-save-note").innerText()).toContain("complete captured files, the last request and summary");
    expect(await page.evaluate(() => window.__drafts.calls.some(call => call.method === "codingDraftSave"))).toBe(false);
    await page.locator("#coding-drafts-name").fill("Parser checkpoint"); await page.locator("#coding-drafts-save").click();
    await expect.poll(() => page.locator("#coding-drafts-status").textContent()).toContain("saved encrypted");
    expect(await page.evaluate(() => window.__drafts.calls.filter(call => call.method === "codingDraftSave"))).toEqual([{ method: "codingDraftSave", args: ["result-one", "Parser checkpoint"] }]);
    expect(await page.evaluate(() => window.__drafts.calls.some(call => /Continue|Import/.test(call.method)))).toBe(false); await page.close();
  }, 30_000);

  it("opens historical context as inert plain text with bounded files and preview", async () => {
    const saved = draft(); saved.name = '<img src=x onerror="window.injected=true">'; saved.files = Array.from({ length: 205 }, (_, i) => ({ path: `src/${i}.ts`, kind: "file" })); saved.filesTotal = 205; saved.preview = "x".repeat(64010);
    const page = await open({ draft: saved, library: { ...library(), drafts: [saved] } }); await view(page);
    expect(await page.locator("#coding-drafts-view-title").innerText()).toBe(saved.name); expect(await page.locator("#coding-drafts img").count()).toBe(0);
    expect(await page.locator("#coding-drafts-metadata").innerText()).toContain("Historical checks: 2 run, 1 passed, 1 failed");
    expect(await page.locator("#coding-drafts-view").innerText()).toContain("Saved context is untrusted history");
    expect(await page.locator("#coding-drafts-request").innerText()).toBe(saved.context.request);
    expect(await page.locator("#coding-drafts-files li").count()).toBe(200); expect((await page.locator("#coding-drafts-preview").textContent())!.length).toBe(64000);
    expect(await page.locator("#coding-drafts-import").isDisabled()).toBe(true);
    expect(await page.evaluate(() => window.__drafts.calls.filter(call => call.method.startsWith("codingDraft")).map(call => call.method))).toEqual(["codingDraftsState", "codingDraftOpen"]); await page.close();
  }, 30_000);

  it("requires a newly chosen folder, opens the fresh import review, and starts only a typed new request", async () => {
    const page = await open(); await view(page);
    await page.locator("#coding-drafts-folder").click(); await expect.poll(() => page.locator("#coding-drafts-import").isEnabled()).toBe(true);
    await page.locator("#coding-drafts-import").click(); await expect.poll(() => page.locator("#project-coding-review-title").textContent()).toBe("Imported saved parser");
    expect(await page.locator("#project-coding-review-summary").textContent()).toContain("Checks: 0 run, 0 passed, 0 failed");
    expect(await page.evaluate(() => window.__drafts.calls.some(call => call.method === "codingResultContinue"))).toBe(false);
    await page.locator("#project-coding-continue").click(); expect(await page.locator("#project-coding-continue-request").inputValue()).toBe("");
    await page.locator("#project-coding-continue-request").fill("Verify the imported parser and run a fresh check."); await page.locator("#project-coding-continue-send").click();
    await expect.poll(() => page.locator("#project-coding-status").textContent()).toContain("Requested a new coding session");
    expect(await page.evaluate(() => window.__drafts.calls.filter(call => call.method === "codingResultContinue"))).toEqual([{ method: "codingResultContinue", args: ["imported-result", "one", "Verify the imported parser and run a fresh check."] }]); await page.close();
  }, 30_000);

  it("keeps import disabled after cancellation and refuses conflicts without creating continuation authority", async () => {
    const page = await open(); await view(page); await page.evaluate(() => { window.__drafts.cancelFolder = true; });
    await page.locator("#coding-drafts-folder").click(); await expect.poll(() => page.locator("#coding-drafts-status").textContent()).toContain("cancelled"); expect(await page.locator("#coding-drafts-import").isDisabled()).toBe(true);
    await page.evaluate(() => { window.__drafts.cancelFolder = false; window.__drafts.conflict = true; });
    await page.locator("#coding-drafts-folder").click(); await expect.poll(() => page.locator("#coding-drafts-import").isEnabled()).toBe(true); await page.locator("#coding-drafts-import").click();
    await expect.poll(() => page.locator("#coding-drafts-status").textContent()).toContain("1 conflicting file");
    expect(await page.locator("#project-coding-review").isHidden()).toBe(true); expect(await page.locator("#coding-drafts-import").isDisabled()).toBe(true);
    expect(await page.evaluate(() => window.__drafts.calls.some(call => call.method === "codingResultContinue"))).toBe(false); await page.close();
  }, 30_000);

  it("allows forgetting encrypted drafts when opening and saving are unavailable", async () => {
    const page = await open({ library: { canSave: false, canOpen: false, canForget: true, drafts: [], message: "The keyring is unavailable. Saved drafts can still be forgotten." } });
    await page.locator("#coding-drafts-refresh").click(); await expect.poll(() => page.locator("#coding-drafts-forget-all").isEnabled()).toBe(true); await page.locator("#coding-drafts-forget-all").click();
    await expect.poll(() => page.locator("#coding-drafts-status").textContent()).toContain("forgotten");
    expect(await page.evaluate(() => window.__drafts.calls.some(call => call.method === "codingDraftForgetAll"))).toBe(true); await page.close();
  }, 30_000);

  it("clears an opened private view when a fresh library read no longer offers it", async () => {
    const page = await open(); await view(page);
    await page.evaluate(() => { window.__drafts.library.drafts = []; }); await page.locator("#coding-drafts-refresh").click();
    await expect.poll(() => page.locator("#coding-drafts-view").isHidden()).toBe(true);
    expect(await page.locator("#coding-drafts-request").textContent()).toBe(""); expect(await page.locator("#coding-drafts-preview").textContent()).toBe(""); await page.close();
  }, 30_000);

  it("revokes a pending open immediately when Forget all is clicked", async () => {
    const page = await open({ deferred: { codingDraftOpen: true } }); await refresh(page); await page.getByRole("button", { name: /^Open saved draft:/ }).click();
    await page.waitForFunction(() => !!window.__drafts.resolve.codingDraftOpen); await page.locator("#coding-drafts-forget-all").click();
    await expect.poll(() => page.locator("#coding-drafts-status").textContent()).toContain("forgotten"); await page.evaluate(() => window.__drafts.resolve.codingDraftOpen(window.__drafts.draft));
    expect(await page.locator("#coding-drafts-view").isHidden()).toBe(true); expect(await page.locator("#coding-drafts-request").textContent()).toBe(""); await page.close();
  }, 30_000);

  it.each(["resolve", "reject"])("keeps an unrelated Forget pending while Close hides the opened draft, then recovers after %s", async outcome => {
    const first = draft(), second = { ...draft(), id: "draft-two", name: "Other saved draft" };
    const page = await open({ library: { ...library(), drafts: [first, second] }, deferred: { codingDraftForget: true } });
    await page.locator("#coding-drafts-refresh").click();
    const openFirst = page.getByRole("button", { name: "Open saved draft: Saved parser", exact: true });
    await expect.poll(() => openFirst.isEnabled()).toBe(true); await openFirst.click();
    await expect.poll(() => page.locator("#coding-drafts-view").isVisible()).toBe(true);
    await page.getByRole("button", { name: "Forget saved draft: Other saved draft", exact: true }).click();
    await page.waitForFunction(() => !!window.__drafts.resolve.codingDraftForget);
    expect(await page.locator("#coding-drafts-view").isVisible()).toBe(true); expect(await page.locator("#coding-drafts-close").isEnabled()).toBe(true);
    expect(await page.locator("#coding-drafts-forget-all").isDisabled()).toBe(true);
    await page.locator("#coding-drafts-close").click();
    expect(await page.locator("#coding-drafts-view").isHidden()).toBe(true); expect(await page.locator("#coding-drafts-request").textContent()).toBe("");
    expect(await page.locator("#coding-drafts-preview").textContent()).toBe("");
    expect(await page.locator("#coding-drafts-status").textContent()).toContain("Forgetting saved draft");
    expect(await page.locator("#coding-drafts-forget-all").isDisabled()).toBe(true);
    await page.evaluate(outcome => {
      const h = window.__drafts; h.deferred.codingDraftForget = false;
      if (outcome === "resolve") h.resolve.codingDraftForget({ ...h.library, drafts: [h.draft], message: "Saved draft forgotten." });
      else h.reject.codingDraftForget(new Error("The saved draft could not be forgotten. Try again."));
    }, outcome);
    const forgetFirst = page.getByRole("button", { name: "Forget saved draft: Saved parser", exact: true });
    await expect.poll(() => forgetFirst.isEnabled()).toBe(true); expect(await page.locator("#coding-drafts-forget-all").isEnabled()).toBe(true);
    expect(await page.locator("#coding-drafts-view").isHidden()).toBe(true); expect(await page.locator("#coding-drafts-request").textContent()).toBe("");
    await forgetFirst.click();
    await expect.poll(() => page.locator("#coding-drafts-status").textContent()).toContain("forgotten");
    expect(await page.evaluate(() => window.__drafts.calls.filter(call => call.method === "codingDraftForget").map(call => call.args))).toEqual([["draft-two"], ["draft-one"]]);
    await page.close();
  }, 30_000);

  it("does not restore a saved draft list from a late Save reply after Forget all", async () => {
    const page = await open({ deferred: { codingDraftSave: true } });
    await expect.poll(() => page.getByRole("button", { name: "Review result: Parser change", exact: true }).isEnabled()).toBe(true);
    await page.getByRole("button", { name: "Review result: Parser change", exact: true }).click(); await page.locator("#coding-drafts-save-show").click();
    await expect.poll(() => page.locator("#coding-drafts-save-form").isVisible()).toBe(true); await page.locator("#coding-drafts-save").click(); await page.waitForFunction(() => !!window.__drafts.resolve.codingDraftSave);
    await page.locator("#coding-drafts-forget-all").click(); await expect.poll(() => page.locator("#coding-drafts-status").textContent()).toContain("forgotten");
    await page.evaluate(() => window.__drafts.resolve.codingDraftSave(window.__drafts.library));
    expect(await page.locator("#coding-drafts-list").textContent()).not.toContain("Saved parser"); expect(await page.locator("#coding-drafts-save-form").isHidden()).toBe(true); await page.close();
  }, 30_000);

  it("ignores a late import acknowledgement after selecting another project", async () => {
    const page = await open({ deferred: { codingDraftImport: true } }); await view(page); await page.locator("#coding-drafts-folder").click();
    await expect.poll(() => page.locator("#coding-drafts-import").isEnabled()).toBe(true); await page.locator("#coding-drafts-import").click(); await page.waitForFunction(() => !!window.__drafts.resolve.codingDraftImport);
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("ember-project-changed", { detail: { projectId: "two" } }));
      window.__drafts.resolve.codingDraftImport({ ok: true, message: "OLD imported result", resultId: "imported-result" });
    });
    expect(await page.locator("#project-coding-review").isHidden()).toBe(true); expect(await page.locator("#coding-drafts-import").isDisabled()).toBe(true);
    expect(await page.locator("#coding-drafts-status").textContent()).not.toContain("OLD imported"); await page.close();
  }, 30_000);

  it.each(["account", "provider", "connection"])("ignores private draft replies after %s changes", async change => {
    const page = await open({ deferred: { codingDraftOpen: true } }); await refresh(page); await page.getByRole("button", { name: /^Open saved draft:/ }).click(); await page.waitForFunction(() => !!window.__drafts.resolve.codingDraftOpen);
    await page.evaluate(change => {
      const h = window.__drafts;
      if (change === "account") h.emit("onConversationForgotten"); else h.emit("onAgentStatus", { phase: change === "provider" ? "ready" : "signed-out", login: "different", service: { host: "new-provider.example", kind: "user" } });
      h.resolve.codingDraftOpen(h.draft);
    }, change);
    expect(await page.locator("#coding-drafts-view").isHidden()).toBe(true); expect(await page.locator("#coding-drafts-request").textContent()).toBe(""); expect(await page.locator("#coding-drafts-list").textContent()).not.toContain("Saved parser"); await page.close();
  }, 30_000);

  it.each(["state", "open"])("retires private drafts and rejects a late %s reply during a same-service credential switch", async held => {
    const page = await open();
    await page.evaluate(() => window.__drafts.emit("onAgentStatus", { phase: "ready", login: "same-account", service: { host: "same-model.example", kind: "user" }, conductorModel: "same-model", workerModel: "same-worker", switchPending: false }));
    await view(page);
    await page.getByRole("button", { name: "Review result: Parser change", exact: true }).click(); await page.locator("#coding-drafts-save-show").click();
    await expect.poll(() => page.locator("#coding-drafts-save-form").isVisible()).toBe(true);
    expect(await page.locator("#coding-drafts-request").textContent()).toContain("Old request");
    const method = held === "state" ? "codingDraftsState" : "codingDraftOpen";
    await page.evaluate(method => { window.__drafts.deferred[method] = true; }, method);
    if (held === "state") await page.locator("#coding-drafts-refresh").click();
    else await page.getByRole("button", { name: "Open saved draft: Saved parser", exact: true }).click();
    await page.waitForFunction(method => !!window.__drafts.resolve[method], method);
    await page.evaluate(() => window.__drafts.emit("onAgentStatus", { phase: "ready", login: "same-account", service: { host: "same-model.example", kind: "user" }, conductorModel: "same-model", workerModel: "same-worker", switchPending: true }));
    expect(await page.locator("#coding-drafts-view").isHidden()).toBe(true);
    for (const id of ["request", "summary", "preview", "list"]) expect(await page.locator(`#coding-drafts-${id}`).textContent()).toBe("");
    expect(await page.locator("#coding-drafts-save-form").isHidden()).toBe(true); expect(await page.locator("#coding-drafts-name").inputValue()).toBe("");
    expect(await page.locator("#coding-drafts-save-show").isDisabled()).toBe(true); expect(await page.locator("#coding-drafts-refresh").isDisabled()).toBe(true);
    await page.evaluate(() => window.__drafts.emit("onAgentStatus", { phase: "ready", login: "same-account", service: { host: "same-model.example", kind: "user" }, conductorModel: "same-model", workerModel: "same-worker", switchPending: false }));
    await page.evaluate(method => window.__drafts.resolve[method](method === "codingDraftsState" ? window.__drafts.library : window.__drafts.draft), method);
    expect(await page.locator("#coding-drafts-view").isHidden()).toBe(true);
    for (const id of ["request", "summary", "preview", "list"]) expect(await page.locator(`#coding-drafts-${id}`).textContent()).toBe("");
    expect(await page.locator("#coding-drafts-save-form").isHidden()).toBe(true); expect(await page.locator("#coding-drafts-name").inputValue()).toBe(""); await page.close();
  }, 30_000);

  it("rejects a late folder reply after project selection without applying it to the new project", async () => {
    const page = await open({ deferred: { codingDraftFolderChoose: true } }); await view(page); await page.locator("#coding-drafts-folder").click(); await page.waitForFunction(() => !!window.__drafts.resolve.codingDraftFolderChoose);
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("ember-project-changed", { detail: { projectId: "two" } }));
      window.__drafts.resolve.codingDraftFolderChoose({ ok: true, message: "OLD folder", workspace: { ...window.__drafts.workspace.one, folder: { path: "/private/old", label: "Old", valid: true } } });
    });
    await expect.poll(() => page.locator("#project-coding-folder").textContent()).toContain("Current folder");
    expect(await page.locator("#project-coding-folder").textContent()).not.toContain("/private/old"); expect(await page.locator("#coding-drafts-import").isDisabled()).toBe(true); await page.close();
  }, 30_000);

  it("wraps saved context and previews in narrow light, dark and contrast views", async () => {
    const saved = draft(); saved.context.request = "x".repeat(2000); saved.preview = "x".repeat(5000); saved.files[0].path = "src/" + "a".repeat(250) + ".ts";
    const page = await open({ draft: saved }); await view(page);
    await page.evaluate(() => {
      document.documentElement.classList.add("content"); document.documentElement.dataset.textSize = "larger"; document.getElementById("navigation")!.hidden = true;
      const main = document.createElement("main"); main.className = "home"; const section = document.createElement("section"); section.dataset.pane = "projects"; section.append(document.getElementById("project-coding")!); main.append(section); document.body.append(main);
    });
    const css = fs.readFileSync("app/renderer/shared/ember.css", "utf8").replace('../fonts/InterVariable.woff2', `data:font/woff2;base64,${fs.readFileSync("assets/fonts/InterVariable.woff2").toString("base64")}`);
    await page.addStyleTag({ content: css + fs.readFileSync("app/renderer/home/styles.css", "utf8") });
    for (const theme of ["dark", "light", "contrast"] as const) {
      await page.emulateMedia({ colorScheme: theme === "light" ? "light" : "dark", forcedColors: theme === "contrast" ? "active" : "none" });
      await page.setViewportSize({ width: 390, height: 900 }); await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.EMBER_UI_EVIDENCE) { fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true }); await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, `coding-drafts-${theme}-390.png`), fullPage: true }); }
    }
    await page.locator("#coding-drafts-close").click(); await page.getByRole("button", { name: "Review result: Parser change", exact: true }).click(); await page.locator("#coding-drafts-save-show").click();
    await expect.poll(() => page.locator("#coding-drafts-save-form").isVisible()).toBe(true);
    await page.emulateMedia({ colorScheme: "dark", forcedColors: "none" });
    for (const width of [900, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
      expect((await page.locator("#coding-drafts-name").boundingBox())!.width).toBeGreaterThan(180);
      if (process.env.EMBER_UI_EVIDENCE) await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, `coding-drafts-save-${width}.png`), fullPage: true });
    }
    await page.close();
  }, 30_000);
});
