/** The conductor's tools and requests: start_task takes the ask box's whole text (review #149). */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { conductorTools } from "../../app/main/agent/conductor";
import { SettingsStore } from "../../app/main/settings";

describe("start_task's goal (review #149)", () => {
  const settings = new SettingsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-cond-")), "settings.json"));
  settings.load();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types tool lists as Tool<any>[]
  const handler = (tools: any[], name: string) => (args: unknown) => tools.find(t => t.name === name).handler(args, {});

  it("takes a goal that carries the ask box's 2,000 characters and the instruction around them", async () => {
    const start = handler(conductorTools(settings, undefined, g => `started ${g.length}`), "start_task");
    const goal = `Type this paragraph into the open document: ${"word ".repeat(400)}`;
    expect(goal.length).toBeGreaterThan(2000);
    expect(await start({ goal })).toBe(`started ${goal.length}`);
    expect(await start({ goal: "x".repeat(4001) })).toMatch(/^Invalid arguments for start_task/);
  });

  it("the same with a target", async () => {
    const start = handler(conductorTools(settings, undefined, (g, t) => `started ${g.length} ${t}`, undefined, undefined, undefined, { caps: { commands: false, targets: true } }), "start_task");
    expect(await start({ goal: "y".repeat(3000), target: "build-01" })).toBe("started 3000 build-01");
  });

  it("offers coding only when enabled and routes its goal without a model-chosen path", async () => {
    expect(conductorTools(settings).map(t => t.name)).not.toContain("start_coding");
    const start = handler(conductorTools(settings, undefined, undefined, undefined, undefined, undefined, {}, undefined, undefined, undefined, g => `coding ${g}`), "start_coding");
    expect(await start({ goal: "fix the failing test", workspace: "/untrusted" })).toBe("coding fix the failing test");
    expect(await start({ goal: "x" })).toMatch(/^Invalid arguments for start_coding/);
  });
});

describe("conductor project coordination", () => {
  it("accepts bounded coding session names only as project metadata and preserves unnamed callback arguments", async () => {
    const settings = new SettingsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-coding-session-tools-")), "settings.json"));
    settings.load();
    const calls: unknown[][] = [];
    const coding = (...args: unknown[]) => { calls.push(args); return "Started"; };
    const projects = { create: () => "created", select: () => "selected", list: () => "projects" };
    const tools = conductorTools(settings, undefined, undefined, undefined, undefined, undefined, {}, undefined, undefined, undefined, coding, undefined, projects);
    const start = tools.find(tool => tool.name === "start_coding")!;
    const call = (raw: unknown) => start.handler!(raw, { sessionId: "test", toolCallId: "coding", toolName: "start_coding", arguments: raw });
    expect(await call({ goal: "Inspect parser", sessionName: "  Implementation  " })).toBe("Started");
    expect(await call({ goal: "Review parser" })).toBe("Started");
    expect(await call({ goal: "Test parser", sessionName: "x".repeat(80) })).toBe("Started");
    for (const sessionName of ["", "   ", "x".repeat(81), "Injected\nlabel", "Hidden\u200blabel"]) {
      expect(await call({ goal: "Inspect parser", sessionName })).toMatch(/^Invalid arguments for start_coding/);
    }
    expect(calls).toEqual([["Inspect parser", "Implementation"], ["Review parser"], ["Test parser", "x".repeat(80)]]);
    const withoutProjects = conductorTools(settings, undefined, undefined, undefined, undefined, undefined, {}, undefined, undefined, undefined, coding).find(tool => tool.name === "start_coding")!;
    expect(Object.keys((withoutProjects.parameters as { shape: object }).shape)).toEqual(["goal"]);
  });

  it("offers metadata tools only when wired and keeps task/session naming separate from permissions", async () => {
    const settings = new SettingsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-project-tools-")), "settings.json"));
    settings.load();
    const calls: unknown[][] = [];
    const tools = conductorTools(settings, (...a) => Promise.resolve(String(a)), (...a) => { calls.push(a); return "Started"; }, undefined, undefined, undefined, {}, undefined, undefined, undefined, undefined, undefined, {
      create: (name, goal) => `${name}: ${goal}`, select: id => String(id), list: () => "<projects untrusted=\"true\">[]</projects>",
    });
    const call = (name: string, raw: unknown) => tools.find(t => t.name === name)!.handler!(raw, { sessionId: "test", toolCallId: name, toolName: name, arguments: raw });
    expect(conductorTools(settings).map(t => t.name)).not.toContain("create_project");
    expect(await call("create_project", { name: "Release", goal: "Check the announcement" })).toBe("Release: Check the announcement");
    expect(await call("create_project", { name: "Release", folder: "/untrusted" })).toMatch(/^Invalid arguments/);
    expect(await call("select_project", { id: "../folder" })).toMatch(/^Invalid arguments/);
    expect(await call("select_project", { id: null })).toBe("null");
    expect(await call("list_projects", {})).toContain('untrusted="true"');
    expect(await call("start_task", { goal: "Check the announcement in the browser", sessionName: "Review copy" })).toBe("Started");
    expect(calls).toEqual([["Check the announcement in the browser", undefined, "Review copy"]]);
  });
});
