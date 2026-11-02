/** Ember's presence (docs/DESIGN.md "Presence"): the ring's states, the sound levels that drive it, and the handle's line. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LEVEL_MS, LEVEL_STEPS, LevelMeter, NO_LEVEL, envelope, levelForOverlay, levelStep, readLevel, rms, voiceAt } from "../../app/shared/level";
import { DONE_RING_MS, RING_TICKS, meterBars, presenceOf, ticksLit } from "../../app/shared/presence";
import { handleLine } from "../../app/renderer/handle/line";
import { IDLE_BUBBLE, type TaskCard } from "../../app/shared/overlay";

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
const bubble = (mood: typeof IDLE_BUBBLE.mood, visible = true) => ({ ...IDLE_BUBBLE, visible, mood });

describe("the presence ring's state", () => {
  it("follows the bubble first, then a microphone that hears a request", () => {
    expect(presenceOf({ bubble: bubble("attention") })).toBe("needs");
    expect(presenceOf({ bubble: bubble("error") })).toBe("error");
    expect(presenceOf({ bubble: bubble("thinking") })).toBe("thinking");
    expect(presenceOf({ bubble: bubble("acting") })).toBe("acting");
    expect(presenceOf({ bubble: bubble("guiding") })).toBe("acting");
    expect(presenceOf({ bubble: bubble("done") })).toBe("done");
    expect(presenceOf({ bubble: bubble("listening") })).toBe("listening");
    expect(presenceOf({ bubble: bubble("idle", false), mic: "active" })).toBe("listening");
  });

  it("is idle (no ring by the cursor) at rest, while the wake word is only awaited, and for an answer", () => {
    expect(presenceOf({ bubble: IDLE_BUBBLE })).toBe("idle");
    expect(presenceOf({ bubble: IDLE_BUBBLE, mic: "waiting" })).toBe("idle");
    expect(presenceOf({ bubble: bubble("idle") })).toBe("idle");
    // A hidden bubble's mood says nothing.
    expect(presenceOf({ bubble: bubble("error", false) })).toBe("idle");
  });

  it("lights no tick on silence, and all of them at the loudest", () => {
    expect(ticksLit(0)).toBe(0);
    expect(ticksLit(null)).toBe(0);
    expect(ticksLit(undefined)).toBe(0);
    expect(ticksLit(LEVEL_STEPS)).toBe(RING_TICKS);
    expect(ticksLit(LEVEL_STEPS / 2)).toBe(RING_TICKS / 2);
    expect(ticksLit(99)).toBe(RING_TICKS);
  });

  it("rests the voice meter's bars low at no level, and raises the middle one most", () => {
    expect(meterBars(null)).toEqual([0.15, 0.15, 0.15, 0.15, 0.15]);
    const loud = meterBars(LEVEL_STEPS);
    expect(loud[2]).toBe(1);
    expect(loud[0]).toBeLessThan(loud[1]);
    expect(DONE_RING_MS).toBeLessThanOrEqual(2500);
  });
});

describe("sound levels for the presence (never audio)", () => {
  it("are eight steps on a decibel scale: silence is 0, a raised voice the top", () => {
    expect(levelStep(0)).toBe(0);
    expect(levelStep(0.0005)).toBe(0);
    expect(levelStep(0.25)).toBe(LEVEL_STEPS);
    const quiet = levelStep(0.006), louder = levelStep(0.05);
    expect(quiet).toBeGreaterThan(0);
    expect(louder).toBeGreaterThan(quiet);
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array())).toBe(0);
  });

  it("are sent at most 20 times a second and only when the step changes", () => {
    const sent: (number | null)[] = [];
    const m = new LevelMeter(l => sent.push(l));
    // A 512-sample frame every 32 ms for a second, alternating loud and quiet.
    for (let t = 0; t < 1000; t += 32) m.push(t % 64 ? 0.2 : 0.01, t);
    expect(sent.length).toBeLessThanOrEqual(1000 / LEVEL_MS);
    expect(sent.length).toBeGreaterThan(5);
    const steady: (number | null)[] = [];
    const n = new LevelMeter(l => steady.push(l));
    for (let t = 0; t < 1000; t += 32) n.push(0.05, t);
    expect(steady).toEqual([levelStep(0.05)]);
  });

  it("stop the meter at once when the stream ends, and say nothing more for a stream that never sent", () => {
    const sent: (number | null)[] = [];
    const m = new LevelMeter(l => sent.push(l));
    m.push(0.1, 0);
    m.push(0.01, 10);
    expect(m.pending).toBe(true);
    m.end();
    expect(sent).toEqual([levelStep(0.1), null]);
    expect(m.pending).toBe(false);
    m.end();
    expect(sent).toEqual([levelStep(0.1), null]);
    const none: (number | null)[] = [];
    new LevelMeter(l => none.push(l)).end();
    expect(none).toEqual([]);
  });

  it("find Ember's voice level by the audio clock, and none between or after its chunks", () => {
    const loud = new Float32Array(2400).fill(0.2);
    const spans = [{ at: 1, env: envelope(loud, 24_000), stepS: LEVEL_MS / 1000 }];
    expect(spans[0].env).toHaveLength(2);
    expect(voiceAt(spans, 1.02)).toBeCloseTo(0.2);
    expect(voiceAt(spans, 0.99)).toBeNull();
    expect(voiceAt(spans, 1.2)).toBeNull();
  });

  it("are read from a page only as known keys with whole steps (anything else is dropped)", () => {
    expect(readLevel({ mic: 3 })).toEqual({ mic: 3 });
    expect(readLevel({ voice: null })).toEqual({ voice: null });
    expect(readLevel({ mic: 9 })).toBeNull();
    expect(readLevel({ mic: 1.5 })).toBeNull();
    expect(readLevel({ mic: "3" })).toBeNull();
    expect(readLevel({ mic: 2, samples: [1] })).toBeNull();
    expect(readLevel({})).toBeNull();
    expect(readLevel([3])).toBeNull();
    expect(readLevel(null)).toBeNull();
  });

  it("reach the overlay apart from the state, and the microphone's only while Ember hears a request", () => {
    const voice = read("app/main/voice.ts");
    expect(voice).toContain('if (l.mic !== undefined && l.mic !== null && this.state !== "active") delete l.mic;');
    expect(voice).toContain("this.mic.webContents.send(VOICE.levelOn, hearing);");
    expect(voice).toContain("if (!hearing) this.o.onLevel?.({ mic: null });");
    expect(read("app/main/main.ts")).toContain("        overlay?.setLevel(l);\n");
    // First run's "Hey Ember" meter gets the microphone's level only while that step asks for it and the window shows.
    expect(read("app/main/main.ts")).toContain("if (homeWantsLevel && l.mic !== undefined && home && !home.isDestroyed() && home.isVisible() && !home.isMinimized()) home.webContents.send(IPC.homeLevel, l.mic);");
    // The mic page measures only while asked to, and ends the meter when told to stop.
    const mic = read("app/renderer/mic/main.ts");
    expect(mic).toContain("if (micLevels && ev.data instanceof ArrayBuffer) micMeter.push(");
    expect(mic).toContain("if (!on) micMeter.end();");
  });

  it("keep a meter's end while Ember is hidden, and start from nothing when it shows again (UI audit 4)", () => {
    expect(levelForOverlay({ mic: 3 }, false)).toEqual({ mic: 3 });
    expect(levelForOverlay({ mic: 3 }, true)).toBeNull();
    // A level and an end together: the end still reaches the overlay, so that meter isn't left lit.
    expect(levelForOverlay({ mic: 3, voice: null }, true)).toEqual({ voice: null });
    expect(levelForOverlay({ voice: null }, true)).toEqual({ voice: null });
    expect(NO_LEVEL).toEqual({ mic: null, voice: null });
    expect(read("app/main/overlay.ts")).toContain("if (shows) this.setLevel({ ...NO_LEVEL });");
  });
});

describe("the presence ring's styles (software compositing; Calm)", () => {
  const css = read("app/renderer/overlay/styles.css");
  it("moves only its unstyled wrapper, never rotates, and runs its finite effects a fixed number of times", () => {
    expect(css).toMatch(/\.presence \{ position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 0; pointer-events: none; will-change: transform; \}/);
    expect(css).toMatch(/\.presence\[hidden\] \{ display: none; \}/);
    expect(css).toMatch(/\.presence\[data-state="thinking"\] \.ring \{ animation: ring-glow 1\.6s ease-in-out 3; \}/);
    expect(css).toMatch(/\.presence\[data-state="done"\] \.ring \{ animation: ring-done 2\.2s ease 1 forwards; \}/);
    expect(css).not.toMatch(/@keyframes [\w-]+ \{[^}]*rotate/);
  });

  it("holds still in Calm and with reduced motion, and keeps its paint under forced colours", () => {
    expect(css).toMatch(/html\.calm \.presence \.ring, html\.calm \.presence\[data-state="acting"\] \.ring-now \{ animation: none; \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^\n]*\.ring, \.ring-now \{ animation: none; \}/);
    expect(css).toMatch(/\.tick, \.ring-now, \.mic-mark, \.mic-mark::before, \.meter, \.meter i \{ forced-color-adjust: none; \}/);
  });

  it("lights the microphone's level by opacity, never on a tick's colour (a repaint per level)", () => {
    expect(css).toMatch(/\.presence\[data-state="listening"\] \.tick\[data-on\] \{ opacity: 1; \}/);
  });

  it("gives the HUD tokens an Increase Contrast value and a forced-colours mapping", () => {
    const shared = read("app/renderer/shared/ember.css");
    for (const t of ["hud-line", "hud-dim"]) {
      expect(shared.match(new RegExp(`--${t}: `, "g"))?.length, t).toBe(3);
    }
    const forced = shared.slice(shared.indexOf("@media (forced-colors: active)"));
    expect(forced).toContain("--hud-line: CanvasText;");
    expect(forced).toContain("--hud-dim: GrayText;");
  });
});

describe("the handle's line (review #5)", () => {
  const task = (status: TaskCard["status"]): TaskCard => ({ id: status, title: status, status, detail: "" });
  it("says the most urgent true thing: a task that needs you, why Ember can't answer, work under way", () => {
    expect(handleLine({ idle: "Ready", setup: "Fix “Screen reading”", tasks: [task("waiting"), task("running")] })).toBe("1 task needs you");
    expect(handleLine({ idle: "Not connected", tasks: [task("running")] })).toBe("Not connected");
    expect(handleLine({ idle: "Ready", setup: "Fix “Screen reading”", tasks: [task("running"), task("queued")] })).toBe("Working on 2 tasks…");
    expect(handleLine({ idle: "Ready", setup: "Fix “Screen reading”", tasks: [task("failed"), task("failed")] })).toBe("2 tasks failed");
  });

  it("names the setup row that holds Ember back only when nothing more urgent is going on, then the microphone, then Ready", () => {
    expect(handleLine({ idle: "Ready", setup: "Fix “Screen reading”", tasks: [task("done")] })).toBe("Fix “Screen reading”");
    expect(handleLine({ idle: "Ready", setup: null, mic: "error", tasks: [] })).toBe("Microphone problem");
    expect(handleLine({ idle: "Ready", tasks: [] })).toBe("Ready");
    expect(handleLine({ tasks: [] })).toBe("Ready");
  });
});
