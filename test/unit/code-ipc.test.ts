/**
 * The coding window's channels (app/main/code/ipc.ts) and its preload (app/preload/code.ts): every CODE_IPC command
 * has a handler that answers only a registered coding window's own page (none registered: every sender refused),
 * checks its arguments' type and size before the hub sees them, and becomes exactly one hub command.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CODE_IPC, CODE_LIMITS } from "../../app/shared/code";
import { CODE_ARGS, CodeWindows, registerCodeIpc, type CodeIpcEvent } from "../../app/main/code/ipc";
import { CODE_REFUSALS } from "../../app/main/code/guards";
import type { CodeCommand } from "../../app/main/code/hub";

type Handler = (event: CodeIpcEvent, ...args: unknown[]) => unknown;

function setUp() {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Handler>();
  const commands: { command: CodeCommand; actor: string; from: string }[] = [];
  const hub = { dispatch: async (command: CodeCommand, actor: string, from: string) => { commands.push({ command, actor, from }); return { ok: true }; } };
  const windows = new CodeWindows(url => url.startsWith("file://"));
  registerCodeIpc({ handle: (c, fn) => handlers.set(c, fn), on: (c, fn) => listeners.set(c, fn) }, hub as never, windows);
  const contents = { id: 7, sent: [] as unknown[], send(channel: string, payload: unknown) { this.sent.push([channel, payload]); }, isDestroyed: () => false };
  const event = (sender: unknown = contents, url = "file:///app/renderer/code/index.html"): CodeIpcEvent => ({ sender, senderFrame: { url } });
  return { handlers, listeners, commands, windows, contents, event };
}

describe("the coding window's channels", () => {
  it("has a handler for every command channel, invoke or fire-and-forget", () => {
    const { handlers, listeners } = setUp();
    const commandChannels = Object.entries(CODE_IPC).filter(([k]) => !["event", "row", "request", "micHeld"].includes(k)).map(([, v]) => v);
    expect([...handlers.keys(), ...listeners.keys()].sort()).toEqual([...commandChannels].sort());
    expect([...listeners.keys()].sort()).toEqual([CODE_IPC.detach, CODE_IPC.stopAll, CODE_IPC.markRead].sort());
    expect(Object.keys(CODE_ARGS).sort()).toEqual(Object.keys(CODE_IPC).filter(k => !["event", "row", "request", "micHeld"].includes(k)).sort());
  });

  it("refuses every sender until a coding window is registered, then only that window's own page", async () => {
    const s = setUp();
    await expect(Promise.resolve(s.handlers.get(CODE_IPC.list)!(s.event()))).rejects.toThrow("untrusted IPC sender");
    const unregister = s.windows.register(s.contents);
    expect(await s.handlers.get(CODE_IPC.list)!(s.event())).toEqual({ ok: true });
    await expect(Promise.resolve(s.handlers.get(CODE_IPC.list)!(s.event({ id: 7, send() {}, isDestroyed: () => false })))).rejects.toThrow("untrusted IPC sender");
    await expect(Promise.resolve(s.handlers.get(CODE_IPC.list)!(s.event(s.contents, "https://evil.example/")))).rejects.toThrow("untrusted IPC sender");
    s.listeners.get(CODE_IPC.stopAll)!(s.event({ id: 8 }));
    expect(s.commands.map(c => c.command.type)).toEqual(["list"]);
    unregister();
    await expect(Promise.resolve(s.handlers.get(CODE_IPC.list)!(s.event()))).rejects.toThrow("untrusted IPC sender");
  });

  it("turns each channel's arguments into one hub command, as the user, from that window", async () => {
    const s = setUp();
    s.windows.register(s.contents);
    await s.handlers.get(CODE_IPC.attach)!(s.event(), "abc", 12);
    await s.handlers.get(CODE_IPC.interrupt)!(s.event(), "abc", { keepBackground: true });
    await s.handlers.get(CODE_IPC.respond)!(s.event(), { sessionId: "abc", requestId: "r1", kind: "permission", payload: { kind: "approve-once" } });
    s.listeners.get(CODE_IPC.stopAll)!(s.event());
    await new Promise(r => setTimeout(r, 0));
    expect(s.commands).toEqual([
      { command: { type: "attach", sessionId: "abc", sinceSeq: 12 }, actor: "user", from: "7" },
      { command: { type: "interrupt", sessionId: "abc", keepBackground: true }, actor: "user", from: "7" },
      { command: { type: "respond", answer: { sessionId: "abc", requestId: "r1", kind: "permission", payload: { kind: "approve-once" } } }, actor: "user", from: "7" },
      { command: { type: "stopAll" }, actor: "user", from: "7" },
    ]);
  });

  it("answers arguments of the wrong type or size with a refusal, and the hub never sees them", async () => {
    const s = setUp();
    s.windows.register(s.contents);
    const bad: [string, unknown[]][] = [
      [CODE_IPC.attach, [{ id: 1 }]],
      [CODE_IPC.send, [{ sessionId: "a", prompt: "x".repeat(CODE_LIMITS.prompt + 1) }]],
      [CODE_IPC.send, [{ sessionId: "a", prompt: "x", attachments: Array.from({ length: CODE_LIMITS.attachments + 1 }, () => ({ type: "file", path: "/a" })) }]],
      [CODE_IPC.create, [{ folder: "/etc" }]],
      [CODE_IPC.rpc, [{ scope: "session", method: "x", params: { s: "a".repeat(CODE_LIMITS.params + 1) } }]],
      [CODE_IPC.setPermissionMode, ["a", "yolo"]],
      [CODE_IPC.update, ["a", { name: "x".repeat(CODE_LIMITS.name + 1) }]],
      [CODE_IPC.removeProject, ["../x y"]],
    ];
    for (const [channel, args] of bad) expect(await s.handlers.get(channel)!(s.event(), ...args), channel).toEqual({ ok: false, reason: CODE_REFUSALS.badArgs });
    expect(await s.handlers.get(CODE_IPC.list)!(s.event(), "extra")).toEqual({ projects: [], sessions: [] });
    expect(s.commands).toEqual([]);
  });

  it("sends a session's events to the window that asked and rows and requests to every coding window", () => {
    const s = setUp();
    const other = { id: 9, sent: [] as unknown[], send(channel: string, payload: unknown) { this.sent.push([channel, payload]); }, isDestroyed: () => false };
    s.windows.register(s.contents);
    s.windows.register(other);
    s.windows.send(CODE_IPC.event, { seq: 1 }, "7");
    s.windows.send(CODE_IPC.row, { id: "a" });
    expect(s.contents.sent).toEqual([[CODE_IPC.event, { seq: 1 }], [CODE_IPC.row, { id: "a" }]]);
    expect(other.sent).toEqual([[CODE_IPC.row, { id: "a" }]]);
  });
});

describe("main's wiring of the coding hub (main.ts)", () => {
  it("stops every session on Stop, at sign-out and when another account signs in, behind its own setting", () => {
    const main = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8");
    expect(main).toContain('{ name: "code", stop: () => codeRef?.stopAll() },');
    const signOut = main.slice(main.indexOf("ipcMain.handle(IPC.signOut"), main.indexOf("ipcMain.handle(IPC.cancelSignIn"));
    expect(signOut).toContain("codeRef?.accountEnded()");
    const changed = main.slice(main.indexOf("onAccountChanged: () => {"), main.indexOf("onReminder:"));
    expect(changed).toContain("codeRef?.accountEnded()");
    expect(main).toContain("enabled: () => settings.get().code.enabled");
    expect(main).toContain("registerCodeIpc(ipcMain, code, codeWindows, { log: log.child(\"code\") });");
  });
});

describe("the coding window's preload", () => {
  it("exposes window.emberCode with every method of EmberCodeApi, over CODE_IPC only", () => {
    const source = fs.readFileSync(path.resolve("app/preload/code.ts"), "utf8");
    const shared = fs.readFileSync(path.resolve("app/shared/code.ts"), "utf8");
    const api = /export interface EmberCodeApi \{([\s\S]*?)\n\}/.exec(shared)![1];
    const methods = [...api.matchAll(/^\s+(\w+)\(/gm)].map(m => m[1]);
    expect(methods.length).toBe(23);
    for (const m of methods) expect(source, m).toMatch(new RegExp(`\\n  ${m}: `));
    expect(source).toContain('contextBridge.exposeInMainWorld("emberCode", api);');
    expect(source).not.toMatch(/ipcRenderer\.(invoke|send)\("/);
  });

  it("is built with the other preloads", () => {
    expect(fs.readFileSync(path.resolve("scripts/build-app.mjs"), "utf8")).toContain("entryPoints: pages.map(p => ({ in: `app/preload/${p}.ts`, out: p })),");
  });
});
