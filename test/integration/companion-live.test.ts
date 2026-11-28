/**
 * The companion as an option, end to end in the real app (docs/CODING-APP.md §5). With the companion off and coding
 * sessions on, Ember opens the coding window and nothing of the companion: no overlay, no handle, no conversation, and
 * Stop still works. With both on, the conductor (the mock model scripted to call its tools) starts a coding session in a
 * project the user added and lists the sessions: the session shows in the coding window, started by "companion", and
 * the audit log records the companion's commands. Real Electron, renderer, preload, IPC, session layer and Copilot
 * runtime; only the model is a mock server. Runs with EMBER_CODE_LIVE=1 under `dbus-run-session -- xvfb-run -a` on
 * Linux with git, after `npm run build`.
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
const step = (s: string) => { console.log(`[companion-live] ${s}`); };

let dir = "", userData = "", work = "";
let mock: Mock;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
}

function writeSettings(companion: boolean): void {
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    version: 1, onboarded: true, wakeWord: false, speak: false, consent: { version: CONSENT_VERSION, at: new Date().toISOString() },
    code: { enabled: true }, companion: { enabled: companion },
  }));
}

/** The mock model: the tool a request names (CALLTOOL:name{args}), once; else a short reply. */
function reply(messages: Message[]) {
  const lastAssistant = messages.map(m => m.role).lastIndexOf("assistant");
  const tail = messages.slice(lastAssistant + 1);
  const lastUser = [...messages].reverse().find(m => m.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
  const asked = /CALLTOOL:([A-Za-z0-9_-]+)(\{[^}]*\})?/.exec(text.replace(/\\"/g, "\""));
  if (asked && tail.every(m => m.role !== "tool")) return { tool: { name: asked[1], args: JSON.parse(asked[2] ?? "{}") } };
  return { text: tail.some(m => m.role === "tool") ? "Done. I used my tool." : "Hello from the mock model." };
}

async function launch(): Promise<ElectronApplication> {
  return _electron.launch({
    executablePath: requireCjs("electron") as string,
    args: [process.cwd(), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
    env: { ...process.env, EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: mock.baseUrl, EMBER_TEST_HOOKS: "1", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
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

/** Every audit entry written so far. */
function auditEntries(): Record<string, unknown>[] {
  const folder = path.join(userData, "audit");
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).flatMap(f => fs.readFileSync(path.join(folder, f), "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } }));
}

beforeAll(async () => {
  if (gate) return;
  mock = await startMockLlm({ delayMs: 2, respond: reply });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ember-companion-live-")));
  userData = path.join(dir, "profile");
  work = path.join(dir, "app");
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

describe.skipIf(gate)("the companion as an option in the real app", () => {
  it("with the companion off opens the coding window and nothing of the companion, and Stop still works", async () => {
    writeSettings(false);
    const app = await launch();
    try {
      const page = await codeWindow(app);
      await page.waitForTimeout(4000);
      step("no overlay or handle");
      expect(pageOf(app, "overlay")).toBeUndefined();
      expect(pageOf(app, "handle")).toBeUndefined();
      // No conversation: a request goes nowhere (the host has no conductor session).
      const sessionId = await app.evaluate(() => {
        const e = (globalThis as unknown as { __ember: { agent(): { conductor: { sessionId: string | null } | null } | null } }).__ember;
        return e.agent()?.conductor?.sessionId ?? null;
      });
      expect(sessionId).toBeNull();
      step("Stop everything");
      const before = auditEntries().length;
      await app.evaluate(() => { (globalThis as unknown as { __ember: { stopEverything(s: string): void } }).__ember.stopEverything("hotkey"); });
      await expect.poll(() => auditEntries().slice(before).some(e => e.event === "stop"), { timeout: 10_000 }).toBe(true);
    } finally {
      await quit(app);
    }
  }, 120_000);

  it("with both on, the companion starts a coding session in a known project and lists the sessions, audited as the companion", async () => {
    writeSettings(true);
    const app = await launch();
    try {
      const page = await codeWindow(app);
      await expect.poll(() => !!pageOf(app, "handle"), { timeout: 30_000 }).toBe(true);
      await app.evaluate(({ dialog }, f) => {
        (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
      }, work);
      await page.locator("#side-add").click();
      await expect.poll(() => page.locator("#side-list .p-name").allTextContents(), { timeout: 30_000 }).toContain("app");

      const ask = (text: string) => app.evaluate((_e, t) => (globalThis as unknown as { __ember: { ask(t: string): Promise<unknown> } }).__ember.ask(t), text);
      step("start_coding_session");
      await expect.poll(async () => {
        const phase = await app.evaluate(() => (globalThis as unknown as { __ember: { agent(): { getStatus(): { phase: string } } | null } }).__ember.agent()?.getStatus().phase ?? "none");
        return phase;
      }, { timeout: 90_000 }).toBe("ready");
      await ask(`Please start a coding session in app. CALLTOOL:start_coding_session${JSON.stringify({ project: "app", request: "Say hello from the companion" })}`);
      await expect.poll(() => page.evaluate(() => Object.values(window.__emberCode!.app.state.sessions.byId).map(s => s.createdBy)), { timeout: 60_000 }).toContain("companion");
      await expect.poll(() => auditEntries().some(e => e.event === "code" && e.phase === "start" && e.by === "companion"), { timeout: 10_000 }).toBe(true);

      step("list_coding_sessions");
      await ask("Which coding sessions do I have? CALLTOOL:list_coding_sessions{}");
      await expect.poll(() => JSON.stringify(mock.requests.map(r => r.messages)).includes("coding_sessions untrusted"), { timeout: 60_000 }).toBe(true);
      const companion = auditEntries().filter(e => e.event === "code" && e.phase === "companion").map(e => e.command);
      expect(companion).toEqual(expect.arrayContaining(["list", "create", "send"]));
    } finally {
      await quit(app);
    }
  }, 240_000);
});
