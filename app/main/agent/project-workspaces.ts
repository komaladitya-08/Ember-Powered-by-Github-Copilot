/** Explicit, encrypted project checkpoints. A workspace never restores permission to take an action. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SecretBox } from "./auth";
import { PROJECT_FILES, ProjectInputError, projectRequest } from "./project";
import { memoryRefusal } from "../memory/guard";

export const workspaceName = z.string().trim().min(1).max(64)
  .refine(name => !/[\p{Cc}\p{Cf}]/u.test(name) && !memoryRefusal(name));

const exchange = projectRequest.extend({ answer: z.string().max(24_080) });
const workspace = z.object({
  name: workspaceName,
  files: z.array(z.string().min(1).max(4096)).max(PROJECT_FILES),
  folder: z.string().min(1).max(4096).nullable(),
  exchange: exchange.nullable(),
}).strict();
const MAX_WORKSPACES = 8;
const MAX_BYTES = 1_048_576;
const scopeKey = z.string().regex(/^[0-9a-f]{64}$/);
const library = z.object({ version: z.literal(1), scope: scopeKey, entries: z.array(workspace).max(MAX_WORKSPACES) }).strict();

export type ProjectExchange = z.infer<typeof exchange>;
export type ProjectWorkspace = z.infer<typeof workspace>;

export const workspaceAction = z.union([
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.enum(["save", "open", "forget"]), name: workspaceName }).strict(),
]);

/** Stores only user-requested metadata and the last completed project exchange, with no plaintext fallback. */
export class ProjectWorkspaceStore {
  constructor(private dir: string, private box: SecretBox, private asyncKeyring: boolean) {}

  private file(scope: string): string {
    return path.join(this.dir, "project-workspaces-" + scopeKey.parse(scope) + ".bin");
  }

  private async requireKeyring(): Promise<void> {
    if (this.box.getSelectedStorageBackend?.() === "basic_text" ||
        !(this.asyncKeyring ? await this.box.isAsyncEncryptionAvailable?.() : this.box.isEncryptionAvailable())) {
      throw new ProjectInputError("A system keyring is required to keep project workspaces.");
    }
  }

  async list(scope: string): Promise<ProjectWorkspace[]> {
    const file = this.file(scope);
    let fd: number;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    let bytes: Buffer;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Invalid workspace file");
      bytes = Buffer.alloc(stat.size + 1);
      if (fs.readSync(fd, bytes) !== stat.size) throw new Error("Workspace file changed");
      bytes = bytes.subarray(0, stat.size);
    } finally {
      fs.closeSync(fd);
    }
    await this.requireKeyring();
    const text = this.asyncKeyring && this.box.decryptStringAsync
      ? (await this.box.decryptStringAsync(bytes)).result : this.box.decryptString(bytes);
    const data = library.parse(JSON.parse(text));
    if (data.scope !== scope) throw new Error("Workspace owner changed");
    return data.entries;
  }

  async write(scope: string, entries: ProjectWorkspace[], current: () => boolean): Promise<void> {
    if (entries.length > MAX_WORKSPACES) throw new ProjectInputError("Keep up to eight saved workspaces. Forget one before saving another.");
    const file = this.file(scope);
    if (!entries.length) {
      if (!current()) throw new ProjectInputError("Workspace request cancelled.");
      fs.rmSync(file, { force: true });
      return;
    }
    const data = library.parse({ version: 1, scope, entries });
    await this.requireKeyring();
    const text = JSON.stringify(data);
    const bytes = this.asyncKeyring && this.box.encryptStringAsync ? await this.box.encryptStringAsync(text) : this.box.encryptString(text);
    if (bytes.length > MAX_BYTES) throw new ProjectInputError("The saved workspaces are too large.");
    if (!current()) throw new ProjectInputError("Workspace request cancelled.");
    const temporary = path.join(this.dir, ".ember-workspaces-" + randomUUID());
    try {
      fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600, flush: true });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
