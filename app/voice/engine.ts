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
 * After Ember answers a wake's request: a follow-up window where no wake word
 * is needed ("Thanks" ends it), for a voice as loud as the one that woke Ember
 * (up to three in a row; "Hey Ember" in one makes it a wake's).
 * While Ember itself is speaking, "Hey Ember" that its speakers' own stream didn't
 * say cuts in: Ember is hushed and listens. Without that stream, only "Hey Ember"
 * with its greeting cuts in (Ember never says it there), and nothing heard before
 * Ember says it has stopped is sent. What was said over Ember's voice is only
 * heard for a stop, unless the request went on once Ember was quiet. "Hey Ember"
 * or "Ember, stop" is ignored when it comes out of the speakers; a listening
 * window waits until Ember has finished speaking.
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
  /**
   * The speech the VAD is in the middle of, from a little before it began up to the last frame fed, without ending
   * it (null: it hears no speech); optional. The engine transcribes it at a pause, ahead of the VAD (SPECULATE_FRAMES).
   */
  speechSoFar?(): Float32Array | null;
  /**
   * Where the VAD is: the samples fed to it since it last started afresh; optional (with speechEnd, it lets a
   * transcript made ahead be checked against where the VAD's own segment ended).
   */
  fed?(): number;
  /** Where a segment the VAD returned had its speech end by the VAD's own test (before the quiet added after it), as fed() counts. */
  speechEnd?(segment: Float32Array): number | null;
  resetVad(): void;
  /** What was said in `samples`, or "". Keyword checks keep their original handling of decoder repeats. */
  transcribe(samples: Float32Array, purpose?: "keyword" | "request"): string;
  /** What the VAD heard just before a segment it returned (0.1 s), if it still has it; optional. */
  before?(segment: Float32Array): Float32Array | null;
}

type ListeningWindow = "wake" | "follow-up" | "manual" | "conversation";

export type VoiceEvent =
  | { type: "wake"; keyword: string }
  | { type: "stop" }
  /** `window`: which listening window this is (a follow-up's timeout shouldn't clear the answer it follows). */
  | { type: "listening"; on: boolean; reason: ListeningWindow | "timeout" | "done" | "stop" | "rejected"; window: ListeningWindow }
  | { type: "speech"; on: boolean }
  /** The user started talking over Ember, in a conversation (see checkCutIn): main hushes Ember at once, and what they say follows as an utterance. */
  | { type: "cut-in" }
  /** Speech is being heard over Ember: its voice drops while what was said is checked (on), or it was nothing, and it comes back. */
  | { type: "duck"; on: boolean }
  /**
   * `window`: a wake's request, a follow-up (three in a row at most) or part of a conversation; `cut`: the speaker was
   * still talking when the request reached its length limit; `overEmber`: some of it was said while Ember spoke, so it
   * can't be told from Ember's own voice for certain and never approves anything.
   */
  /** `verified`: Voice Match compared it with the owner's voiceprint and it matched (match.ts); absent otherwise. */
  /**
   * `short`: it matched as a whole, but what follows the wake phrase was too short, or too unlike the owner on its own,
   * for Voice Match to vouch for it (APPROVAL_MIN_SECONDS, match.ts); `restScore`: that part's own score against the
   * enrolled voiceprint, unrounded, when it had one (absent: too little voice to score, which is never trusted).
   */
  | { type: "utterance"; text: string; ms: number; window: ListeningWindow; cut?: boolean; overEmber?: true; overSound?: true; verified?: true; short?: true; restScore?: number }
  /** `voice`: Voice Match found the request wasn't the owner's (`score`: how close it came); it is heard all the same (match.ts). */
  | { type: "rejected"; keyword: string; reason: "self" | "speakers" | "check" | "voice"; heard?: string; score?: number }
  /**
   * What was said in a conversation over other sound, without the name, wasn't heard: it can't be told from the song's
   * words (match.ts, owner decision of 2026-11-05). Main says so, once a conversation (voice-listening-10).
   */
  | { type: "dropped"; reason: "over-sound" };

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
  /** Transcribe a request at a pause, ahead of the VAD's end of it (SPECULATE_FRAMES). Default on. */
  transcribeAhead?: boolean;
  /** After a wake's request, keep listening as a conversation (openConversation). Default off; settings' voice.conversation. */
  conversation?: boolean;
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
  if (CALLED_AS_WORD.test(transcript)) return true;
  if (MISHEARD_NAME.test(transcript) && !heardOtherWord(transcript.replace(MISHEARD_NAME, ""))) return true;
  if (heardOtherWord(transcript)) return false;
  // "Hey" as the recognizer writes it too ("Pay Ember", "Peyember"): the spotter may take the name of "Hey Ember" first.
  return /^\W*(?:(?:\S+\s+){0,4}?\S*[.!?;:]\s+)?(?:(?:hey|hi|ok|okay|hay|pay|pey|they|a|oh|so|um|uh|well|and|yes|yeah|no|please)[\s,.!'"“”]+)*(?:hey|hay|pay|pey)?(?:ember|emmer|umber|anber|embre)\b(?!['’]?s\b)/i.test(transcript);
}

/**
 * The name written as an everyday word, where how the words go on says it was the name. On a real laptop's microphone
 * (2026-11-05) "Hey Ember" came out as "Hey, number." and "A number. What time is it?", and "Ember, open the calculator"
 * as "Number open the calculator": "number" is a near miss (heardOtherWord), so each real wake was taken back, the
 * owner's "it doesn't listen". After a greeting, or before a request's first word (never before "the": "I remember the…"
 * comes out as "Number, the…"). "Amber" only before a plain command: it is someone's name otherwise.
 */
const CALLED_AS_WORD = /^\W*(?:(?:hey|hi|hay|day|a)\W+(?:a\W+)?number\b|number\b(?=\W+(?:open|close|turn|play|search|what|who|how|when|where|why|tell|show|go|set|start|send|find|call|can|could|please)\b)|amber\b(?=\W+(?:open|close|turn|play|search|show|set|start)\b)|(?:hey|hi|hay|pay|pey|ok|okay)\W+amber\b(?=\W+(?:open|close|turn|play|search|show|set|start|send|find|call)\b))\W*/i;

/**
 * "Hey Amber…" when the spotter heard "Hey Ember": Moonshine base writes the name so (the early check heard "Pay amber to"
 * for "Hey Ember, turn on night light", and took a real wake back). Where the check heard only a word or two after the
 * name, with no end to it, it leaves this to the whole of what was said (Mode.maybeAmber): "Hey Amber, dinner's ready." is
 * still someone else's, and so is "Hey Amber, what time is it?", heard whole.
 */
const GREETED_AMBER = /^\W*(?:hey|hi|hay|pay|pey|ok|okay)\W+amber\b(?:\W+[\w']+){0,2}\s*,?\s*$/i;

/**
 * More of the recognizer's spellings of the name said first, alone or before the request ("Member.", "Member, what time
 * is it?", "Embra."): measured on 33 synthesized voices, Moonshine wrote a lone "Ember." as the name itself for 4 of
 * them, and as one of these for 3 more (and "Ember?" for 3 more than 6). Only at the very start, with no filler before
 * it ("No member, I think." was "November, I think."). Not "Amber" or "Emma" (people's names: the spotter took the name
 * in "Amber, dinner is ready." for 28 of the 33 voices), nor "Number" ("I remember the…" comes out as "Number, the…").
 * "Member" only alone or before punctuation: sentences start with it ("Member services, how can I help?").
 */
const MISHEARD_NAME = /^\W*(?:member(?=\s*(?:[,.?!]|$))|(?:embra|embro|embo|emba)\b(?!['’]?s\b))/i;

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
const NAME = String.raw`(embers?\b(?!['’])|ember(?=[a-z])|emmer\b|amber\b|member\b|emma\b|emb(?:ra|ro|o|a)\b|[ap][.\s-]*m[.\s-]*[br]\b\.?)[\s,.!?:;-]*`;
/** The wake phrase as the recognizer writes it ("Hey, Ember." "hey Emmer" "OK Amber" "Hey, EmberStop." "Peyamber" "A. M. B." "P. M. B." "Embra."). */
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
    t = t.replace(CALLED_AS_WORD, "");
    const named = t.replace(WAKE_IN_FIRST_WORDS, "");
    t = named !== t ? named : t.replace(GREETING_IN_FIRST_WORDS, "");
  }
  for (let again = t.replace(WAKE_AT_START, ""); again !== t; again = t.replace(WAKE_AT_START, "")) t = again;
  return t.trim().replace(/^[a-z]/, c => c.toUpperCase());
}

/**
 * Does the clip `heard` came from hold the wake phrase before the request (`text`, with the wake stripped)? Voice Match
 * then vouches only for what follows it (match.ts afterWakePhrase). On a later pass (`first` false: the wake phrase was
 * heard alone, and this clip is the request after it) a name said in its first words still counts ("Um, Ember, allow"),
 * though stripWake takes only a wake at the very start there: otherwise the whole clip, the name in it too, would be
 * "what follows" (security review of #143).
 */
export function holdsWake(heard: string, text: string, first: boolean): boolean {
  return text.trim() !== heard.trim() || (!first && WAKE_IN_FIRST_WORDS.test(heard));
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
/**
 * "Hey Ember" (or "OK Ember") anywhere in what was heard: a cut-in without the speakers' stream (bargeIn). Stricter than
 * WAKE, as Ember's own words reach the microphone there: not "Amber", "Emma" or "A. M. B." ("Hi Emma, the meeting
 * moved."), not "they", not "Ember's". Ember never says what this matches (spoken.ts withoutOwnPhrases takes it out).
 */
const CUT_IN_WAKE = /\b(?:hey|hi|ok|okay|k|hay|pay|pey)[\s,.!]*(?:ember|emmer)\b(?!['’]?s\b)/i;

/** Did the microphone hear "Hey Ember" as a cut-in without the speakers' stream must (CUT_IN_WAKE)? */
export function heardCutInWake(transcript: string): boolean {
  return CUT_IN_WAKE.test(transcript);
}
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
 * is how people say yes; a short no answers it too. Explicit closers ("I'm good.", "That's all.") still end it.
 */
export function isCloser(text: string, afterQuestion = false): boolean {
  if (afterQuestion && isAnswerWord(text)) return false;
  const word = String.raw`(thanks(\s+(a\s+lot|so\s+much|a\s+bunch|again))?|thank\s+you(\s+(very|so)\s+much)?|cheers|much\s+appreciated|appreciate\s+it|great|perfect|cool|nice|awesome|wonderful|excellent|good|fine|okay|ok|alright|all\s+right|sounds\s+(good|great|fine)|that\s+works|works\s+for\s+me|got\s+it|that'?s\s+(all|it|everything|fine|great|good|perfect)|that\s+is\s+all|nothing(\s+else)?|no|nope|no\s+thanks|not\s+now|i'?m\s+(good|done|fine|all\s+set)|all\s+(good|set)|bye|goodbye)`;
  if (!new RegExp(String.raw`^((okay|ok|alright|all\s+right|oh|so|yeah|um|uh)[\s,.!]+)*${word}([\s,.!]+(${word}|ember|for\s+now|then|anyway))*[\s.!,]*$`, "i").test(text)) return false;
  return !afterQuestion || /^((okay|ok|alright|all\s+right|oh|so|um|uh|well)[\s,.!]+)*(no|nope|nah|not\s+now|nothing|that'?s\s+(all|it|everything)|that\s+is\s+all|i'?m\s+(good|done|fine|all\s+set)|all\s+set|bye|goodbye)\b/i.test(text);
}

/** "No.", "Not now.", "Nope.", "Don't.": a short answer to a question of Ember's (voice-answer.ts has the full list). */
export function isAnswerWord(text: string): boolean {
  return /^((okay|ok|oh|so|um|uh|well|ember)[\s,.!]+)*(no|nope|not\s+now|no\s+thanks?|no\s+thank\s+you|don'?t|do\s+not)([\s,.!]+(thanks|ember))*[\s.!,]*$/i.test(text.trim());
}

/**
 * A request that trails off: "And make the text a.", "Open the", "Send it to my, um." (it ends on a word no request ends
 * on, with no "?" or "!"). People pause to think mid-request, and the VAD ends a request after 0.6 s of silence: such a
 * one is held for TRAIL_HOLD_MS for the rest of it (voice-listening-3). "Turn it on." and "Log in." aren't held.
 */
export function trailsOff(text: string): boolean {
  return /\b(a|an|the|to|and|or|of|for|with|my|your|from|but|into|than|u+m+|u+h+|e+r+m*)[\s,.…-]*$/i.test(text);
}

/** How long a request that trails off waits for the rest of it (ms): measured pauses mid-request were 0.7–1.2 s. */
export const TRAIL_HOLD_MS = 900;

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

  /** Keeps only the newest `samples` (all of them when it holds no more). */
  keepLast(samples: number): void {
    const s = this.read();
    if (samples >= s.length) return;
    this.clear();
    if (samples > 0) this.push(s.subarray(s.length - samples));
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
 * What the microphone hears until Ember says it has stopped speaking, and this long after it (ms: the speakers' output
 * and the microphone's own latency), is Ember's own voice: the echo canceller doesn't take out the voice it plays
 * through Web Audio (player.ts). A wake that follows it leaves it out of its pre-roll (and of what Voice Match hears)
 * and out of how busy the room was before the wake phrase (busyRoom): with it in, "Hey Ember" said within 3 s of
 * Ember's answer found the room busy, and a request said softer than the wake phrase after a pause was dropped; said
 * within 1.6 s, Ember's own last words were sent as the request. (A cut-in, while Ember speaks, keeps both as before.)
 */
const SELF_LAG_MS = 96;
/**
 * A conversation (owner decision of 2026-11-05: "a voice agent needs to be continuously listening"): after a wake's request
 * the microphone stays open for the next thing said, with no name, no count of turns and no loudness test, also while
 * Ember speaks and while its tasks work (main says so: conversationBusy). It ends after this long with nothing said,
 * nothing spoken and nothing at work, when the user says so (endsConversation), or on a stop.
 */
export const CONVERSATION_IDLE_MS = 30_000;
/**
 * Talking over Ember: what the VAD hears while Ember speaks is transcribed once it has gone on this long (frames: the
 * VAD's own 0.2 s, and a word of what follows; a shorter word is decided when its segment ends), and again this often,
 * on at most the last 3 s. Chromium's echo canceller leaves almost nothing of Ember (measured on a laptop's speakers at
 * 96 % and its microphone array: 1–2 dB under the room, no onset in 23 s of speech: scripts/voice/echo-check.mjs), but
 * a computer where it does worse must not interrupt itself: what was heard is compared with what Ember is saying
 * (spokenByEmber), and a segment that was Ember's raises the loudness the next one must beat (ECHO_MARGIN).
 */
const CUT_IN_FRAMES = 12;
const CUT_IN_EVERY_FRAMES = 8;
const CUT_IN_SECONDS = 3;
/** Speech over Ember must be this much louder (energy: 6 dB) than the loudest of Ember's own voice the microphone was found to hear. */
const ECHO_MARGIN = 4;
/** Each request heard lowers that loudness by this much, so one bad reading can't deafen Ember to the user for good. */
const ECHO_DECAY = 0.8;
/** The share of what was heard that must be Ember's own recent words for it to be its own voice. */
const OWN_WORDS_SHARE = 0.6;
/** Ember's latest words kept for that comparison. */
const OWN_WORDS_KEPT = 160;

/** Follow-ups in a row a wake's request may get (each needs the voice that woke Ember: see followUp). */
const MAX_FOLLOW_UPS = 3;
/** Speech the VAD heard for this long (frames: 0.5 s) before Ember said it speaks was there before Ember's voice (see selfSpeaking). */
const OVER_REQUEST_FRAMES = 16;
/** Without the speakers' stream and with no word from the page, Ember's voice is taken to end this long after a cut-in (ms). */
const BARGE_IN_VOICE_MS = 1500;
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
/**
 * The speaker's own softer words ("…make the text a bit…") can stay 12–15 dB under their loudest for 0.6 s, as quiet as
 * others' talk, but with gaps of the room's own noise between their syllables (2–5 frames: shorter than a pause): such a
 * gap, before any pause, starts the count over (measured in a -45 dBFS room: a request ended 5.9 s in, mid-sentence; it
 * now goes on to the cap). Others' talk with a dip of a frame still ends a request as before.
 */
const GAP_FRAMES = 2;
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
/**
 * Listen once's deadline is for speech to start by: a request still being spoken then goes on to its end (it was thrown
 * away at the deadline, and Home said "No request heard": voice-listening-1), within the caps above, and never past this
 * long from the press (ms), where it is sent as heard so far, `cut`. VoiceService's own wait is set above it.
 */
export const MANUAL_MAX_MS = 20_000;
/**
 * …and only for speech that stands out from the room: its loudest 0.3 s (LOUD_FRAMES) this much (energy: 10 dB) over the
 * room as it was before that speech began, or over the room's own noise. Without it, a TV or a colleague talking on
 * when nothing was said kept "Listening…" up for 20 s, and their words went as the request (3 of 3 cases on the real
 * models, where the window had ended at 8 s with "No request heard": voice-listening-c1-1). The user's own request,
 * said up close over that talk, still goes on to its end.
 * The room before the speech is the window's frames before it that the VAD heard no speech in (MANUAL_VAD_LAG frames
 * before each of its onsets are the speech's own: Silero says so 7–9 frames into speech, 9–13 at a stream's start).
 * Talk already under way as the window opened (fewer than MANUAL_OPEN_FRAMES such frames) is measured against the
 * window's first second (MANUAL_ROOM_FRAMES), as the room's talk: a TV on at the press still ends it at 8 s. Measured
 * against the first second whoever spoke in it, a request begun within 0.9 s of the press was measured against
 * itself and thrown away at 8 s (3 of 3 on the real models: voice-listening-r2-1).
 */
const MANUAL_OVER_ROOM = 10;
const MANUAL_ROOM_FRAMES = 31;
const MANUAL_VAD_LAG = 9;
const MANUAL_OPEN_FRAMES = 3;
/**
 * Speech begun in the window's first second that stands out only from the moment before it can't be told by its
 * loudness from talk that was going on as the window opened and paused just then (a TV between two lines at the press
 * went on to 20 s and sent its words in 25 of 118 presses on the real models). It goes on past the deadline to this long
 * from the press (ms) at most: a request begun then is heard if it ends by then (a 9.7 s one begun at 0.8 s ends at
 * 11.1 s), and talk still under way then, or at the engine's 10 s cap (SPEECH_CAP_FRAMES), was the room's: nothing of it
 * is sent.
 */
const MANUAL_DOUBT_MS = 12_000;
/** The frames Listen once keeps the loudness of (its 20 s, MANUAL_MAX_MS, and a little more). */
const MANUAL_FRAMES = 640;
/**
 * The VAD hears speech about 0.25 s after it starts: sound that stands out so in the last 8 frames before the deadline
 * puts it back once, by this long (ms), for the VAD to say (speech begun at 7.9 s was "No request heard").
 */
const MANUAL_ONSET_FRAMES = 8;
const MANUAL_ONSET_MS = 400;
/** A request reaching the cap was cut when the speaker's voice was heard in its last second. */
const STILL_TALKING_FRAMES = 32;
const BREATH_FRAMES = 3;
const BREATH_WINDOW_FRAMES = 156;
const MAX_TRANSCRIBE = 21 * SAMPLE_RATE;
/**
 * At a quiet pause of this many frames (0.35 s) in a request, what was said so far is transcribed ahead of the VAD,
 * which ends the request only after 0.6 s of silence (and Silero's own lag: about 0.72 s after the voice). If the VAD
 * then ends it with no sound since, that transcript is the request's: it is sent at once, without waiting for
 * Moonshine (0.13 s in WebAssembly, scripts/perf/latency.mjs). When a request ends is unchanged (a request that goes
 * on after the pause throws the transcript away). The audio is the speech so far, whole, as the VAD's segment of it is
 * (with a little more of the quiet before it): on 18 synthesized requests the words came out as right as the VAD's
 * (scripts/perf/latency.mjs; the voice tests). Only in a quiet pause (the room's own noise, see SILENCE_RATIO), once
 * per pause, and never for a bare name not shown yet, a cut-in over Ember's voice, a wake still being checked or a
 * room where others talk (each is decided on the VAD's own segment, as before). It costs one more transcription for
 * each pause of 0.35 s to 0.6 s a request has in it.
 */
const SPECULATE_FRAMES = 11;
/**
 * Only a request of up to 6 s so far is transcribed ahead: Moonshine's time grows with it (about 0.13 s for a 2 s
 * request in WebAssembly), and it runs in the frame's own time, before the frames after it (a stop phrase's too).
 */
const AHEAD_MAX = 6 * SAMPLE_RATE;
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
 * "listening" event) until the whole of what was said, once the speaker paused, starts with the name (handleSegment);
 * `overFollowUp`: a wake said in a follow-up window (wakeOverFollowUp). A window of `reason` "conversation" never closes
 * on a request: `until` moves on with everything said, spoken or at work (see CONVERSATION_IDLE_MS).
 */
type Mode =
  | { kind: "idle" }
  | { kind: "listening"; until: number; ms: number; heardSpeech: boolean; first: boolean; reason: ListeningWindow; checkAt: number | null; keyword: string; afterQuestion?: boolean; bargeIn?: boolean; held?: boolean; announced?: boolean; overFollowUp?: boolean; maybeAmber?: boolean };

/**
 * A spotted stop (or "Hey Ember" while Ember speaks) being checked: see VoiceEngine.pendingStop. `teaching`: the name
 * spotted while Voice Match is taught (stopsOnly), a stop only if "stop" was said with it.
 */
type PendingStop = { keyword: string; at: number; checkAt: number | null; spoke?: boolean; again?: boolean; checked?: boolean; bargeIn?: boolean; teaching?: boolean };

export class VoiceEngine {
  private mode: Mode = { kind: "idle" };
  private manualFrom = 0;
  private manualReady = false;
  /**
   * Listen once: the frame energies heard since it opened, which of them held speech (the VAD's, and its lag before it:
   * MANUAL_VAD_LAG), where the speech under way began, and whether its deadline was put back for speech just begun
   * (MANUAL_ONSET_MS).
   */
  private manualLevels: number[] = [];
  private manualTalk: boolean[] = [];
  private manualSpeechAt = 0;
  private manualOnset = false;
  /** The speech under way at the deadline began in the window's first second, and may be the room's talk (MANUAL_DOUBT_MS). */
  private manualDoubt = false;
  /** What Ember's windows announce as Listen once opens, while a screen reader runs (withoutAnnounced). */
  private manualAnnounced: readonly string[] = [];
  /** What was heard for the request just emitted ("utterance"), for Voice Match; it never goes to main. */
  requestAudio: Float32Array | null = null;
  /** That audio starts with the wake phrase (heard with it in one breath): Voice Match vouches only for what follows it. */
  requestWithWake = false;
  /** The pre-roll the last wake started from: what its request was heard with (Ember's own voice left out, SELF_LAG_MS). */
  wakeAudio: Float32Array | null = null;
  private ring: Ring;
  /**
   * How many of the pre-roll's newest frames came after Ember's own voice (SELF_LAG_MS). Not reset by ring.clear(): it
   * counts frames since that voice, and keepLast keeps at most what the ring holds.
   */
  private ringOwn = 0;
  /**
   * A cut-in without the speakers' stream waits for the page to say Ember stopped speaking (bargeIn), only if the page
   * last said it was speaking: in the tail after it said it stopped, main's hush changes nothing and no word comes.
   */
  private hushAwaited = false;
  /** What the page last said: Ember speaking (selfSpeaking). */
  private pageSpeaking = false;
  /** The wake phrase's loudness, when the request after it is measured on its own (a follow-up must still come near it). */
  private wakePeak = 0;
  private recent = new Ring(RECENT_SECONDS);
  private selfSpeakingUntil = 0;
  /** Until when the microphone hears Ember's own voice (SELF_LAG_MS). */
  private selfVoiceUntil = 0;
  /** When Ember said it had stopped speaking (the tail after it is under way), and the frames heard around then. */
  private tailFrom = 0;
  private tail: { frame: Float32Array; energy: number; at: number }[] = [];
  private monitorHits: { keyword: string; at: number }[] = [];
  /**
   * A spotted wake word waiting out the speakers check; a spotted stop waiting out it and its transcript check
   * (`keyword` "hey_ember": said while Ember spoke; `checked`: the speakers didn't say it, and what was said with it was
   * heard; `bargeIn`: it was "Hey Ember", so Ember was hushed to listen).
   */
  private pendingWake: { keyword: string; at: number; paused: boolean; overFollowUp?: boolean } | null = null;
  private pendingStop: PendingStop | null = null;
  /** The speakers' recent frames, when they last made a sound and last sent a frame, and whether their spotter runs. */
  private speakers: { frame: Float32Array; at: number; sound: boolean; energy: number }[] = [];
  private monitorSoundAt = Number.NEGATIVE_INFINITY;
  private monitorFrameAt = Number.NEGATIVE_INFINITY;
  private monitorSpotting = false;
  /** The microphone's recent frame energies (as long as the speakers' ring), and how much later it hears the speakers (ms, measured as Ember speaks). */
  private micLevels: number[] = [];
  /** Which of those frames held Ember's own voice (SELF_LAG_MS). */
  private micSelf: boolean[] = [];
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
  /**
   * The request so far, transcribed at its pause (transcribeAhead), and where the VAD was then (`at`, its fed()): null
   * once sound comes back.
   */
  private ahead: { text: string; at: number } | null = null;
  /** A segment the VAD ended after that pause, and the transcript made ahead for it (handleSegment's first look). */
  private early: { audio: Float32Array; text: string } | null = null;
  private silentAt = -1;
  /** After cutting in: frames of the speaker's own voice in the segment under way since Ember's voice stopped reaching the microphone. */
  private afterHush = 0;
  /** The loudness of the last wake's request (a follow-up must come near it), and how many follow-ups in a row were sent since (MAX_FOLLOW_UPS). */
  private voice = 0;
  /** The room had sound before the last wake (others talking, a TV; not silence or a steady fan). */
  private busyRoom = false;
  private followUps = 0;
  /** A wake's request opens a conversation (settings' voice.conversation). */
  private conversing = false;
  /** The computer's output is playing something other than Ember (main says so: otherSound). */
  private outputPlaying = false;
  /** A reply is on its way or a task is at work: the conversation stays open (main says so). */
  private busy = false;
  /** Ember's latest words, to tell its own voice from the user's (spokenByEmber). */
  private said: string[] = [];
  /** The speech under way was heard while Ember spoke; it has been taken for the user cutting in; where it was last checked. */
  private overEmber = false;
  /** Said with other sound playing and not by name: it counts only if it sounds like the owner (match.ts). */
  private overSound = false;
  private cutIn = false;
  private cutInCheckedAt = 0;
  /** Ember's voice is ducked for the speech under way. */
  private ducked = false;
  /** The loudest of Ember's own voice the microphone was found to hear (energy; 0: none). */
  private echo = 0;
  /** When the spotter last heard the name: a word or two heard then, in a conversation, is the name as the recognizer wrote it. */
  private spottedAt = Number.NEGATIVE_INFINITY;
  /** The bare name came first in what was said: little sound before the spotter fired (see NAME_FIRST_FRAMES). */
  private nameFirst = false;
  /** Frames the keyword spotter actually decoded (for CPU accounting and tests). */
  spotted = 0;
  private now: () => number;

  constructor(private backend: VoiceBackend, private emit: (e: VoiceEvent) => void, private o: EngineOptions = {}) {
    this.ring = new Ring(o.preRoll ?? 1.6);
    this.now = o.now ?? Date.now;
    this.conversing = !!o.conversation;
  }

  /** Conversations turned on or off (settings' voice.conversation); off ends one under way. */
  conversation(on: boolean): void {
    this.conversing = on;
    if (!on && this.inConversation) this.endListening("timeout");
  }

  /** A reply is on its way or a task is at work (on), or nothing is any more: the conversation's idle time starts then. */
  conversationBusy(on: boolean): void {
    if (this.busy === on) return;
    this.busy = on;
    if (!on && this.mode.kind === "listening" && this.mode.reason === "conversation") this.mode.until = Math.max(this.mode.until, this.now() + this.mode.ms);
  }

  /** The computer is playing other sound (Windows: the output's level), or no longer: see soundPlaying. */
  otherSound(on: boolean): void {
    this.outputPlaying = on;
  }

  /**
   * Other sound is playing: a song's or a video's words reach the microphone, and the echo canceller knows only Ember's
   * own voice. In a conversation Ember then hears only what is said to it by name, and isn't interrupted by the rest.
   * The speakers' own stream says so too where there is one (Linux with parec), once Ember's voice has left it.
   */
  private soundPlaying(now: number): boolean {
    return this.outputPlaying || (this.hearsSpeakers(now) && now >= this.selfSpeakingUntil + OTHER_SOUND_MS && now - this.monitorSoundAt < OTHER_SOUND_MS);
  }

  /** Words Ember is about to say (spokenByEmber tells them from the user's). */
  selfWords(text: string): void {
    this.said = [...this.said, ...wordsOf(text)].slice(-OWN_WORDS_KEPT);
  }

  private get inConversation(): boolean {
    return this.mode.kind === "listening" && this.mode.reason === "conversation";
  }

  /** The microphone stays open for what is said next (see CONVERSATION_IDLE_MS). */
  private openConversation(): void {
    this.resetListening();
    this.peak = 0;
    this.tail = [];
    this.tailFrom = 0;
    this.mode = { kind: "listening", until: this.now() + CONVERSATION_IDLE_MS, ms: CONVERSATION_IDLE_MS, heardSpeech: false, first: false, reason: "conversation", checkAt: null, keyword: "" };
    this.emit({ type: "listening", on: true, reason: "conversation", window: "conversation" });
  }

  /**
   * Speech heard while Ember speaks, in a conversation: is the user talking over it? Decided on what the recognizer makes
   * of it so far: Ember's own words (a computer whose echo canceller left them in) and a "yeah" or "mm-hmm" leave Ember
   * speaking; anything else stops it, and the rest of what they say is the next request.
   */
  private checkCutIn(now: number): void {
    const n = this.segment.length, so = this.backend.speechSoFar;
    if (this.cutIn || !so || n < CUT_IN_FRAMES || n - this.cutInCheckedAt < CUT_IN_EVERY_FRAMES || this.soundPlaying(now)) return;
    this.cutInCheckedAt = n;
    if (this.peak < this.echo * ECHO_MARGIN) return;
    const speech = so.call(this.backend);
    if (!speech) return;
    const heard = this.backend.transcribe(speech.subarray(Math.max(0, speech.length - CUT_IN_SECONDS * SAMPLE_RATE)));
    if (!saysSomething(stripWake(heard, true)) || BACKCHANNEL.test(heard)) return;
    if (spokenByEmber(heard, this.said)) { this.echo = Math.max(this.echo, this.peak); return; }
    this.cutInNow(now);
  }

  /** The user is talking over Ember: its voice counts as over from now. Main hushes it on this event. */
  private cutInNow(now: number): void {
    this.cutIn = true;
    this.ducked = false;
    this.selfSpeakingUntil = Math.min(this.selfSpeakingUntil, now);
    this.selfVoiceUntil = Math.min(this.selfVoiceUntil, now + SELF_LAG_MS);
    this.emit({ type: "cut-in" });
  }

  get listening(): boolean {
    return this.mode.kind === "listening";
  }

  /**
   * Voice Match is being taught (process.ts): its phrases sound like requests ("Hey Ember, open my calendar."), so no
   * wake, follow-up or request is taken, but "Ember, stop" still is, checked as ever (voice-listening-v1: it went unheard
   * for as long as teaching lasted). The real spotter takes the bare name first in "Ember, stop", and "Hey Ember" in "Hey
   * Ember, stop", so the name is a stop too where the recognizer heard "stop" said with it, as while Ember speaks (only
   * "ember_stop" counted, and it stopped 0 times in 24 on the real models: voice-listening-r1). The VAD is the
   * enrolment's meanwhile: nothing here feeds it.
   */
  private onlyStops = false;
  /**
   * A request that trailed off, waiting until `until` for the rest of it (trailsOff); `t0`: when it was heard; `level`:
   * its loudness (soundLevel: with the wake phrase, when it was said in the same breath), which the rest must come near.
   */
  private held: { text: string; audio: Float32Array; withWake: boolean; until: number; t0: number; level: number } | null = null;
  stopsOnly(on: boolean): void {
    this.onlyStops = on;
    this.pendingWake = null;
    this.ring.clear();
  }

  /** One of Ember's questions is up (main says so): a short "no" in a follow-up window is an answer, not a closer. */
  private questionWaiting = false;
  questionUp(on: boolean): void {
    this.questionWaiting = on;
  }

  /**
   * Ember is speaking (TTS): a wake word only counts as "Hey Ember, stop", and what a listening window hears is
   * ignored, until it stops (plus a short tail). Capped, so a lost "stopped" can't deafen Ember for good. A
   * "stopped" while silent changes nothing; one after speech measures the microphone's lag behind the speakers.
   */
  selfSpeaking(on: boolean, tailMs = 400): void {
    const now = this.now();
    this.hushAwaited = false;
    this.pageSpeaking = on;
    if (!on) {
      if (this.selfSpeakingUntil > now) { this.tailFrom = now; this.micLag = this.measureLag() ?? this.micLag; }
      this.selfSpeakingUntil = Math.min(this.selfSpeakingUntil, now + tailMs);
      this.selfVoiceUntil = Math.min(this.selfVoiceUntil, now + SELF_LAG_MS);
      return;
    }
    this.selfSpeakingUntil = now + SELF_SPEAKING_MAX_MS;
    this.selfVoiceUntil = now + SELF_SPEAKING_MAX_MS;
    this.tailFrom = 0;
    this.tail = [];
    if (this.mode.kind !== "listening") return;
    // A conversation hears on through Ember's voice (checkCutIn).
    if (this.mode.reason === "conversation") return;
    // A request already under way for half a second (OVER_REQUEST_FRAMES) when Ember began to speak (a reminder, the next
    // sentence of an answer after a gap in it) is the user's: it is kept, and goes on once Ember is done (what is heard
    // meanwhile isn't fed to the VAD). It was thrown away, and the user had to say it again.
    // (Only without the speakers' stream: with it, Ember's voice is told apart as before.)
    if (!this.hearsSpeakers(now) && this.wasSpeaking && this.segment.length >= OVER_REQUEST_FRAMES && this.mode.announced !== false) return;
    // Otherwise what the VAD heard so far is Ember's voice (its first sound can come before it says it speaks), or was
    // cut by it: start afresh once Ember is done.
    this.resetListening();
    // (A bare name's window not shown yet never said speech began: it says nothing of its end either.)
    if (this.wasSpeaking) { this.wasSpeaking = false; if (this.mode.announced !== false) this.emit({ type: "speech", on: false }); }
  }

  /**
   * Listen for a follow-up without the wake word (the window starts once Ember has finished speaking). After a wake's
   * request, and after up to MAX_FOLLOW_UPS follow-ups' (it was one: a third request without "Hey Ember" was never
   * heard, and people took Ember for deaf); never for good, or the room's talk could keep a conversation going without
   * anyone saying "Hey Ember". It hears a voice about as loud as the one that woke Ember (within 6 dB).
   * `afterQuestion`: Ember's answer asked something, so "Okay." or "Fine." is a reply to send, not a closer.
   */
  followUp(ms = 8000, o: { afterQuestion?: boolean } = {}): void {
    if (this.onlyStops || (this.mode.kind === "listening" && this.mode.reason === "manual")) return;
    // A conversation is listening already: it only learns whether the answer asked something.
    if (this.mode.kind === "listening" && this.mode.reason === "conversation") {
      this.mode.afterQuestion = !!o.afterQuestion;
      this.mode.until = Math.max(this.mode.until, this.now() + this.mode.ms);
      return;
    }
    if (this.followUps >= MAX_FOLLOW_UPS) return;
    if (this.mode.kind === "listening" && this.mode.announced === false) {
      // A bare name's window not shown yet ("…remember…" may yet be taken back): it becomes the follow-up window, which
      // needs no name, rather than be extended and then dropped with the follow-up in it. What it heard so far stays.
      const m = this.mode;
      this.mode = { kind: "listening", until: Math.max(m.until, this.now() + ms), ms, heardSpeech: m.heardSpeech, first: false, reason: "follow-up", checkAt: null, keyword: "", afterQuestion: !!o.afterQuestion };
      this.emit({ type: "listening", on: true, reason: "follow-up", window: "follow-up" });
      if (this.wasSpeaking) this.emit({ type: "speech", on: true });
      return;
    }
    if (this.mode.kind === "listening") { this.mode.until = Math.max(this.mode.until, this.now() + ms); return; }
    this.resetListening();
    // End this request against its own loudness: a follow-up 3 dB softer than the wake was cut at "And make the text"
    // before "a bit bigger". Admission still uses the original wake's unchanged `voice` in mustBeClose/loudFrames;
    // quieter room talk cannot start a request or lower that reference over successive follow-ups.
    this.peak = 0;
    this.mode = { kind: "listening", until: this.now() + ms, ms, heardSpeech: false, first: false, reason: "follow-up", checkAt: null, keyword: "", afterQuestion: !!o.afterQuestion };
    // Opened during the tail after Ember's answer: what was heard since its voice ended (before it said so) may be a reply.
    if (this.tailFrom) this.tail = this.recentFrames(TAIL_KEEP_FRAMES);
    this.emit({ type: "listening", on: true, reason: "follow-up", window: "follow-up" });
  }

  /**
   * A fresh request after an explicit keyboard or mouse action. No pre-roll or inherited loudness. `announced`: what
   * Ember's windows say as it opens, while a screen reader runs (it says them through the speakers: withoutAnnounced).
   */
  listenOnce(from: number, ms: number, announced: readonly string[] = []): void {
    this.manualFrom = from;
    this.manualAnnounced = announced;
    this.manualReady = false;
    this.manualLevels = [];
    this.manualTalk = [];
    this.manualSpeechAt = 0;
    this.manualOnset = false;
    this.manualDoubt = false;
    this.peak = 0;
    this.wakePeak = 0;
    this.busyRoom = false;
    this.wasSpeaking = false;
    this.tail = [];
    this.tailFrom = 0;
    this.mode = { kind: "listening", until: from + ms, ms, heardSpeech: false, first: false, reason: "manual", checkAt: null, keyword: "" };
  }

  /**
   * At Listen once's deadline, does it wait on? Only for speech that stands out from the room as it was before that
   * speech began (MANUAL_OVER_ROOM): under way (the VAD hears it), or just begun (MANUAL_ONSET_FRAMES), once.
   */
  private manualGoesOn(now: number): boolean {
    const silence = Math.max(this.o.silenceRms ?? 0.0008, this.floor * SILENCE_RATIO) ** 2;
    const speaking = this.backend.speaking();
    const over = Math.max(this.roomBefore(speaking ? this.manualSpeechAt : this.manualLevels.length - MANUAL_ONSET_FRAMES), this.floor ** 2) * MANUAL_OVER_ROOM;
    if (speaking) {
      const loud = loudest(this.segment);
      if (loud < over) return false;
      // Begun in the first second: it goes on only to MANUAL_DOUBT_MS, unless it stands out from all that second held
      // (the user's own request said over talk that was going on as it opened).
      this.manualDoubt = this.manualSpeechAt < MANUAL_ROOM_FRAMES && loud < Math.max(loudest(this.manualLevels.slice(0, MANUAL_ROOM_FRAMES)), this.floor ** 2) * MANUAL_OVER_ROOM;
      return true;
    }
    this.manualDoubt = false;
    if (this.manualOnset || !this.micLevels.slice(-MANUAL_ONSET_FRAMES).some(e => e >= over && e >= silence)) return false;
    this.manualOnset = true;
    if (this.mode.kind === "listening") this.mode.until = now + MANUAL_ONSET_MS;
    return true;
  }

  /**
   * Listen once: the room's loudness (its loudest 0.3 s) in the window's frames before frame `at` that held no speech,
   * or, with too few of them (talk already under way as the window opened), in its first second (MANUAL_OPEN_FRAMES).
   */
  private roomBefore(at: number): number {
    const room: number[] = [];
    for (let i = 0; i < Math.min(at, this.manualLevels.length); i++) if (!this.manualTalk[i]) room.push(this.manualLevels[i]);
    return loudest(room.length >= MANUAL_OPEN_FRAMES ? room : this.manualLevels.slice(0, MANUAL_ROOM_FRAMES));
  }

  /** Listen once heard no request of the user's: nothing more is sent, but a request held for the rest of it goes as it was. */
  private endManual(): void {
    if (this.held) this.sendHeld();
    else this.endListening("timeout");
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
  feed(frame: Float32Array, capturedAt?: number): void {
    const now = this.now();
    // The rest of a request that trailed off didn't come: it goes as it was.
    if (this.held && now >= this.held.until && !this.backend.speaking()) this.sendHeld();
    if (this.mode.kind === "listening" && this.mode.reason === "manual") {
      if (now >= this.manualFrom + MANUAL_MAX_MS) {
        for (const seg of this.backend.flushVad()) this.handleSegment(this.trim(seg), true);
        if (this.held) this.sendHeld();
        if (this.mode.kind === "listening") this.endListening("timeout");
        return;
      }
      // No speech of the user's under way at the deadline: nothing more is waited for. Speech under way goes on (the end of
      // feed()). A request that trailed off and is held for the rest (TRAIL_HOLD_MS) goes as it was: what is said now isn't
      // the user's (it was thrown away with the window: voice-listening-3).
      if (now >= this.mode.until && !this.manualGoesOn(now)) { this.endManual(); return; }
      else if (this.manualDoubt && now >= this.manualFrom + MANUAL_DOUBT_MS) { this.endManual(); return; }
      else if (capturedAt === undefined || capturedAt <= Math.max(this.manualFrom, this.selfSpeakingUntil)) return;
      else if (!this.manualReady) {
        this.manualReady = true;
        this.emit({ type: "listening", on: true, reason: "manual", window: "manual" });
      }
    }
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const energy = sum / Math.max(1, frame.length);
    const rms = Math.sqrt(energy);
    this.frames++;
    this.fedAt = now;
    this.recent.push(frame);
    // Ember's own voice, as the microphone hears it, only matters where the speakers' stream can't say so (SELF_LAG_MS):
    // on Linux with it, the pre-roll and the room are as before.
    const own = now < this.selfVoiceUntil && !this.hearsSpeakers(now);
    this.micLevels.push(energy);
    this.micSelf.push(own);
    if (this.micLevels.length > SPEAKERS_RING_FRAMES) { this.micLevels.shift(); this.micSelf.shift(); }
    // (Ember's own voice, should it speak in the window, isn't the room's: see roomBefore.)
    if (this.mode.kind === "listening" && this.mode.reason === "manual" && this.manualLevels.length < MANUAL_FRAMES) { this.manualLevels.push(energy); this.manualTalk.push(now < this.selfSpeakingUntil); }

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
      if (this.onlyStops && keyword !== "ember_stop") {
        // While Voice Match is taught, the name (said first in "Ember, stop" and "Hey Ember, stop") is checked once "stop"
        // can have been said (see decideStop); the teaching's own phrases are nothing here.
        if (!this.pendingStop) { this.pendingStop = { keyword, at: now, checkAt: now + SELF_STOP_MAX_MS, teaching: true }; this.watchSpeakers(); }
        continue;
      }
      if (keyword !== "ember_stop" && this.inConversation) this.spottedAt = now;
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
      // "Hey Ember" in a follow-up window is a wake (wakeOverFollowUp). The bare name isn't: a follow-up needs no name,
      // and the name is spotted inside "remember".
      else if (this.mode.kind === "listening" && this.mode.reason === "follow-up" && keyword !== BARE_NAME && !this.pendingWake) { this.pendingWake = { keyword, at: now, paused, overFollowUp: true }; this.watchSpeakers(); }
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
        if (w.overFollowUp && this.mode.kind === "listening") {
          // (A follow-up window that ended meanwhile leaves an ordinary wake, below.)
          if (this.mode.reason === "follow-up") this.wakeOverFollowUp(w.keyword);
        } else {
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
    }
    if (this.monitorSpotting && !this.pendingWake && !this.pendingStop) {
      this.monitorSpotting = false;
      this.backend.resetMonitor?.();
    }
    if (this.onlyStops) return;

    if (this.mode.kind === "idle") {
      this.ring.push(frame);
      this.ringOwn = own ? 0 : this.ringOwn + 1;
      return;
    }
    if (this.mode.checkAt !== null) {
      // What's heard is held (with the pre-roll) until the wake is checked, then replayed.
      this.ring.push(frame);
      this.ringOwn = own ? 0 : this.ringOwn + 1;
      if (now < this.mode.checkAt) return;
      this.mode.checkAt = null;
      const heard = this.backend.transcribe(this.ring.read(), "keyword");
      if (heard && heardOtherWord(heard) && isStop(stripWake(heard, true))) {
        // "Hey, Amber, stop.": whoever it was for, stopping is the safe side (and it's often "Ember" misheard).
        this.emit({ type: "stop" });
        this.ring.clear();
        this.endListening("stop");
      } else if (heard && GREETED_AMBER.test(heard) && !NAME_ALONE.test(heard) && !CALLED_AS_WORD.test(heard)) {
        this.mode.maybeAmber = true;
        this.replayPreRoll();
      } else if (heard && heardOtherWord(heard) && !NAME_ALONE.test(heard) && !CALLED_AS_WORD.test(heard)) {
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
      if (this.mode.reason === "manual") return;
      this.mode.until = Math.max(this.mode.until, now + this.mode.ms);
      if (this.mode.reason === "conversation") {
        this.listen(frame, energy);
        if (this.inConversation && this.backend.speaking()) {
          this.overEmber = true;
          // The moment anything is heard over Ember, and only then is it known what.
          if (!this.ducked && !this.cutIn && !this.soundPlaying(now) && this.peak >= this.echo * ECHO_MARGIN) { this.ducked = true; this.emit({ type: "duck", on: true }); }
          this.checkCutIn(now);
        }
        return;
      }
      this.tail.push({ frame, energy, at: now });
      if (this.tail.length > TAIL_KEEP_FRAMES) this.tail.shift();
      return;
    }
    if (this.tailFrom && this.mode.reason !== "conversation" && !this.afterTail(frame, energy, now)) return;
    this.listen(frame, energy);
    // A conversation lasts while the user speaks and while Ember has something at work.
    if (this.mode.kind === "listening" && this.mode.reason === "conversation" && (this.busy || this.backend.speaking())) this.mode.until = Math.max(this.mode.until, now + this.mode.ms);
    if (this.mode.kind === "listening" && now > this.mode.until && (!this.backend.speaking() || !this.segmentStandsOut())) {
      // Time's up, and nobody (or only the room's other talk) is speaking.
      for (const seg of this.backend.flushVad()) this.handleSegment(this.trim(seg));
      // (A request in that last speech starts a conversation's time over.)
      if (this.mode.kind === "listening" && now > this.mode.until) this.endListening("timeout");
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
    if (s.keyword !== "ember_stop" && !s.teaching && !s.checked && !this.inConversation && now < this.selfSpeakingUntil && this.speakersClear(s.at, now) && (this.hearsSpeakers(now) || s.keyword !== BARE_NAME)) {
      // "Hey Ember" while Ember speaks, and its speakers' own stream didn't say it: the user is cutting in (see bargeIn).
      // Without that stream (Windows, macOS, Linux without parec) "Hey Ember" cuts in too: Ember never says it there
      // (VoiceService.speak drops its own wake and stop phrases, withoutOwnPhrases), the check below takes back "they
      // remember…" (heardOtherWord), and words heard then never count towards a dangerous command (spokenWords). Before,
      // only "Hey Ember, stop" counted, and a request said while Ember read its answer out was thrown away. The bare name
      // doesn't: Ember's own words have it ("remember", "I'm Ember").
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
      // The name while Voice Match is taught: a stop if "stop" came with it ("Ember stopped the task." too, as the
      // recognizer writes it), otherwise one of the teaching's phrases.
      const heard = this.backend.transcribe(this.fromSound(this.recentAudio(this.fedAt - s.at + SELF_STOP_BEFORE_MS)), "keyword");
      if (!saidWakeStop(heard) && !(s.teaching && EMBER_STOP.test(heard.toLowerCase()))) {
        if (!s.bargeIn && !s.teaching) this.emit({ type: "rejected", keyword: s.keyword, reason: "self", heard });
        return;
      }
    } else if (s.checkAt !== null) {
      const heard = this.backend.transcribe(this.fromSound(this.recentAudio(s.again ? this.fedAt - s.at + SELF_STOP_BEFORE_MS : STOP_CHECK_SECONDS * 1000)), "keyword");
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
    const heard = pre.length >= MIN_TRANSCRIBE_SAMPLES ? this.backend.transcribe(pre, "keyword") : "";
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
    // Without the speakers' stream, only where the check heard the greeting and the name ("…in the evening. Hey, Ember"):
    // the spotter also fires on Ember's own words now and then, and Ember never says that phrase itself.
    if (!this.hearsSpeakers(now) && !CUT_IN_WAKE.test(heard)) return false;
    s.bargeIn = true;
    this.selfSpeakingUntil = now;
    if (!this.hearsSpeakers(now)) {
      // Ember's voice goes on until the page says it stopped (main hushes it on the wake): nothing is sent till then
      // (hushAwaited, set below). If that never comes, frames after BARGE_IN_VOICE_MS aren't taken for Ember's own any
      // more, or a later wake's pre-roll would be empty and Voice Match would lose its first look.
      this.selfVoiceUntil = Math.min(this.selfVoiceUntil, now + BARGE_IN_VOICE_MS);
    }
    this.tailFrom = 0;
    this.tail = [];
    // (The bare name shows at once here: the name was heard, and main must hush Ember on the wake.)
    this.announceWake(s.keyword, null, true);
    // In the tail after the page said Ember stopped, no word comes: waiting for one held every request (review of #144).
    if (!this.hearsSpeakers(now)) this.hushAwaited = this.pageSpeaking;
    if (this.mode.kind === "listening") this.mode.bargeIn = true;
    this.replayPreRoll();
    return false;
  }

  private announceWake(keyword: string, checkAt: number | null, show = false): void {
    // The bare name shows once what was said with it starts with the name (see Mode.announced), unless nothing checks it.
    const quiet = keyword === BARE_NAME && this.o.verifyWake !== false && !show;
    this.nameFirst = quiet && this.soundFrames() <= NAME_FIRST_FRAMES;
    // Ember's own voice, just before a wake that follows its answer, is neither the request nor the room (SELF_LAG_MS).
    // A cut-in (`show`) hears the wake phrase over that voice: its pre-roll and the room are as they were.
    if (!show) this.ring.keepLast(this.ringOwn * 512);
    this.hushAwaited = false;
    this.wakeAudio = this.ring.read();
    if (!quiet) this.emit({ type: "wake", keyword });
    this.resetListening();
    this.peak = 0;
    this.wakePeak = 0;
    // (A cut-in counts Ember's voice as the room's only where its speakers' stream says when it went quiet: without it, nothing heard
    // before Ember said it stopped is sent anyway, see AFTER_HUSH_FRAMES.)
    this.busyRoom = this.roomWasBusy(show && this.hearsSpeakers(this.now()));
    const ms = this.o.waitForSpeechMs ?? 6000;
    this.mode = { kind: "listening", until: this.now() + ms, ms, heardSpeech: false, first: true, reason: "wake", checkAt, keyword, ...(quiet ? { announced: false } : {}) };
    if (!quiet) this.emit({ type: "listening", on: true, reason: "wake", window: "wake" });
  }

  /**
   * "Hey Ember" said in a follow-up window: the window becomes a wake's, as if it had been idle. A follow-up hears only
   * a voice as loud as the one that woke Ember (within 6 dB, see mustBeClose), so people who say "Hey Ember" again after
   * the answer (they don't know the window is open, and it shows only as the status line) had their request dropped
   * when they said it softer than the first one, and said "Hey Ember" again and again. What the VAD is hearing goes on
   * (the phrase and the request may be one breath), its loudness so far is the wake phrase's, and the room is judged
   * as at a wake. There is no transcript check before it shows (the pre-roll was heard already): handleSegment takes it
   * back where the recognizer heard another word ("Hey Amber") said softer than a follow-up must be.
   */
  private wakeOverFollowUp(keyword: string): void {
    if (this.mode.kind !== "listening") return;
    const m = this.mode;
    this.wakeAudio = null;
    this.emit({ type: "wake", keyword });
    let loudest = 0;
    for (let i = LOUD_FRAMES; i <= this.segment.length; i++) loudest = Math.max(loudest, median(this.segment, i - LOUD_FRAMES, i));
    this.peak = loudest;
    this.wakePeak = 0;
    this.busyRoom = this.roomWasBusy(false);
    const ms = this.o.waitForSpeechMs ?? 6000;
    this.mode = { kind: "listening", until: Math.max(m.until, this.now() + ms), ms, heardSpeech: m.heardSpeech, first: true, reason: "wake", checkAt: null, keyword, overFollowUp: true };
    this.emit({ type: "listening", on: true, reason: "wake", window: "wake" });
  }

  /** How many frames of the pre-roll have sound in them. */
  private soundFrames(): number {
    const pre = this.ring.read(), silence = Math.max(this.o.silenceRms ?? 0.0008, this.floor * SILENCE_RATIO);
    let n = 0;
    for (let i = 0; i + 512 <= pre.length; i += 512) if (rmsOf(pre.subarray(i, i + 512)) >= silence) n++;
    return n;
  }

  /**
   * Did the room have sound in the 1.5 s before the wake phrase (and what the pre-roll holds)? Others talking, a TV;
   * not Ember's own voice (SELF_LAG_MS), unless `withOwn` (a cut-in: the wake phrase was said over it).
   */
  private roomWasBusy(withOwn: boolean): boolean {
    const silence = Math.max(this.o.silenceRms ?? 0.0008, this.floor * SILENCE_RATIO) ** 2, from = this.micLevels.length - WAKE_PHRASE_FRAMES;
    const before = this.micLevels.filter((_, i) => i < from && (withOwn || !this.micSelf[i]));
    return before.length >= BUSY_FRAMES && before.filter(e => e >= silence).length >= before.length * BUSY_SHARE;
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
      // A bare name not shown yet says nothing: main shows "Listening…" on speech, and a window it never saw open sends
      // it no "listening off" ("I remember…" left "Listening…" up for good). It's told once the wake shows (handleSegment).
      if (this.mode.kind !== "listening" || this.mode.announced !== false) this.emit({ type: "speech", on: speaking });
      if (speaking && this.mode.kind === "listening") this.mode.heardSpeech = true;
      // Listen once: where this speech began (the VAD says so MANUAL_VAD_LAG frames into it), for roomBefore.
      if (speaking && this.mode.kind === "listening" && this.mode.reason === "manual") {
        this.manualSpeechAt = Math.max(0, this.manualLevels.length - 1 - MANUAL_VAD_LAG);
        this.manualTalk.fill(true, this.manualSpeechAt);
      }
    }
    if (speaking && this.mode.kind === "listening" && this.mode.reason === "manual" && this.manualTalk.length) this.manualTalk[this.manualTalk.length - 1] = true;
    if (speaking || segments.length) {
      this.segment.push(energy);
      if (this.segment.length > SEGMENT_FRAMES) this.segment.shift();
      const n = this.segment.length;
      if (speaking && n >= LOUD_FRAMES) this.peak = Math.max(this.peak, median(this.segment, n - LOUD_FRAMES, n));
      // The room's own noise: a pause, or the end, that the VAD's silence decides on (for 0.64 s at most since the voice).
      const silent = Math.sqrt(energy) < Math.max(this.o.silenceRms ?? 0.0008, this.floor * SILENCE_RATIO);
      // A gap between syllables: a moment of the room's own noise (shorter than a pause), and sound again.
      const gap = !silent && this.silentRun >= GAP_FRAMES && this.silentRun < SILENT_FRAMES;
      this.silentRun = silent ? this.silentRun + 1 : 0;
      if (!silent) this.ahead = null;
      if (this.silentRun >= BREATH_FRAMES) this.silentAt = n;
      this.hushRun = silent && this.hushed < PAUSE_HOLD_FRAMES ? this.hushRun + 1 : 0;
      // The count starts over when the speaker's voice is back, or at their softer words before any pause (and at a gap
      // between syllables then, see GAP_FRAMES); it holds in a pause, and at loud talk after one (see QUIET_RATIO).
      const near = median(this.segment, n - LOUDNESS_FRAMES, n) >= this.peak * QUIET_RATIO, voice = median(this.segment, n - BACK_FRAMES, n) >= this.peak * CLOSE_RATIO;
      if (voice) { this.quietFor = 0; this.pausedSinceVoice = false; this.hushed = 0; }
      else if ((near || gap) && !this.pausedSinceVoice) this.quietFor = 0;
      else if (!near && this.hushRun < SILENT_FRAMES) this.quietFor++;
      if (this.hushRun >= SILENT_FRAMES) { this.pauseAt = n; this.pausedSinceVoice = true; this.hushed++; }
      // After cutting in, the speaker's voice once Ember's no longer reaches the microphone (it starts over if Ember's does again).
      // Without the speakers' stream, Ember's voice reaches it until Ember says it has stopped (main hushes it on the wake), and SELF_LAG_MS on.
      const overEmber = this.fedAt - this.monitorFrameAt < 200 ? this.fedAt - this.monitorSoundAt <= this.micLag + OVER_EMBER_MS : this.hushAwaited || this.fedAt < this.selfVoiceUntil;
      if (this.mode.kind === "listening" && this.mode.bargeIn) this.afterHush = overEmber ? 0 : this.afterHush + (voice ? 1 : 0);
    }
    // The VAD ended the request in the quiet that followed a transcript made ahead: that transcript is its, if the VAD's
    // own speech ended by then (soft words it heard as speech after the pause, under the room's noise by the engine's
    // own test, are in its segment and not in that transcript: the segment is transcribed, review of PR #137).
    const ahead = segments.length === 1 ? this.ahead : null;
    if (segments.length) this.ahead = null;
    for (const seg of segments) {
      const clip = this.trim(seg, false);
      const end = ahead ? this.backend.speechEnd?.(seg) ?? null : null;
      this.early = ahead !== null && clip && end !== null && end <= ahead.at ? { audio: clip.audio, text: ahead.text } : null;
      try { this.handleSegment(clip, false, true); } finally { this.early = null; }
    }
    if (segments.length && !speaking) this.endSegment();
    if (this.mode.kind !== "listening" || !speaking) return;
    if (this.silentRun === SPECULATE_FRAMES) this.transcribeAhead();
    const n = this.segment.length;
    // At 10 s, a request goes on (to 20 s) while the speaker's own voice does, in a room quiet when they breathe.
    const goesOn = this.voiceIn(n - 2 * STILL_TALKING_FRAMES) && n - this.silentAt <= BREATH_WINDOW_FRAMES;
    const capped = n >= LONG_CAP_FRAMES || (n >= SPEECH_CAP_FRAMES && !goesOn);
    const over = this.quietFor >= QUIET_END_FRAMES && !this.hushRun && n - this.pauseAt > RETURN_FRAMES;
    if (over || capped) {
      // (Listen once's talk that may be the room's isn't sent at a cap: MANUAL_DOUBT_MS.)
      if (!over && this.mode.reason === "manual" && this.manualDoubt) { this.endManual(); return; }
      const cut = !over && this.voiceIn(n - STILL_TALKING_FRAMES);
      for (const seg of this.backend.flushVad()) this.handleSegment(this.trim(seg), cut);
      this.endSegment();
    }
  }

  /** At a quiet pause in a request (SPECULATE_FRAMES): what was said so far, transcribed for the VAD's end of it. */
  private transcribeAhead(): void {
    const m = this.mode;
    const b = this.backend;
    if (this.o.transcribeAhead === false || m.kind !== "listening" || m.bargeIn || this.overEmber || m.announced === false || m.checkAt !== null || this.busyRoom || !b.speechSoFar || !b.fed || !b.speechEnd) return;
    const so = b.speechSoFar();
    const clip = so ? this.trim(so, false) : null;
    // Only a short request (AHEAD_MAX): each pause would transcribe all of a long one again, in the frame's own time.
    if (!clip?.audio.length || clip.audio.length > AHEAD_MAX) return;
    const at = b.fed();
    const heard = this.transcribe(clip.audio);
    // Nothing heard in it, or right after a wake no wake phrase in it ("A. emperor." for "Hey Ember."): the VAD's segment
    // gets its own look (and its second try, see handleSegment).
    this.ahead = /[a-z0-9]/i.test(heard) && !(m.first && stripWake(heard, true).trim() === heard.trim()) ? { text: heard, at } : null;
  }

  /** Was the speaker's own voice (within 12 dB of the request's loudness) heard in the segment since frame `from`? */
  private voiceIn(from: number): boolean {
    const e = this.segment, half = LOUD_FRAMES >> 1;
    for (let i = Math.max(0, from); i < e.length; i++) if (median(e, i - half, i + half + 1) >= this.peak * QUIET_RATIO) return true;
    return false;
  }

  private endSegment(): void {
    this.segment = [];
    this.ahead = null;
    this.quietFor = 0;
    this.pauseAt = Number.NEGATIVE_INFINITY;
    this.pausedSinceVoice = false;
    this.hushRun = 0;
    this.hushed = 0;
    this.silentRun = 0;
    this.silentAt = -1;
    this.afterHush = 0;
    this.overEmber = false;
    this.overSound = false;
    this.cutIn = false;
    this.cutInCheckedAt = 0;
    if (this.ducked) { this.ducked = false; this.emit({ type: "duck", on: false }); }
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
    // (A conversation hears a softer voice too: "as loud as the wake phrase" dropped people turning away from the computer.)
    if (this.mode.reason === "conversation") return false;
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

  /** `paused`: the VAD ended the segment in silence (not flushed: the speaker's voice left while sound went on, or time ran out). */
  private handleSegment(clip: Clip | null, cut = false, paused = false): void {
    if (this.mode.kind !== "listening" || !clip?.audio.length) return;
    const t0 = this.now();
    const withBefore = (before: Float32Array) => {
      const a = new Float32Array(before.length + clip.audio.length);
      a.set(before);
      a.set(clip.audio, before.length);
      return a;
    };
    let heard = this.transcribe(clip.audio);
    if (!/[a-z0-9]/i.test(heard) && clip.before?.length && clip.audio.length <= RETRY_MAX) {
      // The recognizer heard nothing in a short segment (its way with a lone word now and then): a second try, with
      // a moment of what came before it (measured on 159 short replies: 24 came back empty, 4 after a second try).
      heard = this.transcribe(withBefore(clip.before));
    }
    if (this.mode.announced === false && clip.before?.length && !calledByName(heard) && !(heard && isStop(stripWake(heard, true)))) {
      // The bare name must start what was said, and the VAD's segment can start a little into it: "Ember, turn on…" was
      // heard as "Remember, turn on…", "Ever turn on…" or "Amber turned on…" for 7 of 16 placements of the same clip.
      // A second try with the moment before the segment (as above) hears the whole name.
      const again = this.transcribe(withBefore(clip.before));
      if (calledByName(again) || isStop(stripWake(again, true))) heard = again;
    }
    if (this.mode.maybeAmber) {
      this.mode.maybeAmber = false;
      if (heardOtherWord(heard) && !NAME_ALONE.test(heard) && !CALLED_AS_WORD.test(heard) && !isStop(stripWake(heard, true))) {
        this.emit({ type: "rejected", keyword: this.mode.keyword, reason: "check", heard });
        this.endListening("rejected");
        return;
      }
    }
    if (this.mode.announced === false) {
      // The bare name, with all that was said with it: "Ember, stop" stops (the spotter takes the name, so the kill phrase
      // isn't spotted after it); a phrase it doesn't start ("I remember…", "the embers…") was never a wake, and nothing
      // was shown. Otherwise the wake shows now, and what was said is the request.
      if (heard && isStop(stripWake(heard, true))) { this.emit({ type: "stop" }); this.endListening("stop"); return; }
      if (!calledByName(heard) && !nameOnItsOwn(heard, clip.audio.length) && !(this.nameFirst && !this.busyRoom && !heardOtherWord(heard) && !/\bembers?\b/i.test(heard))) { this.emit({ type: "rejected", keyword: BARE_NAME, reason: "check", heard }); this.endListening("rejected"); return; }
      this.mode.announced = true;
      this.emit({ type: "wake", keyword: BARE_NAME });
      this.emit({ type: "listening", on: true, reason: "wake", window: "wake" });
      if (this.wasSpeaking) this.emit({ type: "speech", on: true });
    }
    if (this.mode.overFollowUp && this.mode.first && heardOtherWord(heard) && saysSomething(stripWake(heard, true)) && !isStop(stripWake(heard, true))) {
      // A wake spotted in a follow-up window, and the recognizer heard another word in a request ("Hey Amber, dinner's
      // ready"): taken as the follow-up would have taken it (in the voice that woke Ember: see mustBeClose), or not at
      // all. (The wake phrase alone as the recognizer wrote it, "A member.", stays a wake: the request is to come.)
      if (!this.asLoudAs(clip.audio, this.voice * CLOSE_RATIO)) { this.emit({ type: "rejected", keyword: this.mode.keyword, reason: "check", heard }); this.endListening("rejected"); return; }
      this.mode.reason = "follow-up";
      this.mode.overFollowUp = false;
    }
    const conversation = this.mode.reason === "conversation";
    // With a song or a video on, what is said to Ember by name is for it, and so is what sounds like its owner (the voice
    // gate decides that; without a voiceprint it is dropped there). Over Ember's voice too, nothing can tell whose it is.
    if (conversation && this.soundPlaying(t0) && t0 - this.spottedAt >= NAME_HEARD_MS && !calledByName(heard)) {
      if (this.overEmber) { this.peak = 0; return; }
      this.overSound = true;
    }
    if (conversation && this.overEmber && !this.cutIn) {
      // All of what was said over Ember, its end heard: Ember's own voice, a "yeah", or the user cutting in.
      if (this.peak < this.echo * ECHO_MARGIN || BACKCHANNEL.test(heard)) { this.peak = 0; return; }
      if (spokenByEmber(heard, this.said)) { this.echo = Math.max(this.echo, this.peak); this.peak = 0; return; }
      if (saysSomething(stripWake(heard, true))) this.cutInNow(this.now());
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
    let text = this.mode.reason === "manual" ? heard.trim() : stripWake(heard, this.mode.first || conversation);
    if (this.mode.reason === "manual" && this.manualAnnounced.length) {
      const own = withoutAnnounced(text, this.manualAnnounced);
      if (own !== text && !saysSomething(own)) {
        // Only a screen reader saying the window had opened: the request is still to come, the window's time after it.
        this.mode.until = Math.max(this.mode.until, this.now() + this.mode.ms);
        return;
      }
      text = own;
    }
    // The clip holds the wake phrase before the request ("Hey Ember, allow" in one breath): Voice Match then vouches only
    // for what follows it (match.ts afterWakePhrase).
    let withWake = this.mode.reason !== "manual" && holdsWake(heard, text, this.mode.first || conversation);
    let audio = clip.audio;
    const held = this.held;
    if (held) {
      // The rest of a request that trailed off: one request, its audio whole for Voice Match. A cough or an "um" keeps
      // it waiting; a stop said on its own still stops (below), and the half request goes.
      if (!saysSomething(text)) return;
      this.held = null;
      if (!stopped(text) && !this.asLoudAs(clip.audio, held.level * CLOSE_RATIO)) {
        // Not as loud as the voice that paused (within 6 dB, as a follow-up must come near the wake's): others' talk, a TV.
        // Their words aren't the user's: the half request goes as it was, and a conversation hears theirs as what was said
        // next, as before the hold (on the real models they were joined to it in 12 of 18 cases at 12–19 dB under:
        // voice-listening-c1-2).
        const listensOn = this.mode.reason === "conversation";
        this.sendRequest(held.text, held.audio, held.withWake, false, held.t0);
        if (!listensOn || this.mode.kind !== "listening") return;
      } else if (!stopped(text)) {
        text = `${held.text.replace(/[\s,.…-]+$/, "")} ${text.replace(/^[A-Z](?![A-Z.])/, c => c.toLowerCase())}`;
        withWake = held.withWake;
        audio = new Float32Array(held.audio.length + clip.audio.length);
        audio.set(held.audio);
        audio.set(clip.audio, held.audio.length);
      }
    }
    const wakePhrase = this.mode.first && this.mode.reason === "wake";
    this.mode.first = false;
    // (One word is the wake phrase misheard over the room's talk: Moonshine base wrote it as "10.".)
    const ownWords = clip.own && saysSomething(text) ? stripWake(this.transcribe(clip.own), true).replace(LONE_GREETING, "") : null;
    if (ownWords !== null && (!saysSomething(ownWords) || wordsOf(ownWords).length < 2)) {
      // "Hey Ember." and then only others' talk (a TV, colleagues: under the wake phrase's loudness): the user hasn't
      // said their request yet.
      text = "";
    }
    if (!saysSomething(text)) {
      // Only the wake phrase (or a cough, or "um"): keep listening for the request.
      if (this.mode.reason !== "manual") this.mode.until = Math.max(this.mode.until, this.now() + 4000);
      // The request said after it is measured on its own loudness, not the wake phrase's (said up close, and louder: the
      // microphone has no gain control). Against the wake phrase's, its softer words counted as others' talk and ended it
      // early ("Hey Ember." … "And make the text a bit bigger." 6 dB softer was sent as "And make the text."). Only after
      // a pause the VAD heard, in a room that wasn't busy: where sound went on after the wake phrase, or others talked
      // before it, the request must still come as loud as the wake phrase (VO9-3).
      if (wakePhrase && paused && !this.busyRoom) { this.wakePeak = Math.max(this.wakePeak, this.peak); this.peak = 0; }
      return;
    }
    if (stopped(text) || (this.mode.reason === "manual" && isStop(stripWake(text, false)))) {
      // "Hey Ember, stop": the kill phrase in other words, handled here and never sent anywhere (once: the spotter may have heard it too).
      this.pendingStop = null;
      this.emit({ type: "stop" });
      this.endListening("stop");
      return;
    }
    // "Ember?" said again in a conversation, however the recognizer wrote it ("Number.", "Andber."): Ember is listening already.
    // Judged on all that was heard, so "Ember, close it" keeps its "Close it", and only on what reads as the name.
    if (conversation && this.now() - this.spottedAt < NAME_HEARD_MS && wordsOf(heard).length <= 2 && NAME_WRITTEN.test(heard)) {
      this.peak = 0;
      this.mode.until = Math.max(this.mode.until, this.now() + this.mode.ms);
      return;
    }
    // While one of Ember's questions is up, "No." or "Not now." in a follow-up window answers it (main's voice-answer.ts),
    // so it is sent rather than taken for "that's all".
    if (this.mode.reason === "follow-up" && !(this.questionWaiting && isAnswerWord(text)) && isCloser(text, this.mode.afterQuestion)) {
      // "Thanks.": nothing more to do (like a window that heard nothing).
      this.endListening("timeout");
      return;
    }
    if (conversation && !(this.questionWaiting && isAnswerWord(text))) {
      // "That's all.": the conversation is over. "Thanks.": there is nothing to answer, and the user may have more to say.
      if (endsConversation(text)) { this.endListening("timeout"); return; }
      if (!this.cutIn && isCloser(text, this.mode.afterQuestion)) { this.peak = 0; this.mode.until = Math.max(this.mode.until, this.now() + this.mode.ms); return; }
    }
    if (bargeIn && this.afterHush < AFTER_HUSH_FRAMES && (!this.mode.held || !this.hearsSpeakers(this.now()))) {
      // Said over Ember's voice, and not a stop: maybe not what was said (see AFTER_HUSH_FRAMES). Ember has been hushed,
      // and listens for the request again. Without the speakers' stream, never sent: what was heard may be Ember's own
      // next sentence (it went on until the page said it stopped).
      this.mode.held = true;
      this.mode.until = Math.max(this.mode.until, this.now() + 4000);
      return;
    }
    if (!held && !cut && !bargeIn && !this.overEmber && !this.overSound && trailsOff(text) && !(this.questionWaiting && isAnswerWord(text))) {
      // "And make the text a.": the speaker paused to think. Held for the rest of it (the window stays open meanwhile).
      this.held = { text, audio, withWake, until: this.now() + TRAIL_HOLD_MS, t0, level: this.soundLevel(audio) };
      this.mode.until = Math.max(this.mode.until, this.held.until);
      return;
    }
    this.sendRequest(text, audio, withWake, cut, t0);
  }

  /** A request that trailed off and wasn't continued: sent as it was heard. */
  private sendHeld(): void {
    const h = this.held;
    this.held = null;
    if (h && this.mode.kind === "listening") this.sendRequest(h.text, h.audio, h.withWake, false, h.t0);
  }

  /** The window's request goes to main (`audio`: what Voice Match checks), and the window ends or, in a conversation, listens on. */
  private sendRequest(text: string, audio: Float32Array, withWake: boolean, cut: boolean, t0: number): void {
    if (this.mode.kind !== "listening") return;
    const conversation = this.mode.reason === "conversation";
    // A wake's request sets the loudness its follow-up must come near; after three follow-ups in a row, the next request needs "Hey Ember" (MAX_FOLLOW_UPS).
    const window = this.mode.reason;
    // (Not softer than the wake phrase: else each follow-up could take softer room talk.)
    if (window === "wake") this.voice = Math.max(this.wakePeak, this.peak);
    this.followUps = window === "follow-up" ? this.followUps + 1 : 0;
    this.requestAudio = audio;
    this.requestWithWake = withWake;
    this.emit({ type: "utterance", text, ms: this.now() - t0, window, ...(cut ? { cut } : {}), ...(this.overEmber ? { overEmber: true as const } : {}), ...(this.overSound ? { overSound: true as const } : {}) });
    this.echo *= ECHO_DECAY;
    if (conversation && this.mode.kind === "listening") {
      // The microphone stays with the user: the next thing they say is heard as this one was, whatever Ember does meanwhile.
      this.mode.afterQuestion = false;
      this.mode.until = this.now() + this.mode.ms;
      this.peak = 0;
      return;
    }
    const opens = this.conversing && window !== "manual";
    this.endListening("done");
    if (opens) this.openConversation();
  }

  /** Does `audio` hold 9 frames (of those with sound) as loud as `energy`? */
  private asLoudAs(audio: Float32Array, energy: number): boolean {
    const e = framesOf(audio), half = LOUD_FRAMES >> 1, silent = Math.max(this.o.silenceRms ?? 0.0008, this.floor * SILENCE_RATIO) ** 2;
    for (let i = 0; i < e.length; i++) if (soundMedian(e, i - half, i + half + 1, silent) >= energy) return true;
    return false;
  }

  /** The loudness of `audio`'s loudest 9 frames (of those with sound), as asLoudAs measures it; 0 with none. */
  private soundLevel(audio: Float32Array): number {
    const e = framesOf(audio), half = LOUD_FRAMES >> 1, silent = Math.max(this.o.silenceRms ?? 0.0008, this.floor * SILENCE_RATIO) ** 2;
    let out = 0;
    for (let i = 0; i < e.length; i++) out = Math.max(out, soundMedian(e, i - half, i + half + 1, silent));
    return out;
  }

  /** At most 12 s at a time goes to the recognizer, split where it's quietest (between 6 and 12 s in). */
  private transcribe(seg: Float32Array): string {
    if (this.early?.audio === seg) return this.early.text;
    const parts: string[] = [];
    let at = 0;
    while (seg.length - at > TRANSCRIBE_CHUNK) {
      let split = at + TRANSCRIBE_CHUNK, low = Infinity;
      for (let i = at + TRANSCRIBE_CHUNK / 2; i + 1600 <= at + TRANSCRIBE_CHUNK; i += 512) {
        const e = rmsOf(seg.subarray(i, i + 1600));
        if (e < low) { low = e; split = i + 800; }
      }
      parts.push(this.backend.transcribe(seg.subarray(at, split), "request"));
      at = split;
    }
    parts.push(this.backend.transcribe(seg.subarray(at), "request"));
    return parts.map(p => p.trim()).filter(Boolean).join(" ");
  }

  private endListening(reason: "timeout" | "done" | "stop" | "rejected"): void {
    const window = this.mode.kind === "listening" ? this.mode.reason : "wake";
    const shown = this.mode.kind !== "listening" || this.mode.announced !== false;
    // (A request held for the rest of it goes with the window: never sent after a stop or a cancel.)
    this.held = null;
    this.mode = { kind: "idle" };
    this.wasSpeaking = false;
    this.hushAwaited = false;
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

/** A word that keeps someone talking rather than stopping them: "yeah", "mm-hmm", "right". */
const BACKCHANNEL = /^\W*(yeah|yes|yep|yup|ok|okay|right|sure|uh[- ]?huh|mm+[- ]?h?m*|hmm+|i see|got it)\W*$/i;

/** "That's all.", "Bye.", "Stop listening.": the conversation is over. */
export function endsConversation(text: string): boolean {
  return /^\W*((okay|ok|alright|all right|thanks|thank you|no)[\s,.!]+)*(that'?s all|that is all|that'?ll be all|bye(\s+bye)?|goodbye|good night|stop listening|go to sleep|i'?m done|we'?re done|nothing else)\b.{0,16}$/i.test(text);
}

/** Lower-case words of `text`, apostrophes kept. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/** Are `a` and `b` the same word, or one letter apart in a word long enough for the recognizer to have slipped? */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, slips = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++slips > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return slips + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Is `heard` Ember's own voice: are most of its words ones Ember is saying (`said`)? What the microphone keeps of Ember's
 * voice comes out as its words; someone talking over it says others. Nothing heard is nobody's.
 */
export function spokenByEmber(heard: string, said: readonly string[]): boolean {
  const words = wordsOf(heard);
  if (!words.length || !said.length) return false;
  return words.filter(w => said.some(s => sameWord(w, s))).length / words.length >= OWN_WORDS_SHARE;
}

/** The role a screen reader says after a button's name ("Cancel listening, push button"). */
const ROLE_WORDS = [["push", "button"], ["button"]];

/** `sameWord`, or, in words of six letters or more, two letters apart ("Listing" for "Listening"). */
function nearWord(a: string, b: string): boolean {
  if (sameWord(a, b)) return true;
  if (Math.min(a.length, b.length) < 6 || Math.abs(a.length - b.length) > 2) return false;
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length] <= 2;
}

/**
 * A Listen once request without what a screen reader said at its start: Ember's own status lines and button name as the
 * window opens (`announced`, sent only while one runs), which it says through the speakers, outside the echo canceller.
 * On the real models the announcement was in what was sent 36 of 36 times, and heard alone, with the user waiting for it
 * to finish, it went as the whole request (4 of 4: voice-listening-c2-1). Whole phrases from the start, in any order:
 * each word as the recognizer may slip on it, one word of a phrase of four or more another ("Listen for one request"),
 * a phrase of one word only as said alone ("Listening." or in the announcement, never "Starting tomorrow…"), and the role
 * a screen reader says after a button's name.
 */
export function withoutAnnounced(heard: string, announced: readonly string[]): string {
  if (!announced.length) return heard;
  const words = [...heard.matchAll(/[\p{L}\p{N}']+/gu)];
  const said = words.map(w => w[0].toLowerCase());
  const phrases = [...announced.map(wordsOf), ...ROLE_WORDS].filter(p => p.length);
  let at = 0;
  for (;;) {
    let took = 0;
    for (const p of phrases) {
      if (p.length <= took || at + p.length > said.length) continue;
      if (p.filter((w, i) => !nearWord(said[at + i], w)).length > (p.length >= 4 ? 1 : 0)) continue;
      const end = words[at].index! + words[at][0].length;
      if (p.length === 1 && at === 0 && at + 1 < said.length && !/^[^\p{L}\p{N}']*[.,;:!?…]/u.test(heard.slice(end))) continue;
      took = p.length;
    }
    if (!took) break;
    at += took;
  }
  if (!at) return heard;
  return at >= words.length ? "" : heard.slice(words[at].index!).replace(/^\p{Ll}/u, c => c.toUpperCase());
}

/** The wake said alone as the recognizer may write it: "Hey Amber.", "Member.". */
const NAME_ALONE = /^\W*(?:(?:hey|hi|hay|ok|okay|a|day)\W+)?(?:amber|member|ember|emmer|remember|number)\W*$/i;
/** Other sound counts as playing this long after the speakers' stream last had any (ms). */
const OTHER_SOUND_MS = 1500;
/** How the recognizer ends a name written as a word of its own: "Number.", "Andber.", "Day number.", "Embra." */
const NAME_WRITTEN = /(?:ber|mer|bra|bro)\W*$/i;
/** The spotter heard the name this long ago (ms) at most: what the recognizer wrote then holds it. */
const NAME_HEARD_MS = 3000;
/**
 * At most this much sound (frames: about 1 s) before the spotter fired on the bare name: the name itself, and the 0.45 s
 * the spotter takes. The name came first, so "Open the calculator." with the name clipped off is still a call: the VAD's
 * segment can start after it (measured on a laptop's microphone). A word heard that is another word still takes it back.
 */
const NAME_FIRST_FRAMES = 32;
/** Audio of up to this much (samples: 1.5 s) is the bare name on its own, with room for a slow "Ember?". */
const NAME_MAX = 1.5 * 16_000;

/**
 * The spotter heard the bare name in a short segment of two words at most, or of none the recognizer could make out: the
 * name said on its own. The recognizer writes a lone name as many things ("Emperor.", "I'm there.", or nothing: 19 of 30
 * phrases after a second of quiet), and each of those took the wake back in silence, though the user had plainly called:
 * 9 real "Ember"s in one evening's log. A longer phrase must start with the name (calledByName), so "I remember when…"
 * is still not a wake; a stray "remember" said alone only opens a window that hears nothing.
 */
export function nameOnItsOwn(heard: string, samples: number): boolean {
  return samples <= NAME_MAX && wordsOf(heard).length <= 2;
}

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

/** The loudest stretch of `e` (the median of LOUD_FRAMES frames; of all of them when it has fewer), or 0. */
function loudest(e: number[]): number {
  if (e.length <= LOUD_FRAMES) return median(e, 0, e.length);
  let out = 0;
  for (let i = LOUD_FRAMES; i <= e.length; i++) out = Math.max(out, median(e, i - LOUD_FRAMES, i));
  return out;
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
