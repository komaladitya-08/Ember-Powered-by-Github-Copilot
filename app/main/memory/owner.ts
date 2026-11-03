import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type MemoryOwnership = "waiting" | "ready" | "locked";

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

  verify(login: string | null, create: boolean): void {
    this.account = login ? crypto.createHash("sha256").update(`github:${login.toLowerCase()}`).digest("hex") : null;
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
