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
});
