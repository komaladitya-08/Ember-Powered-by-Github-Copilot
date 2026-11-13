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
    __home: { sent: string[]; stops: number; news: number; copied: string[]; stopResult: boolean; sendResult: string | undefined; sendError?: string; hold: boolean; release(): void; emit(name: string, value: unknown): void };
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
    expect(await page.locator("#conversation-search-status").innerText()).toBe("1 matching message in this conversation.");
    expect(await page.locator("#conversation li:visible p").innerText()).toContain("updated details");
    await page.locator("#conversation-search").fill("missing text");
    expect(await page.locator("#conversation-search-status").innerText()).toBe("0 matching messages in this conversation.");
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
    // New conversation: a plain button, reached and activated from the keyboard; it asks first (home-9), then empties the chat only.
    await page.locator("#conversation-stop").focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("conversation-new");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.__conversationTest.news)).toBe(0);
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("conversation-new-yes");
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
      // `hold`: Stop response and Copy wait for release() before main answers them.
      let held: (() => void)[] = [];
      const wait = () => h.hold ? new Promise<void>(resolve => { held.push(resolve); }) : Promise.resolve();
      const h = window.__home = { sent: [] as string[], stops: 0, news: 0, copied: [] as string[], stopResult: true, sendResult: undefined as string | undefined, sendError: undefined as string | undefined, hold: false, release: () => { for (const r of held) r(); held = []; }, emit };
      window.ember = new Proxy({}, { get: (_target, name: string) => {
        if (name.startsWith("on")) return (fn: (value: unknown) => void) => { (listeners[name] ??= new Set()).add(fn); return () => { listeners[name]?.delete(fn); }; };
        if (name === "conversation") return async () => entries;
        if (name === "conversationSend") return async (text: string) => { h.sent.push(text); await wait(); if (h.sendError) throw new Error(`Error invoking remote method 'agent:conversation-send': Error: ${h.sendError}`); return h.sendResult; };
        if (name === "conversationStop") return async () => { h.stops++; await wait(); return h.stopResult; };
        if (name === "conversationNew") return async () => { h.news++; emit("onConversation", []); };
        if (name === "copyText") return async (text: string) => { h.copied.push(text); await wait(); };
        if (name === "reminders") return async () => [];
        if (name === "historyProblem") return async () => null;
        return () => new Promise(() => undefined);
      } }) as EmberHomeApi;
    }, seed);
    await page.goto(`${base}/app/renderer/home/index.html`);
    // Home as it stands once its pane has come in: leaving the first run starts the pane's entrance, a 6 px rise over
    // 420 ms (styles.css, "A pane coming into view"), and a place measured during it moved by the rest of the rise
    // when it ended (1.55 px in CI, 145 ms in; home-1).
    await page.evaluate(() => {
      document.body.classList.remove("loading", "first-run");
      for (const a of document.getAnimations()) {
        if (a instanceof CSSTransition && a.effect instanceof KeyframeEffect && a.effect.target?.matches(".home > [data-pane]")) a.finish();
      }
    });
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
      // Within a pixel: where the browser's anchoring doesn't hold it, Home scrolls back by whole pixels.
      expect(Math.abs((await copy.boundingBox())!.y - where!)).toBeLessThanOrEqual(1.5);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Copy");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("keeps the place of someone reading elsewhere when the rows above them go, without the browser's scroll anchoring (home-1)", async () => {
    // Only the last messages show, so a reply takes rows off the top, above the message being read. The browser's scroll
    // anchoring usually holds the place; once in CI it didn't, and the focused Copy jumped 333 px. Home holds it itself.
    const seed = exchange(16);
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(() => { document.documentElement.style.overflowAnchor = "none"; });
      const copy = (await page.locator("#conversation li.ember").last().getByRole("button", { name: /Copy/ }).elementHandle())!;
      await copy.focus();
      const where = (await copy.boundingBox())?.y;
      expect(where).toBeGreaterThan(0);
      await reply(page, [...seed, ...exchange(2, seed.length)], "One more", 3);
      // Within a pixel: the page scrolls by whole pixels.
      expect(Math.abs((await copy.boundingBox())!.y - where!)).toBeLessThanOrEqual(1.5);
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

  it("shows the new request and its reply after a search was left typed in (home-4)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Find the invoice from March" }, { t: at(1), who: "ember", text: "The invoice is in Downloads." }];
    const { page, errors } = await home(seed);
    try {
      await page.locator("#conversation-search").fill("invoice");
      await page.locator("#conversation-message").fill("Thanks, now open my calendar");
      await page.locator("#conversation-send").click();
      await expect.poll(() => page.evaluate(() => window.__home.sent)).toEqual(["Thanks, now open my calendar"]);
      await reply(page, seed, "Thanks, now open my calendar", 3);
      expect(await page.locator("#conversation-search").inputValue()).toBe("");
      expect(await page.locator("#conversation-search-status").innerText()).toBe("");
      expect(await page.locator("#conversation > li:visible p").allInnerTexts()).toEqual([seed[0].text, seed[1].text, "Thanks, now open my calendar", expect.stringMatching(/^word0 word1/)]);
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Reply received.");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("keeps the composer, its Send and the new exchange in view after sending with a search left typed in, at 760×640 (home-r1)", async () => {
    const seed = exchange(12);
    const { page, errors } = await home(seed);
    try {
      await page.locator("#conversation-search").fill("number 10");
      await expect.poll(() => page.locator("#conversation > li:visible").count()).toBe(1);
      await page.locator("#conversation-message").click();
      await page.keyboard.type("And the one after?");
      expect((await rect(page, "#conversation-send")).bottom).toBeLessThanOrEqual(640);
      await page.keyboard.press("Control+Enter");
      await expect.poll(() => page.evaluate(() => window.__home.sent)).toEqual(["And the one after?"]);
      expect(await page.locator("#conversation-search").inputValue()).toBe("");
      await reply(page, seed, "And the one after?", 5);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("conversation-message");
      const send = await rect(page, "#conversation-send");
      expect(send.top).toBeGreaterThanOrEqual(0);
      expect(send.bottom).toBeLessThanOrEqual(send.height);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("keeps a message holding the keyboard focus on the page while newer ones come, so its Copy keeps the focus (home-c1-2)", async () => {
    const seed = exchange(6);
    const { page, errors } = await home(seed);
    try {
      const texts = () => page.locator("#conversation > li p").allInnerTexts();
      // The oldest answer shown, its Copy focused from the keyboard (to copy it, or read it again).
      const copy = page.locator("#conversation > li.ember").first().getByRole("button", { name: /Copy/ });
      await copy.focus();
      const more = [...seed, ...exchange(2, 6)];
      await page.evaluate(e => window.__home.emit("onConversation", e), more);
      expect(await page.evaluate(() => document.activeElement?.closest("li")?.querySelector("p")?.textContent)).toBe(seed[1].text);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Copy");
      expect((await texts())[0]).toBe(seed[1].text);
      expect(await page.locator("#conversation-earlier").innerText()).toBe("Show 1 earlier message");
      // Once the focus has gone, the next change shows the latest few again.
      await page.locator("#conversation-message").focus();
      await page.evaluate(e => window.__home.emit("onConversation", e), [...more, ...exchange(2, 8)]);
      await expect.poll(() => page.locator("#conversation > li").count()).toBe(6);
      expect((await texts())[0]).toBe("Question number 4");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("keeps the keyboard focus on Send, Stop response and a message's Copy while main answers them (home-c1-3)", async () => {
    const { page, errors } = await home(exchange(2));
    try {
      await page.evaluate(() => { window.__home.hold = true; });
      const settle = () => page.evaluate(() => new Promise<void>(resolve => { document.body.getBoundingClientRect(); requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }));
      await page.locator("#conversation-stop").focus();
      await page.keyboard.press("Enter");
      await settle();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("conversation-stop");
      // A second press while the first is answered sends nothing more.
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => window.__home.stops)).toBe(1);
      await page.evaluate(() => window.__home.release());
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Response stopped. Running tasks continue.");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("conversation-stop");
      const copy = page.locator("#conversation li.ember").getByRole("button", { name: /Copy Ember's answer/ });
      await copy.focus();
      await page.keyboard.press("Enter");
      await settle();
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toMatch(/^Copy Ember's answer/);
      await page.evaluate(() => window.__home.release());
      await expect.poll(() => copy.innerText()).toBe("Copied");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toMatch(/^Copy Ember's answer/);
      expect(await page.evaluate(() => window.__home.copied)).toHaveLength(1);
      // Send pressed from the keyboard: the focus stays on it while it says "Sending…", and a second press sends nothing.
      await page.locator("#conversation-message").fill("What's next?");
      await page.locator("#conversation-send").focus();
      await page.keyboard.press("Enter");
      await settle();
      expect(await page.evaluate(() => [document.activeElement?.id, document.activeElement?.textContent])).toEqual(["conversation-send", "Sending…"]);
      await page.keyboard.press("Enter");
      await page.evaluate(() => window.__home.release());
      await expect.poll(() => page.locator("#conversation-send").innerText()).toBe("Send");
      expect(await page.evaluate(() => [window.__home.sent, document.activeElement?.id])).toEqual([["What's next?"], "conversation-send"]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("keeps a long paste whole, says how much to shorten it, and sends nothing until it fits (home-5)", async () => {
    const { page, errors } = await home([]);
    try {
      const long = `${"A long log line that matters. ".repeat(108)}THE IMPORTANT LAST LINE`;
      expect(long.length).toBe(3263);
      await page.locator("#conversation-message").focus();
      await page.keyboard.insertText(long);
      expect(await page.locator("#conversation-message").inputValue()).toBe(long);
      expect(await page.locator("#conversation-count").innerText()).toBe("3,263 of 2,000 characters, 1,263 too many.");
      expect(await page.locator("#conversation-message").getAttribute("aria-invalid")).toBe("true");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("This message is longer than 2,000 characters. Shorten it to send it.");
      await page.keyboard.press("Control+Enter");
      await page.locator("#conversation-send").click();
      expect(await page.evaluate(() => window.__home.sent)).toEqual([]);
      expect(await page.locator("#conversation-message").inputValue()).toBe(long);
      // Cut to fit: the count stays while it is near the limit, and Send works.
      await page.locator("#conversation-message").fill(long.slice(-1900));
      expect(await page.locator("#conversation-count").innerText()).toBe("1,900 of 2,000 characters.");
      expect(await page.locator("#conversation-message").getAttribute("aria-invalid")).toBeNull();
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("");
      await page.locator("#conversation-send").click();
      await expect.poll(() => page.evaluate(() => window.__home.sent)).toEqual([long.slice(-1900)]);
      expect(await page.locator("#conversation-count").isHidden()).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("marks once where the messages kept from before a restart end, so they don't read as this conversation (home-8)", async () => {
    const yesterday = (h: number) => new Date(Date.now() - 86_400_000 + h * 60_000).toISOString();
    const restored: TranscriptEntry[] = [
      { t: yesterday(0), who: "you", text: "Clean up my Downloads folder", restored: true },
      { t: yesterday(1), who: "ember", text: "I can delete the 12 installers there. Shall I?", restored: true },
    ];
    const { page, errors } = await home(restored);
    try {
      const rows = () => page.locator("#conversation > li").evaluateAll(els => els.map(e => e.classList.contains("restored-end") ? "|" : (e.querySelector("p")?.textContent ?? "")));
      const end = page.locator("#conversation > li.restored-end");
      await expect.poll(rows).toEqual([restored[0].text, restored[1].text, "|"]);
      expect(await end.innerText()).toBe("The messages above are from before Ember restarted, for you to read. Ember doesn't remember them: it starts afresh below.");
      // Their day is said, not only a time that reads as today's.
      expect(await page.locator("#conversation > li.you time").first().innerText()).toMatch(/^Yesterday, /);
      // The live conversation goes on below it; the mark stays where the restored lines end.
      const live = await reply(page, restored, "Yes please", 4);
      expect(await rows()).toEqual([restored[0].text, restored[1].text, "|", "Yes please", live.at(-1)!.text]);
      expect(await end.count()).toBe(1);
      // While searching, the matches alone.
      await page.locator("#conversation-search").fill("installers");
      expect(await end.isHidden()).toBe(true);
      expect(await page.locator("#conversation-search-status").innerText()).toBe("1 matching message in this conversation.");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  /** Main's word of the conversation's turn (AgentHost.conversationTurn), as it pushes it to Home. */
  const turn = (page: Page, state: "idle" | "thinking" | "slow" | "held") => page.evaluate(t => window.__home.emit("onConversationTurn", t), state);
  const READY = { phase: "ready", detail: "", models: [], conductorModel: null, workerModel: null, usage: { calls: 0, inputTokens: 0, outputTokens: 0 } };

  it("says in the window that Ember is thinking, then still waiting with how to stop while the bubble says so, until the reply comes (home-7, home-c1-1)", async () => {
    const { page, errors } = await home([]);
    try {
      await page.clock.install();
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      await expect.poll(() => page.locator("#state-word").innerText()).toBe("Ready");
      await page.locator("#conversation-message").fill("What's the weather?");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Thinking… The reply will appear above.");
      expect(await page.locator("#state-word").innerText()).toBe("Thinking…");
      // No guess of its own: only main's word that the bubble says it is still waiting.
      await page.clock.runFor(20_000);
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Thinking… The reply will appear above.");
      await turn(page, "slow");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Still waiting for Copilot… Stop response ends this reply.");
      await turn(page, "thinking");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Thinking… The reply will appear above.");
      // Words come, then the reply: the wait is over.
      await reply(page, [], "What's the weather?", 2);
      await turn(page, "idle");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Reply received.");
      expect(await page.locator("#state-word").innerText()).toBe("Ready");
      // A reply that starts writing is never called a wait.
      await page.locator("#conversation-message").fill("And tomorrow?");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Thinking… The reply will appear above.");
      await page.evaluate(() => window.__home.emit("onConversationStream", { id: 3, text: "Rain", state: "streaming" }));
      await turn(page, "slow");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Thinking… The reply will appear above.");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("says a message held for a new model service waits for the switch, never that Ember is thinking, until it is sent (home-r4-4)", async () => {
    const { page, errors } = await home([]);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      await page.locator("#conversation-message").fill("Summarise my inbox");
      await page.locator("#conversation-send").click();
      await turn(page, "held");
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("This goes to the new model service once what's under way now has finished. Stop response cancels it.");
      expect(await page.locator("#state-word").innerText()).toBe("Switching model service…");
      if (process.env.EMBER_UI_EVIDENCE) {
        fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
        await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "conversation-held.png") });
      }
      // Switched and sent: now it is answered.
      await turn(page, "thinking");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Thinking… The reply will appear above.");
      expect(await page.locator("#state-word").innerText()).toBe("Thinking…");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("ends the wait when a turn that wrote nothing ends, and says so, never \"Still waiting\" after it (home-c1-1)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Tidy my desktop" }, { t: at(1), who: "ember", text: "On it." }];
    const { page, errors } = await home(seed);
    try {
      await page.clock.install();
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      await page.locator("#conversation-message").fill("Then empty the trash");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await page.evaluate(e => window.__home.emit("onConversation", e), [...seed, { t: at(2), who: "you", text: "Then empty the trash" }]);
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Thinking… The reply will appear above.");
      // The turn only started a task: no line of Ember's, and the turn ends.
      await turn(page, "idle");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("No reply was written. Task activity shows any task this request started.");
      expect(await page.locator("#state-word").innerText()).toBe("Ready");
      await page.clock.runFor(30_000);
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("No reply was written. Task activity shows any task this request started.");
      // A turn under way before the send (asked in the Ask box) isn't this request's end: its end comes with the last one.
      await turn(page, "thinking");
      await page.locator("#conversation-message").fill("And close Files");
      await page.locator("#conversation-send").click();
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Thinking… The reply will appear above.");
      await turn(page, "idle");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("No reply was written. Task activity shows any task this request started.");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("says Ember is reading its last answer out after a typed \"Read it out\", never \"Thinking…\" for good (voice-speaking-x7-2)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "When is my next meeting?" }, { t: at(1), who: "ember", text: "Your next meeting is at three." }];
    const { page, errors } = await home(seed);
    try {
      await page.clock.install();
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      await page.locator("#conversation-message").fill("Read it out");
      await page.locator("#conversation-send").click();
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Thinking… The reply will appear above.");
      // Main reads the answer aloud: no line is written, and it says the request was answered that way.
      await turn(page, "thinking");
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "read-out" }));
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Reading the last answer out.");
      expect(await page.locator("#state-word").innerText()).toBe("Ready");
      expect(await page.locator("#conversation-message").inputValue()).toBe("");
      await page.clock.runFor(30_000);
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Reading the last answer out.");
      // Told before main answered the send (the read began at once): said as soon as the send is answered.
      await page.evaluate(() => { window.__home.hold = true; });
      await page.locator("#conversation-message").fill("tell me again");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "read-out" }));
      await page.evaluate(() => { window.__home.release(); window.__home.hold = false; });
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Reading the last answer out.");
      expect(await page.locator("#conversation-message").inputValue()).toBe("");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("waits for its own turn's end, not another line of Ember's that comes meanwhile, such as a reminder (home-7)", async () => {
    const { page, errors } = await home([]);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      await page.locator("#conversation-message").fill("Summarise my mail");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      const asked: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Summarise my mail" }];
      await page.evaluate(e => window.__home.emit("onConversation", e), asked);
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Thinking… The reply will appear above.");
      // A reminder comes due while Ember answers: Ember's line, but not this reply.
      const reminded = [...asked, { t: at(1), who: "ember" as const, text: "Reminder: call the dentist" }];
      await page.evaluate(e => window.__home.emit("onConversation", e), reminded);
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Thinking… The reply will appear above.");
      expect(await page.locator("#state-word").innerText()).toBe("Thinking…");
      await page.evaluate(e => window.__home.emit("onConversation", e), [...reminded, { t: at(2), who: "ember" as const, text: "Three new messages, none urgent." }]);
      await turn(page, "idle");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Reply received.");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("says a typed \"stop\" stopped everything, and waits for no reply after it (home-c1-1)", async () => {
    const { page, errors } = await home([]);
    try {
      await page.clock.install();
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      await page.evaluate(() => { window.__home.sendResult = "stopped"; });
      await page.locator("#conversation-message").fill("stop");
      await page.locator("#conversation-message").press("Control+Enter");
      // Main stops everything at once (the kill switch tells Home), and answers the send: "stopped".
      await page.evaluate(() => window.__home.emit("onStopped", "typed"));
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Stopped everything, running tasks included.");
      expect(await page.locator("#conversation-message").inputValue()).toBe("");
      expect(await page.locator("#state-word").innerText()).toBe("Ready");
      await page.clock.runFor(30_000);
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Stopped everything, running tasks included.");
      expect(await page.locator("#state-word").innerText()).toBe("Ready");
      // Stop everything from elsewhere (its shortcut, "Ember, stop") during a wait ends it the same way.
      await page.evaluate(() => { window.__home.sendResult = undefined; });
      await page.locator("#conversation-message").fill("Summarise my mail");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Thinking… The reply will appear above.");
      await page.evaluate(() => window.__home.emit("onStopped", "hotkey"));
      await turn(page, "idle");
      // (It never became a line of the conversation, so it never went: its words are back to send again, home-r3-1.)
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Stopped everything, running tasks included. Your message wasn't sent, so it's back here to edit or send again.");
      expect(await page.locator("#conversation-message").inputValue()).toBe("Summarise my mail");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("gives back the words of a message that a Stop ended before it was sent, while Ember reconnected, and says it is ready (home-r3-1)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Q1" }, { t: at(1), who: "ember", text: "A1" }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const field = page.locator("#conversation-message");
      // Sent while Ember reconnects: main took it, and it waits for the connection (no line of it yet).
      await field.fill("Q2 during reconnect");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await expect.poll(() => field.inputValue()).toBe("");
      // Stop response: main ends the wait at once and says Stop ended it, before or after it answers the press.
      await page.evaluate(() => { window.__home.hold = true; });
      await page.locator("#conversation-stop").click();
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped" }));
      const back = "Response stopped. Running tasks continue. Your message wasn't sent, so it's back here to edit or send again.";
      expect(await line.innerText()).toBe(back);
      expect(await field.inputValue()).toBe("Q2 during reconnect");
      expect(await page.locator("#state-word").innerText()).toBe("Ready");
      await page.evaluate(() => window.__home.release());
      await expect.poll(() => page.evaluate(() => window.__home.stops)).toBe(1);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      expect(await line.innerText()).toBe(back);
      expect(await field.inputValue()).toBe("Q2 during reconnect");
      // Answered first, then the turn's end: the same.
      await page.evaluate(() => { window.__home.hold = false; });
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await expect.poll(() => field.inputValue()).toBe("");
      await page.locator("#conversation-stop").click();
      await expect.poll(() => line.innerText()).toBe(back);
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped" }));
      expect(await line.innerText()).toBe(back);
      expect(await field.inputValue()).toBe("Q2 during reconnect");
      // Never over something typed since: above it, and said so (home-v4-2). Never for a message that went: its line has
      // Copy and Edit.
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await expect.poll(() => field.inputValue()).toBe("");
      await field.fill("Something new");
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped-everything" }));
      expect(await line.innerText()).toBe("Stopped everything, running tasks included. Your message wasn't sent, so it's back here, above what you were writing, to edit or send again.");
      expect(await field.inputValue()).toBe("Q2 during reconnect\n\nSomething new");
      await field.fill("Q3");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await page.evaluate(e => window.__home.emit("onConversation", e), [...seed, { t: at(2), who: "you" as const, text: "Q3" }]);
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped" }));
      expect(await line.innerText()).toBe("Response stopped. Running tasks continue.");
      expect(await field.inputValue()).toBe("");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("never gives back a message Ember answered itself, however far the conversation has moved past it (home-v4-1)", async () => {
    const { page, errors } = await home([]);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const field = page.locator("#conversation-message");
      // Answered by Ember itself, with no turn: its line and the answer come after main took the send.
      await field.fill("What are you doing?");
      await page.locator("#conversation-send").click();
      await expect.poll(() => field.inputValue()).toBe("");
      const answered: TranscriptEntry[] = [{ t: at(0), who: "you", text: "What are you doing?" }, { t: at(1), who: "ember", text: "Nothing's running right now." }];
      await page.evaluate(e => window.__home.emit("onConversation", e), answered);
      expect(await line.innerText()).toBe("Reply received.");
      // Then by voice or the Ask box, until main's 60 lines have dropped it.
      const later = [...answered, ...exchange(30, 2)];
      await page.evaluate(e => window.__home.emit("onConversation", e), later);
      await page.evaluate(e => window.__home.emit("onConversation", e), [...later, ...exchange(32, 32)].slice(-60));
      expect(await page.evaluate(() => [...document.querySelectorAll("#conversation li.you p")].some(p => p.textContent === "What are you doing?"))).toBe(false);
      // Stop response while a spoken answer is under way: it stopped that, and gives nothing back.
      await turn(page, "thinking");
      await page.locator("#conversation-stop").click();
      await expect.poll(() => page.evaluate(() => window.__home.stops)).toBe(1);
      await expect.poll(() => line.innerText()).toBe("Response stopped. Running tasks continue.");
      expect(await field.inputValue()).toBe("");
      // Its line came before main answered the send: the same.
      await page.evaluate(() => { window.__home.hold = true; });
      await field.fill("status?");
      await page.locator("#conversation-send").click();
      const status = [...later, ...exchange(32, 32)].slice(-58).concat([{ t: at(70), who: "you", text: "status?" }, { t: at(71), who: "ember", text: "Nothing's running right now." }]);
      await page.evaluate(e => window.__home.emit("onConversation", e), status);
      await page.evaluate(() => { window.__home.hold = false; window.__home.release(); });
      await expect.poll(() => field.inputValue()).toBe("");
      await page.evaluate(e => window.__home.emit("onConversation", e), [...status, ...exchange(60, 72)].slice(-60));
      await page.locator("#conversation-stop").click();
      await expect.poll(() => page.evaluate(() => window.__home.stops)).toBe(2);
      await expect.poll(() => line.innerText()).toBe("Response stopped. Running tasks continue.");
      expect(await field.inputValue()).toBe("");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("gives back every message a Stop dropped before it went, above anything typed since, and says so (home-v4-2)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Q1" }, { t: at(1), who: "ember", text: "A1" }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const field = page.locator("#conversation-message");
      const sendWhileReconnecting = async (text: string) => {
        await field.fill(text);
        await page.locator("#conversation-send").click();
        await turn(page, "thinking");
        await expect.poll(() => field.inputValue()).toBe("");
      };
      // (a) One waits for the reconnect, the next is being written: Stop response.
      await sendWhileReconnecting("Book the meeting room for Friday");
      await field.fill("And tell Sam");
      await page.locator("#conversation-stop").click();
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped" }));
      await expect.poll(() => line.innerText()).toBe("Response stopped. Running tasks continue. Your message wasn't sent, so it's back here, above what you were writing, to edit or send again.");
      expect(await field.inputValue()).toBe("Book the meeting room for Friday\n\nAnd tell Sam");
      expect(await field.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd, el.value.length])).toEqual([46, 46, 46]);
      // While someone types (the caret in the middle of the draft), Stop everything from elsewhere: the caret stays put in it.
      await sendWhileReconnecting("Book the meeting room for Friday");
      await field.fill("And tell Sam");
      await field.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(4, 8); });
      await page.evaluate(() => window.__home.emit("onStopped", "hotkey"));
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped-everything" }));
      expect(await line.innerText()).toBe("Stopped everything, running tasks included. Your message wasn't sent, so it's back here, above what you were writing, to edit or send again.");
      expect(await field.inputValue()).toBe("Book the meeting room for Friday\n\nAnd tell Sam");
      expect(await field.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe("tell");
      // (b) Both sent while it waits: both come back, oldest first.
      await field.fill("");
      await sendWhileReconnecting("Book the meeting room for Friday");
      await sendWhileReconnecting("And tell Sam");
      expect(await page.evaluate(() => window.__home.sent.slice(-2))).toEqual(["Book the meeting room for Friday", "And tell Sam"]);
      await page.locator("#conversation-stop").click();
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped" }));
      await expect.poll(() => line.innerText()).toBe("Response stopped. Running tasks continue. Your 2 messages weren't sent, so they're back here to edit or send again.");
      expect(await field.inputValue()).toBe("Book the meeting room for Friday\n\nAnd tell Sam");
      // Only those that never went: the first went (its line came), the second waited.
      await sendWhileReconnecting("Book the meeting room for Friday");
      await page.evaluate(e => window.__home.emit("onConversation", e), [...seed, { t: at(2), who: "you" as const, text: "Book the meeting room for Friday" }]);
      await sendWhileReconnecting("And tell Sam");
      await page.locator("#conversation-stop").click();
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped" }));
      await expect.poll(() => line.innerText()).toBe("Response stopped. Running tasks continue. Your message wasn't sent, so it's back here to edit or send again.");
      expect(await field.inputValue()).toBe("And tell Sam");
      // One waits, the next was refused (its draft stays), then Stop everything: the first comes back above it too.
      await field.fill("");
      await sendWhileReconnecting("Book the meeting room for Friday");
      const refused = "Reconnecting to Copilot. Your message is still here: send it again in a moment.";
      await page.evaluate(e => { window.__home.sendError = e; }, refused);
      await field.fill("And tell Sam");
      await page.locator("#conversation-send").click();
      await expect.poll(() => line.innerText()).toBe(refused);
      await page.evaluate(() => { window.__home.sendError = undefined; window.__home.emit("onStopped", "hotkey"); });
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped-everything" }));
      expect(await line.innerText()).toBe("Stopped everything, running tasks included. Your message wasn't sent, so it's back here, above what you were writing, to edit or send again.");
      expect(await field.inputValue()).toBe("Book the meeting room for Friday\n\nAnd tell Sam");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  /** How often the composer's line (a role=status region: each write is read out) was written since the last call. */
  const lineWrites = (page: Page) => page.evaluate(() => {
    const w = window as unknown as { __lineWrites?: number };
    if (w.__lineWrites === undefined) {
      w.__lineWrites = 0;
      new MutationObserver(records => { w.__lineWrites = (w.__lineWrites ?? 0) + records.length; }).observe(document.getElementById("conversation-compose-status")!, { childList: true, characterData: true, subtree: true });
    }
    const n = w.__lineWrites;
    w.__lineWrites = 0;
    return n;
  });
  /** Main has answered the composer's send (Send is no longer waiting for it). */
  const sendAnswered = (page: Page) => expect.poll(() => page.locator("#conversation-send").getAttribute("aria-disabled")).toBeNull();

  it("gives back only the waiting message when a typed \"stop\" stops everything, and keeps saying it wasn't sent (home-r4-2)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Q1" }, { t: at(1), who: "ember", text: "A1" }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const field = page.locator("#conversation-message");
      // Held while Ember reconnects (or for a switch of model service): main took it, and no line of it came.
      await field.fill("Book the meeting room for Friday");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await expect.poll(() => field.inputValue()).toBe("");
      // Then "stop" while a task is at work: main keeps it and its answer, stops everything (Home is told at once), and
      // only then answers the send.
      await page.evaluate(() => { window.__home.hold = true; window.__home.sendResult = "stopped"; });
      await field.fill("stop");
      await page.locator("#conversation-send").click();
      await expect.poll(() => page.evaluate(() => window.__home.sent.at(-1))).toBe("stop");
      await lineWrites(page);
      const said: TranscriptEntry[] = [...seed, { t: at(2), who: "you", text: "stop" }, { t: at(3), who: "ember", text: "Okay, I've stopped everything." }];
      await page.evaluate(e => {
        window.__home.emit("onConversation", e.slice(0, 3));
        window.__home.emit("onStopped", "typed");
        window.__home.emit("onConversation", e);
        window.__home.release();
      }, said);
      await sendAnswered(page);
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped-everything" }));
      const back = "Stopped everything, running tasks included. Your message wasn't sent, so it's back here to edit or send again.";
      // The "stop" went (its line is there): only the held message is back, and the line keeps saying so, once.
      expect(await field.inputValue()).toBe("Book the meeting room for Friday");
      expect(await line.innerText()).toBe(back);
      expect(await lineWrites(page)).toBe(1);
      // A message on its way to main as Stop everything (its shortcut) comes, which main takes after it: it went, so only
      // the held one is back.
      await page.evaluate(() => { window.__home.sendResult = undefined; window.__home.hold = false; });
      await field.fill("Order lunch");
      await page.locator("#conversation-send").click();
      await expect.poll(() => field.inputValue()).toBe("");
      await turn(page, "thinking");
      await page.evaluate(() => { window.__home.hold = true; });
      await field.fill("And tell Sam");
      await page.locator("#conversation-send").click();
      await expect.poll(() => page.evaluate(() => window.__home.sent.at(-1))).toBe("And tell Sam");
      await page.evaluate(() => {
        window.__home.emit("onStopped", "hotkey");
        window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped-everything" });
        window.__home.release();
      });
      await sendAnswered(page);
      expect(await field.inputValue()).toBe("Order lunch");
      expect(await line.innerText()).toBe(back);
      await page.evaluate(e => window.__home.emit("onConversation", e), [...said, { t: at(4), who: "you" as const, text: "And tell Sam" }]);
      // One main refused after a Stop gave words back in its place: back under them, unsent.
      await field.fill("");
      await page.evaluate(() => { window.__home.hold = false; });
      await field.fill("Order lunch");
      await page.locator("#conversation-send").click();
      await expect.poll(() => field.inputValue()).toBe("");
      await turn(page, "thinking");
      const refused = "Reconnecting to Copilot. Your message is still here: send it again in a moment.";
      await page.evaluate(e => { window.__home.hold = true; window.__home.sendError = e; }, refused);
      await field.fill("And tell Sam");
      await page.locator("#conversation-send").click();
      await expect.poll(() => page.evaluate(() => window.__home.sent.at(-1))).toBe("And tell Sam");
      await page.evaluate(() => { window.__home.emit("onStopped", "hotkey"); window.__home.release(); });
      await expect.poll(() => line.innerText()).toBe(refused);
      expect(await field.inputValue()).toBe("Order lunch\n\nAnd tell Sam");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("keeps Edit's caution and the words a Stop gave back while I edit, and Cancel edit keeps them (home-r4-1)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Empty the trash" }, { t: at(1), who: "ember", text: "Done." }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const field = page.locator("#conversation-message");
      const waitThenEdit = async (text: string, draft: string) => {
        await field.fill(text);
        await page.locator("#conversation-send").click();
        await turn(page, "thinking");
        await expect.poll(() => field.inputValue()).toBe("");
        await field.fill(draft);
        await page.locator("#conversation li.you").first().getByRole("button", { name: /^Edit your message/ }).click();
        expect(await field.inputValue()).toBe("Empty the trash");
      };
      const stop = async () => {
        await page.locator("#conversation-stop").click();
        await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped" }));
        await expect.poll(() => page.evaluate(() => window.__home.stops)).toBeGreaterThan(0);
        await expect.poll(() => page.locator("#conversation-stop").getAttribute("aria-disabled")).toBeNull();
      };
      // Sent while Ember reconnects, then Edit on an earlier request, then Stop response.
      await waitThenEdit("Book the meeting room for Friday", "");
      await stop();
      expect(await field.inputValue()).toBe("Book the meeting room for Friday\n\nEmpty the trash");
      expect(await line.innerText()).toBe("Response stopped. Running tasks continue. Your message wasn't sent, so it's back here, above the request you're editing. Sending that request again may repeat actions.");
      await page.getByRole("button", { name: "Cancel edit" }).click();
      expect(await field.inputValue()).toBe("Book the meeting room for Friday");
      expect(await line.innerText()).toBe("Edit cancelled. The message that wasn't sent is back here to edit or send again.");
      // With a draft before Edit: it comes back too, under the message.
      await field.fill("");
      await waitThenEdit("Order lunch", "Tell Sam");
      await stop();
      expect(await field.inputValue()).toBe("Order lunch\n\nEmpty the trash");
      await page.getByRole("button", { name: "Cancel edit" }).click();
      expect(await field.inputValue()).toBe("Order lunch\n\nTell Sam");
      expect(await line.innerText()).toBe("Edit cancelled. Your previous draft is restored, below the message that wasn't sent.");
      // The next edit starts afresh: Cancel edit gives back only its own draft.
      await page.locator("#conversation li.you").first().getByRole("button", { name: /^Edit your message/ }).click();
      await page.getByRole("button", { name: "Cancel edit" }).click();
      expect(await field.inputValue()).toBe("Order lunch\n\nTell Sam");
      expect(await line.innerText()).toBe("Edit cancelled. Your previous draft is restored.");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("says a Stop once under Send, however main tells it, and says a new Stop again (home-r4-3)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Q1" }, { t: at(1), who: "ember", text: "A1" }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const field = page.locator("#conversation-message");
      // The turn's end first, then Stop response's own answer: one write.
      const stopEndFirst = async () => {
        await page.evaluate(() => { window.__home.hold = true; });
        await page.locator("#conversation-stop").click();
        await page.evaluate(() => { window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped" }); window.__home.release(); window.__home.hold = false; });
        await expect.poll(() => page.locator("#conversation-stop").getAttribute("aria-disabled")).toBeNull();
      };
      // (a) Its request went to the model (its line came).
      await field.fill("Q2");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await page.evaluate(e => window.__home.emit("onConversation", e), [...seed, { t: at(2), who: "you" as const, text: "Q2" }]);
      await lineWrites(page);
      await stopEndFirst();
      expect(await line.innerText()).toBe("Response stopped. Running tasks continue.");
      expect(await lineWrites(page)).toBe(1);
      // (b) It waited for a reconnect, and its words come back.
      await field.fill("Book the meeting room for Friday");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await expect.poll(() => field.inputValue()).toBe("");
      await lineWrites(page);
      await stopEndFirst();
      expect(await line.innerText()).toBe("Response stopped. Running tasks continue. Your message wasn't sent, so it's back here to edit or send again.");
      expect(await lineWrites(page)).toBe(1);
      // (c) A new Stop, of a spoken answer, with the same words already there: said again.
      await field.fill("");
      await page.locator("#conversation li.ember").first().getByRole("button", { name: /^Copy/ }).click();
      await expect.poll(() => line.innerText()).toBe("Copied message.");
      await turn(page, "thinking");
      await stopEndFirst();
      expect(await line.innerText()).toBe("Response stopped. Running tasks continue.");
      await turn(page, "thinking");
      await lineWrites(page);
      await stopEndFirst();
      expect(await line.innerText()).toBe("Response stopped. Running tasks continue.");
      expect(await lineWrites(page)).toBe(1);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("says when the messages a Stop gave back are together too long to send, and how to send them (home-c4-2)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Q1" }, { t: at(1), who: "ember", text: "A1" }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const field = page.locator("#conversation-message");
      for (const c of ["a", "b"]) {
        await field.fill(c.repeat(1500));
        await page.locator("#conversation-send").click();
        await turn(page, "thinking");
        await expect.poll(() => field.inputValue()).toBe("");
      }
      await lineWrites(page);
      await page.locator("#conversation-stop").click();
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped" }));
      await expect.poll(() => page.locator("#conversation-stop").getAttribute("aria-disabled")).toBeNull();
      expect(await field.inputValue()).toBe(`${"a".repeat(1500)}\n\n${"b".repeat(1500)}`);
      expect(await line.innerText()).toBe("Response stopped. Running tasks continue. Your 2 messages weren't sent, so they're back here. Together they're over 2,000 characters: send them one at a time.");
      expect(await page.locator("#conversation-count").innerText()).toBe("3,002 of 2,000 characters, 1,002 too many.");
      expect(await field.getAttribute("aria-invalid")).toBe("true");
      // Said once: not the over-limit note first, then this.
      expect(await lineWrites(page)).toBe(1);
      // Cut to one that fits: the line no longer says they're over, as the over-limit note goes.
      await field.fill("a".repeat(1500));
      expect(await line.innerText()).toBe("");
      expect(await field.getAttribute("aria-invalid")).toBeNull();
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  /** A message sent while Ember reconnects (it waits), then `draft` typed and Edit on the earlier request, then Stop response. */
  const waitEditStop = async (page: Page, text: string, draft: string) => {
    const field = page.locator("#conversation-message");
    await field.fill(text);
    await page.locator("#conversation-send").click();
    await turn(page, "thinking");
    await expect.poll(() => field.inputValue()).toBe("");
    await field.fill(draft);
    await page.locator("#conversation li.you").first().getByRole("button", { name: /^Edit your message/ }).click();
    await page.locator("#conversation-stop").click();
    await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped" }));
    await expect.poll(() => page.locator("#conversation-stop").getAttribute("aria-disabled")).toBeNull();
  };

  it("keeps the words a Stop gave back as I left them through Cancel edit: corrected, or gone once I deleted them (home-v5-1)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Empty the trash" }, { t: at(1), who: "ember", text: "Done." }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const field = page.locator("#conversation-message");
      const cancel = page.getByRole("button", { name: "Cancel edit" });
      // Deleted, as the person changed their mind: nothing comes back but the draft from before Edit.
      await waitEditStop(page, "Book the meeting room for Friday", "Tell Sam");
      expect(await field.inputValue()).toBe("Book the meeting room for Friday\n\nEmpty the trash");
      await field.fill("Empty the trash");
      await cancel.click();
      expect(await field.inputValue()).toBe("Tell Sam");
      expect(await line.innerText()).toBe("Edit cancelled. Your previous draft is restored.");
      // Only the request being edited changed since: that change goes, as Cancel edit's do, and the message stays.
      await waitEditStop(page, "Book the meeting room for Friday", "Tell Sam");
      await field.fill("Book the meeting room for Friday\n\nEmpty the trash and the bin");
      await cancel.click();
      expect(await field.inputValue()).toBe("Book the meeting room for Friday\n\nTell Sam");
      expect(await line.innerText()).toBe("Edit cancelled. Your previous draft is restored, below the message that wasn't sent.");
      // Both changed: the message's changes stay, and the request's go, as Cancel edit's do (home-w5-4).
      await waitEditStop(page, "Order lunch", "Tell Sam");
      await field.fill("Order lunch for two\n\nEmpty the bin");
      await cancel.click();
      expect(await field.inputValue()).toBe("Order lunch for two\n\nTell Sam");
      expect(await line.innerText()).toBe("Edit cancelled. The message that wasn't sent stays here with your changes, and your previous draft is restored below it.");
      // Corrected, Friday to Saturday: Saturday stays, and the next Send sends it.
      await waitEditStop(page, "Book the meeting room for Friday", "Tell Sam");
      await field.fill("Book the meeting room for Saturday\n\nEmpty the trash");
      await cancel.click();
      expect(await field.inputValue()).toBe("Book the meeting room for Saturday\n\nTell Sam");
      expect(await line.innerText()).toBe("Edit cancelled. The message that wasn't sent stays here with your changes, and your previous draft is restored below it.");
      await page.locator("#conversation-send").click();
      await expect.poll(() => page.evaluate(() => window.__home.sent.at(-1))).toBe("Book the meeting room for Saturday\n\nTell Sam");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("keeps Edit's caution once the words a Stop gave back above my edit fit again (home-v5-2)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Empty the trash" }, { t: at(1), who: "ember", text: "Done." }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const field = page.locator("#conversation-message");
      // A message that fits by itself, over the limit only with the request being edited under it.
      await waitEditStop(page, "b".repeat(1990), "");
      expect(await page.locator("#conversation-count").innerText()).toBe("2,007 of 2,000 characters, 7 too many.");
      expect(await line.innerText()).toBe("Response stopped. Running tasks continue. Your message wasn't sent, so it's back here, above the request you're editing. Together they're over 2,000 characters: send them one at a time. Sending that request again may repeat actions.");
      // Done as told: the message cut out. The edit is still open, and so is its caution.
      await field.fill("Empty the trash");
      expect(await page.getByRole("button", { name: "Cancel edit" }).isVisible()).toBe(true);
      expect(await line.innerText()).toBe("Review this as a new request, then choose Send. Sending again may repeat actions; nothing is sent by choosing Edit.");
      // Over the limit by typing, then back within it, in the same edit: the caution again, not an empty line.
      await field.fill("x".repeat(2001));
      expect(await line.innerText()).toBe("This message is longer than 2,000 characters. Shorten it to send it.");
      await field.fill("Empty the trash");
      expect(await line.innerText()).toBe("Review this as a new request, then choose Send. Sending again may repeat actions; nothing is sent by choosing Edit.");
      // With no edit open, the over-limit note goes as before.
      await page.getByRole("button", { name: "Cancel edit" }).click();
      await field.fill("x".repeat(2001));
      await field.fill("Tell Sam");
      expect(await line.innerText()).toBe("");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("says to shorten what I was writing, not to send one at a time, when it alone is over the limit (home-v5-3)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Q1" }, { t: at(1), who: "ember", text: "A1" }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const field = page.locator("#conversation-message");
      await field.fill("Book the meeting room for Friday");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await expect.poll(() => field.inputValue()).toBe("");
      await field.fill("y".repeat(2300));
      expect(await line.innerText()).toBe("This message is longer than 2,000 characters. Shorten it to send it.");
      await page.locator("#conversation-stop").click();
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped" }));
      await expect.poll(() => page.locator("#conversation-stop").getAttribute("aria-disabled")).toBeNull();
      expect(await field.inputValue()).toBe(`Book the meeting room for Friday\n\n${"y".repeat(2300)}`);
      expect(await line.innerText()).toBe("Response stopped. Running tasks continue. Your message wasn't sent, so it's back here, above what you were writing, which is longer than 2,000 characters: shorten it to send it.");
      // It goes, as the over-limit note does, once what is there fits.
      await field.fill("Book the meeting room for Friday");
      expect(await line.innerText()).toBe("");
      // Above a request being edited that is over by itself: shorten that, and Edit's caution stays.
      await field.fill("Order lunch");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await expect.poll(() => field.inputValue()).toBe("");
      await field.fill("w".repeat(2100));
      await page.locator("#conversation li.you").first().getByRole("button", { name: /^Edit your message/ }).click();
      await field.fill(`Q1 ${"v".repeat(2100)}`);
      await page.locator("#conversation-stop").click();
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped" }));
      await expect.poll(() => page.locator("#conversation-stop").getAttribute("aria-disabled")).toBeNull();
      expect(await line.innerText()).toBe("Response stopped. Running tasks continue. Your message wasn't sent, so it's back here, above the request you're editing, which is longer than 2,000 characters: shorten it to send it. Sending that request again may repeat actions.");
      // Cancel edit: the draft from before Edit comes back under the message, and it alone is over.
      await page.getByRole("button", { name: "Cancel edit" }).click();
      expect(await field.inputValue()).toBe(`Order lunch\n\n${"w".repeat(2100)}`);
      expect(await line.innerText()).toBe("Edit cancelled. Your previous draft is restored, below the message that wasn't sent. That draft is longer than 2,000 characters: shorten it to send it.");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  /** `text` typed with the keyboard over `from`–`to` of the composer (Delete pressed for ""), as a person does. */
  const typeAt = async (page: Page, from: number, text: string, to = from) => {
    const field = page.locator("#conversation-message");
    await field.focus();
    await field.evaluate((el: HTMLTextAreaElement, [a, b]) => el.setSelectionRange(a, b), [from, to]);
    if (text) await page.keyboard.type(text); else await page.keyboard.press("Delete");
  };

  it("never keeps for Cancel edit words I typed into the request I was editing, in front of it or under an emptied one (home-w5-1)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "open Firefox" }, { t: at(1), who: "ember", text: "Done." }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const field = page.locator("#conversation-message");
      const cancel = page.getByRole("button", { name: "Cancel edit" });
      const given = "Book the meeting room for Friday";
      // "Please " put in front of the request, on its own line: it is the request's, and goes with its edit.
      await waitEditStop(page, given, "Tell Sam");
      expect(await field.inputValue()).toBe(`${given}\n\nopen Firefox`);
      await field.fill(`${given}\n\nPlease open Firefox`);
      await cancel.click();
      expect(await field.inputValue()).toBe(`${given}\n\nTell Sam`);
      expect(await line.innerText()).toBe("Edit cancelled. Your previous draft is restored, below the message that wasn't sent.");
      // The same with the keyboard, and the message itself changed at its end: that change stays.
      await waitEditStop(page, given, "Tell Sam");
      await typeAt(page, given.length + 2, "Please ");
      await typeAt(page, given.length, " at 10am");
      expect(await field.inputValue()).toBe(`${given} at 10am\n\nPlease open Firefox`);
      await cancel.click();
      expect(await field.inputValue()).toBe(`${given} at 10am\n\nTell Sam`);
      expect(await line.innerText()).toBe("Edit cancelled. The message that wasn't sent stays here with your changes, and your previous draft is restored below it.");
      // The edit emptied for a fresh request, the message given back, the request typed under it: still the request's.
      await field.fill(given);
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await expect.poll(() => field.inputValue()).toBe("");
      await field.fill("Tell Sam");
      await page.locator("#conversation li.you").first().getByRole("button", { name: /^Edit your message/ }).click();
      await field.fill("");
      await page.locator("#conversation-stop").click();
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped" }));
      await expect.poll(() => field.inputValue()).toBe(given);
      await typeAt(page, given.length, "\n\nDelete my downloads");
      await cancel.click();
      expect(await field.inputValue()).toBe(`${given}\n\nTell Sam`);
      expect(await line.innerText()).toBe("Edit cancelled. Your previous draft is restored, below the message that wasn't sent.");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("keeps nothing of a message I deleted through Cancel edit, however I went on editing, and counts only those left (home-w5-2)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "open Firefox" }, { t: at(1), who: "ember", text: "Done." }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const field = page.locator("#conversation-message");
      const cancel = page.getByRole("button", { name: "Cancel edit" });
      const given = "Book the meeting room for Friday";
      // Deleted, then the request changed: the edit is cancelled, and only the draft from before it comes back.
      await waitEditStop(page, given, "Tell Sam");
      await field.fill("open Firefox and Files");
      await cancel.click();
      expect(await field.inputValue()).toBe("Tell Sam");
      expect(await line.innerText()).toBe("Edit cancelled. Your previous draft is restored.");
      expect(await cancel.isVisible()).toBe(false);
      // The same with the keyboard: the message and its blank line deleted, then the request changed.
      await field.fill("");
      await waitEditStop(page, given, "Tell Sam");
      await typeAt(page, 0, "", given.length + 2);
      await typeAt(page, "open Firefox".length, " and Files");
      await cancel.click();
      expect(await field.inputValue()).toBe("Tell Sam");
      expect(await line.innerText()).toBe("Edit cancelled. Your previous draft is restored.");
      // Two given back and one deleted: one is said to be there, and it is.
      await field.fill("");
      for (const text of ["Order lunch", "Tell Sam I'm late"]) {
        await field.fill(text);
        await page.locator("#conversation-send").click();
        await turn(page, "thinking");
        await expect.poll(() => field.inputValue()).toBe("");
      }
      await page.locator("#conversation li.you").first().getByRole("button", { name: /^Edit your message/ }).click();
      await page.locator("#conversation-stop").click();
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped" }));
      await expect.poll(() => field.inputValue()).toBe("Order lunch\n\nTell Sam I'm late\n\nopen Firefox");
      await field.fill("Order lunch\n\nopen Firefox");
      await cancel.click();
      expect(await field.inputValue()).toBe("Order lunch");
      expect(await line.innerText()).toBe("Edit cancelled. The message that wasn't sent is back here to edit or send again.");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("keeps the words a Stop gave back above my edit through a second Edit, and Cancel edit still names them and their length (home-w5-3)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Empty the trash" }, { t: at(1), who: "ember", text: "Done." }, { t: at(2), who: "you", text: "Open Files" }, { t: at(3), who: "ember", text: "Done." }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const field = page.locator("#conversation-message");
      const cancel = page.getByRole("button", { name: "Cancel edit" });
      const editSecond = () => page.locator("#conversation li.you").nth(1).getByRole("button", { name: /^Edit your message/ }).click();
      // Edit on another request: the message stays above it, still the message that wasn't sent.
      await waitEditStop(page, "Book the meeting room for Friday", "Tell Sam");
      await editSecond();
      expect(await field.inputValue()).toBe("Book the meeting room for Friday\n\nOpen Files");
      expect(await line.innerText()).toBe("Review this as a new request, then choose Send. The message that wasn't sent stays above it. Sending again may repeat actions; nothing is sent by choosing Edit.");
      await cancel.click();
      expect(await field.inputValue()).toBe("Book the meeting room for Friday\n\nTell Sam");
      expect(await line.innerText()).toBe("Edit cancelled. Your previous draft is restored, below the message that wasn't sent.");
      // Over the limit with the request a second Edit puts under it, and then with the draft: said each time.
      await field.fill("");
      await waitEditStop(page, "b".repeat(1990), "Tell Sam now");
      await editSecond();
      expect(await field.inputValue()).toBe(`${"b".repeat(1990)}\n\nOpen Files`);
      expect(await line.innerText()).toBe("Review this as a new request, then choose Send. The message that wasn't sent stays above it. Together they're over 2,000 characters: send them one at a time. Sending again may repeat actions; nothing is sent by choosing Edit.");
      await cancel.click();
      expect(await field.inputValue()).toBe(`${"b".repeat(1990)}\n\nTell Sam now`);
      expect(await page.locator("#conversation-count").innerText()).toBe("2,004 of 2,000 characters, 4 too many.");
      expect(await line.innerText()).toBe("Edit cancelled. Your previous draft is restored, below the message that wasn't sent. Together they're over 2,000 characters: send them one at a time.");
      // Corrected before the second Edit: the correction comes along, and Cancel edit says it stays with it.
      await field.fill("");
      await waitEditStop(page, "Order lunch", "");
      await typeAt(page, "Order lunch".length, " for two");
      await editSecond();
      expect(await field.inputValue()).toBe("Order lunch for two\n\nOpen Files");
      await cancel.click();
      expect(await field.inputValue()).toBe("Order lunch for two");
      expect(await line.innerText()).toBe("Edit cancelled. The message that wasn't sent stays here with your changes, to edit or send again.");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("never leaves the request I edited in the composer after Cancel edit, though I changed it and the words above it (home-w5-4)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Empty the trash" }, { t: at(1), who: "ember", text: "Done." }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const field = page.locator("#conversation-message");
      const cancel = page.getByRole("button", { name: "Cancel edit" });
      await waitEditStop(page, "b".repeat(1990), "Tell Sam I'm late");
      await field.fill(`${"b".repeat(1989)}c\n\nEmpty the trash now`);
      await cancel.click();
      // The message's change stays, over the limit with the draft; the request's goes, and with it the need to caution.
      expect(await field.inputValue()).toBe(`${"b".repeat(1989)}c\n\nTell Sam I'm late`);
      expect(await cancel.isVisible()).toBe(false);
      expect(await line.innerText()).toBe("Edit cancelled. The message that wasn't sent stays here with your changes, and your previous draft is restored below it. Together they're over 2,000 characters: send them one at a time.");
      // Trimmed as told: the line goes, and no request of an edit is left behind to send again.
      await field.fill("Tell Sam I'm late");
      expect(await line.innerText()).toBe("");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("says Ember is thinking in the status panel while it answers the Ask box or a spoken request (home-c1-1)", async () => {
    const { page, errors } = await home([]);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      await expect.poll(() => page.locator("#state-word").innerText()).toBe("Ready");
      await turn(page, "thinking");
      expect(await page.locator("#state-word").innerText()).toBe("Thinking…");
      // The composer's line is about what was sent from it: nothing was.
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("");
      await turn(page, "slow");
      expect(await page.locator("#state-word").innerText()).toBe("Thinking…");
      await turn(page, "idle");
      expect(await page.locator("#state-word").innerText()).toBe("Ready");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("says the reply failed when its Problem line came before its end, never a reply that didn't begin, and that Stop ended it when the bubble's Stop or Stop everything did (home-r2-1, home-c2-2, reliability-performance-c1-1)", async () => {
    const { page, errors } = await home([]);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      // A model error: main sends the Problem line, then the turn's end (home-r2-1).
      await page.locator("#conversation-message").fill("What's the weather?");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      const failed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "What's the weather?" }, { t: at(1), who: "problem", text: "The model service reported a problem. Try again." }];
      await page.evaluate(e => window.__home.emit("onConversation", e), failed);
      await turn(page, "idle");
      // No reply began (the model service refused it): it couldn't answer, not "finish this reply" (reliability-performance-c1-1).
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("This request got no answer. Review the message above; you can edit your request and send again.");
      // A reply that began, then stopped short with a Problem line: that reply couldn't finish.
      await page.locator("#conversation-message").fill("And the wind?");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      const in1 = (s: number) => new Date(Date.UTC(2026, 10, 7, 9, 1, s)).toISOString();
      const cut: TranscriptEntry[] = [...failed, { t: in1(20), who: "you", text: "And the wind?" }, { t: in1(30), who: "ember", text: "The wind is", stopped: true }, { t: in1(40), who: "problem", text: "My model connection stopped unexpectedly. Try again." }];
      await page.evaluate(e => window.__home.emit("onConversation", e), cut);
      await turn(page, "idle");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("This reply couldn't be finished. Review the message above; you can edit your request and send again.");
      // The bubble's own Stop on a stalled reply: no line comes, main says Stop ended it.
      await page.locator("#conversation-message").fill("And tomorrow?");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      const asked = [...cut, { t: at(2), who: "you" as const, text: "And tomorrow?" }];
      await page.evaluate(e => window.__home.emit("onConversation", e), asked);
      await turn(page, "slow");
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped" }));
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Response stopped. Running tasks continue.");
      expect(await page.locator("#state-word").innerText()).toBe("Ready");
      // Stop everything ends it with everything else.
      await page.locator("#conversation-message").fill("And the weekend?");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await page.evaluate(e => window.__home.emit("onConversation", e), [...asked, { t: at(3), who: "you" as const, text: "And the weekend?" }]);
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle", ended: "stopped-everything" }));
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Stopped everything, running tasks included.");
      // The next turn's own end says what its lines show, not the Stop before it.
      await page.locator("#conversation-message").fill("Thanks");
      await page.locator("#conversation-send").click();
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "thinking" }));
      await reply(page, [...asked, { t: at(3), who: "you" as const, text: "And the weekend?" }], "Thanks", 9);
      await page.evaluate(() => window.__home.emit("onConversationTurn", { turn: "idle" }));
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Reply received.");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("says where to look on a Problem line that settings can help with, and goes there (home-7)", async () => {
    const seed: TranscriptEntry[] = [
      { t: at(0), who: "you", text: "What's the weather?" },
      { t: at(1), who: "problem", text: "The model service reported a problem. Try again; if it keeps happening, check the model service in Ember's settings (Ctrl+Alt+E)." },
      { t: at(2), who: "you", text: "And now?" },
      { t: at(3), who: "problem", text: "Copilot had a problem on its side. Try again in a moment." },
    ];
    const { page, errors } = await home(seed);
    try {
      const rows = page.locator("#conversation > li.problem");
      await expect.poll(() => rows.count()).toBe(2);
      expect(await rows.nth(0).locator("p").innerText()).toBe("The model service reported a problem. Try again; if it keeps happening, check the model service in Models & connections.");
      // Only where settings can help.
      expect(await rows.nth(1).locator("button").count()).toBe(0);
      // Found by the words it shows.
      await page.locator("#conversation-search").fill("Models & connections");
      expect(await page.locator("#conversation-search-status").innerText()).toBe("1 matching message in this conversation.");
      await page.locator("#conversation-search").fill("");
      const go = rows.nth(0).getByRole("button", { name: /^Models & connections…/ });
      expect(await go.innerText()).toBe("Models & connections…");
      await go.click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("copilot-h");
      expect(await page.locator("#copilot-h").isVisible()).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("offers Models & connections on the line that says to press Check again there, never on one for my administrator (home-r3-2, accessibility-visual-c3-2)", async () => {
    const seed: TranscriptEntry[] = [
      { t: at(0), who: "you", text: "What's the weather?" },
      { t: at(1), who: "problem", text: "Your organisation's model service refused the request. Ask your administrator to check Ember's model service settings." },
      { t: at(2), who: "you", text: "And now?" },
      { t: at(3), who: "problem", text: "My model connection stopped unexpectedly and keeps stopping, so I've stopped reconnecting. Press Check again in Models & connections to try once more, or restart me." },
    ];
    const { page, errors } = await home(seed);
    try {
      const rows = page.locator("#conversation > li.problem");
      await expect.poll(() => rows.count()).toBe(2);
      // The administrator's setting: nothing here to press.
      expect(await rows.nth(0).locator("button").count()).toBe(0);
      // Check again is there: the way to it, from the keyboard, lands with a ring on the section's heading.
      const go = rows.nth(1).getByRole("button", { name: /^Models & connections…/ });
      await go.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("copilot-h");
      expect(await page.evaluate(() => document.activeElement?.matches(":focus-visible"))).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("says under Stop response that Ember is still waiting for a request from the Ask box or by voice, not an older message's outcome (home-r2-3)", async () => {
    const { page, errors } = await home([]);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      await page.locator("#conversation-message").fill("What's the weather?");
      await page.locator("#conversation-send").click();
      await turn(page, "thinking");
      await reply(page, [], "What's the weather?", 2);
      await turn(page, "idle");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Reply received.");
      // Asked in the Ask box, and the bubble says Ember is still waiting: so does the line under Stop response.
      await turn(page, "thinking");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Reply received.");
      await turn(page, "slow");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Still waiting for Copilot… Stop response ends this reply.");
      // Heard from again, or over: the line goes, rather than say a wait that has ended.
      await turn(page, "thinking");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("");
      await turn(page, "slow");
      await turn(page, "idle");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("keeps Edit's caution and the over-limit note under the draft while a request from the Ask box or by voice waits (home-c3-1)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Empty the trash" }, { t: at(1), who: "ember", text: "Done." }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const caution = "Review this as a new request, then choose Send. Sending again may repeat actions; nothing is sent by choosing Edit.";
      await page.getByRole("button", { name: /^Edit your message/ }).click();
      expect(await line.innerText()).toBe(caution);
      // Asked in the Ask box meanwhile, and the bubble says Ember is still waiting: the caution about the edited draft stays.
      await turn(page, "thinking");
      await turn(page, "slow");
      expect(await line.innerText()).toBe(caution);
      expect(await page.locator("#state-word").innerText()).toBe("Thinking…");
      await page.evaluate(() => window.__home.emit("onConversationStream", { id: 4, text: "Sure", state: "streaming" }));
      const answered = [...seed, { t: at(2), who: "you" as const, text: "Is it sunny?" }, { t: at(3), who: "ember" as const, text: "Sure", answerId: 4 }];
      await page.evaluate(e => window.__home.emit("onConversation", e), answered);
      await page.evaluate(() => window.__home.emit("onConversationStream", { id: 4, text: "", state: "done" }));
      await turn(page, "idle");
      expect(await line.innerText()).toBe(caution);
      expect(await page.locator("#conversation-message").inputValue()).toBe("Empty the trash");
      // Over the limit: the note stays through another wait, and the count with it.
      await page.locator("#conversation-message").fill("x".repeat(2100));
      const over = "This message is longer than 2,000 characters. Shorten it to send it.";
      expect(await line.innerText()).toBe(over);
      await turn(page, "thinking");
      await turn(page, "slow");
      await turn(page, "idle");
      expect(await line.innerText()).toBe(over);
      expect(await page.locator("#conversation-count").innerText()).toBe("2,100 of 2,000 characters, 100 too many.");
      // An older message's outcome still gives way to the wait, which goes with it (home-r2-3).
      await page.locator("#conversation-message").fill("Short");
      await page.getByRole("button", { name: "Cancel edit" }).click();
      expect(await line.innerText()).toBe("Edit cancelled. Your previous draft is restored.");
      await turn(page, "thinking");
      await turn(page, "slow");
      expect(await line.innerText()).toBe("Still waiting for Copilot… Stop response ends this reply.");
      // Written to at last: the line doesn't say the composer's "Thinking…", which no message of its own waits for.
      await page.evaluate(() => window.__home.emit("onConversationStream", { id: 5, text: "Here", state: "streaming" }));
      expect(await line.innerText()).not.toBe("Thinking… The reply will appear above.");
      await turn(page, "idle");
      expect(await line.innerText()).toBe("");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("keeps the line saying how the request is going in view under the buttons after a reply, at 760×640 (home-7)", async () => {
    const seed = exchange(12);
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      await page.locator("#conversation-message").focus();
      await page.keyboard.type("What should I do next?");
      await page.keyboard.press("Control+Enter");
      await turn(page, "thinking");
      const after = await reply(page, seed, "What should I do next?", 7);
      await turn(page, "idle");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Reply received.");
      const status = await rect(page, "#conversation-compose-status");
      expect(status.top).toBeGreaterThanOrEqual(0);
      expect(status.bottom).toBeLessThanOrEqual(status.height);
      // Right under the buttons, before their footnotes.
      const send = await rect(page, "#conversation-send");
      expect(status.top - send.bottom).toBeLessThan(24);
      // The next request's wait, and its still-waiting line, show too.
      await page.keyboard.type("And after that?");
      await page.keyboard.press("Control+Enter");
      await turn(page, "thinking");
      await page.evaluate(e => window.__home.emit("onConversation", e), [...after, { t: at(after.length), who: "you", text: "And after that?" }]);
      await turn(page, "slow");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Still waiting for Copilot… Stop response ends this reply.");
      const waiting = await rect(page, "#conversation-compose-status");
      expect(waiting.top).toBeGreaterThanOrEqual(0);
      expect(waiting.bottom).toBeLessThanOrEqual(waiting.height);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("brings the line under Send into view when it says why a send was refused, that a send is waiting, or how a Stop ended it, at 760×640 (home-c3-2)", async () => {
    const seed = exchange(12);
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const inView = async () => { const r = await rect(page, "#conversation-compose-status"); return r.top >= 0 && r.bottom <= r.height; };
      // Send's foot at the window's foot, as a reply leaves it: the line under it starts below the window.
      const sendAtBottom = () => page.evaluate(() => { window.scrollBy(0, document.getElementById("conversation-send")!.getBoundingClientRect().bottom - innerHeight); });
      await page.locator("#conversation-message").focus();
      await page.keyboard.type("What should I do next?");
      await page.keyboard.press("Control+Enter");
      await turn(page, "thinking");
      const after = await reply(page, seed, "What should I do next?", 7);
      await turn(page, "idle");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Reply received.");
      // Refused while Ember can't reach the model service: what to do is the line's second half, and it shows.
      const refused = "The model service can't be reached right now. Your message is still here: send it again once you're online.";
      await page.evaluate(e => { window.__home.sendError = e; }, refused);
      await page.keyboard.type("Q2 while offline");
      await page.keyboard.press("Control+Enter");
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe(refused);
      expect(await inView()).toBe(true);
      expect(await page.locator("#conversation-message").inputValue()).toBe("Q2 while offline");
      // Ember connects again: the line no longer says it can't be reached, and the message is still there (reliability-c7-2).
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), { ...READY, phase: "error", reason: "network", detail: "Can't reach the model service." });
      expect(await page.locator("#conversation-compose-status").innerText()).toBe(refused);
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Connected again. Your message is still here: send it now.");
      expect(await inView()).toBe(true);
      expect(await page.locator("#conversation-message").inputValue()).toBe("Q2 while offline");
      // The runtime drops again before the message is sent: the line no longer says to send it now (reliability-x7-1),
      // and the next reconnect doesn't bring it back (nothing was refused since).
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), { ...READY, phase: "error", reason: "runtime", detail: "Copilot stopped unexpectedly. Reconnecting…" });
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("");
      expect(await page.locator("#conversation-message").inputValue()).toBe("Q2 while offline");
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("");
      // A send refused for a locked screen keeps its reason when the connection comes back: connecting doesn't unlock it.
      const locked = "Unlock your screen before sending a request.";
      await page.evaluate(e => { window.__home.sendError = e; }, locked);
      await page.keyboard.press("Control+Enter");
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe(locked);
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), { ...READY, phase: "error", reason: "network", detail: "Can't reach the model service." });
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      expect(await page.locator("#conversation-compose-status").innerText()).toBe(locked);
      // A message copied, then a request from the Ask box came and went, leaving the line empty; then a send that waits for
      // a reconnect (no line of its own yet): its "Thinking…" shows, and so does how Stop everything ended it.
      await page.evaluate(() => { window.__home.sendError = undefined; });
      await page.locator("#conversation-message").fill("");
      await page.locator("#conversation li.ember").last().getByRole("button", { name: /^Copy/ }).click();
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Copied message.");
      await turn(page, "slow");
      await turn(page, "idle");
      await page.evaluate(e => window.__home.emit("onConversation", e), after);
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("");
      await sendAtBottom();
      await page.locator("#conversation-message").focus();
      await page.keyboard.type("Q3 during reconnect");
      await page.keyboard.press("Control+Enter");
      await turn(page, "thinking");
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Thinking… The reply will appear above.");
      expect(await inView()).toBe(true);
      await page.evaluate(() => window.__home.emit("onStopped", "hotkey"));
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Stopped everything, running tasks included. Your message wasn't sent, so it's back here to edit or send again.");
      expect(await inView()).toBe(true);
      // Stop response's own outcome, said under it.
      await page.locator("#conversation-message").fill("");
      await page.keyboard.type("Q4");
      await page.keyboard.press("Control+Enter");
      await turn(page, "thinking");
      await sendAtBottom();
      await page.locator("#conversation-stop").focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Response stopped. Running tasks continue. Your message wasn't sent, so it's back here to edit or send again.");
      expect(await inView()).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("says nothing was stopped when Stop response is pressed with no reply under way, and that it stopped when one was (home-3, accessibility-visual-8)", async () => {
    const { page, errors } = await home([]);
    try {
      await page.evaluate(() => { window.__home.stopResult = false; });
      await page.locator("#conversation-stop").click();
      await expect.poll(() => page.evaluate(() => window.__home.stops)).toBe(1);
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Nothing is being answered right now, so there was nothing to stop.");
      await page.evaluate(() => { window.__home.stopResult = true; });
      await page.locator("#conversation-stop").click();
      await expect.poll(() => page.locator("#conversation-compose-status").innerText()).toBe("Response stopped. Running tasks continue.");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("asks before New conversation clears the messages, keeps them on Keep or Escape, and skips the question when there are none (home-9)", async () => {
    const { page, errors } = await home(exchange(12));
    try {
      const confirm = page.locator("#conversation-new-confirm");
      await page.locator("#conversation-new").click();
      expect(await confirm.isVisible()).toBe(true);
      expect(await page.locator("#conversation-new-question").innerText()).toBe("Start a new conversation? This clears the 12 messages here.");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("conversation-new-no");
      expect(await page.evaluate(() => window.__home.news)).toBe(0);
      await page.locator("#conversation-new-no").click();
      expect(await confirm.isHidden()).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("conversation-new");
      // From the keyboard: Enter opens it, Escape keeps the conversation.
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("conversation-new-no");
      await page.keyboard.press("Escape");
      expect(await confirm.isHidden()).toBe(true);
      expect(await page.evaluate(() => [window.__home.news, document.activeElement?.id])).toEqual([0, "conversation-new"]);
      // Start a new conversation: once, and the composer has the focus as before.
      await page.locator("#conversation-new").click();
      await page.locator("#conversation-new-yes").click();
      await expect.poll(() => page.evaluate(() => window.__home.news)).toBe(1);
      await expect.poll(() => page.locator("#conversation > li").count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("conversation-message");
      // Nothing to clear: no question.
      await page.locator("#conversation-new").click();
      await expect.poll(() => page.evaluate(() => window.__home.news)).toBe(2);
      expect(await confirm.isHidden()).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("puts back the draft Edit set aside once the edited request is sent, and says so (home-c5-1)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Empty the trash" }, { t: at(1), who: "ember", text: "Done." }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const line = page.locator("#conversation-compose-status");
      const field = page.locator("#conversation-message");
      const cancel = page.getByRole("button", { name: "Cancel edit" });
      const edit = page.locator("#conversation li.you").first().getByRole("button", { name: /^Edit your message/ });
      await field.fill("My long unsent draft about holidays");
      await edit.click();
      await page.locator("#conversation-send").click();
      await expect.poll(() => page.evaluate(() => window.__home.sent)).toEqual(["Empty the trash"]);
      await expect.poll(() => field.inputValue()).toBe("My long unsent draft about holidays");
      expect(await line.innerText()).toBe("Thinking… The reply will appear above. Your previous draft is restored.");
      expect(await cancel.isHidden()).toBe(true);
      // The wait's lines still follow main's word of the turn, and the reply's line ends it as ever.
      await turn(page, "slow");
      await turn(page, "thinking");
      expect(await line.innerText()).toBe("Thinking… The reply will appear above.");
      await page.evaluate(e => window.__home.emit("onConversation", e), [...seed, { t: at(2), who: "you", text: "Empty the trash" }, { t: at(3), who: "ember", text: "Done again." }]);
      await turn(page, "idle");
      await expect.poll(() => line.innerText()).toBe("Reply received.");
      expect(await field.inputValue()).toBe("My long unsent draft about holidays");
      // No draft before Edit: nothing comes back, and nothing is said of one.
      await field.fill("");
      await edit.click();
      await page.locator("#conversation-send").click();
      await expect.poll(() => page.evaluate(() => window.__home.sent.length)).toBe(2);
      await expect.poll(() => line.innerText()).toBe("Thinking… The reply will appear above.");
      expect(await field.inputValue()).toBe("");
      expect(await cancel.isHidden()).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("keeps Cancel edit when I choose Edit while an earlier send is still being acknowledged, and never brings the sent words back as a draft (home-c7-2)", async () => {
    const seed: TranscriptEntry[] = [{ t: at(0), who: "you", text: "Empty the trash" }, { t: at(1), who: "ember", text: "Done." }];
    const { page, errors } = await home(seed);
    try {
      await page.evaluate(s => window.__home.emit("onAgentStatus", s), READY);
      const field = page.locator("#conversation-message");
      const cancel = page.getByRole("button", { name: "Cancel edit" });
      await page.evaluate(() => { window.__home.hold = true; });
      await field.fill("Order lunch");
      await page.locator("#conversation-send").click();
      await expect.poll(() => page.evaluate(() => window.__home.sent)).toEqual(["Order lunch"]);
      await page.locator("#conversation li.you").first().getByRole("button", { name: /^Edit your message/ }).click();
      expect(await field.inputValue()).toBe("Empty the trash");
      await page.evaluate(() => { window.__home.release(); window.__home.hold = false; });
      await expect.poll(() => page.locator("#conversation-send").getAttribute("aria-disabled")).toBeNull();
      // The edit is still open: its request is in the field and Cancel edit is there.
      expect(await field.inputValue()).toBe("Empty the trash");
      expect(await cancel.isVisible()).toBe(true);
      // "Order lunch" was sent: it is not the draft from before Edit.
      await cancel.click();
      expect(await field.inputValue()).toBe("");
      expect(await cancel.isHidden()).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("says Copied on a message's Copy, where the eye is, and names no ⌘ in the composer's hint on Linux (home-11)", async () => {
    const { page, errors } = await home(exchange(2));
    try {
      await page.clock.install();
      const copy = page.locator("#conversation li.ember").getByRole("button", { name: /Copy Ember's answer/ });
      await copy.click();
      await expect.poll(() => copy.innerText()).toBe("Copied");
      expect(await page.locator("#conversation-compose-status").innerText()).toBe("Copied message.");
      await page.clock.runFor(2_100);
      expect(await copy.innerText()).toBe("Copy");
      expect(await page.evaluate(() => window.__home.copied)).toEqual([exchange(2)[1].text]);
      expect(await page.locator("#conversation-send-hint").innerText()).toBe("Up to 2,000 characters. Enter adds a new line. Ctrl+Enter sends.");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
});
