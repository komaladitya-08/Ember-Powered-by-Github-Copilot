/** Drawing helpers shared by the character renderers. Units: a character is ~100 units tall. */

import type { Pose } from "./rig";

export type Ctx = CanvasRenderingContext2D;
export interface Pt { x: number; y: number }

export interface Character {
  id: string;
  name: string;
  pitch: string;
  /** Draw centred on (0, 0); the caller sets translate/scale. */
  draw(ctx: Ctx, pose: Pose): void;
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function mix(a: string, b: string, k: number): string {
  const A = hex(a), B = hex(b);
  return `rgb(${Math.round(lerp(A[0], B[0], k))},${Math.round(lerp(A[1], B[1], k))},${Math.round(lerp(A[2], B[2], k))})`;
}
export function rgba(c: string, a: number): string {
  const [r, g, b] = hex(c);
  return `rgba(${r},${g},${b},${a})`;
}

/** Pick a colour from three palettes keyed by heat: cooled (0.4), normal (1), white-hot (1.35). */
export function heatColor(heat: number, cool: string, normal: string, hot: string): string {
  return heat < 1 ? mix(cool, normal, clamp((heat - 0.4) / 0.6, 0, 1)) : mix(normal, hot, clamp((heat - 1) / 0.35, 0, 1));
}

/** Smooth closed curve through points (midpoint quadratic). */
export function smoothPath(ctx: Ctx, pts: Pt[]): void {
  const n = pts.length;
  ctx.beginPath();
  const m0 = { x: (pts[n - 1].x + pts[0].x) / 2, y: (pts[n - 1].y + pts[0].y) / 2 };
  ctx.moveTo(m0.x, m0.y);
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
  }
  ctx.closePath();
}

export interface EyeStyle {
  sep: number;        // distance between eye centres
  y: number;
  w: number;
  h: number;
  /** "sclera": white eye + pupil; "solid": dark eye, no white; "glow": light-emitting eye + small pupil. */
  kind: "sclera" | "solid" | "glow";
  fill: string;
  pupil?: string;
  glow?: string;
  lid: string;        // stroke colour for closed eyes
  brow?: string;
  browW?: number;
  catchlight?: boolean;
}

function eyeShape(ctx: Ctx, cx: number, cy: number, w: number, hh: number, smile: number): void {
  ctx.beginPath();
  ctx.ellipse(cx, cy, w / 2, hh, 0, Math.PI, Math.PI * 2);
  ctx.quadraticCurveTo(cx, cy + hh * 2 * (1 - 1.8 * smile), cx - w / 2, cy);
  ctx.closePath();
}

export function drawEyes(ctx: Ctx, pose: Pose, s: EyeStyle): void {
  const f = pose.face;
  for (const side of [-1, 1]) {
    const cx = side * s.sep / 2 + pose.look.x * s.w * 0.12;
    const cy = s.y + pose.look.y * s.h * 0.08;
    const hh = (s.h / 2) * clamp(f.open, 0, 1.4);
    const smile = clamp(f.smile, 0, 1);

    if (hh < s.h * 0.09 || (smile > 0.85 && f.open < 0.6)) {
      // Closed: happy arcs (∩) or resting lids (‿)
      ctx.beginPath();
      const up = smile > 0.4;
      ctx.moveTo(cx - s.w / 2, cy + (up ? 2 : 0));
      ctx.quadraticCurveTo(cx, cy + (up ? -s.h * 0.45 : s.h * 0.3), cx + s.w / 2, cy + (up ? 2 : 0));
      ctx.strokeStyle = s.lid;
      ctx.lineWidth = Math.max(2.4, s.w * 0.22);
      ctx.lineCap = "round";
      if (s.kind === "glow" && s.glow) { ctx.shadowColor = s.glow; ctx.shadowBlur = 8; }
      ctx.stroke();
      ctx.shadowBlur = 0;
    } else {
      ctx.save();
      eyeShape(ctx, cx, cy, s.w, hh, smile);
      if (s.kind === "glow" && s.glow) { ctx.shadowColor = s.glow; ctx.shadowBlur = 12; }
      ctx.fillStyle = s.fill;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.clip();
      const pr = Math.min(s.w, s.h) * (s.kind === "glow" ? 0.2 : 0.34) * f.pupil;
      const px = cx + pose.look.x * s.w * 0.24;
      const py = cy + pose.look.y * hh * 0.4;
      if (s.kind !== "solid" && s.pupil) {
        ctx.fillStyle = s.pupil;
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fill();
      }
      if (s.catchlight !== false && s.kind !== "glow") {
        const cr = s.kind === "solid" ? s.w * 0.17 : pr * 0.42;
        const bx = s.kind === "solid" ? cx + pose.look.x * s.w * 0.2 : px;
        const by = s.kind === "solid" ? cy + pose.look.y * hh * 0.3 : py;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(bx + cr * 0.9, by - cr * 1.1, cr, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.arc(bx - cr * 0.8, by + cr * 0.9, cr * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }

    if (s.brow) {
      const base = s.y - s.h * 0.72 - f.browY * s.h * 0.28;
      const inner = -side; // direction toward the face centre
      const ix = cx + inner * s.w * 0.55, ox = cx - inner * s.w * 0.55;
      const iy = base - f.browTilt * s.h * 0.2, oy = base + f.browTilt * s.h * 0.08;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.quadraticCurveTo(cx, Math.min(iy, oy) - s.h * 0.08, ix, iy);
      ctx.strokeStyle = s.brow;
      ctx.lineWidth = s.browW ?? 3;
      ctx.lineCap = "round";
      if (s.kind === "glow" && s.glow) { ctx.shadowColor = s.glow; ctx.shadowBlur = 6; }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }
}

export interface MouthStyle {
  y: number;
  w: number;
  color: string;
  inner: string;
  lineW?: number;
  glow?: string;
  tongue?: string;
}

export function drawMouth(ctx: Ctx, pose: Pose, s: MouthStyle): void {
  const f = pose.face;
  const mw = s.w * f.mouthW;
  const curve = f.mouth * s.w * 0.3;
  const open = clamp(f.mouthOpen, 0, 1) * s.w * 0.55;
  const skew = f.mouthSkew * s.w * 0.18;
  const x = pose.look.x * s.w * 0.12;
  const lx = x - mw / 2, rx = x + mw / 2;
  const ly = s.y - skew * 0.4, ry = s.y + skew * 0.4;
  if (s.glow) { ctx.shadowColor = s.glow; ctx.shadowBlur = 8; }
  if (open < 1.2) {
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.quadraticCurveTo(x + skew, s.y + curve, rx, ry);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.lineW ?? 3;
    ctx.lineCap = "round";
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.quadraticCurveTo(x + skew, s.y + curve * 0.5 - open * 0.15, rx, ry);
    ctx.quadraticCurveTo(x + skew, s.y + curve + open * 1.7, lx, ly);
    ctx.closePath();
    ctx.fillStyle = s.inner;
    ctx.fill();
    if (s.tongue && open > s.w * 0.2) {
      ctx.save();
      ctx.clip();
      ctx.fillStyle = s.tongue;
      ctx.beginPath();
      ctx.ellipse(x + skew, s.y + curve + open * 0.95, mw * 0.28, open * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = (s.lineW ?? 3) * 0.7;
    ctx.lineJoin = "round";
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

export function drawBlush(ctx: Ctx, pose: Pose, sep: number, y: number, color: string): void {
  const a = clamp(pose.face.blush, 0, 1);
  if (a < 0.02) return;
  for (const side of [-1, 1]) {
    const g = ctx.createRadialGradient(side * sep / 2, y, 0, side * sep / 2, y, 9);
    g.addColorStop(0, rgba(color, 0.55 * a));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(side * sep / 2 - 10, y - 10, 20, 20);
  }
}

function star(ctx: Ctx, x: number, y: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? r * 0.32 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

/** Comic emotes above the head. Outlined so they read on any background. */
export function drawEmote(ctx: Ctx, pose: Pose, top: number, accent: string): void {
  const age = pose.emoteAge, t = pose.t;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const ink = "#2a140c";
  switch (pose.emote) {
    case "dots": {
      for (let i = 0; i < 3; i++) {
        const y = top - 4 - Math.max(0, Math.sin(t * 6 - i * 0.7)) * 6;
        ctx.beginPath();
        ctx.arc(-12 + i * 12, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = ink;
        ctx.stroke();
      }
      break;
    }
    case "question":
    case "exclaim": {
      const pop = pose.emote === "exclaim" ? 1 + 0.5 * Math.exp(-age * 8) * Math.sin(age * 30) : 1;
      ctx.translate(16, top - 6 + Math.sin(t * 3) * 2);
      ctx.rotate(pose.emote === "question" ? 0.18 + Math.sin(t * 2) * 0.08 : 0);
      ctx.scale(pop, pop);
      ctx.font = "900 30px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 5;
      ctx.strokeStyle = ink;
      const g = pose.emote === "question" ? "?" : "!";
      ctx.strokeText(g, 0, 0);
      ctx.fillStyle = pose.emote === "question" ? "#fff" : accent;
      ctx.fillText(g, 0, 0);
      break;
    }
    case "zzz": {
      ctx.font = "800 15px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      for (let i = 0; i < 3; i++) {
        const k = ((t * 0.5 + i / 3) % 1);
        ctx.globalAlpha = Math.sin(k * Math.PI);
        const s = 0.7 + k * 0.6;
        ctx.save();
        ctx.translate(14 + k * 22, top + 8 - k * 30);
        ctx.scale(s, s);
        ctx.lineWidth = 4;
        ctx.strokeStyle = ink;
        ctx.strokeText("z", 0, 0);
        ctx.fillStyle = "#fff";
        ctx.fillText("z", 0, 0);
        ctx.restore();
      }
      break;
    }
    case "sparkle": {
      const spots = [[-34, top + 12], [32, top + 4], [4, top - 12], [40, top + 34]];
      spots.forEach(([x, y], i) => {
        const tw = 0.5 + 0.5 * Math.sin(t * 5 + i * 1.9);
        star(ctx, x, y, 4 + tw * 5);
        ctx.fillStyle = "#fff6c9";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = accent;
        ctx.stroke();
      });
      break;
    }
    case "sweat": {
      const k = (t * 0.7) % 1;
      const x = 34, y = top + 34 + k * 14;
      ctx.globalAlpha = 1 - k * 0.6;
      ctx.beginPath();
      ctx.moveTo(x, y - 9);
      ctx.quadraticCurveTo(x + 7, y + 2, x, y + 4);
      ctx.quadraticCurveTo(x - 7, y + 2, x, y - 9);
      ctx.fillStyle = "#bfe6ff";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#2b5a7a";
      ctx.stroke();
      break;
    }
    case "none":
      break;
  }
  ctx.restore();
}
