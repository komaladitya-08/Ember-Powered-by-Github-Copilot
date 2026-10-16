/**
 * A worker does a task on Ember's desk: a private display with its own bus.
 * It opens the app there, types, clicks something accessibility can't reach
 * and presses Ctrl+S with full XTest input, without asking the user and
 * without touching the user's pointer. Needs Xvfb, xauth, dbus-daemon and a
 * Python with pyatspi (skipped otherwise; EMBER_ATSPI_TEST=1 requires them).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";
import { pickPython, AtspiSidecar } from "../../app/main/perception/sidecar";
import { Perception } from "../../app/main/perception";
import { DeskManager } from "../../app/main/desk/desk";
import { openDeskPlace, type DeskPlace } from "../../app/main/desk/place";
import { PolicyEngine } from "../../app/main/policy/policy";
import { AuditLog } from "../../app/main/policy/audit";
import { Confirmer } from "../../app/main/agent/confirm";
import { Presenter } from "../../app/main/agent/presenter";
import { Worker } from "../../app/main/agent/worker";
import { locateRuntime } from "../../app/main/agent/runtime";
import { SettingsStore } from "../../app/main/settings";
import { openXInput } from "../../app/main/hands/input";
import { openX11 } from "../../app/main/x11";
import { deskAgentScript } from "../unit/desk-agent-build";
import type { Logger } from "../../app/main/logger";

const python = pickPython();
const available = DeskManager.available().ok && spawnSync(python, ["-c", "import pyatspi, gi"], { stdio: "ignore" }).status === 0;
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
type Msg = { role: string; content: unknown };
const text = (m: Msg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const idOf = (messages: Msg[], pattern: RegExp) => {
  const screen = [...messages].reverse().find(m => m.role === "tool" && text(m).includes("<screen"));
  for (const line of text(screen!).split(/\\n|\n/)) {
    const m = /\[(\d+)\] (.*)/.exec(line);
    if (m && pattern.test(m[2])) return Number(m[1]);
  }
  throw new Error(`no element matching ${pattern}`);
};

describe.skipIf(!available && process.env.EMBER_ATSPI_TEST !== "1")("worker on Ember's desk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-desk-test-"));
  const log = path.join(dir, "bench.jsonl");
  let mock: { baseUrl: string; close(): Promise<void> };
  let client: CopilotClient;
  let desk: DeskManager;
  let place: DeskPlace | null = null;

  beforeAll(async () => {
    // A launcher for the test bench, found like any installed app.
    const apps = path.join(dir, "share", "applications");
    fs.mkdirSync(apps, { recursive: true });
    fs.writeFileSync(path.join(apps, "ember-bench.desktop"), `[Desktop Entry]\nType=Application\nName=Ember Bench\nExec=${python} ${path.resolve("test/fixtures/gtk3_bench.py")}\n`);
    process.env.XDG_DATA_HOME = path.join(dir, "share");
    process.env.EMBER_BENCH_LOG = log;
    mock = await startMockLlm({
      delayMs: 2,
      respond: (messages: Msg[]) => {
        const step = messages.filter(m => m.role === "tool").length;
        const plan = [
          () => ({ tool: { name: "open_on_desk", args: { name: "Ember Bench" } } }),
          () => ({ tool: { name: "perceive_window", args: {} } }),
          () => ({ tool: { name: "type_text", args: { id: idOf(messages, /^text "Name"/), text: "Desk Worker", mode: "replace" } } }),
          () => ({ tool: { name: "click", args: { id: idOf(messages, /"Sketch pad"/) } } }),
          () => ({ tool: { name: "press_keys", args: { keys: "ctrl+s" } } }),
          () => ({ tool: { name: "finish_task", args: { success: true, summary: "Filled it in on my desk and saved." } } }),
        ];
        return (plan[step] ?? (() => ({ text: "Done." })))();
      },
    });
    client = new CopilotClient({
      mode: "empty", baseDirectory: path.join(dir, "copilot"), useLoggedInUser: false,
      connection: RuntimeConnection.forStdio({ path: locateRuntime({ appPath: process.cwd() }).path }),
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    });
    await client.start();
    desk = new DeskManager(quiet, { handOff: path.join(dir, "Ember"), env: { EMBER_BENCH_LOG: log }, display: 254, agent: deskAgentScript() });
  }, 60_000);

  afterAll(async () => {
    place?.close();
    desk?.stop();
    await client?.stop();
    await mock?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does the job on its desk with full input, asking nothing and leaving the user's pointer alone", async () => {
    const userInput = process.env.DISPLAY ? openXInput() : null;
    // Like Ember, hold a connection to the user's display first (a second display must still open).
    const userX11 = process.env.DISPLAY ? openX11() : null;
    const userPointer = userInput?.pointer() ?? null;
    const asked: string[] = [];
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    settings.load();
    const shown: (DeskPlace | null)[] = [];
    const worker = new Worker({
      client, log: quiet, model: "mock-model", vision: false,
      provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
      workDir: path.join(dir, "empty"),
      // The user's screen is never used in this task.
      perception: new Perception({ sidecar: new AtspiSidecar(path.resolve("sidecar/atspi/ember_atspi.py"), quiet, python), x11: null, neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), log: quiet }),
      sidecar: new AtspiSidecar(path.resolve("sidecar/atspi/ember_atspi.py"), quiet, python),
      policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}) }),
      // Nothing on the desk needs the user's OK: a question would be a failure, so it is noted and answered no at once.
      confirmer: (() => {
        const c: Confirmer = new Confirmer(p => {
          const actions = p.bubble?.actions ?? [];
          if (actions.length) { asked.push(p.bubble!.thought); setTimeout(() => c.answer(actions.find(a => a.id.endsWith(":deny"))!.id), 20); }
        }, { timeoutMs: 30_000, armMs: 0, gapMs: 0 });
        return c;
      })(),
      audit: new AuditLog(path.join(dir, "audit")), settings,
      presenter: new Presenter(() => undefined),
      lease: async () => () => undefined,
      flyTo: () => undefined,
      onProgress: () => undefined,
      desk: async () => (place ??= await openDeskPlace(desk, { sidecarScript: path.resolve("sidecar/atspi/ember_atspi.py"), log: quiet, neverLook: () => [], profiles: path.join(dir, "profiles") })),
      onDesk: p => shown.push(p),
    }, { id: "d1", goal: "Fill in the bench on your desk and save", target: {} });
    const t0 = Date.now();
    const result = await worker.run(new AbortController().signal);
    await worker.dispose();
    expect(result).toEqual({ success: true, summary: "Filled it in on my desk and saved." });
    expect(asked).toEqual([]);
    const events = fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "text", name: "Name", value: "Desk Worker" }),
      expect.objectContaining({ event: "pad-click", name: "Sketch pad" }),
      expect.objectContaining({ event: "key", name: "s", ctrl: true }),
    ]));
    expect(shown[0]).toBe(place);
    expect(shown.at(-1)).toBeNull();
    if (userInput) { expect(userInput.pointer()).toEqual(userPointer); userInput.close(); }
    userX11?.close();
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);

  it("cleans up: no display or bus left after stopping", async () => {
    const display = desk.running!.display;
    place?.close();
    place = null;
    desk.stop();
    await new Promise(r => setTimeout(r, 1800));
    expect(fs.existsSync(`/tmp/.X11-unix/X${display.slice(1)}`)).toBe(false);
  });
});
