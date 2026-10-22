/**
 * Ember's own windows never reach a model as pixels (critique integration-4, design §3.10): a picture of the whole screen
 * blacks out every window of Ember's process (the command window, the prompt window, settings, the ask box, the
 * handle), but the overlay, which is hidden for the capture and lets every click through. A picture of one window already
 * blacks out whatever of Ember's lies over it. When the window stack can't be read, there is no picture of the whole
 * screen (fail closed). OS-neutral: the window system is a fake, the pixels a grey screen.
 */

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { Perception } from "../../app/main/perception";
import type { AtspiSidecar, AxWindow, Bounds } from "../../app/main/perception/sidecar";
import type { PerceptionWindows, StackedWindow, X11Image, X11Window } from "../../app/main/platform/types";
import type { Logger } from "../../app/main/logger";

const OWN = 999;
const SCREEN: Bounds = { x: 0, y: 0, width: 300, height: 200 };

const top = (id: number, pid: number, r: Bounds, title: string, wmClass = "app"): StackedWindow =>
  ({ id, client: id, pid, title, wmClass, ...r, outer: r, inner: r, overrideRedirect: false });
const win = (id: number, pid: number, title: string, wmClass: string): X11Window & { wmClass: string } =>
  ({ id, pid, title, wmClass, x: 10, y: 10, width: 200, height: 150 });

/** The user's app, Ember's command window over it, and Ember's full-screen overlay on top of everything. */
const GEDIT_FRAME: Bounds = { x: 10, y: 10, width: 200, height: 150 };
const COMMANDS: Bounds = { x: 120, y: 60, width: 80, height: 50 };
const gedit = top(1, 42, GEDIT_FRAME, "notes.txt", "gedit");
const commands = top(2, OWN, COMMANDS, "Ember commands", "ember");
const overlay = top(3, OWN, SCREEN, "Ember overlay", "ember");
const geditAx: AxWindow = { app: "gedit", pid: 42, name: "notes.txt", role: "frame", active: true, bounds: GEDIT_FRAME };

function grey(x: number, y: number, width: number, height: number): X11Image | null {
  const x0 = Math.max(SCREEN.x, x), y0 = Math.max(SCREEN.y, y);
  const x1 = Math.min(SCREEN.x + SCREEN.width, x + width), y1 = Math.min(SCREEN.y + SCREEN.height, y + height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, bgra: Buffer.alloc((x1 - x0) * (y1 - y0) * 4, 200) };
}

/** A screen whose stack is `stacks()` (asked anew each time: before the picture and again after it). */
function desktop(o: { stacks: () => StackedWindow[]; active?: X11Window & { wmClass: string }; window?: AxWindow | null }) {
  const warnings: string[] = [];
  const log = { debug() {}, info() {}, warn(event: string) { warnings.push(event); }, error() {}, child() { return log; } } as unknown as Logger;
  const sidecar = {
    readWindow: async () => ({ window: o.window ?? null, nodes: [], ms: 1 }),
    listWindows: async () => ({ windows: [] }),
    scaleElements: () => undefined,
    markSecret: async () => undefined,
    readElement: async () => ({ role: "text", name: "", states: [], bounds: null }),
    shellOverlays: async () => ({ overlays: [] }),
    secretFields: async () => ({ fields: [], complete: true, ms: 1 }),
  } as unknown as AtspiSidecar;
  const ws: PerceptionWindows = {
    stack: () => o.stacks(), activeWindow: () => o.active ?? null, focusWindow: () => o.active ?? null, clientWindows: () => [],
    capture: (x, y, w, h) => grey(x, y, w, h),
  };
  let hides = 0;
  const perception = new Perception({
    sidecar, x11: ws, log, neverLook: () => [], screenBounds: () => SCREEN, ownPid: OWN,
    hideOverlay: async () => { hides++; return () => undefined; },
  });
  return { perception, warnings, hides: () => hides };
}

/** The colour at a screen point of a picture taken of `rect`. */
async function at(data: Buffer, rect: Bounds, x: number, y: number): Promise<number[]> {
  const { data: raw, info } = await sharp(data).raw().toBuffer({ resolveWithObject: true });
  const i = ((y - rect.y) * info.width + (x - rect.x)) * info.channels;
  return [raw[i], raw[i + 1], raw[i + 2]];
}
const isBlack = (p: number[]) => p.every(c => c < 40);
const isGrey = (p: number[]) => p.every(c => c > 160 && c < 240);

describe("Ember's own windows in screenshots (critique integration-4)", () => {
  it("blacks out Ember's command window over the screen in a picture of the whole screen; the overlay is hidden, not blacked out", async () => {
    const { perception, hides } = desktop({ stacks: () => [gedit, commands, overlay], active: win(1, 42, "notes.txt", "gedit"), window: geditAx });
    const p = await perception.perceive({ image: true, scope: "screen" });
    expect(p.capture?.rect).toEqual(SCREEN);
    const data = p.capture!.data;
    expect(isBlack(await at(data, SCREEN, 160, 85))).toBe(true);
    expect(isBlack(await at(data, SCREEN, 122, 62))).toBe(true);
    // The rest of the screen shows: the overlay covers all of it, and is not masked.
    expect(isGrey(await at(data, SCREEN, 50, 50))).toBe(true);
    expect(isGrey(await at(data, SCREEN, 250, 150))).toBe(true);
    expect(isGrey(await at(data, SCREEN, 205, 85))).toBe(true);
    expect(hides()).toBe(1);
  });

  it("blacks out the command window in a picture of a window it lies over", async () => {
    const { perception } = desktop({ stacks: () => [gedit, commands, overlay], active: win(1, 42, "notes.txt", "gedit"), window: geditAx });
    const p = await perception.perceive({ image: true, scope: "window" });
    expect(p.capture?.rect).toEqual(GEDIT_FRAME);
    const data = p.capture!.data;
    expect(isBlack(await at(data, GEDIT_FRAME, 160, 85))).toBe(true);
    expect(isGrey(await at(data, GEDIT_FRAME, 50, 50))).toBe(true);
    expect(p.text).toContain("(Screenshot: parts covered by other windows are hidden.)");
  });

  it("blacks it out when the user is in one of Ember's own windows, whose picture is of the whole screen", async () => {
    // The ask box has the keyboard: there is no window of the user's to take a picture of.
    const askBox = top(4, OWN, { x: 20, y: 150, width: 100, height: 30 }, "Ask Ember", "ember");
    const { perception } = desktop({ stacks: () => [gedit, commands, askBox, overlay], active: win(4, OWN, "Ask Ember", "ember") });
    const p = await perception.perceive({ image: true, scope: "window" });
    expect(p.capture?.rect).toEqual(SCREEN);
    const data = p.capture!.data;
    expect(isBlack(await at(data, SCREEN, 160, 85))).toBe(true);
    expect(isBlack(await at(data, SCREEN, 60, 165))).toBe(true);
    expect(isGrey(await at(data, SCREEN, 50, 50))).toBe(true);
  });

  it("blacks out every window of Ember's, settings and the prompt window too, and no other app's", async () => {
    const settings = top(5, OWN, { x: 220, y: 10, width: 70, height: 60 }, "Ember", "ember");
    const prompt = top(6, OWN, { x: 220, y: 120, width: 70, height: 60 }, "Ember", "ember");
    const other = top(7, 77, { x: 0, y: 170, width: 100, height: 30 }, "Ember", "gedit");
    const { perception } = desktop({ stacks: () => [gedit, settings, prompt, other, overlay], active: win(1, 42, "notes.txt", "gedit"), window: geditAx });
    const data = (await perception.perceive({ image: true, scope: "screen" })).capture!.data;
    expect(isBlack(await at(data, SCREEN, 250, 40))).toBe(true);
    expect(isBlack(await at(data, SCREEN, 250, 150))).toBe(true);
    expect(isGrey(await at(data, SCREEN, 50, 185))).toBe(true);
  });

  it("leaves an Ember window lying under the window pictured alone: it can't show there", async () => {
    const under = top(8, OWN, { x: 100, y: 40, width: 60, height: 60 }, "Ember", "ember");
    const { perception } = desktop({ stacks: () => [under, gedit, overlay], active: win(1, 42, "notes.txt", "gedit"), window: geditAx });
    const data = (await perception.perceive({ image: true, scope: "window" })).capture!.data;
    expect(isGrey(await at(data, GEDIT_FRAME, 130, 70))).toBe(true);
  });

  it("blacks out an Ember window that opened while the picture was taken", async () => {
    let asked = 0;
    const { perception } = desktop({ stacks: () => (++asked > 1 ? [gedit, commands, overlay] : [gedit, overlay]), active: win(1, 42, "notes.txt", "gedit"), window: geditAx });
    const data = (await perception.perceive({ image: true, scope: "screen" })).capture!.data;
    expect(asked).toBeGreaterThan(1);
    expect(isBlack(await at(data, SCREEN, 160, 85))).toBe(true);
  });

  it("takes no picture of the whole screen when the window stack can't be read (fail closed)", async () => {
    const { perception, warnings } = desktop({ stacks: () => { throw new Error("BadWindow"); }, active: win(1, 42, "notes.txt", "gedit"), window: geditAx });
    const p = await perception.perceive({ image: true, scope: "screen" });
    expect(p.capture).toBeNull();
    expect(p.text).toContain("(No screenshot: Ember couldn't check where its own windows are.)");
    expect(warnings).toContain("perception.capture_declined");
  });

  it("takes no picture when the stack can't be read once it is taken", async () => {
    let asked = 0;
    const { perception } = desktop({ stacks: () => { if (++asked > 1) throw new Error("BadWindow"); return [gedit, overlay]; }, active: win(1, 42, "notes.txt", "gedit"), window: geditAx });
    const p = await perception.perceive({ image: true, scope: "screen" });
    expect(p.capture).toBeNull();
  });
});
