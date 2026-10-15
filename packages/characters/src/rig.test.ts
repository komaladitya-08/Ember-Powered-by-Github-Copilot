import { describe, it, expect, vi, afterEach } from "vitest";
import { Rig, PRESETS, type Emotion } from "./rig";

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
