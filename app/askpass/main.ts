/**
 * Ember's askpass helper on Linux and macOS PCs (§5.1.6; owned by package SA): ssh runs it for a password, passphrase,
 * code or a new host key. It asks Ember over the per-run socket named in EMBER_ASKPASS_SOCK, proving itself with
 * EMBER_ASKPASS_NONCE, prints the answer for ssh and exits 0; anything else (no Ember, a cancel, a malformed answer)
 * exits 1, which ssh takes as "cancelled". It logs nothing, writes nothing to disk, and keeps nothing. Built to
 * dist/app/askpass.cjs, which runs two ways:
 * - Linux: as plain Node (ELECTRON_RUN_AS_NODE=1, through the two-line wrapper Ember writes), with ssh's prompt as its
 *   one argument after the script path, so Node never reads the prompt as an option;
 * - macOS, whose build refuses node mode (review #177): as a worker thread of Ember itself in its askpass mode
 *   (in-ember.ts), the prompt in EMBER_ASKPASS_PROMPT, the answer written straight to file descriptor 1 and the exit
 *   code handed to the blocked main thread through shared memory.
 */

import fs from "node:fs";
import net from "node:net";
import { isMainThread, workerData } from "node:worker_threads";
import { BEAT_MS, type AskpassWorkerData } from "./in-ember";

/** The longest prompt sent (ssh's text, cut), and the longest answer line read. */
const PROMPT_MAX = 2048;
const ANSWER_MAX = 64 * 1024;

/** What the helper needs from its process (injected in tests). */
export interface AskpassIo {
  argv: readonly string[];
  /** ssh's prompt, when it doesn't come as the arguments after the script path (Ember's askpass mode). */
  prompt?: string;
  env: Readonly<Record<string, string | undefined>>;
  write(text: string): void;
  connect(path: string): net.Socket;
}

/** Runs the helper: resolves the exit code (0: answered; 1: cancelled or failed). */
export function runAskpass(io: AskpassIo): Promise<number> {
  const sock = io.env.EMBER_ASKPASS_SOCK ?? "";
  const nonce = io.env.EMBER_ASKPASS_NONCE ?? "";
  if (!/^[0-9a-f]{32}$/.test(nonce) || !sock.startsWith("/") || sock.length > 200) return Promise.resolve(1);
  const prompt = (io.prompt ?? io.argv.slice(2).join(" ")).slice(0, PROMPT_MAX);
  const hint = io.env.SSH_ASKPASS_PROMPT;
  const mode = hint === "confirm" ? "confirm" : hint === "none" ? "notify" : "secret";
  return new Promise(resolve => {
    let done = false;
    let buf = "";
    const conn = io.connect(sock);
    const finish = (code: number) => {
      if (done) return;
      done = true;
      conn.destroy();
      resolve(code);
    };
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`${JSON.stringify({ v: 1, nonce, mode, prompt })}\n`));
    conn.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > ANSWER_MAX) return finish(1);
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let answer: unknown;
      try {
        answer = JSON.parse(buf.slice(0, nl));
      } catch {
        return finish(1);
      }
      const a = answer as { ok?: unknown; value64?: unknown };
      if (a.ok !== true || typeof a.value64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.value64)) return finish(1);
      io.write(`${Buffer.from(a.value64, "base64").toString("utf8")}\n`);
      finish(0);
    });
    conn.on("error", () => finish(1));
    conn.on("close", () => finish(1));
  });
}

/**
 * The helper as Ember's askpass worker (macOS): beats in `state[1]` from the start and every BEAT_MS (so the blocked
 * main thread knows it is alive while the user takes their time), asks with the prompt in EMBER_ASKPASS_PROMPT, and
 * stores the outcome in `state[0]` (1 answered, 2 not), waking the main thread. `io.write` must have written the answer
 * by the time it returns: the main thread ends the process as soon as the outcome is stored.
 */
export async function runAskpassWorker(data: AskpassWorkerData, io: Omit<AskpassIo, "argv" | "prompt">): Promise<void> {
  const state = new Int32Array(data.state);
  Atomics.add(state, 1, 1);
  const beat = setInterval(() => Atomics.add(state, 1, 1), BEAT_MS);
  let code = 1;
  try {
    code = await runAskpass({ ...io, argv: [], prompt: io.env.EMBER_ASKPASS_PROMPT ?? "" });
  } catch {
    code = 1; // runAskpass resolves on every path; a throw is a failure all the same
  } finally {
    clearInterval(beat);
    Atomics.store(state, 0, code === 0 ? 1 : 2);
    Atomics.notify(state, 0);
  }
}

/** Writes all of `text` to `fd`, synchronously (a pipe may take it in parts). */
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  for (let at = 0; at < bytes.length;) {
    try {
      at += fs.writeSync(fd, bytes, at, bytes.length - at);
    } catch (err) {
      // A non-blocking pipe that is full for now: wait a moment and go on. Anything else (ssh gone) fails the run.
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

/** Runs the helper as a process. */
export function main(): void {
  void runAskpass({
    argv: process.argv,
    env: process.env,
    write: text => process.stdout.write(text),
    connect: path => net.connect(path),
  }).then(code => {
    // Let stdout flush the answer before the process ends.
    process.stdout.write("", () => process.exit(code));
  });
}

/** Runs the helper as Ember's askpass worker (see runAskpassWorker). Any failure still ends in an outcome stored. */
function workerMain(data: AskpassWorkerData): void {
  const state = new Int32Array(data.state);
  process.on("uncaughtException", () => { Atomics.store(state, 0, 2); Atomics.notify(state, 0); });
  void runAskpassWorker(data, {
    env: process.env,
    write: text => writeAll(data.fd ?? 1, text),
    connect: path => net.connect(path),
  });
}

// Only when run as dist/app/askpass.cjs (esbuild's CommonJS entry), never when a test imports the module: as a process
// (Linux), or as the worker thread of Ember's askpass mode (macOS), which names itself in its workerData.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module && isMainThread) main();
else if (!isMainThread && (workerData as Partial<AskpassWorkerData> | null)?.emberAskpass === true) workerMain(workerData as AskpassWorkerData);
