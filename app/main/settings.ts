/**
 * User settings in ~/.config/ember/settings.json. Validated with zod; invalid
 * values fall back to defaults item by item (one bad never-look entry doesn't
 * reset the list); writes are atomic and durable (tmp + fsync + rename), and a
 * change made by hand while Ember runs is picked up, never overwritten.
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
    /** The user turned the microphone off (Ctrl+Alt+M): it stays off across restarts. */
    muted: z.boolean().default(false),
  }).default({ consent: false, speakerRejection: true, muted: false }),
  /** What the user agreed to on first run (screen reading, what goes to Copilot, what stays here). */
  consent: z.object({
    version: z.number().int().min(0).default(0),
    at: z.string().nullable().default(null),
  }).default({ version: 0, at: null }),
  /** Start Ember when the user logs in (an XDG autostart entry). */
  startAtLogin: z.boolean().default(false),
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
  /** Calm mode: no hops, bounces or idle fidgets (also on when the desktop asks for reduced motion). */
  reduceMotion: z.boolean().default(false),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsPatch = Partial<Omit<Settings, "version">>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export { CONSENT_VERSION };
export const hasConsent = (s: Settings) => s.consent.version >= CONSENT_VERSION;

type Shape = typeof SettingsSchema.shape;

/** A broken object field, cut down to what is still valid in it. */
function repairObject(key: keyof Shape, v: Record<string, unknown>): unknown {
  if (key === "grants") return Object.fromEntries(Object.entries(v).filter(([, g]) => g === "observe" || g === "act"));
  if (key === "privacy") {
    const list = Array.isArray(v.neverLook) ? v.neverLook.filter((x): x is string => typeof x === "string" && x.length <= 100).slice(0, 100) : undefined;
    return list ? { neverLook: list } : {};
  }
  // Other objects: keep each sub-field that is valid on its own.
  let kept = { ...(DEFAULT_SETTINGS[key] as Record<string, unknown>) };
  for (const [k, x] of Object.entries(v)) {
    const probe = { ...kept, [k]: x };
    if (SettingsSchema.shape[key].safeParse(probe).success) kept = probe;
  }
  return kept;
}

/** Keeps every valid setting (down to single list entries) and resets only what is invalid. */
export function repairSettings(partial: Record<string, unknown>): Settings {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(SettingsSchema.shape) as (keyof Shape)[]) {
    const field = SettingsSchema.shape[key];
    const v = partial[key];
    if (field.safeParse(v).success) { out[key] = v; continue; }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const fixed = repairObject(key, v as Record<string, unknown>);
      if (field.safeParse(fixed).success) out[key] = fixed;
    }
  }
  return SettingsSchema.parse(out);
}

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
  private problemListeners = new Set<(msg: string) => void>();
  /** The file as Ember last read or wrote it: anything newer was edited by hand. */
  private seen: number | null = null;
  /** A change applied in memory whose save is due shortly (a slider being dragged). */
  private pending: SettingsPatch | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;

  constructor(readonly file: string, private admin: AdminPolicy | null = null) {}

  load(): LoadResult {
    const r = this.read(false);
    this.apply(this.current);
    return { ...r, settings: this.effective };
  }

  private mtime(): number | null {
    try { return fs.statSync(this.file).mtimeMs; } catch { return null; }
  }

  /** Onboarding isn't finished until the current consent is given (older files are asked again). */
  private apply(next: Settings): void {
    this.current = next.onboarded && !hasConsent(next) ? { ...next, onboarded: false } : next;
    this.effective = this.admin ? applyAdminPolicy(this.current, this.admin) : this.current;
  }

  /**
   * Reads the file. At start-up a missing or unreadable file means defaults. While Ember runs
   * (`running`), a file that is gone, unreadable or not JSON at all (a hand edit in progress, a
   * trailing comma) never replaces the settings in use: they stay, and the file is read again
   * when it next changes. JSON with a few bad values is repaired value by value either way.
   */
  private read(running: boolean): LoadResult {
    let raw: string;
    this.seen = this.mtime();
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if (running) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.problem(`Ember can't read ${this.file}, so it keeps the settings it has.`);
        return { settings: this.current };
      }
      this.current = DEFAULT_SETTINGS;
      return { settings: this.current };
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      if (running) {
        this.problem(`${this.file} isn't valid JSON, so Ember keeps the settings it has until the file is fixed.`);
        return { settings: this.current };
      }
      json = undefined;
    }
    const parsed = SettingsSchema.safeParse(json);
    if (parsed.success) {
      this.current = parsed.data;
      return { settings: this.current };
    }
    // Keep what is valid (down to single entries), reset only what isn't.
    this.current = json && typeof json === "object" && !Array.isArray(json) ? repairSettings(json as Record<string, unknown>) : DEFAULT_SETTINGS;
    const backup = `${this.file}.bad-${Date.now()}`;
    try { fs.copyFileSync(this.file, backup); } catch { /* best effort */ }
    // A full disk must not stop Ember starting: the repaired settings are used from memory.
    try { this.save(this.current); } catch { /* kept in memory; saved with the next change */ }
    if (running) this.problem(`Some values in ${this.file} weren't valid and were reset; your file was kept as ${backup}.`);
    return { settings: this.current, recoveredFrom: backup };
  }

  private problem(msg: string): void {
    for (const fn of this.problemListeners) { try { fn(msg); } catch { /* a listener's own problem */ } }
  }

  /** Told when a hand edit couldn't be used (the settings in use are kept). */
  onProblem(fn: (msg: string) => void): () => void {
    this.problemListeners.add(fn);
    return () => this.problemListeners.delete(fn);
  }

  /** The file changed outside Ember (edited by hand): use it. Returns true when it did. */
  reloadIfChanged(): boolean {
    const m = this.mtime();
    if (m === this.seen) return false;
    const before = this.current;
    this.read(true);
    // A change still waiting to be saved goes on top of the hand edit.
    if (this.pending) {
      const next = SettingsSchema.safeParse({ ...this.current, ...this.pending });
      if (next.success) this.current = next.data;
    }
    if (this.current === before) return false;
    this.apply(this.current);
    for (const fn of this.listeners) fn(this.effective);
    return true;
  }

  /** Picks up hand edits while Ember runs (checked every couple of seconds). */
  watch(intervalMs = 2000): () => void {
    const timer = setInterval(() => { try { this.reloadIfChanged(); } catch { /* next time */ } }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** The settings in force (the user's, with the administrator's policy applied). */
  get(): Settings {
    return this.effective;
  }

  /** The user's own settings, without the administrator's policy. */
  own(): Settings {
    return this.current;
  }

  /**
   * Validates and applies a patch to the user's settings; throws on invalid values (or if it can't
   * be saved). `soon`: applied now and saved a moment later, for changes that come many times a
   * second (a slider being dragged); any other change, or flush(), saves it at once.
   */
  update(patch: SettingsPatch, opts: { soon?: boolean } = {}): Settings {
    // A hand edit since Ember last looked comes first: the patch goes on top of it.
    if (this.mtime() !== this.seen) { try { this.read(true); } catch { /* keep what is in memory */ } }
    const next = SettingsSchema.parse({ ...this.current, ...patch });
    if (next.onboarded && !hasConsent(next)) throw new Error("onboarding can't finish before the user gives consent");
    if (opts.soon) {
      this.pending = { ...this.pending, ...patch };
      if (!this.pendingTimer) {
        this.pendingTimer = setTimeout(() => { try { this.flush(); } catch { /* saved with the next change */ } }, 400);
        this.pendingTimer.unref?.();
      }
    } else {
      // Saved first: memory changes only once the change is on disk.
      this.save(next);
      this.clearPending();
    }
    this.apply(next);
    for (const fn of this.listeners) fn(this.effective);
    return this.effective;
  }

  /** Saves a change made with `soon` now (also done on quit). */
  flush(): void {
    if (!this.pending) return;
    this.save(this.current);
    this.clearPending();
  }

  private clearPending(): void {
    this.pending = null;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
  }

  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private save(settings: Settings): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      // Durable: the new file is on disk before it replaces the old one (a power cut leaves one or the other, never an empty file).
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(settings, null, 2) + "\n");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing left to tidy */ }
      throw err;
    }
    try { const dir = fs.openSync(path.dirname(this.file), "r"); fs.fsyncSync(dir); fs.closeSync(dir); } catch { /* not every filesystem allows it */ }
    this.seen = this.mtime();
  }
}
