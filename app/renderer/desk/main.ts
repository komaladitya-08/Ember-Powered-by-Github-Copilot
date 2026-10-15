/** The desk mini-view: watch Ember work; take over to use the desk yourself. */

import type { DeskViewApi } from "../../shared/desk";

declare global { interface Window { emberDesk: DeskViewApi } }

const api = window.emberDesk;
const img = document.getElementById("screen") as HTMLImageElement;
const control = document.getElementById("control") as HTMLButtonElement;
let deskSize = { width: 1280, height: 800 };
let inControl = false;

api.onFrame(f => {
  img.src = f.url;
  deskSize = { width: f.width, height: f.height };
  document.getElementById("title")!.textContent = f.title;
});
api.onMode(m => {
  inControl = m.control;
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

img.tabIndex = 0;
img.addEventListener("mousemove", e => { if (inControl) api.input({ type: "move", ...toDesk(e) }); });
img.addEventListener("mousedown", e => { if (inControl) { e.preventDefault(); img.focus(); api.input({ type: "button", button: e.button + 1, down: true, ...toDesk(e) }); } });
img.addEventListener("mouseup", e => { if (inControl) api.input({ type: "button", button: e.button + 1, down: false, ...toDesk(e) }); });
img.addEventListener("wheel", e => { if (inControl) { e.preventDefault(); api.input({ type: "wheel", dy: Math.sign(e.deltaY), ...toDesk(e) }); } }, { passive: false });
img.addEventListener("contextmenu", e => e.preventDefault());
for (const t of ["keydown", "keyup"] as const) {
  img.addEventListener(t, e => {
    if (!inControl) return;
    e.preventDefault();
    api.input({ type: "key", key: e.key, code: e.code, down: t === "keydown" });
  });
}
