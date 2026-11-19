import { describe, expect, it } from "vitest";
import { validCodingClarification } from "../../app/main/agent/coding-worker";

describe("coding clarification", () => {
  it("accepts complete questions and the full set of choices supported by the prompt", () => {
    expect(validCodingClarification({ question: "Which one?", choices: Array.from({ length: 20 }, (_, n) => `Choice ${n}`), allowFreeform: false })).toBe(true);
    expect(validCodingClarification({ question: "What next?" })).toBe(true);
  });
  it("rejects data that cannot be shown in full instead of truncating it", () => {
    expect(validCodingClarification({ question: "x".repeat(2001) })).toBe(false);
    expect(validCodingClarification({ question: "Which?", choices: ["x".repeat(201)] })).toBe(false);
    expect(validCodingClarification({ question: "Which?", choices: Array(21).fill("x") })).toBe(false);
    expect(validCodingClarification({ question: "Which?", allowFreeform: false })).toBe(false);
  });
});
