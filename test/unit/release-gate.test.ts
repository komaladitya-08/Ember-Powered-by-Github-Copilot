import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
// @ts-expect-error This release-time script runs directly in Node without TypeScript declarations.
import { assess } from "../../scripts/package/release-gate.mjs";

const tag = "v1.2.3", sha = "a".repeat(40);
const args = { workflow: "ci", tag, sha };
const run = { id: 2, event: "push", head_branch: tag, head_sha: sha, status: "completed", conclusion: "success" };
const release = { name: "Publish the release (v* tags, after every other job passed)", status: "completed", conclusion: "success" };

describe("release workflow gate", () => {
  it("only accepts a completed successful run and release job on the exact tag and commit", () => {
    expect(assess([run], [release], args).state).toBe("passed");
    expect(assess([], null, args).state).toBe("pending");
    expect(assess([{ ...run, event: "workflow_dispatch" }], null, args).state).toBe("pending");
    expect(assess([{ ...run, head_branch: "other" }], null, args).state).toBe("pending");
    expect(assess([{ ...run, head_sha: "b".repeat(40) }], null, args).state).toBe("failed");
    expect(assess([{ ...run, status: "in_progress" }], null, args).state).toBe("pending");
    for (const conclusion of ["failure", "cancelled", "skipped", null]) expect(assess([{ ...run, conclusion }], null, args).state).toBe("failed");
    expect(assess([run], [], args).state).toBe("failed");
    expect(assess([run], [{ ...release, conclusion: "skipped" }], args).state).toBe("failed");
    expect(assess([run, { ...run, id: 3, head_sha: "b".repeat(40) }], [release], args).state).toBe("failed");
  });
  it("requires the remote safety jobs, even when the workflow says success", () => {
    const remote = { ...args, workflow: "remote", requireArm: false };
    expect(assess([run], [], remote).state).toBe("failed");
    expect(assess([run], null, remote)).toEqual({ state: "jobs", id: 2 });
    const names = [
      "SSH/WSL unit tests (ubuntu-24.04)", "SSH/WSL unit tests (windows-2022)", "SSH/WSL unit tests (macos-15)",
      "Commands on Linux (Ubuntu 24.04)", "Commands on Linux (rockylinux:8, util-linux 2.32)",
      "SSH to Linux (sshd on localhost, Ubuntu 24.04)", "SSH to RHEL 8 (rockylinux:8 container)",
      "SSH from RHEL 8's client (OpenSSH 8.0, rockylinux:8)", "SSH to a Wayland session (headless mutter)",
      "WSL1, Windows commands and Windows SSH (windows-2022)", "WSL2 (windows-2025)", "Commands and SSH on macOS (macos-15)",
    ];
    const jobs = names.map(name => ({ name, status: "completed", conclusion: "success" }));
    expect(assess([run], jobs, remote).state).toBe("passed");
    expect(assess([run], jobs.slice(1), remote).state).toBe("failed");
    expect(assess([run], [{ ...jobs[0], conclusion: "skipped" }, ...jobs.slice(1)], remote).state).toBe("failed");
    expect(assess([run], jobs, { ...remote, requireArm: true }).state).toBe("failed");
    jobs.push({ name: "SSH to Linux arm64 (sshd on localhost)", status: "completed", conclusion: "success" });
    expect(assess([run], jobs, { ...remote, requireArm: true }).state).toBe("passed");
  });
  it("checks out the tag for both manual and automatic npm publishing, independent of the dispatch branch", () => {
    const workflow = fs.readFileSync(".github/workflows/npm.yml", "utf8");
    expect(workflow).toContain("ref: refs/tags/${{ github.event.workflow_run.head_branch || inputs.tag }}");
    expect(workflow).toContain('node release-gate/scripts/package/release-gate.mjs remote "$TAG" "$sha"');
    expect(workflow).toContain('node release-gate/scripts/package/release-gate.mjs ci "$TAG" "$sha"');
    expect(workflow).toContain('working-directory: source/packages/npm');
    expect(workflow).toContain('[ "$sha" != "$RUN_SHA" ]');
    expect(workflow).toContain('if [ "$live_sha" != "$VERIFIED_SHA" ]; then');
    expect(fs.readFileSync(".github/workflows/ci.yml", "utf8")).toContain('release-gate.mjs remote "$GITHUB_REF_NAME" "$(git rev-parse HEAD)"');
    expect(fs.readFileSync(".github/workflows/remote.yml", "utf8")).not.toContain("run-integration.mjs --allow-missing");
  });
  it("refuses invalid tags before querying GitHub", () => {
    for (const bad of ["main", "v1.2.3; touch pwn", "v1.2.3/other"]) {
      const invoke = () => execFileSync(process.execPath, ["scripts/package/release-gate.mjs", "ci", bad, sha], {
        env: { ...process.env, GITHUB_REPOSITORY: "owner/repo" }, stdio: "pipe",
      });
      expect(invoke).toThrow();
    }
  });
  it("a tag checkout resolves lightweight and annotated tags to the tagged source, not a later branch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-release-tag-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
    try {
      git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
      fs.writeFileSync(path.join(dir, "launcher"), "tagged\n"); git("add", "launcher"); git("commit", "-qm", "tagged");
      const tagged = git("rev-parse", "HEAD");
      git("tag", "v1.2.3"); git("tag", "-a", "v1.2.4", "-m", "annotated");
      fs.writeFileSync(path.join(dir, "launcher"), "branch\n"); git("commit", "-qam", "changed launcher");
      for (const ref of ["v1.2.3", "v1.2.4"]) {
        git("checkout", "-q", "--detach", `refs/tags/${ref}`);
        expect(git("rev-parse", "HEAD")).toBe(tagged);
        expect(fs.readFileSync(path.join(dir, "launcher"), "utf8")).toBe("tagged\n");
      }
      expect(() => git("checkout", "-q", "--detach", "refs/tags/v9.9.9")).toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
