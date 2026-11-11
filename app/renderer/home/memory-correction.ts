/**
 * One local correction draft survives list paging and live updates, and waits out of sight while the same account is
 * checked again (a reconnect keeps the epoch: memory-8); ownership resets retire both the draft and its acknowledgement.
 */
import type { EmberHomeApi, MemoryView } from "../../shared/ipc";
import { MEMORY_CORRECTION as words, memoryCorrectionFailedText, memoryProvenanceLabel } from "./copy";

type MemoryRow = MemoryView["rows"][number];
const same = (a: MemoryRow, b: MemoryRow) => a.id === b.id && a.text === b.text && a.source === b.source && a.at === b.at && (a.revision ?? 0) === (b.revision ?? 0) && a.until === b.until;

/** Mounts a deliberately submitted correction; typing, cancelling and live-list changes never write a fact. */
export function mountMemoryCorrection(api: Pick<EmberHomeApi, "correctMemory">, fallback: () => HTMLElement, saved?: (expected: MemoryRow, corrected: MemoryRow) => void): {
  open(row: MemoryRow): void;
  observe(rows: MemoryRow[], epoch: number, owned: boolean, writable: boolean): void;
} {
  const $ = (id: string) => document.getElementById(id)!;
  const form = $("memory-correction") as HTMLFormElement;
  const input = $("memory-correction-text") as HTMLTextAreaElement;
  const save = $("memory-correction-save") as HTMLButtonElement;
  const cancel = $("memory-correction-cancel") as HTMLButtonElement;
  const status = $("memory-correction-status");
  $("memory-correction-title").textContent = words.title;
  $("memory-correction-label").textContent = words.label;
  $("memory-correction-hint").textContent = words.hint;
  save.textContent = words.save; cancel.textContent = words.cancel;
  let expected: MemoryRow | null = null, epoch = 0, generation = 0, busy = false, writable = false, stale = false;
  /** The draft waits while memory is checked again; `refocus`: it had focus, which went to the fallback meanwhile. */
  let held = false, refocus = false;
  const say = (text: string) => { status.textContent = text; };
  const close = (message = "", returnFocus = true) => {
    const hadFocus = form.contains(document.activeElement);
    const id = expected?.id;
    generation++; expected = null; busy = false; stale = false; held = false; refocus = false;
    input.value = ""; $("memory-correction-original").textContent = ""; $("memory-correction-source").textContent = "";
    form.hidden = true; save.removeAttribute("aria-disabled"); cancel.removeAttribute("aria-disabled"); say(message);
    if (hadFocus && returnFocus) {
      const button = [...document.querySelectorAll<HTMLElement>("[data-memory-correct]")].find(el => el.dataset.memoryCorrect === id);
      (button ?? fallback()).focus();
    }
  };
  cancel.addEventListener("click", () => { if (!busy) close(); });
  form.addEventListener("submit", e => {
    e.preventDefault();
    if (busy || !expected) return;
    if (!writable) { say(words.off); input.focus(); return; }
    if (stale) { say(words.stale); input.focus(); return; }
    if (!input.value.trim() || input.value.length > 400) { input.reportValidity(); return; }
    const request = { expected: { ...expected }, epoch, text: input.value };
    const started = generation;
    busy = true;
    save.setAttribute("aria-disabled", "true"); cancel.setAttribute("aria-disabled", "true"); say(words.saving);
    void api.correctMemory(request).then(corrected => {
      if (started !== generation) return;
      saved?.(request.expected, corrected);
      close(words.saved);
    }, error => { if (started === generation) say(memoryCorrectionFailedText(error)); }).finally(() => {
      if (started !== generation) return;
      busy = false; save.removeAttribute("aria-disabled"); cancel.removeAttribute("aria-disabled");
    });
  });
  return {
    open(row) {
      if (expected) { if (expected.id !== row.id) say(words.finish); input.focus(); return; }
      expected = { ...row }; stale = false; generation++;
      input.value = row.text;
      $("memory-correction-original").textContent = row.text;
      $("memory-correction-source").textContent = memoryProvenanceLabel(row.source, row.correctedAt, row.kind);
      form.hidden = false; say(writable ? "" : words.off); input.focus(); input.select();
    },
    observe(rows, nextEpoch, owned, canWrite) {
      writable = canWrite;
      if (epoch !== nextEpoch) { epoch = nextEpoch; close(); return; }
      // The same account's memory, checked again: the draft goes out of sight with the list, and comes back with it.
      if (!owned) {
        if (!expected || held) return;
        held = true;
        refocus = form.contains(document.activeElement);
        form.hidden = true;
        if (refocus) fallback().focus();
        return;
      }
      if (held) {
        held = false;
        form.hidden = false;
        // Only if focus is still where it was put: someone who moved on meanwhile stays where they are.
        if (refocus && document.activeElement === fallback()) input.focus();
        refocus = false;
      }
      if (!expected) return;
      const current = rows.find(row => row.id === expected?.id);
      if (!current) { close(words.gone); return; }
      stale = !same(expected, current);
      if (!busy) say(stale ? words.stale : writable ? "" : words.off);
    },
  };
}
