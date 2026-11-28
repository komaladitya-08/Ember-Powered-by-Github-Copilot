/**
 * Ember's own small record of coding projects and sessions (docs/CODING-APP.md §2 "SessionIndex"): what the SDK
 * doesn't keep about a session (its project, whether it works in the folder or a worktree Ember made, that worktree's
 * branch and path, pinned, archived, unread, the session it came from and who started it). The SDK's own metadata
 * (`listSessions`: summary, times, folder) is merged with it into CodeSessionRow. The file is
 * `<userData>/code/index.json`, mode 0600, written whole through a temporary file and a rename (one write at a time),
 * and checked with zod when read: a file that isn't valid is moved aside, logged, and Ember starts with an empty
 * index (the SDK's sessions are still listed, as rows of no project). Plain Node.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CODE_LIMITS, type CodeActor, type CodeIsolation, type CodeProject } from "../../shared/code";

const Text = (max: number) => z.string().max(max);
const Folder = z.string().min(1).max(4096);

const ProjectSchema = z.object({
  id: Text(64).min(1),
  folder: Folder,
  name: Text(400),
  gitRoot: Folder.optional(),
  repository: Text(400).optional(),
  branch: Text(400).optional(),
  addedAt: z.number().int().nonnegative(),
}).strict();

const SessionSchema = z.object({
  projectId: Text(64).min(1),
  /** The folder the session works in: the project's, or its worktree. */
  folder: Folder,
  isolation: z.enum(["folder", "worktree"]),
  branch: Text(400).optional(),
  baseBranch: Text(400).optional(),
  /** The worktree Ember made (removed with the session). */
  worktree: Folder.optional(),
  /** The repository the worktree belongs to (its `git worktree remove` runs there). */
  gitRoot: Folder.optional(),
  pinned: z.boolean(),
  archived: z.boolean(),
  unread: z.number().int().nonnegative(),
  parentId: Text(200).optional(),
  createdBy: z.enum(["user", "companion", "system"]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  name: Text(CODE_LIMITS.name).optional(),
  permissionMode: z.enum(["manual", "assisted", "allow-all"]).optional(),
  agentMode: z.enum(["interactive", "plan", "autopilot"]).optional(),
  model: Text(200).optional(),
}).strict();

const IndexSchema = z.object({
  version: z.literal(1),
  projects: z.array(ProjectSchema).max(10_000),
  sessions: z.record(Text(200).min(1), SessionSchema),
}).strict();

export type IndexProject = z.infer<typeof ProjectSchema>;
export type IndexSession = z.infer<typeof SessionSchema>;
type IndexFile = z.infer<typeof IndexSchema>;

const EMPTY = (): IndexFile => ({ version: 1, projects: [], sessions: {} });

/** The index's file. */
export const indexFile = (codeDir: string): string => path.join(codeDir, "index.json");

export interface IndexLog { warn(event: string, fields?: Record<string, unknown>): void }

/** The fields a new session's record takes. */
export interface NewSession {
  projectId: string;
  folder: string;
  isolation: CodeIsolation;
  createdBy: CodeActor;
  branch?: string;
  baseBranch?: string;
  worktree?: string;
  gitRoot?: string;
  parentId?: string;
  name?: string;
  permissionMode?: IndexSession["permissionMode"];
  agentMode?: IndexSession["agentMode"];
  model?: string;
}

export class SessionIndex {
  private data: IndexFile = EMPTY();
  private writing: Promise<void> = Promise.resolve();
  /** A write waits its turn and will take every change made meanwhile. */
  private queued = false;

  constructor(private readonly file: string, private readonly log?: IndexLog, private readonly now: () => number = Date.now) {}

  /** Reads the file; a missing one is an empty index, a broken one is moved aside and logged. */
  load(): this {
    let text: string;
    try { text = fs.readFileSync(this.file, "utf8"); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.log?.warn("code.index_unreadable", { code: (err as NodeJS.ErrnoException).code ?? "unknown" });
      this.data = EMPTY();
      return this;
    }
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; /* not JSON: broken, as below */ }
    const parsed = IndexSchema.safeParse(json);
    if (parsed.success) { this.data = parsed.data; return this; }
    this.log?.warn("code.index_corrupt", { bytes: text.length });
    try { fs.renameSync(this.file, `${this.file}.broken-${this.now()}`); } catch { /* keeping it aside is a courtesy; starting empty is what matters */ }
    this.data = EMPTY();
    return this;
  }

  projects(): CodeProject[] {
    return this.data.projects.map(p => ({ id: p.id, folder: p.folder, name: p.name, ...(p.gitRoot ? { gitRoot: p.gitRoot } : {}),
      ...(p.repository ? { repository: p.repository } : {}), ...(p.branch ? { branch: p.branch } : {}) }));
  }

  project(id: string): IndexProject | undefined { return this.data.projects.find(p => p.id === id); }

  /** The project of `folder`, if one is kept. */
  projectAt(folder: string): IndexProject | undefined { return this.data.projects.find(p => p.folder === folder); }

  /** Adds (or, for a folder already kept, refreshes) a project. */
  addProject(p: Omit<IndexProject, "id" | "addedAt">): IndexProject {
    const known = this.projectAt(p.folder);
    if (known) {
      Object.assign(known, p);
      this.save();
      return known;
    }
    const added: IndexProject = { id: crypto.randomUUID(), addedAt: this.now(), ...p };
    this.data.projects.push(added);
    this.save();
    return added;
  }

  removeProject(id: string): boolean {
    const before = this.data.projects.length;
    this.data.projects = this.data.projects.filter(p => p.id !== id);
    if (this.data.projects.length === before) return false;
    this.save();
    return true;
  }

  session(id: string): IndexSession | undefined { return this.data.sessions[id]; }

  sessionIds(): string[] { return Object.keys(this.data.sessions); }

  addSession(id: string, s: NewSession): IndexSession {
    const t = this.now();
    const record: IndexSession = { pinned: false, archived: false, unread: 0, createdAt: t, updatedAt: t, ...s };
    this.data.sessions[id] = SessionSchema.parse(record);
    this.save();
    return this.data.sessions[id];
  }

  /** Changes a session's record; unknown ids change nothing. */
  updateSession(id: string, change: Partial<Omit<IndexSession, "createdAt" | "createdBy" | "projectId">>, touch = true): IndexSession | undefined {
    const s = this.data.sessions[id];
    if (!s) return undefined;
    const next = { ...s, ...change, ...(touch ? { updatedAt: this.now() } : {}) };
    for (const k of Object.keys(next) as (keyof IndexSession)[]) if (next[k] === undefined) delete next[k];
    const checked = SessionSchema.safeParse(next);
    if (!checked.success) return s;
    this.data.sessions[id] = checked.data;
    this.save();
    return checked.data;
  }

  removeSession(id: string): IndexSession | undefined {
    const s = this.data.sessions[id];
    if (!s) return undefined;
    delete this.data.sessions[id];
    this.save();
    return s;
  }

  /** Waits for the writes so far. */
  flushed(): Promise<void> { return this.writing; }

  /**
   * Writes the whole index: a temporary file (0600) renamed over the old one, one write after another. Changes made
   * while a write waits its turn go in that write (it reads the index as it starts), so a count that changes on every
   * event (unread) costs one write at a time, not one each.
   */
  private save(): void {
    if (this.queued) return;
    this.queued = true;
    this.writing = this.writing.then(() => { this.queued = false; return writeAtomic(this.file, JSON.stringify(this.data)); }).catch(err => {
      this.log?.warn("code.index_write_failed", { code: (err as NodeJS.ErrnoException).code ?? "unknown" });
    });
  }
}

/** `text` written to `file` whole or not at all: a temporary file beside it, mode 0600, synced, then renamed over it. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const handle = await fs.promises.open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await fs.promises.chmod(tmp, 0o600);
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
