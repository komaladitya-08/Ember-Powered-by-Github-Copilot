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

  it("knows nothing yet when it began to watch as Ember spoke, until a second after Ember stops: what isn't known isn't taken for quiet (owner's report of 2026-11-12)", () => {
    const { told, busy } = watch();
    for (let t = 0; t < 4000; t += 200) busy.look(0.2, true, t);
    for (let t = 4000; t < 4800; t += 200) busy.look(0.1, false, t);
    expect(told).toEqual([]);
    busy.look(0.1, false, 5000);
    expect(told).toEqual([true]);
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
