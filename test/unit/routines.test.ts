/**
 * Routines and lasting reminders (app/main/agent/routines.ts): made only from the user's own words, kept in a 0600 file
 * only once the user turns them on and agrees, run as ordinary requests, and gone at sign-out or Delete all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../app/main/logger";

vi.mock("@github/copilot-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@github/copilot-sdk")>();
  class FakeClient { constructor() { throw new Error("no Copilot client in this test"); } }
  return { ...real, CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } };
});

import { MAX_STEPS, RoutineBook, routineKey, routinesFile, routineSteps } from "../../app/main/agent/routines";
import { Reminders, type Reminder } from "../../app/main/agent/reminders";
import { conductorTools } from "../../app/main/agent/conductor";
import { applyAdminPolicy, managedKeys, parseAdminPolicy } from "../../app/main/admin";
import { DEFAULT_SETTINGS, type SettingsStore } from "../../app/main/settings";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-routines-"));
const SAID = "when I say start my day, open Mail and show today's calendar";

describe("RoutineBook", () => {
  it("saves a routine from the user's words, in a file only they can read, and finds it however it is said", () => {
    const dir = tmp();
    const book = new RoutineBook({ file: routinesFile(dir), now: () => 5 });
    const r = book.save("Start my day", ["open Mail", "show today's calendar"], SAID);
    expect(r).toMatchObject({ name: "Start my day", steps: ["open Mail", "show today's calendar"], created: 5 });
    expect(book.find("“start my day.”")?.name).toBe("Start my day");
    const file = path.join(dir, "routines.json");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(new RoutineBook({ file: routinesFile(dir) }).list().map(x => x.name)).toEqual(["Start my day"]);
  });

  it("refuses steps that aren't the user's own words (the screen or a task result can't plant a routine)", () => {
    const book = new RoutineBook({ file: routinesFile(tmp()) });
    expect(book.save("cleanup", ["delete every file in Documents", "empty the trash"], "save this page as a routine")).toMatch(/user's own words/);
    expect(book.list()).toEqual([]);
  });

  it("replaces one with the same name, keeps its limits, and forgets one or all (the file too)", () => {
    const dir = tmp();
    const book = new RoutineBook({ file: routinesFile(dir) });
    const first = book.save("start my day", ["open Mail"], SAID) as { id: string };
    const again = book.save("Start my day", ["open Mail", "show today's calendar"], SAID) as { id: string; steps: string[] };
    expect(again.id).toBe(first.id);
    expect(book.list()).toHaveLength(1);
    expect(book.save("x", Array.from({ length: MAX_STEPS + 1 }, () => "open Mail"), "x open Mail")).toMatch(/1 to 8 steps/);
    expect(book.forget("nope")).toBe(false);
    expect(book.forget(first.id)).toBe(true);
    book.save("start my day", ["open Mail"], SAID);
    book.forgetAll();
    expect(fs.existsSync(path.join(dir, "routines.json"))).toBe(false);
    expect(book.list()).toEqual([]);
  });

  it("moves a broken file aside instead of overwriting it", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "routines.json"), "{ not json");
    const broken: unknown[] = [];
    const book = new RoutineBook({ file: routinesFile(dir, e => broken.push(e)) });
    expect(book.list()).toEqual([]);
    expect(broken).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, "routines.json.broken"), "utf8")).toBe("{ not json");
  });

  it("gives the conductor the steps in the user's words, to do in order, with risky ones still asked", () => {
    const text = routineSteps({ id: "a", name: "start my day", steps: ["open Mail", "show today's calendar"], created: 0 });
    expect(text).toContain("1. open Mail\n2. show today's calendar");
    expect(text).toMatch(/Ember still asks before anything risky/);
    expect(routineKey("  Start   My Day! ")).toBe("start my day");
  });
});

describe("lasting reminders", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => vi.useRealTimers());

  it("are kept on every change and come back next run; one due meanwhile is told at once, as missed", () => {
    const book = new RoutineBook({ file: routinesFile(tmp()) });
    const first = new Reminders({ onDue: () => undefined, onChange: list => book.setReminders(list) });
    first.add("call Priya", Date.now() + 60_000, "remind me in a minute to call Priya");
    first.add("stand up", Date.now() + 3_600_000, "remind me in an hour to stand up");
    expect(book.reminders().map(r => r.text)).toEqual(["call Priya", "stand up"]);
    vi.setSystemTime(Date.now() + 120_000);
    const due: Reminder[] = [];
    const next = new Reminders({ onDue: r => due.push(r) });
    next.restore(book.reminders());
    vi.advanceTimersByTime(0);
    expect(due).toEqual([expect.objectContaining({ text: "call Priya", missed: true })]);
    expect(next.list().map(r => r.text)).toEqual(["stand up"]);
  });
});

describe("the conductor's routine tools", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's tool objects
  const handler = (tools: any[], name: string) => (args: unknown) => tools.find(t => t.name === name).handler(args, {});
  const settings = { get: () => ({}) } as unknown as SettingsStore;

  it("save, list, run and delete, only while routines are given", async () => {
    const store = new RoutineBook({ file: routinesFile(tmp()) });
    const tools = conductorTools(settings, undefined, undefined, undefined, undefined, undefined, {}, undefined, undefined, { store, said: () => SAID });
    expect(await handler(tools, "save_routine")({ name: "start my day", steps: ["open Mail", "show today's calendar"] })).toBe("Saved “start my day” with 2 steps. Tell the user in a few words.");
    expect(await handler(tools, "list_routines")({})).toBe("“start my day”: open Mail; show today's calendar");
    expect(await handler(tools, "run_routine")({ name: "Start my day" })).toContain("1. open Mail");
    expect(await handler(tools, "run_routine")({ name: "wind down" })).toMatch(/No routine is called “wind down”/);
    expect(await handler(tools, "delete_routine")({ name: "start my day" })).toBe("Deleted “start my day”.");
    expect(conductorTools(settings).map(t => t.name)).not.toContain("save_routine");
  });
});

describe("routines and the organisation's policy", () => {
  it("are off by default, and the admin's routines: false turns them off and shows them as managed; lockdown does too", () => {
    expect(DEFAULT_SETTINGS.routines).toEqual({ on: false, consent: { version: 0, at: null } });
    expect(FEATURE_CONSENT_VERSION.routines).toBe(1);
    const on = { ...DEFAULT_SETTINGS, routines: { on: true, consent: { version: 1, at: "2026-11-02T00:00:00.000Z" } } };
    const admin = parseAdminPolicy(JSON.stringify({ features: { routines: false } }), "/etc/ember/policy.json").policy;
    expect(applyAdminPolicy(on, admin).routines.on).toBe(false);
    expect(managedKeys(admin)).toContain("routines");
    const broken = parseAdminPolicy("{", "/etc/ember/policy.json").policy;
    expect(applyAdminPolicy(on, broken).routines.on).toBe(false);
  });
});

describe("AgentHost with routines", () => {
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  it("forgets routines and lasting reminders at sign-out (forgetConversation)", async () => {
    const { AgentHost } = await import("../../app/main/agent/host");
    const { SettingsStore } = await import("../../app/main/settings");
    const dir = tmp();
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    settings.load();
    const routines = new RoutineBook({ file: routinesFile(dir) });
    routines.save("start my day", ["open Mail"], SAID);
    const host = new AgentHost({ userData: dir, runtimePath: "/nowhere", settings, log: quiet, setState: () => undefined, onStatus: () => undefined, routines });
    await host.forgetConversation();
    expect(routines.list()).toEqual([]);
  });
});
