/** The desk mini-view: watch Ember work; take over to use the desk yourself. */

import type { DeskViewApi } from "../../shared/desk";

declare global { interface Window { emberDesk: DeskViewApi } }

const api = window.emberDesk;
const img = document.getElementById("screen") as HTMLImageElement;
const control = document.getElementById("control") as HTMLButtonElement;
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
  inControl = m.control;
  if (!m.control) pressed.clear();
  document.body.classList.toggle("control", m.control);
  control.textContent = m.control ? "Hand back" : "Take over";
  if (m.control) img.focus();
});
control.addEventListener("click", () => (inControl ? api.handBack() : api.takeOver()));
document.getElementById("hide")!.addEventListener("click", () => api.hide());

/** Image pixels → desk pixels (the image is letterboxed by object-fit: contain). */
function toDesk(e: MouseEvent): { x: number; y: number } {
  const r = img.getBoundingClientRect();
  const scale = Math.min(r.width / deskSize.width, r.height / deskSize.height);
  const ox = r.left + (r.width - deskSize.width * scale) / 2, oy = r.top + (r.height - deskSize.height * scale) / 2;
  return { x: Math.round((e.clientX - ox) / scale), y: Math.round((e.clientY - oy) / scale) };
}

/** Losing the keyboard (or being hidden) with keys or buttons down would leave them down on the desk. */
const letGo = () => { pressed.clear(); if (inControl) api.release(); };

img.tabIndex = 0;
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
img.addEventListener("wheel", e => {
  if (!inControl) return;
  e.preventDefault();
  api.input({ type: "wheel", dx: Math.sign(e.deltaX), dy: Math.sign(e.deltaY), ...toDesk(e) });
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
