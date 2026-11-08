import type { ListenOnceStatus } from "../../shared/ipc";

const listening = (s: ListenOnceStatus | undefined): boolean =>
  s?.phase === "starting" || s?.phase === "listening" || s?.phase === "checking";
/** Main says listening can't start now (its detail says why): the control is unavailable, never a press that does nothing. */
const blocked = (s: ListenOnceStatus | undefined): boolean => s?.phase === "blocked";

/**
 * The same one-request control in Ask and Home. Main owns the session and every permission check. `live`: the status
 * line screen readers are told the detail's changes through, all but those main marks `listening`: that Ember is
 * already listening (a wake's or a conversation's window, or the other control's Listen once) changes as the microphone
 * opens for a request (and a question's line while a conversation waits for its answer, voice-listening-v4-1), and a
 * screen reader saying it then was heard in the request, or as one of its own in a conversation. Kept from before, the
 * line isn't said again when it comes back as the window closes either (voice-listening-c3-1). That holds for a press's
 * own answer too (a window opened as it was pressed, and would hear it); `live` is emptied then, unsaid, so browse mode
 * never reads a line that no longer holds beside the one shown, such as "Checking the microphone…" (voice-listening-v4-2).
 */
export function mountListenOnce(
  button: HTMLButtonElement,
  detail: HTMLElement,
  request: (on: boolean) => Promise<ListenOnceStatus>,
  ready: string,
  fit?: () => void,
  live?: HTMLElement,
): (s: ListenOnceStatus | undefined) => void {
  let status: ListenOnceStatus | undefined;
  let revision = 0;
  let pending: { on: boolean; revision: number } | null = null;
  let error = "";
  /** The line `live` last settled on (never a press's own "Checking the microphone…"), kept while `live` is emptied. */
  let told = live?.textContent ?? "";
  const draw = () => {
    const label = listening(status) ? "Cancel listening" : "Listen once";
    if (button.textContent !== label) button.textContent = label;
    // Drawn as disabled (opacity 0.4), where a press in flight only waits (companion-3: it was drawn and announced as
    // available, and a press only flashed "Checking the microphone…").
    button.setAttribute("data-blocked", String(!pending && blocked(status)));
    button.setAttribute("aria-disabled", String(!status || !!pending || blocked(status)));
    const text = pending?.revision === revision
      ? pending.on ? "Checking the microphone…" : "Cancelling…"
      : error || (status ? status.detail || ready : "Checking the microphone…");
    if (detail.textContent !== text) detail.textContent = text;
    const settled = pending?.revision !== revision;
    const quiet = settled && !error && status?.phase === "blocked" && status.reason === "listening";
    // (An emptied status line says nothing; what it said before is what the next line is compared with.)
    if (live && quiet) { if (live.textContent) live.textContent = ""; }
    else if (live && (live.textContent || told) !== text) { live.textContent = text; if (settled) told = text; }
    fit?.();
  };
  const update = (next: ListenOnceStatus | undefined) => {
    status = next;
    revision++;
    error = "";
    draw();
  };
  const toggle = async () => {
    if (!status || pending || blocked(status)) return;
    const change = pending = { on: !listening(status), revision };
    error = "";
    draw();
    try {
      const result = await request(change.on);
      if (change.revision === revision) update(result);
    } catch {
      if (change.revision === revision) error = "Couldn't update the microphone. Try again.";
    } finally {
      pending = null;
      draw();
    }
  };
  button.addEventListener("click", () => { void toggle(); });
  draw();
  return update;
}
