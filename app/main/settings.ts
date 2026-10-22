/**
 * User settings in settings.json in Ember's data folder (~/.config/ember on Linux). Validated with zod; invalid
 * values fall back to defaults item by item (one bad never-look entry doesn't
 * reset the list); writes are atomic and durable (tmp + fsync + rename), and a
 * change made by hand while Ember runs is picked up, never overwritten.
 * The administrator's policy (see admin.ts and the platform's policy source) layers on
 * top: get() returns the settings in force, with the admin's values applied.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { applyAdminPolicy, type AdminPolicy } from "./admin";
import { CONSENT_VERSION } from "../shared/consent";
import { NEVER_LOOK_DEFAULTS } from "../shared/never-look";
import { HOST_OS } from "./platform/os";

/** This OS's never-look defaults (read once at load: renderers import this module only for its types). */
const neverLookDefault = () => [...NEVER_LOOK_DEFAULTS[HOST_OS]];

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
    /** The user turned the microphone off (its shortcut or the menu): it stays off across restarts. */
    muted: z.boolean().default(false),
  }).default({ consent: false, speakerRejection: true, muted: false }),
  /** What the user agreed to on first run (screen reading, what goes to Copilot, what stays here). */
  consent: z.object({
    version: z.number().int().min(0).default(0),
    at: z.string().nullable().default(null),
  }).default({ version: 0, at: null }),
  /** Start Ember when the user logs in (the OS's own login item: an XDG autostart entry on Linux). */
  startAtLogin: z.boolean().default(false),
  /** Onboarding finished (consent given, character picked). */
  onboarded: z.boolean().default(false),
  /** Apps and windows Ember must never read or capture (matched case-insensitively against app name and title). */
  privacy: z.object({
    neverLook: z.array(z.string().max(100)).max(100).default(neverLookDefault()),
  }).default({ neverLook: neverLookDefault() }),
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

/**
 * JSON with the slips people make editing by hand (comments, trailing commas) read anyway; undefined
 * when even that fails.
 */
export function lenientJson(raw: string): unknown {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') {
      // A string, copied as it is (escapes included).
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') j += raw[j] === "\\" ? 2 : 1;
      out += raw.slice(i, j + 1);
      i = j;
    } else if (c === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2);
      i = end < 0 ? raw.length : end + 1;
    } else if (c === ",") {
      // A comma with nothing after it (but space and comments) before the closing bracket.
      let j = i + 1;
      for (;;) {
        while (j < raw.length && /\s/.test(raw[j])) j++;
        if (raw.startsWith("//", j)) { while (j < raw.length && raw[j] !== "\n") j++; continue; }
        if (raw.startsWith("/*", j)) { const end = raw.indexOf("*/", j + 2); j = end < 0 ? raw.length : end + 2; continue; }
        break;
      }
      if (raw[j] !== "}" && raw[j] !== "]") out += c;
    } else out += c;
  }
  try { return JSON.parse(out); } catch { return undefined; }
}

/** The never-look entries of a file that can't be read at all: the one list worth saving from it. */
function salvageNeverLook(raw: string): string[] | null {
  const m = /"neverLook"\s*:\s*\[([\s\S]*?)\]/.exec(raw);
  if (!m) return null;
  const list = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => { try { return JSON.parse(`"${x[1]}"`) as string; } catch { return null; } });
  return list.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 100).slice(0, 100);
}

/** Rename failures another program's open handle causes for a moment on Windows (antivirus scans, sync clients): worth retrying. */
const BUSY_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);
/** How long to wait between those retries. */
const RENAME_RETRY_MS = 50;

/** Waits `ms` without returning to the event loop (saves are synchronous; this runs only after a refused rename). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** How a SettingsStore saves on this OS (the platform's paths). */
export interface SettingsStoreOptions {
  /**
   * How many times a rename refused with EPERM/EBUSY/EACCES is tried again, 50 ms apart (the platform's
   * paths.renameRetries: 0 on Linux and macOS, as before; 5 on Windows, whose antivirus and sync locks are brief).
   */
  renameRetries?: number;
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
  private problemListeners = new Set<(msg: string | null) => void>();
  /** A problem was reported and not yet cleared by a file that reads fine. */
  private troubled = false;
  /** The file on disk isn't JSON (a hand edit): where the user's version was kept ("" if it couldn't be). */
  private broken: string | null = null;
  /** The file as Ember last read or wrote it: anything newer was edited by hand. */
  private seen: number | null = null;
  /** A change applied in memory whose save is due shortly (a slider being dragged). */
  private pending: SettingsPatch | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;

  private renameRetries: number;

  constructor(readonly file: string, private admin: AdminPolicy | null = null, o: SettingsStoreOptions = {}) {
    this.renameRetries = Math.max(0, Math.floor(o.renameRetries ?? 0));
  }

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
    let strict = true;
    try {
      json = JSON.parse(raw);
    } catch {
      strict = false;
      // A hand edit with a slip (a trailing comma, a comment) is read anyway.
      json = lenientJson(raw);
      if (running && json === undefined) {
        // Ember's next save would replace it: the user's file is kept beside it first.
        const backup = this.keep();
        this.broken = backup ?? this.broken ?? "";
        this.problem(`settings.json isn't valid JSON, so Ember keeps the settings it was using until it is fixed${backup ? ` (your version is saved as ${path.basename(backup)})` : ""}.`);
        return { settings: this.current };
      }
    }
    const parsed = SettingsSchema.safeParse(json);
    if (parsed.success && strict) {
      this.current = parsed.data;
      this.broken = null;
      if (this.troubled) this.problem(null);
      return { settings: this.current };
    }
    // Keep what is valid (down to single entries), reset only what isn't; from a file that can't be
    // read at all, at least the never-look list.
    if (parsed.success) this.current = parsed.data;
    else if (json && typeof json === "object" && !Array.isArray(json)) this.current = repairSettings(json as Record<string, unknown>);
    else {
      const neverLook = salvageNeverLook(raw);
      this.current = neverLook ? { ...DEFAULT_SETTINGS, privacy: { neverLook } } : DEFAULT_SETTINGS;
    }
    const backup = this.keep();
    // A full disk must not stop Ember starting: the repaired settings are used from memory.
    try { this.save(this.current); } catch { /* kept in memory; saved with the next change */ }
    this.problem(parsed.success
      ? `settings.json had a small mistake (a comma or comment JSON doesn't allow); Ember read it anyway and tidied the file${backup ? ` (your version is saved as ${path.basename(backup)})` : ""}.`
      : `Some of settings.json couldn't be used, so those settings went back to their defaults${backup ? `; your version is saved as ${path.basename(backup)}` : ""}.`);
    return { settings: this.current, recoveredFrom: backup ?? undefined };
  }

  /** A copy of the file as it is now (once per version of it), before Ember writes over it. */
  private kept: number | null = null;
  private keep(): string | null {
    const m = this.mtime();
    if (m !== null && m === this.kept) return null;
    const backup = `${this.file}.bad-${Date.now()}`;
    try { fs.copyFileSync(this.file, backup); this.kept = m; return backup; } catch { return null; }
  }

  private problem(msg: string | null): void {
    this.troubled = msg !== null;
    this.lastProblem = msg;
    for (const fn of this.problemListeners) { try { fn(msg); } catch { /* a listener's own problem */ } }
  }

  /** What went wrong with the file last (null once it reads fine again). */
  lastProblem: string | null = null;

  /** Told when the file couldn't be used as it was (the settings in use are kept), and null once it reads fine. */
  onProblem(fn: (msg: string | null) => void): () => void {
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
      this.savedOverBroken();
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
    this.savedOverBroken();
  }

  /** Ember's own save replaced a hand edit that wasn't JSON: the notice says so (not "until it is fixed"). */
  private savedOverBroken(): void {
    if (this.broken === null) return;
    const kept = this.broken;
    this.broken = null;
    this.problem(`Your edit of settings.json wasn't valid JSON, so Ember saved its settings over it${kept ? `; your version is kept as ${path.basename(kept)}` : ""}.`);
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

  /** Puts the new file in place, retrying a briefly locked target (renameRetries). */
  private rename(tmp: string): void {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, this.file);
        return;
      } catch (err) {
        if (attempt >= this.renameRetries || !BUSY_RENAME.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
        pause(RENAME_RETRY_MS);
      }
    }
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
      this.rename(tmp);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing left to tidy */ }
      throw err;
    }
    try { const dir = fs.openSync(path.dirname(this.file), "r"); fs.fsyncSync(dir); fs.closeSync(dir); } catch { /* not every filesystem allows it */ }
    this.seen = this.mtime();
  }
}
