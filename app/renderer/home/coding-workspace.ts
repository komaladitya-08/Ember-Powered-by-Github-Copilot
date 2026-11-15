/** The coding workspace is distinct from Projects' selected-file review. */
import type { CodingWorkspaceState } from "../../shared/ipc";

export function mountCodingWorkspace(): void {
  const root = document.querySelector<HTMLElement>("#coding-workspace")!;
  const folder = root.querySelector<HTMLElement>("#coding-workspace-folder")!;
  const branch = root.querySelector<HTMLElement>("#coding-workspace-branch")!;
  const choose = root.querySelector<HTMLButtonElement>("#coding-workspace-choose")!;
  const forget = root.querySelector<HTMLButtonElement>("#coding-workspace-forget")!;
  const ask = root.querySelector<HTMLButtonElement>("#coding-workspace-ask")!;
  const activity = root.querySelector<HTMLButtonElement>("#coding-workspace-activity")!;
  const status = root.querySelector<HTMLElement>("#coding-workspace-status")!;
  let state: CodingWorkspaceState | null = null;
  let picking = false;
  let epoch = 0;

  const draw = () => {
    folder.textContent = state?.folder ? `Active folder: ${state.folder}` : "No coding folder selected.";
    branch.textContent = state?.branch ? `Branch: ${state.branch}` : "";
    branch.hidden = !state?.branch;
    choose.disabled = !state || state.available === false || state.running || picking;
    forget.disabled = !state?.folder || state.running || picking;
    ask.disabled = !state?.folder || state.available === false || picking;
    status.textContent = state?.error ?? (state?.available === false ? "Coding work is temporarily unavailable. Desktop tasks still work." : state?.running ? "A coding task is running. Stop it before changing folders." : "");
  };
  window.ember.onCodingState(next => { epoch++; state = next; draw(); });
  const ticket = epoch;
  void window.ember.codingState().then(next => {
    if (ticket === epoch) { state = next; draw(); }
  }).catch(() => {
    if (ticket === epoch) status.textContent = "Couldn't load the coding workspace. Try reopening settings.";
  });
  choose.addEventListener("click", async () => {
    if (choose.disabled) return;
    const at = epoch;
    picking = true;
    let failed = false;
    draw();
    try {
      const next = await window.ember.codingChooseWorkspace();
      if (at === epoch) state = next;
    } catch {
      if (at === epoch) failed = true;
    } finally {
      picking = false;
      if (at === epoch && state) draw();
      else if (at !== epoch) draw();
      if (failed && at === epoch) status.textContent = "Couldn't choose a coding folder. Your current selection is kept.";
    }
  });
  forget.addEventListener("click", async () => {
    if (forget.disabled) return;
    const at = epoch;
    picking = true;
    let failed = false;
    draw();
    try {
      const next = await window.ember.codingClearWorkspace();
      if (at === epoch) state = next;
    } catch {
      if (at === epoch) failed = true;
    } finally {
      picking = false;
      draw();
      if (failed && at === epoch) status.textContent = "Couldn't forget the coding folder. Try again.";
    }
  });
  ask.addEventListener("click", () => void window.ember.openAsk().catch(() => { status.textContent = "Couldn't open Ask Ember."; }));
  activity.addEventListener("click", () => document.querySelector<HTMLButtonElement>("#p-tasks")?.click());
}
