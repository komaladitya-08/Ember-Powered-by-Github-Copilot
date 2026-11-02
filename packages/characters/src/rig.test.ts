import { describe, it, expect, vi, afterEach } from "vitest";
import { BLINK_CLOSE, BLINK_OPEN, Rig, PRESETS, VOICE_STALE_S, blinkAt, blinkGap, fidgetGap, type Emotion } from "./rig";

function settle(rig: Rig, seconds: number) {
  let pose = rig.update(0);
  for (let t = 0; t < seconds; t += 1 / 60) pose = rig.update(1 / 60);
  return pose;
}

describe("Rig", () => {
  it("has a label and gesture for every emotion", () => {
    for (const e of Object.keys(PRESETS) as Emotion[]) {
      expect(PRESETS[e].label.length).toBeGreaterThan(0);
      expect(PRESETS[e].gesture).toBeTruthy();
    }
  });

  it("moves the face toward the emotion's preset", () => {
    const rig = new Rig();
    rig.alive = false;
    rig.setEmotion("sad");
    const pose = settle(rig, 3);
    expect(pose.face.mouth).toBeLessThan(-0.6);
    expect(pose.face.heat).toBeLessThan(0.6);
    expect(pose.gesture).toBe("facepalm");
  });

  it("shows the emote for the new emotion", () => {
    const rig = new Rig();
    rig.setEmotion("confused");
    expect(rig.update(1 / 60).emote).toBe("question");
  });

  it("blinks while awake but stays closed when sleepy", () => {
    const awake = new Rig();
    awake.alive = false;
    let minOpen = 1;
    for (let i = 0; i < 60 * 8; i++) minOpen = Math.min(minOpen, awake.update(1 / 60).face.open);
    expect(minOpen).toBeLessThan(0.3);

    const sleepy = new Rig();
    sleepy.setEmotion("sleepy");
    expect(settle(sleepy, 3).face.open).toBeLessThan(0.2);
  });

  it("follows a look target", () => {
    const rig = new Rig();
    rig.alive = false;
    rig.lookAt(1, 0);
    expect(settle(rig, 1).look.x).toBeGreaterThan(0.8);
  });

  it("ignores negative or huge time steps", () => {
    const rig = new Rig();
    const pose = rig.update(-1);
    expect(Number.isFinite(pose.face.open)).toBe(true);
    expect(Number.isFinite(rig.update(10).face.open)).toBe(true);
  });

  it("moves at the same speed at 15 fps as at 60 fps", () => {
    const fast = new Rig(), slow = new Rig();
    const t0 = fast.update(0).t, s0 = slow.update(0).t;
    fast.setEmotion("sad");
    slow.setEmotion("sad");
    let a = fast.update(0), b = slow.update(0);
    for (let i = 0; i < 60; i++) a = fast.update(1 / 60);
    for (let i = 0; i < 15; i++) b = slow.update(1 / 15);
    expect(a.t - t0).toBeCloseTo(1, 5);
    expect(b.t - s0).toBeCloseTo(1, 5);
    expect(b.face.mouth).toBeCloseTo(a.face.mouth, 1);
  });

  it("says when nothing is moving quickly, so a renderer can draw less often", () => {
    const rig = new Rig();
    rig.alive = false;
    settle(rig, 4);
    rig.setEmotion("surprised");
    rig.update(1 / 60);
    expect(rig.settled).toBe(false);
    let settled = false;
    for (let i = 0; i < 60 * 6 && !settled; i++) { rig.update(1 / 60); settled = rig.settled; }
    expect(settled).toBe(true);
  });
});

describe("Rig sleep", () => {
  it("dozes off after a long idle and wakes when something happens", () => {
    const rig = new Rig();
    rig.sleepAfter = 5;
    settle(rig, 6);
    expect(rig.emotion).toBe("sleepy");
    expect(rig.asleep).toBe(true);
    rig.wake();
    expect(rig.emotion).toBe("neutral");
    expect(rig.asleep).toBe(false);
    settle(rig, 3);
    expect(rig.emotion).toBe("neutral");
  });

  it("stays sleepy when asked to be, whatever happens", () => {
    const rig = new Rig();
    rig.setEmotion("sleepy");
    rig.wake();
    expect(rig.emotion).toBe("sleepy");
  });
});

describe("Rig reduced motion", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /** Runs a rig for `seconds`, tracking the extremes of its body motion. */
  function watch(rig: Rig, seconds: number) {
    let lift = 0, squash = 0, mouthOpen = 0, minOpen = 1;
    for (let t = 0; t < seconds; t += 1 / 60) {
      const p = rig.update(1 / 60);
      lift = Math.max(lift, Math.abs(p.lift));
      squash = Math.max(squash, Math.abs(p.face.squash));
      mouthOpen = Math.max(mouthOpen, p.face.mouthOpen);
      minOpen = Math.min(minOpen, p.face.open);
    }
    return { lift, squash, mouthOpen, minOpen };
  }

  it("has no hops, idle float or squash pops", () => {
    const lively = new Rig();
    lively.setEmotion("surprised");
    const a = watch(lively, 2);
    expect(a.lift).toBeGreaterThan(5);
    expect(a.squash).toBeGreaterThan(0.2);

    const calm = new Rig();
    calm.reducedMotion = true;
    calm.setEmotion("surprised");
    const b = watch(calm, 2);
    expect(b.lift).toBe(0);
    // Settles on the preset's squash (0.14) plus breathing, without overshooting it.
    expect(b.squash).toBeLessThan(0.14 + 0.03);
  });

  it("has no idle fidgets but still blinks", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.6); // every fidget would be a yawn
    const lively = new Rig();
    expect(watch(lively, 20).mouthOpen).toBeGreaterThan(0.6);

    const calm = new Rig();
    calm.reducedMotion = true;
    const b = watch(calm, 20);
    expect(b.mouthOpen).toBeLessThan(0.1);
    expect(b.minOpen).toBeLessThan(0.3);
  });

  it("does not jiggle with movement", () => {
    const calm = new Rig();
    calm.reducedMotion = true;
    calm.setPosition(0, 0, 1 / 60);
    calm.setPosition(10, 0, 1 / 60);
    expect(calm.update(1 / 60).accel).toEqual({ x: 0, y: 0 });
  });
});

describe("Rig liveliness (motion notes §4.4)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("closes a blink faster than it opens it", () => {
    expect(BLINK_CLOSE).toBeLessThan(BLINK_OPEN);
    expect(blinkAt(0)).toBe(1);
    expect(blinkAt(BLINK_CLOSE)).toBeCloseTo(0, 5);
    expect(blinkAt(BLINK_CLOSE / 2)).toBeCloseTo(0.5, 5);
    expect(blinkAt(BLINK_CLOSE + BLINK_OPEN / 2)).toBeCloseTo(0.5, 5);
    expect(blinkAt(BLINK_CLOSE + BLINK_OPEN)).toBe(1);
  });

  it("blinks less while thinking or working, as people do while reading", () => {
    expect(blinkGap("thinking")[0]).toBeGreaterThanOrEqual(6);
    expect(blinkGap("focused")[0]).toBeGreaterThanOrEqual(6);
    expect(blinkGap("neutral")).toEqual([2.5, 5]);
    // Counted over a minute: fewer blinks thinking than at rest.
    const count = (e: Emotion) => {
      const rig = new Rig();
      rig.alive = false;
      rig.setEmotion(e);
      let n = 0, was = 1;
      for (let i = 0; i < 60 * 60; i++) { const o = rig.update(1 / 60).face.open; if (o < 0.3 && was >= 0.3) n++; was = o; }
      return n;
    };
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(count("thinking")).toBeLessThan(count("neutral"));
  });

  it("gives one long \"got it\" blink when the user's request ends", () => {
    const rig = new Rig();
    rig.alive = false;
    rig.setEmotion("listening");
    settle(rig, 1.5);
    rig.setEmotion("thinking");
    let closedFor = 0;
    for (let i = 0; i < 60; i++) if (rig.update(1 / 60).face.open < 0.5 * PRESETS.thinking.face.open!) closedFor += 1 / 60;
    // A plain blink is closed for well under 0.1 s; this one longer.
    expect(closedFor).toBeGreaterThan(0.1);
  });

  it("enters listening and \"Needs you\" without the anticipation pop", () => {
    // The pop is a kick to the squash spring: in the first frame after the change, the body jumps up.
    const kick = (e: Emotion) => {
      const rig = new Rig();
      rig.alive = false;
      settle(rig, 2);
      const before = rig.update(0).face.squash;
      rig.setEmotion(e);
      return rig.update(1 / 60).face.squash - before;
    };
    expect(kick("listening")).toBeLessThan(0.01);
    expect(kick("worried")).toBeLessThan(0.01);
    expect(kick("curious")).toBeGreaterThan(0.025);
  });

  it("fidgets less often after a minute of idling, never more", () => {
    expect(fidgetGap(10)).toEqual([5, 10]);
    expect(fidgetGap(120)[0]).toBeGreaterThan(fidgetGap(10)[0]);
  });

  it("moves its mouth and glow with the loudness of its own voice, and keeps the flap for the system's voice", () => {
    const rig = new Rig();
    rig.alive = false;
    rig.setTalking(true);
    rig.setTalkLevel(0);
    const quiet = settle(rig, 0.5);
    rig.setTalkLevel(1);
    const loud = settle(rig, 0.3);
    expect(loud.talk).toBeGreaterThan(quiet.talk + 0.5);
    expect(loud.face.energy).toBeGreaterThan(quiet.face.energy + 0.1);
    // Silence closes it.
    rig.setTalkLevel(0);
    expect(settle(rig, 0.5).talk).toBeLessThan(0.05);
    // No level (the system's voice): the syllable flap.
    rig.setTalkLevel(null);
    let flap = 0;
    for (let i = 0; i < 60; i++) flap = Math.max(flap, rig.update(1 / 60).talk);
    expect(flap).toBeGreaterThan(0.3);
  });

  it("holds still once asleep, so the overlay can stop drawing", () => {
    const rig = new Rig();
    rig.sleepAfter = 2;
    settle(rig, 3);
    expect(rig.asleep).toBe(true);
    settle(rig, 4);
    expect(rig.settled).toBe(true);
    // And stays so: no saccades or blinks while asleep.
    let still = true;
    for (let i = 0; i < 60 * 5; i++) { rig.update(1 / 60); if (!rig.settled) still = false; }
    expect(still).toBe(true);
  });

  it("settles every spring without overshoot in Calm", () => {
    const rig = new Rig();
    rig.alive = false;
    rig.reducedMotion = true;
    settle(rig, 2);
    rig.setEmotion("sad");
    let low = Infinity;
    for (let i = 0; i < 60 * 3; i++) low = Math.min(low, rig.update(1 / 60).face.mouth);
    expect(low).toBeGreaterThanOrEqual(PRESETS.sad.face.mouth! - 0.01);
  });
});

describe("Rig while a question is up, and after it stops talking (review of the Liquid Glass branch)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("stops moving its mouth when it stops talking, even with the voice's last level left behind", () => {
    const rig = new Rig();
    rig.alive = false;
    rig.setTalking(true);
    rig.setTalkLevel(0.6);
    settle(rig, 0.5);
    rig.setTalking(false);
    const pose = settle(rig, 10);
    // A mouth still moving kept the overlay drawing every 33 ms for good.
    expect(pose.talk).toBeLessThan(0.01);
  });

  it("holds still while a question is up, whatever emotion it shows (Confirmer's is curious): no pop, hop, fidget or glance away", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.6); // every fidget would be a yawn, every saccade far off
    const rig = new Rig();
    settle(rig, 2);
    rig.setQuestion(true);
    rig.lookAt(0.2, 0.1);
    const before = rig.update(0).face.squash;
    rig.setEmotion("curious");
    expect(rig.update(1 / 60).face.squash - before).toBeLessThan(0.01);
    let lift = 0, yawn = 0;
    const looks: number[] = [];
    for (let t = 0; t < 20; t += 1 / 60) {
      const p = rig.update(1 / 60);
      lift = Math.max(lift, Math.abs(p.lift));
      yawn = Math.max(yawn, p.face.mouthOpen);
      if (t > 2) looks.push(p.look.x);
    }
    // (Curious's idle float stays, a few units; a hop is tens.)
    expect(lift).toBeLessThan(5);
    expect(yawn).toBeLessThan(0.5);
    expect(Math.max(...looks) - Math.min(...looks)).toBeLessThan(0.1);
    // Answered: its life comes back.
    rig.setQuestion(false);
    rig.setEmotion("surprised");
    let hop = 0;
    for (let i = 0; i < 60; i++) hop = Math.max(hop, Math.abs(rig.update(1 / 60).lift));
    expect(hop).toBeGreaterThan(5);
  });
});

describe("Rig mouth and Ember's own voice (re-review: the last sentence plays after the words)", () => {
  it("keeps following the voice's levels after the words have ended (setTalking(false))", () => {
    const rig = new Rig();
    rig.alive = false;
    rig.setTalking(true);
    rig.setTalking(false);
    // The last sentence plays: levels keep coming, ten a second.
    let open = 0, n = 0;
    for (let i = 0; i < 60 * 3; i++) {
      if (i % 6 === 0) rig.setTalkLevel([0.2, 0.9, 0.5, 0.8][(i / 6) % 4]);
      const p = rig.update(1 / 60);
      if (i > 30) { open += p.talk; n++; }
    }
    expect(open / n).toBeGreaterThan(0.3);
  });

  it("lets go of a level that stops coming (the voice's page closed or crashed), within about 1.5 s, and stays still", () => {
    const rig = new Rig();
    rig.alive = false;
    rig.setTalking(true);
    for (let i = 0; i < 60; i++) { if (i % 6 === 0) rig.setTalkLevel(0.8); rig.update(1 / 60); }
    rig.setTalking(false);
    // No null, no more levels.
    expect(rig.update(1 / 60).talk).toBeGreaterThan(0.3);
    const p = settle(rig, VOICE_STALE_S + 0.5);
    expect(p.talk).toBeLessThan(0.01);
    expect(settle(rig, 5).talk).toBeLessThan(0.01);
  });

  it("holds the idle float and the body's wobble still while a question is up", () => {
    const rig = new Rig();
    rig.alive = false;
    settle(rig, 2);
    rig.setQuestion(true);
    rig.setEmotion("curious");
    settle(rig, 1);
    let lift = 0, overTilt = 0;
    for (let i = 0; i < 60 * 4; i++) {
      const p = rig.update(1 / 60);
      lift = Math.max(lift, Math.abs(p.lift));
      overTilt = Math.max(overTilt, p.face.tilt - PRESETS.curious.face.tilt!);
    }
    expect(lift).toBe(0);
    expect(overTilt).toBeLessThan(0.005);
  });
});
