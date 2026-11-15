/** Actual project board DOM in Chromium; replaces only the preload boundary, never runs a desktop action. */
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectSession, ProjectSessionsAction, ProjectSessionsState } from "../../app/shared/project-sessions";

interface BoardHarness {
  state: ProjectSessionsState;
  actions: ProjectSessionsAction[];
  sent: string[];
  controls: { id: string; action: string }[];
  opened: string[];
  checkpoints: string[];
  saved: ProjectSessionsState | null;
  deferCheckpoint: boolean;
  resolveCheckpoint?: (value: { state: ProjectSessionsState; message: string }) => void;
  emit(name: string, value?: unknown): void;
  deferState: boolean;
  resolveState?: (value: ProjectSessionsState) => void;
  deferAction: boolean;
  resolveAction?: (value: ProjectSessionsState) => void;
  deferSend: boolean;
  resolveSend?: (value: string) => void;
}
declare global { interface Window { __projectBoard: BoardHarness } }

const empty: ProjectSessionsState = { projects: [], selectedProjectId: null };
const session = (status: ProjectSession["status"], title = "Check the app"): ProjectSession => ({ id: "session-1", taskId: "task-1", title, kind: "desktop", status, detail: "Reading the app", startedAt: 1 });
const populated = (sessions: ProjectSession[] = []): ProjectSessionsState => ({ projects: [{ id: "project-1", name: "App project", goal: "Ship a useful app", createdAt: 1, sessions }], selectedProjectId: "project-1" });

describe.skipIf(process.env.EMBER_UIUX_TEST !== "1")("Projects and delegated sessions in Chromium", () => {
  let browser: Browser;
  let script = "";
  let markup = "";
  beforeAll(async () => {
    const bundle = await build({ stdin: { contents: 'import { mountProjectSessions } from "./app/renderer/home/project-sessions"; mountProjectSessions();', resolveDir: process.cwd() }, bundle: true, platform: "browser", write: false });
    script = bundle.outputFiles[0].text;
    const html = fs.readFileSync("app/renderer/home/index.html", "utf8");
    markup = html.slice(html.indexOf('<div class="group" id="project-sessions"'), html.indexOf('<div class="group" id="coding-workspace"'));
    browser = await chromium.launch({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  async function open(state = empty, ready = true): Promise<Page> {
    const page = await browser.newPage();
    await page.setContent(`<html><body><button id="p-write">Conversation</button><button id="p-tasks">Activity</button>${markup}</body></html>`);
    await page.evaluate(({ state, ready }) => {
      const listeners: Record<string, ((value: unknown) => void)[]> = {};
      const harness: BoardHarness = window.__projectBoard = {
        state, actions: [], sent: [], controls: [], opened: [], checkpoints: [], saved: null, deferCheckpoint: false, deferState: false, deferAction: false, deferSend: false,
        emit: (name, value) => { for (const fn of listeners[name] ?? []) fn(value); },
      };
      for (const id of ["p-write", "p-tasks"]) document.getElementById(id)!.addEventListener("click", () => harness.opened.push(id));
      window.ember = new Proxy({}, { get: (_target, key: string) => {
        if (key.startsWith("on")) return (fn: (value: unknown) => void) => { (listeners[key] ??= []).push(fn); return () => undefined; };
        if (key === "agentStatus") return async () => ({ phase: ready ? "ready" : "signed-out" });
        if (key === "projectSessionsState") return () => harness.deferState
          ? new Promise<ProjectSessionsState>(resolve => { harness.resolveState = resolve; }) : Promise.resolve(structuredClone(harness.state));
        if (key === "projectSessionsAction") return async (action: ProjectSessionsAction) => {
          harness.actions.push(action);
          if (harness.deferAction) return new Promise<ProjectSessionsState>(resolve => { harness.resolveAction = resolve; });
          if (action.action === "create") {
            const project = { id: `created-${harness.actions.length}`, name: action.name, goal: action.goal ?? "", createdAt: 1, sessions: [] };
            harness.state.projects.push(project); harness.state.selectedProjectId = project.id;
          } else if (action.action === "select") harness.state.selectedProjectId = action.id;
          else { harness.state.projects = harness.state.projects.filter(p => p.id !== action.id); harness.state.selectedProjectId = null; }
          return structuredClone(harness.state);
        };
        if (key === "projectSessionsCheckpoint") return async (action: "save" | "open" | "forget") => {
          harness.checkpoints.push(action);
          if (harness.deferCheckpoint) return new Promise<{ state: ProjectSessionsState; message: string }>(resolve => { harness.resolveCheckpoint = resolve; });
          if (action === "save") harness.saved = structuredClone(harness.state);
          else if (action === "open" && harness.saved) harness.state = structuredClone(harness.saved);
          else if (action === "forget") harness.saved = null;
          return { state: structuredClone(harness.state), message: `Checkpoint ${action}.` };
        };
        if (key === "conversationSend") return (text: string) => {
          harness.sent.push(text);
          return harness.deferSend ? new Promise<string>(resolve => { harness.resolveSend = resolve; }) : Promise.resolve("sent");
        };
        if (key === "taskControl") return async (id: string, action: string) => {
          harness.controls.push({ id, action });
          for (const project of harness.state.projects) for (const task of project.sessions) if (task.taskId === id) task.status = "stopped";
          return true;
        };
        throw new Error(`Unexpected preload call: ${key}`);
      } }) as never;
    }, { state, ready });
    await page.addScriptTag({ content: script });
    await expect.poll(() => page.locator("#project-sessions-add").isEnabled()).toBe(true);
    return page;
  }

  it("creates and selects a project, sends original user words and opens the shared activity/conversation", async () => {
    const page = await open();
    await page.locator("#project-sessions-name").fill("My project");
    await page.locator("#project-sessions-goal").fill("Coordinate my app work");
    await page.locator("#project-sessions-add").click();
    await expect.poll(() => page.locator("#project-sessions-goal-text").textContent()).toBe("Coordinate my app work");
    expect(await page.locator("#project-sessions-select option:checked").textContent()).toBe("My project");
    expect(await page.evaluate(() => window.__projectBoard.checkpoints)).toEqual([]);
    const words = "  Please inspect the app.\nDo not publish anything.  ";
    await page.locator("#project-sessions-request").fill(words);
    await page.locator("#project-sessions-send").click();
    await expect.poll(() => page.evaluate(() => window.__projectBoard.sent)).toEqual([words]);
    await expect.poll(() => page.locator("#project-sessions-request").inputValue()).toBe("");
    await page.locator("#project-sessions-conversation").click();
    await page.locator("#project-sessions-activity").click();
    expect(await page.evaluate(() => window.__projectBoard.opened)).toEqual(["p-write", "p-tasks"]);
    await page.locator("#project-sessions-select").selectOption("");
    await expect.poll(() => page.locator("#project-sessions-send").isDisabled()).toBe(true);
    const id = await page.locator("#project-sessions-select option").nth(1).getAttribute("value");
    await page.locator("#project-sessions-select").selectOption(id!);
    await expect.poll(() => page.locator("#project-sessions-send").isEnabled()).toBe(true);
    await page.close();
  });

  it("shows live session outcomes as text and stops only the selected task", async () => {
    const attack = '<img src=x onerror="window.injected=true">';
    const state = populated([session("queued", attack)]);
    state.projects[0].goal = attack;
    const page = await open(state);
    expect(await page.locator("#project-sessions-goal-text").textContent()).toBe(attack);
    expect(await page.locator("#project-sessions-list h4").textContent()).toBe(attack);
    expect(await page.locator("#project-sessions-list img").count()).toBe(0);
    expect(await page.locator("#project-sessions-list").innerText()).toContain("Waiting its turn");
    expect(await page.locator("#project-sessions-forget").isDisabled()).toBe(true);
    expect(await page.locator("#project-sessions-open").isDisabled()).toBe(true);
    await page.evaluate(() => { window.__projectBoard.state.projects[0].sessions[0].status = "running"; window.__projectBoard.emit("onTasks"); });
    await expect.poll(() => page.locator("#project-sessions-list").innerText()).toContain("Working");
    await page.getByRole("button", { name: `Stop session: ${attack}`, exact: true }).focus();
    await page.evaluate(() => { window.__projectBoard.state.projects[0].sessions[0].status = "waiting"; window.__projectBoard.emit("onTasks"); });
    await expect.poll(() => page.locator("#project-sessions-list").innerText()).toContain("Waiting for you");
    expect(await page.getByRole("button", { name: `Stop session: ${attack}`, exact: true }).evaluate(element => document.activeElement === element)).toBe(true);
    await page.getByRole("button", { name: `Stop session: ${attack}`, exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__projectBoard.controls)).toEqual([{ id: "task-1", action: "stop" }]);
    await expect.poll(() => page.locator("#project-sessions-list").innerText()).toContain("Stopped");
    expect(await page.getByRole("button", { name: /^Stop session:/ }).count()).toBe(0);
    expect(await page.locator("#project-sessions-forget").isEnabled()).toBe(true);
    await page.evaluate(attack => {
      const task = window.__projectBoard.state.projects[0].sessions[0];
      task.status = "done"; task.summary = attack;
      window.__projectBoard.emit("onTasks");
    }, attack);
    await expect.poll(() => page.locator("#project-sessions-list li > p").count()).toBe(2);
    expect(await page.locator("#project-sessions-list li > p").nth(1).textContent()).toBe(attack);
    expect(await page.locator("#project-sessions-list img").count()).toBe(0);
    expect(await page.getByRole("button", { name: /^Stop session:/ }).count()).toBe(0);
    await page.close();
  });

  it("never sends from a disconnected board, and disables a ready board immediately on disconnect", async () => {
    const page = await open(populated(), false);
    expect(await page.locator("#project-sessions-request").isDisabled()).toBe(true);
    expect(await page.locator("#project-sessions-send").isDisabled()).toBe(true);
    await page.evaluate(() => window.__projectBoard.emit("onAgentStatus", { phase: "ready" }));
    await expect.poll(() => page.locator("#project-sessions-request").isEnabled()).toBe(true);
    await page.locator("#project-sessions-request").fill("Do this later");
    await page.evaluate(() => window.__projectBoard.emit("onAgentStatus", { phase: "signed-out" }));
    expect(await page.locator("#project-sessions-send").isDisabled()).toBe(true);
    await page.locator("#project-sessions-request-form").evaluate(form => form.dispatchEvent(new Event("submit", { cancelable: true })));
    expect(await page.evaluate(() => window.__projectBoard.sent)).toEqual([]);
    await page.close();
  });

  it("rejects an old state and an old create reply after the account is forgotten", async () => {
    const page = await open(populated());
    await page.evaluate(() => { window.__projectBoard.deferState = true; window.__projectBoard.emit("onTasks"); });
    await page.waitForFunction(() => !!window.__projectBoard.resolveState);
    await page.evaluate(() => {
      const board = window.__projectBoard;
      const old = board.resolveState!;
      board.deferState = false; board.state = { projects: [], selectedProjectId: null };
      board.emit("onConversationForgotten");
      old({ projects: [{ id: "private", name: "Previous account private project", goal: "secret", createdAt: 1, sessions: [] }], selectedProjectId: "private" });
    });
    await expect.poll(() => page.locator("#project-sessions-select option").count()).toBe(1);
    expect(await page.locator("#project-sessions-goal-text").textContent()).toBe("");
    await page.evaluate(() => { window.__projectBoard.deferAction = true; });
    await page.locator("#project-sessions-name").fill("Old account pending project");
    await page.locator("#project-sessions-add").click();
    await page.waitForFunction(() => !!window.__projectBoard.resolveAction);
    await page.evaluate(() => {
      const board = window.__projectBoard;
      board.emit("onConversationForgotten");
      board.resolveAction!({ projects: [{ id: "late", name: "Old account pending project", goal: "private", createdAt: 1, sessions: [] }], selectedProjectId: "late" });
    });
    await expect.poll(() => page.locator("#project-sessions-add").isEnabled()).toBe(true);
    expect(await page.locator("#project-sessions-select option").count()).toBe(1);
    expect(await page.locator("#project-sessions-status").textContent()).toBe("");
    expect(await page.locator("#project-sessions-name").inputValue()).toBe("");
    await page.close();
  });

  it("does not restore request text or a sent notice from an earlier account", async () => {
    const page = await open(populated());
    await page.evaluate(() => { window.__projectBoard.deferSend = true; });
    await page.locator("#project-sessions-request").fill("Previous account private request");
    await page.locator("#project-sessions-send").click();
    await page.waitForFunction(() => !!window.__projectBoard.resolveSend);
    await page.evaluate(() => {
      const board = window.__projectBoard;
      board.state = { projects: [], selectedProjectId: null };
      board.emit("onAgentStatus", { phase: "signed-out" });
      board.emit("onConversationForgotten");
      board.resolveSend!("sent");
    });
    await expect.poll(() => page.locator("#project-sessions-add").isEnabled()).toBe(true);
    expect(await page.locator("#project-sessions-request").inputValue()).toBe("");
    expect(await page.locator("#project-sessions-status").textContent()).toBe("");
    expect(await page.locator("#project-sessions-select option").count()).toBe(1);
    expect(await page.locator("#project-sessions-send").isDisabled()).toBe(true);
    await page.close();
  });

  it("keeps the user's navigation focus when a delayed project creation finishes", async () => {
    const page = await open();
    await page.evaluate(() => { window.__projectBoard.deferAction = true; });
    await page.locator("#project-sessions-name").fill("New project");
    await page.locator("#project-sessions-add").click();
    await page.waitForFunction(() => !!window.__projectBoard.resolveAction);
    await page.locator("#project-sessions-name").fill("My next project draft");
    await page.locator("#project-sessions-goal").fill("My next goal");
    await page.locator("#project-sessions-conversation").click();
    await page.evaluate(state => {
      const board = window.__projectBoard;
      board.state = state;
      board.resolveAction!(state);
    }, populated());
    await expect.poll(() => page.locator("#project-sessions-goal-text").textContent()).toBe("Ship a useful app");
    expect(await page.locator("#project-sessions-conversation").evaluate(element => document.activeElement === element)).toBe(true);
    expect(await page.locator("#project-sessions-name").inputValue()).toBe("My next project draft");
    expect(await page.locator("#project-sessions-goal").inputValue()).toBe("My next goal");
    await page.close();
  });

  it("saves, opens and forgets checkpoints only on explicit clicks, without starting work", async () => {
    const page = await open(populated([session("done")]));
    expect(await page.evaluate(() => window.__projectBoard.checkpoints)).toEqual([]);
    await page.locator("#project-sessions-save").click();
    await expect.poll(() => page.locator("#project-sessions-status").textContent()).toBe("Checkpoint save.");
    await page.locator("#project-sessions-forget").click();
    await expect.poll(() => page.locator("#project-sessions-select option").count()).toBe(1);
    await page.locator("#project-sessions-open").click();
    await expect.poll(() => page.locator("#project-sessions-select option:checked").textContent()).toBe("App project");
    expect(await page.getByRole("button", { name: /^Stop session:/ }).count()).toBe(0);
    await page.locator("#project-sessions-forget-saved").click();
    await expect.poll(() => page.locator("#project-sessions-status").textContent()).toBe("Checkpoint forget.");
    expect(await page.evaluate(() => window.__projectBoard.checkpoints)).toEqual(["save", "open", "forget"]);
    expect(await page.evaluate(() => window.__projectBoard.saved)).toBeNull();
    expect(await page.evaluate(() => window.__projectBoard.sent)).toEqual([]);
    expect(await page.evaluate(() => window.__projectBoard.controls)).toEqual([]);
    expect(await page.locator("#project-sessions-select option:checked").textContent()).toBe("App project");
    await page.close();
  });

  it("rejects a late checkpoint reply after the account is forgotten", async () => {
    const page = await open();
    await page.evaluate(() => { window.__projectBoard.deferCheckpoint = true; });
    await page.locator("#project-sessions-open").click();
    await page.waitForFunction(() => !!window.__projectBoard.resolveCheckpoint);
    await page.evaluate(state => {
      const board = window.__projectBoard;
      board.emit("onAgentStatus", { phase: "signed-out" });
      board.emit("onConversationForgotten");
      board.resolveCheckpoint!({ state, message: "Previous account private checkpoint" });
    }, populated());
    await expect.poll(() => page.locator("#project-sessions-add").isEnabled()).toBe(true);
    expect(await page.locator("#project-sessions-select option").count()).toBe(1);
    expect(await page.locator("#project-sessions-status").textContent()).toBe("");
    expect(await page.locator("#project-sessions-open").isDisabled()).toBe(true);
    await page.close();
  });

  it("fits the actual Home styles at wide and narrow window sizes", async () => {
    const tasks: ProjectSession[] = [
      { ...session("running", "Inspect the app and compare the current settings"), id: "one", taskId: "one" },
      { ...session("queued", "Verify the next change in a separate session"), id: "two", taskId: "two", detail: "Waiting for a worker slot" },
      { ...session("done", "Review the project plan"), id: "three", taskId: "three", summary: "The remaining work and acceptance checks are recorded." },
    ];
    const page = await open(populated(tasks));
    const source = fs.readFileSync("app/renderer/home/index.html", "utf8");
    const nav = source.slice(source.indexOf('<nav class="jump'), source.indexOf("</nav>") + 6);
    await page.evaluate(nav => {
      document.documentElement.classList.add("content");
      for (const id of ["p-write", "p-tasks"]) document.getElementById(id)!.hidden = true;
      const main = document.createElement("main"); main.className = "home";
      const navigation = new DOMParser().parseFromString(nav, "text/html").body.firstElementChild!;
      navigation.querySelector('a[href="#project-h"]')!.setAttribute("aria-current", "true");
      const section = document.createElement("section"); section.dataset.pane = "projects";
      const title = document.createElement("h2"); title.textContent = "Projects";
      section.append(title, document.getElementById("project-sessions")!);
      main.append(navigation, section); document.body.append(main);
    }, nav);
    const shared = fs.readFileSync("app/renderer/shared/ember.css", "utf8").replace('../fonts/InterVariable.woff2', `data:font/woff2;base64,${fs.readFileSync("assets/fonts/InterVariable.woff2").toString("base64")}`);
    await page.addStyleTag({ content: shared + fs.readFileSync("app/renderer/home/styles.css", "utf8") });
    const evidence = process.env.EMBER_UI_EVIDENCE;
    if (evidence) fs.mkdirSync(evidence, { recursive: true });
    for (const width of [900, 420]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
      const field = await page.locator("#project-sessions-request").evaluate(element => ({
        width: element.getBoundingClientRect().width,
        form: element.closest("form")!.getBoundingClientRect().width,
        font: parseFloat(getComputedStyle(element).fontSize),
      }));
      expect(Math.abs(field.width - field.form)).toBeLessThanOrEqual(1);
      expect(field.font).toBeGreaterThanOrEqual(14);
      if (evidence) await page.screenshot({ path: path.join(evidence, `projects-${width}.png`), fullPage: true });
    }
    await page.close();
  });
});
