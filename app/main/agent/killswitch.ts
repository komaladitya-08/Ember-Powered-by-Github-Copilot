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

export type StopSource = "hotkey" | "voice" | "menu";

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
