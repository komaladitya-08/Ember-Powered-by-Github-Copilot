/** Home-only coding folder/review IPC. Main supplies its sender guard and native folder picker. */
import { z } from "zod";
import { IPC } from "../shared/ipc";
import { parseTargetId } from "../shared/targets";
import type { ProjectSessionsState } from "../shared/project-sessions";
import type { CodingResultReview, CodingResultSummary, ProjectCodingExecutionState, ProjectCodingWorkspaceState } from "../shared/project-coding";
import type { CodingWorkspace } from "./agent/coding-workspace";
import type { ProjectCodingWorkspaces } from "./agent/project-coding-workspaces";
import { CodingResultRegistryError, type CodingResultRegistry } from "./agent/coding-result-registry";

export interface ProjectCodingIpcDeps {
  /** Main wraps each handler in its existing Home sender guard. No event or renderer destination is accepted here. */
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
  projects(): ProjectSessionsState;
  folders: ProjectCodingWorkspaces;
  results(): Promise<Pick<CodingResultRegistry, "state" | "review" | "export" | "reset" | "forgetProject" | "forgetResult">>;
  canUse(): boolean;
  availability(projectId?: string): { available: boolean; message: string; canContinue?: boolean };
  executionState?(projectId: string): ProjectCodingExecutionState | undefined;
  /** Synchronous metadata choice only; it does not install, start or approve commands. */
  chooseExecution?(projectId: string, targetId: string): void;
  /** Explicit Home selection only; may read the user of a running distro under the captured current context. */
  prepareExecution?(projectId: string, targetId: string, current: () => boolean): Promise<void>;
  /** Explicit project intent; no dependency set is approved or fetched by this metadata action. */
  choosePublicDependencies?(projectId: string, enabled: boolean): void;
  /** Calls the host's synchronous intake capture, then returns its ordinary conversation submission. */
  continueResult?(id: string, projectId: string, request: string): Promise<boolean>;
  chooseFolder(title: string): Promise<string | null>;
  validateFolder(path: string): CodingWorkspace | Promise<CodingWorkspace>;
  /** Synchronous host cancellation after a folder capability changes; undefined invalidates every project. */
  folderChanged?(projectId?: string): void;
  changed(): void;
  resultForgotten?(id: string): void;
  projectForgotten?(projectId?: string): void;
}

export interface ProjectCodingIpc {
  /** Existing guarded picker, reused only by another trusted Home action. */
  chooseFolder(projectId: string): Promise<ProjectCodingWorkspaceState>;
  /** Invalidates pending chooser/review/export replies synchronously, before private cleanup is awaited. */
  reset(): Promise<void>;
  /** Retires only this project's folder capability and review records. */
  forgetProject(projectId: string): Promise<void>;
}

const idSchema = z.string().max(36).uuid();
const argsSchema = z.tuple([idSchema]);
const executionArgsSchema = z.tuple([idSchema, z.string().min(1).max(68).refine(value => {
  const parsed = parseTargetId(value); return parsed?.kind === "local" || parsed?.kind === "wsl";
})]);
const publicDependenciesArgsSchema = z.tuple([idSchema, z.boolean()]);
const continuationArgsSchema = z.tuple([idSchema, idSchema, z.string().min(1).max(2000).refine(value => !!value.trim())]);
const UNAVAILABLE = "Connect Ember and open Projects to use coding work.";
const STALE = "The account, project or folder choice changed. Try again.";
const BUSY = "Stop this project's coding sessions before changing its folder.";
const PICKING = "Finish this project's folder picker before choosing another.";
const RESULT_GONE = "This coding result is no longer available for the current account and project.";
const idFrom = (args: unknown[]): string => {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) throw new Error("Choose an existing project or coding result.");
  return parsed.data[0];
};
const safe = (check: () => boolean): boolean => { try { return check() === true; } catch { return false; } };

export function registerProjectCodingIpc(d: ProjectCodingIpcDeps): ProjectCodingIpc {
  let epoch = 0;
  let registrySeen = false;
  const revisions = new Map<string, number>();
  const pickers = new Map<string, object>();
  const usable = () => safe(() => d.canUse());
  const project = (id: string) => { try { return d.projects().projects.find(value => value.id === id); } catch { return undefined; } };
  const liveCoding = (id: string) => !!project(id)?.sessions.some(session => session.kind === "coding" && ["queued", "running", "waiting"].includes(session.status));
  const changed = () => { try { d.changed(); } catch { /* The host record is authoritative if the renderer closed. */ } };
  const registryForUse = async () => { const registry = await d.results(); registrySeen = true; return registry; };
  const absentBackend = (error: unknown) => !registrySeen && error instanceof CodingResultRegistryError && error.code === "unsupported";
  const capability = (id?: string) => {
    const at = epoch, revision = id ? revisions.get(id) ?? 0 : null, ownerCurrent = d.folders.ownerCurrent(id);
    return () => at === epoch && usable() && safe(ownerCurrent) && (id === undefined || (!!project(id) && (revisions.get(id) ?? 0) === revision));
  };
  const assertCurrent = (current: () => boolean) => { if (!safe(current)) throw new Error(STALE); };
  const projectCapabilities = () => {
    const captured = new Map<string, () => boolean>();
    try { for (const candidate of d.projects().projects) captured.set(candidate.id, capability(candidate.id)); } catch { /* No unverifiable project is offered. */ }
    return captured;
  };
  const requireProject = (id: string) => { if (!usable() || !project(id) || !safe(d.folders.ownerCurrent(id))) throw new Error(UNAVAILABLE); };
  const workspaceState = (id: string): ProjectCodingWorkspaceState => {
    const allowed = usable() && !!project(id) && safe(d.folders.ownerCurrent(id));
    if (!allowed) return { projectId: id, folder: null, available: false, canChoose: false, message: UNAVAILABLE };
    let availability: { available: boolean; message: string; canContinue?: boolean };
    try { availability = d.availability(id); } catch { availability = { available: false, message: "Coding work is unavailable on this computer." }; }
    const folder = d.folders.state(id), busy = liveCoding(id), picking = pickers.has(id);
    let execution: ProjectCodingExecutionState | undefined;
    try { const state = d.executionState?.(id); if (state) execution = { ...state, canSelect: !!d.chooseExecution && state.canSelect && !busy && !picking,
      ...(state.publicDependencies ? { publicDependencies: { ...state.publicDependencies, canChange: !!d.choosePublicDependencies && state.publicDependencies.canChange && !busy && !picking } } : {}) }; } catch { /* A missing capability offers no choice. */ }
    return {
      projectId: id, folder, available: availability.available,
      ...(typeof availability.canContinue === "boolean" ? { canContinue: availability.canContinue } : {}),
      canChoose: !busy && !picking,
      ...(execution ? { execution } : {}),
      message: busy ? BUSY : picking ? "Finish the folder picker for this project." : availability.message || (availability.available ? "Coding work uses a private copy. The original folder is unchanged." : "Coding work is unavailable on this computer."),
    };
  };
  const requireFolderChange = (id: string) => {
    requireProject(id);
    if (liveCoding(id)) throw new Error(BUSY);
    if (pickers.has(id)) throw new Error(PICKING);
  };
  const locate = (registry: Awaited<ReturnType<ProjectCodingIpcDeps["results"]>>, id: string): CodingResultSummary | null => {
    try {
      for (const candidate of d.projects().projects) {
        const found = registry.state(candidate.id).find(result => result.id === id && result.projectId === candidate.id);
        if (found) return found;
      }
    } catch { /* Missing or unverifiable records expose no metadata. */ }
    return null;
  };

  d.handle(IPC.projectCodingWorkspaceState, (...args): ProjectCodingWorkspaceState => workspaceState(idFrom(args)));
  const chooseFolder = async (id: string): Promise<ProjectCodingWorkspaceState> => {
    if (!idSchema.safeParse(id).success) throw new Error("Choose an existing project.");
    requireFolderChange(id);
    const current = capability(id), owner = capability(), token = {};
    pickers.set(id, token); changed();
    const mayBind = () => safe(current) && pickers.get(id) === token && !liveCoding(id);
    try {
      const selected = await d.chooseFolder("Choose a coding folder");
      assertCurrent(mayBind);
      if (selected !== null) {
        const folder = await d.validateFolder(selected);
        assertCurrent(mayBind);
        d.folders.bind(id, folder, mayBind);
        // bind intentionally advances the project's revision. Follow only this newly bound capability from here.
        const bound = d.folders.ownerCurrent(id);
        d.folderChanged?.(id);
        assertCurrent(() => safe(owner) && safe(bound) && !liveCoding(id));
      }
      if (pickers.get(id) === token) pickers.delete(id);
      changed();
      assertCurrent(() => safe(owner) && !!project(id));
      return workspaceState(id);
    } catch {
      if (!safe(owner) || !project(id) || !safe(current)) throw new Error(STALE);
      if (liveCoding(id)) throw new Error(BUSY);
      throw new Error("Couldn't choose that coding folder. Choose an ordinary local folder and try again.");
    } finally {
      if (pickers.get(id) === token) { pickers.delete(id); changed(); }
    }
  };
  d.handle(IPC.projectCodingWorkspaceChoose, (...args) => chooseFolder(idFrom(args)));
  d.handle(IPC.projectCodingWorkspaceForget, (...args): ProjectCodingWorkspaceState => {
    const id = idFrom(args); requireFolderChange(id);
    d.folders.clear(id); d.folderChanged?.(id); changed();
    return workspaceState(id);
  });
  d.handle(IPC.projectCodingExecutionChoose, async (...args): Promise<ProjectCodingWorkspaceState> => {
    const parsed = executionArgsSchema.safeParse(args);
    if (!parsed.success) throw new Error("Choose a command environment listed for this project.");
    const [id, targetId] = parsed.data; requireFolderChange(id);
    const current = capability(id), owner = capability();
    let selectionCurrent = current;
    try {
      const execution = d.executionState?.(id);
      assertCurrent(current);
      requireFolderChange(id);
      if (!d.chooseExecution || !execution?.canSelect || !execution.choices.some(choice => choice.id === targetId && choice.selectable)) throw new Error("unavailable");
      d.chooseExecution(id, targetId);
      assertCurrent(() => safe(current) && !liveCoding(id) && !pickers.has(id));
      revisions.set(id, (revisions.get(id) ?? 0) + 1);
      selectionCurrent = capability(id);
      d.folderChanged?.(id); changed();
      const preparedCurrent = () => safe(owner) && safe(selectionCurrent) && !liveCoding(id) && !pickers.has(id) && d.executionState?.(id)?.selected === targetId;
      assertCurrent(preparedCurrent);
      if (d.prepareExecution) await d.prepareExecution(id, targetId, preparedCurrent);
      assertCurrent(preparedCurrent);
      return workspaceState(id);
    } catch {
      if (!safe(owner) || !safe(selectionCurrent)) throw new Error(STALE);
      throw new Error("Couldn't change the command environment. Refresh Projects and choose an available option.");
    }
  });
  d.handle(IPC.projectCodingPublicDependenciesChoose, (...args): ProjectCodingWorkspaceState => {
    const parsed = publicDependenciesArgsSchema.safeParse(args);
    if (!parsed.success) throw new Error("Choose this project's public dependency setting.");
    const [id, enabled] = parsed.data; requireFolderChange(id);
    const current = capability(id), owner = capability(); let selectionCurrent = current;
    try {
      const state = d.executionState?.(id);
      assertCurrent(current); requireFolderChange(id);
      if (!d.choosePublicDependencies || !state?.publicDependencies?.canChange) throw new Error("unavailable");
      d.choosePublicDependencies(id, enabled);
      assertCurrent(() => safe(current) && !liveCoding(id) && !pickers.has(id));
      revisions.set(id, (revisions.get(id) ?? 0) + 1); selectionCurrent = capability(id);
      d.folderChanged?.(id); changed();
      assertCurrent(() => safe(owner) && safe(selectionCurrent) && !liveCoding(id) && !pickers.has(id));
      return workspaceState(id);
    } catch {
      if (!safe(owner) || !safe(selectionCurrent)) throw new Error(STALE);
      throw new Error("Couldn't change public dependency downloads. Refresh Projects and choose again.");
    }
  });
  d.handle(IPC.codingResultsState, async (...args): Promise<CodingResultSummary[]> => {
    const id = idFrom(args);
    if (!usable() || !project(id)) return [];
    const current = capability(id);
    if (!safe(current)) return [];
    try {
      const registry = await registryForUse();
      if (!safe(current)) return [];
      const results = registry.state(id).filter(result => result.projectId === id);
      return safe(current) ? results : [];
    } catch { return []; }
  });
  d.handle(IPC.codingResultReview, async (...args): Promise<CodingResultReview> => {
    const id = idFrom(args), owner = capability();
    if (!safe(owner)) throw new Error(UNAVAILABLE);
    const projects = projectCapabilities();
    try {
      const registry = await registryForUse(); assertCurrent(owner);
      const found = locate(registry, id);
      if (!found) throw new Error(RESULT_GONE);
      const current = projects.get(found.projectId) ?? (() => false);
      assertCurrent(current);
      const review = await registry.review(id);
      assertCurrent(() => safe(owner) && safe(current));
      if (!review || review.id !== id || review.projectId !== found.projectId || !locate(registry, id)) throw new Error(RESULT_GONE);
      return review;
    } catch { throw new Error(RESULT_GONE); }
  });
  d.handle(IPC.codingResultExport, async (...args): Promise<{ ok: boolean; message: string }> => {
    const id = idFrom(args), owner = capability();
    if (!safe(owner)) return { ok: false, message: UNAVAILABLE };
    const projects = projectCapabilities();
    let projectId: string | undefined, token: object | undefined;
    try {
      const registry = await registryForUse(); assertCurrent(owner);
      const found = locate(registry, id);
      if (!found) return { ok: false, message: RESULT_GONE };
      projectId = found.projectId;
      if (pickers.has(projectId)) return { ok: false, message: PICKING };
      const current = projects.get(projectId) ?? (() => false);
      assertCurrent(current);
      token = {}; pickers.set(projectId, token); changed();
      const scope = () => safe(owner) && safe(current) && pickers.get(projectId!) === token && !!locate(registry, id);
      const destination = await d.chooseFolder("Export coding review");
      assertCurrent(scope);
      if (destination === null) return { ok: false, message: "Coding review export cancelled." };
      const reply = await registry.export(id, destination, scope);
      assertCurrent(scope);
      return { ok: reply.ok, message: reply.message };
    } catch {
      return { ok: false, message: safe(owner) ? "Couldn't export this coding review. Choose another ordinary local folder and try again." : STALE };
    } finally {
      if (projectId && token && pickers.get(projectId) === token) { pickers.delete(projectId); changed(); }
    }
  });
  d.handle(IPC.codingResultForget, async (...args): Promise<{ ok: boolean; message: string }> => {
    const id = idFrom(args), owner = capability();
    if (!safe(owner)) return { ok: false, message: UNAVAILABLE };
    d.resultForgotten?.(id);
    const projects = projectCapabilities();
    try {
      const registry = await registryForUse(); assertCurrent(owner);
      const found = locate(registry, id);
      if (!found) return { ok: false, message: RESULT_GONE };
      const current = projects.get(found.projectId) ?? (() => false);
      assertCurrent(current);
      // The registry revokes membership before its first await, also cancelling this result's pending review/export.
      const clearing = registry.forgetResult(id); changed();
      await clearing;
      assertCurrent(() => safe(owner) && safe(current));
      return { ok: true, message: "Private coding review forgotten. Exported copies and project history are unchanged." };
    } catch {
      return { ok: false, message: safe(owner) ? "Couldn't finish clearing this private coding review. Forget everything tries again. Exported copies and project history are unchanged." : STALE };
    }
  });
  d.handle(IPC.codingResultContinue, async (...args): Promise<{ ok: boolean; message: string }> => {
    const parsed = continuationArgsSchema.safeParse(args);
    if (!parsed.success) throw new Error("Choose an existing project or coding result.");
    const [id, projectId, request] = parsed.data, owner = capability(), current = capability(projectId);
    const selected = () => d.projects().selectedProjectId === projectId;
    const available = () => { const status = d.availability(projectId); return status.available === true && status.canContinue !== false && d.folders.state(projectId)?.valid === true && !pickers.has(projectId); };
    if (!d.continueResult || !safe(() => safe(owner) && safe(current) && selected() && available())) return { ok: false, message: UNAVAILABLE };
    try {
      const registry = await registryForUse();
      assertCurrent(() => safe(owner) && safe(current) && selected() && available());
      const found = locate(registry, id);
      if (!found || found.projectId !== projectId) return { ok: false, message: RESULT_GONE };
      // No await separates the final result/owner checks from the host's opaque intake capture.
      assertCurrent(() => safe(owner) && safe(current) && selected() && available() && locate(registry, id)?.projectId === projectId);
      void d.continueResult(id, projectId, request).catch(() => undefined);
      return { ok: true, message: "Requested a new coding session from this review. Watch Conversation for progress." };
    } catch { return { ok: false, message: safe(owner) && safe(current) ? RESULT_GONE : STALE }; }
  });

  return {
    chooseFolder,
    reset(): Promise<void> {
      const at = ++epoch;
      d.projectForgotten?.(undefined);
      revisions.clear(); pickers.clear(); d.folders.ownerReset(); d.folderChanged?.(undefined); changed();
      return (async () => {
        try { const registry = await registryForUse(); if (at === epoch) await registry.reset(); return; }
        catch (error) { if (absentBackend(error)) return; }
        // This error can cross IPC; private storage paths from a backend cause must stay out of it.
        throw new Error("Some coding reviews could not be cleared. Try again before starting new coding work.");
      })();
    },
    forgetProject(id: string): Promise<void> {
      if (!idSchema.safeParse(id).success) return Promise.reject(new Error("Choose an existing project."));
      d.projectForgotten?.(id);
      const at = epoch, ownerCurrent = d.folders.ownerCurrent();
      revisions.set(id, (revisions.get(id) ?? 0) + 1); pickers.delete(id); d.folders.clear(id); d.folderChanged?.(id); changed();
      return (async () => {
        try { const registry = await registryForUse(); if (at === epoch && safe(ownerCurrent)) await registry.forgetProject(id); return; }
        catch (error) { if (absentBackend(error)) return; }
        throw new Error("Some of this project's coding reviews could not be cleared. Try again.");
      })();
    },
  };
}
