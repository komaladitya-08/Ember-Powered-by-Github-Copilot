/**
 * Ember's accessibility sidecar host on Windows and macOS (bundled as dist/app/ax-sidecar.cjs). On Windows Ember runs it
 * with its own binary in node mode (ELECTRON_RUN_AS_NODE=1); on macOS as an Electron utility process, Ember's child,
 * because the macOS build refuses node mode (review #177). It reads newline-delimited JSON-RPC requests (on stdin, or
 * as messages on Electron's parent port, a utility process having no stdin) and answers each on stdout, one at a time
 * and in order, exactly as the Python AT-SPI sidecar does on Linux, so Ember's client (app/main/perception/sidecar.ts)
 * works with either. stdout carries protocol lines only (anything else printing goes to stderr, which Ember only logs);
 * a bad line gets an error answer, never a crash; and when stdin closes, or a utility process finds Ember gone (its
 * parent changed), the host stops its provider (the Windows bridge with it) and exits. Ember ends a utility process
 * itself when it stops the host (Electron sends SIGTERM).
 *
 * Environment: EMBER_ATSPI_ID_BASE (where this process's element ids start, from Ember); EMBER_OWNER_PID (Ember's own
 * process, never read; else this process's parent); EMBER_UIA_SCRIPT and EMBER_UIA_CACHE (Windows: the bridge's
 * bootstrap script and its compiled-assembly cache, from Ember's launch); and for tests in a development tree only,
 * EMBER_AX_PROVIDER=fake with EMBER_AX_FAKE_DESKTOP / EMBER_AX_FAKE_LOG (see providers/index.ts and providers/fake.ts).
 */

import readline from "node:readline";
import { Host } from "./host";
import { encodeError } from "./protocol";
import { ownerPid } from "./provider";
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
// Ember's own process: never read (EMBER_OWNER_PID from Ember's launch, else this process's parent, which is Ember).
const owner = ownerPid(process.env, process.ppid);
const provider = openProvider(process.env, process.platform, typeof __filename === "string" ? __filename : "", owner);
// Ember went away while an answer was on its way: nobody is left to answer (the Windows bridge stops with the host).
process.stdout.on("error", () => {
  try {
    provider.stop();
  } catch {
    // Stopping it failed too: it exits when its input closes with this process.
  }
  process.exit(0);
});
const host = new Host(provider, { note, ownerPid: owner });
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

/** Electron's parent port, in a utility process only. */
interface ParentPort { on(event: "message", listener: (e: { data: unknown }) => void): unknown }
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;

/** How often a utility process looks whether Ember, its parent, is still there (stdin's close tells a spawned host). */
const PARENT_CHECK_MS = 2000;

if (parentPort) {
  // Each message is one request line (Ember's client sends it with its newline); a message holding several is taken
  // line by line, as stdin's would be.
  parentPort.on("message", e => {
    if (typeof e.data !== "string") {
      note("host.bad_message", { type: typeof e.data });
      return;
    }
    const lines = e.data.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    queue.push(...lines);
    void pump();
  });
  // Ember gone (crashed or killed): this process is the system's child now, and nobody is left to answer.
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid === parent) return;
    closed = true;
    if (!working) exit();
  }, PARENT_CHECK_MS).unref();
} else {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", line => {
    queue.push(line);
    void pump();
  });
  input.on("close", () => {
    closed = true;
    if (!working) exit();
  });
}
