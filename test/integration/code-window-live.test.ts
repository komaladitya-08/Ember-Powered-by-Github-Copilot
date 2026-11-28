/**
 * The coding window end to end in the real app (docs/CODING-APP.md): with coding sessions on, Ember starts with the
 * coding window open; a person adds a project (a git repository; the folder picker answered by replacing main's dialog,
 * as the coding journeys do), starts a session in it, lets a command run from its card by the keyboard and sees its
 * output, exit code and file, turns down a file's change with a reason, quits and finds the session again with its
 * messages, starts one in a worktree, stops a turn as it runs and deletes the worktree session with its folder. Home's
 * page can't reach the coding channels, and with coding sessions off the window doesn't open. Real Electron, renderer,
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

type Mock = { baseUrl: string; requests: { messages: unknown[] }[]; close(): Promise<void> };
type Message = { role: string; content: unknown };
const gate = process.env.EMBER_CODE_LIVE !== "1";
const requireCjs = createRequire(import.meta.url);
const call = (name: string, args: Record<string, unknown>) => `CALLTOOL:${name}${JSON.stringify(args)}`;
const LONG = "LONG-TURN-MARKER";
const LINK = "LINK-MARKER";
const step = (s: string) => { console.log(`[code-live] ${s}`); };

let dir = "", userData = "", work = "";
let mock: Mock;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
}

function writeSettings(enabled: boolean): void {
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    version: 1, onboarded: true, wakeWord: false, speak: false, consent: { version: CONSENT_VERSION, at: new Date().toISOString() }, code: { enabled },
  }));
}

/** The mock model: a tool call where the prompt asks for one, a long slow reply for the Stop step, else a short one. */
function reply(messages: Message[]) {
  const lastAssistant = messages.map(m => m.role).lastIndexOf("assistant");
  const tail = messages.slice(lastAssistant + 1);
  const lastUser = [...messages].reverse().find(m => m.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
  if (text.includes(LONG) && tail.every(m => m.role !== "tool")) return { text: "word ".repeat(4000) };
  if (text.includes(LINK)) return { text: "They are [on the docs site](https://example.com/docs/page?q=secret-path)." };
  const asked = /CALLTOOL:([A-Za-z0-9_-]+)(\{[^}]*\})?/.exec(text);
  if (asked && tail.every(m => m.role !== "tool")) return { tool: { name: asked[1], args: JSON.parse(asked[2] ?? "{}") } };
  return { text: tail.some(m => m.role === "tool") ? "Done. I used my tool." : "Hello from the mock model." };
}

async function launch(extra: string[] = []): Promise<ElectronApplication> {
  return _electron.launch({
    executablePath: requireCjs("electron") as string,
    args: [process.cwd(), ...extra, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
    env: { ...process.env, EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: mock.baseUrl, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
  });
}

async function quit(app: ElectronApplication): Promise<void> {
  const closed = new Promise<void>(done => app.process().once("exit", () => done()));
  await app.evaluate(({ app: electronApp }) => { electronApp.quit(); }).catch(() => undefined);
  await Promise.race([closed, new Promise(r => setTimeout(r, 20_000))]);
}

const pageOf = (app: ElectronApplication, name: string) => app.windows().find(w => w.url().includes(`/renderer/${name}/index.html`));

async function codeWindow(app: ElectronApplication): Promise<Page> {
  await expect.poll(() => !!pageOf(app, "code"), { timeout: 30_000 }).toBe(true);
  const page = pageOf(app, "code")!;
  await page.waitForSelector("#side-list", { state: "attached" });
  return page;
}

/** Main's folder picker, answered with `folder`. */
async function pickFolder(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, folder);
}

/**
 * A coding channel invoked from another window's page: the real handler main registered, with that page's webContents
 * as the sender, as Electron's own invoke would call it. Resolves to "refused" when the handler threw.
 */
async function invokeAs(app: ElectronApplication, page: string, channel: string, ...args: unknown[]): Promise<string> {
  return app.evaluate(async ({ ipcMain, webContents }, o) => {
    const sender = webContents.getAllWebContents().find(w => w.getURL().includes(`/renderer/${o.page}/index.html`));
    if (!sender) return "no sender";
    // Electron 44 keeps each handler as it was given to handle() (checked by a probe); a different shape fails the test.
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (e: unknown, ...a: unknown[]) => unknown> })._invokeHandlers;
    const fn = handlers?.get(o.channel);
    if (!fn) return "no handler";
    try {
      const v = await fn({ sender, senderFrame: sender.mainFrame, processId: sender.getProcessId(), frameId: sender.mainFrame.routingId }, ...o.args);
      return `answered ${JSON.stringify(v)}`;
    } catch { return "refused"; }
  }, { page, channel, args });
}

/** Presses a card's button by the keyboard once the card has been in view long enough to take a press. */
async function pressOnCard(page: Page, card: ReturnType<Page["locator"]>, name: string): Promise<void> {
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await card.getByRole("button", { name, exact: true }).focus();
  await page.keyboard.press("Enter");
}

beforeAll(async () => {
  if (gate) return;
  mock = await startMockLlm({ delayMs: 2, respond: reply });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ember-code-live-")));
  userData = path.join(dir, "profile");
  work = path.join(dir, "work");
  fs.mkdirSync(userData, { mode: 0o700 });
  fs.mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(work, "notes.txt"), "first line\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "init");
}, 60_000);

afterAll(async () => {
  if (gate) return;
  await mock?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(gate)("the coding window in the real app", () => {
  let firstSession = "";

  it("adds a project, runs an allowed command, turns down a change with a reason, and keeps the session over a restart", async () => {
    writeSettings(true);
    let app = await launch();
    try {
      let page = await codeWindow(app);
      const errors: string[] = [];
      page.on("pageerror", e => errors.push(e.message));
      await pickFolder(app, work);
      await page.locator("#side-add").click();
      await expect.poll(() => page.locator("#side-list .p-name").allTextContents(), { timeout: 30_000 }).toContain("work");

      // A new session in the folder, once Ember is connected (before, main says to connect first, in place).
      step("new session");
      await expect.poll(async () => {
        if (await page.locator("#session-view").isVisible()) return true;
        await page.locator("#side-new").click();
        await page.getByRole("button", { name: "Start session" }).click();
        await page.waitForTimeout(1500);
        return page.locator("#session-view").isVisible();
      }, { timeout: 90_000, interval: 500 }).toBe(true);
      firstSession = await page.evaluate(() => (window.__emberCode!.app.state.view as { id: string }).id);
      expect(await page.locator("#session-where").textContent()).toContain("work");

      // A command: its card shows the SDK's choices and is allowed by keyboard; its output, exit code and file follow.
      step("command");
      const command = "echo live-code-marker > marker.txt && echo printed-code-marker";
      await page.locator("#composer-text").fill(call("bash", { command, description: "write a marker" }));
      await page.locator("#composer-text").press("Enter");
      const log = page.locator("#transcript");
      const card = log.locator(".card.permission");
      await card.waitFor({ timeout: 60_000 });
      const choices = await card.locator(".card-actions button").allTextContents();
      expect(choices).toContain("Allow once");
      expect(choices.at(-1)).toBe("Don't allow");
      expect(fs.existsSync(path.join(work, "marker.txt"))).toBe(false);
      await pressOnCard(page, card, "Allow once");
      await expect.poll(() => log.locator(".record").first().textContent(), { timeout: 30_000 }).toBe("Allowed once, by you.");
      const shell = log.locator(".tool.s-shell").first();
      await expect.poll(() => shell.locator(".tool-output").textContent(), { timeout: 60_000 }).toContain("printed-code-marker");
      await expect.poll(() => shell.locator(".tool-end").textContent(), { timeout: 30_000 }).toMatch(/exit code 0/);
      expect(fs.readFileSync(path.join(work, "marker.txt"), "utf8").trim()).toBe("live-code-marker");
      await expect.poll(() => log.locator(".msg.copilot").last().innerText(), { timeout: 30_000 }).toContain("Done. I used my tool.");

      // A change to a file: its card shows the diff; turned down with a reason, the file stays as it was.
      step("edit");
      const notes = path.join(work, "notes.txt");
      await page.locator("#composer-text").fill(call("edit", { path: notes, old_str: "first line", new_str: "changed line" }));
      await page.locator("#composer-text").press("Enter");
      const write = log.locator(".card.permission:not(.resolved)");
      await write.waitFor({ timeout: 60_000 });
      await expect.poll(() => write.locator(".diff").count(), { timeout: 10_000 }).toBeGreaterThan(0);
      expect(await write.locator(".diff").innerText()).toContain("changed line");
      await write.locator(".card-reason > summary").click();
      await write.locator("textarea").fill("Keep the first line as it is.");
      await pressOnCard(page, write, "Don't allow");
      await expect.poll(() => log.locator(".record").allTextContents(), { timeout: 30_000 }).toContainEqual(expect.stringMatching(/^Not allowed/));
      await expect.poll(() => log.locator(".msg.copilot").count(), { timeout: 30_000 }).toBeGreaterThan(1);
      expect(fs.readFileSync(notes, "utf8")).toBe("first line\n");
      // The reason went back to the model with the no.
      expect(JSON.stringify(mock.requests.at(-1)?.messages ?? [])).toContain("Keep the first line as it is.");
      expect(errors).toEqual([]);

      await quit(app);

      // Started again (with settings asked for, so Home opens too): the session is in the sidebar with its messages.
      app = await launch(["--show-settings"]);
      page = await codeWindow(app);
      page.on("pageerror", e => errors.push(e.message));
      const row = page.locator(`.s-open[data-session='${firstSession}']`);
      await row.waitFor({ timeout: 30_000 });
      // Everything in it happened while it was shown with the focus: nothing is unread (markRead).
      expect(await row.getAttribute("aria-label")).not.toMatch(/Unread/);
      await row.click();
      await expect.poll(() => page.locator("#transcript").innerText(), { timeout: 60_000 }).toContain("printed-code-marker");
      expect(await page.locator("#transcript").innerText()).toContain("Done. I used my tool.");

      // Nothing from another Ember window reaches the coding channels: Home's page is refused, the coding window's not.
      await expect.poll(() => !!pageOf(app, "home"), { timeout: 30_000 }).toBe(true);
      expect(await invokeAs(app, "home", "code:list")).toBe("refused");
      expect(await invokeAs(app, "home", "code:send", { sessionId: firstSession, prompt: "From Home." })).toBe("refused");
      expect(await invokeAs(app, "home", "code:open-link", "https://example.com/")).toBe("refused");
      expect(await invokeAs(app, "code", "code:list")).toMatch(/^answered /);

      // A link in a reply opens in the person's browser through main (shell.openExternal, replaced here), audited by
      // its host alone; an address with a password in it isn't opened.
      step("link");
      await app.evaluate(({ shell }) => {
        const opened: string[] = [];
        (globalThis as unknown as { __opened: string[] }).__opened = opened;
        (shell as unknown as { openExternal: unknown }).openExternal = async (url: string) => { opened.push(url); };
      });
      await page.locator("#composer-text").fill(`Where are the docs? ${LINK}`);
      await page.locator("#composer-text").press("Enter");
      const link = page.locator("#transcript a.md-link").last();
      await link.waitFor({ timeout: 60_000 });
      await link.click();
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened), { timeout: 10_000 }).toEqual(["https://example.com/docs/page?q=secret-path"]);
      expect(await page.url()).toContain("/renderer/code/index.html");
      expect(await page.evaluate(() => window.emberCode!.openLink("https://me:pw@example.com/"))).toMatchObject({ ok: false });
      expect(await page.evaluate(() => window.emberCode!.openLink("file:///etc/passwd"))).toMatchObject({ ok: false });
      const audit = fs.readdirSync(path.join(userData, "audit")).map(f => fs.readFileSync(path.join(userData, "audit", f), "utf8")).join("\n");
      expect(audit).toMatch(/"phase":"link".*"host":"example.com"/);
      expect(audit).not.toContain("secret-path");

      // A session in a new worktree: its folder and branch show.
      step("worktree");
      await page.locator("#side-new").click();
      await page.getByLabel("In a new worktree").check();
      await page.getByRole("button", { name: "Start session" }).click();
      await expect.poll(() => page.evaluate(id => { const v = window.__emberCode!.app.state.view; return v.kind === "session" && v.id !== id ? v.id : ""; }, firstSession), { timeout: 60_000 }).not.toBe("");
      const treeSession = await page.evaluate(() => (window.__emberCode!.app.state.view as { id: string }).id);
      await expect.poll(() => page.locator("#session-where").textContent(), { timeout: 10_000 }).toMatch(/worktree ember\/[a-z0-9]+/);
      const tree = path.join(userData, "code", "worktrees", treeSession);
      expect(fs.existsSync(path.join(tree, "notes.txt"))).toBe(true);
      const branch = /worktree (ember\/[a-z0-9-]+)/.exec((await page.locator("#session-where").textContent())!)![1];
      expect(git(tree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(branch);
      await expect.poll(() => page.locator(`.s-open[data-session='${treeSession}'] .s-branch`).textContent()).toBe(branch);

      // Stop while a turn runs gives the composer back.
      step("stop");
      await page.locator("#composer-text").fill(`Say a lot. ${LONG}`);
      await page.locator("#composer-text").press("Enter");
      const stop = page.locator("#composer-stop");
      await stop.waitFor({ state: "visible", timeout: 60_000 });
      await expect.poll(() => page.locator("#transcript .msg.copilot").last().innerText(), { timeout: 60_000 }).toContain("word");
      await stop.click();
      await expect.poll(() => page.locator("#composer-send").textContent(), { timeout: 30_000 }).toBe("Send");
      expect(await stop.isHidden()).toBe(true);
      // The reply ended where Stop came, well short of its 4,000 words.
      expect((await page.locator("#transcript .msg.copilot").last().innerText()).split(/\s+/).filter(w => w === "word").length).toBeLessThan(4000);
      expect(await page.locator("#composer-text").isEnabled()).toBe(true);

      // Deleted from the command palette (keeping it is the first choice): the row and the worktree's folder go.
      step("delete");
      await page.keyboard.press("Control+k");
      await page.keyboard.type("delete this session");
      await page.keyboard.press("Enter");
      await expect.poll(() => page.locator("#palette .pal-label").allTextContents()).toEqual(["Keep the session", expect.stringMatching(/^Delete “.*”, its history and its worktree$/)]);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect.poll(() => page.locator(`.s-open[data-session='${treeSession}']`).count(), { timeout: 30_000 }).toBe(0);
      expect(fs.existsSync(tree)).toBe(false);
      expect(await page.locator(`.s-open[data-session='${firstSession}']`).count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await quit(app);
    }
  }, 400_000);

  it("doesn't open the coding window with coding sessions off, and its channels refuse every page", async () => {
    writeSettings(false);
    const app = await launch(["--show-settings"]);
    try {
      await expect.poll(() => !!pageOf(app, "home"), { timeout: 30_000 }).toBe(true);
      // Started by hand: Home opens, the coding window doesn't (its preload is in the build).
      await new Promise(r => setTimeout(r, 3000));
      expect(pageOf(app, "code")).toBeUndefined();
      expect(fs.existsSync(path.resolve("dist/app/preload/code.cjs"))).toBe(true);
      expect(await invokeAs(app, "home", "code:list")).toBe("refused");
      expect(await invokeAs(app, "home", "code:create", {})).toBe("refused");
    } finally {
      await quit(app);
    }
  }, 120_000);
});
