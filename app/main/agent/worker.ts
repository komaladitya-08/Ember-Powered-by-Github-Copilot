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
import { workerSystemMessage, guideSystemMessage } from "./worker-persona";
import type { Presenter } from "./presenter";
import type { Confirmer } from "./confirm";
import type { Perception, WindowTarget } from "../perception";
import type { AtspiSidecar, AxNode, Bounds, ActionResult, ElementInfo } from "../perception/sidecar";
import type { PolicyEngine, ActionKind } from "../policy/policy";
import type { AuditLog } from "../policy/audit";
import { inferLabels } from "../perception/elements";
import { isSecurityWindow } from "../policy/policy";
import { SETTINGS, changeSetting, findApp, launchApp, listApps, type SettingName } from "../hands/system";
import { BorrowStopped, CursorBorrow, UserTookOver, type Hand } from "../hands/borrow";
import type { DeskPlace } from "../desk/place";
import { focusedElement } from "../perception/elements";
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
  /** Ember's desk (tier 2), started on first use. */
  desk?: () => Promise<DeskPlace>;
  /** The worker moved to (or left) the desk: show or hide the mini-view. */
  onDesk?: (place: DeskPlace | null) => void;
  /** Pointer position and button mask in screen pixels (guide mode watches for the user's click). */
  pointer?: () => { x: number; y: number; mask: number } | null;
  /** Tier 3, when available: borrowing the user's mouse and keyboard. */
  cursor?: {
    borrow: CursorBorrow;
    /** X window id for a window title (0 if not found). */
    findWindow: (title: string) => number;
    /** "waiting": for the user to be still; "active": Ember's windows stop taking clicks and the status says so. */
    setBorrowing: (state: "waiting" | "active" | "off") => void;
    /** The window with keyboard focus on the user's screen (an auth prompt there pauses Ember's input). */
    activeWindow?: () => { app: string; title: string } | null;
  };
  onUsage?: (input: number, output: number) => void;
}

export interface TaskSpec {
  id: string;
  goal: string;
  /** The window the user was in when they asked. */
  target: WindowTarget & { app?: string };
  /** "do": Ember acts. "guide": Ember points and the user clicks. */
  mode?: "do" | "guide";
}

export interface WorkerResult {
  success: boolean;
  summary: string;
  /** The user stopped it (took the mouse back): not a failure. */
  stopped?: boolean;
}

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
  /** Where the worker is acting: null for the user's screen, or Ember's desk. */
  private place: DeskPlace | null = null;
  private deskBorrow: CursorBorrow | null = null;
  /** True while this worker holds the user's mouse and keyboard. */
  private usingCursor = false;
  private signal: AbortSignal | null = null;
  private guideStep = 0;
  private userTookOver = false;

  constructor(private d: WorkerDeps, readonly spec: TaskSpec) {
    this.target = { ...spec.target };
    this.window = { app: spec.target.app ?? "", name: spec.target.title ?? "" };
  }

  private get perception() { return this.place?.perception ?? this.d.perception; }
  private get sidecar() { return this.place?.sidecar ?? this.d.sidecar; }
  /** Ember flies to controls on the user's screen; desk work shows in the mini-view instead. */
  private fly(b: Bounds | null): void { if (!this.place) this.d.flyTo(b); }

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types tool lists as Tool<any>[]
  tools(): Tool<any>[] {
    const all = this.allTools();
    const guide = new Set(["perceive_window", "list_windows", "switch_window", "point_at", "wait_for_click", "report_progress", "finish_task"]);
    return this.spec.mode === "guide" ? all.filter(t => guide.has(t.name)) : all.filter(t => t.name !== "point_at" && t.name !== "wait_for_click");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types tool lists as Tool<any>[]
  private allTools(): Tool<any>[] {
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
          const wins = await this.perception.windows();
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
        handler: async a => this.act("click", a.id, undefined, () => this.sidecar.doAction(a.id, "click")),
      }),
      defineTool("toggle", {
        description: "Turn a switch, check box or toggle button on or off.",
        parameters: z.object({ id, on: z.boolean().describe("true to turn it on, false to turn it off") }),
        ...common,
        handler: async a => {
          const node = this.known.get(a.id);
          if (node) {
            const now = await this.sidecar.readElement(a.id).catch(() => null);
            const isOn = now ? now.states.includes("checked") || now.states.includes("pressed") : null;
            if (isOn === a.on) return done(`Already ${a.on ? "on" : "off"}: ${describeAfter(now!)}`);
          }
          return this.act("toggle", a.id, a.on ? "on" : "off", () => this.sidecar.doAction(a.id, "toggle"));
        },
      }),
      defineTool("type_text", {
        description: "Put text into a text field or document: replace its contents, insert at the caret, or append at the end.",
        parameters: z.object({ id, text: z.string().max(5000), mode: z.enum(["replace", "insert", "append"]).optional() }),
        ...common,
        handler: async a => this.act("text", a.id, a.text, () => this.sidecar.setText(a.id, a.text, a.mode ?? "replace")),
      }),
      defineTool("choose_option", {
        description: "Choose an option in a combo box, drop-down or list by its visible name.",
        parameters: z.object({ id, option: z.string().min(1) }),
        ...common,
        handler: async a => this.act("select", a.id, a.option, () => this.sidecar.selectOption(a.id, a.option)),
      }),
      defineTool("set_value", {
        description: "Set a slider or spin button to a number.",
        parameters: z.object({ id, value: z.number() }),
        ...common,
        handler: async a => this.act("value", a.id, String(a.value), () => this.sidecar.setValue(a.id, a.value)),
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
      ...(this.d.desk ? [defineTool("open_on_desk", {
        description: "Open an app on Ember's desk: a private screen the user doesn't see, where you can use mouse and keyboard freely without disturbing them (they can watch in a small view). Good for longer jobs and for apps that need typing or shortcuts. Save files the user should get into the folder this tool names.",
        parameters: z.object({ name: z.string().min(1) }),
        ...common,
        handler: async (a: { name: string }) => {
          const app = findApp(listApps(), a.name);
          if (!app) return fail(`No installed app matches "${a.name}".`);
          return this.system("open_app", `${app.name} (on Ember's desk)`, async () => {
            const place = await this.d.desk!();
            this.place = place;
            this.d.onDesk?.(place);
            // The app's window is the one from the process just started, or else whichever window is new.
            const key = (w: { pid: number | null; name: string }) => `${w.pid}:${w.name}`;
            const before = new Set((await place.perception.windows().catch(() => [])).map(key));
            const pid = place.open(app);
            for (let i = 0; i < 60; i++) {
              await new Promise(r => setTimeout(r, 250));
              const wins = await place.perception.windows().catch(() => []);
              const w = wins.find(x => pid !== undefined && x.pid === pid) ?? wins.find(x => !before.has(key(x)));
              if (w) { this.target = { title: w.name }; return `Opened ${app.name} on your desk ("${w.name}"). Everything you do now happens there. Save results in ${place.info.handOff}. Call perceive_window.`; }
            }
            return `Started ${app.name} on your desk, but its window hasn't appeared yet. Use list_windows.`;
          });
        },
      })] : []),
      defineTool("open_app", {
        description: "Start an application by name (for example Text Editor, Files, Settings).",
        parameters: z.object({ name: z.string().min(1) }),
        ...common,
        handler: async a => {
          const app = findApp(listApps(), a.name);
          if (!app) return fail(`No installed app matches "${a.name}".`);
          return this.system("open_app", app.name, async () => {
            if (this.place) { this.place = null; this.d.onDesk?.(null); }
            launchApp(app);
            for (let i = 0; i < 40; i++) {
              await new Promise(r => setTimeout(r, 250));
              const w = (await this.perception.windows()).find(x => x.app.toLowerCase().includes(app.name.toLowerCase().split(" ")[0]) || x.name.toLowerCase().includes(app.name.toLowerCase()));
              if (w) { this.target = { title: w.name }; return `Opened ${app.name}; now working in its window "${w.name}". Call perceive_window.`; }
            }
            return `Started ${app.name}, but its window hasn't appeared yet. Use list_windows and switch_window.`;
          });
        },
      }),
      ...(this.d.cursor || this.d.desk ? [
        defineTool("press_keys", {
          description: "Press a key or shortcut in the window you are working in, e.g. \"ctrl+s\", \"Return\", \"ctrl+shift+t\". Borrows the user's keyboard, so the user is asked first; prefer element tools when they work.",
          parameters: z.object({ keys: z.string().min(1).max(40) }),
          ...common,
          handler: async (a: { keys: string }) => this.pressKeys(a.keys),
        }),
        defineTool("scroll", {
          description: "Scroll an element (a list, document or page) up or down by a few steps. Borrows the user's mouse, so the user is asked first.",
          parameters: z.object({ id, direction: z.enum(["up", "down", "left", "right"]), steps: z.number().int().min(1).max(30).optional() }),
          ...common,
          handler: async (a: { id: number; direction: "up" | "down" | "left" | "right"; steps?: number }) => this.scroll(a.id, a.direction, a.steps ?? 5),
        }),
      ] : []),
      defineTool("point_at", {
        description: "Point at an element so the user can do this step themselves: Ember flies next to it, highlights it and shows your short instruction.",
        parameters: z.object({ id, say: z.string().min(1).max(160).describe("A short instruction, e.g. \"Click Display\"") }),
        ...common,
        handler: async a => {
          const node = this.known.get(a.id);
          if (!node?.bounds) return fail(`Element ${a.id} is not in your latest perceive_window (or has no position). Call perceive_window.`);
          this.guideStep++;
          this.fly(node.bounds);
          this.d.presenter.guide(a.say, `Step ${this.guideStep}`);
          this.d.audit.write({ event: "action", task: this.spec.id, kind: "point", app: this.window.app, element: { role: node.role, name: node.name || this.labels.get(a.id) || "" }, ok: true });
          return done(`Pointing at [${a.id}]. Now call wait_for_click with id ${a.id}.`);
        },
      }),
      defineTool("wait_for_click", {
        description: "Wait until the user clicks the element you pointed at (or it changes, e.g. a switch turns on, or the window changes).",
        parameters: z.object({ id, timeoutSeconds: z.number().int().min(5).max(300).optional() }),
        ...common,
        handler: async a => this.waitForClick(a.id, (a.timeoutSeconds ?? 90) * 1000),
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
      systemMessage: this.spec.mode === "guide" ? guideSystemMessage() : workerSystemMessage(),
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
    this.signal = signal;
    const onAbort = () => {
      this.aborted = true;
      // Motion stops at once: a borrow in progress lets go and the pointer goes straight back.
      if (this.usingCursor) this.d.cursor?.borrow.stop();
      this.deskBorrow?.stop();
      void session.abort().catch(() => undefined);
    };
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
      if (this.place) d.onDesk?.(null);
    }
    if (this.aborted) return { success: false, summary: "Stopped.", stopped: true };
    const result = this.result ?? { success: false, summary: lastAnswer || "The worker stopped without a summary." };
    return this.userTookOver && !result.success ? { ...result, stopped: true } : result;
  }

  async dispose(): Promise<void> {
    await this.session?.disconnect().catch(() => undefined);
  }

  /** Guide mode: done when the user presses inside the element, the element changes, or the window does. */
  private async waitForClick(id: number, timeoutMs: number): Promise<ToolResultObject> {
    const node = this.known.get(id);
    if (!node?.bounds) return fail(`Element ${id} is not in your latest perceive_window. Call perceive_window.`);
    const b = node.bounds, pad = 4;
    const inside = (p: { x: number; y: number }) => p.x >= b.x - pad && p.y >= b.y - pad && p.x < b.x + b.width + pad && p.y < b.y + b.height + pad;
    const before = await this.sidecar.readElement(id).catch(() => null);
    const key = (e: ElementInfo | null) => (e ? `${e.states.filter(s => ["checked", "pressed", "selected", "expanded", "focused"].includes(s)).sort().join(",")}|${e.selected ?? ""}|${e.value ?? ""}` : "gone");
    const t0 = Date.now();
    let wasDown = (this.d.pointer?.()?.mask ?? 0) & 256;
    let lastCheck = 0;
    while (Date.now() - t0 < timeoutMs) {
      if (this.signal?.aborted) return denied("Stopped.");
      const p = this.d.pointer?.();
      const down = (p?.mask ?? 0) & 256;
      if (p && down && !wasDown && inside(p)) {
        await new Promise(r => setTimeout(r, 400)); // let the app react before the next look
        this.d.audit.write({ event: "action", task: this.spec.id, kind: "user_clicked", app: this.window.app, element: { role: node.role, name: node.name }, ok: true });
        return done("The user clicked it. Call perceive_window to see what changed.");
      }
      wasDown = down;
      if (Date.now() - lastCheck > 500) {
        lastCheck = Date.now();
        const now = await this.sidecar.readElement(id).catch(() => null);
        if (key(now) !== key(before)) {
          return done(now ? `It changed: ${describeAfter(now)}. Call perceive_window for the next step.` : "The window changed (the element is gone). Call perceive_window.");
        }
      }
      await new Promise(r => setTimeout(r, 30));
    }
    return done("The user hasn't clicked it yet. Finish kindly, saying where they got to, unless the goal is already done.");
  }

  private async perceive(image: boolean): Promise<ToolResultObject> {
    const p = await this.perception.perceive({ image, scope: "window", target: this.target });
    if (p.blocked) return denied("This window is private (on the user's never-look list, or a password prompt). Don't use it; finish the task and say so.");
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
    if (this.place?.userInControl()) return denied("The user has taken over your desk. Wait for them, or finish the task saying where you got to.");
    const req = { taskId: this.spec.id, kind, app: this.window.app, window: this.window.name, element: { role: node.role, name: node.name || this.labels.get(id) || "" }, value };
    const verdict = await this.authorize(req);
    if (verdict) return verdict;
    const release = await this.d.lease(this.window.name || this.window.app, this.spec.id);
    try {
      if (node.bounds) this.fly(node.bounds);
      await new Promise(r => setTimeout(r, 350)); // let Ember arrive, so the user sees where it acts
      const res = await run();
      this.d.audit.write({ event: "action", task: this.spec.id, kind, app: req.app, window: req.window, element: req.element, ok: res.ok, after: { states: res.after.states, selected: res.after.selected } });
      return done(`${res.ok ? "Done" : "The app reported it did not work"}. Now: ${describeAfter(res.after)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.d.audit.write({ event: "action", task: this.spec.id, kind, app: req.app, element: req.element, ok: false, error: msg });
      if (msg.includes("background_unavailable")) {
        release();
        // The router: tier 1 can't do it, so try tier 3 (the user's mouse), with their OK.
        if ((this.place || this.d.cursor) && node.bounds && (kind === "click" || kind === "toggle" || kind === "text")) {
          this.d.log.info("router.escalate", { task: this.spec.id, from: "tier1", to: this.place ? "tier2-desk" : "tier3", kind, role: node.role });
          return this.cursorAct(kind === "text" ? "cursor_text" : "cursor_click", id, node, value);
        }
        return fail(`${msg.replace("background_unavailable: ", "")}. This can't be done without the mouse; tell the user in finish_task.`);
      }
      return fail(msg);
    } finally {
      release();
    }
  }

  /** Tier 3: borrow the mouse (and keyboard) for one action, with the user's OK. */
  private async cursorAct(kind: "cursor_click" | "cursor_text", id: number, node: AxNode, value?: string): Promise<ToolResultObject> {
    const element = { role: node.role, name: node.name || this.labels.get(id) || "" };
    const verdict = await this.authorize({ taskId: this.spec.id, kind, app: this.window.app, window: this.window.name, element, value });
    if (verdict) return verdict;
    const b = node.bounds!;
    const cx = b.x + Math.min(b.width / 2, 120), cy = b.y + b.height / 2;
    return this.withCursor(kind, element, async hand => {
      await hand.glideTo(cx, cy);
      await hand.click();
      if (kind === "cursor_text") {
        await hand.keys("ctrl+a");
        await hand.type(value ?? "");
      }
    }, id);
  }

  private async pressKeys(keys: string): Promise<ToolResultObject> {
    // Keys go to whatever has focus in the window: never a password field.
    const seen = await this.perception.read(this.target).catch(() => null);
    const focus = seen ? focusedElement(seen.nodes) : null;
    const element = focus ? { role: focus.role, name: focus.name } : undefined;
    const verdict = await this.authorize({ taskId: this.spec.id, kind: "keys", app: this.window.app, window: this.window.name, element, value: keys });
    if (verdict) return verdict;
    return this.withCursor("keys", element, hand => hand.keys(keys));
  }

  private async scroll(id: number, direction: "up" | "down" | "left" | "right", steps: number): Promise<ToolResultObject> {
    const node = this.known.get(id);
    if (!node?.bounds) return fail(`Element ${id} is not in your latest perceive_window (or has no position). Call perceive_window.`);
    const element = { role: node.role, name: node.name || this.labels.get(id) || "" };
    const verdict = await this.authorize({ taskId: this.spec.id, kind: "scroll", app: this.window.app, window: this.window.name, element, value: direction });
    if (verdict) return verdict;
    const b = node.bounds;
    return this.withCursor("scroll", element, async hand => {
      await hand.glideTo(b.x + b.width / 2, b.y + b.height / 2);
      await hand.scroll(direction, steps);
    });
  }

  private async withCursor(kind: ActionKind, element: { role: string; name: string } | undefined, fn: (hand: Hand) => Promise<void>, verifyId?: number): Promise<ToolResultObject> {
    if (this.place) return this.onDeskInput(this.place, kind, element, fn, verifyId);
    if (!this.d.cursor) return fail("This needs the mouse or keyboard, which isn't available here. Try open_on_desk.");
    const c = this.d.cursor;
    // A password or authentication prompt has the keyboard: those are the user's alone (M8.3).
    const authPrompt = () => { const w = c.activeWindow?.(); return !!w && isSecurityWindow(w); };
    if (authPrompt()) return denied("An authentication prompt is open on the user's screen. That's for the user only: wait, or finish the task saying what's left.");
    const guarded = (hand: Hand): Hand => {
      const check = () => { if (authPrompt()) throw new Error("an authentication prompt took the keyboard, so Ember stopped"); };
      return {
        ...hand,
        click: async b => { check(); await hand.click(b); },
        keys: async k => { check(); await hand.keys(k); },
        type: async t => { for (const part of t.match(/[\s\S]{1,8}/g) ?? []) { check(); await hand.type(part); } },
      };
    };
    const release = await this.d.lease(this.window.name || this.window.app, this.spec.id);
    c.setBorrowing("waiting");
    this.fly(null); // Ember rides along with the cursor
    this.usingCursor = true;
    try {
      await c.borrow.borrow(hand => fn(guarded(hand)), {
        window: this.window.name ? c.findWindow(this.window.name) || undefined : undefined,
        onStart: () => c.setBorrowing("active"),
      });
      const after = verifyId !== undefined ? await this.sidecar.readElement(verifyId).catch(() => null) : null;
      this.d.audit.write({ event: "action", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, ok: true, tier: 3 });
      return done(`Done with the user's mouse, which is back where it was.${after ? ` Now: ${describeAfter(after)}` : " Call perceive_window to check the result."}`);
    } catch (err) {
      const tookOver = err instanceof UserTookOver;
      const msg = err instanceof Error ? err.message : String(err);
      this.d.audit.write({ event: "action", task: this.spec.id, kind, app: this.window.app, element, ok: false, tier: 3, error: msg, ...(tookOver ? { tookOverAfterMs: err.afterMs } : {}) });
      if (tookOver) this.userTookOver = true;
      if (tookOver) return denied("The user took the mouse back, so you stopped. Don't try again; finish the task and say what's left.");
      if (err instanceof BorrowStopped) return denied("Stopped.");
      return fail(msg);
    } finally {
      this.usingCursor = false;
      c.setBorrowing("off");
      release();
    }
  }

  /** Tier 2: full mouse and keyboard on Ember's own desk (the user's input is never touched). */
  private async onDeskInput(place: DeskPlace, kind: ActionKind, element: { role: string; name: string } | undefined, fn: (hand: Hand) => Promise<void>, verifyId?: number): Promise<ToolResultObject> {
    if (place.userInControl()) return denied("The user has taken over your desk. Wait for them, or finish the task saying where you got to.");
    const release = await this.d.lease(`desk:${this.window.name || this.window.app}`, this.spec.id);
    this.deskBorrow ??= new CursorBorrow(place.input);
    try {
      await this.deskBorrow.borrow(fn, { idleMs: 0, window: this.window.name ? place.input.findWindow(this.window.name) || undefined : undefined });
      const after = verifyId !== undefined ? await place.sidecar.readElement(verifyId).catch(() => null) : null;
      this.d.audit.write({ event: "action", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, ok: true, tier: 2 });
      return done(`Done on your desk.${after ? ` Now: ${describeAfter(after)}` : " Call perceive_window to check the result."}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.d.audit.write({ event: "action", task: this.spec.id, kind, app: this.window.app, element, ok: false, tier: 2, error: msg });
      if (err instanceof UserTookOver) return denied("The user took over your desk. Stop and finish the task, saying where you got to.");
      if (err instanceof BorrowStopped) return denied("Stopped.");
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
  private async authorize(request: Parameters<PolicyEngine["decide"]>[0]): Promise<ToolResultObject | null> {
    const req = { ...request, onDesk: !!this.place, goal: this.spec.goal };
    const decision = this.d.policy.decide(req);
    const sessionAllowed = decision.verdict === "confirm" && !decision.risky && !decision.everyTime && this.allowedApps.has(req.app.toLowerCase());
    this.d.audit.write({ event: "decision", task: this.spec.id, kind: req.kind, app: req.app, window: req.window, element: req.element, tier: decision.tier, verdict: sessionAllowed ? "allow" : decision.verdict, reason: decision.reason, ...(decision.aligned === false ? { aligned: false } : {}) });
    if (decision.verdict === "deny") return denied(`Not allowed: ${decision.reason}. Don't try another way; tell the user in finish_task.`);
    if (decision.verdict === "allow" || sessionAllowed) return null;
    const options = decision.needsGrant && decision.remember && req.app
      ? [{ id: "once", label: "Allow", primary: true }, { id: "always", label: `Always in ${req.app}` }, { id: "deny", label: "Not now" }]
      : [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }];
    const context = this.spec.goal.length > 40 ? this.spec.goal.slice(0, 39) + "…" : this.spec.goal;
    const answer = await this.d.confirmer.ask({ title: "May I?", context, prompt: decision.prompt, options });
    this.d.audit.write({ event: "confirm", task: this.spec.id, kind: req.kind, app: req.app, element: req.element, answer: answer ?? "expired" });
    if (answer === "always" && decision.remember) {
      this.d.settings.update({ grants: { ...this.d.settings.get().grants, [req.app.toLowerCase()]: "act" } });
    }
    if (answer === "once" || answer === "always") {
      if (decision.needsGrant && req.app) this.allowedApps.add(req.app.toLowerCase());
      return null;
    }
    return denied("The user said no (or didn't answer). Don't retry or work around it; finish the task and say what wasn't done.");
  }
}
