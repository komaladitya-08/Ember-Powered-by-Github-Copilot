/**
 * The typed-ahead probe (review #78), shared by the real-runner suites (ember-win32, ember-darwin): Linux holds the
 * keyboard while the ask box opens and replays the first letters into it; Windows and macOS have no such hold
 * (platform keyboardHold: null), so the owner chose to tell users to wait for the box (README, and the box's first
 * openings) and to give the box the keyboard as soon as it can (owner decision D-78). The suites press the real ask
 * chord with the OS's own synthetic input (SendInput, CGEvent), let go of it, type at once at a fast typist's pace, and
 * read what the box holds; from Ember's own log they print when it heard the chord, showed the box and had the keyboard,
 * and how many letters came before that. The run fails only when the box never opened from the chord, or holds
 * something other than the end of what was typed (letters reordered or misrouted into it).
 */

/** What the probe types straight after the chord. */
export const PROBE_TEXT = "quick brown fox";
/** A fast typist's pace between letters, in ms (about 150 words a minute). */
export const PROBE_PACE_MS = 40;

/** What the box holds of `typed`: how many leading letters were lost, and the line the suite prints. */
export function probeVerdict(os: string, typed: string, held: string): { lost: number; inOrder: boolean; line: string } {
  const inOrder = typed.endsWith(held);
  const lost = inOrder ? typed.length - held.length : typed.length;
  const decision = !inOrder ? "the box holds something else: look at the log"
    : lost === 0 ? "nothing lost: the box had the keyboard before the first letter"
    : "letters typed before the box had the keyboard were lost: users must wait for the box (the README and the box's tip say so)";
  return { lost, inOrder, line: `typed-ahead probe (${os}): typed ${JSON.stringify(typed)} straight after letting go of the ask chord; the box holds ${JSON.stringify(held)} (${lost} of ${typed.length} letters lost): ${decision}` };
}

/** One line of Ember's log (userData/logs/ember.log) that the timeline reads. */
interface LogLine { msg: string; t: number; ms?: number; source?: string }

function logLines(log: string): LogLine[] {
  const out: LogLine[] = [];
  for (const raw of log.split("\n")) {
    try {
      const e = JSON.parse(raw) as { msg?: unknown; t?: unknown; ms?: unknown; source?: unknown };
      const t = typeof e.t === "string" ? Date.parse(e.t) : NaN;
      if (typeof e.msg !== "string" || !Number.isFinite(t)) continue;
      out.push({ msg: e.msg, t, ...(typeof e.ms === "number" ? { ms: e.ms } : {}), ...(typeof e.source === "string" ? { source: e.source } : {}) });
    } catch {
      // not a log line (a line still being written, or another program's)
    }
  }
  return out;
}

/**
 * What Ember's log says of the opening the probe made: when Ember heard the chord (ask.open's time less its `ms`), when
 * it showed the box (ask.open is written once the box is up) and when Electron said the box had the keyboard
 * (ask.keyboard), each in ms after `pressedAt` (the test's Date.now() as it pressed the chord: the same clock); and how
 * many of the letters typed at `typedAt` came before that, against the `lost` count. A time the log doesn't have is null
 * and said as missing.
 */
export function probeTimeline(os: string, log: string, pressedAt: number, typedAt: readonly number[], lost: number): {
  heardMs: number | null; shownMs: number | null; keyboardMs: number | null; typedBefore: number | null; line: string;
} {
  const lines = logLines(log).filter(e => e.t >= pressedAt);
  const open = lines.find(e => e.msg === "ask.open" && e.source === "hotkey");
  const head = `typed-ahead timing (${os}):`;
  if (!open) return { heardMs: null, shownMs: null, keyboardMs: null, typedBefore: null, line: `${head} Ember's log has no opening from the chord after it was pressed` };
  // On Windows the box says it has the keyboard inside show(), so ask.keyboard can come before ask.open.
  const keyboard = lines.find(e => e.msg === "ask.keyboard");
  const heardMs = open.ms !== undefined ? open.t - open.ms - pressedAt : null;
  const shownMs = open.t - pressedAt;
  const heard = `Ember heard the chord ${heardMs ?? "?"} ms after it was pressed, showed the box at ${shownMs} ms`;
  if (!keyboard) return { heardMs, shownMs, keyboardMs: null, typedBefore: null, line: `${head} ${heard}; Electron never said it had the keyboard` };
  const keyboardMs = keyboard.t - pressedAt;
  const typedBefore = typedAt.filter(t => t < keyboard.t).length;
  const where = lost === 0 ? "nothing went elsewhere"
    : lost <= typedBefore ? "no more than were typed before, so they went to the app underneath" : "letters were lost inside the box";
  return {
    heardMs, shownMs, keyboardMs, typedBefore,
    line: `${head} ${heard} and had the keyboard at ${keyboardMs} ms (Electron's focus); ${typedBefore} of the ${typedAt.length} letters were typed before that, and ${lost} were lost: ${where}`,
  };
}
