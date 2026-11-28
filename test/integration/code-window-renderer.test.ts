/**
 * The built coding window in Chromium, as a person uses it (docs/CODING-APP.md step 2): the list, a new session from
 * the start flow, a message with Copilot's streamed reply, a command's row with its output, a write request's card with
 * exactly the SDK's choices answered by keyboard (a press before it has been in view a moment counts for nothing), the
 * model's question, leaving plan mode, queueing and steering while a turn runs, Stop, catching up after a gap and after
 * a detach, and the archived view. Only the preload boundary is replaced: window.emberCode is the scripted fake in
 * test/fixtures/code-window/fake-api.js, which plays SDK events as the runtime sends them. Nothing is read, sent or
 * kept. Runs with EMBER_UIUX_TEST=1 after `npm run build`.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { modeRefused } from "../../app/renderer/code/copy";

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

async function open(viewport = { width: 1280, height: 800 }): Promise<Page & { errors: string[] }> {
  const page = await browser.newPage({ viewport }) as Page & { errors: string[] };
  page.errors = [];
  page.on("pageerror", e => page.errors.push(e.message));
  await page.addInitScript({ path: FAKE });
  await page.goto(`http://127.0.0.1:${port}/app/renderer/code/index.html`);
  await page.waitForSelector(".s-open", { state: "attached" });
  return page;
}
const calls = (p: Page) => p.evaluate(() => window.__fake.calls);
const focusedText = (p: Page) => p.evaluate(() => document.activeElement?.textContent ?? "");

describe.skipIf(gate)("the coding window", () => {
  it("lists projects with their sessions, starts a new one in a worktree, and plays a whole session through its requests", async () => {
    const page = await open();
    // The list: pinned first, with state in words; the archived one only in the archived view.
    const rows = page.locator("#side-list .s-open");
    expect(await rows.evaluateAll(els => els.map(e => e.getAttribute("aria-label")))).toEqual([
      "Fix the login redirect. Pinned", "Upgrade the test runner, worktree ember/upgrade-vitest. Unread",
    ]);
    expect(await page.locator("#side-archived").textContent()).toBe("Archived (1)");

    // ── The start flow ──
    await page.locator("#side-new").click();
    await expect.poll(() => page.locator("#start-view").isVisible()).toBe(true);
    expect(await focusedText(page)).toBe("New session");
    await expect.poll(() => page.locator("#start-model option").allTextContents()).toEqual(["Default model", "GPT-5.5", "Claude Sonnet 5", "GPT-5.4 mini"]);
    await page.locator("#start-project").selectOption("p-app");
    await page.getByLabel("In a new worktree").check();
    await page.locator("#start-base").fill("main");
    await page.locator("#start-model").selectOption("gpt-5.5");
    expect(await page.locator("#start-effort option").allTextContents()).toEqual(["Default (Medium)", "Low", "Medium", "High", "Extra high"]);
    await page.locator("#start-effort").selectOption("high");
    await page.locator("#start-agent-mode").selectOption("interactive");
    await page.locator("#start-name").fill("Return to the page after sign-in");
    await page.getByRole("button", { name: "Start session" }).click();
    await expect.poll(() => calls(page)).toContainEqual(expect.stringMatching(/^create:/));
    const created = JSON.parse((await calls(page)).find(c => c.startsWith("create:"))!.slice(7));
    expect(created).toEqual({ projectId: "p-app", isolation: "worktree", baseBranch: "main", model: "gpt-5.5", reasoningEffort: "high", agentMode: "interactive", permissionMode: "manual", name: "Return to the page after sign-in" });
    await expect.poll(() => page.locator("#session-title").textContent()).toBe("Return to the page after sign-in");
    expect(await page.locator("#session-where").textContent()).toBe("app · worktree ember/new-session · In the sandbox");
    const sid = (await calls(page)).find(c => c.startsWith("attach:s-new"))!.slice(7);

    // ── A message, the streamed reply and a command's row ──
    await page.locator("#composer-text").fill("Make sign-in go back to the page people came from");
    await page.locator("#composer-text").press("Enter");
    expect(await calls(page)).toContain(`send:${sid}:-:Make sign-in go back to the page people came from`);
    const log = page.locator("#transcript");
    await expect.poll(() => log.locator(".msg.copilot").first().innerText()).toContain("I'll run the login tests first, then fix the handler.");
    expect(await log.locator(".msg.copilot strong").first().textContent()).toBe("fix");
    const shell = log.locator(".tool.s-shell").first();
    await expect.poll(() => shell.locator(".tool-output").textContent()).toContain("Tests  1 failed | 1 passed (2)");
    expect(await shell.locator(".tool-command").textContent()).toBe("npm test -- login");
    await expect.poll(() => shell.locator(".tool-end").textContent()).toBe("Failed, exit code 1. Ran in the sandbox.");
    expect(await log.locator("details.reasoning").evaluate(d => (d as HTMLDetailsElement).open)).toBe(false);
    await expect.poll(() => page.locator("#composer-meter").getAttribute("aria-valuetext")).toBe("38% of the context used (48,200 of 128,000 tokens)");

    // ── The write request: exactly its choices, said assertively, answered by keyboard ──
    const card = log.locator(".card.permission");
    await card.waitFor();
    expect(await card.locator(".card-actions button").allTextContents()).toEqual(["Allow once", "Allow for this session", "Don't allow"]);
    expect(await card.locator(".d-add .sr").first().textContent()).toBe("Added: ");
    expect(await card.locator(".card-assisted").textContent()).toBe("The assisted check leaves this to you. Its reason: It changes how sign-in redirects, which you didn't ask to change in this way.");
    await expect.poll(() => page.locator("#live-asks").textContent()).toBe("Copilot asks in “Return to the page after sign-in”: Change a file?");
    await expect.poll(() => page.locator("#needs-words").textContent()).toBe("Copilot is waiting for you");
    await page.locator("#needs-go").focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => focusedText(page)).toBe("Allow once");
    // A press as the card comes into view counts for nothing.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    expect((await calls(page)).some(c => c.startsWith("respond:"))).toBe(false);
    await page.waitForTimeout(600);
    await page.keyboard.press("Tab");
    expect(await focusedText(page)).toBe("Allow for this session");
    await page.keyboard.press("Enter");
    await expect.poll(() => calls(page)).toContain('respond:perm-1:{"kind":"approve-for-session"}');
    await expect.poll(() => log.locator(".record").first().textContent()).toBe("Allowed for this session, by you.");
    await expect.poll(() => page.locator("#needs-bar").isHidden()).toBe(true);
    // The edit's row shows the diff its request carried, and the sub-agent's row opens on its own work.
    await expect.poll(() => log.locator(".tool.s-edit .diff").count()).toBe(1);
    const agent = log.locator(".tool.s-agent");
    await expect.poll(() => agent.locator(".tool-end").textContent()).toBe("Finished: 1 step in 4 s.");
    await agent.locator("details.work > summary").click();
    expect(await agent.locator(".items.nested .msg.copilot").innerText()).toContain("Two places redirect after sign-in");

    // ── The model's question, answered in words ──
    const question = log.locator(".card[data-kind='user-input']");
    await question.waitFor();
    expect(await question.locator(":scope > .card-actions button").allTextContents()).toEqual(["Yes, both", "Only the login form"]);
    await question.getByLabel("Your answer").fill("Both, and add a test for each");
    await question.getByLabel("Your answer").press("Enter");
    await expect.poll(() => calls(page)).toContain('respond:ask-1:{"answer":"Both, and add a test for each","wasFreeform":true}');
    await expect.poll(() => log.getByText("Answered “Both, and add a test for each”, by you.").count()).toBe(1);

    // ── Leaving plan mode: the plan, its actions, the recommended one marked ──
    const plan = log.locator(".card[data-kind='exit-plan-mode']");
    await plan.waitFor();
    expect(await plan.locator(".card-plan li").allTextContents()).toEqual(["Read next in the login handler", "Do the same in src/oauth.ts", "Add tests for both, including one that tries another host"]);
    expect(await plan.locator(":scope > .card-actions button").allTextContents()).toEqual(["Leave plan mode only", "Start, step by step (Recommended)", "Start on Autopilot", "Keep planning"]);
    await plan.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await plan.getByRole("button", { name: "Start, step by step (Recommended)" }).click();
    await expect.poll(() => calls(page)).toContain('respond:plan-1:{"approved":true,"selectedAction":"interactive"}');
    await page.evaluate(() => window.__fake.wait("long-turn"));

    // ── While the turn runs: queue, steer, the queue's own controls, then Stop ──
    await expect.poll(() => page.locator("#composer-send").textContent()).toBe("Queue");
    await page.locator("#composer-text").fill("Also update the changelog");
    await page.locator("#composer-text").press("Enter");
    expect(await calls(page)).toContain(`send:${sid}:enqueue:Also update the changelog`);
    await expect.poll(() => page.locator("#composer-queue .q-title").textContent()).toBe("Queued (1)");
    expect(await page.locator("#composer-queue .q-text").textContent()).toBe("Also update the changelog");
    await page.locator("#composer-text").fill("Use 303 for the redirect");
    await page.getByRole("button", { name: "Steer now" }).click();
    expect(await calls(page)).toContain(`send:${sid}:immediate:Use 303 for the redirect`);
    await expect.poll(() => page.locator("#composer-queue .steering").textContent()).toBe("Steering: Use 303 for the redirect");
    await page.getByRole("button", { name: "Remove: Also update the changelog" }).click();
    await expect.poll(() => calls(page)).toContain("rpc:session:queue.removeAt");
    // A mode change the SDK didn't apply: the mode in force stays shown, with why.
    await page.locator("#pick-permissions").selectOption("allow-all");
    await expect.poll(() => page.locator("#composer-note").textContent()).toBe(modeRefused("permission", "allow-all", "manual"));
    expect(await page.locator("#pick-permissions").inputValue()).toBe("manual");
    const stop = page.locator("#composer-stop");
    expect(await stop.getAttribute("aria-label")).toBe("Stop: Return to the page after sign-in");
    await stop.click();
    expect(await calls(page)).toContain(`interrupt:${sid}`);
    await expect.poll(() => log.locator(".note.n-abort").count()).toBe(1);
    await expect.poll(() => page.locator("#composer-send").textContent()).toBe("Send");
    expect(await stop.isHidden()).toBe(true);

    // ── A gap in the envelopes: the window attaches again from its last seq and catches up ──
    const before = await page.evaluate(id => window.__emberCode!.app.state.transcripts[id].lastSeq, sid);
    await page.evaluate(id => { window.__fake.gap(); window.__fake.emit(id, "assistant.message", { messageId: "lost", content: "This one came while the window looked away." }); window.__fake.emit(id, "assistant.message", { messageId: "after", content: "And this one after it." }); }, sid);
    await expect.poll(() => calls(page)).toContain(`attach:${sid}:${before}`);
    await expect.poll(() => log.innerText()).toContain("This one came while the window looked away.");
    expect(await log.innerText()).toContain("And this one after it.");

    // ── Detached, then shown again: the whole kept history comes back ──
    await page.evaluate(id => window.__emberCode!.app.detach(id), sid);
    expect(await calls(page)).toContain(`detach:${sid}`);
    await page.locator(".s-open[data-session='s-login']").click();
    await page.locator(`.s-open[data-session='${sid}']`).click();
    await expect.poll(async () => (await calls(page)).filter(c => c === `attach:${sid}`).length).toBe(2);
    await expect.poll(() => log.innerText()).toContain("Make sign-in go back to the page people came from");
    expect(await log.innerText()).toContain("And this one after it.");
    expect(await log.locator(".card:not(.resolved)").count()).toBe(0);
    expect(page.errors).toEqual([]);
  });

  it("shows archived sessions apart and restores one, pins from the list, and opens the command palette by its key", async () => {
    const page = await open();
    await page.locator("#side-archived").click();
    await expect.poll(() => page.locator("#side-archived").textContent()).toBe("Back to sessions");
    await expect.poll(() => page.locator("#side-list .s-open").evaluateAll(els => els.map(e => e.getAttribute("aria-label")))).toEqual(["Tidy the changelog"]);
    await page.getByRole("button", { name: "Restore “Tidy the changelog”" }).click();
    await expect.poll(() => calls(page)).toContain('update:s-notes:{"archived":false}');
    await expect.poll(() => page.locator("#side-list").innerText()).toContain("No archived sessions.");
    await page.locator("#side-archived").click();
    await page.getByRole("button", { name: "Pin “Upgrade the test runner”" }).click();
    await expect.poll(() => calls(page)).toContain('update:s-vitest:{"pinned":true}');
    // Search narrows the list.
    await page.locator("#side-search").fill("vitest");
    await expect.poll(() => page.locator("#side-list .s-open").count()).toBe(1);
    await page.locator("#side-search").press("Escape");
    // The palette: every action by name, run by the keyboard.
    await page.keyboard.press("Control+k");
    await expect.poll(() => page.locator("#palette").evaluate(d => (d as HTMLDialogElement).open)).toBe(true);
    await page.keyboard.type("customise");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("#customise-view").isVisible()).toBe(true);
    expect(await page.locator(".c-nav .c-link").allTextContents()).toEqual(["Models", "MCP servers", "Skills", "Plugins", "Agents", "Instructions", "Hooks", "Permissions", "Sandbox", "Schedules", "Usage", "Defaults", "Session settings", "Storage", "Companion"]);
    // The panel's tabs, with their empty states, moved between with the arrow keys.
    await page.getByRole("button", { name: "Show panel" }).click();
    await expect.poll(() => page.getByRole("tab").allTextContents()).toEqual(["Changes", "Plan", "Files", "Terminal", "Agents and tasks"]);
    await page.getByRole("tab", { name: "Changes" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => page.getByRole("tab", { name: "Plan" }).getAttribute("aria-selected")).toBe("true");
    expect(page.errors).toEqual([]);
  });

  it("removes a project after asking, and says main's sentence while it still has sessions", async () => {
    const page = await open();
    // A project with sessions: asked, then main's refusal in the sidebar's note, and the project stays.
    await page.getByRole("button", { name: "Remove “app” from the list…" }).click();
    const ask = page.getByRole("group", { name: "Remove “app” from the list? Its folder and files stay as they are." });
    await ask.waitFor();
    expect(await focusedText(page)).toBe("Cancel");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Remove “app” from the list…");
    await page.keyboard.press("Enter");
    await ask.getByRole("button", { name: "Remove" }).click();
    await expect.poll(() => page.locator("#side-note").textContent()).toBe("This project still has sessions. Delete them first, then remove the project.");
    expect(await calls(page)).toContain("removeProject:p-app");
    expect(await page.locator(".p-name").allTextContents()).toContain("app");
    // One with none: gone from the list.
    await page.getByRole("button", { name: "Add project…" }).click();
    await page.getByRole("button", { name: "Remove “site” from the list…" }).click();
    await page.getByRole("group", { name: /Remove “site”/ }).getByRole("button", { name: "Remove" }).click();
    await expect.poll(() => page.locator(".p-name").allTextContents()).not.toContain("site");
    expect(await page.locator("#side-note").textContent()).toBe("");
    expect(page.errors).toEqual([]);
  });

  it("fits from 720 px wide, and is a drawer and a single column at 480 px", async () => {
    for (const width of [720, 480]) {
      const page = await open({ width, height: 700 });
      if (width === 480) {
        expect(await page.locator("#sidebar").isVisible()).toBe(false);
        await page.getByRole("button", { name: "Sessions" }).click();
      }
      await page.locator(".s-open[data-session='s-login']").click();
      await page.locator("#composer-text").waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await page.locator("#transcript").evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      expect(page.errors).toEqual([]);
      await page.close();
    }
  });
});
