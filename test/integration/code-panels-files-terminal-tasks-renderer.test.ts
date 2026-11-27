/**
 * The coding window's Files, Terminal and Agents and tasks tabs in Chromium, as a person uses them (docs/CODING-APP.md
 * §4): the file tree by keyboard with its change marks, the viewer (text with line numbers, a binary file named and not
 * shown, Copilot's own session files), the filter with the composer's completions, "Attach to message" into the
 * composer; Copilot's commands with their live output, Stop and "Show in transcript", and the person's own command
 * line with its history, colours mapped, and Cancel; background tasks with their count on the tab, a message,
 * cancel, remove, starting an agent, Fleet…, this turn's sub-agents and stopping a schedule. Only the preload boundary
 * is replaced: window.emberCode is test/fixtures/code-window/fake-api.js. Runs with EMBER_UIUX_TEST=1 after
 * `npm run build`.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

declare global {
  interface Window {
    __fake: { calls: string[]; gap(): void; emit(sid: string, type: string, data: unknown, extra?: Record<string, unknown>): void; wait(name: string): Promise<void> };
  }
}

const gate = process.env.EMBER_UIUX_TEST !== "1";
const FAKE = path.resolve("test/fixtures/code-window/fake-api.js");

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

/** The window with the pinned session open and the panel on `tab`. */
async function open(tab: string, viewport = { width: 1280, height: 900 }): Promise<Page & { errors: string[] }> {
  const page = await browser.newPage({ viewport }) as Page & { errors: string[] };
  page.errors = [];
  page.on("pageerror", e => page.errors.push(e.message));
  await page.addInitScript({ path: FAKE });
  await page.goto(`http://127.0.0.1:${port}/app/renderer/code/index.html`);
  await page.waitForSelector(".s-open", { state: "attached" });
  await page.locator(".s-open[data-session='s-login']").click();
  await page.locator("#composer-text").waitFor();
  await page.getByRole("button", { name: "Show panel" }).click();
  await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
  return page;
}
const calls = (p: Page) => p.evaluate(() => window.__fake.calls);
const emit = (p: Page, type: string, data: unknown, extra: Record<string, unknown> = {}) => p.evaluate(([t, d, x]) => window.__fake.emit("s-login", t as string, d, x as Record<string, unknown>), [type, data, extra] as const);
const focused = (p: Page) => p.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "");

describe.skipIf(gate)("the coding window's panel tabs", () => {
  it("Files: walks the tree by keyboard, marks changes, shows text with line numbers, names a binary file, filters and attaches", async () => {
    const page = await open("Files");
    const tree = page.getByRole("tree", { name: "Files" });
    await expect.poll(() => tree.getByRole("treeitem").allTextContents()).toEqual(["work/app", "assets", "logo.png", "docs", "old.md", "src", "login.ts", "Copilot's session files", "paste-1.txt", "plan.md", "shot.png"]);
    expect(await calls(page)).toEqual(expect.arrayContaining(["rpc:session:workspaces.diff", "rpc:session:workspaces.listFiles"]));
    // Marks: in words for a screen reader, a symbol on screen; a file outside the folder is never listed.
    expect(await tree.getByRole("treeitem", { name: "login.ts, changed" }).getAttribute("data-change")).toBe("modified");
    expect(await tree.getByRole("treeitem", { name: "logo.png, added" }).count()).toBe(1);
    expect(await tree.getByRole("treeitem", { name: "old.md, deleted" }).count()).toBe(1);
    expect(await tree.getByRole("treeitem", { name: "src, has changes" }).getAttribute("aria-expanded")).toBe("true");
    expect(await tree.innerText()).not.toContain("outside.txt");

    // The keyboard: one row in the tab order, arrows move, left closes a folder and right opens it, Enter opens a file.
    expect(await tree.locator("[tabindex='0']").count()).toBe(1);
    await tree.locator("[tabindex='0']").focus();
    expect(await focused(page)).toBe("work/app");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toBe("src, has changes");
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => tree.getByRole("treeitem", { name: "src, has changes" }).getAttribute("aria-expanded")).toBe("false");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await focused(page)).toBe("login.ts, changed");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator(".pf-text").textContent()).toContain("export async function signIn(req, res) {");
    expect(await tree.getByRole("treeitem", { name: "login.ts, changed" }).getAttribute("aria-selected")).toBe("true");
    expect((await page.locator(".pf-nos").textContent())!.split("\n")).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(await page.locator(".pf-nos").getAttribute("aria-hidden")).toBe("true");
    expect(await page.locator(".pf-vfacts").textContent()).toBe("9 lines.");
    expect(await calls(page)).toContain("rpc:session:workspaces.diff");

    // A binary file is named and never shown; a deleted one says so; Copilot's own file is read through readFile.
    await tree.getByRole("treeitem", { name: "logo.png, added" }).click();
    await expect.poll(() => page.locator(".pf-vwords").textContent()).toBe("This file isn't text, so it isn't shown.");
    expect(await page.locator(".pf-lines").isHidden()).toBe(true);
    await tree.getByRole("treeitem", { name: "old.md, deleted" }).click();
    await expect.poll(() => page.locator(".pf-vwords").textContent()).toBe("Copilot deleted this file in this session.");
    await tree.getByRole("treeitem", { name: "plan.md" }).click();
    await expect.poll(() => page.locator(".pf-text").textContent()).toBe("# Plan\n\n1. Read next\n2. Test it");
    expect(await calls(page)).toEqual(expect.arrayContaining(["rpc:session:workspaces.statFile", "rpc:session:workspaces.readFile"]));
    expect(await page.getByRole("button", { name: "Attach “plan.md” to the message" }).isDisabled()).toBe(true);
    await tree.getByRole("treeitem", { name: "shot.png" }).click();
    await expect.poll(() => page.locator(".pf-vwords").textContent()).toBe("This file isn't text, so it isn't shown.");

    // The filter narrows the tree and asks the composer's completions for more of the working folder.
    await page.getByLabel("Filter files").fill("oauth");
    await expect.poll(() => calls(page)).toContain("rpc:session:completions.request");
    await expect.poll(() => tree.getByRole("treeitem").allTextContents()).toEqual(["work/app", "src", "oauth.ts", "Copilot's session files"]);
    expect(await page.locator(".pf-none").textContent()).toBe("Nothing here matches “oauth”.");
    await page.getByLabel("Filter files").press("ArrowDown");
    expect(await focused(page)).toBe("oauth.ts");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator(".pf-vwords").textContent()).toBe("Ember can show a working-folder file only once this session has changed it. You can still attach it to a message.");

    // Attach to message: the composer gets it as its picker's results, and the message carries it.
    await page.evaluate(() => {
      const api = window.emberCode!;
      const send = api.send.bind(api);
      (window as unknown as { __sent: unknown[] }).__sent = [];
      api.send = m => { (window as unknown as { __sent: unknown[] }).__sent.push(m); return send(m); };
    });
    await page.getByRole("button", { name: "Attach “oauth.ts” to the message" }).click();
    await expect.poll(() => page.locator("#composer-chips .chip-name").allTextContents()).toEqual(["oauth.ts"]);
    expect(await page.locator(".pf-note").textContent()).toBe("“oauth.ts” will go with your next message.");
    await page.locator("#composer-text").fill("Look at this one");
    await page.locator("#composer-text").press("Enter");
    await expect.poll(() => calls(page)).toContain("send:s-login:-:Look at this one:+1");
    // The path is the listed one under the session's folder, as main will check it.
    const sent = await page.evaluate(() => (window as unknown as { __sent: { attachments?: unknown[] }[] }).__sent.at(-1)?.attachments);
    expect(sent).toEqual([{ type: "file", path: "/home/me/work/app/src/oauth.ts", displayName: "oauth.ts" }]);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it("Terminal: shows Copilot's commands with live output, Stop and Show in transcript; runs the person's commands with history and Cancel", async () => {
    const page = await open("Terminal");
    expect(await page.locator(".pt-agent .pt-empty").textContent()).toBe("Copilot hasn't run a command in this session yet.");
    expect(await page.locator(".pt-user .pt-empty").textContent()).toContain("it isn't a full terminal");
    expect(await page.locator(".pt-where").textContent()).toBe("Runs in work/app. In the sandbox.");

    // A command of Copilot's: running first, its output as it streams, Stop for its background task.
    await emit(page, "tool.execution_start", { toolCallId: "w1", toolName: "bash", arguments: { command: "npm test -- --watch" }, shellToolInfo: { displayCommand: "npm test -- --watch", hasWriteFileRedirection: false, possiblePaths: [] } });
    await emit(page, "tool.shell_output", { toolCallId: "w1", text: "\u001b[32mPASS\u001b[0m test/login.test.ts\n", stream: "stdout", sequence: 0 }, { ephemeral: true });
    const running = page.locator(".pt-running .pt-cmd");
    await expect.poll(() => running.locator(".pt-out").textContent()).toBe("PASS test/login.test.ts\n");
    expect(await running.locator(".ansi.t-green").textContent()).toBe("PASS");
    expect(await page.locator(".pt-running .pt-sub").textContent()).toBe("Running now");
    const stop = running.getByRole("button", { name: "Stop “npm test -- --watch”" });
    await stop.waitFor();
    await stop.click();
    await expect.poll(() => calls(page)).toContain("rpc:session:tasks.cancel");
    await emit(page, "tool.shell_output", { toolCallId: "w1", text: "Waiting for file changes…\n", stream: "stdout", sequence: 1 }, { ephemeral: true });
    await expect.poll(() => running.locator(".pt-out").textContent()).toContain("Waiting for file changes…");
    await emit(page, "tool.execution_complete", { toolCallId: "w1", success: false, shellExecution: { exitCode: 130 }, sandboxed: true });
    await expect.poll(() => page.locator(".pt-running").count().then(async () => page.locator(".pt-running .pt-cmd").count())).toBe(0);
    const row = page.locator(".pt-agent > .pt-list .pt-cmd", { hasText: "npm test -- --watch" });
    expect(await row.locator(".pt-end").textContent()).toMatch(/^Failed, exit code 130, in \d+ s\. In the sandbox\.$/);
    // A command with no task to cancel offers to stop the turn, in those words.
    await emit(page, "tool.execution_start", { toolCallId: "w2", toolName: "bash", arguments: { command: "make" } });
    await expect.poll(() => page.locator(".pt-running").getByRole("button", { name: "Stop the turn" }).count()).toBe(1);
    await emit(page, "tool.execution_complete", { toolCallId: "w2", success: true, shellExecution: { exitCode: 0 } });
    // Show in transcript: the transcript's row gets focus.
    await row.getByRole("button", { name: "Show “npm test -- --watch” in the transcript" }).click();
    expect(await page.evaluate(() => document.activeElement?.closest("#transcript li")?.textContent ?? "")).toContain("npm test -- --watch");

    // The person's own command: output with colours mapped and escapes dropped, its end said once, no permission card.
    const input = page.getByLabel("Command", { exact: true });
    await input.fill("git status");
    await input.press("Enter");
    await expect.poll(() => calls(page)).toContain("rpc:session:shell.executeUserRequested");
    const entry = page.locator(".pt-entry").last();
    await expect.poll(() => entry.locator(".pt-end").textContent()).toMatch(/^Finished, exit code 0/);
    expect(await entry.locator(".pt-uout").textContent()).toBe("On branch main\nmodified:   src/login.ts\nnew file:   assets/logo.png\n");
    expect(await entry.locator(".ansi.t-red").textContent()).toBe("modified:   src/login.ts");
    expect(await page.locator(".pt-user [role='status']").textContent()).toBe("Your command finished, exit code 0.");
    expect(await page.locator(".card.permission").count()).toBe(0);
    // It is the person's, so it isn't listed as Copilot's.
    expect(await page.locator(".pt-agent .pt-code").allTextContents()).toEqual(["npm test -- --watch", "make"]);

    // History: Up brings it back, Down returns to what was being written.
    await input.fill("ls -");
    await input.press("ArrowUp");
    expect(await input.inputValue()).toBe("git status");
    await input.press("ArrowDown");
    expect(await input.inputValue()).toBe("ls -");

    // A long command: running, then Cancel.
    await input.fill("sleep 30");
    await input.press("Enter");
    await expect.poll(() => page.locator(".pt-busy").textContent()).toBe("Running “sleep 30”…");
    await expect.poll(() => page.locator(".pt-entry").last().locator(".pt-uout").textContent()).toBe("waiting…\n");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(() => calls(page)).toContain("rpc:session:shell.cancelUserRequested");
    await expect.poll(() => page.locator(".pt-entry").last().locator(".pt-end").textContent()).toMatch(/^Cancelled/);
    expect(await page.locator(".pt-busy").isHidden()).toBe(true);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it("Agents and tasks: counts what runs on the tab, and messages, cancels, removes, starts agents, a fleet and stops schedules", async () => {
    const page = await open("Agents and tasks");
    const tab = page.getByRole("tab", { name: /^Agents and tasks/ });
    await expect.poll(() => tab.getAttribute("aria-label")).toBe("Agents and tasks, 2 running");
    expect(await tab.locator(".tab-badge").textContent()).toBe("2");
    const rows = page.locator(".pk-sec").first().locator(".pk-row");
    // Running first (the latest first), then the finished ones.
    await expect.poll(() => rows.locator(".pk-title").allTextContents()).toEqual(["npm test -- --watch", "Check the OAuth flow", "Read the docs"]);
    const agent = rows.nth(1);
    expect(await agent.locator(".pk-state").textContent()).toBe("Running");
    expect(await agent.locator(".pk-facts").textContent()).toMatch(/^Agent: explore · gpt-5\.4-mini · 2 min \d+ s$/);
    expect(await agent.locator(".pk-doing").textContent()).toBe("Reading the OAuth callback");
    expect(await rows.first().locator(".pk-doing").textContent()).toBe("Waiting for file changes…");

    // A message to the agent, by keyboard.
    await agent.getByRole("button", { name: "Send “Check the OAuth flow” a message" }).click();
    const field = page.getByLabel("Message for “Check the OAuth flow”");
    await expect.poll(() => focused(page)).toBe("Message for “Check the OAuth flow”");
    await field.fill("Also check the logout redirect");
    await field.press("Enter");
    await expect.poll(() => calls(page)).toContain("rpc:session:tasks.sendMessage");
    await expect.poll(() => page.locator(".pk-note").textContent()).toBe("Sent to “Check the OAuth flow”.");
    // Cancel and Remove, as the SDK offers them.
    await agent.getByRole("button", { name: "Cancel “Check the OAuth flow”" }).click();
    await expect.poll(() => calls(page)).toContain("rpc:session:tasks.cancel");
    await rows.last().getByRole("button", { name: "Remove “Read the docs”" }).click();
    await expect.poll(() => rows.locator(".pk-title").allTextContents()).toEqual(["npm test -- --watch", "Check the OAuth flow"]);

    // A sub-agent of this turn, with its row in the transcript.
    await emit(page, "user.message", { content: "Look around" });
    await emit(page, "tool.execution_start", { toolCallId: "t-9", toolName: "task", arguments: { agent_type: "explore" } });
    await emit(page, "subagent.started", { toolCallId: "t-9", agentName: "explore", agentDisplayName: "Explore", agentDescription: "Find the redirects", model: "gpt-5.4-mini" }, { agentId: "sub-9" });
    const subs = page.locator(".pk-sec").nth(1).locator(".pk-row");
    await expect.poll(() => subs.locator(".pk-title").allTextContents()).toEqual(["Explore"]);
    await expect.poll(() => tab.getAttribute("aria-label")).toBe("Agents and tasks, 3 running");
    await subs.getByRole("button", { name: "Show “Explore” in the transcript" }).click();
    expect(await page.evaluate(() => document.activeElement?.closest("#transcript li")?.textContent ?? "")).toContain("Explore");

    // Start an agent: its types from agent.list (one a person can't choose is left out), a prompt and a name.
    await page.locator(".pk-start > summary").click();
    await expect.poll(() => page.locator("#pk-type option").allTextContents()).toEqual(["Explore", "Task"]);
    await page.getByLabel("What should it do?").fill("Write tests for the redirect");
    await page.getByRole("button", { name: "Start agent" }).click();
    await expect.poll(() => page.locator(".pk-note").textContent()).toBe("Give it a name first.");
    await page.getByLabel("Name", { exact: true }).fill("Redirect tests");
    await page.getByRole("button", { name: "Start agent" }).click();
    await expect.poll(() => page.locator(".pk-note").textContent()).toBe("“Redirect tests” started.");
    await expect.poll(() => rows.locator(".pk-title").allTextContents()).toContain("Redirect tests");

    // Fleet…, with a prompt.
    const fleet = page.getByRole("button", { name: "Fleet…" });
    await fleet.click();
    expect(await fleet.getAttribute("aria-expanded")).toBe("true");
    await page.getByLabel("What should the fleet do?").fill("Fix every redirect");
    await page.getByRole("button", { name: "Start fleet" }).click();
    await expect.poll(() => page.locator(".pk-note").textContent()).toBe("The fleet started.");
    expect(await calls(page)).toContain("rpc:session:fleet.start");

    // Schedules: listed with when they run, stopped by their number.
    const sched = page.locator(".pk-sec").last().locator(".pk-row");
    expect(await sched.locator(".pk-facts").textContent()).toMatch(/^Every 10 min, next at /);
    await sched.getByRole("button", { name: "Stop the schedule “Check CI”" }).click();
    await expect.poll(() => page.locator(".pk-sec").last().locator(".pk-empty").textContent()).toBe("No prompts are scheduled.");
    expect(page.errors).toEqual([]);
  }, 60_000);

  it("fits the panel at its narrowest in a 720 px window, with nothing scrolling sideways", async () => {
    const page = await open("Files", { width: 720, height: 700 });
    await page.evaluate(() => window.__emberCode!.app.setUi({ panelWidth: 260 }));
    for (const tab of ["Files", "Terminal", "Agents and tasks"]) {
      await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
      await page.waitForTimeout(300);
      expect(await page.locator("#panel-body").evaluate(e => e.scrollWidth <= e.clientWidth + 1), tab).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(page.errors).toEqual([]);
  }, 60_000);
});
