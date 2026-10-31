/**
 * The kill ladder (§3.13; package RUN): what Stop, the kill switch and a timeout do to a running command, per kind of
 * run. POSIX (local, and a remote's agent running the same code): Ctrl+C into the PTY (or SIGINT to the group on
 * pipes) at once, then SIGTERM to the group, to script(1)'s child session and to every process carrying the run's
 * marker at 300 ms, SIGKILL to all of them and to the run's own process at 1000 ms, and a last sweep at 1500 ms whose
 * finds are the stragglers. Windows: the job host is terminated at once, and its kill-on-close job ends the whole tree
 * (there is no polite phase there). WSL: Ctrl+C through the job host (or the in-distro sweep with INT), the in-distro
 * sweeps, and the job host only after the KILL sweep, because killing wsl.exe first orphans the Linux tree (critique
 * wsl-16). Step 1 is always synchronous, so the kill switch's 300 ms race is met. Plain Node; timers are injected.
 */

/** When each later step runs, in ms after Stop (§3.13). */
export const LADDER_MS = { term: 300, kill: 1000, last: 1500 } as const;

/** The kinds of run the ladder knows. */
export type LadderKind = "posix-pty" | "posix-pipe" | "windows" | "wsl-pty" | "wsl-pipe";

/** The timers the ladder runs on (real ones in Ember; fakes in the tests). */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * The real timers. They keep the process alive (they are never unref'd): once the run's own process has exited, the
 * ladder's later steps are all that is left to reach what it left behind, and a remote agent whose link ended must not
 * exit before its SIGKILL step and last sweep (§3.13). A run's time limit is cleared when it ends; the ladder lasts 1.5 s.
 */
export const REAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** What each step does to a run; a kind uses only the operations its steps name. None may throw. */
export interface LadderOps {
  /** PTY runs: Ctrl+C (`\x03`) into script's stdin, or through the job host to wsl.exe. */
  interrupt(): void;
  /** POSIX: a signal to the run's process group. */
  group(signal: NodeJS.Signals): void;
  /** POSIX: a signal to the run's session (`pkill -<SIGNAL> -s <sid>`). */
  session(signal: NodeJS.Signals): void;
  /** The environment sweep with a signal (§3.13); resolves the names of the processes it found. Never rejects. */
  sweep(signal: NodeJS.Signals): Promise<string[]>;
  /** The run's own process: SIGKILL to script(1) or the shell (POSIX); TerminateProcess of the job host (Windows, WSL). */
  terminate(): void;
}

/** A ladder under way. */
export interface Ladder {
  /** The names the last sweep still found (none on Windows, where the job holds the tree). */
  readonly stragglers: Promise<string[]>;
  /** Resolves once the KILL step has been sent (at once on Windows). */
  readonly killed: Promise<void>;
}

/**
 * Starts the ladder for one run. Step 1 runs before this returns; the later steps run on `timers` whether or not the
 * run's own process has ended by then, since what it left behind is what they are for.
 */
export function startLadder(kind: LadderKind, ops: LadderOps, timers: Timers): Ladder {
  let killedDone!: () => void;
  const killed = new Promise<void>(resolve => { killedDone = resolve; });
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // each operation reports nothing: a process that is gone needs nothing more
    }
  };
  const sweep = (signal: NodeJS.Signals): Promise<string[]> => {
    try {
      return ops.sweep(signal).catch(() => []);
    } catch {
      return Promise.resolve([]);
    }
  };

  if (kind === "windows") {
    safe(() => ops.terminate());
    killedDone();
    return { stragglers: Promise.resolve([]), killed };
  }

  const at = (ms: number, fn: () => void) => timers.setTimeout(() => safe(fn), ms);
  let lastDone!: (names: string[]) => void;
  const stragglers = new Promise<string[]>(resolve => { lastDone = resolve; });

  if (kind === "posix-pty" || kind === "posix-pipe") {
    safe(() => (kind === "posix-pty" ? ops.interrupt() : ops.group("SIGINT")));
    for (const [ms, signal] of [[LADDER_MS.term, "SIGTERM"], [LADDER_MS.kill, "SIGKILL"]] as const) {
      at(ms, () => {
        safe(() => ops.group(signal));
        safe(() => ops.session(signal));
        void sweep(signal);
        if (signal === "SIGKILL") {
          // script's own exit hangs up the PTY too: SIGHUP to its session.
          safe(() => ops.terminate());
          killedDone();
        }
      });
    }
    at(LADDER_MS.last, () => { void sweep("SIGKILL").then(lastDone); });
    return { stragglers, killed };
  }

  // WSL: wsl.exe (inside the job host) is never killed before the KILL sweep has run.
  let hostGone = false;
  const host = () => {
    if (hostGone) return;
    hostGone = true;
    safe(() => ops.terminate());
    killedDone();
  };
  if (kind === "wsl-pty") safe(() => ops.interrupt());
  else void sweep("SIGINT");
  at(LADDER_MS.term, () => { void sweep("SIGTERM"); });
  at(LADDER_MS.kill, () => { void sweep("SIGKILL").then(host); });
  at(LADDER_MS.last, () => {
    // A KILL sweep still starting (each costs a wsl.exe start) doesn't hold the job host any longer.
    host();
    void sweep("SIGKILL").then(lastDone);
  });
  return { stragglers, killed };
}

/** The status line's straggler sentence (§3.13), or "" when none is left. */
export function stragglerText(names: readonly string[]): string {
  if (names.length === 0) return "";
  const unique = [...new Set(names)];
  const list = unique.length <= 3 ? unique.join(", ") : `${unique.slice(0, 3).join(", ")} and ${unique.length - 3} more`;
  return names.length === 1
    ? `1 program it started is still running: ${list}.`
    : `${names.length} programs it started are still running: ${list}.`;
}
