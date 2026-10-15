import { describe, it, expect } from "vitest";
import { announcement, bubblePosition, chipLabel, plainStream, BUBBLE_CSS, BUBBLE_LABEL, type BubbleView } from "./bubble";

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

describe("plainStream", () => {
  it("drops markdown markers, also half-arrived ones", () => {
    expect(plainStream("**Steps:**\n1. Open `Settings`\n2. Click **Background**\n- Pick an image now & enjoy"))
      .toBe("Steps:\n1. Open Settings\n2. Click Background\n• Pick an image now & enjoy");
    expect(plainStream("Here: **Ste")).toBe("Here: Ste");
    expect(plainStream("## Heading\nsome *soft* words and _more_.")).toBe("Heading\nsome soft words and more.");
    expect(plainStream("See [the docs](https://example.com/x).")).toBe("See the docs (https://example.com/x).");
  });

  it("leaves ordinary text alone", () => {
    for (const t of ["2 * 3 = 6", "file_name.txt and my_var", "5*3", "Hi Ana, thanks!"]) expect(plainStream(t)).toBe(t);
  });
});

describe("bubble styles", () => {
  it("keeps line breaks, hides the caret unless streaming, and calms down with html.calm", () => {
    expect(BUBBLE_CSS).toMatch(/\.eb-thought \{[^}]*white-space: pre-line/);
    expect(BUBBLE_CSS).toMatch(/\.eb-thought span::after \{[^}]*display: none/);
    expect(BUBBLE_CSS).toMatch(/html\.calm \.eb-dot, html\.calm \.eb-thought span::after \{ animation: none !important; \}/);
  });
});
