/**
 * Ember's ears. Everything here runs on this computer: audio never leaves it,
 * and nothing is kept, before the wake word.
 *
 * Always: keyword spotting for "Ember" on its own, "hey ember" (wake) and "ember stop" (kill). The bare name is
 * spotted inside "remember" and "September" too, so a wake by it shows only once the transcript check has heard the
 * name start the phrase ("Ember, open the terminal"; not "the embers", not "I remember").
 * After a wake: voice activity detection finds the end of what was said, then
 * an offline recognizer transcribes the whole utterance at once (accurate,
 * punctuated). A short pre-roll means "Hey Ember, turn on Night Light" works
 * in one breath; the wake phrase is stripped from the transcript. Other people
 * talking in the background don't keep a request going: it ends when the
 * speaker's own voice does, and runs 10 s at most (20 s in a quiet room).
 * After Ember answers a wake's request: one follow-up window where no wake word
 * is needed ("Thanks" ends it), for a voice as loud as the one that woke Ember.
 * While Ember itself is speaking, "Hey Ember" that its speakers' own stream didn't
 * say cuts in: Ember is hushed and listens (without that stream, only "Hey Ember,
 * stop" counts; what was said over Ember's voice is only heard for a stop, unless
 * the request went on once Ember was quiet); it or "Ember, stop" is ignored when it
 * comes out of the speakers; a listening window waits until Ember has finished speaking.
 * Right after a wake, only a voice about as loud as the wake phrase is a request.
 */

export const SAMPLE_RATE = 16_000;
/**
 * Less audio than this (0.1 s) holds no word, and the recognizer can't take it: Moonshine throws a bare number out of
 * WebAssembly for under about 0.06 s (review #253). transcribe() hears nothing in it.
 */
export const MIN_TRANSCRIBE_SAMPLES = Math.round(0.1 * SAMPLE_RATE);

/** The recognizers, behind an interface so the state machine is testable. */
export interface VoiceBackend {
  /** Keywords spotted in this frame ("hey_ember", "ember_stop"…). */
  spot(frame: Float32Array): string[];
  /** Starts the spotter afresh (after a pause, so half-heard words don't carry over). */
  resetSpot?(): void;
  /** The speaker paused: the spotter decodes what it has (padded with silence) instead of waiting for more audio. */
  padSpot?(): string[];
  /** Keywords spotted in speaker output (for rejecting wake words from videos); optional. Only run while a wake or stop is checked. */
  spotMonitor?(frame: Float32Array): string[];
  /** The same as padSpot, for the speakers' stream. */
  padMonitor?(): string[];
  /** Ends that spotting (the next spotMonitor starts afresh). */
  resetMonitor?(): void;
  /**
   * Is someone speaking? An eager voice check with its own state (not vad()'s), which decides when the spotter
   * runs while Ember waits for its name; optional (without it, loudness against the room's noise decides).
   */
  hearsSpeech?(frame: Float32Array): boolean;
  /** Starts that check afresh (it rested while the room was steady). */
  resetHearsSpeech?(): void;
  /** Feeds voice activity detection; returns finished speech segments. */
  vad(frame: Float32Array): Float32Array[];
  /** True while VAD hears speech. */
  speaking(): boolean;
  /** Ends any segment in progress and returns it (it ends with the last frame fed); the VAD starts afresh. */
  flushVad(): Float32Array[];
  resetVad(): void;
  /** What was said in `samples`; "" for nothing heard (less than MIN_TRANSCRIBE_SAMPLES of audio, or the recognizer failed). */
  transcribe(samples: Float32Array): string;
  /** What the VAD heard just before a segment it returned (0.1 s), if it still has it; optional. */
  before?(segment: Float32Array): Float32Array | null;
}

export type VoiceEvent =
  | { type: "wake"; keyword: string }
  | { type: "stop" }
  /** `window`: which listening window this is (a follow-up's timeout shouldn't clear the answer it follows). */
  | { type: "listening"; on: boolean; reason: "wake" | "follow-up" | "timeout" | "done" | "stop" | "rejected"; window: "wake" | "follow-up" }
  | { type: "speech"; on: boolean }
  /** `window`: a wake's request or a follow-up (which gets no follow-up of its own); `cut`: the speaker was still talking when the request reached its length limit. */
  | { type: "utterance"; text: string; ms: number; window: "wake" | "follow-up"; cut?: boolean }
  | { type: "rejected"; keyword: string; reason: "self" | "speakers" | "check"; heard?: string };

export interface EngineOptions {
  /** Audio kept before a wake so a one-breath command isn't cut (seconds). */
  preRoll?: number;
  /** How long to wait for speech after a wake before giving up (ms). */
  waitForSpeechMs?: number;
  /**
   * Speaker-output matches within this window reject a wake or a stop (ms). The speakers' own stream hears the
   * same audio at almost the same moment, but either spotter can report it a few chunks later (measured: 150 ms
   * let half of a video's "Hey Ember"s through). Only waited out while something is playing.
   */
  rejectWindowMs?: number;
  /** Frames quieter than this (RMS), or than the room's own noise floor, count as silence; keyword spotting pauses in long silences. */
  silenceRms?: number;
  /** Second-stage check: transcribe the wake word (or the stop phrase) and reject near-misses ("Amber", "September stopped"). Default on. */
  verifyWake?: boolean;
  /**
   * The check waits this long after the spotter fires (ms). By default it doesn't when the spotter fired mid-speech
   * (0.45 s after the word), and waits 256 ms when it fired at a pause (0.1 s after it): the recognizer drops a
   * word cut at its very end ("Hey Amber" came out as nothing).
   */
  checkAfterMs?: number;
  now?: () => number;
}

/**
 * Second stage: the keyword spotter can't always tell "Ember" from words that
 * sound like it. If the recognizer clearly heard one of those (and not
 * "Ember"), it wasn't a wake. Only clear near-misses are rejected, so a
 * mumbled real wake still counts.
 */
export function heardOtherWord(transcript: string): boolean {
  const t = transcript.toLowerCase();
  if (/\bember\b|\bembers\b/.test(t)) return false;
  return /\b(amber|ambers|remember|remembers|member|members|september|november|december|timber|number|chamber|hammer)\b/.test(t);
}

/** The spotter's label for the name said on its own ("Ember, turn on Night Light"), without "Hey" or "OK". */
export const BARE_NAME = "ember";

/**
 * Was Ember called by its bare name: does the name start what was said (after a greeting or a filler, or after the end
 * of a sentence said before it: the check hears 1.6 s of what came before)? "Ember, what time is it?", "Okay. Ember,
 * open the terminal." and "Um, Ember?" are; "The embers are glowing", "I remember" and "tell Ember's team" aren't.
 * The recognizer's spellings of the name that aren't words count ("Umber, open the terminal"); "Amber, …" and "Number,
 * …" don't, though it writes a first "Ember" so too: "Amber" is someone else's name, and it writes "I remember the…"
 * as "Number, the…" (measured: taking it woke Ember on 4 of 120 near-miss phrases).
 */
export function calledByName(transcript: string): boolean {
  if (heardOtherWord(transcript)) return false;
  // "Hey" as the recognizer writes it too ("Pay Ember", "Peyember"): the spotter may take the name of "Hey Ember" first.
  return /^\W*(?:(?:\S+\s+){0,4}?\S*[.!?;:]\s+)?(?:(?:hey|hi|ok|okay|hay|pay|pey|they|a|oh|so|um|uh|well|and|yes|yeah|no|please)[\s,.!'"“”]+)*(?:hey|hay|pay|pey)?(?:ember|emmer|umber|anber|embre)\b(?!['’]?s\b)/i.test(transcript);
}

/** "Ember, stop" as the recognizer writes it ("Ember stopped the task.", "Embers, please stop", "Emmer, stop the task."). */
const EMBER_STOP = /\b(embers?|emmer)\b[^a-z]*(please\s+)?stop/;

/**
 * The same for "Ember, stop": "September stopped being fun" and "December stop sign" are other words. The
 * recognizer often writes the name as "Amber" or "Emma" (or "Emmer": nobody's name, so it's Ember), and the kill
 * phrase as "Ember stopped"; "Amber, stop" counts when the stop is said on its own ("Amber, stop it."), not as part
 * of a sentence ("Amber, stop that right now!", a TV or someone talking to an Amber), unless Ember is speaking (its
 * own words may follow in the transcript).
 * A garbled transcript still stops (stopping is the safe side); one with no words in it is no "Ember, stop" (the
 * engine looks again at the speaker's pause, and rejects it if it still has none).
 */
export function heardOtherStop(transcript: string, emberSpeaking = false): boolean {
  const t = transcript.toLowerCase();
  if (EMBER_STOP.test(t)) return false;
  const rest = afterName(t, /amber|emma/);
  if (rest !== null) return !emberSpeaking && !SAID_ALONE.test(rest);
  return /\b(sept|nov|dec|rem|m)ember\w*(\W+\w+){0,2}?\W+stop/.test(t);
}

/**
 * The second look at "Amber, stop…" heard mid-sentence, once the speaker paused: a stop if the name came out as
 * "Ember" this time (as in the first look, a transcript that says "Ember, stop" always stops), or if no more than a
 * couple of words ("it", "now"…) followed it ("Amber stopped that right now." isn't).
 */
export function stopSaidAlone(transcript: string): boolean {
  const t = transcript.toLowerCase();
  if (EMBER_STOP.test(t)) return true;
  return SAID_ALONE.test(afterName(t, /embers?|amber|emma|emmer/) ?? /\bst[a-z']*(.*)$/.exec(t)?.[1] ?? "");
}

/** What may follow a stop said on its own. */
const SAID_ALONE = /^[^a-z]*((stop|it|that|now|please|everything|ember|already|talking)\b[^a-z]*){0,2}$/;

/** "Amber, stop that right now!" → " that right now!": what follows the name (one of `names`) and the word after it, or null. */
function afterName(transcript: string, names: RegExp): string | null {
  const m = new RegExp(String.raw`\b(${names.source})\b[^a-z]*(please\s+)?[a-z']+(.*)$`).exec(transcript);
  return m ? m[3] : null;
}

const GREETING = String.raw`(hey|hi|ok|okay|hay|pay|pey|they)[\s,.!]*`;
const NAME = String.raw`(embers?\b|ember(?=[a-z])|emmer\b|amber\b|member\b|emma\b|[ap][.\s-]*m[.\s-]*[br]\b\.?)[\s,.!?:;-]*`;
/** The wake phrase as the recognizer writes it ("Hey, Ember." "hey Emmer" "OK Amber" "Hey, EmberStop." "Peyamber" "A. M. B." "P. M. B."). */
const WAKE = String.raw`(${GREETING})?${NAME}`;
const WAKE_AT_START = new RegExp(String.raw`^\s*` + WAKE, "i");
/** Right after a wake, the pre-roll can start with the end of what was said before it: "Lunch, hey Ember, …". */
const WAKE_IN_FIRST_WORDS = new RegExp(String.raw`^\s*(\S+\s+){0,5}?` + WAKE, "i");
/** …or the name came out as another word: "Hey, ever, turn on…", "Hey, I'm return on…" ("hey" and the word after it are the wake phrase; not "okay", which often starts a request). */
const GREETING_IN_FIRST_WORDS = /^\s*(\S+\s+){0,2}?(hey|hi|hay|pay|they)[\s,.!]+\S+[\s,.!?:;-]*/i;

/**
 * "Hey Ember, turn on Night Light." → "Turn on Night Light." With `afterWake` (the first thing heard after a
 * wake), words said just before the wake phrase go too: nothing said before "Hey Ember" is sent anywhere.
 * A wake phrase said twice ("Hey Ember, Ember stop") goes both times.
 */
export function stripWake(text: string, afterWake = false): string {
  let t = text;
  if (afterWake) {
    const named = t.replace(WAKE_IN_FIRST_WORDS, "");
    t = named !== t ? named : t.replace(GREETING_IN_FIRST_WORDS, "");
  }
  for (let again = t.replace(WAKE_AT_START, ""); again !== t; again = t.replace(WAKE_AT_START, "")) t = again;
  return t.trim().replace(/^[a-z]/, c => c.toUpperCase());
}

/** "Hey Ember, stop." / "No, stop." / "Shut up." / "Never mind": the whole request is to stop, handled here like "Ember, stop" (never sent to the model). */
export function isStop(text: string): boolean {
  // A lone "stop" (or "quiet") heard short ("Stuff.", "Step.", "St", "Quite."): the recognizer's way with the word said alone.
  if (/^(the\s+)?(st|stop|stopped|stuff|step|stap|stob|stup|quite)[\s.!]*$/i.test(text)) return true;
  return /^((please|ok|okay|no|oh|ember)[\s,.!]+)*(stop|cancel|abort|never\s?mind|forget\s+(it|that)|be\s+quiet|quiet|hush|shut\s+up|that'?s\s+enough|enough)([\s,.!]+(stop|it|that|now|please|talking|everything|ember|already))*[\s.!,]*$/i.test(text);
}

/**
 * "Hey Ember, stop" anywhere in what the microphone heard while Ember spoke (its own words can come before and after it).
 * The recognizer writes a lone "stop" as "stopped", "Stuff." or "Step." too ("A. Ember stopped.", "'pay ember' stopped
 * talking."): those count where the phrase ends with them, not in a sentence of Ember's ("The ember stopped glowing.");
 * and "be quiet" as "the quiet".
 */
const STOP_HEARD_SHORT = String.raw`(stop\w*|stuff|step|stap|stob|stup)(?=([\s,.!]+(it|that|now|please|talking|everything|ember|already)\b)*[\s"”]*([.!?,;:]|$))`;
const WAKE_THEN_STOP = new RegExp(String.raw`\b` + WAKE + String.raw`["“”]?\s*(please\s+)?(stop\b|${STOP_HEARD_SHORT}|(be|the)\s+quiet|quiet|hush|shut\s+up|that'?s\s+enough|enough|cancel|never\s?mind)\b`, "i");
/**
 * With the greeting ("Hey Ember, stopped Thursday at 2."), "stopped" counts whatever follows it: Ember never says "Hey
 * Ember" itself, and its own words go on after the user's "stop" until it has been hushed.
 */
const GREETED_STOP = new RegExp(String.raw`\b${GREETING}${NAME}["“”]?\s*(please\s+)?stop`, "i");
export function saidWakeStop(transcript: string): boolean {
  return WAKE_THEN_STOP.test(transcript) || GREETED_STOP.test(transcript);
}

/**
 * What was heard right after cutting in on Ember, said over its voice: a few words with "stop", "quiet" or "that's
 * enough" in them are a stop as the recognizer garbled it ("Ever be quiet.", "Be quite."), not a request ("Is there
 * enough disk space?" is one). "Quite" counts only where nothing follows it: "That's not quite right." isn't a stop.
 */
export function heardStopWord(text: string): boolean {
  return text.trim().split(/\s+/).length <= 6 && /\b(stop\w*|quiet|quite(?=\W*$)|hush|shut|that'?s\s+enough)\b|^\W*enough\b/i.test(text);
}

/**
 * "Thanks." "No, that's all." "Okay, great." "Sounds good.": said in a follow-up window, the conversation is over
 * (nothing is sent). After Ember asked something ("Should I close that one too?"), "Okay.", "Fine." or "Sounds good."
 * is how people say yes: only a reply that starts with no ("No, thanks.", "Nope.", "I'm good.", "That's all.") ends it.
 */
export function isCloser(text: string, afterQuestion = false): boolean {
  const word = String.raw`(thanks(\s+(a\s+lot|so\s+much|a\s+bunch|again))?|thank\s+you(\s+(very|so)\s+much)?|cheers|much\s+appreciated|appreciate\s+it|great|perfect|cool|nice|awesome|wonderful|excellent|good|fine|okay|ok|alright|all\s+right|sounds\s+(good|great|fine)|that\s+works|works\s+for\s+me|got\s+it|that'?s\s+(all|it|everything|fine|great|good|perfect)|that\s+is\s+all|nothing(\s+else)?|no|nope|no\s+thanks|not\s+now|i'?m\s+(good|done|fine|all\s+set)|all\s+(good|set)|bye|goodbye)`;
  if (!new RegExp(String.raw`^((okay|ok|alright|all\s+right|oh|so|yeah|um|uh)[\s,.!]+)*${word}([\s,.!]+(${word}|ember|for\s+now|then|anyway))*[\s.!,]*$`, "i").test(text)) return false;
  return !afterQuestion || /^((okay|ok|alright|all\s+right|oh|so|um|uh|well)[\s,.!]+)*(no|nope|nah|not\s+now|nothing|that'?s\s+(all|it|everything)|that\s+is\s+all|i'?m\s+(good|done|fine|all\s+set)|all\s+set|bye|goodbye)\b/i.test(text);
}

/** "Um." "Hmm.": a filler, not a request (the window keeps listening). */
export function isFiller(text: string): boolean {
  return /^((u+m+|u+h+|h*m+|mhm|a+h+|o+h+|e+r+m*)[\s,.!?…-]*)+$/i.test(text);
}

/** A fixed-length ring of recent samples. */
export class Ring {
  private buf: Float32Array;
  private at = 0;
  private full = false;

  constructor(seconds: number, rate = SAMPLE_RATE) {
    this.buf = new Float32Array(Math.max(1, Math.round(seconds * rate)));
  }

  push(frame: Float32Array): void {
    for (let i = 0; i < frame.length; i++) {
      this.buf[this.at] = frame[i];
      this.at = (this.at + 1) % this.buf.length;
      if (this.at === 0) this.full = true;
    }
  }

  /** Oldest to newest. */
  read(): Float32Array {
    if (!this.full) return this.buf.slice(0, this.at);
    const out = new Float32Array(this.buf.length);
    out.set(this.buf.subarray(this.at), 0);
    out.set(this.buf.subarray(0, this.at), this.buf.length - this.at);
    return out;
  }

  clear(): void {
    this.at = 0;
    this.full = false;
  }
}

/**
 * Frames of 32 ms. The spotter gets half a second without speech after it (enough for its
 * own delay), then rests and is reset when speech returns: a stream fed long silence after
 * a detection stops recognizing the next "Hey Ember" (measured: 1 s of it misses wakes).
 * The frames it missed are replayed then, from 12 frames before the sound started (out of a
 * calm room): where its stream starts changes what it hears (measured: a few frames either way
 * costs wakes). Speech that doesn't stand out from the room's noise gets the last 24 frames.
 */
const MIC_REST_FRAMES = 16;
const MIC_REPLAY_FRAMES = 12;
const MIC_QUIET_REPLAY_FRAMES = 24;
/** Frames kept while the spotter rests (the voice check's delay is well within it); a room this many frames calm has a clear start of sound. */
const MIC_TAIL_FRAMES = 32;
const CALM_FRAMES = 8;
/** A pause is 3 quiet frames after at least 10 of sound; a word spotted then is checked 256 ms later. */
const PAUSE_FRAMES = 3;
const SOUND_FRAMES = 10;
const PAUSED_CHECK_MS = 256;
/** The voice check wakes on a frame this far above the room's noise, runs for 2 s after the last one, and starts with 8 frames of context. */
const CHECK_WAKE_RATIO = 1.3;
const CHECK_HANG_FRAMES = 63;
const CHECK_CONTEXT_FRAMES = 8;
/** The room's noise is learned in its first 3 s (a noisy room in about 2 s), then follows slowly. */
const FLOOR_LEARN_FRAMES = 94;
/**
 * The speakers' last 3 s are kept; their stream is only spotted (from a fresh stream, over those 3 s and then
 * as it plays) while a wake or a stop waits for the speakers check: spotting everything that plays cost 8–11 %
 * of a core. Speakers silent this long before a wake can't have played "Hey Ember" (phrase + spotter delay).
 */
const SPEAKERS_RING_FRAMES = 94;
const SPEAKERS_QUIET_MS = 1500;
/** Longest Ember counts as speaking without hearing so again (the mic window repeats it while it speaks). */
const SELF_SPEAKING_MAX_MS = 60_000;
/**
 * The microphone's last 3 s are kept. The stop phrase's transcript check hears the last 2 s. "Hey Ember" while Ember
 * speaks is checked from 1.5 s before it was spotted, once "stop" can have been said: at a pause (5 quiet frames)
 * after more words, 12 quiet frames, or 1.2 s on. Both checks hear it from 10 frames before its first sound: the
 * recognizer returns nothing for a phrase after near-silence (measured: 19 of 30 after 1 s of it, 4 after 0.6 s, none after 0.3 s).
 */
const RECENT_SECONDS = 3;
const STOP_CHECK_SECONDS = 2;
const SELF_STOP_BEFORE_MS = 1500;
const SELF_STOP_PAUSE_FRAMES = 5;
const SELF_STOP_SILENT_FRAMES = 12;
const SELF_STOP_MAX_MS = 1200;
const STOP_LEAD_FRAMES = 10;
/** "Amber, stop" heard mid-sentence waits this long at most for the speaker's pause (ms). */
const NAMED_STOP_WAIT_MS = 600;
/**
 * After cutting in on Ember, what the microphone heard while Ember's voice still reached it (until its speakers' stream
 * went quiet, plus the microphone's lag and 64 ms) counts only for a stop: the recognizer mixes Ember's words into a
 * phrase said over them ("Hey Ember, stop." came out as "Stiles 1440", "Hey Ember, pause." as "Paul's hunt."). What
 * was heard is sent if the speaker's own voice (within 6 dB of its loudest, see QUIET_RATIO) went on for 2 frames
 * after that; otherwise Ember, hushed, listens for the request again (once: what it hears next is sent). Measured on
 * cut-ins at echo 0.05–0.25: none of 45 stops garbled into a request had a frame of it; 81 of 89 requests had 2.
 */
const OVER_EMBER_MS = 64;
const AFTER_HUSH_FRAMES = 2;
/**
 * A request ends when the speaker's voice does, even while other people talk on (the VAD hears their speech
 * too). Loudness is the median frame of a stretch (a TV's loud syllables don't count, nor do the speaker's own
 * short pauses): the request's own is its loudest 0.3 s (9 frames) in this window, the wake phrase's included.
 * When the last half second (16 frames) stays 12 dB under that for 12 frames, the request is over: about 20
 * frames after the voice ends, while other people talk on. The count starts over when the speaker's voice is back
 * (4 frames within 6 dB of its loudest), and, with no pause since it was, at their softer words (the 16 frames
 * within 12 dB). A pause (a fifth of a second of silence: 6 frames under 2.5 times the room's noise) holds it: a
 * pause in a quiet room is left to the VAD (0.6 s of silence), so a speaker's hesitation mid-request isn't cut
 * (it was at 0.25 s). After one, others' loud talk holds it too (it is no sign of the speaker), and it ends no
 * sooner than 8 frames on, and not in silence: the voice coming back gets that long to show (its first syllable,
 * with the end of the word before the pause, cut requests at commas). Starting over at a pause instead let a TV's
 * or colleague's pause between sentences restart it: the request ran into their next sentence (0.6 s after the
 * voice at the median, 5 s at worst, at 10 dB). Silence holds it for 0.64 s (20 frames) at most since the voice:
 * a pause longer than that is the VAD's to end, and "silence" the VAD goes on hearing speech in is the background
 * (a radio's quieter passages fall under the room's noise estimate, which follows them: a request ran 4.6 s into
 * the radio at 15 dB). What goes to the recognizer keeps 10 frames around the voice (it drops a last word cut at
 * its very end; right after a wake, the voice starts where it's within 6 dB of that loudness: the wake phrase is
 * said up close); a cut segment with no 0.3 s that loud is other people's talk, and is dropped. Speech is cut
 * after 10 s (the VAD's own maximum isn't a hard one: 53 s was seen), or 20 s while the speaker's own voice goes
 * on (heard in the last 2 s) in a quiet room: a tenth of a second of silence in the last 5 s, as a breath or the
 * pause at a comma gives (people speak 3–5 s between them; a fifth of a second in 3 s cut requests of 18 s at
 * 12–15 s), where others' talk filling the pauses leaves none. The recognizer gets at most 12 s at a time (its
 * time grows with it, and it loops), split where it's quietest.
 */
const QUIET_RATIO = 10 ** -1.2;
const CLOSE_RATIO = 10 ** -0.6;
const SILENCE_RATIO = 2.5;
const SILENT_FRAMES = 6;
const LOUDNESS_FRAMES = 16;
const BACK_FRAMES = 4;
const QUIET_END_FRAMES = 12;
const RETURN_FRAMES = 8;
const PAUSE_HOLD_FRAMES = 20;
const LOUD_FRAMES = 9;
/** A dip this short (frames) in that loudness doesn't end the stretch it's in; the wake phrase's own stretch is heard with this many frames after it. */
const CLOSE_GAP_FRAMES = 3;
const OWN_AFTER_FRAMES = 6;
/**
 * The frames just before a wake hold the wake phrase; a room with sound in a quarter of the 16 or more before them was
 * busy (measured before wakes: a quiet room or a fan none, typing up to 0.23, others talking 15 dB under the user 0.15–0.85).
 */
const WAKE_PHRASE_FRAMES = 47;
const BUSY_FRAMES = 16;
const BUSY_SHARE = 0.25;
const KEEP_AFTER_FRAMES = 10;
const SPEECH_CAP_FRAMES = 313;
const LONG_CAP_FRAMES = 625;
/** A request reaching the cap was cut when the speaker's voice was heard in its last second. */
const STILL_TALKING_FRAMES = 32;
const BREATH_FRAMES = 3;
const BREATH_WINDOW_FRAMES = 156;
const MAX_TRANSCRIBE = 21 * SAMPLE_RATE;
/** A segment of up to 3 s that the recognizer heard nothing in is tried again with 0.1 s of what came before it. */
const RETRY_MAX = 3 * SAMPLE_RATE;
const RETRY_LEAD = Math.round(0.1 * SAMPLE_RATE);
const TRANSCRIBE_CHUNK = 12 * SAMPLE_RATE;
/** Speech frames tracked per segment (the cap, plus the VAD's lead-in). */
const SEGMENT_FRAMES = LONG_CAP_FRAMES + 32;
/**
 * Frames kept around the end of Ember's speech (1 s), replayed if the user was already replying: from where the
 * speakers' stream went quiet (plus the microphone's measured lag behind it), or, without that stream, from where
 * the tail (13 frames: 400 ms after Ember says it stopped) went quiet, once sound has gone on 8 frames past it.
 */
const TAIL_KEEP_FRAMES = 32;
const TAIL_FRAMES = 13;
const TAIL_HOLD_FRAMES = 8;
/** The microphone's lag behind the speakers' stream is measured up to 0.4 s; a match this good says it hears them at all. */
const MAX_LAG_FRAMES = 12;
const LAG_MIN_CORRELATION = 0.5;

/**
 * `ms`: the window's length (it starts again after Ember speaks); `first`: nothing heard yet since the wake;
 * `checkAt`: when the wake's transcript check runs (null: none pending), for `keyword`; `afterQuestion`: a follow-up
 * to an answer that asked something ("Okay." is a yes then, not the end of the conversation); `bargeIn`: a wake said
 * while Ember spoke (what it heard first has Ember's own words around it); `held`: what it heard over Ember's voice
 * wasn't sent (see AFTER_HUSH_FRAMES); `announced` false: a wake by the bare name that isn't shown (no "wake" or
 * "listening" event) until the whole of what was said, once the speaker paused, starts with the name (handleSegment).
 */
type Mode =
  | { kind: "idle" }
  | { kind: "listening"; until: number; ms: number; heardSpeech: boolean; first: boolean; reason: "wake" | "follow-up"; checkAt: number | null; keyword: string; afterQuestion?: boolean; bargeIn?: boolean; held?: boolean; announced?: boolean };

/** A spotted stop (or "Hey Ember" while Ember speaks) being checked: see VoiceEngine.pendingStop. */
type PendingStop = { keyword: string; at: number; checkAt: number | null; spoke?: boolean; again?: boolean; checked?: boolean; bargeIn?: boolean };

export class VoiceEngine {
  private mode: Mode = { kind: "idle" };
  private ring: Ring;
  private recent = new Ring(RECENT_SECONDS);
  private selfSpeakingUntil = 0;
  /** When Ember said it had stopped speaking (the tail after it is under way), and the frames heard around then. */
  private tailFrom = 0;
  private tail: { frame: Float32Array; energy: number; at: number }[] = [];
  private monitorHits: { keyword: string; at: number }[] = [];
  /**
   * A spotted wake word waiting out the speakers check; a spotted stop waiting out it and its transcript check
   * (`keyword` "hey_ember": said while Ember spoke; `checked`: the speakers didn't say it, and what was said with it was
   * heard; `bargeIn`: it was "Hey Ember", so Ember was hushed to listen).
   */
  private pendingWake: { keyword: string; at: number; paused: boolean } | null = null;
  private pendingStop: PendingStop | null = null;
  /** The speakers' recent frames, when they last made a sound and last sent a frame, and whether their spotter runs. */
  private speakers: { frame: Float32Array; at: number; sound: boolean; energy: number }[] = [];
  private monitorSoundAt = Number.NEGATIVE_INFINITY;
  private monitorFrameAt = Number.NEGATIVE_INFINITY;
  private monitorSpotting = false;
  /** The microphone's recent frame energies (as long as the speakers' ring), and how much later it hears the speakers (ms, measured as Ember speaks). */
  private micLevels: number[] = [];
  private micLag = 0;
  private wasSpeaking = false;
  private frames = 0;
  /** When the microphone's latest frame came. */
  private fedAt = 0;
  /** Quiet frames in a row, and the most recent ones (replayed to the spotter when sound returns). */
  private quietRun = 0;
  /** The room's noise level (RMS): follows the quietest frames down at once and rises only slowly. */
  private floor = 0;
  private quietTail: Float32Array[] = [];
  /** Where in the tail the sound started (the first frame well above a calm room's noise), or -1; and how long the room has been calm. */
  private loudAt = -1;
  private calmRun = 0;
  /** Frames of sound, then of quiet, in a row (a pause after speech lets the spotter finish early). */
  private soundRun = 0;
  private pauseRun = 0;
  /** Frames left before the voice check rests (the room was steady), and the frame it last heard. */
  private unsteady = 0;
  private checkedAt = -1;
  /** Listening: the window's speech at its loudest (median energy of 9 frames), the energies of the segment under way, and how long it has been quiet against it while others talked. */
  private peak = 0;
  private segment: number[] = [];
  private quietFor = 0;
  /**
   * Where in the segment the last pause was, and whether there was one since the speaker's voice; frames of silence in
   * a row that may be a pause, and how many have held the count since the voice.
   */
  private pauseAt = Number.NEGATIVE_INFINITY;
  private pausedSinceVoice = false;
  private hushRun = 0;
  private hushed = 0;
  /** Frames of silence (the room's own noise) in a row, and where in the segment the last tenth of a second of it was. */
  private silentRun = 0;
  private silentAt = -1;
  /** After cutting in: frames of the speaker's own voice in the segment under way since Ember's voice stopped reaching the microphone. */
  private afterHush = 0;
  /** The loudness of the last wake's request (a follow-up must come near it), and whether the last request came from a follow-up (it gets none of its own). */
  private voice = 0;
  /** The room had sound before the last wake (others talking, a TV; not silence or a steady fan). */
  private busyRoom = false;
  private afterFollowUp = false;
  /** Frames the keyword spotter actually decoded (for CPU accounting and tests). */
  spotted = 0;
  private now: () => number;

  constructor(private backend: VoiceBackend, private emit: (e: VoiceEvent) => void, private o: EngineOptions = {}) {
    this.ring = new Ring(o.preRoll ?? 1.6);
    this.now = o.now ?? Date.now;
  }

  get listening(): boolean {
    return this.mode.kind === "listening";
  }

  /**
   * Ember is speaking (TTS): a wake word only counts as "Hey Ember, stop", and what a listening window hears is
   * ignored, until it stops (plus a short tail). Capped, so a lost "stopped" can't deafen Ember for good. A
   * "stopped" while silent changes nothing; one after speech measures the microphone's lag behind the speakers.
   */
  selfSpeaking(on: boolean, tailMs = 400): void {
    const now = this.now();
    if (!on) {
      if (this.selfSpeakingUntil > now) { this.tailFrom = now; this.micLag = this.measureLag() ?? this.micLag; }
      this.selfSpeakingUntil = Math.min(this.selfSpeakingUntil, now + tailMs);
      return;
    }
    this.selfSpeakingUntil = now + SELF_SPEAKING_MAX_MS;
    this.tailFrom = 0;
    this.tail = [];
    if (this.mode.kind !== "listening") return;
    // What the VAD heard so far is Ember's voice, or was cut by it: start afresh once Ember is done.
    this.resetListening();
    if (this.wasSpeaking) { this.wasSpeaking = false; this.emit({ type: "speech", on: false }); }
  }

  /**
   * Listen for a follow-up without the wake word (the window starts once Ember has finished speaking). Only after a
   * wake's request: the answer to a follow-up gets none, or the room's talk could keep a conversation going without
   * anyone saying "Hey Ember". It hears a voice about as loud as the one that woke Ember (within 6 dB).
   * `afterQuestion`: Ember's answer asked something, so "Okay." or "Fine." is a reply to send, not a closer.
   */
  followUp(ms = 8000, o: { afterQuestion?: boolean } = {}): void {
    if (this.afterFollowUp) return;
    if (this.mode.kind === "listening") { this.mode.until = Math.max(this.mode.until, this.now() + ms); return; }
    this.resetListening();
    this.peak = this.voice;
    this.mode = { kind: "listening", until: this.now() + ms, ms, heardSpeech: false, first: false, reason: "follow-up", checkAt: null, keyword: "", afterQuestion: !!o.afterQuestion };
    // Opened during the tail after Ember's answer: what was heard since its voice ended (before it said so) may be a reply.
    if (this.tailFrom) this.tail = this.recentFrames(TAIL_KEEP_FRAMES);
    this.emit({ type: "listening", on: true, reason: "follow-up", window: "follow-up" });
  }

  /** Stop listening for a command, and drop a wake or stop still being checked (the kill switch, Esc). */
  cancel(): void {
    this.pendingWake = null;
    this.pendingStop = null;
    this.ring.clear();
    if (this.mode.kind === "listening") this.endListening("stop");
    else this.resetListening();
  }

  /** Speaker output (PulseAudio monitor), for rejecting wake words and stops that come from videos (or Ember's own voice). */
  feedMonitor(frame: Float32Array): void {
    const at = this.now();
    this.monitorFrameAt = at;
    const rms = rmsOf(frame);
    const sound = rms >= (this.o.silenceRms ?? 0.0008);
    if (sound) this.monitorSoundAt = at;
    this.speakers.push({ frame, at, sound, energy: rms * rms });
    if (this.speakers.length > SPEAKERS_RING_FRAMES) this.speakers.shift();
    if (this.monitorSpotting) this.spotSpeakers(frame, at);
  }

  /** One frame of microphone audio, 16 kHz mono. */
  feed(frame: Float32Array): void {
    const now = this.now();
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const energy = sum / Math.max(1, frame.length);
    const rms = Math.sqrt(energy);
    this.frames++;
    this.fedAt = now;
    this.recent.push(frame);
    this.micLevels.push(energy);
    if (this.micLevels.length > SPEAKERS_RING_FRAMES) this.micLevels.shift();

    // Nobody is saying "Hey Ember" unless someone is speaking: the spotter (most of the idle CPU) rests
    // after half a second without speech, and the frames it missed are replayed when speech returns.
    // True silence is never speech. Otherwise the voice check decides: it hears speech under a fan,
    // where loudness can't (measured: in steady noise at 3–6 dB SNR, most wakes were missed). It only runs while the room
    // isn't steady, so a quiet room costs nothing. The room's noise floor is minimum statistics, so
    // continuous speech or TV, which dips between words, can't drag it up.
    const base = this.o.silenceRms ?? 0.0008;
    this.floor = Math.min(rms, Math.max(this.floor, base / 4) * (this.frames <= FLOOR_LEARN_FRAMES ? 1.05 : 1.003));
    const quiet = rms < base || (this.mode.kind === "idle" && !this.maybeSpeech(frame, rms));
    this.quietRun = quiet ? this.quietRun + 1 : 0;
    let toSpot: Float32Array[] = [frame];
    const loud = rms >= Math.max(base, this.floor * 2.5) && this.calmRun >= CALM_FRAMES;
    this.calmRun = rms < Math.max(base, this.floor * CHECK_WAKE_RATIO) ? this.calmRun + 1 : 0;
    if (quiet && this.quietRun > MIC_REST_FRAMES && this.mode.kind === "idle") {
      this.quietTail.push(frame);
      if (loud && this.loudAt < 0) this.loudAt = this.quietTail.length - 1;
      if (this.quietTail.length > MIC_TAIL_FRAMES) { this.quietTail.shift(); this.loudAt--; }
      toSpot = [];
    } else if (this.quietTail.length) {
      this.backend.resetSpot?.();
      const from = this.loudAt >= 0 ? this.loudAt - MIC_REPLAY_FRAMES : loud ? this.quietTail.length - MIC_REPLAY_FRAMES : this.quietTail.length - MIC_QUIET_REPLAY_FRAMES;
      toSpot = [...this.quietTail.slice(Math.max(0, from)), frame];
      this.quietTail = [];
      this.loudAt = -1;
    }
    const keywords: string[] = [];
    for (const f of toSpot) { this.spotted++; keywords.push(...this.backend.spot(f)); }
    // A pause after speech: the spotter would otherwise wait for 0.3–0.45 s more audio before deciding on the
    // last words ("Hey Ember." then a pause: the cue came 0.44 s after the name; now 0.1 s).
    const sound = rms >= Math.max(base, this.floor * 2.5);
    let paused = false;
    if (sound) { if (this.pauseRun >= PAUSE_FRAMES) this.soundRun = 0; this.soundRun++; this.pauseRun = 0; }
    else if (++this.pauseRun === PAUSE_FRAMES && this.soundRun >= SOUND_FRAMES && toSpot.length && this.backend.padSpot) {
      const early = this.backend.padSpot();
      paused = early.length > 0;
      keywords.push(...early);
    }

    const checkAt = (at: number) => (this.o.verifyWake === false ? null : at + (this.o.checkAfterMs ?? (paused ? PAUSED_CHECK_MS : 0)));
    for (const keyword of keywords) {
      if (keyword === "ember_stop") {
        // The kill phrase works in every state (also while Ember speaks: that's when it's needed). It goes once
        // the speakers didn't say it and the recognizer heard "Ember, stop" (not "September stopped").
        if (this.pendingStop?.keyword !== keyword) { this.pendingStop = { keyword, at: now, checkAt: checkAt(now) }; this.watchSpeakers(); }
        continue;
      }
      if (now < this.selfSpeakingUntil) {
        // While Ember speaks, "Hey Ember" the speakers didn't say cuts in (see decideStop); "Hey Ember, stop" stops (the
        // spotter takes the name, so the kill phrase isn't spotted after it): checked once "stop" has been said.
        if (this.o.verifyWake === false) this.emit({ type: "rejected", keyword, reason: "self" });
        else if (!this.pendingStop) { this.pendingStop = { keyword, at: now, checkAt: now + SELF_STOP_MAX_MS }; this.watchSpeakers(); }
        continue;
      }
      if (this.mode.kind === "idle" && !this.pendingWake) { this.pendingWake = { keyword, at: now, paused }; this.watchSpeakers(); }
    }
    this.monitorHits = this.monitorHits.filter(h => now - h.at < 5000);
    if (this.pendingStop && sound && now > this.pendingStop.at) this.pendingStop.spoke = true;
    this.decideStop(now);

    // A wake is accepted once we're sure the speakers didn't just say it.
    if (this.pendingWake) {
      const w = this.pendingWake;
      if (this.saidBySpeakers(w.keyword, w.at)) {
        this.pendingWake = null;
        this.emit({ type: "rejected", keyword: w.keyword, reason: "speakers" });
      } else if (this.speakersClear(w.at, now)) {
        this.pendingWake = null;
        // Ember shows it's listening at once. The transcript check takes the wake back if the recognizer
        // clearly heard another word ("Amber"). Mid-speech the spotter fires 0.45 s after the word, so it
        // checks at once (checking later took back more real wakes: of 90, 3 at once, 8 after 128 ms, 6 after
        // 256 ms); at a pause it fires sooner, and the check waits for what followed the word.
        // The bare name has no check here: what follows it decides (handleSegment), as a moment of audio after a name
        // said out of silence is too little for the recognizer ("Emperor Tunnel Nine"), and "Hey, rem|ember to…" heard
        // as it is spotted sounds like "Hey, Ember".
        this.announceWake(w.keyword, this.o.verifyWake === false || w.keyword === BARE_NAME ? null : w.at + (this.o.checkAfterMs ?? (w.paused ? PAUSED_CHECK_MS : 0)));
        if (this.mode.kind === "listening" && this.mode.checkAt === null) this.replayPreRoll();
      }
    }
    if (this.monitorSpotting && !this.pendingWake && !this.pendingStop) {
      this.monitorSpotting = false;
      this.backend.resetMonitor?.();
    }

    if (this.mode.kind === "idle") {
      this.ring.push(frame);
      return;
    }
    if (this.mode.checkAt !== null) {
      // What's heard is held (with the pre-roll) until the wake is checked, then replayed.
      this.ring.push(frame);
      if (now < this.mode.checkAt) return;
      this.mode.checkAt = null;
      const heard = this.backend.transcribe(this.ring.read());
      if (heard && heardOtherWord(heard) && isStop(stripWake(heard, true))) {
        // "Hey, Amber, stop.": whoever it was for, stopping is the safe side (and it's often "Ember" misheard).
        this.emit({ type: "stop" });
        this.ring.clear();
        this.endListening("stop");
      } else if (heard && heardOtherWord(heard)) {
        this.emit({ type: "rejected", keyword: this.mode.keyword, reason: "check", heard });
        this.ring.clear();
        this.endListening("rejected");
      } else {
        this.replayPreRoll();
      }
      return;
    }
    // The speakers went quiet (their own stream says so) and the microphone has stopped hearing them: Ember's voice is over, the tail can end now.
    if (this.tailFrom && now < this.selfSpeakingUntil && now - this.monitorFrameAt < 200 && now - this.monitorSoundAt > this.micLag) this.selfSpeakingUntil = now;
    if (now < this.selfSpeakingUntil) {
      // Ember's own voice (it plays outside the browser's echo cancellation) is not a request: the VAD isn't fed,
      // and the window stays open until Ember has finished. Otherwise Ember answers itself, again and again.
      this.mode.until = Math.max(this.mode.until, now + this.mode.ms);
      this.tail.push({ frame, energy, at: now });
      if (this.tail.length > TAIL_KEEP_FRAMES) this.tail.shift();
      return;
    }
    if (this.tailFrom && !this.afterTail(frame, energy, now)) return;
    this.listen(frame, energy);
    if (this.mode.kind === "listening" && now > this.mode.until && (!this.backend.speaking() || !this.segmentStandsOut())) {
      // Time's up, and nobody (or only the room's other talk) is speaking.
      for (const seg of this.backend.flushVad()) this.handleSegment(this.trim(seg));
      if (this.mode.kind === "listening") this.endListening("timeout");
    }
  }

  /** Idle: might someone be speaking? (See feed.) */
  private maybeSpeech(frame: Float32Array, rms: number): boolean {
    if (!this.backend.hearsSpeech) return rms >= this.floor * 2.5;
    if (rms >= this.floor * CHECK_WAKE_RATIO) this.unsteady = CHECK_HANG_FRAMES;
    else if (this.unsteady > 0) this.unsteady--;
    if (!this.unsteady) return false;
    if (this.checkedAt !== this.frames - 1) {
      // Starting afresh (it rested, or Ember was listening): a moment of what came before, for context.
      this.backend.resetHearsSpeech?.();
      const pre = this.ring.read();
      for (let i = Math.max(0, pre.length - CHECK_CONTEXT_FRAMES * 512); i < pre.length; i += 512) this.backend.hearsSpeech(pre.subarray(i, i + 512));
    }
    this.checkedAt = this.frames;
    return this.backend.hearsSpeech(frame);
  }

  /** A wake or stop was spotted while the speakers play: spot what they played (their last 3 s, then as it comes). */
  private watchSpeakers(): void {
    if (this.monitorSpotting || !this.backend.spotMonitor || this.now() - this.monitorSoundAt > SPEAKERS_QUIET_MS) return;
    this.monitorSpotting = true;
    this.backend.resetMonitor?.();
    // Like the microphone's spotter, from 12 frames before their sound last started out of silence (a stream fed
    // a long silence first misses the phrase).
    let from = 0;
    for (let i = this.speakers.length - 1, quiet = 0, heard = false; i >= 0; i--) {
      heard ||= this.speakers[i].sound;
      quiet = this.speakers[i].sound || !heard ? 0 : quiet + 1;
      if (quiet > MIC_REST_FRAMES) { from = i + quiet - MIC_REPLAY_FRAMES; break; }
    }
    for (const s of this.speakers.slice(Math.max(0, from))) this.spotSpeakers(s.frame, s.at);
    // Decided on all they played up to now (the microphone's spotter may have decided early, at a pause).
    const at = this.speakers.at(-1)?.at ?? this.now();
    for (const keyword of this.backend.padMonitor?.() ?? []) this.monitorHits.push({ keyword, at });
  }

  private spotSpeakers(frame: Float32Array, at: number): void {
    for (const keyword of this.backend.spotMonitor?.(frame) ?? []) this.monitorHits.push({ keyword, at });
  }

  private saidBySpeakers(keyword: string, at: number): boolean {
    const window = this.o.rejectWindowMs ?? 400;
    // The bare name is in every phrase: the microphone's may be the name of a phrase the speakers' stream spotted whole.
    // Not the other way round: the speakers' "remember" (the name in another word) doesn't take back the user's "Hey Ember".
    const same = (k: string) => k === keyword || keyword === BARE_NAME;
    return this.monitorHits.some(h => same(h.keyword) && Math.abs(h.at - at) <= window);
  }

  /** The speakers can't have said what was spotted at `at`: their window has passed, or they were quiet all along. */
  private speakersClear(at: number, now: number): boolean {
    return !this.backend.spotMonitor || now - at >= (this.o.rejectWindowMs ?? 400) || now - this.monitorSoundAt > SPEAKERS_QUIET_MS;
  }

  private decideStop(now: number): void {
    const s = this.pendingStop;
    if (!s) return;
    if (this.saidBySpeakers(s.keyword, s.at)) {
      this.pendingStop = null;
      this.emit({ type: "rejected", keyword: s.keyword, reason: "speakers" });
      return;
    }
    if (s.keyword !== "ember_stop" && !s.checked && now < this.selfSpeakingUntil && this.speakersClear(s.at, now) && this.hearsSpeakers(now)) {
      // "Hey Ember" while Ember speaks, and its speakers' own stream didn't say it: the user is cutting in (see bargeIn).
      // Without that stream, Ember can't tell its own voice from the user's: only "Hey Ember, stop" counts (below).
      s.checked = true;
      if (this.bargeIn(s, now)) return;
    }
    const waits = s.keyword !== "ember_stop" || s.again;
    const due = s.checkAt === null || now >= s.checkAt || (waits && this.pauseRun >= (s.spoke || s.again ? SELF_STOP_PAUSE_FRAMES : SELF_STOP_SILENT_FRAMES));
    if (!this.speakersClear(s.at, now) || !due) return;
    this.pendingStop = null;
    const emberSpeaking = now < this.selfSpeakingUntil;
    if (s.keyword !== "ember_stop") {
      // "Hey Ember" while Ember spoke: a stop if "stop" came with it, otherwise Ember's own voice (or a wake it can't take now).
      const heard = this.backend.transcribe(this.fromSound(this.recentAudio(this.fedAt - s.at + SELF_STOP_BEFORE_MS)));
      if (!saidWakeStop(heard)) { if (!s.bargeIn) this.emit({ type: "rejected", keyword: s.keyword, reason: "self", heard }); return; }
    } else if (s.checkAt !== null) {
      const heard = this.backend.transcribe(this.fromSound(this.recentAudio(s.again ? this.fedAt - s.at + SELF_STOP_BEFORE_MS : STOP_CHECK_SECONDS * 1000)));
      const empty = !/[a-z]/i.test(heard);
      if (!s.again && (empty || (!emberSpeaking && afterName(heard.toLowerCase(), /amber|emma/) !== null)) && this.pauseRun < SELF_STOP_PAUSE_FRAMES) {
        // "Amber, stop…" and the speaker goes on, or nothing made out yet (the phrase cut mid-word): decided at their next
        // pause (0.6 s at most), on how the sentence went on.
        this.pendingStop = { ...s, checkAt: now + NAMED_STOP_WAIT_MS, again: true };
        return;
      }
      // Nothing made out even at the pause: the spotter's "Ember, stop" stands (the kill switch errs on the safe side; a
      // quiet "Ember stop" can come out empty). Words that say it wasn't one reject it.
      if (!empty && (s.again && !emberSpeaking ? !stopSaidAlone(heard) : heardOtherStop(heard, emberSpeaking))) { this.emit({ type: "rejected", keyword: "ember_stop", reason: "check", heard }); return; }
    }
    this.emit({ type: "stop" });
    if (this.mode.kind === "listening") this.endListening("stop");
    this.pendingWake = null;
  }

  /** Is the speakers' stream arriving (so a wake word they didn't say wasn't Ember's own voice)? */
  private hearsSpeakers(now: number): boolean {
    return !!this.backend.spotMonitor && now - this.monitorFrameAt < 200;
  }

  /**
   * "Hey Ember" the speakers didn't say, while Ember speaks: the wake's check runs first, on what the microphone heard
   * (the phrase was said 0.4 s ago). "Hey Ember, stop" (Ember's words around it) stops. Another name ("Hey Amber, …",
   * someone else in the room) leaves Ember speaking: the stop check still decides on it, as before. Otherwise the user
   * is cutting in: Ember's voice counts as over from now (main hushes it on a wake, and nothing it was saying resumes),
   * and a wake's window opens on the pre-roll (Ember's words around the wake phrase are left out where the user's
   * voice is much louder, as before a wake). Returns whether the stop check is done with.
   */
  private bargeIn(s: PendingStop, now: number): boolean {
    // A window that was already listening has heard its pre-roll (the ring is empty): nothing to check here, and the stop
    // check below still hears what was said with the name.
    const pre = this.ring.read();
    const heard = pre.length >= MIN_TRANSCRIBE_SAMPLES ? this.backend.transcribe(pre) : "";
    if (saidWakeStop(heard)) {
      this.pendingStop = null;
      this.emit({ type: "stop" });
      if (this.mode.kind === "listening") this.endListening("stop");
      this.ring.clear();
      return true;
    }
    if (heard && heardOtherWord(heard)) return false;
    // The bare name cuts in only where the recognizer heard the name itself (not "remember" or "September"); Ember's own
    // words can come before it here, so it needn't start what was heard.
    if (s.keyword === BARE_NAME && !/\b(ember|emmer)\b(?!['’]?s\b)/i.test(heard)) return false;
    s.bargeIn = true;
    this.selfSpeakingUntil = now;
    this.tailFrom = 0;
    this.tail = [];
    // (The bare name shows at once here: the name was heard, and main must hush Ember on the wake.)
    this.announceWake(s.keyword, null, true);
    if (this.mode.kind === "listening") this.mode.bargeIn = true;
    this.replayPreRoll();
    return false;
  }

  private announceWake(keyword: string, checkAt: number | null, show = false): void {
    // The bare name shows once what was said with it starts with the name (see Mode.announced), unless nothing checks it.
    const quiet = keyword === BARE_NAME && this.o.verifyWake !== false && !show;
    if (!quiet) this.emit({ type: "wake", keyword });
    this.resetListening();
    this.peak = 0;
    // The 1.5 s before the wake phrase (and what the pre-roll holds).
    const silence = Math.max(this.o.silenceRms ?? 0.0008, this.floor * SILENCE_RATIO) ** 2, before = this.micLevels.slice(0, -WAKE_PHRASE_FRAMES);
    this.busyRoom = before.length >= BUSY_FRAMES && before.filter(e => e >= silence).length >= before.length * BUSY_SHARE;
    const ms = this.o.waitForSpeechMs ?? 6000;
    this.mode = { kind: "listening", until: this.now() + ms, ms, heardSpeech: false, first: true, reason: "wake", checkAt, keyword, ...(quiet ? { announced: false } : {}) };
    if (!quiet) this.emit({ type: "listening", on: true, reason: "wake", window: "wake" });
  }

  /** Replays what was said just before (and during) the wake word, so a one-breath request isn't cut. */
  private replayPreRoll(): void {
    const pre = this.ring.read();
    this.ring.clear();
    for (let i = 0; i < pre.length && this.mode.kind === "listening"; i += 512) {
      const f = pre.subarray(i, i + 512);
      let sum = 0;
      for (let k = 0; k < f.length; k++) sum += f[k] * f[k];
      this.listen(f, sum / Math.max(1, f.length));
    }
  }

  /**
   * Ember's tail is over. If the user was already replying, what they said around its end is heard too: from
   * the speakers' own silence (plus the microphone's lag) when their stream says when that was; otherwise, once
   * the sound has gone on for 8 frames past the tail (Ember's own voice, when it was said to have ended early,
   * stops sooner), from where it went quiet in the tail (2 quiet frames: a pause between Ember's own words is
   * shorter). Returns whether this frame is still to be heard (false: it's held, or was heard with the tail).
   */
  private afterTail(frame: Float32Array, energy: number, now: number): boolean {
    const quiet = (e: number) => Math.sqrt(e) < Math.max(this.o.silenceRms ?? 0.0008, this.floor * 2.5);
    const replay = (frames: { frame: Float32Array; energy: number }[]) => {
      this.tail = [];
      this.tailFrom = 0;
      for (const t of frames) this.listen(t.frame, t.energy);
    };
    if (now - this.monitorFrameAt < 200) {
      // From the frame the microphone heard the speakers' last sound in, and one before it (their last sounds are a
      // faint fade, and the lag is known to a frame): a reply said right at the end keeps its first word.
      const quietAt = this.monitorSoundAt + this.micLag - 32;
      replay(this.tail.filter(t => t.at >= quietAt));
      return true;
    }
    const tail = this.tail.filter(t => t.at >= this.tailFrom && t.at < this.selfSpeakingUntil).slice(-TAIL_FRAMES);
    const held = this.tail.filter(t => t.at >= this.selfSpeakingUntil);
    if (quiet(energy)) { replay([]); return true; } // nothing, or only Ember's last sounds, went on past the tail
    this.tail.push({ frame, energy, at: now });
    if (held.length + 1 < TAIL_HOLD_FRAMES) return false;
    let from = tail.length;
    for (let i = tail.length - 1; i > 0; i--) if (quiet(tail[i].energy) && quiet(tail[i - 1].energy)) { from = i - 1; break; }
    replay([...tail.slice(from), ...held, { frame, energy }]);
    return false;
  }

  /** The microphone's recent `audio` from a little before its first sound (see STOP_LEAD_FRAMES; in frames as they came), or all of it if it has none. */
  private fromSound(audio: Float32Array): Float32Array {
    const silence = Math.max(this.o.silenceRms ?? 0.0008, this.floor * SILENCE_RATIO);
    for (let i = audio.length % 512; i + 512 <= audio.length; i += 512) if (rmsOf(audio.subarray(i, i + 512)) >= silence) return audio.subarray(Math.max(0, i - STOP_LEAD_FRAMES * 512));
    return audio;
  }

  /** What the microphone heard in the last `ms`. */
  private recentAudio(ms: number): Float32Array {
    const s = this.recent.read();
    return s.subarray(Math.max(0, s.length - Math.round((ms * SAMPLE_RATE) / 1000)));
  }

  /** The last `n` frames the microphone heard (the frames as they came, and when). */
  private recentFrames(n: number): { frame: Float32Array; energy: number; at: number }[] {
    const s = this.recent.read(), out: { frame: Float32Array; energy: number; at: number }[] = [];
    for (let k = 1; k <= n && k * 512 <= s.length; k++) {
      const frame = s.slice(s.length - k * 512, s.length - (k - 1) * 512);
      out.unshift({ frame, energy: rmsOf(frame) ** 2, at: this.fedAt - (k - 1) * 32 });
    }
    return out;
  }

  /**
   * How much later the microphone hears the speakers (ms): where the loudness of the speakers' last 3 s lines up
   * best with the microphone's (frame by frame, in dB), up to when the speakers went quiet (a reply may follow).
   * Null when it doesn't line up well (the microphone doesn't hear them).
   */
  private measureLag(): number | null {
    const mic = this.micLevels, spk = this.speakers;
    if (this.now() - this.monitorFrameAt > 200 || !spk.some(s => s.sound)) return null;
    const db = (e: number) => 10 * Math.log10(e + 1e-10);
    // The microphone's latest frame came this many frames after the speakers' latest, and this many after their last sound.
    const ahead = Math.round((this.fedAt - this.monitorFrameAt) / 32), sinceSound = Math.round((this.fedAt - this.monitorSoundAt) / 32);
    let best = LAG_MIN_CORRELATION, lag: number | null = null;
    for (let l = 0; l <= MAX_LAG_FRAMES; l++) {
      const x: number[] = [], y: number[] = [];
      for (let i = sinceSound; i < mic.length; i++) {
        const k = i + l - ahead; // frames back from the speakers' latest
        if (k < 0 || k >= spk.length) continue;
        x.push(db(spk[spk.length - 1 - k].energy));
        y.push(db(mic[mic.length - 1 - i]));
      }
      const r = x.length >= 32 ? correlation(x, y) : 0;
      if (r > best) { best = r; lag = l * 32; }
    }
    return lag;
  }

  /** Feeds a frame to the VAD, follows the speaker's loudness, and ends a request their voice has left (or that ran on too long). */
  private listen(frame: Float32Array, energy: number): void {
    const segments = this.backend.vad(frame);
    const speaking = this.backend.speaking();
    if (speaking !== this.wasSpeaking) {
      this.wasSpeaking = speaking;
      this.emit({ type: "speech", on: speaking });
      if (speaking && this.mode.kind === "listening") this.mode.heardSpeech = true;
    }
    if (speaking || segments.length) {
      this.segment.push(energy);
      if (this.segment.length > SEGMENT_FRAMES) this.segment.shift();
      const n = this.segment.length;
      if (speaking && n >= LOUD_FRAMES) this.peak = Math.max(this.peak, median(this.segment, n - LOUD_FRAMES, n));
      // The room's own noise: a pause, or the end, that the VAD's silence decides on (for 0.64 s at most since the voice).
      const silent = Math.sqrt(energy) < Math.max(this.o.silenceRms ?? 0.0008, this.floor * SILENCE_RATIO);
      this.silentRun = silent ? this.silentRun + 1 : 0;
      if (this.silentRun >= BREATH_FRAMES) this.silentAt = n;
      this.hushRun = silent && this.hushed < PAUSE_HOLD_FRAMES ? this.hushRun + 1 : 0;
      // The count starts over when the speaker's voice is back, or at their softer words before any pause; it holds in a
      // pause, and at loud talk after one (see QUIET_RATIO).
      const near = median(this.segment, n - LOUDNESS_FRAMES, n) >= this.peak * QUIET_RATIO, voice = median(this.segment, n - BACK_FRAMES, n) >= this.peak * CLOSE_RATIO;
      if (voice) { this.quietFor = 0; this.pausedSinceVoice = false; this.hushed = 0; }
      else if (near && !this.pausedSinceVoice) this.quietFor = 0;
      else if (!near && this.hushRun < SILENT_FRAMES) this.quietFor++;
      if (this.hushRun >= SILENT_FRAMES) { this.pauseAt = n; this.pausedSinceVoice = true; this.hushed++; }
      // After cutting in, the speaker's voice once Ember's no longer reaches the microphone (it starts over if Ember's does again).
      if (this.mode.kind === "listening" && this.mode.bargeIn) this.afterHush = this.fedAt - this.monitorSoundAt <= this.micLag + OVER_EMBER_MS ? 0 : this.afterHush + (voice ? 1 : 0);
    }
    for (const seg of segments) this.handleSegment(this.trim(seg, false));
    if (segments.length && !speaking) this.endSegment();
    if (this.mode.kind !== "listening" || !speaking) return;
    const n = this.segment.length;
    // At 10 s, a request goes on (to 20 s) while the speaker's own voice does, in a room quiet when they breathe.
    const goesOn = this.voiceIn(n - 2 * STILL_TALKING_FRAMES) && n - this.silentAt <= BREATH_WINDOW_FRAMES;
    const capped = n >= LONG_CAP_FRAMES || (n >= SPEECH_CAP_FRAMES && !goesOn);
    const over = this.quietFor >= QUIET_END_FRAMES && !this.hushRun && n - this.pauseAt > RETURN_FRAMES;
    if (over || capped) {
      const cut = !over && this.voiceIn(n - STILL_TALKING_FRAMES);
      for (const seg of this.backend.flushVad()) this.handleSegment(this.trim(seg), cut);
      this.endSegment();
    }
  }

  /** Was the speaker's own voice (within 12 dB of the request's loudness) heard in the segment since frame `from`? */
  private voiceIn(from: number): boolean {
    const e = this.segment, half = LOUD_FRAMES >> 1;
    for (let i = Math.max(0, from); i < e.length; i++) if (median(e, i - half, i + half + 1) >= this.peak * QUIET_RATIO) return true;
    return false;
  }

  private endSegment(): void {
    this.segment = [];
    this.quietFor = 0;
    this.pauseAt = Number.NEGATIVE_INFINITY;
    this.pausedSinceVoice = false;
    this.hushRun = 0;
    this.hushed = 0;
    this.silentRun = 0;
    this.silentAt = -1;
    this.afterHush = 0;
  }

  /** The VAD starts afresh (the window's loudest frame is kept). */
  private resetListening(): void {
    this.backend.resetVad();
    this.endSegment();
  }

  /**
   * Does anything in the segment under way stand out like the speaker's own voice (within 12 dB of the request's
   * loudness; within 6 dB of the wake phrase's once it was heard, in a follow-up of the wake's request)?
   */
  private segmentStandsOut(): boolean {
    const { first, close } = this.loudFrames();
    return this.mustBeClose() ? close >= 0 : first >= 0;
  }

  /**
   * A follow-up hears only a voice about as loud as the one that woke Ember, and so does a wake's window once it heard
   * the wake phrase in a room where others talk: the user says their request up close, as they said "Hey Ember"; the
   * room's talk, 10 dB under them, isn't a request (it was sent when the user said nothing more).
   */
  private mustBeClose(): boolean {
    if (this.mode.kind !== "listening") return false;
    return this.mode.reason === "follow-up" ? this.voice > 0 : !this.mode.first && this.peak > 0 && this.busyRoom;
  }

  /**
   * The first and last frames of the segment under way (or of the frame energies `e`) loud enough to be the
   * speaker's (the 9 frames around them), or -1; and the first within 6 dB of the request's loudness (the wake
   * phrase is said up close: what the pre-roll heard before it, quieter, is someone else), in a follow-up the wake's;
   * `closeEnd`: where that loudness first stops (the wake phrase's end, at the start of a wake's window), and
   * `closeAgain`: whether it comes back after that.
   * With `silent` (an energy), the loudness of 9 frames is that of those with sound (at least 5): a short word's
   * own, not lowered by the silence around it.
   */
  private loudFrames(e: number[] = this.segment, silent = -1): { first: number; last: number; close: number; closeEnd: number; closeAgain: boolean } {
    const followUp = this.mode.kind === "listening" && this.mode.reason === "follow-up" && this.voice > 0;
    const half = LOUD_FRAMES >> 1, threshold = this.peak * QUIET_RATIO, closeThreshold = (followUp ? this.voice : this.peak) * CLOSE_RATIO;
    let first = -1, last = -1, close = -1, closeEnd = -1, closeAgain = false;
    for (let i = 0; i < e.length; i++) {
      const m = silent < 0 ? median(e, i - half, i + half + 1) : soundMedian(e, i - half, i + half + 1, silent);
      if (m >= closeThreshold) {
        if (close < 0) close = closeEnd = i;
        else if (i - closeEnd <= CLOSE_GAP_FRAMES && !closeAgain) closeEnd = i;
        else closeAgain = true;
      }
      if (m < threshold) continue;
      if (first < 0) first = i;
      last = i;
    }
    return { first, last, close, closeEnd, closeAgain };
  }

  /**
   * A segment as it goes to the recognizer: a flushed one (it ends with the last frame heard) loses what came
   * after the speaker's voice left (bar 10 frames) and before it began; one with none of it is dropped, and so
   * is a follow-up's with nothing near the wake's loudness. Natural ends (silence) are kept whole. Never more than 21 s.
   * Its loudness is measured on its own frames, those with sound: the VAD hears speech 0.2 s after it starts, and a
   * word as short as "Yes." never showed 0.3 s near the voice's loudness after that (a follow-up's "Yep." was dropped
   * 6 times in 6).
   * `before`: a moment of what was heard before it (for a second try at a short one, see handleSegment).
   */
  private trim(seg: Float32Array, flushed = true): Clip | null {
    const levels = framesOf(seg), { first, last, close, closeEnd, closeAgain } = this.loudFrames(levels, Math.max(this.o.silenceRms ?? 0.0008, this.floor * SILENCE_RATIO) ** 2);
    if (levels.length && (first < 0 || (this.mustBeClose() && close < 0))) return null;
    const n = levels.length, wakePhrase = this.mode.kind === "listening" && this.mode.first && close >= 0;
    let from = 0, to = seg.length;
    if (flushed && first >= 0) {
      const start = wakePhrase ? close : first;
      to = Math.max(0, seg.length - Math.max(0, n - 1 - last - KEEP_AFTER_FRAMES) * 512);
      from = Math.max(0, seg.length - (n - start + KEEP_AFTER_FRAMES) * 512);
    }
    const audio = seg.subarray(from, Math.min(to, from + MAX_TRANSCRIBE));
    // Right after a wake in a room where others talk, the user's voice was as loud as the wake phrase only in it, and
    // what goes to the recognizer goes on after it: what they said themselves is the wake phrase's stretch (see handleSegment).
    const ownTo = seg.length - Math.max(0, n - 1 - closeEnd - OWN_AFTER_FRAMES) * 512;
    const own = wakePhrase && this.busyRoom && !closeAgain && ownTo > from && ownTo < from + audio.length ? seg.subarray(from, ownTo) : undefined;
    return { audio, before: from ? seg.subarray(Math.max(0, from - RETRY_LEAD), from) : this.backend.before?.(seg) ?? null, own };
  }

  private handleSegment(clip: Clip | null, cut = false): void {
    if (this.mode.kind !== "listening" || !clip?.audio.length) return;
    const t0 = this.now();
    let heard = this.transcribe(clip.audio);
    if (!/[a-z0-9]/i.test(heard) && clip.before?.length && clip.audio.length <= RETRY_MAX) {
      // The recognizer heard nothing in a short segment (its way with a lone word now and then): a second try, with
      // a moment of what came before it (measured on 159 short replies: 24 came back empty, 4 after a second try).
      const again = new Float32Array(clip.before.length + clip.audio.length);
      again.set(clip.before);
      again.set(clip.audio, clip.before.length);
      heard = this.transcribe(again);
    }
    if (this.mode.announced === false) {
      // The bare name, with all that was said with it: "Ember, stop" stops (the spotter takes the name, so the kill phrase
      // isn't spotted after it); a phrase it doesn't start ("I remember…", "the embers…") was never a wake, and nothing
      // was shown. Otherwise the wake shows now, and what was said is the request.
      if (heard && isStop(stripWake(heard, true))) { this.emit({ type: "stop" }); this.endListening("stop"); return; }
      if (!calledByName(heard)) { this.emit({ type: "rejected", keyword: BARE_NAME, reason: "check", heard }); this.endListening("rejected"); return; }
      this.mode.announced = true;
      this.emit({ type: "wake", keyword: BARE_NAME });
      this.emit({ type: "listening", on: true, reason: "wake", window: "wake" });
    }
    const bargeIn = !!this.mode.bargeIn, stopped = (t: string) => isStop(t) || (bargeIn && heardStopWord(t));
    if (bargeIn && this.pendingStop?.bargeIn) this.pendingStop = null; // decided here, on what the window heard
    if (bargeIn && saidWakeStop(heard)) {
      // "Hey Ember, stop" with Ember's last words after it ("Hey Ember stopped Thursday at 2.").
      this.emit({ type: "stop" });
      this.endListening("stop");
      return;
    }
    if (bargeIn && this.mode.first && heardOtherWord(heard) && !stopped(stripWake(heard, true))) {
      // "Hey Amber, what time is the meeting?": the check (0.4 s after the name, over Ember's voice) made out too little;
      // the whole of it is someone talking to an Amber ("Hey, Amber, be quiet." still stops: the safe side).
      this.emit({ type: "rejected", keyword: this.mode.keyword, reason: "check", heard });
      this.endListening("rejected");
      return;
    }
    let text = stripWake(heard, this.mode.first);
    this.mode.first = false;
    if (clip.own && saysSomething(text) && !saysSomething(stripWake(this.transcribe(clip.own), true).replace(LONE_GREETING, ""))) {
      // "Hey Ember." and then only others' talk (a TV, colleagues: under the wake phrase's loudness): the user hasn't
      // said their request yet.
      text = "";
    }
    if (!saysSomething(text)) {
      // Only the wake phrase (or a cough, or "um"): keep listening for the request.
      this.mode.until = Math.max(this.mode.until, this.now() + 4000);
      return;
    }
    if (stopped(text)) {
      // "Hey Ember, stop": the kill phrase in other words, handled here and never sent anywhere (once: the spotter may have heard it too).
      this.pendingStop = null;
      this.emit({ type: "stop" });
      this.endListening("stop");
      return;
    }
    if (this.mode.reason === "follow-up" && isCloser(text, this.mode.afterQuestion)) {
      // "Thanks.": nothing more to do (like a window that heard nothing).
      this.endListening("timeout");
      return;
    }
    if (bargeIn && !this.mode.held && this.afterHush < AFTER_HUSH_FRAMES) {
      // Said over Ember's voice, and not a stop: maybe not what was said (see AFTER_HUSH_FRAMES). Ember has been hushed,
      // and listens for the request again.
      this.mode.held = true;
      this.mode.until = Math.max(this.mode.until, this.now() + 4000);
      return;
    }
    // A wake's request sets the loudness its follow-up must come near; a follow-up's request gets no follow-up.
    const window = this.mode.reason;
    if (window === "wake") this.voice = this.peak;
    this.afterFollowUp = window === "follow-up";
    this.emit({ type: "utterance", text, ms: this.now() - t0, window, ...(cut ? { cut } : {}) });
    this.endListening("done");
  }

  /** At most 12 s at a time goes to the recognizer, split where it's quietest (between 6 and 12 s in). */
  private transcribe(seg: Float32Array): string {
    const parts: string[] = [];
    let at = 0;
    while (seg.length - at > TRANSCRIBE_CHUNK) {
      let split = at + TRANSCRIBE_CHUNK, low = Infinity;
      for (let i = at + TRANSCRIBE_CHUNK / 2; i + 1600 <= at + TRANSCRIBE_CHUNK; i += 512) {
        const e = rmsOf(seg.subarray(i, i + 1600));
        if (e < low) { low = e; split = i + 800; }
      }
      parts.push(this.backend.transcribe(seg.subarray(at, split)));
      at = split;
    }
    parts.push(this.backend.transcribe(seg.subarray(at)));
    return parts.map(p => p.trim()).filter(Boolean).join(" ");
  }

  private endListening(reason: "timeout" | "done" | "stop" | "rejected"): void {
    const window = this.mode.kind === "listening" ? this.mode.reason : "wake";
    const shown = this.mode.kind !== "listening" || this.mode.announced !== false;
    this.mode = { kind: "idle" };
    this.wasSpeaking = false;
    this.tail = [];
    this.tailFrom = 0;
    this.resetListening();
    if (shown) this.emit({ type: "listening", on: false, reason, window });
  }
}

/**
 * A segment as it goes to the recognizer, and a moment of what was heard before it (null: not known); `own`: right
 * after a wake, the part with the wake phrase's loudness, when sound went on after it (others' talk, or a softer request).
 */
type Clip = { audio: Float32Array; before: Float32Array | null; own?: Float32Array };

/** "Hey." "A." (the wake phrase with its name cut off). */
const LONE_GREETING = /^\W*(a|hey|hi|ok|okay|hay|pay|pey|they)\W*$/i;

/** Words, not only punctuation, a cough or an "um". */
function saysSomething(text: string): boolean {
  return !!text && !/^[\s.,!?]*$/.test(text) && !isFiller(text);
}

/** The energy of each 512-sample frame of `seg`, counted back from its end (a flushed segment ends with the frame just heard). */
function framesOf(seg: Float32Array): number[] {
  const out: number[] = [];
  for (let end = seg.length; end >= 512; end -= 512) {
    let sum = 0;
    for (let i = end - 512; i < end; i++) sum += seg[i] * seg[i];
    out.push(sum / 512);
  }
  return out.reverse();
}

/** The median of the frames in `e[from..to)` with sound (over `silent`), if at least half of them have it; else 0. */
function soundMedian(e: number[], from: number, to: number, silent: number): number {
  const a = e.slice(Math.max(0, from), Math.min(e.length, to)).filter(x => x > silent).sort((x, y) => x - y);
  return a.length * 2 >= to - from ? a[a.length >> 1] : 0;
}

/** The median of `e[from..to)` (clipped to it). */
function median(e: number[], from: number, to: number): number {
  const a = e.slice(Math.max(0, from), Math.min(e.length, to)).sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : 0;
}

function rmsOf(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / Math.max(1, frame.length));
}

/** Pearson's correlation of two series of the same length (0 when either is flat). */
function correlation(x: number[], y: number[]): number {
  const n = x.length, mx = x.reduce((a, v) => a + v, 0) / n, my = y.reduce((a, v) => a + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
