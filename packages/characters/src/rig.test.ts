import { describe, it, expect, vi, afterEach } from "vitest";
import { BLINK_CLOSE, BLINK_OPEN, NEUTRAL, RESTING_FRAME_MS, Rig, PRESETS, VOICE_STALE_S, blinkAt, blinkGap, fidgetGap, frameSeconds, restingGap, type Emotion } from "./rig";

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

describe("Rig mouth when Ember shows again (the overlay's level reset, NO_LEVEL)", () => {
  it("closes the mouth at once on the reset's null, without waiting for the stale limit", () => {
    const rig = new Rig();
    rig.alive = false;
    for (let i = 0; i < 60; i++) { if (i % 6 === 0) rig.setTalkLevel(0.9); rig.update(1 / 60); }
    rig.setTalkLevel(null);
    // Well inside VOICE_STALE_S: a quarter of a second.
    expect(settle(rig, 0.25).talk).toBeLessThan(0.05);
  });
});

describe("restingGap: how often a face at rest is drawn (rp-4)", () => {
  /** A seeded Math.random, so a run of the rig is the same every time. */
  function seeded(seed: number) {
    let x = seed;
    return vi.spyOn(Math, "random").mockImplementation(() => { x = (x * 1103515245 + 12345) % 2 ** 31; return x / 2 ** 31; });
  }
  afterEach(() => vi.restoreAllMocks());

  /** A rig awake at rest, its eyes on a still pointer, settled after a few seconds. */
  function resting() {
    const rig = new Rig();
    rig.sleepAfter = 180;
    for (let i = 0; i < 60 * 3; i++) { rig.lookAt(0.3, 0.2); rig.update(1 / 60); }
    return rig;
  }

  it("draws an awake, still Ready face about 6 times a second, not 18 (rp-4)", () => {
    seeded(7);
    const rig = resting();
    // Waits for a moment when nothing passes (no blink or fidget under way).
    for (let i = 0; i < 600 && !(rig.motion === "still" && rig.nextChange() > 0.2); i++) { rig.lookAt(0.3, 0.2); rig.update(1 / 60); }
    expect(rig.motion).toBe("still");
    expect(restingGap(rig, 55)).toBeGreaterThanOrEqual(150);
    expect(restingGap(rig, 55)).toBeLessThanOrEqual(RESTING_FRAME_MS);
  });

  it("wakes in time for the next blink, fidget or doze rather than start it late (rp-4)", () => {
    seeded(11);
    const rig = resting();
    for (let i = 0; i < 600 && !(rig.motion === "still" && rig.nextChange() < 0.1 && rig.nextChange() > 0.06); i++) { rig.lookAt(0.3, 0.2); rig.update(1 / 60); }
    expect(rig.nextChange()).toBeLessThan(0.1);
    expect(restingGap(rig, 55)).toBeLessThan(100);
    // Never more often than the page's own resting rate.
    expect(restingGap(rig, 55)).toBeGreaterThanOrEqual(55);
  });

  it("keeps the page's own rate for a face that talks, blinks, moves, shows an emote or isn't Ready (rp-4)", () => {
    seeded(3);
    const talking = resting();
    talking.setTalking(true);
    expect(restingGap(talking, 55)).toBe(55);
    const thinking = resting();
    thinking.setEmotion("thinking");
    for (let i = 0; i < 60 * 3; i++) thinking.update(1 / 60);
    expect(restingGap(thinking, 55)).toBe(55);
    const pointing = resting();
    pointing.setGesture("point");
    for (let i = 0; i < 60; i++) pointing.update(1 / 60);
    expect(restingGap(pointing, 55)).toBe(55);
    const blinking = resting();
    for (let i = 0; i < 600 && blinking.motion !== "gentle"; i++) blinking.update(1 / 60);
    expect(restingGap(blinking, 55)).toBe(55);
  });

  /**
   * The overlay's drawing at awake rest for two simulated minutes, the pointer still: brisk at once, gentle every 22 ms,
   * and still every 55 ms ("before" this change) or at restingGap's gap ("now"); "every" draws each 60 fps frame.
   */
  function overlayAtRest(how: "every" | "before" | "now") {
    seeded(5);
    const rig = resting();
    const t0 = rig.update(0).t;
    let draws = 0, blinks = 0, wasShut = false, last = 0, planned = 0, at = 0;
    const until = 120_000;
    while (at < until) {
      const now = Math.ceil(at / (1000 / 60)) * (1000 / 60);
      const dt = how === "now" ? frameSeconds(now - last, planned) : Math.min((now - last) / 1000, 0.1);
      last = now;
      rig.lookAt(0.3, 0.2);
      const shut = rig.update(dt).face.open < 0.6 * NEUTRAL.open;
      draws++;
      if (shut && !wasShut) blinks++;
      wasShut = shut;
      const m = rig.motion;
      const rest = m !== "still" ? 0 : how === "now" ? restingGap(rig, 55) : 55;
      planned = rest > 55 ? rest : 0;
      at = now + (how === "every" ? 0 : m === "brisk" ? 0 : m === "gentle" ? 22 : rest) + 1;
    }
    return { perSecond: draws / (until / 1000), blinks, seconds: rig.update(0).t - t0 };
  }

  it("counts the eyes as still once what is left of their travel is well under a pixel, not for a quarter of a second more (rp-4)", () => {
    seeded(13);
    const rig = resting();
    // A moment with nothing planned for a while (no blink, fidget or saccade due), then the eyes jump a long way.
    for (let i = 0; i < 1200 && !(rig.motion === "still" && rig.nextChange() > 1.5); i++) { rig.lookAt(0.3, 0.2); rig.update(1 / 60); }
    expect(rig.nextChange()).toBeGreaterThan(1.5);
    let t = 0, at: { x: number; y: number } | null = null, stillAfter = 0;
    for (; t < 1.2; t += 1 / 60) {
      rig.lookAt(-0.7, -0.4);
      const pose = rig.update(1 / 60);
      if (!at && t > 0.05 && rig.motion === "still") { at = pose.look; stillAfter = t; }
    }
    const end = rig.update(0).look;
    expect(at).not.toBeNull();
    // Before, the soft spring's last crawl kept it "gentle" (drawn at the lively rate) until about 0.42 s.
    expect(stillAfter).toBeLessThan(0.34);
    // What it still moves then: under a fiftieth of a look unit, a tenth of a pixel at Ember's size.
    expect(Math.hypot(end.x - at!.x, end.y - at!.y)).toBeLessThan(0.02);
  });

  /**
   * The handle's drawing at awake rest past the first minute, as handle/main.ts paces it (brisk at once, gentle every
   * 33 ms, a still face restingGap's), never seeing the pointer (it isn't over the handle).
   */
  function handleAtRest() {
    seeded(5);
    const rig = new Rig();
    let draws = 0, blinks = 0, wasShut = false, last = 0, planned = 0, at = 0;
    while (at < 160_000) {
      const now = Math.ceil(at / (1000 / 60)) * (1000 / 60);
      const dt = frameSeconds(now - last, planned);
      last = now;
      const shut = rig.update(dt).face.open < 0.6 * NEUTRAL.open;
      if (now >= 70_000) { draws++; if (shut && !wasShut) blinks++; }
      wasShut = shut;
      const m = rig.motion;
      const gap = m === "brisk" ? 0 : m === "gentle" ? 33 : restingGap(rig, 66);
      planned = gap > 66 ? gap : 0;
      at = now + gap + 1;
    }
    return { perSecond: draws / 90, blinks };
  }

  it("a simulated handle that can't see the pointer draws its idle glances' last crawl less often, and keeps blinking (rp-4)", () => {
    const now = handleAtRest();
    // 13.0 a second before (the live handle drew 13.2-15.4); 11.5 now.
    expect(now.perSecond).toBeLessThan(12);
    // A blink every 2.5-5 s: at least 18 in the 90 s, each drawn shut.
    expect(now.blinks).toBeGreaterThanOrEqual(18);
  });

  it("a simulated overlay at awake rest draws at most 13 times a second, not 19, and misses no blink (rp-4)", () => {
    const every = overlayAtRest("every"), before = overlayAtRest("before"), now = overlayAtRest("now");
    expect(before.perSecond).toBeGreaterThan(18);
    expect(now.perSecond).toBeLessThanOrEqual(13);
    // Each blink a 60 fps drawing shows is drawn shut at least once.
    expect(now.blinks).toBeGreaterThanOrEqual(every.blinks);
    // Its clock keeps real time: blinks, the breath and falling asleep keep their pace.
    expect(now.seconds).toBeCloseTo(120, 0);
  });
});

describe("frameSeconds", () => {
  it("lets a resting frame's time pass in full, and a stall or a page waking from rest move on 0.1 s at most (rp-4)", () => {
    expect(frameSeconds(16, 0)).toBeCloseTo(0.016);
    expect(frameSeconds(170, 160)).toBeCloseTo(0.17);
    expect(frameSeconds(5000, 160)).toBeCloseTo(0.21);
    expect(frameSeconds(5000, 0)).toBeCloseTo(0.1);
    expect(frameSeconds(5000, 0, 50)).toBeCloseTo(0.05);
    expect(frameSeconds(-3, 0)).toBe(0);
  });
});
