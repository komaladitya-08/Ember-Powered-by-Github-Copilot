/** Fail closed unless the exact tag and commit passed the release's required workflow jobs. */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const remoteJobs = [
  "SSH/WSL unit tests (ubuntu-24.04)", "SSH/WSL unit tests (windows-2022)", "SSH/WSL unit tests (macos-15)",
  "Commands on Linux (Ubuntu 24.04)", "Commands on Linux (rockylinux:8, util-linux 2.32)",
  "SSH to Linux (sshd on localhost, Ubuntu 24.04)", "SSH to RHEL 8 (rockylinux:8 container)",
  "SSH from RHEL 8's client (OpenSSH 8.0, rockylinux:8)", "SSH to a Wayland session (headless mutter)",
  "WSL1, Windows commands and Windows SSH (windows-2022)", "WSL2 (windows-2025)",
  "Commands and SSH on macOS (macos-15)",
];

/** Missing or still running is pending; failures, stale tags and skipped required jobs fail closed. */
export function assess(runs, jobs, { tag, sha, workflow, requireArm = true }) {
  const matching = runs.filter(r => r.event === "push" && r.head_branch === tag)
    .sort((a, b) => b.id - a.id);
  const run = matching[0];
  if (!run) return { state: "pending", reason: "no tag push run found" };
  if (run.head_sha !== sha) return { state: "failed", reason: "latest tag run is for a different commit" };
  if (run.status !== "completed") return { state: "pending", reason: `run ${run.id} is ${run.status}` };
  if (run.conclusion !== "success") return { state: "failed", reason: `run ${run.id} concluded ${run.conclusion}` };
  if (!jobs) return { state: "jobs", id: run.id };
  const required = workflow === "ci" ? ["Publish the release (v* tags, after every other job passed)"] : [
    ...remoteJobs, ...(requireArm ? ["SSH to Linux arm64 (sshd on localhost)"] : []),
  ];
  for (const name of required) {
    const matches = jobs.filter(j => j.name === name);
    if (matches.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== "success") {
      return { state: "failed", reason: `required job ${name} missing, incomplete or unsuccessful` };
    }
  }
  // WSLg is an artefacts-only probe; arm64 is optional only where EMBER_ARM64_RUNNER is explicitly 'none'.
  return { state: "passed", id: run.id };
}

function api(endpoint, key) {
  const records = [];
  for (let page = 1; ; page++) {
    const result = JSON.parse(execFileSync("gh", ["api", `${endpoint}&page=${page}`], { encoding: "utf8" }));
    if (!Array.isArray(result[key])) throw new Error(`GitHub omitted ${key}`);
    records.push(...result[key]);
    if (result[key].length < 100) return records;
  }
}

async function main() {
  const [workflow, tag, sha] = process.argv.slice(2);
  if (!/^(remote|ci)$/.test(workflow || "") || !/^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/.test(tag || "") || !/^[a-f0-9]{40}$/.test(sha || "") || !/^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY || "")) {
    throw new Error("invalid workflow, release tag, commit or repository");
  }
  const args = { workflow, tag, sha, requireArm: process.env.EMBER_ARM64_RUNNER !== "none" };
  const base = `repos/${process.env.GITHUB_REPOSITORY}/actions`;
  const deadline = Date.now() + 20 * 60_000;
  while (true) {
    const runs = api(`${base}/workflows/${workflow}.yml/runs?event=push&branch=${encodeURIComponent(tag)}&per_page=100`, "workflow_runs");
    let result = assess(runs, null, args);
    if (result.state === "jobs") {
      const jobs = api(`${base}/runs/${result.id}/jobs?per_page=100`, "jobs");
      result = assess(runs, jobs, args);
    }
    console.log(`${workflow} gate: ${result.reason || result.state}`);
    if (result.state === "passed") return;
    if (result.state === "failed" || Date.now() >= deadline) throw new Error(`${workflow} release gate: ${result.reason}`);
    await new Promise(resolve => setTimeout(resolve, 15_000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(err => { console.error(err.message); process.exitCode = 1; });
