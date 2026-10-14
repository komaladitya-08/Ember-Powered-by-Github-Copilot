/**
 * Ember's flame renderer: a small particle fire drawn on a transparent canvas.
 *
 * Canvas 2D only (no WebGL), so it runs on RHEL VMs and remote sessions without
 * a GPU. Particles live in world space, so when Ember moves the flame trails
 * behind it on its own. Each particle keeps the colour ramp of the mood it was
 * born in, which makes mood changes blend naturally as old particles burn out.
 */

import { MOODS, type Mood, type MoodStyle } from "./moods";

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

export interface FlameOptions {
  /** Lower particle counts and no orbiting sparks (prefers-reduced-motion). */
  reducedMotion?: boolean;
}

interface Particle {
  x: number; y: number; vx: number; vy: number;
  ox: number;                 // birth x; the flame narrows back toward it
  age: number; life: number; size: number; seed: number;
  ramp: HTMLCanvasElement[];  // sprites of the mood it was born in
}

interface Spark {
  x: number; y: number; vx: number; vy: number;
  age: number; life: number; size: number; gravity: number; seed: number;
  sprite: HTMLCanvasElement;
}

interface Ring { x: number; y: number; age: number; life: number; r0: number; r1: number; rgb: RGB }
interface Puff { x: number; y: number; vx: number; vy: number; age: number; life: number; size: number }

type RGB = [number, number, number];

const RAMP_STEPS = 24;
const SPRITE_PX = 64;
const MAX_PARTICLES = 900;

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function sampleRamp(ramp: RGB[], t: number): RGB {
  const f = Math.min(Math.max(t, 0), 1) * (ramp.length - 1);
  const i = Math.min(Math.floor(f), ramp.length - 2);
  const k = f - i;
  const a = ramp[i], b = ramp[i + 1];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function makeSprite([r, g, b]: RGB): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = SPRITE_PX;
  const ctx = c.getContext("2d")!;
  const h = SPRITE_PX / 2;
  const grad = ctx.createRadialGradient(h, h, 0, h, h, h);
  grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
  grad.addColorStop(0.35, `rgba(${r},${g},${b},0.55)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  return c;
}

const spriteCache = new Map<Mood, HTMLCanvasElement[]>();
function spritesFor(mood: Mood): HTMLCanvasElement[] {
  let s = spriteCache.get(mood);
  if (!s) {
    const ramp = MOODS[mood].ramp.map(hexToRgb);
    s = Array.from({ length: RAMP_STEPS }, (_, i) => makeSprite(sampleRamp(ramp, i / (RAMP_STEPS - 1))));
    spriteCache.set(mood, s);
  }
  return s;
}

export class EmberFlame {
  /** Where the base of the flame sits, in canvas CSS pixels. */
  readonly anchor: Point = { x: 0, y: 0 };

  private readonly ctx: CanvasRenderingContext2D;
  private readonly reduced: boolean;
  private width = 0;
  private height = 0;
  private mood: Mood = "idle";
  private style: MoodStyle = MOODS.idle;
  private glow: RGB = hexToRgb(MOODS.idle.glow);
  private last: Point = { x: 0, y: 0 };
  private speed = 0;
  private time = 0;
  private level = 0;
  private highlight: Rect | null = null;
  private particles: Particle[] = [];
  private sparks: Spark[] = [];
  private rings: Ring[] = [];
  private puffs: Puff[] = [];
  private emitDebt = 0;
  private sparkDebt = 0;
  private puffDebt = 0;
  private edgeDebt = 0;
  private ringClock = 0;

  constructor(private readonly canvas: HTMLCanvasElement, opts: FlameOptions = {}) {
    this.ctx = canvas.getContext("2d")!;
    this.reduced = !!opts.reducedMotion;
  }

  /** Match the canvas backing store to its CSS size and the display scale. */
  resize(width: number, height: number, dpr = window.devicePixelRatio || 1): void {
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  getMood(): Mood { return this.mood; }

  setMood(mood: Mood): void {
    if (mood === this.mood) return;
    this.mood = mood;
    this.style = MOODS[mood];
    if (mood === "done") this.burst(this.anchor, 0.8);
  }

  /** Move the flame base. Call every frame while following or flying. */
  setAnchor(p: Point): void {
    this.anchor.x = p.x;
    this.anchor.y = p.y;
  }

  /** Microphone level 0..1 while listening; drives the voice rings. */
  setLevel(level: number): void {
    this.level = Math.min(Math.max(level, 0), 1);
  }

  /** Ring the given rectangle with fire (guide mode); null clears it. */
  setHighlight(rect: Rect | null): void {
    this.highlight = rect;
  }

  /** Spark burst, e.g. on a click. */
  burst(at: Point, strength = 1): void {
    const sprites = spritesFor(this.mood);
    const n = Math.round((this.reduced ? 10 : 26) * strength);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.2, 0.2);
      const v = rand(140, 320) * strength;
      this.sparks.push({
        x: at.x, y: at.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        age: 0, life: rand(0.35, 0.75), size: rand(1.4, 2.6), gravity: 260, seed: Math.random(),
        sprite: sprites[Math.floor(rand(1, 6))],
      });
    }
    this.rings.push({ x: at.x, y: at.y, age: 0, life: 0.5, r0: 4, r1: 30 * strength + 8, rgb: this.glow });
  }

  /** Advance the simulation and draw one frame. */
  frame(dt: number): void {
    dt = Math.min(dt, 1 / 20);
    if (dt > 0) this.update(dt);
    this.render();
  }

  private update(dt: number): void {
    const s = this.style;
    this.time += dt;

    // Ease the halo colour toward the current mood.
    const target = hexToRgb(s.glow);
    const k = 1 - Math.exp(-dt * 6);
    this.glow = [0, 1, 2].map(i => this.glow[i] + (target[i] - this.glow[i]) * k) as RGB;

    const dx = this.anchor.x - this.last.x;
    const dy = this.anchor.y - this.last.y;
    this.speed = Math.hypot(dx, dy) / dt;

    // Emit flame particles along the path travelled this frame, so fast
    // flights leave a continuous trail instead of dots.
    const rate = (this.reduced ? s.rate * 0.5 : s.rate) * (1 + this.level * 0.6) * (1 + Math.min(this.speed / 900, 1.2));
    this.emitDebt += rate * dt;
    const sprites = spritesFor(this.mood);
    while (this.emitDebt >= 1 && this.particles.length < MAX_PARTICLES) {
      this.emitDebt -= 1;
      const f = Math.random();
      const x = this.last.x + dx * f + rand(-s.size * 0.45, s.size * 0.45);
      const y = this.last.y + dy * f + rand(-s.size * 0.25, s.size * 0.25);
      this.particles.push({
        x, y, ox: x,
        vx: rand(-14, 14) - (dx / dt) * 0.12, vy: rand(-40, -10) - (dy / dt) * 0.12,
        age: 0, life: rand(s.life[0], s.life[1]), size: s.size * rand(0.8, 1.2) * (1 + this.level * 0.25),
        seed: Math.random(), ramp: sprites,
      });
    }

    // Tiny flames dancing along a guide-mode highlight.
    if (this.highlight) {
      const h = this.highlight;
      const perim = 2 * (h.width + h.height);
      this.edgeDebt += (this.reduced ? 30 : 90) * dt;
      while (this.edgeDebt >= 1) {
        this.edgeDebt -= 1;
        let d = Math.random() * perim;
        let x: number, y: number;
        if (d < h.width) { x = h.x + d; y = h.y; }
        else if ((d -= h.width) < h.height) { x = h.x + h.width; y = h.y + d; }
        else if ((d -= h.height) < h.width) { x = h.x + h.width - d; y = h.y + h.height; }
        else { d -= h.width; x = h.x; y = h.y + h.height - d; }
        this.particles.push({
          x, y, ox: x, vx: rand(-6, 6), vy: rand(-30, -5),
          age: 0, life: rand(0.25, 0.5), size: rand(3, 5), seed: Math.random(), ramp: sprites,
        });
      }
    }

    // Free sparks drifting off the tip.
    this.sparkDebt += s.sparks * dt * (this.reduced ? 0.5 : 1);
    while (this.sparkDebt >= 1) {
      this.sparkDebt -= 1;
      this.sparks.push({
        x: this.anchor.x + rand(-4, 4), y: this.anchor.y - s.size * 1.6,
        vx: rand(-30, 30), vy: rand(-150, -70), age: 0, life: rand(0.6, 1.4),
        size: rand(1.1, 2.1), gravity: 45, seed: Math.random(), sprite: sprites[Math.floor(rand(2, 7))],
      });
    }

    // Smoke when the flame gutters.
    this.puffDebt += s.smoke * dt;
    while (this.puffDebt >= 1) {
      this.puffDebt -= 1;
      this.puffs.push({
        x: this.anchor.x + rand(-3, 3), y: this.anchor.y - s.size * 2.2,
        vx: rand(-10, 10), vy: rand(-45, -25), age: 0, life: rand(0.9, 1.6), size: rand(5, 8),
      });
    }

    // Voice rings while listening.
    if (this.mood === "listening") {
      this.ringClock -= dt;
      if (this.ringClock <= 0) {
        this.ringClock = 0.55 - this.level * 0.3;
        this.rings.push({
          x: this.anchor.x, y: this.anchor.y - s.size, age: 0, life: 0.9,
          r0: 12, r1: 26 + this.level * 30, rgb: this.glow,
        });
      }
    }

    const t = this.time;
    for (const p of this.particles) {
      p.age += dt;
      const life = p.age / p.life;
      p.vy -= s.lift * dt;
      p.vx += Math.sin(t * 7 + p.seed * 12 + life * 5) * s.sway * 5 * dt;
      p.vx += (p.ox - p.x) * 3.2 * dt;
      p.vx *= 1 - 1.6 * dt;
      p.vy *= 1 - 0.9 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.particles = this.particles.filter(p => p.age < p.life);

    for (const sp of this.sparks) {
      sp.age += dt;
      sp.vy += sp.gravity * dt;
      sp.vx += Math.sin(t * 9 + sp.seed * 20) * 40 * dt;
      sp.vx *= 1 - 1.2 * dt;
      sp.x += sp.vx * dt;
      sp.y += sp.vy * dt;
    }
    this.sparks = this.sparks.filter(sp => sp.age < sp.life);

    for (const r of this.rings) r.age += dt;
    this.rings = this.rings.filter(r => r.age < r.life);

    for (const pf of this.puffs) {
      pf.age += dt;
      pf.x += pf.vx * dt;
      pf.y += pf.vy * dt;
    }
    this.puffs = this.puffs.filter(pf => pf.age < pf.life);

    this.last.x = this.anchor.x;
    this.last.y = this.anchor.y;
  }

  private flicker(): number {
    const f = this.style.flicker;
    if (!f || this.reduced) return 1;
    const t = this.time * f * Math.PI * 2;
    return 0.86 + 0.14 * (Math.sin(t) * 0.6 + Math.sin(t * 1.73 + 1.3) * 0.4);
  }

  private render(): void {
    const ctx = this.ctx;
    const { x, y } = this.anchor;
    const s = this.style;
    const flick = this.flicker();
    const [gr, gg, gb] = this.glow;
    ctx.clearRect(0, 0, this.width, this.height);

    // A faint dark halo underneath keeps the flame readable over white apps.
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    const shade = ctx.createRadialGradient(x, y - s.size, 0, x, y - s.size, s.size * 4.2);
    shade.addColorStop(0, "rgba(38,12,4,0.30)");
    shade.addColorStop(1, "rgba(38,12,4,0)");
    ctx.fillStyle = shade;
    ctx.fillRect(x - s.size * 5, y - s.size * 6, s.size * 10, s.size * 10);

    for (const pf of this.puffs) {
      const k = pf.age / pf.life;
      const r = pf.size * (1 + k * 1.8);
      ctx.globalAlpha = 0.22 * (1 - k);
      ctx.fillStyle = "rgb(58,52,50)";
      ctx.beginPath();
      ctx.arc(pf.x, pf.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = "lighter";

    // Halo
    const halo = ctx.createRadialGradient(x, y - s.size * 0.8, 0, x, y - s.size * 0.8, s.size * 5);
    halo.addColorStop(0, `rgba(${gr | 0},${gg | 0},${gb | 0},${0.38 * flick})`);
    halo.addColorStop(1, `rgba(${gr | 0},${gg | 0},${gb | 0},0)`);
    ctx.globalAlpha = 1;
    ctx.fillStyle = halo;
    ctx.fillRect(x - s.size * 5, y - s.size * 6, s.size * 10, s.size * 10);

    if (this.highlight) this.drawHighlight(this.highlight);

    for (const r of this.rings) {
      const k = r.age / r.life;
      ctx.globalAlpha = (1 - k) * 0.7;
      ctx.strokeStyle = `rgb(${r.rgb[0] | 0},${r.rgb[1] | 0},${r.rgb[2] | 0})`;
      ctx.lineWidth = 2.2 * (1 - k) + 0.4;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * (1 - (1 - k) * (1 - k)), 0, Math.PI * 2);
      ctx.stroke();
    }

    for (const p of this.particles) {
      const k = p.age / p.life;
      const size = p.size * (1 - 0.72 * k) * flick;
      ctx.globalAlpha = k < 0.08 ? k / 0.08 : Math.pow(1 - k, 1.15);
      const sprite = p.ramp[Math.min(RAMP_STEPS - 1, Math.max(0, Math.floor(k * RAMP_STEPS)))];
      ctx.drawImage(sprite, p.x - size, p.y - size, size * 2, size * 2);
    }

    for (const sp of this.sparks) {
      const k = sp.age / sp.life;
      const tw = 0.6 + 0.4 * Math.sin(this.time * 30 + sp.seed * 40);
      ctx.globalAlpha = (1 - k) * tw;
      const size = sp.size * 2.4;
      ctx.drawImage(sp.sprite, sp.x - size, sp.y - size, size * 2, size * 2);
    }

    if (s.orbiters && !this.reduced) this.drawOrbiters(s.orbiters);

    // Hot core
    const core = spritesFor(this.mood)[0];
    const cs = s.size * 0.8 * flick;
    ctx.globalAlpha = 0.6;
    ctx.drawImage(core, x - cs, y - cs * 1.6, cs * 2, cs * 2.4);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  private drawOrbiters(n: number): void {
    const ctx = this.ctx;
    const sprites = spritesFor(this.mood);
    const cx = this.anchor.x;
    const cy = this.anchor.y - this.style.size * 1.4;
    for (let i = 0; i < n; i++) {
      for (let trail = 0; trail < 5; trail++) {
        const th = this.time * 2.6 + (i / n) * Math.PI * 2 - trail * 0.09;
        const r = 20 + 5 * Math.sin(this.time * 2 + i * 1.7);
        const px = cx + Math.cos(th) * r;
        const py = cy + Math.sin(th) * r * 0.5;
        const size = (2.6 - trail * 0.4) * 2;
        ctx.globalAlpha = 0.9 * (1 - trail / 5);
        ctx.drawImage(sprites[2 + trail], px - size, py - size, size * 2, size * 2);
      }
    }
  }

  private drawHighlight(h: Rect): void {
    const ctx = this.ctx;
    const [r, g, b] = this.glow;
    const pulse = 0.55 + 0.25 * Math.sin(this.time * 4);
    const rad = Math.min(10, h.height / 2, h.width / 2);
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.shadowColor = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.shadowBlur = 16;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(h.x, h.y, h.width, h.height, rad);
    ctx.stroke();
    ctx.restore();
  }
}
