/**
 * Customise in the built coding window, as a person uses it (docs/CODING-APP.md §4 "Customise", step 4): every section
 * opens from a session and says what it applies to; each one's main action reaches the SDK's own method through the
 * scripted window.emberCode (test/fixtures/code-window/fake-api.js); an MCP server's secret is sent once and never drawn
 * again; destructive actions ask first; a refused call says a plain sentence with Try again. Nothing is read, sent or
 * kept. Runs with EMBER_UIUX_TEST=1 after `npm run build`.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/** The fake's handles this suite reads (code-window-renderer.test.ts declares its own on Window, so these are cast). */
type Fake = { calls: string[]; refuse: Set<string>; params: { method: string; params: Record<string, unknown> }[]; mcp: { disabled: Set<string> } };

const gate = process.env.EMBER_UIUX_TEST !== "1";
const FAKE = path.resolve("test/fixtures/code-window/fake-api.js");
const SECRET = "fake-secret-value-123";

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
afterEach(async () => { if (!gate) await Promise.all(browser.contexts().map(context => context.close())); });

/** The window with "Fix the login redirect" shown, then Customise on `section`. */
async function open(section: string, viewport = { width: 1280, height: 900 }): Promise<Page & { errors: string[] }> {
  const page = await browser.newPage({ viewport }) as Page & { errors: string[] };
  page.errors = [];
  page.on("pageerror", e => page.errors.push(e.message));
  await page.addInitScript({ path: FAKE });
  await page.goto(`http://127.0.0.1:${port}/app/renderer/code/index.html`);
  await page.locator(".s-open").first().click();
  await expect.poll(() => page.locator("#session-title").textContent()).toBe("Fix the login redirect");
  await page.locator("#side-customise").click();
  await go(page, section);
  return page;
}
async function go(page: Page, section: string): Promise<void> {
  const link = page.locator(`.c-link[data-section="${section}"]`);
  const label = await link.textContent();
  await link.click();
  await expect.poll(() => page.locator(".c-h").textContent()).toBe(label);
  await expect.poll(() => page.locator(".c-body .cz-loading").count()).toBe(0);
}
const calls = (p: Page) => p.evaluate(() => (window as unknown as { __fake: Fake }).__fake.calls);
const sent = (p: Page, method: string) => p.evaluate(m => (window as unknown as { __fake: Fake }).__fake.params.filter(x => x.method === m).map(x => x.params), method);
const said = (p: Page) => p.locator(".cz-said").textContent();
/** The section below its scope line and session chooser. */
const body = (p: Page) => p.locator(".c-body .cz-body");

describe.skipIf(gate)("Customise in the coding window", () => {
  it("opens every section, each saying what it applies to and naming the session, with nothing left loading", async () => {
    const page = await open("models");
    const scopes: Record<string, string> = {};
    for (const id of ["models", "mcp-servers", "skills", "plugins", "agents", "instructions", "hooks", "permissions", "sandbox", "schedules", "usage"]) {
      await go(page, id);
      scopes[id] = (await page.locator(".cz-scope").textContent()) ?? "";
      expect(await body(page).locator(".cz-problem, .cz-na").count(), id).toBe(0);
    }
    const both = "Parts of this apply to this computer, and parts to the session “Fix the login redirect”.";
    expect(scopes).toEqual({
      models: both, "mcp-servers": both, skills: both, plugins: "Applies to this computer: every session here uses it.", agents: both, instructions: both,
      hooks: "Applies to this computer: every session here uses it.", permissions: "Applies to the session “Fix the login redirect”.", sandbox: both,
      schedules: "Applies to the session “Fix the login redirect”.", usage: both,
    });
    // Keyboard: the section links move with the arrow keys.
    await page.locator(".c-link[data-section='usage']").focus();
    await page.keyboard.press("ArrowUp");
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.section)).toBe("schedules");
    expect(page.errors).toEqual([]);
  });

  it("switches the session's model and effort, and looks for a local provider read-only", async () => {
    const page = await open("models");
    expect(await body(page).locator(".cz-part").nth(1).locator(".cz-row .cz-name span[id]").allTextContents()).toEqual(["GPT-5.5", "Claude Sonnet 5", "GPT-5.4 mini"]);
    await page.locator("#cz-model-pick").selectOption("claude-sonnet-5");
    expect(await page.locator("#cz-effort-pick option").allTextContents()).toEqual(["Low", "Medium", "High"]);
    await page.getByRole("button", { name: "Switch model" }).click();
    await expect.poll(() => said(page)).toBe("The session now uses “Claude Sonnet 5”.");
    expect(await calls(page)).toContain("rpc:session:model.switchTo");
    await page.getByRole("button", { name: "Look for providers: Ollama" }).click();
    await expect.poll(() => body(page).getByText("Running, version 0.12.3").count()).toBe(1);
    expect(await body(page).getByText("qwen3-coder:30b · 17 GB").count()).toBe(1);
    // Nothing here takes a key.
    expect(await body(page).locator("input[type='password']").count()).toBe(0);
  });

  it("adds an MCP server with a secret that is sent once and never drawn again, edits, turns off and removes one", async () => {
    const page = await open("mcp-servers");
    expect(await page.content()).not.toContain(SECRET);
    // An empty form: each error under its field, focus on the first.
    await page.getByRole("button", { name: "Add server…" }).click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("cz-mcp-name");
    await page.getByRole("button", { name: "Save" }).click();
    expect(await page.locator("#cz-mcp-name-err").textContent()).toBe("Give the server a name.");
    expect(await page.locator("#cz-mcp-command-err").textContent()).toBe("Say which program to run.");
    expect(await page.locator("#cz-mcp-name").getAttribute("aria-invalid")).toBe("true");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("cz-mcp-name");
    await page.locator("#cz-mcp-name").fill("files");
    await page.locator("#cz-mcp-command").fill("npx");
    await page.locator("#cz-mcp-args").fill("-y\n@acme/files");
    await page.getByRole("button", { name: "Add a variable" }).click();
    await page.getByLabel("Variable 1 name").fill("FILES_TOKEN");
    const value = page.getByLabel("Variable 1 value");
    expect(await value.getAttribute("type")).toBe("password");
    await value.fill("typed-secret-456");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => said(page)).toBe("“files” was added. New sessions start it.");
    expect(await sent(page, "mcp.config.add")).toEqual([{ name: "files", config: { type: "stdio", command: "npx", args: ["-y", "@acme/files"], env: { FILES_TOKEN: "typed-secret-456" } } }]);
    expect(await page.content()).not.toContain("typed-secret-456");
    expect(await body(page).getByText("Variables: FILES_TOKEN").count()).toBe(1);

    // Editing keeps the value Copilot holds unless a new one is typed; it is never put in the page.
    await page.getByRole("button", { name: "Edit “issues”…" }).click();
    expect(await page.getByLabel("Variable 1 value").inputValue()).toBe("");
    expect(await page.getByLabel("Variable 1 value").getAttribute("placeholder")).toBe("Kept");
    expect(await page.content()).not.toContain(SECRET);
    await page.locator("#cz-mcp-args").fill("-y\n@acme/issues-mcp\n--verbose");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => said(page)).toBe("“issues” was saved. Restart it in a session to use the change.");
    expect(await sent(page, "mcp.config.update")).toEqual([{ name: "issues", config: { type: "stdio", command: "npx", args: ["-y", "@acme/issues-mcp", "--verbose"], env: { ISSUES_TOKEN: SECRET }, timeout: 30_000 } }]);

    // On and off at once; removing asks first, and Cancel keeps it.
    const sw = page.getByRole("switch", { name: "docs" });
    await sw.click();
    await expect.poll(() => page.evaluate(() => [...(window as unknown as { __fake: Fake }).__fake.mcp.disabled])).toEqual(["docs"]);
    await page.getByRole("button", { name: "Remove “docs”" }).click();
    expect(await page.getByRole("group", { name: "Remove “docs”?" }).count()).toBe(1);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Cancel");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Remove “docs”");
    await page.keyboard.press("Enter");
    await page.getByRole("group", { name: "Remove “docs”?" }).getByRole("button", { name: "Remove" }).click();
    await expect.poll(() => said(page)).toBe("“docs” was removed.");
    expect(await sent(page, "mcp.config.remove")).toEqual([{ name: "docs" }]);
    expect(page.errors).toEqual([]);
  });

  it("shows the session's servers live: stop follows the status event, sign-in offers its address to copy, offers open", async () => {
    const page = await open("mcp-servers");
    const live = body(page).locator(".cz-part").last();
    await page.getByRole("button", { name: "Stop “issues”" }).click();
    await expect.poll(() => live.locator(".cz-row").first().locator(".cz-line").first().textContent()).toBe("Stopped · Yours");
    await page.getByRole("button", { name: "Sign in… “docs”" }).click();
    await expect.poll(() => live.locator(".cz-url").textContent()).toBe("https://mcp.example.com/oauth/authorize?client_id=ember&state=abc");
    expect(await calls(page)).toContain("rpc:session:mcp.oauth.login");
    await page.getByRole("button", { name: "Start “issues”" }).waitFor();
    await page.getByRole("button", { name: "Start “issues”" }).click();
    await expect.poll(() => live.locator(".cz-row").first().locator(".cz-line").first().textContent()).toBe("Connected · Yours");
    await live.getByText("What “issues” offers").click();
    await expect.poll(() => live.getByText("create_issue").count()).toBe(1);
    expect(await live.getByText("Open issues").count()).toBe(1);
    expect(await live.getByText("triage").count()).toBe(1);
  });

  it("turns skills off for the session and for new sessions, installs a plugin from a marketplace, and uses an agent", async () => {
    const page = await open("skills");
    const sessionSkill = body(page).locator(".cz-part").first().getByRole("switch", { name: "release-notes" });
    await sessionSkill.click();
    await expect.poll(() => said(page)).toBe("“release-notes” is off.");
    expect(await calls(page)).toContain("rpc:session:skills.disable");
    await body(page).locator(".cz-part").nth(1).getByRole("switch", { name: "pdf" }).click();
    await expect.poll(() => calls(page)).toContain("rpc:client:skills.config.setSkillDisabled");
    await page.getByRole("button", { name: "Reload: Skills in this session" }).click();
    await expect.poll(() => said(page)).toBe("Read again: 1 has a warning.");

    await go(page, "plugins");
    await page.getByLabel("Install a plugin").fill("not a spec");
    await page.getByRole("button", { name: "Install", exact: true }).click();
    expect(await page.locator("#cz-plugin-source-err").textContent()).toBe("Give it as name@marketplace, owner/repo or an address.");
    await body(page).getByText("Plugins in “acme-tools”").click();
    await page.getByRole("button", { name: "Install “deploy-helper”" }).click();
    await expect.poll(() => said(page)).toBe("“deploy-helper” was installed, with 2 skills.");
    expect(await sent(page, "plugins.install")).toEqual([expect.objectContaining({ source: "deploy-helper@acme-tools" })]);
    await page.getByRole("button", { name: "Uninstall “linear”" }).click();
    await page.getByRole("group", { name: /Uninstall “linear”/ }).getByRole("button", { name: "Uninstall" }).click();
    await expect.poll(() => said(page)).toBe("“linear” was uninstalled.");

    await go(page, "agents");
    await page.getByRole("button", { name: "Use “Code reviewer” in this session" }).click();
    await expect.poll(() => said(page)).toBe("The session uses “Code reviewer”.");
    await expect.poll(() => body(page).locator(".cz-current").textContent()).toBe("The session uses “reviewer”.");
    await page.getByRole("button", { name: "Use Copilot's own agent" }).click();
    await expect.poll(() => said(page)).toBe("The session uses Copilot's own agent.");
  });

  it("marks instructions in force, lists hooks read-only, and says what the sandbox has", async () => {
    const page = await open("instructions");
    const found = body(page).locator(".cz-part").nth(1);
    expect(await found.locator(".cz-row .tag").allTextContents()).toEqual(["In force", "Not in this session", "Off until turned on"]);
    await found.getByText("Show its text").first().click();
    expect(await found.locator("pre").first().textContent()).toBe("# How we work\n\nRun npm test before you push.\n");
    await go(page, "hooks");
    expect(await body(page).locator(".cz-row .cz-name span[id]").allTextContents()).toEqual(["Before a tool runs", "When a session ends"]);
    expect(await body(page).locator("input, select").count()).toBe(0);
    expect(await body(page).getByText("1 couldn't be read.").count()).toBe(1);
    await go(page, "sandbox");
    expect(await body(page).getByText("Network inside the sandbox: no").count()).toBe(1);
    expect(await body(page).getByText("Install slirp4netns to give sandboxed commands the network.").count()).toBe(1);
    expect(await body(page).locator("button, input, select").count()).toBe(0);
  });

  it("changes modes through their own commands, holds Approve all the organisation turned off, adds rules and trusts a folder", async () => {
    const page = await open("permissions");
    await expect.poll(() => page.locator("#cz-perm-mode option[value='allow-all']").textContent()).toBe("Approve all (turned off by your organisation)");
    expect(await page.locator("#cz-perm-mode option[value='allow-all']").isDisabled()).toBe(true);
    await page.locator("#cz-perm-mode").selectOption("assisted");
    await expect.poll(() => calls(page)).toContain("permissionMode:s-login:assisted");
    expect((await calls(page)).some(c => /rpc:.*permissions\.setMode/.test(c))).toBe(false);
    await page.locator("#cz-agent-mode").selectOption("plan");
    await expect.poll(() => calls(page)).toContain("agentMode:s-login:plan");

    await page.locator("#cz-rule").fill("Shell(npm test");
    await page.getByRole("button", { name: "Add rule" }).click();
    expect(await page.locator("#cz-rule-err").textContent()).toBe("Write it as a kind, such as write, or a kind with brackets, such as Shell(npm test).");
    await page.locator("#cz-rule").fill("Shell(npm test)");
    await page.locator("#cz-rule-scope").selectOption("location");
    await page.getByRole("button", { name: "Add rule" }).click();
    await expect.poll(() => said(page)).toBe("“Shell(npm test)” was added.");
    expect(await sent(page, "permissions.modifyRules")).toEqual([{ scope: "location", add: [{ kind: "Shell", argument: "npm test" }] }]);
    await page.getByRole("button", { name: "Remove “Shell(npm test)”" }).click();
    await page.getByRole("group", { name: "Remove “Shell(npm test)”?" }).getByRole("button", { name: "Remove" }).click();
    await expect.poll(() => sent(page, "permissions.modifyRules")).toHaveLength(2);

    await page.getByRole("button", { name: "Forget this session's approvals" }).click();
    await page.getByRole("group", { name: /Forget every/ }).getByRole("button", { name: "Forget" }).click();
    await expect.poll(() => said(page)).toBe("Copilot will ask again.");

    await page.locator("#cz-folder").fill("relative/path");
    await page.getByRole("button", { name: "Allow folder" }).click();
    expect(await page.locator("#cz-folder-err").textContent()).toBe("Give a whole path, such as /home/you/project.");
    await page.locator("#cz-folder").fill("/home/me/work/shared");
    await page.getByRole("button", { name: "Allow folder" }).click();
    await expect.poll(() => body(page).getByText("/home/me/work/shared", { exact: true }).count()).toBe(1);

    await page.getByRole("button", { name: "Trust “/home/me/work/app”" }).click();
    await page.getByRole("group", { name: /Trust “\/home\/me\/work\/app”\?/ }).getByRole("button", { name: "Trust" }).click();
    await expect.poll(() => body(page).getByText("Trusted", { exact: true }).count()).toBe(1);
    expect(page.errors).toEqual([]);
  });

  it("stops a schedule after asking, and compacts the conversation after asking", async () => {
    const page = await open("schedules");
    expect(await body(page).getByText("Every 30 minutes", { exact: false }).count()).toBe(1);
    await page.getByRole("button", { name: "Stop “Check the build and tell me if it failed”" }).click();
    await page.getByRole("group", { name: "Stop sending “Check the build and tell me if it failed”?" }).getByRole("button", { name: "Stop" }).click();
    await expect.poll(() => said(page)).toBe("It won't be sent again.");
    expect(await body(page).locator(".cz-row").count()).toBe(1);
    await go(page, "usage");
    expect(await page.getByRole("meter", { name: /Context used: 38%/ }).count()).toBe(1);
    await page.getByRole("button", { name: "Compact now" }).click();
    await page.getByRole("group", { name: "Compact the conversation now?" }).getByRole("button", { name: "Compact now" }).click();
    await expect.poll(() => said(page)).toBe("Compacted: 28K tokens and 12 messages freed.");
    expect(await sent(page, "history.compact")).toEqual([{ trigger: "manual" }]);
  });

  it("says a refused call in a plain sentence with Try again, and loads once it answers", async () => {
    const page = await open("models");
    await page.evaluate(() => { (window as unknown as { __fake: Fake }).__fake.refuse.add("client:mcp.config.list"); (window as unknown as { __fake: Fake }).__fake.refuse.add("session:schedule.list"); });
    await go(page, "mcp-servers");
    const problem = body(page).locator(".cz-problem").first();
    expect(await problem.locator("p").textContent()).toBe("Copilot couldn't read that just now.");
    await page.evaluate(() => (window as unknown as { __fake: Fake }).__fake.refuse.delete("client:mcp.config.list"));
    await problem.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => body(page).getByRole("switch", { name: "issues" }).count()).toBe(1);
    await go(page, "schedules");
    expect(await body(page).locator(".cz-problem p").textContent()).toBe("Copilot couldn't read that just now.");
    expect(page.errors).toEqual([]);
  });

  it("lays out without scrolling sideways at 720 px", async () => {
    const page = await open("mcp-servers", { width: 720, height: 800 });
    for (const id of ["mcp-servers", "permissions", "plugins", "usage"]) {
      await go(page, id);
      expect(await page.evaluate(() => { const v = document.getElementById("customise-view")!; return v.scrollWidth <= v.clientWidth + 1; }), id).toBe(true);
    }
  });
});
