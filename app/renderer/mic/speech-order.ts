/**
 * One order for both of Ember's voices on the speaking page. An answer can change voice part-way: Ember's own voice
 * (the Player) says its English words and the system's voice (LocalSpeech, speechSynthesis) a passage in another
 * language. Each plays on its own clock, and a chunk of Ember's own voice used to be scheduled 30 ms from when it
 * arrived whatever the system voice was saying, so "Shall I reply to it?" was said over the message it follows
 * (voice-speaking-r9-1). Here what arrives is kept in turns, in the order main sent it, and only the first turn
 * sounds: the next starts when that voice has fallen quiet. Main sends in the order it is to be said (voice.ts,
 * afterVoice), so a turn's audio is all here before the next turn's words arrive.
 */

/** What the order drives: the page's two voices (stand-ins in tests). */
export interface SpeechOrderDeps {
  /** Schedules a chunk of Ember's own voice now (the Player, and the page's "played" report). */
  play(id: number, samples: Float32Array, rate: number): void;
  /** Reply `id` of Ember's own voice has no more chunks. */
  played(id: number): void;
  /** Whether Ember's own voice is playing, or about to. */
  ownActive(): boolean;
  /** Gives words to the system's voice now. */
  say(text: string, lang?: string): void;
  /** Whether the system's voice still has words to say: waiting for a voice, queued or being said. */
  systemActive(): boolean;
}

type Turn =
  | { own: true; ids: Set<number>; chunks: { id: number; samples: Float32Array; rate: number }[]; done: number[] }
  | { own: false; words: { text: string; lang?: string }[] };

/** Says what arrives in the order it arrived, one voice at a time. */
export class SpeechOrder {
  /** The first is the one that sounds now; the rest wait for it. */
  private turns: Turn[] = [];
  private settling = false;

  constructor(private d: SpeechOrderDeps) {}

  /** A chunk of reply `id` in Ember's own voice: played now, or kept until the words before it have been said. */
  chunk(id: number, samples: Float32Array, rate: number): void {
    let turn = this.turns.find(t => t.own && t.ids.has(id));
    if (!turn) {
      const last = this.turns.at(-1);
      if (last?.own) turn = last;
      else this.turns.push(turn = { own: true, ids: new Set(), chunks: [], done: [] });
      if (turn.own) turn.ids.add(id);
    }
    if (turn === this.turns[0]) this.d.play(id, samples, rate);
    else if (turn.own) turn.chunks.push({ id, samples, rate });
  }

  /** Reply `id` has no more chunks. */
  done(id: number): void {
    const turn = this.turns.find(t => t.own && t.ids.has(id));
    if (!turn || turn === this.turns[0]) { this.d.played(id); this.settle(); }
    else if (turn.own) turn.done.push(id);
  }

  /** Words for the system's voice: given to it now, or kept until Ember's own voice has said what came before. */
  say(text: string, lang?: string): void {
    const word = { text, ...(lang ? { lang } : {}) };
    const last = this.turns.at(-1);
    if (last && !last.own) {
      if (last === this.turns[0]) this.d.say(text, lang);
      else last.words.push(word);
      return;
    }
    this.turns.push({ own: false, words: [word] });
    if (this.turns.length === 1) this.d.say(text, lang);
    else this.settle();
  }

  /** A voice fell quiet (or its words were dropped): the next turn starts, if the one that sounded is over. */
  settle(): void {
    // Starting a turn can end it at once (words no voice can say), which comes back here.
    if (this.settling) return;
    this.settling = true;
    try {
      for (let head = this.turns[0]; head && !(head.own ? this.d.ownActive() : this.d.systemActive()); head = this.turns[0]) {
        this.turns.shift();
        const next = this.turns[0];
        if (!next) break;
        if (next.own) {
          for (const c of next.chunks) this.d.play(c.id, c.samples, c.rate);
          for (const id of next.done) this.d.played(id);
          next.chunks = [];
          next.done = [];
        } else {
          for (const w of next.words) this.d.say(w.text, w.lang);
          next.words = [];
        }
      }
    } finally {
      this.settling = false;
    }
  }

  /** A hush: nothing waits any more. */
  reset(): void {
    this.turns = [];
  }
}
