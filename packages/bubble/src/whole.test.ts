import { describe, it, expect } from "vitest";
import { WHOLE_READ_HINT, wholeInView, wholeJudged, wholeNext, wholePage, wholeUnreported, type WholeMetrics, type WholeState } from "./whole";
import { announcement, wholeReadNews, BUBBLE_CSS, type BubbleView } from "./bubble";

const TEXT = `Dear team, ${"the figures are attached. ".repeat(4)}MIDDLE-SECRET-PAYLOAD ${"see you at lunch. ".repeat(5)}Bye`;
const state = (o: Partial<WholeState> = {}): WholeState => ({ n: 3, text: TEXT, seen: false, page: 0, ...o });
/** A block 140 px high showing 400 px of text, on a 900 px screen, scrolled to `scrollTop`. */
const block = (scrollTop: number, o: Partial<WholeMetrics> = {}): WholeMetrics => ({ scrollTop, scrollHeight: 400, clientHeight: 140, top: 300, bottom: 452, viewportHeight: 900, ...o });
const shown = { shown: true, fontsLoaded: true };

describe("the whole text's block (review #116)", () => {
  it("is in view only once scrolled to its end, or when it fits", () => {
    expect(wholeInView(block(0), shown)).toBe(false);
    expect(wholeInView(block(200), shown)).toBe(false);
    expect(wholeInView(block(259.5), shown)).toBe(true); // sub-pixel layout
    expect(wholeInView(block(260), shown)).toBe(true);
    expect(wholeInView(block(0, { scrollHeight: 120, clientHeight: 120 }), shown)).toBe(true);
  });

  it("isn't in view hidden, before its typeface is in, off the screen, or unmeasured", () => {
    const fits = block(0, { scrollHeight: 120, clientHeight: 120 });
    expect(wholeInView(fits, { shown: false, fontsLoaded: true })).toBe(false);
    expect(wholeInView(fits, { shown: true, fontsLoaded: false })).toBe(false);
    // Its foot below the screen's edge (a bubble taller than the screen), or its head above it.
    expect(wholeInView({ ...fits, top: 800, bottom: 960 }, shown)).toBe(false);
    expect(wholeInView({ ...fits, top: -40, bottom: 120 }, shown)).toBe(false);
    for (const odd of [{ clientHeight: 0, scrollHeight: 0 }, { scrollTop: Number.NaN }, { bottom: Number.POSITIVE_INFINITY }]) {
      expect(wholeInView({ ...fits, ...odd }, shown), JSON.stringify(odd)).toBe(false);
    }
  });

  it("arms (seen, said once) only after its end has been in view, and stays so for that question", () => {
    let { view } = wholeNext(null, state());
    expect(view).toEqual({ n: 3, text: TEXT, seen: false, paged: 0 });
    let r = wholeJudged(view!, wholeInView(block(0), shown));
    expect(r).toEqual({ view, report: false });
    r = wholeJudged(r.view, wholeInView(block(260), shown));
    expect(r.view.seen).toBe(true);
    expect(r.report).toBe(true);
    // Scrolled back up: still seen, not said again.
    expect(wholeJudged(r.view, wholeInView(block(0), shown))).toEqual({ view: r.view, report: false });
    // The same question in the next state: still seen; main is told until its state says it knows.
    ({ view } = wholeNext(r.view, state()));
    expect(view?.seen).toBe(true);
    expect(wholeUnreported(view, state())).toBe(true);
    expect(wholeUnreported(view, state({ seen: true }))).toBe(false);
    expect(wholeUnreported(view, state({ n: 4 }))).toBe(false);
  });

  it("starts unread and from the top for another question, even with the same text, unless main says it was read", () => {
    const seen = wholeNext(null, state({ seen: true })).view!;
    const next = wholeNext(seen, state({ n: 4 }));
    expect(next).toEqual({ view: { n: 4, text: TEXT, seen: false, paged: 0 }, fresh: true, pages: 0 });
    // Read on another display's bubble: main's word counts here.
    expect(wholeNext(null, state({ seen: true })).view?.seen).toBe(true);
    expect(wholeNext(next.view, state({ n: 4, seen: true })).view?.seen).toBe(true);
    // No whole text, or an empty one: none.
    expect(wholeNext(seen, null)).toEqual({ view: null, fresh: false, pages: 0 });
    expect(wholeNext(null, state({ text: "" })).view).toBeNull();
  });

  it("scrolls on a page for each press of the approve key since the last state, never for an earlier question's", () => {
    let r = wholeNext(null, state({ page: 2 }));
    expect(r.pages).toBe(0); // presses for this question before the page heard of it: it starts at the top
    r = wholeNext(r.view, state({ page: 3 }));
    expect(r.pages).toBe(1);
    r = wholeNext(r.view, state({ page: 5 }));
    expect(r.pages).toBe(2);
    r = wholeNext(r.view, state({ page: 5 }));
    expect(r.pages).toBe(0);
    expect(wholeNext(r.view, state({ page: -1 })).pages).toBe(0);
    // A page is the block's height less a line, so the reader keeps their place.
    expect(wholePage(140, 20)).toBe(120);
    expect(wholePage(10, 20)).toBe(20);
    expect(wholePage(140, Number.NaN)).toBe(120);
  });

  it("says to scroll as the consent cards do", () => {
    expect(WHOLE_READ_HINT).toBe("Scroll down to read it all first.");
  });
});

describe("the whole text in the bubble", () => {
  const SENTENCE = "Type “Dear…Bye” (191 characters) into the “Message” text field?";
  const v: BubbleView = { visible: true, mood: "attention", title: "May I?", thought: SENTENCE, streaming: false, step: "Ctrl+Alt+Y allow · Ctrl+Alt+N not now" };
  /** As main sends it while the whole text waits to be read: the approve key shows the next part. */
  const unread: BubbleView = { ...v, step: "Ctrl+Alt+Y shows the next part · Ctrl+Alt+N not now", whole: TEXT, wholeSeen: false };
  const read: BubbleView = { ...v, whole: TEXT, wholeSeen: true };

  it("is heard whole after the question, then, in words that work without sight, that Allow waits for all of it to be shown", () => {
    expect(announcement(unread)).toBe(`Ember needs you: May I? ${SENTENCE} The whole text: ${TEXT}. You can allow it once all of it has been shown. Ctrl+Alt+Y shows the next part; Ctrl+Alt+N not now.`);
    // Once it has been, the question heard afresh (shown again later) says the keys that answer it.
    expect(announcement(read)).toBe(`Ember needs you: May I? ${SENTENCE} The whole text: ${TEXT}. Ctrl+Alt+Y allow; Ctrl+Alt+N not now.`);
    // Without one, as before.
    expect(announcement(v)).toBe(`Ember needs you: May I? ${SENTENCE} Ctrl+Alt+Y allow; Ctrl+Alt+N not now.`);
  });

  it("once all of it has been shown, says only that and the keys, not the question and its text again", () => {
    expect(wholeReadNews(unread, read)).toBe("You can allow it now. Ctrl+Alt+Y allow; Ctrl+Alt+N not now.");
    // Paged on, still unread: nothing new (the caller says nothing when the announcement is the same).
    expect(wholeReadNews(unread, { ...unread })).toBeNull();
    // Another question (other words, or another text), or nothing heard before: the whole announcement.
    expect(wholeReadNews(null, read)).toBeNull();
    expect(wholeReadNews({ ...unread, thought: "Type “Hi…Bye” (170 characters) into the “To” text field?" }, read)).toBeNull();
    expect(wholeReadNews({ ...unread, whole: `${TEXT}!` }, read)).toBeNull();
    expect(wholeReadNews({ ...unread, visible: false }, read)).toBeNull();
    expect(wholeReadNews(read, read)).toBeNull();
    // No keys held: the news alone.
    expect(wholeReadNews(unread, { ...read, step: null })).toBe("You can allow it now.");
  });

  it("is a panel on the glass that scrolls and takes the wheel, every character as typed, with Allow dimmed until it is read", () => {
    const rule = (sel: string) => new RegExp(`(?:^|\\n)${sel.replace(/[.[\]()*"=]/g, "\\$&")} \\{([^}]*)\\}`).exec(BUBBLE_CSS)?.[1] ?? "";
    const block = rule(".eb-whole");
    expect(block).toMatch(/overflow-y: auto;/);
    expect(block).toMatch(/pointer-events: auto;/);
    expect(block).toMatch(/white-space: pre-wrap;/);
    expect(block).toMatch(/max-height: \d+lh;/);
    // No glass on glass: a flat fill and a hairline.
    expect(block).toMatch(/background: rgba\(255, 255, 255, 0\.06\);/);
    expect(block).not.toMatch(/var\(--glass/);
    expect(rule(".eb-whole-hint")).toMatch(/color: var\(--label-2/);
    expect(rule('.eb-actions button[aria-disabled="true"]')).toMatch(/opacity: 0\.4;/);
  });
});
