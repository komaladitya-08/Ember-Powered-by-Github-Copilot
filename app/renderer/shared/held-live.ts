/**
 * A status line that says nothing while the microphone is open for a request. A screen reader says a live region's
 * change through the speakers, into what Ember hears: Home's and Ask's lines said then were sent with the request, in
 * its place, or as a conversation's next request (voice-listening-c3-1, c4-1, r4-2, i5; design-system.md "Screen
 * readers"). Renderer-safe: it needs only the element's text.
 */

/** How long a line must hold before it is said (ms): one that changes and changes back says nothing. */
export const LIVE_SETTLE_MS = 1000;

export interface HeldLive {
  /** The line now: said once it has held `settleMs`, outside a hold, and only when its words differ from what it last said. */
  say(text: string): void;
  /**
   * While the microphone is open for a request (true) nothing is said, and the line is emptied, unsaid, so browse mode
   * never reads one that no longer holds; once it closes (false), the line then is said once it has held, unless it is
   * what was said before.
   */
  hold(on: boolean): void;
  /**
   * Nothing new to say: a line not said yet is dropped, so one a later change overtook before it was said is never said
   * (the voice row's line from before Ember's voice began loading, voice-listening-x6-3).
   */
  drop(): void;
  /**
   * The next line it settles on is said even when its words are what it said last: a press asked where things stand
   * (the voice row's Try again, ending as it ended before, voice-listening-x6-2).
   */
  again(): void;
}

/** A held status line on `live` (an `.sr` element with `role="status"`). */
export function heldLive(live: { textContent: string | null }, settleMs = LIVE_SETTLE_MS): HeldLive {
  /**
   * What the line last said (kept while it is emptied), what it should say now (null: nothing new, `drop`), and what
   * the timer will say.
   */
  let told = live.textContent ?? "";
  let want: string | null = told;
  let soon: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;
  let held = false;
  /** A press asked for the next line (`again`), said even when it is what was said last. */
  let asked = false;
  const settle = () => {
    if (soon?.text === want) return;
    if (soon) clearTimeout(soon.timer);
    soon = null;
    if (held || want === null || want === told && !asked) return;
    const text = want;
    soon = { text, timer: setTimeout(() => { soon = null; if (held) return; asked = false; live.textContent = text; told = text; }, settleMs) };
  };
  return {
    say(text) { want = text; settle(); },
    drop() { want = null; settle(); },
    again() { asked = true; },
    hold(on) {
      if (on === held) return;
      held = on;
      if (on) {
        if (soon) clearTimeout(soon.timer);
        soon = null;
        if (live.textContent) live.textContent = "";
      }
      else settle();
    },
  };
}
