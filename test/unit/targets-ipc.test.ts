/**
 * The settings window's channels for computers and commands (TARGETS_IPC, targets/ipc.ts): only the settings window's
 * own page is heard (critique integration-5), every request is checked field by field before the runtime sees it, and
 * the changed list goes back only to that page.
 */

import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../app/main/logger";
import { TARGETS_IPC, type TargetSummary } from "../../app/shared/targets";
import type { IpcLike, WebContentsLike } from "../../app/main/targets/types";
import { parseAct, registerTargetsIpc } from "../../app/main/targets/ipc";

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet, file: "" };

/** An ipcMain stand-in: handlers by channel, invoked as a page would. */
function fakeIpc() {
  const handlers = new Map<string, (e: { sender: WebContentsLike }, ...a: unknown[]) => unknown>();
  const ipc: IpcLike = { on: (c, fn) => { handlers.set(c, fn); }, handle: (c, fn) => { handlers.set(c, fn); } };
  const invoke = async (channel: string, sender: WebContentsLike, ...args: unknown[]) => handlers.get(channel)!({ sender }, ...args);
  return { ipc, invoke };
}
const page = (id: number) => ({ id, send: vi.fn() });
const list: TargetSummary[] = [{ id: "local", kind: "local", label: "This computer", state: "ready", can: "apps", active: true }];

describe("TARGETS_IPC", () => {
  it("answers list and act only for the settings window's own page", async () => {
    const home = page(7);
    const other = page(8);
    const act = vi.fn(async () => ({ ok: true as const }));
    const { ipc, invoke } = fakeIpc();
    registerTargetsIpc({ ipc, isHome: s => s.id === 7, log: quiet, list: () => list, act });
    await expect(invoke(TARGETS_IPC.list, home)).resolves.toEqual(list);
    await expect(invoke(TARGETS_IPC.list, other)).rejects.toThrow("not allowed");
    await expect(invoke(TARGETS_IPC.act, other, { kind: "openCommands" })).rejects.toThrow("not allowed");
    expect(act).not.toHaveBeenCalled();
    await expect(invoke(TARGETS_IPC.act, home, { kind: "openCommands" })).resolves.toEqual({ ok: true });
    expect(act).toHaveBeenCalledWith({ kind: "openCommands" });
  });

  it("refuses a request when the check itself throws", async () => {
    const { ipc, invoke } = fakeIpc();
    registerTargetsIpc({ ipc, isHome: () => { throw new Error("gone"); }, log: quiet, list: () => list, act: async () => ({ ok: true }) });
    await expect(invoke(TARGETS_IPC.list, page(1))).rejects.toThrow("not allowed");
  });

  it("answers a malformed request with a plain no, and a runtime failure without its details", async () => {
    const { ipc, invoke } = fakeIpc();
    registerTargetsIpc({ ipc, isHome: () => true, log: quiet, list: () => list, act: async () => { throw new Error("secret detail"); } });
    await expect(invoke(TARGETS_IPC.act, page(1), { kind: "nope" })).resolves.toEqual({ ok: false, message: "Ember didn't understand that request." });
    const r = await invoke(TARGETS_IPC.act, page(1), { kind: "openCommands" });
    expect(r).toEqual({ ok: false, message: "Something went wrong. Try again." });
  });

  it("pushes the changed list only to the settings page that asked, while it still is that page", async () => {
    const home = page(7);
    let isHome = true;
    const { ipc, invoke } = fakeIpc();
    const t = registerTargetsIpc({ ipc, isHome: s => isHome && s.id === 7, log: quiet, list: () => list, act: async () => ({ ok: true }) });
    t.push(list);
    expect(home.send).not.toHaveBeenCalled();
    await invoke(TARGETS_IPC.list, home);
    t.push(list);
    expect(home.send).toHaveBeenCalledWith(TARGETS_IPC.changed, list);
    isHome = false;
    t.push(list);
    expect(home.send).toHaveBeenCalledTimes(1);
  });
});

describe("parseAct", () => {
  it("accepts each request in its exact shape", () => {
    expect(parseAct({ kind: "activate", id: "ssh:build-01" })).toEqual({ kind: "activate", id: "ssh:build-01" });
    expect(parseAct({ kind: "connect", hostId: "build-01" })).toEqual({ kind: "connect", hostId: "build-01" });
    expect(parseAct({ kind: "forget", hostId: "build-01" })).toEqual({ kind: "forget", hostId: "build-01" });
    expect(parseAct({ kind: "add", dest: "deploy@build-01.example.com:2222" })).toEqual({ kind: "add", dest: "deploy@build-01.example.com:2222" });
    expect(parseAct({ kind: "add", dest: "ssh://deploy@build-01:22" })).toEqual({ kind: "add", dest: "ssh://deploy@build-01:22" });
    expect(parseAct({ kind: "wsl", on: true })).toEqual({ kind: "wsl", on: true });
    expect(parseAct({ kind: "commands", id: "wsl:Ubuntu", on: true, askEvery: true })).toEqual({ kind: "commands", id: "wsl:Ubuntu", on: true, askEvery: true });
    expect(parseAct({ kind: "commands", id: "local", on: false })).toEqual({ kind: "commands", id: "local", on: false });
    expect(parseAct({ kind: "offerSsh", on: false })).toEqual({ kind: "offerSsh", on: false });
    expect(parseAct({ kind: "openCommands" })).toEqual({ kind: "openCommands" });
  });

  it("refuses unknown kinds, extra fields, wrong types, bad ids and option-like destinations", () => {
    for (const bad of [
      null, "activate", [], { kind: "activate", id: "ssh:Build 01" }, { kind: "activate", id: "box" }, { kind: "activate", id: "local", extra: 1 },
      { kind: "connect", hostId: "Build-01" }, { kind: "connect", hostId: "-oProxyCommand=x" }, { kind: "add", dest: "-oProxyCommand=touch x" },
      { kind: "add", dest: "host name" }, { kind: "add", dest: "a\nb" }, { kind: "wsl", on: "yes" }, { kind: "commands", id: "local", on: true, askEvery: "x" },
      { kind: "commands", id: "wsl:bad name", on: true }, { kind: "openCommands", now: true }, { kind: "uninstall" },
    ]) expect(parseAct(bad), JSON.stringify(bad)).toBeNull();
  });
});
