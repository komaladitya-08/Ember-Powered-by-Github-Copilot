import { describe, expect, it } from "vitest";
import { OutputBusy } from "../../app/renderer/mic/output-watch";

describe("whether other sound is playing (Windows' output level, in a conversation)", () => {
  const watch = () => { const told: boolean[] = []; return { told, busy: new OutputBusy(on => told.push(on)) }; };

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
