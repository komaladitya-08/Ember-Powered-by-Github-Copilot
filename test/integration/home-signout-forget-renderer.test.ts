/** Built Home in Chromium: Sign out and Forget everything ask first, with live counts, and Esc or cancel call nothing. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../app/main/settings";

declare global { interface Window { __calls: string[]; __counts: { tasks: number; facts: number; reminders: number; routines: number }; __mode: { memory: "ok" | "reject" | "locked" | "hang" | "manual"; signOutHangs: boolean; routinesUnreadable?: boolean; routinesDefer?: boolean }; __pend: ((v: unknown) => void)[]; __emit: (name: string, value: unknown) => void; __release: () => void } }

it.skipIf(process.env.EMBER_SIGNOUT_FORGET_TEST !== "1")("asks before Sign out and Forget everything, shows live counts, and cancels cleanly", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.onboarded = true; settings.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
  settings.memory = { ...settings.memory, on: true, consent: { version: 99, at: "2026-11-04T12:00:00Z" } };
  const status = { appVersion: "0.1.1", settings, environment: { checks: [], versions: { node: "24", electron: "44", chrome: "152" } }, logFile: "/test/ember.log", settingsNotice: null,
    admin: { source: null, error: null, managed: [], features: {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [] } };
  const browser = await chromium.launch({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const dist = path.resolve("dist");
  const server = http.createServer((req, res) => {
    const file = path.resolve(dist, `.${decodeURIComponent((req.url ?? "/").split("?")[0])}`);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
    res.setHeader("content-type", mime[path.extname(file)] ?? "application/octet-stream");
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(seed => {
      window.__calls = []; window.__pend = []; window.__counts = { tasks: 3, facts: 4, reminders: 2, routines: 1 };
      const rows = () => Array.from({ length: window.__counts.facts }, (_, i) => ({ id: `f${i}`, text: `Fact ${i}`, source: "user", at: "2026-11-04" }));
      window.__mode = { memory: "ok", signOutHangs: false };
      const subs: Record<string, ((v: unknown) => void)[]> = {};
      // Complete payloads only: a throwing subscriber fails the test instead of being swallowed.
      window.__emit = (name, value) => { for (const fn of subs[name] ?? []) fn(value); };
      window.ember = new Proxy({}, { get: (_t, name: string) => {
        if (name.startsWith("on")) return (fn: (v: unknown) => void) => { (subs[name] ??= []).push(fn); return () => undefined; };
        if (name === "getStatus") return async () => seed.status;
        // The finished one is never counted, whatever the number asked for.
        if (name === "tasks") return async () => [...["running", "waiting", "queued"].slice(0, window.__counts.tasks).map((status, i) => ({ id: `t${i}`, status })), { id: "done", status: "done" }];
        if (name === "memory") return () => {
          if (window.__mode.memory === "reject") return Promise.reject(new Error("boom"));
          if (window.__mode.memory === "manual") return new Promise(resolve => { const held = rows(); window.__release = () => resolve({ rows: held, ownership: "ready" }); });
          if (window.__mode.memory === "hang") return new Promise(() => undefined);
          // Locked memory deliberately returns no rows even when some are stored.
          if (window.__mode.memory === "locked") return Promise.resolve({ rows: [], ownership: "locked" });
          return Promise.resolve({ rows: rows(), ownership: "ready" });
        };
        if (name === "reminders") return async () => Array.from({ length: window.__counts.reminders }, (_, i) => ({ id: `r${i}`, text: "x", at: 1, created: 1, kept: false }));
        if (name === "routines") return async () => Array.from({ length: window.__counts.routines }, (_, i) => ({ id: `n${i}`, name: "n", steps: [] }));
        if (name === "routinesCount") return () => window.__mode.routinesDefer ? new Promise(resolve => { window.__pend.push(resolve); }) : Promise.resolve(window.__mode.routinesUnreadable ? { known: false } : { known: true, n: window.__counts.routines });
        if (name === "signOut") return () => { window.__calls.push("signOut"); return window.__mode.signOutHangs ? new Promise(() => undefined) : Promise.resolve(); };
        if (name === "updateSettings") return (patch: unknown) => { window.__calls.push(`updateSettings:${JSON.stringify(patch)}`); return new Promise(() => undefined); };
        if (name === "forgetAllMemory") return async () => { window.__calls.push("forgetAll"); };
        return () => new Promise(() => undefined);
      } }) as never;
    }, { status });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn't start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await page.evaluate(() => {
      document.body.classList.remove("loading", "first-run");
      (document.getElementById("sign-out") as HTMLElement).hidden = false;
      (document.getElementById("memory-forget-all") as HTMLElement).hidden = false;
    });
    await page.locator('a[href="#copilot-h"]').click();
    const calls = () => page.evaluate(() => window.__calls);
    const focusedId = () => page.evaluate(() => document.activeElement?.id);

    // Sign out: opens with live counts, Esc changes nothing, focus returns.
    await page.locator("#sign-out").click();
    await expect.poll(() => page.locator("#sign-out-confirm").isVisible()).toBe(true);
    expect(await page.locator("#sign-out-scope").innerText()).toBe("Sign out? This stops 3 tasks that are running or waiting, and clears this conversation (and the copy saved on this computer, if you keep one), 4 saved facts, 2 reminders and 1 routine.");
    expect(await focusedId()).toBe("sign-out-no");
    await page.keyboard.press("Escape");
    expect(await page.locator("#sign-out-confirm").isHidden()).toBe(true);
    expect(await focusedId()).toBe("sign-out");
    expect(await calls()).toEqual([]);

    // Counts are read again on each open; Cancel button also changes nothing.
    await page.evaluate(() => { window.__counts = { tasks: 0, facts: 1, reminders: 0, routines: 0 }; });
    await page.locator("#sign-out").click();
    await expect.poll(() => page.locator("#sign-out-scope").innerText()).toContain("0 tasks");
    await page.locator("#sign-out-no").click();
    expect(await focusedId()).toBe("sign-out");
    expect(await calls()).toEqual([]);

    // Confirm runs the existing path.
    await page.locator("#sign-out").click();
    await page.locator("#sign-out-yes").click();
    expect(await page.locator("#sign-out-confirm").isHidden()).toBe(true);
    await expect.poll(calls).toEqual(["signOut"]);
    expect(await focusedId()).toBe("sign-out");
    // Completion hides the opener (as main.ts does when the account goes); focus must land on Sign in, not nowhere (review #5).
    await page.evaluate(() => { (document.getElementById("sign-out") as HTMLElement).hidden = true; (document.getElementById("sign-in") as HTMLElement).hidden = false; });
    await expect.poll(focusedId).toBe("sign-in");
    await page.evaluate(() => { (document.getElementById("sign-out") as HTMLElement).hidden = false; (document.getElementById("sign-in") as HTMLElement).hidden = true; });

    // Forget everything.
    await page.locator('a[href="#memory-h"]').click();
    await page.evaluate(() => { window.__counts = { tasks: 2, facts: 4, reminders: 2, routines: 1 }; });
    await page.locator("#memory-forget-all").click();
    await expect.poll(() => page.locator("#forget-all-confirm").isVisible()).toBe(true);
    expect(await page.locator("#forget-all-scope").innerText()).toBe("Forget everything? This removes 4 saved facts, what Ember learned from them and the conversation saved on this computer, if you keep one. 2 tasks, 2 reminders and 1 routine stay as they are, and so do the lines on screen now, but they aren't saved again.");
    await page.keyboard.press("Escape");
    expect(await focusedId()).toBe("memory-forget-all");
    expect(await calls()).toEqual(["signOut"]);
    // The Cancel button (Keep saved memory) also calls nothing.
    await page.locator("#memory-forget-all").click();
    await expect.poll(() => page.locator("#forget-all-scope").innerText()).toContain("4 saved facts");
    expect(await page.locator("#forget-all-no").innerText()).toBe("Keep saved memory");
    await page.locator("#forget-all-no").click();
    expect(await page.locator("#forget-all-confirm").isHidden()).toBe(true);
    expect(await focusedId()).toBe("memory-forget-all");
    expect(await calls()).toEqual(["signOut"]);
    await page.locator("#memory-forget-all").click();
    await expect.poll(() => page.locator("#forget-all-yes").isEnabled()).toBe(true);
    await page.locator("#forget-all-yes").click();
    await expect.poll(calls).toEqual(["signOut", "forgetAll"]);
    expect(await focusedId()).toBe("memory-forget-all");
    // The memory switch is where focus goes if the button goes with the last fact.
    await page.evaluate(() => { (document.getElementById("memory-forget-all") as HTMLElement).hidden = true; });
    await expect.poll(focusedId).toBe("memory-on");
    await page.evaluate(() => { (document.getElementById("memory-forget-all") as HTMLElement).hidden = false; });

    // A failed read is unknown, not "0 saved facts"; Cancel is focused straight away.
    await page.evaluate(() => { window.__mode.memory = "reject"; });
    await page.locator("#memory-forget-all").click();
    expect(await focusedId()).toBe("forget-all-no");
    await expect.poll(() => page.locator("#forget-all-scope").innerText()).toContain("an unknown number of saved facts");
    expect(await page.locator("#forget-all-scope").innerText()).not.toContain("0 saved facts");
    expect(await page.locator("#forget-all-confirm").getAttribute("role")).toBe("alertdialog");
    expect(await page.locator("#forget-all-confirm").getAttribute("aria-modal")).toBe("true");
    await page.keyboard.press("Escape");

    // An unreadable routines book (EACCES) is unknown, never "0 routines"; a genuinely empty one is still 0.
    await page.evaluate(() => { window.__mode.memory = "ok"; window.__mode.routinesUnreadable = true; window.__counts.routines = 0; });
    await page.locator("#memory-forget-all").click();
    await expect.poll(() => page.locator("#forget-all-yes").isDisabled()).toBe(false);
    expect(await page.locator("#forget-all-scope").innerText()).not.toMatch(/\b0 routines/);
    expect(await page.locator("#forget-all-scope").innerText()).toContain("an unknown number of routines");
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.__mode.routinesUnreadable = false; });
    await page.locator("#memory-forget-all").click();
    await expect.poll(() => page.locator("#forget-all-yes").isDisabled()).toBe(false);
    expect(await page.locator("#forget-all-scope").innerText()).not.toContain("unknown number of routines");
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.__counts.routines = 1; });

    // Locked memory (no rows, owner not ready) is unknown too.
    await page.evaluate(() => { window.__mode.memory = "locked"; });
    await page.locator("#memory-forget-all").click();
    await expect.poll(() => page.locator("#forget-all-scope").innerText()).toContain("an unknown number of saved facts");
    await page.keyboard.press("Escape");

    // A hung read doesn't block the panel: loading shows at once, Esc works then, and the read times out to unknown.
    await page.evaluate(() => { window.__mode.memory = "hang"; });
    await page.locator("#memory-forget-all").click();
    expect(await page.locator("#forget-all-confirm").isVisible()).toBe(true);
    expect(await page.locator("#forget-all-scope").innerText()).toBe("Checking what this affects…");
    expect(await page.locator("#forget-all-yes").isDisabled()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.locator("#forget-all-confirm").isHidden()).toBe(true);
    await page.locator("#memory-forget-all").click();
    await expect.poll(() => page.locator("#forget-all-scope").innerText(), { timeout: 8000 }).toContain("an unknown number of saved facts");
    // Tab stays inside the dialog.
    for (let i = 0; i < 4; i++) { await page.keyboard.press("Tab"); expect(await page.evaluate(() => !!document.activeElement?.closest("#forget-all-confirm"))).toBe(true); }
    await page.keyboard.press("Escape");

    // Counts that change while it is open refresh, and Confirm acts on what is shown.
    await page.evaluate(() => { window.__mode.memory = "ok"; window.__counts = { tasks: 0, facts: 4, reminders: 0, routines: 0 }; });
    await page.locator("#memory-forget-all").click();
    await expect.poll(() => page.locator("#forget-all-scope").innerText()).toContain("4 saved facts");
    await page.evaluate(() => window.__emit("onMemory", { rows: Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, text: "x", source: "user", at: "2026-11-04" })), ownership: "ready" }));
    await expect.poll(() => page.locator("#forget-all-scope").innerText()).toContain("8 saved facts");
    await page.evaluate(() => window.__emit("onTasks", [{ id: "a", title: "A", status: "running", activity: { startedAt: 1, items: [], dropped: 0, steps: 0, failedSteps: 0, counts: {}, questions: 0, approvals: 0, asking: false, retry: 0, slow: false, nearLimit: false, live: "", note: "" } }]));
    await expect.poll(() => page.locator("#forget-all-scope").innerText()).toContain("1 task, 0 reminders");
    await page.keyboard.press("Escape");

    // P2-1: the page behind an open question is inert, so a pointer can't reach the sidebar or the memory switch.
    await page.evaluate(() => { window.__mode.memory = "ok"; window.__counts = { tasks: 0, facts: 2, reminders: 0, routines: 0 }; window.__calls.length = 0; });
    await page.locator('a[href="#memory-h"]').click();
    await page.locator("#memory-forget-all").click();
    await expect.poll(() => page.locator("#forget-all-yes").isEnabled()).toBe(true);
    const clickAt = async (sel: string) => { const b = (await page.locator(sel).boundingBox())!; await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };
    await clickAt('a[href="#copilot-h"]');
    await clickAt("#memory-on");
    expect(await page.locator("#forget-all-confirm").isVisible()).toBe(true);
    expect(await calls()).toEqual([]);
    expect(await page.evaluate(() => document.getElementById("memory-on")!.closest("[inert]") !== null)).toBe(true);
    await page.keyboard.press("Escape"); // the key handler is still attached, not orphaned
    expect(await page.locator("#forget-all-confirm").isHidden()).toBe(true);
    expect(await page.evaluate(() => document.querySelectorAll("[inert]").length)).toBe(0);
    // Inert is gone again after closing: a trial click (which hit-tests, without clicking) reaches the switch.
    await page.locator("#memory-on").click({ trial: true, timeout: 3000 });

    // Hidden from outside: nothing stays inert.
    await page.locator("#memory-forget-all").click();
    await page.evaluate(() => { (document.getElementById("forget-all-confirm") as HTMLElement).hidden = true; });
    await expect.poll(() => page.evaluate(() => document.querySelectorAll("[inert]").length)).toBe(0);

    // P2-2: the last fact goes (a real onMemory push) while the question is up; Cancel lands on the memory switch.
    await page.locator("#memory-forget-all").click();
    await page.evaluate(() => window.__emit("onMemory", { rows: [], ownership: "ready" }));
    await expect.poll(() => page.locator("#memory-forget-all").isHidden()).toBe(true);
    await page.locator("#forget-all-no").click();
    expect(await focusedId()).toBe("memory-on");
    await page.evaluate(() => window.__emit("onMemory", { rows: [{ id: "z", text: "x", source: "user", at: "2026-11-04" }], ownership: "ready" }));
    await expect.poll(() => page.locator("#memory-forget-all").isVisible()).toBe(true);
    await page.locator("#memory-forget-all").click();
    await page.evaluate(() => window.__emit("onMemory", { rows: [], ownership: "ready" }));
    await page.keyboard.press("Escape");
    expect(await focusedId()).toBe("memory-on");
    await page.evaluate(() => window.__emit("onMemory", { rows: [{ id: "z", text: "x", source: "user", at: "2026-11-04" }], ownership: "ready" }));

    // Managed memory: its switch is disabled, so Cancel after the last fact goes lands on an enabled, visible control or the heading.
    await page.evaluate(() => { (document.getElementById("memory-on") as HTMLInputElement).disabled = true; });
    await page.locator("#memory-forget-all").click();
    await page.evaluate(() => window.__emit("onMemory", { rows: [], ownership: "ready" }));
    await expect.poll(() => page.locator("#memory-forget-all").isHidden()).toBe(true);
    await page.locator("#forget-all-no").click();
    const landed = await page.evaluate(() => { const a = document.activeElement as HTMLElement; return { id: a.id, body: a === document.body, disabled: !!(a as HTMLInputElement).disabled, visible: a.checkVisibility() }; });
    expect(landed).toEqual({ id: "memory-h", body: false, disabled: false, visible: true });
    await page.evaluate(() => { (document.getElementById("memory-on") as HTMLInputElement).disabled = false; window.__emit("onMemory", { rows: [{ id: "z", text: "x", source: "user", at: "2026-11-04" }], ownership: "ready" }); });
    await expect.poll(() => page.locator("#memory-forget-all").isVisible()).toBe(true);

    // Main moves Home to another pane (onFocusSection) while a question is up: it closes, nothing stays inert, Tab is free.
    await page.locator("#memory-forget-all").click();
    await expect.poll(() => page.locator("#forget-all-yes").isEnabled()).toBe(true);
    await page.evaluate(() => window.__emit("onFocusSection", "copilot"));
    expect(await page.locator("#forget-all-confirm").isHidden()).toBe(true);
    expect(await page.evaluate(() => document.querySelectorAll("[inert]").length)).toBe(0);
    expect(await focusedId()).toBe("copilot-h");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe("forget-all-no");
    expect(await page.evaluate(() => !!document.activeElement?.closest("#forget-all-confirm"))).toBe(false);
    await page.locator('a[href="#memory-h"]').click();

    // A slow read that answers after a newer push doesn't overwrite it.
    await page.evaluate(() => { window.__mode.memory = "manual"; window.__counts.facts = 2; });
    await page.locator("#memory-forget-all").click();
    await page.evaluate(() => window.__emit("onMemory", { rows: Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, text: "x", source: "user", at: "2026-11-04" })), ownership: "ready" }));
    await page.evaluate(() => window.__release());
    await page.evaluate(() => window.__emit("onTasks", [])); // let the stale answer land first
    await expect.poll(() => page.locator("#forget-all-scope").innerText()).toContain("7 saved facts");
    await page.waitForTimeout(200);
    expect(await page.locator("#forget-all-scope").innerText()).toContain("7 saved facts");

    // Reminder and routine changes while it is open update the text.
    await page.evaluate(() => {
      window.__counts.routines = 2; // a pushed list only invalidates; the strict re-read supplies the number
      window.__emit("onReminders", [{ id: "r1", text: "a", at: 1, created: 1, kept: false }, { id: "r2", text: "b", at: 2, created: 1, kept: false }, { id: "r3", text: "c", at: 3, created: 1, kept: false }]);
      window.__emit("onRoutines", [{ id: "n1", name: "n", steps: [] }, { id: "n2", name: "m", steps: [] }]);
    });
    await expect.poll(() => page.locator("#forget-all-scope").innerText()).toContain("3 reminders and 2 routines");
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.__mode.memory = "ok"; });

    // #182 round 4: a push of routines is only an invalidation. Policy turns routines off and main broadcasts [], which
    // must never read as "0 routines" while three are stored; the fresh strict read decides what shows.
    await page.evaluate(() => { window.__mode.memory = "ok"; window.__mode.routinesDefer = true; window.__counts = { tasks: 0, facts: 1, reminders: 0, routines: 3 }; });
    const dialogs = [
      { pane: "#copilot-h", open: "#sign-out", box: "#sign-out-confirm", scope: "#sign-out-scope", yes: "#sign-out-yes", no: "#sign-out-no" },
      { pane: "#memory-h", open: "#memory-forget-all", box: "#forget-all-confirm", scope: "#forget-all-scope", yes: "#forget-all-yes", no: "#forget-all-no" },
    ];
    const pending = () => page.evaluate(() => window.__pend.length);
    const answer = (i: number, v: unknown) => page.evaluate(([n, val]) => window.__pend[n as number]!(val), [i, v] as const);
    for (const d of dialogs) {
      const text = () => page.locator(d.scope).innerText();
      const settle = async () => { await page.waitForTimeout(150); };
      const openFresh = async () => {
        await page.evaluate(() => { window.__pend = []; });
        await page.locator(`a[href="${d.pane}"]`).click();
        await page.locator(d.open).click();
        await expect.poll(pending).toBe(1);
      };
      // Count loaded as 3, then [] is pushed: loading (Confirm off), then the re-read's 3, never 0.
      await openFresh();
      await answer(0, { known: true, n: 3 });
      await expect.poll(text).toContain("3 routines");
      await page.evaluate(() => window.__emit("onRoutines", []));
      await expect.poll(pending).toBe(2);
      expect(await text()).toBe("Checking what this affects…");
      expect(await page.locator(d.yes).isDisabled()).toBe(true);
      await answer(1, { known: true, n: 3 });
      await expect.poll(text).toContain("3 routines");
      expect(await text()).not.toMatch(/\b0 routines/);
      expect(await page.locator(d.yes).isDisabled()).toBe(false);
      await page.keyboard.press("Escape");
      // [] pushed while the first read is in flight: the older answer is dropped, the newer one shows.
      await openFresh();
      await page.evaluate(() => window.__emit("onRoutines", []));
      await expect.poll(pending).toBe(2);
      await answer(0, { known: true, n: 3 });
      await settle();
      expect(await text()).toBe("Checking what this affects…");
      expect(await page.locator(d.yes).isDisabled()).toBe(true);
      await answer(1, { known: true, n: 3 });
      await expect.poll(text).toContain("3 routines");
      expect(await text()).not.toMatch(/\b0 routines/);
      await page.keyboard.press("Escape");
      // Unknown, then [] pushed: the re-read decides, and unknown stays unknown.
      await openFresh();
      await answer(0, { known: false });
      await expect.poll(text).toContain("an unknown number of routines");
      await page.evaluate(() => window.__emit("onRoutines", []));
      await expect.poll(pending).toBe(2);
      expect(await page.locator(d.yes).isDisabled()).toBe(true);
      await answer(1, { known: false });
      await expect.poll(text).toContain("an unknown number of routines");
      expect(await text()).not.toMatch(/\b0 routines/);
      await page.keyboard.press("Escape");
    }
    await page.evaluate(() => { window.__mode.routinesDefer = false; });

    // Sign out twice while the first is pending makes one call.
    await page.locator('a[href="#copilot-h"]').click();
    await page.evaluate(() => { window.__mode.signOutHangs = true; window.__calls.length = 0; });
    await page.locator("#sign-out").click();
    await expect.poll(() => page.locator("#sign-out-yes").isEnabled()).toBe(true);
    await page.locator("#sign-out-yes").click();
    await page.locator("#sign-out").click();
    expect(await page.locator("#sign-out-confirm").isHidden()).toBe(true);
    expect(await calls()).toEqual(["signOut"]);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}, 60_000);
