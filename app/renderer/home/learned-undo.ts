/** The learned-memory action acknowledges a durable deletion, and keeps a failed or refused Undo retryable. */
import { LEARNED_UNDO_MS } from "../../shared/ipc";
import { FORGET_LEARNED, LEARNED_UNDONE, MEMORY_FORGETTING, MEMORY_PUT_BACK, MEMORY_UNDO_EXPIRED, UNDO_LEARNED, forgetMemoryLabel, learnedUndoFailedText, memoryDeleteFailedText, memoryRestoreFailedText, undoForgotLabel, undoLearnedLabel } from "./copy";

/**
 * Puts one learned fact's async Undo and its local failure message into a conversation row. `at`: when Ember learned
 * it (the line's time). For LEARNED_UNDO_MS forgetting it undoes it, so what it replaced holds again, and the button
 * says Undo; after that main forgets it alone, so the button says Forget, where it is (memory-r9-10). A time that
 * can't be read counts as old.
 */
export function mountLearnedUndo(row: HTMLElement, text: string, id: string, forget: (id: string) => Promise<void>, at?: string): void {
  const left = () => LEARNED_UNDO_MS - (Date.now() - Date.parse(at ?? ""));
  const undoes = () => (at === undefined ? true : left() > 0);
  const undo = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small" });
  const label = () => {
    undo.textContent = undoes() ? UNDO_LEARNED : FORGET_LEARNED;
    undo.setAttribute("aria-label", undoes() ? undoLearnedLabel(text) : forgetMemoryLabel(text));
  };
  label();
  // Still on the page when its time is over: the words change, the button and focus stay.
  if (at !== undefined && undoes()) setTimeout(() => { if (undo.getAttribute("aria-disabled") !== "true") label(); }, left() + 50);
  const note = Object.assign(document.createElement("p"), { className: "hint learned-undo-note" });
  note.setAttribute("role", "status");
  undo.addEventListener("click", () => {
    if (undo.getAttribute("aria-disabled") === "true") return;
    undo.setAttribute("aria-disabled", "true");
    undo.textContent = MEMORY_FORGETTING;
    note.textContent = "";
    void forget(id).then(() => { undo.textContent = LEARNED_UNDONE; }, err => {
      undo.removeAttribute("aria-disabled");
      label();
      note.textContent = undoes() ? learnedUndoFailedText(err) : memoryDeleteFailedText(err);
    });
  });
  row.append(undo, note);
}

/**
 * The Undo beside "Ember forgot: …" (memory-v2): puts the forgotten fact back while main still can (restore's token),
 * says so once it is too late, and keeps a failed Undo retryable.
 */
export function mountForgotUndo(row: HTMLElement, text: string, token: string, restore: (token: string) => Promise<boolean>): void {
  const undo = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: UNDO_LEARNED });
  undo.setAttribute("aria-label", undoForgotLabel(text));
  const note = Object.assign(document.createElement("p"), { className: "hint learned-undo-note" });
  note.setAttribute("role", "status");
  undo.addEventListener("click", () => {
    if (undo.getAttribute("aria-disabled") === "true") return;
    undo.setAttribute("aria-disabled", "true");
    note.textContent = "";
    void restore(token).then(put => {
      if (put) { undo.textContent = MEMORY_PUT_BACK; return; }
      note.textContent = MEMORY_UNDO_EXPIRED;
      // Focus stays in the line (never dropped to the page with the hidden button), on the words that say it's too late.
      if (row.contains(document.activeElement)) { note.tabIndex = -1; note.focus(); }
      undo.hidden = true;
    }, err => {
      undo.removeAttribute("aria-disabled");
      note.textContent = memoryRestoreFailedText(err);
    });
  });
  row.append(undo, note);
}
