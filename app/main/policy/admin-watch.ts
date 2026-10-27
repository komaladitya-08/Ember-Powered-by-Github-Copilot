/**
 * The administrator's policy while Ember runs (review #112): read again every 10 seconds, as the remote's helper reads
 * its own (app/remote/admin.ts PolicyWatch), so a policy tightened, repaired or removed doesn't wait for the next login.
 * Only the first change is reported: main then holds Ember locked down until it is restarted (admin.ts
 * heldUntilRestart), and the restart reads whatever the policy says by then. A change counts once the next read says
 * the same new thing: one bad read (a file caught mid-write by an editor or a management tool, a registry read that
 * failed once) is let pass when the read after it says what the policy said at start. Reads that keep differing from
 * the start, but not in the same way, count as a change by the third (fail closed). A read that throws counts as a
 * policy that can't be used. Plain Node: the reader is the platform's policy source, passed in.
 */

import { lockedDown, samePolicy, type LoadedAdminPolicy } from "../admin";

/** How often the policy is read again (the remote's helper's interval too). */
export const ADMIN_WATCH_MS = 10_000;

/** Reads in a row that differ from the start, whatever they say, after which the policy counts as changed. */
const DIFFERING_READS = 3;

/** What watchAdminPolicy needs. */
export interface AdminWatchOptions {
  /** The policy Ember started with. */
  first: LoadedAdminPolicy;
  /** Reads the policy now (the platform's AdminPolicySource.load). */
  read: () => LoadedAdminPolicy;
  /** The policy says something else than at start (called once, with what it says now). */
  onChange: (next: LoadedAdminPolicy) => void;
  /** How often to read it (ms; ADMIN_WATCH_MS). */
  every?: number;
}

/** Starts reading the policy every `every` ms; returns the function that stops it. */
export function watchAdminPolicy(o: AdminWatchOptions): () => void {
  // The reads in a row that differed from the start, the last one last.
  let differing: LoadedAdminPolicy[] = [];
  const timer = setInterval(() => {
    let next: LoadedAdminPolicy;
    try {
      next = o.read();
    } catch (err) {
      next = lockedDown(o.first.source ?? "the administrator's policy", `it couldn't be read: ${(err as Error).message}`);
    }
    if (samePolicy(o.first, next)) {
      differing = [];
      return;
    }
    const confirmed = differing.length > 0 && samePolicy(differing[differing.length - 1], next);
    differing.push(next);
    if (!confirmed && differing.length < DIFFERING_READS) return;
    clearInterval(timer);
    o.onChange(next);
  }, o.every ?? ADMIN_WATCH_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
