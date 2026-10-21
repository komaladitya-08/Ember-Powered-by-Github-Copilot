import { describe, expect, it } from "vitest";
import { armMsFor, TASK_ARM_MS } from "../../app/renderer/handle/arm";

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
});
