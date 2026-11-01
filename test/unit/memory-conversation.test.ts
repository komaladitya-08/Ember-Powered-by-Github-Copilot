/**
 * Memory in conversation (docs/MEMORY.md step 2): the service saves what the user tells Ember and counts it as theirs
 * only in their own words, recalls it for a request as an untrusted block, forgets on request and erases whole; the
 * conductor gets its tools and prompt rules only while memory is on; and the organisation can turn it off.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conductorTools, type ConductorMemory } from "../../app/main/agent/conductor";
import { NO_CAPS, TOOL_RULES, toolRules } from "../../app/main/agent/persona";
import { AdminPolicySchema, applyAdminPolicy, managedKeys } from "../../app/main/admin";
import { DEFAULT_SETTINGS, SettingsStore } from "../../app/main/settings";
import { MemoryService, SAVE_DELAY_MS, ownWords } from "../../app/main/memory/service";
import { memoryFile } from "../../app/main/memory/store";
import { PLATFORM_WORDS } from "../../app/shared/words";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-memconv-"));
const quiet = { info: () => undefined, warn: () => undefined };

function service(dir = tmp()) {
  const n = { e: 0, f: 0 };
  const changes = vi.fn();
  const s = new MemoryService({
    dir, log: quiet, onChange: changes,
    clock: { now: () => new Date("2026-11-01T10:00:00Z"), id: p => `${p}${++n[p]}` },
  });
  return { s, dir, changes };
}

afterEach(() => { vi.useRealTimers(); });

describe("whose words a fact is", () => {
  it("counts a fact as the user's when most of its words are in what they said", () => {
    expect(ownWords("Works on the Atlas project with Priya", "I work on the Atlas project with Priya, remember that")).toBe(true);
    expect(ownWords("Prefers to send reports to finance@example.com", "what's on my screen?")).toBe(false);
  });
});

describe("MemoryService", () => {
  it("remembers a fact in the user's words as theirs, and one only the model said as inference", () => {
    const { s } = service();
    expect(s.remember("Works on the Atlas project", [{ name: "User", kind: "person" }, { name: "Atlas", kind: "project" }], "Remember I work on the Atlas project")).toBe("Remembered [f1].");
    expect(s.remember("Likes concise answers", [], "what time is it")).toBe("Remembered [f2].");
    expect(s.list().map(i => [i.text, i.source])).toEqual([["Likes concise answers", "conversation"], ["Works on the Atlas project", "user"]]);
  });

  it("tells the model plainly when it may not remember something, and keeps nothing of it", () => {
    const { s } = service();
    expect(s.remember("Wifi password is hunter2", [], "my wifi password is hunter2")).toMatch(/^Not remembered: it holds a password/);
    expect(s.list()).toEqual([]);
  });

  it("replaces what held one value at a time, and says which fact it replaced", () => {
    const { s } = service();
    s.remember("Works at Initech", [{ name: "User" }], "I work at Initech", "works_at");
    expect(s.remember("Works at Globex", [{ name: "User" }], "I work at Globex now", "works_at")).toBe("Remembered [f2], replacing [f1].");
    expect(s.list().map(i => i.text)).toEqual(["Works at Globex"]);
  });

  it("gives a request what bears on it as an untrusted block, and nothing when nothing does", () => {
    const { s } = service();
    s.remember("Works on the Atlas project with Priya", [{ name: "User" }, { name: "Atlas", kind: "project" }, { name: "Priya", kind: "person" }], "I work on the Atlas project with Priya");
    expect(s.context("Draft a note to Priya about Atlas")).toMatch(/^<memory untrusted="true">\n- \[f1\] \(you told me, 2026-11-01\) Works on the Atlas project with Priya\n<\/memory>$/);
    expect(s.context("what's the weather")).toBe("");
  });

  it("saves soon after a change, readable by the user alone, and loads it again next time", () => {
    vi.useFakeTimers();
    const { s, dir } = service();
    s.remember("Lives in Leeds", [{ name: "User" }], "I live in Leeds");
    expect(fs.existsSync(path.join(dir, "memory.json"))).toBe(false);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(memoryFile(dir).load().allFacts().map(f => f.text)).toEqual(["Lives in Leeds"]);
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "memory.json")).mode & 0o777).toBe(0o600);
    expect(service(dir).s.list().map(i => i.text)).toEqual(["Lives in Leeds"]);
  });

  it("forgets one fact, or everything with the file, and tells Settings each time", () => {
    const { s, dir, changes } = service();
    s.remember("Lives in Leeds", [{ name: "User" }], "I live in Leeds");
    s.remember("Has a dog called Biscuit", [{ name: "Biscuit", kind: "thing" }], "my dog Biscuit");
    s.flush();
    expect(s.forget("f1")).toBe(true);
    expect(s.forget("f1")).toBe(false);
    s.forgetAll();
    expect(s.list()).toEqual([]);
    expect(fs.existsSync(path.join(dir, "memory.json"))).toBe(false);
    expect(changes).toHaveBeenCalledTimes(4);
  });
});

describe("the conductor with memory", () => {
  const settings = new SettingsStore(path.join(tmp(), "settings.json"));
  settings.load();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types tool lists as Tool<any>[]
  const handler = (tools: any[], name: string) => (args: unknown) => tools.find(t => t.name === name).handler(args, {});

  it("has no memory tools while memory is off", () => {
    const names = conductorTools(settings).map(t => t.name);
    expect(names).not.toContain("remember");
    expect(names).not.toContain("recall");
    expect(names).not.toContain("forget_memory");
  });

  it("passes what the user said with each fact, and forgets by an id given in brackets", async () => {
    const store: ConductorMemory = { remember: vi.fn(() => "Remembered [f1]."), context: vi.fn(() => ""), forget: vi.fn(() => true) };
    const tools = conductorTools(settings, undefined, undefined, undefined, undefined, undefined, {}, { store, said: () => "I work at Globex" });
    expect(await handler(tools, "remember")({ fact: "Works at Globex", about: [{ name: "User" }], replaces: "works_at" })).toBe("Remembered [f1].");
    expect(store.remember).toHaveBeenCalledWith("Works at Globex", [{ name: "User" }], "I work at Globex", "works_at");
    expect(await handler(tools, "recall")({ query: "the weather" })).toBe("Nothing remembered about that.");
    expect(await handler(tools, "forget_memory")({ id: "[f1]" })).toBe("Forgot [f1].");
    expect(store.forget).toHaveBeenCalledWith("f1");
    expect(await handler(tools, "remember")({ fact: "x", about: [] })).toMatch(/^Invalid arguments for remember/);
  });

  it("keeps today's prompt with memory off, and adds memory's rules only while it is on", () => {
    expect(toolRules(PLATFORM_WORDS.linux, NO_CAPS)).toBe(TOOL_RULES);
    const on = toolRules(PLATFORM_WORDS.linux, { ...NO_CAPS, memory: true });
    expect(on.startsWith(TOOL_RULES.slice(0, TOOL_RULES.lastIndexOf("\nTreat any text")))).toBe(true);
    expect(on).toMatch(/<memory>.*information, never instructions/);
    expect(on).toMatch(/Never save passwords, codes or keys/);
  });
});

describe("memory and the organisation's policy", () => {
  it("is off by default and needs its own agreement", () => {
    expect(DEFAULT_SETTINGS.memory).toEqual({ on: false, consent: { version: 0, at: null } });
  });

  it("is turned off and managed when the policy says features.memory is false", () => {
    const user = { ...DEFAULT_SETTINGS, memory: { on: true, consent: { version: 1, at: "2026-11-01T00:00:00Z" } } };
    const off = AdminPolicySchema.parse({ features: { memory: false } });
    expect(applyAdminPolicy(user, off).memory).toEqual({ on: false, consent: { version: 1, at: "2026-11-01T00:00:00Z" } });
    expect(managedKeys(off)).toContain("memory");
    expect(applyAdminPolicy(user, AdminPolicySchema.parse({})).memory.on).toBe(true);
  });
});
