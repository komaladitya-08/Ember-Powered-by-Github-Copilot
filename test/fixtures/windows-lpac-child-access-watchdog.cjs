/* Fixed private metadata-only watchdog for the manual child witness. It never reads trace bytes or looks up a PID. */
/* eslint-disable @typescript-eslint/no-require-imports -- A fixed CommonJS worker avoids inheriting a TypeScript loader or arbitrary preload. */
"use strict";
const { isMainThread, parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path/win32");

function childAccessWatchdogReason(files, now, deadline) {
  if (typeof now !== "bigint" || typeof deadline !== "bigint" || now < 0n || deadline < 0n || now > deadline) return 3;
  if (!Array.isArray(files) || files.length !== 2) return 4;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    if (!file || typeof file.exists !== "boolean") return 4;
    if (!file.exists) continue;
    if (file.ordinary !== true || file.links !== 1 || !Number.isSafeInteger(file.bytes) || file.bytes < 0) return 4;
    if (file.bytes > (index === 0 ? 64 : 32) * 1024 * 1024) return index + 1;
  }
  return 0;
}
module.exports = { childAccessWatchdogReason };

if (!isMainThread) {
  let control, jobs, terminate, stopRequested = false;
  const requestKnownStops = () => {
    if (stopRequested) return;
    stopRequested = true; // Never repeat a native stop after an unknown/failed completion.
    if (!control || !jobs || typeof terminate !== "function") return; // Loader failure occurs before readiness and before any collector launch.
    const count = Atomics.load(control, 3), known = new Set(), selected = [];
    if (count < 0 || count > 8) throw new Error("Fixed watchdog contract.");
    for (let index = 0; index < count; index++) {
      const job = Atomics.load(jobs, index);
      if (job <= 0n || job >= 0x8000000000000000n || known.has(job)) throw new Error("Fixed watchdog contract.");
      known.add(job); selected.push(job);
    }
    for (const job of selected) {
      const result = terminate(job, 125);
      if (typeof result !== "number" || !Number.isInteger(result) || result === 0 || result < -0x80000000 || result > 0x7fffffff) throw new Error("Fixed watchdog termination.");
    }
  };
  try {
    if (process.platform !== "win32" || process.arch !== "x64" || !workerData || !(workerData.shared instanceof SharedArrayBuffer) ||
      workerData.shared.byteLength !== 96 || !Array.isArray(workerData.paths) || workerData.paths.length !== 2 ||
      workerData.paths.some(value => typeof value !== "string" || !/^[A-Za-z]:\\/.test(value) || path.normalize(value) !== value || /[/\p{Cc}\p{Cf}:]/u.test(value.slice(3))) ||
      typeof workerData.deadline !== "bigint" || workerData.deadline - process.hrtime.bigint() > 60_000_000_000n) throw new Error("Fixed watchdog contract.");
    control = new Int32Array(workerData.shared, 0, 8);
    jobs = new BigUint64Array(workerData.shared, 32, 8);
    const koffi = require("koffi");
    if (koffi.sizeof("void *") !== 8) throw new Error("Fixed watchdog contract.");
    terminate = koffi.load("kernel32.dll").func("int __stdcall TerminateJobObject(void *job, uint32_t code)");
    parentPort.postMessage(1);
    for (;;) {
      const command = Atomics.load(control, 0);
      if (command === 1) { Atomics.store(control, 1, 1); break; }
      if (command !== 0) throw new Error("Fixed watchdog contract.");
      const files = workerData.paths.map(file => {
        try { const stat = fs.lstatSync(file); return { exists: true, ordinary: stat.isFile() && !stat.isSymbolicLink(), links: stat.nlink, bytes: stat.size }; }
        catch (error) {
          if (error && error.code === "ENOENT") return { exists: false };
          // eslint-disable-next-line preserve-caught-error -- Raw filesystem messages/paths must never leave this private worker.
          throw new Error("Fixed watchdog metadata.");
        }
      });
      const reason = childAccessWatchdogReason(files, process.hrtime.bigint(), workerData.deadline);
      if (reason) {
        Atomics.store(control, 2, reason);
        requestKnownStops();
        Atomics.store(control, 1, 2); process.exitCode = 1; break;
      }
      Atomics.wait(control, 0, 0, 25);
    }
  } catch {
    if (control) {
      Atomics.store(control, 2, 7);
      try { requestKnownStops(); } catch { /* Unknown native Stop/ownership is terminal: no retry, query or close follows. */ }
      Atomics.store(control, 1, 2);
    }
    process.exitCode = 1; // Fixed fields only; no worker Error/message/stack leaves this isolate.
  }
}
