/**
 * The kill switch (M8.9): Ctrl+Alt+X, "Ember, stop", or Stop in the handle menu.
 * Every part is told to stop at once (tasks, questions, the answer being
 * written, a borrowed mouse, Ember's flight, speech); none waits for another.
 * It returns once all have stopped, or after 300 ms with whatever is still
 * winding down left to finish on its own (nothing more is sent to apps by then).
 */

import type { Logger } from "../logger";
import type { AuditLog } from "../policy/audit";

export interface StopPart {
  name: string;
  stop: () => void | Promise<unknown>;
}

/**
 * Who pulled it: Ember's shortcut, "Ember, stop", the handle's menu, settings' Stop everything, Stop on a remote's
 * notice by someone at that screen, or the administrator's policy changing while Ember ran.
 */
export type StopSource = "hotkey" | "voice" | "menu" | "settings" | "remote-console" | "policy";

export class KillSwitch {
  constructor(private parts: () => StopPart[], private log: Logger, private audit?: () => AuditLog | null) {}

  async pull(source: StopSource): Promise<{ ms: number; late: string[] }> {
    const t0 = performance.now();
    const pending = new Set<string>();
    const all = this.parts().map(p => {
      pending.add(p.name);
      let result: Promise<unknown>;
      try {
        result = Promise.resolve(p.stop());
      } catch (err) {
        result = Promise.reject(err);
      }
      return result
        .catch(err => this.log.warn("killswitch.part_failed", { part: p.name, err }))
        .finally(() => pending.delete(p.name));
    });
    await Promise.race([Promise.all(all), new Promise(r => setTimeout(r, 300))]);
    const ms = Math.round(performance.now() - t0);
    const late = [...pending];
    this.log.info("killswitch.pulled", { source, ms, late });
    try { this.audit?.()?.write({ event: "stop", source, ms }); } catch { /* the stop matters more than its record */ }
    return { ms, late };
  }
}

/** The parts the bubble names when they are late, in plain words (the overlay's own motion is never named). */
const PART_WORDS: Readonly<Record<string, string | null>> = {
  borrow: "the borrowed mouse", speech: "speaking", listening: "listening", agent: "tasks", targets: "commands", desk: "Ember's desk", motion: null,
};

/** "a", "a and b", "a, b and c". */
const listed = (xs: readonly string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * What the "Stopped" bubble says when parts were still winding down after the kill switch's wait (`late`, from pull()),
 * or null when everything stopped in time: the parts in plain words, and with commands the computers they may still be
 * stopping on (`computers`: the ones connected over SSH).
 */
export function stillStoppingWords(late: readonly string[], computers: readonly string[] = []): string | null {
  const words: string[] = [];
  for (const part of late) {
    const w = part in PART_WORDS ? PART_WORDS[part] : "another part of Ember";
    if (w && !words.includes(w)) words.push(w);
    if (part === "targets") for (const c of computers) if (!words.includes(c)) words.push(c);
  }
  return words.length ? `I've told everything to stop. Still stopping: ${listed(words)}…` : null;
}
