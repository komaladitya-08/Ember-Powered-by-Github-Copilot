/**
 * Warms sharp's text drawing on Windows and macOS, once per user. Ember's marks on a screenshot are SVG text drawn by
 * sharp, and the first text sharp draws builds fontconfig's cache of the system's fonts (sharp brings its own
 * fontconfig there; the cache is on disk, per user). On a fresh machine that took seconds to tens of seconds (2 s on
 * one Windows CI runner, more than 15 s on another), paid by the user's first screenshot with marks. So a few seconds
 * after Ember starts it draws one mark's text in the background (sharp does the work on libuv's threads, not the main
 * thread), best effort, and records that in a marker file in userData: later starts do nothing (sharp's work is
 * milliseconds once the cache exists, and loading its library isn't free). Never for `ember --doctor`. Linux keeps what
 * it did: nothing here. Plain Node: the drawing, the clock and the files come in.
 */

import fs from "node:fs";
import type { OS } from "../../shared/shortcuts";
import type { Logger } from "../logger";

/** The OSes where sharp's own fontconfig builds its cache on the first text drawn. */
const WARMS: ReadonlySet<OS> = new Set<OS>(["win32", "darwin"]);

/** How long after start it draws (ms): past start-up's own work and the first read. */
export const TEXT_WARM_DELAY_MS = 10_000;

export interface TextWarmOptions {
  os: OS;
  /** The process's arguments: `--doctor` is a check-up, not a start. */
  argv: readonly string[];
  /** The marker file (in userData), holding `key` once it has been done. */
  marker: string;
  /** What it was done for: Ember's version (an update may bring a sharp whose fontconfig builds a new cache). */
  key: string;
  /** Draws text once with sharp (capture.ts warmText). */
  draw: () => Promise<void>;
  log: Pick<Logger, "info" | "warn">;
  /** How long after start it draws (ms; TEXT_WARM_DELAY_MS). */
  delayMs?: number;
  /** Runs `f` after `ms` without keeping Ember running (default: an unref'd setTimeout). */
  later?: (f: () => void, ms: number) => void;
  /** The marker's file, read (null when it isn't there) and written. */
  files?: { read(file: string): string | null; write(file: string, text: string): void };
}

const DISK: NonNullable<TextWarmOptions["files"]> = {
  read: file => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } },
  write: (file, text) => fs.writeFileSync(file, text, { mode: 0o600 }),
};

let scheduled = false;

/**
 * Schedules the warm-up, once per process: on Windows and macOS, unless Ember started for `--doctor` or a start of
 * this version already did it. True when it was scheduled.
 */
export function scheduleTextWarm(o: TextWarmOptions): boolean {
  if (scheduled || !WARMS.has(o.os) || o.argv.includes("--doctor")) return false;
  const files = o.files ?? DISK;
  if (files.read(o.marker)?.trim() === o.key) return false;
  scheduled = true;
  const later = o.later ?? ((f, ms) => { setTimeout(f, ms).unref?.(); });
  later(() => { void warm(o, files); }, o.delayMs ?? TEXT_WARM_DELAY_MS);
  return true;
}

/** Draws, then writes the marker; a failure is logged (a later start tries again) and goes no further. */
async function warm(o: TextWarmOptions, files: NonNullable<TextWarmOptions["files"]>): Promise<void> {
  const t0 = Date.now();
  try {
    await o.draw();
  } catch (err) {
    o.log.warn("text_warm.failed", { err });
    return;
  }
  o.log.info("text_warm.done", { ms: Date.now() - t0 });
  try { files.write(o.marker, o.key); } catch (err) { o.log.warn("text_warm.marker_failed", { err }); }
}
