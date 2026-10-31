/**
 * The default models by cost as well as by name (review #144): a model that costs several premium requests per call
 * isn't picked over a standard one just because the list put it first, and the conversation doesn't land on a model
 * tuned for code or a slow reasoning one. (Made-up model ids.)
 */

import { describe, expect, it } from "vitest";
import { chooseModels, costOf, type ModelLike } from "../../app/main/agent/models";

const vision = (id: string, multiplier?: number): ModelLike => ({ id, capabilities: { supports: { vision: true } }, ...(multiplier !== undefined ? { billing: { multiplier } } : {}) });
const text = (id: string, multiplier?: number): ModelLike => ({ id, capabilities: { supports: { vision: false } }, ...(multiplier !== undefined ? { billing: { multiplier } } : {}) });

describe("choosing the default models by cost", () => {
  it("the worker is a standard (at most 1×) vision model, not a premium one listed first", () => {
    expect(chooseModels([vision("delta-ultra", 10), vision("delta-pro", 1), vision("delta-mini", 0)]).worker).toBe("delta-pro");
    // Only premium ones: the cheapest.
    expect(chooseModels([vision("delta-ultra", 10), vision("delta-max", 3)]).worker).toBe("delta-max");
    expect(chooseModels([vision("gamma-flash", 5), vision("gamma-lite", 2)]).conductor).toBe("gamma-lite");
  });

  it("the conversation is a small standard model that isn't tuned for code or a slow reasoning one", () => {
    expect(chooseModels([text("o9-mini", 0.33), text("beta-code-fast-1", 0), vision("alpha-mini", 0), vision("alpha-pro", 1)]).conductor).toBe("alpha-mini");
    // No small one fits: a standard general model rather than a code-tuned small one.
    expect(chooseModels([text("beta-code-fast-1", 0), vision("alpha-pro", 1)]).conductor).toBe("alpha-pro");
    // A premium small model isn't picked over a standard one.
    expect(chooseModels([vision("gamma-flash", 5), vision("gamma-lite", 1)]).conductor).toBe("gamma-lite");
  });

  it("models without billing information count as standard, so the choice is as before", () => {
    const models = [vision("alpha-pro"), vision("alpha-mini"), text("text-only-mini")];
    expect(chooseModels(models)).toEqual({ conductor: "alpha-mini", worker: "alpha-pro" });
    expect(costOf(vision("x"))).toBe(1);
    expect(costOf(vision("x", 0))).toBe(0);
  });

  it("the user's own choice always wins, whatever it costs", () => {
    expect(chooseModels([vision("delta-ultra", 10), vision("delta-pro", 1)], { conductor: "delta-ultra", worker: "delta-ultra" })).toEqual({ conductor: "delta-ultra", worker: "delta-ultra" });
  });
});

describe("the settings window's model lists (review #144)", () => {
  it("say which models cost more than one premium request a call", async () => {
    const { modelLabel } = await import("../../app/renderer/home/copy");
    expect(modelLabel({ name: "Delta Ultra", cost: 10 })).toBe("Delta Ultra (10× premium requests)");
    expect(modelLabel({ name: "Delta Pro", cost: 1 })).toBe("Delta Pro");
    expect(modelLabel({ name: "Delta Mini", cost: 0 })).toBe("Delta Mini");
    expect(modelLabel({ name: "Delta Half", cost: 0.33 })).toBe("Delta Half");
    expect(modelLabel({ name: "Unknown" })).toBe("Unknown");
    expect(modelLabel({ name: "Delta Max", cost: 1.5 })).toBe("Delta Max (1.5× premium requests)");
  });
});
