/**
 * Ember's accessibility sidecar host on Windows and macOS (bundled as dist/app/ax-sidecar.cjs and run by Ember's own
 * binary with ELECTRON_RUN_AS_NODE=1). It reads newline-delimited JSON-RPC requests on stdin and answers each on
 * stdout, one at a time and in order, exactly as the Python AT-SPI sidecar does on Linux, so Ember's client
 * (app/main/perception/sidecar.ts) works with either. stdout carries protocol lines only (anything else printing goes
 * to stderr, which Ember only logs); a bad line gets an error answer, never a crash; and when stdin closes (Ember quit
 * or killed it) the host stops its provider (the Windows bridge with it) and exits.
 *
 * Environment: EMBER_ATSPI_ID_BASE (where this process's element ids start, from Ember); EMBER_UIA_SCRIPT and
 * EMBER_UIA_CACHE (Windows: the bridge's bootstrap script and its compiled-assembly cache, from Ember's launch); and
 * for tests in a development tree only, EMBER_AX_PROVIDER=fake with EMBER_AX_FAKE_DESKTOP / EMBER_AX_FAKE_LOG (see
 * providers/index.ts and providers/fake.ts).
 */

import readline from "node:readline";
import { Host } from "./host";
import { encodeError } from "./protocol";
import { openProvider } from "./providers";

/** A note for Ember's log (it logs this process's stderr): events and sizes, never screen text. */
function note(event: string, fields: Record<string, unknown> = {}): void {
  try {
    process.stderr.write(JSON.stringify({ event, ...fields }) + "\n");
  } catch {
    // stderr is gone too: nothing to tell.
  }
}

// Protocol lines only on stdout: a dependency printing there would corrupt an answer.
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
process.on("uncaughtException", err => note("host.uncaught", { error: err instanceof Error ? err.message : String(err) }));
process.on("unhandledRejection", err => note("host.unhandled", { error: err instanceof Error ? err.message : String(err) }));
// Ember went away while an answer was on its way: nobody is left to answer.
process.stdout.on("error", () => process.exit(0));

const provider = openProvider();
const host = new Host(provider, { note });
const queue: string[] = [];
let working = false;
let closed = false;

/** Answers the queued requests one at a time, in order. */
async function pump(): Promise<void> {
  if (working) return;
  working = true;
  while (queue.length) {
    const line = queue.shift()!;
    let answer: string | null;
    try {
      answer = await host.handle(line);
    } catch (err) {
      answer = encodeError(null, err instanceof Error ? err.message : String(err)); // handle() never throws; just in case
    }
    if (answer !== null) process.stdout.write(answer + "\n");
  }
  working = false;
  if (closed) exit();
}

/** stdin closed: the provider stops (the Windows bridge is killed), and the host exits once its answers are out. */
function exit(): void {
  try {
    provider.stop();
  } catch (err) {
    note("host.stop_failed", { error: err instanceof Error ? err.message : String(err) });
  }
  process.stdout.write("", () => process.exit(0));
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  queue.push(line);
  void pump();
});
input.on("close", () => {
  closed = true;
  if (!working) exit();
});
