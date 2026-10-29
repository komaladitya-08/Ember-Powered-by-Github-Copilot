/**
 * Electron's utilityProcess.fork, played by Node so the tests run on every OS (review #177: Ember's macOS
 * accessibility host runs as a utility process). The child is a Node process with stdout and stderr piped and an IPC
 * channel standing in for the parent port: a preloaded shim gives it `process.parentPort` as Electron's utility process
 * has it (messages arrive as `{ data, ports }`). Like Electron's, `pid` is undefined until the child has spawned and
 * again after it exits, `kill()` answers false then, and `exit` carries a number.
 */

import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UtilityChild, UtilityFork } from "../../app/main/perception/sidecar";

const SHIM = `
const { EventEmitter } = require("node:events");
const port = new EventEmitter();
port.postMessage = m => process.send(m);
process.on("message", data => port.emit("message", { data, ports: [] }));
process.parentPort = port;
`;

let shimFile = "";
function shim(): string {
  if (!shimFile) {
    shimFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-utility-shim-")), "parent-port.cjs");
    fs.writeFileSync(shimFile, SHIM);
  }
  return shimFile;
}

/** One fork the fake was asked for, and the Node child that plays it. */
export interface ForkCall { modulePath: string; args: string[]; options: Parameters<UtilityFork>[2]; child: ChildProcess }

/** A fake fork, and every call made to it. `fail` makes the next call throw, as Electron's does before ready. */
export function fakeFork(): { fork: UtilityFork; calls: ForkCall[]; fail: (message: string) => void } {
  const calls: ForkCall[] = [];
  let failing: string | null = null;
  const forkFn: UtilityFork = (modulePath, args, options) => {
    if (failing) { const m = failing; failing = null; throw new Error(m); }
    const child = fork(modulePath, args, { env: options.env, stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: ["--require", shim()] });
    calls.push({ modulePath, args, options, child });
    let spawned = false, exited = false;
    const proc = new EventEmitter() as EventEmitter & UtilityChild;
    Object.assign(proc, {
      stdout: child.stdout,
      stderr: child.stderr,
      postMessage: (m: unknown) => { if (child.connected) child.send(m as string); },
      kill: () => (spawned && !exited ? child.kill() : false),
    });
    Object.defineProperty(proc, "pid", { get: () => (spawned && !exited ? child.pid : undefined) });
    child.on("spawn", () => { spawned = true; proc.emit("spawn"); });
    child.on("exit", code => { exited = true; proc.emit("exit", code ?? 1); });
    child.on("error", () => undefined);
    return proc;
  };
  return { fork: forkFn, calls, fail: m => { failing = m; } };
}
