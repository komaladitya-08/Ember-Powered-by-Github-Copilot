/**
 * User settings in ~/.config/ember/settings.json. Validated with zod; unknown
 * or invalid values fall back to defaults; writes are atomic (tmp + rename).
 * The administrator's policy (/etc/ember/policy.json, see admin.ts) layers on
 * top: get() returns the settings in force, with the admin's values applied.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { applyAdminPolicy, type AdminPolicy } from "./admin";
import { CONSENT_VERSION } from "../shared/consent";

export const CHARACTERS = ["cinder", "wisp", "glassling", "glint"] as const;

export const SettingsSchema = z.object({
  version: z.literal(1).default(1),
  character: z.enum(CHARACTERS).default("cinder"),
  /** Character size on screen, in px. */
  size: z.number().int().min(36).max(110).default(60),
  /** Speak replies aloud (text always shows in the bubble). */
  speak: z.boolean().default(false),
  /** Listen for "Hey Ember". */
  wakeWord: z.boolean().default(true),
  voice: z.object({
    /** The user agreed to the microphone disclosure (nothing listens before this). */
    consent: z.boolean().default(false),
    /** Ignore "Hey Ember" when it comes out of the speakers (needs parec). */
    speakerRejection: z.boolean().default(true),
  }).default({ consent: false, speakerRejection: true }),
  /** What the user agreed to on first run (screen reading, what goes to Copilot, what stays here). */
  consent: z.object({
    version: z.number().int().min(0).default(0),
    at: z.string().nullable().default(null),
  }).default({ version: 0, at: null }),
  /** Onboarding finished (consent given, character picked). */
  onboarded: z.boolean().default(false),
  /** Apps and windows Ember must never read or capture (matched case-insensitively against app name and title). */
  privacy: z.object({
    neverLook: z.array(z.string().max(100)).max(100).default(["keepassxc", "seahorse", "passwords and keys", "1password", "bitwarden", "polkit"]),
  }).default({ neverLook: ["keepassxc", "seahorse", "passwords and keys", "1password", "bitwarden", "polkit"] }),
  /** Apps Ember may act in without asking first (lower-case app name → grant). */
  grants: z.record(z.string(), z.enum(["observe", "act"])).default({}),
  /** Preferred Copilot models; null lets Ember choose. */
  models: z.object({
    conductor: z.string().nullable().default(null),
    worker: z.string().nullable().default(null),
  }).default({ conductor: null, worker: null }),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsPatch = Partial<Omit<Settings, "version">>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export { CONSENT_VERSION };
export const hasConsent = (s: Settings) => s.consent.version >= CONSENT_VERSION;

export interface LoadResult {
  settings: Settings;
  /** Set when the file existed but could not be used; the bad file is kept beside it. */
  recoveredFrom?: string;
}

export class SettingsStore {
  /** What the user chose (saved to their file). */
  private current: Settings = DEFAULT_SETTINGS;
  private effective: Settings = DEFAULT_SETTINGS;
  private listeners = new Set<(s: Settings) => void>();

  constructor(readonly file: string, private admin: AdminPolicy | null = null) {}

  load(): LoadResult {
    const r = this.read();
    // Onboarding isn't finished until the current consent is given (older files are asked again).
    if (this.current.onboarded && !hasConsent(this.current)) this.current = { ...this.current, onboarded: false };
    this.effective = this.admin ? applyAdminPolicy(this.current, this.admin) : this.current;
    return { ...r, settings: this.effective };
  }

  private read(): LoadResult {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      this.current = DEFAULT_SETTINGS;
      return { settings: this.current };
    }
    try {
      const parsed = SettingsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        this.current = parsed.data;
        return { settings: this.current };
      }
      // Keep valid fields, reset invalid ones.
      const partial = JSON.parse(raw) as Record<string, unknown>;
      const repaired: Record<string, unknown> = {};
      for (const key of Object.keys(SettingsSchema.shape)) {
        const field = SettingsSchema.shape[key as keyof typeof SettingsSchema.shape];
        if (field.safeParse(partial[key]).success) repaired[key] = partial[key];
      }
      this.current = SettingsSchema.parse(repaired);
    } catch {
      this.current = DEFAULT_SETTINGS;
    }
    const backup = `${this.file}.bad-${Date.now()}`;
    try { fs.copyFileSync(this.file, backup); } catch { /* best effort */ }
    this.save();
    return { settings: this.current, recoveredFrom: backup };
  }

  /** The settings in force (the user's, with the administrator's policy applied). */
  get(): Settings {
    return this.effective;
  }

  /** Validates and applies a patch to the user's settings; throws on invalid values. */
  update(patch: SettingsPatch): Settings {
    const next = SettingsSchema.parse({ ...this.current, ...patch });
    if (next.onboarded && !hasConsent(next)) throw new Error("onboarding can't finish before the user gives consent");
    this.current = next;
    this.effective = this.admin ? applyAdminPolicy(next, this.admin) : next;
    this.save();
    for (const fn of this.listeners) fn(this.effective);
    return this.effective;
  }

  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.current, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
