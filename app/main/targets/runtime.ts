/**
 * The targets runtime (§2; package TG): where Ember can work (this computer, WSL distros, computers reached over SSH)
 * and the commands on each. It keeps the registry, binds tasks from the user's own words, hands workers each target's
 * hands and CommandService, shows the first-use consent cards, notices the user's own ssh and offers to come along,
 * serves the settings window's channels, builds the handle menu's picker, answers the bubble's actions, reads a remote's
 * quick context, stops every command and remote for the kill switch, and adds the doctor's rows.
 *
 * Nothing new happens without a reason (critique integration-25): with nothing set up, or with the administrator
 * turning WSL, SSH and commands off, there is no menu item, no badge, no new window, no prompt change (caps all false)
 * and no process started; only the noticer's cheap look at the window the user is in runs, and only while SSH is allowed
 * and the offer switch is on. Every decision comes from local data: a remote's own reports only ever narrow what Ember
 * does there, and the model can never connect, pick a computer the user didn't name, or approve anything. Plain Node
 * (L13): Electron reaches it only through TargetsDeps.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import pathPosix from "node:path/posix";
import pathWin32 from "node:path/win32";
import { COMMANDS_IPC } from "../../shared/commands";
import type { ConsentPanel } from "../../shared/consent";
import { IDLE_BUBBLE, type BubbleState } from "../../shared/overlay";
import type { OS } from "../../shared/shortcuts";
import { DISTRO_NAME, HOST_ID, LOCAL_TARGET, parseTargetId, targetIdOf, type TargetId, type TargetSummary, type TargetsAct } from "../../shared/targets";
import { commandMode, type LoadedAdminPolicy } from "../admin";
import type { Question } from "../agent/confirm";
import type { WorkerSystem } from "../agent/worker";
import { createLocalRunner } from "../commands/run/local";
import type { CommandCapability, CommandRunner, CommandService, CommandWindowPort } from "../commands/types";
import { createCommandWindowPort } from "../commands/window";
import { isTerminalWindowApp } from "../hands/system";
import type { Logger } from "../logger";
import type { QuickContext } from "../perception";
import type { PlatformDoctorRow, SystemPlatform } from "../platform/types";
import { PolicyEngine } from "../policy/policy";
import { createConnections } from "../remote/connections";
import { parseTypedDestination } from "../remote/destination";
import { createPromptWindow } from "../remote/prompt-window";
import { emberNamesRegExp } from "../remote/protocol";
import { sshDestination, userSshProcesses } from "../remote/notice-ssh";
import { remoteTargetParts, type RemoteTargetExtras } from "../remote/target";
import { ConnectError, type ConnectProgress, type Connections, type HostRecord, type PromptUi, type RemoteLink, type SshSeen } from "../remote/types";
import { wslAwareSystem } from "../wsl/privacy";
import { turnOnLinuxAccessibility } from "../wsl/launch-sidecar";
import { doctorHelperRows, stopWslHelpers, wslHelperDoctorRows, wslHelperPids } from "../wsl/router";
import { createWsl } from "../wsl/service";
import type { WslFacts, WslService } from "../wsl/types";
import { commandsConsent, consentCurrent, consentGiven, consentYes, machineChanged, sshConsent, sshNeedsConsent, wslConsent } from "./consent";
import { doctorRowsWith, realDoctorProbes, remoteTccRow, type DoctorProbes } from "./doctor";
import { hostBinding, localBinding, remoteHands, screenHands, waitingPerception, wslBinding, type HandsBase } from "./hands";
import { registerTargetsIpc, type ActResult } from "./ipc";
import { createLocalService, forgetCommands, linuxOwnPids, ownTree, psProcTable, setCommandsSwitch, type WarmService } from "./local-service";
import { targetMenu } from "./menu";
import { NOTICE_TICK_MS, createNoticer, type Noticer, type SshNotice } from "./offer";
import { noWindowContext, remoteQuickContext } from "./quick-context";
import {
  LOCAL_LABEL, activeOf, bindable, buildRegistry, defaultDistro, distroLabel, hostPart, namedTargets, sshAllowed, summaryOf, wslAllowed,
  type LinkState, type LinkView, type TargetEntry,
} from "./registry";
import { createRemoteTarget, type RemoteTarget } from "./remote-service";
import { NOT_NAMED, WSL_WORDS, bindTarget, namedAnywhere, normaliseName, targetsNamed } from "./resolve";
import type { MenuItemLike, TargetBinding, TargetHands, TargetsDeps, TargetsForAgent, TargetsRuntime } from "./types";
import { createWslService, isToolDistro } from "./wsl-service";

// ───────────── What the runtime is built from ─────────────

/** A panel's answer from its own window's buttons (already checked there: that window, the card on screen, its hash). */
export interface PanelAnswer { n: number; answer: "once" | "deny"; sha256: string }

/** UI's command window controller as the runtime uses it: the contract, plus its answer hook when it has one. */
export type CommandWindow = CommandWindowPort & {
  show(): void; owns(sender: { readonly id: number }): boolean; dispose(): void;
  /** The card's own buttons' answers (UI's extra; without it the runtime hears COMMANDS_IPC.answer itself). */
  onAnswer?(fn: (a: PanelAnswer) => void): () => void;
};

/** UI's prompt window as the runtime uses it: the contract, plus its consent-answer hook and show() when it has them. */
export type PromptWindow = PromptUi & {
  showConsent(n: number, c: ConsentPanel): void; hideConsent(n: number): void; consentReady(n: number): boolean; dispose(): void;
  /** A consent question's answer from its card (UI's extra; without it a consent question can only be declined). */
  onConsent?(fn: (a: PanelAnswer) => void): () => void;
  /** Brings the window back with its card (UI's extra). */
  show?(): void;
};

/** The factories and OS facts the runtime is built from: the real ones in createTargets, fakes in tests. */
export interface TargetsParts {
  env: NodeJS.ProcessEnv;
  home: string;
  user: string;
  localRunner: typeof createLocalRunner;
  commandWindow: (o: Parameters<typeof createCommandWindowPort>[0]) => CommandWindow;
  promptWindow: (o: Parameters<typeof createPromptWindow>[0]) => PromptWindow;
  wsl: typeof createWsl;
  connections: typeof createConnections;
  remoteParts: typeof remoteTargetParts;
  /** SA's noticing functions; null: Ember doesn't look for the user's own ssh. */
  notice: SshNotice | null;
  doctor: DoctorProbes;
  /** Ember's own helper processes now (its main process's descendants that aren't command runs), for D4.5. */
  ownPids: () => number[];
  /**
   * WB's accessibility helpers in WSL distros (one router per main process, app/main/wsl/router.ts): the kill switch
   * stops them, their pids are Ember's own (D4.5), and their doctor rows join the targets'.
   */
  wslHelpers: { stop(): void; pids(): number[]; doctorRows(): Promise<PlatformDoctorRow[]> };
  /** Host aliases of the user's ~/.ssh/config (offer_connect's second source). */
  sshConfigHosts: () => string[];
  randomHex: (bytes: number) => string;
  now: () => Date;
  setInterval: (fn: () => void, ms: number) => { unref?(): void };
  clearInterval: (t: unknown) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
}

// ───────────── Small pure helpers ─────────────

/** A host record's id from what the user calls it (HOST_ID): lower case, [^a-z0-9._-] → "-", unique with "-2", "-3"… */
export function hostIdFor(alias: string, taken: ReadonlySet<string>): string {
  let base = alias.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 60);
  if (!base) base = "host";
  if (!taken.has(base) && HOST_ID.test(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id) && HOST_ID.test(id)) return id;
  }
}

/**
 * "user@host:22", "ssh://user@host:22", "[::1]:22" → the destination ssh gets and a port apart (§5.1.2), or null: SA's
 * own reading of what the user typed (parseTypedDestination), so settings' Add takes exactly what a connect accepts.
 */
export function splitDest(raw: string): { dest: string; port?: number } | null {
  return parseTypedDestination(String(raw ?? ""));
}

/** Megabytes for the connecting bubble ("12 of 29 MB"). */
const mb = (bytes: number) => Math.max(0, Math.round(bytes / 1_000_000));

/** The connecting bubble's step words (§8.2). */
export function progressWords(label: string, p: ConnectProgress): string | null {
  switch (p.step) {
    case "resolving": case "connecting": case "checking": return `Checking ${label}…`;
    case "downloading": return `Downloading what Ember needs for ${label} (${mb(p.done)} of ${mb(p.total)} MB)…`;
    case "copying": return `Copying Ember's helper to ${label} (${mb(p.done)} of ${mb(p.total)} MB)…`;
    case "starting": return `Starting Ember on ${label}…`;
    default: return null;
  }
}

/** Ember's own paths on this computer (§3.6.2): its data, its install, the administrator's policy folder. */
export function emberPathsOf(o: { os: OS; userData: string; resourcesPath: string; packaged: boolean; env: NodeJS.ProcessEnv }): string[] {
  const p = o.os === "win32" ? pathWin32 : pathPosix;
  const out = [o.userData];
  if (o.packaged) out.push(o.os === "darwin" ? p.resolve(o.resourcesPath, "..", "..") : p.dirname(o.resourcesPath));
  if (o.os === "linux") {
    out.push("/opt/ember", "/etc/ember");
    if (o.env.APPIMAGE) out.push(o.env.APPIMAGE);
  } else if (o.os === "darwin") {
    out.push("/Applications/Ember.app", "/Library/Application Support/Ember");
  } else {
    out.push(p.join(o.env.ProgramFiles ?? "C:\\Program Files", "Ember"));
  }
  return [...new Set(out.filter(Boolean))];
}

/** Ember's own process names (D4.5): its binary's and the Copilot runtime's (only names emberNamesRegExp accepts). */
export function emberNamesOf(execPath: string, runtimeExe: string, os: OS): RegExp {
  const base = (os === "win32" ? pathWin32 : pathPosix).basename(execPath);
  const names = [...new Set([base, runtimeExe, "ember"].filter(n => /^[A-Za-z0-9._+ -]{1,64}$/.test(n)))];
  return emberNamesRegExp(names);
}

/** The Host aliases in an ssh config's text (literal names only: no patterns, no negations; Include isn't followed). */
export function configHosts(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*Host\s+(.+?)\s*$/i.exec(line);
    if (!m) continue;
    // Never one ssh would read as an option ("-oProxyCommand…"): the destination validator refuses those too.
    for (const h of m[1].split(/\s+/)) if (h && !/[*?!]/.test(h) && /^(?!-)[A-Za-z0-9._-]{1,255}$/.test(h)) out.push(h);
  }
  return out;
}

/** Whether a host record is for this destination (dest and port; the host part compared without case). */
function sameDest(h: HostRecord, dest: string, port: number | undefined): boolean {
  const fold = (d: string) => { const at = d.lastIndexOf("@"); return at < 0 ? d.toLowerCase() : `${d.slice(0, at)}@${d.slice(at + 1).toLowerCase()}`; };
  return fold(h.dest) === fold(dest) && (h.port ?? null) === (port ?? null);
}

/** The destination a seen ssh connects to, with its -l user folded in ("deploy@build-01"). */
function seenDest(s: SshSeen): string {
  return s.user && !s.dest.includes("@") ? `${s.user}@${s.dest}` : s.dest;
}

/** The framed stream through wsl.exe is proven binary-safe (L22, verify on `wsl2-windows`): until then, no. */
export const WSL_SSH_PROVEN = false;

/** A list from a function that may throw (main's live pid list): empty then. */
function safeList(f: () => number[]): number[] {
  try { const v = f(); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** A yes/no from a function that may throw: `failClosed` then (elevation unknown counts as elevated: every command asks). */
function safeBool(f: () => boolean, failClosed: boolean): boolean {
  try { return f() === true; } catch { return failClosed; }
}

/** A service's capability, never throwing (a service that can't say has commands off). */
function safeCap(svc: CommandService | null): CommandCapability | null {
  if (!svc) return null;
  try { return svc.capability(); } catch { return null; }
}
const safeState = (svc: CommandService | null): CommandCapability["state"] => safeCap(svc)?.state ?? "off";

// ───────────── The real parts ─────────────

/** The real factories and OS facts (createTargets); `deps` gives what main knows. */
export function productionParts(deps: TargetsDeps): TargetsParts {
  const env = process.env;
  let ps: { at: number; rows: number[] } = { at: -Infinity, rows: [] };
  let psRunning = false;
  let proc: { at: number; rows: number[] } = { at: -Infinity, rows: [] };
  const procReader = {
    pids: () => fs.readdirSync("/proc").filter(n => /^\d+$/.test(n)).map(Number),
    stat: (pid: number) => { try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return null; } },
    environ: (pid: number) => { try { return fs.readFileSync(`/proc/${pid}/environ`); } catch { return null; } },
  };
  return {
    env,
    home: os.homedir(),
    user: (() => { try { return os.userInfo().username; } catch { return env.USER ?? env.USERNAME ?? ""; } })(),
    localRunner: createLocalRunner,
    commandWindow: o => createCommandWindowPort(o) as CommandWindow,
    promptWindow: o => createPromptWindow(o) as PromptWindow,
    wsl: createWsl,
    connections: createConnections,
    remoteParts: remoteTargetParts,
    // SA's noticing (§2.7): the host argument of the user's own ssh processes, read only while the offer may be shown.
    notice: { sshDestination, userSshProcesses },
    wslHelpers: { stop: stopWslHelpers, pids: wslHelperPids, doctorRows: wslHelperDoctorRows },
    doctor: realDoctorProbes({ os: deps.os, sys: deps.sys, resourcesPath: deps.resourcesPath, env }),
    ownPids: () => {
      const now = Date.now();
      if (deps.os === "linux") {
        if (now - proc.at > 1000) {
          try { proc = { at: now, rows: linuxOwnPids(procReader, process.pid) }; } catch { proc = { at: now, rows: [] }; }
        }
        return proc.rows;
      }
      if (deps.os === "darwin") {
        // `ps` is a process start: read in the background at most every 5 s; the last answer is used meanwhile.
        if (now - ps.at > 5000 && !psRunning) {
          psRunning = true;
          try {
            execFile("/bin/ps", ["-A", "-o", "pid=,ppid=,comm="], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
              psRunning = false;
              ps = { at: Date.now(), rows: err ? ps.rows : ownTree(psProcTable(String(out), process.pid), process.pid) };
            });
          } catch {
            psRunning = false;
          }
        }
        return ps.rows;
      }
      // Windows: the job object holds every command's tree, and Ember's helpers are named by ember.names (no cheap table).
      return [];
    },
    sshConfigHosts: () => {
      try {
        return configHosts(fs.readFileSync((deps.os === "win32" ? pathWin32 : pathPosix).join(os.homedir(), ".ssh", "config"), "utf8"));
      } catch {
        return []; // no config: only host records count
      }
    },
    randomHex: n => crypto.randomBytes(n).toString("hex"),
    now: () => new Date(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: t => clearInterval(t as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: t => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
}

/** What main hands the runtime beyond TargetsDeps (an extension of the contract; optional, so tests may leave it out). */
export interface TargetsDepsExtra {
  /**
   * Stops every task bound to `target` (queued or running): someone at that computer pressed Stop, its screen locked,
   * or its connection dropped or closed (§5.3.4, §5.3.9, §5.1.11); the runtime's bubble says which.
   */
  stopTasksOn?(target: TargetId): void;
}

/** What the runtime offers main beyond TargetsRuntime (an extension of the contract). */
export interface TargetsRuntimeExtra {
  /**
   * Applies a fix a target doctor row offers (§8.8): `wsl-a11y:<distro>` turns on toolkit accessibility in that running
   * distro with WB's fixed command, through its own command runner. Refused (with why) for anything else, with WSL off
   * or not allowed, or for a distro that isn't running (nothing is booted for it).
   */
  applyFix(id: string): Promise<{ ok: boolean; message: string }>;
}

/** The targets runtime main builds once. */
export function createTargets(deps: TargetsDeps & TargetsDepsExtra): TargetsRuntime & TargetsRuntimeExtra {
  return buildTargets(deps, productionParts(deps));
}

/** The doctor's and setup check's target rows (§8.8): the SSH client, the commands terminal, the remote parts, WSL's. */
export async function targetDoctorRows(o: { os: OS; sys: SystemPlatform; admin: () => LoadedAdminPolicy; resourcesPath: string; packaged: boolean; appDir?: string }): Promise<PlatformDoctorRow[]> {
  const rows = await doctorRowsWith(o, realDoctorProbes({ os: o.os, sys: o.sys, resourcesPath: o.resourcesPath, env: process.env }));
  if (o.os !== "win32" || !wslAllowed(o.admin())) return rows;
  // The doctor runs apart from Ember: its own short-lived view of WSL (nothing is started; it is let go at once).
  const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet, file: "" };
  let wsl: WslService | null = null;
  try {
    wsl = createWsl({ log: quiet, env: process.env, os: o.os, ember: { winPaths: [] }, jobHost: null });
    if (wsl) {
      rows.push(...await wsl.doctorRows());
      // No router runs in the doctor's process: a short-lived one looks inside each running distro (nothing is booted).
      // (main.cjs's folder, dist/app, when main doesn't say: the source tree's script beside it in a development copy.)
      const appDir = o.appDir ?? (typeof __dirname === "string" ? __dirname : null);
      rows.push(...await doctorHelperRows({ os: o.os, log: quiet, wsl, resourcesPath: o.resourcesPath, appDir, env: process.env }));
    }
  } catch {
    // WSL's rows are left out when it can't be asked (the doctor's other rows stand).
  } finally {
    try { wsl?.dispose(); } catch { /* already gone */ }
  }
  return rows;
}

// ───────────── The runtime ─────────────

/** One SSH host's connection as the runtime keeps it. */
interface Conn {
  state: LinkState;
  link: RemoteLink | null;
  target: RemoteTarget | null;
  abort: AbortController | null;
  offs: (() => void)[];
  /** Make it the picker's choice once it is ready. */
  activate: boolean;
}

/** An offer on screen: an ssh Ember saw the user run, or offer_connect's button. */
type Offer = { kind: "seen"; seen: SshSeen } | { kind: "connect"; hostId: string | null; alias: string };

/** How long an informational bubble stays (only if nothing of the runtime's replaced it). */
const INFO_MS = 7000;

/** The runtime from its parts (createTargets with the real ones; tests with fakes). */
export function buildTargets(deps: TargetsDeps & TargetsDepsExtra, parts: TargetsParts): TargetsRuntime & TargetsRuntimeExtra {
  const log = deps.log;
  const settings = deps.settings;
  const admin = () => deps.admin();
  const system: WorkerSystem = wslAwareSystem(deps.sys);
  let disposed = false;

  // ── Windows of Ember's own (made only when something needs them; their channels are theirs) ──
  const commandWindow = parts.commandWindow({ create: deps.windows.command, ipc: deps.ipc, log: log.child("command-window"), os: deps.os, keyHint: () => null });
  const promptWindow = parts.promptWindow({ create: deps.windows.prompt, ipc: deps.ipc, log: log.child("prompt-window"), os: deps.os });

  // ── This computer's commands ──
  const emberPaths = emberPathsOf({ os: deps.os, userData: deps.userData, resourcesPath: deps.resourcesPath, packaged: deps.packaged, env: parts.env });
  const emberPids = (): number[] => [...new Set([...safeList(deps.emberPids), ...safeList(parts.ownPids), ...safeList(parts.wslHelpers.pids)].filter(p => Number.isInteger(p) && p > 0))];
  let extraPath: string[] = [];
  try { extraPath = deps.extraPath(); } catch (err) { log.warn("targets.extra_path_failed", { err }); }
  const elevated = () => safeBool(deps.elevated, true);
  const localRunner = parts.localRunner({
    log: log.child("commands"), os: deps.os, env: parts.env,
    ember: { paths: emberPaths, pids: emberPids, names: emberNamesOf(deps.execPath, deps.sys.paths.runtimeExe, deps.os) },
    home: parts.home, user: parts.user, elevated, extraPath, jobHost: deps.jobHost,
  });
  const localService = createLocalService({
    os: deps.os, log, binding: () => localBinding(deps.os, !!deps.localHands), runner: localRunner, window: commandWindow, settings, admin, privileged: elevated,
  });

  // ── WSL (Windows, allowed by the administrator) ──
  let wsl: WslService | null = null;
  if (deps.os === "win32" && wslAllowed(admin())) {
    try { wsl = parts.wsl({ log: log.child("wsl"), env: parts.env, os: deps.os, ember: { winPaths: emberPaths }, jobHost: deps.jobHost }); } catch (err) { log.error("targets.wsl_failed", { err }); }
  }
  let wslFacts: WslFacts | null = null;
  const wslServices = new Map<string, WarmService>();
  const wslOn = () => wslAllowed(admin()) && settings.get().targets.wsl.on && consentCurrent("wsl", settings.get().targets.wsl.consent);
  const distroOf = (name: string) => wslFacts?.distros.find(d => d.name === name) ?? null;
  const wslService = (name: string): WarmService | null => {
    if (!wsl) return null;
    let s = wslServices.get(name);
    if (!s) {
      let runner: CommandRunner;
      try { runner = wsl.runner(name); } catch (err) { log.warn("targets.wsl_runner_failed", { err }); return null; }
      s = createWslService({
        name, log, distro: () => distroOf(name), binding: () => wslBinding(distroOf(name) ?? { name, version: 2 }, !!deps.localHands),
        runner, window: commandWindow, settings, admin, wslOn,
      });
      wslServices.set(name, s);
    }
    return s;
  };
  let wslLoading: Promise<void> | null = null;
  const refreshWsl = (fresh = false): Promise<void> => {
    const w = wsl;
    if (!w) return Promise.resolve();
    if (wslLoading && !fresh) return wslLoading;
    wslLoading = (async () => {
      try { wslFacts = await w.facts(fresh ? { refresh: true } : undefined); } catch (err) { log.warn("targets.wsl_facts_failed", { err }); }
      wslLoading = null;
      refresh();
    })();
    return wslLoading;
  };

  // ── SSH ──
  const conns = new Map<string, Conn>();
  /** This install's id (§5.1.13): made at first use, kept in settings. */
  const pcId = (): string => {
    const have = settings.get().targets.pcId;
    if (/^[0-9a-f]{32}$/.test(have)) return have;
    const id = parts.randomHex(16);
    try { settings.update({ targets: { ...settings.own().targets, pcId: id } }); } catch (err) { log.error("targets.pc_id_failed", { err }); }
    return id;
  };
  let connections: Connections | null = null;
  try {
    connections = parts.connections({
      log: log.child("ssh"), os: deps.os, userData: deps.userData, appDir: deps.appDir, execPath: deps.execPath, resourcesPath: deps.resourcesPath,
      settings, admin, prompts: promptWindow, fetch: deps.fetch,
      // This computer over loopback only for the integration tests, and only in a development copy (R10).
      allowLoopback: !deps.packaged && deps.devEnv("EMBER_TEST_ALLOW_LOOPBACK_SSH") === "1",
      audit: deps.audit, pcId, wsl: () => wsl, jobHost: deps.jobHost,
    });
  } catch (err) {
    log.error("targets.connections_failed", { err });
  }
  const hostOf = (hostId: string) => settings.get().targets.hosts.find(h => h.id === hostId) ?? null;
  const saveHost = (h: HostRecord) => {
    const own = settings.own().targets;
    const hosts = own.hosts.some(x => x.id === h.id) ? own.hosts.map(x => (x.id === h.id ? h : x)) : [...own.hosts, h];
    settings.update({ targets: { ...own, hosts } });
  };

  // ── The registry ──
  let entries: TargetEntry[] = [];
  let lastPushed = "";
  // Nothing set up: no badge (the handle is told only when the picker leaves this computer).
  let lastBadge = "null";
  const commandsOf = (id: TargetId): CommandService | null => {
    const p = parseTargetId(id);
    if (!p) return null;
    if (p.kind === "local") return localService;
    if (p.kind === "wsl") return wslService(p.name);
    return conns.get(p.name)?.target?.service ?? null;
  };
  const linkViews = (): Map<string, LinkView> => {
    const m = new Map<string, LinkView>();
    for (const [hostId, c] of conns) {
      const t = c.target;
      m.set(hostId, { state: c.state, ...(t ? { desktop: t.desktop(), commands: safeState(t.service) } : {}) });
    }
    return m;
  };
  const rebuild = () => {
    entries = buildRegistry({
      os: deps.os, admin: admin(), settings: settings.get(), localDesktop: !!deps.localHands,
      commands: id => safeState(commandsOf(id)), wsl: wslFacts, links: linkViews(),
    });
  };
  const activeId = (): TargetId => activeOf(entries, settings.get().targets.active);
  const entryOf = (id: TargetId) => entries.find(e => e.id === id) ?? null;
  const summaries = (): TargetSummary[] => { const a = activeId(); return entries.map(e => summaryOf(e, a)); };
  const ipc = registerTargetsIpc({
    ipc: deps.ipc, isHome: deps.isHome, log,
    // The settings window opening is a moment to look for WSL distros again (WA caches them for a minute).
    list: () => { if (wsl) void refreshWsl(); return summaries(); },
    act: a => act(a),
  });
  /** Rebuilds the registry and tells the renderers what changed (the settings list, the handle's badge). */
  function refresh(): void {
    if (disposed) return;
    try { rebuild(); } catch (err) { log.error("targets.registry_failed", { err }); return; }
    const list = summaries();
    const json = JSON.stringify(list);
    if (json !== lastPushed) { lastPushed = json; ipc.push(list); }
    const active = list.find(s => s.active);
    const badge = active && active.id !== LOCAL_TARGET ? active : undefined;
    const bj = JSON.stringify(badge ?? null);
    if (bj !== lastBadge) {
      lastBadge = bj;
      try { deps.showState({ target: badge }); } catch (err) { log.warn("targets.badge_failed", { err }); }
    }
  }
  const setActive = (id: TargetId) => {
    const own = settings.own().targets;
    if (own.active !== id) { try { settings.update({ targets: { ...own, active: id } }); } catch (err) { log.error("targets.active_failed", { err }); } }
    refresh();
  };

  // ── Bubbles (main's guarded setter: a question on screen is never replaced) ──
  let bubbleSeq = 0;
  let shown: { key: string; seq: number } | null = null;
  const bubble = (key: string, b: Pick<BubbleState, "title" | "thought" | "actions" | "mood">, hideMs?: number) => {
    const seq = ++bubbleSeq;
    shown = { key, seq };
    try { deps.showState({ bubble: { ...IDLE_BUBBLE, visible: true, ...b } }); } catch (err) { log.warn("targets.bubble_failed", { err }); return; }
    if (hideMs) parts.setTimeout(() => { if (shown?.seq === seq) hideBubble(key); }, hideMs);
  };
  const hideBubble = (key?: string) => {
    if (key !== undefined && shown?.key !== key) return;
    shown = null;
    try { deps.showState({ bubble: IDLE_BUBBLE }); } catch { /* the overlay went with Ember */ }
  };

  // ── Questions with panels (§3.9): which one is up ──
  let current: { n: number; question: Question } | null = null;
  const questionUp = () => current !== null || (deps.confirmer()?.waiting ?? false);

  // ── Consent cards asked directly (settings' switches, connecting) ──
  let cardSeq = 0;
  const askCard = async (card: ConsentPanel): Promise<boolean> => {
    try {
      const a = await promptWindow.ask({ id: `consent-${++cardSeq}`, kind: "consent-direct", consent: card });
      return consentYes(card, a);
    } catch (err) {
      log.warn("targets.consent_failed", { feature: card.feature, err });
      return false;
    }
  };

  // ── Connecting ──
  const connState = (hostId: string): Conn => {
    let c = conns.get(hostId);
    if (!c) { c = { state: "closed", link: null, target: null, abort: null, offs: [], activate: false }; conns.set(hostId, c); }
    return c;
  };
  /** The tasks on `hostId` stop (main's AgentHost): what they were doing there can't go on. */
  const stopTasks = (hostId: string) => {
    try { deps.stopTasksOn?.(targetIdOf("ssh", hostId)); } catch (err) { log.warn("targets.stop_tasks_failed", { err }); }
  };
  const dropTarget = (c: Conn) => {
    for (const off of c.offs.splice(0)) { try { off(); } catch { /* the link is gone */ } }
    try { c.target?.dispose(); } catch (err) { log.warn("targets.remote_dispose_failed", { err }); }
    c.target = null;
    c.link = null;
  };
  const sshFacts = (host: HostRecord, resolved: HostRecord["resolved"]) => ({
    label: host.id, resolved, ...(host.extra ? { extra: host.extra } : {}),
    ...(host.via && host.via !== "local" ? { viaLabel: distroLabel(host.via.slice(4)) } : {}),
    desktopOff: admin().policy.ssh?.desktop === false, graceSeconds: admin().policy.ssh?.commandGraceSeconds ?? 20,
  });
  /** Builds the target for a link that came up (a connect, or SA's own reconnect). */
  const adopt = (hostId: string, link: RemoteLink): boolean => {
    const host = hostOf(hostId);
    const c = connState(hostId);
    if (!host) { void link.close("forgotten").catch(() => undefined); return false; }
    if (c.link === link && c.target) return true;
    dropTarget(c);
    let target: RemoteTarget;
    try {
      target = createRemoteTarget({
        host, link, log: log.child(`ssh-${hostId}`), settings, admin, window: commandWindow, makeParts: parts.remoteParts,
        onLocked: () => {
          // A screen that locks mid-task stops that computer's tasks (§5.3.4 step 8); the next task asks for it again.
          stopTasks(hostId);
          if (activeId() === targetIdOf("ssh", hostId)) bubble(`locked:${hostId}`, { title: `Stopped on ${host.id}`, thought: `${host.id}'s screen locked, so I stopped working there.`, actions: [], mood: "attention" }, INFO_MS);
          refresh();
        },
        onConsoleStop: () => {
          // Everything stopped there (§5.3.9): its tasks here too, or a worker would go on with commands after the Stop.
          stopTasks(hostId);
          bubble(`console:${hostId}`, { title: `Stopped on ${host.id}`, thought: `Someone at ${host.id} pressed Stop.`, actions: [], mood: "attention" }, INFO_MS);
        },
      });
    } catch (err) {
      log.error("targets.remote_parts_failed", { err });
      void link.close("parts").catch(() => undefined);
      c.state = "closed";
      refresh();
      return false;
    }
    c.link = link;
    c.target = target;
    c.state = link.state === "stalled" ? "stalled" : link.state === "ready" ? "ready" : "closed";
    try { c.offs.push(link.onState(s => onLinkState(hostId, link, s))); } catch (err) { log.warn("targets.link_listen_failed", { err }); }
    return true;
  };
  function onLinkState(hostId: string, link: RemoteLink, s: "ready" | "stalled" | "lost" | "closed"): void {
    const c = conns.get(hostId);
    if (!c || c.link !== link) return;
    if (s === "stalled") {
      c.state = "stalled";
      bubble(`stalled:${hostId}`, {
        title: `${hostId} isn't answering`, thought: `Its running commands stop in ${link.welcome.graceSeconds} s unless the link comes back. Nothing new is sent meanwhile.`,
        actions: [{ id: `conn:${hostId}:disconnect`, label: "Disconnect" }], mood: "attention",
      });
    } else if (s === "ready") {
      c.state = "ready";
      hideBubble(`stalled:${hostId}`);
    } else if (s === "lost") {
      dropTarget(c);
      c.state = "lost";
      stopTasks(hostId);
      if (settings.get().targets.active === targetIdOf("ssh", hostId)) setActive(LOCAL_TARGET);
      bubble(`lost:${hostId}`, {
        title: `Lost ${hostId}`, thought: "The connection dropped, so everything there stopped. I'll try to reconnect.",
        actions: [{ id: `conn:${hostId}:reconnect`, label: "Reconnect", primary: true }, { id: `conn:${hostId}:stop`, label: "Stop trying" }], mood: "error",
      });
    } else {
      dropTarget(c);
      c.state = "closed";
      stopTasks(hostId);
      hideBubble(`stalled:${hostId}`);
      if (settings.get().targets.active === targetIdOf("ssh", hostId)) {
        setActive(LOCAL_TARGET);
        bubble("back", { title: "Back on this computer", thought: `${hostId} isn't connected any more, so I'll work here.`, actions: [], mood: "attention" }, INFO_MS);
      }
    }
    refresh();
  }
  /**
   * Connects a host the user chose (settings, an offer, the picker): its card first when needed, then the link. `again`:
   * the second try after the user said yes to a changed machine's card.
   */
  async function connect(hostId: string, o: { interactive: boolean; activate: boolean; again?: boolean }): Promise<ActResult> {
    if (!sshAllowed(admin())) return { ok: false, message: "Your organisation doesn't allow Ember on other computers." };
    if (!connections) return { ok: false, message: "Ember can't connect to other computers here." };
    const conn = connections;
    let host = hostOf(hostId);
    if (!host) return { ok: false, message: "Ember doesn't know that computer." };
    const c = connState(hostId);
    if (c.state === "connecting") { c.activate ||= o.activate; return { ok: true }; }
    if ((c.state === "ready" || c.state === "stalled") && c.target) { if (o.activate) setActive(targetIdOf("ssh", hostId)); return { ok: true }; }
    const label = host.id;
    const abort = new AbortController();
    c.abort = abort;
    c.state = "connecting";
    c.activate = o.activate;
    refresh();
    bubble(`connecting:${hostId}`, { title: `Connecting to ${label}…`, thought: `Checking ${label}…`, actions: [{ id: `conn:${hostId}:cancel`, label: "Cancel" }], mood: "thinking" });
    const stopped = (message: string): ActResult => { c.state = "closed"; c.abort = null; refresh(); hideBubble(`connecting:${hostId}`); return { ok: false, message }; };
    const fail = (message: string, retry = false): ActResult => {
      c.state = "closed";
      c.abort = null;
      refresh();
      bubble(`fail:${hostId}`, { title: `Can't connect to ${label}`, thought: message, actions: retry ? [{ id: `conn:${hostId}:reconnect`, label: "Try again" }] : [], mood: "error" }, retry ? undefined : 2 * INFO_MS);
      return { ok: false, message };
    };
    try {
      // What ssh -G makes of it now: a changed user, hostname or port (or a card never accepted) asks again (§7.4).
      const now = await conn.resolve(host.dest, { ...(host.port ? { port: host.port } : {}), ...(host.extra ? { extra: host.extra } : {}), ...(host.via ? { via: host.via } : {}) });
      if (abort.signal.aborted) return stopped("Cancelled.");
      const resolved = { user: now.user, hostname: now.hostname, port: now.port, jump: [...now.jump] };
      if (sshNeedsConsent(host, resolved)) {
        const card = sshConsent({ os: deps.os, target: targetIdOf("ssh", hostId), facts: sshFacts(host, resolved) });
        if (!(await askCard(card))) return stopped("Not now.");
        // Cancelled, forgotten or stopped by the kill switch while the card was up: nothing is saved or connected.
        if (abort.signal.aborted) return stopped("Cancelled.");
        host = { ...host, resolved, consent: consentGiven("ssh", parts.now()) };
        saveHost(host);
      }
      if (abort.signal.aborted) return stopped("Cancelled.");
      const link = await conn.connect(host, { interactive: o.interactive, signal: abort.signal });
      // A link that came up as the user cancelled (or pressed the kill switch) is let go, never adopted.
      const letGo = async (message: string): Promise<ActResult> => { await conn.disconnect(hostId).catch(() => undefined); return stopped(message); };
      if (abort.signal.aborted) return letGo("Cancelled.");
      // Another computer under the same name than the one the user said yes to: asked again (§7.4).
      if (machineChanged(host, link.welcome.machineIdHash)) {
        const card = sshConsent({ os: deps.os, target: targetIdOf("ssh", hostId), facts: { ...sshFacts(host, host.resolved), machineChanged: true } });
        if (!(await askCard(card))) return letGo("Not now.");
        if (abort.signal.aborted) return letGo("Cancelled.");
        host = { ...host, consent: consentGiven("ssh", parts.now()) };
      }
      host = { ...host, machineIdHash: link.welcome.machineIdHash, lastUsed: parts.now().toISOString() };
      saveHost(host);
      c.abort = null;
      if (!adopt(hostId, link)) {
        await conn.disconnect(hostId).catch(() => undefined);
        return fail(`Ember can't work on ${label} from here yet.`);
      }
      if (c.activate) setActive(targetIdOf("ssh", hostId)); else refresh();
      const headless = c.target?.desktop() === "none";
      bubble(`connected:${hostId}`, {
        title: `Ember is on ${label}`,
        thought: headless ? `${label} has no desktop, so I'll run commands there.` : "Ask away: I'll work there. Your voice and your sign-in stay on this computer.",
        actions: [], mood: "done",
      }, INFO_MS);
      return { ok: true };
    } catch (err) {
      if (abort.signal.aborted) return stopped("Cancelled.");
      // SA found another computer under this name after its probe, before uploading anything (§7.4): the card again
      // (once), and on a yes the old machine is forgotten and Ember connects afresh (SA then remembers the new one).
      if (err instanceof ConnectError && err.kind === "machine-changed" && !o.again) {
        const card = sshConsent({ os: deps.os, target: targetIdOf("ssh", hostId), facts: { ...sshFacts(host, host.resolved), machineChanged: true } });
        if (!(await askCard(card))) return stopped("Not now.");
        const now = hostOf(hostId);
        if (abort.signal.aborted || !now) return stopped("Cancelled.");
        const { machineIdHash: _was, ...rest } = now;
        try { saveHost({ ...rest, consent: consentGiven("ssh", parts.now()) }); } catch (e) { log.warn("targets.host_save_failed", { err: e }); return fail(`Ember couldn't connect to ${label}.`); }
        c.state = "closed";
        c.abort = null;
        return connect(hostId, { ...o, again: true });
      }
      if (err instanceof ConnectError) return fail(err.fix ? `${err.message} ${err.fix}` : err.message, err.retry);
      log.warn("targets.connect_failed", { err });
      return fail(`Ember couldn't connect to ${label}.`);
    }
  }
  async function disconnect(hostId: string): Promise<void> {
    const c = conns.get(hostId);
    if (c?.abort) c.abort.abort();
    // Its link listener goes with the target: the tasks there stop here, as at any close.
    if (c) { if (c.target) stopTasks(hostId); dropTarget(c); c.state = "closed"; }
    try { await connections?.disconnect(hostId); } catch (err) { log.warn("targets.disconnect_failed", { err }); }
    if (settings.get().targets.active === targetIdOf("ssh", hostId)) setActive(LOCAL_TARGET);
    refresh();
  }
  /** A destination the user typed (settings' Add) or Ember saw them use: its record, then its card, then the link. */
  async function addAndConnect(raw: { dest: string; port?: number; extra?: HostRecord["extra"]; via?: HostRecord["via"] }): Promise<ActResult> {
    if (!sshAllowed(admin())) return { ok: false, message: "Your organisation doesn't allow Ember on other computers." };
    if (!connections) return { ok: false, message: "Ember can't connect to other computers here." };
    const existing = settings.get().targets.hosts.find(h => sameDest(h, raw.dest, raw.port));
    if (existing) return connect(existing.id, { interactive: true, activate: true });
    let resolved: HostRecord["resolved"];
    try {
      const r = await connections.resolve(raw.dest, { ...(raw.port ? { port: raw.port } : {}), ...(raw.extra ? { extra: raw.extra } : {}), ...(raw.via ? { via: raw.via } : {}) });
      resolved = { user: r.user, hostname: r.hostname, port: r.port, jump: [...r.jump] };
    } catch (err) {
      if (!(err instanceof ConnectError)) log.warn("targets.resolve_failed", { err });
      return { ok: false, message: err instanceof ConnectError ? (err.fix ? `${err.message} ${err.fix}` : err.message) : "Ember couldn't look that computer up." };
    }
    const id = hostIdFor(hostPart(raw.dest), new Set(settings.get().targets.hosts.map(h => h.id)));
    const host: HostRecord = {
      id, dest: raw.dest, ...(raw.port ? { port: raw.port } : {}), ...(raw.extra ? { extra: raw.extra } : {}), ...(raw.via ? { via: raw.via } : {}),
      resolved, consent: { version: 0, at: null },
    };
    const card = sshConsent({ os: deps.os, target: targetIdOf("ssh", id), facts: sshFacts(host, resolved) });
    if (!(await askCard(card))) return { ok: false, message: "Not now." };
    try { saveHost({ ...host, consent: consentGiven("ssh", parts.now()) }); } catch (err) {
      log.warn("targets.host_save_failed", { err });
      return { ok: false, message: "Ember couldn't save that computer." };
    }
    return connect(id, { interactive: true, activate: true });
  }
  async function forget(hostId: string): Promise<void> {
    await disconnect(hostId);
    conns.delete(hostId);
    const own = settings.own().targets;
    settings.update({ targets: { ...own, hosts: own.hosts.filter(h => h.id !== hostId), ...(own.active === targetIdOf("ssh", hostId) ? { active: LOCAL_TARGET } : {}) } });
    forgetCommands(settings, targetIdOf("ssh", hostId));
    refresh();
  }

  // ── The settings window's acts ──
  async function act(a: TargetsAct): Promise<ActResult> {
    switch (a.kind) {
      case "activate": {
        rebuild();
        const e = entryOf(a.id);
        if (!e || e.listedOnly) return { ok: false, message: e?.why ?? "Ember doesn't know that computer." };
        if (e.kind === "ssh" && e.host && e.state !== "ready") return connect(e.host.id, { interactive: true, activate: true });
        setActive(a.id);
        return { ok: true };
      }
      case "connect": return connect(a.hostId, { interactive: true, activate: true });
      case "disconnect": await disconnect(a.hostId); return { ok: true };
      case "forget": await forget(a.hostId); return { ok: true };
      case "uninstall": {
        const host = hostOf(a.hostId);
        if (!host || !connections) return { ok: false, message: "Ember doesn't know that computer." };
        // The PC then forgets the host record (§5.2.7): Ember isn't there any more.
        try { await connections.uninstall(host); await forget(host.id); return { ok: true }; } catch (err) {
          return { ok: false, message: err instanceof ConnectError ? err.message : `Ember couldn't remove its helper from ${host.id}.` };
        }
      }
      case "add": {
        const d = splitDest(a.dest);
        if (!d) return { ok: false, message: "That isn't an SSH host Ember can use. Type an alias from your SSH config, or user@host." };
        return addAndConnect(d);
      }
      case "wsl": return setWsl(a.on);
      case "commands": return setCommands(a.id, a.on, a.askEvery);
      case "offerSsh":
        settings.update({ targets: { ...settings.own().targets, offerSsh: a.on } });
        return { ok: true };
      case "openCommands":
        commandWindow.show();
        return { ok: true };
      default:
        return { ok: false, message: "Ember didn't understand that request." };
    }
  }
  async function setWsl(on: boolean): Promise<ActResult> {
    if (!wslAllowed(admin())) return { ok: false, message: "Your organisation doesn't allow Ember to work in WSL." };
    if (!wsl) return { ok: false, message: "WSL isn't installed on this computer." };
    const own = settings.own().targets;
    if (!on) { settings.update({ targets: { ...own, wsl: { ...own.wsl, on: false } } }); refresh(); return { ok: true }; }
    if (!consentCurrent("wsl", own.wsl.consent)) {
      await refreshWsl();
      const d = defaultDistro(wslFacts);
      const card = wslConsent(d ? { target: targetIdOf("wsl", d.name), targetLabel: distroLabel(d.name) } : { target: LOCAL_TARGET, targetLabel: "WSL" });
      if (!(await askCard(card))) return { ok: false, message: "Not now." };
      settings.update({ targets: { ...settings.own().targets, wsl: { on: true, consent: consentGiven("wsl", parts.now()) } } });
    } else {
      settings.update({ targets: { ...own, wsl: { ...own.wsl, on: true } } });
    }
    await refreshWsl(true);
    return { ok: true };
  }
  async function setCommands(id: TargetId, on: boolean, askEvery?: boolean): Promise<ActResult> {
    rebuild();
    const e = entryOf(id);
    if (!e) return { ok: false, message: "Ember doesn't know that computer." };
    if (on) {
      const svc = commandsOf(id);
      const mode = e.kind === "ssh" && svc ? svc.mode() : commandMode(admin(), e.kind);
      if (mode === "off") {
        return { ok: false, message: e.kind === "local" ? "Your organisation has turned off commands on this computer." : e.kind === "wsl" ? "Your organisation has turned off commands in WSL." : "Your organisation has turned off commands on computers reached over SSH." };
      }
      const was = settings.get().commands[id];
      if (!consentCurrent("commands", was?.consent)) {
        const card = commandsConsent({ os: deps.os, target: id, targetLabel: e.label, facts: cardFacts(e) });
        if (!(await askCard(card))) return { ok: false, message: "Not now." };
        const own = settings.own().commands;
        settings.update({ commands: { ...own, [id]: { on: true, askEvery: askEvery ?? own[id]?.askEvery ?? false, consent: consentGiven("commands", parts.now()) } } });
        refresh();
        return { ok: true };
      }
    }
    setCommandsSwitch(settings, id, on, askEvery);
    refresh();
    return { ok: true };
  }
  /** What the commands card says about a target besides its common text (§8.4.3 line 4). */
  const cardFacts = (e: TargetEntry) => {
    const privileged = e.kind === "local" ? elevated()
      : e.kind === "wsl" ? e.distro?.defaultUid === 0 || (wslServices.get(e.distro?.name ?? "")?.facts()?.privileged ?? false)
        : safeCap(commandsOf(e.id))?.askEvery === "root";
    return { kind: e.kind, privileged, windows: e.kind === "local" && deps.os === "win32", podman: e.kind === "wsl" && !!e.distro && isToolDistro(e.distro) };
  };

  // ── Panel answers (the command card's and a consent card's own buttons) ──
  // Each window answers only its own kind of question (R7: a command is allowed only from the command window's card, a
  // consent card only from the prompt window's): the Confirmer checks the hash, not which window sent it. "Not now"
  // passes from either (the Confirmer takes it from anywhere).
  const confirmAnswer = (kind: "command" | "consent") => (a: PanelAnswer) => {
    if (a.answer !== "deny" && (current?.n !== a.n || current.question.panel?.kind !== kind)) {
      log.warn("targets.panel_answer_refused", { kind });
      return;
    }
    try { deps.confirmer()?.answer(`q${a.n}:${a.answer}`, "panel", { sha256: a.sha256 }); } catch (err) { log.warn("targets.panel_answer_failed", { err }); }
  };
  if (commandWindow.onAnswer) {
    commandWindow.onAnswer(confirmAnswer("command"));
  } else {
    // The card's Allow sends COMMANDS_IPC.answer; only the command window's own page is heard (§3.9.1).
    deps.ipc.on(COMMANDS_IPC.answer, (e, raw) => {
      let mine: boolean;
      try { mine = commandWindow.owns(e.sender); } catch { mine = false; }
      if (!mine) { log.warn("targets.ipc_refused", { channel: COMMANDS_IPC.answer }); return; }
      const r = raw as { n?: unknown; answer?: unknown; sha256?: unknown } | null;
      if (!r || typeof r !== "object" || typeof r.n !== "number" || !Number.isSafeInteger(r.n) || (r.answer !== "once" && r.answer !== "deny")
        || typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) return;
      confirmAnswer("command")({ n: r.n, answer: r.answer, sha256: r.sha256 });
    });
  }
  // A consent question's yes comes only from its card's own button; without UI's hook it can only be declined (fail closed).
  if (promptWindow.onConsent) promptWindow.onConsent(confirmAnswer("consent"));
  else log.info("targets.consent_answers_unwired", {});
  const hidePanel = (q: { n: number; question: Question }) => {
    const p = q.question.panel;
    try {
      if (p?.kind === "command") commandWindow.hideCard(q.n);
      else if (p?.kind === "consent") promptWindow.hideConsent(q.n);
    } catch (err) { log.warn("targets.panel_hide_failed", { err }); }
  };
  const showPanel = (q: { n: number; question: Question }) => {
    const p = q.question.panel;
    try {
      if (p?.kind === "command") commandWindow.showCard(q.n, p.card);
      else if (p?.kind === "consent") promptWindow.showConsent(q.n, p.consent);
    } catch (err) { log.warn("targets.panel_show_failed", { err }); }
  };

  // ── The ssh noticer and the offers ──
  let offerSeq = 0;
  const offers = new Map<number, Offer>();
  let wslOffered = false;
  function showSeenOffer(s: SshSeen): void {
    const k = ++offerSeq;
    offers.set(k, { kind: "seen", seen: s });
    const label = hostPart(s.dest);
    if (s.via && s.via !== "local" && !WSL_SSH_PROVEN) {
      bubble(`offer:${k}`, {
        title: `You're connected to ${label} from ${s.via.slice(4)}`,
        thought: "Ember connects with Windows' SSH. Add your key to Windows' ssh-agent, or connect once from PowerShell, then bring Ember there.",
        actions: [{ id: `offer:${k}:later`, label: "Not now" }, { id: `offer:${k}:never`, label: "Don't offer again" }], mood: "attention",
      });
      return;
    }
    bubble(`offer:${k}`, {
      title: `You're connected to ${label}`, thought: "Bring Ember there too? It will open its own connection with your SSH settings.",
      actions: [{ id: `offer:${k}:bring`, label: "Bring Ember", primary: true }, { id: `offer:${k}:later`, label: "Not now" }, { id: `offer:${k}:never`, label: "Don't offer again" }],
      mood: "attention",
    });
  }
  const bringSeen = (s: SshSeen) => {
    const extra: HostRecord["extra"] = {
      ...(s.jump?.length ? { jump: s.jump } : {}), ...(s.identityFiles?.length ? { identityFiles: s.identityFiles } : {}),
      ...(s.configFile ? { configFile: s.configFile } : {}), ...(s.options && Object.keys(s.options).length ? { options: s.options } : {}),
    };
    void addAndConnect({
      dest: seenDest(s), ...(s.port ? { port: s.port } : {}), ...(Object.keys(extra).length ? { extra } : {}),
      ...(s.via && s.via !== "local" && WSL_SSH_PROVEN ? { via: s.via } : {}),
    });
  };
  const dismissSeen = (s: SshSeen) => {
    const own = settings.own().targets;
    const dest = seenDest(s).slice(0, 255);
    if (own.dismissedOffers.some(d => d.toLowerCase() === dest.toLowerCase())) return;
    try { settings.update({ targets: { ...own, dismissedOffers: [...own.dismissedOffers, dest].slice(-200) } }); } catch (err) { log.warn("targets.dismiss_failed", { err }); }
  };
  let noticer: Noticer | null = null;
  let noticeTimer: unknown = null;
  // The window the user is in comes from the hands' tier-3 view of it (main's window system); without it, no noticing.
  const look = deps.localHands?.cursor?.activeWindow;
  if (parts.notice && look) {
    noticer = createNoticer({
      os: deps.os, log, notice: parts.notice,
      enabled: () => sshAllowed(admin()) && settings.get().targets.offerSsh,
      activeWindow: () => {
        const w = look();
        return w && typeof w.app === "string" && typeof w.title === "string" ? { app: w.app, title: w.title } : null;
      },
      isTerminal: app => isTerminalWindowApp(app, deps.sys.apps, deps.os),
      cimAllowed: () => settings.get().targets.hosts.length > 0 || settings.get().targets.dismissedOffers.length === 0,
      wsl: () => {
        if (!wsl || !wslOn() || !wslFacts?.wslExe) return null;
        const distros = wslFacts.distros.filter(d => d.running && entries.some(e => e.distro?.name === d.name && !e.listedOnly)).map(d => d.name);
        return { exe: wslFacts.wslExe, distros };
      },
      dismissed: s => settings.get().targets.dismissedOffers.some(d => d.toLowerCase() === seenDest(s).toLowerCase()),
      connected: s => settings.get().targets.hosts.some(h => sameDest(h, seenDest(s), s.port) && ["ready", "stalled", "connecting"].includes(conns.get(h.id)?.state ?? "closed")),
      questionUp,
      offer: s => showSeenOffer(s),
      now: () => parts.now().getTime(),
    });
    const t = parts.setInterval(() => { try { noticer?.tick(); } catch (err) { log.warn("targets.notice_failed", { err }); } }, NOTICE_TICK_MS);
    t.unref?.();
    noticeTimer = t;
  }
  function offerWsl(): void {
    if (wslOffered || questionUp()) return;
    wslOffered = true;
    bubble("offer:wsl", {
      title: "Ember can work in WSL", thought: "It can read and use your Linux apps and run commands there. Turn it on in settings?",
      actions: [{ id: "offer:wsl:settings", label: "Open settings", primary: true }, { id: "offer:wsl:later", label: "Not now" }], mood: "attention",
    });
  }

  // ── Start ──
  rebuild();
  // A remote picked last time isn't connected after a restart: work here until it is again.
  if (parseTargetId(settings.get().targets.active)?.kind === "ssh") {
    try { settings.update({ targets: { ...settings.own().targets, active: LOCAL_TARGET } }); } catch (err) { log.warn("targets.active_reset_failed", { err }); }
  }
  if (wsl && wslOn()) void refreshWsl();
  const offs: (() => void)[] = [];
  try { offs.push(settings.onChange(() => refresh())); } catch (err) { log.warn("targets.settings_listen_failed", { err }); }
  if (wsl) { try { offs.push(wsl.onChange(f => { wslFacts = f; refresh(); })); } catch (err) { log.warn("targets.wsl_listen_failed", { err }); } }
  if (connections) {
    const cs = connections;
    try {
      offs.push(cs.onProgress((hostId, p) => {
        const c = conns.get(hostId);
        if (p.step === "ready") {
          // SA brought the link back by itself (a reconnect after a loss): the target is rebuilt on the new link. Never
          // for a host the user disconnected meanwhile, and never for another computer than the one the user said yes
          // to under this name (§7.4): that one is let go, and Reconnect (an interactive connect) shows the card again.
          const link = cs.link(hostId);
          if (!link || !c || c.state === "connecting" || c.state === "closed" || c.link === link) return;
          const host = hostOf(hostId);
          if (host && machineChanged(host, link.welcome.machineIdHash)) {
            log.warn("targets.reconnect_machine_changed", { host: hostId });
            void cs.disconnect(hostId).catch(() => undefined);
            dropTarget(c);
            c.state = "lost";
            bubble(`lost:${hostId}`, {
              title: `Lost ${hostId}`, thought: `${hostId} came back as a different computer, so Ember didn't use it. Reconnect to check it.`,
              actions: [{ id: `conn:${hostId}:reconnect`, label: "Reconnect", primary: true }], mood: "error",
            });
            refresh();
            return;
          }
          if (adopt(hostId, link)) { hideBubble(`lost:${hostId}`); refresh(); }
          return;
        }
        if (c?.state !== "connecting") return;
        const words = progressWords(hostId, p);
        if (words) bubble(`connecting:${hostId}`, { title: `Connecting to ${hostId}…`, thought: words, actions: [{ id: `conn:${hostId}:cancel`, label: "Cancel" }], mood: "thinking" });
      }));
    } catch (err) { log.warn("targets.progress_listen_failed", { err }); }
  }
  refresh();

  // ── What the agent asks ──
  const bindingOf = (e: TargetEntry): TargetBinding => {
    if (e.kind === "local") return localBinding(deps.os, !!deps.localHands);
    if (e.kind === "wsl") return wslBinding(e.distro ?? { name: e.id.slice(4), version: 2 }, !!deps.localHands);
    const t = e.host ? conns.get(e.host.id)?.target : null;
    if (t) { try { return t.parts.binding(); } catch (err) { log.warn("targets.binding_failed", { err }); } }
    return hostBinding(e.host ?? { id: e.id.slice(4), resolved: { user: "", hostname: "", port: 22, jump: [] } });
  };
  let base: HandsBase | null = null;
  /** What commands-only hands carry when this screen has none: main's audit and Confirmer, and the PC's policy rules. */
  const handsBase = (): HandsBase | null => {
    const audit = deps.audit();
    const confirmer = deps.confirmer();
    if (!audit || !confirmer) return null;
    if (!base || base.audit !== audit || base.confirmer !== confirmer) {
      base = {
        audit, confirmer,
        policy: new PolicyEngine({
          neverLook: () => settings.get().privacy.neverLook, grants: () => settings.get().grants,
          rateLimit: admin().policy.maxActionsPerMinute, actionsAllowed: () => admin().policy.features.actions !== false,
          confirmEveryAction: () => admin().policy.confirmEveryAction, allowGrants: () => admin().policy.allowGrants,
          isTerminalApp: name => isTerminalWindowApp(name, deps.sys.apps, deps.os), keys: deps.sys.keys, os: deps.os,
          isSecurityWindow: deps.sys.privacy.isSecurityWindow,
        }),
      };
    }
    return base;
  };
  /** A target's commands when they aren't off (its facts read once now, so its shells are its own). */
  const liveCommands = (svc: CommandService | null): CommandService | null => {
    if (!svc || safeState(svc) === "off") return null;
    try { (svc as Partial<WarmService>).warm?.(); } catch { /* the shells stay the defaults */ }
    return svc;
  };
  const refuse = (why: string) => ({ ok: false as const, why });
  /** SC's desktop.state request for a remote (it never rejects; a failure leaves the binding as it was). */
  const desktopNow = (t: RemoteTarget): Promise<unknown> => {
    const refresh = (t.parts as Partial<RemoteTargetExtras>).refreshDesktop;
    if (typeof refresh !== "function") return Promise.resolve();
    try { return refresh().catch(() => undefined); } catch (err) { log.warn("targets.desktop_refresh_failed", { err }); return Promise.resolve(); }
  };
  const handsFor = (id: TargetId): { ok: true; hands: TargetHands } | { ok: false; why: string } => {
    try {
      if (!parseTargetId(id)) return refuse("Ember doesn't know that computer.");
      rebuild();
      const e = entryOf(id);
      if (!e) return refuse("Ember doesn't know that computer, or can't work there now.");
      // A connected remote's desktop is asked for before every task (§5.3.4 step 8): that starts its desktop helper and
      // notice there, and is the only way access comes back after a lock, so it goes out even when this one is refused.
      const live = e.kind === "ssh" && e.host ? conns.get(e.host.id) : undefined;
      const asking = live?.target && live.state === "ready" && live.target.link.state === "ready" ? desktopNow(live.target) : null;
      if (e.listedOnly || !e.usable) return refuse(e.why ?? `Ember can't work on ${e.label} now.`);
      if (e.kind === "ssh") {
        const c = e.host ? conns.get(e.host.id) : undefined;
        const t = c?.target;
        if (!t || !asking || c?.state !== "ready" || t.link.state !== "ready") return refuse(e.why ?? `${e.label} isn't connected. Connect it from Ember's menu first.`);
        const audit = deps.localHands?.audit ?? deps.audit();
        const confirmer = deps.localHands?.confirmer ?? deps.confirmer();
        if (!audit || !confirmer) return refuse("Ember can't keep its record of what it does, so it won't work there.");
        const commands = liveCommands(t.service);
        // Reads and steps wait for the desktop's answer.
        const hands = remoteHands({ hostId: t.hostId, parts: t.parts, base: { audit, confirmer }, commands, ready: () => asking });
        if (hands.binding.desktop === "none" && !commands) return refuse(`${e.label} has no desktop Ember can use, and commands are off there.`);
        return { ok: true, hands };
      }
      const binding = bindingOf(e);
      const commands = liveCommands(commandsOf(id));
      if (binding.desktop === "none" && !commands) {
        return refuse(e.kind === "local"
          ? "Ember can't use this computer's screen here, and commands are off. Tell the user they can turn commands on in Ember's settings."
          : `${binding.desktopWhy ?? `Ember can't use ${e.label}'s screen.`} Commands are off there; the user can turn them on in Ember's settings.`);
      }
      const hands = screenHands({ hands: deps.localHands, base: deps.localHands ? null : handsBase(), binding, system, commands });
      if (!hands) return refuse("Ember can't keep its record of what it does, so it won't work here.");
      return { ok: true, hands };
    } catch (err) {
      log.error("targets.hands_failed", { err });
      return refuse("Ember can't work there right now.");
    }
  };
  const bind = (o: { userWords: string; choice?: string }): { ok: true; binding: TargetBinding } | { ok: false; why: string } => {
    try {
      rebuild();
      const words = typeof o.userWords === "string" ? o.userWords : "";
      const usableNamed = targetsNamed(words, namedTargets(entries), deps.os);
      if (!usableNamed.length) {
        // A place the user named that Ember lists but can't work in yet (WSL off, a distro to set up): say why.
        const listed = entries.filter(e => e.listedOnly);
        const hit = targetsNamed(words, listed.map(e => ({ id: e.id, names: e.names })), deps.os)[0];
        const e = hit ? entryOf(hit) : null;
        if (e) {
          if (e.kind === "wsl" && !wslOn()) offerWsl();
          return refuse(e.why ?? NOT_NAMED);
        }
        // "In WSL" on a Windows PC where Ember has no distros listed (WSL off and not looked at yet, or none found).
        if (deps.os === "win32" && !entries.some(x => x.kind === "wsl") && targetsNamed(words, [{ id: "wsl:WSL", names: [...WSL_WORDS] }], deps.os).length) {
          if (!wslAllowed(admin())) return refuse("Your organisation doesn't allow Ember to work in WSL.");
          if (!wsl) return refuse("WSL isn't installed on this computer.");
          // Discovery has looked and found no distro Ember could use (WSL's installer alone, or only tools' distros).
          const none = "WSL has no Linux distro Ember can use on this computer.";
          if (wslFacts && !defaultDistro(wslFacts)) return refuse(none);
          if (!wslOn()) {
            // "Ember can work in WSL" only once discovery shows a distro to work in (it reads the registry; nothing starts).
            void refreshWsl().then(() => { if (defaultDistro(wslFacts)) offerWsl(); });
            return refuse("WSL isn't turned on for Ember. Tell the user they can turn it on in Ember's settings (Computers).");
          }
          void refreshWsl();
          return refuse("Ember is still finding WSL's distros. Try again in a moment.");
        }
      }
      const r = bindTarget({ userWords: words, ...(o.choice !== undefined ? { choice: o.choice } : {}), targets: namedTargets(entries), active: activeId(), os: deps.os });
      if (!r.ok) return r;
      const e = entryOf(r.id);
      return e ? { ok: true, binding: bindingOf(e) } : refuse(NOT_NAMED);
    } catch (err) {
      log.error("targets.bind_failed", { err });
      return refuse("Ember can't tell where to work right now.");
    }
  };
  /** "on for this computer", "off in Ubuntu (WSL)", "waiting for the user's OK on build-01". */
  const commandsWords = (e: TargetEntry): string => {
    const cap = safeCap(commandsOf(e.id));
    const state = cap?.state ?? "off";
    const where = e.kind === "local" ? "for this computer" : e.kind === "wsl" ? `in ${e.label}` : `on ${e.label}`;
    const how = state === "on" ? (cap?.askEvery ? "on, asking before every command," : "on") : state === "needs-consent" ? "waiting for the user's OK" : "off";
    return `${how} ${where}`;
  };
  const describeTargets = (): string => {
    try {
      rebuild();
      const a = activeId();
      const lines = bindable(entries).map(e => {
        const kind = e.kind === "local" ? (deps.os === "win32" ? "Windows" : deps.os === "darwin" ? "macOS" : "Linux") : e.kind === "wsl" ? "WSL" : "SSH";
        const conn = e.kind !== "ssh" ? "" : e.state === "ready" ? `, connected as ${e.login}` : e.state === "connecting" ? ", connecting" : ", not connected";
        const set = e.id === a ? ", Ember is set to work here" : "";
        const t = e.kind === "ssh" && e.host ? conns.get(e.host.id)?.target : null;
        const desktop = e.kind === "ssh" ? (!t ? "not connected" : t.desktop() === "none" ? "no desktop session" : "apps on its screen")
          : bindingOf(e).desktop === "none" ? "no desktop" : e.kind === "wsl" ? "Linux apps on this screen" : "apps";
        const state = safeState(commandsOf(e.id));
        const cmd = state === "on" ? "commands" : state === "needs-consent" ? "commands once the user agrees" : "no commands";
        return `- ${e.label} (${kind}${conn}${set}): ${cmd}; ${desktop}`;
      });
      return `<computers>\n${lines.join("\n")}\n</computers>`;
    } catch (err) {
      log.warn("targets.describe_failed", { err });
      return `<computers>\n- ${LOCAL_LABEL}\n</computers>`;
    }
  };
  const activeLine = (): string => {
    try {
      rebuild();
      const a = activeId();
      const e = entryOf(a);
      const live = bindable(entries);
      const others = live.filter(x => x.kind === "ssh" && x.state === "ready" && x.id !== a);
      const withCommands = live.filter(x => safeState(commandsOf(x.id)) !== "off");
      if (a === LOCAL_TARGET && !others.length && !withCommands.length) return "";
      const out: string[] = [];
      if (e) {
        const conn = e.kind !== "ssh" ? "" : e.state === "ready" && e.login ? `, connected as ${e.login}` : ", which isn't connected";
        const where = e.kind === "local" ? "on this computer" : e.kind === "wsl" ? `in ${e.label}` : `on ${e.label}`;
        out.push(`Ember is set to work ${where}${conn}: ${e.can}.`);
      }
      if (others.length) out.push(`Also connected: ${others.map(o => o.label).join(", ")}.`);
      // WSL's default distro is hidden (a tool's): "WSL" names the first visible one, and the line says which (§2.3 rule 5).
      const def = defaultDistro(wslFacts);
      const wslMeans = def && !def.isDefault ? live.find(x => x.kind === "wsl" && x.distro?.name === def.name) : undefined;
      if (wslMeans) out.push(`"WSL" means ${wslMeans.label}.`);
      out.push(`Commands: ${live.map(commandsWords).join("; ")}.`);
      return `(${out.join(" ")})`;
    } catch (err) {
      log.warn("targets.active_line_failed", { err });
      return "";
    }
  };
  const caps = () => {
    try {
      rebuild();
      const live = bindable(entries);
      // "needs-consent" is a user who turned commands on and must accept a newer card: waiting only for the card.
      return { commands: live.some(e => safeState(commandsOf(e.id)) !== "off"), targets: live.length > 1 };
    } catch (err) {
      log.warn("targets.caps_failed", { err });
      return { commands: false, targets: false };
    }
  };
  const describeScreen = (id: TargetId): Promise<string> | null => {
    const p = parseTargetId(id);
    if (!p || p.kind !== "ssh") return null;
    const c = conns.get(p.name);
    const t = c?.target;
    if (!t || c?.state !== "ready") return Promise.resolve(`${p.name} isn't connected.`);
    if (t.desktop() === "none") return Promise.resolve(`${p.name} has no desktop Ember can see; it can only run commands there.`);
    // Its desktop asked for first, as before a task (that starts its desktop helper there).
    try { return waitingPerception(t.parts.perception, () => desktopNow(t)).describe().catch(() => `${p.name}'s screen couldn't be read.`); } catch { return Promise.resolve(`${p.name}'s screen couldn't be read.`); }
  };
  const offerConnect = (name: string, userWords: string): string => {
    try {
      if (!sshAllowed(admin())) return "Your organisation doesn't allow Ember on other computers. Tell the user.";
      const n = typeof name === "string" ? name.trim() : "";
      if (!n || normaliseName(n).length < 3 || !namedAnywhere(typeof userWords === "string" ? userWords : "", { id: "ssh:x", names: [n] }, deps.os)) {
        return "The user didn't name that computer, so Ember won't offer to connect to it.";
      }
      const key = normaliseName(n);
      const host = settings.get().targets.hosts.find(h => [h.id, hostPart(h.dest), h.resolved.hostname].some(x => normaliseName(x) === key));
      const state = host ? conns.get(host.id)?.state : undefined;
      if (host && state === "ready") return `Ember is already connected to ${host.id}: start the task with target ${host.id}.`;
      if (host && state === "connecting") return `Ember is connecting to ${host.id} now. Start the task once it is connected.`;
      const alias = host ? null : parts.sshConfigHosts().find(h => normaliseName(h) === key) ?? null;
      const label = host?.id ?? alias;
      if (!label) return `Ember doesn't know a computer called ${n}. Tell the user to add it in Ember's settings (Computers).`;
      if (questionUp()) return `Ember can't show the button while a question is waiting. Tell the user to connect ${label} from Ember's menu.`;
      const k = ++offerSeq;
      offers.set(k, { kind: "connect", hostId: host?.id ?? null, alias: label });
      bubble(`offer:${k}`, {
        title: `Connect to ${label}?`, thought: `You asked for ${label}. Ember isn't connected to it yet.`,
        actions: [{ id: `offer:${k}:connect`, label: "Connect", primary: true }, { id: `offer:${k}:later`, label: "Not now" }], mood: "attention",
      });
      return `Ember showed the user a Connect button for ${label}. Tell them to click it; once it is connected, start the task there.`;
    } catch (err) {
      log.warn("targets.offer_connect_failed", { err });
      return "Ember can't offer a connection right now. Tell the user.";
    }
  };
  const agent: TargetsForAgent = {
    get active() { try { return activeId(); } catch { return LOCAL_TARGET; } },
    bind, handsFor, describeTargets, describeScreen, offerConnect, activeLine, caps,
  };

  // ── The picker and the bubble's actions ──
  function pick(id: TargetId): void {
    const e = entryOf(id);
    if (!e || e.listedOnly) return;
    if (e.kind === "ssh" && e.host && e.state !== "ready") { void connect(e.host.id, { interactive: true, activate: true }); return; }
    setActive(id);
  }
  const bubbleAction = (id: string): boolean => {
    if (typeof id !== "string") return false;
    try {
      let m = /^ui:cmdstop:([0-9a-f]{16})$/.exec(id);
      if (m) { commandWindow.cancelAnnounce(m[1]); return true; }
      m = /^ui:panel:(\d+)$/.exec(id);
      if (m) {
        const n = Number(m[1]);
        const p = current?.n === n ? current.question.panel : undefined;
        if (p?.kind === "command") commandWindow.show();
        else if (p?.kind === "consent") { if (promptWindow.show) promptWindow.show(); else promptWindow.showConsent(n, p.consent); }
        return true;
      }
      m = /^target:(.+)$/.exec(id);
      if (m) {
        const t = m[1];
        if (parseTargetId(t)) pick(t as TargetId);
        return true;
      }
      m = /^conn:([a-z0-9][a-z0-9._-]{0,63}):(cancel|disconnect|reconnect|stop)$/.exec(id);
      if (m) {
        const [, hostId, what] = m;
        if (what === "cancel") { conns.get(hostId)?.abort?.abort(); hideBubble(`connecting:${hostId}`); }
        else if (what === "reconnect") { hideBubble(); void connect(hostId, { interactive: true, activate: true }); }
        else { hideBubble(); void disconnect(hostId); }
        return true;
      }
      if (id === "offer:wsl:settings") { hideBubble("offer:wsl"); deps.openSettings("computers"); return true; }
      if (id === "offer:wsl:later") { hideBubble("offer:wsl"); return true; }
      m = /^offer:(\d+):(bring|later|never|connect)$/.exec(id);
      if (m) {
        const k = Number(m[1]);
        const o = offers.get(k);
        offers.delete(k);
        hideBubble(`offer:${k}`);
        if (o?.kind === "seen") {
          if (m[2] === "bring" && (!o.seen.via || o.seen.via === "local" || WSL_SSH_PROVEN)) bringSeen(o.seen);
          else if (m[2] === "never") dismissSeen(o.seen);
        } else if (o?.kind === "connect" && m[2] === "connect") {
          void (o.hostId ? connect(o.hostId, { interactive: true, activate: true }) : addAndConnect({ dest: o.alias }));
        }
        return true;
      }
      // Ours by prefix, but stale or malformed: handled (nothing to do), never passed on as a question's answer.
      return /^(target|offer|conn|ui:panel|ui:cmdstop):/.test(id);
    } catch (err) {
      log.warn("targets.bubble_action_failed", { err });
      return /^(target|offer|conn|ui:panel|ui:cmdstop):/.test(id);
    }
  };

  return {
    agent,
    wsl,
    stopAll: async () => {
      // Every part told at once (step 1 of each ladder is synchronous), then waited for together; nothing throws.
      const waits: Promise<unknown>[] = [];
      const call = (f: () => unknown) => { try { waits.push(Promise.resolve(f())); } catch (err) { log.warn("targets.stop_part_failed", { err }); } };
      call(() => localRunner.stopAll("killswitch"));
      for (const s of wslServices.values()) call(() => s.runner.stopAll("killswitch"));
      // WSLg apps' accessibility helpers too (they start again when a Linux window needs reading).
      call(() => parts.wslHelpers.stop());
      for (const c of conns.values()) {
        if (c.abort) call(() => c.abort?.abort());
        const t = c.target;
        if (t) { call(() => t.link.stop()); call(() => t.parts.runner.stopAll("killswitch")); }
      }
      // SA's own part: reconnects after a loss end, connects under way are cancelled, and a link not (yet) a target here
      // (one awaiting a card, one SA just brought back) is told to stop too.
      const cs = connections;
      if (cs) call(() => cs.stopAll());
      const settled = await Promise.allSettled(waits);
      const failed = settled.filter(r => r.status === "rejected").length;
      if (failed) log.warn("targets.stop_parts_failed", { failed });
    },
    busy: () => {
      let commands = 0;
      const count = (r: CommandRunner) => { try { const n = r.running; if (Number.isFinite(n) && n > 0) commands += Math.floor(n); } catch { /* a runner that can't say counts none */ } };
      count(localRunner);
      for (const s of wslServices.values()) count(s.runner);
      let links = 0;
      for (const c of conns.values()) {
        if (c.target) count(c.target.parts.runner);
        if (c.state === "ready" || c.state === "stalled" || c.state === "connecting") links++;
      }
      return { commands, connections: links };
    },
    menuItems: (): MenuItemLike[] => {
      try {
        rebuild();
        return targetMenu({
          entries, active: activeId(), sshAllowed: sshAllowed(admin()), pick,
          bring: () => deps.openSettings("computers"), disconnect: h => { void disconnect(h); },
        });
      } catch (err) {
        log.warn("targets.menu_failed", { err });
        return [];
      }
    },
    bubbleAction,
    quickContext: (): Promise<QuickContext | null> | null => {
      try {
        const a = activeId();
        const p = parseTargetId(a);
        if (!p || p.kind !== "ssh") return null;
        const c = conns.get(p.name);
        const t = c?.target ?? null;
        return remoteQuickContext({
          id: a, label: p.name, connected: c?.state === "ready" && !!t, desktop: t ? t.desktop() : "none", perception: t?.parts.perception ?? null,
          setTimer: parts.setTimeout, clearTimer: parts.clearTimeout,
        });
      } catch (err) {
        log.warn("targets.quick_context_failed", { err });
        const a = settings.get().targets.active;
        return parseTargetId(a)?.kind === "ssh" ? Promise.resolve(noWindowContext(a, a.slice(4), "its screen couldn't be read.")) : null;
      }
    },
    questionChanged: q => {
      try {
        const was = current;
        current = q && typeof q.n === "number" && q.question ? q : null;
        if (was && (!current || current.n !== was.n)) hidePanel(was);
        if (current && (!was || was.n !== current.n)) showPanel(current);
      } catch (err) {
        log.warn("targets.question_changed_failed", { err });
      }
    },
    panelReady: n => {
      try {
        if (!current || current.n !== n) return false;
        const p = current.question.panel;
        if (p?.kind === "command") return commandWindow.cardReady(n) === true;
        if (p?.kind === "consent") return promptWindow.consentReady(n) === true;
        return false;
      } catch {
        return false;
      }
    },
    questionWords: q => {
      try {
        const p = q?.panel;
        if (!p) return null;
        if (p.kind === "command") {
          const where = p.card.target === LOCAL_TARGET ? "this computer" : p.card.targetLabel;
          return `Ember wants to run a command on ${where}.`;
        }
        const c = p.consent;
        if (c.feature === "commands") return `Ember needs your OK to run commands on ${c.target === LOCAL_TARGET ? "this computer" : c.targetLabel}. Read what it means in the window that opened.`;
        return `${c.title} Read what it means in the window that opened.`;
      } catch {
        return "Ember needs your OK. Read it in the window that opened.";
      }
    },
    doctorRows: async () => {
      const rows = await doctorRowsWith({ os: deps.os, admin, packaged: deps.packaged }, parts.doctor).catch(() => [] as PlatformDoctorRow[]);
      if (wsl) {
        try { rows.push(...await wsl.doctorRows()); } catch (err) { log.warn("targets.wsl_doctor_failed", { err }); }
        // Each running distro's Linux apps and their accessibility (wsl-helper:<d>, wsl-a11y:<d>, §8.8).
        try { rows.push(...await parts.wslHelpers.doctorRows()); } catch (err) { log.warn("targets.wsl_helper_doctor_failed", { err }); }
      }
      for (const [hostId, c] of conns) if (c.target?.link.welcome.tccLimited) rows.push(remoteTccRow(hostId));
      return rows;
    },
    summaries: () => { try { return summaries(); } catch { return []; } },
    applyFix: async (id: string) => {
      const m = /^wsl-a11y:(.+)$/.exec(typeof id === "string" ? id : "");
      if (!m || !DISTRO_NAME.test(m[1])) return { ok: false, message: "Ember doesn't know that fix." };
      const name = m[1];
      if (!wsl || !wslOn()) return { ok: false, message: "WSL isn't turned on for Ember. Turn it on in Ember's settings (Computers)." };
      const d = distroOf(name);
      if (!d || d.needsSetup || isToolDistro(d)) return { ok: false, message: `Ember doesn't use Linux apps in ${name}.` };
      if (d.defaultUid === 0) return { ok: false, message: "Ember doesn't use Linux apps of a distro that runs as root." };
      // Never booted for a fix: the fix is for apps on screen now, and starting a distro is the user's call.
      let running = false;
      try { running = (await wsl.runningNow()).has(name); } catch (err) { log.warn("targets.wsl_running_failed", { err }); }
      if (!running) return { ok: false, message: `Start ${name} first: Ember doesn't start a distro to change its settings.` };
      // Its command service's runner: the kill switch stops the fix as it stops any command there.
      const svc = wslService(name);
      if (!svc) return { ok: false, message: `Ember can't run its fix in ${name}.` };
      const r = await turnOnLinuxAccessibility(svc.runner, name);
      log.info("targets.wsl_a11y_fix", { ok: r.ok });
      return r;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      if (noticeTimer !== null) parts.clearInterval(noticeTimer);
      for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } }
      const waits: Promise<unknown>[] = [];
      const call = (f: () => unknown) => { try { waits.push(Promise.resolve(f())); } catch (err) { log.warn("targets.dispose_part_failed", { err }); } };
      call(() => localRunner.stopAll("quit"));
      for (const s of wslServices.values()) call(() => s.runner.stopAll("quit"));
      for (const c of conns.values()) { c.abort?.abort(); dropTarget(c); }
      const cs = connections;
      if (cs) call(() => cs.dispose());
      call(() => wsl?.dispose());
      call(() => commandWindow.dispose());
      call(() => promptWindow.dispose());
      await Promise.allSettled(waits);
    },
  };
}
