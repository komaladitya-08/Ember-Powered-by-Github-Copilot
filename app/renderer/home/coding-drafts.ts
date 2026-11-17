/** Explicit encrypted draft controls. Opened source/context stay inert until a fresh-folder import is reviewed. */
import { CODING_DRAFT_FILE_LIST_LIMIT, CODING_DRAFT_NAME_LIMIT, CODING_DRAFT_PREVIEW_LIMIT, type CodingDraftView, type CodingDraftsState } from "../../shared/coding-drafts";
import type { ProjectCodingWorkspaceState } from "../../shared/project-coding";
import { ipcErrorText } from "./copy";

export interface CodingDraftContext {
  projectId: string | null;
  generation: number;
  ready: boolean;
  pending: boolean;
  workspace: ProjectCodingWorkspaceState | null;
  result: { id: string; title: string } | null;
}
export interface CodingDraftControls {
  changed(): void;
}
export function codingDraftNameValid(value: string): boolean {
  return !!value.trim() && value.length <= CODING_DRAFT_NAME_LIMIT && !/[\p{Cc}\p{Cf}]/u.test(value);
}
export function codingDraftChecksLine(checks: { ran: number; passed: number; failed: number }): string {
  return `Historical checks: ${checks.ran} run, ${checks.passed} passed, ${checks.failed} failed. Run required checks again for a new request.`;
}

/** Main rechecks owner, consent, stored identity and the post-Open folder receipt for every operation. */
export function mountCodingDrafts(d: {
  context(): CodingDraftContext;
  workspaceChanged(state: ProjectCodingWorkspaceState): void;
  imported(id: string): Promise<void>;
}): CodingDraftControls {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(`coding-drafts-${id}`) as T;
  const saveShow = get<HTMLButtonElement>("save-show"), saveForm = get<HTMLFormElement>("save-form"), name = get<HTMLInputElement>("name");
  const save = get<HTMLButtonElement>("save"), saveCancel = get<HTMLButtonElement>("save-cancel");
  const refresh = get<HTMLButtonElement>("refresh"), forgetAll = get<HTMLButtonElement>("forget-all"), list = get<HTMLOListElement>("list");
  const stateText = get<HTMLParagraphElement>("state"), status = get<HTMLParagraphElement>("status"), view = get<HTMLElement>("view");
  const title = get<HTMLHeadingElement>("view-title"), metadata = get<HTMLParagraphElement>("metadata"), source = get<HTMLParagraphElement>("source");
  const request = get<HTMLPreElement>("request"), summary = get<HTMLPreElement>("summary"), files = get<HTMLUListElement>("files");
  const filesNote = get<HTMLParagraphElement>("files-note"), limitations = get<HTMLUListElement>("limitations"), preview = get<HTMLPreElement>("preview");
  const previewMessage = get<HTMLParagraphElement>("preview-message"), folder = get<HTMLButtonElement>("folder"), use = get<HTMLButtonElement>("import"), close = get<HTMLButtonElement>("close");
  let library: CodingDraftsState | null = null, opened: CodingDraftView | null = null;
  let epoch = 0, busy = false, forgetting = false, connectionPending = false, drawn = "", ownerKey = "", projectKey = "", resultId: string | null = null;
  let prepared: { id: string; project: string; path: string } | null = null;
  let origin: HTMLButtonElement | null = null;
  const current = (at: number) => epoch === at;
  const clearSave = () => { saveForm.hidden = true; name.value = ""; saveShow.setAttribute("aria-expanded", "false"); };
  const clearView = () => {
    opened = null; prepared = null; view.hidden = true; title.textContent = ""; metadata.textContent = ""; source.textContent = "";
    request.textContent = ""; summary.textContent = ""; files.replaceChildren(); filesNote.textContent = ""; limitations.replaceChildren(); preview.textContent = ""; previewMessage.textContent = "";
  };
  const acceptLibrary = (next: CodingDraftsState) => {
    library = next;
    if (opened && (!next.canOpen || !next.drafts.some(draft => draft.id === opened!.id))) clearView();
  };
  const plain = (tag: string, text: string) => { const element = document.createElement(tag); element.textContent = text; return element; };
  const render = () => {
    const context = d.context();
    refresh.disabled = busy || connectionPending;
    forgetAll.disabled = forgetting || connectionPending || library?.canForget !== true;
    saveShow.disabled = busy || connectionPending || context.pending || !context.ready || !context.result || library?.canSave === false;
    name.disabled = busy; saveCancel.disabled = busy;
    save.disabled = busy || connectionPending || context.pending || !context.ready || !context.result || library?.canSave !== true || !codingDraftNameValid(name.value);
    folder.disabled = busy || connectionPending || context.pending || !context.ready || !opened || !context.projectId || !context.workspace?.canChoose;
    use.disabled = busy || connectionPending || context.pending || !context.ready || !opened || !prepared || prepared.id !== opened.id || prepared.project !== context.projectId || !context.workspace?.folder?.valid || prepared.path !== context.workspace.folder.path;
    close.disabled = false;
    stateText.textContent = connectionPending ? "Wait for the model connection to finish changing before opening or saving drafts." : library?.message || "Refresh to see this account's saved drafts.";
    const signature = JSON.stringify(library?.drafts ?? []);
    if (signature !== drawn) {
      drawn = signature;
      const focused = list.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement.dataset.draftControl : undefined;
      list.replaceChildren();
      for (const draft of (library?.drafts ?? []).slice(0, 8)) {
        const item = document.createElement("li"), actions = document.createElement("div"); actions.className = "agent-actions";
        item.append(plain("h5", draft.name.slice(0, 80)), plain("p", new Date(draft.savedAt).toLocaleString()), plain("p", `Previous source label: ${draft.sourceLabel.slice(0, 4096)}`));
        for (const kind of ["open", "forget"] as const) {
          const button = document.createElement("button"); button.type = "button"; button.className = "btn quiet small"; button.textContent = kind === "open" ? "Open saved draft" : "Forget saved draft";
          button.setAttribute("aria-label", `${button.textContent}: ${draft.name}`); button.dataset.draftControl = `${kind}:${draft.id}`; button.dataset.draftKind = kind;
          button.addEventListener("click", () => { if (!button.disabled) void (kind === "open" ? open(draft.id, button) : forget(draft.id)); }); actions.append(button);
        }
        item.append(actions); list.append(item);
      }
      if (library && !library.drafts.length) list.append(plain("li", "No saved coding drafts for this account."));
      if (focused) [...list.querySelectorAll<HTMLButtonElement>("button")].find(button => button.dataset.draftControl === focused)?.focus({ preventScroll: true });
    }
    for (const button of list.querySelectorAll<HTMLButtonElement>("button")) button.disabled = connectionPending || (button.dataset.draftKind === "forget" ? forgetting || library?.canForget !== true : busy || library?.canOpen !== true);
  };
  const read = async (): Promise<boolean> => {
    if (busy || connectionPending) return false;
    const at = ++epoch; busy = true; status.textContent = "Refreshing saved drafts…"; render();
    try { const next = await window.ember.codingDraftsState(); if (!current(at)) return false; acceptLibrary(next); status.textContent = ""; return true; }
    catch { if (current(at)) status.textContent = "Couldn't refresh saved coding drafts. Try Refresh saved drafts."; return false; }
    finally { if (current(at)) { busy = false; render(); } }
  };
  const open = async (id: string, button: HTMLButtonElement) => {
    if (busy || connectionPending || !library?.canOpen) return;
    const at = ++epoch; clearSave(); clearView(); busy = true; status.textContent = "Opening saved draft for review…"; render();
    try {
      const next = await window.ember.codingDraftOpen(id); if (!current(at) || next.id !== id) return;
      opened = next; origin = button;
      title.textContent = next.name.slice(0, 80); metadata.textContent = `Saved ${new Date(next.savedAt).toLocaleString()}. ${codingDraftChecksLine(next.historicalChecks)}`;
      source.textContent = `Previous source label: ${next.sourceLabel.slice(0, 4096)}. This label does not identify or grant access to the original folder.`;
      request.textContent = next.context.request.slice(0, 2000) || "No previous request was saved.";
      summary.textContent = next.context.summary.slice(0, 2000) || "No previous summary was saved.";
      files.replaceChildren(...next.files.slice(0, CODING_DRAFT_FILE_LIST_LIMIT).map(file => plain("li", `${file.kind === "directory" ? "Folder" : "File"}: ${file.path.slice(0, 4096)}`)));
      filesNote.textContent = `Showing ${Math.min(next.files.length, CODING_DRAFT_FILE_LIST_LIMIT)} of ${next.filesTotal} captured entries. The saved draft retains the complete captured files.`;
      limitations.replaceChildren(...next.limitations.slice(0, 50).map(line => plain("li", line.slice(0, 4096))));
      preview.textContent = next.preview?.slice(0, CODING_DRAFT_PREVIEW_LIMIT) ?? ""; preview.hidden = !next.preview;
      previewMessage.textContent = next.previewMessage + ((next.preview?.length ?? 0) > CODING_DRAFT_PREVIEW_LIMIT ? " The patch preview is shortened." : "");
      view.hidden = false; status.textContent = "Saved draft opened for review. No work has started.";
      if (document.activeElement === button) title.focus({ preventScroll: true });
    } catch (error) { if (current(at)) status.textContent = ipcErrorText(error); }
    finally { if (current(at)) { busy = false; render(); } }
  };
  const forget = async (id?: string) => {
    if (forgetting || connectionPending || !library?.canForget) return;
    const at = ++epoch; busy = true; forgetting = true; clearSave(); if (!id || opened?.id === id) clearView();
    status.textContent = id ? "Forgetting saved draft…" : "Forgetting all saved drafts…"; render();
    try { const next = id ? await window.ember.codingDraftForget(id) : await window.ember.codingDraftForgetAll(); if (!current(at)) return; acceptLibrary(next); status.textContent = next.message; }
    catch (error) { if (current(at)) status.textContent = ipcErrorText(error); }
    finally { if (current(at)) { busy = false; forgetting = false; render(); } }
  };
  refresh.addEventListener("click", () => { void read(); });
  forgetAll.addEventListener("click", () => { if (!forgetAll.disabled) void forget(); });
  saveShow.addEventListener("click", () => {
    if (saveShow.disabled) return;
    const result = d.context().result;
    void (async () => {
      if (!library && !await read()) return;
      if (!library?.canSave || !result || d.context().result?.id !== result.id) return;
      saveForm.hidden = false; saveShow.setAttribute("aria-expanded", "true"); name.value = result.title.slice(0, CODING_DRAFT_NAME_LIMIT); render(); name.focus();
    })();
  });
  name.addEventListener("input", render);
  saveCancel.addEventListener("click", () => { clearSave(); render(); saveShow.focus({ preventScroll: true }); });
  saveForm.addEventListener("submit", event => {
    event.preventDefault(); const result = d.context().result;
    if (save.disabled || !result || !codingDraftNameValid(name.value)) return;
    const at = ++epoch, id = result.id, selectedName = name.value; busy = true; status.textContent = "Saving complete coding draft encrypted on this computer…"; render();
    void window.ember.codingDraftSave(id, selectedName).then(next => { if (current(at)) { acceptLibrary(next); clearSave(); status.textContent = next.message; } })
      .catch(error => { if (current(at)) status.textContent = ipcErrorText(error); }).finally(() => { if (current(at)) { busy = false; render(); } });
  });
  folder.addEventListener("click", () => {
    const project = d.context().projectId, id = opened?.id; if (folder.disabled || !project || !id) return;
    const at = ++epoch; prepared = null; busy = true; status.textContent = "Choose a folder for a new private import review."; render();
    void window.ember.codingDraftFolderChoose(id, project).then(reply => {
      if (!current(at) || d.context().projectId !== project || opened?.id !== id) return;
      if (reply.workspace?.projectId === project) d.workspaceChanged(reply.workspace);
      if (reply.ok && reply.workspace?.folder?.valid) prepared = { id, project, path: reply.workspace.folder.path };
      status.textContent = reply.message;
    }).catch(error => { if (current(at)) status.textContent = ipcErrorText(error); }).finally(() => { if (current(at)) { busy = false; render(); } });
  });
  use.addEventListener("click", () => {
    const project = d.context().projectId, id = opened?.id; if (use.disabled || !project || !id) return;
    const at = ++epoch; busy = true; status.textContent = "Preparing a new private import review…"; render();
    void window.ember.codingDraftImport(id, project).then(async reply => {
      if (!current(at) || d.context().projectId !== project || opened?.id !== id) return;
      status.textContent = reply.message; prepared = null;
      if (reply.ok && reply.resultId) await d.imported(reply.resultId);
    }).catch(error => { if (current(at)) status.textContent = ipcErrorText(error); }).finally(() => { if (current(at)) { busy = false; render(); } });
  });
  close.addEventListener("click", () => {
    // Closing this view must leave another draft's pending erasure able to settle its own controls.
    if (!forgetting) { epoch++; busy = false; status.textContent = ""; }
    clearView(); render(); if (origin?.isConnected) origin.focus({ preventScroll: true }); origin = null;
  });
  const retire = () => { epoch++; busy = false; forgetting = false; library = null; drawn = ""; clearSave(); clearView(); status.textContent = ""; list.replaceChildren(); render(); };
  window.ember.onConversationForgotten(retire);
  window.ember.onAgentStatus(next => {
    connectionPending = next.switchPending === true;
    const key = JSON.stringify([next.phase, next.login, next.service, next.conductorModel, next.workerModel, connectionPending]);
    if (!ownerKey || key !== ownerKey) retire(); ownerKey = key;
  });
  const changed = () => {
    const context = d.context(), next = JSON.stringify([context.projectId, context.generation]);
    if (projectKey && projectKey !== next) { epoch++; busy = false; forgetting = false; prepared = null; clearSave(); status.textContent = ""; }
    projectKey = next;
    if (resultId !== context.result?.id) { resultId = context.result?.id ?? null; clearSave(); }
    render();
  };
  changed(); return { changed };
}
