/**
 * Telling the user a newer Ember is out. Off until they turn it on and agree to its note (settings `updates`,
 * FEATURE_CONSENT_VERSION.updates), and the administrator can turn it off (`features.updates`, false under LOCKDOWN).
 *
 * It only tells: Ember's packages aren't signed yet, so nothing is downloaded or installed here. One request a day goes
 * to GitHub's public API with no token and no version of Ember in it, and the link the user opens is built from the
 * version number, never from what the reply says.
 */

import path from "node:path";
import { z } from "zod";
import type { OS } from "../shared/shortcuts";
import type { InstallKind, UpdateStatus } from "../shared/ipc";

const REPO = "komaladitya-08/Ember-Powered-by-Github-Copilot";
/** Every release, not /releases/latest: that skips prereleases, and every Ember so far is one. */
export const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
/** The first look comes a minute after start, so it never competes with Ember starting. */
export const FIRST_CHECK_MS = 60_000;
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;
/** Twenty releases' notes are far smaller; a longer reply isn't read. */
const MAX_REPLY_CHARS = 2_000_000;

const Releases = z.array(z.object({ tag_name: z.string(), draft: z.boolean() }).passthrough());

/** `v1.2.3` as numbers, or null for anything else (a test tag, a suffix). */
export function versionOf(tag: string): [number, number, number] | null {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is version `a` newer than `b`? Never when either can't be read. */
export function isNewer(a: string, b: string): boolean {
  const x = versionOf(a), y = versionOf(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The newest published version in GitHub's reply, without its "v", or null when it holds none. */
export function newestVersion(reply: unknown): string | null {
  let best: string | null = null;
  for (const r of Releases.parse(reply)) {
    if (r.draft) continue;
    const v = versionOf(r.tag_name);
    if (!v) continue;
    const version = v.join(".");
    if (best === null || isNewer(version, best)) best = version;
  }
  return best;
}

/** The page of `version`'s release: only ever a number read by versionOf goes in. */
export function releasePage(version: string): string | null {
  const v = versionOf(version);
  return v ? `https://github.com/${REPO}/releases/tag/v${v.join(".")}` : null;
}

/**
 * The system notification that `version` is out, and where clicking it leads: Home's Updates section, at its "See
 * what's new…" (shown while a newer version is out; the section's heading otherwise). The body still says where to go,
 * for a notification centre that doesn't pass the click on.
 */
export function updateNotice(version: string): { title: string; body: string; section: string } {
  return { title: "Ember: a new version is out", body: `Ember ${version} is out. Open Ember's settings to see what's new.`, section: "updates:updates-open" };
}

/** The file the npm launcher (packages/npm/lib/launcher.mjs, MARKER) leaves in each complete version folder. */
export const NPM_MARKER = ".ember-npm-complete";

/**
 * How this Ember was installed, so Home's Updates can say how to update it (install-docs-11), or null when it can't
 * tell (development, a build run from elsewhere). The npm launcher's copy has its marker in the version folder: beside
 * the AppImage, above Ember\Ember.exe, or beside Ember.app. Otherwise the RPM installs into /opt/ember, the AppImage
 * runs with APPIMAGE set (runningAppImage), and Windows and macOS have one package each (the zip; the app, from the dmg
 * or the zip).
 */
export function installKind(o: { os: OS; packaged: boolean; execPath: string; appImage: string | null; exists: (file: string) => boolean }): InstallKind | null {
  if (!o.packaged) return null;
  const p = o.os === "win32" ? path.win32 : path.posix;
  const folder = o.os === "linux" ? (o.appImage ? p.dirname(o.appImage) : null)
    : o.os === "win32" ? p.dirname(p.dirname(o.execPath))
    : p.resolve(o.execPath, "../../../..");
  if (folder !== null && o.exists(p.join(folder, NPM_MARKER))) return "npm";
  if (o.os === "win32") return "zip";
  if (o.os === "darwin") return "app";
  if (o.appImage) return "appimage";
  return o.execPath.startsWith("/opt/ember/") ? "rpm" : null;
}

export interface UpdateCheckerOptions {
  /** Electron's net.fetch in main, so the system's proxy is used. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  current: string;
  /** Turned on, agreed to, allowed by the administrator, and Ember's own consent given. */
  allowed(): boolean;
  /** The last version the user was told about, so each one is announced once. */
  told(): string | null;
  /** A newer version than `told()`: tell the user, and remember it. */
  announce(version: string): void;
  /** When it last asked GitHub (ISO, kept in the settings), or null: a restart then waits out the day (integrations-v3). */
  lastChecked?(): string | null;
  /** It asked GitHub at `at` (ISO): keep it for the next start. */
  checked?(at: string): void;
  changed(status: UpdateStatus): void;
  log: { warn(event: string, fields?: Record<string, unknown>): void };
  now?: () => Date;
}

/** Looks once a day while allowed, and asks nothing of the network otherwise. */
export class UpdateChecker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** A scheduled look is under way. */
  private looking = false;
  private latest: string | null = null;
  private checkedAt: string | null = null;
  private phase: Exclude<UpdateStatus["phase"], "off"> = "idle";

  constructor(private o: UpdateCheckerOptions) {}

  get status(): UpdateStatus {
    if (!this.o.allowed()) return { phase: "off", latest: null, checkedAt: null };
    return { phase: this.phase, latest: this.latest, checkedAt: this.checkedAt };
  }

  /** Settings changed: starts looking if it may and wasn't, stops if it may not. */
  refresh(): void {
    if (!this.o.allowed()) { this.stop(); this.phase = "idle"; this.latest = null; this.checkedAt = null; }
    // Announcing changes the settings, which lands here mid-look: that look schedules the next one itself.
    else if (!this.timer && !this.looking) {
      this.checkedAt ??= this.lastLook();
      // A newer version found before a restart (the one the user was told of) is still out: said again at once, with
      // no request, until the next look or until Ember is that version (integrations-r6).
      const told = this.o.told();
      if (this.phase === "idle" && this.latest === null && told !== null && isNewer(told, this.o.current)) { this.latest = told; this.phase = "available"; }
      this.schedule(this.firstWait());
    }
    this.o.changed(this.status);
  }

  /** The last look's time as kept, or null when there is none or it can't be read. */
  private lastLook(): string | null {
    const at = this.o.lastChecked?.() ?? null;
    return at !== null && Number.isFinite(Date.parse(at)) ? at : null;
  }

  /**
   * How long the first look waits: a minute after start, or until a day after the last look when that is later, so
   * restarting Ember never asks GitHub more than once a day (integrations-v3). Never more than a day: a clock set back
   * doesn't stop it looking.
   */
  private firstWait(): number {
    const at = this.lastLook();
    if (at === null) return FIRST_CHECK_MS;
    const due = Date.parse(at) + CHECK_EVERY_MS - (this.o.now?.() ?? new Date()).getTime();
    return Math.min(CHECK_EVERY_MS, Math.max(FIRST_CHECK_MS, due));
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.looking = true;
      void this.check().finally(() => {
        this.looking = false;
        if (this.o.allowed() && !this.timer) this.schedule(CHECK_EVERY_MS);
      });
    }, ms);
    this.timer.unref?.();
  }

  /** Looks now. A failure only says so in Home: being offline is no reason to bother anyone. */
  async check(): Promise<UpdateStatus> {
    if (!this.o.allowed() || this.phase === "checking") return this.status;
    this.phase = "checking";
    this.o.changed(this.status);
    try {
      const response = await this.o.fetch(RELEASES_URL, {
        headers: { Accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_REPLY_CHARS) throw new Error("reply too long");
      const newest = newestVersion(JSON.parse(text));
      this.checkedAt = (this.o.now?.() ?? new Date()).toISOString();
      this.o.checked?.(this.checkedAt);
      this.latest = newest !== null && isNewer(newest, this.o.current) ? newest : null;
      this.phase = this.latest ? "available" : "current";
      const told = this.o.told();
      if (this.latest && this.o.allowed() && (told === null || isNewer(this.latest, told))) this.o.announce(this.latest);
    } catch (err) {
      this.phase = "failed";
      this.o.log.warn("updates.check_failed", { err: err instanceof Error ? err.name : "unknown" });
      // A look that failed counts too: Home says Ember tries again tomorrow, and a restart keeps to that.
      if (this.o.allowed()) this.o.checked?.((this.o.now?.() ?? new Date()).toISOString());
    }
    this.o.changed(this.status);
    return this.status;
  }
}
