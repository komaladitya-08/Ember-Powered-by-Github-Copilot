import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerProjectCodingIpc } from "../../app/main/project-coding-ipc";
import { ProjectCodingWorkspaces } from "../../app/main/agent/project-coding-workspaces";
import { projectCommandFolder } from "../../app/main/agent/project";
import type { CodingWorkspace } from "../../app/main/agent/coding-workspace";
import { CodingResultRegistryError } from "../../app/main/agent/coding-result-registry";
import { IPC } from "../../app/shared/ipc";
import type { ProjectSession, ProjectSessionsState } from "../../app/shared/project-sessions";
import type { CodingResultReview, CodingResultSummary, ProjectCodingWorkspaceState } from "../../app/shared/project-coding";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-coding-ipc-")); directories.push(root);
  const source = path.join(root, "source"), other = path.join(root, "other"), privateDir = path.join(root, "private");
  for (const directory of [source, other, privateDir]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(source, "unchanged.txt"), "The original is unchanged.");
  const first = randomUUID(), second = randomUUID(), record = randomUUID();
  let owner: string | null = "owner-a", allowed = true, available = false;
  const state: ProjectSessionsState = { selectedProjectId: first, projects: [first, second].map(id => ({ id, name: id, goal: "", createdAt: 1, sessions: [] })) };
  const folders = new ProjectCodingWorkspaces({ projectExists: id => state.projects.some(project => project.id === id), currentOwner: () => owner });
  const review: CodingResultReview = { id: record, projectId: first, taskId: randomUUID(), title: "Improve the app", sourcePath: source, status: "done", files: 1, conflicts: 0,
    patchComplete: true, checks: { ran: 1, passed: 1, failed: 0 }, message: "Ready for review.", changes: [], textPatch: "", limitations: [], previewMessage: "No text changes." };
  let records: CodingResultSummary[] = [review];
  const registry = {
    state: vi.fn((id: string) => records.filter(item => item.projectId === id)),
    review: vi.fn(async (id: string) => records.some(item => item.id === id) ? review : null),
    export: vi.fn(async (_id: string, _destination: string, current: () => boolean) => ({ ok: current(), message: "Export finished.", directory: "/native/export/result" })),
    reset: vi.fn(async () => { records = []; }),
    forgetProject: vi.fn(async (id: string) => { records = records.filter(item => item.projectId !== id); }),
    forgetResult: vi.fn(async (id: string) => { records = records.filter(item => item.id !== id); }),
  };
  const results = vi.fn(async () => registry);
  const chooseFolder = vi.fn(async (_title: string): Promise<string | null> => source);
  const validateFolder = vi.fn<(selected: string) => CodingWorkspace | Promise<CodingWorkspace>>(selected => projectCommandFolder(selected, privateDir));
  const changed = vi.fn();
  const folderChanged = vi.fn<(projectId?: string) => void>();
  const continueResult = vi.fn(async (_id: string, _projectId: string, _request: string) => true);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const api = registerProjectCodingIpc({ handle: (channel, handler) => handlers.set(channel, handler), projects: () => state, folders, results,
    canUse: () => allowed, availability: () => ({ available, message: "Coding work is unavailable, but a folder can be prepared." }), continueResult,
    chooseFolder, validateFolder, folderChanged, changed });
  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => await handlers.get(channel)!(...args) as T;
  const live = (id: string, status: ProjectSession["status"], kind: ProjectSession["kind"] = "coding") => {
    state.projects.find(project => project.id === id)!.sessions = [{ id: randomUUID(), taskId: randomUUID(), title: "Work", kind, status, detail: "", startedAt: 1 }];
  };
  return { root, source, other, privateDir, first, second, record, review, state, folders, registry, results, chooseFolder, validateFolder, folderChanged, changed, handlers, api, call, live,
    continueResult, available: (value: boolean) => { available = value; },
    owner: (value: string | null) => { owner = value; }, allowed: (value: boolean) => { allowed = value; },
    records: (value: CodingResultSummary[]) => { records = value; } };
}

describe("Home's project coding IPC", () => {
  const prepareContinuation = (f: ReturnType<typeof setup>) => {
    f.available(true); f.folders.bind(f.first, projectCommandFolder(f.source, f.privateDir), f.folders.ownerCurrent(f.first));
  };
  it("captures only an explicit selected result and exact new request without waiting for the conductor", async () => {
    const f = setup(); prepareContinuation(f);
    const pending = deferred<boolean>(), request = "  Continue the parser fix\nRun its focused test.  "; f.continueResult.mockReturnValueOnce(pending.promise);
    expect(await f.call(IPC.codingResultContinue, f.record, f.first, request)).toMatchObject({ ok: true, message: expect.stringContaining("Requested a new coding session") });
    expect(f.continueResult).toHaveBeenCalledExactlyOnceWith(f.record, f.first, request);
    expect(f.chooseFolder).not.toHaveBeenCalled(); expect(f.validateFolder).not.toHaveBeenCalled(); expect(f.registry.export).not.toHaveBeenCalled();
    pending.resolve(true); expect(fs.readFileSync(path.join(f.source, "unchanged.txt"), "utf8")).toBe("The original is unchanged.");
  });

  it("rejects malformed continuation arguments, blank or oversized goals, and renderer-supplied extra authority", async () => {
    const f = setup(); prepareContinuation(f);
    for (const args of [[f.record, f.first, ""], [f.record, f.first, "  \n"], [f.record, f.first, "x".repeat(2001)],
      ["../result", f.first, "Repair source"], [f.record, "../project", "Repair source"], [f.record, f.first, { goal: "Repair source", directory: f.source }],
      [f.record, f.first, "Repair source", { artifact: "invented" }]]) {
      await expect(f.call(IPC.codingResultContinue, ...args)).rejects.toThrow("Choose an existing project or coding result.");
    }
    expect(f.continueResult).not.toHaveBeenCalled(); expect(f.results).not.toHaveBeenCalled();
  });

  it("requires current coding availability, a valid chosen folder and the result's selected project", async () => {
    const f = setup();
    expect(await f.call(IPC.codingResultContinue, f.record, f.first, "Repair source")).toMatchObject({ ok: false });
    f.available(true); expect(await f.call(IPC.codingResultContinue, f.record, f.first, "Repair source")).toMatchObject({ ok: false });
    prepareContinuation(f); f.state.selectedProjectId = f.second;
    expect(await f.call(IPC.codingResultContinue, f.record, f.first, "Repair source")).toMatchObject({ ok: false });
    f.state.selectedProjectId = f.first; f.records([{ ...f.review, projectId: f.second }]);
    expect(await f.call(IPC.codingResultContinue, f.record, f.first, "Repair source")).toMatchObject({ ok: false });
    expect(f.continueResult).not.toHaveBeenCalled();
  });

  it.each(["selection", "folder", "owner", "result"] as const)("rechecks %s after a delayed registry lookup before capturing continuation intake", async change => {
    const f = setup(); prepareContinuation(f); const registry = deferred<typeof f.registry>(); f.results.mockReturnValueOnce(registry.promise);
    const pending = f.call(IPC.codingResultContinue, f.record, f.first, "Repair source");
    if (change === "selection") f.state.selectedProjectId = f.second;
    if (change === "folder") f.folders.bind(f.first, projectCommandFolder(f.other, f.privateDir), f.folders.ownerCurrent(f.first));
    if (change === "owner") { f.owner("other"); f.folders.ownerReset(); f.owner("owner-a"); }
    if (change === "result") f.records([]);
    registry.resolve(f.registry); expect(await pending).toMatchObject({ ok: false }); expect(f.continueResult).not.toHaveBeenCalled();
  });

  it("sanitizes synchronous host admission failures and absorbs only late submission failures", async () => {
    const f = setup(); prepareContinuation(f);
    f.continueResult.mockImplementationOnce(() => { throw new Error("private=/native/secret"); });
    const refused = await f.call<{ ok: boolean; message: string }>(IPC.codingResultContinue, f.record, f.first, "Repair source");
    expect(refused.ok).toBe(false); expect(refused.message).not.toContain("secret");
    f.continueResult.mockRejectedValueOnce(new Error("private=/native/secret"));
    const accepted = await f.call<{ ok: boolean; message: string }>(IPC.codingResultContinue, f.record, f.first, "Repair source");
    expect(accepted).toMatchObject({ ok: true, message: expect.stringContaining("Requested") });
    await Promise.resolve(); expect(JSON.stringify(accepted)).not.toContain("secret");
  });

  it("registers only bounded metadata/review channels and prepares a folder without executing or reading source files", async () => {
    const f = setup();
    expect([...f.handlers.keys()]).toEqual([IPC.projectCodingWorkspaceState, IPC.projectCodingWorkspaceChoose, IPC.projectCodingWorkspaceForget, IPC.codingResultsState, IPC.codingResultReview, IPC.codingResultExport, IPC.codingResultForget, IPC.codingResultContinue]);
    const before = fs.readFileSync(path.join(f.source, "unchanged.txt"), "utf8");
    const state = await f.call<ProjectCodingWorkspaceState>(IPC.projectCodingWorkspaceState, f.first);
    expect(state).toMatchObject({ available: false, canChoose: true, folder: null });
    const chosen = await f.call<ProjectCodingWorkspaceState>(IPC.projectCodingWorkspaceChoose, f.first);
    expect(f.folderChanged).toHaveBeenLastCalledWith(f.first);
    expect(chosen.folder).toEqual({ path: fs.realpathSync.native(f.source), label: "source", valid: true });
    expect(chosen.available).toBe(false); expect(chosen.canChoose).toBe(true);
    expect(f.chooseFolder).toHaveBeenCalledWith("Choose a coding folder");
    expect(f.validateFolder).toHaveBeenCalledWith(f.source);
    expect(f.results).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.source, "unchanged.txt"), "utf8")).toBe(before);
    expect(fs.readdirSync(f.privateDir)).toEqual([]);
    expect((await f.call<ProjectCodingWorkspaceState>(IPC.projectCodingWorkspaceForget, f.first)).folder).toBeNull();
    expect(f.folderChanged).toHaveBeenLastCalledWith(f.first);
  });

  it("passes the picker spelling to validation and publishes only the canonical folder grant", async () => {
    const f = setup(), selected = `${f.source}${path.sep}.`; f.chooseFolder.mockResolvedValueOnce(selected);
    const chosen = await f.call<ProjectCodingWorkspaceState>(IPC.projectCodingWorkspaceChoose, f.first);
    expect(f.validateFolder).toHaveBeenCalledWith(selected);
    expect(chosen.folder).toEqual({ path: fs.realpathSync.native(f.source), label: "source", valid: true });
    expect(chosen.folder?.path).not.toBe(selected);
    expect(f.folders.capture(f.first)?.current()).toBe(true);
    expect(f.results).not.toHaveBeenCalled();
  });

  it("accepts no renderer folder, destination, model state, extra arguments or unknown project", async () => {
    const f = setup();
    for (const channel of f.handlers.keys()) {
      for (const args of [[], ["../project"], ["x".repeat(10_000)], [{ projectId: f.first, path: f.source }], [f.first, f.source]]) {
        await expect(f.call(channel, ...args)).rejects.toThrow("Choose an existing project or coding result.");
      }
    }
    await expect(f.call(IPC.projectCodingWorkspaceChoose, randomUUID())).rejects.toThrow("Connect Ember");
    expect(f.chooseFolder).not.toHaveBeenCalled(); expect(f.validateFolder).not.toHaveBeenCalled(); expect(f.results).not.toHaveBeenCalled();
  });

  it("does not publish paths or result metadata without the current usable account", async () => {
    const f = setup(); f.folders.bind(f.first, projectCommandFolder(f.source, f.privateDir), f.folders.ownerCurrent(f.first));
    f.allowed(false);
    expect(await f.call(IPC.projectCodingWorkspaceState, f.first)).toMatchObject({ folder: null, available: false, canChoose: false });
    expect(await f.call(IPC.codingResultsState, f.first)).toEqual([]);
    await expect(f.call(IPC.codingResultReview, f.record)).rejects.toThrow("Connect Ember");
    expect(await f.call(IPC.codingResultExport, f.record)).toMatchObject({ ok: false });
    expect(await f.call(IPC.codingResultForget, f.record)).toMatchObject({ ok: false });
    expect(f.results).not.toHaveBeenCalled(); expect(f.chooseFolder).not.toHaveBeenCalled();
    f.allowed(true); f.owner(null);
    expect(await f.call(IPC.codingResultsState, f.first)).toEqual([]);
    expect(f.results).not.toHaveBeenCalled();
  });

  it.each(["queued", "running", "waiting"] as const)("blocks folder changes for %s coding work only in that project", async status => {
    const f = setup(); f.live(f.first, status);
    expect(await f.call(IPC.projectCodingWorkspaceState, f.first)).toMatchObject({ canChoose: false });
    await expect(f.call(IPC.projectCodingWorkspaceChoose, f.first)).rejects.toThrow("Stop this project's coding");
    await expect(f.call(IPC.projectCodingWorkspaceForget, f.first)).rejects.toThrow("Stop this project's coding");
    expect((await f.call<ProjectCodingWorkspaceState>(IPC.projectCodingWorkspaceChoose, f.second)).folder?.path).toBe(fs.realpathSync.native(f.source));
    f.live(f.first, "running", "desktop");
    expect((await f.call<ProjectCodingWorkspaceState>(IPC.projectCodingWorkspaceChoose, f.first)).folder?.path).toBe(fs.realpathSync.native(f.source));
  });

  it("permits one chooser per project, leaves other projects usable and keeps cancellation non-mutating", async () => {
    const f = setup(), a = deferred<string | null>(), b = deferred<string | null>();
    f.folders.bind(f.first, projectCommandFolder(f.source, f.privateDir), f.folders.ownerCurrent(f.first));
    const original = f.folders.capture(f.first)!;
    f.chooseFolder.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = f.call<ProjectCodingWorkspaceState>(IPC.projectCodingWorkspaceChoose, f.first);
    expect(await f.call(IPC.projectCodingWorkspaceState, f.first)).toMatchObject({ canChoose: false });
    await expect(f.call(IPC.projectCodingWorkspaceChoose, f.first)).rejects.toThrow("folder picker");
    const second = f.call<ProjectCodingWorkspaceState>(IPC.projectCodingWorkspaceChoose, f.second);
    a.resolve(null); b.resolve(f.other);
    expect((await first).folder?.path).toBe(fs.realpathSync.native(f.source)); expect(original.current()).toBe(true);
    expect((await second).folder?.path).toBe(fs.realpathSync.native(f.other));
    expect(f.validateFolder).toHaveBeenCalledTimes(1);
  });

  it("keeps a native validation error out of the renderer and retains the existing folder", async () => {
    const f = setup(); f.folders.bind(f.first, projectCommandFolder(f.source, f.privateDir), f.folders.ownerCurrent(f.first));
    f.validateFolder.mockImplementationOnce(() => { throw new Error("secret=/private/raw/source"); });
    await expect(f.call(IPC.projectCodingWorkspaceChoose, f.first)).rejects.toThrow("Choose an ordinary local folder");
    expect(f.folders.capture(f.first)?.path).toBe(fs.realpathSync.native(f.source));
  });

  it("rechecks live work and folder revisions after the native picker, without binding a stale choice", async () => {
    const f = setup(), picker = deferred<string | null>(); f.chooseFolder.mockReturnValueOnce(picker.promise);
    const chosen = f.call(IPC.projectCodingWorkspaceChoose, f.first);
    f.live(f.first, "running"); picker.resolve(f.source);
    await expect(chosen).rejects.toThrow("Stop this project's coding");
    expect(f.folders.capture(f.first)).toBeNull(); expect(f.validateFolder).not.toHaveBeenCalled();
    f.live(f.first, "done");
    const nextPicker = deferred<string | null>(); f.chooseFolder.mockReturnValueOnce(nextPicker.promise);
    const old = f.call(IPC.projectCodingWorkspaceChoose, f.first);
    f.folders.bind(f.first, projectCommandFolder(f.other, f.privateDir), f.folders.ownerCurrent(f.first));
    nextPicker.resolve(f.source);
    await expect(old).rejects.toThrow("choice changed");
    expect(f.folders.capture(f.first)?.path).toBe(fs.realpathSync.native(f.other));
  });

  it("invalidates an owner ABA and pending chooser synchronously on reset, before cleanup resolves", async () => {
    const f = setup(), picker = deferred<string | null>(), cleanup = deferred<void>();
    f.chooseFolder.mockReturnValueOnce(picker.promise); f.registry.reset.mockReturnValueOnce(cleanup.promise);
    const old = f.call(IPC.projectCodingWorkspaceChoose, f.first);
    f.owner("owner-b"); const reset = f.api.reset(); f.owner("owner-a");
    expect(f.folderChanged).toHaveBeenLastCalledWith(undefined);
    expect(f.folders.state(f.first)).toBeNull();
    picker.resolve(f.source);
    await expect(old).rejects.toThrow("choice changed"); expect(f.validateFolder).not.toHaveBeenCalled();
    cleanup.resolve(); await reset;
    expect(f.registry.reset).toHaveBeenCalledTimes(1);
  });

  it("rechecks a pending asynchronous folder validation before binding or notifying the host", async () => {
    const f = setup(), validation = deferred<CodingWorkspace>();
    f.validateFolder.mockReturnValueOnce(validation.promise);
    const old = f.call(IPC.projectCodingWorkspaceChoose, f.first);
    await vi.waitFor(() => expect(f.validateFolder).toHaveBeenCalled());
    f.folders.bind(f.first, projectCommandFolder(f.other, f.privateDir), f.folders.ownerCurrent(f.first));
    validation.resolve(projectCommandFolder(f.source, f.privateDir));
    await expect(old).rejects.toThrow("choice changed");
    expect(f.folders.capture(f.first)?.path).toBe(fs.realpathSync.native(f.other));
    expect(f.folderChanged).not.toHaveBeenCalled();
  });

  it("forgets only one project's folder and results, retaining another project's grants", async () => {
    const f = setup();
    f.folders.bind(f.first, projectCommandFolder(f.source, f.privateDir), f.folders.ownerCurrent(f.first));
    f.folders.bind(f.second, projectCommandFolder(f.other, f.privateDir), f.folders.ownerCurrent(f.second));
    const first = f.folders.capture(f.first)!, second = f.folders.capture(f.second)!;
    f.records([f.review, { ...f.review, id: randomUUID(), projectId: f.second }]);
    const forgotten = f.api.forgetProject(f.first);
    expect(f.folderChanged).toHaveBeenLastCalledWith(f.first);
    expect(first.current()).toBe(false); expect(second.current()).toBe(true);
    await forgotten;
    expect(f.registry.forgetProject).toHaveBeenCalledWith(f.first); expect(f.registry.reset).not.toHaveBeenCalled();
    expect(await f.call(IPC.codingResultsState, f.first)).toEqual([]);
    expect(await f.call<CodingResultSummary[]>(IPC.codingResultsState, f.second)).toHaveLength(1);
  });

  it("rejects an old registry read and review after folder rebind or project deletion", async () => {
    const f = setup(), registry = deferred<typeof f.registry>(); f.results.mockReturnValueOnce(registry.promise);
    const oldState = f.call(IPC.codingResultsState, f.first);
    f.folders.bind(f.first, projectCommandFolder(f.other, f.privateDir), f.folders.ownerCurrent(f.first));
    registry.resolve(f.registry); expect(await oldState).toEqual([]);
    const review = deferred<CodingResultReview | null>(); f.registry.review.mockReturnValueOnce(review.promise);
    const oldReview = f.call(IPC.codingResultReview, f.record);
    await vi.waitFor(() => expect(f.registry.review).toHaveBeenCalled());
    f.state.projects = f.state.projects.filter(project => project.id !== f.first);
    review.resolve(f.review);
    await expect(oldReview).rejects.toThrow("no longer available");
  });

  it("exports only a host-minted result to the native picker destination and strips extra return data", async () => {
    const f = setup(); f.chooseFolder.mockResolvedValueOnce("/native/chosen");
    expect(await f.call(IPC.codingResultReview, f.record)).toBe(f.review);
    const exported = await f.call(IPC.codingResultExport, f.record);
    expect(f.chooseFolder).toHaveBeenCalledWith("Export coding review");
    expect(f.registry.export).toHaveBeenCalledWith(f.record, "/native/chosen", expect.any(Function));
    expect(exported).toEqual({ ok: true, message: "Export finished." });
    expect(f.validateFolder).not.toHaveBeenCalled();
    expect(await f.call(IPC.codingResultExport, randomUUID())).toMatchObject({ ok: false, message: expect.stringContaining("no longer available") });
    expect(f.chooseFolder).toHaveBeenCalledTimes(1);
  });

  it("captures project revisions before a lazy registry opens, for review and export alike", async () => {
    const f = setup(), first = deferred<typeof f.registry>(); f.results.mockReturnValueOnce(first.promise);
    const review = f.call(IPC.codingResultReview, f.record);
    f.folders.bind(f.first, projectCommandFolder(f.other, f.privateDir), f.folders.ownerCurrent(f.first));
    first.resolve(f.registry); await expect(review).rejects.toThrow("no longer available");
    expect(f.registry.review).not.toHaveBeenCalled();
    const second = deferred<typeof f.registry>(); f.results.mockReturnValueOnce(second.promise);
    const exported = f.call<{ ok: boolean }>(IPC.codingResultExport, f.record);
    f.folders.clear(f.first); second.resolve(f.registry);
    expect((await exported).ok).toBe(false); expect(f.chooseFolder).not.toHaveBeenCalled();
  });

  it("forgets only a current host-minted result while keeping folders, live sessions and project history", async () => {
    const f = setup(), other = { ...f.review, id: randomUUID(), projectId: f.second };
    f.records([f.review, other]); f.live(f.first, "running");
    f.folders.bind(f.first, projectCommandFolder(f.source, f.privateDir), f.folders.ownerCurrent(f.first));
    const folder = f.folders.capture(f.first)!, history = structuredClone(f.state);
    expect(await f.call(IPC.codingResultForget, randomUUID())).toMatchObject({ ok: false, message: expect.stringContaining("no longer available") });
    expect(f.registry.forgetResult).not.toHaveBeenCalled();
    expect(await f.call(IPC.codingResultForget, f.record)).toEqual({ ok: true, message: expect.stringContaining("Exported copies and project history are unchanged") });
    expect(f.registry.forgetResult).toHaveBeenCalledExactlyOnceWith(f.record);
    expect(f.state).toEqual(history); expect(folder.current()).toBe(true);
    expect(f.registry.reset).not.toHaveBeenCalled(); expect(f.registry.forgetProject).not.toHaveBeenCalled(); expect(f.folderChanged).not.toHaveBeenCalled();
    expect(await f.call(IPC.codingResultsState, f.second)).toEqual([other]);
    expect(f.chooseFolder).not.toHaveBeenCalled();
  });

  it("revokes pending review and native export replies when the same result is explicitly forgotten", async () => {
    const f = setup(), reading = deferred<CodingResultReview | null>(), picker = deferred<string | null>();
    f.registry.review.mockReturnValueOnce(reading.promise); f.chooseFolder.mockReturnValueOnce(picker.promise);
    const review = f.call(IPC.codingResultReview, f.record), exporting = f.call<{ ok: boolean }>(IPC.codingResultExport, f.record);
    await vi.waitFor(() => expect(f.chooseFolder).toHaveBeenCalled());
    expect(await f.call(IPC.codingResultForget, f.record)).toMatchObject({ ok: true });
    reading.resolve(f.review); picker.resolve("/native/chosen");
    await expect(review).rejects.toThrow("no longer available"); expect((await exporting).ok).toBe(false);
    expect(f.registry.export).not.toHaveBeenCalled();
  });

  it("fences Forget across lazy account/project changes and hides private cleanup errors", async () => {
    const f = setup(), opening = deferred<typeof f.registry>(); f.results.mockReturnValueOnce(opening.promise);
    const forgetting = f.call<{ ok: boolean }>(IPC.codingResultForget, f.record);
    f.folders.clear(f.first); opening.resolve(f.registry);
    expect((await forgetting).ok).toBe(false); expect(f.registry.forgetResult).not.toHaveBeenCalled();
    f.registry.forgetResult.mockRejectedValueOnce(new Error("secret=/private/review"));
    const failed = await f.call<{ ok: boolean; message: string }>(IPC.codingResultForget, f.record);
    expect(failed.ok).toBe(false); expect(failed.message).toContain("Forget everything tries again"); expect(failed.message).not.toContain("secret=");
  });

  it("cancels stale exports across folder replacement, lock and owner reset and hides raw backend paths", async () => {
    const f = setup(), picker = deferred<string | null>(); f.chooseFolder.mockReturnValueOnce(picker.promise);
    const old = f.call<{ ok: boolean; message: string }>(IPC.codingResultExport, f.record);
    await vi.waitFor(() => expect(f.chooseFolder).toHaveBeenCalled());
    f.folders.bind(f.first, projectCommandFolder(f.other, f.privateDir), f.folders.ownerCurrent(f.first));
    picker.resolve("/native/chosen");
    expect((await old).ok).toBe(false); expect(f.registry.export).not.toHaveBeenCalled();
    const writing = deferred<{ ok: boolean; message: string; directory: string }>(); f.registry.export.mockReturnValueOnce(writing.promise);
    const afterDialog = f.call<{ ok: boolean; message: string }>(IPC.codingResultExport, f.record);
    await vi.waitFor(() => expect(f.registry.export).toHaveBeenCalled());
    const current = f.registry.export.mock.calls.at(-1)![2]; f.allowed(false); expect(current()).toBe(false);
    writing.resolve({ ok: true, message: "OLD PRIVATE PATH", directory: "/private/old" });
    expect(await afterDialog).toEqual({ ok: false, message: expect.stringContaining("choice changed") });
    f.allowed(true); f.registry.export.mockRejectedValueOnce(new Error("secret=/private/raw/path"));
    const failed = await f.call<{ ok: boolean; message: string }>(IPC.codingResultExport, f.record);
    expect(failed.ok).toBe(false); expect(failed.message).not.toMatch(/secret=|private\/raw/);
  });

  it("does not let an old chooser or cleanup retire a newly recreated project's pending picker", async () => {
    const f = setup(), first = deferred<string | null>(), second = deferred<string | null>();
    f.chooseFolder.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const old = f.call(IPC.projectCodingWorkspaceChoose, f.first);
    await f.api.forgetProject(f.first);
    const next = f.call<ProjectCodingWorkspaceState>(IPC.projectCodingWorkspaceChoose, f.first);
    first.resolve(f.source); await expect(old).rejects.toThrow("choice changed");
    expect(await f.call(IPC.projectCodingWorkspaceState, f.first)).toMatchObject({ canChoose: false });
    second.resolve(f.other); expect((await next).folder?.path).toBe(fs.realpathSync.native(f.other));
  });

  it("treats a never-created unsupported registry as absent, while surfacing every actual cleanup failure", async () => {
    const f = setup();
    f.results.mockRejectedValueOnce(new CodingResultRegistryError("unsupported"));
    await expect(f.api.reset()).resolves.toBeUndefined();
    f.results.mockRejectedValueOnce(new CodingResultRegistryError("unsupported"));
    await expect(f.api.forgetProject(f.first)).resolves.toBeUndefined();
    await f.call(IPC.codingResultsState, f.first);
    f.registry.reset.mockRejectedValueOnce(new Error("/private/raw/cleanup"));
    await expect(f.api.reset()).rejects.toThrow("Some coding reviews could not be cleared");
    f.results.mockRejectedValueOnce(new CodingResultRegistryError("unsupported"));
    await expect(f.api.reset()).rejects.toThrow("Some coding reviews could not be cleared");
  });

  it("notifies the host after each folder mutation and before renderer notification or asynchronous cleanup", async () => {
    const f = setup();
    const events: string[] = [];
    f.changed.mockImplementation(() => { events.push("render"); });
    f.folderChanged.mockImplementation(id => {
      if (id) expect(f.folders.state(id)?.path).toBe(fs.realpathSync.native(f.source));
      events.push("host");
    });
    await f.call(IPC.projectCodingWorkspaceChoose, f.first);
    expect(events.slice(events.indexOf("host"), events.indexOf("host") + 2)).toEqual(["host", "render"]);
    f.folderChanged.mockImplementation(id => { if (id) expect(f.folders.state(id)).toBeNull(); events.push("host"); });
    events.length = 0;
    await f.call(IPC.projectCodingWorkspaceForget, f.first);
    expect(events).toEqual(["host", "render"]);
    f.registry.reset.mockImplementation(async () => { expect(f.folderChanged).toHaveBeenLastCalledWith(undefined); });
    await f.api.reset();
    expect(f.changed).toHaveBeenCalled();
  });
});
