/**
 * The first-use consent cards (§8.4) and their records (§7.4): WSL once, SSH per host, commands per target. Each card's
 * text is built here for the PC's OS (the stop chord named as that OS's shortcut, substituted before the text is
 * hashed, so each OS's card is its own text: critique integration-22), and the yes must carry back the SHA-256 of
 * exactly that text. A card's record keeps the version the user said yes to; bumping FEATURE_CONSENT_VERSION asks that
 * card again and nothing else. Plain Node.
 */

import { createHash } from "node:crypto";
import { FEATURE_CONSENT_VERSION, type ConsentPanel } from "../../shared/consent";
import { SHORTCUTS, type OS } from "../../shared/shortcuts";
import type { TargetId } from "../../shared/targets";
import type { HostRecord } from "../remote/types";

/** sha256Hex of a card's title and body, as ConsentPanel.sha256 says. */
export function consentSha256(c: { title: string; body: readonly string[] }): string {
  return createHash("sha256").update(`${c.title}\n${c.body.join("\n")}`, "utf8").digest("hex");
}

/** A card with its hash. */
function panel(o: Omit<ConsentPanel, "sha256">): ConsentPanel {
  return { ...o, sha256: consentSha256(o) };
}

/**
 * The PC's stop chord as the cards name it ("Ctrl+Alt+X"): `key`, the one Ember holds now (its fallback while another
 * app holds the default, D-45b; null while it holds neither), else the OS's default.
 */
const stopLabel = (os: OS, key?: string | null) => (key === undefined ? SHORTCUTS[os].stop.label : key);

/**
 * Where what Ember reads goes, as the cards name it: GitHub Copilot, or the organisation's own model endpoint when the
 * administrator set one (`byok`: the policy's provider; Ember then never uses a GitHub sign-in).
 */
const serviceName = (byok: boolean | undefined) => (byok ? "your organisation's model service" : "GitHub Copilot");

/**
 * The WSL card (§8.4.1). `target` is the distro "WSL" names (or "local" when none is installed yet); `byok`: the
 * organisation's own model service is in use.
 */
export function wslConsent(o: { target: TargetId; targetLabel: string; byok?: boolean }): ConsentPanel {
  return panel({
    feature: "wsl", target: o.target, targetLabel: o.targetLabel,
    title: "Use Ember with WSL?",
    body: [
      "Ember will start a small helper inside each WSL distro that has a Linux app open, so it can read and use those apps the way it reads your other windows. It runs only while a Linux app is open, and never starts a distro on its own.",
      `When you ask something, what Ember read goes to ${serviceName(o.byok)}, as it does for your other windows.`,
      "Ember can also run commands in WSL if you turn commands on for it. Commands in WSL can reach your Windows files and programs.",
    ],
    yes: "Turn on", no: "Not now",
  });
}

/** What the commands card says about the target besides its common text (§8.4.3 line 4). */
export interface CommandsCardFacts {
  kind: "local" | "wsl" | "ssh";
  /** Commands run as root or an elevated administrator there (D4.6). */
  privileged: boolean;
  /** The target is a Windows PC (local Windows: PowerShell on pipes). */
  windows: boolean;
  /** A Podman distro. */
  podman: boolean;
  /** The organisation's own model service is in use (the policy's provider), not GitHub Copilot. */
  byok?: boolean;
}

/** The commands card for one target (§8.4.3). */
export function commandsConsent(o: { os: OS; target: TargetId; targetLabel: string; facts: CommandsCardFacts; stopKey?: string | null }): ConsentPanel {
  const here = o.target === "local" ? "this computer" : o.targetLabel;
  const stop = stopLabel(o.os, o.stopKey);
  const extra: string[] = [];
  if (o.facts.kind === "wsl") extra.push("Commands in WSL can also reach your Windows files and programs.");
  if (o.facts.privileged) extra.push("Commands here run as the administrator, so Ember asks before every one.");
  if (o.facts.windows) extra.push("Commands here run in Windows PowerShell and can't ask you for answers or passwords.");
  if (o.facts.podman) extra.push("Podman uses this distro, so Ember asks before every command here.");
  return panel({
    feature: "commands", target: o.target, targetLabel: o.targetLabel,
    title: `Let Ember run commands on ${here}?`,
    // How to stop it and what it can reach come first (review #270).
    body: [
      `Ember runs commands in its own command window, where you can watch them and stop them. ${stop ?? "Stop everything, in Ember's handle menu and in settings,"} stops everything at once; what a command already changed stays changed. It never types into your own terminal windows.`,
      ...extra,
      "Most commands run straight away. Before anything that deletes or overwrites data, pushes or publishes anywhere, touches passwords or keys, changes the system, or downloads and runs code, Ember stops and asks you. If you asked for exactly that yourself, it tells you first and gives you a few seconds to stop it.",
      `What a command prints goes to ${serviceName(o.facts.byok)} as part of the task. Ember hides passwords and keys it recognises, and never sees what you type into a command. If a command prints something that looks like instructions, Ember doesn't follow it and asks you before every further command in that task.`,
    ],
    yes: "Turn on", no: "Not now",
  });
}

/** What the SSH card knows before connecting (the resolution of `ssh -G`, the carried options, the policy's limits). */
export interface SshCardFacts {
  label: string;
  resolved: HostRecord["resolved"];
  extra?: HostRecord["extra"];
  /** A distro's label when ssh runs inside it (L22). */
  viaLabel?: string;
  /** The PC's administrator turned off remote desktops (`ssh.desktop: false`): commands only. */
  desktopOff: boolean;
  /** How long a command survives a silent link (s): the PC's `ssh.commandGraceSeconds`, else 20. */
  graceSeconds: number;
  /** The machine Ember connected to before isn't the one it reached now (§7.4: asked again). */
  machineChanged?: boolean;
  /** The organisation's own model service is in use (the policy's provider): no GitHub sign-in, nothing to Copilot. */
  byok?: boolean;
  /** What `ssh -G` resolved the name to when the user said yes, when it now resolves it elsewhere (sshChangedFrom). */
  changedFrom?: HostRecord["resolved"];
}

/** "the key ~/.ssh/a and the settings file ~/.ssh/b" from the carried options, or "". */
function carriedWords(extra: HostRecord["extra"] | undefined, shown: (p: string) => string = p => p): string {
  const keys = (extra?.identityFiles ?? []).map(shown);
  const parts: string[] = [];
  if (keys.length === 1) parts.push(`the key ${keys[0]}`);
  else if (keys.length > 1) parts.push(`the keys ${keys.slice(0, -1).join(", ")} and ${keys[keys.length - 1]}`);
  if (extra?.configFile) parts.push(`the settings file ${shown(extra.configFile)}`);
  return parts.join(" and ");
}

/** The longest line a card may have: the prompt window shows none longer (prompt-window.ts validCard). */
export const CARD_LINE_MAX = 2000;

/** The carried options' line, within CARD_LINE_MAX: long paths (up to 16 keys of 1024 characters) shortened in the middle. */
function carriedLine(extra: HostRecord["extra"] | undefined): string | null {
  for (const keep of [Infinity, 200, 60]) {
    const shown = (p: string) => (p.length > keep ? `${p.slice(0, Math.ceil(keep / 2))}…${p.slice(-Math.floor(keep / 2))}` : p);
    const carried = carriedWords(extra, shown);
    if (!carried) return null;
    const line = `It uses ${carried}, as your own ssh did.`;
    if (line.length <= CARD_LINE_MAX) return line;
  }
  return `It uses ${extra?.identityFiles?.length ?? 0} keys${extra?.configFile ? " and a settings file" : ""} from your own ssh command, as it did.`;
}

/** The SSH card for one host (§8.4.2), before the first connection (or a changed resolution or machine). */
export function sshConsent(o: { os: OS; target: TargetId; facts: SshCardFacts; stopKey?: string | null }): ConsentPanel {
  const f = o.facts;
  const stop = stopLabel(o.os, o.stopKey);
  const r = f.resolved;
  const through = r.jump.length ? `, through ${r.jump.join(", ")}` : "";
  const body: string[] = [];
  const was = f.changedFrom;
  if (was) body.push(`Your SSH settings now send ${f.label} to ${r.user}@${r.hostname}, port ${r.port} (before: ${was.user}@${was.hostname}, port ${was.port}). Connect only if you meant to change them.`);
  if (f.machineChanged) body.push(`${f.label} isn't the computer Ember connected to before under this name. Connect only if you know why it changed.`);
  body.push(`Ember will connect to ${f.label} as ${r.user} (${r.user}@${r.hostname}, port ${r.port}${through}) with your own SSH settings and keys.`);
  const carried = carriedLine(f.extra);
  if (carried) body.push(carried);
  if (f.viaLabel) body.push(`It connects from ${f.viaLabel}, with ${f.viaLabel.replace(/ \(WSL\)$/, "")}'s SSH keys.`);
  // What it can reach there and what stays here come before what it copies (review #270).
  body.push(
    f.desktopOff
      ? `Your organisation lets Ember only run commands on ${f.label}.`
      // Built before Ember has looked at the computer (§8.4.2): what it does there is said for each kind it may be.
      : `If ${f.label} has a desktop, Ember reads and uses apps on its screen only when ${r.user} is the person logged in there, and shows a notice with a Stop button while it does. You'll be asked before every step it takes there. On a server with no desktop, or on a Mac, it only runs commands.`,
    `Your voice and ${f.byok ? "the key to your organisation's model service" : "your GitHub sign-in"} stay on this computer. Ember sends ${f.label} only the steps it takes there and the commands it runs. What it reads there goes to ${serviceName(f.byok)} from this computer when you ask something.`,
    `It copies a helper there: about 33 MB (up to about 60 MB where that computer can't unpack the smaller download, as is usual on a Mac), unpacked to about 130 MB in its own folder (~/.local/share/ember-remote, or ~/Library/Application Support/Ember Remote on a Mac). It runs only while Ember is connected and stops when you disconnect, quit Ember or ${stop ? `press ${stop}` : "use Stop everything"}. If the connection drops, a command running there stops within ${f.graceSeconds} seconds.`,
    `${f.label} keeps its own record of what Ember does there.`,
  );
  return panel({ feature: "ssh", target: o.target, targetLabel: f.label, title: `Bring Ember to ${f.label}?`, body, yes: "Connect", no: "Not now" });
}

/** A consent record (settings): the card's version the user said yes to, and when. */
export interface ConsentRecord { version: number; at: string | null }

/** The record a yes to `feature`'s current card leaves. */
export function consentGiven(feature: keyof typeof FEATURE_CONSENT_VERSION, now: Date): ConsentRecord {
  return { version: FEATURE_CONSENT_VERSION[feature], at: now.toISOString() };
}

/** Whether a record covers `feature`'s current card. */
export function consentCurrent(feature: keyof typeof FEATURE_CONSENT_VERSION, r: ConsentRecord | undefined): boolean {
  return !!r && r.version >= FEATURE_CONSENT_VERSION[feature];
}

/** `ssh -G` sends the name to another user, hostname or port than `was`. */
const resolvedElsewhere = (was: HostRecord["resolved"], now: HostRecord["resolved"]): boolean =>
  was.user !== now.user || was.hostname.toLowerCase() !== now.hostname.toLowerCase() || was.port !== now.port;

/**
 * Whether a host's SSH card must be shown (again) before connecting: never accepted at the current version, or `ssh -G`
 * now resolves it to another user, hostname or port than when the user said yes (§7.4).
 */
export function sshNeedsConsent(host: HostRecord, now: HostRecord["resolved"]): boolean {
  return !consentCurrent("ssh", host.consent) || resolvedElsewhere(host.resolved, now);
}

/**
 * What a host resolved to when the user said yes, when its card is asked again only because `ssh -G` now resolves it
 * to another user, hostname or port (the card then leads with what changed); undefined otherwise.
 */
export function sshChangedFrom(host: HostRecord, now: HostRecord["resolved"]): HostRecord["resolved"] | undefined {
  return consentCurrent("ssh", host.consent) && resolvedElsewhere(host.resolved, now) ? host.resolved : undefined;
}

/** Whether the machine reached is another than the one the user consented to (a stored hash that differs). */
export function machineChanged(host: HostRecord, machineIdHash: string): boolean {
  return !!host.machineIdHash && host.machineIdHash !== machineIdHash;
}

/** The answer to a consent card counts as yes only with the hash of exactly what was shown. */
export function consentYes(card: ConsentPanel, a: { ok: boolean; sha256?: string } | null | undefined): boolean {
  return !!a && a.ok === true && typeof a.sha256 === "string" && a.sha256 === card.sha256;
}
