/**
 * The shared "brain" behind every Ember character: emotions map to face
 * parameters that move on springs, and an always-on liveliness layer adds
 * breathing, blinking, gaze, hops, talking and idle fidgets. Renderers only
 * draw a Pose; they never decide how Ember feels.
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
  /** Fall asleep after this many idle seconds (0 = never). */
  sleepAfter = 0;

  setEmotion(e: Emotion, opts: { gesture?: Gesture } = {}): void {
    const p = PRESETS[e];
    const changed = e !== this.emotion;
    this.emotion = e;
    this.target = { ...NEUTRAL, ...p.face };
    if (changed || opts.gesture) {
      this.emote = p.emote;
      this.emoteAge = 0;
      this.setGesture(opts.gesture ?? p.gesture);
      this.gazeOverride = p.gaze ?? null;
      this.vel.squash += 2.2;   // anticipation pop on every change
      this.vel.tilt += rand(-0.6, 0.6);
      if (p.hop) this.hop(p.hop);
      this.fidget = null;
      this.idleFor = 0;
    }
  }

  setGesture(g: Gesture): void {
    if (g !== this.gesture) { this.gesture = g; this.gestureAge = 0; }
  }

  /** Look toward a direction; components roughly -1 … 1. */
  lookAt(x: number, y: number): void {
    this.lookTarget = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
    this.lookTargetAge = 0;
  }

  /** Aim a pointing hand at a unit direction (null to stop). */
  setAim(dir: { x: number; y: number } | null): void {
    this.aim = dir;
  }

  hop(strength = 1): void {
    if (this.hopY > -1) this.hopV = -150 * strength;
  }

  setTalking(on: boolean): void {
    this.talking = on;
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
    dt = Math.min(Math.max(dt, 0), 1 / 20);
    this.t += dt;
    this.emoteAge += dt;
    this.gestureAge += dt;

    // Idle life: fidgets, then sleep.
    if (this.alive && this.emotion === "neutral") {
      this.idleFor += dt;
      this.fidgetIn -= dt;
      if (this.sleepAfter && this.idleFor > this.sleepAfter) this.setEmotion("sleepy");
      else if (this.fidgetIn <= 0 && !this.fidget) {
        const r = Math.random();
        this.fidget = r < 0.5
          ? { kind: "glance", age: 0, dur: 1.2, dir: { x: rand(-1, 1), y: rand(-0.6, 0.6) } }
          : r < 0.8 ? { kind: "yawn", age: 0, dur: 1.6 } : { kind: "hop", age: 0, dur: 0.6 };
        if (this.fidget.kind === "hop") this.hop(0.6);
        this.fidgetIn = rand(5, 10);
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

    // Springs: wobbly for body, snappier for face.
    for (const k of KEYS) {
      const wobbly = k === "squash" || k === "tilt";
      const stiff = wobbly ? 160 : 110;
      const damp = wobbly ? 2 * Math.sqrt(stiff) * 0.32 : 2 * Math.sqrt(stiff) * 0.8;
      this.vel[k] += (stiff * (target[k] - this.face[k]) - damp * this.vel[k]) * dt;
      this.face[k] += this.vel[k] * dt;
    }

    // Gaze: override > fidget glance > external target > saccades.
    this.lookTargetAge += dt;
    this.saccadeIn -= dt;
    let goal = this.lookTarget;
    if (this.gazeOverride) {
      goal = { x: this.gazeOverride.x + Math.sin(this.t * 1.3) * 0.08, y: this.gazeOverride.y };
    } else if (this.fidget?.kind === "glance" && this.fidget.dir) {
      goal = this.fidget.dir;
    } else if (this.lookTargetAge > 2.5) {
      if (this.saccadeIn <= 0) {
        this.lookTarget = { x: rand(-0.5, 0.5), y: rand(-0.3, 0.3) };
        this.saccadeIn = rand(0.7, 2.2);
      }
      goal = this.lookTarget;
    }
    const ls = 260, ld = 2 * Math.sqrt(ls) * 0.9;
    this.lookVel.x += (ls * (goal.x - this.look.x) - ld * this.lookVel.x) * dt;
    this.lookVel.y += (ls * (goal.y - this.look.y) - ld * this.lookVel.y) * dt;
    this.look.x += this.lookVel.x * dt;
    this.look.y += this.lookVel.y * dt;

    // Blinks (sometimes double).
    let blink = 1;
    if (this.emotion !== "sleepy") {
      this.blinkIn -= dt;
      if (this.blinkIn <= 0 && this.blinkT < 0) {
        this.blinkT = 0;
        this.blinkIn = Math.random() < 0.2 ? 0.28 : rand(2, 5);
      }
      if (this.blinkT >= 0) {
        this.blinkT += dt;
        const b = this.blinkT / 0.16;
        blink = b < 0.5 ? 1 - b * 2 : (b - 0.5) * 2;
        if (b >= 1) { this.blinkT = -1; blink = 1; }
      }
    }

    // Hops land with a squash.
    this.hopV += 900 * dt;
    this.hopY += this.hopV * dt;
    if (this.hopY > 0) {
      if (this.hopV > 120) this.vel.squash -= this.hopV * 0.012;
      this.hopY = 0;
      this.hopV = 0;
    }

    // Talking flaps the mouth with a syllable rhythm.
    const syl = Math.max(0, Math.sin(this.t * 17) * 0.6 + Math.sin(this.t * 7.3) * 0.4);
    this.talk += ((this.talking ? syl : 0) - this.talk) * Math.min(1, dt * 25);

    this.lean += ((Math.max(-1, Math.min(1, this.posVel.x / 900)) * 0.35) - this.lean) * Math.min(1, dt * 8);

    const breath = Math.sin(this.t * Math.PI * 2 * 0.28);
    const face = { ...this.face };
    face.open = Math.max(0, face.open * blink);
    face.mouthOpen = Math.min(1, face.mouthOpen + this.talk * 0.55);
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
      dt,
      breath,
      lift: this.hopY + Math.sin(this.t * 2.1) * face.bounce * 3,
      lean: this.lean,
      accel: { ...this.accel },
      talk: this.talk,
      aim: this.aim,
    };
  }
}
