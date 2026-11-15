/**
 * Real Chromium project panes -> Home IPC -> AgentHost/conductor -> fresh SDK/controller -> command policy -> Linux
 * namespaces -> resources/registry -> review/export. Electron sender, native picker/command window and synthetic model
 * account are UI/auth fixtures. No desktop actions, Windows compatibility or live-provider authorization are claimed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { expect, it } from "vitest";
import { AgentHost } from "../../app/main/agent/host";
import { ProjectCodingResources } from "../../app/main/agent/coding-resources";
import { registerProjectCodingIpc, type ProjectCodingIpc } from "../../app/main/project-coding-ipc";
import { projectCommandFolder } from "../../app/main/agent/project";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { Confirmer, type Question } from "../../app/main/agent/confirm";
import { createLocalRunner } from "../../app/main/commands/run/local";
import { createLocalService, recordCommandsConsent, setCommandsSwitch } from "../../app/main/targets/local-service";
import { loadAdminPolicy } from "../../app/main/admin";
import { AuditLog } from "../../app/main/policy/audit";
import { PolicyEngine } from "../../app/main/policy/policy";
import { SettingsStore, hasConsent } from "../../app/main/settings";
import { createLogger } from "../../app/main/logger";
import { LINUX_WORKER_SYSTEM } from "../../app/main/agent/worker";
import type { TargetBinding, TargetHands, TargetsForAgent } from "../../app/main/targets/types";
import type { CommandCard, RunExit } from "../../app/main/commands/types";
import type { ActiveProvider } from "../../app/main/provider";
import { CONSENT_VERSION } from "../../app/shared/consent";
import { IPC, type EmberHomeApi } from "../../app/shared/ipc";
// @ts-expect-error -- offline JavaScript model fixture
import { startMockLlm } from "../mock-llm/server.mjs";

declare global { interface Window {
  ember: EmberHomeApi;
  __projectCodingCall(method: string, args: unknown[]): Promise<unknown>;
  __projectCodingEmit(name: string, value?: unknown): void;
} }
const supported = () => {
  const probe = spawnSync("/usr/bin/bwrap", ["--unshare-net", "--ro-bind", "/", "/", "--", "/usr/bin/true"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
};
const repairRequest = "In this project's chosen folder, run node --test test.cjs, fix its assertion in the private copy, rerun that exact check, and prepare a review. Leave the original unchanged.";
const cleanupRequest = "Prepare an unchanged cleanup fixture copy for review without running commands or claiming its test passes.";
const original = "const {test}=require('node:test');const assert=require('node:assert/strict');test('sum',()=>assert.equal(1 + 1, 3));\n";

it.skipIf(process.env.EMBER_UIUX_TEST !== "1" || process.platform !== "linux" || process.arch !== "x64")("repairs a copied Node project through the full host/UI flow and retires private reviews on Forget and account change", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-project-coding-runtime-"));
  const userData = path.join(root, "host"), source = path.join(root, "source"), exported = path.join(root, "exported");
  for (const directory of [userData, source, exported]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(source, "test.cjs"), original);
  const dispatched = new Set<string>(); let codingStep = 0, cleanupStep = 0;
  const model = await startMockLlm({ delayMs: 0, respond: (messages: { role: string; content: unknown }[], tools: string[]) => {
    if (tools.includes("start_coding")) {
      const request = [...messages].reverse().filter(m => m.role === "user").map(m => JSON.stringify(m.content))
        .map(text => text.includes(cleanupRequest) ? cleanupRequest : text.includes(repairRequest) ? repairRequest : "").find(Boolean);
      if (request && !dispatched.has(request)) {
        dispatched.add(request);
        return { tool: { name: "start_coding", args: { goal: request === cleanupRequest ? "Prepare an unchanged cleanup fixture copy for review" : "Repair the copied assertion and verify node --test test.cjs" } } };
      }
      return { text: "The coding session has its own project card and Stop." };
    }
    if (tools.includes("finish_coding")) {
      if (messages.some(m => JSON.stringify(m.content).includes("unchanged cleanup fixture"))) return ++cleanupStep === 1
        ? { tool: { name: "finish_coding", args: { success: true, summary: "Prepared the unchanged copy for an inert review; no test pass is claimed." } } }
        : { text: "The unchanged copy is ready." };
      codingStep++;
      if (codingStep === 1 || codingStep === 3) return { tool: { name: "run_command", args: { target: "This computer", command: "node --test test.cjs", why: "Verify the copied assertion" } } };
      if (codingStep === 2) return { tool: { name: "coding_replace", args: { path: "test.cjs", oldText: "1 + 1, 3", newText: "1 + 1, 2" } } };
      if (codingStep === 4) return { tool: { name: "finish_coding", args: { success: true, summary: "Fixed the copied assertion and reran the exact check successfully. Review the patch before applying it." } } };
    }
    return { text: "Ready for review." };
  } });
  let host: AgentHost | undefined, resources: ProjectCodingResources | undefined, codingIpc: ProjectCodingIpc | undefined;
  let browser: Browser | undefined, page: Page | undefined, events = Promise.resolve();
  const errors: string[] = [], cards: CommandCard[] = [], exits: RunExit[] = [], questions: Question[] = [], pickerCalls: string[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const emit = (name: string, value?: unknown) => {
    events = events.then(async () => {
      if (!page || page.isClosed()) return;
      try { await page.evaluate(({ name, value }) => window.__projectCodingEmit(name, value), { name, value }); }
      catch (error) { if (page && !page.isClosed()) errors.push(String(error)); }
    });
  };
  try {
    const settings = new SettingsStore(path.join(userData, "settings.json")); settings.load();
    settings.update({ consent: { version: CONSENT_VERSION, at: new Date().toISOString() } });
    recordCommandsConsent(settings, "local");
    setCommandsSwitch(settings, "local", true, true);
    const log = createLogger({ dir: path.join(userData, "logs") }), audit = new AuditLog(path.join(userData, "audit"));
    const admin = loadAdminPolicy(path.join(root, "absent-admin-policy.json"));
    // This is the native command panel boundary: approve only this fixture's exact displayed hash after its arm time.
    const confirmer = new Confirmer(() => undefined, { panelReady: () => true, gapMs: 0, onChange: pending => {
      if (!pending) return;
      const { n, question } = pending; questions.push(question);
      const panel = question.panel;
      if (panel?.kind !== "command" || panel.card.command !== "node --test test.cjs" || panel.card.cwd !== "/work") {
        errors.push("Unexpected command approval"); confirmer.answer(`q${n}:deny`); return;
      }
      setTimeout(() => { if (!confirmer.answer(`q${n}:once`, "panel", { sha256: panel.card.sha256 })) errors.push("Fixture command panel approval was refused"); }, (question.armMs ?? 500) + 25);
    } });
    const binding: TargetBinding = { id: "local", kind: "local", label: "This computer", screenOs: "linux", shellOs: "linux", desktop: "none" };
    const runner = createLocalRunner({ os: "linux", env: process.env, log, home: os.homedir(), user: os.userInfo().username,
      elevated: () => process.getuid?.() === 0, extraPath: [], jobHost: null, ember: { paths: [userData], pids: () => [process.pid], names: /^ember$/ } });
    const service = createLocalService({ os: "linux", log, binding: () => binding, runner, settings, admin: () => admin,
      privileged: () => process.getuid?.() === 0, window: {
        showCard() {}, hideCard() {}, cardReady: () => true, announce: async () => true, cancelAnnounce() {},
        attach(card, running) { cards.push(structuredClone(card)); void running.done.then(exit => { exits.push(exit); }); },
      } });
    // OS inventory boundary; no desktop API is provided or used. The actual local command service/policy is preserved.
    const hands: TargetHands = { perception: {} as never, sidecar: {} as never, policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}) }),
      audit, confirmer, flyTo() { throw new Error("No desktop action is permitted in this fixture"); }, currentWindow: () => null,
      binding, commands: service, system: LINUX_WORKER_SYSTEM, grantKey: key => key, leaseKey: key => key };
    const targets: TargetsForAgent = { active: "local", caps: () => ({ commands: service.capability().state !== "off", targets: false }),
      handsFor: id => id === "local" ? { ok: true, hands } : { ok: false, why: "No remote target in this fixture" },
      bind: () => ({ ok: true, binding }), describeTargets: () => "This computer: commands only", describeScreen: () => null,
      offerConnect: () => "No remote connection in this fixture", activeLine: () => "This computer has commands on and no desktop." };
    let provider: ActiveProvider = { kind: "user", config: { type: "openai", wireApi: "completions", baseUrl: model.baseUrl, apiKey: "synthetic-first-account" },
      models: { conductor: "mock-model", worker: "mock-model" } };
    resources = await ProjectCodingResources.create({ userData, protectedPaths: [userData], env: process.env, execPath: process.execPath, isElectron: false,
      currentOwner: () => host?.projectWorkspaceScope() ?? null, projectExists: id => !!host?.projectSessionsState().projects.some(p => p.id === id),
      changed: () => emit("onTasks") });
    await expect.poll(() => resources!.availability().available, { timeout: 20_000 }).toBe(true);
    const runtime = runtimeFor("linux", process.arch), located = locateRuntime({ appPath: process.cwd(), runtimeId: runtime.id, exe: runtime.exe });
    expect(located.exists).toBe(true);
    host = new AgentHost({ userData, settings, runtimePath: located.path, log, targets, taskBase: { audit, confirmer }, provider: () => provider,
      scopedCoding: { available: () => hasConsent(settings.get()) && resources!.availability().available,
        workspace: id => resources!.workspace(id), createWorkspace: (spec, signal, admit) => resources!.createWorkspace(spec, signal, admit),
        get reviewBase() { return resources!.reviewBase; }, publish: (spec, output, status, checks) => resources!.publish(spec, output, status, checks) },
      setState: patch => { if (patch.tasks) emit("onTasks"); }, onStatus: status => emit("onAgentStatus", status),
      onTranscript: (entries, why) => { if (!entries.length && why !== "new-conversation") emit("onConversationForgotten"); emit("onConversation", entries); } });
    expect(await host.start(null), JSON.stringify(host.getStatus())).toBe("ready");
    codingIpc = registerProjectCodingIpc({ handle: (channel, handler) => { handlers.set(channel, handler); }, projects: () => host!.projectSessionsState(),
      folders: resources.folders, results: () => resources!.results(), canUse: () => host!.getStatus().phase === "ready" && !!host!.projectWorkspaceScope(),
      availability: () => resources!.availability(), chooseFolder: async title => { pickerCalls.push(title); return title === "Export coding review" ? exported : source; },
      validateFolder: selected => resources!.validateSource(projectCommandFolder(selected, userData)),
      folderChanged: id => host!.codingWorkspaceChanged(id), changed: () => emit("onTasks") });
    const invoke = async (method: string, args: unknown[]) => {
      if (method === "agentStatus") return host!.getStatus();
      if (method === "projectSessionsState") return host!.projectSessionsState();
      if (method === "projectSessionsAction") {
        const action = args[0] as { action: string; id?: string };
        if (action.action === "forget" && action.id) await codingIpc!.forgetProject(action.id);
        return host!.projectSessionsAction(args[0]);
      }
      if (method === "conversationSend") { if (typeof args[0] !== "string") throw new Error("Invalid request"); await host!.ask(args[0]); return "sent"; }
      const channel = IPC[method as keyof typeof IPC], handler = handlers.get(channel);
      if (!handler) throw new Error(`Unexpected Home method: ${method}`);
      return handler(...args);
    };
    const script = (await build({ stdin: { contents: 'import { mountProjectSessions } from "./app/renderer/home/project-sessions"; import { mountProjectCoding } from "./app/renderer/home/project-coding"; mountProjectSessions(); mountProjectCoding();', resolveDir: process.cwd() }, bundle: true, platform: "browser", write: false })).outputFiles[0].text;
    const html = fs.readFileSync("app/renderer/home/index.html", "utf8"), css = fs.readFileSync("app/renderer/home/styles.css", "utf8");
    const markup = html.slice(html.indexOf('<div class="group" id="project-sessions"'), html.indexOf('<div class="group" id="coding-workspace"'));
    browser = await chromium.launch({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
    page = await browser.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.exposeBinding("__projectCodingCall", (_source, method: string, args: unknown[]) => invoke(method, args));
    await page.setContent(`<html><head><style>${css}</style></head><body><button id="p-write">Conversation</button><button id="p-tasks">Activity</button>${markup}</body></html>`);
    await page.evaluate(() => {
      const listeners: Record<string, ((value: unknown) => void)[]> = {};
      window.__projectCodingEmit = (name, value) => { for (const listener of listeners[name] ?? []) listener(value); };
      window.ember = new Proxy({}, { get: (_target, name: string) => name.startsWith("on")
        ? (listener: (value: unknown) => void) => { (listeners[name] ??= []).push(listener); return () => undefined; }
        : (...args: unknown[]) => window.__projectCodingCall(name, args) }) as never;
    });
    await page.addScriptTag({ content: script });
    const prepare = async (name: string, request: string) => {
      await expect.poll(() => page!.locator("#project-sessions-add").isEnabled()).toBe(true);
      await page!.locator("#project-sessions-name").fill(name); await page!.locator("#project-sessions-add").click();
      await expect.poll(() => page!.locator("#project-coding-choose").isEnabled()).toBe(true);
      await page!.locator("#project-coding-choose").click();
      await expect.poll(() => page!.locator("#project-coding-folder").textContent()).toContain(source);
      const id = host!.projectSessionsState().selectedProjectId!;
      await page!.locator("#project-sessions-request").fill(request); await page!.locator("#project-sessions-send").click();
      await expect.poll(() => host!.projectSessionsState().projects.find(p => p.id === id)?.sessions[0]?.status, { timeout: 35_000 }).toBe("done");
      await expect.poll(() => page!.locator("#project-coding-results button").count()).toBe(1);
      return id;
    };
    const project = await prepare("Copied Node repair", repairRequest);
    const access = await resources.results(), result = access.state(project)[0];
    expect(result).toMatchObject({ projectId: project, status: "done", files: 1, conflicts: 0, checks: { ran: 2, passed: 1, failed: 1 } });
    expect(exits.map(exit => exit.code)).toEqual([1, 0]); expect(exits.every(exit => exit.ended === "exit" && !exit.outputCut && !exit.endLost)).toBe(true);
    expect(cards).toHaveLength(2); expect(cards[0].sha256).toBe(cards[1].sha256); expect(cards.every(card => card.cwd === "/work")).toBe(true);
    expect(questions).toHaveLength(2); expect(audit.recent().filter(entry => entry.event === "command" && entry.phase === "started")).toHaveLength(2);
    await page.locator("#project-coding-results button").click();
    await expect.poll(() => page!.locator("#project-coding-patch").textContent()).toContain("1 + 1, 2");
    await expect.poll(() => host!.conductor!.turnOpen).toBe(false);
    const modelCount = model.requests.length;
    await page.locator("#project-coding-export").click();
    await expect.poll(() => page!.locator("#project-coding-status").textContent()).toContain("Exported the coding review");
    expect(model.requests.length).toBe(modelCount);
    const exportedName = fs.readdirSync(exported)[0], destination = path.join(exported, exportedName);
    expect(fs.readFileSync(path.join(destination, "changes.patch"), "utf8")).toContain("1 + 1, 2");
    expect(fs.readFileSync(path.join(source, "test.cjs"), "utf8")).toBe(original);
    expect(fs.readdirSync(path.join(userData, "coding-controllers"))).toEqual([]);
    await page.locator("#project-coding-close").click(); await page.locator("#project-sessions-forget").click();
    await expect.poll(() => host!.projectSessionsState().projects.length).toBe(0);
    expect(access.state(project)).toEqual([]); expect(await access.review(result.id)).toBeNull(); expect(fs.readdirSync(resources.reviewBase)).toEqual([]);
    expect(fs.existsSync(destination)).toBe(true); // Explicit exports outlive private Forget cleanup.
    const second = await prepare("Account cleanup review", cleanupRequest), secondResult = access.state(second)[0];
    expect(secondResult).toMatchObject({ status: "done", files: 0, checks: { ran: 0, passed: 0, failed: 0 } });
    expect(fs.readdirSync(resources.reviewBase)).not.toEqual([]);
    provider = { ...provider, config: { ...provider.config, apiKey: "synthetic-second-account" } };
    host.providerChanged();
    expect(host.projectWorkspaceScope()).toBeNull();
    await codingIpc.reset(); await resources.invalidate();
    emit("onConversationForgotten"); await events;
    expect(access.state(second)).toEqual([]); expect(await access.review(secondResult.id)).toBeNull();
    expect(fs.readdirSync(resources.reviewBase)).toEqual([]);
    await expect.poll(() => page!.locator("#project-coding").isHidden()).toBe(true);
    expect(pickerCalls).toEqual(["Choose a coding folder", "Export coding review", "Choose a coding folder"]);
    expect(dispatched.size).toBe(2); expect(errors).toEqual([]);
    expect(fs.readFileSync(path.join(source, "test.cjs"), "utf8")).toBe(original);
  } finally {
    page = undefined;
    await browser?.close(); await host?.stop(); await resources?.close(); await events; await model.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
