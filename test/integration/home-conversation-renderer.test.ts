/** Built Home in Chromium: the real controls and DOM, with only the isolated preload boundary replaced. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmberHomeApi } from "../../app/shared/ipc";
import type { TranscriptEntry } from "../../app/main/agent/host";
import { CONVERSATION_SHOWN } from "../../app/renderer/home/conversation-view";

declare global {
  interface Window {
    __conversationTest: {
      sent: string[]; copied: string[]; patches: unknown[]; stops: number; news: number; allStops: number; failNext: boolean; deferNext: boolean; deferNew: boolean;
      push(entries: TranscriptEntry[]): void;
      reset(): void;
      resolveSend(): void;
      resolveNew(): void;
      resolveInitial(): void;
    };
    /** The journeys' preload (home() below): what Home asked main for, and main's events. */
    __home: { sent: string[]; stops: number; news: number; copied: string[]; stopResult: boolean; emit(name: string, value: unknown): void };
  }
}

it.skipIf(process.env.EMBER_CONVERSATION_TEST !== "1")("keeps drafts, finds earlier messages, copies full answers and requires explicit resend", async () => {
  const long = "Full answer with code: <script>never execute this</script>\n".repeat(160) + "Final sentence remains available.";
  const entries: TranscriptEntry[] = Array.from({ length: 40 }, (_, i) => ({
    t: new Date(Date.UTC(2026, 10, 4, 10, i)).toISOString(), who: i % 2 ? "ember" : "you",
    text: i === 0 ? "A uniquely earlier request" : i === 39 ? long : `Message ${i}`,
    ...(i === 38 ? { heardId: 123 } : {}),
  }));
  const browser = await chromium.launch({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const dist = path.resolve("dist");
  const server = http.createServer((req, res) => {
    const file = path.resolve(dist, `.${decodeURIComponent((req.url ?? "/").split("?")[0])}`);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
    res.setHeader("content-type", mime[path.extname(file)] ?? "application/octet-stream");
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(seed => {
      const listeners: Record<string, Set<(value: unknown) => void>> = {};
      const emit = (name: string, value: unknown) => { for (const listener of listeners[name] ?? []) listener(value); };
      let pendingSend: (() => void) | null = null;
      let pendingInitial: (() => void) | null = null;
      let pendingNew: (() => void) | null = null;
      const test = window.__conversationTest = {
        sent: [] as string[], copied: [] as string[], patches: [] as unknown[], stops: 0, news: 0, allStops: 0, failNext: false, deferNext: false, deferNew: false,
        push: (value: TranscriptEntry[]) => emit("onConversation", value),
        reset: () => { emit("onConversationForgotten", undefined); },
        resolveSend: () => { pendingSend?.(); pendingSend = null; },
        resolveNew: () => { pendingNew?.(); pendingNew = null; },
        resolveInitial: () => { pendingInitial?.(); pendingInitial = null; },
      };
      window.ember = new Proxy({}, { get: (_target, name: string) => {
        if (name.startsWith("on")) return (fn: (value: unknown) => void) => {
          (listeners[name] ??= new Set()).add(fn);
          return () => { listeners[name]?.delete(fn); };
        };
        if (name === "conversation") return () => new Promise<TranscriptEntry[]>(resolve => { pendingInitial = () => resolve(seed); });
        if (name === "conversationSend") return async (text: string) => {
          if (test.failNext) { test.failNext = false; throw new Error("Couldn’t connect. Try again."); }
          test.sent.push(text);
          if (test.deferNext) { test.deferNext = false; await new Promise<void>(resolve => { pendingSend = resolve; }); }
        };
        if (name === "updateSettings") return async (patch: unknown) => { test.patches.push(patch); return {}; };
        if (name === "conversationStop") return async () => { test.stops++; };
        // As main answers it: the transcript is emptied (conversationChanged), but no "forgotten" is broadcast for it.
        if (name === "conversationNew") return async () => {
          test.news++;
          emit("onConversation", []);
          if (test.deferNew) { test.deferNew = false; await new Promise<void>(resolve => { pendingNew = resolve; }); }
        };
        if (name === "stopEverything") return async () => { test.allStops++; };
        if (name === "reminders") return async () => [];
        if (name === "copyText") return async (text: string) => { test.copied.push(text); };
        // Unrelated asynchronous settings/data views stay pending; all real event listeners still mount.
        return () => new Promise(() => undefined);
      } }) as EmberHomeApi;
    }, entries);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn’t start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    // A newer live transcript must win over a delayed initial IPC snapshot.
    await page.evaluate(seed => {
      window.__conversationTest.push(seed.map((entry, i) => i ? entry : { ...entry, text: "A uniquely earlier request with updated details" }));
      window.__conversationTest.resolveInitial();
    }, entries);
    await expect.poll(() => page.locator("#conversation li").count()).toBe(CONVERSATION_SHOWN);
    await page.evaluate(() => document.body.classList.remove("loading", "first-run"));
    await page.locator("#conversation-message").fill("My unsent draft");
    await page.locator('a[href="#voice-h"]').click();
    await page.locator('a[href="#home-h"]').click();
    expect(await page.locator("#conversation-message").inputValue()).toBe("My unsent draft");
    await page.locator("#conversation-search").fill("uniquely earlier");
    await expect.poll(() => page.locator("#conversation li:visible").count()).toBe(1);
    expect(await page.locator("#conversation-search-status").innerText()).toBe("1 matching message in this session.");
    expect(await page.locator("#conversation li:visible p").innerText()).toContain("updated details");
    await page.locator("#conversation-search").fill("missing text");
    expect(await page.locator("#conversation-search-status").innerText()).toBe("0 matching messages in this session.");
    await page.locator("#conversation-search").fill("");
    const answer = page.locator("#conversation li.ember").last();
    expect(await answer.locator("p").innerText()).toBe(long);
    expect(await answer.locator("script").count()).toBe(0);
    await answer.getByRole("button", { name: /Copy Ember/ }).click();
    expect(await page.evaluate(() => window.__conversationTest.copied)).toEqual([long]);
    await page.locator("#conversation li.you").last().getByRole("button", { name: /Edit your message/ }).click();
    expect(await page.evaluate(() => window.__conversationTest.sent)).toEqual([]);
    expect(await page.locator("#conversation-message").inputValue()).toBe("Message 38");
    await page.locator("#conversation-cancel-edit").click();
    expect(await page.locator("#conversation-message").inputValue()).toBe("My unsent draft");
    await page.evaluate(() => { window.__conversationTest.failNext = true; });
    await page.locator("#conversation-send").click();
    await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toContain("Couldn’t connect");
    expect(await page.locator("#conversation-message").inputValue()).toBe("My unsent draft");
    await page.locator("#conversation-message").press("Control+Enter");
    await expect.poll(() => page.evaluate(() => window.__conversationTest.sent)).toEqual(["My unsent draft"]);
    expect(await page.locator("#conversation-message").inputValue()).toBe("");
    await page.locator("#conversation-stop").click();
    await expect.poll(() => page.evaluate(() => window.__conversationTest.stops)).toBe(1);
    expect(await page.locator("#conversation-compose-status").innerText()).toContain("Running tasks continue");
    expect(await page.evaluate(() => window.__conversationTest.allStops)).toBe(0);
    await page.locator("#conversation li.you").last().getByRole("button", { name: /Edit your message/ }).click();
    expect(await page.evaluate(() => window.__conversationTest.sent)).toEqual(["My unsent draft"]);
    await page.locator("#conversation-message").fill("An explicitly edited request");
    await page.locator("#conversation-send").click();
    await expect.poll(() => page.evaluate(() => window.__conversationTest.sent)).toEqual(["My unsent draft", "An explicitly edited request"]);
    expect(await page.locator("#conversation-retention").innerText()).toContain("latest 60 messages");
    // Keeping the conversation across restarts is a switch, off until chosen, and says what it saves and what it doesn't.
    const keep = page.locator("#keep-conversation");
    expect(await keep.isChecked()).toBe(false);
    expect(await keep.getAttribute("role")).toBe("switch");
    expect(await page.locator("#keep-conversation-label").innerText()).toBe("Keep my recent conversation after Ember closes");
    expect(await page.locator("#keep-conversation-hint").innerText()).toContain("starts a fresh conversation");
    await keep.focus();
    await page.keyboard.press("Space");
    await expect.poll(() => page.evaluate(() => window.__conversationTest.patches)).toEqual([{ keepConversation: true }]);
    // New conversation: a plain button, reached and activated from the keyboard; it empties the chat only.
    await page.locator("#conversation-stop").focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("conversation-new");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.__conversationTest.news)).toBe(1);
    await expect.poll(() => page.locator("#conversation li").count()).toBe(0);
    // Its own reset still announces the result and puts focus back on the composer (review of #184).
    await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toContain("Memory, reminders and running tasks are untouched");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("conversation-message");
    expect(await page.locator("#conversation-new").isDisabled()).toBe(false);
    expect(await page.evaluate(() => window.__conversationTest.allStops)).toBe(0);
    // An account reset that lands while it is under way is not its own: the newer draft and status stay untouched.
    await page.evaluate(() => { window.__conversationTest.deferNew = true; });
    await page.locator("#conversation-new").click();
    await expect.poll(() => page.evaluate(() => window.__conversationTest.news)).toBe(2);
    await page.evaluate(() => window.__conversationTest.reset());
    await page.locator("#conversation-message").fill("Next account’s draft");
    await page.locator("#conversation-send").focus();
    await page.evaluate(() => window.__conversationTest.resolveNew());
    await expect.poll(() => page.locator("#conversation-new").isDisabled()).toBe(false);
    expect(await page.locator("#conversation-message").inputValue()).toBe("Next account’s draft");
    expect(await page.locator("#conversation-compose-status").innerText()).toBe("");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("conversation-send");
    await page.locator("#conversation-message").fill("");
    // Real layouts at either side of the Home breakpoint, larger type, Calm and forced colours.
    for (const width of [600, 1000]) for (const textSize of ["default", "large", "larger"]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(size => { document.documentElement.dataset.textSize = size; document.documentElement.classList.add("calm"); }, textSize);
      await page.locator("#conversation-compose").scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.EMBER_UI_EVIDENCE) {
        fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
        await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, `conversation-${width}-${textSize}.png`) });
      }
    }
    await page.emulateMedia({ forcedColors: "active" });
    expect(await page.locator("#conversation-message").isVisible()).toBe(true);
    if (process.env.EMBER_UI_EVIDENCE) await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "conversation-forced-colours.png") });
    await page.evaluate(() => window.__conversationTest.push([{ t: new Date().toISOString(), who: "ember", text: "The retained portion.", truncated: true }]));
    expect(await page.locator("#conversation .conversation-limit").innerText()).toContain("Only the text shown here is retained and copied");
    // Account/sign-out transcript reset clears the in-memory draft and search too.
    await page.locator("#conversation-message").fill("Private unfinished message");
    await page.evaluate(() => window.__conversationTest.push([]));
    expect(await page.locator("#conversation-message").inputValue()).toBe("Private unfinished message");
    await page.evaluate(() => window.__conversationTest.reset());
    expect(await page.locator("#conversation-message").inputValue()).toBe("");
    await page.locator("#conversation-message").fill("A pending message from the previous account");
    await page.evaluate(() => { window.__conversationTest.deferNext = true; });
    await page.locator("#conversation-send").click();
    expect(await page.locator("#conversation-send").isDisabled()).toBe(true);
    await page.evaluate(() => window.__conversationTest.reset());
    await page.locator("#conversation-message").fill("Next account’s unfinished draft");
    await page.evaluate(async () => { window.__conversationTest.resolveSend(); await Promise.resolve(); });
    expect(await page.locator("#conversation-message").inputValue()).toBe("Next account’s unfinished draft");
    expect(await page.locator("#conversation-compose-status").innerText()).toBe("");
    await page.evaluate(() => {
      window.__conversationTest.push([{ t: new Date().toISOString(), who: "ember", text: "Previous account retained answer" }]);
      window.__conversationTest.reset();
    });
    expect(await page.locator("#conversation li").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);

const at = (i: number) => new Date(Date.UTC(2026, 10, 7, 9, i)).toISOString();
/** `n` messages, a question and its answer in turn; each answer a few lines long, as a real one is. */
const exchange = (n: number, from = 0): TranscriptEntry[] => Array.from({ length: n }, (_, k) => {
  const i = from + k;
  return { t: at(i), who: i % 2 ? "ember" : "you", text: i % 2 ? `Answer ${i}. ${"Some words of the answer here. ".repeat(6)}` : `Question number ${i}` };
});

describe.skipIf(process.env.EMBER_CONVERSATION_TEST !== "1")("Home's conversation, as the person uses it (2026-11-07 product audit)", () => {
  let browser: Browser;
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
    const dist = path.resolve("dist");
    server = http.createServer((req, res) => {
      const file = path.resolve(dist, `.${decodeURIComponent((req.url ?? "/").split("?")[0])}`);
      if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
      const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
      res.setHeader("content-type", mime[path.extname(file)] ?? "application/octet-stream");
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn't start.");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); });

  /** Built Home at the default window size (760×640), its preload replaced by a recorder, the conversation `seed`. */
  async function home(seed: TranscriptEntry[], viewport = { width: 760, height: 640 }): Promise<{ page: Page; errors: string[] }> {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(entries => {
      const listeners: Record<string, Set<(value: unknown) => void>> = {};
      const emit = (name: string, value: unknown) => { for (const listener of listeners[name] ?? []) listener(value); };
      const h = window.__home = { sent: [] as string[], stops: 0, news: 0, copied: [] as string[], stopResult: true, emit };
      window.ember = new Proxy({}, { get: (_target, name: string) => {
        if (name.startsWith("on")) return (fn: (value: unknown) => void) => { (listeners[name] ??= new Set()).add(fn); return () => { listeners[name]?.delete(fn); }; };
        if (name === "conversation") return async () => entries;
        if (name === "conversationSend") return async (text: string) => { h.sent.push(text); };
        if (name === "conversationStop") return async () => { h.stops++; return h.stopResult; };
        if (name === "conversationNew") return async () => { h.news++; emit("onConversation", []); };
        if (name === "copyText") return async (text: string) => { h.copied.push(text); };
        if (name === "reminders") return async () => [];
        if (name === "historyProblem") return async () => null;
        return () => new Promise(() => undefined);
      } }) as EmberHomeApi;
    }, seed);
    await page.goto(`${base}/app/renderer/home/index.html`);
    await page.evaluate(() => document.body.classList.remove("loading", "first-run"));
    if (seed.length) await expect.poll(() => page.locator("#conversation li").count()).toBeGreaterThan(0);
    return { page, errors };
  }
  /** Where `selector` is in the window (its top and bottom, CSS px), and the window's height. */
  const rect = (page: Page, selector: string) => page.evaluate(s => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: innerHeight };
  }, selector);
  /** Main's side of a turn: the request echoed, then the answer written word by word, then settled. */
  async function reply(page: Page, before: TranscriptEntry[], asked: string, id: number): Promise<TranscriptEntry[]> {
    const withYou = [...before, { t: at(before.length), who: "you" as const, text: asked }];
    await page.evaluate(e => window.__home.emit("onConversation", e), withYou);
    let text = "";
    for (let i = 0; i < 80; i++) {
      text += `word${i} `;
      await page.evaluate(([x, n]) => window.__home.emit("onConversationStream", { id: n, text: x, state: "streaming" }), [text, id] as const);
    }
    const settled = [...withYou, { t: at(before.length + 1), who: "ember" as const, text: text.trim(), answerId: id }];
    await page.evaluate(e => window.__home.emit("onConversation", e), settled);
    await page.evaluate(n => window.__home.emit("onConversationStream", { id: n, text: "", state: "done" }), id);
    return settled;
  }

  it("keeps the composer and its Send in view while a reply grows above it, and leaves alone someone reading elsewhere (home-1)", async () => {
    const seed = exchange(12);
    const { page, errors } = await home(seed);
    try {
      await page.locator("#conversation-message").focus();
      await page.keyboard.type("What should I do next?");
      await page.keyboard.press("Control+Enter");
      await expect.poll(() => page.evaluate(() => window.__home.sent)).toEqual(["What should I do next?"]);
      const after = await reply(page, seed, "What should I do next?", 7);
      // Still writing here: the box and its buttons show, not 150 px below the window's foot.
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("conversation-message");
      const box = await rect(page, "#conversation-message");
      const send = await rect(page, "#conversation-send");
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(send.bottom).toBeLessThanOrEqual(send.height);
      // Scrolled up to read an earlier message while the box keeps the focus: the next reply doesn't pull the page back.
      await page.evaluate(() => window.scrollTo({ top: 0 }));
      const later = await reply(page, after, "And after that?", 8);
      expect(await page.evaluate(() => scrollY)).toBe(0);
      // Reading elsewhere (the focus on a message's Copy): nothing scrolls either.
      const more = [...later, ...exchange(2, later.length)];
      const copy = (await page.locator("#conversation li.ember").last().getByRole("button", { name: /Copy/ }).elementHandle())!;
      await copy.focus();
      const where = (await copy.boundingBox())?.y;
      await reply(page, more, "One more", 9);
      expect((await copy.boundingBox())?.y).toBe(where);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Copy");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("opens \"Read the last answer\" at that answer, focused and in view, also before the conversation has come (home-v1)", async () => {
    const seed = exchange(30);
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(() => window.__home.emit("onFocusSection", "conversation:latest"));
      const newest = () => page.evaluate(() => {
        const rows = [...document.querySelectorAll("#conversation > li.ember")];
        const r = rows.at(-1)!.getBoundingClientRect();
        return { focused: document.activeElement === rows.at(-1), top: r.top, height: innerHeight, text: rows.at(-1)!.querySelector("p")?.textContent };
      });
      expect((await newest()).focused).toBe(true);
      expect((await newest()).text).toContain("Answer 29.");
      // (It glides there unless Calm is on.)
      await expect.poll(async () => { const n = await newest(); return n.top >= 0 && n.top < n.height / 2; }).toBe(true);
    } finally { await page.close(); }
    // Home opened by the request: the messages come after it, and it waits for them.
    const late = await home([]);
    try {
      await late.page.evaluate(() => window.__home.emit("onFocusSection", "conversation:latest"));
      await late.page.evaluate(e => window.__home.emit("onConversation", e), seed);
      await expect.poll(() => late.page.evaluate(() => document.activeElement === [...document.querySelectorAll("#conversation > li.ember")].at(-1))).toBe(true);
      expect(errors.concat(late.errors)).toEqual([]);
    } finally { await late.page.close(); }
  }, 60_000);

  it("puts the composer and Task activity within reach of a long conversation, by pointer and by keyboard (home-v2)", async () => {
    const { page, errors } = await home(exchange(30));
    try {
      // The latest few messages, the rest a click away: the composer no longer sits six window-heights down (4,195 px).
      await expect.poll(() => page.locator("#conversation > li").count()).toBe(6);
      expect(await page.locator("#conversation-earlier").innerText()).toBe("Show 24 earlier messages");
      const composer = await page.evaluate(() => document.getElementById("conversation-message")!.getBoundingClientRect().top + scrollY);
      expect(composer).toBeLessThan(2.25 * 640);
      // Two quiet links in the status panel: to the composer, and to Task activity.
      await page.getByRole("button", { name: "Write to Ember" }).click();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("conversation-message");
      await expect.poll(async () => { const r = await rect(page, "#conversation-message"); return r.top >= 0 && r.bottom <= r.height; }).toBe(true);
      await page.evaluate(() => window.scrollTo({ top: 0 }));
      await page.getByRole("button", { name: "Task activity" }).click();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("tasks-h");
      // From the keyboard: the link comes before any message's Copy and Edit, and Enter takes the focus to the composer.
      await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo({ top: 0 }); });
      let presses = 0;
      while (presses < 40 && await page.evaluate(() => document.activeElement?.textContent) !== "Write to Ember") { await page.keyboard.press("Tab"); presses++; }
      expect(presses).toBeLessThan(20);
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("conversation-message");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
});
