/**
 * Admin lockdown (M8.7): /etc/ember/policy.json, written by the machine's
 * administrator. It can only make Ember stricter: turn features off, keep
 * apps out of Ember's sight, require a click for every action, pin or limit
 * models, point Ember at the organisation's own model endpoint (BYOK) and
 * set how long the audit log is kept. Its values override the user's settings.
 * A policy file that exists but can't be read locks Ember down (fail closed).
 */

import fs from "node:fs";
import { z } from "zod";
import type { Settings } from "./settings";

export const ADMIN_POLICY_FILE = "/etc/ember/policy.json";

const name = z.string().min(1).max(100);

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
  features: { voice: false, actions: false, cursor: false, desk: false, screenImages: false },
  allowGrants: false,
  confirmEveryAction: true,
});

/**
 * Reads the administrator's policy. `file` is /etc/ember/policy.json except in
 * development (main passes EMBER_ADMIN_POLICY only for unpackaged builds, so a
 * user can't point an installed Ember at a policy of their own). The system
 * file must belong to root and be writable only by root, or Ember locks down.
 */
export function loadAdminPolicy(file = ADMIN_POLICY_FILE, opts: { requireRootOwned?: boolean } = {}): LoadedAdminPolicy {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { policy: AdminPolicySchema.parse({}), source: null };
    return { policy: LOCKDOWN, source: file, error: `can't read ${file}: ${(err as Error).message}` };
  }
  if (opts.requireRootOwned ?? file === ADMIN_POLICY_FILE) {
    try {
      const st = fs.statSync(file);
      if (st.uid !== 0 || (st.mode & 0o022) !== 0) return { policy: LOCKDOWN, source: file, error: `${file} must belong to root and be writable only by root` };
    } catch (err) {
      return { policy: LOCKDOWN, source: file, error: `can't check ${file}: ${(err as Error).message}` };
    }
  }
  try {
    const parsed = AdminPolicySchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { policy: parsed.data, source: file };
    const issue = parsed.error.issues[0];
    return { policy: LOCKDOWN, source: file, error: `${file}: ${issue.path.join(".") || "(top)"}: ${issue.message}` };
  } catch (err) {
    return { policy: LOCKDOWN, source: file, error: `${file} is not valid JSON: ${(err as Error).message}` };
  }
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
