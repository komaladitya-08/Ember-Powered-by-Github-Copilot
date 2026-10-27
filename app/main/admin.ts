/**
 * Admin lockdown (M8.7): /etc/ember/policy.json on Linux (each OS's location is
 * the platform's policy source, which reuses parseAdminPolicy), written by the machine's
 * administrator. It can only make Ember stricter: turn features off, keep
 * apps out of Ember's sight, require a click for every action, pin or limit
 * models, point Ember at the organisation's own model endpoint (BYOK) and
 * set how long the audit log is kept. Its values override the user's settings.
 * A policy file that exists but can't be read locks Ember down (fail closed).
 */

import fs from "node:fs";
import { z } from "zod";
import type { Settings } from "./settings";
import type { TargetKind } from "../shared/targets";
import type { CommandMode } from "./commands/types";
import { readTextFile, stripBom } from "./text-file";

export const ADMIN_POLICY_FILE = "/etc/ember/policy.json";

/** Where an administrator's policy file lives on a POSIX machine (Windows uses the registry: platform/win32). */
export const ADMIN_POLICY_PATHS: Readonly<{ linux: string; darwin: string }> = {
  linux: "/etc/ember/policy.json",
  darwin: "/Library/Application Support/Ember/policy.json",
};

const name = z.string().min(1).max(100);

const CommandModeSchema = z.enum(["on", "ask", "off"]);

export const AdminPolicySchema = z.object({
  features: z.object({
    /** Listening for "Hey Ember". */
    voice: z.boolean().optional(),
    /** Speaking replies out loud. */
    speak: z.boolean().optional(),
    /** Acting in apps at all (false: Ember only answers, reads and guides). */
    actions: z.boolean().optional(),
    /** Borrowing the user's mouse and keyboard (tier 3). */
    cursor: z.boolean().optional(),
    /** Ember's private desk (tier 2). */
    desk: z.boolean().optional(),
    /** Sending screenshots to the model (accessibility text is still used). */
    screenImages: z.boolean().optional(),
    /** WSL: reading and acting in WSLg apps, and the WSL target (commands are `commands.wsl`). */
    wsl: z.boolean().optional(),
    /** SSH: connecting to other computers (on the PC); on a remote: letting Ember in at all. */
    ssh: z.boolean().optional(),
  }).strict().default({}),
  /** Apps and windows Ember never reads, captures or acts in (added to the user's never-look list). */
  neverLook: z.array(name).max(200).default([]),
  /** Ask the user before every action, even in apps they allowed. */
  confirmEveryAction: z.boolean().default(false),
  /** false: users can't let Ember act in an app without asking ("Always in this app" is off). */
  allowGrants: z.boolean().default(true),
  /** Lower than Ember's own limit only. */
  maxActionsPerMinute: z.number().int().min(1).max(40).optional(),
  models: z.object({
    /** Only these model ids may be used. */
    allowed: z.array(name).min(1).optional(),
    conductor: name.optional(),
    worker: name.optional(),
  }).strict().default({}),
  /** The organisation's own model endpoint (BYOK); Ember then never uses a GitHub sign-in. */
  provider: z.object({
    type: z.enum(["openai", "azure", "anthropic"]),
    baseUrl: z.string().url(),
    /** A file only Ember's users can read, holding the API key. */
    apiKeyFile: z.string().optional(),
    wireApi: z.enum(["completions", "responses"]).optional(),
    azure: z.object({ apiVersion: z.string().optional() }).strict().optional(),
  }).strict().optional(),
  /** Days the audit log is kept (default 30). */
  auditRetentionDays: z.number().int().min(1).max(3650).optional(),
  /** Commands per kind of target (R5: absent in a policy that exists → "off"; D4.7). */
  commands: z.object({
    local: CommandModeSchema.optional(),
    wsl: CommandModeSchema.optional(),
    ssh: CommandModeSchema.optional(),
  }).strict().optional(),
  ssh: z.object({
    /** Patterns of computers Ember may connect to (matched against user@host:port, host:port and host). */
    allowedHosts: z.array(z.string().min(1).max(255)).max(200).optional(),
    /** false: commands only on remotes (no desktop). On a remote: no desktop for Ember arriving over SSH. */
    desktop: z.boolean().optional(),
    /** On a remote: a person at its screen must allow Ember before it reads anything there. */
    requireConsoleConsent: z.boolean().optional(),
    /** Where the PC downloads Node for remotes instead of nodejs.org (same layout; still checked by SHA-256). */
    runtimeMirror: z.string().url().startsWith("https://").optional(),
    /** How long a command on a remote keeps running while the link is silent (L10; default 20; both machines: the smaller). */
    commandGraceSeconds: z.number().int().min(3).max(120).optional(),
  }).strict().optional(),
}).strict();

export type AdminPolicy = z.infer<typeof AdminPolicySchema>;

export interface LoadedAdminPolicy {
  policy: AdminPolicy;
  /** The file in force, if any. */
  source: string | null;
  /** Set when the file exists but couldn't be used: Ember is locked down. */
  error?: string;
}

/** Everything off that could act or listen: used when the policy file is broken. */
const LOCKDOWN: AdminPolicy = AdminPolicySchema.parse({
  features: { voice: false, actions: false, cursor: false, desk: false, screenImages: false, wsl: false, ssh: false },
  allowGrants: false,
  confirmEveryAction: true,
  commands: { local: "off", wsl: "off", ssh: "off" },
});

/** Ember locked down because of `source`: what a policy that exists but can't be used means (fail closed). */
export function lockedDown(source: string, error: string): LoadedAdminPolicy {
  return { policy: LOCKDOWN, source, error };
}

/**
 * The policy in `raw` (JSON text) from `source`, checked against AdminPolicySchema: anything that isn't valid JSON
 * or breaks the schema locks Ember down, naming `source`. Every OS's policy source ends here (the Linux and macOS
 * files, the Windows registry value).
 */
export function parseAdminPolicy(raw: string, source: string): LoadedAdminPolicy {
  try {
    // A byte-order mark is no reason to lock Ember down (review #82).
    const parsed = AdminPolicySchema.safeParse(JSON.parse(stripBom(raw)));
    if (parsed.success) return { policy: parsed.data, source };
    const issue = parsed.error.issues[0];
    return lockedDown(source, `${source}: ${issue.path.join(".") || "(top)"}: ${issue.message}`);
  } catch (err) {
    return lockedDown(source, `${source} is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * Reads the administrator's policy. `file` is /etc/ember/policy.json except in
 * development (main passes EMBER_ADMIN_POLICY only for unpackaged builds, so a
 * user can't point an installed Ember at a policy of their own). The system
 * file must belong to root and be writable only by root, or Ember locks down.
 */
export function loadAdminPolicy(file = ADMIN_POLICY_FILE, opts: { requireRootOwned?: boolean } = {}): LoadedAdminPolicy {
  let raw: string;
  try {
    raw = readTextFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { policy: AdminPolicySchema.parse({}), source: null };
    return lockedDown(file, `can't read ${file}: ${(err as Error).message}`);
  }
  if (opts.requireRootOwned ?? file === ADMIN_POLICY_FILE) {
    try {
      const st = fs.statSync(file);
      if (st.uid !== 0 || (st.mode & 0o022) !== 0) return lockedDown(file, `${file} must belong to root and be writable only by root`);
    } catch (err) {
      return lockedDown(file, `can't check ${file}: ${(err as Error).message}`);
    }
  }
  return parseAdminPolicy(raw, file);
}

/** The settings Ember actually uses: the user's, with the administrator's values on top. */
export function applyAdminPolicy(user: Settings, admin: AdminPolicy): Settings {
  const s: Settings = structuredClone(user);
  if (admin.features.voice === false) s.wakeWord = false;
  if (admin.features.speak === false) s.speak = false;
  if (admin.neverLook.length) {
    const have = new Set(s.privacy.neverLook.map(x => x.toLowerCase()));
    s.privacy = { ...s.privacy, neverLook: [...s.privacy.neverLook, ...admin.neverLook.filter(x => !have.has(x.toLowerCase()))] };
  }
  if (!admin.allowGrants) s.grants = {};
  const allowed = admin.models.allowed;
  const pick = (pinned: string | undefined, chosen: string | null) => pinned ?? (chosen && allowed && !allowed.includes(chosen) ? null : chosen);
  s.models = { conductor: pick(admin.models.conductor, s.models.conductor), worker: pick(admin.models.worker, s.models.worker) };
  return s;
}

/** Settings keys the administrator decides, for the settings window ("Managed by your organisation"). */
export function managedKeys(admin: AdminPolicy): string[] {
  const keys: string[] = [];
  if (admin.features.voice === false) keys.push("wakeWord");
  if (admin.features.speak === false) keys.push("speak");
  if (admin.models.conductor || admin.models.worker || admin.models.allowed) keys.push("models");
  if (!admin.allowGrants) keys.push("grants");
  if (admin.provider) keys.push("provider");
  return keys;
}

/** The API key for an admin-configured provider, read from its key file (or EMBER_PROVIDER_API_KEY). */
export function providerApiKey(p: NonNullable<AdminPolicy["provider"]>, read: (f: string) => string = f => fs.readFileSync(f, "utf8")): string | undefined {
  if (p.apiKeyFile) return read(p.apiKeyFile).trim();
  return process.env.EMBER_PROVIDER_API_KEY || undefined;
}

/**
 * The commands mode for a kind of target (R5): no policy file → "on" (the user still turns commands on per target);
 * a policy that exists without a `commands` key → "off" (the administrator never agreed to commands); a policy that
 * couldn't be read → "off"; otherwise its value for `kind`, "off" when that key is missing. A kind the administrator
 * turned off (`features.wsl` or `features.ssh` false) has no commands either, whatever `commands` says (§9.3's table).
 */
export function commandMode(loaded: LoadedAdminPolicy, kind: TargetKind): CommandMode {
  if (loaded.error) return "off";
  if (kind !== "local" && loaded.policy.features[kind] === false) return "off";
  if (loaded.source === null) return "on";
  return loaded.policy.commands?.[kind] ?? "off";
}

/** What a remote and the PC tell each other about their policies (protocol, gate 1). */
export interface AdminSummary {
  source: string | null;
  error?: string;
  features: { actions?: boolean; cursor?: boolean; desk?: boolean; screenImages?: boolean; wsl?: boolean; ssh?: boolean; voice?: boolean; speak?: boolean };
  neverLook: string[];
  confirmEveryAction: boolean;
  allowGrants: boolean;
  maxActionsPerMinute?: number;
  commands: Record<TargetKind, CommandMode>;
  ssh: { desktop?: boolean; requireConsoleConsent?: boolean; allowedHosts?: string[]; commandGraceSeconds?: number };
  models: { allowed?: string[] };
  provider: boolean;
}

/** The feature switches a summary carries (every one of AdminPolicy's). */
const SUMMARY_FEATURES = ["actions", "cursor", "desk", "screenImages", "wsl", "ssh", "voice", "speak"] as const;
const KINDS: readonly TargetKind[] = ["local", "wsl", "ssh"];
/** How long a remote command outlives a silent link when no policy says (L10). */
const DEFAULT_GRACE_SECONDS = 20;

/** A copy of `o` without its undefined values (a summary says only what a policy said). */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** What a remote and the PC tell each other about their policies (protocol, gate 1): plain data, no provider details. */
export function adminSummary(loaded: LoadedAdminPolicy): AdminSummary {
  const p = loaded.policy;
  const features: AdminSummary["features"] = {};
  for (const k of SUMMARY_FEATURES) if (p.features[k] !== undefined) features[k] = p.features[k];
  return {
    source: loaded.source,
    ...(loaded.error !== undefined ? { error: loaded.error } : {}),
    features,
    neverLook: [...p.neverLook],
    confirmEveryAction: p.confirmEveryAction,
    allowGrants: p.allowGrants,
    ...(p.maxActionsPerMinute !== undefined ? { maxActionsPerMinute: p.maxActionsPerMinute } : {}),
    commands: { local: commandMode(loaded, "local"), wsl: commandMode(loaded, "wsl"), ssh: commandMode(loaded, "ssh") },
    ssh: defined({
      desktop: p.ssh?.desktop,
      requireConsoleConsent: p.ssh?.requireConsoleConsent,
      allowedHosts: p.ssh?.allowedHosts ? [...p.ssh.allowedHosts] : undefined,
      commandGraceSeconds: p.ssh?.commandGraceSeconds,
    }),
    models: p.models.allowed ? { allowed: [...p.models.allowed] } : {},
    provider: p.provider !== undefined,
  };
}

/** Commands modes from the most to the least strict. */
const MODE_ORDER: readonly CommandMode[] = ["off", "ask", "on"];
const stricterMode = (a: CommandMode, b: CommandMode): CommandMode => MODE_ORDER[Math.min(MODE_ORDER.indexOf(a), MODE_ORDER.indexOf(b))] ?? "off";
/** Both sides' values when either has one (`fn` gets undefined for the side without), else undefined. */
function either<T, R>(a: T | undefined, b: T | undefined, fn: (a: T | undefined, b: T | undefined) => R): R | undefined {
  return a === undefined && b === undefined ? undefined : fn(a, b);
}
/** Two notes about where the policies came from or what was wrong with them, as one. */
const joinNotes = (a: string | null | undefined, b: string | null | undefined): string | null =>
  a && b ? `${a}; ${b}` : a || b || null;

/**
 * Both machines' rules for what Ember does on the remote: each value the stricter of the two (property-tested never to
 * loosen either). Features AND (absent = on); never-look lists joined; "confirm every action" OR; grants AND; the rate
 * limit the lower; each kind's commands mode the stricter (off < ask < on); the remote desktop AND; console consent
 * OR; allowed hosts only patterns both lists hold; the command grace the shorter (absent = 20 s); allowed models
 * those both allow (none in common: the caller refuses to connect); an organisation's own endpoint on either OR.
 */
export function combineAdmin(local: AdminSummary, remote: AdminSummary): AdminSummary {
  const features: AdminSummary["features"] = {};
  for (const k of SUMMARY_FEATURES) {
    const v = either(local.features[k], remote.features[k], (a, b) => (a ?? true) && (b ?? true));
    if (v !== undefined) features[k] = v;
  }
  const seen = new Set<string>();
  const neverLook = [...local.neverLook, ...remote.neverLook].filter(n => {
    const key = n.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const commands = Object.fromEntries(KINDS.map(k => [k, stricterMode(local.commands[k] ?? "off", remote.commands[k] ?? "off")])) as Record<TargetKind, CommandMode>;
  const allowed = either(local.models.allowed, remote.models.allowed, (a, b) => (a && b ? a.filter(m => b.includes(m)) : [...(a ?? b ?? [])]));
  const error = joinNotes(local.error, remote.error);
  const maxActionsPerMinute = either(local.maxActionsPerMinute, remote.maxActionsPerMinute, (a, b) => Math.min(a ?? Infinity, b ?? Infinity));
  return {
    source: joinNotes(local.source, remote.source),
    ...(error !== null ? { error } : {}),
    features,
    neverLook,
    confirmEveryAction: local.confirmEveryAction || remote.confirmEveryAction,
    allowGrants: local.allowGrants && remote.allowGrants,
    ...(maxActionsPerMinute !== undefined ? { maxActionsPerMinute } : {}),
    commands,
    ssh: defined({
      desktop: either(local.ssh.desktop, remote.ssh.desktop, (a, b) => (a ?? true) && (b ?? true)),
      requireConsoleConsent: either(local.ssh.requireConsoleConsent, remote.ssh.requireConsoleConsent, (a, b) => (a ?? false) || (b ?? false)),
      // A host must be allowed by both lists: only the patterns both hold (never looser than either; possibly stricter).
      allowedHosts: either(local.ssh.allowedHosts, remote.ssh.allowedHosts, (a, b) => (a && b ? a.filter(h => b.includes(h)) : [...(a ?? b ?? [])])),
      commandGraceSeconds: either(local.ssh.commandGraceSeconds, remote.ssh.commandGraceSeconds, (a, b) => Math.min(a ?? DEFAULT_GRACE_SECONDS, b ?? DEFAULT_GRACE_SECONDS)),
    }),
    models: allowed !== undefined ? { allowed } : {},
    provider: local.provider || remote.provider,
  };
}

/** A shell-style pattern ("*" any run of characters, "?" one) as an anchored regular expression. */
function hostPattern(p: string): RegExp {
  const body = [...p].map(c => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[\\^$.+()[\]{}|]/g, "\\$&"))).join("");
  return new RegExp(`^${body}$`, "s");
}

/** A destination's host name compared as DNS compares it (case-insensitively); a login name stays as it is. */
function foldHost(s: string): string {
  const at = s.lastIndexOf("@");
  return at < 0 ? s.toLowerCase() : s.slice(0, at + 1) + s.slice(at + 1).toLowerCase();
}

/**
 * Whether the PC's policy lets Ember connect to this resolved destination (§5.1.3): SSH not turned off, and, when the
 * policy lists allowed hosts, one of its patterns matches `user@host:port`, `host:port` or `host` (an empty list allows
 * none).
 */
export function hostAllowed(p: AdminPolicy, d: { user: string; hostname: string; port: number }): boolean {
  if (p.features.ssh === false) return false;
  const list = p.ssh?.allowedHosts;
  if (!list) return true;
  const host = d.hostname.toLowerCase();
  const forms = [`${d.user}@${host}:${d.port}`, `${host}:${d.port}`, host];
  return list.some(pattern => {
    const re = hostPattern(foldHost(pattern));
    return forms.some(f => re.test(f));
  });
}
