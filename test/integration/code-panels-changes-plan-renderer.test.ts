/**
 * The coding window's Changes and Plan tabs in Chromium, as a person uses them (docs/CODING-APP.md §4): the session's
 * diff by file in each mode, with whitespace ignored, read again on a workspace file's change and when a turn ends;
 * line comments chosen by the keyboard, collected in the Review strip, edited, removed and sent as one message; git
 * actions sent as messages (queued while a turn runs); rewinding with its preview and its warning, refused while a
 * turn runs, after which the window attaches again; and the Plan tab's plan, to-dos, Autopilot objective and the
 * exit-plan-mode request's own card, with the tab's mark. Only the preload boundary is replaced: window.emberCode is
 * test/fixtures/code-window/fake-api.js. Runs with EMBER_UIUX_TEST=1 after `npm run build`.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { COMMANDS_NOT_UNDONE } from "../../app/renderer/code/copy-changes";

interface Panels { params: { method: string; sessionId?: string; params: Record<string, unknown> | null }[]; fail: Record<string, string> }
/** The fake's handle (test/fixtures/code-window/fake-api.js), typed here only: the window journey declares its own. */
interface W {
  __fake: {
    calls: string[]; panels: Panels;
    emit(sid: string, type: string, data: unknown, extra?: Record<string, unknown>): void;
    request(sid: string, kind: string, requestId: string, data: unknown): void;
    setRow(sid: string, change: Record<string, unknown>): void;
  };
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

async function open(session: string, tab: "Changes" | "Plan", viewport = { width: 1280, height: 900 }): Promise<Page & { errors: string[] }> {
  const page = await browser.newPage({ viewport }) as Page & { errors: string[] };
  page.errors = [];
  page.on("pageerror", e => page.errors.push(e.message));
  await page.addInitScript({ path: FAKE });
  await page.goto(`http://127.0.0.1:${port}/app/renderer/code/index.html`);
  await page.locator(`.s-open[data-session='${session}']`).click();
  await page.locator("#composer-text").waitFor();
  await page.getByRole("button", { name: "Show panel" }).click();
  await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
  return page;
}
const calls = (p: Page) => p.evaluate(() => (window as unknown as W).__fake.calls);
const params = (p: Page, method: string) => p.evaluate(m => (window as unknown as W).__fake.panels.params.filter(x => x.method === m).map(x => x.params), method);
const count = async (p: Page, method: string) => (await params(p, method)).length;
const focused = (p: Page) => p.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "");

describe.skipIf(gate)("the Changes tab", () => {
  it("shows the session's diff by file in each mode, reads it again when it changes, and says why it couldn't", async () => {
    const page = await open("s-login", "Changes");
    const heads = page.locator(".ch-file-head");
    await expect.poll(() => heads.evaluateAll(els => els.map(e => e.getAttribute("aria-label")))).toEqual([
      "src/login.ts: changed, 3 lines added, 1 removed", "src/oauth.ts: added, 4 lines added, 0 removed",
      "docs/redirects.md: renamed, from docs/old.md, 0 lines added, 0 removed", "src/util.ts: changed, 1 line added, 1 removed",
    ]);
    expect(await params(page, "workspaces.diff")).toEqual([{ mode: "session" }]);
    await expect.poll(() => page.locator(".ch-count").textContent()).toBe("4 files changed: 8 lines added, 2 removed.");
    // Collapsed per file; the arrow keys move between files; a file opens to its lines, with signs and numbers.
    expect(await heads.first().getAttribute("aria-expanded")).toBe("false");
    await heads.first().focus();
    await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toContain("src/oauth.ts");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect.poll(() => heads.first().getAttribute("aria-expanded")).toBe("true");
    const lines = page.locator(".ch-lines").first();
    expect(await lines.getAttribute("role")).toBe("listbox");
    expect(await lines.locator("[role='option']:not([aria-disabled])").evaluateAll(els => els.map(e => e.getAttribute("aria-label")))).toEqual([
      "Unchanged, line 40:   await session.start(req, user);", "Removed, line 41:   const redirectTo = \"/\";",
      "Added, line 41:   const next = typeof req.query.next === \"string\" ? req.query.next : \"/\";",
      "Added, line 42:   // Only a path on this site: never another host.",
      "Added, line 43:   const redirectTo = next.startsWith(\"/\") && !next.startsWith(\"//\") ? next : \"/\";",
      "Unchanged, line 44:   res.redirect(redirectTo);", "Unchanged, line 45: }",
    ]);
    expect(await lines.locator(".d-del .d-sign").first().textContent()).toBe("−");
    // The modes, by the arrow keys in their radio group; whitespace ignored.
    await page.getByRole("radio", { name: "This session" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => page.getByRole("radio", { name: "Uncommitted" }).getAttribute("aria-checked")).toBe("true");
    await expect.poll(() => heads.allTextContents()).toEqual(["src/login.tsChanged+3 −1", "test/login.test.tsChanged+3 −0"]);
    await page.getByRole("radio", { name: "Against the branch" }).click();
    await expect.poll(() => page.locator(".ch-summary").innerText()).toContain("Compared with “main”.");
    await page.locator(".ch-file-head", { hasText: "vendor/huge.js" }).click();
    await expect.poll(() => page.locator(".ch-file-body").last().innerText()).toBe("This file's diff is too large to show here.");
    await page.getByRole("radio", { name: "This session" }).click();
    await page.getByRole("switch", { name: "Ignore whitespace" }).check();
    await expect.poll(() => heads.count()).toBe(3);
    expect((await params(page, "workspaces.diff")).at(-1)).toEqual({ mode: "session", ignoreWhitespace: true });
    expect((await params(page, "workspaces.diff")).map(p => p?.mode)).toEqual(["session", "unstaged", "branch", "session", "session"]);
    // A workspace file's change, in a burst, reads the diff again once.
    const before = await count(page, "workspaces.diff");
    await page.evaluate(() => { for (let i = 0; i < 4; i++) (window as unknown as W).__fake.emit("s-login", "session.workspace_file_changed", { operation: "update", path: "src/login.ts" }, { ephemeral: true }); });
    await expect.poll(() => count(page, "workspaces.diff")).toBe(before + 1);
    await page.waitForTimeout(600);
    expect(await count(page, "workspaces.diff")).toBe(before + 1);
    // A turn ends: read again.
    await page.evaluate(() => (window as unknown as W).__fake.setRow("s-login", { busy: true }));
    await page.evaluate(() => (window as unknown as W).__fake.setRow("s-login", { busy: false }));
    await expect.poll(() => count(page, "workspaces.diff")).toBe(before + 2);
    // Refused: Ember's sentence, then main's.
    await page.evaluate(() => { (window as unknown as W).__fake.panels.fail["workspaces.diff"] = "That session isn't open. Open it again first."; });
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect.poll(() => page.locator(".ch-summary .pt-problem").textContent()).toBe("Ember couldn't read the changes. That session isn't open. Open it again first.");
    expect(page.errors).toEqual([]);
  });

  it("collects line comments chosen by the keyboard in a review, and sends them to Copilot as one message", async () => {
    const page = await open("s-login", "Changes");
    await page.locator(".ch-file-head").first().click();
    const lines = page.locator(".ch-lines").first();
    await lines.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    expect(await lines.locator("[aria-selected='true']").count()).toBe(3);
    expect(await page.locator(".ch-file-foot button").textContent()).toBe("Comment on lines 41–43…");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
    expect(await page.locator(".ch-comment .pt-form-title").textContent()).toBe("Comment on src/login.ts, lines 41–43");
    // Empty: says so, adds nothing.
    await page.getByRole("button", { name: "Add to review" }).click();
    expect(await page.locator(".ch-comment .pt-problem").textContent()).toBe("Write a comment first.");
    await page.keyboard.type("Keep the old fallback when next is missing.");
    await page.getByRole("button", { name: "Add to review" }).click();
    await expect.poll(() => page.locator(".ch-review .tag").textContent()).toBe("1 comment");
    expect(await focused(page)).toContain("Lines of src/login.ts");
    // A removed line, by the pointer.
    await lines.locator(".d-del").click();
    await page.getByRole("button", { name: "Comment on removed line 41…" }).click();
    await page.keyboard.type("Why was this removed?");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Add to review" }).click();
    await expect.poll(() => page.locator(".ch-rc-where").allTextContents()).toEqual(["src/login.ts, lines 41–43", "src/login.ts, removed line 41"]);
    // Edit one, remove the other.
    await page.getByRole("button", { name: "Edit the comment on src/login.ts, lines 41–43" }).click();
    await page.locator(".ch-review textarea").fill("Keep the fallback to / when next is missing.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => page.locator(".ch-rc-text").first().textContent()).toBe("Keep the fallback to / when next is missing.");
    await page.getByRole("button", { name: "Remove the comment on src/login.ts, removed line 41" }).click();
    await expect.poll(() => page.locator(".ch-review .tag").textContent()).toBe("1 comment");
    // Send: one message, structured, with no attachment.
    await page.getByRole("button", { name: "Send to Copilot" }).click();
    await expect.poll(async () => (await calls(page)).some(c => c.startsWith("send:s-login:-:Please address my review comments"))).toBe(true);
    const sent = (await calls(page)).find(c => c.startsWith("send:s-login:-:Please address"))!;
    expect(sent).toContain("1. src/login.ts, lines 41–43\n```diff\n+  const next = typeof req.query.next");
    expect(sent).toContain("Comment: Keep the fallback to / when next is missing.");
    expect(sent).not.toMatch(/:\+\d+$/);
    await expect.poll(() => page.locator(".ch-review-host").innerText()).toBe("Review sent to Copilot.");

    // The turn now runs: a git action waits in the queue, and a rewind is refused.
    await expect.poll(() => page.evaluate(() => document.querySelector("#composer-working")?.textContent ?? "")).not.toBe("");
    await page.getByRole("button", { name: "Commit…" }).click();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("ch-commit-msg");
    await page.keyboard.type("Return people to where they were");
    await page.getByRole("button", { name: "Ask Copilot to commit" }).click();
    await expect.poll(async () => (await calls(page)).some(c => c.startsWith("send:s-login:enqueue:Please commit the current changes in this repository with this commit message:\n\nReturn people to where they were"))).toBe(true);
    await expect.poll(() => page.locator("#ch-git-h ~ .pt-body .pt-note").textContent()).toBe("Queued for Copilot: it reads it when the turn ends.");
    await page.getByRole("button", { name: /^Rewind to before your message/ }).first().click();
    await expect.poll(() => page.locator(".rw-confirm").innerText()).toContain("Stop the turn first: Ember can't rewind while Copilot is working.");
    expect(await page.getByRole("button", { name: "Rewind", exact: true }).isDisabled()).toBe(true);
    expect(page.errors).toEqual([]);
  });

  it("rewinds after a preview and a plain warning, and the window draws the conversation again", async () => {
    const page = await open("s-login", "Changes");
    const points = page.getByRole("button", { name: /^Rewind to before your message/ });
    await expect.poll(() => points.count()).toBe(1);
    expect(await points.first().getAttribute("aria-label")).toContain("Why does signing in send people back");
    await points.first().click();
    await expect.poll(() => page.locator(".rw-files li").allInnerTexts()).toEqual(["src/login.ts\nPut back as it was, +3 −1", "src/oauth.ts\nRemoved again (Copilot made it), +4 −0"]);
    expect(await page.locator(".rw-warn").textContent()).toBe(COMMANDS_NOT_UNDONE);
    expect(await page.getByRole("radio", { name: "Conversation only" }).isChecked()).toBe(true);
    // Escape backs off, to the point's button.
    await page.getByRole("radio", { name: "Conversation only" }).focus();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".rw-confirm").count()).toBe(0);
    expect(await focused(page)).toContain("Rewind to before your message");
    await points.first().click();
    await page.getByRole("radio", { name: "Conversation and files" }).check();
    const attachesBefore = (await calls(page)).filter(c => c === "attach:s-login").length;
    await page.getByRole("button", { name: "Rewind", exact: true }).click();
    await expect.poll(() => params(page, "history.rewind")).toEqual([{ eventId: expect.any(String), mode: "conversation-and-files" }]);
    await expect.poll(() => page.locator("[data-key='rewind-note']").textContent()).toBe("Rewound. 2 files were put back. 1 file was left as it is: you changed it since, or Copilot didn't keep how it was.");
    // The window attaches again for the whole kept history, which no longer holds the message.
    await expect.poll(async () => (await calls(page)).filter(c => c === "attach:s-login").length).toBeGreaterThan(attachesBefore);
    await expect.poll(() => page.locator("#transcript").innerText()).not.toContain("Why does signing in send people back");
    await expect.poll(() => page.locator(".ch-files-host").innerText()).toBe("Copilot hasn't changed any files in this session yet.");
    await expect.poll(() => page.locator("#ch-rewind-h ~ .pt-body").innerText()).toContain("There's nothing to rewind to yet.");
    expect(page.errors).toEqual([]);
  });

  it("says when the session's own changes and rewinding aren't available, and why", async () => {
    const page = await open("s-vitest", "Changes");
    await expect.poll(() => page.locator(".ch-summary .pt-note").textContent()).toBe("This session didn't track its file changes from its first turn, so its own changes and rewinding files aren't available. Showing uncommitted changes instead.");
    await expect.poll(() => page.locator(".ch-file-head").count()).toBe(1);
    await expect.poll(() => page.locator("#ch-rewind-h ~ .pt-body .pt-note").textContent()).toBe("This session didn't track its file changes from its first turn, so it can't be rewound here.");
    // Push is a message to Copilot, said so beside it.
    expect(await page.getByRole("button", { name: "Push" }).getAttribute("aria-describedby")).toBe("ch-git-hint");
    await page.getByRole("button", { name: "Push" }).click();
    await expect.poll(async () => (await calls(page)).some(c => c.startsWith("send:s-vitest:-:Please push the current branch"))).toBe(true);
    expect(page.errors).toEqual([]);
  });

  it("fits the panel at its narrowest in a 720 px window, with nothing scrolling sideways", async () => {
    const page = await open("s-login", "Changes", { width: 720, height: 700 });
    await page.evaluate(() => (window as unknown as { __emberCode: { app: { setUi(p: object): void } } }).__emberCode.app.setUi({ panelWidth: 260 }));
    await page.locator(".ch-file-head").first().click();
    await page.locator(".ch-lines").first().waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator("#panel-body").evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await page.getByRole("tab", { name: /^Plan/ }).click();
    await page.locator(".pl-todo").first().waitFor();
    expect(await page.locator("#panel-body").evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    expect(page.errors).toEqual([]);
  });
});

describe.skipIf(gate)("the Plan tab", () => {
  it("shows the plan, edits, saves and deletes it, and reads it again when Copilot changes it", async () => {
    const page = await open("s-login", "Plan");
    const doc = page.getByRole("document", { name: "The plan" });
    await expect.poll(() => doc.locator("li").allTextContents()).toEqual(["Read next in the login handler", "Do the same in src/oauth.ts", "Add tests for both, including one that tries another host", "Keep the old behaviour for a missing next"]);
    expect(await doc.locator("strong").textContent()).toBe("one that tries another host");
    await page.getByRole("button", { name: "Edit" }).first().click();
    const editor = page.getByLabel("The plan, in Markdown");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("pl-editor");
    // Copilot changes it while it is being edited: said, and the edit kept.
    await editor.fill("## Plan\n\n1. Only the login form\n");
    await page.evaluate(() => { ((window as unknown as W).__fake.panels as unknown as { plans: Map<string, string> }).plans.set("s-login", "## Plan\n\n1. Copilot's own change\n"); (window as unknown as W).__fake.emit("s-login", "session.plan_changed", { operation: "update" }); });
    await expect.poll(() => page.locator("#pl-plan-h ~ .pt-body .pt-note").textContent()).toBe("Copilot changed the plan while you were editing it. Saving puts your version in its place.");
    expect(await editor.inputValue()).toBe("## Plan\n\n1. Only the login form\n");
    await page.getByRole("button", { name: "Save plan" }).click();
    await expect.poll(() => params(page, "plan.update")).toEqual([{ content: "## Plan\n\n1. Only the login form\n" }]);
    await expect.poll(() => doc.locator("li").allTextContents()).toEqual(["Only the login form"]);
    expect(await focused(page)).toBe("Plan saved.");
    // Delete, after a plain question; Keep it backs off.
    await page.getByRole("button", { name: "Delete plan…" }).click();
    expect(await page.locator(".pt-confirm").innerText()).toContain("Delete the plan?");
    await page.getByRole("button", { name: "Keep it" }).click();
    expect(await params(page, "plan.delete")).toEqual([]);
    await page.getByRole("button", { name: "Delete plan…" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(() => params(page, "plan.delete")).toEqual([null]);
    await expect.poll(() => page.locator("#pl-plan-h ~ .pt-body .pt-empty").textContent()).toBe("Copilot hasn't written a plan for this session.");
    expect(page.errors).toEqual([]);
  });

  it("lists the to-dos with their states and dependencies, read again when they change", async () => {
    const page = await open("s-login", "Plan");
    const todos = page.locator(".pl-todo");
    await expect.poll(() => todos.count()).toBe(4);
    expect(await page.locator(".pl-progress").textContent()).toBe("1 of 4 done");
    expect(await todos.locator(".pl-todo-title").allTextContents()).toEqual(["Done: Read next in the login handler", "In progress: Do the same in the OAuth callback", "Not started: Add tests for both", "Blocked: Test another host is refused"]);
    expect(await todos.nth(2).locator(".pl-todo-after").textContent()).toBe("After “Read next in the login handler”, “Do the same in the OAuth callback”");
    const reads = await count(page, "plan.readSqlTodosWithDependencies");
    await page.evaluate(() => (window as unknown as W).__fake.emit("s-login", "session.todos_changed", {}, { ephemeral: true }));
    await expect.poll(() => count(page, "plan.readSqlTodosWithDependencies")).toBe(reads + 1);
    // An older runtime without dependencies: the rows alone, and the tab says so.
    await page.evaluate(() => { (window as unknown as W).__fake.panels.fail["plan.readSqlTodosWithDependencies"] = "Not in this runtime."; (window as unknown as W).__fake.emit("s-login", "session.todos_changed", {}, { ephemeral: true }); });
    await expect.poll(() => count(page, "plan.readSqlTodos")).toBe(1);
    await expect.poll(() => page.locator("#pl-todos-h ~ .pt-body .hint").textContent()).toBe("Dependencies between to-dos aren't available here, so they aren't shown.");
    expect(page.errors).toEqual([]);
  });

  it("shows the Autopilot objective, edits and deletes it, and reads it again when it changes", async () => {
    const page = await open("s-login", "Plan");
    await expect.poll(() => page.locator(".pl-obj-meta").textContent()).toBe("Working toward it · 3 turns so far");
    expect(await page.locator(".pl-obj-text").textContent()).toBe("Make every sign-in path return people to where they were, with tests.");
    await page.locator("#pl-obj-h ~ .pt-body").getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("The objective").fill("Return people to where they were.");
    await page.getByRole("button", { name: "Save objective" }).click();
    await expect.poll(() => params(page, "workspaces.writeAutopilotObjective")).toEqual([{ content: "Return people to where they were." }]);
    await expect.poll(() => page.locator(".pl-obj-text").textContent()).toBe("Return people to where they were.");
    const reads = await count(page, "autopilotObjective.getState");
    await page.evaluate(() => (window as unknown as W).__fake.emit("s-login", "session.autopilot_objective_changed", { operation: "update" }));
    await expect.poll(() => count(page, "autopilotObjective.getState")).toBeGreaterThan(reads);
    await page.getByRole("button", { name: "Delete objective…" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(() => params(page, "workspaces.deleteAutopilotObjective")).toEqual([null]);
    await expect.poll(() => page.locator("#pl-obj-h ~ .pt-body .pt-empty").textContent()).toBe("No objective is set.");
    expect(page.errors).toEqual([]);
  });

  it("shows a waiting exit-plan-mode request's own card, marks the tab, and answers it once through main", async () => {
    const page = await open("s-login", "Changes");
    await page.evaluate(() => (window as unknown as W).__fake.request("s-login", "exit-plan-mode", "plan-x", { summary: "Change both redirects.", planContent: "1. Login\n2. OAuth", actions: ["exit_only", "interactive", "autopilot"], recommendedAction: "interactive" }));
    // The mark shows on the tab whichever tab is up, in its name for a screen reader.
    await expect.poll(() => page.getByRole("tab", { name: "Plan, needs you" }).count()).toBe(1);
    await page.getByRole("tab", { name: "Plan, needs you" }).click();
    const card = page.locator(".pl-waiting .card");
    await expect.poll(() => card.locator(".card-title").textContent()).toBe("Start on the plan?");
    // Its ids are its own: nothing on the page shares one with the transcript's card.
    expect(await page.evaluate(() => { const ids = [...document.querySelectorAll("[id]")].map(e => e.id); return ids.length - new Set(ids).size; })).toBe(0);
    await page.waitForTimeout(700);
    await card.getByRole("button", { name: "Keep planning" }).click();
    await expect.poll(() => calls(page)).toContain('respond:plan-x:{"approved":false}');
    await expect.poll(() => card.count()).toBe(0);
    await expect.poll(() => page.getByRole("tab", { name: "Plan", exact: true }).count()).toBe(1);
    expect(page.errors).toEqual([]);
  });
});
