/**
 * Why a connection failed, in Ember's words (§5.1.8, messages §8.7). ssh's stderr is matched against OpenSSH's own
 * fixed texts only; everything else it holds (banners, motd, shell noise, a ProxyCommand's chatter) is untrusted and
 * never reaches the model, the bubble or the audit: at most one offending configuration line is quoted, cleaned and
 * cut short. Pure.
 */

import type { OS } from "../../shared/shortcuts";

/** A failure as the settings window and the bubble show it. */
export interface SshFailure {
  /** The class (§5.1.8): unknown-host-key, host-key-changed, auth, too-many-keys, dns, network, config, timeout, no-setup, not-posix, remote, unknown… */
  kind: string;
  message: string;
  /** A second sentence that says what to do, when there is one. */
  fix?: string;
  /** Trying again later (or interactively) may work. */
  retry: boolean;
}

/** Control and bidi characters out, whitespace runs single, at most `max` characters: a remote string made safe to show. */
export function cleanLine(s: string, max = 200): string {
  const t = String(s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim(); // eslint-disable-line no-control-regex -- control characters are exactly what's removed
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Every §8.7 message that names a host, built from its label ("build-01"). */
export const MESSAGES = {
  noClient: () => "Ember can't find SSH on this computer. Install OpenSSH (Linux: `sudo dnf install openssh-clients`; Windows: Settings › Apps › Optional features › OpenSSH Client), then try again.",
  tooOld: () => "Ember needs OpenSSH 7.6 or newer.",
  tooOldWindows: () => "Ember needs OpenSSH 8.1 or newer: update the OpenSSH Client in Settings › Apps › Optional features.",
  dns: (h: string) => `Ember can't find ${h}. Check the name, or add it to your SSH config.`,
  network: (h: string, reason: string) => `Ember can't reach ${h} (${reason}). Check you're on the right network or VPN.`,
  localNetwork: (h: string) => `If ${h} is on your local network, allow Ember in System Settings › Privacy & Security › Local Network.`,
  config: (h: string, line: string) => `Your SSH settings for ${h} have a line this SSH can't use: ${line}. Fix or remove it, then connect again.`,
  timeout: (h: string) => `${h} took too long to answer (a jump host or sign-in helper may be waiting).`,
  noSetup: (h: string) => `${h} didn't run Ember's set-up (it may be Windows, or this login runs a fixed program).`,
  authNoAskpass: (h: string) => `${h} didn't accept your key. Add it to the ssh-agent (\`ssh-add\`), then connect again.`,
  signInFailed: (h: string) => `${h} didn't accept that sign-in.`,
  unknownKeyNoAskpass: (h: string) => `Connect once with \`ssh ${h}\` in a terminal, check its key, then try again.`,
  unknownKey: (h: string) => `This computer hasn't connected to ${h} before.`,
  keyChanged: (h: string) => `The key ${h} shows isn't the one this computer knows. Someone may be pretending to be ${h}, or it was reinstalled. Ember won't connect.`,
  keyChangedFix: (h: string) => `If you know why it changed, remove the old key in a terminal with \`ssh-keygen -R ${h}\`, then connect again.`,
  knownHostsDiscarded: (h: string) => `${h}'s settings throw host keys away, so Ember can't check it's really ${h}.`,
  jumpWindows: () => "Ember can't connect through a jump host from Windows yet.",
  jumpTooMany: (h: string) => `Ember can connect to ${h} through at most 3 jump hosts.`,
  jumpNested: (h: string) => `Ember can't connect to ${h}: its jump host goes through another jump host of its own.`,
  jumpUnusable: (h: string) => `Ember can't use the jump host your SSH settings give for ${h}.`,
  jumpViaWsl: (h: string) => `Ember can't connect to ${h} through a jump host from a WSL distro.`,
  tooManyKeys: (h: string) => `${h} refused after too many keys. Add \`IdentitiesOnly yes\` and the right \`IdentityFile\` for ${h} to your SSH config.`,
  notPosix: (h: string) => `${h} runs Windows: Ember can't work there yet.`,
  unsupported: (os: string, cpu: string) => `Ember can't work on ${os} ${cpu} computers yet.`,
  glibc: (h: string) => `${h}'s system is too old for Ember (it needs glibc 2.28 or newer, as in RHEL 8 or Ubuntu 20.04).`,
  musl: (h: string) => `${h}'s system uses musl, which Ember can't work with yet (it needs glibc 2.28 or newer).`,
  kernel: (h: string) => `${h}'s system is too old for Ember (it needs Linux 4.18 or newer).`,
  macos: (h: string) => `${h}'s system is too old for Ember (it needs macOS 13.5 or newer).`,
  tools: (h: string, missing: readonly string[]) => `${h} is missing ${missing.join(", ")}, which Ember's set-up needs there.`,
  disk: (h: string) => `${h} doesn't have room for Ember's helper (it needs about 400 MB in your home folder).`,
  noexec: (h: string) => `${h} doesn't let programs run from your home folder, so Ember can't run there.`,
  execDenied: (h: string) => `${h}'s security software doesn't let programs from your home folder run. Ask its administrator to allow Ember's helper (fapolicyd trust), or to install the Ember remote package.`,
  integrity: (h: string, file: string) => `Ember's helper didn't arrive intact on ${h} (${file}). Try again.`,
  sameMachine: (h: string) => `${h} is this computer. Ember already works here.`,
  sameMachineWsl: (h: string) => `${h} is WSL on this computer: use it as WSL instead.`,
  notAllowed: (h: string) => `Your organisation doesn't allow Ember to connect to ${h}.`,
  remoteNotAllowed: (h: string) => `${h}'s administrator doesn't allow Ember there.`,
  remotePolicyBroken: (h: string) => `${h}'s Ember policy is broken, so Ember won't work there.`,
  remoteProvider: (h: string) => `${h}'s administrator requires its own model service, which Ember on this computer can't use.`,
  remoteModels: (h: string) => `${h}'s administrator allows only models Ember on this computer isn't set to use.`,
  busy: (h: string) => `Ember from another computer is already working on ${h}.`,
  busyInstall: (h: string) => `Another Ember is installing its helper on ${h}. Try again in a minute.`,
  download: (h: string, reason: string) => `Ember couldn't download what it needs for ${h} (${reason}). Check your internet connection, or ask your administrator about a mirror.`,
  downloadMismatch: (h: string) => `Ember couldn't check the Node download for ${h} (it doesn't match the expected file). Try again later.`,
  partsMissing: () => "Ember's helper for other computers is missing from this install. Reinstall Ember.",
  cancelled: () => "Connection cancelled",
  noConsent: (h: string) => `Ember needs your yes before it connects to ${h}.`,
  resolutionChanged: (h: string) => `${h} now resolves to a different computer or login, so Ember asks again before it connects.`,
  machineChanged: (h: string) => `${h} is a different computer than the one you allowed, so Ember asks again before it connects.`,
  answeredOddly: (h: string) => `${h} answered in a way Ember can't check.`,
  lost: (h: string) => `Lost ${h}`,
  helperMissing: (h: string) => `Ember's helper on ${h} went missing during set-up. Try again.`,
  remoteStopped: (h: string, code: string) => `Ember's set-up on ${h} stopped (${code}).`,
  unknown: (h: string) => `Ember couldn't connect to ${h} (SSH stopped without saying why).`,
  sshOff: () => "SSH connections are turned off on this computer.",
  notBuilt: (h: string) => `Ember's helper for ${h} isn't part of this install.`,
} as const;

/** ssh's network failures and the few words Ember shows for each. */
const NETWORK: readonly [RegExp, string][] = [
  [/Connection refused/i, "the connection was refused"],
  [/No route to host/i, "no route to it"],
  [/Connection timed out|Operation timed out/i, "the connection timed out"],
  [/Network is unreachable/i, "the network is unreachable"],
  [/kex_exchange_identification|Connection closed by|closed by remote host/i, "it closed the connection"],
  [/Connection reset by|Connection reset/i, "the connection was reset"],
];

/** stderr lines that mean the user's SSH configuration has something this client can't use (critique remote-18c). */
const CONFIG = /Bad configuration option|Unsupported option|getsockname failed: Not a socket|command-line line 0:|Bad key types|Unsupported Match attribute|keyword .* extra arguments/i;

/**
 * The failure class of an ssh run (§5.1.8). `probeBegan`: the bootstrap printed EMBER-PROBE-BEGIN (so ssh connected
 * and the remote ran sh). `darwinMajor`: this Mac's Darwin major (os.release(); macOS 15 is 24), for the Local Network
 * hint on a LAN address (`lan`). `host`: the label the messages name.
 *
 * Once the probe began, the host key was checked and the login accepted, and stderr also carries whatever the remote
 * printed (its rc files, the script's commands): text there that reads like a host-key, sign-in, name or
 * configuration failure is the remote's, never ssh's, so only a dropped connection and the remote's own end are read.
 */
export function classifySshFailure(stderr: string, exitCode: number | null, o: { probeBegan: boolean; os: OS; darwinMajor?: number; lan?: boolean; host?: string }): SshFailure {
  const h = o.host ?? "that computer";
  const text = String(stderr ?? "");
  if (o.probeBegan) return afterProbe(text, exitCode, h);
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i.test(text)) {
    return { kind: "host-key-changed", message: MESSAGES.keyChanged(h), fix: MESSAGES.keyChangedFix(h), retry: false };
  }
  if (/Host key verification failed\./.test(text)) {
    return { kind: "unknown-host-key", message: MESSAGES.unknownKeyNoAskpass(h), retry: true };
  }
  if (/Too many authentication failures/i.test(text)) {
    return { kind: "too-many-keys", message: MESSAGES.tooManyKeys(h), retry: false };
  }
  if (/Permission denied \(/.test(text)) {
    return { kind: "auth", message: MESSAGES.authNoAskpass(h), retry: true };
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname provided|No such host is known/i.test(text)) {
    return { kind: "dns", message: MESSAGES.dns(h), retry: true };
  }
  for (const [re, reason] of NETWORK) {
    if (re.test(text)) {
      const lanHint = reason === "no route to it" && o.os === "darwin" && (o.darwinMajor ?? 0) >= 24 && o.lan === true;
      return { kind: "network", message: MESSAGES.network(h, reason), ...(lanHint ? { fix: MESSAGES.localNetwork(h) } : {}), retry: true };
    }
  }
  const configLine = text.split(/\r?\n/).find(l => CONFIG.test(l));
  if (configLine !== undefined) {
    return { kind: "config", message: MESSAGES.config(h, cleanLine(configLine)), retry: false };
  }
  if (!o.probeBegan && exitCode !== null && exitCode !== 255) {
    return { kind: "no-setup", message: MESSAGES.noSetup(h), retry: false };
  }
  return { kind: "unknown", message: MESSAGES.unknown(h), retry: true };
}

/** A failure after the probe began (§5.1.8): the connection dropped (ssh's own line, exit 255), or the remote ended. */
function afterProbe(text: string, exitCode: number | null, h: string): SshFailure {
  if (exitCode === null || exitCode === 255) {
    for (const [re, reason] of NETWORK) {
      if (re.test(text)) return { kind: "network", message: MESSAGES.network(h, reason), retry: true };
    }
    return { kind: "unknown", message: MESSAGES.unknown(h), retry: true };
  }
  return { kind: "remote", message: MESSAGES.remoteStopped(h, `exit ${exitCode}`), retry: false };
}

/** A bootstrap `EMBER-ERROR <code> [detail]` line in Ember's words (§5.1.9, §8.7). */
export function bootstrapFailure(code: string, detail: string | undefined, h: string): SshFailure {
  const c = /^[a-z0-9-]{1,32}$/.test(code) ? code : "unknown";
  const file = detail && /^[A-Za-z0-9._/-]{1,100}$/.test(detail) ? detail : c;
  switch (c) {
    case "busy-install": return { kind: "busy-install", message: MESSAGES.busyInstall(h), retry: true };
    case "busy": return { kind: "busy", message: MESSAGES.busy(h), retry: true };
    case "exec-denied": return { kind: "exec-denied", message: MESSAGES.execDenied(h), retry: false };
    case "space": return { kind: "disk", message: MESSAGES.disk(h), retry: false };
    case "integrity": case "unpack": case "manifest": return { kind: "integrity", message: MESSAGES.integrity(h, file), retry: true };
    case "missing": return { kind: "missing", message: MESSAGES.helperMissing(h), retry: true };
    case "not-built": return { kind: "not-built", message: MESSAGES.notBuilt(h), retry: false };
    default: return { kind: "remote", message: MESSAGES.remoteStopped(h, c), retry: false };
  }
}

/** Is `host` (an address) private, loopback-free LAN space: RFC 1918, link-local, or IPv6 ULA/link-local (critique remote-29)? */
export function isLanAddress(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^(fe8|fe9|fea|feb|fc|fd)/i.test(host) && host.includes(":");
}
