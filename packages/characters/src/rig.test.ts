import { describe, it, expect } from "vitest";
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
});
