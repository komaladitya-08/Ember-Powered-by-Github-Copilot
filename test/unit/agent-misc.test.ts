import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chooseModels } from "../../app/main/agent/models";
import { isUsableToken, resolveToken, TokenStore, startDeviceFlow, pollDeviceFlow, type SecretBox } from "../../app/main/agent/auth";
import { hardenedSessionConfig, BUILTIN_AGENTS } from "../../app/main/agent/session-config";
import { explainStartError } from "../../app/main/agent/host";
import { locateRuntime } from "../../app/main/agent/runtime";

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
