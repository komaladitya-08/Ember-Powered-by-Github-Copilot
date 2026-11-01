/**
 * The microphone's errors in plain words (voice.ts micHelp): where the system refused the microphone (Windows, macOS
 * privacy settings), the platform's hint says where to allow it; Linux passes none and keeps today's text.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

const { micHelp } = await import("../../app/main/voice");

describe("micHelp", () => {
  const hint = "To allow it, open System Settings › Privacy & security › Microphone.";

  it("keeps today's text without a hint (Linux)", () => {
    expect(micHelp("NotAllowedError: Permission denied")).toBe("Ember wasn't allowed to use the microphone.");
    expect(micHelp("NotFoundError: Requested device not found")).toBe("No microphone was found.");
    expect(micHelp("NotReadableError: Could not start audio source")).toBe("The microphone is in use by another app or unavailable.");
    expect(micHelp("something else")).toBe("something else");
  });

  it("adds the platform's hint to a refusal only", () => {
    expect(micHelp("NotAllowedError: Permission denied", hint)).toBe(`Ember wasn't allowed to use the microphone. ${hint}`);
    expect(micHelp("NotFoundError: Requested device not found", hint)).toBe("No microphone was found.");
  });
});
