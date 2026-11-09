/** Verify the immutable audit worktree before any probe is bundled; Git is injectable only at its process boundary. */
import { spawnSync } from "node:child_process";

/** The main commit whose command decisions the audit promises never to weaken. */
export const AUDIT_BASELINE = "4d64d3aff1798d51fdd3bbe19cb212cace028424";

/** Refuse a baseline whose identity or inputs cannot be verified. */
export function assertBaseline(root, spawn = spawnSync) {
  const git = args => {
    const r = spawn("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000 });
    if (r.status !== 0) throw new Error("Use a clean baseline worktree: Git found changes or couldn't verify it.");
    return r.stdout;
  };
  if (git(["rev-parse", "HEAD"]).trim() !== AUDIT_BASELINE) throw new Error("The baseline must be the audit's exact 4d64d3a commit.");
  git(["diff", "--quiet", "HEAD"]);
  // No exclusion rules here: ignored source and build configuration can shadow imports too. --directory keeps
  // intentional dependency trees cheap to list. Only these two roots are permitted, including symlinks to them.
  const untracked = git(["ls-files", "--others", "--directory", "-z"]).split("\0").filter(Boolean);
  if (untracked.some(file => !/^(node_modules|\.cache)(\/|$)/.test(file))) {
    throw new Error("Use a clean baseline worktree: remove untracked or ignored files outside node_modules and .cache.");
  }
}
