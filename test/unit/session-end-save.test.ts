/**
 * When the desktop session ends (log-off, shutdown, the display going away) there may be no will-quit, and no time to
 * wait: before, main's endSession saved settings and let go of input and voice, but never stopped the agent nor wrote
 * a conversation save still waiting its second, so an answer being shown and the last line said were lost (integrator,
 * lanes/convsave). Now it stops the agent as quitting does (an answer under way is kept as it stands), writes the saved
 * conversation and memory at once, synchronously, and stops learning.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HISTORY_FILE, HistoryStore, type HistoryOps } from "../../app/main/agent/conversation-store";
import { endOfSession } from "../../app/main/session-end";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-session-end-")); dirs.push(d); return d; };
const quiet = { info: () => undefined, warn: () => undefined };
const msg = (who: "you" | "ember", text: string, extra: object = {}) => ({ t: "2026-11-13T10:00:00.000Z", who, text, ...extra });
const saved = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, HISTORY_FILE), "utf8")).entries.map((e: { who: string; text: string; stopped?: true }) => `${e.who}: ${e.text}${e.stopped ? " (stopped)" : ""}`);

describe("the end of the desktop session (integrator's endSession finding)", () => {
  it("writes a conversation save still waiting its delay at once, without waiting (endSession)", () => {
    const dir = tmp();
    const store = new HistoryStore({ dir, log: quiet, delayMs: 60_000 });
    store.save("acct", [msg("you", "What's on today?")]);
    store.flushNow();
    expect(saved(dir)).toEqual(["you: What's on today?"]);
    expect(fs.readdirSync(dir).filter(f => f.includes(".tmp"))).toEqual([]);
  });

  it("is not undone by a slower write begun earlier, whose rename gives way (endSession)", async () => {
    const dir = tmp();
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const ops: HistoryOps = { write: async (t, d) => { await held; fs.writeFileSync(t, d, { mode: 0o600 }); }, syncDir: async () => undefined };
    const store = new HistoryStore({ dir, log: quiet, ops, delayMs: 1 });
    store.save("acct", [msg("you", "first")]);
    await new Promise(r => setTimeout(r, 10));
    store.save("acct", [msg("you", "first"), msg("ember", "second")]);
    store.flushNow();
    release();
    await store.flush();
    expect(saved(dir)).toEqual(["you: first", "ember: second"]);
  });

  it("never writes back a conversation the person cleared while its write was under way (endSession)", async () => {
    const dir = tmp();
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const ops: HistoryOps = { write: async (t, d) => { await held; fs.writeFileSync(t, d, { mode: 0o600 }); }, syncDir: async () => undefined };
    const store = new HistoryStore({ dir, log: quiet, ops, delayMs: 1 });
    store.save("acct", [msg("you", "private")]);
    await new Promise(r => setTimeout(r, 10));
    expect(store.clear()).toBe(true);
    store.flushNow();
    release();
    await store.flush();
    expect(fs.existsSync(path.join(dir, HISTORY_FILE))).toBe(false);
  });

  it("stops the agent as quitting does and writes what it kept before returning, then memory (endSession)", () => {
    const dir = tmp();
    const store = new HistoryStore({ dir, log: quiet, delayMs: 60_000 });
    const order: string[] = [];
    const agent = {
      // As AgentHost.stop: the answer on screen is kept, as it stands, before the runtime goes.
      stop: () => { order.push("agent"); store.save("acct", [msg("you", "Summarise my day"), msg("ember", "You have three meetings", { stopped: true })]); return new Promise<void>(() => undefined); },
    };
    endOfSession({ agent, history: store, learning: { stop: () => { order.push("learning"); } }, memory: { stop: () => { order.push("memory"); } }, log: quiet });
    expect(order).toEqual(["agent", "learning", "memory"]);
    expect(saved(dir)).toEqual(["you: Summarise my day", "ember: You have three meetings (stopped)"]);
  });

  it("still saves the rest when one part throws, and copes with parts that never started (endSession)", () => {
    const dir = tmp();
    const store = new HistoryStore({ dir, log: quiet, delayMs: 60_000 });
    store.save("acct", [msg("you", "hello")]);
    const warned: string[] = [];
    endOfSession({ agent: { stop: () => { throw new Error("gone"); } }, history: store, learning: null, memory: { stop: () => { throw new Error("full"); } }, log: { info: () => undefined, warn: e => { warned.push(e); } } });
    expect(saved(dir)).toEqual(["you: hello"]);
    expect(warned).toEqual(["session_end.agent_not_stopped", "session_end.memory_not_saved"]);
    endOfSession({ agent: null, history: null, learning: null, memory: null, log: quiet });
  });

  it("is what main's endSession calls (endSession)", () => {
    const main = fs.readFileSync("app/main/main.ts", "utf8");
    const body = main.slice(main.indexOf("const endSession = (source: string) => {"), main.indexOf("if (sys.lifecycle.sessionEnd === \"power-monitor-shutdown\")"));
    expect(body).toContain("endOfSession({ agent, history: historyStore, learning, memory, log });");
  });
});
