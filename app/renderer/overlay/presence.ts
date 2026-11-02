/**
 * Ember's presence by the cursor (app/shared/presence.ts says which state; docs/DESIGN.md "Presence"): a ring of 24
 * ticks round Ember, a steady microphone mark while it hears a request (apart from the ring, so seeing that Ember
 * listens never depends on a level), and a five-bar meter while its own voice plays.
 *
 * The overlay is always on screen on a CPU-only desktop, so all of it is cheap by construction: one empty wrapper
 * moved by transform (never the styled parts), the ticks placed once by a static transform, a level shown by toggling
 * which ticks are lit (their opacity: the ring's small area repaints) and the meter by `scale` on its
 * bars, at most 20 times a second and only while there is sound. Nothing runs while Ember is hidden, and in Calm the
 * ring holds still: listening shows every tick lit and the meter a steady mark.
 */

import { DONE_RING_MS, RING_TICKS, meterBars, ticksLit, type Presence } from "../../shared/presence";
import { snapToDevice } from "@ember/bubble";
import type { SoundLevel } from "../../shared/level";

export class PresenceView {
  /** The wrapper moved with Ember (unstyled: only its transform changes as Ember moves). */
  readonly mount: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  private readonly ticks: HTMLElement[] = [];
  private readonly bars: HTMLElement[] = [];
  private state: Presence = "idle";
  private lit = 0;
  private mic: number | null = null;
  private voice: number | null = null;
  private calm = false;
  private at: { x: number; y: number } | null = null;
  private size = 0;
  private shown = true;
  private doneTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: HTMLElement) {
    this.mount = document.createElement("div");
    this.mount.className = "presence";
    this.mount.setAttribute("aria-hidden", "true");
    this.ring = document.createElement("div");
    this.ring.className = "ring";
    for (let i = 0; i < RING_TICKS; i++) {
      const t = document.createElement("i");
      t.className = "tick";
      t.style.setProperty("--i", String(i));
      this.ticks.push(t);
      this.ring.append(t);
    }
    const now = document.createElement("i");
    now.className = "ring-now";
    this.ring.append(now);
    const mark = document.createElement("i");
    mark.className = "mic-mark";
    const meter = document.createElement("span");
    meter.className = "meter";
    for (let i = 0; i < 5; i++) {
      const b = document.createElement("i");
      this.bars.push(b);
      meter.append(b);
    }
    this.mount.append(this.ring, mark, meter);
    this.mount.dataset.state = "idle";
    host.prepend(this.mount);
  }

  /** Calm mode or the desktop's reduced motion: the ring holds still (no level, no meter movement). */
  setCalm(on: boolean): void {
    if (on === this.calm) return;
    this.calm = on;
    this.showMic();
    this.showVoice();
  }

  /** The state to show (a change starts the done ring's time; any other state cancels it). */
  setState(next: Presence): void {
    if (next === this.state) return;
    if (this.doneTimer) { clearTimeout(this.doneTimer); this.doneTimer = null; }
    this.state = next;
    this.mount.dataset.state = next;
    // Done completes once and goes: the ring is idle again after its time, whatever Calm does to the animation.
    if (next === "done") this.doneTimer = setTimeout(() => { this.doneTimer = null; if (this.state === "done") this.mount.dataset.state = "idle"; }, DONE_RING_MS);
    this.showMic();
  }

  /** Whether the microphone hears a request now (the steady mark), apart from its level. */
  setHearing(on: boolean): void {
    if (this.mount.hasAttribute("data-mic") === on) return;
    this.mount.toggleAttribute("data-mic", on);
  }

  /** A level from the page that hears or speaks (null: that stream ended). */
  setLevel(l: SoundLevel): void {
    if (l.mic !== undefined) { this.mic = l.mic; this.showMic(); }
    if (l.voice !== undefined) { this.voice = l.voice; this.showVoice(); }
  }

  /**
   * Where Ember's centre is (overlay px) and its size: only the wrapper's transform is written, and only on a change.
   * On device pixels at `dpr`, so the ticks stay sharp at 125 % and 150 %.
   */
  place(x: number, y: number, size: number, dpr = 1): void {
    const rx = snapToDevice(x, dpr), ry = snapToDevice(y, dpr);
    if (this.at?.x !== rx || this.at.y !== ry) {
      this.at = { x: rx, y: ry };
      this.mount.style.transform = `translate(${rx}px, ${ry}px)`;
    }
    if (size !== this.size) {
      this.size = size;
      this.mount.style.setProperty("--size", `${size}px`);
    }
  }

  /** Ember is on this display (and not hidden): otherwise nothing of the presence shows or runs. */
  show(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    this.mount.hidden = !on;
  }

  /** The ticks the microphone's level lights (none when it is quiet, all of them still in Calm). */
  private showMic(): void {
    const n = this.state !== "listening" ? 0 : this.calm ? RING_TICKS : ticksLit(this.mic);
    if (n === this.lit) return;
    this.ticks.forEach((t, i) => { if ((i < n) !== (i < this.lit)) t.toggleAttribute("data-on", i < n); });
    this.lit = n;
  }

  /** The voice meter: shown while Ember's own voice plays, its bars at the level (a steady mark in Calm). */
  private showVoice(): void {
    const on = this.voice !== null;
    if (this.mount.hasAttribute("data-voice") !== on) this.mount.toggleAttribute("data-voice", on);
    if (!on) return;
    const scales = meterBars(this.calm ? 5 : this.voice);
    this.bars.forEach((b, i) => { const v = String(scales[i]); if (b.style.scale !== `1 ${v}`) b.style.scale = `1 ${v}`; });
  }
}
