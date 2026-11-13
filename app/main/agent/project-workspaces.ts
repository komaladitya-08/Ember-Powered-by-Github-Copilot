/** Explicit, encrypted project checkpoints. A workspace never restores permission to take an action. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
/**
 * `scope`: whose library it is, which also names its file. `holder`: the account or credential its answers were given
 * to, written only where that is another thing than the owner (a model provider, owned by the service; a GitHub
 * account's file is as it always was).
 */
const library = z.object({ version: z.literal(1), scope: scopeKey, holder: scopeKey.optional(), entries: z.array(workspace).max(MAX_WORKSPACES) }).strict();

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Whose the saved workspaces are, and whose a saved answer is, for the connection in force (integrations-r9-3).
 *
 * `library`: the GitHub account, or the model service by whose it is (the user's, the organisation's), its type and its
 * address. Never its key: the owner used to be a hash of the provider's whole config, so a replaced or removed key, or
 * another wire API, left every saved workspace in a file nothing listed or removed, which the person could not forget.
 *
 * `holder`: the account, or that whole config, key included, as before: an answer goes to no other service, address,
 * key or account than the one that gave it (integrations-r1), from the Projects pane and from a saved workspace alike.
 * Both are hashes; neither holds the key. null: nothing verified is connected.
 */
export function workspaceOwners(provider: { kind: string; config: { type?: string; baseUrl: string } } | null, githubAccountId: number | null): { library: string; holder: string } | null {
  if (provider) {
    return {
      library: sha(JSON.stringify(["workspaces", provider.kind, provider.config.type ?? "openai", provider.config.baseUrl])),
      holder: sha(JSON.stringify([provider.kind, provider.config])),
    };
  }
  if (githubAccountId === null) return null;
  const account = sha(`github:${githubAccountId}`);
  return { library: account, holder: account };
}

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

  /** The saved workspaces of `owner` as `holder` may have them (read()'s entries). */
  async list(owner: string, holder = owner): Promise<ProjectWorkspace[]> {
    return (await this.read(owner, holder)).entries;
  }

  /**
   * The saved workspaces of `owner` (workspaceOwners' library). An answer saved for another `holder` than the one in
   * force is left out, and `left` names the workspaces it was left out of: their files and folder are the person's
   * whatever key the provider has now, the answer is not (integrations-r9-3).
   */
  async read(owner: string, holder = owner): Promise<{ entries: ProjectWorkspace[]; left: string[] }> {
    let data = await this.load(this.file(owner));
    if (!data && holder !== owner) {
      // A library saved before the service owned it is named for, and owned by, the whole config: with the key it was
      // saved with still in force it is found under that name, and becomes the service's here.
      const earlier = await this.load(this.file(holder));
      if (earlier) {
        if (earlier.scope !== holder || earlier.holder !== undefined) throw new Error("Workspace owner changed");
        data = { version: 1, scope: owner, holder, entries: earlier.entries };
        await this.save(data);
        fs.rmSync(this.file(holder), { force: true });
      }
    }
    if (!data) return { entries: [], left: [] };
    if (data.scope !== owner) throw new Error("Workspace owner changed");
    if ((data.holder ?? data.scope) === holder) return { entries: data.entries, left: [] };
    return { entries: data.entries.map(e => ({ ...e, exchange: null })), left: data.entries.filter(e => e.exchange).map(e => e.name) };
  }

  /** A library file's contents, or null when there is no such file. One that doesn't read is set aside. */
  private async load(file: string): Promise<z.infer<typeof library> | null> {
    let fd: number;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
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
    try {
      const text = this.asyncKeyring && this.box.decryptStringAsync
        ? (await this.box.decryptStringAsync(bytes)).result : this.box.decryptString(bytes);
      return library.parse(JSON.parse(text));
    } catch {
      // Damaged, or from a keyring that is gone: every action reads the library first, so left in place it could never be
      // replaced or forgotten. Moved aside, not deleted, as memory does (memory/store.ts).
      fs.renameSync(file, `${file}.broken`);
      throw new ProjectInputError("I couldn't read your saved workspaces, so I set them aside. You can save new ones.");
    }
  }

  /** Saves `owner`'s library whole, its answers as `holder`'s (the account or credential in force). */
  async write(owner: string, entries: ProjectWorkspace[], current: () => boolean, holder = owner): Promise<void> {
    if (entries.length > MAX_WORKSPACES) throw new ProjectInputError("Keep up to eight saved workspaces. Forget one before saving another.");
    if (!entries.length) {
      if (!current()) throw new ProjectInputError("Workspace request cancelled.");
      fs.rmSync(this.file(owner), { force: true });
      return;
    }
    await this.save(library.parse({ version: 1, scope: owner, ...(holder !== owner ? { holder } : {}), entries }), current);
  }

  /** Encrypts and writes a library to its owner's file, whole and atomically; nothing in plain text, ever. */
  private async save(data: z.infer<typeof library>, current: () => boolean = () => true): Promise<void> {
    await this.requireKeyring();
    const text = JSON.stringify(data);
    const bytes = this.asyncKeyring && this.box.encryptStringAsync ? await this.box.encryptStringAsync(text) : this.box.encryptString(text);
    if (bytes.length > MAX_BYTES) throw new ProjectInputError("The saved workspaces are too large.");
    if (!current()) throw new ProjectInputError("Workspace request cancelled.");
    const temporary = path.join(this.dir, ".ember-workspaces-" + randomUUID());
    try {
      fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600, flush: true });
      fs.renameSync(temporary, this.file(data.scope));
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
