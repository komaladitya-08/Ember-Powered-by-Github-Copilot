/**
 * The shared "brain" behind every Ember character: emotions map to face
 * parameters that move on springs, and an always-on liveliness layer adds
 * breathing, blinking, gaze, hops, talking and idle fidgets. Renderers only
 * draw a Pose; they never decide how Ember feels.
 *
 * Its life follows how people look (docs/DESIGN.md "The rig"): blinks close fast
 * and open slower, rarer while thinking or working (as when reading); the eyes jump
 * to a new point (a saccade) and then follow it smoothly; a long "got it" blink
 * when the user's request ends; and fidgets grow rarer the longer Ember idles, never
 * more frequent. All of it is a few numbers a frame: no extra drawing.
 */

export type Emotion =
  | "neutral" | "happy" | "listening" | "thinking" | "focused" | "curious"
  | "surprised" | "confused" | "worried" | "sad" | "proud" | "sleepy";

export type Emote = "none" | "question" | "exclaim" | "zzz" | "sparkle" | "sweat" | "dots";

export type Gesture =
  | "rest" | "wave" | "point" | "thumbsUp" | "scratch" | "cheeks" | "type"
  | "ear" | "facepalm" | "clap" | "chin" | "pillow" | "tap";

export interface Face {
  open: number;      // eyelid openness, 0 closed … 1.3 wide
  smile: number;     // lower-lid lift (happy eyes), 0 … 1
  pupil: number;     // pupil scale
  browY: number;     // -1 low … 1 raised
  browTilt: number;  // -1 cross (inner down) … 1 worried (inner up)
  mouth: number;     // -1 frown … 1 smile
  mouthOpen: number; // 0 … 1
  mouthW: number;    // width factor
  mouthSkew: number; // -1 … 1 sideways
  squash: number;    // + taller, - wider
  tilt: number;      // head tilt in radians
  energy: number;    // aura / flame / glow strength
  heat: number;      // 0.4 cooled … 1 normal … 1.35 white-hot
  blush: number;     // 0 … 1
  bounce: number;    // idle float amplitude
}

const KEYS: (keyof Face)[] = [
  "open", "smile", "pupil", "browY", "browTilt", "mouth", "mouthOpen", "mouthW",
  "mouthSkew", "squash", "tilt", "energy", "heat", "blush", "bounce",
];

export const NEUTRAL: Face = {
  open: 1, smile: 0.12, pupil: 1, browY: 0, browTilt: 0, mouth: 0.3, mouthOpen: 0,
  mouthW: 0.8, mouthSkew: 0, squash: 0, tilt: 0, energy: 0.6, heat: 1, blush: 0.15, bounce: 0.35,
};

interface Preset {
  face: Partial<Face>;
  emote: Emote;
  gesture: Gesture;
  gaze?: { x: number; y: number };
  hop?: number;
  label: string;
  when: string;
}

export const PRESETS: Record<Emotion, Preset> = {
  neutral:   { face: {}, emote: "none", gesture: "rest", label: "Ready", when: "Resting beside your cursor" },
  happy:     { face: { smile: 0.85, open: 0.8, mouth: 1, mouthOpen: 0.35, mouthW: 1, browY: 0.4, energy: 0.95, heat: 1.15, blush: 0.65, bounce: 0.8 },
               emote: "none", gesture: "wave", hop: 1, label: "Happy", when: "“Hey Ember!”" },
  listening: { face: { open: 1.12, pupil: 1.25, browY: 0.55, mouth: 0.3, mouthW: 0.5, energy: 0.85, heat: 1.08, squash: 0.06, bounce: 0.15 },
               emote: "none", gesture: "ear", label: "Listening", when: "Wake word heard" },
  thinking:  { face: { open: 0.85, browY: 0.35, browTilt: 0.3, mouth: -0.1, mouthW: 0.45, mouthSkew: 0.7, energy: 0.7, tilt: -0.12, bounce: 0.1 },
               emote: "dots", gesture: "chin", gaze: { x: -0.7, y: -0.8 }, label: "Thinking", when: "Model is reasoning" },
  focused:   { face: { open: 0.7, browY: -0.45, browTilt: -0.55, mouth: 0.05, mouthW: 0.55, energy: 1.05, heat: 1.15, squash: -0.04, bounce: 0.05 },
               emote: "none", gesture: "type", gaze: { x: 0, y: 0.45 }, label: "Focused", when: "Working in an app" },
  curious:   { face: { open: 1.05, pupil: 1.3, browY: 0.7, browTilt: 0.2, mouth: 0.3, mouthOpen: 0.15, mouthW: 0.45, tilt: 0.22, energy: 0.8 },
               emote: "none", gesture: "point", label: "Curious", when: "Showing you where to click" },
  surprised: { face: { open: 1.3, pupil: 0.7, browY: 1, mouth: 0, mouthOpen: 0.9, mouthW: 0.5, squash: 0.14, energy: 1.3, heat: 1.3 },
               emote: "exclaim", gesture: "cheeks", hop: 1.4, label: "Surprised", when: "Something unexpected popped up" },
  confused:  { face: { open: 0.9, browY: 0.2, browTilt: 0.7, mouth: -0.3, mouthW: 0.6, mouthSkew: -0.8, tilt: 0.28, energy: 0.6 },
               emote: "question", gesture: "scratch", label: "Confused", when: "Can't find something" },
  worried:   { face: { open: 1.05, pupil: 0.85, browY: 0.4, browTilt: 1, mouth: -0.5, mouthW: 0.5, mouthOpen: 0.1, energy: 0.7, heat: 0.9, squash: -0.05 },
               emote: "sweat", gesture: "cheeks", label: "Needs you", when: "Asking before a risky step" },
  sad:       { face: { open: 0.55, browY: -0.1, browTilt: 0.9, mouth: -0.9, mouthW: 0.6, squash: -0.12, energy: 0.3, heat: 0.45, bounce: 0.05, tilt: 0.1, blush: 0 },
               emote: "none", gesture: "facepalm", gaze: { x: 0.2, y: 0.8 }, label: "Sorry", when: "A step failed" },
  proud:     { face: { open: 0.45, smile: 1, mouth: 1, mouthOpen: 0.25, mouthW: 1.1, browY: 0.5, energy: 1.2, heat: 1.3, blush: 0.8, squash: 0.08, bounce: 0.6 },
               emote: "sparkle", gesture: "thumbsUp", hop: 1, label: "Proud", when: "Task done" },
  sleepy:    { face: { open: 0.06, smile: 0, browY: -0.3, mouth: 0.1, mouthW: 0.35, mouthOpen: 0.15, energy: 0.25, heat: 0.7, squash: -0.08, tilt: 0.18, bounce: 0 },
               emote: "zzz", gesture: "pillow", label: "Sleepy", when: "Nothing to do for a while" },
};

export interface Pose {
  face: Face;
  look: { x: number; y: number };
  emotion: Emotion;
  emote: Emote;
  emoteAge: number;
  gesture: Gesture;
  gestureAge: number;
  /** Seconds since the rig started. */
  t: number;
  dt: number;
  /** -1 … 1 breathing phase. */
  breath: number;
  /** Vertical offset from hops and idle float, in character units. */
  lift: number;
  /** Body lean from movement, radians. */
  lean: number;
  /** Movement acceleration (character units / s²) for soft-body jiggle. */
  accel: { x: number; y: number };
  /** Mouth flap 0 … 1 while talking. */
  talk: number;
  /** Where a pointing hand should aim (unit vector), if anywhere. */
  aim: { x: number; y: number } | null;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** A blink closes in BLINK_CLOSE s and opens in BLINK_OPEN s (closing is the faster half). */
export const BLINK_CLOSE = 0.06;
export const BLINK_OPEN = 0.11;
/** The long blink that says "got it" as the user's request ends (Hömke et al. 2018), in seconds. */
export const GOT_IT_BLINK = 0.25;
/**
 * Seconds between blinks: about 17 a minute at rest, fewer while thinking or working (people blink about 4.5 times a
 * minute while reading). Sleep has none.
 */
export function blinkGap(e: Emotion): [number, number] {
  return e === "thinking" || e === "focused" ? [6, 10] : [2.5, 5];
}
/** Seconds between idle fidgets: 5–10 in the first minute of idling, then 8–15 (rarer, never more insistent). */
export function fidgetGap(idleFor: number): [number, number] {
  return idleFor < 60 ? [5, 10] : [8, 15];
}
/** How open the eyes are `t` s into a blink of `close` + `open` s (1 open, 0 shut). */
export function blinkAt(t: number, close = BLINK_CLOSE, open = BLINK_OPEN): number {
  if (t <= 0 || t >= close + open) return 1;
  return t < close ? 1 - t / close : (t - close) / open;
}
/**
 * How long a voice level holds (s): Ember's voice sends one at least every half second while it plays
 * (app/shared/level.ts VOICE_KEEP_ALIVE_MS), so one older than this means the voice stopped without saying so.
 */
export const VOICE_STALE_S = 1.5;
/** Emotions entered without the anticipation pop: listening must start at once, and a pop reads as alarm on a question. */
const NO_POP: ReadonlySet<Emotion> = new Set(["listening", "worried"]);

/** Longest frame the rig accepts, and the step it integrates in (so 15 fps moves like 60 fps). */
const MAX_DT = 0.1;
const STEP = 1 / 30;
/** Longest step handed to renderers' own physics (Glassling's jiggle, Wisp's sparks). */
const MAX_DRAW_DT = 1 / 20;

export class Rig {
  emotion: Emotion = "neutral";
  alive = true;
  private face: Face = { ...NEUTRAL };
  private target: Face = { ...NEUTRAL };
  private vel = Object.fromEntries(KEYS.map(k => [k, 0])) as Record<keyof Face, number>;
  private emote: Emote = "none";
  private emoteAge = 0;
  private gesture: Gesture = "rest";
  private gestureAge = 0;
  private t = rand(0, 10);
  private look = { x: 0, y: 0 };
  private lookVel = { x: 0, y: 0 };
  private lookTarget = { x: 0, y: 0 };
  private lookTargetAge = 99;
  private saccadeIn = 1;
  private gazeOverride: { x: number; y: number } | null = null;
  private blinkIn = rand(1, 4);
  private blinkT = -1;
  /** The blink under way: its closing and opening times (a got-it blink is the long one). */
  private blinkClose = BLINK_CLOSE;
  private blinkOpen = BLINK_OPEN;
  /** Seconds left of a saccade's quick jump (then the soft spring follows). */
  private saccade = 0;
  /** The level of Ember's own voice while it plays (0–1), or null: then the mouth keeps its synthetic flap. */
  private voiceLevel: number | null = null;
  /** When the level last came (rig time, s). */
  private voiceAt = -Infinity;
  private voice = 0;
  /** A question is up (setQuestion): nothing about Ember jumps, pops, hops or fidgets until it is answered. */
  private question = false;
  private hopY = 0;
  private hopV = 0;
  private talking = false;
  private talk = 0;
  private idleFor = 0;
  private fidgetIn = rand(5, 9);
  private fidget: { kind: "glance" | "yawn" | "hop"; age: number; dur: number; dir?: { x: number; y: number } } | null = null;
  private pos = { x: 0, y: 0 };
  private posVel = { x: 0, y: 0 };
  private accel = { x: 0, y: 0 };
  private lean = 0;
  private aim: { x: number; y: number } | null = null;
  private blink = 1;
  /** Asleep because nothing happened for `sleepAfter` seconds (not because someone asked). */
  private dozing = false;
  /** Fall asleep after this many idle seconds (0 = never). */
  sleepAfter = 0;
  /**
   * Calm mode (prefers-reduced-motion or the reduce-motion setting): no hops, idle float,
   * fidgets, squash pops or jiggle, and no wobble on the body springs. Blinks, gaze, the
   * talking mouth and a gentle breath stay, so Ember still reads as alive.
   */
  reducedMotion = false;

  setEmotion(e: Emotion, opts: { gesture?: Gesture } = {}): void {
    const p = PRESETS[e];
    const changed = e !== this.emotion;
    // The user's request has ended (Ember heard it): one long blink, "got it".
    if (changed && this.emotion === "listening") this.gotIt();
    this.emotion = e;
    this.dozing = false;
    this.target = { ...NEUTRAL, ...p.face };
    if (changed || opts.gesture) {
      this.emote = p.emote;
      this.emoteAge = 0;
      this.setGesture(opts.gesture ?? p.gesture);
      this.gazeOverride = p.gaze ?? null;
      if (!this.reducedMotion && !NO_POP.has(e) && !this.question) {
        this.vel.squash += 2.2;   // anticipation pop on a change
        this.vel.tilt += rand(-0.6, 0.6);
      }
      if (p.hop) this.hop(p.hop);
      if (this.question) this.fidget = null;
      // The next blink comes at the new emotion's rate (thinking's is slower), not the last one's.
      const [lo, hi] = blinkGap(e);
      this.blinkIn = Math.min(Math.max(this.blinkIn, 0.3), rand(lo, hi));
      this.fidget = null;
      this.idleFor = 0;
    }
  }

  /** One long, slow blink: "got it" (the user's request ended), in place of any blink under way. Not while asleep. */
  gotIt(): void {
    if (this.emotion === "sleepy") return;
    this.blinkT = 0;
    this.blinkClose = GOT_IT_BLINK * 0.4;
    this.blinkOpen = GOT_IT_BLINK * 0.6;
  }

  /**
   * The loudness of Ember's own voice as it plays (0 quiet … 1 loud; null when it stops, or for the system's voice,
   * which gives none): the mouth opens with it, and the glow brightens a little with it, instead of a made-up flap.
   */
  setTalkLevel(v: number | null): void {
    this.voiceLevel = v === null || !Number.isFinite(v) ? null : Math.max(0, Math.min(1, v));
    this.voiceAt = this.t;
  }

  /** Something happened (the user moved, Ember was spoken to): restart the idle clock and wake from a doze. */
  wake(): void {
    this.idleFor = 0;
    if (this.dozing) this.setEmotion("neutral");
  }

  /** Dozing after a long idle (see `sleepAfter`). */
  get asleep(): boolean {
    return this.dozing;
  }

  /**
   * How much passing motion there is, so a renderer can draw less often when little moves:
   * "brisk" (a hop, a fresh gesture or emote, a fast change of face or gaze), "gentle" (a
   * blink, an idle fidget, a saccade, springs still settling) or "still". Steady motion, like
   * talking or a waving hand, is the renderer's call.
   */
  get motion(): "brisk" | "gentle" | "still" {
    const look = Math.abs(this.lookVel.x) + Math.abs(this.lookVel.y);
    const face = Math.max(...KEYS.map(k => Math.abs(this.vel[k])));
    // A saccade is fast but tiny (the pupils jump a few px): drawn at the lively rate, not every frame (measured: idle
    // saccades at every frame cost the overlay about a point of a core).
    const glancing = look > 1.5 && this.saccade <= 0;
    if (this.hopY !== 0 || this.gestureAge < 0.8 || this.emoteAge < 0.8 || glancing || face > 1.5) return "brisk";
    if (this.fidget || this.blinkT >= 0 || look > 0.05 || face > 0.05) return "gentle";
    return "still";
  }

  /** No passing motion at all (see `motion`). */
  get settled(): boolean {
    return this.motion === "still";
  }

  setGesture(g: Gesture): void {
    if (g !== this.gesture) { this.gesture = g; this.gestureAge = 0; }
  }

  /** Look toward a direction; components roughly -1 … 1. A far new point is reached by a quick jump, then followed. */
  lookAt(x: number, y: number): void {
    const next = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
    if (!this.question && Math.hypot(next.x - this.lookTarget.x, next.y - this.lookTarget.y) > 0.5) this.saccade = 0.12;
    this.lookTarget = next;
    this.lookTargetAge = 0;
  }

  /** Aim a pointing hand at a unit direction (null to stop). */
  setAim(dir: { x: number; y: number } | null): void {
    this.aim = dir;
  }

  hop(strength = 1): void {
    if (this.reducedMotion || this.question) return;
    if (this.hopY > -1) this.hopV = -150 * strength;
  }

  /**
   * Talking or not, as the words go (the syllable flap of the system's voice). Ember's own voice moves the mouth by its
   * level (setTalkLevel) for as long as it plays, which outlasts the words: the last sentence is spoken after them.
   */
  setTalking(on: boolean): void {
    this.talking = on;
  }

  /**
   * A question is up, whatever the emotion it shows (Confirmer's is "curious"): until it is answered nothing about Ember
   * jumps, pops, hops, fidgets or glances away (design-system.md "Nothing near a pending question moves"); blinks stay,
   * and the eyes still follow the pointer smoothly.
   */
  setQuestion(on: boolean): void {
    if (on === this.question) return;
    this.question = on;
    if (on) { this.fidget = null; this.saccade = 0; }
  }

  /** Tell the rig where the character is on screen, so it can lean and jiggle. */
  setPosition(x: number, y: number, dt: number): void {
    if (dt <= 0) return;
    const vx = (x - this.pos.x) / dt;
    const vy = (y - this.pos.y) / dt;
    this.accel = { x: (vx - this.posVel.x) / dt, y: (vy - this.posVel.y) / dt };
    this.posVel = { x: vx, y: vy };
    this.pos = { x, y };
  }

  update(dt: number): Pose {
    dt = Math.min(Math.max(dt, 0), MAX_DT);
    const n = Math.max(1, Math.ceil(dt / STEP - 1e-6));
    for (let i = 0; i < n; i++) this.step(dt / n);

    const breath = Math.sin(this.t * Math.PI * 2 * 0.28);
    const face = { ...this.face };
    face.open = Math.max(0, face.open * this.blink);
    face.mouthOpen = Math.min(1, face.mouthOpen + this.talk * 0.55);
    // The glow follows Ember's own voice.
    face.energy += 0.2 * this.voice;
    face.squash += breath * 0.025;

    return {
      face,
      look: { ...this.look },
      emotion: this.emotion,
      emote: this.emote,
      emoteAge: this.emoteAge,
      gesture: this.gesture,
      gestureAge: this.gestureAge,
      t: this.t,
      dt: Math.min(dt, MAX_DRAW_DT),
      breath,
      lift: this.hopY + (this.reducedMotion || this.question ? 0 : Math.sin(this.t * 2.1) * face.bounce * 3),
      lean: this.lean,
      accel: this.reducedMotion ? { x: 0, y: 0 } : { ...this.accel },
      talk: this.talk,
      aim: this.aim,
    };
  }

  private step(dt: number): void {
    this.t += dt;
    this.emoteAge += dt;
    this.gestureAge += dt;

    // Idle life: fidgets (not in calm mode), then sleep.
    if (this.reducedMotion) this.fidget = null;
    if (this.alive && this.emotion === "neutral") {
      this.idleFor += dt;
      this.fidgetIn -= dt;
      if (this.sleepAfter && this.idleFor > this.sleepAfter) {
        this.setEmotion("sleepy");
        this.dozing = true;
      } else if (this.fidgetIn <= 0 && !this.fidget && !this.reducedMotion && !this.question) {
        const r = Math.random();
        this.fidget = r < 0.5
          ? { kind: "glance", age: 0, dur: 1.2, dir: { x: rand(-1, 1), y: rand(-0.6, 0.6) } }
          : r < 0.8 ? { kind: "yawn", age: 0, dur: 1.6 } : { kind: "hop", age: 0, dur: 0.6 };
        if (this.fidget.kind === "hop") this.hop(0.6);
        const [lo, hi] = fidgetGap(this.idleFor);
        this.fidgetIn = rand(lo, hi);
      }
    } else if (this.emotion !== "sleepy") {
      this.idleFor = 0;
    }
    const target = { ...this.target };
    if (this.fidget) {
      const f = this.fidget;
      f.age += dt;
      const k = Math.sin(Math.min(f.age / f.dur, 1) * Math.PI);
      if (f.kind === "yawn") {
        target.mouthOpen = Math.max(target.mouthOpen, 0.95 * k);
        target.mouthW = 0.55;
        target.open = target.open * (1 - 0.8 * k);
        target.squash += 0.12 * k;
        target.browY += 0.4 * k;
      }
      if (f.age >= f.dur) this.fidget = null;
    }

    // Springs: wobbly for body, snappier for face; in calm mode every one settles without overshoot.
    for (const k of KEYS) {
      const wobbly = k === "squash" || k === "tilt";
      const stiff = wobbly ? 160 : 110;
      // (A question holds the body still too: its tilt and squash settle without wobbling.)
      const damp = 2 * Math.sqrt(stiff) * (this.reducedMotion || (wobbly && this.question) ? 1 : wobbly ? 0.32 : 0.8);
      this.vel[k] += (stiff * (target[k] - this.face[k]) - damp * this.vel[k]) * dt;
      this.face[k] += this.vel[k] * dt;
    }

    // Gaze: override > fidget glance > external target > saccades.
    this.lookTargetAge += dt;
    this.saccadeIn -= dt;
    let goal = this.lookTarget;
    // Asleep: the eyes stay where they are (nothing to look at; a dozing Ember draws nothing).
    if (this.emotion === "sleepy") goal = this.look;
    else if (this.gazeOverride) {
      goal = { x: this.gazeOverride.x + Math.sin(this.t * 1.3) * 0.08, y: this.gazeOverride.y };
    } else if (this.fidget?.kind === "glance" && this.fidget.dir) {
      goal = this.fidget.dir;
    } else if (this.lookTargetAge > 2.5 && !this.question) {
      if (this.saccadeIn <= 0) {
        this.lookTarget = { x: rand(-0.5, 0.5), y: rand(-0.3, 0.3) };
        this.saccadeIn = rand(0.7, 2.2);
        this.saccade = 0.12;
      }
      goal = this.lookTarget;
    }
    // A saccade is ballistic (about 60 ms, a stiff spring without overshoot); following is the soft spring.
    this.saccade = Math.max(0, this.saccade - dt);
    const ls = this.saccade > 0 ? 900 : 260, ld = 2 * Math.sqrt(ls) * (this.saccade > 0 ? 1 : 0.9);
    this.lookVel.x += (ls * (goal.x - this.look.x) - ld * this.lookVel.x) * dt;
    this.lookVel.y += (ls * (goal.y - this.look.y) - ld * this.lookVel.y) * dt;
    this.look.x += this.lookVel.x * dt;
    this.look.y += this.lookVel.y * dt;

    // Blinks: quick to close, slower to open, sometimes double; rarer while thinking or working.
    let blink = 1;
    if (this.emotion !== "sleepy") {
      this.blinkIn -= dt;
      if (this.blinkIn <= 0 && this.blinkT < 0) {
        this.blinkT = 0;
        this.blinkClose = BLINK_CLOSE;
        this.blinkOpen = BLINK_OPEN;
        const [lo, hi] = blinkGap(this.emotion);
        this.blinkIn = Math.random() < 0.2 ? 0.28 : rand(lo, hi);
      }
      if (this.blinkT >= 0) {
        this.blinkT += dt;
        blink = blinkAt(this.blinkT, this.blinkClose, this.blinkOpen);
        if (this.blinkT >= this.blinkClose + this.blinkOpen) { this.blinkT = -1; blink = 1; }
      }
    } else {
      this.blinkT = -1;
    }
    this.blink = blink;

    // Hops land with a squash.
    this.hopV += 900 * dt;
    this.hopY += this.hopV * dt;
    if (this.hopY > 0) {
      if (this.hopV > 120 && !this.reducedMotion) this.vel.squash -= this.hopV * 0.012;
      this.hopY = 0;
      this.hopV = 0;
    }

    // Talking: with Ember's own voice the mouth follows its loudness (opening fast, closing a little slower, with a
    // touch of syllable rhythm between the level's ten updates a second); with the system's voice, a syllable flap.
    const syl = Math.max(0, Math.sin(this.t * 17) * 0.6 + Math.sin(this.t * 7.3) * 0.4);
    // A level not refreshed for VOICE_STALE_S is dropped: the voice stopped without its null (its page closed).
    if (this.voiceLevel !== null && this.t - this.voiceAt > VOICE_STALE_S) this.voiceLevel = null;
    const level = this.voiceLevel ?? 0;
    this.voice += (level - this.voice) * Math.min(1, dt * (level > this.voice ? 40 : 11));
    const mouth = this.voiceLevel !== null ? this.voice * (0.8 + 0.2 * syl) : this.talking ? syl : 0;
    this.talk += (mouth - this.talk) * Math.min(1, dt * 25);

    this.lean += ((Math.max(-1, Math.min(1, this.posVel.x / 900)) * 0.35) - this.lean) * Math.min(1, dt * 8);
  }
}
