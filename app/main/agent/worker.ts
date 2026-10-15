/**
 * A worker: one Copilot session that carries out one task in the user's apps.
 * It sees the screen through Perception and acts through the accessibility
 * sidecar (tier 1) or system settings (tier 0). Every action goes through the
 * policy engine first, and is shown on screen: Ember flies to the element it
 * is touching.
 */

import fs from "node:fs";
import { defineTool, type CopilotClient, type CopilotSession, type ProviderConfig, type Tool, type ToolResultObject } from "@github/copilot-sdk";
import { z } from "zod";
import { hardenedSessionConfig, verifySessionTools } from "./session-config";
import { workerSystemMessage } from "./worker-persona";
import type { Presenter } from "./presenter";
import type { Confirmer } from "./confirm";
import type { Perception, WindowTarget } from "../perception";
import type { AtspiSidecar, AxNode, Bounds, ActionResult, ElementInfo } from "../perception/sidecar";
import type { PolicyEngine, ActionKind } from "../policy/policy";
import type { AuditLog } from "../policy/audit";
import { inferLabels } from "../perception/elements";
import { SETTINGS, changeSetting, findApp, launchApp, listApps, type SettingName } from "../hands/system";
import type { Logger } from "../logger";
import type { SettingsStore } from "../settings";

export interface WorkerDeps {
  client: CopilotClient;
  log: Logger;
  model: string | null;
  vision: boolean;
  provider?: ProviderConfig;
  workDir: string;
  perception: Perception;
  sidecar: AtspiSidecar;
  policy: PolicyEngine;
  confirmer: Confirmer;
  audit: AuditLog;
  settings: SettingsStore;
  presenter: Presenter;
  /** Waits until no other task is acting in this window; returns the release function. */
  lease: (windowKey: string, taskId: string) => Promise<() => void>;
  /** Ember flies to an element (screen px) while it acts; null brings it back. */
  flyTo: (bounds: Bounds | null) => void;
  onProgress: (text: string) => void;
  onUsage?: (input: number, output: number) => void;
}

export interface TaskSpec {
  id: string;
  goal: string;
  /** The window the user was in when they asked. */
  target: WindowTarget & { app?: string };
}

export interface WorkerResult { success: boolean; summary: string }

const done = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "success" });
const fail = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "failure", error: text });
const denied = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "denied" });

function describeAfter(a: ElementInfo): string {
  const bits = [`${a.role} "${a.name}"`];
  if (a.states.length) bits.push(`(${a.states.join(", ")})`);
  if (a.selected !== undefined) bits.push(`selected="${a.selected}"`);
  if (a.value !== undefined) bits.push(`value=${a.value}`);
  if (a.text !== undefined) bits.push(`text=${JSON.stringify(a.text.length > 300 ? a.text.slice(0, 300) + "…" : a.text).replace(/</g, "\\u003c")}`);
  return bits.join(" ");
}

export class Worker {
  private session: CopilotSession | null = null;
  private result: WorkerResult | null = null;
  /** Elements from this worker's latest perceive_window, by id. */
  private known = new Map<number, AxNode>();
  /** Labels borrowed by unnamed controls (a switch takes the label beside it). */
  private labels = new Map<number, string>();
  private window: { app: string; name: string } = { app: "", name: "" };
  private target: WindowTarget;
  /** Apps the user allowed for this task only ("Allow once"). */
  private allowedApps = new Set<string>();
  private aborted = false;

  constructor(private d: WorkerDeps, readonly spec: TaskSpec) {
    this.target = { ...spec.target };
    this.window = { app: spec.target.app ?? "", name: spec.target.title ?? "" };
  }

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types tool lists as Tool<any>[]
  tools(): Tool<any>[] {
    const common = { skipPermission: true, defer: "never" as const };
    const id = z.number().int().describe("Element id from your latest perceive_window");
    return [
      defineTool("perceive_window", {
        description: "Read the window you are working in: its elements with ids, roles, names, states and positions." + (this.d.vision ? " Pass image=true to also get a screenshot with numbered marks." : ""),
        parameters: z.object({ image: z.boolean().optional().describe("Also return a marked screenshot") }),
        ...common,
        handler: async ({ image }) => this.perceive(image === true && this.d.vision),
      }),
      defineTool("list_windows", {
        description: "List the open windows (app and title).",
        parameters: z.object({}),
        ...common,
        handler: async () => {
          const wins = await this.d.perception.windows();
          return done(wins.map(w => `- ${w.app}: "${w.name}"${w.active ? " (focused by the user)" : ""}`).join("\n") || "No windows found.");
        },
      }),
      defineTool("switch_window", {
        description: "Work in another open window from now on (does not raise it or take focus from the user).",
        parameters: z.object({ title: z.string().min(1).describe("Part of the window title, from list_windows") }),
        ...common,
        handler: async ({ title }) => {
          this.target = { title };
          return this.perceive(false);
        },
      }),
      defineTool("click", {
        description: "Click (activate) a button, menu item, link or similar element.",
        parameters: z.object({ id }),
        ...common,
        handler: async a => this.act("click", a.id, undefined, () => this.d.sidecar.doAction(a.id, "click")),
      }),
      defineTool("toggle", {
        description: "Turn a switch, check box or toggle button on or off.",
        parameters: z.object({ id, on: z.boolean().describe("true to turn it on, false to turn it off") }),
        ...common,
        handler: async a => {
          const node = this.known.get(a.id);
          if (node) {
            const now = await this.d.sidecar.readElement(a.id).catch(() => null);
            const isOn = now ? now.states.includes("checked") || now.states.includes("pressed") : null;
            if (isOn === a.on) return done(`Already ${a.on ? "on" : "off"}: ${describeAfter(now!)}`);
          }
          return this.act("toggle", a.id, a.on ? "on" : "off", () => this.d.sidecar.doAction(a.id, "toggle"));
        },
      }),
      defineTool("type_text", {
        description: "Put text into a text field or document: replace its contents, insert at the caret, or append at the end.",
        parameters: z.object({ id, text: z.string().max(5000), mode: z.enum(["replace", "insert", "append"]).optional() }),
        ...common,
        handler: async a => this.act("text", a.id, a.text, () => this.d.sidecar.setText(a.id, a.text, a.mode ?? "replace")),
      }),
      defineTool("choose_option", {
        description: "Choose an option in a combo box, drop-down or list by its visible name.",
        parameters: z.object({ id, option: z.string().min(1) }),
        ...common,
        handler: async a => this.act("select", a.id, a.option, () => this.d.sidecar.selectOption(a.id, a.option)),
      }),
      defineTool("set_value", {
        description: "Set a slider or spin button to a number.",
        parameters: z.object({ id, value: z.number() }),
        ...common,
        handler: async a => this.act("value", a.id, String(a.value), () => this.d.sidecar.setValue(a.id, a.value)),
      }),
      defineTool("change_setting", {
        description: `Change a desktop setting directly: ${Object.entries(SETTINGS).map(([k, v]) => `${k} (${v})`).join("; ")}.`,
        parameters: z.object({
          setting: z.enum(Object.keys(SETTINGS) as [SettingName, ...SettingName[]]),
          value: z.string().describe('"on"/"off", or a number for text_size'),
        }),
        ...common,
        handler: async a => this.system("setting", `${SETTINGS[a.setting]} → ${a.value}`, async () => {
          const r = await changeSetting(a.setting, a.value);
          return `${SETTINGS[a.setting]}: was ${r.before}, now ${r.after}.`;
        }),
      }),
      defineTool("open_app", {
        description: "Start an application by name (for example Text Editor, Files, Settings).",
        parameters: z.object({ name: z.string().min(1) }),
        ...common,
        handler: async a => {
          const app = findApp(listApps(), a.name);
          if (!app) return fail(`No installed app matches "${a.name}".`);
          return this.system("open_app", app.name, async () => {
            launchApp(app);
            for (let i = 0; i < 40; i++) {
              await new Promise(r => setTimeout(r, 250));
              const w = (await this.d.perception.windows()).find(x => x.app.toLowerCase().includes(app.name.toLowerCase().split(" ")[0]) || x.name.toLowerCase().includes(app.name.toLowerCase()));
              if (w) { this.target = { title: w.name }; return `Opened ${app.name}; now working in its window "${w.name}". Call perceive_window.`; }
            }
            return `Started ${app.name}, but its window hasn't appeared yet. Use list_windows and switch_window.`;
          });
        },
      }),
      defineTool("report_progress", {
        description: "Tell the user briefly how the task is going (shown on Ember's task card).",
        parameters: z.object({ text: z.string().max(200) }),
        ...common,
        handler: async a => { this.d.onProgress(a.text); return done("Shown."); },
      }),
      defineTool("finish_task", {
        description: "End the task with a one or two sentence summary for the user.",
        parameters: z.object({ success: z.boolean(), summary: z.string().max(400) }),
        ...common,
        handler: async a => { this.result = { success: a.success, summary: a.summary }; return done("Task closed. Stop now."); },
      }),
    ];
  }

  async run(signal: AbortSignal): Promise<WorkerResult> {
    const d = this.d;
    fs.mkdirSync(d.workDir, { recursive: true });
    const tools = this.tools();
    const config = hardenedSessionConfig({
      sessionId: `ember-task-${this.spec.id}`,
      model: d.model ?? undefined,
      provider: d.provider,
      tools,
      systemMessage: workerSystemMessage(),
      workingDirectory: d.workDir,
      onPermissionRequest: () => ({ kind: "reject", feedback: "Workers use only Ember's own tools." }),
    });
    this.session = await d.client.createSession(config);
    await verifySessionTools(this.session, tools.map(t => t.name));
    const session = this.session;
    let lastAnswer = "";
    const idle = () => new Promise<void>((resolve, reject) => {
      const off = session.on(e => {
        if (e.type === "session.idle") { off(); resolve(); }
        if (e.type === "session.error") { off(); reject(new Error(String((e.data as { message?: string }).message ?? "session error"))); }
      });
    });
    session.on(e => {
      d.presenter.event(e as { type: string; data?: Record<string, unknown> });
      if (e.type === "assistant.message") lastAnswer = String((e.data as { content?: string }).content ?? lastAnswer);
      if (e.type === "assistant.usage") d.onUsage?.(e.data.inputTokens ?? 0, e.data.outputTokens ?? 0);
    });
    const onAbort = () => { this.aborted = true; void session.abort().catch(() => undefined); };
    signal.addEventListener("abort", onAbort, { once: true });
    d.presenter.taskStarted();
    try {
      const where = this.spec.target.title ? `The user was in the window "${this.spec.target.title}"${this.spec.target.app ? ` (${this.spec.target.app})` : ""} when they asked; start there unless the goal needs another app.` : "";
      let wait = idle();
      await session.send({ prompt: `Task: ${this.spec.goal}\n${where}` });
      await wait;
      if (!this.result && !this.aborted) {
        wait = idle();
        await session.send({ prompt: "Call finish_task now with a short summary of what you did." });
        await wait;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      d.flyTo(null);
    }
    if (this.aborted) return { success: false, summary: "Stopped." };
    return this.result ?? { success: false, summary: lastAnswer || "The worker stopped without a summary." };
  }

  async dispose(): Promise<void> {
    await this.session?.disconnect().catch(() => undefined);
  }

  private async perceive(image: boolean): Promise<ToolResultObject> {
    const p = await this.d.perception.perceive({ image, scope: "window", target: this.target });
    if (p.blocked) return denied("This window is on the user's never-look list. Don't use it; finish the task and say so.");
    if (!p.window) return fail("That window can't be read (it is closed or exposes no accessibility information). Use list_windows.");
    this.window = { app: p.window.app, name: p.window.name };
    this.target = { title: p.window.name, pid: p.window.pid ?? undefined };
    this.known = new Map(p.nodes.map(n => [n.id, n]));
    this.labels = inferLabels(p.nodes);
    const result: ToolResultObject = { textResultForLlm: p.text, resultType: "success" };
    if (p.capture) result.binaryResultsForLlm = [{ type: "image", mimeType: p.capture.mimeType, data: p.capture.data.toString("base64"), description: "The window with numbered marks matching element ids" }];
    return result;
  }

  /** Policy check, confirmation, lease, motion, action, audit: the one path every window action takes. */
  private async act(kind: ActionKind, id: number, value: string | undefined, run: () => Promise<ActionResult>): Promise<ToolResultObject> {
    const node = this.known.get(id);
    if (!node) return fail(`Element ${id} is not in your latest perceive_window. Call perceive_window and use its ids.`);
    const req = { taskId: this.spec.id, kind, app: this.window.app, window: this.window.name, element: { role: node.role, name: node.name || this.labels.get(id) || "" }, value };
    const verdict = await this.authorize(req);
    if (verdict) return verdict;
    const release = await this.d.lease(this.window.name || this.window.app, this.spec.id);
    try {
      if (node.bounds) this.d.flyTo(node.bounds);
      await new Promise(r => setTimeout(r, 350)); // let Ember arrive, so the user sees where it acts
      const res = await run();
      this.d.audit.write({ event: "action", task: this.spec.id, kind, app: req.app, window: req.window, element: req.element, ok: res.ok, after: { states: res.after.states, selected: res.after.selected } });
      return done(`${res.ok ? "Done" : "The app reported it did not work"}. Now: ${describeAfter(res.after)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.d.audit.write({ event: "action", task: this.spec.id, kind, app: req.app, element: req.element, ok: false, error: msg });
      if (msg.includes("background_unavailable")) return fail(`${msg.replace("background_unavailable: ", "")}. This can't be done without the mouse yet; tell the user in finish_task.`);
      return fail(msg);
    } finally {
      release();
    }
  }

  /** Tier 0 actions (settings, launching): policy and audit, no window. */
  private async system(kind: "setting" | "open_app", value: string, run: () => Promise<string>): Promise<ToolResultObject> {
    const verdict = await this.authorize({ taskId: this.spec.id, kind, app: "", window: "", value });
    if (verdict) return verdict;
    try {
      const text = await run();
      this.d.audit.write({ event: "action", task: this.spec.id, kind, value, ok: true });
      return done(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.d.audit.write({ event: "action", task: this.spec.id, kind, value, ok: false, error: msg });
      return fail(msg);
    }
  }

  /** null when the action may go ahead; otherwise the tool result to return. */
  private async authorize(req: Parameters<PolicyEngine["decide"]>[0]): Promise<ToolResultObject | null> {
    const decision = this.d.policy.decide(req);
    const sessionAllowed = decision.verdict === "confirm" && !decision.risky && this.allowedApps.has(req.app.toLowerCase());
    this.d.audit.write({ event: "decision", task: this.spec.id, kind: req.kind, app: req.app, window: req.window, element: req.element, tier: decision.tier, verdict: sessionAllowed ? "allow" : decision.verdict, reason: decision.reason });
    if (decision.verdict === "deny") return denied(`Not allowed: ${decision.reason}. Don't try another way; tell the user in finish_task.`);
    if (decision.verdict === "allow" || sessionAllowed) return null;
    const options = decision.needsGrant && req.app
      ? [{ id: "once", label: "Allow", primary: true }, { id: "always", label: `Always in ${req.app}` }, { id: "deny", label: "Not now" }]
      : [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }];
    const answer = await this.d.confirmer.ask({ title: "May I?", prompt: decision.prompt, options });
    this.d.audit.write({ event: "confirm", task: this.spec.id, kind: req.kind, app: req.app, element: req.element, answer: answer ?? "expired" });
    if (answer === "always") {
      this.d.settings.update({ grants: { ...this.d.settings.get().grants, [req.app.toLowerCase()]: "act" } });
    }
    if (answer === "once" || answer === "always") {
      if (decision.needsGrant && req.app) this.allowedApps.add(req.app.toLowerCase());
      return null;
    }
    return denied("The user said no (or didn't answer). Don't retry or work around it; finish the task and say what wasn't done.");
  }
}
