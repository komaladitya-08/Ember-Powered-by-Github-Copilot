/**
 * The coding window's panel tabs and Customise in the real app, on the real bundled runtime (docs/CODING-APP.md §4, §7):
 * after a session ran a command and edited a file, Changes shows the real diff and a line comment goes back to Copilot;
 * a rewind of conversation and files puts the file back and the transcript is drawn again without what it took away;
 * Files lists the working folder through main and reads a file; Terminal runs the person's own command and shows its
 * output; Agents and tasks lists a background shell and starts a built-in agent; Plan answers Copilot's request to
 * leave plan mode from its own card; Customise › Models switches the model, Sandbox says what this computer has,
 * Permissions adds a rule that lets a matching command run unasked, and MCP servers adds a local stdio server (written
 * into the test's temporary folder) whose tool a new session lists and the model is offered. Real Electron, renderer,
 * preload, IPC, session layer and Copilot runtime; only the model is a mock server. Runs with EMBER_CODE_LIVE=1 under
 * `dbus-run-session -- xvfb-run -a` on Linux with git (and bubblewrap for the sandbox, else it runs without one).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSENT_VERSION } from "../../app/shared/consent";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";

type Message = { role: string; content: unknown };
type Mock = { baseUrl: string; requests: { messages: Message[]; tools: string[] }[]; close(): Promise<void> };
const gate = process.env.EMBER_CODE_LIVE !== "1";
const requireCjs = createRequire(import.meta.url);
const call = (name: string, args: Record<string, unknown>) => `CALLTOOL:${name}${JSON.stringify(args)}`;
const step = (s: string) => { console.log(`[code-panels-live] ${s}`); };
const text = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c ?? ""));

let dir = "", userData = "", work = "", mcpServer = "";
let mock: Mock;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
}

/** The mock model: the tool a message asks for (once, until its result comes), else a short reply. */
function reply(messages: Message[], tools: string[]) {
  const lastUser = [...messages].reverse().find(m => m.role === "user");
  const words = text(lastUser?.content);
  const after = messages.slice(messages.lastIndexOf(lastUser!) + 1);
  const asked = /CALLTOOL:([A-Za-z0-9_-]+)(\{[^}]*\})?/.exec(words);
  if (asked && tools.length && after.every(m => m.role !== "tool")) return { tool: { name: asked[1], args: JSON.parse(asked[2] ?? "{}") } };
  if (/USE-MCP/.test(words) && tools.length && after.every(m => m.role !== "tool")) {
    const shout = tools.find(t => /shout/.test(t));
    if (shout) return { tool: { name: shout, args: { words: "panels" } } };
  }
  return { text: after.some(m => m.role === "tool") ? "Done. I used my tool." : "Hello from the mock model." };
}

async function launch(): Promise<ElectronApplication> {
  return _electron.launch({
    executablePath: requireCjs("electron") as string,
    args: [process.cwd(), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
    env: { ...process.env, EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: mock.baseUrl, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
  });
}

async function quit(app: ElectronApplication): Promise<void> {
  const closed = new Promise<void>(done => app.process().once("exit", () => done()));
  await app.evaluate(({ app: electronApp }) => { electronApp.quit(); }).catch(() => undefined);
  await Promise.race([closed, new Promise(r => setTimeout(r, 20_000))]);
}

const pageOf = (app: ElectronApplication, name: string) => app.windows().find(w => w.url().includes(`/renderer/${name}/index.html`));

beforeAll(async () => {
  if (gate) return;
  mock = await startMockLlm({ delayMs: 1, respond: reply });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ember-code-panels-")));
  userData = path.join(dir, "profile");
  work = path.join(dir, "work");
  fs.mkdirSync(userData, { mode: 0o700 });
  fs.mkdirSync(path.join(work, "src"), { recursive: true });
  git(work, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(work, "notes.txt"), "first line\nsecond line\n");
  fs.writeFileSync(path.join(work, "src", "app.js"), "console.log(1);\n");
  fs.writeFileSync(path.join(work, ".gitignore"), "build/\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "init");
  fs.mkdirSync(path.join(work, "build"));
  fs.writeFileSync(path.join(work, "build", "out.js"), "built\n");
  // A tiny MCP server over stdio: one tool that shouts its words back.
  mcpServer = path.join(dir, "mcp-shout.cjs");
  fs.writeFileSync(mcpServer, [
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "const send = m => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', line => { let m; try { m = JSON.parse(line); } catch { return; } if (m.id === undefined) return;",
    "  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'shout', version: '1.0.0' } } });",
    "  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'shout', description: 'Shouts the words back.', inputSchema: { type: 'object', properties: { words: { type: 'string' } }, required: ['words'] } }] } });",
    "  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(m.params?.arguments?.words ?? '').toUpperCase() }] } });",
    "  else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } }); });",
  ].join("\n"));
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    version: 1, onboarded: true, wakeWord: false, speak: false, consent: { version: CONSENT_VERSION, at: new Date().toISOString() }, code: { enabled: true },
  }));
}, 60_000);

afterAll(async () => {
  if (gate) return;
  await mock?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Sends a message from the composer and waits for the reply's end in the transcript. */
async function say(page: Page, words: string, until = "Done. I used my tool."): Promise<void> {
  const before = await page.locator("#transcript .msg.copilot").count();
  await page.locator("#composer-text").fill(words);
  await page.locator("#composer-text").press("Enter");
  await expect.poll(async () => (await page.locator("#transcript .msg.copilot").count()) > before && (await page.locator("#transcript .msg.copilot").last().innerText()).includes(until), { timeout: 60_000 }).toBe(true);
  await expect.poll(() => page.locator("#composer-send").textContent(), { timeout: 30_000 }).toBe("Send");
}

/** A new session in the project, once Ember is connected; returns its id. */
async function newSession(page: Page, other = ""): Promise<string> {
  await expect.poll(async () => {
    const v = await page.evaluate(() => window.__emberCode!.app.state.view as { kind: string; id?: string });
    if (v.kind === "session" && v.id && v.id !== other) return true;
    await page.locator("#side-new").click();
    await page.getByRole("button", { name: "Start session" }).click();
    await page.waitForTimeout(1500);
    return false;
  }, { timeout: 90_000, interval: 500 }).toBe(true);
  return page.evaluate(() => (window.__emberCode!.app.state.view as { id: string }).id);
}

async function tab(page: Page, name: string): Promise<void> {
  if (await page.getByRole("button", { name: "Show panel" }).isVisible()) await page.getByRole("button", { name: "Show panel" }).click();
  await page.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
}

async function customise(page: Page, section: string): Promise<void> {
  await page.locator("#side-customise").click();
  const link = page.locator(`.c-link[data-section="${section}"]`);
  const label = await link.textContent();
  await link.click();
  await expect.poll(() => page.locator(".c-h").textContent()).toBe(label);
  await expect.poll(() => page.locator(".c-body .cz-loading").count(), { timeout: 30_000 }).toBe(0);
}

describe.skipIf(gate)("the coding window's panels and Customise on the real runtime", () => {
  it("shows the real diff, sends a review, rewinds files and conversation, lists and reads the folder, runs the person's command, lists tasks, answers leaving plan mode, and changes models, rules and MCP servers", async () => {
    const app = await launch();
    try {
      await expect.poll(() => !!pageOf(app, "code"), { timeout: 30_000 }).toBe(true);
      const page = pageOf(app, "code")!;
      await page.waitForSelector("#side-list", { state: "attached" });
      const errors: string[] = [];
      page.on("pageerror", e => errors.push(e.message));
      await app.evaluate(({ dialog }, f) => { (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, work);
      await page.locator("#side-add").click();
      await expect.poll(() => page.locator("#side-list .p-name").allTextContents(), { timeout: 30_000 }).toContain("work");
      const id = await newSession(page);
      await page.evaluate(sid => window.emberCode!.setPermissionMode(sid, "allow-all"), id);

      step("a command and an edit");
      await say(page, call("bash", { command: "echo made > made.txt", description: "make a file" }));
      const notes = path.join(work, "notes.txt");
      await say(page, `Change it. ${call("edit", { path: notes, old_str: "second line", new_str: "second line, changed" })}`);
      expect(fs.readFileSync(notes, "utf8")).toBe("first line\nsecond line, changed\n");

      step("Changes: the real diff, and a comment back to Copilot");
      await tab(page, "Changes");
      const heads = page.locator(".ch-file-head");
      await expect.poll(() => heads.evaluateAll(els => els.map(e => e.getAttribute("aria-label"))), { timeout: 30_000 }).toEqual(expect.arrayContaining([
        "made.txt: added, 1 line added, 0 removed", "notes.txt: changed, 1 line added, 1 removed",
      ]));
      await page.locator(".ch-file-head", { hasText: "notes.txt" }).click();
      const lines = page.locator(".ch-lines").first();
      await lines.locator(".d-add").first().click();
      await page.getByRole("button", { name: /^Comment on line \d+…$/ }).click();
      await page.keyboard.type("Say what changed in the line.");
      await page.getByRole("button", { name: "Add to review" }).click();
      await page.getByRole("button", { name: "Send to Copilot" }).click();
      await expect.poll(() => mock.requests.some(r => r.messages.some(m => m.role === "user" && text(m.content).includes("Please address my review comments") && text(m.content).includes("notes.txt") && text(m.content).includes("Say what changed in the line."))), { timeout: 60_000 }).toBe(true);
      await expect.poll(() => page.locator("#composer-send").textContent(), { timeout: 30_000 }).toBe("Send");

      step("rewind: conversation and files");
      const points = page.getByRole("button", { name: /^Rewind to before your message/ });
      await expect.poll(() => points.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
      const toEdit = page.getByRole("button", { name: /^Rewind to before your message of .*: Change it\./ });
      await toEdit.click();
      await expect.poll(() => page.locator(".rw-files li").allInnerTexts(), { timeout: 30_000 }).toEqual([expect.stringMatching(/^notes\.txt\n/)]);
      await page.getByRole("radio", { name: "Conversation and files" }).check();
      await page.getByRole("button", { name: "Rewind", exact: true }).click();
      await expect.poll(() => fs.readFileSync(notes, "utf8"), { timeout: 30_000 }).toBe("first line\nsecond line\n");
      expect(fs.readFileSync(path.join(work, "made.txt"), "utf8")).toBe("made\n");
      await expect.poll(() => page.locator("#transcript").innerText(), { timeout: 30_000 }).not.toContain("Change it.");
      expect(await page.locator("#transcript").innerText()).toContain("made.txt");
      expect(await page.locator("#transcript").innerText()).not.toContain("Please address my review comments");

      step("Files: the working folder through main");
      await tab(page, "Files");
      const tree = page.getByRole("tree", { name: "Files" });
      await expect.poll(() => tree.getByRole("treeitem").allTextContents(), { timeout: 30_000 }).toEqual([`${path.basename(dir)}/work`, "src", ".gitignore", "made.txt", "notes.txt", "Copilot's session files"]);
      // What git ignores and .git aren't listed.
      expect(await tree.getByRole("treeitem").allTextContents()).not.toEqual(expect.arrayContaining(["build"]));
      expect(await tree.getByRole("treeitem").allTextContents()).not.toEqual(expect.arrayContaining([".git"]));
      await tree.getByRole("treeitem", { name: "src", exact: true }).click();
      await tree.getByRole("treeitem", { name: "app.js" }).click();
      await expect.poll(() => page.locator(".pf-text").textContent(), { timeout: 30_000 }).toBe("console.log(1);");

      step("Terminal: the person's own command");
      await tab(page, "Terminal");
      const input = page.getByLabel("Command", { exact: true });
      await input.fill("echo terminal-marker && pwd");
      await input.press("Enter");
      const entry = page.locator(".pt-entry").last();
      await expect.poll(async () => (await entry.locator(".pt-uout").textContent())?.trim(), { timeout: 30_000 }).toBe(`terminal-marker\n${work}`);
      await expect.poll(() => entry.locator(".pt-end").textContent(), { timeout: 30_000 }).toMatch(/^Finished, exit code 0/);
      expect(await page.locator(".card.permission:not(.resolved)").count()).toBe(0);

      step("Agents and tasks: a background shell, and a built-in agent");
      await tab(page, "Agents and tasks");
      await page.locator("#composer-text").fill(call("bash", { command: "sleep 8", description: "wait in the background", mode: "async" }));
      await page.locator("#composer-text").press("Enter");
      const rows = page.locator(".pk-sec").first().locator(".pk-row .pk-title");
      await expect.poll(() => rows.allTextContents(), { timeout: 30_000 }).toContain("sleep 8");
      await expect.poll(() => page.locator("#composer-send").textContent(), { timeout: 30_000 }).toBe("Send");
      await page.locator(".pk-start > summary").click();
      await expect.poll(() => page.locator("#pk-type option").allTextContents()).toEqual(expect.arrayContaining(["General purpose", "Explore"]));
      await page.locator("#pk-type").selectOption("explore");
      await page.getByLabel("What should it do?").fill("Look around");
      await page.getByLabel("Name", { exact: true }).fill("Looker");
      await page.getByRole("button", { name: "Start agent" }).click();
      await expect.poll(() => page.locator(".pk-note").textContent(), { timeout: 30_000 }).toBe("“Looker” started.");
      await expect.poll(() => rows.allTextContents(), { timeout: 30_000 }).toContain("Looker");

      step("Plan: leaving plan mode from the tab");
      await page.evaluate(sid => window.emberCode!.setAgentMode(sid, "plan"), id);
      await page.locator("#composer-text").fill(`Plan it. ${call("exit_plan_mode", { summary: "Change the notes, then test." })}`);
      await page.locator("#composer-text").press("Enter");
      await expect.poll(() => page.getByRole("tab", { name: "Plan, needs you" }).count(), { timeout: 60_000 }).toBe(1);
      await page.getByRole("tab", { name: "Plan, needs you" }).click();
      const card = page.locator(".pl-waiting .card");
      await expect.poll(() => card.innerText(), { timeout: 30_000 }).toContain("Change the notes, then test.");
      await page.waitForTimeout(800);
      await card.getByRole("button", { name: "Start, step by step" }).click();
      await expect.poll(() => card.count(), { timeout: 30_000 }).toBe(0);
      await expect.poll(() => page.evaluate(sid => window.__emberCode!.app.state.sessions.byId[sid]?.agentMode, id), { timeout: 30_000 }).toBe("interactive");
      await expect.poll(() => page.locator("#composer-send").textContent(), { timeout: 30_000 }).toBe("Send");

      step("Customise › Models: switch");
      await customise(page, "models");
      await expect.poll(() => page.locator("#cz-model-pick").inputValue(), { timeout: 30_000 }).toBe("mock-model");
      await page.getByRole("button", { name: "Switch model" }).click();
      await expect.poll(() => page.locator(".cz-said").textContent(), { timeout: 30_000 }).toBe("The session now uses “mock-model”.");
      // With a model provider of the user's own there is no Copilot account: the list says so in Ember's words.
      expect(await page.locator(".c-body").innerText()).not.toMatch(/Not authenticated|model service/);

      step("Customise › Sandbox: this computer");
      await customise(page, "sandbox");
      const support = await page.evaluate(() => window.emberCode!.rpc({ scope: "client", method: "sandbox.getHostSupport" }));
      const caps = (support as { ok: true; value: { capabilities: { name: string; supported: boolean }[] } }).value.capabilities;
      const network = caps.find(c => c.name === "network");
      if (network) expect(await page.locator(".c-body").innerText()).toContain(`Network inside the sandbox: ${network.supported ? "yes" : "no"}`);
      expect(await page.locator(".c-body").innerText()).not.toContain("docs.github.com");

      step("Customise › Permissions: a rule that lets a command run unasked");
      await page.evaluate(sid => window.emberCode!.setPermissionMode(sid, "manual"), id);
      await customise(page, "permissions");
      await page.locator("#cz-rule").fill("Shell(echo rule-marker > rule.txt)");
      await page.getByRole("button", { name: "Add rule" }).click();
      await expect.poll(() => page.locator(".cz-said").textContent(), { timeout: 30_000 }).toBe("“shell(echo rule-marker > rule.txt)” was added.");
      await page.locator(`.s-open[data-session='${id}']`).click();
      await say(page, call("bash", { command: "echo rule-marker > rule.txt", description: "ruled" }));
      expect(fs.readFileSync(path.join(work, "rule.txt"), "utf8").trim()).toBe("rule-marker");
      // A command no rule covers still asks.
      await page.locator("#composer-text").fill(call("bash", { command: "echo unruled > other.txt", description: "unruled" }));
      await page.locator("#composer-text").press("Enter");
      const ask = page.locator("#transcript .card.permission:not(.resolved)");
      await ask.waitFor({ timeout: 60_000 });
      await ask.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      await ask.getByRole("button", { name: "Don't allow", exact: true }).click();
      await expect.poll(() => page.locator("#composer-send").textContent(), { timeout: 30_000 }).toBe("Send");
      expect(fs.existsSync(path.join(work, "other.txt"))).toBe(false);

      step("Customise › MCP servers: a local server, in a new session");
      await customise(page, "mcp-servers");
      await page.getByRole("button", { name: "Add server…" }).click();
      await page.locator("#cz-mcp-name").fill("shout");
      await page.locator("#cz-mcp-command").fill(process.execPath);
      await page.locator("#cz-mcp-args").fill(mcpServer);
      await page.getByRole("button", { name: "Add a variable" }).click();
      await page.getByLabel("Variable 1 name").fill("SHOUT_TOKEN");
      await page.getByLabel("Variable 1 value").fill("panels-secret-value");
      await page.getByRole("button", { name: "Save" }).click();
      await expect.poll(() => page.locator(".cz-said").textContent(), { timeout: 30_000 }).toBe("“shout” was added. New sessions start it.");
      // Its value was sent once and never comes back to the window.
      expect(await page.content()).not.toContain("panels-secret-value");
      const listed = await page.evaluate(() => window.emberCode!.rpc({ scope: "client", method: "mcp.config.list" }));
      expect(JSON.stringify(listed)).not.toContain("panels-secret-value");
      await page.locator(`.s-open[data-session='${id}']`).click();
      const second = await newSession(page, id);
      await page.evaluate(sid => window.emberCode!.setPermissionMode(sid, "allow-all"), second);
      await customise(page, "mcp-servers");
      const live = page.locator(".c-body .cz-part").last();
      await expect.poll(async () => {
        if (await live.getByText("What “shout” offers").count()) return true;
        await customise(page, "mcp-servers");
        return false;
      }, { timeout: 60_000, interval: 1000 }).toBe(true);
      await live.getByText("What “shout” offers").click();
      await expect.poll(() => live.getByText("shout", { exact: true }).count(), { timeout: 30_000 }).toBeGreaterThan(0);
      await expect.poll(() => live.innerText(), { timeout: 30_000 }).toContain("Shouts the words back.");
      await page.locator(`.s-open[data-session='${second}']`).click();
      await say(page, "Shout it. USE-MCP");
      expect(mock.requests.some(r => r.tools.some(t => /shout/.test(t)))).toBe(true);
      // The model was given the tool's answer, and the transcript has no raw event rows.
      expect(mock.requests.some(r => r.messages.some(m => m.role === "tool" && text(m.content).includes("PANELS")))).toBe(true);
      expect(await page.locator("#transcript").innerText()).toContain("Used “shout” from “shout”");
      expect(await page.locator("#transcript").innerText()).not.toMatch(/Event: (system\.message|session\.mcp_server_removed)/);
      expect(errors).toEqual([]);
    } finally {
      await quit(app);
    }
  }, 600_000);
});
