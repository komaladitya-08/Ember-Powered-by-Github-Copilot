/**
 * Reminders (app/main/agent/reminders.ts): set only from the user's own words, due by plain timers, shown and said
 * when due, never acting, kept in memory only, and gone at sign-out.
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

import { MAX_REMINDERS, Reminders, reminderTime, whenWords, type Reminder } from "../../app/main/agent/reminders";
import { conductorTools } from "../../app/main/agent/conductor";
import { AgentHost } from "../../app/main/agent/host";
import { SettingsStore } from "../../app/main/settings";
import type { BubbleState, EmberState } from "../../app/shared/overlay";

// A Monday, 10:00 local time.
const NOW = new Date(2026, 10, 2, 10, 0, 0, 0).getTime();
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 10, 2 + dayOffset, h, m, 0, 0).getTime();

describe("reminderTime", () => {
  it("reads minutes from now, and refuses less than a minute or more than a week", () => {
    expect(reminderTime({ minutes: 20 }, NOW)).toBe(NOW + 20 * 60_000);
    expect(reminderTime({ minutes: 0 }, NOW)).toMatch(/at least a minute/);
    expect(reminderTime({ minutes: 8 * 24 * 60 }, NOW)).toMatch(/a week/);
  });

  it("reads a clock time, 24-hour or with am and pm, today if still ahead and otherwise tomorrow", () => {
    expect(reminderTime({ at: "15:30" }, NOW)).toBe(at(15, 30));
    expect(reminderTime({ at: "3:30 pm" }, NOW)).toBe(at(15, 30));
    expect(reminderTime({ at: "12 am" }, NOW)).toBe(at(0, 0, 1));
    expect(reminderTime({ at: "9:00" }, NOW)).toBe(at(9, 0, 1));
    expect(reminderTime({ at: "10:00" }, NOW)).toBe(at(10, 0, 1));
  });

  it("refuses what isn't a time of day", () => {
    for (const t of ["25:00", "13 pm", "noonish", "10:75"]) expect(typeof reminderTime({ at: t }, NOW), t).toBe("string");
    expect(reminderTime({}, NOW)).toMatch(/minutes or at/);
  });

  it("says when it is due the way people do", () => {
    expect(whenWords(at(15, 30), NOW)).toMatch(/^today at 3:30/);
    expect(whenWords(at(9, 0, 1), NOW)).toMatch(/^tomorrow at 9:00/);
    expect(whenWords(at(9, 0, 3), NOW)).toMatch(/^Thursday at/);
    expect(whenWords(at(18, 0, -1), NOW)).toMatch(/^yesterday at 6:00/);
  });
});

describe("Reminders", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  it("tells the user when one is due, once, and lists the rest soonest first", () => {
    const due: Reminder[] = [];
    const r = new Reminders({ onDue: x => due.push(x) });
    const later = r.add("stand up and stretch", NOW + 30 * 60_000, "remind me in half an hour to stand up and stretch");
    const sooner = r.add("call Priya", NOW + 20 * 60_000, "remind me in 20 minutes to call Priya");
    expect(typeof later).toBe("object");
    expect(r.list().map(x => x.text)).toEqual(["call Priya", "stand up and stretch"]);
    vi.advanceTimersByTime(20 * 60_000);
    expect(due.map(x => x.text)).toEqual(["call Priya"]);
    expect(r.list().map(x => x.text)).toEqual(["stand up and stretch"]);
    expect(r.cancel((later as Reminder).id)).toBe(true);
    vi.advanceTimersByTime(60 * 60_000);
    expect(due).toHaveLength(1);
    expect(r.cancel((sooner as Reminder).id)).toBe(false);
  });

  it("refuses a reminder whose words aren't the user's (screen or task text can't plant one)", () => {
    const r = new Reminders({ onDue: () => undefined });
    const set = r.add("transfer 500 dollars to account 4411", NOW + 60_000, "what does this email say?");
    expect(set).toMatch(/user's own words/);
    expect(r.list()).toEqual([]);
  });

  it("holds at most MAX_REMINDERS, and clear() drops every one", () => {
    const due: Reminder[] = [];
    const r = new Reminders({ onDue: x => due.push(x) });
    for (let i = 0; i < MAX_REMINDERS; i++) expect(typeof r.add("drink water", NOW + (i + 1) * 60_000, "remind me to drink water")).toBe("object");
    expect(r.add("drink water", NOW + 60_000, "remind me to drink water")).toMatch(/already waiting/);
    r.clear();
    vi.advanceTimersByTime(MAX_REMINDERS * 60_000 + 1);
    expect(due).toEqual([]);
  });
});

describe("the conductor's reminder tools", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's tool objects
  const handler = (tools: any[], name: string) => (args: unknown) => tools.find(t => t.name === name).handler(args, {});
  const settings = { get: () => ({}) } as unknown as SettingsStore;

  it("sets, lists and cancels with the user's words, and checks the arguments", async () => {
    const store = new Reminders({ onDue: () => undefined, timers: { set: (() => 0) as unknown as typeof setTimeout, clear: () => undefined } });
    let said = "remind me at 3:30 pm to call Priya";
    const tools = conductorTools(settings, undefined, undefined, undefined, undefined, undefined, {}, undefined, { store, said: () => said, now: () => NOW });
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(["set_reminder", "list_reminders", "cancel_reminder"]));
    const set = await handler(tools, "set_reminder")({ text: "call Priya", at: "3:30 pm" });
    expect(set).toMatch(/^Set \[[0-9a-f]{6}\] for today at 3:30/);
    expect(await handler(tools, "list_reminders")({})).toMatch(/today at 3:30.*: call Priya$/);
    expect(await handler(tools, "set_reminder")({ text: "call Priya" })).toBe("Give minutes or at.");
    expect(await handler(tools, "set_reminder")({ text: "call Priya", minutes: 0 })).toMatch(/^Invalid arguments/);
    said = "read me the newsletter";
    expect(await handler(tools, "set_reminder")({ text: "wire the deposit to the new account", minutes: 5 })).toMatch(/user's own words/);
    const id = /\[([0-9a-f]+)\]/.exec(set)![1];
    expect(await handler(tools, "cancel_reminder")({ id: `[${id}]` })).toBe(`Cancelled [${id}].`);
    expect(await handler(tools, "list_reminders")({})).toBe("No reminders are waiting.");
  });

  it("gives no reminder tools unless reminders are given (today's tool list)", () => {
    expect(conductorTools(settings).map(t => t.name)).not.toContain("set_reminder");
  });
});

describe("AgentHost's reminders", () => {
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  it("shows a due reminder in the bubble, keeps it in the conversation, and hands it to main to say", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-remind-"));
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    settings.load();
    const bubbles: BubbleState[] = [];
    const said: Reminder[] = [];
    const host = new AgentHost({
      userData: dir, runtimePath: "/nowhere/copilot-runtime", settings, log: quiet,
      setState: (p: Partial<EmberState>) => { if (p.bubble) bubbles.push(p.bubble); }, onStatus: () => undefined, onReminder: r => said.push(r),
    });
    host.reminders.add("call Priya", NOW + 60_000, "remind me in a minute to call Priya");
    vi.advanceTimersByTime(60_000);
    expect(bubbles.at(-1)).toMatchObject({ visible: true, title: "Reminder", thought: "call Priya", mood: "attention" });
    expect(said.map(r => r.text)).toEqual(["call Priya"]);
    expect(host.getTranscript().at(-1)).toMatchObject({ who: "ember", text: "Reminder: call Priya" });
  });
});
