/**
 * The registry of targets (§2.2): which computers exist for Ember right now, what each is called, its state, and what
 * Ember can do there, rebuilt from local data on every change (settings, the admin policy, WSL discovery, the links).
 * Pure: the runtime feeds it facts and keeps the result. A target that is off, lost or unavailable is listed for the
 * settings window but never acted on; Docker's and Rancher's distros are never listed; a distro still waiting for its
 * first-run set-up is never started.
 */

import { FEATURE_CONSENT_VERSION } from "../../shared/consent";
import type { OS } from "../../shared/shortcuts";
import { LOCAL_TARGET, targetIdOf, DISTRO_NAME, HOST_ID, type TargetId, type TargetKind, type TargetSummary } from "../../shared/targets";
import type { LoadedAdminPolicy } from "../admin";
import type { CommandCapability } from "../commands/types";
import type { HostRecord } from "../remote/types";
import type { DesktopState } from "../remote/protocol";
import type { Settings } from "../settings";
import type { WslDistro, WslFacts } from "../wsl/types";
import type { DesktopAccess } from "./types";
import { WSL_WORDS, type NamedTarget } from "./resolve";

/** This computer's label everywhere a target is named (§8.1). */
export const LOCAL_LABEL = "This computer";

/** Distros that belong to a tool and are never listed (R3; critique wsl-22). */
const HIDDEN_DISTRO = /^(docker-desktop|rancher-desktop)(-data)?$/i;
/** Podman's machine: commands only, every command asked (§2.2). */
const PODMAN_DISTRO = /^podman-machine/i;

/** A link's state as the registry shows it ("stalled" is ready with a warning; "closed" is off). */
export type LinkState = "connecting" | "ready" | "stalled" | "lost" | "closed";

/** What the registry knows about one SSH host's connection now. */
export interface LinkView {
  state: LinkState;
  /** The remote's desktop now (welcome, then desktop.changed); absent while connecting. */
  desktop?: DesktopAccess;
  /** Commands there now (the combined policy, the switch, the card). */
  commands?: CommandCapability["state"];
  /** Why they are off there, in the capability's own words (who turned them off, and how to turn them on). */
  commandsWhy?: string;
}

/** One target as the runtime keeps it. */
export interface TargetEntry {
  id: TargetId;
  kind: TargetKind;
  label: string;
  login?: string;
  state: TargetSummary["state"];
  can: string;
  /** Ember may act there now (ready, or a stopped distro that commands start). */
  usable: boolean;
  /** Listed for the settings window only: not a target a task can bind to (WSL off, a distro to set up first). */
  listedOnly: boolean;
  /** Why it can't be used now, in plain words for the model and the bubble. */
  why?: string;
  names: string[];
  distro?: WslDistro;
  host?: HostRecord;
  /** "stalled": shown as ready with a warning. */
  stalled?: boolean;
}

/** Everything the registry is built from. */
export interface RegistryInput {
  os: OS;
  admin: LoadedAdminPolicy;
  settings: Settings;
  /** This screen has a window system (local's desktop is "screen"). */
  localDesktop: boolean;
  /** Commands on each target id (its CommandService's capability state, or "off" when none). */
  commands: (id: TargetId) => CommandCapability["state"];
  /** WSL discovery's last answer (Windows, WSL allowed); null: not known yet or no WSL. */
  wsl: WslFacts | null;
  links: ReadonlyMap<string, LinkView>;
}

/** WSL is allowed by the administrator (features.wsl, or a policy that can't be read). */
export function wslAllowed(admin: LoadedAdminPolicy): boolean {
  return !admin.error && admin.policy.features.wsl !== false;
}

/** SSH is allowed by the administrator. */
export function sshAllowed(admin: LoadedAdminPolicy): boolean {
  return !admin.error && admin.policy.features.ssh !== false;
}

/** A distro's label ("Ubuntu (WSL)"). */
export function distroLabel(name: string): string {
  return `${name} (WSL)`;
}

/** The distro "WSL" and "in Linux" name: the default one, or the first visible one when the default is hidden (§2.3). */
export function defaultDistro(facts: WslFacts | null): WslDistro | null {
  const visible = (facts?.distros ?? []).filter(d => DISTRO_NAME.test(d.name) && !HIDDEN_DISTRO.test(d.name) && !d.needsSetup);
  return visible.find(d => d.isDefault) ?? visible[0] ?? null;
}

/** The host part of a destination ("deploy@build-01:22" → "build-01"), as the user would say it. */
export function hostPart(dest: string): string {
  const at = dest.lastIndexOf("@");
  let h = at >= 0 ? dest.slice(at + 1) : dest;
  if (h.startsWith("[")) h = h.slice(1, h.indexOf("]") > 0 ? h.indexOf("]") : undefined);
  else if (h.split(":").length === 2) h = h.split(":")[0];
  return h;
}

/** What "can" says for commands of one state. */
const commandsWord = (s: CommandCapability["state"]): string => (s === "on" ? "commands" : s === "needs-consent" ? "commands once you agree" : "");

/** "apps and commands", "commands only", "Linux apps"… (§2.1's examples). */
function canWords(apps: string | null, commands: CommandCapability["state"]): string {
  const c = commandsWord(commands);
  if (apps && c) return `${apps} and ${c}`;
  if (apps) return apps;
  return c ? `${c} only` : "nothing yet";
}

/** The local entry. */
function localEntry(i: RegistryInput): TargetEntry {
  const cmd = i.commands(LOCAL_TARGET);
  const can = i.localDesktop ? canWords("apps", cmd) : canWords(null, cmd);
  const usable = i.localDesktop || cmd !== "off";
  return {
    id: LOCAL_TARGET, kind: "local", label: LOCAL_LABEL, state: "ready", can, usable, listedOnly: false, names: [LOCAL_LABEL],
    ...(usable ? {} : { why: "Ember can't use this computer's screen here, and commands are off. Tell the user they can turn commands on in Ember's settings." }),
  };
}

/** The WSL entries: every visible distro, as targets when WSL is on, listed for settings otherwise. */
function wslEntries(i: RegistryInput): TargetEntry[] {
  if (i.os !== "win32" || !wslAllowed(i.admin) || !i.wsl?.installed) return [];
  // On only with the card accepted at its current version (a newer card asks again).
  const on = i.settings.targets.wsl.on && i.settings.targets.wsl.consent.version >= FEATURE_CONSENT_VERSION.wsl;
  const def = defaultDistro(i.wsl);
  const out: TargetEntry[] = [];
  for (const d of i.wsl.distros) {
    if (!DISTRO_NAME.test(d.name) || HIDDEN_DISTRO.test(d.name)) continue;
    const id = targetIdOf("wsl", d.name);
    const label = distroLabel(d.name);
    const cmd = i.commands(id);
    const tool = d.tool === "podman" || PODMAN_DISTRO.test(d.name);
    // WSL 1 runs no WSLg and a tool's distro has no apps of the user's: commands only (§1.3, §2.2).
    const apps = d.version === 2 && !tool && i.localDesktop ? "Linux apps" : null;
    const names = [d.name, label, ...(def && def.name === d.name ? WSL_WORDS : [])];
    if (d.needsSetup) {
      out.push({ id, kind: "wsl", label, state: "unavailable", can: "set it up first", usable: false, listedOnly: true, names, distro: d,
        why: `Set up ${d.name} first: open it from the Start menu once.` });
      continue;
    }
    if (!on) {
      out.push({ id, kind: "wsl", label, state: "unavailable", can: "WSL is off in Ember", usable: false, listedOnly: true, names, distro: d,
        why: "WSL isn't turned on for Ember. The user can turn it on in Ember's settings (Computers)." });
      continue;
    }
    const usable = apps !== null || cmd !== "off";
    const can = d.version === 1 && cmd !== "off" ? "WSL 1: commands only" : canWords(apps, cmd);
    out.push({
      id, kind: "wsl", label, state: d.running ? "ready" : "off", can, usable, listedOnly: false, names, distro: d,
      ...(usable ? {} : { why: `${d.name} runs ${d.version === 1 ? "WSL 1, which shows no Linux apps" : "only a tool's work"}, and commands are off there. The user can turn them on in Ember's settings.` }),
    });
  }
  return out;
}

/**
 * Why a known computer that isn't connected can't take a task: offer_connect puts a Connect button in the bubble, as it
 * does for a computer Ember doesn't know yet, so the model is pointed there, not at a menu (review #197).
 */
export function notConnectedWhy(label: string): string {
  return `${label} isn't connected. Ember can offer a Connect button for it (offer_connect).`;
}

/** The SSH entries: one per host record, while the administrator allows SSH. */
function sshEntries(i: RegistryInput): TargetEntry[] {
  if (!sshAllowed(i.admin)) return [];
  const out: TargetEntry[] = [];
  for (const h of i.settings.targets.hosts) {
    if (!HOST_ID.test(h.id)) continue;
    const id = targetIdOf("ssh", h.id);
    const link = i.links.get(h.id);
    const label = h.id;
    const names = [...new Set([h.id, hostPart(h.dest), h.resolved.hostname, h.dest.includes("@") ? "" : h.dest].filter(Boolean))];
    const base = { id, kind: "ssh" as const, label, login: h.resolved.user, names, host: h, listedOnly: false };
    if (!link || link.state === "closed") {
      out.push({ ...base, state: "off", can: "not connected", usable: false, why: notConnectedWhy(label) });
      continue;
    }
    if (link.state === "connecting") {
      out.push({ ...base, state: "connecting", can: "connecting…", usable: false, why: `Ember is still connecting to ${label}. Try again once it is connected.` });
      continue;
    }
    if (link.state === "lost") {
      // The menu's item is disabled while lost: the bubble's Reconnect, offer_connect's button or Settings (review #197).
      out.push({ ...base, state: "lost", can: "connection lost", usable: false,
        why: `The connection to ${label} dropped. Ember can offer a Connect button for it (offer_connect), or the user can reconnect it in Ember's settings (Computers).` });
      continue;
    }
    const cmd = link.commands ?? "off";
    const apps = link.desktop === "screen" || link.desktop === "text" ? "apps" : null;
    const usable = link.state === "ready" && (apps !== null || cmd !== "off");
    const can = link.state === "stalled" ? "isn't answering" : canWords(apps, cmd);
    out.push({
      ...base, state: "ready", can, usable, ...(link.state === "stalled" ? { stalled: true } : {}),
      ...(link.state === "stalled" ? { why: `${label} isn't answering right now. Try again in a moment.` }
        : usable ? {} : { why: `${label} has no desktop Ember can use. ${link.commandsWhy ?? "Commands are off there."}` }),
    });
  }
  return out;
}

/** Every target Ember knows now: "local" first, then WSL distros, then SSH hosts (§2.2). */
export function buildRegistry(i: RegistryInput): TargetEntry[] {
  return [localEntry(i), ...wslEntries(i), ...sshEntries(i)];
}

/** The targets a task can bind to (listed-only rows left out). */
export function bindable(entries: readonly TargetEntry[]): TargetEntry[] {
  return entries.filter(e => !e.listedOnly);
}

/** The names each bindable target answers to, for targetsNamed. */
export function namedTargets(entries: readonly TargetEntry[]): NamedTarget[] {
  return bindable(entries).map(e => ({ id: e.id, names: e.names }));
}

/** The picker's choice if it still names a target a task can bind to, else "local". */
export function activeOf(entries: readonly TargetEntry[], wanted: TargetId): TargetId {
  return bindable(entries).some(e => e.id === wanted) ? wanted : LOCAL_TARGET;
}

/** What the renderers get (settings, the handle's badge). */
export function summaryOf(e: TargetEntry, active: TargetId): TargetSummary {
  return { id: e.id, kind: e.kind, label: e.label, ...(e.login ? { login: e.login } : {}), state: e.state, can: e.can, active: e.id === active };
}

/** A remote's desktop as the registry shows it: what the agent reported (§5.4). */
export function desktopOf(d: DesktopState | undefined): DesktopAccess | undefined {
  return d?.access;
}
