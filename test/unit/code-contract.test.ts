/**
 * The pure parts of the coding window's contract that main and the window share or main decides alone: which
 * addresses main opens in the person's browser (`linkRefusal`), when a start opens the coding window
 * (`opensCodeAtStart`), and when the microphone holds the live regions (`voiceHoldsLive`, Home's rule too).
 */
import { describe, expect, it } from "vitest";
import { CODE_LIMITS, linkRefusal } from "../../app/shared/code";
import { opensCodeAtStart, startView } from "../../app/main/launcher";
import { voiceHoldsLive } from "../../app/shared/ipc";

describe("an address from the coding window", () => {
  it("is opened only when it is http or https, has a host, fits the limit and carries no user name or password", () => {
    expect(linkRefusal("https://example.com/docs?q=1#a")).toBeNull();
    expect(linkRefusal("http://localhost:5173/")).toBeNull();
    for (const bad of ["", "file:///etc/passwd", "javascript:alert(1)", "mailto:a@example.com", "ftp://example.com/", "ember://x", "https://", "example.com", 42, null])
      expect(linkRefusal(bad), String(bad)).toBe("not-web");
    expect(linkRefusal(`https://example.com/${"a".repeat(CODE_LIMITS.link)}`)).toBe("too-long");
    expect(linkRefusal("https://user:pass@example.com/")).toBe("credentials");
    expect(linkRefusal("https://user@example.com/")).toBe("credentials");
  });
});

describe("a start of Ember with coding sessions on", () => {
  const view = (o: Partial<Parameters<typeof startView>[0]> = {}) => startView({ onboarded: true, showSettings: false, atLogin: false, sessionProblem: false, ask: false, ...o });

  it("opens the coding window by hand beside greeting or settings, and never at login, for Ask Ember or before setup (the live journey's first defect)", () => {
    expect(opensCodeAtStart({ view: view(), onboarded: true, atLogin: false })).toBe(true);
    // A setup row the desktop needs opens settings; the coding window doesn't need it, so it opens too.
    expect(view({ setupNeeded: true })).toBe("settings");
    expect(opensCodeAtStart({ view: view({ setupNeeded: true }), onboarded: true, atLogin: false })).toBe(true);
    expect(opensCodeAtStart({ view: view({ showSettings: true }), onboarded: true, atLogin: false })).toBe(true);
    expect(opensCodeAtStart({ view: view({ atLogin: true }), onboarded: true, atLogin: true })).toBe(false);
    expect(opensCodeAtStart({ view: view({ ask: true }), onboarded: true, atLogin: false })).toBe(false);
    expect(opensCodeAtStart({ view: view({ onboarded: false }), onboarded: false, atLogin: false })).toBe(false);
  });
});

describe("the microphone's hold on live regions", () => {
  it("holds while it is open or opening for a request, Listen once starts or listens, or Voice Match is taught", () => {
    expect(voiceHoldsLive({ state: "active" })).toBe(true);
    expect(voiceHoldsLive({ state: "starting" })).toBe(true);
    expect(voiceHoldsLive({ state: "listening", listenOnce: { phase: "listening" } } as never)).toBe(true);
    expect(voiceHoldsLive({ state: "listening", match: { enrolling: true } } as never)).toBe(true);
    expect(voiceHoldsLive({ state: "listening" } as never)).toBe(false);
    expect(voiceHoldsLive({ state: "off" } as never)).toBe(false);
  });
});
