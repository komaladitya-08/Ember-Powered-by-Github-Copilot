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
import { emberSystemMessage, NO_CAPS } from "../../app/main/agent/persona";
import { Presenter } from "../../app/main/agent/presenter";
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
async function conductorWith(extra: Partial<ConductorDeps>) {
  const sent: string[] = [];
  let config: { tools: { name: string }[]; systemMessage: unknown } | null = null;
  const session = {
    sessionId: "ember-conductor-x",
    rpc: { tools: { initializeAndValidate: async () => ({}), getCurrentMetadata: async () => ({ tools: config!.tools.map(t => ({ name: t.name })) }) } },
    on: () => () => undefined,
    send: async (m: { prompt: string }) => { sent.push(m.prompt); return "m"; },
    abort: async () => undefined, disconnect: async () => undefined,
  };
  const client = { createSession: async (c: typeof config) => { config = c; return session; }, deleteSession: async () => undefined };
  const c = new Conductor({
    client: client as never, settings, presenter: new Presenter(() => undefined), log: quiet, stateFile: path.join(dir, `agent-${Math.random().toString(36).slice(2)}.json`),
    workDir: "/tmp", model: "m", ...extra,
  });
  await c.start();
  return { c, sent, config: () => config! };
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
