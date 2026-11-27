/**
 * Built Home in Chromium, its Chats pane as a person uses it: the switch in Projects wakes it, a new chat streams
 * Copilot's words, a command's row shows its output, a write request's card offers exactly the SDK's choices (armed
 * once it has been in view, answered by keyboard alone), becomes a record of who decided, a refused mode change is
 * explained, and Stop ends the turn. Only the preload boundary is replaced (window.ember and a scripted
 * window.emberChat); nothing is read, sent or kept. With EMBER_UI_EVIDENCE set it also saves screenshots for the
 * render check. Runs with EMBER_UIUX_TEST=1 (CI's checks job).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import { CHAT_NATIVE_HINT, CHAT_NATIVE_LABEL, CHAT_NATIVE_LOCKED, chatModeRefused } from "../../app/renderer/home/copy";

declare global {
  interface Window {
    __chat: { calls: string[]; emit(e: Record<string, unknown>): void; settings(patch: Record<string, unknown>): void };
  }
}

const gate = process.env.EMBER_UIUX_TEST !== "1";

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

const DIFF = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -10,4 +10,4 @@ export function start() {\n   const port = 8080;\n-  listen(port);\n+  listen(port, \"127.0.0.1\");\n   return port;\n }\n";

interface Seed { native?: boolean; admin?: Record<string, unknown>; viewport?: { width: number; height: number }; scale?: number }

/** Home after first run, on Projects, with a scripted chat runtime behind window.emberChat. */
async function open(seed: Seed = {}): Promise<Page & { errors: string[] }> {
  const settings = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
  settings.onboarded = true;
  settings.consent = { version: 99, at: "2026-11-27T12:00:00Z" };
  settings.chat = { native: seed.native ?? false };
  const admin = { source: null, error: null, managed: [], features: {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [], ...seed.admin };
  const page = await browser.newPage({ viewport: seed.viewport ?? { width: 1000, height: 900 }, deviceScaleFactor: seed.scale ?? 1 }) as Page & { errors: string[] };
  page.errors = [];
  page.on("pageerror", e => page.errors.push(e.message));
  await page.addInitScript(({ settings, admin, diff }) => {
    const subs: Record<string, ((v: unknown) => void)[]> = {};
    let chatListener: ((e: unknown) => void) | null = null;
    const calls: string[] = [];
    const emit = (e: Record<string, unknown>) => chatListener?.({ session: "ember-chat-1", ...e });
    const later = (ms: number, fn: () => void) => setTimeout(fn, ms);
    let current = settings as Record<string, unknown>;
    window.__chat = {
      calls, emit,
      settings: patch => { current = { ...current, ...patch }; for (const fn of subs.onSettingsChanged ?? []) fn(current); },
    };
    const row = { id: "ember-chat-1", name: "", folder: "/home/me/work/app", permissionMode: "manual", agentMode: "interactive", busy: false, pending: 0, open: true };
    const kept = { id: "ember-chat-kept", name: "Tidy the changelog", folder: "/home/me/notes", permissionMode: "manual", agentMode: "interactive", busy: false, pending: 0, open: false };
    let made = false;
    (window as unknown as { emberChat: unknown }).emberChat = {
      list: async () => { calls.push("list"); return { ok: true, value: made ? [{ ...row }, kept] : [kept] }; },
      create: async () => { calls.push("create"); made = true; return { ok: true, value: { ...row } }; },
      resume: async (id: string) => { calls.push(`resume:${id}`); return { ok: true, value: { ...kept, open: true } }; },
      send: async (id: string, text: string) => {
        calls.push(`send:${id}:${text}`);
        later(20, () => emit({ type: "reasoning-delta", reasoningId: "r1", text: "The port is fixed; listen on loopback only." }));
        later(40, () => emit({ type: "text-delta", messageId: "m1", text: "I'll run the build " }));
        later(80, () => emit({ type: "text-delta", messageId: "m1", text: "and then fix the listener." }));
        later(120, () => emit({ type: "message", messageId: "m1", text: "I'll run the build and then fix the listener." }));
        later(140, () => emit({ type: "tool-start", toolCallId: "t1", tool: "bash", args: JSON.stringify({ command: "npm run build", description: "build" }) }));
        later(160, () => emit({ type: "tool-output", toolCallId: "t1", text: "> app@1.0.0 build\n> tsc -p .\n" }));
        later(180, () => emit({ type: "tool-output", toolCallId: "t1", text: "build ok in 2.1 s\n" }));
        later(200, () => emit({ type: "tool-complete", toolCallId: "t1", tool: "bash", success: true, exitCode: 0, fileEdits: [], approvedBy: "user" }));
        later(240, () => emit({ type: "permission-requested", requestId: "p1", toolCallId: "t2", request: { kind: "write", file: "/home/me/work/app/src/app.ts", intention: "Listen on loopback only", diff }, managed: false, choices: ["approve-once", "approve-for-session", "reject"], truncated: false }));
        return { ok: true, value: undefined };
      },
      decide: async (id: string, requestId: string, decision: { kind: string; feedback?: string }) => {
        calls.push(`decide:${id}:${requestId}:${decision.kind}${decision.feedback ? `:${decision.feedback}` : ""}`);
        const ok = decision.kind !== "reject";
        later(10, () => emit({ type: "permission-resolved", requestId, kind: "write", decision: ok ? (decision.kind === "approve-for-session" ? "approved-for-session" : "approved") : "denied-interactively-by-user", by: "user" }));
        if (ok) {
          later(20, () => emit({ type: "tool-start", toolCallId: "t2", tool: "edit", args: JSON.stringify({ path: "/home/me/work/app/src/app.ts" }) }));
          later(40, () => emit({ type: "tool-complete", toolCallId: "t2", tool: "edit", success: true, fileEdits: [{ path: "/home/me/work/app/src/app.ts", kind: "modify" }], approvedBy: "user" }));
          later(60, () => emit({ type: "text-delta", messageId: "m2", text: "Working on the tests next…" }));
        }
        return { ok: true, value: undefined };
      },
      answer: async () => ({ ok: true, value: undefined }),
      setPermissionMode: async (id: string, mode: string) => {
        calls.push(`permission:${id}:${mode}`);
        return mode === "allow-all" ? { ok: true, value: { requested: mode, mode: "manual", applied: false } } : { ok: true, value: { requested: mode, mode, applied: true } };
      },
      setAgentMode: async (id: string, mode: string) => { calls.push(`agent:${id}:${mode}`); return { ok: true, value: { requested: mode, mode, applied: true } }; },
      stop: async (id: string) => { calls.push(`stop:${id}`); later(10, () => emit({ type: "idle", aborted: true })); return { ok: true, value: undefined }; },
      onEvent: (fn: (e: unknown) => void) => { chatListener = fn; return () => { chatListener = null; }; },
    };
    const status = () => ({ appVersion: "0.1.1", settings: current, environment: { checks: [], versions: { node: "24", electron: "44", chrome: "152" } }, logFile: "/test/ember.log", settingsNotice: null, admin });
    window.ember = new Proxy({}, { get: (_t, name: string) => {
      if (name.startsWith("on")) return (fn: (v: unknown) => void) => { (subs[name] ??= []).push(fn); return () => undefined; };
      if (name === "getStatus") return async () => status();
      if (name === "updateSettings") return async (patch: Record<string, unknown>) => { calls.push(`save:${JSON.stringify(patch)}`); window.__chat.settings(patch); return current; };
      if (name === "conversation") return async () => [];
      if (name === "tasks") return async () => [];
      if (name === "activity") return async () => [];
      return () => new Promise(() => undefined);
    } }) as never;
  }, { settings, admin, diff: DIFF });
  await page.goto(`http://127.0.0.1:${port}/app/renderer/home/index.html`);
  await page.waitForSelector("a[href='#project-h']");
  await page.evaluate(() => document.body.classList.remove("loading", "first-run"));
  await page.locator("a[href='#project-h']").first().click();
  return page;
}

const calls = (p: Page) => p.evaluate(() => window.__chat.calls);

/** Turns chats on from Projects, opens the pane and starts a chat. */
async function startChat(page: Page): Promise<void> {
  await page.getByRole("switch", { name: CHAT_NATIVE_LABEL }).check();
  await page.locator("#jump-chats").click();
  await page.getByRole("button", { name: "New chat…" }).click();
  await expect.poll(() => page.locator("#chat-main").isVisible()).toBe(true);
}

describe.skipIf(gate)("Home's Chats pane", () => {
  it("is hidden while its switch is off, and the switch writes the user's setting", async () => {
    const page = await open();
    expect(await page.locator("#jump-chats").isHidden()).toBe(true);
    expect(await page.locator("#chats").isHidden()).toBe(true);
    const sw = page.getByRole("switch", { name: CHAT_NATIVE_LABEL });
    expect(await sw.isChecked()).toBe(false);
    expect(await page.locator("#chat-native-hint").textContent()).toBe(CHAT_NATIVE_HINT);
    // Nothing is asked of main while it is off.
    expect(await calls(page)).toEqual([]);
    await sw.check();
    expect(await calls(page)).toContain(`save:${JSON.stringify({ chat: { native: true } })}`);
    await expect.poll(() => page.locator("#jump-chats").isVisible()).toBe(true);
    await expect.poll(() => calls(page)).toContain("list");
    expect(page.errors).toEqual([]);
  });

  it("is locked off where the organisation allows no chat (acting off), whatever the setting says", async () => {
    const page = await open({ native: true, admin: { source: "/etc/ember/policy.json", features: { actions: false } } });
    const sw = page.getByRole("switch", { name: CHAT_NATIVE_LABEL });
    expect(await sw.isChecked()).toBe(false);
    expect(await sw.isDisabled()).toBe(true);
    expect(await page.locator("#chat-native-hint").textContent()).toBe(CHAT_NATIVE_LOCKED);
    expect(await page.locator("#jump-chats").isHidden()).toBe(true);
    expect(await calls(page)).not.toContain("list");
  });

  it("streams a chat, shows a command's output, answers a write request with exactly its choices, explains a refused mode and stops", async () => {
    const page = await open();
    await startChat(page);
    expect(await page.locator("#chat-name").textContent()).toBe("Chat in work/app");
    // The list: this chat, shown, and a kept one from an earlier run.
    expect(await page.locator("#chat-list .chat-open[aria-current='true']").getAttribute("aria-label")).toBe("Chat in work/app, in work/app");
    expect(await page.locator("#chat-list .chat-open").nth(1).getAttribute("aria-label")).toBe("Tidy the changelog, in me/notes. Kept from before");

    await page.locator("#chat-message").fill("Make the server listen on loopback");
    await page.locator("#chat-message").press("Enter");
    expect(await calls(page)).toContain("send:ember-chat-1:Make the server listen on loopback");
    const log = page.locator("#chat-log");
    await expect.poll(() => log.innerText()).toContain("I'll run the build and then fix the listener.");
    // The command, its live output, its end with the exit code and who let it run.
    const shell = log.locator("li.chat-tool").first();
    await expect.poll(() => shell.innerText()).toContain("build ok in 2.1 s");
    expect(await shell.locator(".chat-code").textContent()).toBe("npm run build");
    await expect.poll(() => shell.locator(".chat-tool-end").textContent()).toBe("Finished, exit code 0. You allowed it.");
    // Reasoning is folded away.
    expect(await log.locator("details.chat-reasoning").evaluate(d => (d as HTMLDetailsElement).open)).toBe(false);

    // The write request's card: its buttons are exactly the SDK's choices.
    const card = log.locator("li.chat-card:not(.resolved)");
    await card.waitFor();
    expect(await card.locator(".chat-choices button").allTextContents()).toEqual(["Allow once", "Allow for this chat", "Don't allow"]);
    expect(await card.innerText()).toContain("Listen on loopback only");
    // The diff: removed and added lines told apart by sign and words, not colour alone.
    expect(await card.locator(".d-del .d-sign").textContent()).toBe("−");
    expect(await card.locator(".d-add .sr").textContent()).toBe("Added: ");
    // Said assertively as it appears, without Ember's name.
    await expect.poll(() => page.locator("#chat-asks").textContent()).toBe("Copilot asks in “Chat in work/app”: Change a file? The request is in the chat.");
    // The list says this chat needs you.
    await expect.poll(() => page.locator("#chat-list .chat-open").first().getAttribute("aria-label")).toBe("Chat in work/app, in work/app. Needs you");

    // Keyboard alone: from the composer to the request, then to its second choice.
    await page.locator("#chat-message").focus();
    const jump = page.locator("#chat-pending");
    expect(await jump.textContent()).toBe("Copilot is waiting for you: go to its request");
    await jump.focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Allow once");
    await page.waitForTimeout(700); // armed once in view for a moment
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Allow for this chat");
    await page.keyboard.press("Enter");
    await expect.poll(() => calls(page)).toContain("decide:ember-chat-1:p1:approve-for-session");
    // The card becomes the record of who decided; the edit's row shows its diff.
    await expect.poll(() => log.locator(".chat-record").first().textContent()).toBe("Allowed for this chat, by you.");
    await expect.poll(() => log.locator("li.chat-tool").nth(1).innerText()).toContain("Changed src/app.ts");
    expect(await log.locator("li.chat-tool").nth(1).locator(".chat-diff").count()).toBe(1);
    expect(await page.locator("#chat-pending").isHidden()).toBe(true);

    // A mode change the SDK didn't apply: the mode in force stays shown, with why.
    await page.locator("#chat-permission").selectOption("allow-all");
    await expect.poll(() => page.locator("#chat-permission-note").textContent()).toBe(chatModeRefused("permission", "allow-all", "manual"));
    expect(await page.locator("#chat-permission").inputValue()).toBe("manual");
    await page.locator("#chat-agent").selectOption("plan");
    await expect.poll(() => page.locator("#chat-agent-hint").textContent()).toBe("Copilot works out a plan with you first, and starts on it when you say so.");

    // Stop, while the turn is under way.
    const stop = page.locator("#chat-stop");
    expect(await stop.getAttribute("aria-label")).toBe("Stop: Chat in work/app");
    await stop.click();
    expect(await calls(page)).toContain("stop:ember-chat-1");
    await expect.poll(() => log.locator("li.stopped").count()).toBe(1);
    await expect.poll(() => stop.isHidden()).toBe(true);
    expect(page.errors).toEqual([]);
  });

  it("drops a press on an approval made before the card has been in view for a moment, but never holds back Don't allow", async () => {
    const page = await open();
    await startChat(page);
    await page.locator("#chat-message").fill("go");
    await page.locator("#chat-send").click();
    const card = page.locator("#chat-log li.chat-card:not(.resolved)");
    await card.waitFor();
    await card.getByRole("button", { name: "Allow once" }).click();
    await page.waitForTimeout(100);
    expect((await calls(page)).some(c => c.startsWith("decide:"))).toBe(false);
    await card.getByText("Tell Copilot why, if you don't allow it").click();
    await card.getByLabel("Reason for Copilot (optional)").fill("Not on loopback, please");
    await card.getByRole("button", { name: "Don't allow" }).click();
    await expect.poll(() => calls(page)).toContain("decide:ember-chat-1:p1:reject:Not on loopback, please");
    await expect.poll(() => page.locator("#chat-log .chat-record").first().textContent()).toBe("Not allowed, by you.");
  });

  it("opens a kept chat again by resuming it", async () => {
    const page = await open();
    await page.getByRole("switch", { name: CHAT_NATIVE_LABEL }).check();
    await page.locator("#jump-chats").click();
    await page.getByRole("button", { name: "Tidy the changelog, in me/notes. Kept from before" }).click();
    await expect.poll(() => calls(page)).toContain("resume:ember-chat-kept");
    await expect.poll(() => page.locator("#chat-name").textContent()).toBe("Tidy the changelog");
    expect(await page.locator("#chat-resumed").isVisible()).toBe(true);
  });

  // The render check's screenshots (design-system.md "Real renders"), saved only where asked.
  it.skipIf(!process.env.EMBER_UI_EVIDENCE)("saves screenshots of the chat with a card, a diff and a command's output", async () => {
    const dir = process.env.EMBER_UI_EVIDENCE!;
    fs.mkdirSync(dir, { recursive: true });
    for (const width of [1000, 600, 380]) {
      const page = await open({ viewport: { width, height: 1200 }, scale: 2 });
      await page.locator("#chat-native-hint").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(dir, `switch-${width}-dark.png`) });
      await startChat(page);
      await page.locator("#chat-message").fill("Make the server listen on loopback");
      await page.locator("#chat-send").click();
      await page.locator("#chat-log li.chat-card:not(.resolved)").waitFor();
      await page.evaluate(() => { (document.querySelector("#chat-log details.chat-reasoning") as HTMLDetailsElement).open = true; });
      for (const scheme of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(dir, `chat-${width}-${scheme}.png`), fullPage: true });
        await page.locator("#chat-log").screenshot({ path: path.join(dir, `chat-log-${width}-${scheme}.png`) });
      }
      await page.emulateMedia({ colorScheme: "dark", forcedColors: "active" });
      await page.waitForTimeout(300);
      await page.locator("#chat-log").screenshot({ path: path.join(dir, `chat-log-${width}-forced.png`) });
      await page.close();
    }
  });
});
