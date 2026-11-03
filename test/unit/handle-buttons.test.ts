import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ArmClock, armMsFor, TASK_ARM_MS } from "../../app/renderer/handle/arm";
import { cardAutonomous, cardRisky } from "../../app/renderer/handle/card";

describe("corner card buttons", () => {
  it("does not make a question's Allow wait longer than the Confirmer's own arm", () => {
    expect(armMsFor([{ id: "q1:once" }, { id: "q1:deny" }])).toBe(0);
    expect(armMsFor([{ id: "ui:settings" }])).toBe(0);
    expect(armMsFor([])).toBe(0);
  });

  it("still arms a new task card's Stop/Close so a resting pointer cannot press it", () => {
    expect(armMsFor([{ id: "task:abc:stop" }])).toBe(TASK_ARM_MS);
    expect(armMsFor([{ id: "task:abc:dismiss" }])).toBe(TASK_ARM_MS);
  });

  it("arms the bubble's Try again and Stop as a card's, but never a question's buttons (UI audit)", () => {
    expect(armMsFor([{ id: "ui:retry" }])).toBe(TASK_ARM_MS);
    expect(armMsFor([{ id: "ui:stop" }])).toBe(TASK_ARM_MS);
    const clock = new ArmClock();
    clock.shown(["ui:retry", "q1:once"], 1000);
    expect(clock.ready("ui:retry", 1000 + TASK_ARM_MS - 1)).toBe(false);
    expect(clock.ready("q1:once", 1000)).toBe(true);
    // Shown again by a later update: still the same button, armed from when it first came up.
    clock.shown(["ui:retry"], 1500);
    expect(clock.ready("ui:retry", 1000 + TASK_ARM_MS)).toBe(true);
    // Gone and back: armed again.
    clock.shown([], 3000);
    clock.shown(["ui:retry"], 3100);
    expect(clock.ready("ui:retry", 3200)).toBe(false);
    expect(readFileSync("app/renderer/overlay/main.ts", "utf8")).toContain("if (bubbleArm.ready(a.id, performance.now())) api.bubbleAction(a.id);");
  });
});

describe("a risky question on the corner card (no compositor)", () => {
  const css = readFileSync("app/renderer/handle/styles.css", "utf8");
  const ask = { visible: true, mood: "attention" as const };

  it("is marked only while a risky question is on screen (UI audit 5)", () => {
    expect(cardRisky({ ...ask, risky: true })).toBe(true);
    expect(cardRisky({ ...ask })).toBe(false);
    expect(cardRisky({ ...ask, risky: true, visible: false })).toBe(false);
    expect(cardRisky({ visible: true, mood: "idle", risky: true })).toBe(false);
    const main = readFileSync("app/renderer/handle/main.ts", "utf8");
    expect(main).toContain("if (document.body.dataset.risky !== risky) document.body.dataset.risky = risky;");
    expect(main).toContain('$("risk").textContent = RISKY_TAG;');
  });

  it("shows the Risky step tag and an Allow bordered in the caution colour, not filled, as the bubble does (UI audit 5)", () => {
    expect(css).toContain('body.fallback[data-risky="true"] .risk { display: inline-flex; }');
    expect(css).toContain('body[data-risky="true"] .actions button.primary { background: rgba(255, 255, 255, 0.08); color: var(--label); box-shadow: inset 0 0 0 1.5px var(--yellow); }');
    // Forced colours: a plain button with a firmer edge; Increase Contrast: a firmer caution edge.
    expect(css).toContain('body[data-risky="true"] .actions button.primary { forced-color-adjust: auto; color: ButtonText; background: ButtonFace; border: 2px solid CanvasText; }');
    expect(css).toContain('body[data-risky="true"] .actions button.primary { box-shadow: inset 0 0 0 2px var(--yellow); }');
  });

  it("shows Ember's own Without asking tag on the corner card, as the bubble does, and lines its buttons up under the words (HIG alerts)", () => {
    expect(cardAutonomous({ visible: true, autonomous: true })).toBe(true);
    expect(cardAutonomous({ visible: true })).toBe(false);
    expect(cardAutonomous({ visible: false, autonomous: true })).toBe(false);
    const main = readFileSync("app/renderer/handle/main.ts", "utf8");
    expect(main).toContain('$("auto").textContent = AUTONOMOUS_TAG;');
    expect(main).toContain("if (document.body.dataset.autonomous !== autonomous) document.body.dataset.autonomous = autonomous;");
    expect(css).toContain('body.fallback[data-autonomous="true"] .auto { display: inline-flex; }');
    // 8 px in, the 96 px face and its 10 px gap: the buttons start where the words do.
    expect(css).toContain("body.fallback .actions { margin-left: 114px; }");
    expect(css).toMatch(/body\.fallback \.handle \{[^}]*padding: 12px 16px 8px 8px;/);
    expect(css).toContain("body.fallback #face { width: 96px; height: 96px; }");
  });
});
