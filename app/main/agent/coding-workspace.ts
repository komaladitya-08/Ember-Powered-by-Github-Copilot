/** A separately granted, encrypted coding workspace. Old selected-file consent is never reused. */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { SecretBox } from "./auth";
import { projectCommandFolder } from "./project";
import { ProjectWorkspaceStore } from "./project-workspaces";

export type CodingWorkspace = ReturnType<typeof projectCommandFolder>;
const NAME = "Coding workspace";

export class CodingWorkspaceStore {
  private readonly dir: string;
  private readonly store: ProjectWorkspaceStore;
  constructor(private readonly privateDir: string, box: SecretBox, asyncKeyring: boolean) {
    this.dir = path.join(privateDir, "coding-workspaces");
    this.store = new ProjectWorkspaceStore(this.dir, box, asyncKeyring);
  }
  private prepare(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(fs.realpathSync(this.dir)) !== fs.realpathSync(this.privateDir)) {
      throw new Error("Invalid coding workspace storage directory");
    }
  }
  async load(scope: string): Promise<CodingWorkspace | null> {
    this.prepare();
    const entries = await this.store.list(scope);
    const folder = entries.find(e => e.name === NAME)?.folder;
    return folder ? projectCommandFolder(folder, this.privateDir) : null;
  }
  async save(scope: string, folder: CodingWorkspace, current: () => boolean): Promise<void> {
    this.prepare();
    await this.store.write(scope, [{ name: NAME, files: [], folder: folder.path, exchange: null }], () => current() && folder.current());
  }
  async forget(scope: string): Promise<void> {
    this.prepare();
    await this.store.write(scope, [], () => true);
    // The underlying store preserves corrupt records for recovery. Forget must remove those copies too.
    const prefix = `project-workspaces-${scope}.bin.broken`;
    for (const name of fs.readdirSync(this.dir)) {
      if (name === prefix || (name.startsWith(prefix + "-") && /^[0-9a-f-]{36}$/i.test(name.slice(prefix.length + 1)))) {
        fs.rmSync(path.join(this.dir, name), { force: true });
      }
    }
  }
}

/** Best-effort branch label, never required for non-Git folders or for starting work. */
export function codingBranch(folder: CodingWorkspace): Promise<string | null> {
  return new Promise(resolve => {
    execFile("git", ["-C", folder.path, "symbolic-ref", "--quiet", "--short", "HEAD"],
      { timeout: 3000, maxBuffer: 4096, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (err, stdout) => {
        const branch = stdout.trim();
        resolve(!err && folder.current() && branch.length <= 200 && branch && !/[\p{Cc}\p{Cf}]/u.test(branch) ? branch : null);
      });
  });
}
