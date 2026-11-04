/** The learned-memory action acknowledges a durable deletion, and keeps a failed or refused Undo retryable. */
import { LEARNED_UNDONE, MEMORY_FORGETTING, UNDO_LEARNED, learnedUndoFailedText, undoLearnedLabel } from "./copy";

/** Puts one learned fact's async Undo and its local failure message into a conversation row. */
export function mountLearnedUndo(row: HTMLElement, text: string, id: string, forget: (id: string) => Promise<void>): void {
  const undo = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: UNDO_LEARNED });
  undo.setAttribute("aria-label", undoLearnedLabel(text));
  const note = Object.assign(document.createElement("p"), { className: "hint learned-undo-note" });
  note.setAttribute("role", "status");
  undo.addEventListener("click", () => {
    if (undo.getAttribute("aria-disabled") === "true") return;
    undo.setAttribute("aria-disabled", "true");
    undo.textContent = MEMORY_FORGETTING;
    note.textContent = "";
    void forget(id).then(() => { undo.textContent = LEARNED_UNDONE; }, err => {
      undo.removeAttribute("aria-disabled");
      undo.textContent = UNDO_LEARNED;
      note.textContent = learnedUndoFailedText(err);
    });
  });
  row.append(undo, note);
}
