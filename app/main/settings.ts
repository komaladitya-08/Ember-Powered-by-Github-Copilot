/**
 * User settings in ~/.config/ember/settings.json. Validated with zod; unknown
 * or invalid values fall back to defaults; writes are atomic (tmp + rename).
 * Admin policy (/etc/ember/policy.json, M8.7) will layer on top of this.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

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
  /** Onboarding finished (consent given, character picked). */
  onboarded: z.boolean().default(false),
  /** Preferred Copilot models; null lets Ember choose. */
  models: z.object({
    conductor: z.string().nullable().default(null),
    worker: z.string().nullable().default(null),
  }).default({ conductor: null, worker: null }),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsPatch = Partial<Omit<Settings, "version">>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export interface LoadResult {
  settings: Settings;
  /** Set when the file existed but could not be used; the bad file is kept beside it. */
  recoveredFrom?: string;
}

export class SettingsStore {
  private current: Settings = DEFAULT_SETTINGS;
  private listeners = new Set<(s: Settings) => void>();

  constructor(readonly file: string) {}

  load(): LoadResult {
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

  get(): Settings {
    return this.current;
  }

  /** Validates and applies a patch; throws on invalid values. */
  update(patch: SettingsPatch): Settings {
    const next = SettingsSchema.parse({ ...this.current, ...patch });
    this.current = next;
    this.save();
    for (const fn of this.listeners) fn(next);
    return next;
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
