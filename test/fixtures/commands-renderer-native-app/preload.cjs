/** Synthetic fixture bridge only: unchanged Commands API; no production IPC, Node, model, command or arbitrary state authority. */
/* eslint-disable @typescript-eslint/no-require-imports -- A plain sandbox-supported Electron preload, never built or injected into production. */
const { contextBridge, ipcRenderer } = require("electron");

const prefix = "commands-renderer:";
let current = 0, armMs = 1500, deliveryAt = 0, lastTime = 0, clockOk = true, fontsReady = false;
const reports = new Map();
function now() {
  const value = Date.now();
  if (!Number.isFinite(value) || value < lastTime) clockOk = false;
  lastTime = value; return value;
}
function fault() { ipcRenderer.send(prefix + "fault", 1); }
function acceptState(state) {
  const n = state?.card?.n ?? 0;
  if (n !== 0 && n !== 1 && n !== 2) { fault(); return; }
  if (n && n !== current) { deliveryAt = now(); armMs = state.card.armMs; }
  current = n;
}
const on = (name, listener) => ipcRenderer.on(prefix + name, (_event, value) => listener(value));
const api = {
  pull: async () => { const value = await ipcRenderer.invoke(prefix + "pull"); acceptState(value?.state); return value; },
  onState: listener => on("state", state => { acceptState(state); listener(state); }),
  onOutput: listener => on("output", listener),
  answer: answer => {
    if (!answer || !Number.isInteger(answer.n) || ![1, 2].includes(answer.n) || !["once", "deny"].includes(answer.answer) || typeof answer.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(answer.sha256)) { fault(); return; }
    ipcRenderer.send(prefix + "answer", { n: answer.n, answer: answer.answer, sha256: answer.sha256 });
  },
  cardSeen: report => {
    // Production prioritizes its original boolean report. Standalone telemetry carries no approval authority here.
    if (report && [1, 2].includes(report.n) && Object.hasOwn(report, "diagnostic") &&
        typeof report.seen !== "boolean" && typeof report.inView !== "boolean") return;
    if (!report || ![1, 2].includes(report.n) || typeof report.seen !== "boolean" || typeof report.inView !== "boolean" || (report.inView && !report.seen)) { fault(); return; }
    // Withdrawals for the old card are real renderer messages too, but cannot become the new card's report.
    if (report.n === current) {
      const old = reports.get(report.n);
      reports.set(report.n, { seen: report.seen, inView: report.inView, firstAt: old?.firstAt ?? now() });
    }
    ipcRenderer.send(prefix + "seen", { n: report.n, seen: report.seen, inView: report.inView });
  },
  size: () => {}, stop: fault, input: fault, close: fault, closeWindow: fault,
};
contextBridge.exposeInMainWorld("emberCommands", api);

/** Independent current DOM sample, with exactly production judgeMetrics' one-CSS-pixel slack and clipping rule. */
function sample(sequence) {
  const time = now(), block = document.getElementById("ask-cmd"), card = block?.closest(".ask");
  const allow = card?.querySelector("button"), deny = card?.querySelectorAll("button")[1], actions = card?.querySelector(".actions");
  const dom = (block ? 1 : 0) | (allow ? 2 : 0) | (allow && !allow.disabled ? 4 : 0) | (deny && !deny.disabled ? 8 : 0) | (allow?.disabled ? 16 : 0);
  let geometry = 0;
  if (block && actions) {
    const r = block.getBoundingClientRect(); let top = 0, left = 0, bottom = innerHeight, right = innerWidth;
    for (let a = block.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const style = getComputedStyle(a); if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const box = a.getBoundingClientRect(); top = Math.max(top, box.top + a.clientTop); left = Math.max(left, box.left + a.clientLeft);
      bottom = Math.min(bottom, box.top + a.clientTop + a.clientHeight); right = Math.min(right, box.left + a.clientLeft + a.clientWidth);
    }
    const actionsTop = actions.getBoundingClientRect().top; bottom = Math.min(bottom, actionsTop);
    const narrow = block.scrollWidth <= block.clientWidth + 1, fits = narrow && block.scrollHeight <= block.clientHeight + 1;
    const atEnd = narrow && block.scrollTop + block.clientHeight >= block.scrollHeight - 1;
    const inClip = [top, left, bottom, right].every(Number.isFinite) && r.top >= top - 1 && r.left >= left - 1 && r.bottom <= bottom + 1 && r.right <= right + 1;
    const inViewport = r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1;
    const visible = document.visibilityState === "visible", positive = block.clientHeight > 0 && block.clientWidth > 0;
    const onScreen = visible && positive && inClip && inViewport;
    geometry = (fits ? 1 : 0) | (atEnd ? 2 : 0) | (onScreen ? 4 : 0) | (visible ? 8 : 0) | (inClip ? 16 : 0) | (inViewport ? 32 : 0) | (positive ? 64 : 0) | (r.bottom <= actionsTop + 1 ? 128 : 0);
  }
  const report = reports.get(current), reported = (report ? 1 : 0) | (report?.seen ? 2 : 0) | (report?.inView ? 4 : 0);
  // Actual cardSeen occurs after CardModel creation: its first timestamp bounds shownAt from above. Zero means unknown.
  const arm = !clockOk || !current ? 0 : report && time >= report.firstAt + armMs ? 2 : time < deliveryAt + armMs ? 1 : 0;
  return { schema: 1, sequence, card: block ? current : 0, dom, geometry, reported, arm, assets: fontsReady ? 4 : 0, lifecycle: clockOk ? 128 : 0 };
}
on("sample", sequence => {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 16) { fault(); return; }
  try { ipcRenderer.send(prefix + "sampled", sample(sequence)); } catch { fault(); }
});
document.addEventListener("DOMContentLoaded", () => {
  // pagePrefs' actual default removes this attribute; no test-only size or font override is applied.
  delete document.documentElement.dataset.textSize;
  void document.fonts.ready.then(() => document.fonts.load('14px "Ember Sans"')).then(() => {
    fontsReady = document.fonts.status === "loaded" && document.fonts.check('14px "Ember Sans"');
    ipcRenderer.send(prefix + "ready", fontsReady ? 1 : 0);
  }).catch(fault);
});
