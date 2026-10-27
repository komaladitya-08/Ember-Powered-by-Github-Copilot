/**
 * Only Ember's own bundled pages may use the settings IPC (isTrustedSender, windows.ts). File URLs use "/" on every
 * OS, so a Windows install's pages are recognised too (the "\" separator test refused every one of them there). The
 * command and prompt windows go further: their channels are taken only from their own window's page, and each preload
 * bridges only its own window's channels (critique integration-5).
 */

import { describe, expect, it, vi } from "vitest";
import { COMMANDS_IPC } from "../../app/shared/commands";
import { PROMPT_IPC } from "../../app/shared/remote-ui";
import { TARGETS_IPC } from "../../app/shared/targets";
import { COMMANDS_EXTRA_IPC } from "../../app/renderer/command/model";
import { createCommandWindowController } from "../../app/main/commands/window";
import { createPromptWindowController } from "../../app/main/remote/prompt-window";
import type { BrowserWindowLike, IpcLike, WebContentsLike } from "../../app/main/targets/types";
import type { Logger } from "../../app/main/logger";

/** What the preloads expose and which IPC channels each exposed function uses (a fake contextBridge and ipcRenderer). */
const bridge = vi.hoisted(() => ({ exposed: new Map<string, Record<string, unknown>>(), channels: [] as string[] }));
vi.mock("electron", () => ({
  BrowserWindow: class {},
  contextBridge: { exposeInMainWorld: (name: string, api: Record<string, unknown>) => { bridge.exposed.set(name, api); } },
  ipcRenderer: {
    invoke: (channel: string) => { bridge.channels.push(channel); return Promise.resolve(null); },
    send: (channel: string) => { bridge.channels.push(channel); },
    on: (channel: string) => { bridge.channels.push(channel); },
    removeListener: () => undefined,
  },
}));

const { isTrustedSender } = await import("../../app/main/windows");

describe("isTrustedSender", () => {
  it("trusts Ember's own pages on Linux, as before", () => {
    expect(isTrustedSender("file:///opt/ember/resources/app.asar/dist/app/renderer/home/index.html")).toBe(true);
    expect(isTrustedSender("file:///home/dev/ember/dist/app/renderer/home/index.html")).toBe(true);
  });

  it("trusts them on Windows, where the install path has spaces and a drive letter", () => {
    expect(isTrustedSender("file:///C:/Program%20Files/Ember/resources/app/dist/app/renderer/home/index.html")).toBe(true);
    expect(isTrustedSender("file:///C:/Users/Ana%20Lopez/AppData/Local/Programs/Ember/resources/app/dist/app/renderer/home/index.html")).toBe(true);
  });

  it("trusts them on macOS, inside the app bundle", () => {
    expect(isTrustedSender("file:///Applications/Ember.app/Contents/Resources/app/dist/app/renderer/home/index.html")).toBe(true);
  });

  it("refuses a page outside Ember's renderer folder, and anything that isn't a local file", () => {
    expect(isTrustedSender("file:///tmp/evil/index.html")).toBe(false);
    expect(isTrustedSender("file:///tmp/renderer-ish/index.html")).toBe(false);
    expect(isTrustedSender("https://example.com/renderer/home/index.html")).toBe(false);
    expect(isTrustedSender("devtools://devtools/renderer/index.html")).toBe(false);
    expect(isTrustedSender("")).toBe(false);
  });

  it("doesn't take a Windows backslash as a folder separator in a URL", () => {
    expect(isTrustedSender("file:///C:/evil/%5Crenderer%5C/index.html")).toBe(false);
  });

  it("doesn't take an encoded slash as a folder separator either", () => {
    expect(isTrustedSender("file:///tmp/evil%2Frenderer%2Findex.html")).toBe(false);
    expect(isTrustedSender("file:///tmp/evil/%2Frenderer%2F/index.html")).toBe(false);
  });

  it("trusts Ember's pages in a folder whose name has a % in it, as Chromium writes their URL, and never throws", () => {
    // loadFile leaves a literal % as it is (checked with Electron 44): "100% Free" becomes "100%%20Free", which
    // decodeURIComponent refuses ("URI malformed"), and that failed every settings and status request there.
    expect(isTrustedSender("file:///D:/Tools/100%%20Free/Ember/resources/app/dist/app/renderer/home/index.html")).toBe(true);
    expect(isTrustedSender("file:///home/zoe/Tools%20C%23%20100%%20Free%20(x86)%20&%20Zo%C3%AB's%20[x]/ember/resources/app/dist/app/renderer/home/index.html")).toBe(true);
    expect(isTrustedSender("file:///opt/50%AB/ember/resources/app/dist/app/renderer/home/index.html")).toBe(true);
    expect(() => isTrustedSender("file:///tmp/100%/evil.html")).not.toThrow();
    expect(isTrustedSender("file:///tmp/100%/evil.html")).toBe(false);
  });
});

// ───── The SSH/WSL windows' channels (critique integration-5): each only from its own window ─────

type Handler = (event: { sender: WebContentsLike }, ...args: unknown[]) => unknown;
function fakeIpc() {
  const ons = new Map<string, Handler[]>();
  const handles = new Map<string, Handler>();
  const ipc: IpcLike = {
    on: (c, fn) => { ons.set(c, [...(ons.get(c) ?? []), fn]); },
    handle: (c, fn) => { handles.set(c, fn); },
  };
  const deliver = (c: string, sender: WebContentsLike, ...args: unknown[]) => {
    for (const fn of ons.get(c) ?? []) fn({ sender }, ...args);
    return handles.get(c)?.({ sender }, ...args);
  };
  return { ipc, ons, handles, deliver };
}
function fakeWindow(id: number): BrowserWindowLike {
  let visible = false;
  return {
    webContents: { id, send: () => undefined },
    show: () => { visible = true; }, showInactive: () => { visible = true; }, hide: () => { visible = false; }, focus: () => undefined, close: () => undefined, moveTop: () => undefined,
    isVisible: () => visible, isMinimized: () => false, isDestroyed: () => false, isAlwaysOnTop: () => true, isFocused: () => true,
    setAlwaysOnTop: () => undefined, setBounds: () => undefined, setContentProtection: () => undefined, on: () => undefined,
  };
}
const refusals: string[] = [];
const log: Logger = { debug: () => undefined, info: () => undefined, warn: (m, f) => { if (m.endsWith("ipc_refused")) refusals.push((f as { channel: string }).channel); }, error: () => undefined, child: () => log, file: "" };
/** The settings window's own page: a trusted Ember page (isTrustedSender says yes), but not the command or prompt window. */
const home: WebContentsLike = { id: 1, send: () => undefined };

describe("the command window's channels", () => {
  it("are taken only from the command window's page, never from another of Ember's own pages (commands:*)", () => {
    const { ipc, ons, handles, deliver } = fakeIpc();
    const ctl = createCommandWindowController({ create: () => fakeWindow(7), ipc, log, os: "linux", keyHint: () => null });
    ctl.show();
    refusals.length = 0;
    const channels = [...ons.keys(), ...handles.keys()];
    expect(channels.sort()).toEqual([COMMANDS_IPC.answer, COMMANDS_IPC.cardSeen, COMMANDS_IPC.close, COMMANDS_IPC.input, COMMANDS_EXTRA_IPC.size, COMMANDS_IPC.state, COMMANDS_IPC.stop].sort());
    for (const c of channels) deliver(c, home, {});
    expect(refusals.sort()).toEqual(channels.sort());
    expect(ctl.owns(home)).toBe(false);
    expect(ctl.owns({ id: 7, send: () => undefined })).toBe(true);
  });
});

describe("the prompt window's channels", () => {
  it("are taken only from the prompt window's page (prompt:*)", () => {
    const { ipc, ons, handles, deliver } = fakeIpc();
    const ctl = createPromptWindowController({ create: () => fakeWindow(9), ipc, log, os: "linux" });
    void ctl.ask({ id: "p", kind: "touch", host: "build-01" });
    refusals.length = 0;
    const channels = [...ons.keys(), ...handles.keys()];
    expect(channels.sort()).toEqual([PROMPT_IPC.answer, PROMPT_IPC.cancel, PROMPT_IPC.show].sort());
    for (const c of channels) deliver(c, home, { id: "p", ok: true });
    expect(refusals.sort()).toEqual(channels.sort());
    expect(ctl.owns(home)).toBe(false);
  });
});

describe("each preload bridges only its own window's channels", () => {
  /** Calls every function a preload exposed, and returns the channels they used. */
  async function channelsOf(preload: string, world: string): Promise<string[]> {
    await import(preload);
    const api = bridge.exposed.get(world);
    expect(api, world).toBeDefined();
    bridge.channels.length = 0;
    for (const fn of Object.values(api!)) if (typeof fn === "function") (fn as (...a: unknown[]) => unknown)("0123456789abcdef", { n: 1, answer: "deny", sha256: "x" });
    return [...bridge.channels];
  }

  it("the command window's: commands:* only", async () => {
    const used = await channelsOf("../../app/preload/command", "emberCommands");
    expect(used.length).toBeGreaterThan(0);
    for (const c of used) expect(c).toMatch(/^commands:/);
    expect(new Set(used)).toEqual(new Set([...Object.values(COMMANDS_IPC), COMMANDS_EXTRA_IPC.size]));
  });

  it("the prompt window's: prompt:* only", async () => {
    const used = await channelsOf("../../app/preload/prompt", "emberPrompt");
    for (const c of used) expect(c).toMatch(/^prompt:/);
    expect(new Set(used)).toEqual(new Set(Object.values(PROMPT_IPC)));
  });

  it("the settings window's: targets:* through emberTargets only, and no command or prompt channel at all (targets:*)", async () => {
    const targets = await channelsOf("../../app/preload/home", "emberTargets");
    expect(new Set(targets)).toEqual(new Set(Object.values(TARGETS_IPC)));
    bridge.channels.length = 0;
    for (const fn of Object.values(bridge.exposed.get("ember")!)) if (typeof fn === "function") (fn as (...a: unknown[]) => unknown)(() => undefined);
    for (const c of bridge.channels) expect(c).not.toMatch(/^(commands|prompt|targets):/);
  });
});
