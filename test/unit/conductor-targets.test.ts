/**
 * The conductor's target-aware tools and prompt (§2.6, §3.15): start_task and describe_screen take a `target`, and
 * list_computers and offer_connect exist, only with PromptCaps.targets (read when the conversation is created); the
 * model never connects anything itself; the host's trusted line goes before each request's untrusted context.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Conductor, conductorTools, type ConductorDeps } from "../../app/main/agent/conductor";
import { Reminders } from "../../app/main/agent/reminders";
import { emberSystemMessage, NO_CAPS } from "../../app/main/agent/persona";
import { Presenter, stepOf } from "../../app/main/agent/presenter";
import { SHORTCUTS } from "../../app/shared/shortcuts";
import type { EmberState } from "../../app/shared/overlay";
import { PLATFORM_WORDS } from "../../app/shared/words";
import type { PromptCaps } from "../../app/main/targets/types";
import type { SettingsStore } from "../../app/main/settings";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const settings = {} as SettingsStore;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-conductor-targets-"));
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const TARGETS: PromptCaps = { commands: false, targets: true };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types tool lists as Tool<any>[]
const byName = (tools: any[], name: string) => tools.find(t => t.name === name);
const shapeOf = (t: { parameters: unknown }) => Object.keys((t.parameters as z.ZodObject<z.ZodRawShape>).shape);
const run = (t: { handler: (a: unknown, i: unknown) => unknown }, args: Record<string, unknown>) => t.handler(args, {}) as Promise<string>;

describe("the conductor's tools with other computers (§2.6)", () => {
  it("offers list_computers and offer_connect, and a target on start_task and describe_screen, only with caps.targets", () => {
    const off = conductorTools(settings, async () => "", () => "", () => "", undefined, PLATFORM_WORDS.linux, { caps: { commands: true, targets: false } });
    expect(off.map(t => t.name)).toEqual(["set_appearance", "describe_screen", "start_task", "show_me"]);
    expect(shapeOf(byName(off, "start_task"))).toEqual(["goal"]);
    expect(shapeOf(byName(off, "describe_screen"))).toEqual([]);
    const on = conductorTools(settings, async () => "", () => "", () => "", undefined, PLATFORM_WORDS.linux, { caps: TARGETS });
    expect(on.map(t => t.name)).toEqual(["set_appearance", "describe_screen", "start_task", "show_me", "list_computers", "offer_connect"]);
    expect(shapeOf(byName(on, "start_task"))).toEqual(["goal", "target"]);
    expect(shapeOf(byName(on, "describe_screen"))).toEqual(["target"]);
    expect(shapeOf(byName(on, "offer_connect"))).toEqual(["name"]);
    expect(shapeOf(byName(on, "list_computers"))).toEqual([]);
    const target = (byName(on, "start_task").parameters as z.ZodObject<z.ZodRawShape>).shape.target as z.ZodOptional<z.ZodString>;
    expect(target.description).toBe("The computer the user named for this task, exactly as they said it (\"build-01\", \"Ubuntu\", \"this computer\"). Leave it out to use the one Ember is set to.");
  });

  it("passes the model's target through to the host, which decides with the user's own words", async () => {
    const started: [string, string | undefined][] = [];
    const described: (string | undefined)[] = [];
    const tools = conductorTools(settings, async t => { described.push(t); return "<screen/>"; }, (goal, t) => { started.push([goal, t]); return "started"; }, () => "", undefined,
      PLATFORM_WORDS.linux, { caps: TARGETS });
    await run(byName(tools, "start_task"), { goal: "check the disk", target: "build-01" });
    await run(byName(tools, "start_task"), { goal: "check the disk" });
    await run(byName(tools, "describe_screen"), { target: "Ubuntu" });
    await run(byName(tools, "describe_screen"), {});
    expect(started).toEqual([["check the disk", "build-01"], ["check the disk", undefined]]);
    expect(described).toEqual(["Ubuntu", undefined]);
    // A target is a name, not an essay.
    expect(await run(byName(tools, "start_task"), { goal: "check the disk", target: "x".repeat(81) })).toMatch(/^Invalid arguments for start_task/);
  });

  it("list_computers and offer_connect answer from the targets runtime, or say Ember can't", async () => {
    const offered: string[] = [];
    const tools = conductorTools(settings, undefined, undefined, undefined, undefined, PLATFORM_WORDS.linux, {
      caps: TARGETS, listComputers: () => "<computers>\n- This computer: apps and commands\n</computers>", offerConnect: n => { offered.push(n); return "Shown a Connect button."; },
    });
    expect(await run(byName(tools, "list_computers"), {})).toBe("<computers>\n- This computer: apps and commands\n</computers>");
    expect(await run(byName(tools, "offer_connect"), { name: "build-01" })).toBe("Shown a Connect button.");
    expect(offered).toEqual(["build-01"]);
    const bare = conductorTools(settings, undefined, undefined, undefined, undefined, PLATFORM_WORDS.linux, { caps: TARGETS });
    expect(await run(byName(bare, "list_computers"), {})).toBe("Ember works only on this computer now.");
    expect(await run(byName(bare, "offer_connect"), { name: "build-01" })).toBe("Ember can't connect to other computers now. Tell the user.");
  });
});

/** A conductor on a pretend client: the session's config and every prompt sent are kept. */
async function conductorWith(extra: Partial<ConductorDeps>, o: { send?: (prompt: string) => Promise<string> } = {}) {
  const sent: string[] = [];
  const listeners: ((e: { type: string; data?: unknown }) => void)[] = [];
  let config: { tools: { name: string; handler: (a: unknown, i: unknown) => unknown }[]; systemMessage: unknown } | null = null;
  const session = {
    sessionId: "ember-conductor-x",
    rpc: { tools: { initializeAndValidate: async () => ({}), getCurrentMetadata: async () => ({ tools: config!.tools.map(t => ({ name: t.name })) }) } },
    on: (l: (e: { type: string; data?: unknown }) => void) => { listeners.push(l); return () => undefined; },
    send: async (m: { prompt: string }) => { sent.push(m.prompt); return o.send ? o.send(m.prompt) : "m"; },
    abort: async () => undefined, disconnect: async () => undefined,
  };
  const client = { createSession: async (c: typeof config) => { config = c; return session; }, deleteSession: async () => undefined };
  const c = new Conductor({
    client: client as never, settings, presenter: new Presenter(() => undefined), log: quiet, stateFile: path.join(dir, `agent-${Math.random().toString(36).slice(2)}.json`),
    workDir: "/tmp", model: "m", ...extra,
  });
  await c.start();
  return { c, sent, config: () => config!, emit: (e: { type: string; data?: unknown }) => { for (const l of listeners) l(e); } };
}

describe("the conductor's session (§3.15)", () => {
  it("is created with the prompt and tools its caps allow, and today's without caps", async () => {
    const today = await conductorWith({});
    expect(today.config().systemMessage).toEqual(emberSystemMessage(PLATFORM_WORDS.linux));
    expect(today.c.toolNames).not.toContain("list_computers");
    const caps: PromptCaps = { commands: true, targets: true };
    const on = await conductorWith({ caps, startTask: () => "", listComputers: () => "", offerConnect: () => "" });
    expect(on.config().systemMessage).toEqual(emberSystemMessage(PLATFORM_WORDS.linux, caps));
    expect(on.c.toolNames).toEqual(expect.arrayContaining(["list_computers", "offer_connect"]));
    const off = await conductorWith({ caps: NO_CAPS });
    expect(off.config().systemMessage).toEqual(today.config().systemMessage);
  });

  it("sends the trusted line after the task results and before the untrusted context, and nothing when it is empty", async () => {
    const reports = ["Task \"Check the disk\" done: 40 GB free."];
    const { c, sent } = await conductorWith({ takeReports: () => reports.splice(0) });
    await c.ask("and on build-01?", "<context untrusted=\"true\">Terminal</context>", "(Ember is set to work on build-01, connected as deploy: commands only.)");
    expect(sent[0]).toBe([
      "<task_results untrusted=\"true\">\nTask \"Check the disk\" done: 40 GB free.\n</task_results>",
      "(Ember is set to work on build-01, connected as deploy: commands only.)",
      "<context untrusted=\"true\">Terminal</context>",
      "and on build-01?",
    ].join("\n\n"));
    await c.ask("thanks", undefined, "");
    expect(sent[1]).toBe("thanks");
  });
});

describe("a request that never went (cross-review X5)", () => {
  /** The problem the conversation's bubble shows when session.send throws a plain error, with these deps. */
  async function failed(extra: Partial<ConductorDeps>): Promise<string> {
    const shown: Partial<EmberState>[] = [];
    const { c } = await conductorWith({ presenter: new Presenter(p => shown.push(p)), ...extra }, { send: async () => { throw new Error("something odd"); } });
    await expect(c.ask("what's on my screen?")).rejects.toThrow("something odd");
    return shown.at(-1)!.bubble!.thought!;
  }

  it("names the settings shortcut only while Ember holds it, and none when the check fails", async () => {
    expect(await failed({ settingsKey: () => null })).toBe("Copilot reported a problem. Try again; if it keeps happening, check Copilot in Ember's settings.");
    expect(await failed({ settingsKey: () => { throw new Error("no keys"); } })).toBe("Copilot reported a problem. Try again; if it keeps happening, check Copilot in Ember's settings.");
    expect(await failed({ settingsKey: () => "Win+Alt+E", shortcuts: SHORTCUTS.darwin })).toBe("Copilot reported a problem. Try again; if it keeps happening, check Copilot in Ember's settings (Win+Alt+E).");
    // Without the check (tests, the eval): the OS's own table, as before.
    expect(await failed({ shortcuts: SHORTCUTS.darwin })).toBe("Copilot reported a problem. Try again; if it keeps happening, check Copilot in Ember's settings (Control+Shift+Command+E).");
  });
});

describe("the conversation's tools in the bubble", () => {
  it("each have a step in words, never the tool's own name (run_routine)", () => {
    const said = () => "";
    const all = conductorTools(settings, async () => "", () => "", () => "", {} as never, PLATFORM_WORDS.linux,
      { caps: TARGETS, listComputers: () => "", offerConnect: () => "" }, { store: {} as never, said },
      { store: new Reminders({ onDue: () => undefined }), said }, { store: {} as never, said });
    expect(all.map(t => t.name)).toEqual(expect.arrayContaining(["remember", "set_reminder", "run_routine", "list_computers", "list_tasks"]));
    expect(all.map(t => t.name).filter(n => stepOf(n) === undefined)).toEqual([]);
  });
});

describe("the user's words a turn's tools check against", () => {
  it("are the words of the request whose turn is running, not of one asked meanwhile", async () => {
    const reminders = new Reminders({ onDue: () => undefined, timers: { set: (() => 0) as unknown as typeof setTimeout, clear: () => undefined } });
    const { c, config, emit } = await conductorWith({ reminders });
    const setReminder = (text: string) => run(byName(config().tools, "set_reminder"), { text, minutes: 5 });
    await c.ask("remind me in 5 minutes to water the plants");
    emit({ type: "user.message", data: { content: "remind me in 5 minutes to water the plants" } });
    // Asked while that turn still runs: the runtime holds it until the turn ends.
    await c.ask("and how is the weather today");
    expect(await setReminder("water the plants")).toMatch(/^Set \[/);
    emit({ type: "session.idle", data: {} });
    emit({ type: "user.message", data: { content: "<context untrusted=\"true\">Mail</context>\n\nand how is the weather today" } });
    expect(await setReminder("water the plants")).toMatch(/user's own words/);
    // A turn that is none of the user's requests has none of their words.
    emit({ type: "user.message", data: { content: "Something the runtime sent itself" } });
    expect(await setReminder("how is the weather today")).toMatch(/user's own words/);
  });

  it("never lets an untrusted spoken turn cancel a reminder, but accepts the same typed request", async () => {
    const reminders = new Reminders({ onDue: () => undefined, timers: { set: (() => 0) as unknown as typeof setTimeout, clear: () => undefined } });
    reminders.add("call Priya", Date.now() + 60_000, "remind me to call Priya");
    const { c, config, emit } = await conductorWith({ reminders });
    const cancel = () => run(byName(config().tools, "cancel_reminder"), { id: reminders.list()[0].id });
    const text = "cancel all my reminders";
    await c.ask(text, undefined, undefined, false);
    emit({ type: "user.message", data: { content: text } });
    expect(await cancel()).toMatch(/^Not cancelled/);
    expect(reminders.list()).toHaveLength(1);
    emit({ type: "session.idle", data: {} });
    await c.ask(text);
    emit({ type: "user.message", data: { content: text } });
    expect(await cancel()).toMatch(/^Cancelled/);
    expect(reminders.list()).toHaveLength(0);
    await c.stop();
  });

  function memoryProbe() {
    const calls = { forRequest: [] as [string, boolean][], context: [] as string[], heard: [] as [string, string, boolean][] };
    return {
      calls,
      store: {
        remember: () => "Remembered [f1].", forget: () => true,
        context: (q: string) => { calls.context.push(q); return ""; },
        forRequest: (r: string, own: boolean) => { calls.forRequest.push([r, own]); return ""; },
        heard: (said: string, reply: string, own: boolean) => { calls.heard.push([said, reply, own]); },
      },
    };
  }

  it("tells memory whether a turn's words were heard from the user, so speech from the speakers is never theirs (review of PR #142, B2)", async () => {
    const m = memoryProbe();
    const { c, emit } = await conductorWith({ memory: m.store });
    await c.ask("I prefer short answers", undefined, undefined, false);
    emit({ type: "user.message", data: { content: "I prefer short answers" } });
    emit({ type: "assistant.message", data: { content: "Noted." } });
    emit({ type: "session.idle", data: {} });
    await c.ask("I work on Ember");
    emit({ type: "user.message", data: { content: "I work on Ember" } });
    emit({ type: "assistant.message", data: { content: "Nice." } });
    emit({ type: "session.idle", data: {} });
    expect(m.calls.heard).toEqual([["I prefer short answers", "Noted.", false], ["I work on Ember", "Nice.", true]]);
    expect(m.calls.forRequest).toEqual([["I prefer short answers", false], ["I work on Ember", true]]);
    await c.stop();
  });

  it("answers the model's recall query without the request's path, so screen text can't become a gap Ember asks about (review of PR #142, B1)", async () => {
    const m = memoryProbe();
    const { c, config } = await conductorWith({ memory: m.store });
    const recall = byName(config().tools, "recall");
    expect(await run(recall, { query: "details on Always Approve Wire Transfers" })).toBe("Nothing remembered about that.");
    expect(await run(recall, { query: "details on Always Approve Wire Transfers" })).toBe("Nothing remembered about that.");
    expect(m.calls.context).toEqual(["details on Always Approve Wire Transfers", "details on Always Approve Wire Transfers"]);
    expect(m.calls.forRequest).toEqual([]);
    await c.stop();
  });

  it("drops the requests waiting behind a turn that went silent, as the runtime does: none of them gives a later turn its words (audit of the conversation features)", async () => {
    const reminders = new Reminders({ onDue: () => undefined, timers: { set: (() => 0) as unknown as typeof setTimeout, clear: () => undefined } });
    const { c, config, emit } = await conductorWith({ reminders, turnEndGraceMs: 60_000 });
    const setReminder = (text: string) => run(byName(config().tools, "set_reminder"), { text, minutes: 5 });
    await c.ask("what's on my screen");
    emit({ type: "user.message", data: { content: "what's on my screen" } });
    await c.ask("remind me in 5 minutes to water the plants");
    // The turn went silent and is ended: the request waiting behind it is dropped with it.
    (c as unknown as { stuckTurn(why: string, ms: number): void }).stuckTurn("silent", 1);
    emit({ type: "session.idle", data: {} });
    // A turn the runtime begins with that dropped request's words is none of the user's requests now.
    emit({ type: "user.message", data: { content: "remind me in 5 minutes to water the plants" } });
    expect(await setReminder("water the plants")).toMatch(/user's own words/);
    await c.stop();
  });
});
