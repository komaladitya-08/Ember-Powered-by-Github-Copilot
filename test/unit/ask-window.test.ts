/**
 * The ask box opens only when asked for, at once, with the keyboard (live test: once it opened on a plain click
 * into Mousepad, once so late after Ctrl+Alt+Space that the first letters went into the app).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const made = vi.hoisted(() => [] as FakeWindow[]);
/** The edit menus popped up: their items, and the popup's options (its callback runs when the menu closes). */
const menus = vi.hoisted(() => [] as { items: { role?: string; label?: string; enabled?: boolean }[]; popup?: { callback?: () => void } }[]);
interface FakeWindow {
  shown: number; focused: number; visible: boolean; ignoreMouse: boolean; handlers: Map<string, (() => void)[]>;
  bounds: { x: number; y: number; width: number; height: number }; heard: Map<string, (e: unknown, ...a: unknown[]) => void>;
  contents: Map<string, (e: unknown, ...a: unknown[]) => void>;
  webContents: { on(e: string, fn: (e: unknown, ...a: unknown[]) => void): void; send(ch: string, t: unknown): void; isLoading(): boolean };
  emit(e: string): void;
  isFocused(): boolean;
}

vi.mock("electron", () => {
  const display = { workArea: { x: 0, y: 0, width: 1280, height: 800 }, bounds: { x: 0, y: 0, width: 1280, height: 800 } };
  class BrowserWindow implements FakeWindow {
    shown = 0; focused = 0; visible = false; handlers = new Map<string, (() => void)[]>();
    bounds = { x: 0, y: 0, width: 560, height: 92 };
    heard = new Map<string, (e: unknown, ...a: unknown[]) => void>();
    contents = new Map<string, (e: unknown, ...a: unknown[]) => void>();
    webContents = {
      on: (e: string, fn: (e: unknown, ...a: unknown[]) => void) => { this.contents.set(e, fn); }, send() {}, isLoading: () => false,
      ipc: { on: (ch: string, fn: (e: unknown, ...a: unknown[]) => void) => { this.heard.set(ch, fn); } },
    };
    constructor(o: { x: number; y: number; width: number; height: number }) { made.push(this); this.bounds = { x: o.x, y: o.y, width: o.width, height: o.height }; }
    on(e: string, fn: () => void) { this.handlers.set(e, [...(this.handlers.get(e) ?? []), fn]); return this; }
    once(e: string, fn: () => void) { return this.on(e, fn); }
    emit(e: string) { for (const fn of this.handlers.get(e) ?? []) fn(); }
    setAlwaysOnTop() {}
    loadURL() { return Promise.resolve(); }
    setBounds(b: { x: number; y: number; width: number; height: number }) { this.bounds = b; }
    getBounds() { return this.bounds; }
    show() { this.shown++; this.visible = true; this.ignoreMouse = false; }
    hide() { this.visible = false; }
    focus() { this.focused++; }
    ignoreMouse = true;
    setIgnoreMouseEvents(on: boolean) { this.ignoreMouse = on; }
    isVisible() { return this.visible; }
    isFocused() { return this.visible; }
    isDestroyed() { return false; }
    destroy() {}
    getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeUInt32LE(0x3a00007, 0); return b; }
  }
  const Menu = {
    buildFromTemplate: (items: { role?: string; label?: string; enabled?: boolean }[]) => {
      const m: (typeof menus)[number] = { items };
      menus.push(m);
      return { popup: (o: { callback?: () => void }) => { m.popup = o; } };
    },
  };
  return {
    BrowserWindow, Menu,
    screen: { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getDisplayMatching: () => display, getCursorScreenPoint: () => ({ x: 10, y: 10 }) },
  };
});

const { AskWindow, MAC_SETTLE_MS, clearOfCards, roomForAnswer, stepsAsideFor } = await import("../../app/main/ask");
type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const { IDLE_BUBBLE, answerEndShown, askSuggestions, askSuggestionsComing, bubbleBoxOf } = await import("../../app/shared/overlay");

afterEach(() => { made.length = 0; menus.length = 0; vi.useRealTimers(); });

describe("the ask box", () => {
  it("made ahead of time, it opens at once when asked for and takes the keyboard through X", () => {
    const focusedX: number[] = [];
    const ask = new AskWindow({ takeFocus: xid => focusedX.push(xid) });
    ask.prepare();
    const [win] = made;
    win.emit("ready-to-show");
    // Loaded, never asked for: it stays hidden.
    expect(win.shown).toBe(0);
    ask.show({ x: 400, y: 300 });
    expect(made).toHaveLength(1);
    expect(win.shown).toBe(1);
    expect(win.focused).toBe(1);
    expect(focusedX).toEqual([0x3a00007]);
  });

  it("closed before it had loaded, it doesn't pop up later by itself", () => {
    const ask = new AskWindow();
    ask.show({ x: 400, y: 300 });
    const [win] = made;
    ask.hide();
    win.emit("ready-to-show");
    expect(win.shown).toBe(0);
  });

  it("one that took too long to load isn't shown over what the user went on to do", () => {
    vi.useFakeTimers();
    const ask = new AskWindow();
    ask.show({ x: 400, y: 300 });
    const [win] = made;
    vi.advanceTimersByTime(3000);
    win.emit("ready-to-show");
    expect(win.shown).toBe(0);
    // Asked for again, it opens now.
    ask.show({ x: 400, y: 300 });
    expect(win.shown).toBe(1);
  });

  it("hands letters typed while it opened to the box", () => {
    const sent: unknown[] = [];
    const ask = new AskWindow();
    ask.prepare();
    const [win] = made;
    win.webContents.send = (ch: string, t: unknown) => { sent.push([ch, t]); };
    win.emit("ready-to-show");
    ask.show({ x: 400, y: 300 });
    ask.typed({ text: "hello", submit: false, cancel: false });
    expect(sent).toContainEqual(["agent:ask-typed", { text: "hello", submit: false, cancel: false }]);
    ask.typed({ text: "", submit: false, cancel: false });
    expect(sent.filter(x => Array.isArray(x) && x[0] === "agent:ask-typed")).toHaveLength(1);
  });

  it("waits for X focus, not just Electron's, before it counts as having the keyboard", async () => {
    vi.useFakeTimers();
    let ours = false;
    const ask = new AskWindow({ hasFocus: () => ours });
    ask.prepare();
    const [win] = made;
    win.emit("ready-to-show");
    ask.show({ x: 400, y: 300 });
    const ready = ask.hasKeyboard(200);
    await vi.advanceTimersByTimeAsync(30);
    // Electron says focused (the window is visible), but X still has the user's app: keep holding the keys.
    ours = true;
    await vi.advanceTimersByTimeAsync(20);
    await expect(ready).resolves.toBe(true);
  });

  it("hiding the box takes the pointer off it (a leftover mapped window would steal a click into the app)", () => {
    const revealed: string[] = [];
    const ask = new AskWindow({ onReveal: s => revealed.push(s) });
    ask.prepare();
    const [win] = made;
    win.emit("ready-to-show");
    ask.show({ x: 400, y: 300 }, undefined, "hotkey");
    expect(revealed).toEqual(["hotkey"]);
    expect(win.ignoreMouse).toBe(false);
    ask.hide();
    expect(win.visible).toBe(false);
    expect(win.ignoreMouse).toBe(true);
    // A focus on the hidden box must not map it again.
    ask.focus();
    expect(win.visible).toBe(false);
  });

  it("takes clicks only on what it shows where the window system can say so, so one beside it reaches the app (companion-4)", () => {
    const shapes: { x: number; y: number; width: number; height: number }[][] = [];
    let can = true;
    const ask = new AskWindow({ shape: (_w, rects) => { shapes.push(rects.map(r => ({ ...r }))); return can; } });
    ask.prepare();
    const [win] = made;
    win.emit("ready-to-show");
    const field = { x: 8, y: 8, width: 544, height: 50 }, line = { x: 22, y: 60, width: 516, height: 23 };
    const report = (rects: unknown) => win.heard.get("agent:ask-shape")!({}, rects);
    // Said while hidden: kept for the opening (a hidden box takes no pointer at all).
    report([field, line]);
    expect(shapes).toEqual([]);
    ask.show({ x: 400, y: 300 });
    expect(win.ignoreMouse).toBe(false);
    expect(shapes.at(-1)).toEqual([field, line]);
    // What it shows changed while open (a row came or went): the region follows.
    report([field]);
    expect(shapes.at(-1)).toEqual([field]);
    // Nothing from the page that isn't a short list of boxes.
    const before = shapes.length;
    for (const bad of [null, "x", [{ x: 0, y: 0, width: 10 }], [{ ...field, width: Number.NaN }], [{ ...field, height: 0 }], Array.from({ length: 17 }, () => field)]) report(bad);
    expect(shapes.length).toBe(before);
    // Hidden: the pointer off it, as before; reports wait for the next opening.
    ask.hide();
    expect(win.ignoreMouse).toBe(true);
    report([field, line]);
    expect(shapes.length).toBe(before);
    // Where the window system can't shape it (Windows, macOS), the whole box takes clicks, as it always did.
    can = false;
    ask.show({ x: 400, y: 300 });
    expect(win.ignoreMouse).toBe(false);
  });

  it("is never shaped as an opaque panel (no compositor), which is all box", () => {
    const shapes: unknown[] = [];
    const ask = new AskWindow({ shape: (_w, rects) => { shapes.push(rects); return true; } });
    ask.setOpaque(true);
    ask.prepare();
    const [win] = made;
    win.emit("ready-to-show");
    win.heard.get("agent:ask-shape")!({}, [{ x: 8, y: 8, width: 544, height: 50 }]);
    ask.show({ x: 400, y: 300 });
    expect(shapes).toEqual([]);
  });

  it("steps aside once for a question that comes up under it while it is open, and tells main where it is (companion-c1-1)", () => {
    type Box = { x: number; y: number; width: number; height: number };
    const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    let bubble: Box | null = null;
    const told: (Box | null)[] = [];
    const ask = new AskWindow({ bubble: () => bubble, onBounds: b => told.push(b && { ...b }) });
    ask.prepare();
    const [win] = made;
    win.emit("ready-to-show");
    // Opened by Ember near the top with no bubble up: below Ember, centred (and main hears where, for the bubble to keep off).
    ask.show({ x: 687, y: 113, size: 60 });
    const opened = { ...win.bounds };
    expect(opened).toMatchObject({ x: 407, y: 149 });
    expect(told.at(-1)).toEqual(opened);
    // A task asks while the box is open, and the overlay found no room clear of it: the question is under the field.
    bubble = { x: 665, y: 155, width: 366, height: 224 };
    ask.bubbleChanged("q1:once,q1:always,q1:deny");
    expect(overlaps(win.bounds, bubble), JSON.stringify(win.bounds)).toBe(false);
    expect(told.at(-1)).toEqual(win.bounds);
    // Once for that question: it doesn't dance after a bubble that moves on.
    const aside = { ...win.bounds };
    bubble = { ...aside };
    ask.bubbleChanged("q1:once,q1:always,q1:deny");
    expect(win.bounds).toEqual(aside);
    // Other bubbles (an answer, a reminder) keep off the box themselves where they can: the box stays where it is typed in.
    bubble = { x: 100, y: 155, width: 330, height: 123 };
    ask.bubbleChanged(null);
    expect(win.bounds).toEqual(aside);
    // Closed: main hears that there is nothing to keep off.
    ask.hide();
    expect(told.at(-1)).toBeNull();
    ask.bubbleChanged("q2:once,q2:deny");
    expect(win.bounds).toEqual(aside);
  });

  it("steps aside again for the same question once it has grown under the field, and only then (companion-c4-1)", () => {
    type Box = { x: number; y: number; width: number; height: number };
    const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    let bubble: Box | null = null;
    const ask = new AskWindow({ bubble: () => bubble });
    ask.prepare();
    const [win] = made;
    win.emit("ready-to-show");
    ask.show({ x: 687, y: 113, size: 60 });
    // A question comes up under the field, as wide as there is no room beside it: the box steps aside, under it.
    bubble = { x: 380, y: 155, width: 520, height: 224 };
    ask.bubbleChanged("q1:once,q1:always,q1:deny");
    const aside = { ...win.bounds };
    expect(overlaps(aside, bubble)).toBe(false);
    // A spoken yes that wasn't taken adds its note: the same question (the same answers), 63 px taller, now under the
    // field, which covered the note's end and the keys it names. The box steps aside again, clear of all of it.
    bubble = { ...bubble, height: 287 };
    expect(overlaps(aside, bubble)).toBe(true);
    ask.bubbleChanged("q1:once,q1:always,q1:deny");
    expect(overlaps(win.bounds, bubble), JSON.stringify(win.bounds)).toBe(false);
    // Still once for each size: no dance after a question that only moved, or grew no further.
    const again = { ...win.bounds };
    bubble = { ...again, height: 287 };
    ask.bubbleChanged("q1:once,q1:always,q1:deny");
    expect(win.bounds).toEqual(again);
  });

  it("keeps what it shows off the task cards by the least sideways move, never onto Ember's answer, the handle or Ember (companion-r5-1)", () => {
    // As measured live at Larger text with Ember at the top, Ask opened under "I've started on that. Its card shows how
    // it's going.": the field and its hint ran over the running card's ring and title (2,210 and 1,846 px² of them at
    // 1366 x 768, the hint's 2,736 at 1280 x 800). What the page showed, window-local: the field, the hint, "Set up
    // voice in Settings…" and the suggestions.
    const parts = [{ x: 10, y: 10, width: 708, height: 62 }, { x: 476, y: 76, width: 228, height: 26 }, { x: 24, y: 106, width: 230, height: 50 }, { x: 24, y: 160, width: 326, height: 50 }];
    const near = { x: 730, y: 113, size: 60 };
    const wide = { x: 0, y: 0, width: 1366, height: 768 };
    const box = { x: 366, y: 360, width: 728, height: 236 }, card = { x: 999, y: 406, width: 351, height: 290 };
    const handle = { x: 1094, y: 700, width: 260, height: 56 }, answer = { x: 708, y: 155, width: 330, height: 197 };
    const moved = clearOfCards(box, parts, wide, [card], handle, answer, near);
    expect(moved).toEqual({ x: 273, y: 360, width: 728, height: 236 });
    const shown = (b: Box) => parts.map(p => ({ x: b.x + p.x, y: b.y + p.y, width: p.width, height: p.height }));
    expect(shown(box).some(p => overlaps(p, card))).toBe(true);
    expect(shown(moved).some(p => overlaps(p, card))).toBe(false);
    expect(overlaps(moved, answer) || overlaps(moved, handle)).toBe(false);
    // 1280 x 800: only the hint was over the card; it moves as far as that takes.
    const at1280 = clearOfCards({ x: 323, y: 360, width: 728, height: 236 }, parts, { x: 0, y: 0, width: 1280, height: 800 }, [{ x: 913, y: 438, width: 351, height: 290 }],
      { x: 1008, y: 732, width: 260, height: 56 }, { x: 665, y: 155, width: 330, height: 197 }, { x: 687, y: 113, size: 60 });
    expect(at1280).toEqual({ x: 201, y: 360, width: 728, height: 236 });
    // Clear of them already, or no cards: where it was.
    expect(clearOfCards(moved, parts, wide, [card], handle, answer, near)).toBe(moved);
    expect(clearOfCards(box, parts, wide, [], handle, answer, near)).toBe(box);
    // Where no move clears them without going onto the answer being replied to or off the screen (a 1024-wide screen,
    // the box as it opens before the page says what it shows), the answer comes first: where it was.
    const narrow = { x: 0, y: 0, width: 1024, height: 768 };
    const tight = { x: 148, y: 370, width: 728, height: 221 };
    expect(clearOfCards(tight, [], narrow, [{ x: 592, y: 483, width: 416, height: 213 }], { x: 752, y: 700, width: 260, height: 56 }, { x: 537, y: 155, width: 330, height: 207 }, { x: 559, y: 113, size: 60 })).toBe(tight);
  });

  it("opens off the task cards and moves off one that comes up under it while it is open (companion-r5-1)", () => {
    let cards: Box[] = [];
    const bubble = { x: 665, y: 155, width: 330, height: 197 };
    const ask = new AskWindow({ bubble: () => bubble, cards: () => cards, keepOff: () => ({ x: 1008, y: 732, width: 260, height: 56 }) });
    ask.prepare();
    const [win] = made;
    win.emit("ready-to-show");
    // No cards: where it always opened, under the answer.
    ask.show({ x: 687, y: 113, size: 60 });
    const plain = { ...win.bounds };
    expect(overlaps(plain, bubble)).toBe(false);
    ask.hide();
    // A running card in the corner, under where it would open: it opens beside where it was, at the same height.
    const card = { x: plain.x + plain.width - 60, y: plain.y + 20, width: 351, height: 290 };
    cards = [card];
    ask.show({ x: 687, y: 113, size: 60 });
    expect(win.bounds.y).toBe(plain.y);
    expect(overlaps(win.bounds, card)).toBe(false);
    expect(overlaps(win.bounds, bubble)).toBe(false);
    ask.hide();
    // Opened with none, then a task's card comes up under it (asked for in the box): it moves off the card once.
    cards = [];
    ask.show({ x: 687, y: 113, size: 60 });
    expect(win.bounds).toEqual(plain);
    cards = [card];
    ask.keepClear();
    expect(overlaps(win.bounds, card)).toBe(false);
    const off = { ...win.bounds };
    ask.keepClear();
    expect(win.bounds).toEqual(off);
    // The page says what it shows: a row of suggestions over a card that is lower down moves it off that card too.
    ask.hide();
    cards = [];
    ask.show({ x: 687, y: 113, size: 60 });
    const low = { x: plain.x + 300, y: plain.y + plain.height - 30, width: 351, height: 200 };
    cards = [low];
    win.heard.get("agent:ask-shape")!({}, [{ x: 10, y: 10, width: 708, height: 62 }]);
    expect(win.bounds).toEqual(plain);
    win.heard.get("agent:ask-shape")!({}, [{ x: 10, y: 10, width: 708, height: 62 }, { x: 24, y: plain.height - 20, width: 326, height: 18 }]);
    expect(win.bounds).toEqual({ ...plain, x: plain.x - 58 });
    expect(overlaps({ x: win.bounds.x + 24, y: win.bounds.y + plain.height - 20, width: 326, height: 18 }, low)).toBe(false);
  });

  it("steps aside for a question or Listen once's \"Listening…\", never for an answer it can be typed beside (companion-c1-1)", () => {
    const actions = (...ids: string[]) => ids.map(id => ({ id, label: id }));
    expect(stepsAsideFor({ visible: true, mood: "attention", actions: actions("q4:once", "q4:always", "q4:deny") })).toBe("q4:once,q4:always,q4:deny");
    expect(stepsAsideFor({ visible: true, mood: "listening", actions: [] }, true)).toBe("listening");
    // Only for the box's own Listen once: a wake's "Listening…" (someone nearby said "Hey Ember") or speech heard in a
    // follow-up window never moves the box being typed in (companion-c2-3).
    expect(stepsAsideFor({ visible: true, mood: "listening", actions: [] })).toBeNull();
    expect(stepsAsideFor({ visible: true, mood: "listening", actions: [] }, false)).toBeNull();
    // An answer and its own buttons (Stop, Try again), a problem, or nothing up: the bubble keeps off the box itself.
    expect(stepsAsideFor({ visible: true, mood: "done", actions: actions("ui:retry") })).toBeNull();
    expect(stepsAsideFor({ visible: true, mood: "thinking", actions: actions("ui:stop") })).toBeNull();
    expect(stepsAsideFor({ visible: false, mood: "attention", actions: actions("q4:once") })).toBeNull();
  });

  it("offers no suggestion while a question is up, and one that follows an answer only while that answer shows (companion-r2-1, companion-c2-2)", () => {
    const answer = { ...IDLE_BUBBLE, visible: true, thought: "Tokyo is 9 hours ahead. Want me to add a world clock?" };
    const s = { bubble: answer, suggest: { thought: answer.thought, items: ["Yes, please", "No, thanks", "Remind me in an hour"] } };
    const items = [{ text: "Yes, please", follows: true }, { text: "No, thanks", follows: true }, { text: "Remind me in an hour" }];
    // Beside the answer they were made for: all of them.
    expect(askSuggestions(s, items, false)).toEqual(["Yes, please", "No, thanks", "Remind me in an hour"]);
    // A task asks something: none, so "Yes, please" never sits by its Allow, also before the bubble shows the question.
    const question = { ...answer, mood: "attention" as const, thought: "May I click “Apply” in Settings?", actions: [{ id: "q3:once", label: "Allow" }, { id: "q3:deny", label: "Not now" }] };
    expect(askSuggestions(s, items, true)).toEqual([]);
    expect(askSuggestions({ ...s, bubble: question }, items, false)).toEqual([]);
    // The answer has gone (its time ran out, or something else shows): only the ones that stand on their own.
    expect(askSuggestions({ ...s, bubble: IDLE_BUBBLE }, items, false)).toEqual(["Remind me in an hour"]);
    expect(askSuggestions({ ...s, bubble: { ...answer, thought: "Night light is on." } }, items, false)).toEqual(["Remind me in an hour"]);
    expect(askSuggestions({ bubble: answer, suggest: null }, items, false)).toEqual(["Remind me in an hour"]);
    // An answer's own buttons (Try again) are no question.
    expect(askSuggestions({ ...s, bubble: { ...answer, actions: [{ id: "ui:retry", label: "Try again" }] } }, items, false)).toEqual(["Yes, please", "No, thanks", "Remind me in an hour"]);
  });

  it("offers nothing that agrees to an answer cut short under Read all, whose offer the bubble doesn't show, until it is opened in full (companion-c5-2)", () => {
    // A 70-word answer ending in "Want me to add a world clock?", cut at six lines: the bubble showed "…Tokyo is nine
    // hours ahead of" and Read all, and the box offered "Yes, please" and "No, thanks" in Tab order all the same.
    const thought = "Tokyo is nine hours ahead of London, so it is evening there. ".repeat(6) + "Want me to add a world clock?";
    const cut = { ...IDLE_BUBBLE, visible: true, thought, step: "Or press Ctrl+Alt+E and go to Conversation.", actions: [{ id: "ui:more", label: "Read all" }] };
    const s = { bubble: cut, suggest: { thought, items: ["Yes, please", "No, thanks", "Remind me in an hour"] } };
    const items = [{ text: "Yes, please", follows: true, answers: true }, { text: "No, thanks", follows: true, answers: true }, { text: "Remind me in an hour" }];
    // Only the one that stands on its own.
    expect(askSuggestions(s, items, false)).toEqual(["Remind me in an hour"]);
    // Read all: the whole answer, its offer with it, shows (the overlay says its end has), and so do the chips that
    // answer it.
    const full = { ...cut, step: null, expanded: true, actions: [{ id: "ui:close", label: "Close" }, { id: "ui:conversation", label: "Open conversation" }] };
    expect(askSuggestions({ ...s, bubble: full }, items, false, true)).toEqual(["Yes, please", "No, thanks", "Remind me in an hour"]);
    // An answer short enough to show whole offers them as before.
    expect(askSuggestions({ ...s, bubble: { ...cut, step: null, actions: [] } }, items, false)).toEqual(["Yes, please", "No, thanks", "Remind me in an hour"]);
  });

  it("offers what answers a long answer's offer once Read all has shown its end, however long the answer (companion-v6-1)", async () => {
    const { predictNext } = await import("../../app/main/personal/predict");
    const { expandedBubble, expandedSuggest } = await import("../../app/main/agent/presenter");
    // As the bubble shows an answer (presenter.ts clip: its first 600 characters).
    const clip = (t: string) => (t.length > 600 ? `${t.slice(0, 599).trimEnd()}…` : t);
    const close = [{ id: "ui:close", label: "Close" }, { id: "ui:conversation", label: "Open conversation" }];
    for (const n of [300, 650, 1200]) {
      const full = "Tokyo is nine hours ahead of London in winter and eight in summer. ".repeat(40).slice(0, n - 30).trimEnd() + " Want me to add a world clock?";
      const items = predictNext({ lastRequest: "What time is it in Tokyo?", lastRequestOwn: true, lastReply: full, spoken: false, task: null, history: [], hour: 14, people: [] }, () => false);
      expect(items, String(n)).toEqual([{ text: "Yes, please", follows: true, answers: true }, { text: "No, thanks", follows: true, answers: true }]);
      const cut = { ...IDLE_BUBBLE, visible: true, title: "Ember", thought: clip(full), step: "Or press Ctrl+Alt+E and go to Conversation.", actions: [{ id: "ui:more", label: "Read all" }] };
      const s = { bubble: cut, suggest: { thought: cut.thought, items: items.map(i => i.text) } };
      // Cut short, its offer out of sight: nothing that answers it.
      expect(askSuggestions(s, items, false), String(n)).toEqual([]);
      // Read all (main's expandAnswer): the suggestions follow the whole answer. At 650 and 1200 characters they were
      // made for its first 600, matched it no more, and "Yes, please" never came back.
      const opened = { bubble: expandedBubble(cut, full), suggest: expandedSuggest(s.suggest, cut, full) };
      expect(opened.bubble).toMatchObject({ expanded: true, thought: full, actions: close });
      expect(opened.suggest, String(n)).toEqual({ thought: full, items: ["Yes, please", "No, thanks"] });
      // Offered once its end has shown (the overlay's word: all of it, or scrolled to it), not before.
      expect(askSuggestions(opened, items, false), String(n)).toEqual([]);
      expect(askSuggestions(opened, items, false, true), String(n)).toEqual(["Yes, please", "No, thanks"]);
    }
    // Never for another answer than the one they were made for, nor for one the conversation kept only in part.
    const other = { ...IDLE_BUBBLE, visible: true, thought: "Night light is on." };
    const made = { thought: "Tokyo is 9 hours ahead. Want me to add a world clock?", items: ["Yes, please"] };
    expect(expandedSuggest(made, other, "Night light is on.")).toBe(made);
    const kept = { ...IDLE_BUBBLE, visible: true, thought: made.thought };
    expect(expandedSuggest(made, kept, "Something else entirely.")).toBe(made);
    const huge = "x".repeat(128 * 1024), part = { thought: clip(huge), items: ["Yes, please"] };
    expect(expandedSuggest(part, { ...kept, thought: clip(huge) }, huge)).toBe(part);
    expect(expandedSuggest(null, kept, made.thought)).toBeNull();
  });

  it("offers what answers an answer opened in full once its overlay says its end has shown, and refuses any other word for it (companion-repairs-x6-4)", () => {
    const thought = "Tokyo is nine hours ahead of London, so it is evening there. ".repeat(6) + "Want me to add a world clock?";
    const full = { ...IDLE_BUBBLE, visible: true, thought, expanded: true, actions: [{ id: "ui:close", label: "Close" }, { id: "ui:conversation", label: "Open conversation" }] };
    const s = { bubble: full, suggest: { thought, items: ["Yes, please", "No, thanks"] } };
    const items = [{ text: "Yes, please", follows: true, answers: true }, { text: "No, thanks", follows: true, answers: true }];
    const rect = { x: 98, y: 427, width: 410, height: 333 };
    // What main's OVERLAY.bubble handler keeps of each report, and what the box offers then (askOffers).
    const offered = (box: ReturnType<typeof bubbleBoxOf>) => askSuggestions(s, items, false, answerEndShown(full, box, null));
    expect(bubbleBoxOf(rect)).toEqual(rect);
    expect(offered(bubbleBoxOf(rect))).toEqual([]);
    expect(bubbleBoxOf({ ...rect, endShown: true })).toEqual({ ...rect, endShown: true });
    expect(offered(bubbleBoxOf({ ...rect, endShown: true }))).toEqual(["Yes, please", "No, thanks"]);
    // Anything but true for it, or a shape that isn't a rect, is refused (undefined: main keeps what it had) ...
    for (const bad of [{ ...rect, endShown: "yes" }, { ...rect, endShown: 1 }, { ...rect, x: "98" }, { ...rect, width: Infinity }, { x: 1, y: 2 }, "rect", 7, undefined]) {
      expect(bubbleBoxOf(bad), JSON.stringify(bad) ?? "undefined").toBeUndefined();
    }
    // ... and never drops extra fields through to main's record: only the rect and endShown.
    expect(bubbleBoxOf({ ...rect, endShown: null, html: "<b>" })).toEqual(rect);
    expect(bubbleBoxOf(null)).toBeNull();
  });

  it("offers what answers an answer opened in full in the corner card once the card has shown its end, for those very words only (companion-repairs-x6-3)", async () => {
    // No compositor: the card showed all of it, its offer included, after Read all, and the box offered nothing.
    const thought = "Tokyo is nine hours ahead of London, so it is evening there. ".repeat(6) + "Want me to add a world clock?";
    const full = { ...IDLE_BUBBLE, visible: true, thought, expanded: true, actions: [{ id: "ui:close", label: "Close" }, { id: "ui:conversation", label: "Open conversation" }] };
    const s = { bubble: full, suggest: { thought, items: ["Yes, please", "No, thanks"] } };
    const items = [{ text: "Yes, please", follows: true, answers: true }, { text: "No, thanks", follows: true, answers: true }];
    const offered = (b: typeof full, cardEnded: string | null) => askSuggestions({ ...s, bubble: b }, items, false, answerEndShown(b, null, cardEnded));
    expect(offered(full, null)).toEqual([]);
    expect(offered(full, thought)).toEqual(["Yes, please", "No, thanks"]);
    // The card's word for other words (an answer that has gone), for one not opened in full, or one not shown: nothing.
    expect(answerEndShown(full, null, "Night light is on.")).toBe(false);
    expect(answerEndShown({ ...full, expanded: false }, null, thought)).toBe(false);
    expect(answerEndShown({ ...full, visible: false }, null, thought)).toBe(false);
    // The overlay's word stands as before.
    expect(answerEndShown(full, { x: 0, y: 0, width: 10, height: 10, endShown: true }, null)).toBe(true);
    // Main takes the card's word only from the handle, only as text no longer than a conversation keeps, and only for the
    // answer shown now; it forgets it once that answer no longer shows.
    const { readFileSync } = await import("node:fs");
    const main = readFileSync("app/main/main.ts", "utf8");
    const told = main.slice(main.indexOf("ipcMain.on(OVERLAY.handleAnswerEnd,"));
    expect(told.slice(0, told.indexOf("\n  });"))).toMatch(/if \(!isHandle\(event\.sender\) \|\| typeof words !== "string" \|\| words\.length > CONVERSATION_TEXT_LIMIT \|\| words === cardEnded \|\| !answerEndShown\(lastState\.bubble, null, words\)\) return;\n\s+cardEnded = words;\n\s+askOffersChanged\(\);/);
    const show = main.slice(main.indexOf("const showState = "));
    expect(show.slice(0, show.indexOf("\n  };"))).toContain("if (next.bubble && !answerEndShown(next.bubble, null, cardEnded)) cardEnded = null;");
  });

  it("keeps what doesn't answer an answer's last words for one cut short, which the keyboard can't open: Read it out, Close it (companion-v6-1)", async () => {
    const { predictNext } = await import("../../app/main/personal/predict");
    const { expandedBubble, expandedSuggest } = await import("../../app/main/agent/presenter");
    // A 1,049-character summary, not said aloud: "Read it out" is for exactly such an answer, and agrees to nothing.
    const full = "Here is a summary of the document. ".repeat(30).trim();
    const items = predictNext({ lastRequest: "Summarise this document", lastRequestOwn: true, lastReply: full, spoken: false, task: null, history: [], hour: 14, people: [] }, () => false);
    expect(items[0]).toEqual({ text: "Read it out", follows: true });
    const cut = { ...IDLE_BUBBLE, visible: true, title: "Ember", thought: `${full.slice(0, 599).trimEnd()}…`, actions: [{ id: "ui:more", label: "Read all" }] };
    const s = { bubble: cut, suggest: { thought: cut.thought, items: items.map(i => i.text) } };
    // Under Read all (mouse only) and opened in full, before its end has shown: still offered.
    expect(askSuggestions(s, items, false)).toContain("Read it out");
    expect(askSuggestions({ bubble: expandedBubble(cut, full), suggest: expandedSuggest(s.suggest, cut, full) }, items, false)).toContain("Read it out");
    // "Close it" after something was opened, and "What went wrong?" after a task failed, stay too.
    const opened = predictNext({ lastRequest: "Open my notes", lastRequestOwn: true, lastReply: full, spoken: false, task: null, history: [], hour: 14, people: [] }, () => false);
    expect(askSuggestions({ ...s, suggest: { thought: cut.thought, items: opened.map(i => i.text) } }, opened, false)).toEqual(expect.arrayContaining(["Close it", "Read it out"]));
    const failed = predictNext({ lastRequest: "Tidy my desktop", lastRequestOwn: true, lastReply: full, spoken: false, task: { status: "failed" }, history: [], hour: 14, people: [] }, () => false);
    expect(askSuggestions({ ...s, suggest: { thought: cut.thought, items: failed.map(i => i.text) } }, failed, false)).toContain("What went wrong?");
  });

  it("offers nothing that agrees to an answer opened in full until its end has shown: cut short to the room, its offer is out of view (companion-v6-2)", () => {
    // As measured live at 1024 x 768, Larger text, Ember mid-screen: Read all with the box open cut the answer to seven
    // of its nine lines, its last, "Want me to add a world clock?", scrolled out of view under a line that ends a
    // sentence; the box opened again with "Yes, please" and "No, thanks", which Tab and Enter agreed with.
    const thought = "Tokyo is nine hours ahead of London, so it is evening there. ".repeat(6) + "Want me to add a world clock?";
    const full = { ...IDLE_BUBBLE, visible: true, title: "Ember", thought, expanded: true, actions: [{ id: "ui:close", label: "Close" }, { id: "ui:conversation", label: "Open conversation" }] };
    const s = { bubble: full, suggest: { thought, items: ["Yes, please", "No, thanks", "Remind me in an hour"] } };
    const items = [{ text: "Yes, please", follows: true, answers: true }, { text: "No, thanks", follows: true, answers: true }, { text: "Remind me in an hour" }];
    // Cut short (the overlay doesn't say its end has shown): only what stands on its own.
    expect(askSuggestions(s, items, false)).toEqual(["Remind me in an hour"]);
    expect(askSuggestions(s, items, false, false)).toEqual(["Remind me in an hour"]);
    // Scrolled to its end, or shown whole (once the box closed: companion-v6-3): offered.
    expect(askSuggestions(s, items, false, true)).toEqual(["Yes, please", "No, thanks", "Remind me in an hour"]);
    // The overlay's word never stands for an answer cut short under Read all, nor through a question.
    expect(askSuggestions({ ...s, bubble: { ...full, expanded: false, actions: [{ id: "ui:more", label: "Read all" }] } }, items, false, true)).toEqual(["Remind me in an hour"]);
    expect(askSuggestions(s, items, true, true)).toEqual([]);
  });

  it("opens with room for an answer's follow-ups while the answer still comes in, so they land where the keyboard reaches them (accessibility-visual-c4-1)", async () => {
    const streaming = { ...IDLE_BUBBLE, visible: true, thought: "Tokyo is 9 hours", streaming: true };
    expect(askSuggestionsComing({ bubble: streaming }, false, true)).toBe(true);
    // An answer whole already (its follow-ups are offered, or none will be), nothing up, a step at work, or a question:
    // no room is kept for any.
    expect(askSuggestionsComing({ bubble: { ...streaming, streaming: false } }, false, true)).toBe(false);
    expect(askSuggestionsComing({ bubble: IDLE_BUBBLE }, false, true)).toBe(false);
    expect(askSuggestionsComing({ bubble: { ...streaming, mood: "acting" as const } }, false, true)).toBe(false);
    expect(askSuggestionsComing({ bubble: { ...streaming, actions: [{ id: "q1:once", label: "Allow" }] } }, false, true)).toBe(false);
    expect(askSuggestionsComing({ bubble: streaming }, true, true)).toBe(false);
    // The box keeps that room only where the answer coming in can still finish whole by Ember clear of it (as measured
    // live: 1280 x 800 at the default text size, Ember near the bottom; the box a row taller from the start, its bottom
    // where it was, so the field never moves when they come).
    const sent: [string, unknown][] = [];
    const ask = new AskWindow();
    ask.prepare();
    const [win] = made;
    win.webContents.send = (ch: string, t: unknown) => { sent.push([ch, t]); };
    win.emit("ready-to-show");
    const told = () => sent.filter(([ch]) => ch === "agent:ask-context").at(-1)?.[1] as { suggestionsComing?: boolean } | undefined;
    ask.show({ x: 640, y: 600, size: 60 }, { sees: null, history: [] });
    const plain = { ...win.bounds };
    ask.hide();
    ask.show({ x: 640, y: 600, size: 60 }, { sees: null, history: [], suggestionsComing: true });
    expect(win.bounds.height).toBeGreaterThan(plain.height);
    expect(win.bounds.y + win.bounds.height).toBe(plain.y + plain.height);
    expect(told()?.suggestionsComing).toBe(true);
    ask.hide();
    // Where the row would take the room the finished answer needs (1024 x 768 at Larger text, Ember in the middle, the
    // box above it: 58,080 px² of the answer went under the field with the row kept), none is kept, and the page isn't
    // told to keep any: the follow-ups wait for the next opening, as before.
    const display = { x: 0, y: 0, width: 1024, height: 768 };
    const tall = { x: 195, y: 245, width: 728, height: 236 }, short = { x: 195, y: 308, width: 728, height: 173 };
    expect(roomForAnswer(tall, { x: 512, y: 450, size: 60 }, display, 1.3)).toBe(false);
    // Ember at the top, the box under it: the room below the box is the answer's (1024 x 768 Larger), yet at 1280 x 800
    // Default there is room for both.
    expect(roomForAnswer({ x: 195, y: 245, width: 728, height: 236 }, { x: 512, y: 110, size: 60 }, display, 1.3)).toBe(false);
    expect(roomForAnswer({ x: 195, y: 245, width: 728, height: 173 }, { x: 512, y: 110, size: 60 }, display, 1.3)).toBe(true);
    expect(roomForAnswer({ x: 360, y: 149, width: 560, height: 188 }, { x: 640, y: 110, size: 60 }, { x: 0, y: 0, width: 1280, height: 800 }, 1)).toBe(true);
    // Lower on a 1024 x 768 screen at Larger text there is room above the box again, so it is kept there.
    expect(roomForAnswer({ x: 195, y: 355, width: 728, height: 236 }, { x: 512, y: 560, size: 60 }, display, 1.3)).toBe(true);
    // Opened without Ember to go by: none is assumed.
    expect(roomForAnswer(short, null, display, 1)).toBe(false);
    // Main opens the box with it when nothing is offered yet (askOffers first).
    const { readFileSync } = await import("node:fs");
    const main = readFileSync("app/main/main.ts", "utf8");
    expect(main).toContain("...(askOffers().length ? { suggestions: askOffers() } : askSuggestionsComing(lastState, !!confirmer?.waiting, !!personalRef && settings.get().voice.suggest) ? { suggestionsComing: true } : {}),");
  });

  it("keeps no row for follow-ups with “Suggest what I might say next” off, where none can come: the box opens as it does once the answer is whole (companion-v5-2)", () => {
    const streaming = { ...IDLE_BUBBLE, visible: true, thought: "Tokyo is 9 hours", streaming: true };
    // Off, Ember offers nothing (PersonalVoice.current() is empty), so the row would stay blank for as long as the box
    // is open: 188 px tall against 140 at 1280 x 800 Default, the field 48 px further from Ember.
    expect(askSuggestionsComing({ bubble: streaming }, false, false)).toBe(false);
    expect(askSuggestionsComing({ bubble: streaming }, false, true)).toBe(true);
    const ask = new AskWindow();
    ask.prepare();
    const [win] = made;
    win.emit("ready-to-show");
    const opening = (suggests: boolean) => ({ sees: null, history: [], ...(askSuggestionsComing({ bubble: streaming }, false, suggests) ? { suggestionsComing: true } : {}) });
    ask.show({ x: 640, y: 600, size: 60 }, { sees: null, history: [] });
    const whole = { ...win.bounds };
    ask.hide();
    ask.show({ x: 640, y: 600, size: 60 }, opening(false));
    expect(win.bounds).toEqual(whole);
    ask.hide();
    // On, the row is kept as before.
    ask.show({ x: 640, y: 600, size: 60 }, opening(true));
    expect(win.bounds.height).toBeGreaterThan(whole.height);
    ask.hide();
  });

  it("tells an open box what it offers now on a channel of its own, and nothing while it is closed (companion-r2-1)", async () => {
    const sent: [string, unknown][] = [];
    const ask = new AskWindow();
    ask.prepare();
    const [win] = made;
    win.webContents.send = (ch: string, t: unknown) => { sent.push([ch, t]); };
    win.emit("ready-to-show");
    ask.show({ x: 400, y: 300 }, { sees: null, history: [], suggestions: ["Yes, please", "No, thanks"] });
    const offered = () => sent.filter(([ch]) => ch === "agent:ask-suggestions").map(([, w]) => w);
    const contexts = () => sent.filter(([ch]) => ch === "agent:ask-context").length;
    const before = contexts();
    // A question came: the chips go, and only they change (the draft and the rest of the page stay).
    ask.setSuggestions([]);
    ask.setSuggestions([]);
    expect(offered()).toEqual([[]]);
    expect(contexts()).toBe(before);
    // It was answered: what stands on its own comes back.
    ask.setSuggestions(["Remind me in an hour"]);
    expect(offered()).toEqual([[], ["Remind me in an hour"]]);
    // Closed: nothing is sent (the next opening brings its own).
    ask.hide();
    ask.setSuggestions(["Yes, please"]);
    expect(offered()).toHaveLength(2);
    // Main offers in the box only what askSuggestions offers now, and takes a chip back only if it is offered now.
    const { readFileSync } = await import("node:fs");
    const main = readFileSync("app/main/main.ts", "utf8");
    expect(main).toMatch(/const askOffers = \(\) => askSuggestions\(lastState, personalRef\?\.current\(\) \?\? \[\], !!confirmer\?\.waiting, answerEndShown\(lastState\.bubble, overlay\?\.bubbleRect\(\), cardEnded\)\);/);
    // Read all carries the suggestions over to the whole answer (companion-v6-1), and the overlay's word that its end
    // has shown changes what the box offers (companion-v6-2).
    expect(main).toMatch(/const suggest = expandedSuggest\(lastState\.suggest, lastState\.bubble, full\);\n\s+setState\(\{ talking: false, bubble: expandedBubble\(lastState\.bubble, full\), \.\.\.\(suggest !== lastState\.suggest \? \{ suggest \} : \{\}\) \}\);/);
    const reported = main.slice(main.indexOf("ipcMain.on(OVERLAY.bubble,"));
    expect(reported.slice(0, reported.indexOf("\n  });"))).toMatch(/const rect = bubbleBoxOf\(raw\);\n\s+if \(!overlay\?\.owns\(event\.sender\) \|\| rect === undefined\) return;[\s\S]+if \(\(overlay\.bubbleRect\(\)\?\.endShown === true\) !== ended\) askOffersChanged\(\);/);
    const open = main.slice(main.indexOf("const openAsk = "), main.indexOf("let audit: AuditLog"));
    expect(open).toMatch(/suggestions: askOffers\(\)/);
    expect(open).not.toMatch(/personalRef\.current\(\)/);
    const chip = main.slice(main.indexOf("ipcMain.on(IPC.askSuggestion,"));
    expect(chip.slice(0, chip.indexOf("\n  });"))).toMatch(/!askOffers\(\)\.includes\(text\)/);
    // An open box hears of every change: a question coming or going, the answer going, a new answer.
    expect(main).toMatch(/askOffersChanged = \(\) => askWindow\.setSuggestions\(askOffers\(\)\);/);
    const qc = main.slice(main.indexOf("const questionChanged = "));
    expect(qc.slice(0, qc.indexOf("\n  };"))).toMatch(/askOffersChanged\(\);/);
    const show = main.slice(main.indexOf("const showState = "));
    expect(show.slice(0, show.indexOf("\n  };"))).toMatch(/askOffersChanged\(\);/);
  });

  it("says why Ember can't answer as that changes while the box is open, without opening it afresh (companion-6)", async () => {
    const sent: [string, unknown][] = [];
    const ask = new AskWindow();
    ask.prepare();
    const [win] = made;
    win.webContents.send = (ch: string, t: unknown) => { sent.push([ch, t]); };
    win.emit("ready-to-show");
    ask.show({ x: 400, y: 300 }, { sees: null, history: ["earlier"], unavailable: "Connecting…" });
    ask.setContext({ sees: "Text Editor · Notes.txt", history: ["earlier"] });
    const contexts = () => sent.filter(([ch]) => ch === "agent:ask-context").length;
    const words = () => sent.filter(([ch]) => ch === "agent:ask-unavailable").map(([, w]) => w);
    const before = contexts();
    // Copilot's connection failed while the box was open: the line says so now, and only the line changes (the page keeps
    // what it shows, its place in the history and the draft: not an opening, nor the context sent again).
    ask.setUnavailable("Offline");
    expect(words()).toEqual(["Offline"]);
    expect(contexts()).toBe(before);
    // The same word again: nothing to say. Connected: the line goes.
    ask.setUnavailable("Offline");
    ask.setUnavailable(undefined);
    expect(words()).toEqual(["Offline", null]);
    // Closed: kept for the next opening's context, not sent.
    ask.hide();
    ask.setUnavailable("Not connected");
    expect(words()).toEqual(["Offline", null]);
    ask.show({ x: 400, y: 300 });
    expect(sent.filter(([ch]) => ch === "agent:ask-context").at(-1)?.[1]).toMatchObject({ unavailable: "Not connected", opened: true });
    // Main tells it on every change of Copilot's status, in the handle's word.
    const { readFileSync } = await import("node:fs");
    // Inside the handler's own body, however long the rest of it grows (it ends at its closing "},").
    const main = readFileSync("app/main/main.ts", "utf8");
    const handler = main.slice(main.indexOf("onStatus: status => {"));
    expect(handler.slice(0, handler.indexOf("\n      },"))).toMatch(/askWindow\.setUnavailable\(unansweredWord\(status\) \?\? undefined\);$/);
  });

  it("grows with its field as lines are added or pasted, upward above Ember, and opens one line tall again (review #70)", () => {
    const ask = new AskWindow();
    ask.show({ x: 400, y: 500 });
    const [win] = made;
    win.emit("ready-to-show");
    const one = { ...win.bounds };
    expect(one.height).toBe(140);
    win.heard.get("agent:ask-fit")!({}, 4);
    expect(win.bounds).toEqual({ ...one, height: 164, y: one.y - 24 });
    // Nothing from the page that isn't a number of lines.
    win.heard.get("agent:ask-fit")!({}, "9");
    expect(win.bounds.height).toBe(164);
    ask.hide();
    ask.show({ x: 400, y: 500 });
    expect(win.bounds).toEqual(one);
  });

  it("offers Cut, Copy, Paste and Select all on a right-click, and stays open while that menu is up (review #77)", () => {
    const ask = new AskWindow();
    ask.show({ x: 400, y: 500 });
    const [win] = made;
    win.emit("ready-to-show");
    win.contents.get("context-menu")!({}, { editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } });
    expect(menus[0].items.map(i => [i.role, i.label, i.enabled])).toEqual([
      ["cut", "Cut", false], ["copy", "Copy", false], ["paste", "Paste", true], [undefined, undefined, undefined], ["selectAll", "Select all", true],
    ]);
    // The menu may take the keyboard: the box doesn't close under it, and keeps the keyboard once it closes.
    vi.useFakeTimers();
    win.emit("blur");
    expect(win.visible).toBe(true);
    win.emit("focus");
    const focused = win.focused;
    menus[0].popup!.callback!();
    vi.advanceTimersByTime(500);
    expect(win.focused).toBe(focused);
    expect(win.visible).toBe(true);
    // Past the handover after the box was shown: a blur now is the user clicking away.
    vi.advanceTimersByTime(1500);
    win.emit("blur");
    expect(win.visible).toBe(false);
  });

  it("stays open when the keyboard is taken back while the box is still being handed it", () => {
    vi.useFakeTimers();
    const taken: number[] = [];
    const ask = new AskWindow({ takeFocus: id => taken.push(id) });
    ask.show({ x: 400, y: 300 });
    const [win] = made;
    win.emit("ready-to-show");
    const focused = win.focused;
    win.isFocused = () => false;
    win.emit("blur");
    expect(win.visible).toBe(true);
    vi.advanceTimersByTime(0);
    expect(win.focused).toBe(focused + 1);
    expect(taken).toEqual([0x3a00007, 0x3a00007]);
    expect(win.visible).toBe(true);
    vi.advanceTimersByTime(1500);
    win.emit("blur");
    expect(win.visible).toBe(false);
  });

  it("on macOS, a click into another app once the box has had the keyboard closes it, also in the handover (review #84)", () => {
    vi.useFakeTimers();
    const taken: number[] = [];
    const ask = new AskWindow({ takeFocus: id => taken.push(id), settleMs: MAC_SETTLE_MS });
    ask.show({ x: 400, y: 300 });
    const [win] = made;
    win.emit("ready-to-show");
    win.emit("focus");
    const focused = win.focused;
    // The user types, then clicks back into their app well inside OPENING_MS: the box goes, the app keeps the keyboard.
    vi.advanceTimersByTime(600);
    win.isFocused = () => false;
    win.emit("blur");
    vi.advanceTimersByTime(0);
    expect(win.visible).toBe(false);
    expect(win.focused).toBe(focused);
    expect(taken).toEqual([0x3a00007]);
  });

  it("on macOS, a blur before the box ever had the keyboard is still the handover: it takes it again", () => {
    vi.useFakeTimers();
    const ask = new AskWindow({ settleMs: MAC_SETTLE_MS });
    ask.show({ x: 400, y: 300 });
    const [win] = made;
    win.emit("ready-to-show");
    const focused = win.focused;
    win.isFocused = () => false;
    win.emit("blur");
    vi.advanceTimersByTime(0);
    expect(win.visible).toBe(true);
    expect(win.focused).toBe(focused + 1);
    // Once it has the keyboard, a blur is the user: the box goes.
    win.emit("focus");
    win.emit("blur");
    expect(win.visible).toBe(false);
  });

  it("with a settle time, a blur that comes sooner after the box got the keyboard is still the handover", () => {
    vi.useFakeTimers();
    const ask = new AskWindow({ settleMs: 200 });
    ask.show({ x: 400, y: 300 });
    const [win] = made;
    win.emit("ready-to-show");
    win.emit("focus");
    vi.advanceTimersByTime(50);
    win.isFocused = () => false;
    win.emit("blur");
    expect(win.visible).toBe(true);
    win.emit("focus");
    vi.advanceTimersByTime(250);
    win.emit("blur");
    expect(win.visible).toBe(false);
  });

  /** A box with its right-click menu up; `focused` is whether it has the keyboard when the menu has closed. */
  function withMenu(focused: () => boolean) {
    vi.useFakeTimers();
    const ask = new AskWindow();
    ask.show({ x: 400, y: 500 });
    const [win] = made;
    win.emit("ready-to-show");
    win.isFocused = () => win.visible && focused();
    win.contents.get("context-menu")!({}, { editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } });
    return { win, closeMenu: () => menus[menus.length - 1].popup!.callback!() };
  }

  it("goes away, instead of taking the keyboard back, when the user dismissed its menu by clicking another app (review #77)", () => {
    // The click on the other app took the keyboard while the menu was up: a blur, and no focus since.
    const { win, closeMenu } = withMenu(() => false);
    win.emit("blur");
    const focused = win.focused;
    closeMenu();
    vi.advanceTimersByTime(500);
    expect(win.visible).toBe(false);
    expect(win.focused).toBe(focused);
  });

  it("goes away when that click's blur comes just after the menu has closed (review #77)", () => {
    const { win, closeMenu } = withMenu(() => false);
    const focused = win.focused;
    closeMenu();
    win.emit("blur");
    vi.advanceTimersByTime(500);
    expect(win.visible).toBe(false);
    expect(win.focused).toBe(focused);
  });

  it("takes the keyboard back when the menu closed and nothing else took it", () => {
    const { win, closeMenu } = withMenu(() => false);
    const focused = win.focused;
    closeMenu();
    vi.advanceTimersByTime(500);
    expect(win.visible).toBe(true);
    expect(win.focused).toBe(focused + 1);
  });
});
