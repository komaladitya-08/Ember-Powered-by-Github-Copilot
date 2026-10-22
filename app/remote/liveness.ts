/**
 * The agent's side of liveness (§5.1.11, §5.3.11, critique remote-7): a PING every 500 ms; the freshness gate (a step
 * or command runs only if the PC's last frame is under 1.5 s old); the desktop dead-man (3 s without a frame: desktop
 * work and in-flight steps stop, commands go on); and the command grace (the combined `ssh.commandGraceSeconds`,
 * default 20 s, without a frame: every run's ladder and exit). The dead-man and the grace are separate checks of the
 * same silence, so a network blip shorter than the grace never ends a build. Pure over the mux's clock and timers.
 */

/** Below this the PC's last frame is fresh enough for a step or a command to start (§5.1.11). */
export const FRESH_MS = 1500;
/** Desktop work stops after this much silence. */
export const DEADMAN_MS = 3000;
/** How often the agent pings and looks at the silence. */
export const TICK_MS = 500;

/** What the agent's liveness watches and does. */
export interface LivenessOptions {
  /** ms since the PC's last frame (Mux.silentMs). */
  silentMs(): number;
  /** Sends a PING (Mux.ping). */
  ping(): void;
  /** The command grace in ms, read at every tick (hello and policy changes may lower it). */
  graceMs(): number;
  /** Silence reached the dead-man: stop desktop work. */
  onDeadman(): void;
  /** Frames came again after the dead-man fired. */
  onAlive(): void;
  /** Silence reached the grace: stop every run and exit. Called once. */
  onGrace(): void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

/** The running liveness checks. */
export interface Liveness {
  /** The PC's last frame is under 1.5 s old. */
  fresh(): boolean;
  /** The dead-man has fired and frames haven't come back since. */
  readonly dead: boolean;
  stop(): void;
}

/** Starts the pings and the two silence checks. */
export function startLiveness(o: LivenessOptions): Liveness {
  const every = o.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clear = o.clearInterval ?? (h => clearInterval(h as NodeJS.Timeout));
  let dead = false;
  let graced = false;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    o.ping();
    const silent = o.silentMs();
    if (silent >= DEADMAN_MS && !dead) {
      dead = true;
      o.onDeadman();
    } else if (silent < DEADMAN_MS && dead) {
      dead = false;
      o.onAlive();
    }
    if (silent >= o.graceMs() && !graced) {
      graced = true;
      o.onGrace();
    }
  };
  const handle = every(tick, TICK_MS);
  (handle as { unref?: () => void } | null)?.unref?.();
  return {
    fresh: () => o.silentMs() < FRESH_MS,
    get dead() { return dead; },
    stop() {
      stopped = true;
      clear(handle);
    },
  };
}
