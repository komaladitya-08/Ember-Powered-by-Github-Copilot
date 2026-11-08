/**
 * Keeps the setup check's Screen reading row (Windows, macOS: the shared accessibility host's `status`) in step with
 * the helper (reliability-performance-c4-1). It was asked once, 10 s after start, so a bridge that began failing later
 * left the row green while the model, told the helper can't work here, sent the person to the setup check "which says
 * what's wrong"; and one early exit left "didn't start" up for the whole run while reads worked. Now the status is
 * asked again on Check again (waited for, briefly), and in the background when a read finds the helper can't work while
 * the row says it does, or works while the row says it can't. Plain Node, so it is unit-tested with fakes.
 */

import { helperCantRun } from "./perception/sidecar";
import type { HelperStatus } from "./platform/types";

/** Requests that say how the helper is, rather than read: their outcome says nothing about reading. */
const ABOUT_HELPER: ReadonlySet<string> = new Set(["ping", "status", "remember_secrets"]);

export interface HelperWatchOptions {
  /** Asks the host its status and keeps the answer for the row (never rejects). */
  ask: () => Promise<void>;
  /** What the row shows now: the last answer kept (undefined before the first). */
  row: () => HelperStatus | null | undefined;
  /** How long Check again waits for an answer; a later one still lands. */
  waitMs: number;
}

export class HelperWatch {
  /** What reads last found: working, or the helper's answer that it can't work here. */
  private found: "worked" | "cant-run" | null = null;
  /** The finding the status was last asked for: once per finding, so a host that disagrees isn't asked on every read. */
  private askedFor: "worked" | "cant-run" | null = null;
  private asking: Promise<void> | null = null;
  /** Asked for again while an ask was out: its answer may be from before, so one more follows it. */
  private more = false;
  /** The first look after start has been made: reads ask nothing before it, so start-up isn't slowed. */
  private looked = false;

  constructor(private o: HelperWatchOptions) {}

  /** Check again (and the first look after start): asks now, and resolves with the answer or after `waitMs`. */
  again(): Promise<void> {
    this.looked = true;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>(r => { timer = setTimeout(r, this.o.waitMs); });
    return Promise.race([this.ask(), late]).finally(() => clearTimeout(timer));
  }

  /**
   * A request to the helper ended (`err` null: it worked). Asks the status again, in the background, when what it found
   * disagrees with the row; never for an error that may pass (a timeout, a restart, a bridge still starting), and never
   * before the first look (again), which reads the row anyway.
   */
  saw(method: string, err: unknown): void {
    if (!this.looked || ABOUT_HELPER.has(method)) return;
    const found = err == null ? "worked" : helperCantRun(err) ? "cant-run" : null;
    if (!found) return;
    if (found !== this.found) { this.found = found; this.askedFor = null; }
    const works = this.o.row()?.toolkitAccessibility;
    const disagrees = found === "cant-run" ? works !== false : works !== true;
    if (!disagrees || this.askedFor === found) return;
    this.askedFor = found;
    void this.ask();
  }

  private ask(): Promise<void> {
    if (this.asking) { this.more = true; return this.asking; }
    const run = (): Promise<void> => this.o.ask().catch(() => undefined).then(() => {
      if (this.more) { this.more = false; return run(); }
      this.asking = null;
    });
    this.asking = run();
    return this.asking;
  }
}
