/**
 * The targets runtime (§2, targets/runtime.ts) built from fakes for every factory it wires (RUN's runner, UI's command
 * and prompt windows, WA's WSL, SA's connections and noticing, SC's remote parts): today's behaviour when nothing is set
 * up; commands per target with the administrator's mode, the user's switch and the card; consent records and when a
 * card is asked again; the kill switch's part reaching every runner and link at once; busy counts; the menu; the bubble's
 * actions; question panels; a remote's quick context; the active line and caps; and the doctor's rows. Also the pure
 * pieces: Ember's own process tree, the doctor's row rules and the consent cards' text per OS.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminPolicySchema, adminSummary, type LoadedAdminPolicy } from "../../app/main/admin";
import type { Hands } from "../../app/main/agent/host";
import type { Question } from "../../app/main/agent/confirm";
import type { CommandCard, CommandRunner, RunnerFacts } from "../../app/main/commands/types";
import type { Logger } from "../../app/main/logger";
import type { PerceptionPort, SidecarPort } from "../../app/main/perception/ports";
import type { PlatformDoctorRow, SystemPlatform } from "../../app/main/platform/types";
import type { Welcome } from "../../app/main/remote/protocol";
import type { RemoteTargetParts } from "../../app/main/remote/target";
import { ConnectError, type ConnectProgress, type Connections, type HostRecord, type RemoteLink } from "../../app/main/remote/types";
import type { PromptAnswer } from "../../app/shared/remote-ui";
import { SettingsStore } from "../../app/main/settings";
import type { WslDistro, WslFacts, WslService } from "../../app/main/wsl/types";
import { KEYS, SHORTCUTS, type OS } from "../../app/shared/shortcuts";
import type { ConsentPanel } from "../../app/shared/consent";
import { TARGETS_IPC, type TargetId } from "../../app/shared/targets";
import { commandsConsent, consentSha256, sshConsent, wslConsent } from "../../app/main/targets/consent";
import { commandTerminalRow, parseSshVersion, powershellRow, remotePartsRow, sshClientRow } from "../../app/main/targets/doctor";
import { linuxOwnPids, linuxProcTable, ownTree, psProcTable, statParent } from "../../app/main/targets/local-service";
import {
  WSL_OFF_ROW, buildTargets, configHosts, emberNamesOf, emberPathsOf, hostIdFor, productionParts, progressWords, splitDest, wslSwitchOn,
  type CommandWindow, type PromptWindow, type TargetsParts,
} from "../../app/main/targets/runtime";
import { WSL_READER, sshDestination, userSshProcesses } from "../../app/main/remote/notice-ssh";
import { stopWslHelpers, wslHelperDoctorRows, wslHelperPids } from "../../app/main/wsl/router";
import { A11Y_FIX_COMMAND } from "../../app/main/wsl/launch-sidecar";
import { validConsent } from "../../app/main/remote/prompt-window";
import type { IpcLike, TargetsDeps, WebContentsLike } from "../../app/main/targets/types";

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet, file: "" };
const noPolicy: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };
const policy = (p: unknown): LoadedAdminPolicy => ({ policy: AdminPolicySchema.parse(p), source: "/etc/ember/policy.json" });
const SINCE = "2026-10-22T10:00:00.000Z";
const flush = () => new Promise(r => setTimeout(r, 0));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** A command runner that records what it was asked. */
function fakeRunner(target: TargetId, facts?: Partial<RunnerFacts>) {
  const full: RunnerFacts = {
    os: "linux", shells: ["bash", "sh"], shellPaths: { bash: "/bin/bash", sh: "/bin/sh" }, script: null, home: "/home/ana", user: "ana",
    privileged: false, pty: false, ember: { paths: [], pids: [], names: /(?!)/ }, extraPath: [], ...facts,
  };
  return {
    target, running: 0,
    facts: vi.fn(async () => full),
    inspect: vi.fn(async (p: string[]) => p.map(() => ({ exists: null, real: null }))),
    gitFacts: vi.fn(async () => null),
    start: vi.fn(),
    stopAll: vi.fn(async (_why: "killswitch" | "quit"): Promise<void> => undefined),
  } satisfies CommandRunner & Record<string, unknown>;
}

const welcome = (more: Partial<Welcome> = {}): Welcome => ({
  proto: 1, partsId: "1.0.0-abc", os: "linux", arch: "x64", machineIdHash: "a".repeat(64), isWsl: false, uid: 1000, user: "deploy",
  home: "/home/deploy", facts: { os: "linux", shells: ["bash", "sh"], shellPaths: {}, script: null, home: "/home/deploy", user: "deploy", privileged: false, pty: true, ember: { paths: [], pids: [], names: /(?!)/ }, extraPath: [] },
  desktop: { access: "screen", notice: "shown" }, remoteAdmin: adminSummary(noPolicy), pid: 4321, graceSeconds: 20, ...more,
});

/** A live link the test can move between states and send events on. */
function fakeLink(hostId: string, w: Welcome = welcome()) {
  const states: ((s: "ready" | "stalled" | "lost" | "closed") => void)[] = [];
  const evs = new Map<string, ((d: unknown) => void)[]>();
  const link = {
    id: `link-${hostId}`, hostId, welcome: w, state: "ready" as RemoteLink["state"], epoch: 1, rttMs: 10,
    request: vi.fn(), onBytes: vi.fn(() => () => undefined), close: vi.fn(async () => undefined),
    stop: vi.fn(async () => ({ ms: 1, escalated: false })),
    on: vi.fn((ev: string, fn: (d: unknown) => void) => { evs.set(ev, [...(evs.get(ev) ?? []), fn]); return () => undefined; }),
    onState: vi.fn((fn: (s: "ready" | "stalled" | "lost" | "closed") => void) => { states.push(fn); return () => undefined; }),
  };
  return {
    link: link as unknown as RemoteLink & typeof link,
    move: (s: "ready" | "stalled" | "lost" | "closed") => { link.state = s; for (const f of states) f(s); },
    emit: (ev: string, d: unknown) => { for (const f of evs.get(ev) ?? []) f(d); },
  };
}

interface RigOptions {
  os?: OS;
  admin?: LoadedAdminPolicy;
  hands?: Hands | null;
  settings?: Record<string, unknown>;
  wslFacts?: WslFacts | null;
  elevated?: () => boolean;
  /** How the prompt window answers a consent card: yes (with its hash), no, or yes with a wrong hash. */
  consent?: "yes" | "no" | "forged";
  resolved?: HostRecord["resolved"];
  welcome?: Welcome;
  notice?: TargetsParts["notice"];
  commandWindowExtras?: boolean;
  keyHint?: () => string | null;
  cursor?: boolean;
  /** Main passes its window system's active window (TargetsDepsExtra.activeWindow). */
  activeWindow?: boolean;
}

/** The runtime over fakes, and every fake for the test to look at. */
function rig(o: RigOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-targets-"));
  dirs.push(dir);
  const admin = o.admin ?? noPolicy;
  const settings = new SettingsStore(path.join(dir, "settings.json"), admin.source ? admin.policy : null);
  settings.load();
  if (o.settings) settings.update(o.settings);
  const osName: OS = o.os ?? "linux";
  const audit = { tag: "audit" } as unknown as Hands["audit"];
  const answers: { id: string; via: string; proof?: { sha256: string } }[] = [];
  const confirmer = { waiting: false, answer: vi.fn((id: string, via: string, proof?: { sha256: string }) => { answers.push({ id, via, ...(proof ? { proof } : {}) }); return true; }) } as unknown as Hands["confirmer"];
  const activeWindow = vi.fn(() => ({ app: "gnome-terminal-server", title: "deploy@build-01: ~" }));
  const hands: Hands | null = o.hands === undefined ? {
    perception: { tag: "perception" } as unknown as PerceptionPort, sidecar: { tag: "sidecar" } as unknown as SidecarPort,
    policy: { tag: "policy" } as unknown as Hands["policy"], audit, confirmer, flyTo: vi.fn(), currentWindow: () => null,
    ...(o.cursor ? { cursor: { activeWindow } as unknown as Hands["cursor"] } : {}),
  } : o.hands;
  const local = fakeRunner("local");
  const wslRunners = new Map<string, ReturnType<typeof fakeRunner>>();
  let onAnswer: ((a: { n: number; answer: "once" | "deny"; sha256: string }) => void) | null = null;
  let onConsent: ((a: { n: number; answer: "once" | "deny"; sha256: string }) => void) | null = null;
  const cw = {
    showCard: vi.fn(), hideCard: vi.fn(), cardReady: vi.fn(() => true), announce: vi.fn(async () => true), cancelAnnounce: vi.fn(), attach: vi.fn(),
    show: vi.fn(), owns: vi.fn((s: { id: number }) => s.id === 2), dispose: vi.fn(),
    ...(o.commandWindowExtras === false ? {} : { onAnswer: vi.fn((fn: typeof onAnswer) => { onAnswer = fn; return () => undefined; }) }),
  };
  const cards: ConsentPanel[] = [];
  const pw = {
    ask: vi.fn(async (card: { id: string; kind: string; consent?: ConsentPanel }): Promise<PromptAnswer> => {
      if (card.consent) cards.push(card.consent);
      const mode = o.consent ?? "yes";
      if (mode === "no") return { id: card.id, ok: false };
      return { id: card.id, ok: true, sha256: mode === "forged" ? "0".repeat(64) : card.consent?.sha256 };
    }),
    dismiss: vi.fn(), showConsent: vi.fn(), hideConsent: vi.fn(), consentReady: vi.fn(() => false), dispose: vi.fn(), show: vi.fn(),
    onConsent: vi.fn((fn: typeof onConsent) => { onConsent = fn; return () => undefined; }),
  };
  const wslChange: ((f: WslFacts) => void)[] = [];
  const wsl = {
    facts: vi.fn(async () => o.wslFacts ?? { installed: false, wslExe: null, distros: [], wslg: { available: false, disabledByUser: false, version: null }, wslVersion: null }),
    isRunning: () => true, runningNow: async () => new Set<string>(),
    runner: vi.fn((d: string) => { let r = wslRunners.get(d); if (!r) { r = fakeRunner(`wsl:${d}`); wslRunners.set(d, r); } return r; }),
    defaultUid: async () => 1000, windowsContext: vi.fn(), bootIds: async () => [], onChange: vi.fn((fn: (f: WslFacts) => void) => { wslChange.push(fn); return () => undefined; }),
    doctorRows: vi.fn(async (): Promise<PlatformDoctorRow[]> => [{ id: "wsl", status: "ok", label: "WSL", detail: "WSL 2.3.26 with WSLg; distros: Ubuntu" }]), dispose: vi.fn(),
  };
  const links = new Map<string, ReturnType<typeof fakeLink>>();
  const progress: ((hostId: string, p: ConnectProgress) => void)[] = [];
  let connectFail: Error | null = null;
  let connectGate: Promise<void> | null = null;
  const connOpts: { pcId?: () => string; allowLoopback?: boolean } = {};
  const conns = {
    connect: vi.fn(async (h: HostRecord, c: { interactive: boolean; signal?: AbortSignal }) => {
      if (connectGate) await connectGate;
      if (c.signal?.aborted) throw new ConnectError("Cancelled.", "cancelled");
      if (connectFail) throw connectFail;
      const l = fakeLink(h.id, o.welcome);
      links.set(h.id, l);
      return l.link;
    }),
    disconnect: vi.fn(async () => undefined),
    link: vi.fn((hostId: string) => links.get(hostId)?.link ?? null),
    uninstall: vi.fn(async () => undefined),
    resolve: vi.fn(async (dest: string) => ({ ...(o.resolved ?? { user: "deploy", hostname: `${dest.split("@").pop()}.example.com`, port: 22, jump: [] }), controlPath: null })),
    onProgress: vi.fn((fn: (hostId: string, p: ConnectProgress) => void) => { progress.push(fn); return () => undefined; }),
    stopAll: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
  };
  const remoteRunners = new Map<string, ReturnType<typeof fakeRunner>>();
  /** What a remote's desktop.state answers (SC's refreshDesktop; default: the welcome's access). */
  const remoteDesktop = new Map<string, "screen" | "text" | "none">();
  const refreshes: { hostId: string; release: () => void }[] = [];
  const reads: string[] = [];
  const remoteParts = vi.fn((link: RemoteLink, ro: { hostLabel: string; login: string }) => {
    const r = fakeRunner(`ssh:${link.hostId}`);
    remoteRunners.set(link.hostId, r);
    // As SC's parts judge the desktop: a report only lowers it; the PC's own desktop.state request may raise it.
    const order = ["none", "text", "screen"];
    let access = link.welcome.desktop.access as "screen" | "text" | "none";
    link.on("desktop.changed", d => { if (order.indexOf(d.access) < order.indexOf(access)) access = d.access; });
    const binding = () => ({ id: `ssh:${link.hostId}`, kind: "ssh", label: ro.hostLabel, login: ro.login, screenOs: "linux", shellOs: "linux", desktop: access });
    return {
      perception: {
        quickContext: vi.fn(async () => ({ target: { pid: 7, title: "notes" }, text: "gedit: notes" })), describe: vi.fn(async () => { reads.push("describe"); return "<screen>remote</screen>"; }),
        read: vi.fn(async () => { reads.push("read"); return { text: "read" }; }),
      },
      sidecar: { doAction: vi.fn(async () => { reads.push("doAction"); return { ok: true }; }), scaleOf: () => 1, stop: vi.fn() },
      apps: {}, runner: r, policy: { tag: "remote-policy" }, system: { os: "linux" },
      binding,
      refreshDesktop: vi.fn(() => new Promise(res => {
        refreshes.push({ hostId: link.hostId, release: () => { access = remoteDesktop.get(link.hostId) ?? link.welcome.desktop.access; res(binding()); } });
      })),
      onAuthorized: vi.fn(), dispose: vi.fn(),
    } as unknown as RemoteTargetParts;
  });
  const ticks: (() => void)[] = [];
  const timers: (() => void)[] = [];
  const handlers = new Map<string, (e: { sender: WebContentsLike }, ...a: unknown[]) => unknown>();
  const ipc: IpcLike = { on: (c, fn) => { handlers.set(c, fn); }, handle: (c, fn) => { handlers.set(c, fn); } };
  const home = { id: 1, send: vi.fn() };
  const showState = vi.fn();
  const openSettings = vi.fn();
  const windowsMade = vi.fn(() => { throw new Error("no windows in unit tests"); });
  const sys = {
    os: osName, keys: KEYS[osName], paths: { runtimeExe: osName === "win32" ? "copilot-runtime.exe" : "copilot-runtime" },
    apps: { isTerminalApp: (a: { id: string; name?: string }) => /terminal/i.test(a.name ?? a.id), list: () => [], appKey: (s: string) => s.toLowerCase() },
    privacy: { isSecurityWindow: () => false }, spawnDefaults: {}, which: () => null,
  } as unknown as SystemPlatform;
  let runnerOpts: Parameters<TargetsParts["localRunner"]>[0] | null = null;
  let cwOpts: Parameters<TargetsParts["commandWindow"]>[0] | null = null;
  const wslMade = vi.fn((_o: Parameters<TargetsParts["wsl"]>[0]) => wsl as unknown as WslService);
  const parts: TargetsParts = {
    env: { APPIMAGE: "/home/ana/Ember.AppImage" }, home: "/home/ana", user: "ana",
    localRunner: ro => { runnerOpts = ro; return local; },
    commandWindow: co => { cwOpts = co; return cw as unknown as CommandWindow; },
    promptWindow: () => pw as unknown as PromptWindow,
    wsl: wslMade,
    connections: co => { Object.assign(connOpts, co); return conns as unknown as Connections; },
    remoteParts: remoteParts as unknown as TargetsParts["remoteParts"],
    notice: o.notice ?? null,
    doctor: {
      ssh: async () => ({ path: "/usr/bin/ssh", text: "OpenSSH_8.0p1, OpenSSL 1.1.1k  FIPS 25 Mar 2021" }),
      script: async () => "/usr/bin/script", powershell: async () => null, remoteParts: async () => ["linux-x64", "linux-arm64", "darwin-arm64"],
    },
    ownPids: () => [55],
    wslHelpers: { stop: vi.fn(), pids: vi.fn((): number[] => []), doctorRows: vi.fn(async (): Promise<PlatformDoctorRow[]> => []) },
    sshConfigHosts: () => ["build-02"],
    randomHex: n => "c".repeat(n * 2),
    now: () => new Date("2026-10-22T12:00:00.000Z"),
    setInterval: fn => { ticks.push(fn); return {}; },
    clearInterval: vi.fn(),
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout: vi.fn(),
  };
  const deps: TargetsDeps = {
    log: quiet, os: osName, sys, userData: "/home/ana/.config/ember", appDir: "/opt/ember/resources/app/dist/app", resourcesPath: "/opt/ember/resources",
    execPath: "/opt/ember/ember", packaged: true, settings, admin: () => admin, audit: () => audit, confirmer: () => confirmer,
    localHands: hands, showState, notify: vi.fn(), openSettings, ipc, isHome: s => s.id === 1,
    windows: { command: windowsMade, prompt: windowsMade }, fetch: vi.fn(), devEnv: () => undefined,
    elevated: o.elevated ?? (() => false), emberPids: () => [10, 11], extraPath: () => [], jobHost: null,
    ...(o.keyHint ? { keyHint: o.keyHint } : {}),
  };
  const stopTasksOn = vi.fn();
  const t = buildTargets({ ...deps, stopTasksOn, ...(o.activeWindow ? { activeWindow } : {}) }, parts);
  return {
    t, deps, parts, settings, local, wsl, wslRunners, wslChange, conns, links, progress, remoteRunners, remoteParts, cw, pw, cards, ticks, timers,
    handlers, home, showState, openSettings, windowsMade, answers, confirmer, audit, hands, activeWindow, connOpts, wslMade, stopTasksOn,
    remoteDesktop, refreshes, reads,
    runnerOpts: () => runnerOpts!,
    cwOpts: () => cwOpts!,
    onAnswer: () => onAnswer, onConsent: () => onConsent,
    failConnect: (e: Error | null) => { connectFail = e; },
    holdConnect: () => { let release!: () => void; connectGate = new Promise(r => { release = r; }); return () => { connectGate = null; release(); }; },
    invoke: async (channel: string, sender: WebContentsLike, ...args: unknown[]) => handlers.get(channel)!({ sender }, ...args),
  };
}

const commandsOn = (id: TargetId, version = 1, askEvery = false) => ({ commands: { [id]: { on: true, askEvery, consent: { version, at: SINCE } } } });
const hostRecord = (id: string, more: Partial<HostRecord> = {}): HostRecord => ({
  id, dest: `deploy@${id}`, resolved: { user: "deploy", hostname: `${id}.example.com`, port: 22, jump: [] }, consent: { version: 1, at: SINCE }, ...more,
});
const withHosts = (hosts: HostRecord[], more: Record<string, unknown> = {}) => ({ targets: { active: "local", offerSsh: true, dismissedOffers: [], hosts, wsl: { on: false, consent: { version: 0, at: null } }, pcId: "", ...more } });
const ubuntu = (more: Partial<WslDistro> = {}): WslDistro => ({ name: "Ubuntu", version: 2, isDefault: true, defaultUid: 1000, running: true, needsSetup: false, ...more });
const wslFacts = (distros: WslDistro[]): WslFacts => ({ installed: true, wslExe: "C:\\Program Files\\WSL\\wsl.exe", distros, wslg: { available: true, disabledByUser: false, version: "1.0" }, wslVersion: "2.3.26.0" });
const wslOnSettings = { targets: { active: "local", offerSsh: true, dismissedOffers: [], hosts: [], wsl: { on: true, consent: { version: 1, at: SINCE } }, pcId: "" } };

/** Connects build-01 through the settings window and waits for it. */
async function connected(r: ReturnType<typeof rig>, hostId = "build-01") {
  const res = await r.invoke(TARGETS_IPC.act, r.home, { kind: "connect", hostId });
  expect(res).toEqual({ ok: true });
  return r.links.get(hostId)!;
}

describe("with nothing set up", () => {
  it("behaves as today: this computer only, no commands, no caps, no line, no menu, no badge, no window, nothing started", async () => {
    const r = rig();
    const got = r.t.agent.handsFor("local");
    if (!got.ok) throw new Error(got.why);
    for (const k of Object.keys(r.hands!) as (keyof Hands)[]) expect(got.hands[k]).toBe(r.hands![k]);
    expect(got.hands.commands).toBeNull();
    expect(got.hands.binding).toEqual({ id: "local", kind: "local", label: "This computer", screenOs: "linux", shellOs: "linux", desktop: "screen" });
    expect(got.hands.leaseKey("1:x")).toBe("1:x");
    expect(r.t.agent.active).toBe("local");
    expect(r.t.agent.caps()).toEqual({ commands: false, targets: false });
    expect(r.t.agent.activeLine()).toBe("");
    expect(r.t.menuItems()).toEqual([]);
    expect(r.t.summaries()).toEqual([{ id: "local", kind: "local", label: "This computer", state: "ready", can: "apps", active: true }]);
    expect(r.t.wsl).toBeNull();
    expect(r.t.quickContext()).toBeNull();
    expect(r.t.agent.describeScreen("local")).toBeNull();
    expect(r.t.panelReady(1)).toBe(false);
    expect(r.t.questionWords({ title: "May I?", prompt: "x", options: [] })).toBeNull();
    expect(r.t.busy()).toEqual({ commands: 0, connections: 0 });
    expect(r.showState).not.toHaveBeenCalled();
    expect(r.windowsMade).not.toHaveBeenCalled();
    expect(r.local.facts).not.toHaveBeenCalled();
    expect(r.wslMade).not.toHaveBeenCalled();
    expect(r.ticks).toEqual([]);
    expect(r.settings.get().targets.pcId).toBe("");
    await expect(r.t.stopAll()).resolves.toBeUndefined();
    await r.t.dispose();
  });

  it("binds every task here and refuses a computer the user didn't name", () => {
    const r = rig();
    const b = r.t.agent.bind({ userWords: "open gedit" });
    expect(b.ok && b.binding.id).toBe("local");
    expect(r.t.agent.bind({ userWords: "open gedit", choice: "build-01" })).toEqual({ ok: false, why: "The user didn't name that computer. Use the one they chose, or ask them." });
    expect(r.t.agent.handsFor("ssh:build-01").ok).toBe(false);
    expect(r.t.agent.handsFor("wsl:Ubuntu").ok).toBe(false);
    expect(r.t.agent.handsFor("nonsense" as TargetId).ok).toBe(false);
  });

  it("without a window system and with commands off, refuses this computer (nothing to work with)", () => {
    const r = rig({ hands: null });
    const got = r.t.agent.handsFor("local");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.why).toMatch(/commands are off/);
  });

  it("without a window system, says the user can turn commands on only where the administrator hasn't turned them off", () => {
    expect(rig({ hands: null }).t.agent.handsFor("local")).toEqual({ ok: false, why: "Ember can't use this computer's screen here, and commands are off. Tell the user they can turn commands on in Ember's settings." });
    // A policy that doesn't mention commands turns them off (R5), as does one that says so.
    for (const admin of [policy({}), policy({ commands: { local: "off" } })]) {
      const got = rig({ hands: null, admin, settings: commandsOn("local") }).t.agent.handsFor("local");
      expect(got).toEqual({ ok: false, why: "Ember can't use this computer's screen here, and your organisation has turned off commands on it. Tell the user." });
    }
  });

  it("keeps today's behaviour when the administrator turns WSL, SSH and commands off", () => {
    const r = rig({ os: "win32", admin: policy({ features: { wsl: false, ssh: false }, commands: { local: "off", wsl: "off", ssh: "off" } }), settings: { ...commandsOn("local"), ...withHosts([hostRecord("build-01")]) } });
    expect(r.t.agent.caps()).toEqual({ commands: false, targets: false });
    expect(r.t.menuItems()).toEqual([]);
    expect(r.t.wsl).toBeNull();
    expect(r.t.summaries().map(s => s.id)).toEqual(["local"]);
    const got = r.t.agent.handsFor("local");
    expect(got.ok && got.hands.commands).toBeNull();
  });
});

describe("commands on this computer (§2.5, §3.8.1)", () => {
  it("are offered once the user turned them on with the card: caps, the line, the hands and the runner's shells", async () => {
    const r = rig({ settings: commandsOn("local") });
    expect(r.t.agent.caps()).toEqual({ commands: true, targets: false });
    expect(r.t.agent.activeLine()).toBe("(Ember is set to work on this computer: apps and commands. Commands: on for this computer.)");
    const got = r.t.agent.handsFor("local");
    if (!got.ok) throw new Error(got.why);
    const svc = got.hands.commands!;
    expect(svc.capability()).toEqual({ state: "on", askEvery: null });
    expect(svc.runner).toBe(r.local);
    expect(svc.window).toBe(r.cw);
    expect(svc.mode()).toBe("on");
    expect(r.local.facts).toHaveBeenCalledTimes(1);
    await flush();
    expect(svc.shells()).toEqual(["bash", "sh"]);
    r.t.agent.handsFor("local");
    expect(r.local.facts).toHaveBeenCalledTimes(1);
  });

  it("are off when a policy file exists without commands (R5), even with the user's switch on", () => {
    const r = rig({ admin: policy({}), settings: commandsOn("local") });
    const got = r.t.agent.handsFor("local");
    expect(got.ok && got.hands.commands).toBeNull();
    expect(r.t.agent.caps().commands).toBe(false);
  });

  it("ask before every command under the administrator's ask, the user's own switch, or an elevated Ember (also when that can't be told)", () => {
    const svc = (r: ReturnType<typeof rig>) => { const g = r.t.agent.handsFor("local"); if (!g.ok) throw new Error(g.why); return g.hands.commands!; };
    expect(svc(rig({ admin: policy({ commands: { local: "ask" } }), settings: commandsOn("local") })).capability().askEvery).toBe("admin");
    const user = svc(rig({ settings: commandsOn("local", 1, true) }));
    expect(user.capability().askEvery).toBe("user");
    expect(user.userAskEvery()).toBe(true);
    expect(svc(rig({ settings: commandsOn("local"), elevated: () => true })).capability().askEvery).toBe("root");
    expect(svc(rig({ settings: commandsOn("local"), elevated: () => { throw new Error("token"); } })).capability().askEvery).toBe("root");
  });

  it("wait only for the card when the user turned them on and a newer card must be accepted", () => {
    const r = rig({ settings: commandsOn("local", 0) });
    const got = r.t.agent.handsFor("local");
    if (!got.ok) throw new Error(got.why);
    expect(got.hands.commands!.capability().state).toBe("needs-consent");
    expect(r.t.agent.caps().commands).toBe(true);
    got.hands.commands!.consented();
    expect(r.settings.get().commands.local).toEqual({ on: true, askEvery: false, consent: { version: 1, at: expect.any(String) } });
    expect(got.hands.commands!.capability().state).toBe("on");
  });

  it("without a window system give commands-only hands that refuse every read and carry main's audit and Confirmer", async () => {
    const r = rig({ hands: null, settings: commandsOn("local") });
    const got = r.t.agent.handsFor("local");
    if (!got.ok) throw new Error(got.why);
    expect(got.hands.binding).toMatchObject({ desktop: "none" });
    expect(got.hands.audit).toBe(r.audit);
    expect(got.hands.confirmer).toBe(r.confirmer);
    expect(got.hands.commands).not.toBeNull();
    await expect(got.hands.perception.describe()).rejects.toThrow(/run_command/);
  });

  it("show the commands card a target waits for, from the flow (§3.9.3; TG's consentPanel)", () => {
    const r = rig({ settings: commandsOn("local", 0) });
    const got = r.t.agent.handsFor("local");
    if (!got.ok) throw new Error(got.why);
    const card = (got.hands.commands as unknown as { consentPanel(): ConsentPanel | null }).consentPanel();
    expect(card).toMatchObject({ feature: "commands", target: "local", title: "Let Ember run commands on this computer?", yes: "Turn on", no: "Not now" });
    expect(card!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("know the other computers the user's words name: a task's bubbles say where, and no command announces (wrong target)", async () => {
    const r = rig({ settings: { ...withHosts([hostRecord("build-01")]), ...commandsOn("local") } });
    const got = r.t.agent.handsFor("local");
    if (!got.ok) throw new Error(got.why);
    const guard = got.hands.commands as unknown as { othersNamed(words: string): string[] };
    // Not a place by §2.3's rule 3 (the task binds to the active computer), yet a computer the user named.
    expect(r.t.agent.bind({ userWords: "build-01 delete build/" })).toMatchObject({ ok: true, binding: { id: "local" } });
    expect(guard.othersNamed("build-01 delete build/")).toEqual(["build-01"]);
    expect(guard.othersNamed("build zero one: delete build/")).toEqual(["build-01"]);
    expect(guard.othersNamed("delete build/ here")).toEqual([]);
    expect(r.t.agent.othersNamed!("ssh:build-01", "delete build/ on this computer")).toEqual(["this computer"]);
    expect(r.t.agent.othersNamed!("ssh:build-01", "on build-01 delete build/")).toEqual([]);
    // A host of the user's ssh config Ember has no record of yet is another computer too.
    expect(guard.othersNamed("build-02 delete build/")).toEqual(["build-02"]);
  });

  it("put no badge on a task that can only use apps for a computer's name that is just a word of the request", () => {
    // Commands off, no SSH host: build-02 is only a Host of the user's ssh config.
    const r = rig();
    expect(r.t.agent.othersNamed!("local", "open the build-02 report in LibreOffice")).toEqual([]);
    expect(r.t.agent.othersNamed!("local", "open build-02.example.com in Firefox")).toEqual([]);
    // Named as a place, it still says where the task acts.
    expect(r.t.agent.othersNamed!("local", "open the report on build-02")).toEqual(["build-02"]);
    expect(r.t.agent.othersNamed!("local", "build-02: open the report")).toEqual(["build-02"]);
    // With commands there, any name counts (D4.4's guard).
    const cmd = rig({ settings: commandsOn("local") });
    expect(cmd.t.agent.othersNamed!("local", "open the build-02 report in LibreOffice")).toEqual(["build-02"]);
  });

  it("know the places the user names that look like a computer Ember doesn't know (the lead's ruling)", () => {
    const r = rig({ settings: { ...withHosts([hostRecord("build-01")]), ...commandsOn("local") } });
    const got = r.t.agent.handsFor("local");
    if (!got.ok) throw new Error(got.why);
    const guard = got.hands.commands as unknown as { placesNamed(words: string): string[] };
    expect(r.t.agent.bind({ userWords: "delete build/ on prod-db" })).toMatchObject({ ok: true, binding: { id: "local" } });
    expect(guard.placesNamed("delete build/ on prod-db")).toEqual(["prod-db"]);
    // Ember's own records and the user's ssh config hosts are known computers, not unknown places.
    expect(guard.placesNamed("delete build/ on build-01")).toEqual([]);
    expect(guard.placesNamed("delete build/ on build-02")).toEqual([]);
    expect(guard.placesNamed("delete build/ on the desktop")).toEqual([]);
    // The task's bubbles say it acts on this computer.
    expect(r.t.agent.othersNamed!("local", "delete build/ on prod-db")).toEqual(["prod-db"]);
  });

  it("give the runner Ember's own paths, names and pids (main's and its helpers', live)", () => {
    const r = rig();
    const o = r.runnerOpts();
    expect(o.ember.paths).toEqual(expect.arrayContaining(["/home/ana/.config/ember", "/opt/ember", "/etc/ember", "/home/ana/Ember.AppImage"]));
    expect(o.ember.names.test("copilot-runtime")).toBe(true);
    expect(o.ember.names.test("EMBER")).toBe(true);
    expect(o.ember.names.test("bash")).toBe(false);
    expect(o.ember.pids()).toEqual([10, 11, 55]);
    expect(o.home).toBe("/home/ana");
    expect(o.elevated()).toBe(false);
    // The same live list for main's agent (commands in WSL, whose runner can't see this computer's processes).
    expect(r.t.emberPids()).toEqual([10, 11, 55]);
  });

  it("give the command card main's key hint, and none when main doesn't say or its hint fails", () => {
    expect(rig({ keyHint: () => "Ctrl+Alt+Y allow · Ctrl+Alt+N not now" }).cwOpts().keyHint()).toBe("Ctrl+Alt+Y allow · Ctrl+Alt+N not now");
    expect(rig().cwOpts().keyHint()).toBeNull();
    expect(rig({ keyHint: () => { throw new Error("no keys"); } }).cwOpts().keyHint()).toBeNull();
  });
});

describe("consent cards (§8.4) and their records (§7.4)", () => {
  it("turns commands on only after a yes to this OS's card, with the hash of exactly that text", async () => {
    const r = rig();
    await expect(r.invoke(TARGETS_IPC.act, r.home, { kind: "commands", id: "local", on: true })).resolves.toEqual({ ok: true });
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0].title).toBe("Let Ember run commands on this computer?");
    expect(r.cards[0].body.at(-1)).toBe("Ctrl+Alt+X stops everything at once. What a command already changed stays changed.");
    expect(r.settings.get().commands.local).toMatchObject({ on: true, consent: { version: 1 } });
    // Already accepted: switching off and on again asks nothing.
    await r.invoke(TARGETS_IPC.act, r.home, { kind: "commands", id: "local", on: false });
    expect(r.settings.get().commands.local!.on).toBe(false);
    await r.invoke(TARGETS_IPC.act, r.home, { kind: "commands", id: "local", on: true, askEvery: true });
    expect(r.cards).toHaveLength(1);
    expect(r.settings.get().commands.local).toMatchObject({ on: true, askEvery: true });
  });

  it("leaves commands off after Not now, or an answer carrying another text's hash", async () => {
    for (const consent of ["no", "forged"] as const) {
      const r = rig({ consent });
      const res = await r.invoke(TARGETS_IPC.act, r.home, { kind: "commands", id: "local", on: true });
      expect(res).toEqual({ ok: false, message: "Not now." });
      expect(r.settings.get().commands.local).toBeUndefined();
    }
  });

  it("never shows the card when the administrator turned commands off", async () => {
    const r = rig({ admin: policy({ commands: { local: "off" } }) });
    const res = await r.invoke(TARGETS_IPC.act, r.home, { kind: "commands", id: "local", on: true });
    expect(res).toEqual({ ok: false, message: "Your organisation has turned off commands on this computer." });
    expect(r.cards).toHaveLength(0);
  });

  it("builds each card per OS: the stop chord substituted before hashing, and the target's own lines", () => {
    const facts = { kind: "local" as const, privileged: false, windows: false, podman: false };
    const linux = commandsConsent({ os: "linux", target: "local", targetLabel: "This computer", facts });
    const win = commandsConsent({ os: "win32", target: "local", targetLabel: "This computer", facts: { ...facts, windows: true, privileged: true } });
    const mac = commandsConsent({ os: "darwin", target: "local", targetLabel: "This computer", facts });
    expect(new Set([linux.sha256, win.sha256, mac.sha256]).size).toBe(3);
    for (const [c, osName] of [[linux, "linux"], [win, "win32"], [mac, "darwin"]] as const) {
      expect(c.body.at(-1)!.startsWith(SHORTCUTS[osName].stop.label)).toBe(true);
      expect(c.sha256).toBe(consentSha256(c));
    }
    expect(win.body).toEqual(expect.arrayContaining(["Commands here run as the administrator, so Ember asks before every one.", "Commands here run in Windows PowerShell and can't ask you for answers or passwords."]));
    const wsl = commandsConsent({ os: "win32", target: "wsl:podman-machine-default", targetLabel: "podman-machine-default (WSL)", facts: { kind: "wsl", privileged: false, windows: false, podman: true } });
    expect(wsl.title).toBe("Let Ember run commands on podman-machine-default (WSL)?");
    expect(wsl.body).toEqual(expect.arrayContaining(["Commands in WSL can also reach your Windows files and programs.", "Podman uses this distro, so Ember asks before every command here."]));
    expect(wslConsent({ target: "wsl:Ubuntu", targetLabel: "Ubuntu (WSL)" })).toMatchObject({ feature: "wsl", title: "Use Ember with WSL?", yes: "Turn on", no: "Not now" });
    const ssh = sshConsent({ os: "linux", target: "ssh:build-01", facts: {
      label: "build-01", resolved: { user: "deploy", hostname: "build-01.example.com", port: 22, jump: ["jump-host"] },
      extra: { identityFiles: ["~/.ssh/work_ed25519"], configFile: "~/.ssh/work_config" }, viaLabel: "Ubuntu (WSL)", desktopOff: false, graceSeconds: 20,
    } });
    expect(ssh.title).toBe("Bring Ember to build-01?");
    expect(ssh.body.slice(0, 3)).toEqual([
      "Ember will connect to build-01 as deploy (deploy@build-01.example.com, port 22, through jump-host) with your own SSH settings and keys.",
      "It uses the key ~/.ssh/work_ed25519 and the settings file ~/.ssh/work_config, as your own ssh did.",
      "It connects from Ubuntu (WSL), with Ubuntu's SSH keys.",
    ]);
    expect(ssh.body).toContain("build-01 keeps its own record of what Ember does there.");
    expect(ssh.body.join(" ")).toContain("press Ctrl+Alt+X");
  });

  it("asks the WSL card once, then turns WSL on and looks for distros", async () => {
    const r = rig({ os: "win32", wslFacts: wslFacts([ubuntu()]) });
    expect(r.t.wsl).not.toBeNull();
    await expect(r.invoke(TARGETS_IPC.act, r.home, { kind: "wsl", on: true })).resolves.toEqual({ ok: true });
    expect(r.cards.map(c => c.title)).toEqual(["Use Ember with WSL?"]);
    expect(r.settings.get().targets.wsl).toMatchObject({ on: true, consent: { version: 1 } });
    await flush();
    expect(r.t.summaries().map(s => s.id)).toEqual(["local", "wsl:Ubuntu"]);
    await r.invoke(TARGETS_IPC.act, r.home, { kind: "wsl", on: false });
    await r.invoke(TARGETS_IPC.act, r.home, { kind: "wsl", on: true });
    expect(r.cards).toHaveLength(1);
  });

  it("asks a host's card before the first connection, not again for the same resolution, and again when it changes", async () => {
    const fresh = rig({ settings: withHosts([hostRecord("build-01", { consent: { version: 0, at: null } })]) });
    await connected(fresh);
    expect(fresh.cards.map(c => c.title)).toEqual(["Bring Ember to build-01?"]);
    expect(fresh.settings.get().targets.hosts[0]).toMatchObject({ consent: { version: 1 }, machineIdHash: "a".repeat(64) });
    const same = rig({ settings: withHosts([hostRecord("build-01")]) });
    await connected(same);
    expect(same.cards).toHaveLength(0);
    const moved = rig({ settings: withHosts([hostRecord("build-01")]), resolved: { user: "deploy", hostname: "elsewhere.example.com", port: 22, jump: [] } });
    await connected(moved);
    expect(moved.cards).toHaveLength(1);
    expect(moved.settings.get().targets.hosts[0].resolved.hostname).toBe("elsewhere.example.com");
  });

  it("asks again when the machine reached isn't the one the user said yes to, and disconnects on Not now", async () => {
    const r = rig({ consent: "no", settings: withHosts([hostRecord("build-01", { machineIdHash: "b".repeat(64) })]) });
    const res = await r.invoke(TARGETS_IPC.act, r.home, { kind: "connect", hostId: "build-01" });
    expect(res).toEqual({ ok: false, message: "Not now." });
    expect(r.cards[0].body[0]).toMatch(/isn't the computer Ember connected to before/);
    expect(r.conns.disconnect).toHaveBeenCalledWith("build-01");
    expect(r.t.agent.handsFor("ssh:build-01").ok).toBe(false);
  });

  it("asks again when SA finds another machine before uploading anything, then connects afresh on a yes (once)", async () => {
    const changed = () => new ConnectError("build-01 is a different computer than the one you allowed, so Ember asks again before it connects.", "machine-changed");
    const r = rig({ settings: withHosts([hostRecord("build-01", { machineIdHash: "b".repeat(64) })]) });
    r.conns.connect.mockImplementationOnce(async () => { throw changed(); });
    await expect(r.invoke(TARGETS_IPC.act, r.home, { kind: "connect", hostId: "build-01" })).resolves.toEqual({ ok: true });
    expect(r.cards.map(c => c.body[0])).toEqual([expect.stringMatching(/isn't the computer Ember connected to before/)]);
    expect(r.conns.connect).toHaveBeenCalledTimes(2);
    // The second try went without the old machine, and the new one is remembered.
    expect(r.conns.connect.mock.calls[1][0].machineIdHash).toBeUndefined();
    expect(r.settings.get().targets.hosts[0].machineIdHash).toBe("a".repeat(64));
    expect(r.t.agent.handsFor("ssh:build-01").ok).toBe(true);
    // Not now: nothing changes; and the card is asked once per click, never in a loop.
    const no = rig({ consent: "no", settings: withHosts([hostRecord("build-01", { machineIdHash: "b".repeat(64) })]) });
    no.failConnect(changed());
    await expect(no.invoke(TARGETS_IPC.act, no.home, { kind: "connect", hostId: "build-01" })).resolves.toEqual({ ok: false, message: "Not now." });
    expect(no.settings.get().targets.hosts[0].machineIdHash).toBe("b".repeat(64));
    const twice = rig({ settings: withHosts([hostRecord("build-01", { machineIdHash: "b".repeat(64) })]) });
    twice.failConnect(changed());
    await expect(twice.invoke(TARGETS_IPC.act, twice.home, { kind: "connect", hostId: "build-01" })).resolves.toMatchObject({ ok: false });
    expect(twice.cards).toHaveLength(1);
    expect(twice.conns.connect).toHaveBeenCalledTimes(2);
  });

  it("makes this install's id at first use, once", () => {
    const r = rig();
    expect(r.settings.get().targets.pcId).toBe("");
    const id = r.connOpts.pcId!();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(r.settings.get().targets.pcId).toBe(id);
    expect(r.connOpts.pcId!()).toBe(id);
    expect(r.connOpts.allowLoopback).toBe(false);
  });
});

describe("SSH targets", () => {
  it("connects from the settings window, makes the host the picker's choice, and builds its hands from the remote's parts", async () => {
    const r = rig({ settings: { ...withHosts([hostRecord("build-01")]), ...commandsOn("ssh:build-01") } });
    await connected(r);
    expect(r.conns.connect).toHaveBeenCalledWith(expect.objectContaining({ id: "build-01" }), expect.objectContaining({ interactive: true }));
    expect(r.t.agent.active).toBe("ssh:build-01");
    expect(r.showState).toHaveBeenCalledWith({ target: expect.objectContaining({ id: "ssh:build-01", state: "ready", login: "deploy" }) });
    const got = r.t.agent.handsFor("ssh:build-01");
    if (!got.ok) throw new Error(got.why);
    expect(got.hands.leaseKey("1:x")).toBe("ssh:build-01|1:x");
    expect(got.hands.commands!.runner).toBe(r.remoteRunners.get("build-01"));
    expect(got.hands.commands!.shells()).toEqual(["bash", "sh"]);
    expect(r.t.agent.caps()).toEqual({ commands: true, targets: true });
    expect(r.t.agent.activeLine()).toBe("(Ember is set to work on build-01, connected as deploy: apps and commands. Commands: off for this computer; on on build-01.)");
    expect(r.t.agent.describeTargets()).toBe("<computers>\n- This computer (Linux): no commands; apps\n- build-01 (SSH, connected as deploy, Ember is set to work here): commands; apps on its screen\n</computers>");
    // describe_screen there asks for its desktop first (desktop.state starts its desktop helper), then reads.
    const described = r.t.agent.describeScreen("ssh:build-01");
    await flush();
    expect(r.reads).toEqual([]);
    for (const x of r.refreshes) x.release();
    await expect(described).resolves.toBe("<screen>remote</screen>");
    expect(r.t.busy()).toEqual({ commands: 0, connections: 1 });
  });

  it("takes the stricter of both machines' commands modes, and root asks before every command", async () => {
    const strict = rig({ settings: { ...withHosts([hostRecord("build-01")]), ...commandsOn("ssh:build-01") }, welcome: welcome({ remoteAdmin: { ...adminSummary(noPolicy), commands: { local: "on", wsl: "on", ssh: "ask" } } }) });
    await connected(strict);
    const g = strict.t.agent.handsFor("ssh:build-01");
    if (!g.ok) throw new Error(g.why);
    expect(g.hands.commands!.mode()).toBe("ask");
    const root = rig({ settings: { ...withHosts([hostRecord("build-01")]), ...commandsOn("ssh:build-01") }, welcome: welcome({ uid: 0 }) });
    await connected(root);
    const h = root.t.agent.handsFor("ssh:build-01");
    if (!h.ok) throw new Error(h.why);
    expect(h.hands.commands!.capability().askEvery).toBe("root");
    const off = rig({ settings: { ...withHosts([hostRecord("build-01")]), ...commandsOn("ssh:build-01") }, welcome: welcome({ desktop: { access: "none", notice: "off" }, remoteAdmin: { ...adminSummary(noPolicy), commands: { local: "on", wsl: "on", ssh: "off" } } }) });
    await connected(off);
    expect(off.t.agent.handsFor("ssh:build-01")).toEqual({ ok: false, why: "build-01 has no desktop Ember can use, and commands are off there." });
  });

  it("lets a remote's newly read policy only tighten commands for the link, never loosen them", async () => {
    const r = rig({ settings: { ...withHosts([hostRecord("build-01")]), ...commandsOn("ssh:build-01") } });
    const l = await connected(r);
    const svc = () => { const g = r.t.agent.handsFor("ssh:build-01"); if (!g.ok) throw new Error(g.why); return g.hands.commands; };
    expect(svc()!.mode()).toBe("on");
    l.emit("policy.changed", { ...adminSummary(noPolicy), commands: { local: "on", wsl: "on", ssh: "ask" } });
    expect(svc()!.mode()).toBe("ask");
    l.emit("policy.changed", { ...adminSummary(noPolicy), commands: { local: "on", wsl: "on", ssh: "on" } });
    expect(svc()!.mode()).toBe("ask");
    l.emit("policy.changed", { ...adminSummary(noPolicy), commands: { local: "on", wsl: "on", ssh: "off" } });
    expect(svc()).toBeNull();
  });

  it("lets a remote only lower its desktop access, never raise it", async () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")]), welcome: welcome({ desktop: { access: "text", notice: "shown" } }) });
    const l = await connected(r);
    l.emit("desktop.changed", { access: "screen", notice: "shown" });
    expect(r.t.agent.describeTargets()).toContain("apps on its screen");
    l.emit("desktop.changed", { access: "none", notice: "off", session: { type: "x11", locked: true, active: true } });
    expect(r.t.agent.describeTargets()).toContain("no desktop session");
    expect(r.showState).toHaveBeenCalledWith({ bubble: expect.objectContaining({ title: "Stopped on build-01", thought: "build-01's screen locked, so I stopped working on its screen." }) });
  });

  it("on a stall, says so and offers Disconnect; on loss, works here again and offers Reconnect", async () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")]) });
    const l = await connected(r);
    l.move("stalled");
    expect(r.showState).toHaveBeenCalledWith({ bubble: expect.objectContaining({ title: "build-01 isn't answering", actions: [{ id: "conn:build-01:disconnect", label: "Disconnect" }] }) });
    expect(r.t.agent.handsFor("ssh:build-01").ok).toBe(false);
    l.move("ready");
    expect(r.t.agent.handsFor("ssh:build-01").ok).toBe(true);
    l.move("lost");
    expect(r.t.agent.active).toBe("local");
    expect(r.showState).toHaveBeenCalledWith({ target: undefined });
    expect(r.showState).toHaveBeenCalledWith({ bubble: expect.objectContaining({ title: "Lost build-01", actions: [{ id: "conn:build-01:reconnect", label: "Reconnect", primary: true }, { id: "conn:build-01:stop", label: "Stop trying" }] }) });
    expect(r.t.agent.handsFor("ssh:build-01")).toEqual({ ok: false, why: "The connection to build-01 dropped. Reconnect it from Ember's menu first." });
    expect(r.t.summaries().find(s => s.id === "ssh:build-01")!.state).toBe("lost");
  });

  it("adopts the link SA brought back by itself after a loss", async () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")]) });
    const l = await connected(r);
    l.move("lost");
    const again = fakeLink("build-01");
    r.links.set("build-01", again);
    for (const p of r.progress) p("build-01", { step: "ready" });
    expect(r.t.agent.handsFor("ssh:build-01").ok).toBe(true);
    expect(r.remoteParts).toHaveBeenCalledTimes(2);
  });

  it("never adopts a link SA brought back from another computer, or for a host the user disconnected", async () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")]) });
    const l = await connected(r);
    l.move("lost");
    // Another machine answers under the same name: let go, and Reconnect (with its card) offered instead.
    r.links.set("build-01", fakeLink("build-01", welcome({ machineIdHash: "f".repeat(64) })));
    for (const p of r.progress) p("build-01", { step: "ready" });
    expect(r.t.agent.handsFor("ssh:build-01").ok).toBe(false);
    expect(r.remoteParts).toHaveBeenCalledTimes(1);
    expect(r.conns.disconnect).toHaveBeenCalledWith("build-01");
    expect(r.showState).toHaveBeenLastCalledWith({ bubble: expect.objectContaining({ title: "Lost build-01", thought: expect.stringMatching(/came back as a different computer/) }) });
    // The user disconnected: a link that comes back anyway isn't used.
    await r.invoke(TARGETS_IPC.act, r.home, { kind: "disconnect", hostId: "build-01" });
    r.links.set("build-01", fakeLink("build-01"));
    for (const p of r.progress) p("build-01", { step: "ready" });
    expect(r.t.agent.handsFor("ssh:build-01").ok).toBe(false);
    expect(r.remoteParts).toHaveBeenCalledTimes(1);
  });

  it("lets go of a link that comes up after Cancel or the kill switch, and saves nothing for a host forgotten meanwhile", async () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")]) });
    // SA answers with a link although the kill switch was pressed while it connected.
    r.conns.connect.mockImplementationOnce(async (h: HostRecord) => {
      await new Promise<void>(res => setTimeout(res, 0));
      const fl = fakeLink(h.id);
      r.links.set(h.id, fl);
      return fl.link;
    });
    const pending = r.invoke(TARGETS_IPC.act, r.home, { kind: "connect", hostId: "build-01" });
    await flush();
    void r.t.stopAll();
    await expect(pending).resolves.toEqual({ ok: false, message: "Cancelled." });
    expect(r.conns.disconnect).toHaveBeenCalledWith("build-01");
    expect(r.t.agent.handsFor("ssh:build-01").ok).toBe(false);
    expect(r.remoteParts).not.toHaveBeenCalled();

    // Forgotten while its card was up: the record isn't written back.
    let answer!: (a: PromptAnswer) => void;
    const f = rig({ settings: withHosts([hostRecord("build-02", { consent: { version: 0, at: null } })]) });
    f.pw.ask.mockImplementationOnce(() => new Promise<PromptAnswer>(res => { answer = res; }));
    const asking = f.invoke(TARGETS_IPC.act, f.home, { kind: "connect", hostId: "build-02" });
    await flush();
    await f.invoke(TARGETS_IPC.act, f.home, { kind: "forget", hostId: "build-02" });
    answer({ id: "consent-1", ok: true, sha256: f.pw.ask.mock.calls[0][0].consent!.sha256 });
    await expect(asking).resolves.toEqual({ ok: false, message: "Cancelled." });
    expect(f.settings.get().targets.hosts).toEqual([]);
    expect(f.conns.connect).not.toHaveBeenCalled();
  });

  it("says what failed in §8.7's words, and offers to try again when it may help", async () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")]) });
    r.failConnect(new ConnectError("Ember can't reach build-01 (no route).", "network", "Check you're on the right network or VPN.", true));
    const res = await r.invoke(TARGETS_IPC.act, r.home, { kind: "connect", hostId: "build-01" });
    expect(res).toEqual({ ok: false, message: "Ember can't reach build-01 (no route). Check you're on the right network or VPN." });
    expect(r.showState).toHaveBeenLastCalledWith({ bubble: expect.objectContaining({ title: "Can't connect to build-01", actions: [{ id: "conn:build-01:reconnect", label: "Try again" }] }) });
    expect(r.t.summaries().find(s => s.id === "ssh:build-01")!.state).toBe("off");
  });

  it("shows progress while connecting, and Cancel stops it", async () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")]) });
    const release = r.holdConnect();
    const pending = r.invoke(TARGETS_IPC.act, r.home, { kind: "connect", hostId: "build-01" });
    await flush();
    expect(r.t.summaries().find(s => s.id === "ssh:build-01")!.state).toBe("connecting");
    expect(r.t.menuItems()[0].submenu!.map(i => i.label)).toEqual(["This computer", "build-01 (connecting…)"]);
    for (const p of r.progress) p("build-01", { step: "downloading", done: 12_000_000, total: 29_000_000 });
    expect(r.showState).toHaveBeenLastCalledWith({ bubble: expect.objectContaining({ title: "Connecting to build-01…", thought: "Downloading what Ember needs for build-01 (12 of 29 MB)…" }) });
    expect(r.t.busy().connections).toBe(1);
    expect(r.t.bubbleAction("conn:build-01:cancel")).toBe(true);
    release();
    await expect(pending).resolves.toEqual({ ok: false, message: "Cancelled." });
    expect(r.t.agent.handsFor("ssh:build-01").ok).toBe(false);
  });

  it("disconnects and forgets a host, working here again", async () => {
    const r = rig({ settings: { ...withHosts([hostRecord("build-01")]), ...commandsOn("ssh:build-01") } });
    await connected(r);
    expect(r.t.menuItems().at(-1)).toMatchObject({ label: "Disconnect build-01" });
    await r.invoke(TARGETS_IPC.act, r.home, { kind: "forget", hostId: "build-01" });
    expect(r.conns.disconnect).toHaveBeenCalledWith("build-01");
    expect(r.t.agent.active).toBe("local");
    expect(r.settings.get().targets.hosts).toEqual([]);
    expect(r.settings.get().commands["ssh:build-01"]).toBeUndefined();
  });

  it("adds a host the user typed: its record from ssh -G, its card, then the link", async () => {
    const r = rig();
    await expect(r.invoke(TARGETS_IPC.act, r.home, { kind: "add", dest: "ssh://deploy@Build-01.example.com:2222" })).resolves.toEqual({ ok: true });
    expect(r.conns.resolve).toHaveBeenCalledWith("deploy@Build-01.example.com", { port: 2222 });
    expect(r.settings.get().targets.hosts[0]).toMatchObject({ id: "build-01.example.com", dest: "deploy@Build-01.example.com", port: 2222, consent: { version: 1 } });
    expect(r.t.agent.active).toBe("ssh:build-01.example.com");
    await expect(r.invoke(TARGETS_IPC.act, r.home, { kind: "add", dest: "a b" })).resolves.toEqual({ ok: false, message: "Ember didn't understand that request." });
    await expect(r.invoke(TARGETS_IPC.act, r.home, { kind: "add", dest: "deploy@build-01.example.com:99999" })).resolves.toEqual({ ok: false, message: "That isn't an SSH host Ember can use. Type an alias from your SSH config, or user@host." });
  });

  it("resets a remote picked last time to this computer at start (it isn't connected yet)", () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")], { active: "ssh:build-01" }) });
    expect(r.t.agent.active).toBe("local");
    expect(r.settings.get().targets.active).toBe("local");
  });

  it("reads a remote's quick context when it is the picker's choice, never this screen's", async () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")]) });
    await connected(r);
    await expect(r.t.quickContext()).resolves.toEqual({ target: { pid: 7, title: "notes" }, text: "gedit: notes", targetId: "ssh:build-01" });
    r.links.get("build-01")!.move("closed");
    expect(r.t.quickContext()).toBeNull();
  });
});

describe("WSL targets", () => {
  it("bind a distro by name, with this screen's hands, unchanged lease keys and the distro's commands", async () => {
    const r = rig({ os: "win32", wslFacts: wslFacts([ubuntu()]), settings: { ...wslOnSettings, ...commandsOn("wsl:Ubuntu") } });
    await flush();
    const b = r.t.agent.bind({ userWords: "open gedit in Ubuntu" });
    expect(b.ok && b.binding).toMatchObject({ id: "wsl:Ubuntu", screenOs: "win32", shellOs: "linux", desktop: "screen" });
    const got = r.t.agent.handsFor("wsl:Ubuntu");
    if (!got.ok) throw new Error(got.why);
    expect(got.hands.perception).toBe(r.hands!.perception);
    expect(got.hands.leaseKey("0x10:gedit")).toBe("0x10:gedit");
    expect(got.hands.commands!.runner).toBe(r.wslRunners.get("Ubuntu"));
    expect(r.t.agent.describeScreen("wsl:Ubuntu")).toBeNull();
    expect(r.t.agent.caps()).toEqual({ commands: true, targets: true });
  });

  it("binds 'in WSL' where Ember is set to work while WSL is off in Ember, and offers to turn it on (once a run)", async () => {
    const r = rig({ os: "win32", wslFacts: wslFacts([ubuntu()]) });
    await flush();
    const b = r.t.agent.bind({ userWords: "open gedit in WSL" });
    expect(b.ok && b.binding.id).toBe("local");
    // Offered once discovery has shown a distro to work in.
    await flush();
    expect(r.wsl.facts).toHaveBeenCalled();
    expect(r.showState).toHaveBeenLastCalledWith({ bubble: expect.objectContaining({ title: "Ember can work in WSL", actions: [{ id: "offer:wsl:settings", label: "Open settings", primary: true }, { id: "offer:wsl:later", label: "Not now" }] }) });
    r.showState.mockClear();
    const again = r.t.agent.bind({ userWords: "open gedit in WSL" });
    expect(again.ok && again.binding.id).toBe("local");
    await flush();
    expect(r.showState).not.toHaveBeenCalledWith({ bubble: expect.objectContaining({ title: "Ember can work in WSL" }) });
    expect(r.t.bubbleAction("offer:wsl:settings")).toBe(true);
    expect(r.openSettings).toHaveBeenCalledWith("computers");
  });

  it("takes 'on Linux', 'in WSL' and a distro's name as words of the request while WSL is off, not installed or not allowed", async () => {
    const asks = ["Open Edge and search for how to install Python on Linux", "Show me how to open a PDF in WSL", "in Ubuntu, how do I list my files?", "what's on the Linux side of my disk?"];
    const setups: RigOptions[] = [
      { os: "win32", wslFacts: wslFacts([ubuntu()]) }, // installed, never turned on in Ember (the default)
      { os: "win32", wslFacts: { ...wslFacts([]), installed: false } }, // not installed
      { os: "win32", wslFacts: wslFacts([ubuntu()]), settings: wslOnSettings, admin: policy({ features: { wsl: false } }) }, // not allowed
    ];
    for (const o of setups) {
      const r = rig(o);
      await flush();
      // "Linux" alone never brings up the WSL offer.
      r.t.agent.bind({ userWords: "search for how to install Python on Linux" });
      await flush();
      expect(r.showState).not.toHaveBeenCalledWith({ bubble: expect.objectContaining({ title: "Ember can work in WSL" }) });
      for (const words of asks) {
        const b = r.t.agent.bind({ userWords: words });
        expect(b.ok && b.binding.id, `${JSON.stringify(o.wslFacts?.installed)} ${words}`).toBe("local");
      }
    }
  });

  it("keeps D4.4's wrong-target guard for 'in WSL' while WSL is off, not installed or not allowed (the task binds here)", async () => {
    const setups: RigOptions[] = [
      { os: "win32", wslFacts: wslFacts([ubuntu()]), settings: commandsOn("local") }, // installed, off in Ember
      { os: "win32", wslFacts: { ...wslFacts([]), installed: false }, settings: commandsOn("local") }, // not installed
      { os: "win32", wslFacts: wslFacts([ubuntu()]), settings: { ...wslOnSettings, ...commandsOn("local") }, admin: policy({ features: { wsl: false }, commands: { local: "on" } }) }, // not allowed
    ];
    for (const o of setups) {
      const r = rig(o);
      await flush();
      expect(r.t.agent.bind({ userWords: "in WSL, delete build/" })).toMatchObject({ ok: true, binding: { id: "local" } });
      const got = r.t.agent.handsFor("local");
      if (!got.ok) throw new Error(got.why);
      const guard = got.hands.commands as unknown as { othersNamed(words: string): string[] };
      expect(guard.othersNamed("in WSL, delete build/").length, JSON.stringify(o.admin?.policy.features ?? o.wslFacts?.installed)).toBeGreaterThan(0);
      expect(guard.othersNamed("on the Linux side, delete build/").length).toBeGreaterThan(0);
      expect(guard.othersNamed("delete build/")).toEqual([]);
    }
  });

  it("never offers WSL once the administrator has turned it off (Ember made its WSL view before that)", async () => {
    const admin: LoadedAdminPolicy = { ...noPolicy };
    const r = rig({ os: "win32", wslFacts: wslFacts([ubuntu()]), admin });
    expect(r.t.wsl).not.toBeNull();
    Object.assign(admin, policy({ features: { wsl: false } }));
    const b = r.t.agent.bind({ userWords: "open gedit in WSL" });
    expect(b.ok && b.binding.id).toBe("local");
    await flush(); await flush();
    expect(r.showState).not.toHaveBeenCalledWith({ bubble: expect.objectContaining({ title: "Ember can work in WSL" }) });
  });

  it("never offers WSL on a PC where discovery finds no distro to work in (WSL's installer alone)", async () => {
    const r = rig({ os: "win32", wslFacts: { ...wslFacts([]), installed: false } });
    const b = r.t.agent.bind({ userWords: "list my files in WSL" });
    expect(b.ok && b.binding.id).toBe("local");
    await flush();
    expect(r.showState).not.toHaveBeenCalledWith({ bubble: expect.objectContaining({ title: "Ember can work in WSL" }) });
  });

  it("with WSL on, still says why it can't work in WSL when discovery found no distro to work in", async () => {
    const r = rig({ os: "win32", wslFacts: { ...wslFacts([]), installed: true }, settings: wslOnSettings });
    await flush();
    expect(r.t.agent.bind({ userWords: "list my files in WSL" })).toEqual({ ok: false, why: "WSL has no Linux distro Ember can use on this computer." });
  });

  it("says in the active line which distro 'WSL' means when the default one is hidden (§2.3 rule 5)", async () => {
    // Docker's distro was the default: WA leaves it out, so none listed is the default.
    const r = rig({ os: "win32", wslFacts: wslFacts([ubuntu({ isDefault: false }), ubuntu({ name: "Debian", isDefault: false })]), settings: { ...wslOnSettings, ...commandsOn("wsl:Ubuntu") } });
    await flush();
    expect(r.t.agent.activeLine()).toBe("(Ember is set to work on this computer: apps. \"WSL\" means Ubuntu (WSL). Commands: off for this computer; on in Ubuntu (WSL); off in Debian (WSL).)");
    const b = r.t.agent.bind({ userWords: "list my files in WSL" });
    expect(b.ok && b.binding.id).toBe("wsl:Ubuntu");
    const plain = rig({ os: "win32", wslFacts: wslFacts([ubuntu()]), settings: { ...wslOnSettings, ...commandsOn("wsl:Ubuntu") } });
    await flush();
    expect(plain.t.agent.activeLine()).not.toContain("\"WSL\" means");
  });

  it("never offers a distro still to be set up, and says how to set it up", async () => {
    const r = rig({ os: "win32", wslFacts: wslFacts([ubuntu({ needsSetup: true })]), settings: wslOnSettings });
    await flush();
    expect(r.t.agent.bind({ userWords: "in Ubuntu, list my files" })).toEqual({ ok: false, why: "Set up Ubuntu first: open it from the Start menu once." });
    expect(r.t.agent.handsFor("wsl:Ubuntu")).toEqual({ ok: false, why: "Set up Ubuntu first: open it from the Start menu once." });
  });

  it("asks before every command in Podman's distro and in a distro whose user is root", async () => {
    const r = rig({ os: "win32", wslFacts: wslFacts([ubuntu({ defaultUid: 0 }), ubuntu({ name: "podman-machine-default", isDefault: false, tool: "podman" })]), settings: { ...wslOnSettings, commands: { "wsl:Ubuntu": { on: true, askEvery: false, consent: { version: 1, at: SINCE } }, "wsl:podman-machine-default": { on: true, askEvery: false, consent: { version: 1, at: SINCE } } } } });
    await flush();
    const root = r.t.agent.handsFor("wsl:Ubuntu");
    const pod = r.t.agent.handsFor("wsl:podman-machine-default");
    if (!root.ok || !pod.ok) throw new Error("refused");
    expect(root.hands.commands!.capability().askEvery).toBe("root");
    expect(pod.hands.commands!.capability().askEvery).toBe("tool");
    expect(pod.hands.commands!.userAskEvery()).toBe(true);
    expect(pod.hands.binding.desktop).toBe("none");
  });
});

describe("the kill switch's part and quitting", () => {
  it("tells every runner and every link to stop at once, before waiting for any", async () => {
    const r = rig({ os: "win32", wslFacts: wslFacts([ubuntu()]), settings: { targets: { ...wslOnSettings.targets, hosts: [hostRecord("build-01")] }, ...commandsOn("wsl:Ubuntu") } });
    await flush();
    r.t.agent.handsFor("wsl:Ubuntu");
    const l = await connected(r);
    const never = () => new Promise<void>(() => undefined);
    let release!: () => void;
    r.local.stopAll.mockImplementation(() => new Promise<void>(res => { release = res; }));
    r.wslRunners.get("Ubuntu")!.stopAll.mockImplementation(never);
    l.link.stop.mockImplementation(() => new Promise(() => undefined));
    const remote = r.remoteRunners.get("build-01")!;
    remote.stopAll.mockImplementation(() => { throw new Error("boom"); });
    let done = false;
    void r.t.stopAll().then(() => { done = true; });
    expect(r.local.stopAll).toHaveBeenCalledWith("killswitch");
    expect(r.wslRunners.get("Ubuntu")!.stopAll).toHaveBeenCalledWith("killswitch");
    expect(l.link.stop).toHaveBeenCalledTimes(1);
    expect(remote.stopAll).toHaveBeenCalledWith("killswitch");
    // SA's own part too: its reconnects end and a link not yet a target here is stopped.
    expect(r.conns.stopAll).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(done).toBe(false);
  });

  it("never throws, whatever a part does", async () => {
    const r = rig();
    r.local.stopAll.mockImplementation(() => Promise.reject(new Error("x")));
    await expect(r.t.stopAll()).resolves.toBeUndefined();
  });

  it("counts running commands on every target and live connections for the quit question", async () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")]) });
    await connected(r);
    (r.local as { running: number }).running = 2;
    (r.remoteRunners.get("build-01") as { running: number }).running = 1;
    expect(r.t.busy()).toEqual({ commands: 3, connections: 1 });
  });

  it("lets everything go when Ember quits", async () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")]) });
    await connected(r);
    await r.t.dispose();
    expect(r.local.stopAll).toHaveBeenCalledWith("quit");
    expect(r.conns.dispose).toHaveBeenCalled();
    expect(r.cw.dispose).toHaveBeenCalled();
    expect(r.pw.dispose).toHaveBeenCalled();
  });
});

describe("the handle menu (§8.1)", () => {
  it("shows the picker, Bring Ember… and Disconnect only when they mean something", async () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")]) });
    const items = r.t.menuItems();
    expect(items.map(i => i.label ?? i.type)).toEqual(["Work on", "separator", "Bring Ember to a computer…"]);
    expect(items[0].submenu!.map(i => [i.label, i.type, i.checked, i.enabled])).toEqual([["This computer", "radio", true, true], ["build-01", "radio", false, true]]);
    items[2].click!();
    expect(r.openSettings).toHaveBeenCalledWith("computers");
    items[0].submenu![1].click!();
    await flush();
    await flush();
    expect(r.conns.connect).toHaveBeenCalled();
    expect(r.t.agent.active).toBe("ssh:build-01");
    expect(r.t.menuItems().at(-1)!.label).toBe("Disconnect build-01");
    r.links.get("build-01")!.move("lost");
    expect(r.t.menuItems()[0].submenu![1]).toMatchObject({ label: "build-01 (lost)", enabled: false });
    expect(rig({ admin: policy({ features: { ssh: false } }), settings: withHosts([hostRecord("build-01")]) }).t.menuItems()).toEqual([]);
  });
});

describe("question panels (§3.9)", () => {
  const card: CommandCard = {
    runId: "0123456789abcdef", target: "ssh:build-01", targetLabel: "build-01", shell: "bash", cwd: "/home/deploy", command: "rm -r build",
    sha256: "d".repeat(64), taskId: "t1", taskTitle: "Clean up", mode: "ask", says: ["Deletes build and everything in it."], unasked: false, armMs: 1500,
  };
  const commandQ: Question = { title: "May I run a command?", prompt: "On build-01: Deletes build", options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }], panel: { kind: "command", card } };
  const consent = commandsConsent({ os: "linux", target: "local", targetLabel: "This computer", facts: { kind: "local", privileged: false, windows: false, podman: false } });
  const consentQ: Question = { title: "Turn on commands on this computer?", prompt: "x", options: [{ id: "once", label: "Turn on", primary: true }, { id: "deny", label: "Not now" }], panel: { kind: "consent", consent }, clickOnly: true };

  it("shows a command question's card and hides it when the question goes; the chord's guard is the card's", () => {
    const r = rig();
    r.t.questionChanged({ n: 3, question: commandQ });
    expect(r.cw.showCard).toHaveBeenCalledWith(3, card);
    expect(r.t.panelReady(3)).toBe(true);
    expect(r.t.panelReady(4)).toBe(false);
    r.cw.cardReady.mockReturnValue(false);
    expect(r.t.panelReady(3)).toBe(false);
    r.t.questionChanged(null);
    expect(r.cw.hideCard).toHaveBeenCalledWith(3);
    expect(r.t.panelReady(3)).toBe(false);
  });

  it("shows a consent question's card in the prompt window", () => {
    const r = rig();
    r.t.questionChanged({ n: 5, question: consentQ });
    expect(r.pw.showConsent).toHaveBeenCalledWith(5, consent);
    r.pw.consentReady.mockReturnValue(true);
    expect(r.t.panelReady(5)).toBe(true);
    r.t.questionChanged({ n: 6, question: commandQ });
    expect(r.pw.hideConsent).toHaveBeenCalledWith(5);
  });

  it("speaks only that Ember wants to run a command (never the command), and gives words for consent cards", () => {
    const r = rig();
    expect(r.t.questionWords(commandQ)).toBe("Ember wants to run a command on build-01.");
    expect(r.t.questionWords({ ...commandQ, panel: { kind: "command", card: { ...card, target: "local", targetLabel: "This computer" } } })).toBe("Ember wants to run a command on this computer.");
    expect(r.t.questionWords(consentQ)).toBe("Ember needs your OK to run commands on this computer. Read what it means in the window that opened.");
    expect(r.t.questionWords({ ...consentQ, panel: { kind: "consent", consent: wslConsent({ target: "wsl:Ubuntu", targetLabel: "Ubuntu (WSL)" }) } })).toBe("Use Ember with WSL? Read what it means in the window that opened.");
  });

  it("passes the card's own answers to the Confirmer as panel answers with their hash", () => {
    const r = rig();
    r.t.questionChanged({ n: 3, question: commandQ });
    r.onAnswer()!({ n: 3, answer: "once", sha256: card.sha256 });
    r.t.questionChanged({ n: 5, question: consentQ });
    r.onConsent()!({ n: 5, answer: "once", sha256: consent.sha256 });
    r.onConsent()!({ n: 5, answer: "deny", sha256: consent.sha256 });
    expect(r.answers).toEqual([
      { id: "q3:once", via: "panel", proof: { sha256: card.sha256 } },
      { id: "q5:once", via: "panel", proof: { sha256: consent.sha256 } },
      { id: "q5:deny", via: "panel", proof: { sha256: consent.sha256 } },
    ]);
  });

  it("lets each window allow only its own kind of question, and only the one up now (R7)", () => {
    const r = rig();
    // No question up: nothing to allow.
    r.onAnswer()!({ n: 3, answer: "once", sha256: card.sha256 });
    // The prompt window can't allow a command, and the command window can't allow a consent card.
    r.t.questionChanged({ n: 3, question: commandQ });
    r.onConsent()!({ n: 3, answer: "once", sha256: card.sha256 });
    r.onAnswer()!({ n: 2, answer: "once", sha256: card.sha256 });
    r.t.questionChanged({ n: 5, question: consentQ });
    r.onAnswer()!({ n: 5, answer: "once", sha256: consent.sha256 });
    expect(r.answers).toEqual([]);
    // "Not now" is taken from either.
    r.onAnswer()!({ n: 5, answer: "deny", sha256: consent.sha256 });
    expect(r.answers).toEqual([{ id: "q5:deny", via: "panel", proof: { sha256: consent.sha256 } }]);
  });

  it("without UI's answer hook, hears COMMANDS_IPC.answer only from the command window's own page", async () => {
    const r = rig({ commandWindowExtras: false });
    r.t.questionChanged({ n: 3, question: commandQ });
    await r.invoke("commands:answer", { id: 9, send: vi.fn() }, { n: 3, answer: "once", sha256: card.sha256 });
    expect(r.answers).toEqual([]);
    await r.invoke("commands:answer", { id: 2, send: vi.fn() }, { n: 3, answer: "once", sha256: "nope" });
    expect(r.answers).toEqual([]);
    await r.invoke("commands:answer", { id: 2, send: vi.fn() }, { n: 3, answer: "once", sha256: card.sha256 });
    expect(r.answers).toEqual([{ id: "q3:once", via: "panel", proof: { sha256: card.sha256 } }]);
  });

  it("never throws when a window misbehaves", () => {
    const r = rig();
    r.cw.showCard.mockImplementation(() => { throw new Error("gone"); });
    r.cw.cardReady.mockImplementation(() => { throw new Error("gone"); });
    expect(() => r.t.questionChanged({ n: 3, question: commandQ })).not.toThrow();
    expect(r.t.panelReady(3)).toBe(false);
    expect(() => r.t.questionChanged({ n: 3 } as unknown as { n: number; question: Question })).not.toThrow();
    expect(r.t.questionWords(undefined as unknown as Question)).toBeNull();
  });
});

describe("the bubble's actions", () => {
  it("stops an announced command by its run id, and owns every id of its prefixes (never passed on as an answer)", () => {
    const r = rig();
    expect(r.t.bubbleAction("ui:cmdstop:0123456789abcdef")).toBe(true);
    expect(r.cw.cancelAnnounce).toHaveBeenCalledWith("0123456789abcdef");
    expect(r.t.bubbleAction("ui:cmdstop:not-a-run")).toBe(true);
    expect(r.cw.cancelAnnounce).toHaveBeenCalledTimes(1);
    for (const id of ["ui:panel:9", "offer:77:bring", "conn:nobody:cancel", "target:ssh:none"]) expect(r.t.bubbleAction(id)).toBe(true);
    for (const id of ["q1:once", "task:t1:stop", "ui:settings"]) expect(r.t.bubbleAction(id)).toBe(false);
    r.cw.cancelAnnounce.mockImplementation(() => { throw new Error("x"); });
    expect(r.t.bubbleAction("ui:cmdstop:0123456789abcdef")).toBe(true);
  });

  it("raises the panel of the question up now", () => {
    const r = rig();
    const card = { runId: "0123456789abcdef", target: "local", targetLabel: "This computer", shell: "bash", cwd: "/", command: "ls", sha256: "e".repeat(64), taskId: "t", taskTitle: "t", mode: "ask", says: [], unasked: false, armMs: 500 } as CommandCard;
    r.t.questionChanged({ n: 2, question: { title: "t", prompt: "p", options: [], panel: { kind: "command", card } } });
    r.t.bubbleAction("ui:panel:2");
    expect(r.cw.show).toHaveBeenCalledTimes(1);
    r.t.bubbleAction("ui:panel:1");
    expect(r.cw.show).toHaveBeenCalledTimes(1);
  });
});

describe("noticing the user's own ssh and offering to come along (§2.7)", () => {
  const notice = {
    sshDestination: (argv: readonly string[]) => ({ dest: argv[argv.length - 1] }),
    userSshProcesses: vi.fn(async () => [{ pid: 9, argv: ["ssh", "deploy@build-01"], via: "local" as const }]),
  };

  it("looks only with a way to see the user's window, offers Bring Ember, and connects after the card", async () => {
    expect(rig({ notice }).ticks).toEqual([]);
    const r = rig({ notice, cursor: true });
    expect(r.ticks).toHaveLength(1);
    r.ticks[0]();
    await flush();
    expect(r.showState).toHaveBeenLastCalledWith({ bubble: expect.objectContaining({
      title: "You're connected to build-01", thought: "Bring Ember there too? It will open its own connection with your SSH settings.",
      actions: [{ id: "offer:1:bring", label: "Bring Ember", primary: true }, { id: "offer:1:later", label: "Not now" }, { id: "offer:1:never", label: "Don't offer again" }],
    }) });
    expect(r.t.bubbleAction("offer:1:bring")).toBe(true);
    await flush(); await flush(); await flush();
    expect(r.cards.map(c => c.title)).toEqual(["Bring Ember to build-01?"]);
    expect(r.conns.connect).toHaveBeenCalled();
    expect(r.t.agent.active).toBe("ssh:build-01");
  });

  it("looks with main's window system alone: no mouse borrowing needed (an organisation's features.cursor: false)", async () => {
    const r = rig({ notice, activeWindow: true });
    expect(r.hands?.cursor).toBeUndefined();
    expect(r.ticks).toHaveLength(1);
    r.ticks[0]();
    await flush();
    expect(r.activeWindow).toHaveBeenCalled();
    expect(r.showState).toHaveBeenLastCalledWith({ bubble: expect.objectContaining({ title: "You're connected to build-01" }) });
    // Without a window system there is nothing to look at.
    expect(rig({ notice, hands: null }).ticks).toEqual([]);
  });

  it("reads the user's ssh in WSL only in distros running now (never booting one), through WA's runner", async () => {
    const seen = { sshDestination: notice.sshDestination, userSshProcesses: vi.fn(async (_os: OS, _o?: unknown) => [] as { pid: number; argv: string[]; via: "local" }[]) };
    const make = (live: string[]) => {
      // Ubuntu ran when Ember last looked (its cached flag says running); WSL reports what runs now.
      const r = rig({ os: "win32", notice: seen, cursor: true, wslFacts: wslFacts([ubuntu(), ubuntu({ name: "Debian", isDefault: false })]), settings: wslOnSettings });
      r.wsl.runningNow = async () => new Set(live);
      const runScript = vi.fn(async (_script: string, _o?: unknown) => ({ code: 0, stdout: Buffer.from("812\tssh\u0001deploy@build-02\u0001\n"), stderr: "" }));
      for (const d of ["Ubuntu", "Debian"]) Object.assign(r.wsl.runner(d), { runScript });
      return { r, runScript };
    };
    const stopped = make([]);
    await flush();
    stopped.r.ticks[0]();
    await flush(); await flush();
    expect(seen.userSshProcesses).toHaveBeenCalledWith("win32");
    expect(stopped.runScript).not.toHaveBeenCalled();
    expect(stopped.r.showState).not.toHaveBeenCalledWith({ bubble: expect.objectContaining({ title: expect.stringContaining("You're connected") }) });
    const running = make(["Debian"]);
    await flush();
    running.r.ticks[0]();
    await flush(); await flush(); await flush();
    // Only Debian, which runs now; never with mayBoot.
    expect(running.runScript).toHaveBeenCalledTimes(1);
    expect(running.runScript).toHaveBeenCalledWith(WSL_READER, { timeoutMs: 5000 });
    expect(running.r.showState).toHaveBeenLastCalledWith({ bubble: expect.objectContaining({ title: "You're connected to build-02 from Debian" }) });
  });

  it("remembers Don't offer again, and stops looking when the user turns offers off", async () => {
    const r = rig({ notice, cursor: true });
    r.ticks[0]();
    await flush();
    r.t.bubbleAction("offer:1:never");
    expect(r.settings.get().targets.dismissedOffers).toEqual(["deploy@build-01"]);
    await r.invoke(TARGETS_IPC.act, r.home, { kind: "offerSsh", on: false });
    expect(r.settings.get().targets.offerSsh).toBe(false);
  });
});

describe("offer_connect (§2.6)", () => {
  it("shows a Connect button only for a computer the user's words named that Ember knows", async () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")]) });
    expect(r.t.agent.offerConnect("build-01", "open the logs")).toBe("The user didn't name that computer, so Ember won't offer to connect to it.");
    expect(r.t.agent.offerConnect("build-03", "open the logs on build-03")).toMatch(/doesn't know a computer called build-03/);
    expect(r.t.agent.offerConnect("build-01", "open the logs on build-01")).toMatch(/showed the user a Connect button for build-01/);
    expect(r.showState).toHaveBeenLastCalledWith({ bubble: expect.objectContaining({ title: "Connect to build-01?", thought: "You asked for build-01. Ember isn't connected to it yet." }) });
    expect(r.conns.connect).not.toHaveBeenCalled();
    r.t.bubbleAction("offer:1:connect");
    await flush(); await flush();
    expect(r.conns.connect).toHaveBeenCalled();
    expect(r.t.agent.offerConnect("build-02", "connect to build-02 please")).toMatch(/Connect button for build-02/);
    expect(rig({ admin: policy({ features: { ssh: false } }) }).t.agent.offerConnect("build-01", "on build-01")).toMatch(/doesn't allow Ember on other computers/);
  });
});

describe("the doctor's rows (§8.8)", () => {
  it("adds the SSH client, the commands terminal and the remote parts while they are allowed, plus WSL's and a Mac's folders", async () => {
    const r = rig();
    expect((await r.t.doctorRows()).map(x => [x.id, x.status, x.detail])).toEqual([
      ["ssh-client", "ok", "OpenSSH 8.0 at /usr/bin/ssh"],
      ["command-terminal", "ok", "script gives commands a terminal"],
      ["remote-parts", "ok", "Ready for Linux (x64, arm64) and macOS"],
    ]);
    const off = rig({ admin: policy({ features: { ssh: false }, commands: { local: "off" } }) });
    expect(await off.t.doctorRows()).toEqual([]);
    const win = rig({ os: "win32", wslFacts: wslFacts([ubuntu()]) });
    expect((await win.t.doctorRows()).map(x => x.id)).toEqual(["ssh-client", "powershell", "remote-parts", "wsl", "wsl-helper"]);
    const mac = rig({ settings: withHosts([hostRecord("mini")]), welcome: welcome({ os: "darwin", tccLimited: true }) });
    await connected(mac, "mini");
    expect((await mac.t.doctorRows()).map(x => x.id)).toContain("remote-tcc:mini");
  });

  it("turns each probe's answer into §8.8's row", () => {
    expect(parseSshVersion("OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2")).toEqual({ major: 9, minor: 5, windows: true });
    expect(sshClientRow("win32", { path: "C:\\Windows\\System32\\OpenSSH\\ssh.exe", text: "OpenSSH_for_Windows_9.5p1" })).toMatchObject({ status: "ok", detail: "OpenSSH 9.5 (passwords through Ember's prompt)" });
    expect(sshClientRow("win32", { path: "x", text: "OpenSSH_for_Windows_8.1p1" })).toMatchObject({ status: "warn", detail: "Passwords can't be asked here: keys and the ssh-agent only" });
    expect(sshClientRow("win32", { path: "x", text: "OpenSSH_for_Windows_7.7p1" })).toMatchObject({ status: "warn", detail: "OpenSSH is too old for Ember" });
    expect(sshClientRow("linux", { path: "/usr/bin/ssh", text: "OpenSSH_7.4p1" })).toMatchObject({ status: "warn" });
    // SSH is optional: without a client the check-up warns, it never fails (a PC that never uses SSH still passes).
    expect(sshClientRow("linux", null)).toMatchObject({ status: "warn", detail: "No SSH client found", fix: expect.stringContaining("sudo dnf install openssh-clients") });
    expect(sshClientRow("linux", { path: "/usr/bin/ssh", text: "dropbear v2022" })).toMatchObject({ status: "warn" });
    expect(commandTerminalRow(null)).toMatchObject({ status: "warn", fix: "Install util-linux (`sudo dnf install util-linux`)." });
    expect(powershellRow({ path: "p", language: "ConstrainedLanguage" })).toMatchObject({ status: "warn" });
    expect(powershellRow(null)).toMatchObject({ status: "fail", detail: "Windows PowerShell isn't available" });
    expect(remotePartsRow(null)).toEqual({ id: "remote-parts", label: "Helper for other computers", status: "warn", detail: "Missing from this install", fix: "Reinstall Ember." });
  });
});

describe("Ember's own processes (D4.5; S0b's hand-off)", () => {
  it("are the main process's descendants, except a command's run and everything under it", () => {
    const rows = [
      { pid: 100, ppid: 1, run: false }, { pid: 101, ppid: 100, run: false }, { pid: 102, ppid: 101, run: false },
      { pid: 103, ppid: 100, run: true }, { pid: 104, ppid: 103, run: false }, { pid: 200, ppid: 1, run: false },
    ];
    expect(ownTree(rows, 100).sort()).toEqual([101, 102]);
  });

  it("are read from Linux's stat and environ, and from macOS's ps", () => {
    expect(statParent("4242 (copilot (runtime) x) S 4000 4242 4242 0")).toBe(4000);
    expect(statParent("garbage")).toBeNull();
    const env = (s: string) => new TextEncoder().encode(s);
    const table = linuxProcTable({
      pids: () => [4000, 4001, 4002, 4003],
      stat: pid => (pid === 4003 ? null : `${pid} (x) S ${pid === 4000 ? 1 : 4000} 0`),
      environ: pid => (pid === 4002 ? env("A=1\0EMBER_RUN_ID=0123456789abcdef\0") : pid === 4001 ? env("A=1\0") : null),
    });
    expect(table).toEqual([{ pid: 4000, ppid: 1, run: false }, { pid: 4001, ppid: 4000, run: false }, { pid: 4002, ppid: 4000, run: true }]);
    // Production reads the environment of Ember's own descendants only, never the user's other programs'.
    const read: number[] = [];
    const reader = {
      pids: () => [1, 4000, 4001, 4002, 4005, 4006, 900],
      stat: (pid: number) => `${pid} (x) S ${({ 1: 0, 4000: 1, 4001: 4000, 4002: 4000, 4005: 4002, 4006: 4001, 900: 1 } as Record<number, number>)[pid]} 0`,
      environ: (pid: number) => { read.push(pid); return pid === 4002 ? env("EMBER_RUN_ID=0123456789abcdef\0") : env("A=1\0"); },
    };
    expect(linuxOwnPids(reader, 4000).sort()).toEqual([4001, 4006]);
    expect(read.sort()).toEqual([4001, 4002, 4006]);
    expect(psProcTable("  500     1 /Applications/Ember.app/Contents/MacOS/Ember\n  501   500 /usr/bin/script\n  502   500 copilot-runtime\n", 500))
      .toEqual([{ pid: 500, ppid: 1, run: false }, { pid: 501, ppid: 500, run: true }, { pid: 502, ppid: 500, run: false }]);
  });
});

describe("small helpers", () => {
  it("splits what the user typed into a destination and a port", () => {
    expect(splitDest("deploy@build-01:2222")).toEqual({ dest: "deploy@build-01", port: 2222 });
    expect(splitDest("ssh://deploy@build-01:22/")).toEqual({ dest: "deploy@build-01", port: 22 });
    // SA's reading (parseTypedDestination): the brackets only set the port apart.
    expect(splitDest("[fe80::1]:22")).toEqual({ dest: "fe80::1", port: 22 });
    expect(splitDest("build-01:")).toBeNull();
    expect(splitDest("fe80::1")).toEqual({ dest: "fe80::1" });
    expect(splitDest("build-01")).toEqual({ dest: "build-01" });
    expect(splitDest("-oProxyCommand=x")).toBeNull();
    expect(splitDest("host:70000")).toBeNull();
    expect(splitDest("a b")).toBeNull();
  });

  it("makes host ids from aliases, unique", () => {
    expect(hostIdFor("Build-01.Example.com", new Set())).toBe("build-01.example.com");
    expect(hostIdFor("build 01", new Set(["build-01"]))).toBe("build-01-2");
    expect(hostIdFor("__", new Set())).toBe("host");
  });

  it("names Ember's paths per OS and its process names", () => {
    expect(emberPathsOf({ os: "darwin", userData: "/Users/ana/Library/Application Support/ember", resourcesPath: "/Applications/Ember.app/Contents/Resources", packaged: true, env: {} }))
      .toEqual(["/Users/ana/Library/Application Support/ember", "/Applications/Ember.app", "/Library/Application Support/Ember"]);
    expect(emberPathsOf({ os: "win32", userData: "C:\\Users\\ana\\AppData\\Local\\ember", resourcesPath: "C:\\Users\\ana\\AppData\\Local\\Programs\\Ember\\resources", packaged: true, env: { ProgramFiles: "C:\\Program Files" } }))
      .toEqual(["C:\\Users\\ana\\AppData\\Local\\ember", "C:\\Users\\ana\\AppData\\Local\\Programs\\Ember", "C:\\Program Files\\Ember"]);
    expect(emberNamesOf("C:\\Program Files\\Ember\\Ember.exe", "copilot-runtime.exe", "win32").test("ember.exe")).toBe(true);
  });

  it("reads only literal Host aliases from an ssh config", () => {
    expect(configHosts("Host build-02 *.corp !bad -oops\n  HostName x\nhost db-03\nMatch exec foo\n")).toEqual(["build-02", "db-03"]);
  });

  it("says each connecting step in §8.2's words", () => {
    expect(progressWords("build-01", { step: "copying", done: 5_000_000, total: 31_000_000 })).toBe("Copying Ember's helper to build-01 (5 of 31 MB)…");
    expect(progressWords("build-01", { step: "starting" })).toBe("Starting Ember on build-01…");
    expect(progressWords("build-01", { step: "failed", message: "x", retry: false, kind: "dns" })).toBeNull();
  });
});

describe("the remote and WSL seams (INT)", () => {
  it("makes every SSH card one the prompt window will show: its lines within 2000 characters, its hash its own", () => {
    const facts = (extra?: HostRecord["extra"]) => ({ label: "build-01", resolved: { user: "deploy", hostname: "build-01.example.com", port: 22, jump: ["jump@bastion:2200"] }, desktopOff: false, graceSeconds: 20, machineChanged: true, ...(extra ? { extra } : {}) });
    const long = (n: number) => `/home/ana/.ssh/${String(n).padStart(2, "0")}${"k".repeat(1000)}`;
    for (const extra of [undefined, { identityFiles: ["~/.ssh/id_ed25519"] }, { identityFiles: Array.from({ length: 16 }, (_, i) => long(i)), configFile: long(99) }]) {
      for (const os of ["linux", "win32", "darwin"] as const) {
        const card = sshConsent({ os, target: "ssh:build-01", facts: facts(extra) });
        expect(validConsent(card), JSON.stringify(extra)?.slice(0, 40)).toBe(true);
        expect(Math.max(...card.body.map(l => l.length))).toBeLessThanOrEqual(2000);
      }
    }
    // A short carried line is today's words.
    expect(sshConsent({ os: "linux", target: "ssh:build-01", facts: facts({ identityFiles: ["~/.ssh/a", "~/.ssh/b"], configFile: "~/.ssh/c" }) }).body)
      .toContain("It uses the keys ~/.ssh/a and ~/.ssh/b and the settings file ~/.ssh/c, as your own ssh did.");
  });

  it("builds its real parts with SA's noticing and WB's helpers", () => {
    const r = rig();
    const real = productionParts(r.deps);
    expect(real.notice).toEqual({ sshDestination, userSshProcesses });
    expect(real.wslHelpers).toEqual({ stop: stopWslHelpers, pids: wslHelperPids, doctorRows: wslHelperDoctorRows });
  });

  it("stops WSL's helpers with the kill switch, counts their pids as Ember's own and adds their doctor rows", async () => {
    const r = rig({ os: "win32", wslFacts: wslFacts([ubuntu()]) });
    (r.parts.wslHelpers.pids as ReturnType<typeof vi.fn>).mockReturnValue([4242]);
    (r.parts.wslHelpers.doctorRows as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "wsl-a11y:Ubuntu", status: "warn", label: "Accessibility in Ubuntu", detail: "off" }]);
    expect(r.runnerOpts().ember.pids()).toEqual([10, 11, 55, 4242]);
    await r.t.stopAll();
    expect(r.parts.wslHelpers.stop).toHaveBeenCalledTimes(1);
    // The user's WSL switch is off: nothing is looked at inside the distros, and the row says so.
    expect((await r.t.doctorRows()).map(x => x.id)).toEqual(["ssh-client", "powershell", "remote-parts", "wsl", "wsl-helper"]);
    expect((await r.t.doctorRows()).at(-1)).toEqual(WSL_OFF_ROW);
    expect(r.parts.wslHelpers.doctorRows).not.toHaveBeenCalled();
    const on = rig({ os: "win32", wslFacts: wslFacts([ubuntu()]), settings: wslOnSettings });
    (on.parts.wslHelpers.doctorRows as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "wsl-a11y:Ubuntu", status: "warn", label: "Accessibility in Ubuntu", detail: "off" }]);
    expect((await on.t.doctorRows()).map(x => x.id)).toEqual(["ssh-client", "powershell", "remote-parts", "wsl", "wsl-a11y:Ubuntu"]);
    // No WSL here (Linux): no helper rows asked for.
    const linux = rig();
    await linux.t.doctorRows();
    expect(linux.parts.wslHelpers.doctorRows).not.toHaveBeenCalled();
  });

  it("forgets a host once Ember is removed from it (§5.2.7), and keeps it when that fails", async () => {
    const r = rig({ settings: { ...withHosts([hostRecord("build-01"), hostRecord("build-02")]), ...commandsOn("ssh:build-01") } });
    await connected(r);
    r.conns.uninstall.mockRejectedValueOnce(new ConnectError("build-02 couldn't be reached.", "network"));
    await expect(r.invoke(TARGETS_IPC.act, r.home, { kind: "uninstall", hostId: "build-02" })).resolves.toEqual({ ok: false, message: "build-02 couldn't be reached." });
    expect(r.settings.get().targets.hosts.map(h => h.id)).toEqual(["build-01", "build-02"]);
    await expect(r.invoke(TARGETS_IPC.act, r.home, { kind: "uninstall", hostId: "build-01" })).resolves.toEqual({ ok: true });
    expect(r.settings.get().targets.hosts.map(h => h.id)).toEqual(["build-02"]);
    expect(r.settings.get().commands["ssh:build-01"]).toBeUndefined();
    expect(r.t.agent.active).toBe("local");
  });

  it("stops the tasks on a computer whose link drops or closes, where someone pressed Stop, or whose screen locked; only there", async () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")]) });
    const l = await connected(r);
    l.emit("console.stop", { at: SINCE });
    expect(r.stopTasksOn).toHaveBeenLastCalledWith("ssh:build-01");
    expect(r.showState).toHaveBeenCalledWith({ bubble: expect.objectContaining({ title: "Stopped on build-01", thought: "Someone at build-01 pressed Stop." }) });
    // A lock stops only the tasks that used its desktop; the others are main's to judge (the host's cancelTasksOn).
    l.emit("desktop.changed", { access: "none", notice: "off", session: { type: "x11", locked: true, active: true } });
    expect(r.stopTasksOn).toHaveBeenCalledTimes(2);
    expect(r.stopTasksOn).toHaveBeenLastCalledWith("ssh:build-01", "desktop");
    l.move("stalled");
    expect(r.stopTasksOn).toHaveBeenCalledTimes(2);
    l.move("lost");
    expect(r.stopTasksOn).toHaveBeenCalledTimes(3);
    expect(r.stopTasksOn.mock.calls[2]).toEqual(["ssh:build-01"]);
    await connected(r);
    await r.invoke(TARGETS_IPC.act, r.home, { kind: "disconnect", hostId: "build-01" });
    expect(r.stopTasksOn).toHaveBeenCalledTimes(4);
    expect(r.stopTasksOn.mock.calls[3]).toEqual(["ssh:build-01"]);
    expect(r.stopTasksOn.mock.calls.every(c => c[0] === "ssh:build-01")).toBe(true);
  });

  it("stops the tasks using a remote's desktop when its session goes inactive, as for a lock (§5.3.4 step 8)", async () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")]), welcome: welcome({ desktop: { access: "screen", notice: "shown" } }) });
    const l = await connected(r);
    // The agent reports an inactive session with access none and no session of its own.
    l.emit("desktop.changed", { access: "none", notice: "off" });
    expect(r.stopTasksOn).toHaveBeenCalledTimes(1);
    expect(r.stopTasksOn).toHaveBeenLastCalledWith("ssh:build-01", "desktop");
    expect(r.showState).toHaveBeenCalledWith({ bubble: expect.objectContaining({ title: "Stopped on build-01", thought: "build-01's desktop session isn't active any more, so I stopped working on its screen." }) });
    // Nothing more to take away: said once.
    l.emit("desktop.changed", { access: "none", notice: "off" });
    expect(r.stopTasksOn).toHaveBeenCalledTimes(1);
  });

  it("asks for a remote's desktop before each task: its reads and steps wait for the answer, and access comes back after a lock", async () => {
    const r = rig({ settings: withHosts([hostRecord("build-01")]), welcome: welcome({ desktop: { access: "screen", notice: "off" } }) });
    const l = await connected(r);
    const got = r.t.agent.handsFor("ssh:build-01");
    if (!got.ok) throw new Error(got.why);
    expect(r.refreshes).toHaveLength(1);
    const read = got.hands.perception.read({} as never);
    const acted = got.hands.sidecar.doAction(1);
    expect(got.hands.sidecar.scaleOf(1)).toBe(1);
    await flush();
    expect(r.reads).toEqual([]);
    r.refreshes[0].release();
    await Promise.all([read, acted]);
    expect(r.reads).toEqual(["read", "doAction"]);
    // A lock lowers it at once (said once); the next task's own request takes it back once the screen is unlocked.
    l.emit("desktop.changed", { access: "none", notice: "off", session: { type: "x11", locked: true, active: true } });
    l.emit("desktop.changed", { access: "none", notice: "off", session: { type: "x11", locked: true, active: true } });
    expect(r.t.agent.describeTargets()).toContain("no desktop session");
    expect(r.stopTasksOn).toHaveBeenCalledTimes(1);
    // (With commands off there, a task needs the desktop: refused now, while the question goes out.)
    expect(r.t.agent.handsFor("ssh:build-01")).toEqual({ ok: false, why: "build-01 has no desktop Ember can use, and commands are off there." });
    expect(r.refreshes).toHaveLength(2);
    r.refreshes[1].release();
    await flush();
    expect(r.t.agent.describeTargets()).toContain("apps on its screen");
    expect(r.t.agent.handsFor("ssh:build-01").ok).toBe(true);
    l.emit("desktop.changed", { access: "none", notice: "off", session: { type: "x11", locked: true, active: true } });
    expect(r.stopTasksOn).toHaveBeenCalledTimes(2);
  });

  it("turns on accessibility in a running WSL distro (wsl-a11y), never starting one, and only with WSL on", async () => {
    const off = rig({ os: "win32", wslFacts: wslFacts([ubuntu()]) });
    await expect(off.t.applyFix("wsl-a11y:Ubuntu")).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/isn't turned on/) });
    const r = rig({ os: "win32", wslFacts: wslFacts([ubuntu(), ubuntu({ name: "Root", isDefault: false, defaultUid: 0 })]), settings: wslOnSettings });
    await flush();
    await expect(r.t.applyFix("rm -rf /")).resolves.toEqual({ ok: false, message: "Ember doesn't know that fix." });
    await expect(r.t.applyFix("wsl-a11y:Root")).resolves.toEqual({ ok: false, message: "Ember doesn't use Linux apps of a distro that runs as root." });
    await expect(r.t.applyFix("wsl-a11y:Ubuntu")).resolves.toEqual({ ok: false, message: "Start Ubuntu first: Ember doesn't start a distro to change its settings." });
    expect(r.wslRunners.get("Ubuntu")?.start ?? vi.fn()).not.toHaveBeenCalled();
    (r.wsl as { runningNow: () => Promise<Set<string>> }).runningNow = async () => new Set(["Ubuntu"]);
    r.wsl.runner("Ubuntu").start.mockImplementation(() => ({ done: Promise.resolve({ ended: "exit", code: 0, signal: null, ms: 5 }) }));
    await expect(r.t.applyFix("wsl-a11y:Ubuntu")).resolves.toEqual({ ok: true, message: "Restart your Linux apps." });
    const spec = r.wslRunners.get("Ubuntu")!.start.mock.calls[0][0] as { command: string; stamp: { verdict: string } };
    expect(spec.command).toBe(A11Y_FIX_COMMAND);
  });

  it("refuses the wsl-a11y fix where the administrator turned WSL, or commands in WSL, off", async () => {
    const turnedOff = "Your organisation has turned this off.";
    const running = async (r: ReturnType<typeof rig>) => {
      await flush();
      if (r.wsl) (r.wsl as { runningNow: () => Promise<Set<string>> }).runningNow = async () => new Set(["Ubuntu"]);
    };
    for (const admin of [
      policy({ features: { wsl: false }, commands: { wsl: "on" } }), policy({ commands: { wsl: "off" } }),
      // R5: a policy that doesn't mention commands turns them off.
      policy({}),
    ]) {
      const r = rig({ os: "win32", wslFacts: wslFacts([ubuntu()]), settings: wslOnSettings, admin });
      await running(r);
      await expect(r.t.applyFix("wsl-a11y:Ubuntu")).resolves.toEqual({ ok: false, message: turnedOff });
      expect(r.wslRunners.get("Ubuntu")?.start ?? vi.fn()).not.toHaveBeenCalled();
    }
    const allowed = rig({ os: "win32", wslFacts: wslFacts([ubuntu()]), settings: wslOnSettings, admin: policy({ commands: { wsl: "ask" } }) });
    await running(allowed);
    allowed.wsl.runner("Ubuntu").start.mockImplementation(() => ({ done: Promise.resolve({ ended: "exit", code: 0, signal: null, ms: 5 }) }));
    await expect(allowed.t.applyFix("wsl-a11y:Ubuntu")).resolves.toEqual({ ok: true, message: "Restart your Linux apps." });
  });
});

describe("wslSwitchOn (the doctor's reading of the user's WSL switch)", () => {
  const file = (targets: unknown, more: Record<string, unknown> = {}) => JSON.stringify({ ...more, targets });
  const wsl = (on: boolean, version: number) => ({ wsl: { on, consent: { version, at: SINCE } } });

  it("is on only with the switch on and its card accepted at the current version", () => {
    expect(wslSwitchOn(file(wsl(true, 1)))).toBe(true);
    expect(wslSwitchOn(file(wsl(true, 0)))).toBe(false);
    expect(wslSwitchOn(file(wsl(false, 1)))).toBe(false);
  });

  it("reads a file with a slip or a few bad values as Ember would, and counts anything else as off", () => {
    expect(wslSwitchOn(`${file(wsl(true, 1))}`.replace(/}$/, ",}"))).toBe(true);
    expect(wslSwitchOn(file(wsl(true, 1), { size: "huge" }))).toBe(true);
    for (const text of [null, "", "not json", "[]", "null", "{}", file({ wsl: "on" })]) expect(wslSwitchOn(text)).toBe(false);
  });
});
