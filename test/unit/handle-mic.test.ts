/**
 * The handle's microphone badge and the remote computer's state on it: each state has its own shape as well as its
 * colour, its words reach screen readers, and a microphone that can't work says so in words (review #246, #59, #73).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { idleLine, micAnnouncement, micBadge, MIC_PROBLEM_MENU } from "../../app/shared/mic";
import type { MicState } from "../../app/shared/voice";
import { HandleLive } from "../../app/renderer/handle/live";

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
const STATES: MicState[] = ["off", "needs-models", "downloading", "starting", "waiting", "active", "muted", "error"];

describe("the microphone badge", () => {
  it("shows whenever listening is on, and nothing when it is off", () => {
    expect(micBadge("off")).toBeNull();
    expect(micBadge(undefined)).toBeNull();
    for (const s of STATES.filter(x => x !== "off")) expect(micBadge(s), s).not.toBeNull();
  });

  it("gives listening, off, not ready and a problem each their own shape, not only their own colour (WCAG 1.4.1; review #246, #59, #73)", () => {
    expect(micBadge("waiting")!.glyph).toBe("mic");
    expect(micBadge("active")!.glyph).toBe("mic");
    expect(micBadge("muted")!.glyph).toBe("mic-off");
    expect(micBadge("needs-models")!.glyph).toBe("mic-off");
    expect(micBadge("downloading")!.glyph).toBe("working");
    expect(micBadge("starting")!.glyph).toBe("working");
    expect(micBadge("error")!.glyph).toBe("problem");
    // Each shape is drawn with its own mask.
    const css = read("app/renderer/handle/styles.css");
    const masks = (["mic", "mic-off", "working", "problem"] as const).map(g => {
      // The microphone is the badge's own look; the others override it.
      const sel = g === "mic" ? "^\\.mic" : `\\.mic\\[data-glyph="${g}"\\]`;
      const m = new RegExp(`${sel} \\{[^}]*--mic-glyph: (var\\(--sym-[\\w-]+\\))`, "m").exec(css);
      return m?.[1];
    });
    expect(masks.every(Boolean), String(masks)).toBe(true);
    expect(new Set(masks).size).toBe(4);
  });

  it("says its state in words, to the tooltip and to screen readers", () => {
    expect(micBadge("waiting")!.label).toBe("Listening for “Hey Ember”");
    expect(micBadge("active")!.label).toBe("Hearing you");
    expect(micBadge("muted")!.label).toBe("Microphone off");
    expect(micBadge("error")!.label).toBe("Microphone problem");
    expect(micBadge("needs-models")!.label).toBe("Voice isn't set up: download the speech models in Settings");
    expect(micBadge("downloading")!.label).toBe("Downloading speech models…");
    expect(micBadge("starting")!.label).toBe("Starting to listen…");
    // Not hidden from assistive technology: an image with the words as its name.
    const tag = /<i id="mic"[^>]*>/.exec(read("app/renderer/handle/index.html"))![0];
    expect(tag).toContain('role="img"');
    expect(tag).not.toContain("aria-hidden");
  });

  it("says a microphone problem, or voice that isn't set up, on the handle instead of \"Ready\" (review #73)", () => {
    expect(idleLine("Ready", "error")).toBe("Microphone problem");
    expect(idleLine(undefined, "error")).toBe("Microphone problem");
    expect(idleLine("Ready", "needs-models")).toBe("Voice isn't set up");
    expect(idleLine("Ready", "waiting")).toBe("Ready");
    expect(idleLine(undefined, "muted")).toBe("Ready");
    // What Copilot's connection says comes first: Ember can't answer at all then.
    expect(idleLine("Not connected", "error")).toBe("Not connected");
  });

  it("is said once when it changes to something the user must know, never while they talk to Ember", () => {
    expect(micAnnouncement("error")).toBe("Microphone problem");
    expect(micAnnouncement("muted")).toBe("Microphone off");
    expect(micAnnouncement("needs-models")).toBe("Voice isn't set up");
    for (const s of ["waiting", "active", "starting", "downloading", "off"] as const) expect(micAnnouncement(s), s).toBeNull();
  });

  it("offers the way to fix a microphone problem in the handle's menu (review #73)", () => {
    expect(MIC_PROBLEM_MENU).toBe("Microphone problem: open Settings…");
    expect(read("app/main/main.ts")).toMatch(/voice\?\.micState === "error"[^\n]*MIC_PROBLEM_MENU/);
  });
});

describe("what the handle says about the microphone in its live region", () => {
  /** Feeds microphone states in order, as main sends them; what is said at each. */
  const said = (states: MicState[]) => { const live = new HandleLive(); return states.map(s => live.micNews(s)); };

  it("says a microphone problem once while Ember keeps retrying, not at every retry (review #73)", () => {
    // VoiceService.restartLater: error, starting again after 1 s, error, after 5 s, error, then every 30 s.
    expect(said(["waiting", "error", "starting", "error", "starting", "error"])).toEqual([null, "Microphone problem", null, null, null, null]);
    // Through the speech models' download too.
    expect(said(["waiting", "error", "downloading", "starting", "error"])).toEqual([null, "Microphone problem", null, null, null]);
  });

  it("says it again when listening worked in between, and when it breaks while starting (review #73)", () => {
    expect(said(["waiting", "error", "starting", "waiting", "error"])).toEqual([null, "Microphone problem", null, null, "Microphone problem"]);
    expect(said(["muted", "starting", "waiting", "muted"])).toEqual([null, null, null, "Microphone off"]);
    // Ember starting to listen as it opens, then failing: news (the first state is only what it was).
    expect(said(["starting", "error"])).toEqual([null, "Microphone problem"]);
    expect(said(["error", "starting", "error"])).toEqual([null, null, null]);
    expect(said(["off", "starting", "error"])).toEqual([null, null, "Microphone problem"]);
  });

  it("says \"Microphone off\" once in the no-compositor card when the shortcut mutes it (review #59)", () => {
    // main's toggleMute: the voice state changes to muted, then its status line says the same words for 2.5 s.
    // announce() in handle/main.ts: the bubble's words (none here), then these, as one live update (null: nothing).
    const live = new HandleLive();
    const update = (mic: MicState, status: string | null) => live.news(status, live.micNews(mic)).join(" ") || null;
    expect(update("waiting", null)).toBeNull();
    expect(update("muted", null)).toBe("Microphone off");
    expect(update("muted", "Microphone off")).toBeNull();
    expect(update("muted", null)).toBeNull();
    // Unmuted and muted again: said again.
    expect(update("starting", null)).toBeNull();
    expect(update("waiting", null)).toBeNull();
    expect(update("muted", null)).toBe("Microphone off");
    expect(update("muted", "Microphone off")).toBeNull();
    // A status line with other words is said as before.
    expect(update("muted", "Using your mouse: move it to take over")).toBe("Using your mouse: move it to take over");
  });

  it("says it once in whichever order the two updates come, or when they come together (review #59)", () => {
    // announce() in handle/main.ts: the bubble's words (none here), then these, as one live update (null: nothing).
    const live = new HandleLive();
    const update = (mic: MicState, status: string | null) => live.news(status, live.micNews(mic)).join(" ") || null;
    update("waiting", null);
    expect(update("waiting", "Microphone off")).toBe("Microphone off");
    expect(update("muted", "Microphone off")).toBeNull();
    update("muted", null); update("starting", null); update("waiting", null);
    expect(update("muted", "Microphone off")).toBe("Microphone off");
  });

  it("still says the same status line again later, once the microphone's news is used up", () => {
    // announce() in handle/main.ts: the bubble's words (none here), then these, as one live update (null: nothing).
    const live = new HandleLive();
    const update = (mic: MicState, status: string | null) => live.news(status, live.micNews(mic)).join(" ") || null;
    update("waiting", null);
    expect(update("muted", null)).toBe("Microphone off");
    expect(update("muted", "Using your mouse: move it to take over")).toBe("Using your mouse: move it to take over");
    // The microphone's news was not on the status line this time: a later "Microphone off" line is new.
    expect(update("muted", "Microphone off")).toBe("Microphone off");
  });

  it("is what the handle page uses, in the pill and the card alike", () => {
    const main = read("app/renderer/handle/main.ts");
    expect(main).toContain("const live = new HandleLive();");
    expect(main).toMatch(/const micNews = live\.micNews\(s\.mic\)/);
    expect(main).toMatch(/parts\.push\(\.\.\.live\.news\(status, micNews\)\);/);
    expect(main).toMatch(/announce\(b, s\.status \?\? null, micNews\);/);
  });
});

describe("the remote computer's badge on the handle", () => {
  it("draws ready, connecting, not connected and lost as different shapes, not only colours (WCAG 1.4.1; review #59)", () => {
    const css = read("app/renderer/handle/styles.css");
    const look = (state: string) => new RegExp(`\\.target\\[data-state="${state}"\\] \\.target-dot \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    const masks = ["connecting", "off", "lost"].map(s => /-webkit-mask: (var\(--sym-[\w-]+\))/.exec(look(s))?.[1]);
    expect(masks.every(Boolean), String(masks)).toBe(true);
    expect(new Set(masks).size).toBe(3);
    // Ready is the plain filled dot (no mask).
    expect(/^\.target-dot \{([^}]*)\}/m.exec(css)![1]).not.toContain("-webkit-mask");
  });
});
