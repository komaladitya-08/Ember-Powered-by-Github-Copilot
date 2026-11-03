import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type MemoryOwnership = "waiting" | "ready" | "locked";

/** Check the account behind the same credential that Copilot authenticated. Logins can be reassigned. */
export async function githubMemoryAccount(
  fetch: (url: string, init: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>,
  token: string,
  login: string,
): Promise<number | null> {
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      redirect: "error", signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) return null;
    const account = await response.json() as { id?: unknown; login?: unknown } | null;
    if (!account || typeof account.login !== "string" || account.login.toLowerCase() !== login.toLowerCase()) return null;
    return typeof account.id === "number" && Number.isSafeInteger(account.id) && account.id > 0 ? account.id : null;
  } catch { return null; }
}

/** One local graph, bound to a verified GitHub account before it can be read or changed. */
export class MemoryOwner {
  private account: string | null = null;
  private status: MemoryOwnership = "waiting";
  private verifiedOwner = false;
  private readonly file: string;

  constructor(private readonly dir: string) { this.file = path.join(dir, "memory-owner"); this.pause(); }

  get state(): MemoryOwnership { return this.status; }
  get ready(): boolean { return this.status === "ready"; }
  /** A disconnect can precede sign-out cleanup. Unknown and mismatched data require an explicit local erase. */
  get mayEraseOnSignOut(): boolean { return this.verifiedOwner; }

  pause(): void { this.account = null; this.refresh(false); }

  /** The graph and vectors must already be gone. */
  clear(): void {
    if (this.hasData()) throw new Error("Saved memory is still present.");
    fs.rmSync(this.file, { force: true });
    this.verifiedOwner = false;
  }

  verify(id: number | null, create: boolean): void {
    this.account = id === null ? null : crypto.createHash("sha256").update(`github-account:${id}`).digest("hex");
    this.verifiedOwner = false;
    this.refresh(create);
  }

  refresh(create: boolean): void {
    this.status = "waiting";
    try {
      if (!this.account) {
        if (this.hasData()) this.status = "locked";
        return;
      }
      const owner = this.readOwner();
      if (owner === this.account) {
        this.status = "ready";
        this.verifiedOwner = true;
        return;
      }
      this.verifiedOwner = false;
      // A previous build or interrupted write may have left a graph or vectors without a trustworthy owner.
      if (this.hasData()) { this.status = "locked"; return; }
      if (!create) return;
      const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tmp, `${this.account}\n`, { mode: 0o600, flag: "wx", flush: true });
        fs.renameSync(tmp, this.file);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      this.status = "ready";
      this.verifiedOwner = true;
    } catch {
      this.status = "locked";
      this.verifiedOwner = false;
    }
  }

  private readOwner(): string | null {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.size > 65) return null;
      return fs.readFileSync(this.file, "utf8").trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private hasData(): boolean {
    for (const name of ["memory.json", "memory-vectors.json"]) for (const suffix of ["", ".broken", ".tmp"]) {
      try { fs.lstatSync(path.join(this.dir, name + suffix)); return true; }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    }
    return false;
  }
}
