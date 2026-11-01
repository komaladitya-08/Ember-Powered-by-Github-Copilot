/**
 * The ask box's ↑/↓ history (renderer/ask/history.ts). Review #69: the update that follows each opening (what Ember
 * will see, once the quick look is done) reset the place in the list and dropped the half-typed text.
 */

import { describe, expect, it } from "vitest";
import { AskHistory } from "../../app/renderer/ask/history";

const HISTORY = ["first question", "second question", "third question"];

describe("the ask box's history", () => {
  it("goes back from the newest and forward to what was being typed", () => {
    const h = new AskHistory();
    h.context(HISTORY, true);
    expect(h.step(-1, "half typed")).toBe("third question");
    expect(h.step(-1, "third question")).toBe("second question");
    expect(h.step(-1, "second question")).toBe("first question");
    expect(h.step(-1, "first question")).toBe("first question");
    expect(h.step(1, "first question")).toBe("second question");
    expect(h.step(1, "second question")).toBe("third question");
    expect(h.step(1, "third question")).toBe("half typed");
    expect(h.step(1, "half typed")).toBe("half typed");
  });

  it("keeps the place when what Ember will see arrives after the box opened", () => {
    const h = new AskHistory();
    h.context(HISTORY, true);
    expect(h.step(-1, "")).toBe("third question");
    expect(h.step(-1, "third question")).toBe("second question");
    h.context(HISTORY, false);
    expect(h.step(-1, "second question")).toBe("first question");
  });

  it("keeps the half-typed text through that update", () => {
    const h = new AskHistory();
    h.context(HISTORY, true);
    expect(h.step(-1, "my half typed draft")).toBe("third question");
    h.context(HISTORY, false);
    expect(h.step(1, "third question")).toBe("my half typed draft");
  });

  it("starts again at the newest each time the box opens, and when the list itself changed", () => {
    const h = new AskHistory();
    h.context(HISTORY, true);
    h.step(-1, "");
    h.step(-1, "");
    h.context(HISTORY, true);
    expect(h.step(-1, "")).toBe("third question");
    // A box still loading when its first update came: the list arrives with that update.
    const late = new AskHistory();
    late.context(HISTORY, false);
    expect(late.size).toBe(3);
    expect(late.step(-1, "")).toBe("third question");
  });

  it("does nothing without earlier questions", () => {
    const h = new AskHistory();
    h.context([], true);
    expect(h.step(-1, "text")).toBeNull();
    expect(h.size).toBe(0);
  });
});
