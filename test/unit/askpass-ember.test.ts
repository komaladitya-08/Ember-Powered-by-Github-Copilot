/**
 * SSH's askpass on macOS as Ember itself (review #177, owner decision D-177): the switch main.ts looks for first, the
 * main thread's blocked wait for the worker (askpassInEmber, with fakes for the worker, the wait and the clock), the
 * worker's side (runAskpassWorker, against the real server over an in-memory socket), and both together with a real
 * worker thread on the built askpass.cjs and a real Unix socket where the temporary folder allows one.
 */

import { buildSync } from "esbuild";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { runAskpassWorker } from "../../app/askpass/main";
import { ASKPASS_SWITCH, BEAT_MS, SILENT_MS, START_MS, askpassInEmber, isAskpassRun, type AskpassWorkerData } from "../../app/askpass/in-ember";
import { createAskpassServer, serveConnections, socketBases, type AskpassFs, type AskpassHandler } from "../../app/main/remote/askpass-server";

const NONCE = "0123456789abcdef0123456789abcdef";
const SOCK = "/var/folders/xy/T/ea-abc123/a.sock";

/** Two in-memory sockets wired to each other (a helper's end and the server's end). */
function socketPair(): [Duplex, Duplex] {
  const aToB = new PassThrough(), bToA = new PassThrough();
  const make = (read: PassThrough, write: PassThrough) => {
    const d = new Duplex({
      read() { /* pushed from `read` below */ },
      write(chunk, _enc, cb) { write.write(chunk); cb(); },
      final(cb) { write.end(); cb(); },
    });
    read.on("data", c => d.push(c));
    read.on("end", () => { d.push(null); setImmediate(() => d.destroy()); });
    d.on("close", () => { if (!write.writableEnded) write.end(); });
    return d;
  };
  return [make(bToA, aToB), make(aToB, bToA)];
}

const shared = (): { data: AskpassWorkerData; state: Int32Array } => {
  const buffer = new SharedArrayBuffer(8);
  return { data: { emberAskpass: true, state: buffer }, state: new Int32Array(buffer) };
};

describe("Ember's askpass switch", () => {
  it("is --ember-askpass, alone, wherever it comes (packaged, or after the development tree's folder)", () => {
    expect(ASKPASS_SWITCH).toBe("--ember-askpass");
    expect(isAskpassRun(["/Applications/Ember.app/Contents/MacOS/Ember", "--ember-askpass"])).toBe(true);
    expect(isAskpassRun(["/x/Electron.app/Contents/MacOS/Electron", "/Users/ana/src/ember", "--ember-askpass"])).toBe(true);
    expect(isAskpassRun(["/Applications/Ember.app/Contents/MacOS/Ember"])).toBe(false);
    expect(isAskpassRun(["/Applications/Ember.app/Contents/MacOS/Ember", "--ember-askpass=1", "--autostart"])).toBe(false);
  });
});

describe("askpassInEmber (the main thread, blocked until the worker has answered)", () => {
  /** A clock the fake wait moves on by the slice it was asked to wait. */
  function clock() {
    let t = 1_000_000;
    return { now: () => t, wait: (_s: Int32Array, _i: number, _v: number, ms: number) => { t += ms; return "timed-out"; } };
  }

  it("gives the worker's exit code once it has answered: 0 for an answer printed, 1 for a cancel", () => {
    for (const [stored, code] of [[1, 0], [2, 1]] as const) {
      const c = clock();
      let started: { script: string; data: AskpassWorkerData } | null = null;
      const got = askpassInEmber({
        script: "/A/dist/app/askpass.cjs", exists: p => p === "/A/dist/app/askpass.cjs", now: c.now, wait: c.wait,
        startWorker: (script, data) => {
          started = { script, data };
          const state = new Int32Array(data.state);
          Atomics.add(state, 1, 1);
          Atomics.store(state, 0, stored);
        },
      });
      expect(got).toBe(code);
      expect(started!.script).toBe("/A/dist/app/askpass.cjs");
      expect(started!.data.emberAskpass).toBe(true);
    }
  });

  it("waits as long as the worker beats (the user may take minutes to answer), then gives its code", () => {
    const c = clock();
    let state: Int32Array | null = null;
    let waits = 0;
    const got = askpassInEmber({
      script: "s", exists: () => true, now: c.now,
      startWorker: (_s, data) => { state = new Int32Array(data.state); },
      wait: (s, i, v, ms) => {
        waits++;
        // A beat every BEAT_MS for ten minutes, then the answer.
        if (waits * ms % BEAT_MS === 0) Atomics.add(state!, 1, 1);
        if (waits * ms >= 10 * 60_000) Atomics.store(state!, 0, 1);
        return c.wait(s, i, v, ms);
      },
    });
    expect(got).toBe(0);
  });

  it("gives up (1, cancelled for ssh) when the worker never starts, or stops beating, instead of waiting for ever", () => {
    const c = clock();
    const t0 = c.now();
    expect(askpassInEmber({ script: "s", exists: () => true, now: c.now, wait: c.wait, startWorker: () => undefined })).toBe(1);
    expect(c.now() - t0).toBeGreaterThan(START_MS);
    expect(c.now() - t0).toBeLessThan(START_MS + 1000);
    const d = clock();
    let state: Int32Array | null = null;
    let beats = 3;
    const t1 = d.now();
    const got = askpassInEmber({
      script: "s", exists: () => true, now: d.now,
      startWorker: (_s, data) => { state = new Int32Array(data.state); Atomics.add(state, 1, 1); },
      wait: (s, i, v, ms) => { if (beats-- > 0) Atomics.add(state!, 1, 1); return d.wait(s, i, v, ms); },
    });
    expect(got).toBe(1);
    expect(d.now() - t1).toBeGreaterThan(SILENT_MS);
    expect(d.now() - t1).toBeLessThan(SILENT_MS + 2000);
  });

  it("gives 1 at once without its helper file, or when the worker can't be started", () => {
    let started = false;
    expect(askpassInEmber({ script: "/gone/askpass.cjs", exists: () => false, startWorker: () => { started = true; } })).toBe(1);
    expect(started).toBe(false);
    expect(askpassInEmber({ script: "s", exists: () => true, startWorker: () => { throw new Error("no threads"); } })).toBe(1);
  });
});

describe("runAskpassWorker (the worker thread: askpass.cjs's helper, answering into shared memory)", () => {
  async function run(handler: AskpassHandler, env: Record<string, string | undefined>) {
    const [client, server] = socketPair();
    serveConnections(NONCE, handler)(server as unknown as net.Socket);
    const { data, state } = shared();
    const out: string[] = [];
    await runAskpassWorker(data, {
      env,
      write: t => out.push(t),
      connect: () => { setImmediate(() => client.emit("connect")); return client as unknown as net.Socket; },
    });
    return { out: out.join(""), done: Atomics.load(state, 0), beats: Atomics.load(state, 1) };
  }

  it("asks with the prompt from its environment, prints the answer and stores 1 (exit 0), having beaten from the start", async () => {
    const asked: string[] = [];
    const r = await run(async req => { asked.push(`${req.mode}: ${req.prompt}`); return "pässwörd"; },
      { EMBER_ASKPASS_SOCK: SOCK, EMBER_ASKPASS_NONCE: NONCE, EMBER_ASKPASS_PROMPT: "ana@build-01's password: " });
    expect(asked).toEqual(["secret: ana@build-01's password: "]);
    expect(r).toEqual({ out: "pässwörd\n", done: 1, beats: 1 });
  });

  it("stores 2 (exit 1) for a cancel, a wrong nonce or no socket, printing nothing", async () => {
    expect(await run(async () => null, { EMBER_ASKPASS_SOCK: SOCK, EMBER_ASKPASS_NONCE: NONCE, EMBER_ASKPASS_PROMPT: "p" })).toMatchObject({ out: "", done: 2 });
    expect(await run(async () => "x", { EMBER_ASKPASS_SOCK: SOCK, EMBER_ASKPASS_NONCE: NONCE.replace("0", "f"), EMBER_ASKPASS_PROMPT: "p" })).toMatchObject({ out: "", done: 2 });
    expect(await run(async () => "x", { EMBER_ASKPASS_NONCE: NONCE })).toMatchObject({ out: "", done: 2 });
  });

  it("tells ssh's confirm prompt by SSH_ASKPASS_PROMPT, as askpass.cjs does", async () => {
    const modes: string[] = [];
    await run(async req => { modes.push(req.mode); return "yes"; }, { EMBER_ASKPASS_SOCK: SOCK, EMBER_ASKPASS_NONCE: NONCE, EMBER_ASKPASS_PROMPT: "Allow?", SSH_ASKPASS_PROMPT: "confirm" });
    expect(modes).toEqual(["confirm"]);
  });
});

// A real worker thread on the built helper, and a real Unix socket (a temporary folder whose path is POSIX).
const root = fileURLToPath(new URL("../../", import.meta.url));
const tmp = fs.realpathSync(os.tmpdir());
describe.skipIf(!tmp.startsWith("/"))("askpass.cjs as a worker thread, against Ember's real askpass server", () => {
  /** The helper as npm run build bundles it (scripts/build-app.mjs), into .cache/test (a development tree). */
  function buildHelper(): string {
    const out = path.join(root, ".cache", "test", "askpass.cjs");
    const part = `${out}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    buildSync({ entryPoints: [path.join(root, "app/askpass/main.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron", "koffi"], outfile: part, logLevel: "silent" });
    fs.renameSync(part, out);
    return out;
  }

  it("answers through the socket and nonce Ember made for the run, and the worker stores 1 (exit 0)", async () => {
    const script = buildHelper();
    const dir = fs.mkdtempSync(path.join(tmp, "ember-askpass-worker-"));
    const channel = await createAskpassServer({
      bases: socketBases({ os: "linux", userData: dir }), fs: fs.promises as unknown as AskpassFs,
      handler: async req => (req.prompt === "Password for build-01:" ? "s3cret" : null),
    });
    const { data, state } = shared();
    const outFile = path.join(dir, "out.txt");
    // Ember's worker writes the answer to file descriptor 1 (ssh's pipe); this one, to a file the test reads.
    const fd = fs.openSync(outFile, "w");
    const worker = new Worker(script, {
      workerData: { ...data, fd }, stdout: true, stderr: true,
      env: { EMBER_ASKPASS_SOCK: channel.address, EMBER_ASKPASS_NONCE: channel.nonce, EMBER_ASKPASS_PROMPT: "Password for build-01:" },
    });
    try {
      for (let i = 0; i < 200 && !Atomics.load(state, 0); i++) await new Promise(r => setTimeout(r, 25));
      expect(Atomics.load(state, 0)).toBe(1);
      expect(Atomics.load(state, 1)).toBeGreaterThanOrEqual(1);
      expect(fs.readFileSync(outFile, "utf8")).toBe("s3cret\n");
    } finally {
      await worker.terminate();
      fs.closeSync(fd);
      await channel.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
