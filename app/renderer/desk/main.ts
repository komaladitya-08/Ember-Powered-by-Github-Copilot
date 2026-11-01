/** The desk mini-view: watch Ember work; take over to use the desk yourself. */

import type { DeskViewApi } from "../../shared/desk";
import { wheelSteps, type WheelState } from "./wheel";
import { modeNews, screenName } from "./a11y";

declare global { interface Window { emberDesk: DeskViewApi } }

const api = window.emberDesk;
const img = document.getElementById("screen") as HTMLImageElement;
const control = document.getElementById("control") as HTMLButtonElement;
const live = document.getElementById("live")!;
let deskSize = { width: 1280, height: 800 };
let inControl = false;
/** Mouse buttons pressed on the desk picture (MouseEvent.button). */
const pressed = new Set<number>();

api.onFrame(f => {
  img.src = f.url;
  // The picture shows from the first frame on (never an empty, broken image).
  document.body.classList.add("live");
  deskSize = { width: f.width, height: f.height };
  document.getElementById("title")!.textContent = f.title;
});
api.onMode(m => {
  const was = inControl;
  inControl = m.control;
  if (!m.control) pressed.clear();
  document.body.classList.toggle("control", m.control);
  control.textContent = m.control ? "Hand back" : "Take over";
  // Taken over, the picture has every key: its name says so and how to hand back, and so does a live announcement.
  // Otherwise it takes no keys, so it is no stop for Tab.
  img.alt = screenName(m.control);
  img.tabIndex = m.control ? 0 : -1;
  const news = modeNews(m.control, was);
  if (news) live.textContent = news;
  if (m.control) img.focus();
  else if (document.activeElement === img) control.focus();
});
control.addEventListener("click", () => (inControl ? api.handBack() : api.takeOver()));
document.getElementById("hide")!.addEventListener("click", () => api.hide());

/** Image pixels → desk pixels (the image is letterboxed by object-fit: contain, inside its 1px keyline). */
function toDesk(e: MouseEvent): { x: number; y: number } {
  const r = img.getBoundingClientRect();
  const left = r.left + img.clientLeft, top = r.top + img.clientTop, w = img.clientWidth, h = img.clientHeight;
  const scale = Math.min(w / deskSize.width, h / deskSize.height);
  const ox = left + (w - deskSize.width * scale) / 2, oy = top + (h - deskSize.height * scale) / 2;
  return { x: Math.round((e.clientX - ox) / scale), y: Math.round((e.clientY - oy) / scale) };
}

/** Losing the keyboard (or being hidden) with keys or buttons down would leave them down on the desk. */
const letGo = () => { pressed.clear(); if (inControl) api.release(); };

img.tabIndex = -1;
img.addEventListener("mousemove", e => { if (inControl) api.input({ type: "move", ...toDesk(e) }); });
img.addEventListener("mousedown", e => {
  if (!inControl) return;
  e.preventDefault();
  img.focus();
  pressed.add(e.button);
  api.input({ type: "button", button: e.button, down: true, ...toDesk(e) });
});
// A button let go anywhere (even off the picture) is let go on the desk too.
window.addEventListener("mouseup", e => {
  if (pressed.delete(e.button) && inControl) api.input({ type: "button", button: e.button, down: false, ...toDesk(e) });
});
const wheel: WheelState = { x: 0, y: 0, at: 0 };
img.addEventListener("wheel", e => {
  if (!inControl) return;
  e.preventDefault();
  const { dx, dy } = wheelSteps(wheel, e, img.clientHeight || 600);
  // A very fast fling is a few steps, not dozens.
  for (let i = 0; i < Math.min(10, Math.max(Math.abs(dx), Math.abs(dy))); i++) {
    api.input({ type: "wheel", dx: i < Math.abs(dx) ? Math.sign(dx) : 0, dy: i < Math.abs(dy) ? Math.sign(dy) : 0, ...toDesk(e) });
  }
}, { passive: false });
img.addEventListener("contextmenu", e => e.preventDefault());
// Back and forward buttons go to the desk, not to this page.
img.addEventListener("auxclick", e => e.preventDefault());
for (const t of ["keydown", "keyup"] as const) {
  img.addEventListener(t, e => {
    if (!inControl) return;
    e.preventDefault();
    // Ctrl+Alt+End (or Ctrl+Alt+Esc, which GNOME keeps for itself) is the way out by keyboard:
    // it hands the desk back and never reaches the desk.
    if ((e.key === "End" || e.key === "Escape") && e.ctrlKey && e.altKey) { if (t === "keydown") api.handBack(); return; }
    api.input({ type: "key", key: e.key, code: e.code, down: t === "keydown" });
  });
}
window.addEventListener("blur", letGo);
document.addEventListener("visibilitychange", () => { if (document.hidden) letGo(); });
