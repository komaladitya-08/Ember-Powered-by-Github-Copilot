/**
 * The typed-ahead probe (review #78), shared by the real-runner suites (ember-win32, ember-darwin): Linux holds the
 * keyboard while the ask box opens and replays the first letters into it; Windows and macOS have no such hold
 * (platform keyboardHold: null). The suites press the real ask chord with the OS's own synthetic input (SendInput,
 * CGEvent), let go of it, type at once at a fast typist's pace, and read what the box holds. What it prints decides
 * between a native hold and telling users to wait for the box: it fails only when the box never opened from the chord,
 * or holds something other than the end of what was typed (letters reordered or misrouted into it).
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
    : lost === 0 ? "nothing lost: telling users to let go of the keys before typing is enough"
    : "letters typed before the box had the keyboard went elsewhere: this OS needs a typed-ahead hold, or users must wait for the box";
  return { lost, inOrder, line: `typed-ahead probe (${os}): typed ${JSON.stringify(typed)} straight after letting go of the ask chord; the box holds ${JSON.stringify(held)} (${lost} of ${typed.length} letters lost): ${decision}` };
}
