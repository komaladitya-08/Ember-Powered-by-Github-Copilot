/**
 * friendlyError for the errors that used to reach the bubble raw (review #219, #23): timeouts, a long conversation's
 * token limit, a bare status code, and anything else unrecognised (said plainly with a next step; the raw text goes to
 * the log only).
 */

import { describe, expect, it } from "vitest";
import { friendlyError } from "../../app/main/agent/presenter";

describe("friendlyError: what used to show raw", () => {
  it("a timeout is Copilot taking too long, not a code error", () => {
    expect(friendlyError("Request timed out after 60000ms")).toBe("Copilot took too long to answer. Try again in a moment.");
    expect(friendlyError("Error: timeout of 30000ms exceeded")).toBe("Copilot took too long to answer. Try again in a moment.");
    // A network timeout is still the network.
    expect(friendlyError("connect ETIMEDOUT 140.82.112.5:443")).toMatch(/can't reach Copilot/);
  });

  it("anything unrecognised gets a next step, and none of the raw text", () => {
    for (const raw of ["Cannot read properties of undefined (reading 'content')", "Unexpected token < in JSON at position 0", "Session not found: 7f3c", "Something odd {\"x\":1}"]) {
      const said = friendlyError(raw, undefined, { settingsKey: "Ctrl+Alt+E" });
      expect(said).toBe("Copilot reported a problem. Try again; if it keeps happening, check Copilot in Ember's settings (Ctrl+Alt+E).");
    }
    expect(friendlyError("odd", undefined, { provider: true })).toMatch(/ reported a problem\. Try again/);
    expect(friendlyError("odd", undefined, { provider: true })).not.toMatch(/odd/);
  });

  it("a long conversation's token limit says so", () => {
    for (const raw of ["CAPIError: 400 prompt token count of 140000 exceeds the limit of 128000", "Error: 400 {\"error\":{\"code\":\"model_max_prompt_tokens_exceeded\"}}"]) {
      expect(friendlyError(raw)).toMatch(/conversation may have got too long/);
    }
    // A single request too large: as before.
    expect(friendlyError("context length exceeded")).toBe("That was too much for me to handle at once. Try a shorter request.");
  });

  it("a bare status code is a refused request, with what to try", () => {
    expect(friendlyError("Error: 400 {\"error\":{\"message\":\"\"}}")).toBe("Copilot refused that request (400). Try asking in other words.");
    expect(friendlyError("422")).toBe("Copilot refused that request (422). Try asking in other words.");
  });
});
