/**
 * Three small truths about forgetting (round nine's P3s): Undo of a Forget never leaves two copies of a fact said
 * again meanwhile (memory-r9-9); the "Ember learned" line's button says Forget, not Undo, once it can no longer undo
 * what the fact replaced (memory-r9-10); and a forget request that names no word of the fact is told to the model as
 * that, never as the user not having asked (memory-r9-12).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conductorTools, type ConductorMemory } from "../../app/main/agent/conductor";
import { MemoryLearning } from "../../app/main/memory/learning";
import { FORGET_THAT_MS } from "../../app/main/memory/questions";
import { MemoryService } from "../../app/main/memory/service";
import { SettingsStore } from "../../app/main/settings";
import { mountLearnedUndo } from "../../app/renderer/home/learned-undo";
import { LEARNED_UNDO_MS } from "../../app/shared/ipc";
import { FakeEl } from "./view-dom-fake";

const quiet = { info: () => undefined, warn: () => undefined };
const USER = [{ name: "User", kind: "person" as const }];

function rig() {
  const n = { e: 0, f: 0 };
  let now = Date.parse("2026-11-12T10:00:00Z");
  const clock = { now: () => new Date(now), id: (p: "e" | "f") => `${p}${++n[p]}` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-memundo-"));
  const s = new MemoryService({ dir, log: quiet, clock });
  const l = new MemoryLearning({ memory: s, inForce: () => true, questionsOn: () => false, askedAt: () => null, setAskedAt: () => undefined, idle: () => true, locked: () => false, say: () => true, log: quiet, now: () => now });
  return { l, s, dir, tools: l.conductorMemory(), advance: (ms: number) => { now += ms; }, list: () => s.list().map(i => `${i.source}: ${i.text}`) };
}

describe("Undo of a Forget after the fact was said again (memory-r9-9)", () => {
  it("leaves one copy: the one said again, surer for it (memory-r9-9)", () => {
    const r = rig();
    r.tools.remember("Is vegetarian", USER, "Remember that I'm vegetarian");
    r.advance(15 * 60_000);
    const gone = r.l.forgetCounted(r.s.list()[0]!.id)!;
    r.advance(10_000);
    // "Sorry, wrong button": said again before the Undo is pressed.
    r.tools.began();
    expect(r.tools.remember("Is vegetarian", USER, "Sorry, wrong button. Remember I'm vegetarian")).toMatch(/^Remembered/);
    expect(r.l.restore(gone.undo, true)).toBe(true);
    expect(r.list()).toEqual(["user: Is vegetarian"]);
    r.s.flush();
    expect(JSON.parse(fs.readFileSync(path.join(r.dir, "memory.json"), "utf8")).facts.filter((f: { text: string }) => f.text === "Is vegetarian")).toHaveLength(1);
  });

  it("still puts a forgotten fact back whole when nothing like it was said since, beside another fact (memory-r9-9)", () => {
    const r = rig();
    r.tools.remember("Is vegetarian", USER, "Remember that I'm vegetarian");
    const gone = r.l.forgetCounted(r.s.list()[0]!.id)!;
    r.tools.began();
    r.tools.remember("Lives in Leeds", USER, "Remember that I live in Leeds");
    expect(r.l.restore(gone.undo, true)).toBe(true);
    expect(r.list().sort()).toEqual(["user: Is vegetarian", "user: Lives in Leeds"]);
  });
});

describe("the “Ember learned” line's button once it can't undo any more (memory-r9-10)", () => {
  class El extends FakeEl {
    private events = new Map<string, (() => void)[]>();
    removeAttribute(name: string): void { delete this.attrs[name]; }
    addEventListener(name: string, fn: () => void): void { this.events.set(name, [...this.events.get(name) ?? [], fn]); }
    click(): void { for (const fn of this.events.get("click") ?? []) fn(); }
    override querySelector(selector: string): El | null { return (this.all().find(el => el.tag === selector) as El | undefined) ?? null; }
  }
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-11-12T10:00:00Z") });
    vi.stubGlobal("document", { createElement: (tag: string) => new El(tag), activeElement: null });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const mount = (t: string) => {
    const row = new El("li");
    mountLearnedUndo(row as unknown as HTMLElement, "Works at Initech", "f2", async () => undefined, t);
    return row.querySelector("button")!;
  };

  it("says Undo while forgetting it still brings back what it replaced, and Forget from then on (memory-r9-10)", () => {
    expect(LEARNED_UNDO_MS).toBe(FORGET_THAT_MS);
    const fresh = mount(new Date(Date.now() - 60_000).toISOString());
    expect(fresh.textContent).toBe("Undo");
    expect(fresh.getAttribute("aria-label")).toBe("Undo: forget “Works at Initech”");
    // Still on the page when its ten minutes are over: the button changes where it is.
    vi.advanceTimersByTime(9 * 60_000 + 1000);
    expect(fresh.textContent).toBe("Forget");
    expect(fresh.getAttribute("aria-label")).toBe("Forget: Works at Initech");
    // Drawn again later (a line eleven minutes old), or with a time that can't be read: Forget.
    expect(mount(new Date(Date.now() - 11 * 60_000).toISOString()).textContent).toBe("Forget");
    expect(mount("not a time").textContent).toBe("Forget");
  });

  it("matches what main does: eleven minutes on, forgetting leaves what it replaced as history (memory-r9-10, memory-12)", () => {
    vi.useRealTimers();
    const r = rig();
    r.tools.remember("Works at Globex", USER, "I work at Globex", "works_at");
    r.advance(86_400_000);
    r.tools.began();
    r.tools.remember("Works at Initech", USER, "I work at Initech", "works_at");
    r.advance(11 * 60_000);
    const gone = r.l.forgetCounted(r.s.list().find(i => i.text === "Works at Initech")!.id)!;
    expect(gone.back).toBeUndefined();
    expect(r.list()).toEqual([]);
  });
});

describe("a forget request that names no word of the fact (memory-r9-12)", () => {
  const tool = (own: string) => {
    const settings = new SettingsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-memundo-")), "settings.json"));
    const forgot: string[] = [];
    const store: ConductorMemory = { remember: () => "", context: () => "", forget: id => { forgot.push(id); return true; }, factText: id => (id === "f1" ? "Lives at 12 Elm Road, Leeds" : null) };
    const t = conductorTools(settings, undefined, undefined, undefined, undefined, undefined, {}, { store, said: () => own, own: () => own }).find(x => x.name === "forget_memory")!;
    return { run: (id: string) => (t.handler as (a: unknown, i: unknown) => Promise<string>)({ id }, {}), forgot };
  };

  it("tells the model the user asked, but not which fact, and still forgets nothing (memory-r9-12)", async () => {
    for (const said of ["Forget my address", "Stop remembering my address", "Delete what you know about my home"]) {
      const t = tool(said);
      expect(await t.run("f1"), said).toBe("Not forgotten: the user asked Ember to forget something, but their words don't name this fact, so Ember can't be sure it is the one they mean. Tell them what you found, and that they can press Forget beside it in Settings › Memory or say what to forget in the fact's own words.");
      expect(t.forgot).toEqual([]);
    }
  });

  it("still says the user didn't ask when they didn't, and forgets what their words name (memory-r9-12, memory-v2)", async () => {
    const other = tool("What's my address?");
    expect(await other.run("f1")).toBe("Not forgotten: the user didn't ask in this request to forget it. Forget a memory only when they ask, and tell them they can use Forget in Settings › Memory.");
    const none = tool("");
    expect(await none.run("f1")).toMatch(/^Not forgotten: the user didn't ask/);
    const named = tool("Forget that I live at 12 Elm Road");
    expect(await named.run("f1")).toBe("Forgot f1.");
    expect(named.forgot).toEqual(["f1"]);
  });
});
