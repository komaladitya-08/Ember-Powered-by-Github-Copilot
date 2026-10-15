/**
 * Four directions for Ember's body. They share one rig (rig.ts), so every
 * expression, blink and gesture works in all of them; only the drawing differs.
 */

import type { Pose, Gesture } from "./rig";
import {
  type Character, type Ctx, type Pt, clamp, mix, rgba, heatColor, smoothPath,
  drawEyes, drawMouth, drawBlush, drawEmote,
} from "./draw";

const TAU = Math.PI * 2;

function bodyTransform(ctx: Ctx, pose: Pose): void {
  const f = pose.face;
  ctx.translate(0, pose.lift);
  ctx.rotate(f.tilt + pose.lean);
  ctx.scale(1 - f.squash * 0.55, 1 + f.squash);
}

// ───────────────────────────── 1. Wisp ─────────────────────────────
// A living flame with a face. Its tongues of fire are its "hair": they shoot up
// when it's excited, droop and darken when it's sorry, and gutter when it's worried.

interface Spark { x: number; y: number; vx: number; vy: number; life: number; age: number }

export function createWisp(): Character {
  const sparks: Spark[] = [];
  return {
    id: "wisp",
    name: "Wisp",
    pitch: "A living flame. Its fire is its mood: tall and white-hot when excited, low and red when sorry.",
    draw(ctx, pose) {
      const f = pose.face, t = pose.t;
      const R = 34;
      const energy = clamp(f.energy, 0.15, 1.5);
      const H0 = 18 + 52 * energy;
      const flick = pose.emotion === "worried" ? 3 : 1;

      ctx.save();
      bodyTransform(ctx, pose);

      const pts: Pt[] = [];
      const N = 80;
      const lobes = [
        { c: -Math.PI / 2, h: 1 },
        { c: -Math.PI / 2 - 0.85, h: 0.5 },
        { c: -Math.PI / 2 + 0.85, h: 0.58 },
      ];
      const sway = Math.sin(t * 2.3) * 0.5 + Math.sin(t * 3.7) * 0.25 - pose.lean * 2;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TAU;
        let x = Math.cos(a) * R;
        let y = Math.sin(a) * R * 0.92 + 6;
        const up = Math.max(0, -Math.sin(a));
        let H = 0;
        lobes.forEach((l, j) => {
          let d = a - (l.c + TAU);
          d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI;
          const fl = 0.82 + 0.12 * Math.sin(t * 7 * flick + j * 1.7) + 0.08 * Math.sin(t * 13 * flick + j * 4.1);
          H = Math.max(H, l.h * fl * Math.exp(-(d * d) / (2 * 0.32 * 0.32)));
        });
        const lift = H0 * H * Math.pow(up, 0.5);
        y -= lift;
        x += sway * 9 * Math.pow(lift / H0, 1.6);
        pts.push({ x, y });
      }

      const c0 = heatColor(f.heat, "#ffb79a", "#fff4d0", "#ffffff");
      const c1 = heatColor(f.heat, "#d9562f", "#ffc24f", "#fff0a8");
      const c2 = heatColor(f.heat, "#8f2418", "#ff7b22", "#ffb340");
      const c3 = heatColor(f.heat, "#4a1210", "#d93c18", "#ff6a1f");

      // Outer glow
      ctx.save();
      ctx.shadowColor = rgba("#ff7a22", 0.55 * energy);
      ctx.shadowBlur = 30 * energy;
      smoothPath(ctx, pts);
      const g = ctx.createRadialGradient(0, 14, 2, 0, -H0 * 0.2, R + H0);
      g.addColorStop(0, c0);
      g.addColorStop(0.42, c1);
      g.addColorStop(0.75, c2);
      g.addColorStop(1, c3);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();

      // Hot heart
      ctx.save();
      ctx.translate(0, 16);
      ctx.scale(0.66, 0.6);
      ctx.translate(0, -16);
      smoothPath(ctx, pts);
      ctx.globalAlpha = 0.55;
      const hg = ctx.createRadialGradient(0, 20, 0, 0, 10, R);
      hg.addColorStop(0, rgba("#ffffff", 0.9));
      hg.addColorStop(1, rgba("#fff1b8", 0));
      ctx.fillStyle = hg;
      ctx.fill();
      ctx.restore();

      const ink = mix("#3b1206", "#2a0a14", clamp(1 - f.heat, 0, 1));
      drawBlush(ctx, pose, 40, 20, "#ff4d6d");
      drawEyes(ctx, pose, { sep: 26, y: 8, w: 11, h: 17, kind: "solid", fill: ink, lid: ink, brow: ink, browW: 2.6 });
      drawMouth(ctx, pose, { y: 25, w: 15, color: ink, inner: "#6e1a0a", tongue: "#ff6a4d", lineW: 2.6 });
      ctx.restore();

      // Free embers drifting off the tips
      if (Math.random() < pose.dt * (2 + energy * 6)) {
        sparks.push({ x: (Math.random() - 0.5) * 20, y: -R - H0 * 0.7, vx: (Math.random() - 0.5) * 30, vy: -40 - Math.random() * 50, life: 0.8 + Math.random() * 0.8, age: 0 });
      }
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.age += pose.dt;
        if (s.age > s.life) { sparks.splice(i, 1); continue; }
        s.x += (s.vx + Math.sin(t * 6 + i) * 20) * pose.dt;
        s.y += s.vy * pose.dt;
        ctx.globalAlpha = 1 - s.age / s.life;
        ctx.fillStyle = c1;
        ctx.beginPath();
        ctx.arc(s.x, s.y + pose.lift, 1.8, 0, TAU);
        ctx.fill();
      }
      ctx.restore();

      drawEmote(ctx, pose, -R - H0 - 12 + pose.lift, "#ff8a2a");
    },
  };
}

// ───────────────────────────── 2. Glassling ─────────────────────────────
// A drop of molten glass with a soft, jiggly body. Glowing amber when happy;
// it cools to pale blue glass when sad. Tiny bubbles drift inside.

export function createGlassling(): Character {
  const N = 28;
  const dr = new Array(N).fill(0);
  const dv = new Array(N).fill(0);
  const bubbles = Array.from({ length: 7 }, () => ({ x: (Math.random() - 0.5) * 50, y: Math.random() * 60 - 30, r: 1 + Math.random() * 2.2, s: 6 + Math.random() * 10 }));
  let lastEmotion = "";
  return {
    id: "glassling",
    name: "Glassling",
    pitch: "A drop of molten glass with a squishy body. Glows amber when happy, cools to pale blue glass when sad.",
    draw(ctx, pose) {
      const f = pose.face, t = pose.t, dt = pose.dt;
      const R = 40;
      if (pose.emotion !== lastEmotion) {
        lastEmotion = pose.emotion;
        for (let i = 0; i < N; i++) dv[i] += (Math.random() - 0.3) * 60;
      }
      // Soft body: each rim point is a damped spring, coupled to its neighbours.
      const pts: Pt[] = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TAU;
        const nx = Math.cos(a), ny = Math.sin(a);
        const inertia = -(pose.accel.x * nx + pose.accel.y * ny) * 0.0016;
        const lap = dr[(i + N - 1) % N] + dr[(i + 1) % N] - 2 * dr[i];
        dv[i] += (-140 * dr[i] - 7 * dv[i] + 60 * lap + inertia * 140 + Math.sin(t * 3 + i) * 2) * dt;
        dr[i] += dv[i] * dt;
        dr[i] = clamp(dr[i], -12, 12);
        let r = R * (1 - f.squash * Math.cos(2 * a) * 1.2);
        if (ny > 0) r *= 1 - 0.1 * Math.pow(ny, 4) + 0.04 * Math.pow(ny, 2) * clamp(-f.squash * 6, 0, 1);
        if (ny < 0) r *= 1 + 0.08 * Math.pow(-ny, 3);
        r += dr[i] + Math.sin(t * 2 + i * 0.7) * 0.6;
        pts.push({ x: nx * r, y: ny * r });
      }

      ctx.save();
      ctx.translate(0, pose.lift);
      ctx.rotate(f.tilt + pose.lean);

      const hot = clamp(f.energy, 0, 1.5);
      const c0 = heatColor(f.heat, "#f1fbff", "#fff3cf", "#ffffff");
      const c1 = heatColor(f.heat, "#a9d6e5", "#ffb547", "#ffd36b");
      const c2 = heatColor(f.heat, "#5f93a8", "#ff6a3d", "#ff8a2a");
      const c3 = heatColor(f.heat, "#2c4b5a", "#a92c17", "#c8441f");

      ctx.save();
      ctx.shadowColor = rgba(f.heat < 0.8 ? "#6fb7d4" : "#ff8a2a", 0.45 * hot);
      ctx.shadowBlur = 26 * hot;
      smoothPath(ctx, pts);
      const g = ctx.createRadialGradient(-12, -16, 2, 0, 4, R * 1.25);
      g.addColorStop(0, c0);
      g.addColorStop(0.35, c1);
      g.addColorStop(0.78, c2);
      g.addColorStop(1, c3);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();

      ctx.save();
      smoothPath(ctx, pts);
      ctx.clip();
      // Pulsing molten heart
      ctx.globalCompositeOperation = "lighter";
      const pulse = 0.75 + 0.25 * Math.sin(t * 2.2);
      const hg = ctx.createRadialGradient(0, 16, 0, 0, 16, 30 * pulse);
      hg.addColorStop(0, rgba(f.heat < 0.8 ? "#bfe8ff" : "#ffd27a", 0.45 * hot));
      hg.addColorStop(1, rgba("#000000", 0));
      ctx.fillStyle = hg;
      ctx.fillRect(-R, -R, R * 2, R * 2.2);
      ctx.globalCompositeOperation = "source-over";
      // Bubbles
      for (const b of bubbles) {
        b.y -= b.s * dt;
        if (b.y < -R) { b.y = R; b.x = (Math.random() - 0.5) * 50; }
        ctx.beginPath();
        ctx.arc(b.x + Math.sin(t * 2 + b.r * 3) * 2, b.y, b.r, 0, TAU);
        ctx.strokeStyle = rgba("#ffffff", 0.45);
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      ctx.restore();

      // Rim and specular highlights
      smoothPath(ctx, pts);
      ctx.strokeStyle = rgba("#3a0f06", 0.35);
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(-6, -6, R * 0.78, Math.PI * 1.08, Math.PI * 1.42);
      ctx.strokeStyle = rgba("#ffffff", 0.75);
      ctx.lineWidth = 4.5;
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(-4, -R * 0.72, 2.4, 0, TAU);
      ctx.fillStyle = rgba("#ffffff", 0.9);
      ctx.fill();

      ctx.scale(1 - f.squash * 0.4, 1 + f.squash * 0.6);
      drawBlush(ctx, pose, 42, 12, "#ff5a7a");
      drawEyes(ctx, pose, { sep: 25, y: -2, w: 13, h: 17, kind: "sclera", fill: "#fffaf2", pupil: "#2a1208", lid: "#4a1608", brow: rgba("#4a1608", 0.85), browW: 2.4 });
      drawMouth(ctx, pose, { y: 16, w: 15, color: "#5a1a0c", inner: "#7d2210", tongue: "#ff7a7a", lineW: 2.4 });
      ctx.restore();

      drawEmote(ctx, pose, -R - 30 + pose.lift, "#ff9a3d");
    },
  };
}

// ───────────────────────────── 3. Cinder ─────────────────────────────
// A little coal critter with glowing cracks, ember eyes and two floating mitten
// hands. The hands do half the acting: waving, pointing at what to click,
// scratching its head, typing, a thumbs-up when done.

type HandKind = "open" | "fist" | "point" | "thumb";
interface HandPose { x: number; y: number; kind: HandKind; rot: number }

function handTargets(g: Gesture, t: number, age: number, pose: Pose): [HandPose, HandPose] {
  const bob = Math.sin(t * 2.4) * 2;
  const restL: HandPose = { x: -48, y: 22 + bob, kind: "open", rot: -0.3 };
  const restR: HandPose = { x: 48, y: 22 - bob, kind: "open", rot: 0.3 };
  switch (g) {
    case "wave": return [restL, { x: 52 + Math.sin(t * 10) * 4, y: -30, kind: "open", rot: Math.sin(t * 10) * 0.55 }];
    case "point": {
      const aim = pose.aim ?? { x: pose.look.x || 0.8, y: pose.look.y };
      const len = Math.hypot(aim.x, aim.y) || 1;
      const ax = aim.x / len, ay = aim.y / len;
      const reach = 58 + Math.sin(age * 6) * 3;
      return [restL, { x: ax * reach, y: ay * reach + 6, kind: "point", rot: Math.atan2(ay, ax) }];
    }
    case "tap": {
      const aim = pose.aim ?? { x: 0.8, y: 0.3 };
      const len = Math.hypot(aim.x, aim.y) || 1;
      const push = Math.max(0, Math.sin(age * 14)) * 10;
      return [restL, { x: (aim.x / len) * (56 + push), y: (aim.y / len) * (56 + push) + 6, kind: "point", rot: Math.atan2(aim.y, aim.x) }];
    }
    case "thumbsUp": return [restL, { x: 50, y: -6 + Math.sin(t * 4) * 2, kind: "thumb", rot: 0 }];
    case "scratch": return [restL, { x: 20 + Math.sin(t * 22) * 3, y: -40, kind: "fist", rot: -0.4 }];
    case "cheeks": return [{ x: -34, y: 10 + Math.sin(t * 20) * 1.2, kind: "open", rot: 0.4 }, { x: 34, y: 10 - Math.sin(t * 20) * 1.2, kind: "open", rot: -0.4 }];
    case "type": {
      const a = Math.max(0, Math.sin(t * 16)) * 6, b = Math.max(0, Math.sin(t * 16 + Math.PI)) * 6;
      return [{ x: -18, y: 42 - a, kind: "fist", rot: 0 }, { x: 18, y: 42 - b, kind: "fist", rot: 0 }];
    }
    case "ear": return [restL, { x: 44, y: -8, kind: "open", rot: -0.9 }];
    case "facepalm": return [{ x: -44, y: 30, kind: "open", rot: -0.2 }, { x: 6, y: -2, kind: "open", rot: -0.2 }];
    case "clap": {
      const d = 8 + Math.abs(Math.sin(t * 8)) * 12;
      return [{ x: -d, y: 28, kind: "open", rot: 0.2 }, { x: d, y: 28, kind: "open", rot: -0.2 }];
    }
    case "chin": return [{ x: -30, y: 36, kind: "open", rot: 0.3 }, { x: 12, y: 32, kind: "fist", rot: 0 }];
    case "pillow": return [{ x: -30, y: 14, kind: "open", rot: 0.6 }, { x: -24, y: 22, kind: "open", rot: 0.6 }];
    case "rest":
    default: return [restL, restR];
  }
}

function drawHand(ctx: Ctx, h: HandPose, glow: string, energy: number): void {
  ctx.save();
  ctx.translate(h.x, h.y);
  ctx.rotate(h.rot);
  const paint = (path: () => void) => {
    path();
    const g = ctx.createRadialGradient(-3, -4, 1, 0, 0, 12);
    g.addColorStop(0, "#ffd08a");
    g.addColorStop(0.55, glow);
    g.addColorStop(1, "#b8401a");
    ctx.fillStyle = g;
    ctx.shadowColor = glow;
    ctx.shadowBlur = 6 + 6 * energy;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#4a160a";
    ctx.lineWidth = 1.6;
    ctx.stroke();
  };
  // Mitten: palm, then thumb or finger depending on the pose.
  if (h.kind === "point") paint(() => { ctx.beginPath(); ctx.roundRect(3, -3.4, 16, 6.8, 3.4); });
  if (h.kind === "thumb") paint(() => { ctx.beginPath(); ctx.roundRect(-3.4, -21, 6.8, 15, 3.4); });
  if (h.kind === "open") paint(() => { ctx.beginPath(); ctx.ellipse(-8, -5, 3.6, 5.4, -0.6, 0, TAU); });
  paint(() => { ctx.beginPath(); ctx.ellipse(0, 0, h.kind === "open" ? 9 : 8.2, h.kind === "open" ? 10.5 : 8.6, 0, 0, TAU); });
  if (h.kind === "fist" || h.kind === "point" || h.kind === "thumb") {
    ctx.strokeStyle = "rgba(74,22,10,0.55)";
    ctx.lineWidth = 1.2;
    for (const y of [-2.5, 2.5]) { ctx.beginPath(); ctx.moveTo(1, y); ctx.lineTo(6, y); ctx.stroke(); }
  }
  ctx.restore();
}

export function createCinder(): Character {
  const rough = Array.from({ length: 36 }, () => (Math.random() - 0.5) * 0.06);
  const cracks: Pt[][] = Array.from({ length: 6 }, (_, i) => {
    const a0 = (i / 6) * TAU + Math.random() * 0.5;
    const pts: Pt[] = [{ x: Math.cos(a0) * 8, y: Math.sin(a0) * 8 + 4 }];
    let a = a0;
    for (let k = 0; k < 4; k++) {
      a += (Math.random() - 0.5) * 0.9;
      const r = 12 + k * 7;
      pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r * 0.95 + 4 });
    }
    return pts;
  });
  const hands: [HandPose, HandPose] = [{ x: -48, y: 22, kind: "open", rot: 0 }, { x: 48, y: 22, kind: "open", rot: 0 }];
  const handVel = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  const tufts = [-9, 0, 9];
  return {
    id: "cinder",
    name: "Cinder",
    pitch: "A little coal critter with ember eyes and floating hands that wave, point at what to click and give a thumbs-up.",
    draw(ctx, pose) {
      const f = pose.face, t = pose.t, dt = pose.dt;
      const R = 34;
      const energy = clamp(f.energy, 0.1, 1.5);
      const glow = heatColor(f.heat, "#b5402a", "#ff8a2a", "#ffc94a");
      const eye = heatColor(f.heat, "#ffb08a", "#ffe9b0", "#ffffff");

      // Hands spring toward their gesture pose.
      const targets = handTargets(pose.gesture, t, pose.gestureAge, pose);
      for (let i = 0; i < 2; i++) {
        const h = hands[i], v = handVel[i], tg = targets[i];
        v.x += (220 * (tg.x - h.x) - 20 * v.x) * dt;
        v.y += (220 * (tg.y - h.y) - 20 * v.y) * dt;
        h.x += v.x * dt;
        h.y += v.y * dt;
        h.rot += (tg.rot - h.rot) * Math.min(1, dt * 14);
        h.kind = tg.kind;
      }

      ctx.save();
      ctx.translate(0, pose.lift);

      // Flame tuft on top
      ctx.save();
      ctx.rotate(f.tilt + pose.lean);
      tufts.forEach((x, i) => {
        const h = (i === 1 ? 16 : 10) * (0.4 + energy) * (0.85 + 0.15 * Math.sin(t * 9 + i * 2));
        const sway = Math.sin(t * 3 + i) * 3 - pose.lean * 10;
        const by = -R * (1 + f.squash) + 4;
        ctx.beginPath();
        ctx.moveTo(x - 5, by);
        ctx.quadraticCurveTo(x - 5, by - h * 0.6, x + sway, by - h);
        ctx.quadraticCurveTo(x + 5, by - h * 0.6, x + 5, by);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, by, 0, by - h);
        g.addColorStop(0, heatColor(f.heat, "#b5402a", "#ff7a22", "#ffd36b"));
        g.addColorStop(1, heatColor(f.heat, "#6a1a10", "#ffd36b", "#ffffff"));
        ctx.fillStyle = g;
        ctx.shadowColor = glow;
        ctx.shadowBlur = 10 * energy;
        ctx.fill();
      });
      ctx.restore();

      ctx.save();
      ctx.rotate(f.tilt + pose.lean);
      ctx.scale(1 - f.squash * 0.55, 1 + f.squash);

      const pts: Pt[] = rough.map((n, i) => {
        const a = (i / rough.length) * TAU;
        const r = R * (1 + n);
        return { x: Math.cos(a) * r, y: Math.sin(a) * r };
      });
      ctx.save();
      ctx.shadowColor = rgba(glow, 0.5 * energy);
      ctx.shadowBlur = 18 * energy;
      smoothPath(ctx, pts);
      const bg = ctx.createRadialGradient(-10, -12, 2, 0, 0, R * 1.1);
      bg.addColorStop(0, "#5b463e");
      bg.addColorStop(0.6, "#2c201c");
      bg.addColorStop(1, "#171110");
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.restore();

      // Glowing cracks
      ctx.save();
      smoothPath(ctx, pts);
      ctx.clip();
      ctx.globalCompositeOperation = "lighter";
      cracks.forEach((c, i) => {
        ctx.beginPath();
        c.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.strokeStyle = rgba(glow, clamp((0.25 + 0.55 * energy) * (0.75 + 0.25 * Math.sin(t * 3 + i * 1.3 + pose.breath)), 0, 1));
        ctx.lineWidth = 1.6;
        ctx.shadowColor = glow;
        ctx.shadowBlur = 6;
        ctx.stroke();
      });
      ctx.restore();

      // Rim light
      ctx.beginPath();
      ctx.arc(0, 0, R - 1, -0.6, 1.1);
      ctx.strokeStyle = rgba(glow, 0.45);
      ctx.lineWidth = 2;
      ctx.stroke();

      drawBlush(ctx, pose, 40, 12, "#ff6a3d");
      drawEyes(ctx, pose, { sep: 24, y: -2, w: 12, h: 16, kind: "glow", fill: eye, pupil: "#2a1208", glow, lid: eye, brow: rgba("#ffb06a", 0.9), browW: 2.4 });
      drawMouth(ctx, pose, { y: 15, w: 14, color: glow, inner: "#ffcf6a", glow, lineW: 2.4 });
      ctx.restore();

      for (const h of hands) drawHand(ctx, h, glow, energy);
      ctx.restore();

      drawEmote(ctx, pose, -R - 40 + pose.lift, "#ff8a2a");
    },
  };
}

// ───────────────────────────── 4. Glint ─────────────────────────────
// Only a pair of glowing eyes and a tiny spark above them. The most minimal
// option and the easiest to read at cursor size; every feeling lives in the
// shape of the eyes.

export function createGlint(): Character {
  let sparkA = 0;
  return {
    id: "glint",
    name: "Glint",
    pitch: "Just two glowing eyes and a spark. The quietest option and the easiest to read at cursor size.",
    draw(ctx, pose) {
      const f = pose.face, t = pose.t;
      const energy = clamp(f.energy, 0.1, 1.5);
      const col = heatColor(f.heat, "#9fd2ff", "#ffe2a8", "#fff8ea");
      const glow = heatColor(f.heat, "#5aa2e0", "#ff9a3d", "#ffd36b");

      ctx.save();
      ctx.translate(0, pose.lift);
      ctx.rotate(f.tilt + pose.lean);

      // Soft backing so it reads over white windows, then a warm halo.
      const back = ctx.createRadialGradient(0, 0, 0, 0, 0, 44);
      back.addColorStop(0, "rgba(26,14,10,0.42)");
      back.addColorStop(1, "rgba(26,14,10,0)");
      ctx.fillStyle = back;
      ctx.fillRect(-46, -46, 92, 92);
      ctx.globalCompositeOperation = "lighter";
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, 40);
      halo.addColorStop(0, rgba(glow, 0.22 * energy));
      halo.addColorStop(1, rgba(glow, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(-46, -46, 92, 92);
      ctx.globalCompositeOperation = "source-over";

      for (const side of [-1, 1]) {
        const near = side * pose.look.x > 0 ? 1 : 0;
        const w = 13 * (1 + 0.12 * (near ? 1 : -1) * Math.abs(pose.look.x));
        const hFull = 30 * (1 + f.squash);
        const open = clamp(f.open, 0, 1.4);
        const h = Math.max(3, hFull * open);
        const cx = side * 15 + pose.look.x * 7;
        const cy = pose.look.y * 6;
        ctx.save();
        ctx.shadowColor = glow;
        ctx.shadowBlur = 14;
        ctx.fillStyle = col;
        if (h <= 4 || (f.smile > 0.85 && open < 0.6)) {
          ctx.beginPath();
          const up = f.smile > 0.4;
          ctx.moveTo(cx - w / 2, cy);
          ctx.quadraticCurveTo(cx, cy + (up ? -12 : 7), cx + w / 2, cy);
          ctx.strokeStyle = col;
          ctx.lineWidth = 4;
          ctx.lineCap = "round";
          ctx.stroke();
        } else {
          // Brows cut into the top of the eye: inner corner for cross, outer for worried.
          const top = cy - h / 2;
          const base = Math.max(0, -f.browY) * h * 0.3 + Math.abs(f.browTilt) * h * 0.12;
          const slope = -f.browTilt * h * 0.28;
          ctx.beginPath();
          const xi = cx - side * w / 2, xo = cx + side * w / 2;
          ctx.moveTo(xo, top + base - slope * 0.5 - 2);
          ctx.lineTo(xi, top + base + slope * 0.5 - 2);
          ctx.lineTo(xi, cy + h);
          ctx.lineTo(xo, cy + h);
          ctx.closePath();
          ctx.clip();
          ctx.beginPath();
          const bottomLift = clamp(f.smile, 0, 1) * h * 0.9;
          ctx.moveTo(cx - w / 2, cy);
          ctx.arc(cx, cy - h / 2 + w / 2, w / 2, Math.PI, 0);
          ctx.lineTo(cx + w / 2, cy + h / 2 - w / 2);
          ctx.quadraticCurveTo(cx + w / 2, cy + h / 2, cx, cy + h / 2 - bottomLift);
          ctx.quadraticCurveTo(cx - w / 2, cy + h / 2, cx - w / 2, cy + h / 2 - w / 2);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }

      // A small glowing mouth only when it matters.
      const showMouth = f.mouthOpen > 0.15 || Math.abs(f.mouth) > 0.6 || pose.talk > 0.05;
      if (showMouth) {
        ctx.save();
        ctx.shadowColor = glow;
        ctx.shadowBlur = 8;
        drawMouth(ctx, pose, { y: 24, w: 12, color: col, inner: col, lineW: 3 });
        ctx.restore();
      }

      // The spark above: orbits when thinking, flares when surprised, droops when sad.
      sparkA += pose.dt * (pose.emotion === "thinking" ? 4 : 0.8);
      let sx = Math.sin(t * 1.7) * 3, sy = -30 + Math.sin(t * 2.6) * 2.5;
      if (pose.emotion === "thinking") { sx = Math.cos(sparkA) * 22; sy = -18 + Math.sin(sparkA) * 9; }
      if (pose.emotion === "sad") { sy = -20; }
      const sr = 2.6 + energy * 2 * (pose.emotion === "surprised" ? 1.6 : 1);
      ctx.globalCompositeOperation = "lighter";
      const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr * 3.2);
      sg.addColorStop(0, rgba("#ffffff", 0.95));
      sg.addColorStop(0.3, rgba(glow, 0.8));
      sg.addColorStop(1, rgba(glow, 0));
      ctx.fillStyle = sg;
      ctx.fillRect(sx - sr * 3.2, sy - sr * 3.2, sr * 6.4, sr * 6.4);
      ctx.restore();

      drawEmote(ctx, pose, -62 + pose.lift, "#ff9a3d");
    },
  };
}

export const FACTORIES = [createCinder, createWisp, createGlassling, createGlint];
