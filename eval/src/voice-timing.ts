/** Voice latency on a microphone clock: compute slower than a frame queues the next frame instead of disappearing. */
import type { RuntimeOptions } from "../../app/voice/runtime";

/** Match the app and scripts/perf/latency.mjs when native Linux speech is selected for a development run. */
export function voiceRuntime(env: NodeJS.ProcessEnv): RuntimeOptions {
  return env.EMBER_SHERPA_CAPI ? { capiDir: env.EMBER_SHERPA_CAPI } : {};
}

/** A frame cannot start until its audio has arrived and all earlier frames have finished. */
export class VoiceFrameClock {
  private finishedAt = 0;
  private startedAt = 0;
  private computeFrom = 0;

  constructor(private now: () => number = () => performance.now()) {}

  /** Begin processing a frame complete at `audioReadyMs`, in milliseconds from the recording's start. */
  start(audioReadyMs: number): void {
    this.startedAt = Math.max(audioReadyMs, this.finishedAt);
    this.computeFrom = this.now();
  }

  /** When an event emitted within this frame would reach the listener, including any queued compute. */
  eventAt(): number { return this.startedAt + this.now() - this.computeFrom; }

  /** Finish the frame and return its compute time, which the idle-CPU measurement totals. */
  finish(): number {
    const computeMs = this.now() - this.computeFrom;
    this.finishedAt = this.startedAt + computeMs;
    return computeMs;
  }
}
