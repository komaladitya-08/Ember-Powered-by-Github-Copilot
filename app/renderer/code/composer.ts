/**
 * The composer: a message (Enter sends, Shift+Enter adds a line), attachments from main's picker, images pasted or
 * dropped as blobs within CODE_LIMITS.blob (a dropped file that isn't an image is refused: the page never learns a
 * dropped file's path, and paths come only from main's pickers), "@" and "/" completions (completions.ts) in a popup
 * the keyboard drives, pickers for the model, reasoning effort, agent mode and permission mode (each showing what is
 * in force after a change, and why when a change was refused), Queue and Steer now while a turn runs, the queue
 * strip (`queue.pendingItems`), Stop, and the context meter (`session.usage_info`, `assistant.usage`).
 */
import { CODE_LIMITS, type CodeAttachment } from "../../shared/code";
import type { CodeApp, View } from "./app";
import { ATTACH_EVENT, attachmentsOf } from "./attach-event";
import { accept, completionItems, moveHighlight, slashItems, triggerAt, type CompletionItem, type Trigger } from "./completions";
import {
  ATTACH, BUSY_HINT, CONTEXT_LABEL, DEFAULT_EFFORT, DEFAULT_MODEL, DROP_ONLY_IMAGES, MESSAGE_LABEL, MESSAGE_PLACEHOLDER, PASTED_IMAGE, PICK_AGENT_MODE,
  PICK_EFFORT, PICK_MODEL, PICK_PERMISSIONS, QUEUE, QUEUE_CANCEL, QUEUE_EDIT, QUEUE_REMOVE, QUEUE_SAVE, QUEUE_SEND_NOW, SEND, SEND_HINT, STEER, STOP,
  SUGGESTIONS, WORKING, agentModeName, blobTooBig, effortName, intentLine, lastCallWords, permissionModeName, queueItemLabel, queueTitle, removeAttachment,
  sessionTitle, steeringLine, stopLabel, tooLong, tooManyAttachments, usageShort, usageWords,
} from "./copy";
import { retryingLine } from "./copy-events";
import { byId, el, idPart, setText } from "./dom";
import { setDraft, setNote, type CodeState } from "./store";

export interface Composer extends View { focus(): void; insert(text: string): void; attach(): void }

export function mountComposer(app: CodeApp): Composer {
  const form = byId<HTMLFormElement>("composer");
  const text = byId<HTMLTextAreaElement>("composer-text");
  const chips = byId("composer-chips");
  const popup = byId("composer-popup");
  const note = byId("composer-note");
  const hint = byId("composer-hint");
  const working = byId("composer-working");
  const queueStrip = byId("composer-queue");
  const send = byId<HTMLButtonElement>("composer-send");
  const steer = byId<HTMLButtonElement>("composer-steer");
  const stop = byId<HTMLButtonElement>("composer-stop");
  const attachBtn = byId<HTMLButtonElement>("composer-attach");
  const meter = byId("composer-meter");
  const model = byId<HTMLSelectElement>("pick-model");
  const effort = byId<HTMLSelectElement>("pick-effort");
  const agentMode = byId<HTMLSelectElement>("pick-agent-mode");
  const permission = byId<HTMLSelectElement>("pick-permissions");
  byId("composer-label").textContent = MESSAGE_LABEL;
  text.placeholder = MESSAGE_PLACEHOLDER;
  attachBtn.textContent = ATTACH;
  steer.textContent = STEER;
  stop.textContent = STOP;
  byId("pick-model-label").textContent = PICK_MODEL;
  byId("pick-effort-label").textContent = PICK_EFFORT;
  byId("pick-agent-mode-label").textContent = PICK_AGENT_MODE;
  byId("pick-permissions-label").textContent = PICK_PERMISSIONS;
  agentMode.replaceChildren(...(["interactive", "plan", "autopilot"] as const).map(m => el("option", { value: m, textContent: agentModeName(m) })));
  permission.replaceChildren(...(["manual", "assisted", "allow-all"] as const).map(m => el("option", { value: m, textContent: permissionModeName(m) })));
  popup.setAttribute("aria-label", SUGGESTIONS);

  let sessionId: string | null = null;
  let attachments: CodeAttachment[] = [];
  let items: CompletionItem[] = [];
  let highlight = -1;
  let trigger: Trigger | null = null;
  let asked = 0;
  let editing: string | null = null;

  const busy = () => {
    if (!sessionId) return false;
    return !!app.state.transcripts[sessionId]?.busy || !!app.state.sessions.byId[sessionId]?.busy;
  };
  const say = (words: string) => { if (sessionId) app.set(s => setNote(s, sessionId!, "composer", words)); };
  const saveDraft = () => { if (sessionId) { const id = sessionId; const d = { text: text.value, attachments: attachments.slice() }; app.set(s => setDraft(s, id, d)); } };

  // ───── Attachments ─────
  function drawChips(): void {
    chips.replaceChildren(...attachments.map((a, i) => {
      const name = a.displayName ?? (a.type === "selection" ? a.filePath : a.type === "blob" ? PASTED_IMAGE : a.path).split(/[\\/]/).pop() ?? "";
      const remove = el("button", { type: "button", className: "chip-x", attrs: { "aria-label": removeAttachment(name), title: removeAttachment(name) } });
      remove.addEventListener("click", () => { attachments.splice(i, 1); drawChips(); saveDraft(); text.focus(); });
      return el("span", { className: "chip", data: { kind: a.type } }, el("span", { className: "chip-name", textContent: name }), remove);
    }));
    chips.hidden = !attachments.length;
  }
  function addAttachments(list: CodeAttachment[]): void {
    const room = CODE_LIMITS.attachments - attachments.length;
    if (list.length > room) say(tooManyAttachments(CODE_LIMITS.attachments));
    attachments = [...attachments, ...list.slice(0, Math.max(0, room))];
    drawChips();
    saveDraft();
  }
  async function attachPicked(): Promise<void> {
    if (!sessionId) return;
    const picked = await app.pickAttachments(sessionId);
    if (picked.length) addAttachments(picked);
    text.focus();
  }
  attachBtn.addEventListener("click", () => { void attachPicked(); });
  // Files a panel tab offers (the Files tab's "Attach to message"), for this session only, as the picker's are added.
  document.addEventListener(ATTACH_EVENT, e => { const list = attachmentsOf((e as CustomEvent).detail, sessionId); if (list?.length) addAttachments(list); });

  /** An image file as a blob attachment, or why it can't be one. */
  async function imageBlob(file: File, name: string): Promise<CodeAttachment | string> {
    if (file.size > CODE_LIMITS.blob) return blobTooBig(CODE_LIMITS.blob);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { type: "blob", data: btoa(bin), mimeType: file.type, displayName: name };
  }
  async function takeImages(files: File[]): Promise<void> {
    const out: CodeAttachment[] = [];
    for (const f of files) {
      const r = await imageBlob(f, f.name || PASTED_IMAGE);
      if (typeof r === "string") say(r); else out.push(r);
    }
    if (out.length) addAttachments(out);
  }
  text.addEventListener("paste", e => {
    const files = [...(e.clipboardData?.items ?? [])].filter(i => i.kind === "file" && i.type.startsWith("image/")).map(i => i.getAsFile()).filter((f): f is File => !!f);
    if (!files.length) return;
    e.preventDefault();
    void takeImages(files);
  });
  form.addEventListener("dragover", e => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  form.addEventListener("drop", e => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    const images = files.filter(f => f.type.startsWith("image/"));
    if (images.length < files.length) say(DROP_ONLY_IMAGES);
    void takeImages(images);
  });

  // ───── Completions ─────
  function closePopup(): void {
    items = []; highlight = -1; trigger = null;
    popup.hidden = true;
    popup.replaceChildren();
    text.setAttribute("aria-expanded", "false");
    text.removeAttribute("aria-activedescendant");
  }
  function drawPopup(): void {
    if (!items.length) { closePopup(); return; }
    popup.hidden = false;
    text.setAttribute("aria-expanded", "true");
    popup.replaceChildren(...items.map((it, i) => {
      const li = el("li", { id: `cmp-${i}`, className: `cmp${i === highlight ? " on" : ""}`, attrs: { role: "option", "aria-selected": String(i === highlight) } },
        el("span", { className: "cmp-label", textContent: it.label }), it.detail ? el("span", { className: "cmp-detail", textContent: it.detail }) : null);
      li.addEventListener("mousedown", e => { e.preventDefault(); take(i); });
      return li;
    }));
    if (highlight >= 0) { text.setAttribute("aria-activedescendant", `cmp-${highlight}`); popup.children[highlight]?.scrollIntoView({ block: "nearest" }); }
  }
  function take(i: number): void {
    const it = items[i];
    if (!it || !trigger) return;
    const r = accept(text.value, text.selectionStart, trigger, it);
    text.value = r.text;
    text.setSelectionRange(r.caret, r.caret);
    closePopup();
    saveDraft();
  }
  async function suggest(): Promise<void> {
    if (!sessionId) return;
    const id = sessionId;
    const triggers = ["/", ...(app.triggers.get(id) ?? [])];
    const caret = text.selectionStart;
    const t = triggerAt(text.value, caret, [...new Set(triggers)]);
    if (!t) { closePopup(); return; }
    const mine = ++asked;
    let next: CompletionItem[];
    if (t.char === "/" && !(app.triggers.get(id) ?? []).includes("/")) next = slashItems(app.commands.get(id) ?? [], t.query, busy());
    else {
      const r = await app.rpc({ scope: "session", sessionId: id, method: "completions.request", params: { text: text.value, offset: caret } });
      next = r.ok ? completionItems(r.value) : [];
      if (t.char === "/" && !next.length) next = slashItems(app.commands.get(id) ?? [], t.query, busy());
    }
    if (mine !== asked || id !== sessionId) return;
    trigger = t;
    items = next;
    highlight = next.length ? 0 : -1;
    drawPopup();
  }

  // ───── Sending ─────
  async function submit(mode?: "enqueue" | "immediate"): Promise<void> {
    if (!sessionId) return;
    const words = text.value;
    if (!words.trim() && !attachments.length) return;
    if (words.length > CODE_LIMITS.prompt) { say(tooLong(words.length, CODE_LIMITS.prompt)); return; }
    const id = sessionId;
    const sentWith = attachments.slice();
    const delivery = mode ?? (busy() ? "enqueue" : undefined);
    text.value = "";
    attachments = [];
    drawChips();
    closePopup();
    app.set(s => setNote(setDraft(s, id, { text: "", attachments: [] }), id, "composer", ""));
    const ok = await app.send(id, words, sentWith, delivery);
    // Nothing typed is lost: a message that didn't go comes back to the box (if it is still empty).
    if (!ok && sessionId === id && !text.value) { text.value = words; attachments = sentWith; drawChips(); saveDraft(); }
  }
  form.addEventListener("submit", e => { e.preventDefault(); void submit(); });
  steer.addEventListener("click", () => { void submit("immediate"); });
  stop.addEventListener("click", () => { if (sessionId) void app.interrupt(sessionId); });

  text.addEventListener("input", () => {
    saveDraft();
    setText(note, text.value.length > CODE_LIMITS.prompt ? tooLong(text.value.length, CODE_LIMITS.prompt) : app.state.notes[sessionId ?? ""]?.composer ?? "");
    void suggest();
  });
  text.addEventListener("keydown", e => {
    if (!popup.hidden && items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || ((e.key === "Home" || e.key === "End") && e.ctrlKey)) { e.preventDefault(); highlight = moveHighlight(highlight, e.key, items.length); drawPopup(); return; }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && highlight >= 0) { e.preventDefault(); take(highlight); return; }
      if (e.key === "Escape") { e.preventDefault(); closePopup(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); void submit(); }
  });
  text.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== text) closePopup(); }, 0));

  // ───── Pickers ─────
  model.addEventListener("change", () => { if (sessionId && model.value) void app.setModel(sessionId, model.value); });
  effort.addEventListener("change", () => { if (sessionId && effort.value) void app.setEffort(sessionId, effort.value); });
  agentMode.addEventListener("change", () => { if (sessionId) void app.setMode(sessionId, "agent", agentMode.value); });
  permission.addEventListener("change", () => { if (sessionId) void app.setMode(sessionId, "permission", permission.value); });

  // ───── The queue ─────
  function drawQueue(s: CodeState): void {
    const q = sessionId ? s.queues[sessionId] : undefined;
    const t = sessionId ? s.transcripts[sessionId] : undefined;
    if (sessionId && t && (!q || q.version !== t.versions.queue) && (busy() || q?.items.length)) {
      // Asked once for each version the SDK said the queue changed at.
      const id = sessionId;
      if (q?.version !== t.versions.queue) app.set(st => ({ ...st, queues: { ...st.queues, [id]: { items: q?.items ?? [], steering: q?.steering ?? [], version: t.versions.queue } } }));
      void app.readQueue(id);
    }
    if (!q || (!q.items.length && !q.steering.length)) { queueStrip.hidden = true; queueStrip.replaceChildren(); return; }
    queueStrip.hidden = false;
    const rows = q.items.map(item => {
      if (editing === item.id) {
        const area = el("textarea", { value: item.text, rows: 2, className: "q-edit", attrs: { "aria-label": queueItemLabel(QUEUE_EDIT, item.text) } });
        const save = el("button", { type: "button", className: "btn quiet small", textContent: QUEUE_SAVE });
        const cancel = el("button", { type: "button", className: "btn quiet small", textContent: QUEUE_CANCEL });
        save.addEventListener("click", () => { editing = null; if (sessionId) void app.queueChange(sessionId, "queue.updateText", { id: item.id, prompt: area.value }); });
        cancel.addEventListener("click", () => { editing = null; drawQueue(app.state); text.focus(); });
        setTimeout(() => area.focus(), 0);
        return el("li", { className: "q-item editing" }, area, el("span", { className: "q-acts" }, save, cancel));
      }
      const edit = el("button", { type: "button", className: "btn quiet small", textContent: QUEUE_EDIT, attrs: { "aria-label": queueItemLabel(QUEUE_EDIT, item.text) } });
      const now = el("button", { type: "button", className: "btn quiet small", textContent: QUEUE_SEND_NOW, attrs: { "aria-label": queueItemLabel(QUEUE_SEND_NOW, item.text) } });
      const remove = el("button", { type: "button", className: "btn quiet small", textContent: QUEUE_REMOVE, attrs: { "aria-label": queueItemLabel(QUEUE_REMOVE, item.text) } });
      edit.addEventListener("click", () => { editing = item.id; drawQueue(app.state); });
      now.addEventListener("click", () => { if (sessionId) void app.queueChange(sessionId, "queue.sendNow", { id: item.id }); });
      remove.addEventListener("click", () => { if (sessionId) void app.queueChange(sessionId, "queue.removeAt", { id: item.id }); });
      return el("li", { className: "q-item", id: `q-${idPart(item.id)}` }, el("span", { className: "q-text", textContent: item.text }), el("span", { className: "q-acts" }, edit, now, remove));
    });
    queueStrip.replaceChildren(
      el("p", { className: "q-title", textContent: queueTitle(q.items.length) }),
      el("ul", { className: "q-list" }, ...rows, ...q.steering.map(m => el("li", { className: "q-item steering", textContent: steeringLine(m) }))),
      ...(s.notes[sessionId ?? ""]?.queue ? [el("p", { className: "problem-line", textContent: s.notes[sessionId ?? ""]!.queue })] : []));
  }

  let lastModels: unknown = null;
  function render(s: CodeState, prev: CodeState | null): void {
    const id = s.view.kind === "session" ? s.view.id : null;
    if (id !== sessionId) {
      sessionId = id;
      const d = id ? s.drafts[id] : undefined;
      text.value = d?.text ?? "";
      attachments = d ? d.attachments.slice() : [];
      editing = null;
      drawChips();
      closePopup();
      if (id) void app.loadCatalog();
    }
    if (!id) return;
    const row = s.sessions.byId[id];
    const t = s.transcripts[id];
    if (prev && prev.view === s.view && prev.sessions.byId[id] === row && prev.transcripts[id] === t && prev.notes[id] === s.notes[id] && prev.catalog === s.catalog && prev.queues[id] === s.queues[id]) return;
    const isBusy = !!t?.busy || !!row?.busy;
    send.textContent = isBusy ? QUEUE : SEND;
    steer.hidden = stop.hidden = !isBusy;
    stop.setAttribute("aria-label", stopLabel(sessionTitle(row ?? { name: "" })));
    setText(hint, isBusy ? BUSY_HINT : SEND_HINT);
    setText(working, isBusy ? (t?.retrying ? retryingLine(t.retrying.attempt) : t?.intent ? intentLine(t.intent) : WORKING) : "");
    if (s.catalog.models !== lastModels || prev?.transcripts[id]?.model !== t?.model) {
      lastModels = s.catalog.models;
      const current = t?.model ?? row?.model ?? "";
      const known = (s.catalog.models ?? []).filter(m => m.enabled);
      model.replaceChildren(
        ...(current && !known.some(m => m.id === current) ? [el("option", { value: current, textContent: current })] : []),
        ...(!current ? [el("option", { value: "", textContent: DEFAULT_MODEL })] : []),
        ...known.map(m => el("option", { value: m.id, textContent: m.name })));
      model.value = current;
    }
    const m = s.catalog.models?.find(x => x.id === (t?.model ?? row?.model));
    const efforts = m?.efforts ?? [];
    effort.replaceChildren(el("option", { value: "", textContent: DEFAULT_EFFORT }), ...efforts.map(e => el("option", { value: e, textContent: effortName(e) })));
    effort.value = t?.reasoningEffort && efforts.includes(t.reasoningEffort) ? t.reasoningEffort : "";
    effort.disabled = !efforts.length;
    if (row) {
      agentMode.value = t?.agentMode ?? row.agentMode;
      permission.value = t?.permissionMode ?? row.permissionMode;
    }
    const notes = s.notes[id] ?? {};
    setText(note, [notes.agent, notes.permission, notes.model, notes.effort, notes.composer, notes.stop, notes.attach].filter(Boolean).join(" "));
    // The context meter: how much of the model's context the session uses.
    if (t?.usage) {
      const pct = t.usage.tokenLimit > 0 ? Math.min(100, Math.round((t.usage.currentTokens / t.usage.tokenLimit) * 100)) : 0;
      meter.hidden = false;
      meter.setAttribute("aria-valuenow", String(pct));
      meter.setAttribute("aria-valuetext", usageWords(t.usage.currentTokens, t.usage.tokenLimit));
      meter.setAttribute("aria-label", CONTEXT_LABEL);
      meter.title = [usageWords(t.usage.currentTokens, t.usage.tokenLimit), t.lastCall ? lastCallWords(t.lastCall) : ""].filter(Boolean).join("\n");
      (meter.querySelector(".meter-fill") as HTMLElement).style.setProperty("--fill", `${pct}%`);
      setText(meter.querySelector(".meter-words")!, usageShort(t.usage.currentTokens, t.usage.tokenLimit));
    } else meter.hidden = true;
    drawQueue(s);
  }

  return {
    render,
    focus() { text.focus(); },
    insert(words: string) { text.value = words; text.focus(); text.setSelectionRange(words.length, words.length); saveDraft(); void suggest(); },
    attach() { void attachPicked(); },
  };
}
