/**
 * The SDK features the coding window gained with docs/CODING-APP.md §8 "SDK coverage", in the built window as a person
 * uses it, against the scripted window.emberCode (test/fixtures/code-window/fake-api.js): the rarer events drawn (a
 * picture from a tool's result and one the session made, a reply's sources, a problem's remedy that opens sign-in or the
 * sandbox, notes for a handoff, a context truncation, a finished task and a workflow); the user's defaults and a
 * project's instructions in Customise › Defaults, preselected by the start flow; a session's settings; and Storage with
 * its dry run first. Nothing is read, sent or kept. Runs with EMBER_UIUX_TEST=1 after `npm run build`; screenshots go to
 * EMBER_SHOTS when it is set.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

type Fake = { calls: string[]; emit(sid: string, type: string, data: unknown, extra?: Record<string, unknown>): void; params: { method: string; params: Record<string, unknown> }[] };
const gate = process.env.EMBER_UIUX_TEST !== "1";
const FAKE = path.resolve("test/fixtures/code-window/fake-api.js");
const SHOTS = process.env.EMBER_SHOTS ?? "";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAAMIM////ZwAAHu8E/KPItPcAAAAASUVORK5CYII=";

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
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
});
afterAll(async () => { if (gate) return; await browser.close(); server.close(); });
afterEach(async () => { if (!gate) await Promise.all(browser.contexts().map(context => context.close())); });

/** The window with "Fix the login redirect" shown. */
async function open(opts: { viewport?: { width: number; height: number }; colorScheme?: "dark" | "light"; forced?: boolean } = {}): Promise<Page & { errors: string[]; loaded: string[] }> {
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: opts.colorScheme ?? "dark", ...(opts.forced ? { forcedColors: "active" as const } : {}) });
  const page = await context.newPage() as Page & { errors: string[]; loaded: string[] };
  page.errors = [];
  page.loaded = [];
  page.on("pageerror", e => page.errors.push(e.message));
  page.on("request", r => page.loaded.push(r.url()));
  await page.addInitScript({ path: FAKE });
  await page.goto(`http://127.0.0.1:${port}/app/renderer/code/index.html`);
  await page.locator(".s-open").first().click();
  await expect.poll(() => page.locator("#session-title").textContent()).toBe("Fix the login redirect");
  return page;
}
const calls = (p: Page) => p.evaluate(() => (window as unknown as { __fake: Fake }).__fake.calls.slice());
const shot = async (p: Page, name: string) => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

describe.skipIf(gate)("the coding window's rarer SDK events", () => {
  it("draws pictures, sources, remedies and notes, loads nothing from outside and opens sign-in through main", async () => {
    const page = await open();
    await page.evaluate(png => {
      const f = (window as unknown as { __fake: Fake }).__fake;
      const sid = "s-login";
      f.emit(sid, "session.handoff", { handoffTime: "t", sourceType: "cloud", repository: { owner: "me", name: "app" }, summary: "The redirect was traced to the OAuth callback." });
      f.emit(sid, "tool.execution_start", { toolCallId: "pic", toolName: "view", arguments: { path: "/home/me/work/app/assets/logo.png" } });
      f.emit(sid, "tool.execution_complete", { toolCallId: "pic", success: true, result: { content: "Viewed image file successfully.", binaryResultsForLlm: [{ type: "image", data: png, mimeType: "image/png", description: "logo.png" }, { type: "image", data: "https://example.com/x.png", mimeType: "image/svg+xml" }] } });
      f.emit(sid, "assistant.message", { messageId: "cite", content: "The callback drops the `next` parameter.", citations: { sources: [{ id: "1", provider: "web", title: "OAuth 2.0 redirect URIs", url: "https://example.com/oauth" }, { id: "2", provider: "file", path: "/home/me/work/app/src/oauth.ts" }], spans: [] } });
      f.emit(sid, "session.truncation", { messagesRemovedDuringTruncation: 6, tokensRemovedDuringTruncation: 4000, performedBy: "runtime", postTruncationMessagesLength: 2, postTruncationTokensInMessages: 1, preTruncationMessagesLength: 8, preTruncationTokensInMessages: 5, tokenLimit: 9 });
      f.emit(sid, "workflow.run_started", { attempt: 1, runId: "w1", workflowName: "release" }, { ephemeral: true });
      f.emit(sid, "session.binary_asset", { assetId: "a", byteLength: 70, data: png, mimeType: "image/png", type: "image", description: "A chart of the redirects" });
      f.emit(sid, "session.task_complete", { success: true, summary: "The redirect keeps `next` now." });
      f.emit(sid, "session.error", { errorType: "authentication", message: "Not authenticated", remediation: "sign_in" });
      f.emit(sid, "session.warning", { warningType: "sandbox", message: "A command needed the network.", remediation: "review_sandbox_policy" });
    }, PNG);
    const items = page.locator("#transcript .items > li");
    await expect.poll(() => page.locator("#transcript .picture-img").count()).toBe(2);
    expect(await page.locator("#transcript .picture-img").first().getAttribute("src")).toBe(`data:image/png;base64,${PNG}`);
    expect(await page.locator("#transcript .picture-img").first().getAttribute("alt")).toBe("logo.png");
    expect(await page.locator("#transcript .hint", { hasText: "One picture isn't shown" }).count()).toBe(1);
    expect(await page.locator("#transcript .sources summary").textContent()).toBe("Sources: 2 sources");
    expect(await items.allTextContents()).toEqual(expect.arrayContaining([
      expect.stringContaining("Continued from a cloud session of me/app."),
      expect.stringContaining("To make room, Copilot no longer sends the model the 6 earliest messages."),
      expect.stringContaining("Running the workflow “release”…"),
      expect.stringContaining("Copilot finished the task."),
    ]));
    // A source opens through main, never in the window.
    await page.locator("#transcript .sources summary").click();
    await page.locator("#transcript .sources a").click();
    expect((await calls(page)).filter(c => c.startsWith("openLink:"))).toEqual(["openLink:https://example.com/oauth"]);
    expect(page.url()).toContain("/app/renderer/code/index.html");
    await shot(page, "events-dark");
    // The remedies: sign-in through main, the sandbox in Customise.
    await page.locator("#transcript .remedy-act", { hasText: "Open sign-in…" }).click();
    expect(await calls(page)).toContain("openSignIn");
    await page.locator("#transcript .remedy-act", { hasText: "Show the sandbox" }).click();
    await expect.poll(() => page.locator(".c-h").textContent()).toBe("Sandbox");
    // Nothing loaded from anywhere but the page's own origin (the pictures are data URLs).
    expect(page.loaded.filter(u => !u.startsWith(`http://127.0.0.1:${port}/`) && !u.startsWith("data:"))).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  it("reads in light mode and under forced colours", async () => {
    for (const [name, o] of [["events-light", { colorScheme: "light" as const }], ["events-forced", { forced: true }]] as const) {
      const page = await open(o);
      await page.evaluate(png => {
        const f = (window as unknown as { __fake: Fake }).__fake;
        f.emit("s-login", "session.binary_asset", { assetId: "a", byteLength: 70, data: png, mimeType: "image/png", type: "image", description: "A chart" });
        f.emit("s-login", "session.error", { errorType: "authentication", message: "Not authenticated", remediation: "sign_in" });
      }, PNG);
      await expect.poll(() => page.locator("#transcript .remedy-act").count()).toBe(1);
      await shot(page, name);
      expect(page.errors).toEqual([]);
    }
  });
});

/** Customise on `section` from the shown session. */
async function customise(page: Page, section: string): Promise<void> {
  await page.locator("#side-customise").click();
  await page.locator(`.c-link[data-section="${section}"]`).click();
  await expect.poll(() => page.locator(".c-body .cz-loading").count()).toBe(0);
}

describe.skipIf(gate)("the person's defaults, a project's settings and a session's options", () => {
  it("saves defaults for every project and one project's own, with its instructions and an extra folder, and the start flow takes them", async () => {
    const page = await open();
    await customise(page, "defaults");
    const all = page.locator(".cz-part").filter({ has: page.locator("h3", { hasText: "For every project" }) });
    await expect.poll(() => all.locator("select").count()).toBe(5);
    // A mode the organisation forbids is shown as such and can't be chosen.
    expect(await all.locator("#cz-def-all-perm option[value='allow-all']").textContent()).toBe("Approve all (not allowed by your organisation)");
    expect(await all.locator("#cz-def-all-perm option[value='allow-all']").isDisabled()).toBe(true);
    await all.locator("#cz-def-all-perm").selectOption("assisted");
    await all.locator("#cz-def-all-agent").selectOption("plan");
    await all.getByRole("button", { name: "Save defaults" }).click();
    await expect.poll(() => page.locator(".cz-said").textContent()).toBe("Saved. New sessions start with these.");
    const project = page.locator(".cz-part").filter({ has: page.locator("h3", { hasText: "For this project" }) });
    await expect.poll(() => project.locator("textarea").count()).toBe(1);
    await project.locator("select[id^='cz-def-p-'][id$='-model']").selectOption("claude-sonnet-5");
    await project.getByRole("button", { name: "Save defaults" }).click();
    await project.locator("textarea").fill("Use British spelling in comments.");
    await page.getByRole("button", { name: "Save instructions" }).click();
    await expect.poll(() => page.locator(".cz-said").textContent()).toBe("Saved. Sessions read them as they start or open again.");
    await page.getByRole("button", { name: "Add folder…" }).click();
    await expect.poll(() => page.locator(".cz-row").filter({ hasText: "shared-lib" }).count()).toBe(1);
    await shot(page, "defaults");
    const c = await calls(page);
    expect(c).toContain('setSettings:{"defaults":{"permissionMode":"assisted","agentMode":"plan"}}');
    expect(c).toContain('setSettings:{"projectId":"p-app","defaults":{"model":"claude-sonnet-5"}}');
    expect(c).toContain('setSettings:{"projectId":"p-app","instructions":"Use British spelling in comments."}');
    expect(c).toContain('projectFolders:p-app:{"add":true}');
    // The start flow preselects them for that project.
    await page.locator(".c-head .btn").click();
    await page.locator("#side-new").click();
    await expect.poll(() => page.locator("#start-agent-mode").inputValue()).toBe("plan");
    expect(await page.locator("#start-permissions").inputValue()).toBe("assisted");
    await expect.poll(() => page.locator("#start-model").inputValue()).toBe("claude-sonnet-5");
    await shot(page, "start-with-defaults");
    expect(page.errors).toEqual([]);
  });

  it("changes a session's summaries, long context, co-author and built-in tools, and keeps them", async () => {
    const page = await open();
    await customise(page, "session-settings");
    await expect.poll(() => page.locator(".cz-check input").count()).toBe(7);
    await page.locator("select[id^='cz-summary-']").selectOption("detailed");
    await page.locator("[id^='cz-long-']").check();
    await page.locator("[id^='cz-coauthor-']").uncheck();
    await page.getByLabel("bash (Running command)").uncheck();
    await page.getByRole("button", { name: "Save session settings" }).click();
    await expect.poll(() => page.locator(".cz-said").textContent()).toBe("Saved. Copilot uses them from its next step.");
    expect(await calls(page)).toContain('configure:s-login:{"reasoningSummary":"detailed","contextTier":"long_context","coauthor":false,"excludedTools":["bash"]}');
    await shot(page, "session-settings");
    // Drawn again: the tool left out is still listed, off, so it can be turned back on.
    await page.locator(".c-link[data-section='usage']").click();
    await page.locator(".c-link[data-section='session-settings']").click();
    await expect.poll(() => page.locator(".cz-check input").count()).toBe(7);
    expect(await page.getByLabel("bash", { exact: true }).isChecked()).toBe(false);
    expect(await page.locator("select[id^='cz-summary-']").inputValue()).toBe("detailed");
    expect(page.errors).toEqual([]);
  });
});
