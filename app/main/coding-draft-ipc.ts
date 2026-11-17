/** Home-only explicit saved drafts. Every asynchronous reply stays with its captured account and consent generation. */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { IPC } from "../shared/ipc";
import type { CodingDraftsState, CodingDraftSummary, CodingDraftView, CodingDraftFolderChoice, CodingDraftImportResult } from "../shared/coding-drafts";
import type { ProjectSessionsState } from "../shared/project-sessions";
import type { ProjectCodingWorkspaceState } from "../shared/project-coding";
import { CodingDraftStore, codingDraftPreviewData, type OpenCodingDraft } from "./agent/coding-draft-store";
import { CodingDraftError, CodingDraftCleanupError, type CodingDraftOwner } from "./agent/coding-draft-format";
import { CodingArtifactCleanupError } from "./agent/coding-artifact-store";
import type { ProjectCodingResourcesPort } from "./agent/project-coding-backend";
import type { ProjectCodingWorkspaces } from "./agent/project-coding-workspaces";

export interface CodingDraftIpcDeps {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
  createStore(): CodingDraftStore;
  owner(): CodingDraftOwner | null;
  consented(): boolean;
  canUse(): boolean;
  /** Stronger project/action eligibility for reading or retaining code; erasure needs no retention consent. */
  canRetain(): boolean;
  storageAvailable(): Promise<boolean>;
  projects(): ProjectSessionsState;
  folders: ProjectCodingWorkspaces;
  resources(): Promise<ProjectCodingResourcesPort>;
  chooseFolder(projectId: string): Promise<ProjectCodingWorkspaceState>;
  imported(resultId: string, projectId: string, context: { request: string; summary: string }): void;
  changed(): void;
}
export interface CodingDraftIpc {
  folderChanged(projectId?: string): void;
  invalidate(): Promise<void>;
  forgetAll(): Promise<void>;
  close(): Promise<void>;
}
const id = z.string().max(36).uuid(), one = z.tuple([id]), pair = z.tuple([id, id]);
const saveArgs = z.tuple([id, z.string().min(1).max(80).refine(value => !!value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value))]);
const draftTag = (value: unknown): string | undefined => typeof value === "string" && value.length === 36 && id.safeParse(value).success ? value : undefined;
const EMPTY = "Connect Ember and agree to the coding-draft note before opening or keeping saved code.";
const NEW_FOLDER = "Choose a coding folder again for this opened draft before preparing an import.";
const safe = (check: () => boolean) => { try { return check() === true; } catch { return false; } };
const read = <T extends z.ZodType>(schema: T, args: unknown[]): z.output<T> => {
  const result = schema.safeParse(args); if (!result.success) throw new CodingDraftError("invalid"); return result.data;
};
const summary = (metadata: CodingDraftSummary): CodingDraftSummary => ({ id: metadata.id, name: metadata.name, savedAt: metadata.savedAt,
  sourceLabel: metadata.sourceLabel, historicalChecks: { ...metadata.historicalChecks } });
export function registerCodingDraftIpc(d: CodingDraftIpcDeps): CodingDraftIpc {
  let store = d.createStore(), epoch = 0, abort = new AbortController(), closed = false, blocked = false, retiring = 0;
  let cleanupFailure: CodingDraftCleanupError | CodingArtifactCleanupError | null = null;
  let barrier = Promise.resolve();
  const byDraft = new Map<string, Set<Promise<unknown>>>();
  const pending = new Set<Promise<unknown>>(), revisions = new Map<string, number>();
  const opened = new Map<string, { draft: OpenCodingDraft; epoch: number; chosen: Map<string, { revision: number; path: string; current(): boolean }> }>();
  const ownerKey = () => { try { return JSON.stringify(d.owner()); } catch { return ""; } };
  const canForget = () => { try { return !!d.owner() && safe(d.canUse); } catch { return false; } };
  const blank = (message = EMPTY): CodingDraftsState => ({ canSave: false, canOpen: false, canForget: canForget(), drafts: [], message });
  const lease = (retention = true) => {
    const selectedOwner = d.owner(), owner = selectedOwner ? Object.freeze({ ...selectedOwner }) : null;
    const key = ownerKey(), at = epoch, selectedStore = store, signal = abort.signal;
    if (!owner || closed || blocked || retiring || !safe(d.canUse) || retention && (!safe(d.canRetain) || !safe(d.consented))) throw new CodingDraftError("stale");
    let live = true;
    const current = () => {
      if (!live) return false;
      live = !closed && !blocked && !retiring && epoch === at && ownerKey() === key && safe(d.canUse) && (!retention || safe(d.canRetain) && safe(d.consented));
      live = live && !closed && !blocked && !retiring && epoch === at && !signal.aborted;
      return live;
    };
    return { owner, store: selectedStore, current, signal, check: () => { if (!current()) throw new CodingDraftError("stale"); } };
  };
  const track = <T>(operation: () => Promise<T>, draftId?: string, erasing = false): Promise<T> => {
    if (pending.size >= (erasing ? 3 : 2)) return Promise.reject(new CodingDraftError("limit"));
    const promise = operation(); pending.add(promise);
    const related = draftId ? byDraft.get(draftId) ?? new Set<Promise<unknown>>() : undefined;
    if (draftId && related) { related.add(promise); byDraft.set(draftId, related); }
    const done = () => { pending.delete(promise); if (draftId && related) { related.delete(promise); if (!related.size) byDraft.delete(draftId); } };
    void promise.then(done, done); return promise;
  };
  const fault = (error: unknown): string => {
    if (error instanceof CodingDraftCleanupError || error instanceof CodingArtifactCleanupError) { blocked = true; cleanupFailure = error; }
    return error instanceof CodingDraftError || error instanceof CodingDraftCleanupError || error instanceof CodingArtifactCleanupError
      ? error.message : "The coding draft could not be prepared safely. Your original folder is unchanged.";
  };
  const stateFor = async (l: ReturnType<typeof lease>): Promise<CodingDraftsState> => {
    try {
      l.check(); if (!safe(d.consented)) return blank();
      await barrier; l.check();
      const available = await d.storageAvailable(); l.check();
      if (!available) return { ...blank("A system keyring is required to keep or open coding drafts."), canForget: true };
      const values = await l.store.list(l.owner, l.current); l.check();
      return { canSave: true, canOpen: true, canForget: true, drafts: values.map(summary),
        message: "Explicit saves keep complete captured files and the last request and summary, encrypted on this computer. Opening a draft starts no work." };
    } catch (error) { return blank(fault(error)); }
  };
  const state = async (): Promise<CodingDraftsState> => { try { return await stateFor(lease()); } catch { return blank(); } };
  const retire = () => {
    epoch++; const previous = abort; abort = new AbortController(); previous.abort();
    for (const value of opened.values()) value.draft.close(); opened.clear(); revisions.clear();
  };
  const invalidate = (): Promise<void> => {
    retire(); retiring++; const previous = store; store = d.createStore();
    barrier = Promise.allSettled([barrier, ...pending, previous.close()]).then(results => {
      const failure = results.find(value => value.status === "rejected" && (value.reason instanceof CodingDraftCleanupError || value.reason instanceof CodingArtifactCleanupError));
      if (failure?.status === "rejected") { blocked = true; cleanupFailure = failure.reason; }
      if (cleanupFailure) throw cleanupFailure;
    }).finally(() => { retiring--; }); return barrier;
  };
  const forgetAll = async (): Promise<void> => {
    retire(); retiring++; const at = epoch, selected = store, key = ownerKey();
    try {
      await Promise.allSettled([...pending]);
      if (cleanupFailure) throw cleanupFailure;
      await selected.forgetAll(() => !closed && epoch === at && ownerKey() === key); d.changed();
    } finally { retiring--; }
  };
  d.handle(IPC.codingDraftsState, (...args) => { if (args.length) throw new CodingDraftError("invalid"); return track(state); });
  d.handle(IPC.codingDraftSave, (...args) => track(async () => {
    const [resultId, name] = read(saveArgs, args), l = lease();
    let captured: Awaited<ReturnType<CodingDraftStore["capture"]>> | undefined;
    try {
      const resource = await d.resources(); l.check(); const registry = await resource.results(); l.check();
      const project = d.projects().projects.find(value => registry.state(value.id).some(result => result.id === resultId));
      if (!project) throw new CodingDraftError("stale");
      let callbackFailure: unknown;
      captured = await registry.withDraftSnapshot(resultId, project.id, l.current, async value => {
        try {
          if (value.context.request.length > 2000 || value.context.summary.length > 2000) throw new CodingDraftError("limit");
          captured = await l.store.capture({ store: value.store, artifact: value.artifact, current: () => l.current() && value.current(), signal: l.signal,
            metadata: { version: 1, id: randomUUID(), owner: l.owner, name: name.trim(), savedAt: Date.now(), sourceLabel: path.basename(value.summary.sourcePath),
              context: value.context, historicalChecks: value.summary.checks, binding: value.binding } });
          return captured;
        } catch (error) { callbackFailure = error; return undefined; }
      });
      if (callbackFailure) throw callbackFailure; if (!captured) throw new CodingDraftError("invalid");
      l.check(); await l.store.save(l.owner, captured, l.current); l.check(); d.changed(); return await stateFor(l);
    } catch (error) { return { ...blank(fault(error)), canForget: l.current() }; }
    finally { captured?.close(); }
  }));
  d.handle(IPC.codingDraftOpen, (...args) => track(async (): Promise<CodingDraftView> => {
    const [draftId] = read(one, args), l = lease();
    let pendingDraft: OpenCodingDraft | undefined;
    try {
      for (const value of opened.values()) value.draft.close(); opened.clear();
      const draft = pendingDraft = await l.store.open(l.owner, draftId, l.current) ?? undefined; l.check(); if (!draft) throw new CodingDraftError("invalid");
      const metadata = draft.metadata(), preview = codingDraftPreviewData(draft);
      opened.set(draftId, { draft, epoch, chosen: new Map() }); pendingDraft = undefined;
      return { ...summary(metadata), context: metadata.context, ...preview,
        previewMessage: "Saved review and historical context only. Choose a folder again to prepare a new import; only a new request can start coding work." };
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Filesystem and keyring causes must never cross renderer IPC.
      throw new Error(fault(error));
    } finally { pendingDraft?.close(); }
  }, draftTag(args[0])));
  d.handle(IPC.codingDraftForget, (...args) => track(async () => {
    const [draftId] = read(one, args), l = lease(false);
    const related = [...(byDraft.get(draftId) ?? [])];
    opened.get(draftId)?.draft.close(); opened.delete(draftId);
    try { await l.store.forget(l.owner, draftId, l.current); await Promise.allSettled(related); l.check(); d.changed();
      return { ...await stateFor(l), message: "Saved draft forgotten. Imported reviews and exported copies are unchanged." }; }
    catch (error) { return blank(fault(error)); }
  }, draftTag(args[0]), true));
  d.handle(IPC.codingDraftForgetAll, (...args) => { if (args.length) throw new CodingDraftError("invalid");
    if (!canForget()) throw new CodingDraftError("stale");
    // Not part of pending: erasure awaits every previously admitted operation, never its own promise.
    return forgetAll().then(state, error => blank(fault(error)));
  });
  d.handle(IPC.codingDraftFolderChoose, (...args) => track(async (): Promise<CodingDraftFolderChoice> => {
    const [draftId, projectId] = read(pair, args), l = lease(), value = opened.get(draftId);
    if (!value || value.epoch !== epoch) return { ok: false, message: NEW_FOLDER };
    const before = revisions.get(projectId) ?? 0, previousFolder = d.folders.capture(projectId);
    try {
      const workspace = await d.chooseFolder(projectId); l.check();
      const folder = d.folders.capture(projectId), revision = revisions.get(projectId) ?? 0;
      if (opened.get(draftId) !== value || before === revision || !folder || !safe(folder.current) || previousFolder && safe(previousFolder.current)) return { ok: false, message: NEW_FOLDER, workspace };
      value.chosen.set(projectId, { revision, path: folder.path, current: folder.current }); return { ok: true, message: "Folder chosen. Preparing an import creates a new private review; your original stays unchanged.", workspace };
    } catch (error) { return { ok: false, message: fault(error) }; }
  }, draftTag(args[0])));
  d.handle(IPC.codingDraftImport, (...args) => track(async (): Promise<CodingDraftImportResult> => {
    const [draftId, projectId] = read(pair, args), l = lease(), value = opened.get(draftId), chosen = value?.chosen.get(projectId);
    if (!value || value.epoch !== epoch || !chosen || chosen.revision !== (revisions.get(projectId) ?? 0) || !safe(chosen.current)) return { ok: false, message: NEW_FOLDER };
    // Each explicit folder choice can prepare at most one import, including a conflicted or failed attempt.
    value.chosen.delete(projectId);
    const current = () => l.current() && opened.get(draftId) === value && chosen.revision === (revisions.get(projectId) ?? 0) && safe(chosen.current);
    try {
      const resource = await d.resources(); l.check();
      if (!current()) throw new CodingDraftError("stale");
      const result = await resource.importDraft(projectId, value.draft, l.owner, l.signal, current); l.check();
      if (!current()) throw new CodingDraftError("stale");
      if (!result.ok) return result;
      d.imported(result.result.id, projectId, result.context); d.changed();
      return { ok: true, resultId: result.result.id, message: "Imported as a new private review. Read it, then type a new request to start work. Historical checks must run again." };
    } catch (error) { return { ok: false, message: fault(error) }; }
  }, draftTag(args[0])));
  return { folderChanged(projectId) {
    if (projectId === undefined) { revisions.clear(); for (const value of opened.values()) value.chosen.clear(); return; }
    revisions.set(projectId, (revisions.get(projectId) ?? 0) + 1);
    for (const value of opened.values()) value.chosen.delete(projectId);
  }, invalidate, forgetAll, async close() { closed = true; retire(); await Promise.allSettled([...pending, barrier]); await store.close(); if (cleanupFailure) throw cleanupFailure; } };
}
