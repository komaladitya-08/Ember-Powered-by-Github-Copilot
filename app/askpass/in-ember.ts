/**
 * SSH's askpass helper on macOS, run as Ember itself (review #177, owner decision D-177). The macOS build refuses node
 * mode (fuses.mjs), so the wrapper ssh runs there (askpass-server.ts's writeAskpassWrapper) starts Ember's own binary
 * with --ember-askpass, and main.ts hands the run to askpassInEmber before anything else of Ember happens. It asks the
 * running Ember exactly as askpass.cjs does on Linux (the same socket, nonce and lines: askpass.cjs itself does the
 * asking, as a worker thread), the answer goes to ssh on stdout, and the exit code is askpass.cjs's (0 answered, 1
 * cancelled or failed).
 *
 * The main thread waits for the worker blocked (Atomics.wait), so Electron never gets as far as its run loop: no
 * single-instance lock, no window, no Dock icon, nothing written to Ember's data folder; main.ts then ends the process
 * with app.exit, which before the run loop exits at once. A worker that never starts, or stops beating, is given up on
 * (exit 1: ssh takes it as cancelled) rather than waited for for ever; a user who takes minutes to answer is waited
 * for. Plain Node APIs only, so the tests run it under Node.
 */

import fs from "node:fs";
import { Worker } from "node:worker_threads";

/** The switch main.ts looks for first: this run is SSH's askpass, nothing else of Ember starts. */
export const ASKPASS_SWITCH = "--ember-askpass";

/** Is this run of Ember's binary SSH's askpass (the switch alone, wherever it comes)? */
export function isAskpassRun(argv: readonly string[]): boolean {
  return argv.includes(ASKPASS_SWITCH);
}

/**
 * What the worker (askpass.cjs) gets. `state[0]`: 0 while it asks, then 1 (answered: exit 0) or 2 (exit 1);
 * `state[1]`: its heartbeat, one more every BEAT_MS. `fd`: where the answer goes (1, ssh's pipe; tests pass a file's).
 */
export interface AskpassWorkerData { emberAskpass: true; state: SharedArrayBuffer; fd?: number }

/** How often the worker beats. */
export const BEAT_MS = 1000;
/** How long the worker may take to start (load askpass.cjs and beat once). */
export const START_MS = 15_000;
/** How long a started worker may go without a beat before it counts as gone (it died without saying). */
export const SILENT_MS = 10_000;
/** How long the main thread sleeps between looks. */
const SLICE_MS = 250;

export interface AskpassInEmberOptions {
  /** dist/app/askpass.cjs, beside main.cjs. */
  script: string;
  exists?: (p: string) => boolean;
  /** Starts the worker (a worker thread on `script`; tests fake it). */
  startWorker?: (script: string, data: AskpassWorkerData) => void;
  /** Atomics.wait (tests fake it, with the clock). */
  wait?: (state: Int32Array, index: number, value: number, ms: number) => unknown;
  now?: () => number;
}

/** Runs SSH's askpass in this process, blocking until it is done: the exit code (0 answered; 1 otherwise). */
export function askpassInEmber(o: AskpassInEmberOptions): number {
  if (!(o.exists ?? fs.existsSync)(o.script)) return 1;
  const buffer = new SharedArrayBuffer(8);
  const state = new Int32Array(buffer);
  try {
    (o.startWorker ?? startWorker)(o.script, { emberAskpass: true, state: buffer });
  } catch {
    return 1; // no worker: nothing can ask
  }
  const wait = o.wait ?? ((s: Int32Array, i: number, v: number, ms: number) => Atomics.wait(s, i, v, ms));
  const now = o.now ?? Date.now;
  let beat = 0;
  let since = now();
  for (;;) {
    const done = Atomics.load(state, 0);
    if (done) return done === 1 ? 0 : 1;
    const b = Atomics.load(state, 1);
    if (b !== beat) {
      beat = b;
      since = now();
    } else if (now() - since > (beat ? SILENT_MS : START_MS)) {
      return 1;
    }
    wait(state, 0, 0, SLICE_MS);
  }
}

/** A worker thread on askpass.cjs. Its own stdout and stderr aren't passed on: the blocked main thread can't relay them. */
function startWorker(script: string, data: AskpassWorkerData): void {
  new Worker(script, { workerData: data, stdout: true, stderr: true }).unref();
}
