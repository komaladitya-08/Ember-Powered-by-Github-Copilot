import { describe, it, expect } from "vitest";
import { announcement, bubbleFit, bubblePosition, chipLabel, onPress, BUBBLE_CSS, BUBBLE_LABEL, MIN_BUBBLE_WIDTH, type BubbleView } from "./bubble";

describe("chipLabel", () => {
  it("says Answering while an answer streams, Ready once it is done", () => {
    expect(chipLabel("idle", true)).toBe("Answering");
    expect(chipLabel("idle", false)).toBe("Ready");
    expect(chipLabel("thinking", true)).toBe("Thinking");
  });

  it("calls an error a Problem", () => {
    expect(chipLabel("error", false)).toBe("Problem");
    expect(Object.values(BUBBLE_LABEL)).not.toContain("Stuck");
  });
});

describe("announcement", () => {
  const view = (v: Partial<BubbleView>): BubbleView => ({ visible: true, mood: "idle", title: "Cinder", thought: "", streaming: false, ...v });

  it("says a finished answer once, as the character", () => {
    expect(announcement(view({ thought: "Night Light is on." }), "Cinder")).toBe("Cinder says: Night Light is on.");
    expect(announcement(view({ mood: "done", title: "Done", thought: "" }), "Cinder")).toBe("Cinder says: Done");
  });

  it("stays quiet while text streams, while Ember works, and while hidden", () => {
    expect(announcement(view({ thought: "Night Li", streaming: true }))).toBe("");
    expect(announcement(view({ mood: "thinking", thought: "Let me look…" }))).toBe("");
    expect(announcement(view({ mood: "acting", thought: "Clicking" }))).toBe("");
    expect(announcement(view({ visible: false, thought: "Hello" }))).toBe("");
  });

  it("reads a whole question with its title", () => {
    expect(announcement(view({ mood: "attention", title: "May I?", thought: "Type “Hi Ana” into Thunderbird?" }), "Cinder"))
      .toBe("Cinder needs you: May I? Type “Hi Ana” into Thunderbird?");
    expect(announcement(view({ mood: "error", title: "Something went wrong", thought: "The model is busy." })))
      .toBe("Ember has a problem: Something went wrong. The model is busy.");
  });
});

describe("bubblePosition", () => {
  const screen = { width: 1280, height: 800 };
  /** Ember's body and the emote over its head, as bubblePosition keeps clear of them. */
  const emberBox = (c: { x: number; y: number }, size: number) =>
    ({ left: c.x - size * 0.75, right: c.x + size * 0.75, top: c.y - size * 1.1, bottom: c.y + size * 0.6 });
  const overlaps = (p: { x: number; y: number }, box: { width: number; height: number }, c: { x: number; y: number }, size: number) => {
    const e = emberBox(c, size);
    return p.x < e.right && p.x + box.width > e.left && p.y < e.bottom && p.y + box.height > e.top;
  };
  const inside = (p: { x: number; y: number }, box: { width: number; height: number }) =>
    p.x >= 8 && p.y >= 8 && p.x + box.width <= screen.width - 8 && p.y + box.height <= screen.height - 8;

  it("sits below-right of Ember with room to spare", () => {
    expect(bubblePosition({ x: 400, y: 324 }, { width: 300, height: 100 }, screen, 60)).toEqual({ x: 378, y: 342 });
  });

  it("keeps the old placement when Ember's size is not given", () => {
    expect(bubblePosition({ x: 100, y: 100 }, { width: 300, height: 100 }, screen)).toEqual({ x: 78, y: 118 });
    expect(bubblePosition({ x: 1250, y: 780 }, { width: 300, height: 100 }, screen)).toEqual({ x: 972, y: 628 });
  });

  it("never covers Ember in the bottom-right corner", () => {
    const size = 60, c = { x: 1240, y: 760 }, box = { width: 300, height: 120 };
    const p = bubblePosition({ x: c.x, y: c.y + size * 0.4 }, box, screen, size);
    expect(overlaps(p, box, c, size)).toBe(false);
    expect(inside(p, box)).toBe(true);
  });

  it("goes beside Ember when neither below nor above fits", () => {
    const size = 60, c = { x: 640, y: 200 }, box = { width: 300, height: 260 }, short = { width: 1280, height: 400 };
    const p = bubblePosition({ x: c.x, y: c.y + size * 0.4 }, box, short, size);
    expect(p.x).toBeGreaterThanOrEqual(c.x + size * 0.75);
    expect(overlaps(p, box, c, size)).toBe(false);
  });

  it("stays on screen and off Ember wherever Ember is", () => {
    for (const size of [40, 60, 110]) {
      for (const h of [60, 160, 280]) {
        const box = { width: 300, height: h };
        for (let x = size; x <= screen.width - size; x += 37) {
          for (let y = size; y <= screen.height - size; y += 29) {
            const p = bubblePosition({ x, y: y + size * 0.4 }, box, screen, size);
            expect(inside(p, box), `${size} ${h} at ${x},${y}`).toBe(true);
            expect(overlaps(p, box, { x, y }, size), `${size} ${h} at ${x},${y}`).toBe(false);
          }
        }
      }
    }
  });

  describe("keeping off the handle and the task cards", () => {
    const handle = { x: 1068, y: 732, width: 200, height: 56 };
    const hits = (p: { x: number; y: number }, box: { width: number; height: number }, r: typeof handle) =>
      p.x < r.x + r.width && p.x + box.width > r.x && p.y < r.y + r.height && p.y + box.height > r.y;

    it("places exactly as before when there is nothing to avoid", () => {
      expect(bubblePosition({ x: 400, y: 324 }, { width: 300, height: 100 }, screen, 60, [])).toEqual({ x: 378, y: 342 });
    });

    it("slides past the handle instead of covering it", () => {
      const size = 60, c = { x: 1080, y: 560 }, box = { width: 300, height: 170 };
      const plain = bubblePosition({ x: c.x, y: c.y + size * 0.4 }, box, screen, size);
      expect(hits(plain, box, handle)).toBe(true);
      const p = bubblePosition({ x: c.x, y: c.y + size * 0.4 }, box, screen, size, [handle]);
      expect(hits(p, box, handle)).toBe(false);
      expect(overlaps(p, box, c, size)).toBe(false);
      expect(inside(p, box)).toBe(true);
    });

    it("never covers the handle, Ember or the screen edge anywhere near the corner", () => {
      for (const size of [40, 60, 110]) {
        const box = { width: 300, height: 140 };
        for (let x = 700; x <= screen.width - size; x += 23) {
          for (let y = 420; y <= screen.height - size; y += 19) {
            const p = bubblePosition({ x, y: y + size * 0.4 }, box, screen, size, [handle]);
            expect(inside(p, box), `${size} at ${x},${y}`).toBe(true);
            expect(overlaps(p, box, { x, y }, size), `${size} at ${x},${y}`).toBe(false);
            expect(hits(p, box, handle), `${size} at ${x},${y}`).toBe(false);
          }
        }
      }
    });
  });
});

describe("bubbleFit: room beside the settings window", () => {
  /** Ember beside the window (as main puts it while the user works in settings), the bubble's own size, and the handle. */
  const setup = (screen: { width: number; height: number }, size = 60) => {
    const win = { x: Math.round((screen.width - 760) / 2), y: 80, width: 760, height: Math.min(640, screen.height - 100) };
    const handle = { x: screen.width - 212, y: screen.height - 68, width: 200, height: 56 };
    const ember = { x: win.x + win.width + 10 + size * 0.6, y: win.y + 90 };
    return { win, handle, ember, size, anchor: { x: ember.x, y: ember.y + size * 0.4 } };
  };
  const box = { width: 326, height: 120 };
  /** Wrapping onto more lines as it narrows. */
  const heightAt = (w: number) => Math.ceil(box.height * box.width / w);
  const covers = (p: { x: number; y: number; width: number; height: number }, r: { x: number; y: number; width: number; height: number }) =>
    p.x < r.x + r.width && p.x + p.width > r.x && p.y < r.y + r.height && p.y + p.height > r.y;
  const onEmber = (p: { x: number; y: number; width: number; height: number }, c: { x: number; y: number }, size: number) =>
    covers(p, { x: c.x - size * 0.75, y: c.y - size * 1.1, width: size * 1.5, height: size * 1.7 });

  it("narrows to fit beside the window when its own width doesn't (1280 × 800)", () => {
    const screen = { width: 1280, height: 800 };
    const { win, handle, ember, size, anchor } = setup(screen);
    expect(bubbleFit(anchor, box, screen, size, [win, handle])).toBeNull();
    const p = bubbleFit(anchor, box, screen, size, [win, handle], heightAt)!;
    expect(p.width).toBeLessThan(box.width);
    expect(p.width).toBeGreaterThanOrEqual(MIN_BUBBLE_WIDTH);
    expect(p.height).toBe(heightAt(p.width));
    expect(covers(p, win)).toBe(false);
    expect(covers(p, handle)).toBe(false);
    expect(onEmber(p, ember, size)).toBe(false);
    // By Ember, not across the window from it.
    expect(p.x).toBeGreaterThanOrEqual(win.x + win.width);
    expect(p.x + p.width).toBeLessThanOrEqual(screen.width - 8);
    expect(p.y + p.height).toBeLessThanOrEqual(screen.height - 8);
  });

  it("stays on Ember's side of the window even when the far side has a pixel more room", () => {
    const screen = { width: 1279, height: 799 };
    const win = { x: 260, y: 80, width: 760, height: 640 };
    const handle = { x: 1068, y: 732, width: 200, height: 56 };
    const p = bubbleFit({ x: 1066, y: 194 }, box, screen, 60, [handle, win], heightAt)!;
    expect(p.x).toBeGreaterThanOrEqual(win.x + win.width);
    expect(p.x + p.width).toBeLessThanOrEqual(screen.width - 8);
  });

  it("keeps its own width where that fits (1440 × 900) and finds no room at all on a small screen (1024 × 600)", () => {
    const wide = { width: 1440, height: 900 };
    const w = setup(wide);
    expect(bubbleFit(w.anchor, box, wide, w.size, [w.win, w.handle], heightAt)).toMatchObject({ width: box.width, height: box.height });
    // One pixel short on Ember's side: a pixel narrower there, rather than its own width across the window.
    const p = bubbleFit(w.anchor, box, { width: 1439, height: 899 }, w.size, [w.win, w.handle], heightAt)!;
    expect(p.width).toBe(box.width - 1);
    expect(p.x).toBeGreaterThanOrEqual(w.win.x + w.win.width);
    const small = { width: 1024, height: 600 };
    const s = setup(small);
    expect(bubbleFit(s.anchor, box, small, s.size, [s.win, s.handle], heightAt)).toBeNull();
  });

  it("is never over the window, the handle, Ember or the screen edge, wherever Ember is", () => {
    for (const screen of [{ width: 1280, height: 800 }, { width: 1366, height: 768 }, { width: 1440, height: 900 }]) {
      const { win, handle } = setup(screen);
      for (const size of [40, 60, 110]) {
        for (let x = size; x <= screen.width - size; x += 41) {
          for (let y = size; y <= screen.height - size; y += 37) {
            const p = bubbleFit({ x, y: y + size * 0.4 }, box, screen, size, [win, handle], heightAt);
            if (!p) continue;
            const at = `${screen.width} ${size} at ${x},${y}`;
            expect(covers(p, win), at).toBe(false);
            expect(covers(p, handle), at).toBe(false);
            expect(onEmber(p, { x, y }, size), at).toBe(false);
            expect(p.x >= 8 && p.y >= 8 && p.x + p.width <= screen.width - 8 && p.y + p.height <= screen.height - 8, at).toBe(true);
            expect(p.width, at).toBeGreaterThanOrEqual(MIN_BUBBLE_WIDTH);
          }
        }
      }
    }
  });

  it("is the usual place when there is nothing in the way", () => {
    const screen = { width: 1280, height: 800 };
    expect(bubbleFit({ x: 400, y: 324 }, { width: 300, height: 100 }, screen, 60, [], heightAt)).toEqual({ x: 378, y: 342, width: 300, height: 100 });
  });
});

describe("bubble styles", () => {
  it("keeps line breaks, hides the caret unless streaming, and calms down with html.calm", () => {
    expect(BUBBLE_CSS).toMatch(/\.eb-thought \{[^}]*white-space: pre-line/);
    // Once faded out, a hidden bubble takes no clicks or keys.
    expect(BUBBLE_CSS).toMatch(/\.ember-bubble\[data-hidden="true"\] \{[^}]*visibility: hidden/);
    expect(BUBBLE_CSS).toMatch(/\.eb-thought span::after \{[^}]*display: none/);
    expect(BUBBLE_CSS).toMatch(/html\.calm \.eb-dot, html\.calm \.eb-thought span::after \{ animation: none !important; \}/);
  });
});

describe("onPress (live test: Allow ignored the first click)", () => {
  class Press extends Event { constructor(type: string, readonly button = 0, readonly detail = 1) { super(type); } }

  it("acts at the mouse's press, once: the click that follows (if it comes) does nothing more", () => {
    const b = new EventTarget() as unknown as HTMLElement;
    let n = 0;
    onPress(b, () => n++);
    b.dispatchEvent(new Press("pointerdown"));
    expect(n).toBe(1);
    b.dispatchEvent(new Press("click"));
    expect(n).toBe(1);
    // Another mouse button doesn't.
    b.dispatchEvent(new Press("pointerdown", 2));
    expect(n).toBe(1);
  });

  it("the keyboard (Enter or Space: a click with no press) still works, as does a click whose press never came", () => {
    const b = new EventTarget() as unknown as HTMLElement;
    let n = 0;
    onPress(b, () => n++);
    b.dispatchEvent(new Press("click", 0, 0));
    expect(n).toBe(1);
    b.dispatchEvent(new Press("click", 0, 1));
    expect(n).toBe(2);
  });
});
