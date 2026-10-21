import { afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chooseModels, mayUseRuntimeDefault } from "../../app/main/agent/models";
import { isUsableToken, resolveToken, TokenStore, startDeviceFlow, pollDeviceFlow, type SecretBox } from "../../app/main/agent/auth";
import { hardenedSessionConfig, BUILTIN_AGENTS } from "../../app/main/agent/session-config";
import { explainStartError } from "../../app/main/agent/host";
import { locateRuntime } from "../../app/main/agent/runtime";

describe("the runtime's default model (Copilot Free lists none)", () => {
  it("only with no model listed and nothing limiting the models", () => {
    expect(mayUseRuntimeDefault(0, {})).toBe(true);
    expect(mayUseRuntimeDefault(2, {})).toBe(false);
    expect(mayUseRuntimeDefault(0, { allowed: ["gpt-5"] })).toBe(false);
    expect(mayUseRuntimeDefault(0, { conductor: "gpt-5" })).toBe(false);
    expect(mayUseRuntimeDefault(0, { worker: "gpt-5" })).toBe(false);
    expect(mayUseRuntimeDefault(0, { provider: true })).toBe(false);
  });
});

describe("chooseModels", () => {
  const models = [
    { id: "gpt-5", capabilities: { supports: { vision: true } } },
    { id: "gpt-5-mini", capabilities: { supports: { vision: true } } },
    { id: "text-only-mini", capabilities: { supports: { vision: false } } },
    { id: "disabled-big", capabilities: { supports: { vision: true } }, policy: { state: "disabled" } },
  ];
  it("uses a fast model for the conductor and a strong vision model for workers", () => {
    expect(chooseModels(models)).toEqual({ conductor: "gpt-5-mini", worker: "gpt-5" });
  });
  it("honours preferences, but never a non-vision worker", () => {
    expect(chooseModels(models, { conductor: "gpt-5", worker: "text-only-mini" })).toEqual({ conductor: "gpt-5", worker: "gpt-5" });
  });
  it("returns nulls when nothing is usable", () => {
    expect(chooseModels([])).toEqual({ conductor: null, worker: null });
  });
});

describe("auth", () => {
  it("accepts OAuth, app and fine-grained tokens but not classic ghp_", () => {
    expect(isUsableToken("gho_abc123")).toBe(true);
    expect(isUsableToken("ghu_abc123")).toBe(true);
    expect(isUsableToken("github_pat_11AA_bb")).toBe(true);
    expect(isUsableToken("ghp_abc123")).toBe(false);
    expect(isUsableToken("")).toBe(false);
  });

  it("prefers a stored token, then the environment, then the GitHub CLI", async () => {
    const box: SecretBox = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s.split("").reverse().join("")), decryptString: b => b.toString().split("").reverse().join("") };
    const store = new TokenStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-tok-")), "token"), box);
    const gh = async () => "gho_fromcli";
    expect(await resolveToken(store, {}, gh)).toEqual({ token: "gho_fromcli", source: "github-cli" });
    expect(await resolveToken(store, { GH_TOKEN: "gho_fromenv" }, gh)).toEqual({ token: "gho_fromenv", source: "environment" });
    store.save("gho_stored");
    expect(fs.readFileSync((store as unknown as { file: string }).file, "utf8")).not.toContain("gho_stored");
    expect(await resolveToken(store, { GH_TOKEN: "gho_fromenv" }, gh)).toEqual({ token: "gho_stored", source: "stored" });
  });

  it("refuses to store tokens without a keyring", () => {
    const box: SecretBox = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString(), getSelectedStorageBackend: () => "basic_text" };
    const store = new TokenStore(path.join(os.tmpdir(), `ember-tok-${Date.now()}`), box);
    expect(store.save("gho_x")).toBe(false);
  });

  it("runs the device flow, waiting through pending and slow_down", async () => {
    const replies = [
      { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 },
      { error: "authorization_pending" },
      { error: "slow_down", interval: 10 },
      { access_token: "gho_done" },
    ];
    const calls: string[] = [];
    const fetch = async (url: string) => { calls.push(url); return { ok: true, status: 200, json: async () => replies.shift() }; };
    const code = await startDeviceFlow(fetch, "client-id");
    expect(code.userCode).toBe("ABCD-1234");
    const waits: number[] = [];
    const token = await pollDeviceFlow(fetch, "client-id", code, { sleep: async ms => { waits.push(ms); } });
    expect(token).toBe("gho_done");
    expect(waits).toEqual([5000, 5000, 10000]);
    expect(calls[0]).toContain("/login/device/code");
  });

  it("explains denial and expiry", async () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ error: "access_denied" }) });
    await expect(pollDeviceFlow(fetch, "c", { deviceCode: "d", userCode: "u", verificationUri: "v", expiresIn: 60, interval: 0 }, { sleep: async () => {} }))
      .rejects.toThrow(/cancelled on GitHub/);
  });
});

describe("hardened session config", () => {
  it("removes every built-in tool and agent and streams", () => {
    const c = hardenedSessionConfig({ tools: [], systemMessage: { content: "x" }, workingDirectory: "/tmp/e", onPermissionRequest: () => ({ kind: "reject" }) as never }) as unknown as Record<string, unknown>;
    expect(c.availableTools).toEqual([]);
    expect(c.excludedBuiltinAgents).toEqual(BUILTIN_AGENTS);
    expect(c.streaming).toBe(true);
  });
});

describe("startup errors", () => {
  it("explains policy, auth and seat problems in plain words", () => {
    expect(explainStartError(new Error("Failed to load models: access denied by Copilot policy"))).toMatch(/Copilot CLI policy/);
    expect(explainStartError(new Error("401 Unauthorized"))).toMatch(/Sign in again/);
    // Electron's own network and certificate errors (net.fetch) read as such, not as "net::ERR_…".
    expect(explainStartError(new Error("net::ERR_INTERNET_DISCONNECTED"))).toMatch(/can't reach GitHub/);
    expect(explainStartError(new Error("net::ERR_PROXY_CONNECTION_FAILED"))).toMatch(/can't reach GitHub/);
    expect(explainStartError(new Error("net::ERR_CERT_AUTHORITY_INVALID"))).toMatch(/certificate/);
    expect(explainStartError(new Error("spawn ENOENT"))).toMatch(/Reinstall/);
  });
});

describe("runtime", () => {
  it("finds the bundled Copilot runtime in node_modules", () => {
    expect(locateRuntime({ appPath: process.cwd(), env: {} }).exists).toBe(true);
  });
  it("honours EMBER_COPILOT_RUNTIME", () => {
    const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-rt-")), "copilot-runtime");
    fs.writeFileSync(fake, "");
    expect(locateRuntime({ appPath: "/nowhere", env: { EMBER_COPILOT_RUNTIME: fake } }).path).toBe(fake);
  });
});

describe("review round 2", () => {
  it("with no model that has vision, tasks get an allowed model anyway (never the runtime's default)", () => {
    const text = [{ id: "text-big" }, { id: "text-mini" }];
    expect(chooseModels(text)).toEqual({ conductor: "text-mini", worker: "text-mini" });
    expect(chooseModels(text, { worker: "text-big" })).toEqual({ conductor: "text-mini", worker: "text-big" });
  });

  it("cancelling the sign-in while it waits fetches nothing more and returns no token", async () => {
    const ac = new AbortController();
    let fetches = 0;
    const fetch = async () => { fetches++; return { ok: true, status: 200, json: async () => ({ access_token: "gho_" + "y".repeat(36) }) }; };
    const poll = pollDeviceFlow(fetch, "cid", { deviceCode: "d", userCode: "u", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 },
      { signal: ac.signal, sleep: async () => { ac.abort(); } });
    await expect(poll).rejects.toMatchObject({ name: "AbortError" });
    expect(fetches).toBe(0);
  });

  it("the clipboard comes back exactly: every format, and empty stays empty", async () => {
    const { electronClipboard, asPasteClipboard } = await import("../../app/main/agent/clipboard");
    class Item { constructor(readonly data: Record<string, unknown>) {} get types() { return Object.keys(this.data); } async getType(t: string) { return this.data[t]; } }
    let board: Item[] = [new Item({ "text/plain": "secret", "text/html": "<b>secret</b>", "image/png": new Blob([new Uint8Array([1, 2, 3])]) })];
    let cleared = 0;
    const cb = electronClipboard<Item>({
      read: async () => board, write: async items => { board = items; }, writeText: async t => { board = [new Item({ "text/plain": t })]; }, clear: () => { board = []; cleared++; },
    }, Item as unknown as new (d: Record<string, never>) => Item);
    const saved = await cb.save();
    await cb.writeText("pasted");
    expect(board[0].data).toEqual({ "text/plain": "pasted" });
    await cb.restore(saved);
    expect(board[0].types).toEqual(["text/plain", "text/html", "image/png"]);
    expect(await (board[0].data["image/png"] as Blob).arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
    board = [];
    const empty = await cb.save();
    await cb.writeText("pasted");
    await cb.restore(empty);
    expect(board).toEqual([]);
    expect(cleared).toBe(1);
    // The older text-only wiring still works.
    let text = "mine";
    const old = asPasteClipboard({ readText: async () => text, writeText: async t => { text = t; } });
    const s = await old.save();
    await old.writeText("x");
    await old.restore(s);
    expect(text).toBe("mine");
  });

  it("the clipboard: raw X targets are never read (Electron crashes on PIXMAP), and an owner that doesn't answer ends the save", async () => {
    const { electronClipboard, ClipboardTimeout } = await import("../../app/main/agent/clipboard");
    const read: string[] = [];
    const data: Record<string, unknown> = { "text/plain": "cells", PIXMAP: 1, BITMAP: 2, TARGETS: 3, "application/x-openoffice-embed-source-xml;windows_formatname=\"Star Embed Source (XML)\"": 4 };
    const item = { types: Object.keys(data), getType: async (t: string) => { read.push(t); return data[t]; } };
    class Item { constructor(readonly data: Record<string, unknown>) {} }
    const cb = electronClipboard<Item>({ read: async () => [item], write: async () => undefined, writeText: async () => undefined, clear: () => undefined }, Item as unknown as new (d: Record<string, never>) => Item);
    expect(Object.keys((await cb.save()).items[0])).toEqual(["text/plain", Object.keys(data)[4]]);
    expect(read).not.toContain("PIXMAP");
    // A frozen owner: one format never comes.
    const stuck = { types: ["text/plain", "text/html"], getType: (t: string) => (t === "text/html" ? new Promise(() => undefined) : Promise.resolve("x")) };
    const slow = electronClipboard<Item>({ read: async () => [stuck], write: async () => undefined, writeText: async () => undefined, clear: () => undefined }, Item as unknown as new (d: Record<string, never>) => Item, 100);
    const t0 = Date.now();
    await expect(slow.save()).rejects.toBeInstanceOf(ClipboardTimeout);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("the clipboard (review round 4)", () => {
  const raw = (name: string) => `electron application/osclipboard;format="${name}"`;
  class Item { constructor(readonly data: Record<string, unknown>) {} get types() { return Object.keys(this.data); } async getType(t: string) { return this.data[t]; } }
  /** A clipboard as Electron 44 lists it; `reads` keeps every format read. */
  const board = (initial: Record<string, unknown>[], reads: string[] = []) => {
    const state = { items: initial.map(d => ({ types: Object.keys(d), getType: async (t: string) => { reads.push(t); return d[t]; } })) as { types: string[]; getType(t: string): Promise<unknown> }[], written: 0, cleared: 0 };
    return { state, reads };
  };
  const clip = async (b: ReturnType<typeof board>, timeoutMs?: number) => {
    const { electronClipboard } = await import("../../app/main/agent/clipboard");
    return electronClipboard<Item>({
      read: async () => b.state.items,
      write: async items => { b.state.items = items.map(i => ({ types: i.types, getType: async (t: string) => i.data[t] })); b.state.written++; },
      writeText: async t => { b.state.items = [{ types: ["text/plain"], getType: async () => t }]; },
      clear: () => { b.state.items = []; b.state.cleared++; },
    }, Item as unknown as new (d: Record<string, never>) => Item, timeoutMs);
  };

  it("an app's own formats (LibreOffice cells, file lists) and the password marker are kept; raw X targets and extra pictures are not read", async () => {
    const cells = { "text/plain": "6", "text/html": "<td>6</td>", "image/png": new Blob([new Uint8Array([9])]), [raw("application/x-openoffice-embed-source-xml;windows_formatname=\"Star Embed Source (XML)\"")]: "<cells/>",
      [raw("application/x-libreoffice-tsvc")]: "6", [raw("application/x-openoffice-bitmap;windows_formatname=\"Bitmap\"")]: "BMP", [raw("image/bmp")]: "BMP",
      [raw("x-special/gnome-copied-files")]: "copy\nfile:///x", [raw("x-kde-passwordManagerHint")]: "secret", [raw("PIXMAP")]: 1, [raw("TARGETS")]: 2, [raw("STRING")]: "6" };
    const b = board([cells]);
    const saved = await (await clip(b)).save();
    expect(Object.keys(saved.items[0]).sort()).toEqual(["image/png", "text/html", "text/plain", raw("application/x-libreoffice-tsvc"),
      raw("application/x-openoffice-embed-source-xml;windows_formatname=\"Star Embed Source (XML)\""), raw("x-kde-passwordManagerHint"), raw("x-special/gnome-copied-files")].sort());
    for (const never of [raw("PIXMAP"), raw("TARGETS"), raw("STRING"), raw("image/bmp"), raw("application/x-openoffice-bitmap;windows_formatname=\"Bitmap\"")]) expect(b.reads).not.toContain(never);
  });

  it("a picture of copied text that takes too long to make is left out instead of failing the save; a copied picture alone is still required", async () => {
    const { ClipboardTimeout } = await import("../../app/main/agent/clipboard");
    const slow = board([]);
    slow.state.items = [{ types: ["text/plain", "image/png"], getType: (t: string) => (t === "image/png" ? new Promise(() => undefined) : Promise.resolve("cells")) }];
    const t0 = Date.now();
    expect((await (await clip(slow, 200)).save()).items).toEqual([{ "text/plain": "cells" }]);
    expect(Date.now() - t0).toBeLessThan(1000);
    const picture = board([]);
    picture.state.items = [{ types: ["image/png"], getType: () => new Promise(() => undefined) }];
    await expect((await clip(picture, 200)).save()).rejects.toBeInstanceOf(ClipboardTimeout);
  });

  it("tells whether the clipboard changed since it was saved, and puts it back only over Ember's own text", async () => {
    const b = board([{ "text/plain": "old copy", "text/html": "<b>old copy</b>" }]);
    const cb = await clip(b);
    const saved = await cb.save();
    expect(await cb.unchanged(saved)).toBe(true);
    b.state.items = [{ types: ["text/plain"], getType: async () => "new copy" }];
    expect(await cb.unchanged(saved)).toBe(false);
    // Still Ember's text: put back.
    await cb.writeText("Ember");
    await cb.restore(saved, "Ember");
    expect(b.state.written).toBe(1);
    expect(await b.state.items[0].getType("text/plain")).toBe("old copy");
    // Cleared meanwhile (a password manager's timer), or a new copy: left as it is.
    await cb.writeText("Ember");
    b.state.items = [];
    await cb.restore(saved, "Ember");
    expect(b.state.items).toEqual([]);
    b.state.items = [{ types: ["text/plain"], getType: async () => "newer copy" }];
    await cb.restore(saved, "Ember");
    expect(await b.state.items[0].getType("text/plain")).toBe("newer copy");
    expect(b.state.written).toBe(1);
  });
});

describe("startup errors (review round 4)", () => {
  it("a runtime connection disposed under a pending request reads as the runtime stopping", () => {
    expect(explainStartError(new Error("Pending response rejected since connection got disposed"))).toBe("Ember's Copilot runtime stopped while connecting. Press Check again.");
  });
});

describe("the user's own words (review round 5)", () => {
  it("a waiting task changed by the user starts with what they said then, beside the conductor's wording", async () => {
    const { TaskManager } = await import("../../app/main/agent/tasks");
    const specs: { goal: string; userWords?: string }[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as never;
    const tm = new TaskManager({
      log: quiet, currentWindow: () => null, setCards: () => undefined, deleteSession: async () => undefined, keepMs: 0, maxRunning: 1,
      makeWorker: spec => { specs.push(spec); return { run: async () => { await gate; return { success: true, summary: "ok" }; }, dispose: async () => undefined, sessionId: spec.id } as never; },
    });
    tm.start("first", { userWords: "do the first thing" });
    const waiting = tm.start("tidy the drafts", { userWords: "tidy my drafts" });
    expect(await tm.steer(waiting.id, "delete them", "and delete the drafts")).toBe(true);
    release();
    await new Promise(r => setTimeout(r, 50));
    expect(specs[1]).toMatchObject({ goal: "tidy the drafts\n(The user then added: delete them)", userWords: "tidy my drafts\nand delete the drafts" });
  });
});

describe("a request the runtime takes but never begins (review round 7)", () => {
  afterEach(() => { vi.useRealTimers(); });
  // Event sequences as the real runtime sends them (one user.message per request, in order; a request sent
  // during a turn begins after its turn_end; idle only once nothing waits).
  async function watch(ms = 20_000, opts: { slowMs?: number; silentMs?: number } = {}) {
    vi.useFakeTimers();
    const { TurnWatch } = await import("../../app/main/agent/conductor");
    const whys: string[] = [];
    const slow: boolean[] = [];
    const w = new TurnWatch(ms, why => { whys.push(why); }, { ...opts, onSlow: s => { slow.push(s); } });
    const ev = (...types: string[]) => { for (const type of types) w.event({ type, data: {} }); };
    const send = () => { w.sending(); ev("pending_messages.modified"); w.sent(); };
    const tool = (phase: "start" | "complete", id: string) => w.event({ type: `tool.execution_${phase}`, data: { toolCallId: id } });
    return { w, ev, send, tool, whys, slow, stuck: () => whys.length, wait: (t: number) => vi.advanceTimersByTime(t) };
  }

  it("a turn that begins (also with its first word a minute later) is left alone; one that never does is noticed once", async () => {
    const a = await watch();
    a.send();
    a.ev("user.message", "assistant.turn_start");
    a.wait(120_000);
    a.ev("assistant.message", "assistant.turn_end", "assistant.idle", "session.idle");
    a.wait(120_000);
    expect(a.stuck()).toBe(0);
    a.send();
    a.wait(19_000);
    expect(a.stuck()).toBe(0);
    a.wait(1000);
    expect(a.stuck()).toBe(1);
    a.ev("pending_messages.modified");
    a.wait(60_000);
    expect(a.stuck()).toBe(1);
  });

  it("its message came but no turn began: noticed; any event is life and starts the wait again", async () => {
    const a = await watch();
    a.send();
    a.ev("user.message");
    a.wait(15_000);
    a.ev("session.info");
    a.wait(15_000);
    expect(a.stuck()).toBe(0);
    a.wait(5000);
    expect(a.stuck()).toBe(1);
  });

  it("requests sent during a long turn wait for it; the runtime not beginning the next one after it ends is noticed", async () => {
    const a = await watch();
    a.send();
    a.ev("user.message", "assistant.turn_start");
    // A long step of the turn (a question to the user, a slow look at the screen).
    a.tool("start", "c1");
    a.send();
    a.send();
    a.wait(300_000);
    a.tool("complete", "c1");
    a.ev("assistant.turn_end", "pending_messages.modified", "user.message", "assistant.turn_start");
    a.tool("start", "c2");
    a.wait(300_000);
    a.tool("complete", "c2");
    expect(a.stuck()).toBe(0);
    a.ev("assistant.turn_end", "pending_messages.modified");
    a.wait(20_000);
    expect(a.whys).toEqual(["not-started"]);
  });

  it("Stop or an error drops what waits; a failed send owes nothing; a sub-agent's events are only life", async () => {
    const a = await watch();
    a.send();
    a.ev("user.message", "assistant.turn_start");
    a.send();
    a.w.clear();
    a.ev("abort", "agent.interrupted", "assistant.turn_end", "assistant.idle", "session.idle");
    a.wait(60_000);
    a.send();
    a.ev("user.message", "assistant.turn_start", "assistant.turn_retry");
    a.send();
    a.ev("session.error", "session.idle");
    a.wait(60_000);
    a.w.sending();
    a.w.unsent();
    a.wait(60_000);
    expect(a.stuck()).toBe(0);
    a.send();
    a.w.event({ type: "assistant.turn_start", agentId: "helper", data: {} });
    a.wait(20_000);
    expect(a.stuck()).toBe(1);
  });

  it("a hook or a compaction under way before the turn gets longer; a disposed watch never fires", async () => {
    const a = await watch();
    a.send();
    a.ev("user.message");
    a.w.event({ type: "hook.start", data: { hookInvocationId: "h1" } });
    a.wait(100_000);
    expect(a.stuck()).toBe(0);
    a.w.event({ type: "hook.end", data: { hookInvocationId: "h1" } });
    a.ev("session.compaction_start");
    a.wait(100_000);
    a.ev("session.compaction_complete");
    a.wait(19_000);
    expect(a.stuck()).toBe(0);
    a.wait(1000);
    expect(a.stuck()).toBe(1);
    const b = await watch();
    b.send();
    b.w.dispose();
    b.wait(60_000);
    expect(b.stuck()).toBe(0);
  });
});

describe("a turn that began and then hears nothing from Copilot (review round 8)", () => {
  afterEach(() => { vi.useRealTimers(); });
  async function watch(opts: { slowMs?: number; silentMs?: number } = {}) {
    vi.useFakeTimers();
    const { TurnWatch, TURN_SLOW_MS, TURN_SILENT_MS } = await import("../../app/main/agent/conductor");
    expect([TURN_SLOW_MS, TURN_SILENT_MS]).toEqual([30_000, 180_000]);
    const whys: string[] = [];
    const slow: boolean[] = [];
    const w = new TurnWatch(20_000, why => { whys.push(why); }, { ...opts, onSlow: s => { slow.push(s); } });
    const ev = (...types: string[]) => { for (const type of types) w.event({ type, data: {} }); };
    const begin = () => { w.sending(); ev("pending_messages.modified"); w.sent(); ev("user.message", "assistant.turn_start"); };
    const tool = (phase: "start" | "complete", id: string) => w.event({ type: `tool.execution_${phase}`, data: { toolCallId: id } });
    return { w, ev, begin, tool, whys, slow, wait: (t: number) => vi.advanceTimersByTime(t) };
  }

  it("a model request that never answers: still waiting at 30 s, given up on at the long limit, once", async () => {
    const a = await watch();
    a.begin();
    a.wait(29_000);
    expect(a.slow).toEqual([]);
    a.wait(1000);
    expect(a.slow).toEqual([true]);
    a.wait(149_000);
    expect(a.whys).toEqual([]);
    a.wait(1000);
    expect(a.whys).toEqual(["silent"]);
    a.ev("assistant.turn_end", "session.idle");
    a.wait(600_000);
    expect(a.whys).toEqual(["silent"]);
  });

  it("asking again while a turn is silent doesn't put off its end: the runtime's echo of the queued request isn't life (AC10-1)", async () => {
    const a = await watch();
    a.begin();
    for (let i = 0; i < 4; i++) { a.wait(40_000); a.w.sending(); a.ev("pending_messages.modified"); a.w.sent(); }
    expect(a.whys).toEqual([]);
    // 180 s since Copilot was last heard from.
    a.wait(20_000);
    expect(a.whys).toEqual(["silent"]);
  });

  it("streaming (reasoning, the answer) is life: heard from again, the bubble's note goes and the waits start over", async () => {
    const a = await watch();
    a.begin();
    for (let i = 0; i < 30; i++) { a.wait(20_000); a.ev(i % 2 ? "assistant.message_delta" : "assistant.reasoning_delta"); }
    expect(a.slow).toEqual([]);
    a.wait(40_000);
    a.ev("assistant.reasoning_delta");
    expect(a.slow).toEqual([true, false]);
    a.wait(140_000);
    a.ev("assistant.message", "assistant.turn_end", "assistant.idle", "session.idle");
    a.wait(600_000);
    expect(a.whys).toEqual([]);
    expect(a.slow).toEqual([true, false, true, false]);
  });

  it("a long tool call (a slow look at the screen, a question to the user) isn't quiet; the wait starts once it's done", async () => {
    const a = await watch();
    a.begin();
    a.ev("assistant.message");
    a.tool("start", "c1");
    a.w.event({ type: "external_tool.requested", data: { requestId: "r1" } });
    a.wait(600_000);
    a.w.event({ type: "external_tool.completed", data: { requestId: "r1" } });
    a.wait(600_000);
    expect(a.slow).toEqual([]);
    expect(a.whys).toEqual([]);
    a.tool("complete", "c1");
    a.wait(180_000);
    expect(a.whys).toEqual(["silent"]);
  });

  it("nothing is watched between turns, after Stop, or once disposed; the timings are the caller's", async () => {
    const a = await watch({ slowMs: 1000, silentMs: 5000 });
    a.begin();
    a.ev("assistant.message", "assistant.turn_end", "assistant.idle", "session.idle");
    a.wait(600_000);
    a.begin();
    a.w.clear();
    a.wait(600_000);
    expect(a.whys).toEqual([]);
    a.begin();
    a.wait(1000);
    expect(a.slow).toEqual([true]);
    a.wait(4000);
    expect(a.whys).toEqual(["silent"]);
    const b = await watch();
    b.begin();
    b.w.dispose();
    b.wait(600_000);
    expect([b.slow, b.whys]).toEqual([[], []]);
  });

  it("a compaction under way in the turn gets twice as long", async () => {
    const a = await watch();
    a.begin();
    a.ev("session.compaction_start");
    a.wait(359_000);
    expect(a.whys).toEqual([]);
    a.wait(1000);
    expect(a.whys).toEqual(["silent"]);
  });

  it("a background compaction outlasts the turn that started it: the next turn, held until it completes, gets twice as long too (AC9-1)", async () => {
    const a = await watch();
    a.begin();
    a.ev("session.compaction_start", "assistant.message", "assistant.turn_end", "assistant.idle", "session.idle");
    // The next request: its turn begins, and the runtime holds it until the compaction completes.
    a.begin();
    a.wait(359_000);
    expect(a.whys).toEqual([]);
    a.ev("session.compaction_complete");
    // Done: the usual limit again.
    a.wait(179_000);
    expect(a.whys).toEqual([]);
    a.wait(1000);
    expect(a.whys).toEqual(["silent"]);
  });

  it("Stop or an error ends the compaction under way: the usual limit again", async () => {
    for (const end of ["abort", "session.error"]) {
      const a = await watch();
      a.ev("session.compaction_start");
      a.begin();
      if (end === "abort") a.w.clear();
      a.ev(end, "assistant.turn_end", "session.idle");
      a.begin();
      a.wait(179_000);
      expect(a.whys).toEqual([]);
      a.wait(1000);
      expect(a.whys).toEqual(["silent"]);
    }
  });

  it("once it has given up, nothing fires until resume(); then it watches again from what the events since say", async () => {
    const a = await watch();
    a.begin();
    a.wait(180_000);
    expect(a.whys).toEqual(["silent"]);
    // The turn is being ended: what comes meanwhile fires nothing.
    a.ev("assistant.reasoning_delta");
    a.wait(600_000);
    a.ev("abort", "assistant.turn_end", "session.idle");
    a.w.resume();
    a.wait(600_000);
    expect(a.whys).toEqual(["silent"]);
    a.begin();
    a.wait(179_000);
    expect(a.whys).toEqual(["silent"]);
    a.wait(1000);
    expect(a.whys).toEqual(["silent", "silent"]);
    expect(a.slow).toEqual([true, true]);
  });
});
