/**
 * The saved copy of Home's conversation (app/main/agent/conversation-store.ts): opt-in, atomic, bounded, owned by one
 * account, and never undone by a write that was begun before a clear.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HISTORY_FILE, HistoryStore, MAX_BYTES, boundedEntries, type HistoryOps } from "../../app/main/agent/conversation-store";
import { CONVERSATION_LIMIT, CONVERSATION_TEXT_LIMIT } from "../../app/shared/conversation";
import { CONVERSATION_RETENTION, CONVERSATION_RETENTION_KEPT, conversationRetention } from "../../app/renderer/home/copy";
import { DEFAULT_SETTINGS } from "../../app/main/settings";

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-history-")); dirs.push(d); return d; };
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const logs: string[] = [];
const log = { info: (e: string) => { logs.push(e); }, warn: (e: string, f?: object) => { logs.push(e + JSON.stringify(f ?? {})); } };
const msg = (i: number, extra: object = {}) => ({ t: new Date(Date.UTC(2026, 10, 5, 10, i % 60)).toISOString(), who: i % 2 ? "ember" : "you", text: `message ${i}`, ...extra });
const store = (dir: string, ops?: HistoryOps) => new HistoryStore({ dir, log, ops, delayMs: 1 });
const file = (dir: string) => path.join(dir, HISTORY_FILE);

describe("the saved conversation", () => {
  it("is off by default and described truthfully in both modes", () => {
    expect(DEFAULT_SETTINGS.keepConversation).toBe(false);
    expect(conversationRetention(false)).toBe(CONVERSATION_RETENTION);
    expect(conversationRetention(true)).toBe(CONVERSATION_RETENTION_KEPT);
    expect(CONVERSATION_RETENTION).toContain("Closing Ember or signing out forgets");
    expect(CONVERSATION_RETENTION_KEPT).toContain("Forget everything delete the saved copy");
  });

  it("round-trips through a real folder in a file only the user can read, parent folder included", async () => {
    const dir = path.join(tmp(), "data");
    const s = store(dir);
    s.save("github:1", [msg(0), msg(1, { truncated: true })]);
    await s.flush();
    expect(fs.statSync(file(dir)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dir)).toEqual([HISTORY_FILE]);
    expect(JSON.parse(fs.readFileSync(file(dir), "utf8"))).toMatchObject({ version: 1, account: "github:1" });
    expect(store(dir).load("github:1")).toEqual([msg(0), msg(1, { truncated: true })]);
  });

  it("writes a temp file and renames it: a crash mid-write leaves the old file whole, and the leftover is cleaned", async () => {
    const dir = tmp();
    const s = store(dir);
    s.save("github:1", [msg(0)]);
    await s.flush();
    const crashing: HistoryOps = { write: async tmp => { fs.writeFileSync(tmp, '{"version":1,"acc'); throw new Error("power cut"); } };
    const t = store(dir, crashing);
    t.save("github:1", [msg(0), msg(1)]);
    await t.flush();
    expect(JSON.parse(fs.readFileSync(file(dir), "utf8")).entries).toHaveLength(1);
    // A temp file an earlier run could not tidy (killed): ignored by load and removed by it.
    fs.writeFileSync(`${file(dir)}.tmp-999-1`, "garbage");
    expect(store(dir).load("github:1")).toEqual([msg(0)]);
    expect(fs.readdirSync(dir)).toEqual([HISTORY_FILE]);
  });

  it("moves an unreadable, wrong-version or oversized file aside without throwing or logging its words", () => {
    const bad: Record<string, string> = {
      notJson: "{ the user's secret words",
      version: JSON.stringify({ version: 2, account: "a", entries: [] }),
      shape: JSON.stringify({ version: 1, account: "a", entries: "no" }),
      huge: " ".repeat(MAX_BYTES + 100_000),
    };
    for (const [name, body] of Object.entries(bad)) {
      const dir = tmp();
      fs.writeFileSync(file(dir), body);
      logs.length = 0;
      expect(store(dir).load("a"), name).toEqual([]);
      expect(fs.existsSync(file(dir)), name).toBe(false);
      expect(fs.readFileSync(`${file(dir)}.broken`, "utf8"), name).toBe(body);
      expect(logs.join(), name).not.toContain("secret");
    }
    // An older .broken is replaced, not accumulated.
    const dir = tmp();
    fs.writeFileSync(`${file(dir)}.broken`, "old");
    fs.writeFileSync(file(dir), "new junk");
    store(dir).load("a");
    expect(fs.readFileSync(`${file(dir)}.broken`, "utf8")).toBe("new junk");
  });

  it("keeps only valid lines within the bounds, and drops unknown fields", () => {
    const many = Array.from({ length: CONVERSATION_LIMIT + 20 }, (_, i) => msg(i));
    const kept = boundedEntries([...many, null, 7, { t: "nope", who: "you", text: "x" }, { ...msg(1), who: "learned" }, { ...msg(1), text: "a".repeat(CONVERSATION_TEXT_LIMIT + 1) }]);
    expect(kept).toHaveLength(CONVERSATION_LIMIT);
    expect(kept.at(-1)?.text).toBe(`message ${CONVERSATION_LIMIT + 19}`);
    expect(boundedEntries([{ ...msg(2), heardId: 9, fact: "f", extra: { a: 1 } }])).toEqual([msg(2)]);
    // The total byte cap drops the oldest first.
    const big = Array.from({ length: 40 }, (_, i) => msg(i, { text: `${i}`.padEnd(100_000, "x") }));
    const fit = boundedEntries(big);
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeLessThanOrEqual(MAX_BYTES);
    expect(fit.length).toBeLessThan(40);
    expect(fit.at(-1)?.text.startsWith("39")).toBe(true);
  });

  it("tolerates a later optional `stopped` field (interrupted partial answers) and drops other values of it", () => {
    expect(boundedEntries([{ ...msg(1), stopped: true }, { ...msg(3), stopped: "yes" }])).toEqual([{ ...msg(1), stopped: true }, msg(3)]);
  });

  it("never shows one account's conversation to another, and deletes it", async () => {
    const dir = tmp();
    const s = store(dir);
    s.save("github:1", [msg(0)]);
    await s.flush();
    expect(store(dir).load("github:2")).toEqual([]);
    expect(fs.existsSync(file(dir))).toBe(false);
    expect(fs.existsSync(`${file(dir)}.broken`)).toBe(false);
    expect(store(dir).load("github:1")).toEqual([]);
  });

  it("clear deletes the file, a moved-aside copy and temp files", async () => {
    const dir = tmp();
    const s = store(dir);
    s.save("a", [msg(0)]);
    await s.flush();
    fs.writeFileSync(`${file(dir)}.broken`, "x");
    fs.writeFileSync(`${file(dir)}.tmp-1-1`, "x");
    s.clear();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("a write begun before a clear can't bring the conversation back (deferred disk)", async () => {
    const dir = tmp();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const slow: HistoryOps = { write: async (tmp, data) => { await gate; fs.writeFileSync(tmp, data, { mode: 0o600 }); } };
    const s = store(dir, slow);
    s.save("a", [msg(0)]);
    await vi.waitFor(() => { expect((s as unknown as { running: unknown }).running).not.toBeNull(); });
    s.save("a", [msg(0), msg(1)]); // queued behind the one in flight
    s.clear();
    release();
    await s.flush();
    await new Promise(r => setTimeout(r, 20));
    await s.flush();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("a write queued (not yet started) before a clear is dropped", async () => {
    const dir = tmp();
    const s = new HistoryStore({ dir, log, delayMs: 50 });
    s.save("a", [msg(0)]);
    s.clear();
    await s.flush();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("coalesces: the last state wins, one write in flight at a time", async () => {
    const dir = tmp();
    let inFlight = 0, most = 0, writes = 0;
    const ops: HistoryOps = { write: async (tmp, data) => { inFlight++; writes++; most = Math.max(most, inFlight); await new Promise(r => setTimeout(r, 10)); fs.writeFileSync(tmp, data); inFlight--; } };
    const s = store(dir, ops);
    for (let i = 1; i <= 5; i++) s.save("a", Array.from({ length: i }, (_, k) => msg(k)));
    await s.flush();
    expect(most).toBe(1);
    expect(writes).toBeLessThan(5);
    expect(store(dir).load("a")).toHaveLength(5);
  });
});
