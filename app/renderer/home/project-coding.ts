/** Coding folders belong to a selected project. Reviewing or exporting a result never executes a task. */
import { CODING_REVIEW_PATCH_LIMIT, type CodingResultReview, type CodingResultSummary, type ProjectCodingWorkspaceState } from "../../shared/project-coding";
import { STATUS_WORDS } from "../../shared/activity";
import { ipcErrorText } from "./copy";

export function mountProjectCoding(): void {
  const root = document.getElementById("project-coding")!;
  const legacyWorkspace = document.getElementById("coding-workspace");
  if (legacyWorkspace) legacyWorkspace.hidden = true;
  const find = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#project-coding-${id}`)!;
  const folder = find<HTMLParagraphElement>("folder");
  const stateText = find<HTMLParagraphElement>("state");
  const choose = find<HTMLButtonElement>("choose");
  const forget = find<HTMLButtonElement>("forget");
  const status = find<HTMLParagraphElement>("status");
  const results = find<HTMLOListElement>("results");
  const review = find<HTMLElement>("review");
  const reviewTitle = find<HTMLHeadingElement>("review-title");
  const reviewSummary = find<HTMLParagraphElement>("review-summary");
  const reviewSource = find<HTMLParagraphElement>("review-source");
  const changes = find<HTMLUListElement>("changes");
  const limitations = find<HTMLUListElement>("limitations");
  const previewMessage = find<HTMLParagraphElement>("preview-message");
  const patch = find<HTMLPreElement>("patch");
  const exportReview = find<HTMLButtonElement>("export");
  const closeReview = find<HTMLButtonElement>("close");
  let projectId: string | null = null;
  let workspace: ProjectCodingWorkspaceState | null = null;
  let summaries: CodingResultSummary[] = [];
  let opened: CodingResultReview | null = null;
  let ready = false;
  let pending = false;
  let generation = 0;
  let readEpoch = 0;
  let initialEpoch = 0;
  let reviewEpoch = 0;
  let actionEpoch = 0;
  const forgotten = new Set<string>();
  let drawn = "";

  const plain = (tag: string, text: string, className = "") => {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
  };
  const counts = (result: CodingResultSummary) => `${result.files} changed ${result.files === 1 ? "file" : "files"} · ${result.conflicts} ${result.conflicts === 1 ? "conflict" : "conflicts"} · Checks: ${result.checks.ran} run, ${result.checks.passed} passed, ${result.checks.failed} failed`;
  const clearReview = () => { reviewEpoch++; opened = null; review.hidden = true; reviewTitle.textContent = ""; patch.textContent = ""; changes.replaceChildren(); limitations.replaceChildren(); reviewSummary.textContent = ""; reviewSource.textContent = ""; previewMessage.textContent = ""; };
  const current = (owner: number, id: string) => generation === owner && projectId === id;
  const controls = () => {
    choose.disabled = pending || !workspace?.canChoose;
    forget.disabled = pending || !workspace?.folder || !workspace.canChoose;
    exportReview.disabled = pending || !opened || opened.projectId !== projectId || !ready;
    for (const button of results.querySelectorAll<HTMLButtonElement>("button")) button.disabled = !ready || (pending && !button.dataset.forgetResult);
  };
  const render = () => {
    root.hidden = false;
    folder.textContent = !projectId ? "Create or select a project above to choose its coding folder." : workspace?.folder ? `${workspace.folder.label}: ${workspace.folder.path}${workspace.folder.valid ? "" : " (folder unavailable)"}` : "No coding folder selected for this project.";
    stateText.textContent = !projectId ? "Each project keeps its own folder choice and coding reviews." : !ready ? "Connect Ember to manage coding folders and review results." : workspace?.message || (workspace?.available ? "Coding work uses a private copy. Your original project stays unchanged." : "Coding work is currently unavailable. You can prepare a folder when Choose folder is available.");
    const signature = JSON.stringify(summaries);
    if (signature !== drawn) {
      drawn = signature;
      const focused = results.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement.dataset.resultControl : undefined;
      results.replaceChildren();
      if (!summaries.length) results.append(plain("li", projectId ? "No coding results for this project yet." : "Select a project to see its coding results.", "hint"));
      for (const result of summaries) {
        const item = document.createElement("li");
        item.append(plain("h4", result.title), plain("p", `${STATUS_WORDS[result.status]} · ${counts(result)}${result.patchComplete ? "" : " · Patch has limitations"}`, "hint"));
        item.append(plain("p", `From ${result.sourcePath}`, "hint"));
        if (result.message) item.append(plain("p", result.message));
        const button = document.createElement("button");
        button.type = "button"; button.className = "btn quiet small"; button.textContent = "Review result";
        button.setAttribute("aria-label", `Review result: ${result.title}`);
        button.dataset.resultControl = result.id;
        button.addEventListener("click", () => { if (!button.disabled) void openResult(result.id); });
        const discard = document.createElement("button");
        discard.type = "button"; discard.className = "btn quiet small"; discard.textContent = "Forget result";
        discard.setAttribute("aria-label", `Forget private result: ${result.title}`);
        discard.dataset.resultControl = `forget:${result.id}`; discard.dataset.forgetResult = result.id;
        discard.addEventListener("click", () => { if (!discard.disabled) void forgetResult(result.id); });
        const actions = document.createElement("div"); actions.className = "agent-actions"; actions.append(button, discard);
        item.append(actions); results.append(item);
      }
      if (focused) [...results.querySelectorAll<HTMLButtonElement>("[data-result-control]")].find(button => button.dataset.resultControl === focused)?.focus({ preventScroll: true });
    }
    controls();
  };
  const load = async () => {
    if (!projectId || !ready || pending) return;
    const id = projectId, owner = generation, ticket = ++readEpoch;
    const replies = await Promise.allSettled([window.ember.projectCodingWorkspaceState(id), window.ember.codingResultsState(id)]);
    if (!current(owner, id) || ticket !== readEpoch) return;
    if (replies[0].status === "fulfilled" && replies[0].value.projectId === id) workspace = replies[0].value;
    if (replies[1].status === "fulfilled") {
      summaries = replies[1].value.filter(result => result.projectId === id && !forgotten.has(result.id));
      if (opened && !summaries.some(result => result.id === opened!.id)) clearReview();
    }
    if (replies.some(reply => reply.status === "rejected")) status.textContent = "Couldn't refresh coding work. Reopen Projects to try again.";
    render();
  };
  const selectProject = (id: string | null) => {
    if (projectId === id) return;
    generation++; readEpoch++; initialEpoch++; actionEpoch++; forgotten.clear();
    projectId = id; workspace = null; summaries = []; pending = false; drawn = "";
    status.textContent = ""; clearReview(); render();
    void load();
  };
  const folderAction = async (kind: "choose" | "forget") => {
    if (!projectId || pending) return;
    const id = projectId, owner = generation, action = ++actionEpoch;
    status.textContent = kind === "choose" ? "Choose a coding folder in the folder picker." : "Forgetting this project's folder choice…";
    readEpoch++; pending = true; render();
    try {
      const next = kind === "choose" ? await window.ember.projectCodingWorkspaceChoose(id) : await window.ember.projectCodingWorkspaceForget(id);
      if (!current(owner, id) || action !== actionEpoch || next.projectId !== id) return;
      workspace = next; status.textContent = next.message;
    } catch (error) { if (current(owner, id) && action === actionEpoch) status.textContent = ipcErrorText(error); }
    finally { if (current(owner, id) && action === actionEpoch) { pending = false; render(); } }
  };
  const openResult = async (id: string) => {
    if (!projectId || pending || !ready) return;
    const project = projectId, owner = generation, focused = document.activeElement, ticket = ++reviewEpoch, action = ++actionEpoch;
    status.textContent = "Loading this coding review…";
    readEpoch++; pending = true; render();
    try {
      const result = await window.ember.codingResultReview(id);
      if (!current(owner, project) || action !== actionEpoch || ticket !== reviewEpoch || forgotten.has(id) || result.projectId !== project || result.id !== id) return;
      opened = result;
      reviewTitle.textContent = result.title;
      reviewSummary.textContent = `${STATUS_WORDS[result.status]} · ${counts(result)}`;
      reviewSource.textContent = `From ${result.sourcePath}`;
      changes.replaceChildren(...result.changes.slice(0, 200).map(change => {
        const item = document.createElement("li");
        item.append(plain("b", `${change.kind}: ${change.path}`));
        const reasons = [...change.conflicts, ...change.patchUnsupported];
        for (const reason of reasons.slice(0, 20)) item.append(plain("p", reason, "hint"));
        if (reasons.length > 20) item.append(plain("p", "More details are available in the exported review.", "hint"));
        return item;
      }));
      const notes = [...result.limitations];
      if (result.changes.length > 200) notes.unshift("The preview shows the first 200 changed paths. Export the review to keep the complete result.");
      if ((result.textPatch?.length ?? 0) > CODING_REVIEW_PATCH_LIMIT) notes.unshift("The patch preview is shortened. Export the review to keep the complete result.");
      limitations.replaceChildren(...notes.slice(0, 50).map(note => plain("li", note)));
      limitations.hidden = notes.length === 0;
      patch.textContent = result.textPatch?.slice(0, CODING_REVIEW_PATCH_LIMIT) ?? "";
      patch.hidden = !result.textPatch;
      previewMessage.textContent = result.previewMessage || (result.textPatch ? "Text patch preview. Export a review to keep this result." : "A text patch isn't available for this result. Review the changed paths and limitations.");
      review.hidden = false;
      status.textContent = "Review ready. Export it to keep a copy.";
      if (document.activeElement === focused && results.contains(focused)) reviewTitle.focus({ preventScroll: true });
    } catch (error) { if (current(owner, project) && action === actionEpoch) status.textContent = ipcErrorText(error); }
    finally { if (current(owner, project) && action === actionEpoch) { pending = false; render(); } }
  };
  const forgetResult = async (id: string) => {
    if (!projectId || !ready || forgotten.has(id) || !summaries.some(result => result.id === id)) return;
    const project = projectId, owner = generation, action = ++actionEpoch;
    const focused = document.activeElement instanceof HTMLElement && document.activeElement.dataset.forgetResult === id;
    readEpoch++; forgotten.add(id); summaries = summaries.filter(result => result.id !== id);
    if (opened?.id === id) clearReview();
    pending = true; status.textContent = "Forgetting this private coding review…"; render();
    if (focused) (results.querySelector<HTMLButtonElement>("[data-forget-result]") ?? root.querySelector<HTMLElement>("h3"))?.focus({ preventScroll: true });
    try {
      const reply = await window.ember.codingResultForget(id);
      if (current(owner, project) && action === actionEpoch) status.textContent = reply.message;
    } catch (error) { if (current(owner, project) && action === actionEpoch) status.textContent = ipcErrorText(error); }
    finally { if (current(owner, project) && action === actionEpoch) { pending = false; render(); void load(); } }
  };
  choose.addEventListener("click", () => { if (!choose.disabled) void folderAction("choose"); });
  forget.addEventListener("click", () => { if (!forget.disabled) void folderAction("forget"); });
  closeReview.addEventListener("click", () => {
    const id = opened?.id; clearReview(); controls();
    [...results.querySelectorAll<HTMLButtonElement>("[data-result-control]")].find(button => button.dataset.resultControl === id)?.focus({ preventScroll: true });
  });
  exportReview.addEventListener("click", () => {
    if (!opened || !projectId || exportReview.disabled) return;
    const id = opened.id, project = projectId, owner = generation, action = ++actionEpoch;
    status.textContent = "Choose a folder for the exported review.";
    pending = true; render();
    void window.ember.codingResultExport(id).then(reply => {
      if (current(owner, project) && action === actionEpoch && !forgotten.has(id)) status.textContent = reply.message;
    }).catch(error => { if (current(owner, project) && action === actionEpoch) status.textContent = ipcErrorText(error); }).finally(() => {
      if (current(owner, project) && action === actionEpoch) { pending = false; render(); }
    });
  });
  window.addEventListener("ember-project-changed", event => {
    const detail = (event as CustomEvent<{ projectId?: unknown }>).detail;
    if (detail && (detail.projectId === null || typeof detail.projectId === "string")) { initialEpoch++; selectProject(detail.projectId); }
  });
  window.ember.onConversationForgotten(() => { initialEpoch++; generation++; readEpoch++; actionEpoch++; forgotten.clear(); projectId = null; workspace = null; summaries = []; pending = false; drawn = ""; status.textContent = ""; clearReview(); render(); });
  let statusEpoch = 0;
  const agentState = (phase: string | undefined) => {
    const nextReady = phase === "ready";
    if (ready !== nextReady) { generation++; readEpoch++; actionEpoch++; forgotten.clear(); pending = false; clearReview(); workspace = null; summaries = []; }
    ready = nextReady; render(); void load();
  };
  window.ember.onAgentStatus(next => { statusEpoch++; agentState(next.phase); });
  const statusTicket = statusEpoch;
  void window.ember.agentStatus().then(next => { if (statusTicket === statusEpoch) agentState(next?.phase); }).catch(() => undefined);
  window.ember.onTasks(() => { void load(); });
  window.ember.onConversation(() => { void load(); });
  const initialTicket = initialEpoch;
  void window.ember.projectSessionsState().then(state => { if (initialTicket === initialEpoch) selectProject(state.selectedProjectId); }).catch(() => undefined);
  render();
}
