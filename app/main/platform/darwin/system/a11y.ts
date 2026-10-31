/**
 * The accessibility preferences Ember follows on a Mac: is VoiceOver running (Ember then speaks its replies, questions
 * and results too, unless the user chose Never for speaking: app/shared/speech.ts), and does the user want less motion. VoiceOver runs as its own process only while it is on, so `pgrep -x VoiceOver`
 * is the test; `defaults read com.apple.universalaccess voiceOverOnOffKey` is only a second opinion for when pgrep
 * can't run (the key is missing until VoiceOver was toggled once, and the domain is privacy-protected on recent
 * releases). Never app.isAccessibilitySupportEnabled(): any accessibility client, Ember's own helper included, turns
 * it on. maySpeak asks synchronously, so the probe runs in the background every 60 s from creation and
 * screenReaderOn() answers its last result.
 */

import type { A11yProbes, SystemPreferencesLike } from "../../types";
import { execRun, type Run } from "./exec";

/** How often VoiceOver's state is probed. */
export const PROBE_MS = 60_000;

/** What darwinA11y() takes. */
export interface DarwinA11yDeps {
  systemPreferences: Pick<SystemPreferencesLike, "getAnimationSettings">;
  run?: Run;
  /** Seam for the tests: schedules the repeating probe (default setInterval, unref'd so it never keeps Ember alive). */
  every?: (fn: () => void, ms: number) => void;
}

/** Is VoiceOver running? true or false from pgrep; from defaults only when pgrep couldn't tell; null when neither could. */
export async function voiceOverRunning(run: Run): Promise<boolean | null> {
  const p = await run("/usr/bin/pgrep", ["-x", "VoiceOver"], { timeout: 5000 });
  if (p.code === 0) return true;
  if (p.code === 1) return false;
  const d = await run("/usr/bin/defaults", ["read", "com.apple.universalaccess", "voiceOverOnOffKey"], { timeout: 5000 });
  if (d.code === 0) return d.stdout.trim() === "1";
  return null;
}

/** The macOS accessibility probes (design §9.10). */
export function darwinA11y(d: DarwinA11yDeps): A11yProbes {
  const run = d.run ?? execRun;
  const every = d.every ?? ((fn: () => void, ms: number) => { setInterval(fn, ms).unref(); });
  let on = false;
  let busy = false;
  const probe = () => {
    if (busy) return;
    busy = true;
    voiceOverRunning(run).then(v => {
      if (v !== null) on = v; // can't tell: keep the last answer
    }, () => { /* a Run never rejects; nothing to keep */ }).finally(() => {
      busy = false;
    });
  };
  probe();
  every(probe, PROBE_MS);
  return {
    screenReaderOn: () => on,
    systemReducedMotion: () => {
      try {
        return !!d.systemPreferences.getAnimationSettings().prefersReducedMotion;
      } catch {
        return false; // can't tell: Ember's own motion setting still applies
      }
    },
  };
}
