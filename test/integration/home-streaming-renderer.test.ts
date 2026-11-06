/** Built Home in Chromium: the answer row that grows while Ember writes, settles once and keeps what an interruption cut short from the transcript. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import type { EmberHomeApi } from "../../app/shared/ipc";
import type { AnswerStream, TranscriptEntry } from "../../app/main/agent/host";

declare global {
  interface Window {
    __streamTest: { push(entries: TranscriptEntry[]): void; stream(e: AnswerStream): void; forget(): void; resolveInitial(entries: TranscriptEntry[]): void };
    __rowMark?: Element | null;
  }
}

const at = (i: number) => new Date(Date.UTC(2026, 10, 6, 10, i)).toISOString();

it.skipIf(process.env.EMBER_CONVERSATION_TEST !== "1")("shows one answer row that grows in place, settles without a duplicate and keeps an interrupted answer after a reload", async () => {
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
    await page.addInitScript(() => {
      const listeners: Record<string, Set<(value: unknown) => void>> = {};
      const emit = (name: string, value: unknown) => { for (const listener of listeners[name] ?? []) listener(value); };
      let initial: ((e: TranscriptEntry[]) => void) | null = null;
      window.__streamTest = {
        push: v => emit("onConversation", v), stream: e => emit("onConversationStream", e), forget: () => emit("onConversationForgotten", undefined),
        resolveInitial: e => { initial?.(e); initial = null; },
      };
      window.ember = new Proxy({}, { get: (_t, name: string) => {
        if (name.startsWith("on")) return (fn: (value: unknown) => void) => { (listeners[name] ??= new Set()).add(fn); return () => { listeners[name]?.delete(fn); }; };
        if (name === "conversation") return () => new Promise<TranscriptEntry[]>(resolve => { initial = resolve; });
        if (name === "reminders") return async () => [];
        return () => new Promise(() => undefined);
      } }) as EmberHomeApi;
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn’t start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await page.evaluate(() => { document.body.classList.remove("loading", "first-run"); });
    const you: TranscriptEntry = { t: at(0), who: "you", text: "Explain it" };
    await page.evaluate(e => { window.__streamTest.resolveInitial([e]); }, you);
    await expect.poll(() => page.locator("#conversation li").count()).toBe(1);
    const rows = page.locator("#conversation li");
    const answer = page.locator("#conversation li[data-stream-id]");

    // Words come: one row appears, and the same element grows.
    await page.evaluate(() => window.__streamTest.stream({ id: 1, text: "Here is", state: "streaming" }));
    await expect.poll(() => answer.count()).toBe(1);
    await page.evaluate(() => { window.__rowMark = document.querySelector("#conversation li[data-stream-id]"); });
    await page.evaluate(() => window.__streamTest.stream({ id: 1, text: "Here is the start of", state: "streaming" }));
    await page.evaluate(() => window.__streamTest.stream({ id: 1, text: "Here is the start of an answer", state: "streaming" }));
    expect(await answer.locator("p").innerText()).toBe("Here is the start of an answer");
    expect(await page.evaluate(() => window.__rowMark === document.querySelector("#conversation li[data-stream-id]"))).toBe(true);
    expect(await rows.count()).toBe(2);
    expect(await answer.getAttribute("aria-busy")).toBe("true");
    // Not a live region of its own: nothing is read word by word.
    expect(await page.locator("#conversation").evaluate(el => el.closest("[aria-live]") === null && !el.hasAttribute("aria-live"))).toBe(true);

    // Completion: the transcript's answer replaces it; exactly one answer row with the final text.
    const final: TranscriptEntry = { t: at(1), who: "ember", text: "Here is the start of an answer. And its end." };
    await page.evaluate(e => window.__streamTest.push(e), [you, final]);
    await page.evaluate(() => window.__streamTest.stream({ id: 1, text: "Here is the start of an answer. And its end.", state: "done" }));
    await expect.poll(() => rows.count()).toBe(2);
    expect(await answer.count()).toBe(0);
    expect(await page.locator("#conversation li.ember p").allInnerTexts()).toEqual([final.text]);
    // A replay of the same transcript and a late word of that answer add nothing.
    await page.evaluate(e => window.__streamTest.push(e), [you, final]);
    await page.evaluate(() => window.__streamTest.stream({ id: 1, text: "Here is the start of an answer. And its end. extra", state: "streaming" }));
    expect(await rows.count()).toBe(2);
    expect(await answer.count()).toBe(0);

    // Interruption: the host keeps the words as a stopped entry; the row only bridges until it arrives, then one row.
    await page.evaluate(() => window.__streamTest.stream({ id: 2, text: "Half of a thou", state: "streaming" }));
    await page.evaluate(() => window.__streamTest.stream({ id: 2, text: "Half of a thou", state: "interrupted" }));
    expect(await answer.locator("p").innerText()).toBe("Half of a thou");
    expect(await answer.locator("small").innerText()).toBe("Stopped before it finished");
    expect(await answer.getAttribute("aria-busy")).toBeNull();
    const stopped: TranscriptEntry = { t: at(2), who: "ember", text: "Half of a thou", stopped: true };
    const problem: TranscriptEntry = { t: at(3), who: "problem", text: "I lost the connection." };
    await page.evaluate(e => window.__streamTest.push(e), [you, final, stopped]);
    await expect.poll(() => answer.count()).toBe(0);
    expect(await page.locator("#conversation li").count()).toBe(3);
    await page.evaluate(e => window.__streamTest.push(e), [you, final, stopped, problem]);
    await expect.poll(() => page.locator("#conversation li").count()).toBe(4);
    const shown = async () => ({
      texts: await page.locator("#conversation li p").allInnerTexts(), notes: await page.locator("#conversation li small").allInnerTexts(),
      streaming: await answer.count(),
    });
    const expected = { texts: ["Explain it", final.text, "Half of a thou", "I lost the connection."], notes: ["Stopped before it finished"], streaming: 0 };
    expect(await shown()).toEqual(expected);
    await page.evaluate(e => window.__streamTest.push(e), [you, final, stopped, problem]);
    expect(await shown()).toEqual(expected);

    // Reopened Home (a fresh page with the host's snapshot, before any stream event): the same single stopped row.
    await page.reload();
    await page.evaluate(() => { document.body.classList.remove("loading", "first-run"); });
    await page.evaluate(e => { window.__streamTest.resolveInitial(e); }, [you, final, stopped, problem]);
    await expect.poll(() => page.locator("#conversation li").count()).toBe(4);
    expect(await shown()).toEqual(expected);
    // The interrupted event of that answer reaching a reopened Home late adds no second row.
    await page.evaluate(() => window.__streamTest.stream({ id: 2, text: "Half of a thou", state: "interrupted" }));
    expect(await page.locator("#conversation li").count()).toBe(4);
    await page.evaluate(e => window.__streamTest.push(e), [you, final, stopped, problem]);
    expect(await shown()).toEqual(expected);

    // Reset: nothing is left, and a late word of the old answer doesn't bring a row back.
    await page.evaluate(() => window.__streamTest.stream({ id: 3, text: "Words before the reset", state: "streaming" }));
    expect(await answer.count()).toBe(1);
    await page.evaluate(() => { window.__streamTest.forget(); });
    await expect.poll(() => rows.count()).toBe(0);
    await page.evaluate(() => window.__streamTest.stream({ id: 3, text: "Words before the reset, late", state: "streaming" }));
    expect(await rows.count()).toBe(0);
    await page.evaluate(() => window.__streamTest.stream({ id: 4, text: "A new answer", state: "streaming" }));
    await expect.poll(() => rows.count()).toBe(1);
    // A new conversation (the list emptied without "forgotten") clears it as well.
    await page.evaluate(() => window.__streamTest.push([]));
    await expect.poll(() => rows.count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 60_000);
