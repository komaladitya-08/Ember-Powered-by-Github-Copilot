/**
 * The SDK features of docs/CODING-APP.md §8 in the real app on the real bundled runtime (SDK 1.0.21, runtime 1.0.97),
 * only the model a mock: the person's defaults and a project's instructions and extra folder set in Customise ›
 * Defaults reach a new session (its modes, its system message, a file read from the extra folder); a picture the view
 * tool returns is drawn in the transcript; Customise › Session settings leaves a built-in tool out of what the model is
 * offered next; Storage lists the sessions' sizes and finds none old; a session's transcript is exported where main's
 * save dialog says; and a new session is started from Copilot's summary with it as a draft. Runs with
 * EMBER_CODE_LIVE=1 under `dbus-run-session -- xvfb-run -a` on Linux with git.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSENT_VERSION } from "../../app/shared/consent";
import type { EmberCodeApi } from "../../app/shared/code";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";

type Message = { role: string; content: unknown };
type Mock = { baseUrl: string; requests: { messages: Message[]; tools: string[] }[]; close(): Promise<void> };
const gate = process.env.EMBER_CODE_LIVE !== "1";
const requireCjs = createRequire(import.meta.url);
const call = (name: string, args: Record<string, unknown>) => `CALLTOOL:${name}${JSON.stringify(args)}`;
const step = (s: string) => { console.log(`[code-sdk-live] ${s}`); };
const text = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c ?? ""));

let dir = "", userData = "", work = "", extra = "";
let mock: Mock;

/** A 2×2 PNG. */
function png(): Buffer {
  const crc = (b: Buffer) => { const t: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const y of b) x = t[(x ^ y) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 0]))), chunk("IEND", Buffer.alloc(0))]);
}

function reply(messages: Message[], tools: string[]) {
  const lastUser = [...messages].reverse().find(m => m.role === "user");
  const words = text(lastUser?.content);
  const after = messages.slice(messages.lastIndexOf(lastUser!) + 1);
  const asked = /CALLTOOL:([A-Za-z0-9_-]+)(\{[^}]*\})?/.exec(words);
  if (asked && tools.length && after.every(m => m.role !== "tool")) return { tool: { name: asked[1], args: JSON.parse(asked[2] ?? "{}") } };
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
/** Main's folder picker answers `folder` from now on. */
const picks = (app: ElectronApplication, folder: string) => app.evaluate(({ dialog }, f) => { (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, folder);

beforeAll(async () => {
  if (gate) return;
  mock = await startMockLlm({ delayMs: 1, respond: reply });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ember-code-sdk-")));
  userData = path.join(dir, "profile");
  work = path.join(dir, "work");
  extra = path.join(dir, "extra");
  fs.mkdirSync(userData, { mode: 0o700 });
  fs.mkdirSync(work);
  fs.mkdirSync(extra);
  execFileSync("git", ["-C", work, "init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(work, "pic.png"), png());
  fs.writeFileSync(path.join(extra, "shared-note.txt"), "a note from the shared folder\n");
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    version: 1, onboarded: true, wakeWord: false, speak: false, consent: { version: CONSENT_VERSION, at: new Date().toISOString() }, code: { enabled: true },
  }));
}, 60_000);
afterAll(async () => {
  if (gate) return;
  await mock?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function say(page: Page, words: string, until = "Done. I used my tool."): Promise<void> {
  const before = await page.locator("#transcript .msg.copilot").count();
  await page.locator("#composer-text").fill(words);
  await page.locator("#composer-text").press("Enter");
  await expect.poll(async () => (await page.locator("#transcript .msg.copilot").count()) > before && (await page.locator("#transcript .msg.copilot").last().innerText()).includes(until), { timeout: 60_000 }).toBe(true);
  await expect.poll(() => page.locator("#composer-send").textContent(), { timeout: 30_000 }).toBe("Send");
}
async function customise(page: Page, section: string): Promise<void> {
  await page.locator("#side-customise").click();
  await page.locator(`.c-link[data-section="${section}"]`).click();
  await expect.poll(() => page.locator(".c-body .cz-loading").count(), { timeout: 30_000 }).toBe(0);
}
type Win = { emberCode: EmberCodeApi; __emberCode?: { app: { state: { view: { kind: string; id?: string } } } } };
const viewOf = (page: Page) => page.evaluate(() => (window as unknown as Win).__emberCode!.app.state.view);

describe.skipIf(gate)("the SDK's further features on the real runtime", () => {
  it("applies defaults, instructions and an extra folder, draws a picture, leaves a tool out, lists storage, exports and hands on", async () => {
    const app = await launch();
    try {
      await expect.poll(() => !!pageOf(app, "code"), { timeout: 30_000 }).toBe(true);
      const page = pageOf(app, "code")!;
      await page.waitForSelector("#side-list", { state: "attached" });
      const errors: string[] = [];
      page.on("pageerror", e => errors.push(e.message));
      await picks(app, work);
      await page.locator("#side-add").click();
      await expect.poll(() => page.locator("#side-list .p-name").allTextContents(), { timeout: 30_000 }).toContain("work");

      step("Customise › Defaults: everyone's modes, the project's instructions and an extra folder");
      await customise(page, "defaults");
      const all = page.locator(".cz-part").filter({ has: page.locator("h3", { hasText: "For every project" }) });
      await expect.poll(() => all.locator("select").count(), { timeout: 30_000 }).toBe(5);
      await all.locator("#cz-def-all-perm").selectOption("allow-all");
      await all.locator("#cz-def-all-agent").selectOption("interactive");
      await all.getByRole("button", { name: "Save defaults" }).click();
      await expect.poll(() => page.locator(".cz-said").textContent()).toBe("Saved. New sessions start with these.");
      await expect.poll(() => page.locator("textarea[id^='cz-instr-']").count(), { timeout: 30_000 }).toBe(1);
      await page.locator("textarea[id^='cz-instr-']").fill("EMBER-LIVE-INSTRUCTIONS: answer in British English.");
      await page.getByRole("button", { name: "Save instructions" }).click();
      await expect.poll(() => page.locator(".cz-said").textContent()).toBe("Saved. Sessions read them as they start or open again.");
      await picks(app, extra);
      await page.getByRole("button", { name: "Add folder…" }).click();
      await expect.poll(() => page.locator(".cz-row").filter({ hasText: "extra" }).count(), { timeout: 30_000 }).toBe(1);
      await page.locator(".c-head .btn").click();

      step("a new session takes them");
      await expect.poll(async () => {
        const v = await viewOf(page);
        if (v.kind === "session" && v.id) return true;
        await page.locator("#side-new").click();
        await expect.poll(() => page.locator("#start-permissions").inputValue(), { timeout: 10_000 }).toBe("allow-all");
        await page.getByRole("button", { name: "Start session" }).click();
        await page.waitForTimeout(1500);
        return false;
      }, { timeout: 90_000, interval: 500 }).toBe(true);
      const id = (await viewOf(page)).id!;
      expect(await page.evaluate(sid => (window as unknown as Win).emberCode.list().then(l => l.sessions.find(s => s.id === sid)?.permissionMode), id)).toBe("allow-all");
      await say(page, call("view", { path: path.join(extra, "shared-note.txt") }));
      const last = mock.requests.at(-1)!;
      expect(last.messages.some(m => m.role === "system" && text(m.content).includes("EMBER-LIVE-INSTRUCTIONS"))).toBe(true);
      expect(last.messages.some(m => m.role === "tool" && text(m.content).includes("a note from the shared folder"))).toBe(true);

      step("a picture from the view tool");
      await say(page, call("view", { path: path.join(work, "pic.png") }));
      await expect.poll(() => page.locator("#transcript .picture-img").count(), { timeout: 30_000 }).toBe(1);
      expect(await page.locator("#transcript .picture-img").getAttribute("src")).toBe(`data:image/png;base64,${png().toString("base64")}`);

      step("Session settings: glob left out of what the model is offered");
      expect(mock.requests.at(-1)!.tools).toContain("glob");
      await customise(page, "session-settings");
      await expect.poll(() => page.locator(".cz-check input").count(), { timeout: 30_000 }).toBeGreaterThan(3);
      await page.getByLabel(/^glob\b/).uncheck();
      await page.locator("select[id^='cz-summary-']").selectOption("concise");
      await page.locator("[id^='cz-long-']").check();
      await page.locator("input[id^='cz-credits-']").fill("500");
      await page.getByRole("button", { name: "Save session settings" }).click();
      await expect.poll(() => page.locator(".cz-said").textContent(), { timeout: 30_000 }).toBe("Saved. Copilot uses them from its next step.");
      await page.locator(".c-head .btn").click();
      // The runtime's own word of the new limit, drawn as a note.
      await expect.poll(() => page.locator("#transcript").innerText(), { timeout: 30_000 }).toContain("This session may now use up to 500 AI credits.");
      await say(page, "hello again", "Hello from the mock model.");
      expect(mock.requests.at(-1)!.tools).not.toContain("glob");
      expect(mock.requests.at(-1)!.tools).toContain("view");

      step("Storage: the sessions' sizes, and none old");
      await customise(page, "storage");
      await expect.poll(() => page.locator(".cz-part").first().locator(".cz-row").count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      await page.getByRole("button", { name: "Find old sessions" }).click();
      await expect.poll(() => page.locator(".cz-prune-found").innerText(), { timeout: 30_000 }).toBe("No sessions are that old.");
      await page.locator(".c-head .btn").click();

      step("export, then a new session from the summary");
      const out = path.join(dir, "transcript.md");
      await app.evaluate(({ dialog }, f) => { (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({ canceled: false, filePath: f }); }, out);
      const palette = async (name: string) => { await page.keyboard.press("Control+k"); await page.locator("#palette-input").fill(name); await page.keyboard.press("Enter"); };
      await palette("Export this session");
      await expect.poll(() => fs.existsSync(out), { timeout: 30_000 }).toBe(true);
      const md = fs.readFileSync(out, "utf8");
      expect(md).toContain("## You");
      expect(md).toContain("hello again");
      expect(md).toContain("> Copilot used view on");
      expect(fs.statSync(out).mode & 0o777).toBe(0o600);
      await palette("New session from this one's summary");
      await expect.poll(async () => (await viewOf(page)).id !== id, { timeout: 90_000 }).toBe(true);
      await expect.poll(() => page.locator("#composer-text").inputValue(), { timeout: 30_000 }).toContain("Carry on from this summary of an earlier session:");
      expect(errors).toEqual([]);
    } finally {
      await quit(app);
    }
  }, 600_000);
});
