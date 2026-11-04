/**
 * Telling the user a newer Ember is out. Off until they turn it on and agree to its note (settings `updates`,
 * FEATURE_CONSENT_VERSION.updates), and the administrator can turn it off (`features.updates`, false under LOCKDOWN).
 *
 * It only tells: Ember's packages aren't signed yet, so nothing is downloaded or installed here. One request a day goes
 * to GitHub's public API with no token and no version of Ember in it, and the link the user opens is built from the
 * version number, never from what the reply says.
 */

import { z } from "zod";
import type { UpdateStatus } from "../shared/ipc";

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
  changed(status: UpdateStatus): void;
  log: { warn(event: string, fields?: Record<string, unknown>): void };
  now?: () => Date;
}

/** Looks once a day while allowed, and asks nothing of the network otherwise. */
export class UpdateChecker {
  private timer: ReturnType<typeof setTimeout> | null = null;
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
    else if (!this.timer) this.schedule(FIRST_CHECK_MS);
    this.o.changed(this.status);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => { this.timer = null; void this.check().finally(() => { if (this.o.allowed() && !this.timer) this.schedule(CHECK_EVERY_MS); }); }, ms);
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
      this.latest = newest !== null && isNewer(newest, this.o.current) ? newest : null;
      this.phase = this.latest ? "available" : "current";
      const told = this.o.told();
      if (this.latest && this.o.allowed() && (told === null || isNewer(this.latest, told))) this.o.announce(this.latest);
    } catch (err) {
      this.phase = "failed";
      this.o.log.warn("updates.check_failed", { err: err instanceof Error ? err.name : "unknown" });
    }
    this.o.changed(this.status);
    return this.status;
  }
}
