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
import { CONVERSATION_RETENTION, CONVERSATION_RETENTION_KEPT, conversationKeepProblem, conversationRetention } from "../../app/renderer/home/copy";
import { DEFAULT_SETTINGS } from "../../app/main/settings";

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-history-")); dirs.push(d); return d; };
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const logs: string[] = [];
const log = { info: (e: string) => { logs.push(e); }, warn: (e: string, f?: object) => { logs.push(e + JSON.stringify(f ?? {})); } };
const msg = (i: number, extra: object = {}) => ({ t: new Date(Date.UTC(2026, 10, 5, 10, i % 60)).toISOString(), who: i % 2 ? "ember" : "you", text: `message ${i}`, ...extra });
const store = (dir: string, ops?: HistoryOps) => new HistoryStore({ dir, log, ops, delayMs: 1 });
const file = (dir: string) => path.join(dir, HISTORY_FILE);
/** POSIX file modes mean something only off Windows (it reports 0666 for a file and 0777 for a folder): the privacy requirement is asserted where the OS can keep it. */
const posixModes = process.platform !== "win32";
/** The real operations, for a test that replaces one of them. */
const real = (): HistoryOps => ({ write: async (t, d) => { fs.writeFileSync(t, d, { mode: 0o600 }); }, syncDir: async () => undefined });

describe("the saved conversation", () => {
  it("is off by default and described truthfully in both modes", () => {
    expect(DEFAULT_SETTINGS.keepConversation).toBe(false);
    expect(conversationRetention(false)).toBe(CONVERSATION_RETENTION);
    expect(conversationRetention(true)).toBe(CONVERSATION_RETENTION_KEPT);
    // Never silent: what is said under the switch when the saved copy can't be written or deleted.
    expect(conversationKeepProblem(null)).toBe("");
    expect(conversationKeepProblem("save")).toBe("Ember couldn’t save the conversation on this computer, so it may not be here after a restart.");
    expect(conversationKeepProblem("delete")).toBe("Ember couldn’t delete the saved conversation on this computer. It won’t show it again, and will try to delete it the next time you turn this off, forget or sign out.");
    expect(conversationKeepProblem("unchecked")).toBe("Ember can’t check that the earlier conversation was cleared, so it isn’t showing it. It will look again the next time Ember starts.");
    expect(conversationKeepProblem("account")).toBe("Ember couldn’t confirm which GitHub account is signed in, so it isn’t keeping this conversation. Sign out and in again, or check your connection.");
    expect(CONVERSATION_RETENTION).toContain("Closing Ember or signing out forgets");
    expect(CONVERSATION_RETENTION_KEPT).toContain("Forget everything delete the saved copy");
  });

  it("round-trips through a real folder in a file only the user can read, parent folder included", async () => {
    const dir = path.join(tmp(), "data");
    const s = store(dir);
    s.save("github:1", [msg(0), msg(1, { truncated: true })]);
    await s.flush();
    if (posixModes) {
      expect(fs.statSync(file(dir)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(fs.readdirSync(dir)).toEqual([HISTORY_FILE]);
    expect(JSON.parse(fs.readFileSync(file(dir), "utf8"))).toMatchObject({ version: 1, account: "github:1" });
    expect(store(dir).load("github:1")).toEqual([msg(0), msg(1, { truncated: true })]);
  });

  it("writes a temp file and renames it: a crash mid-write leaves the old file whole, and the leftover is cleaned", async () => {
    const dir = tmp();
    const s = store(dir);
    s.save("github:1", [msg(0)]);
    await s.flush();
    const crashing: HistoryOps = { ...real(), write: async tmp => { fs.writeFileSync(tmp, '{"version":1,"acc'); throw new Error("power cut"); } };
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
    const slow: HistoryOps = { ...real(), write: async (tmp, data) => { await gate; fs.writeFileSync(tmp, data, { mode: 0o600 }); } };
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
    const ops: HistoryOps = { ...real(), write: async (tmp, data) => { inFlight++; writes++; most = Math.max(most, inFlight); await new Promise(r => setTimeout(r, 10)); fs.writeFileSync(tmp, data); inFlight--; } };
    const s = store(dir, ops);
    for (let i = 1; i <= 5; i++) s.save("a", Array.from({ length: i }, (_, k) => msg(k)));
    await s.flush();
    expect(most).toBe(1);
    expect(writes).toBeLessThan(5);
    expect(store(dir).load("a")).toHaveLength(5);
  });
});

describe("the saved conversation: ephemeral ids, durability", () => {
  it("never writes a per-run id (answerId, heardId) and never reads one back", async () => {
    const dir = tmp();
    const s = store(dir);
    s.save("github:1", [msg(0, { answerId: 1, heardId: 7, someId: 3 }), msg(1, { answerId: 2 })]);
    await s.flush();
    const text = fs.readFileSync(file(dir), "utf8");
    expect(text).not.toMatch(/answerId|heardId|someId/);
    // A file that carries them (written by another build, or edited) loads without them.
    fs.writeFileSync(file(dir), JSON.stringify({ version: 1, account: "github:1", savedAt: "2026-11-05T10:00:00Z", entries: [msg(0, { answerId: 1, heardId: 4 })] }));
    const loaded = store(dir).load("github:1");
    expect(loaded).toEqual([msg(0)]);
    expect(Object.keys(loaded[0]).sort()).toEqual(["t", "text", "who"]);
  });

  it("flushes the folder after the rename so a crash right after keeps the new name; a folder that can't be synced doesn't fail the save", async () => {
    const dir = tmp();
    const order: string[] = [];
    const ops: HistoryOps = {
      ...real(),
      syncDir: async d => { order.push(fs.existsSync(file(dir)) ? "dir-after-rename" : "dir-before-rename"); expect(d).toBe(dir); throw Object.assign(new Error("no"), { code: "EPERM" }); },
    };
    const s = store(dir, ops);
    s.save("github:1", [msg(0)]);
    await s.flush();
    expect(order).toEqual(["dir-after-rename"]);
    expect(store(dir).load("github:1")).toEqual([msg(0)]);
    expect(logs.join("\n")).not.toContain("history.not_saved");
  });

  it("a write that fails midway (ENOSPC) leaves the old file whole, removes the temp file, logs, and the next save works", async () => {
    const dir = tmp();
    const ok = store(dir);
    ok.save("github:1", [msg(0)]);
    await ok.flush();
    logs.length = 0;
    let fail = true;
    const s = store(dir, { ...real(), write: async (t, d) => { if (!fail) { fs.writeFileSync(t, d); return; } fs.writeFileSync(t, d.slice(0, 20)); throw Object.assign(new Error("full"), { code: "ENOSPC" }); } });
    s.save("github:1", [msg(0), msg(1)]);
    await s.flush();
    expect(JSON.parse(fs.readFileSync(file(dir), "utf8")).entries).toHaveLength(1);
    expect(fs.readdirSync(dir)).toEqual([HISTORY_FILE]);
    expect(logs.join("\n")).toContain("history.not_saved");
    expect(logs.join("\n")).toContain("ENOSPC");
    fail = false;
    s.save("github:1", [msg(0), msg(1)]);
    await s.flush();
    expect(JSON.parse(fs.readFileSync(file(dir), "utf8")).entries).toHaveLength(2);
    expect(fs.readdirSync(dir)).toEqual([HISTORY_FILE]);
  });
});

describe("the saved conversation: quit, erasure and failures (PR #188 review)", () => {
  const eacces = () => Object.assign(new Error("denied"), { code: "EACCES" });

  it("flush() waits for a newer snapshot queued behind a write in flight: it is on disk when flush resolves", async () => {
    const dir = tmp();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let first = true;
    const ops: HistoryOps = { ...real(), write: async (t, d) => { if (first) { first = false; await gate; } fs.writeFileSync(t, d, { mode: 0o600 }); } };
    const s = store(dir, ops);
    s.save("a", [msg(0)]);
    await vi.waitFor(() => { expect((s as unknown as { running: unknown }).running).not.toBeNull(); });
    s.save("a", [msg(0), msg(1)]); // B, behind A
    let done = false;
    const flushed = s.flush().then(() => { done = true; });
    release();
    await flushed;
    expect(done).toBe(true);
    expect(JSON.parse(fs.readFileSync(file(dir), "utf8")).entries).toHaveLength(2);
  });

  it("a deletion that fails is reported by clear(), and this store never loads the file meanwhile", async () => {
    const dir = tmp();
    const s = store(dir);
    s.save("a", [msg(0)]);
    await s.flush();
    const rm = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw eacces(); });
    const trunc = vi.spyOn(fs, "truncateSync").mockImplementation(() => { throw eacces(); });
    const problems: unknown[] = [];
    const t = new HistoryStore({ dir, log, delayMs: 1, onProblem: p => problems.push(p) });
    expect(t.clear()).toBe(false);
    expect(t.problem).toBe("delete");
    expect(problems).toEqual(["delete"]);
    expect(fs.existsSync(file(dir))).toBe(true);
    // Still undeletable: the entry is not restored by this store.
    expect(t.load("a")).toEqual([]);
    rm.mockRestore(); trunc.mockRestore();
    // The retry before the next load succeeds and says so.
    expect(t.load("a")).toEqual([]);
    expect(fs.existsSync(file(dir))).toBe(false);
    expect(t.problem).toBeNull();
    expect(problems).toEqual(["delete", null]);
  });

  it("a file that can't be deleted is emptied, so even a later start finds nothing to show", async () => {
    const dir = tmp();
    const s = store(dir);
    s.save("a", [msg(0)]);
    await s.flush();
    const rm = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw eacces(); });
    expect(s.clear()).toBe(false);
    rm.mockRestore();
    expect(fs.statSync(file(dir)).size).toBe(0);
    expect(store(dir).load("a")).toEqual([]);
  });

  it("a save that fails is visible (problem 'save') until a save works", async () => {
    const dir = tmp();
    let fail = true;
    const seen: unknown[] = [];
    const s = new HistoryStore({ dir, log, delayMs: 1, onProblem: p => seen.push(p), ops: { ...real(), write: async (t, d) => { if (fail) throw eacces(); fs.writeFileSync(t, d); } } });
    s.save("a", [msg(0)]);
    await s.flush();
    expect(s.problem).toBe("save");
    fail = false;
    s.save("a", [msg(0)]);
    await s.flush();
    expect(s.problem).toBeNull();
    expect(seen).toEqual(["save", null]);
  });
});

describe("the saved conversation: a clear that survives a restart (PR #188 re-review 2)", () => {
  const eacces = () => Object.assign(new Error("denied"), { code: "EACCES" });
  const marker = (dir: string) => path.join(dir, "conversation.erased");
  /** Deleting and emptying the conversation file fail (a held or read-only file), as in the review's repro. */
  const stuck = () => [
    vi.spyOn(fs, "rmSync").mockImplementation((f: fs.PathLike) => { if (String(f).endsWith(HISTORY_FILE)) throw eacces(); }),
    vi.spyOn(fs, "truncateSync").mockImplementation(() => { throw eacces(); }),
  ];
  const free = (spies: { mockRestore(): void }[]) => spies.forEach(s => s.mockRestore());

  it("a clear whose deletion and emptying both fail still hides the conversation from a fresh store, and says so", async () => {
    const dir = tmp();
    const s = store(dir);
    s.save("a", [msg(0)]);
    await s.flush();
    const spies = stuck();
    expect(s.clear()).toBe(false);
    expect(s.problem).toBe("delete"); // (physical deletion failed; the marker holds it back)
    expect(fs.existsSync(file(dir))).toBe(true);
    if (posixModes) expect(fs.statSync(marker(dir)).mode & 0o777).toBe(0o600);
    // A separate process: no memory of the failure, only the folder.
    const fresh = store(dir);
    expect(fresh.load("a")).toEqual([]);
    expect(fresh.problem).toBe("delete");
    free(spies);
    // Deletion works again: the retry removes the file and then the marker.
    const later = store(dir);
    expect(later.load("a")).toEqual([]);
    expect(later.problem).toBeNull();
    expect(fs.existsSync(file(dir))).toBe(false);
    expect(fs.existsSync(marker(dir))).toBe(false);
    later.save("a", [msg(3)]);
    await later.flush();
    expect(store(dir).load("a")).toEqual([msg(3)]);
  });

  it("an older save still flushing the folder when a clear succeeds in marking doesn't undo that clear (PR #188 round 3)", async () => {
    const dir = tmp();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let syncing = false;
    const ops: HistoryOps = { ...real(), syncDir: async () => { syncing = true; await gate; } };
    const s = store(dir, ops);
    s.save("a", [msg(0)]);
    await vi.waitFor(() => { expect(syncing).toBe(true); }); // renamed, now held in syncDir
    const spies = stuck();
    expect(s.clear()).toBe(false);
    expect(s.problem).toBe("delete");
    free(spies);
    release();
    await s.flush();
    expect(fs.existsSync(marker(dir))).toBe(true);
    expect(s.problem).toBe("delete");
    expect(store(dir).load("a")).toEqual([]);
  });

  it("a marker that can't be read is not 'no marker': nothing is restored, the problem says so, and it recovers when readable (PR #188 round 3)", async () => {
    const dir = tmp();
    const s = store(dir);
    s.save("a", [msg(0)]);
    await s.flush();
    const spies = stuck();
    expect(s.clear()).toBe(false);
    free(spies); // (the old file is still there, voided by the marker)
    const realRead = fs.readFileSync;
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(((f: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(f).endsWith("conversation.erased")) throw eacces();
      return (realRead as (...a: unknown[]) => unknown)(f, ...rest);
    }) as typeof fs.readFileSync);
    const problems: unknown[] = [];
    const fresh = new HistoryStore({ dir, log, delayMs: 1, onProblem: p => problems.push(p) });
    expect(fresh.load("a")).toEqual([]);
    expect(fresh.problem).toBe("unchecked");
    expect(problems).toEqual(["unchecked"]);
    expect(fs.existsSync(marker(dir))).toBe(true);
    read.mockRestore();
    // Readable again: the normal rules apply (the old-generation file is voided and the problem goes).
    expect(fresh.load("a")).toEqual([]);
    expect(fresh.problem).toBeNull();
  });

  it.skipIf(!posixModes || process.getuid?.() === 0)("a marker with mode 000 is refused the same way, with a real permission error (PR #188 round 3)", async () => {
    const dir = tmp();
    const s = store(dir);
    s.save("a", [msg(0)]);
    await s.flush();
    const spies = stuck();
    s.clear();
    free(spies);
    fs.chmodSync(marker(dir), 0);
    try {
      const fresh = store(dir);
      expect(fresh.load("a")).toEqual([]);
      expect(fresh.problem).toBe("unchecked");
    } finally { fs.chmodSync(marker(dir), 0o600); }
  });

  it("a save made while the old file still can't be deleted replaces it, and a restart restores only the new one", async () => {
    const dir = tmp();
    const s = store(dir);
    s.save("a", [msg(0)]);
    await s.flush();
    const spies = stuck();
    s.clear();
    const t = store(dir);
    expect(t.load("a")).toEqual([]);
    t.save("a", [msg(5)]);
    await t.flush();
    expect(store(dir).load("a")).toEqual([msg(5)]);
    free(spies);
    expect(store(dir).load("a")).toEqual([msg(5)]);
    expect(fs.existsSync(marker(dir))).toBe(false); // superseded by the newer save, so it is tidied
  });

  it("an older copy written after the marker (a stale file put back) is never shown", async () => {
    const dir = tmp();
    const s = store(dir);
    s.save("a", [msg(0)]);
    await s.flush();
    const old = fs.readFileSync(file(dir), "utf8");
    const spies = stuck();
    s.clear();
    fs.writeFileSync(file(dir), old);
    expect(store(dir).load("a")).toEqual([]);
    free(spies);
  });

  it("when even the marker can't be written, the problem says the copy may come back", async () => {
    const dir = tmp();
    const s = store(dir);
    s.save("a", [msg(0)]);
    await s.flush();
    const spies = stuck();
    const open = vi.spyOn(fs, "openSync").mockImplementation(() => { throw eacces(); });
    const seen: unknown[] = [];
    const t = new HistoryStore({ dir, log, delayMs: 1, onProblem: p => seen.push(p) });
    expect(t.clear()).toBe(false);
    expect(t.problem).toBe("exposed");
    expect(seen).toEqual(["exposed"]);
    open.mockRestore();
    free(spies);
    expect(conversationKeepProblem("exposed")).not.toContain("won’t show it again");
    expect(conversationKeepProblem("delete")).toContain("won’t show it again");
  });

  it("a failed delete that the marker covers is not 'exposed' once a later start deletes it", async () => {
    const dir = tmp();
    const s = store(dir);
    s.save("a", [msg(0)]);
    await s.flush();
    const spies = stuck();
    s.clear();
    free(spies);
    const t = store(dir);
    t.load("zzz"); // another owner: still tidies everything
    expect(fs.existsSync(file(dir))).toBe(false);
    expect(fs.existsSync(marker(dir))).toBe(false);
  });

  it("an owner the host can't establish is a visible problem until it can", () => {
    const seen: unknown[] = [];
    const t = new HistoryStore({ dir: tmp(), log, delayMs: 1, onProblem: p => seen.push(p) });
    t.setOwnerKnown(false);
    expect(t.problem).toBe("owner");
    t.setOwnerKnown(true);
    expect(t.problem).toBeNull();
    expect(seen).toEqual(["owner", null]);
    expect(conversationKeepProblem("owner")).toMatch(/isn’t saving/);
  });
});
