/**
 * The speakers' own stream (PulseAudio monitor, via parec): whatever is playing (videos, calls) as 16 kHz
 * mono frames, for rejecting wake words that come out of the speakers. It counts as on only once parec has
 * started, and it's kept running: if parec stops (PulseAudio restarted), it starts again after 1 s, 5 s, then
 * every 30 s. Without parec installed it stays off. parec takes the monitor of the output that is the default
 * when it starts, and stays on it: when the default output changes (headphones, a Bluetooth speaker), `pactl
 * subscribe` says so, and parec starts again on the new one (review #260).
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

const RETRY_MS = [1000, 5000, 30_000];
const FRAME_BYTES = 512 * 4;
/** A change of the default output comes with others (the old one goes, the new one is set up): parec starts again once they settle (ms). */
const SWITCH_MS = 500;

export class SpeakerMonitor {
  private child: ChildProcess | null = null;
  private retry: NodeJS.Timeout | undefined;
  private failures = 0;
  private startedAt = 0;
  private stopped = false;
  /** `pactl subscribe`, which says when the server's defaults change; parec's run being replaced on the new output. */
  private watcher: ChildProcess | null = null;
  private switchTimer: NodeJS.Timeout | undefined;
  private replaced: ChildProcess | null = null;

  constructor(
    private onFrame: (frame: Float32Array) => void,
    private onState: (on: boolean, reason?: string) => void,
    private spawn: (cmd: string, args: string[], o: { stdio: ["ignore", "pipe", "ignore"] }) => ChildProcess = nodeSpawn,
  ) {}

  start(): void {
    this.stopped = false;
    clearTimeout(this.retry);
    this.startedAt = 0;
    const p = this.spawn("parec", ["--device=@DEFAULT_MONITOR@", "--rate=16000", "--channels=1", "--format=float32le", "--latency-msec=40"], { stdio: ["ignore", "pipe", "ignore"] });
    this.child = p;
    let ended = false;
    const end = (reason: string, again: boolean) => {
      if (ended) return;
      ended = true;
      if (this.child === p) this.child = null;
      // Replaced on purpose (the default output changed): its successor is already starting.
      if (this.stopped || this.replaced === p) return;
      this.onState(false, reason);
      if (!again) return;
      if (this.startedAt && Date.now() - this.startedAt > 60_000) this.failures = 0; // it had been running fine
      this.retry = setTimeout(() => this.start(), RETRY_MS[Math.min(this.failures++, RETRY_MS.length - 1)]);
    };
    p.once("spawn", () => { this.startedAt = Date.now(); this.onState(true); });
    p.once("error", (err: NodeJS.ErrnoException) => end(err.code === "ENOENT" ? "parec isn't installed (pulseaudio-utils)" : err.message, err.code !== "ENOENT"));
    p.once("exit", (code, signal) => end(`parec stopped (${signal ?? `exit ${code}`})`, true));
    let rest: Buffer = Buffer.alloc(0);
    p.stdout?.on("data", (chunk: Buffer) => {
      rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const usable = rest.length - (rest.length % FRAME_BYTES);
      for (let i = 0; i < usable; i += FRAME_BYTES) this.onFrame(new Float32Array(rest.buffer.slice(rest.byteOffset + i, rest.byteOffset + i + FRAME_BYTES)));
      rest = rest.subarray(usable);
    });
    this.watchDefaults();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.switchTimer);
    const p = this.child, w = this.watcher;
    this.child = this.watcher = null;
    p?.kill();
    w?.kill();
  }

  /**
   * Watches the server's defaults (`pactl subscribe`: "Event 'change' on server #…" when the default output or input
   * changes) while parec runs. Without pactl (or a server) there's nothing to watch: tried again when parec next starts.
   */
  private watchDefaults(): void {
    if (this.watcher) return;
    const w = this.spawn("pactl", ["subscribe"], { stdio: ["ignore", "pipe", "ignore"] });
    this.watcher = w;
    const gone = () => { if (this.watcher === w) this.watcher = null; };
    w.once("error", gone);
    w.once("exit", gone);
    let line = "";
    w.stdout?.on("data", (chunk: Buffer) => {
      const lines = (line + chunk.toString("utf8")).split("\n");
      line = lines.pop() ?? "";
      if (lines.some(l => /^Event 'change' on server\b/.test(l))) {
        clearTimeout(this.switchTimer);
        this.switchTimer = setTimeout(() => this.switchOutput(), SWITCH_MS);
      }
    });
  }

  /** The default output (may have) changed: parec starts again at once, so it takes the new default's monitor. */
  private switchOutput(): void {
    const p = this.child;
    if (this.stopped || !p) return;
    this.replaced = p;
    p.kill();
    this.start();
  }
}
