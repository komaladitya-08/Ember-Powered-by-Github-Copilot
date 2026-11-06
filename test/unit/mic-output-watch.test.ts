import { describe, expect, it } from "vitest";
import { OutputBusy } from "../../app/renderer/mic/output-watch";

describe("whether other sound is playing (Windows' output level, in a conversation)", () => {
  const watch = () => { const told: boolean[] = []; return { told, busy: new OutputBusy(on => told.push(on)) }; };

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

  it("knows nothing once the watch stops", () => {
    const { told, busy } = watch();
    busy.look(0.2, false, 0);
    busy.reset();
    expect(told).toEqual([true, false]);
  });
});
