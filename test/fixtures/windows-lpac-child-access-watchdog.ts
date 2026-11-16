/** Owns the fixed watchdog thread and its borrowed-handle lifetime; never terminates a thread with an in-flight native call. */
import { Worker } from "node:worker_threads";
import type { WindowsLpacChildAccessTool } from "./windows-lpac-child-access-native";

export class ChildAccessWatchdogError extends Error {
  constructor() { super("The private child-access witness watchdog could not verify completion; retain its owners."); this.name = "ChildAccessWatchdogError"; }
}
export class ChildAccessWatchdog {
  private readonly shared = new SharedArrayBuffer(96);
  private readonly control = new Int32Array(this.shared, 0, 8);
  private readonly jobs = new BigUint64Array(this.shared, 32, 8);
  private readonly thread: Worker;
  private readonly exited: Promise<number>;
  private readonly readyResult: Promise<void>;
  private readonly tools: WindowsLpacChildAccessTool[] = [];
  private readonly retained: unknown[] = [];
  private stopped = false;
  private failed = false;
  private admitted = false;
  private stopping: Promise<void> | undefined;
  constructor(pml: string, csv: string) {
    try {
      this.thread = new Worker(new URL("./windows-lpac-child-access-watchdog.cjs", import.meta.url),
        { workerData: { shared: this.shared, paths: [pml, csv], deadline: process.hrtime.bigint() + 60_000_000_000n },
          stdout: true, stderr: true, env: {}, execArgv: [] });
    } catch { throw new ChildAccessWatchdogError(); }
    // No worker bytes are forwarded, even for a loader failure before the fixed entry's catch.
    for (const stream of [this.thread.stdout, this.thread.stderr]) {
      stream?.on("data", (bytes: unknown) => { this.failed = true; if (Buffer.isBuffer(bytes)) bytes.fill(0); });
      stream?.on("error", () => { this.failed = true; });
    }
    this.exited = new Promise(resolve => { this.thread.once("exit", code => { if (code !== 0) this.failed = true; resolve(code); }); });
    this.readyResult = new Promise((resolve, reject) => {
      this.thread.once("message", value => { if (value === 1) resolve(); else { this.failed = true; reject(new ChildAccessWatchdogError()); } });
      this.thread.once("error", () => { this.failed = true; reject(new ChildAccessWatchdogError()); });
      this.thread.once("exit", () => { if (!this.stopped && Atomics.load(this.control, 1) !== 1) { this.failed = true; reject(new ChildAccessWatchdogError()); } });
    });
    void this.readyResult.catch(() => undefined); // The owner may observe an early fixed failure after the worker has already exited.
  }
  async ready(): Promise<void> {
    if (this.stopped) throw new ChildAccessWatchdogError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.readyResult, new Promise<never>((_, reject) => { timer = setTimeout(() => { this.failed = true; reject(new ChildAccessWatchdogError()); }, 5_000); })]);
      if (this.stopped) throw new ChildAccessWatchdogError();
      this.healthy(); this.admitted = true;
    } finally { if (timer) clearTimeout(timer); }
  }
  register(tool: WindowsLpacChildAccessTool): void {
    this.healthy();
    if (!this.admitted || this.stopped || this.tools.includes(tool) || this.tools.length >= 8) throw new ChildAccessWatchdogError();
    let job: bigint;
    try { job = tool.borrowedJob(); }
    catch { this.failed = true; this.retained.push(tool); throw new ChildAccessWatchdogError(); }
    if (typeof job !== "bigint" || job <= 0n || job >= 0x8000000000000000n || this.tools.some((_, index) => Atomics.load(this.jobs, index) === job)) throw new ChildAccessWatchdogError();
    const index = this.tools.length; this.tools.push(tool);
    Atomics.store(this.jobs, index, job); Atomics.store(this.control, 3, this.tools.length);
  }
  healthy(): void {
    if (this.failed || Atomics.load(this.control, 2) !== 0 || (!this.stopped && Atomics.load(this.control, 1) !== 0)) throw new ChildAccessWatchdogError();
  }
  /** Call only after every registered native job/process is independently stopped; all handles remain held until this resolves. */
  stop(): Promise<void> { this.stopping ??= this.stopOnce(); return this.stopping; }
  private async stopOnce(): Promise<void> {
    this.healthy(); if (this.stopped) return;
    this.stopped = true; Atomics.store(this.control, 0, 1); Atomics.notify(this.control, 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([this.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ChildAccessWatchdogError()), 2_000); })]);
      if (code !== 0 || Atomics.load(this.control, 1) !== 1) throw new ChildAccessWatchdogError(); this.healthy();
    } catch { this.failed = true; throw new ChildAccessWatchdogError(); }
    finally { if (timer) clearTimeout(timer); }
  }
}
