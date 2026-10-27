/**
 * The settings window's Computers and Commands sections (§8.3) and the onboarding line (§8.9), as pure functions: what
 * each row says, which switches and buttons it has and what each one asks the targets runtime to do (TARGETS_IPC's
 * TargetsAct). The page (computers.ts) draws exactly this; ui-copy.test.ts pins the words. Kept apart from copy.ts,
 * which the Windows and macOS packages edit too. Sentence case, British spelling. Renderer-safe.
 */

import type { OS } from "../../shared/shortcuts";
import { parseTargetId, type TargetId, type TargetKind, type TargetSummary, type TargetsAct } from "../../shared/targets";
import type { Settings } from "../../main/settings";
import type { CommandMode } from "../../main/commands/types";

export const COMPUTERS_HEADING = "Computers";
export const COMPUTERS_INTRO = "Ember can work on this computer, in WSL, and on computers you reach over SSH. Your voice and your GitHub sign-in always stay here.";
export const COMMANDS_HEADING = "Commands";
export const COMMANDS_INTRO = "Ember runs commands in its own command window, where you can watch and stop them. It asks first before anything that deletes, publishes, touches secrets or changes the system.";
export const WSL_SWITCH = "Let Ember work in WSL";
export const OFFER_SWITCH = "Offer to bring Ember along when I connect with ssh";
export const ADD_PLACEHOLDER = "An SSH host, e.g. build-01 or deploy@build-01.example.com";
export const ADD_BUTTON = "Connect";
export const ASK_EVERY_SWITCH = "Ask me before every command";
export const OPEN_COMMANDS = "Open the command window";
/** The onboarding list's line (§8.9; new users only, CONSENT_VERSION unchanged): `rest` as the page writes it, WSL on Windows only. */
export const ONBOARDING_LINE = {
  lead: "Other computers and commands",
  rest: " are off until you turn them on: Ember can work on computers you reach over SSH, and run commands in its own window. Each asks you first.",
  restWindows: " are off until you turn them on: Ember can work in WSL, on computers you reach over SSH, and run commands in its own window. Each asks you first.",
} as const;

/** The onboarding line after its bold lead on `os` (the page's own words off Windows). */
export function onboardingRest(os: OS = "linux"): string {
  return os === "win32" ? ONBOARDING_LINE.restWindows : ONBOARDING_LINE.rest;
}

/** What the administrator decides about computers and commands, as the settings window learns it. */
export interface TargetsAdmin {
  /** A policy file is in force (R5: one that doesn't mention commands turns them off). */
  source: string | null;
  features: { wsl?: boolean; ssh?: boolean };
  /** Each kind of target's commands mode, when main sends it (adminSummary(...).commands); absent: not known here. */
  commands?: Partial<Record<TargetKind, CommandMode>>;
  /** The policy limits SSH to some hosts (ssh.allowedHosts), when main sends it. */
  sshHostsLimited?: boolean;
}

/** One button on a row: what it says, what it asks for, and the question it asks first (Remove Ember…). */
export interface RowAction { label: string; act: TargetsAct; confirm?: string; ariaLabel?: string }
export interface ComputerRow { id: TargetId; name: string; detail: string | null; status: string; note: string | null; actions: RowAction[] }
export interface Switch { label: string; checked: boolean; disabled: boolean }

export interface ComputersView {
  local: ComputerRow;
  /** Windows only. */
  wsl: { rows: ComputerRow[]; toggle: Switch | null; managed: string | null } | null;
  ssh: { rows: ComputerRow[]; add: boolean; offer: Switch | null; managed: string[] };
}

export interface CommandsRow {
  id: TargetId;
  kind: TargetKind;
  run: Switch;
  /** "Ask me before every command" under it (shown while commands are on here). */
  askEvery: Switch & { shown: boolean };
  /** "Your organisation asks you to approve every command here." */
  managed: string | null;
}
export interface CommandsView { rows: CommandsRow[]; managed: string[] }

const OFF_LINES: Readonly<Record<TargetKind, string>> = {
  local: "Your organisation has turned off commands on this computer.",
  wsl: "Your organisation has turned off commands in WSL.",
  ssh: "Your organisation has turned off commands on computers reached over SSH.",
};
export const ASK_EVERY_MANAGED = "Your organisation asks you to approve every command here.";
export const WSL_MANAGED = "Your organisation doesn't allow Ember to work in WSL.";
export const SSH_MANAGED = "Your organisation doesn't allow Ember on other computers.";
export const SSH_LIMITED = "Your organisation lets Ember connect only to some computers.";

/** The commands mode for a kind of target: what main sent, else "on" with no policy file, else unknown (null). */
export function modeFor(admin: TargetsAdmin, kind: TargetKind): CommandMode | null {
  if ((kind === "wsl" && admin.features.wsl === false) || (kind === "ssh" && admin.features.ssh === false)) return "off";
  const m = admin.commands?.[kind];
  if (m === "on" || m === "ask" || m === "off") return m;
  return admin.source === null ? "on" : null;
}

/** "Run commands on this computer" / "Run commands in Ubuntu (WSL)" / "Run commands on build-01". */
export function runLabel(kind: TargetKind, label: string): string {
  return kind === "local" ? "Run commands on this computer" : kind === "wsl" ? `Run commands in ${label}` : `Run commands on ${label}`;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function wslStatus(t: TargetSummary): string {
  return t.state === "ready" ? "Running" : t.state === "connecting" ? "Starting…" : t.state === "unavailable" ? "Not available" : "Stopped";
}

function sshStatus(t: TargetSummary | undefined): string {
  if (!t) return "Not connected";
  if (t.state === "ready") return t.can ? `Connected: ${t.can}` : "Connected";
  if (t.state === "connecting") return "Connecting…";
  if (t.state === "lost") return "Lost: trying again";
  if (t.state === "unavailable") return "Not available";
  return "Not connected";
}

/** The Computers section. */
export function computersView(i: { os: OS | undefined; summaries: readonly TargetSummary[]; settings: Settings; admin: TargetsAdmin }): ComputersView {
  const commandsHere = i.settings.commands?.local?.on === true && modeFor(i.admin, "local") !== "off";
  const local: ComputerRow = { id: "local", name: "This computer", detail: null, status: commandsHere ? "Apps and commands" : "Apps", note: null, actions: [] };

  let wsl: ComputersView["wsl"] = null;
  if (i.os === "win32") {
    const allowed = i.admin.features.wsl !== false;
    const rows = !allowed ? [] : i.summaries.filter(t => t.kind === "wsl").map(t => ({
      id: t.id, name: t.label, detail: null, status: wslStatus(t), note: t.can ? cap(t.can) : null, actions: [],
    }));
    wsl = {
      rows,
      toggle: allowed ? { label: WSL_SWITCH, checked: i.settings.targets?.wsl?.on === true, disabled: false } : null,
      managed: allowed ? null : WSL_MANAGED,
    };
  }

  const sshAllowed = i.admin.features.ssh !== false;
  const byId = new Map(i.summaries.filter(t => t.kind === "ssh").map(t => [t.id, t] as const));
  const rows: ComputerRow[] = (i.settings.targets?.hosts ?? []).map(h => {
    const id = `ssh:${h.id}` as TargetId;
    const t = byId.get(id);
    const label = t?.label || h.id;
    const connected = t?.state === "ready" || t?.state === "connecting";
    const actions: RowAction[] = [];
    if (sshAllowed) {
      actions.push(connected
        ? { label: "Disconnect", act: { kind: "disconnect", hostId: h.id }, ariaLabel: `Disconnect ${label}` }
        : { label: "Connect", act: { kind: "connect", hostId: h.id }, ariaLabel: `Connect ${label}` });
    }
    actions.push({ label: "Forget", act: { kind: "forget", hostId: h.id }, ariaLabel: `Forget ${label}` });
    if (sshAllowed) {
      actions.push({
        label: `Remove Ember from ${label}`, act: { kind: "uninstall", hostId: h.id },
        confirm: `Remove Ember's helper from ${label}? Its record of what Ember did there stays on ${label}.`,
      });
    }
    return {
      id, name: label, detail: `${h.resolved.user}@${h.resolved.hostname}`,
      status: sshAllowed ? sshStatus(t) : "Not available", note: null, actions,
    };
  });
  const managed = [...(!sshAllowed ? [SSH_MANAGED] : []), ...(sshAllowed && i.admin.sshHostsLimited ? [SSH_LIMITED] : [])];
  return {
    local,
    wsl,
    ssh: { rows, add: sshAllowed, offer: sshAllowed ? { label: OFFER_SWITCH, checked: i.settings.targets?.offerSsh !== false, disabled: false } : null, managed },
  };
}

/** The Commands section: a switch per target (this computer, each distro, each host), and what the organisation set. */
export function commandsView(i: { summaries: readonly TargetSummary[]; settings: Settings; admin: TargetsAdmin }): CommandsView {
  const ids: { id: TargetId; kind: TargetKind; label: string }[] = [{ id: "local", kind: "local", label: "This computer" }];
  for (const t of i.summaries) {
    const parsed = parseTargetId(t.id);
    if (!parsed || parsed.kind === "local") continue;
    if (parsed.kind === "wsl" && (i.settings.targets?.wsl?.on !== true || i.admin.features.wsl === false)) continue;
    ids.push({ id: t.id, kind: parsed.kind, label: t.label });
  }
  // A host the user added shows even before the runtime lists it.
  for (const h of i.settings.targets?.hosts ?? []) {
    const id = `ssh:${h.id}` as TargetId;
    if (!ids.some(x => x.id === id)) ids.push({ id, kind: "ssh", label: h.id });
  }
  const managed = new Set<string>();
  const rows = ids.map(({ id, kind, label }): CommandsRow => {
    const mode = modeFor(i.admin, kind);
    const own = i.settings.commands?.[id];
    if (mode === "off") managed.add(OFF_LINES[kind]);
    const on = own?.on === true && mode !== "off";
    return {
      id, kind,
      run: { label: runLabel(kind, label), checked: on, disabled: mode === "off" },
      askEvery: { label: ASK_EVERY_SWITCH, checked: mode === "ask" || own?.askEvery === true, disabled: mode === "ask" || !on, shown: on },
      managed: mode === "ask" ? ASK_EVERY_MANAGED : null,
    };
  });
  return { rows, managed: [...managed] };
}

/** The words for an admin feature in the managed line ("Turned off: …"). */
export const TARGET_FEATURE_TEXT: Readonly<Record<string, string>> = { wsl: "working in WSL", ssh: "working on other computers" };

/** Whether an organisation's switch means anything on `os`: WSL's only on Windows, so elsewhere it isn't listed as turned off. */
export function targetFeatureApplies(key: string, os: OS = "linux"): boolean {
  return key !== "wsl" || os === "win32";
}

/** The settings window's bridge for computers (app/preload/home.ts exposes it as `window.emberTargets`): TARGETS_IPC only. */
export interface EmberTargetsApi {
  /** Every target as the runtime sees it (rejects when no runtime answers: then the sections stay hidden). */
  list(): Promise<TargetSummary[]>;
  onChanged(fn: (list: TargetSummary[]) => void): () => void;
  /** Asks the runtime to do something; its answer may carry a message for the user (`{ ok, message }`). */
  act(a: TargetsAct): Promise<unknown>;
}

/** The message an act's answer carries for the user, if any. */
export function actMessage(r: unknown): string | null {
  if (!r || typeof r !== "object") return null;
  const m = (r as { message?: unknown }).message;
  return typeof m === "string" && m.trim() ? m.trim().slice(0, 500) : null;
}

/** A host the user typed, as far as the page checks it (main checks it fully): one word of at most 255 characters. */
export function hostInput(s: string): string | null {
  const t = s.trim();
  return t && t.length <= 255 && !/\s/.test(t) && !t.startsWith("-") ? t : null;
}

/** The add form's hint for something that isn't a host. */
export const ADD_INVALID = "Type a host name, or user@host.";
/** When the targets runtime couldn't be reached for an action. */
export const ACT_FAILED = "That didn't work. Try again.";
