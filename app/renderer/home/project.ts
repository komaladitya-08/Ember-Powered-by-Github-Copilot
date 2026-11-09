/** Project selection, explicit context sharing and inert, reviewable output in the Projects destination. */
import { renderProjectAnswer } from "./project-output";
import { PROJECT_COMMANDS_MANAGED, PROJECT_COMMANDS_OFF, PROJECT_COMMANDS_OPEN, projectAnswerText, projectBytes, projectCommandsState, projectConnectionText, projectSelectionText } from "./project-copy";
import type { ProjectMode, ProjectWorkspaceAction } from "../../shared/ipc";

export function mountProject() {
  const provider = document.querySelector<HTMLElement>("#project-provider")!;
  let providerText = "";
  const form = document.querySelector<HTMLFormElement>("#project-form")!;
  const pick = form.querySelector<HTMLButtonElement>("#project-pick")!;
  const clear = form.querySelector<HTMLButtonElement>("#project-clear")!;
  const send = form.querySelector<HTMLButtonElement>("#project-send")!;
  const cancel = form.querySelector<HTMLButtonElement>("#project-cancel")!;
  const files = form.querySelector<HTMLUListElement>("#project-files")!;
  const selection = form.querySelector<HTMLElement>("#project-selection")!;
  const running = form.querySelector<HTMLElement>("#project-running")!;
  const outputStatus = form.querySelector<HTMLElement>("#project-output-status")!;
  const outputActions = form.querySelector<HTMLElement>("#project-answer-actions")!;
  const copyAnswer = form.querySelector<HTMLButtonElement>("#project-copy-answer")!;
  const copyDiff = form.querySelector<HTMLButtonElement>("#project-copy-diff")!;
  const exportAnswer = form.querySelector<HTMLButtonElement>("#project-export-answer")!;
  const exportDiff = form.querySelector<HTMLButtonElement>("#project-export-diff")!;
  const exportHint = form.querySelector<HTMLElement>("#project-export-hint")!;
  const patchSummary = form.querySelector<HTMLElement>("#project-patch-summary")!;
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
  const commandsOff = commands.querySelector<HTMLElement>("#project-commands-off")!;
  const offText = commandsOff.querySelector<HTMLElement>("#project-commands-off-text")!;
  const openCommands = commands.querySelector<HTMLButtonElement>("#project-commands-open")!;
  /** Commands may run on this computer (null: not known yet). Off, the form says so before anything is typed (integrations-12). */
  let localCommands: "on" | "off" | "managed" | null = null;
  /** The organisation's commands mode here (Status.admin.commands.local), known from the status. */
  let adminCommands: "off" | "ask" | "on" | undefined;
  const workspaces = document.querySelector<HTMLDetailsElement>("#project-workspaces")!;
  const saved = workspaces.querySelector<HTMLSelectElement>("#project-workspace-list")!;
  const workspaceName = workspaces.querySelector<HTMLInputElement>("#project-workspace-name")!;
  const saveWorkspace = workspaces.querySelector<HTMLButtonElement>("#project-workspace-save")!;
  const openWorkspace = workspaces.querySelector<HTMLButtonElement>("#project-workspace-open")!;
  const forgetWorkspace = workspaces.querySelector<HTMLButtonElement>("#project-workspace-forget")!;
  const workspaceStatus = workspaces.querySelector<HTMLElement>("#project-workspace-status")!;
  const previousControl = form.querySelector<HTMLElement>("#project-previous-control")!;
  const includePrevious = form.querySelector<HTMLInputElement>("#project-include-previous")!;
  const previousQuestion = form.querySelector<HTMLElement>("#project-previous-question")!;
  let commandFolder: string | null = null;
  let patchCurrent = false;
  let selectedNames: string[] = [];
  let shownAnswer = "";
  const clearPatch = () => { patch.hidden = true; patch.open = false; diff.textContent = ""; patchCurrent = false; };
  const invalidatePatch = () => {
    patchCurrent = false;
    patchSummary.textContent = "Previous diff (read-only)";
  };
  let ready = false;
  let busy: "picking" | "running" | "applying" | "command" | "workspace" | "export" | null = null;
  let revision = 0;
  /**
   * A request's failure as the status line shows it, and when: Ember going off Ready because of it (main's check of the
   * provider, which answers within its 10 s test) never hides why (integrations-r2-5).
   */
  let failedLine = "";
  let failedAt = 0;
  const draw = () => {
    pick.disabled = !ready || !!busy;
    // Applying the reviewed patch, exporting and a file's Remove work on what is kept here and send nothing: they don't
    // wait for a connection (integrations-r3-2).
    apply.disabled = !!busy || !patchCurrent;
    apply.hidden = !patchCurrent;
    exportAnswer.disabled = exportDiff.disabled = !!busy;
    for (const button of files.querySelectorAll<HTMLButtonElement>("button")) button.disabled = !!busy;
    form.setAttribute("aria-busy", String(busy === "running"));
    send.textContent = busy === "running" ? "Working…" : "Send selected files";
    const off = localCommands === "off" || localCommands === "managed";
    commandsOff.hidden = !off;
    offText.textContent = localCommands === "managed" ? PROJECT_COMMANDS_MANAGED : PROJECT_COMMANDS_OFF;
    // The Commands pane is there only with the targets runtime: no link to a pane that isn't, nor to a switch the
    // organisation holds off.
    openCommands.hidden = localCommands !== "off" || !!document.getElementById("jump-commands")?.hidden;
    // The folder can still be chosen (a saved workspace keeps it); the command waits for commands to be on.
    folderPick.disabled = !ready || !!busy;
    command.disabled = !ready || !!busy || off;
    review.disabled = !ready || !!busy || off || !commandFolder || !command.value.trim();
    stopCommand.hidden = busy !== "command";
    workspaceName.disabled = !ready || !!busy;
    saved.disabled = !ready || !!busy || !saved.options.length;
    saveWorkspace.disabled = !ready || !!busy || !workspaceName.value.trim() || (!files.childElementCount && !commandFolder);
    openWorkspace.disabled = forgetWorkspace.disabled = saved.disabled;
    includePrevious.disabled = !!busy || !ready;
    clear.disabled = !!busy || (!files.childElementCount && !question.value && answer.hidden && !commandFolder && !command.value);
    send.disabled = !ready || !!busy || !files.childElementCount || !question.value.trim();
    cancel.hidden = busy !== "running";
    folder.textContent = commandFolder ?? "No command folder selected.";
  };
  const names = (selected: string[], sizes?: (number | null)[]) => {
    selectedNames = [...selected];
    files.replaceChildren(...selected.map((name, index) => {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = name;
      const size = sizes?.[index];
      if (size !== null && size !== undefined) label.textContent += ` · ${projectBytes(size)}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn quiet small remove";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${name}`);
      remove.addEventListener("click", () => void removeFile(name));
      row.append(label, remove);
      return row;
    }));
    selection.textContent = projectSelectionText(selected, sizes);
    selection.hidden = files.hidden = !selected.length;
  };
  const showPrevious = (previous: { question: string; answer: string } | null, canContinue = false) => {
    previousQuestion.textContent = previous ? "Previous request: " + previous.question : "";
    previousQuestion.hidden = !previous;
    shownAnswer = previous?.answer ?? "";
    renderProjectAnswer(answer, shownAnswer, text => void copyText(text, "Project code copied."));
    answer.hidden = outputActions.hidden = exportHint.hidden = !previous;
    previousControl.hidden = !canContinue;
    if (!canContinue) includePrevious.checked = false;
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
    running.hidden = true;
    running.textContent = outputStatus.textContent = "";
    showPrevious(null);
    draw();
  };
  pick.addEventListener("click", async () => {
    const at = revision;
    busy = "picking";
    draw();
    try {
      const result = await window.ember.projectPick();
      if (at !== revision) return;
      names(result.names, result.sizes);
      if (result.changed) { clearPatch(); showPrevious(null); }
      status.textContent = result.error ?? (result.names.length ? "Review the selection before sending." : "Choose the files for this request.");
    } catch {
      if (at === revision) status.textContent = "Couldn't choose project files.";
    } finally {
      if (at === revision) { busy = null; draw(); }
    }
  });
  async function removeFile(name: string): Promise<void> {
    if (busy) return;
    const at = revision;
    busy = "picking";
    let focusAfter: (() => HTMLElement) | null = null;
    draw();
    try {
      const result = await window.ember.projectRemove(name);
      if (at !== revision) return;
      names(result.names, result.sizes);
      if (result.changed) {
        invalidatePatch();
        previousControl.hidden = true;
        includePrevious.checked = false;
      }
      status.textContent = result.error ?? `Removed ${name}. Your request is kept.`;
      // Chosen once drawn: Choose files… waits for a connection, so with the last file gone while not connected the
      // request takes the focus, as after Apply patch (integrations-v4-4, WCAG 2.4.3).
      if (result.changed) focusAfter = () => files.querySelector<HTMLButtonElement>("button") ?? (pick.disabled ? question : pick);
    } catch {
      if (at === revision) status.textContent = "Couldn't remove the file. Your selection is kept.";
    } finally {
      if (at === revision) { busy = null; draw(); focusAfter?.().focus(); }
    }
  }
  async function copyText(text: string, message: string): Promise<void> {
    const at = revision;
    try {
      await window.ember.copyText(text);
      if (at === revision) outputStatus.textContent = message;
    } catch {
      if (at === revision) outputStatus.textContent = "Couldn't copy. Select the output and copy it with your keyboard.";
    }
  }
  const exportOutput = async (kind: "answer" | "diff") => {
    if (busy) return;
    const at = revision;
    busy = "export";
    draw();
    try {
      const result = await window.ember.projectExport(kind);
      if (at === revision) outputStatus.textContent = result.message;
    } catch {
      if (at === revision) outputStatus.textContent = "Couldn't export the project output.";
    } finally {
      if (at === revision) { busy = null; draw(); }
    }
  };
  copyAnswer.addEventListener("click", () => void copyText(shownAnswer, "Project answer copied."));
  copyDiff.addEventListener("click", () => void copyText(diff.textContent ?? "", "Project diff copied."));
  exportAnswer.addEventListener("click", () => void exportOutput("answer"));
  exportDiff.addEventListener("click", () => void exportOutput("diff"));
  clear.addEventListener("click", () => {
    reset();
    status.textContent = "Project work cleared.";
    void window.ember.projectClear().catch(() => { status.textContent = "Couldn't clear the selection. Choose your files again."; });
  });
  // The commands setting as it is now, and as it changes (in Commands, by voice or in the file).
  const followCommands = (s: Parameters<typeof projectCommandsState>[0]) => { localCommands = projectCommandsState(s, adminCommands); draw(); };
  void window.ember.getStatus().then(st => { adminCommands = st.admin.commands?.local; followCommands(st.settings); }, () => { /* not known: the form stays as it was */ });
  window.ember.onSettingsChanged(followCommands);
  openCommands.textContent = PROJECT_COMMANDS_OPEN;
  openCommands.addEventListener("click", () => document.getElementById("jump-commands")?.click());
  // The Commands pane's link shows once the targets runtime has answered: Open Commands follows it.
  const commandsLink = document.getElementById("jump-commands");
  if (commandsLink) new MutationObserver(() => draw()).observe(commandsLink, { attributes: true, attributeFilter: ["hidden"] });
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
  const workspaceAction = async (input: ProjectWorkspaceAction) => {
    if (!ready || busy) return;
    const at = revision;
    const previousName = saved.value;
    busy = "workspace";
    workspaceStatus.textContent = "Checking saved workspaces…";
    draw();
    try {
      const result = await window.ember.projectWorkspace(input);
      if (at !== revision) return;
      if (result.names) {
        saved.replaceChildren(...result.names.map(name => {
          const option = document.createElement("option");
          option.value = option.textContent = name;
          return option;
        }));
        const selected = input.action === "list" ? previousName : input.name;
        if (result.names.includes(selected)) saved.value = selected;
      }
      if (result.opened && input.action === "open") {
        clearPatch();
        names(result.opened.files, result.opened.sizes);
        workspaceName.value = input.name;
        commandFolder = result.opened.folder;
        command.value = "";
        commandStatus.textContent = "";
        question.value = "";
        mode.value = result.opened.previous?.mode ?? "review";
        showPrevious(result.opened.previous, !!result.opened.previous);
        includePrevious.checked = !!result.opened.previous;
        status.textContent = "Review the restored files and enter your next request.";
        form.scrollIntoView({ block: "nearest" });
        question.focus();
      }
      workspaceStatus.textContent = result.message ?? (saved.options.length ? "" : "No saved workspaces.");
    } catch {
      if (at === revision) workspaceStatus.textContent = "Couldn't open saved workspaces.";
    } finally {
      if (at === revision) { busy = null; draw(); }
    }
  };
  workspaces.addEventListener("toggle", () => { if (workspaces.open) void workspaceAction({ action: "list" }); });
  workspaceName.addEventListener("input", draw);
  saveWorkspace.addEventListener("click", () => void workspaceAction({ action: "save", name: workspaceName.value }));
  openWorkspace.addEventListener("click", () => void workspaceAction({ action: "open", name: saved.value }));
  forgetWorkspace.addEventListener("click", () => void workspaceAction({ action: "forget", name: saved.value }));
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
      if (result.done) { invalidatePatch(); patchSummary.textContent = "Applied diff"; }
      status.textContent = result.message;
    } catch {
      if (at === revision) status.textContent = "Couldn't apply the patch.";
    } finally {
      if (at === revision) { busy = null; draw(); if (!patchCurrent) question.focus(); }
    }
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (send.disabled) return;
    const at = revision;
    busy = "running";
    invalidatePatch();
    const sent = { mode: mode.value as ProjectMode, question: question.value, includePrevious: includePrevious.checked };
    running.textContent = `${mode.selectedOptions[0]?.textContent ?? "Project request"} · ${selectedNames.join(", ")}\nRequest: ${sent.question}\nSent to ${providerText}.${sent.includePrevious ? "\nIncludes the previous request and answer." : "\nPrevious request and answer are not included."}`;
    running.hidden = false;
    outputStatus.textContent = "";
    status.textContent = "Working on the request shown below. Edits apply to your next send.";
    draw();
    try {
      const result = await window.ember.projectRun(sent);
      if (at !== revision) return;
      if ("answer" in result) {
        clearPatch();
        showPrevious({ question: sent.question, answer: result.answer }, result.canContinue);
        if (result.patch) {
          diff.textContent = result.patch.diff;
          apply.textContent = `Apply patch to ${result.patch.name}…`;
          patch.hidden = false;
          patchCurrent = true;
          patchSummary.textContent = "Review changes before applying";
        }
        status.textContent = projectAnswerText({ mode: sent.mode, patch: !!result.patch, withheld: result.withheld ?? null, canContinue: result.canContinue });
      } else {
        status.textContent = failedLine = result.error + (answer.hidden ? "" : " Previous output is still shown; its diff cannot be applied.");
        failedAt = Date.now();
      }
    } catch {
      if (at === revision) status.textContent = "Couldn't finish the project request." + (answer.hidden ? "" : " Previous output is still shown; its diff cannot be applied.");
    } finally {
      if (at === revision) { busy = null; running.hidden = true; draw(); }
    }
  });
  /** What the person chose and wrote here: it stays while Ember reconnects (integrations-r1). */
  const kept = () => ({
    files: files.childElementCount > 0,
    work: files.childElementCount > 0 || !!question.value || !answer.hidden || !!commandFolder || !!command.value,
  });
  // Main forgot this work: all of it (sign-out, another account, the organisation's lockdown), or only the previous
  // request and answer as context, once another model service or account is in force (they stay in view).
  window.ember.onProjectForgot(what => {
    if (what === "all") {
      reset();
      workspaceName.value = "";
      status.textContent = projectConnectionText(ready, kept());
    } else {
      previousControl.hidden = true;
      includePrevious.checked = false;
      draw();
    }
  });
  return (on: boolean, service = "GitHub Copilot", model: string | null = null) => {
    providerText = `${service}${model ? ` · ${model}` : ""}`;
    provider.textContent = on ? `Next send uses ${providerText}.` : "Connect a model in Models & connections.";
    if (ready === on) return;
    ready = on;
    // Not connected (a reconnect, a service out of reach for now): sending waits, and nothing chosen or written goes.
    // Saved workspaces are listed again when opened: another service or account has its own.
    if (!on) {
      workspaces.open = false;
      saved.replaceChildren();
      workspaceStatus.textContent = "";
    }
    // A failed request's own reason (a model server that isn't running) stays: main's check of it is what took Ember
    // off Ready (integrations-r2-5). Anything else says only that sending waits.
    const why = !on && failedLine && status.textContent === failedLine && Date.now() - failedAt < 15_000;
    if (!why) status.textContent = projectConnectionText(on, kept());
    failedLine = "";
    draw();
  };
}
