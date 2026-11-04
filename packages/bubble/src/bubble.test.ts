import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { announcement, bubbleFit, bubblePosition, chipLabel, growOrigin, keyHintParts, onPress, questionParts, snapToDevice, streamDelay, thoughtScrolls, titleRepeatsChip, BUBBLE_CSS, BUBBLE_LABEL, MIN_BUBBLE_WIDTH, RISKY_TAG, STREAM_MS, SUGGEST_CAPTION, type BubbleView } from "./bubble";

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

describe("titleRepeatsChip (review #21)", () => {
  it("says a title is the chip's own word again, so the header doesn't read 'Thinking  Thinking…'", () => {
    expect(titleRepeatsChip("Thinking…", chipLabel("thinking", true))).toBe(true);
    expect(titleRepeatsChip("Listening…", chipLabel("listening", true))).toBe(true);
    expect(titleRepeatsChip("showing you", chipLabel("guiding", false))).toBe(true);
    expect(titleRepeatsChip("Checking the clock", chipLabel("thinking", true))).toBe(false);
    expect(titleRepeatsChip("Ember", chipLabel("idle", false))).toBe(false);
    expect(titleRepeatsChip("", chipLabel("idle", false))).toBe(false);
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

describe("announcement: where it is, when not this computer (review #13)", () => {
  const view = (v: Partial<BubbleView>): BubbleView => ({ visible: true, mood: "idle", title: "Ember", thought: "", streaming: false, ...v });

  it("names the computer a question, a problem or an answer comes from", () => {
    expect(announcement(view({ mood: "attention", title: "May I?", thought: "Click “Save” in gedit?", where: "on build-01" })))
      .toBe("Ember needs you, on build-01: May I? Click “Save” in gedit?");
    expect(announcement(view({ mood: "error", title: "Check disk", thought: "It didn't finish.", where: "in Ubuntu (WSL)" })))
      .toBe("Ember has a problem, in Ubuntu (WSL): Check disk. It didn't finish.");
    expect(announcement(view({ mood: "done", title: "Check disk", thought: "12 GB free.", where: "on build-01" }))).toBe("Ember says, on build-01: 12 GB free.");
    expect(announcement(view({ mood: "attention", title: "May I?", thought: "Click “Save”?", where: "  " }))).toBe("Ember needs you: May I? Click “Save”?");
  });
});

describe("announcement: how to answer a question (review #52)", () => {
  const view = (v: Partial<BubbleView>): BubbleView => ({ visible: true, mood: "attention", title: "May I?", thought: "Click “Save” in gedit?", streaming: false, ...v });

  it("reads a question's key hint after it, as its step row shows it", () => {
    expect(announcement(view({ step: "Ctrl+Alt+Y allow · Ctrl+Alt+N not now" })))
      .toBe("Ember needs you: May I? Click “Save” in gedit? Ctrl+Alt+Y allow; Ctrl+Alt+N not now.");
    expect(announcement(view({ title: "May I run a command?", thought: "On build-01: Deletes build", step: "The command is in Ember's command window: press Alt+Tab to go there." })))
      .toBe("Ember needs you: May I run a command? On build-01: Deletes build. The command is in Ember's command window: press Alt+Tab to go there.");
    // A guide's step (what it points at) is never read out: it says what it shows.
    expect(announcement(view({ mood: "guiding", title: "Ember", thought: "Open the File menu.", step: "Pointing at it" }))).toBe("Ember says: Open the File menu.");
  });

  it("reads under an answer cut short where the keyboard finds it whole (review #47)", () => {
    expect(announcement(view({ mood: "idle", title: "Ember", thought: "You have three options…", step: "Or press Ctrl+Alt+E and go to Conversation." })))
      .toBe("Ember says: You have three options… Or press Ctrl+Alt+E and go to Conversation.");
    expect(announcement(view({ mood: "idle", title: "Ember", thought: "Done.", step: null }))).toBe("Ember says: Done.");
  });

  it("reads a problem's keyboard route after it, as it is seen under its buttons (review #47)", () => {
    expect(announcement(view({ mood: "error", title: "Can't connect to build-01", thought: "The connection was refused.", step: "Or press Ctrl+Alt+E and go to Computers." })))
      .toBe("Ember has a problem: Can't connect to build-01. The connection was refused. Or press Ctrl+Alt+E and go to Computers.");
    expect(announcement(view({ mood: "error", title: "Lost build-01", thought: "The connection dropped", step: "Or press Ctrl+Alt+E and go to Computers", where: "on build-01" })))
      .toBe("Ember has a problem, on build-01: Lost build-01. The connection dropped. Or press Ctrl+Alt+E and go to Computers.");
    expect(announcement(view({ mood: "error", title: "Something went wrong", thought: "The model is busy.", step: null })))
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

  it("an answer opened in full that fits nowhere clear goes beside Ember over the cards, never over Ember (review #25)", () => {
    const view = { width: 1280, height: 720 };
    const size = 64;
    const c = { x: 1100, y: 360 };
    const anchor = { x: c.x, y: c.y + size * 0.4 };
    const cards = { x: 920, y: 520, width: 348, height: 124 };
    const handle = { x: 1068, y: 652, width: 200, height: 56 };
    const box = { width: 410, height: 391 };
    const p = bubblePosition(anchor, box, view, size, [cards, handle]);
    const e = emberBox(c, size);
    expect(p.x < e.right && p.x + box.width > e.left && p.y < e.bottom && p.y + box.height > e.top, JSON.stringify(p)).toBe(false);
    expect(bubbleFit(anchor, box, view, size, [cards, handle], () => box.height)).toBeNull();
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

  it("lets a question's or a problem's title wrap onto a second line rather than lose its end (review #16)", () => {
    expect(BUBBLE_CSS).toMatch(/\.ember-bubble:is\(\[data-mood="attention"\], \[data-mood="error"\]\) \.eb-title \{[^}]*white-space: normal;[^}]*-webkit-line-clamp: 2;/);
    // A title hidden because it repeats the chip stays hidden in those moods too (it comes after, as specific).
    const wrap = BUBBLE_CSS.indexOf('.ember-bubble:is([data-mood="attention"], [data-mood="error"]) .eb-title {');
    expect(BUBBLE_CSS.indexOf(".ember-bubble .eb-title[hidden] { display: none; }")).toBeGreaterThan(wrap);
  });

  it("puts a problem's or an answer's keyboard route quietly under its buttons, as a question's key hint (review #47)", () => {
    expect(BUBBLE_CSS).toMatch(/\.ember-bubble:is\(\[data-mood="attention"\], \[data-mood="error"\], \[data-mood="idle"\]\) \.eb-step \{ order: 1;/);
    expect(BUBBLE_CSS).toMatch(/\.ember-bubble:is\(\[data-mood="attention"\], \[data-mood="error"\], \[data-mood="idle"\]\) \.eb-step-arrow \{ display: none; \}/);
  });

  it("shows all of a problem as of a question: up to ten lines, then it scrolls (review #17)", () => {
    expect(BUBBLE_CSS).toMatch(/\.ember-bubble:is\(\[data-mood="attention"\], \[data-mood="error"\]\):not\(\[data-streaming="true"\]\) \.eb-thought \{[^}]*max-height: 10lh; overflow-y: auto;[^}]*pointer-events: auto;/);
    expect(thoughtScrolls({ mood: "error", expanded: false, streaming: false })).toBe(true);
    expect(thoughtScrolls({ mood: "attention", expanded: false, streaming: false })).toBe(true);
    expect(thoughtScrolls({ mood: "idle", expanded: true, streaming: false })).toBe(true);
    expect(thoughtScrolls({ mood: "idle", expanded: false, streaming: false })).toBe(false);
    expect(thoughtScrolls({ mood: "error", expanded: false, streaming: true })).toBe(false);
  });

  it("shows the last line of a long answer opened with Read all (no overflow fade over its scroll box)", () => {
    // The fade on finished text that overflows is (0,4,0): the expanded rule undoes it only as specific and later.
    const fade = BUBBLE_CSS.indexOf('.ember-bubble:not([data-streaming="true"]) .eb-thought[data-overflow="true"] {');
    const expanded = /\.ember-bubble\[data-expanded="true"\]:not\(\[data-streaming="true"\]\) \.eb-thought \{[^}]*mask-image: none;/.exec(BUBBLE_CSS);
    expect(fade).toBeGreaterThan(0);
    expect(expanded?.index).toBeGreaterThan(fade);
  });
});

describe("onPress: release inside one unchanged control", () => {
  class Press extends Event {
    readonly pointerId = 7;
    readonly isPrimary = true;
    constructor(type: string, readonly clientX = 25, readonly clientY = 20, readonly button = 0, readonly detail = 1) { super(type); }
  }
  function control() {
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    let captured = false;
    let rect = { x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 };
    const b = Object.assign(new EventTarget(), {
      ownerDocument: doc, isConnected: true, hidden: false, textContent: "Allow", disabled: false,
      closest: () => null, hasAttribute: () => b.disabled, getAttribute: () => null,
      getBoundingClientRect: () => ({ ...rect }),
      setPointerCapture: () => { captured = true; }, hasPointerCapture: () => captured,
      releasePointerCapture: () => { captured = false; },
    });
    let count = 0;
    onPress(b as unknown as HTMLElement, () => count++);
    return { b, doc, count: () => count, captured: () => captured, move: () => { rect = { ...rect, x: 20, left: 20, right: 120 }; } };
  }
  it("captures down, activates on release inside, and suppresses the following mouse click", () => {
    const c = control();
    c.b.dispatchEvent(new Press("pointerdown"));
    expect(c.count()).toBe(0);
    expect(c.captured()).toBe(true);
    c.b.dispatchEvent(new Press("pointerup"));
    expect(c.count()).toBe(1);
    expect(c.captured()).toBe(false);
    c.b.dispatchEvent(new Press("click"));
    expect(c.count()).toBe(1);
  });
  it("allows dragging outside then back inside, and cancels a release outside", () => {
    const c = control();
    c.b.dispatchEvent(new Press("pointerdown"));
    c.b.dispatchEvent(new Press("pointermove", 200));
    c.b.dispatchEvent(new Press("pointerup"));
    expect(c.count()).toBe(1);
    c.b.dispatchEvent(new Press("pointerdown"));
    c.b.dispatchEvent(new Press("pointerup", 200));
    c.b.dispatchEvent(new Press("click"));
    expect(c.count()).toBe(1);
  });
  for (const event of ["pointercancel", "lostpointercapture"]) it(`cancels ${event}`, () => {
    const c = control();
    c.b.dispatchEvent(new Press("pointerdown"));
    c.b.dispatchEvent(new Press(event));
    c.b.dispatchEvent(new Press("pointerup"));
    expect(c.count()).toBe(0);
  });
  it("cancels a hidden page even if shown again before release", () => {
    const c = control();
    c.b.dispatchEvent(new Press("pointerdown"));
    c.doc.visibilityState = "hidden"; c.doc.dispatchEvent(new Event("visibilitychange"));
    c.doc.visibilityState = "visible";
    c.b.dispatchEvent(new Press("pointerup"));
    expect(c.count()).toBe(0);
  });
  for (const change of ["moved", "removed", "hidden", "disabled", "changed"] as const) it(`cancels a ${change} control`, () => {
    const c = control(); c.b.dispatchEvent(new Press("pointerdown"));
    if (change === "moved") c.move();
    if (change === "removed") c.b.isConnected = false;
    if (change === "hidden") c.b.hidden = true;
    if (change === "disabled") c.b.disabled = true;
    if (change === "changed") c.b.textContent = "Allow another question";
    c.b.dispatchEvent(new Press("pointerup"));
    expect(c.count()).toBe(0);
  });
  it("preserves one keyboard activation and refuses orphan/right mouse clicks", () => {
    const c = control();
    c.b.dispatchEvent(new Press("click", 0, 0, 0, 0));
    expect(c.count()).toBe(1);
    c.b.dispatchEvent(new Press("click"));
    c.b.dispatchEvent(new Press("pointerdown", 25, 20, 2));
    c.b.dispatchEvent(new Press("pointerup", 25, 20, 2));
    expect(c.count()).toBe(1);
  });
});

describe("the bubble's hierarchy (UI audit #9)", () => {
  it("sets a question's decision apart from what it does and from the task it is part of", () => {
    expect(questionParts("Borrow your mouse to click the “Send” button in Mail? It sends “Q3” to Priya Shah.\nYour task: Email Priya")).toEqual({
      ask: "Borrow your mouse to click the “Send” button in Mail?", rest: "It sends “Q3” to Priya Shah.", task: "Your task: Email Priya",
    });
    expect(questionParts("Click “Save”?")).toEqual({ ask: "Click “Save”?", rest: "", task: "" });
    // A question mark inside a quoted name isn't the end of the decision.
    expect(questionParts("Click “Why?” in Help?")).toEqual({ ask: "Click “Why?” in Help?", rest: "", task: "" });
    // Not a question: shown as it is.
    expect(questionParts("Pushing feature-x to origin, as you asked.")).toBeNull();
  });

  it("shows the keys a question names as keycaps beside their words, and any other step as words", () => {
    expect(keyHintParts("Ctrl+Alt+Y allow · Ctrl+Alt+N not now")).toEqual([{ keys: ["Ctrl", "Alt", "Y"], word: "allow" }, { keys: ["Ctrl", "Alt", "N"], word: "not now" }]);
    expect(keyHintParts("Control+Shift+Command+Y allow")).toEqual([{ keys: ["Control", "Shift", "Command", "Y"], word: "allow" }]);
    expect(keyHintParts("Or press Ctrl+Alt+E and go to Conversation.")).toBeNull();
    expect(keyHintParts("Clicking “Rename”")).toBeNull();
    expect(keyHintParts(null)).toBeNull();
  });

  it("says a risky question is one before anything else, as its tag shows it", () => {
    const v: BubbleView = { visible: true, mood: "attention", title: "May I?", thought: "Click “Send”?", streaming: false, step: "Ctrl+Alt+Y allow · Ctrl+Alt+N not now", risky: true };
    expect(announcement(v)).toBe(`Ember needs you: ${RISKY_TAG}. May I? Click “Send”? Ctrl+Alt+Y allow; Ctrl+Alt+N not now.`);
    expect(announcement({ ...v, risky: false })).toBe("Ember needs you: May I? Click “Send”? Ctrl+Alt+Y allow; Ctrl+Alt+N not now.");
  });

  it("makes the state a tag (a tint behind its word), never a pulse on a question, and a risky Allow that doesn't stand out", () => {
    expect(BUBBLE_CSS).toMatch(/\.eb-chip \{[^}]*border-radius: var\(--r-capsule, 999px\);[^}]*background: color-mix\(in srgb, var\(--eb-mood\) 16%, transparent\);/);
    const pulse = /([^{}]+)\{\s*animation: eb-pulse/.exec(BUBBLE_CSS)![1];
    expect(/:is\(([^)]*)\)/.exec(pulse)![1]).not.toContain('"attention"');
    expect(pulse).toContain(':not([data-mood="attention"])');
    expect(BUBBLE_CSS).toMatch(/\.ember-bubble\[data-risky="true"\] \.eb-actions button\.eb-primary \{ background: rgba\(255, 255, 255, 0\.08\);/);
  });

  it("locks its brackets on a question once (180 ms), never in Calm, and keeps them out of the clickable parts", () => {
    expect(BUBBLE_CSS).toMatch(/\.ember-bubble\[data-mood="attention"\]:not\(\[data-hidden="true"\]\) \.eb-lock \{ display: block; animation: eb-lock 180ms var\(--spring-snappy, ease-out\) 1; \}/);
    expect(BUBBLE_CSS).toMatch(/\.eb-lock \{[^}]*pointer-events: none;/);
    expect(BUBBLE_CSS).toContain("html.calm .eb-lock { animation: none !important; }");
    expect(BUBBLE_CSS).toMatch(/@keyframes eb-lock \{ from \{ opacity: 0; scale: 1\.05; \} \}/);
  });
});

describe("the bubble on the screen's pixels and in motion (Liquid Glass workstream)", () => {
  it("sits on whole device pixels at 125 % and 150 %, not on whole CSS px half a device pixel apart", () => {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      for (const v of [10.3, 101.7, 333.33, 47.5]) expect(Number.isInteger(Math.round(snapToDevice(v, dpr) * dpr * 1e6) / 1e6), `${v} at ${dpr}`).toBe(true);
    }
    expect(snapToDevice(10.6, 1.5)).toBeCloseTo(10.6667, 3);
    expect(snapToDevice(10.3, 0)).toBe(10);
  });

  it("grows out of Ember: from the point of the bubble nearest Ember's base", () => {
    // Below-right of Ember: from near its top left.
    expect(growOrigin({ x: 400, y: 300 }, { x: 378, y: 318 }, { width: 300, height: 120 })).toEqual({ x: 22, y: 0 });
    // Above Ember: from its bottom edge.
    expect(growOrigin({ x: 400, y: 300 }, { x: 378, y: 120 }, { width: 300, height: 120 })).toEqual({ x: 22, y: 120 });
    // Ember to its right: from its right edge.
    expect(growOrigin({ x: 800, y: 300 }, { x: 420, y: 250 }, { width: 300, height: 120 })).toEqual({ x: 300, y: 50 });
  });

  it("draws streamed text at most 15 times a second, however fast it arrives (R8)", () => {
    expect(1000 / STREAM_MS).toBeLessThanOrEqual(15.2);
    expect(streamDelay(-Infinity, 5)).toBe(0);
    expect(streamDelay(1000, 1010)).toBe(STREAM_MS - 10);
    expect(streamDelay(1000, 1000 + STREAM_MS)).toBe(0);
    // A token every 10 ms for a second: drawn at most 16 times (the first at once, then once a gap).
    let drawn = -Infinity, draws = 0, due = -1;
    for (let t = 0; t <= 1000; t += 10) {
      if (due >= 0 && t >= due) { drawn = due; draws++; due = -1; }
      const wait = streamDelay(drawn, t);
      if (wait === 0 && due < 0) { drawn = t; draws++; } else if (due < 0) due = t + wait;
    }
    expect(draws).toBeLessThanOrEqual(16);
  });

  it("brings a question in by its opacity alone, and leaves faster than it comes", () => {
    expect(BUBBLE_CSS).toContain('.ember-bubble[data-mood="attention"], .ember-bubble[data-mood="attention"][data-hidden="true"] { translate: none; scale: none; }');
    expect(BUBBLE_CSS).toMatch(/\.ember-bubble\[data-hidden="true"\] \{[^}]*transition-duration: 140ms, 0s, 140ms, 140ms; transition-timing-function: ease-in;/);
  });
});

describe("Ember's suggestions under an answer (review of #145)", () => {
  const SOURCE = fs.readFileSync(path.join(__dirname, "bubble.ts"), "utf8");
  it("puts their row in the bubble's clickable area, or the overlay would never take a click on them", () => {
    expect(SOURCE).toContain("if (!this.suggest.hidden) hot.push(rel(this.suggest));");
    // bubble-motion-live.test.ts checks it in a real Chromium: interactiveRects() covers the row.
  });

  it("gives each chip a real edge in a contrast theme, and a quiet look otherwise (never the accent, 24 px)", () => {
    const forced = BUBBLE_CSS.slice(BUBBLE_CSS.indexOf("@media (forced-colors: active)"));
    expect(forced).toContain(".eb-suggest button { border: 1px solid ButtonText; }");
    expect(forced).toContain(".eb-suggest button:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }");
    const chip = /\.eb-suggest button \{[^}]*\}/.exec(BUBBLE_CSS)![0];
    expect(chip).toContain("min-height: calc(24px * var(--text-scale, 1));");
    expect(chip).not.toContain("--accent");
  });

  it("names the group by its visible caption, once (aria-labelledby, not a second label)", () => {
    expect(SUGGEST_CAPTION).toBe("Ember suggests");
    expect(SOURCE).toContain('this.suggest.setAttribute("aria-labelledby", capId);');
    expect(SOURCE).not.toContain('this.suggest.setAttribute("aria-label"');
  });
});
