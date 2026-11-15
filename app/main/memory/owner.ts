import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type MemoryOwnership = "waiting" | "ready" | "locked";

/**
 * Why saved memory isn't open, so Home can say it truthfully (memory-2, integrations-2): Ember is still connecting
 * (`checking`), nobody is signed in to GitHub (`signed-out`), the user's own model provider or the organisation's model
 * service is in force and memory works only with GitHub Copilot (`own-provider`, `org-provider`), GitHub didn't
 * answer (`unverified`), or the organisation's policy has stopped Ember connecting at all (`lockdown`: it can't be
 * used, or changed while Ember ran; memory-r9-3). Only the last two belong to the saved memory itself: another GitHub
 * account's (`other-account`), or with no owner Ember can read (`unowned`). None of the first five is a reason to
 * erase it; a lockdown may last until an administrator mends the policy, so what is saved can be cleared meanwhile.
 */
export type MemoryOwnerReason = "checking" | "signed-out" | "own-provider" | "org-provider" | "unverified" | "lockdown" | "other-account" | "unowned";
/** Why there is no account to check: what the host says when it has none. */
export type MemoryWait = Exclude<MemoryOwnerReason, "other-account" | "unowned">;

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

/**
 * Whose memory Home's epoch is for (main's `memoryEpoch`, in every MemoryView): Home lets go of a correction draft,
 * an acknowledgement and where focus was when it moves on. It moves on when memory is for another account or for none
 * (signed out, a model provider in force, another account verified), and holds while the same sign-in is checked
 * again (a reconnect: `checking`; a check that failed: `unverified`) and when the same account comes back (memory-8).
 * Memory itself stays closed meanwhile: only `MemoryOwner.ready` opens it.
 */
export class MemoryEpochAccount {
  private id: number | null = null;

  /** The host verified account `id`, or none and why: true when the epoch moves on. */
  verified(id: number | null, why: MemoryWait = "unverified"): boolean {
    if (id === null) return this.paused(why);
    const moved = id !== this.id;
    this.id = id;
    return moved;
  }

  /** No account for now, and why: true when the epoch moves on. */
  paused(why: MemoryWait = "checking"): boolean {
    if (why === "checking" || why === "unverified") return false;
    this.id = null;
    return true;
  }
}

/** One local graph, bound to a verified GitHub account before it can be read or changed. */
export class MemoryOwner {
  private account: string | null = null;
  private status: MemoryOwnership = "waiting";
  private verifiedOwner = false;
  private wait: MemoryWait = "checking";
  private lockedBy: "other-account" | "unowned" | null = null;
  private readonly file: string;

  constructor(private readonly dir: string) { this.file = path.join(dir, "memory-owner"); this.pause(); }

  get state(): MemoryOwnership { return this.status; }
  get ready(): boolean { return this.status === "ready"; }
  /** A disconnect can precede sign-out cleanup. Unknown and mismatched data require an explicit local erase. */
  get mayEraseOnSignOut(): boolean { return this.verifiedOwner; }
  /** Why memory isn't ready (null while it is, or while it waits only for memory to be turned on). */
  get reason(): MemoryOwnerReason | null {
    if (this.status === "ready") return null;
    if (!this.account) return this.wait;
    return this.lockedBy;
  }

  /** No account to check for now: `why` says what Home tells the user meanwhile. */
  pause(why: MemoryWait = "checking"): void { this.account = null; this.wait = why; this.refresh(false); }

  /** The graph and vectors must already be gone. */
  clear(): void {
    if (this.hasData()) throw new Error("Saved memory is still present.");
    fs.rmSync(this.file, { force: true });
    this.verifiedOwner = false;
  }

  /** The verified account's id, or null with why there is none (a model provider in force, GitHub not answering). */
  verify(id: number | null, create: boolean, why: MemoryWait = "unverified"): void {
    this.account = id === null ? null : crypto.createHash("sha256").update(`github-account:${id}`).digest("hex");
    if (id === null) this.wait = why;
    this.verifiedOwner = false;
    this.refresh(create);
  }

  refresh(create: boolean): void {
    this.status = "waiting";
    this.lockedBy = null;
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
      if (this.hasData()) { this.status = "locked"; this.lockedBy = owner === null ? "unowned" : "other-account"; return; }
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
      this.lockedBy = "unowned";
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
    for (const name of ["memory.json", "memory-vectors.json"]) for (const suffix of ["", ".broken", ".broken.2", ".tmp"]) {
      try { fs.lstatSync(path.join(this.dir, name + suffix)); return true; }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    }
    return false;
  }
}
