import type { ProjectMode } from "../../shared/ipc";

export function mountProject() {
  const form = document.querySelector<HTMLFormElement>("#project-form")!;
  const pick = form.querySelector<HTMLButtonElement>("#project-pick")!;
  const clear = form.querySelector<HTMLButtonElement>("#project-clear")!;
  const send = form.querySelector<HTMLButtonElement>("#project-send")!;
  const cancel = form.querySelector<HTMLButtonElement>("#project-cancel")!;
  const files = form.querySelector<HTMLUListElement>("#project-files")!;
  const mode = form.querySelector<HTMLSelectElement>("#project-mode")!;
  const question = form.querySelector<HTMLTextAreaElement>("#project-question")!;
  const status = form.querySelector<HTMLElement>("#project-status")!;
  const answer = form.querySelector<HTMLElement>("#project-answer")!;
  const patch = form.querySelector<HTMLDetailsElement>("#project-patch")!;
  const diff = form.querySelector<HTMLElement>("#project-diff")!;
  const apply = form.querySelector<HTMLButtonElement>("#project-apply")!;
  const commands = document.querySelector<HTMLFormElement>("#project-command-form")!;
  const folderPick = commands.querySelector<HTMLButtonElement>("#project-folder-pick")!;
  const folder = commands.querySelector<HTMLElement>("#project-folder")!;
  const command = commands.querySelector<HTMLInputElement>("#project-command-text")!;
  const review = commands.querySelector<HTMLButtonElement>("#project-command-send")!;
  const stopCommand = commands.querySelector<HTMLButtonElement>("#project-command-stop")!;
  const commandStatus = commands.querySelector<HTMLElement>("#project-command-status")!;
  let commandFolder: string | null = null;
  const clearPatch = () => { patch.hidden = true; patch.open = false; diff.textContent = ""; };
  let ready = false;
  let busy: "picking" | "running" | "applying" | "command" | null = null;
  let revision = 0;
  const draw = () => {
    pick.disabled = !ready || !!busy;
    apply.disabled = !ready || !!busy;
    folderPick.disabled = !ready || !!busy;
    command.disabled = !ready || !!busy;
    review.disabled = !ready || !!busy || !commandFolder || !command.value.trim();
    stopCommand.hidden = busy !== "command";
    clear.disabled = !!busy || (!files.childElementCount && !question.value && answer.hidden && !commandFolder && !command.value);
    send.disabled = !ready || !!busy || !files.childElementCount || !question.value.trim();
    cancel.hidden = busy !== "running";
    folder.textContent = commandFolder ?? "No command folder selected.";
  };
  const names = (selected: string[]) => {
    files.replaceChildren(...selected.map(name => {
      const row = document.createElement("li");
      row.textContent = name;
      return row;
    }));
    files.hidden = !selected.length;
  };
  const reset = () => {
    revision++;
    busy = null;
    names([]);
    clearPatch();
    question.value = "";
    commandFolder = null;
    command.value = "";
    commandStatus.textContent = "";
    answer.textContent = "";
    answer.hidden = true;
    draw();
  };
  pick.addEventListener("click", async () => {
    const at = revision;
    busy = "picking";
    clearPatch();
    draw();
    try {
      const result = await window.ember.projectPick();
      if (at !== revision) return;
      names(result.names);
      status.textContent = result.error ?? (result.names.length ? "Review the selection before sending." : "Choose the files for this request.");
    } catch {
      if (at === revision) status.textContent = "Couldn't choose project files.";
    } finally {
      if (at === revision) { busy = null; draw(); }
    }
  });
  clear.addEventListener("click", () => {
    reset();
    status.textContent = "Project work cleared.";
    void window.ember.projectClear().catch(() => { status.textContent = "Couldn't clear the selection. Choose your files again."; });
  });
  folderPick.addEventListener("click", async () => {
    const at = revision;
    busy = "picking";
    draw();
    try {
      const result = await window.ember.projectChooseFolder();
      if (at !== revision) return;
      commandFolder = result.folder;
      commandStatus.textContent = result.message ?? "";
    } catch {
      if (at === revision) commandStatus.textContent = "Couldn't choose the command folder.";
    } finally {
      if (at === revision) { busy = null; draw(); }
    }
  });
  command.addEventListener("input", draw);
  stopCommand.addEventListener("click", () => {
    commandStatus.textContent = "Stopping project command…";
    void window.ember.projectCancel().catch(() => { commandStatus.textContent = "Use Stop everything to stop the command."; });
  });
  commands.addEventListener("submit", async event => {
    event.preventDefault();
    if (review.disabled) return;
    const at = revision;
    busy = "command";
    commandStatus.textContent = "Checking the project command…";
    draw();
    try {
      const message = await window.ember.projectRunCommand(command.value);
      if (at === revision) commandStatus.textContent = message;
    } catch {
      if (at === revision) commandStatus.textContent = "Couldn't run the project command.";
    } finally {
      if (at === revision) { busy = null; draw(); }
    }
  });
  question.addEventListener("input", draw);
  cancel.addEventListener("click", () => {
    status.textContent = "Cancelling project request…";
    void window.ember.projectCancel().catch(() => { status.textContent = "Couldn't cancel. Use Stop everything to try again."; });
  });
  apply.addEventListener("click", async () => {
    const at = revision;
    busy = "applying";
    draw();
    try {
      const result = await window.ember.projectApply();
      if (at !== revision) return;
      if (result.done) clearPatch();
      status.textContent = result.message;
    } catch {
      if (at === revision) status.textContent = "Couldn't apply the patch.";
    } finally {
      if (at === revision) { busy = null; draw(); if (patch.hidden) question.focus(); }
    }
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (send.disabled) return;
    const at = revision;
    busy = "running";
    clearPatch();
    answer.textContent = "";
    answer.hidden = true;
    status.textContent = "Working on the project request…";
    draw();
    try {
      const result = await window.ember.projectRun({ mode: mode.value as ProjectMode, question: question.value });
      if (at !== revision) return;
      if ("answer" in result) {
        answer.textContent = result.answer;
        answer.hidden = false;
        if (result.patch) {
          diff.textContent = result.patch.diff;
          apply.textContent = `Apply patch to ${result.patch.name}…`;
          patch.hidden = false;
        }
        status.textContent = result.patch ? "Patch ready to review." : mode.value === "patch" ? "Draft ready. Ember could not verify an exact patch to apply." : "Project answer ready.";
      } else status.textContent = result.error;
    } catch {
      if (at === revision) status.textContent = "Couldn't finish the project request.";
    } finally {
      if (at === revision) { busy = null; draw(); }
    }
  });
  return (on: boolean) => {
    if (ready === on) return;
    ready = on;
    if (!on) reset();
    status.textContent = on ? "Choose the files for this request." : "Connect a model to work with project files.";
    draw();
  };
}
