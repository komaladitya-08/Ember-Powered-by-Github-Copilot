import type { ListenOnceStatus } from "../../shared/ipc";

const listening = (s: ListenOnceStatus | undefined): boolean =>
  s?.phase === "starting" || s?.phase === "listening" || s?.phase === "checking";
/** Main says listening can't start now (its detail says why): the control is unavailable, never a press that does nothing. */
const blocked = (s: ListenOnceStatus | undefined): boolean => s?.phase === "blocked";

/** The same one-request control in Ask and Home. Main owns the session and every permission check. */
export function mountListenOnce(
  button: HTMLButtonElement,
  detail: HTMLElement,
  request: (on: boolean) => Promise<ListenOnceStatus>,
  ready: string,
  fit?: () => void,
): (s: ListenOnceStatus | undefined) => void {
  let status: ListenOnceStatus | undefined;
  let revision = 0;
  let pending: { on: boolean; revision: number } | null = null;
  let error = "";
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
