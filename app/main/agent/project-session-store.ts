/** Explicit encrypted board checkpoints. Saved metadata never restores a task or an execution grant. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SecretBox } from "./auth";
import { projectSessionSnapshot } from "./project-sessions";
import type { ProjectSessionsState } from "../../shared/project-sessions";

const ownerSchema = z.object({ library: z.string().regex(/^[0-9a-f]{64}$/), holder: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type ProjectSessionOwner = z.infer<typeof ownerSchema>;
const checkpoint = z.object({ version: z.literal(1), owner: ownerSchema, state: projectSessionSnapshot }).strict();
const MAX_BYTES = 1_048_576;
const revisions = new Map<string, number>();
const checkpointName = /^project-sessions-[0-9a-f]{64}\.bin$/;

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return b.isFile() && !b.isSymbolicLink() && b.nlink === 1 && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export class ProjectSessionStore {
  constructor(private readonly dir: string, private readonly box: SecretBox, private readonly asyncKeyring: boolean) {}

  private file(owner: ProjectSessionOwner): string {
    return path.resolve(this.dir, `project-sessions-${ownerSchema.parse(owner).library}.bin`);
  }

  private prepare(): fs.Stats {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The project checkpoint folder is unavailable.");
    return stat;
  }

  private fence(directory: fs.Stats, file: string, revision: number, current: () => boolean): void {
    if ((revisions.get(file) ?? 0) !== revision) throw new Error("Project checkpoint request cancelled.");
    this.directoryFence(directory, current);
  }

  private directoryFence(directory: fs.Stats, current: () => boolean): void {
    if (!current()) throw new Error("Project checkpoint request cancelled.");
    const live = fs.lstatSync(this.dir);
    if (!live.isDirectory() || live.isSymbolicLink() || live.dev !== directory.dev || live.ino !== directory.ino) throw new Error("The project checkpoint folder changed. Try again.");
  }

  private async requireKeyring(operation: "read" | "write"): Promise<void> {
    if (this.box.getSelectedStorageBackend?.() === "basic_text" ||
        (this.asyncKeyring && typeof (operation === "read" ? this.box.decryptStringAsync : this.box.encryptStringAsync) !== "function") ||
        !(this.asyncKeyring ? await this.box.isAsyncEncryptionAvailable?.() : this.box.isEncryptionAvailable())) {
      throw new Error("A system keyring is required to keep project checkpoints.");
    }
  }

  /** Only an explicit user Save action calls this; changing the live board does not write it. */
  async save(owner: ProjectSessionOwner, state: ProjectSessionsState, current: () => boolean): Promise<void> {
    const parsed = checkpoint.parse({ version: 1, owner, state });
    const text = JSON.stringify(parsed);
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("This project checkpoint is too large.");
    const file = this.file(owner), directory = this.prepare();
    const revision = (revisions.get(file) ?? 0) + 1;
    revisions.set(file, revision);
    this.fence(directory, file, revision, current);
    await this.requireKeyring("write");
    this.fence(directory, file, revision, current);
    const bytes = this.asyncKeyring ? await this.box.encryptStringAsync!(text) : this.box.encryptString(text);
    if (bytes.length > MAX_BYTES) throw new Error("This project checkpoint is too large.");
    this.fence(directory, file, revision, current);
    const temporary = path.join(this.dir, `.ember-project-sessions-${randomUUID()}`);
    try {
      fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600, flush: true });
      this.fence(directory, file, revision, current);
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  /** Returns inert history only. In-flight work is interrupted and every old task reference is discarded. */
  async load(owner: ProjectSessionOwner, current: () => boolean): Promise<ProjectSessionsState | null> {
    const file = this.file(owner), directory = this.prepare(), revision = revisions.get(file) ?? 0;
    this.fence(directory, file, revision, current);
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
    let opened: fs.Stats, bytes: Buffer;
    try {
      opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_BYTES || !sameFile(opened, fs.lstatSync(file))) throw new Error("The project checkpoint file is invalid.");
      bytes = Buffer.alloc(opened.size + 1);
      if (fs.readSync(fd, bytes) !== opened.size || !sameFile(opened, fs.fstatSync(fd))) throw new Error("The project checkpoint changed. Try again.");
      bytes = bytes.subarray(0, opened.size);
    } finally { fs.closeSync(fd); }
    await this.requireKeyring("read");
    this.fence(directory, file, revision, current);
    let text: string;
    try { text = this.asyncKeyring ? (await this.box.decryptStringAsync!(bytes)).result : this.box.decryptString(bytes); }
    catch { throw new Error("Couldn't decrypt the project checkpoint. Check your system keyring and try again; the saved file was left in place."); }
    this.fence(directory, file, revision, current);
    if (!sameFile(opened, fs.lstatSync(file))) throw new Error("The project checkpoint changed. Try again.");
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("This project checkpoint is too large.");
    let data: z.infer<typeof checkpoint>;
    try { data = checkpoint.parse(JSON.parse(text)); }
    catch { throw new Error("Couldn't read the project checkpoint. The saved file was left in place; save a new checkpoint or forget it."); }
    if (data.owner.library !== owner.library || data.owner.holder !== owner.holder) throw new Error("This project checkpoint belongs to a different account or model connection. Nothing was opened.");
    const now = Date.now();
    const ids = new Map(data.state.projects.map(project => [project.id, randomUUID()]));
    return {
      selectedProjectId: data.state.selectedProjectId === null ? null : ids.get(data.state.selectedProjectId)!,
      projects: data.state.projects.map(project => {
        const sessionIds = new Map(project.sessions.map(session => [session.id, randomUUID()]));
        return {
          ...project, id: ids.get(project.id)!,
          sessions: project.sessions.map(session => {
            const interrupted = session.status === "queued" || session.status === "running" || session.status === "waiting";
            return { ...session, id: sessionIds.get(session.id)!, taskId: "", ...(interrupted ? {
              status: "stopped" as const, detail: "Interrupted checkpoint. Start a new request to continue.", finishedAt: now,
            } : {}) };
          }),
          ...(project.sequences ? { sequences: project.sequences.map(sequence => ({
            ...sequence, id: randomUUID(),
            ...(sequence.status === "active" ? { status: "interrupted" as const, reason: "interrupted" as const } : {}),
            steps: sequence.steps.map(step => {
              const interrupted = step.status === "queued" || step.status === "running" || step.status === "waiting";
              return { ...step,
                ...(step.sessionId ? { sessionId: sessionIds.get(step.sessionId)! } : {}),
                ...(interrupted ? { status: "interrupted" as const, finishedAt: now } : {}),
              };
            }),
          })) } : {}),
        };
      }),
    };
  }

  /** Forget works even if the keyring is locked or the provider's credential changed. */
  async forget(owner: ProjectSessionOwner, current: () => boolean): Promise<void> {
    const file = this.file(owner), directory = this.prepare(), revision = (revisions.get(file) ?? 0) + 1;
    revisions.set(file, revision);
    this.fence(directory, file, revision, current);
    fs.rmSync(file, { force: true });
  }

  /** Forget everything does not require a connected account and includes saves still waiting on the keyring. */
  async forgetAll(current: () => boolean): Promise<void> {
    const directory = this.prepare(), root = path.resolve(this.dir);
    this.directoryFence(directory, current);
    const files = new Set(fs.readdirSync(this.dir).filter(name => checkpointName.test(name)).map(name => path.join(root, name)));
    for (const file of revisions.keys()) {
      if (path.dirname(file) === root && checkpointName.test(path.basename(file))) files.add(file);
    }
    this.directoryFence(directory, current);
    // Invalidate every pending save before attempting any delete. A partial filesystem failure cannot resurrect one.
    const invalidated = [...files].map(file => {
      const revision = (revisions.get(file) ?? 0) + 1;
      revisions.set(file, revision);
      return { file, revision };
    });
    for (const { file, revision } of invalidated) {
      this.fence(directory, file, revision, current);
      fs.rmSync(file, { force: true });
    }
  }
}
