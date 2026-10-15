/**
 * A worker: one Copilot session that carries out one task in the user's apps.
 * It sees the screen through Perception and acts through the accessibility
 * sidecar (tier 1) or system settings (tier 0). Every action goes through the
 * policy engine first, and is shown on screen: Ember flies to the element it
 * is touching.
 *
 * Stopping is absolute: once the task is stopped (Stop, the kill switch, a
 * step or time limit), no tool sends anything more to an app, even one that
 * was already approved or waiting for its turn.
 */

import fs from "node:fs";
import { defineTool, type CopilotClient, type CopilotSession, type ProviderConfig, type Tool, type ToolResultObject } from "@github/copilot-sdk";
import { z } from "zod";
import { hardenedSessionConfig, verifySessionTools } from "./session-config";
import { workerSystemMessage, guideSystemMessage } from "./worker-persona";
import { TOOL_STEPS, type Presenter } from "./presenter";
import type { Confirmer } from "./confirm";
import type { Perception, WindowTarget } from "../perception";
import type { AtspiSidecar, AxNode, Bounds, ActionResult, ElementInfo } from "../perception/sidecar";
import type { PolicyEngine, ActionKind, ActionRequest, TextMode } from "../policy/policy";
import type { AuditLog } from "../policy/audit";
import { inferLabels, quoteUntrusted as q } from "../perception/elements";
import { isSecurityWindow } from "../policy/policy";
import { SETTINGS, changeSetting, findApp, launchApp, listApps, type SettingName } from "../hands/system";
import { BorrowStopped, CursorBorrow, UserTookOver, typeableText, type Hand } from "../hands/borrow";
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
  /** Waits until no other task is acting in this window; returns the release function. Gives up when `signal` aborts. */
  lease: (windowKey: string, taskId: string, signal?: AbortSignal) => Promise<() => void>;
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
  /** Limits on one task (defaults: 150 tool calls, 20 minutes). */
  limits?: { maxSteps?: number; maxMs?: number };
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
const STOPPED = (): ToolResultObject => denied("Stopped. Do nothing more.");

/** After Stop, a turn that doesn't wind down within this long is left behind. */
const STOP_GRACE_MS = 2000;

function describeAfter(a: ElementInfo): string {
  const bits = [`${a.role} ${q(a.name, 80)}`];
  if (a.states.length) bits.push(`(${a.states.join(", ")})`);
  if (a.selected !== undefined) bits.push(`selected=${q(a.selected, 80)}`);
  if (a.value !== undefined) bits.push(`value=${a.value}`);
  if (a.text !== undefined) bits.push(`text=${q(a.text, 300)}`);
  return bits.join(" ");
}

const isDisabled = (states: string[]) => states.length > 0 && !states.includes("sensitive") && !states.includes("enabled");

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
  /** Where the worker is acting: null for the user's screen, or Ember's desk. */
  private place: DeskPlace | null = null;
  private deskBorrow: CursorBorrow | null = null;
  /** True while this worker holds the user's mouse and keyboard. */
  private usingCursor = false;
  private guideStep = 0;
  private userTookOver = false;
  /** Aborted when the task must stop: the user's Stop, or a limit. Every tool checks it before acting. */
  private halt = new AbortController();
  /** Why the task stopped on its own (a limit); null when the user stopped it. */
  private haltReason: string | null = null;
  private steps = 0;
  /** Something on screen asked for an action the user didn't (an off-task question): every step is confirmed from then on. */
  private tainted = false;
  /** The last authorize() asked the user (the screen may have changed while the question was up). */
  private asked = false;

  constructor(private d: WorkerDeps, readonly spec: TaskSpec) {
    this.target = { ...spec.target };
    this.window = { app: spec.target.app ?? "", name: spec.target.title ?? "" };
  }

  private get perception() { return this.place?.perception ?? this.d.perception; }
  private get sidecar() { return this.place?.sidecar ?? this.d.sidecar; }
  private get halted() { return this.halt.signal.aborted; }
  /** Ember flies to controls on the user's screen; desk work shows in the mini-view instead. */
  private fly(b: Bounds | null): void { if (!this.place) this.d.flyTo(b); }

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  /** Moving between the user's screen and the desk: element ids belong to the other screen's reader now. */
  private setPlace(place: DeskPlace | null): void {
    if (place === this.place) return;
    this.place = place;
    this.known = new Map();
    this.labels = new Map();
    this.window = { app: "", name: "" };
    this.d.onDesk?.(place);
  }

  /** Stops the task now. `reason` is set when a limit stopped it rather than the user. */
  private stopNow(reason: string | null): void {
    if (this.halted) return;
    this.haltReason = reason;
    // Motion stops at once: a borrow in progress lets go and the pointer goes straight back.
    if (this.usingCursor) this.d.cursor?.borrow.stop();
    this.deskBorrow?.stop();
    this.halt.abort();
    void this.session?.abort().catch(() => undefined);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types tool lists as Tool<any>[]
  tools(): Tool<any>[] {
    const all = this.allTools();
    const guide = new Set(["perceive_window", "list_windows", "switch_window", "point_at", "wait_for_click", "report_progress", "finish_task"]);
    return this.spec.mode === "guide" ? all.filter(t => guide.has(t.name)) : all.filter(t => t.name !== "point_at" && t.name !== "wait_for_click");
  }

  /**
   * One tool: arguments are checked against the schema here (the runtime does not
   * enforce it), the step limit is counted, and nothing runs once the task is stopped or finished.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types tool lists as Tool<any>[]
  private tool<S extends z.ZodType>(name: string, description: string, parameters: S, handler: (a: z.infer<S>) => Promise<ToolResultObject | string>): Tool<any> {
    const maxSteps = this.d.limits?.maxSteps ?? 150;
    return defineTool(name, {
      description, parameters, skipPermission: true, defer: "never",
      handler: async (raw: unknown) => {
        if (this.halted) return STOPPED();
        if (this.result) return denied("The task is already finished. Stop now.");
        if (++this.steps > maxSteps) {
          this.stopNow(`I stopped after ${maxSteps} steps without finishing, to be safe.`);
          return STOPPED();
        }
        const parsed = parameters.safeParse(raw ?? {});
        if (!parsed.success) {
          return fail(`Invalid arguments for ${name}: ${parsed.error.issues.map(i => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ")}`);
        }
        return handler(parsed.data);
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types tool lists as Tool<any>[]
  private allTools(): Tool<any>[] {
    const id = z.number().int().describe("Element id from your latest perceive_window");
    return [
      this.tool("perceive_window",
        "Read the window you are working in: its elements with ids, roles, names, states and positions." + (this.d.vision ? " Pass image=true to also get a screenshot with numbered marks." : ""),
        z.object({ image: z.boolean().optional().describe("Also return a marked screenshot") }),
        async ({ image }) => this.perceive(image === true && this.d.vision)),
      this.tool("list_windows", "List the open windows (app and title).", z.object({}), async () => {
        const wins = await this.perception.windows();
        const lines = wins.map(w => `- ${q(w.app, 60)}: ${q(w.name, 100)}${w.active ? " (focused by the user)" : ""}`);
        return done(lines.length ? `<windows untrusted="true">\n${lines.join("\n")}\n</windows>` : "No windows found.");
      }),
      this.tool("switch_window", "Work in another open window from now on (does not raise it or take focus from the user).",
        z.object({ title: z.string().min(1).max(200).describe("Part of the window title, from list_windows") }),
        async ({ title }) => this.perceive(false, title)),
      this.tool("click", "Click (activate) a button, menu item, link or similar element.", z.object({ id }),
        async a => this.act("click", a.id, undefined, () => this.sidecar.doAction(a.id, "click"))),
      this.tool("toggle", "Turn a switch, check box or toggle button on or off.",
        z.object({ id, on: z.boolean().describe("true to turn it on, false to turn it off") }),
        async a => {
          const node = this.known.get(a.id);
          if (node) {
            const now = await this.sidecar.readElement(a.id).catch(() => null);
            if (this.halted) return STOPPED();
            const isOn = now ? now.states.includes("checked") || now.states.includes("pressed") : null;
            if (isOn === a.on) return done(`Already ${a.on ? "on" : "off"}: ${describeAfter(now!)}`);
          }
          return this.act("toggle", a.id, a.on ? "on" : "off", () => this.sidecar.doAction(a.id, "toggle"));
        }),
      this.tool("type_text",
        "Put text into a text field or document. mode: \"replace\" replaces everything in it, \"insert\" types at the caret, \"append\" adds at the end.",
        z.object({ id, text: z.string().max(5000), mode: z.enum(["replace", "insert", "append"]).describe("replace, insert or append") }),
        async a => this.act("text", a.id, a.text, () => this.sidecar.setText(a.id, a.text, a.mode), a.mode)),
      this.tool("choose_option", "Choose an option in a combo box, drop-down or list by its visible name.",
        z.object({ id, option: z.string().min(1).max(200) }),
        async a => this.act("select", a.id, a.option, () => this.sidecar.selectOption(a.id, a.option))),
      this.tool("set_value", "Set a slider or spin button to a number.", z.object({ id, value: z.number().finite() }),
        async a => this.act("value", a.id, String(a.value), () => this.sidecar.setValue(a.id, a.value))),
      this.tool("change_setting", `Change a desktop setting directly: ${Object.entries(SETTINGS).map(([k, v]) => `${k} (${v})`).join("; ")}.`,
        z.object({
          setting: z.enum(Object.keys(SETTINGS) as [SettingName, ...SettingName[]]),
          value: z.string().max(20).describe('"on"/"off", or a number for text_size'),
        }),
        async a => this.system("setting", `${SETTINGS[a.setting]} → ${a.value}`, async () => {
          const r = await changeSetting(a.setting, a.value);
          return `${SETTINGS[a.setting]}: was ${r.before}, now ${r.after}.`;
        })),
      ...(this.d.desk ? [this.tool("open_on_desk",
        "Open an app on Ember's desk: a private screen the user doesn't see, where you can use mouse and keyboard freely without disturbing them (they can watch in a small view). Good for longer jobs and for apps that need typing or shortcuts. Save files the user should get into the folder this tool names.",
        z.object({ name: z.string().min(1).max(100) }),
        async a => {
          const app = findApp(listApps(), a.name);
          if (!app) return fail(`No installed app matches ${q(a.name, 100)}.`);
          return this.system("open_app", `${app.name} (on Ember's desk)`, async () => {
            const place = await this.d.desk!();
            this.setPlace(place);
            // The app's window is the one from the process just started, or else whichever window is new.
            const key = (w: { pid: number | null; name: string }) => `${w.pid}:${w.name}`;
            const before = new Set((await place.perception.windows().catch(() => [])).map(key));
            const pid = place.open(app);
            for (let i = 0; i < 60 && !this.halted; i++) {
              await new Promise(r => setTimeout(r, 250));
              const wins = await place.perception.windows().catch(() => []);
              const w = wins.find(x => pid !== undefined && x.pid === pid) ?? wins.find(x => !before.has(key(x)));
              if (w) { this.target = { title: w.name, pid: w.pid ?? undefined }; return `Opened ${app.name} on your desk (window ${q(w.name, 100)}). Everything you do now happens there. Save results in ${place.info.handOff}. Call perceive_window.`; }
            }
            return `Started ${app.name} on your desk, but its window hasn't appeared yet. Use list_windows.`;
          }, app.name);
        })] : []),
      this.tool("open_app", "Start an application by name (for example Text Editor, Files, Settings).", z.object({ name: z.string().min(1).max(100) }),
        async a => {
          const app = findApp(listApps(), a.name);
          if (!app) return fail(`No installed app matches ${q(a.name, 100)}.`);
          return this.system("open_app", app.name, async () => {
            this.setPlace(null);
            launchApp(app);
            for (let i = 0; i < 40 && !this.halted; i++) {
              await new Promise(r => setTimeout(r, 250));
              const w = (await this.perception.windows()).find(x => x.app.toLowerCase().includes(app.name.toLowerCase().split(" ")[0]) || x.name.toLowerCase().includes(app.name.toLowerCase()));
              if (w) { this.target = { title: w.name, pid: w.pid ?? undefined }; return `Opened ${app.name}; now working in its window ${q(w.name, 100)}. Call perceive_window.`; }
            }
            return `Started ${app.name}, but its window hasn't appeared yet. Use list_windows and switch_window.`;
          }, app.name);
        }),
      ...(this.d.cursor || this.d.desk ? [
        this.tool("press_keys",
          "Press a key or shortcut in the window you are working in, e.g. \"ctrl+s\", \"Return\", \"ctrl+shift+t\". Borrows the user's keyboard, so the user is asked first; prefer element tools when they work.",
          z.object({ keys: z.string().min(1).max(40) }),
          async a => this.pressKeys(a.keys)),
        this.tool("scroll", "Scroll an element (a list, document or page) up or down by a few steps. Borrows the user's mouse, so the user is asked first.",
          z.object({ id, direction: z.enum(["up", "down", "left", "right"]), steps: z.number().int().min(1).max(30).optional() }),
          async a => this.scroll(a.id, a.direction, a.steps ?? 5)),
      ] : []),
      this.tool("point_at", "Point at an element so the user can do this step themselves: Ember flies next to it, highlights it and shows your short instruction.",
        z.object({ id, say: z.string().min(1).max(160).describe("A short instruction, e.g. \"Click Display\"") }),
        async a => {
          const node = this.known.get(a.id);
          if (!node?.bounds) return fail(`Element ${a.id} is not in your latest perceive_window (or has no position). Call perceive_window.`);
          this.guideStep++;
          this.fly(node.bounds);
          this.d.presenter.guide(a.say, `Step ${this.guideStep}`);
          this.d.audit.write({ event: "action", task: this.spec.id, kind: "point", app: this.window.app, element: { role: node.role, name: node.name || this.labels.get(a.id) || "" }, ok: true });
          return done(`Pointing at [${a.id}]. Now call wait_for_click with id ${a.id}.`);
        }),
      this.tool("wait_for_click", "Wait until the user clicks the element you pointed at (or it changes, e.g. a switch turns on, or the window changes).",
        z.object({ id, timeoutSeconds: z.number().int().min(5).max(300).optional() }),
        async a => this.waitForClick(a.id, (a.timeoutSeconds ?? 90) * 1000)),
      this.tool("report_progress", "Tell the user briefly how the task is going (shown on Ember's task card).", z.object({ text: z.string().max(200) }),
        async a => { this.d.onProgress(a.text); return done("Shown."); }),
      this.tool("finish_task", "End the task with a one or two sentence summary for the user.",
        z.object({ success: z.boolean(), summary: z.string().max(400) }),
        async a => {
          this.result = { success: a.success, summary: a.summary };
          // The task is over: end the turn, so a model that keeps going can't act any more.
          setTimeout(() => { void this.session?.abort().catch(() => undefined); }, 50);
          return done("Task closed. Stop now.");
        }),
    ];
  }

  async run(signal: AbortSignal): Promise<WorkerResult> {
    const d = this.d;
    // Stopped before it began (Stop pressed right after asking): nothing is created or sent.
    if (signal.aborted) return { success: false, summary: "Stopped.", stopped: true };
    const onAbort = () => this.stopNow(null);
    signal.addEventListener("abort", onAbort, { once: true });
    const maxMs = d.limits?.maxMs ?? 20 * 60_000;
    const deadline = setTimeout(() => this.stopNow(`I stopped because the task took longer than ${Math.round(maxMs / 60_000)} minutes.`), maxMs);
    deadline.unref?.();
    let lastAnswer = "";
    try {
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
      // A turn ends at idle or error; after Stop it ends at the latest a moment later, even if the runtime is gone.
      const idle = () => new Promise<void>((resolve, reject) => {
        let grace: ReturnType<typeof setTimeout> | null = null;
        const settle = (fn: () => void) => { off(); if (grace) clearTimeout(grace); this.halt.signal.removeEventListener("abort", onHalt); fn(); };
        const off = session.on(e => {
          if (e.type === "session.idle") settle(resolve);
          if (e.type === "session.error") settle(() => reject(new Error(String((e.data as { message?: string }).message ?? "session error"))));
        });
        const onHalt = () => { grace = setTimeout(() => settle(resolve), STOP_GRACE_MS); };
        if (this.halted) onHalt(); else this.halt.signal.addEventListener("abort", onHalt, { once: true });
      });
      session.on(e => {
        d.presenter.event(e as { type: string; data?: Record<string, unknown> });
        if (e.type === "assistant.message") lastAnswer = String((e.data as { content?: string }).content ?? lastAnswer);
        if (e.type === "assistant.usage") d.onUsage?.(e.data.inputTokens ?? 0, e.data.outputTokens ?? 0);
        // The task card follows the current step ("Typing…"); the model's own progress notes replace it.
        if (e.type === "tool.execution_start") {
          const name = String((e.data as { toolName?: string }).toolName ?? "");
          if (name !== "report_progress" && name !== "finish_task" && TOOL_STEPS[name]) d.onProgress(`${TOOL_STEPS[name]}…`);
        }
      });
      if (!this.halted) {
        d.presenter.taskStarted();
        // Where the user was is screen text (a page can set its own title): it goes in as untrusted data.
        const t = this.spec.target;
        const where = t.title
          ? `\n<context untrusted="true">The user was in the window ${q(t.title, 160)}${t.app ? ` (app ${q(t.app, 60)})` : ""} when they asked; start there unless the goal needs another app.</context>`
          : "";
        let wait = idle();
        await session.send({ prompt: `Task: ${this.spec.goal}${where}` });
        await wait;
        if (!this.result && !this.halted) {
          wait = idle();
          await session.send({ prompt: "Call finish_task now with a short summary of what you did." });
          await wait;
        }
      }
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener("abort", onAbort);
      d.flyTo(null);
      if (this.place) d.onDesk?.(null);
    }
    if (this.halted && this.haltReason === null) return { success: false, summary: "Stopped.", stopped: true };
    if (this.haltReason) return { success: false, summary: this.result?.summary ? `${this.haltReason} ${this.result.summary}` : this.haltReason };
    const result = this.result ?? { success: false, summary: lastAnswer || "The worker stopped without a summary." };
    return this.userTookOver && !result.success ? { ...result, stopped: true } : result;
  }

  /** The user's new instruction for this running task ("use Firefox instead"). */
  async steer(text: string): Promise<boolean> {
    if (!this.session || this.halted || this.result) return false;
    await this.session.send({ prompt: `<user_update>The user changed the task: ${text.replace(/</g, "‹")}</user_update>`, mode: "immediate" });
    return true;
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
      if (this.halted) return STOPPED();
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

  /** `expectTitle`: switch_window's request; nothing changes unless a window with that title is found. */
  private async perceive(image: boolean, expectTitle?: string): Promise<ToolResultObject> {
    const target = expectTitle ? { title: expectTitle } : this.target;
    const p = await this.perception.perceive({ image, scope: "window", target });
    if (this.halted) return STOPPED();
    if (p.blocked) {
      this.d.audit.write({ event: "decision", task: this.spec.id, kind: "read", app: p.window?.app ?? "", window: p.window?.name ?? p.x11Window?.title ?? "", tier: "never", verdict: "deny", reason: "private window (never-look list or a password prompt)" });
      return denied("This window is private (on the user's never-look list, or a password prompt). Don't use it; finish the task and say so.");
    }
    if (!p.window) return fail("That window can't be read (it is closed or exposes no accessibility information). Use list_windows.");
    // Never fall back to whatever the user is looking at: a title that matches nothing is an error.
    if (expectTitle && !p.window.name.toLowerCase().includes(expectTitle.toLowerCase())) {
      return fail(`No open window has ${q(expectTitle, 100)} in its title. Use list_windows and pick one of those titles.`);
    }
    this.window = { app: p.window.app, name: p.window.name };
    this.target = { title: p.window.name, pid: p.window.pid ?? undefined };
    this.known = new Map(p.nodes.map(n => [n.id, n]));
    this.labels = inferLabels(p.nodes);
    const result: ToolResultObject = { textResultForLlm: p.text, resultType: "success" };
    if (p.capture) result.binaryResultsForLlm = [{ type: "image", mimeType: p.capture.mimeType, data: p.capture.data.toString("base64"), description: "The window with numbered marks matching element ids" }];
    return result;
  }

  /**
   * The element as it is now. The policy decides on what is on screen at the
   * moment of acting, not on a list read minutes ago (a "Next" button can become "Install").
   */
  private async fresh(id: number): Promise<{ node: AxNode; element: { role: string; name: string } } | ToolResultObject> {
    const node = this.known.get(id);
    if (!node) return fail(`Element ${id} is not in your latest perceive_window. Call perceive_window and use its ids.`);
    const live = await this.sidecar.readElement(id).catch(() => null);
    if (this.halted) return STOPPED();
    if (!live) return fail(`Element ${id} is gone (the window changed). Call perceive_window.`);
    if (live.role !== node.role) return fail(`Element ${id} has changed (it is now a ${live.role}). Call perceive_window.`);
    if (isDisabled(live.states)) return fail(`Element ${id} is disabled right now, so it can't be used. Call perceive_window to see why.`);
    const current: AxNode = { ...node, name: live.name, states: live.states, bounds: live.bounds ?? node.bounds };
    this.known.set(id, current);
    return { node: current, element: { role: current.role, name: current.name || this.labels.get(id) || "" } };
  }

  /** After a question was up, the element must still be the one the user said yes to. */
  private async stillSame(id: number, element: { role: string; name: string }): Promise<ToolResultObject | null> {
    if (!this.asked) return null;
    const live = await this.sidecar.readElement(id).catch(() => null);
    if (this.halted) return STOPPED();
    const name = live ? live.name || this.labels.get(id) || "" : null;
    if (!live || live.role !== element.role || name !== element.name) {
      return fail(`Element ${id} changed while the user was deciding, so nothing was done. Call perceive_window and ask again if it's still needed.`);
    }
    return null;
  }

  /** Policy check, confirmation, lease, motion, action, audit: the one path every window action takes. */
  private async act(kind: ActionKind, id: number, value: string | undefined, run: () => Promise<ActionResult>, mode?: TextMode): Promise<ToolResultObject> {
    if (this.place?.userInControl()) return denied("The user has taken over your desk. Wait for them, or finish the task saying where you got to.");
    const f = await this.fresh(id);
    if (!("node" in f)) return f;
    const { node, element } = f;
    const req: ActionRequest = {
      taskId: this.spec.id, kind, app: this.window.app, window: this.window.name, element, value,
      ...(kind === "text" ? { mode: mode ?? "replace", currentText: node.text } : {}),
    };
    const verdict = await this.authorize(req);
    if (verdict) return verdict;
    const changed = await this.stillSame(id, element);
    if (changed) return changed;
    const release = await this.d.lease(this.window.name || this.window.app, this.spec.id, this.halt.signal);
    try {
      if (this.halted) return STOPPED();
      if (node.bounds) this.fly(node.bounds);
      await new Promise(r => setTimeout(r, 350)); // let Ember arrive, so the user sees where it acts
      if (this.halted) return STOPPED();
      const res = await run();
      if (res.after) this.known.set(id, { ...node, name: res.after.name, states: res.after.states, bounds: res.after.bounds ?? node.bounds });
      this.d.audit.write({ event: "action", task: this.spec.id, kind, app: req.app, window: req.window, element: req.element, ok: res.ok, ...auditValue(req), after: { states: res.after.states, selected: res.after.selected } });
      return done(`${res.ok ? "Done" : "The app reported it did not work"}. Now: ${describeAfter(res.after)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.d.audit.write({ event: "action", task: this.spec.id, kind, app: req.app, element: req.element, ok: false, error: msg });
      if (msg.includes("background_unavailable")) {
        release();
        // The router: tier 1 can't do it, so try tier 3 (the user's mouse), with their OK.
        if ((this.place || this.d.cursor) && node.bounds && (kind === "click" || kind === "toggle" || kind === "text")) {
          this.d.log.info("router.escalate", { task: this.spec.id, from: "tier1", to: this.place ? "tier2-desk" : "tier3", kind, role: node.role });
          return this.cursorAct(kind === "text" ? "cursor_text" : "cursor_click", id, node, value, mode);
        }
        return fail(`${msg.replace("background_unavailable: ", "")}. This can't be done without the mouse; tell the user in finish_task.`);
      }
      // A slow app may still carry out a request after Ember stopped waiting for it.
      if (/did not answer/.test(msg)) return fail("The app didn't answer in time, so it's unknown whether this happened. Call perceive_window to check before trying again.");
      return fail(msg);
    } finally {
      release();
    }
  }

  /** Tier 3: borrow the mouse (and keyboard) for one action, with the user's OK. */
  private async cursorAct(kind: "cursor_click" | "cursor_text", id: number, node: AxNode, value?: string, mode: TextMode = "replace"): Promise<ToolResultObject> {
    if (kind === "cursor_text" && !typeableText(value ?? "")) {
      return fail("This app only takes typed text, and Ember can only type plain ASCII letters, digits and punctuation with the keyboard. Tell the user in finish_task.");
    }
    const element = { role: node.role, name: node.name || this.labels.get(id) || "" };
    const verdict = await this.authorize({ taskId: this.spec.id, kind, app: this.window.app, window: this.window.name, element, value, ...(kind === "cursor_text" ? { mode, currentText: node.text } : {}) });
    if (verdict) return verdict;
    const b = node.bounds!;
    const cx = b.x + Math.min(b.width / 2, 120), cy = b.y + b.height / 2;
    return this.withCursor(kind, element, async hand => {
      await hand.glideTo(cx, cy);
      await hand.click();
      if (kind === "cursor_text") {
        // Only "replace" selects what is there; append goes to the end, insert types where the click put the caret.
        if (mode === "replace") await hand.keys("ctrl+a");
        else if (mode === "append") await hand.keys("ctrl+End");
        await hand.type(value ?? "");
      }
    }, id);
  }

  private async pressKeys(keys: string): Promise<ToolResultObject> {
    // Keys go to whatever has focus in the window: the policy decides on that element (never a password field).
    const seen = await this.perception.read(this.target).catch(() => null);
    if (this.halted) return STOPPED();
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
    if (this.halted) return STOPPED();
    if (this.place) return this.onDeskInput(this.place, kind, element, fn, verifyId);
    if (!this.d.cursor) return fail("This needs the mouse or keyboard, which isn't available here. Try open_on_desk.");
    const c = this.d.cursor;
    // A password or authentication prompt has the keyboard: those are the user's alone (M8.3).
    const authPrompt = () => { const w = c.activeWindow?.(); return !!w && isSecurityWindow(w); };
    if (authPrompt()) {
      this.d.audit.write({ event: "decision", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, tier: "never", verdict: "deny", reason: "an authentication prompt has the keyboard" });
      return denied("An authentication prompt is open on the user's screen. That's for the user only: wait, or finish the task saying what's left.");
    }
    const guarded = (hand: Hand): Hand => {
      const check = () => {
        if (this.halted) throw new BorrowStopped();
        if (authPrompt()) throw new Error("an authentication prompt took the keyboard, so Ember stopped");
      };
      return {
        ...hand,
        glideTo: async (x, y) => { check(); await hand.glideTo(x, y); },
        click: async b => { check(); await hand.click(b); },
        keys: async k => { check(); await hand.keys(k); },
        type: async t => { for (const part of t.match(/[\s\S]{1,8}/g) ?? []) { check(); await hand.type(part); } },
      };
    };
    const release = await this.d.lease(this.window.name || this.window.app, this.spec.id, this.halt.signal);
    // Stopped while waiting for another task's window: the approved borrow never starts.
    if (this.halted) { release(); return STOPPED(); }
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
      if (err instanceof BorrowStopped) return STOPPED();
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
    const release = await this.d.lease(`desk:${this.window.name || this.window.app}`, this.spec.id, this.halt.signal);
    if (this.halted) { release(); return STOPPED(); }
    this.deskBorrow ??= new CursorBorrow(place.input);
    const guarded = (hand: Hand): Hand => {
      const check = () => { if (this.halted) throw new BorrowStopped(); };
      return {
        ...hand,
        glideTo: async (x, y) => { check(); await hand.glideTo(x, y); },
        click: async b => { check(); await hand.click(b); },
        keys: async k => { check(); await hand.keys(k); },
        type: async t => { check(); await hand.type(t); },
      };
    };
    try {
      await this.deskBorrow.borrow(hand => fn(guarded(hand)), { idleMs: 0, window: this.window.name ? place.input.findWindow(this.window.name) || undefined : undefined });
      const after = verifyId !== undefined ? await place.sidecar.readElement(verifyId).catch(() => null) : null;
      this.d.audit.write({ event: "action", task: this.spec.id, kind, app: this.window.app, window: this.window.name, element, ok: true, tier: 2 });
      return done(`Done on your desk.${after ? ` Now: ${describeAfter(after)}` : " Call perceive_window to check the result."}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.d.audit.write({ event: "action", task: this.spec.id, kind, app: this.window.app, element, ok: false, tier: 2, error: msg });
      if (err instanceof UserTookOver) return denied("The user took over your desk. Stop and finish the task, saying where you got to.");
      if (err instanceof BorrowStopped) return STOPPED();
      return fail(msg);
    } finally {
      release();
    }
  }

  /** Tier 0 actions (settings, launching): policy and audit, no window. `app`: the app being launched. */
  private async system(kind: "setting" | "open_app", value: string, run: () => Promise<string>, app = ""): Promise<ToolResultObject> {
    const verdict = await this.authorize({ taskId: this.spec.id, kind, app, window: "", value });
    if (verdict) return verdict;
    if (this.halted) return STOPPED();
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
  private async authorize(request: ActionRequest): Promise<ToolResultObject | null> {
    this.asked = false;
    if (this.halted) return STOPPED();
    const req = { ...request, onDesk: !!this.place, goal: this.spec.goal };
    let decision = this.d.policy.decide(req);
    if (decision.aligned === false) this.tainted = true;
    // After something on screen tried to steer Ember, nothing more happens without the user's click.
    if (this.tainted && decision.verdict === "allow" && decision.tier !== "read") {
      decision = { ...decision, verdict: "confirm", tier: "confirm", everyTime: true, remember: false,
        reason: `${decision.reason}; something on screen asked for an action you didn't`,
        prompt: `${decision.prompt.replace(/\?$/, "")}? (I'm checking each step: something on screen asked me to do something you didn't.)` };
    }
    const sessionAllowed = decision.verdict === "confirm" && !decision.risky && !decision.everyTime && this.allowedApps.has(req.app.toLowerCase());
    this.d.audit.write({ event: "decision", task: this.spec.id, kind: req.kind, app: req.app, window: req.window, element: req.element, ...auditValue(req), tier: decision.tier, verdict: sessionAllowed ? "allow" : decision.verdict, reason: decision.reason, ...(decision.aligned === false ? { aligned: false } : {}) });
    if (decision.verdict === "deny") return denied(`Not allowed: ${decision.reason}. Don't try another way; tell the user in finish_task.`);
    if (decision.verdict === "allow" || sessionAllowed) return null;
    const options = decision.needsGrant && decision.remember && req.app
      ? [{ id: "once", label: "Allow", primary: true }, { id: "always", label: `Always in ${req.app}` }, { id: "deny", label: "Not now" }]
      : [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }];
    const context = this.spec.goal.length > 40 ? this.spec.goal.slice(0, 39) + "…" : this.spec.goal;
    this.asked = true;
    const answer = await this.d.confirmer.ask({ title: "May I?", context, prompt: decision.prompt, options }, this.halt.signal);
    this.d.audit.write({ event: "confirm", task: this.spec.id, kind: req.kind, app: req.app, element: req.element, answer: this.halted ? "stopped" : answer ?? "expired" });
    if (this.halted) return STOPPED();
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

/** What the audit log keeps about an action's value: keys and choices in full, typed text only as a length. */
function auditValue(r: ActionRequest): Record<string, unknown> {
  if (r.value === undefined) return {};
  if (r.kind === "text" || r.kind === "cursor_text") return { chars: r.value.length, ...(r.mode ? { mode: r.mode } : {}) };
  return { value: r.value.slice(0, 120) };
}
