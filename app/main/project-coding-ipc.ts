/** Home-only coding folder/review IPC. Main supplies its sender guard and native folder picker. */
import { z } from "zod";
import { IPC } from "../shared/ipc";
import type { ProjectSessionsState } from "../shared/project-sessions";
import type { CodingResultReview, CodingResultSummary, ProjectCodingWorkspaceState } from "../shared/project-coding";
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
  availability(): { available: boolean; message: string };
  chooseFolder(title: string): Promise<string | null>;
  validateFolder(path: string): CodingWorkspace | Promise<CodingWorkspace>;
  /** Synchronous host cancellation after a folder capability changes; undefined invalidates every project. */
  folderChanged?(projectId?: string): void;
  changed(): void;
}

export interface ProjectCodingIpc {
  /** Invalidates pending chooser/review/export replies synchronously, before private cleanup is awaited. */
  reset(): Promise<void>;
  /** Retires only this project's folder capability and review records. */
  forgetProject(projectId: string): Promise<void>;
}

const idSchema = z.string().max(36).uuid();
const argsSchema = z.tuple([idSchema]);
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
    let availability: { available: boolean; message: string };
    try { availability = d.availability(); } catch { availability = { available: false, message: "Coding work is unavailable on this computer." }; }
    const folder = d.folders.state(id), busy = liveCoding(id), picking = pickers.has(id);
    return {
      projectId: id, folder, available: availability.available,
      canChoose: !busy && !picking,
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
  d.handle(IPC.projectCodingWorkspaceChoose, async (...args): Promise<ProjectCodingWorkspaceState> => {
    const id = idFrom(args); requireFolderChange(id);
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
  });
  d.handle(IPC.projectCodingWorkspaceForget, (...args): ProjectCodingWorkspaceState => {
    const id = idFrom(args); requireFolderChange(id);
    d.folders.clear(id); d.folderChanged?.(id); changed();
    return workspaceState(id);
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

  return {
    reset(): Promise<void> {
      const at = ++epoch;
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
