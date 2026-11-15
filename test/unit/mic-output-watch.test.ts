import { describe, expect, it } from "vitest";
import { OutputBusy } from "../../app/renderer/mic/output-watch";

describe("whether other sound is playing (Windows' output level, while Ember may hear an answer or a request without its name)", () => {
  const watch = () => { const told: (boolean | null)[] = []; return { told, busy: new OutputBusy(on => told.push(on)) }; };

  it("doesn't take the end of Ember's own voice for other sound, in the gap between its sentences", () => {
    const { told, busy } = watch();
    busy.look(0.1, true, 1000);
    busy.look(0.1, false, 1200);
    busy.look(0.1, true, 1600);
    busy.look(0.1, true, 5000);
    expect(told).toEqual([]);
  });

  it("still finds a song that goes on after Ember stops", () => {
    const { told, busy } = watch();
    busy.look(0.1, true, 1000);
    busy.look(0.1, false, 1200);
    busy.look(0.1, false, 2200);
    expect(told).toEqual([true]);
  });


  it("says so at the first sound, and only once", () => {
    const { told, busy } = watch();
    busy.look(0, false, 0);
    busy.look(0.2, false, 200);
    busy.look(0.2, false, 400);
    expect(told).toEqual([false, true]);
  });

  it("knows a video was playing all through Ember reading its question out, when it watched before Ember spoke (owner's report of 2026-11-12)", () => {
    // Watching since a task began: the answer window opens as Ember stops, and the video is still known to be playing.
    const { told, busy } = watch();
    for (let t = 0; t < 2000; t += 200) busy.look(0.1, false, t);
    for (let t = 2000; t < 6000; t += 200) busy.look(0.2, true, t);
    for (let t = 6000; t < 8000; t += 200) busy.look(0.1, false, t);
    expect(told).toEqual([true]);
  });

  it("knows nothing yet when it began to watch as Ember spoke, until it hears what can't be Ember's own voice or a second has passed since it: what isn't known isn't taken for quiet (owner's report of 2026-11-12)", () => {
    const quiet = watch();
    for (let t = 0; t < 4000; t += 200) quiet.busy.look(0.2, true, t);
    for (let t = 4000; t < 4800; t += 200) quiet.busy.look(0, false, t);
    expect(quiet.told).toEqual([]);
    quiet.busy.look(0, false, 4800);
    expect(quiet.told).toEqual([false]);
    // A video that goes on after Ember: known as soon as its sound can't be Ember's own any more (0.4 s after its last look).
    const { told, busy } = watch();
    for (let t = 0; t < 4000; t += 200) busy.look(0.2, true, t);
    busy.look(0.1, false, 4000);
    expect(told).toEqual([]);
    busy.look(0.1, false, 4200);
    expect(told).toEqual([true]);
  });

  it("says other sound plays as soon as it hears some in the second after Ember stops: a call's “Okay.” then, over before that second is, was never seen (V2-S1)", () => {
    // The output was quiet before the question (a call whose far side listens): "quiet" stood through the read-out and the
    // second after it, and a word that ended before the first look after that second was anyone's yes.
    const { told, busy } = watch();
    for (let t = 0; t < 2000; t += 200) busy.look(0, false, t);
    for (let t = 2000; t < 4000; t += 200) busy.look(0.2, true, t);
    busy.look(0, false, 4000);
    busy.look(0.1, false, 4200); // the far side's "Okay.", 0.2 to 0.6 s after Ember's voice
    expect(told).toEqual([false, true]);
    busy.look(0.1, false, 4400);
    for (let t = 4600; t < 6800; t += 200) busy.look(0, false, t);
    expect(told).toEqual([false, true]);
    busy.look(0, false, 7000);
    expect(told).toEqual([false, true, false]);
  });

  it("says so at the second look after Ember's voice however late either look ran: a timer's callbacks run a few ms late, and that look was thrown away when it came 398 ms after the last one that found Ember speaking (voice-safety-x9-1; V2-S1)", () => {
    // A call's "Okay." 0.2 to 0.4 s after the read-out, over before the look after that: whether it was seen hung on
    // which of two timer callbacks had run later (about every other read-out: taken 12 of 25 with looks up to 4 ms late).
    for (const [lastOfEmber, first, second] of [[3, 0, 1], [1, 0, 3], [15, 0, 1], [1, 15, 0], [15, 15, 0], [0, 0, 15], [4, 1, 0], [60, 0, 0]]) {
      const { told, busy } = watch();
      for (let t = 0; t < 2000; t += 200) busy.look(0, false, t);
      for (let t = 2000; t < 3800; t += 200) busy.look(0.2, true, t);
      busy.look(0.2, true, 3800 + lastOfEmber);
      busy.look(0, false, 4000 + first);
      busy.look(0.1, false, 4200 + second); // the far side's "Okay."
      expect(told, `looks ${lastOfEmber}, ${first} and ${second} ms late`).toEqual([false, true]);
    }
  });

  it("still leaves the first look after Ember's voice out when a later one comes late: only that look may hold its last sounds", () => {
    const { told, busy } = watch();
    for (let t = 0; t < 2000; t += 200) busy.look(0, false, t);
    for (let t = 2000; t < 4000; t += 200) busy.look(0.2, true, t);
    busy.look(0.2, false, 4015); // Ember's own last sounds, the look 15 ms late
    for (let t = 4200; t < 6000; t += 200) busy.look(0, false, t + 3);
    expect(told).toEqual([false]);
  });

  it("doesn't take Ember's own voice, still in the output a moment after the page says it stopped, for that sound", () => {
    const { told, busy } = watch();
    for (let t = 0; t < 2000; t += 200) busy.look(0, false, t);
    for (let t = 2000; t < 4000; t += 200) busy.look(0.2, true, t);
    busy.look(0.2, false, 4000); // 0.2 s after the last look that found Ember speaking: its own last sounds
    for (let t = 4200; t < 6000; t += 200) busy.look(0, false, t);
    expect(told).toEqual([false]);
  });

  it("keeps what played up to Ember's voice as playing through it and until a word begun right after it has been judged, though nothing sounds at the first look then (V2-S1)", () => {
    // The far side of a call talked right up to the read-out: over Ember's voice nothing can be told, and its "Okay." may
    // be over before the watch's second look after it. Forgotten, the first look after Ember said "quiet", and that
    // "Okay." was anyone's.
    const { told, busy } = watch();
    for (let t = 0; t < 2000; t += 200) busy.look(0.1, false, t);
    for (let t = 2000; t < 4000; t += 200) busy.look(0.2, true, t);
    for (let t = 4000; t < 5000; t += 200) busy.look(0, false, t);
    expect(told).toEqual([true]);
  });

  it("lets what played before Ember's voice go 1.3 s after its last look at Ember speaking, when nothing has sounded since: a video paused before the read-out kept “other sound” on for 2.5 s after it, and the user's own prompt “Okay.” was dropped (voice-safety-x9-3)", () => {
    const { told, busy } = watch();
    for (let t = 0; t < 1600; t += 200) busy.look(0.1, false, t); // a video, paused 0.4 s before Ember reads the question out
    for (let t = 1600; t < 2000; t += 200) busy.look(0, false, t);
    for (let t = 2000; t < 4000; t += 200) busy.look(0.2, true, t);
    for (let t = 4000; t < 5200; t += 200) busy.look(0, false, t + 2);
    expect(told).toEqual([true]);
    busy.look(0, false, 5202); // 1.4 s after the last look that found Ember speaking (3800)
    expect(told).toEqual([true, false]);
  });

  it("still holds a video that goes on after Ember's voice for its 2.5 s, from its own last sound (voice-safety-x9-3)", () => {
    const { told, busy } = watch();
    for (let t = 0; t < 2000; t += 200) busy.look(0.1, false, t);
    for (let t = 2000; t < 4000; t += 200) busy.look(0.2, true, t);
    busy.look(0.2, false, 4000);
    busy.look(0.1, false, 4200); // the video's next sentence, seen by its own sound
    for (let t = 4400; t < 6600; t += 200) busy.look(0, false, t);
    expect(told).toEqual([true]);
    busy.look(0, false, 6800);
    expect(told).toEqual([true, false]);
  });

  it("holds through the gaps between a song's lines, and lets go after them", () => {
    const { told, busy } = watch();
    busy.look(0.2, false, 0);
    busy.look(0, false, 2000);
    expect(told).toEqual([true]);
    busy.look(0, false, 3000);
    expect(told).toEqual([true, false]);
  });

  it("doesn't take Ember's own voice for other sound", () => {
    const { told, busy } = watch();
    busy.look(0.2, true, 0);
    busy.look(0.2, true, 200);
    busy.look(0, false, 400);
    expect(told).toEqual([]);
  });

  it("keeps a song that was playing while Ember talks over it", () => {
    const { told, busy } = watch();
    busy.look(0.2, false, 0);
    busy.look(0.2, true, 200);
    expect(told).toEqual([true]);
  });

  it("knows nothing once the watch stops, and says so rather than that nothing plays (owner's report of 2026-11-12)", () => {
    const { told, busy } = watch();
    busy.look(0.2, false, 0);
    busy.reset();
    expect(told).toEqual([true, null]);
  });
});
