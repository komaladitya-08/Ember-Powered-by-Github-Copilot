/**
 * A worker on the real Copilot runtime (offline scripted model) operates the
 * GTK3 bench through the real AT-SPI sidecar: switch, text, button, and a
 * refused password field, with policy, confirmation and audit in the loop.
 * Needs a desktop session with pyatspi (skipped otherwise; EMBER_ATSPI_TEST=1 requires it).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";
import { AtspiSidecar, pickPython } from "../../app/main/perception/sidecar";
import { Perception } from "../../app/main/perception";
import { PolicyEngine } from "../../app/main/policy/policy";
import { AuditLog } from "../../app/main/policy/audit";
import { Confirmer } from "../../app/main/agent/confirm";
import { Presenter } from "../../app/main/agent/presenter";
import { Worker } from "../../app/main/agent/worker";
import { locateRuntime } from "../../app/main/agent/runtime";
import { SettingsStore } from "../../app/main/settings";
import { openXInput } from "../../app/main/hands/input";
import { CursorBorrow } from "../../app/main/hands/borrow";
import type { EmberState } from "../../app/shared/overlay";
import type { Logger } from "../../app/main/logger";

const python = pickPython();
const available = !!process.env.DISPLAY && spawnSync(python, ["-c", "import pyatspi, gi"], { stdio: "ignore" }).status === 0;
const required = process.env.EMBER_ATSPI_TEST === "1";
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
/**
 * The simulated user answers 20 ms after a question shows. Ember's own Confirmer ignores clicks in a
 * question's first moments and pauses between questions (against double-clicks), so here a question
 * takes an answer at once.
 */
const userTiming = { timeoutMs: 30_000, armMs: 0, gapMs: 0 };

type Msg = { role: string; content: unknown };
const text = (m: Msg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
/** Finds an element id in the latest perceive_window result. */
const idOf = (messages: Msg[], pattern: RegExp) => {
  const screen = [...messages].reverse().find(m => m.role === "tool" && text(m).includes("<screen"));
  for (const line of text(screen!).split(/\\n|\n/)) {
    const m = /\[(\d+)\] (.*)/.exec(line);
    if (m && pattern.test(m[2])) return Number(m[1]);
  }
  throw new Error(`no element matching ${pattern}`);
};

describe.skipIf(!available && !required)("worker operating a real GTK window", () => {
  let bench: ChildProcess;
  let mock: { baseUrl: string; close(): Promise<void> };
  let client: CopilotClient;
  let sidecar: AtspiSidecar;
  const events: Record<string, unknown>[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-worker-"));

  beforeAll(async () => {
    bench = spawn(python, [path.resolve("test/fixtures/gtk3_bench.py")], { stdio: ["ignore", "pipe", "inherit"] });
    readline.createInterface({ input: bench.stdout! }).on("line", l => { try { events.push(JSON.parse(l)); } catch { /* not json */ } });
    // The scripted model: one step per tool result so far.
    mock = await startMockLlm({
      delayMs: 2,
      respond: (messages: Msg[]) => {
        const results = messages.filter(m => m.role === "tool");
        const step = results.length;
        if (text(messages.find(m => m.role === "user")!).includes("Show me how")) {
          // Guide: point at the switch, wait for the user, then finish.
          if (step === 0) return { tool: { name: "perceive_window", args: {} } };
          if (step === 1) return { tool: { name: "point_at", args: { id: idOf(messages, /^toggle button/), say: "Turn on this switch" } } };
          if (step === 2) return { tool: { name: "wait_for_click", args: { id: idOf(messages, /^toggle button/), timeoutSeconds: 20 } } };
          if (step === 3) return { tool: { name: "finish_task", args: { success: true, summary: "You turned on Night Light yourself." } } };
          return { text: "Done." };
        }
        if (text(messages.find(m => m.role === "user")!).includes("sketch pad")) {
          // Tier 3: the pad has no accessible actions, so a click escalates to the user's mouse.
          if (step === 0) return { tool: { name: "perceive_window", args: {} } };
          if (step === 1) return { tool: { name: "click", args: { id: idOf(messages, /"Sketch pad"/) } } };
          if (step === 2) return { tool: { name: "press_keys", args: { keys: "ctrl+s" } } };
          if (step === 3) return { tool: { name: "finish_task", args: { success: true, summary: "Clicked the pad and saved." } } };
          return { text: "Done." };
        }
        if (step === 0) return { reasoning: "Read the window first.", tool: { name: "perceive_window", args: {} } };
        if (step === 1) return { reasoning: "Night Light is the switch.", tool: { name: "toggle", args: { id: idOf(messages, /^toggle button/), on: true } } };
        if (step === 2) return { tool: { name: "type_text", args: { id: idOf(messages, /^text "Name"/), text: "Ada Lovelace", mode: "replace" } } };
        if (step === 3) return { tool: { name: "type_text", args: { id: idOf(messages, /^password text/), text: "hunter2", mode: "replace" } } };
        if (step === 4) return { tool: { name: "choose_option", args: { id: idOf(messages, /^combo box "Theme"/), option: "Dark" } } };
        if (step === 5) return { tool: { name: "click", args: { id: idOf(messages, /^push button "Save"/) } } };
        if (step === 6) return { tool: { name: "finish_task", args: { success: true, summary: "Night Light is on, the name is filled in and saved. I left the password for you." } } };
        return { text: "Done." };
      },
    });
    const runtime = locateRuntime({ appPath: process.cwd() });
    client = new CopilotClient({
      mode: "empty", baseDirectory: path.join(dir, "copilot"), useLoggedInUser: false,
      connection: RuntimeConnection.forStdio({ path: runtime.path }),
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    });
    await client.start();
    sidecar = new AtspiSidecar(path.resolve("sidecar/atspi/ember_atspi.py"), quiet, python);
    for (let i = 0; i < 50; i++) {
      const r = await sidecar.readWindow({ title: "Ember Test Bench" }).catch(() => null);
      if (r?.window && r.nodes.length > 5) break;
      await new Promise(res => setTimeout(res, 200));
    }
  }, 60_000);

  afterAll(async () => {
    sidecar?.stop();
    bench?.kill();
    await client?.stop();
    await mock?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("guides: points at the control and waits until the user clicks it", async () => {
    const xinput = openXInput()!;
    const settings = new SettingsStore(path.join(dir, "settings-guide.json"));
    settings.load();
    const states: Partial<EmberState>[] = [];
    const focus: unknown[] = [];
    const before = events.length;
    // Make sure Night Light starts off.
    const r = await sidecar.readWindow({ title: "Ember Test Bench" });
    const sw = r.nodes.find(n => n.role === "toggle button")!;
    if (sw.states.includes("checked")) await sidecar.doAction(sw.id, "toggle");
    const worker = new Worker({
      client, log: quiet, model: "mock-model", vision: false,
      provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
      workDir: path.join(dir, "empty"),
      perception: new Perception({ sidecar, x11: null, neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }), log: quiet }),
      sidecar, policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}) }),
      confirmer: new Confirmer(() => undefined), audit: new AuditLog(path.join(dir, "audit-guide")), settings,
      presenter: new Presenter(p => states.push(p)),
      lease: async () => () => undefined,
      flyTo: b => {
        focus.push(b);
        if (!b) return;
        // The user sees Ember pointing and clicks the control themselves (real X input).
        setTimeout(() => {
          const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
          xinput.move(cx, cy);
          setTimeout(() => { xinput.button(1, true); setTimeout(() => xinput.button(1, false), 150); }, 300);
        }, 800);
      },
      onProgress: () => undefined,
      pointer: () => xinput.pointerState(),
    }, { id: "g1", goal: "Show me how to turn on Night Light", target: { title: "Ember Test Bench" }, mode: "guide" });
    const result = await worker.run(new AbortController().signal);
    await worker.dispose();
    expect(result).toEqual({ success: true, summary: "You turned on Night Light yourself." });
    expect(states.some(s => s.bubble?.mood === "guiding" && s.bubble.thought === "Turn on this switch" && s.gesture === "point")).toBe(true);
    expect(events.slice(before)).toContainEqual(expect.objectContaining({ event: "toggled", name: "Night Light", active: true }));
    // A guide never acts itself: only point/user_clicked entries, no toggles by Ember.
    expect(worker.tools().map(t => t.name).sort()).toEqual(["finish_task", "list_windows", "perceive_window", "point_at", "report_progress", "switch_window", "wait_for_click"]);
    xinput.close();
  }, 120_000);

  it("borrows the mouse when accessibility can't do it, with the user's OK, and gives it back", async () => {
    const xinput = openXInput();
    expect(xinput).not.toBeNull();
    const settings = new SettingsStore(path.join(dir, "settings-t3.json"));
    settings.load();
    settings.update({ grants: { "gtk3_bench.py": "act" } });
    const asked: string[] = [];
    const confirmer: Confirmer = new Confirmer(p => {
      const actions = p.bubble?.actions ?? [];
      if (actions.length) { asked.push(p.bubble!.thought); setTimeout(() => confirmer.answer(actions[0].id), 20); }
    }, userTiming);
    const home = xinput!.pointer();
    const borrowing: string[] = [];
    const audit = new AuditLog(path.join(dir, "audit-t3"));
    const before = events.length;
    const worker = new Worker({
      client, log: quiet, model: "mock-model", vision: false,
      provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
      workDir: path.join(dir, "empty"),
      perception: new Perception({ sidecar, x11: null, neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }), log: quiet }),
      sidecar, policy: new PolicyEngine({ neverLook: () => [], grants: () => settings.get().grants }),
      confirmer, audit, settings,
      presenter: new Presenter(() => undefined),
      lease: async () => () => undefined,
      flyTo: () => undefined,
      onProgress: () => undefined,
      cursor: { borrow: new CursorBorrow(xinput!), findWindow: (t, pid) => xinput!.findWindow(t, pid), setBorrowing: on => borrowing.push(on) },
    }, { id: "w2", goal: "Click the sketch pad, then save with ctrl+s", target: { title: "Ember Test Bench" } });
    const result = await worker.run(new AbortController().signal);
    await worker.dispose();
    expect(result).toEqual({ success: true, summary: "Clicked the pad and saved." });
    expect(asked).toEqual([
      "Borrow your mouse to click the “Sketch pad” panel in gtk3_bench.py?\nYour task: Click the sketch pad, then save with ctrl+s",
      "Borrow your keyboard to press Ctrl+S on the “Save” button in gtk3_bench.py?\nYour task: Click the sketch pad, then save with ctrl+s",
    ]);
    await new Promise(r => setTimeout(r, 300));
    const mine = events.slice(before);
    expect(mine).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "pad-click", name: "Sketch pad", button: 1 }),
      expect.objectContaining({ event: "key", name: "s", ctrl: true }),
    ]));
    expect(xinput!.pointer()).toEqual(home); // handed back
    expect(borrowing).toEqual(["waiting", "active", "off", "waiting", "active", "off"]);
    const audited = fs.readFileSync(audit.file, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(audited.filter(e => e.event === "action" && e.tier === 3 && e.ok)).toHaveLength(2);
    xinput!.close();
  }, 120_000);

  it("does the task, asks before acting in a new app, and refuses the password field", async () => {
    // Earlier tests may have left Night Light on; this one turns it on itself.
    const fresh = await sidecar.readWindow({ title: "Ember Test Bench" });
    const nightLight = fresh.nodes.find(n => n.role === "toggle button")!;
    if (nightLight.states.includes("checked")) await sidecar.doAction(nightLight.id, "toggle");
    const states: Partial<EmberState>[] = [];
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    settings.load();
    const audit = new AuditLog(path.join(dir, "audit"));
    // The user clicks "Allow" on the first question.
    const asked: string[] = [];
    const confirmer: Confirmer = new Confirmer(p => {
      states.push(p);
      const actions = p.bubble?.actions ?? [];
      if (actions.length) {
        asked.push(p.bubble!.thought);
        setTimeout(() => confirmer.answer(actions[0].id), 20);
      }
    }, userTiming);
    const focus: unknown[] = [];
    const worker = new Worker({
      client, log: quiet, model: "mock-model", vision: false,
      provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
      workDir: path.join(dir, "empty"),
      perception: new Perception({ sidecar, x11: null, neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }), log: quiet }),
      sidecar, policy: new PolicyEngine({ neverLook: () => [], grants: () => settings.get().grants }),
      confirmer, audit, settings,
      presenter: new Presenter(p => states.push(p)),
      lease: async () => () => undefined,
      flyTo: b => focus.push(b),
      onProgress: () => undefined,
    }, { id: "w1", goal: "Turn on Night Light, put my name Ada Lovelace in, pick the dark theme and save", target: { title: "Ember Test Bench" } });

    const result = await worker.run(new AbortController().signal);
    await worker.dispose();

    expect(result).toEqual({ success: true, summary: "Night Light is on, the name is filled in and saved. I left the password for you." });
    // One question: the first action in this app. "Allow" covers the rest of the task.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Let me work in gtk3_bench\.py\? First step: turn on the “Night Light” switch\./);
    // What really happened in the app.
    await new Promise(r => setTimeout(r, 300));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "toggled", name: "Night Light", active: true }),
      expect.objectContaining({ event: "text", name: "Name", value: "Ada Lovelace" }),
      expect.objectContaining({ event: "selected", name: "Theme", value: "Dark" }),
      expect.objectContaining({ event: "clicked", name: "Save" }),
    ]));
    expect(events.some(e => e.name === "Password")).toBe(false);
    // Ember flew to each control it touched, then came back.
    expect(focus.length).toBeGreaterThanOrEqual(5);
    expect(focus.at(-1)).toBeNull();
    // The audit log has the refusal and every action.
    const audited = fs.readFileSync(audit.file, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(audited.some(e => e.event === "decision" && e.tier === "never" && e.element?.role === "password text")).toBe(true);
    expect(audited.filter(e => e.event === "action" && e.ok).length).toBe(4);
    // Reasoning and steps reached the bubble.
    expect(states.some(s => s.bubble?.step === "Flipping a switch")).toBe(true);
  }, 120_000);
});
