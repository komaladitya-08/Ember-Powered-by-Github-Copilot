/**
 * This computer's commands (§2.5, §3.8.1): the CommandService a worker's run_command uses here, made of RUN's local
 * runner, UI's command window and the switches that decide whether commands may run at all. Also the capability rules
 * every target's service shares: the administrator's mode (R5, D4.7), the user's per-target switch, the commands card
 * at its current version, and what makes every command ask (root or an elevated token, the administrator's "ask", the
 * user's own "Ask before every command", a tool's distro). Nothing here starts a process until a command runs or its
 * facts are first needed, and never while commands are off. Plain Node.
 */

import type { OS } from "../../shared/shortcuts";
import type { TargetId } from "../../shared/targets";
import { commandMode, type LoadedAdminPolicy } from "../admin";
import type { ConsentPanel } from "../../shared/consent";
import type { CommandCapability, CommandMode, CommandRunner, CommandService, CommandWindowPort, RunnerFacts, ShellId } from "../commands/types";
import type { Logger } from "../logger";
import type { SettingsStore } from "../settings";
import type { TargetBinding } from "./types";
import { consentCurrent, consentGiven } from "./consent";

/** One target's command settings (settings.commands[id]). */
export interface TargetCommandsSetting { on: boolean; askEvery: boolean; consent: { version: number; at: string | null } }

/** The words that end "Your organisation has turned off commands …" for each kind (§3.8.2 rule 2). */
const ADMIN_OFF: Readonly<Record<"local" | "wsl" | "ssh", string>> = {
  local: "Your organisation has turned off commands on this computer.",
  wsl: "Your organisation has turned off commands in WSL.",
  ssh: "Your organisation has turned off commands on computers reached over SSH.",
};

/** Where a target's commands run, as a sentence ends ("on this computer", "in Ubuntu (WSL)", "on build-01"). */
export function placeWords(kind: "local" | "wsl" | "ssh", label: string): string {
  return kind === "local" ? "on this computer" : kind === "wsl" ? `in ${label}` : `on ${label}`;
}

/**
 * A target's commands capability now (§2.5): "off" when the administrator's mode is off, the target itself can't take
 * them (`unavailable`), or the user hasn't turned them on; "needs-consent" when the user turned them on but the card was
 * accepted only at an older version; "on" otherwise. `askEvery` says why every command asks, most serious first (the
 * order of decideCommand's rules 4-6).
 */
export function commandCapability(o: {
  kind: "local" | "wsl" | "ssh";
  label: string;
  mode: CommandMode;
  setting: TargetCommandsSetting | undefined;
  unavailable?: string | null;
  privileged: boolean;
  tool: boolean;
}): CommandCapability {
  const askEvery: CommandCapability["askEvery"] = o.privileged ? "root" : o.mode === "ask" ? "admin" : o.setting?.askEvery ? "user" : o.tool ? "tool" : null;
  if (o.mode === "off") return { state: "off", why: ADMIN_OFF[o.kind], askEvery };
  if (o.unavailable) return { state: "off", why: o.unavailable, askEvery };
  if (!o.setting?.on) return { state: "off", why: `Commands are off ${placeWords(o.kind, o.label)}. The user can turn them on in Ember's settings (Commands).`, askEvery };
  if (!consentCurrent("commands", o.setting.consent)) return { state: "needs-consent", askEvery };
  return { state: "on", askEvery };
}

/** settings.commands[id], or undefined. */
export function commandsSetting(settings: SettingsStore, id: TargetId): TargetCommandsSetting | undefined {
  return settings.get().commands[id];
}

/** Remembers the user's yes to a target's commands card: on, the card's version and when (settings). */
export function recordCommandsConsent(settings: SettingsStore, id: TargetId, now = new Date()): void {
  const own = settings.own().commands;
  const was = own[id];
  settings.update({ commands: { ...own, [id]: { on: true, askEvery: was?.askEvery ?? false, consent: consentGiven("commands", now) } } });
}

/** Sets a target's switches (the settings window), keeping its card record. */
export function setCommandsSwitch(settings: SettingsStore, id: TargetId, on: boolean, askEvery?: boolean): void {
  const own = settings.own().commands;
  const was = own[id] ?? { on: false, askEvery: false, consent: { version: 0, at: null } };
  settings.update({ commands: { ...own, [id]: { ...was, on, ...(askEvery !== undefined ? { askEvery } : {}) } } });
}

/** Forgets a target's command settings (a host the user forgot). */
export function forgetCommands(settings: SettingsStore, id: TargetId): void {
  const own = { ...settings.own().commands };
  if (!(id in own)) return;
  delete own[id];
  settings.update({ commands: own });
}

/** The shells each OS offers before its runner has said (§3.3: the default first). */
export function defaultShells(os: OS): ShellId[] {
  return os === "win32" ? ["powershell"] : os === "darwin" ? ["zsh", "bash", "sh"] : ["bash", "sh"];
}

/** A CommandService with its facts read once, on first need, and its shells known from then on. */
export interface WarmService extends CommandService {
  /** Reads the runner's facts now (once; failures are logged), so shells() is the runner's own. */
  warm(): void;
  /** The facts once read (null until then, or when reading them failed). */
  facts(): RunnerFacts | null;
}

/** This computer's CommandService. */
export function createLocalService(o: {
  os: OS;
  log: Logger;
  binding: () => TargetBinding;
  runner: CommandRunner;
  window: CommandWindowPort;
  settings: SettingsStore;
  admin: () => LoadedAdminPolicy;
  /** Ember runs elevated or as root (D4.6). */
  privileged: () => boolean;
}): WarmService {
  const warm = warmFacts(o.runner, o.log, "targets.local_facts_failed");
  const mode = () => commandMode(o.admin(), "local");
  const setting = () => commandsSetting(o.settings, "local");
  const svc: WarmService = {
    get binding() { return o.binding(); },
    capability: () => commandCapability({ kind: "local", label: "This computer", mode: mode(), setting: setting(), privileged: o.privileged(), tool: false }),
    shells: () => shellsOf(warm.facts(), defaultShells(o.os)),
    runner: o.runner,
    window: o.window,
    consented: () => recordCommandsConsent(o.settings, "local"),
    userAskEvery: () => setting()?.askEvery === true,
    mode,
    warm: warm.warm,
    facts: warm.facts,
  };
  return svc;
}

/** What the command flow asks of a target's service beyond the contract (flow.ts CommandConsentSource, CommandTargetGuard). */
export interface FlowExtras {
  /** The target's first-use commands card (§8.4.3) with its text hashed; null when it can't be shown. */
  consentPanel(): ConsentPanel | null;
  /** The labels of the other known computers the user's own words name (D4.4's wrong-target guard). */
  othersNamed(words: string): string[];
}

/**
 * `svc` as a worker gets it: the same service (its binding, runner and window are read through, so the flow's per-runner
 * slots and facts stay its own), plus the flow's extras. A card that can't be built is none (nothing is turned on).
 */
export function withFlowExtras(svc: CommandService, extras: FlowExtras): CommandService & FlowExtras {
  return {
    get binding() { return svc.binding; },
    capability: () => svc.capability(),
    shells: () => svc.shells(),
    get runner() { return svc.runner; },
    get window() { return svc.window; },
    consented: () => svc.consented(),
    userAskEvery: () => svc.userAskEvery(),
    mode: () => svc.mode(),
    consentPanel: () => {
      try { return extras.consentPanel(); } catch { return null; } // no card: commands stay off there
    },
    // A guard that fails throws on: the flow then counts another computer as named (it asks).
    othersNamed: words => extras.othersNamed(words),
  };
}

/** How long a runner whose facts couldn't be read is left alone before they are asked again. */
const FACTS_RETRY_MS = 60_000;

/** A runner's facts, read once on first need (again a minute after a failure), and kept. */
export function warmFacts(runner: CommandRunner, log: Logger, event: string, now: () => number = Date.now): { warm(): void; facts(): RunnerFacts | null } {
  let facts: RunnerFacts | null = null;
  let reading = false;
  let failedAt = -Infinity;
  return {
    warm: () => {
      if (facts || reading || now() - failedAt < FACTS_RETRY_MS) return;
      reading = true;
      let p: Promise<RunnerFacts>;
      try { p = runner.facts(); } catch (err) { p = Promise.reject(err); }
      p.then(f => { facts = f; }, err => { failedAt = now(); log.warn(event, { err }); }).finally(() => { reading = false; });
    },
    facts: () => facts,
  };
}

/** The shells a runner's facts list (the default first), or `fallback` until they are known. */
export function shellsOf(facts: RunnerFacts | null, fallback: ShellId[]): ShellId[] {
  return facts?.shells.length ? [...facts.shells] : fallback;
}

/** One process as a process table lists it: `run` when it carries a command run's marker (the user's work, not Ember's). */
export interface ProcRow { pid: number; ppid: number; run: boolean }
/** A process and its parent; `run` when already known. */
export type ParentRow = Omit<ProcRow, "run"> & { run?: boolean };

/**
 * Ember's own processes from a process table (D4.5): every descendant of Ember's main process (the accessibility
 * helper, the Copilot runtime, ssh and its askpass, WSL helpers, the desk), except a command's run and everything under
 * it, which are the user's work and may be stopped like any other program (critique integration-24, S0b's hand-off).
 */
export function ownTree(rows: readonly ParentRow[], root: number, isRun?: (pid: number) => boolean): number[] {
  const children = new Map<number, ParentRow[]>();
  for (const r of rows) {
    if (r.pid === r.ppid) continue;
    const list = children.get(r.ppid);
    if (list) list.push(r); else children.set(r.ppid, [r]);
  }
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    const p = queue.shift()!;
    for (const c of children.get(p) ?? []) {
      // A row's own `run`, else asked only now: only Ember's descendants are ever looked into.
      if (seen.has(c.pid) || (c.run ?? isRun?.(c.pid) ?? false)) continue;
      seen.add(c.pid);
      out.push(c.pid);
      queue.push(c.pid);
    }
  }
  return out;
}

/** The parent pid in a Linux /proc/<pid>/stat line ("1234 (comm) S 1 …"; comm may hold spaces and parentheses). */
export function statParent(stat: string): number | null {
  const m = /^\s*\d+ \(.*\) \S (\d+) /s.exec(stat);
  return m ? Number(m[1]) : null;
}

/** What reading Linux's process table needs (the real /proc in production; a fake in tests). */
export interface ProcReader {
  pids(): number[];
  stat(pid: number): string | null;
  /** The process's environment (own processes only; null when it can't be read). */
  environ(pid: number): Uint8Array | null;
}

/** Linux's processes and their parents (from stat only). */
export function linuxParents(r: ProcReader): ParentRow[] {
  const rows: ParentRow[] = [];
  for (const pid of r.pids()) {
    const s = r.stat(pid);
    const ppid = s === null ? null : statParent(s);
    if (ppid !== null) rows.push({ pid, ppid });
  }
  return rows;
}

/** The environment marker every command run carries (§3.3). */
const RUN_MARKER = Buffer.from("EMBER_RUN_ID=");

/** A process carries a command run's EMBER_RUN_ID marker in its environment. */
function carriesRunMarker(r: ProcReader, pid: number): boolean {
  const env = r.environ(pid);
  return !!env && Buffer.from(env).includes(RUN_MARKER);
}

/** Linux's process table: parents from stat, a command run by its EMBER_RUN_ID marker (§3.3). */
export function linuxProcTable(r: ProcReader): ProcRow[] {
  return linuxParents(r).map(p => ({ pid: p.pid, ppid: p.ppid, run: carriesRunMarker(r, p.pid) }));
}

/**
 * Ember's own processes on Linux (ownTree over /proc): the environment is read only for Ember's own descendants, never
 * for the user's other programs (whose environments can hold their secrets).
 */
export function linuxOwnPids(r: ProcReader, root: number): number[] {
  return ownTree(linuxParents(r), root, pid => carriesRunMarker(r, pid));
}

/**
 * macOS's process table from `ps -A -o pid=,ppid=,comm=`: a run is a `script` or a shell Ember's main process started
 * itself (that is how every local command starts, §3.3), since another process's environment can't be read cheaply.
 */
export function psProcTable(text: string, root: number): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]), ppid = Number(m[2]);
    rows.push({ pid, ppid, run: ppid === root && /(^|\/)(script|bash|zsh|sh)$/.test(m[3]) });
  }
  return rows;
}
