import { describe, expect, it } from "vitest";
import { recognitionScore } from "../../scripts/voice/word-errors";

describe("recognition benchmark", () => {
  it("sees both a corrected and a damaged word when the error rate stays the same", () => {
    expect(recognitionScore("Open Jira and call Priya", "Open Jeera and call Priya", "Open Jira and call Riya"))
      .toEqual({ errors: 1, words: 5, improved: 1, harmed: 1 });
  });

  it("counts missed repeated words and keeps extra words in the edit distance", () => {
    expect(recognitionScore("New York New York", "New York New York", "New York"))
      .toEqual({ errors: 2, words: 4, improved: 0, harmed: 2 });
    expect(recognitionScore("Open Notes", "Open Notes", "Please open Notes"))
      .toEqual({ errors: 1, words: 2, improved: 0, harmed: 0 });
  });
});
