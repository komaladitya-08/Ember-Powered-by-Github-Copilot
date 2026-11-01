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
import { DISTRO_NAME, HOST_ID, parseTargetId, type TargetId } from "../shared/targets";
import { HANDLE_POSITIONS } from "../shared/handle-place";
import { HOST_OS } from "./platform/os";
import { readTextFile } from "./text-file";

/** This OS's never-look defaults (read once at load: renderers import this module only for its types). */
const neverLookDefault = () => [...NEVER_LOOK_DEFAULTS[HOST_OS]];

export const CHARACTERS = ["cinder", "wisp", "glassling", "glint"] as const;

/** A first-use consent card's record (§7.4): the card's version the user said yes to (0: not yet) and when. */
const ConsentRecord = z.object({ version: z.number().int().min(0).default(0), at: z.string().nullable().default(null) }).default({ version: 0, at: null });

/** No control characters (they could hide what a value says, or end a line in ssh's config). */
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/; // eslint-disable-line no-control-regex -- control characters are exactly what's refused here
/** §5.1.2's destination validator (validDest): an alias, user@host or user@host:port; never an option. */
const DEST = /^(?!-)[A-Za-z0-9._%+@[\]:-]{1,255}$/;
/** §5.1.2's jump hop validator (validHop): stricter, no "%" (ssh expands it in a ProxyCommand) and no brackets. */
const HOP = /^(?!-)[A-Za-z0-9._@:-]{1,255}$/;
/** An identity or config file carried from the user's ssh command line: absolute or ~/-relative. */
const SSH_FILE = /^(\/|~\/|[A-Za-z]:[\\/])/;
/** The -o options a host record may carry (§2.7's allow-list) and the characters their values may hold. */
const SSH_OPTIONS = new Set(["Port", "User", "ProxyJump", "IdentityFile", "IdentitiesOnly", "HostKeyAlias", "HostName"]);
const SSH_OPTION_VALUE = /^[A-Za-z0-9._@:/~+-]{1,255}$/;
const port = z.number().int().min(1).max(65535);
const sshFile = z.string().min(2).max(1024).regex(SSH_FILE).regex(NO_CONTROL);
const isTargetId = (v: unknown): v is TargetId => typeof v === "string" && parseTargetId(v) !== null;

/** A host the user added (remote/types.ts HostRecord), checked field by field: a record that fails is dropped alone. */
export const HostRecordSchema = z.object({
  id: z.string().regex(HOST_ID),
  dest: z.string().regex(DEST),
  port: port.optional(),
  extra: z.object({
    jump: z.array(z.string().regex(HOP)).max(8).optional(),
    identityFiles: z.array(sshFile).max(16).optional(),
    configFile: sshFile.optional(),
    options: z.record(z.string().refine(k => SSH_OPTIONS.has(k)), z.string().regex(SSH_OPTION_VALUE)).optional(),
  }).strict().optional(),
  via: z.custom<"local" | `wsl:${string}`>(v => v === "local" || (typeof v === "string" && v.startsWith("wsl:") && DISTRO_NAME.test(v.slice(4)))).optional(),
  resolved: z.object({
    user: z.string().min(1).max(255).regex(NO_CONTROL),
    hostname: z.string().min(1).max(255).regex(NO_CONTROL),
    port,
    jump: z.array(z.string().regex(HOP)).max(8),
  }),
  consent: ConsentRecord,
  machineIdHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  lastUsed: z.string().max(64).optional(),
});

/** The settings of one target's commands (§3.9.3): the user's switch, "Ask before every command", and the card. */
const TargetCommands = z.object({
  on: z.boolean().default(false),
  askEvery: z.boolean().default(false),
  consent: ConsentRecord,
});

/** Destinations whose ssh offer the user dismissed ("Don't offer again"): at most this many. */
const DISMISSED_MAX = 200;
const dismissedOffer = z.string().min(1).max(255).regex(NO_CONTROL);

export const SettingsSchema = z.object({
  version: z.literal(1).default(1),
  character: z.enum(CHARACTERS).default("cinder"),
  /** Character size on screen, in px. */
  size: z.number().int().min(36).max(110).default(60),
  /** Speak replies aloud (text always shows in the bubble). On by default: Ember is a voice assistant (0.1.1). */
  speak: z.boolean().default(true),
  /** Speak them while a screen reader runs, even with `speak` off; off with it, Ember never speaks (app/shared/speech.ts). */
  speakWithScreenReader: z.boolean().default(true),
  /** Listen for "Hey Ember". */
  wakeWord: z.boolean().default(true),
  voice: z.object({
    /** The user agreed to the microphone disclosure (nothing listens before this). */
    consent: z.boolean().default(false),
    /** Ignore "Hey Ember" when it comes out of the speakers (needs parec). */
    speakerRejection: z.boolean().default(true),
    /** The user turned the microphone off (its shortcut or the menu): it stays off across restarts. */
    muted: z.boolean().default(false),
    /** Voice Match: answer only the owner's voice (its voiceprint is kept apart, in voiceprint.json: voiceprint-store.ts). */
    match: z.boolean().default(false),
    /**
     * Ember's natural voice (Kokoro, 320 MB, downloaded when this is turned on): Windows and macOS only, where speech
     * runs natively, and only where this computer makes it fast enough (VoiceService, tts-process.ts).
     */
    natural: z.boolean().default(false),
  }).default({ consent: false, speakerRejection: true, muted: false, match: false, natural: false }),
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
  /** More time to read and answer: bubbles stay ten times as long, and a question waits 20 minutes (WCAG 2.2.1: readTimeOf). */
  moreTime: z.boolean().default(false),
  /** Text size in Ember's windows, bubble and cards (main's page-prefs.ts applies it): larger is 30% bigger. */
  textSize: z.enum(["default", "large", "larger"]).default("default"),
  /**
   * The primary display's corner Ember's handle sits in, and its task cards above it (Comfort & access › Handle
   * position, and the handle menu's "Move to the other side"; review #75). A file from before it reads as the bottom right.
   */
  handlePosition: z.enum(HANDLE_POSITIONS).default("bottom-right"),
  /**
   * How many times the ask box has opened where Ember can't hold the letters typed while it opens (Windows, macOS),
   * counted up to the openings that say to wait for it before typing (ask.ts WAIT_TIP_OPENINGS, review #78).
   */
  askOpened: z.number().int().min(0).max(1000).default(0),
  /** Where Ember works (§2): the picker's target, the SSH hosts the user added, WSL, and this install's id. */
  targets: z.object({
    /** The picker's choice: requests that name no computer go here. */
    active: z.custom<TargetId>(isTargetId).default("local"),
    /** Offer to come along when the user runs ssh themselves (§2.7). */
    offerSsh: z.boolean().default(true),
    dismissedOffers: z.array(dismissedOffer).max(DISMISSED_MAX).default([]),
    /** Each id once. */
    hosts: z.array(HostRecordSchema).max(100).refine(h => new Set(h.map(x => x.id)).size === h.length, "host ids must be unique").default([]),
    /** WSL turned on (after its card). */
    wsl: z.object({ on: z.boolean().default(false), consent: ConsentRecord }).default({ on: false, consent: { version: 0, at: null } }),
    /** This Ember install's id (§5.1.13): 32 hex digits the targets runtime makes at first use; "" until then. */
    pcId: z.string().regex(/^(?:[0-9a-f]{32})?$/).default(""),
  }).default({ active: "local", offerSsh: true, dismissedOffers: [], hosts: [], wsl: { on: false, consent: { version: 0, at: null } }, pcId: "" }),
  /**
   * How often Ember asks: `askedApps` (on by default), no "Let me work in …?" in an app the user asked for help in (they
   * were in it, or named it; risky steps still ask); `reviewCommands` (off by default until the reviewer passes its
   * evaluation, eval/src/review-gate.ts), a command that would ask is reviewed by the model first, and one it finds
   * routine for the request runs with its Stop countdown instead (commands/review.ts).
   */
  trust: z.object({
    askedApps: z.boolean().default(true),
    reviewCommands: z.boolean().default(false),
  }).default({ askedApps: true, reviewCommands: false }),
  /** Commands per target id (§3.9.3): off until the user turns them on with the commands card. */
  commands: z.partialRecord(z.string().refine(isTargetId), TargetCommands).default({}),
  /**
   * Long-term memory (docs/MEMORY.md): off until the user turns it on and agrees to its note in Settings ›
   * Conversation (`consent`, FEATURE_CONSENT_VERSION.memory). What Ember remembers is kept in memory.json, apart from
   * the settings (app/main/memory/store.ts).
   */
  memory: z.object({ on: z.boolean().default(false), consent: ConsentRecord }).default({ on: false, consent: { version: 0, at: null } }),
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
  // Commands: each target's entry kept on its own.
  if (key === "commands") return Object.fromEntries(Object.entries(v).filter(([id, c]) => isTargetId(id) && TargetCommands.safeParse(c).success));
  // Targets: each host record and dismissed offer kept on its own (one bad record doesn't forget the others), then
  // every other field as below.
  if (key === "targets") {
    const ids = new Set<string>();
    const hosts = Array.isArray(v.hosts) ? v.hosts.filter(h => {
      const r = HostRecordSchema.safeParse(h);
      if (!r.success || ids.has(r.data.id)) return false;
      ids.add(r.data.id);
      return true;
    }).slice(0, 100) : undefined;
    const dismissed = Array.isArray(v.dismissedOffers) ? v.dismissedOffers.filter(x => dismissedOffer.safeParse(x).success).slice(0, DISMISSED_MAX) : undefined;
    v = { ...v, ...(hosts ? { hosts } : {}), ...(dismissed ? { dismissedOffers: dismissed } : {}) };
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

/** How long a repairable hand edit must stay the same before Ember rewrites it (the watcher looks every 2 s). */
const SETTLE_MS = 2000;
/** How many copies of unusable versions (settings.json.bad-<time>) are kept. */
const KEEP_BACKUPS = 3;

/** Read errors another program's hold or a network home's hiccup causes for a moment (at login, scans and syncs run). */
const BUSY_READ = new Set(["EBUSY", "EPERM", "EACCES", "EIO", "ETIMEDOUT", "EAGAIN"]);
/** How long to wait before each further try of a start-up read (about 350 ms in all, only when it fails). */
const READ_RETRY_MS = [50, 100, 200];

/** The file's text at start-up, tried again a few times when it fails for a moment (review #83). */
function readSoon(file: string): string {
  for (let attempt = 0; ; attempt++) {
    try {
      return readTextFile(file);
    } catch (err) {
      if (attempt >= READ_RETRY_MS.length || !BUSY_READ.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
      pause(READ_RETRY_MS[attempt]);
    }
  }
}

/** Waits `ms` without returning to the event loop (saves are synchronous; this runs only after a refused rename). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * One plain sentence for a save that failed, for the settings window (review #84). `later`: the change stays in use
 * and is saved with the next one (the size slider); otherwise it wasn't kept.
 */
export function saveFailure(err: unknown, later = false): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const why = code === "ENOSPC" || code === "EDQUOT" ? "the disk is full"
    : code === "EROFS" ? "its folder is on a disk that can only be read"
    : code === "EACCES" || code === "EPERM" ? "it isn't allowed to write to its folder"
    : code === "EBUSY" ? "another program is holding settings.json"
    : "the file couldn't be written";
  return `Ember couldn't save your settings: ${why}. ${later ? "It will try again with your next change." : "Your change wasn't kept."}`;
}

/**
 * What the settings window is told when update() threw (review #84): a failed save as saveFailure's sentence (the
 * raw error as its cause), never Node's own words; anything else as it is.
 */
export function plainSaveError(err: unknown): unknown {
  return typeof (err as NodeJS.ErrnoException | null)?.code === "string" ? new Error(saveFailure(err), { cause: err }) : err;
}

/** How a SettingsStore saves on this OS (the platform's paths). */
export interface SettingsStoreOptions {
  /**
   * How many times a rename refused with EPERM/EBUSY/EACCES is tried again, 50 ms apart (the platform's
   * paths.renameRetries: 0 on Linux and macOS, as before; 5 on Windows, whose antivirus and sync locks are brief).
   */
  renameRetries?: number;
  /** Milliseconds now (tests): how long a hand edit has stayed the same. */
  clock?: () => number;
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
  /** A change applied in memory whose save is due shortly (a slider being dragged), or once the file reads again. */
  private pending: SettingsPatch | null = null;
  /** The file is there but couldn't be read at start-up: nothing is saved over it until it reads (review #83). */
  private unread = false;
  /** The notice that said so. */
  private unreadNotice: string | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;

  private renameRetries: number;
  private clock: () => number;

  constructor(readonly file: string, private admin: AdminPolicy | null = null, o: SettingsStoreOptions = {}) {
    this.renameRetries = Math.max(0, Math.floor(o.renameRetries ?? 0));
    this.clock = o.clock ?? Date.now;
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
  private read(running: boolean, settle = running): LoadResult {
    let raw: string;
    this.deferred = false;
    this.seen = this.mtime();
    try {
      // Whatever Unicode form an editor or script saved it in (a byte-order mark, UTF-16): review #82.
      raw = running ? readTextFile(this.file) : readSoon(this.file);
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      // Nothing is there to save over any more: the notice that said Ember wouldn't goes too.
      if (missing && this.unread) { this.unread = false; this.withdraw(this.unreadNotice); }
      if (running) {
        // (Still unreadable since start-up: its notice stands.)
        if (!missing && !this.unread) this.problem(`Ember can't read ${this.file}, so it keeps the settings it has.`);
        return { settings: this.current };
      }
      this.current = DEFAULT_SETTINGS;
      if (!missing) {
        // The user's settings are there but can't be read: Ember runs on defaults and saves nothing over them until
        // they can be read (the watcher keeps trying), so one change can't replace consent, hosts and the never-look
        // list with defaults (review #83).
        this.unread = true;
        this.unreadNotice = `Ember can't read ${this.file}, so it started with its default settings. It won't save over the file until it can read it again.`;
        this.problem(this.unreadNotice);
      }
      return { settings: this.current };
    }
    this.unread = false;
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
    // An editor that saves as the user types may be mid-edit ("size": 800 on the way to 80): the file is
    // rewritten only once it has stayed the same for SETTLE_MS, never under the editor (review #92).
    if (settle && !this.settled()) {
      this.seen = null; // looked at again at the next check
      this.deferred = true;
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

  /** The version of a repairable hand edit being waited on (its time stamp), and since when it has looked the same. */
  private settling: { mtime: number | null; since: number } | null = null;
  /** The last read left a repairable hand edit for later (it may still be changing): nothing changed in memory. */
  private deferred = false;

  /** Has the file (as last read) stayed the same for SETTLE_MS? */
  private settled(): boolean {
    const now = this.clock();
    if (!this.settling || this.settling.mtime !== this.seen) this.settling = { mtime: this.seen, since: now };
    return now - this.settling.since >= SETTLE_MS;
  }

  /** A copy of the file as it is now (once per version of it), before Ember writes over it. */
  private kept: number | null = null;
  private lastBackup = 0;
  private keep(): string | null {
    const m = this.mtime();
    if (m !== null && m === this.kept) return null;
    // Two versions within a millisecond still get a copy each.
    this.lastBackup = Math.max(Date.now(), this.lastBackup + 1);
    const backup = `${this.file}.bad-${this.lastBackup}`;
    try { fs.copyFileSync(this.file, backup); this.kept = m; } catch { return null; }
    this.pruneBackups();
    return backup;
  }

  /** Only the newest KEEP_BACKUPS copies stay: an editor that saves as the user types makes one per save (review #92). */
  private pruneBackups(): void {
    const dir = path.dirname(this.file);
    const prefix = `${path.basename(this.file)}.bad-`;
    try {
      const old = fs.readdirSync(dir)
        .filter(n => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
        .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)))
        .slice(KEEP_BACKUPS);
      for (const n of old) fs.rmSync(path.join(dir, n), { force: true });
    } catch { /* tidied the next time */ }
  }

  /** Takes `msg` away if it is still the notice shown. */
  private withdraw(msg: string | null): void {
    if (msg !== null && this.lastProblem === msg) this.problem(null);
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

  /** The file changed outside Ember (edited by hand), or reads again after it couldn't: use it. Returns true when it did. */
  reloadIfChanged(): boolean {
    const m = this.mtime();
    const wasUnread = this.unread;
    if (m === this.seen && !wasUnread) return false;
    const before = this.current;
    this.read(true);
    // Still unreadable, or an edit left until it stops changing: nothing to use (or save) yet.
    if ((wasUnread && this.unread) || this.deferred) return false;
    // A change still waiting to be saved goes on top of the hand edit.
    if (this.pending) {
      const next = SettingsSchema.safeParse({ ...this.current, ...this.pending });
      if (next.success) this.current = next.data;
    }
    if (this.current === before) return false;
    this.apply(this.current);
    // Changes held while the file couldn't be read (no save is due for them) are saved now, on top of the user's own.
    if (this.pending && !this.pendingTimer) { try { this.flush(); } catch { /* saved with the next change */ } }
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
    // A hand edit since Ember last looked comes first (or the file that couldn't be read): the patch goes on top of it.
    // (A repairable edit is repaired now, not waited on: Ember saves anyway.)
    if (this.unread || this.mtime() !== this.seen) { try { this.read(true, false); } catch { /* keep what is in memory */ } }
    // A change not saved yet (held while the file couldn't be read, or a slider's) goes on top of what was just read,
    // as reloadIfChanged() does it, and is saved with this one (review #83).
    const next = SettingsSchema.parse({ ...this.current, ...this.pending, ...patch });
    if (next.onboarded && !hasConsent(next)) throw new Error("onboarding can't finish before the user gives consent");
    if (this.unread) {
      // Saving would replace the user's unreadable file with defaults: the change is used now and saved on top of
      // their settings once the file reads again (review #83).
      this.pending = { ...this.pending, ...patch };
    } else if (opts.soon) {
      this.pending = { ...this.pending, ...patch };
      if (!this.pendingTimer) {
        // Let go of before saving: a save that fails leaves the next change free to set a new one (review #84).
        this.pendingTimer = setTimeout(() => { this.pendingTimer = null; try { this.flush(); } catch { /* saved with the next change */ } }, 400);
        this.pendingTimer.unref?.();
      }
    } else {
      // Saved first: memory changes only once the change is on disk.
      this.persist(next, false);
      this.clearPending();
      this.savedOverBroken();
    }
    this.apply(next);
    for (const fn of this.listeners) fn(this.effective);
    return this.effective;
  }

  /** Saves a change made with `soon` now (also done on quit); nothing while the file can't be read (review #83). */
  flush(): void {
    if (!this.pending || this.unread) return;
    this.persist(this.current, true);
    this.clearPending();
    this.savedOverBroken();
  }

  /** The notice a failed save raised (the next save that works takes it away). */
  private saveNotice: string | null = null;

  /**
   * save(), with its failure said plainly (review #84): every window's notice says why (the error is thrown on as it
   * came; plainSaveError words it for the settings window). `later`: the change stays in use and is saved later.
   */
  private persist(settings: Settings, later: boolean): void {
    try {
      this.save(settings);
    } catch (err) {
      this.saveNotice = saveFailure(err, later);
      this.problem(this.saveNotice);
      throw err;
    }
    this.withdraw(this.saveNotice);
    this.saveNotice = null;
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
