/**
 * remote.yml's triggers and jobs, checked against the code they run. The commands, SSH and WSL integration suites run
 * only in remote.yml (ci.yml's integration run sets none of their variables), and remote.yml runs on a pull request or
 * a push to main only when it changes a file under its `paths` filter. So every file those suites load must be under
 * the filter, or a change to it alone merges with the suites unrun (cross-review X16): the test files' import closure
 * (esbuild's metafile, as scripts/build-app.mjs bundles), the bundles the suites run, vitest's own set-up, the scripts
 * the jobs run and the repository files the suites and scripts read by name.
 */

import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const wf = fs.readFileSync(path.join(root, ".github/workflows/remote.yml"), "utf8");
const on = wf.slice(wf.indexOf("\non:\n"), wf.indexOf("\npermissions:"));

/** The `paths` list of one trigger in remote.yml's `on:` block. */
function pathsOf(event: "push" | "pull_request"): string[] {
  const start = on.indexOf(`\n  ${event}:\n`);
  expect(start, event).toBeGreaterThan(0);
  const next = on.slice(start + 1).search(/\n {2}[\w-]+:/);
  const block = next < 0 ? on.slice(start) : on.slice(start, start + 1 + next);
  const list = block.slice(block.indexOf("\n    paths:\n"));
  return [...list.matchAll(/^ {6}- "([^"]+)"$/gm)].map(m => m[1]);
}

/**
 * A `paths` pattern as GitHub matches it, for the forms remote.yml uses: `**` any characters, `*` any but `/`, the
 * rest literal. Anything else GitHub gives a meaning (`?`, `+`, `[]`, `!`, `{}`) throws, so it is never misread here.
 */
function pathPattern(glob: string): RegExp {
  if (/[?+[\]!{}\\]/.test(glob) || glob.startsWith("/")) throw new Error(`a paths pattern this check can't read: ${glob}`);
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith("**", i)) { re += ".*"; i++; } else if (glob[i] === "*") re += "[^/]*";
    else re += glob[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Every file of the repository (forward slashes), without what git ignores here: dependencies, builds and caches. */
function repoFiles(): string[] {
  const skip = new Set(["node_modules", "dist", ".git", ".cache", "out", "coverage"]);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(rel); } else if (e.isFile()) out.push(rel);
    }
  };
  walk("");
  return out;
}

/** The plain-Node bundles the suites run (`npm run build`), by output file, and the entry scripts/build-app.mjs builds each from. */
const BUNDLES: Record<string, string> = {
  "ember-remote.cjs": "app/remote/main.ts",
  "askpass.cjs": "app/askpass/main.ts",
  "remote-link.cjs": "app/main/remote/link-worker.ts",
  "job-host.cjs": "app/main/commands/run/job-host.ts",
};

/** What the repository has at the root that the suites' runs depend on: npm's, TypeScript's and vitest's set-up. */
const CONFIG = ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts"];

/** Repository paths named in source text: as one string ("test/fixtures/x.py") or as join(ROOT, "test", "fixtures", …). */
function namedPaths(text: string): string[] {
  const out = [...text.matchAll(/["'`]((?:app|test|scripts|sidecar|packages|resources|packaging|assets)\/[\w./-]+)["'`]/g)].map(m => m[1]);
  for (const m of text.matchAll(/join\(\s*(?:ROOT|root)\s*,((?:\s*"[\w.-]+"\s*,?)+)\)/g)) {
    out.push([...m[1].matchAll(/"([\w.-]+)"/g)].map(s => s[1]).join("/"));
  }
  return out.filter(p => !/^(dist|node_modules)\//.test(p) && fs.existsSync(path.join(root, p)) && fs.statSync(path.join(root, p)).isFile());
}

/** Every file of the repository the remote.yml suites need, and why. */
async function neededFiles(): Promise<Map<string, string>> {
  const needed = new Map<string, string>();
  const need = (file: string, why: string) => { if (!needed.has(file)) needed.set(file, why); };
  // The jobs' text without comments (which say what a step is for, and name files too).
  const commands = wf.slice(wf.indexOf("\njobs:\n")).split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
  const suites = [...new Set(commands.match(/test\/integration\/[\w.-]+\.test\.ts/g) ?? [])];
  expect(suites.length).toBeGreaterThan(8);
  const run = [...new Set(commands.match(/scripts\/[\w./-]+\.(?:mjs|sh)/g) ?? [])];
  // npm run build is scripts/build-app.mjs; what it builds that the suites run is BUNDLES, whose closure is below.
  expect(commands).toContain("npm run build");
  const scripts = [...run, "scripts/build-app.mjs"];
  const buildApp = fs.readFileSync(path.join(root, "scripts/build-app.mjs"), "utf8");
  for (const [out, entry] of Object.entries(BUNDLES)) {
    expect(buildApp, `scripts/build-app.mjs builds ${out} from ${entry}`).toContain(`"${entry}"`);
    expect(buildApp, `scripts/build-app.mjs builds ${out}`).toContain(out);
  }
  const entries = [...suites, ...Object.values(BUNDLES), "vitest.config.ts", "test/warm-text.ts", ...scripts.filter(s => s.endsWith(".mjs"))];
  const r = await build({
    entryPoints: entries, bundle: true, write: false, metafile: true, platform: "node", format: "esm", absWorkingDir: root,
    outdir: path.join(os.tmpdir(), "ember-remote-closure"), logLevel: "silent", packages: "external", external: ["*.node"],
    loader: { ".py": "text", ".ps1": "text", ".cs": "text", ".sh": "text", ".html": "text", ".css": "text", ".svg": "text", ".png": "file" },
  });
  const inputs = Object.keys(r.metafile.inputs).filter(f => !f.includes("node_modules/"));
  for (const f of inputs) need(f, "loaded by a remote.yml suite, a bundle it runs or a script the jobs run");
  for (const f of CONFIG) need(f, "set-up every run reads");
  for (const s of scripts) need(s, "run by a remote.yml job");
  // Shell scripts run others by path (rebuild-el8.sh runs check-symvers.sh).
  for (const s of scripts.filter(x => x.endsWith(".sh"))) {
    for (const m of fs.readFileSync(path.join(root, s), "utf8").matchAll(/scripts\/[\w./-]+\.(?:mjs|sh)/g)) need(m[0], `run by ${s}`);
  }
  // Files read by name at run time: by the suites (fixtures, the bootstrap, the askpass helper's source) and by the
  // scripts the jobs run themselves (the remote parts' Python files). Not the entries build-app.mjs names for the
  // app's other bundles, nor layout.mjs's staging lists: no suite runs those.
  for (const f of [...inputs.filter(x => x.startsWith("test/")), ...run]) {
    for (const p of namedPaths(fs.readFileSync(path.join(root, f), "utf8"))) need(p, `read by ${f}`);
  }
  // A suite runs a bundle by its file name: each must be one of BUNDLES (whose closure is checked above).
  for (const f of inputs.filter(x => x.startsWith("test/"))) {
    // (Not a pgrep pattern's "[e]mber-remote.cjs".)
    for (const m of fs.readFileSync(path.join(root, f), "utf8").matchAll(/(?<![\w\]-])[\w-]+\.cjs\b/g)) {
      expect(Object.keys(BUNDLES), `${f} runs ${m[0]}: add its entry to BUNDLES`).toContain(m[0]);
    }
  }
  return needed;
}

describe("remote.yml's paths filter (cross-review X16)", () => {
  const push = pathsOf("push");
  const pr = pathsOf("pull_request");

  it("reads GitHub's pattern forms as GitHub does", () => {
    expect(pathPattern("app/main/hands/**").test("app/main/hands/system.ts")).toBe(true);
    expect(pathPattern("app/main/hands/**").test("app/main/hands/deep/x.ts")).toBe(true);
    expect(pathPattern("app/main/hands/**").test("app/main/handsfree.ts")).toBe(false);
    expect(pathPattern("test/integration/ssh-*").test("test/integration/ssh-windows.test.ts")).toBe(true);
    expect(pathPattern("test/integration/ssh-*").test("test/integration/ssh/x.ts")).toBe(false);
    expect(pathPattern("app/main/admin.ts").test("app/main/adminXts")).toBe(false);
    expect(() => pathPattern("app/**/!x")).toThrow(/can't read/);
  });

  it("is the same list for pushes and pull requests", () => {
    expect(push.length).toBeGreaterThan(20);
    expect(pr).toEqual(push);
  });

  it("names only files that exist", () => {
    const files = repoFiles();
    for (const p of push) expect(files.some(f => pathPattern(p).test(f)), `${p} matches no file`).toBe(true);
  });

  it("covers every file the SSH, WSL and commands suites load, run or read", async () => {
    const patterns = push.map(pathPattern);
    const missing = [...(await neededFiles())].filter(([f]) => !patterns.some(p => p.test(f))).map(([f, why]) => `${f} (${why})`);
    expect(missing, "add these to both paths lists in .github/workflows/remote.yml").toEqual([]);
  }, 60_000);
});

describe("Windows SSH to a real Linux kernel, in remote.yml's WSL2 job (release follow-up)", () => {
  /** A job's text, from its key to the next job's. */
  const job = (name: string) => {
    const start = wf.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(0);
    const next = wf.slice(start + 1).search(/\n {2}[\w-]+:\n/);
    return next < 0 ? wf.slice(start) : wf.slice(start, start + 1 + next);
  };
  const steps = (text: string) => text.split(/\n {6}- /).slice(1);
  const wsl2 = job("wsl2-windows");
  const all = steps(wsl2);
  const at = (has: string) => { const i = all.findIndex(s => s.includes(has)); expect(i, has).toBeGreaterThanOrEqual(0); return i; };

  it("keeps the WSL tests as they were: first, on a stopped distro with nothing of the test's own installed", () => {
    const wslTests = at("test/integration/wsl.test.ts");
    expect(all[wslTests]).toContain('EMBER_WSL_TEST: "1"');
    expect(wsl2).toContain('"EMBER_WSL_EXPECT_STOPPED=1"');
    // setup-wsl installs no sshd: it would start with the distro's systemd before the WSL tests.
    expect(all[at("Vampire/setup-wsl@")]).toMatch(/\n {10}additional-packages: util-linux python3 git$/);
    for (const later of ["ssh-keygen.exe", "openssh-server", "sleep', 'infinity'", "StrictHostKeyChecking=accept-new", "remote-parts.mjs", "ssh-windows.test.ts"]) {
      expect(at(later), later).toBeGreaterThan(wslTests);
    }
  });

  it("sets up sshd in the distro on port 2222 for its non-root user, with the runner's new Windows key", () => {
    const key = all[at("ssh-keygen.exe")];
    expect(key).toContain("shell: pwsh");
    expect(key).toContain(`& "$ssh\\ssh-keygen.exe" -q -t ed25519 -N '' -f "$dir\\id_ed25519"`);
    expect(key).toContain('Add-Content -Path "$dir\\config" -Value "Host 127.0.0.1", "  User ember"');
    const sshd = all[at("openssh-server")];
    expect(sshd).toContain("wsl.exe -d Ubuntu-22.04 -u root --exec /bin/bash -euo pipefail -s");
    expect(sshd).toContain("printf '%s\\n' 'Port 2222' > /etc/ssh/sshd_config.d/ember-ci.conf");
    expect(sshd).toContain("/home/ember/.ssh/authorized_keys");
    expect(sshd).toContain("systemctl is-active ssh");
    // WSL stops an idle distro (no wsl.exe attached) after 15 s, sshd with it: one stays attached for the job.
    const alive = all[at("sleep', 'infinity'")];
    expect(alive).toContain("Start-Process -FilePath wsl.exe -ArgumentList '-d', 'Ubuntu-22.04', '--exec', 'sleep', 'infinity' -WindowStyle Hidden");
    expect(alive).not.toMatch(/-NoNewWindow|-Redirect/);
    expect(all[at("StrictHostKeyChecking=accept-new")]).toContain("-p 2222 127.0.0.1");
  });

  it("runs the Windows SSH suite there with the remote parts built, and requires the hello", () => {
    expect(at("node scripts/package/remote-parts.mjs")).toBeLessThan(at("ssh-windows.test.ts"));
    const suite = all[at("ssh-windows.test.ts")];
    expect(suite).toContain("run: node scripts/run-integration.mjs test/integration/ssh-windows.test.ts\n");
    for (const v of ['EMBER_SSH_TEST: "1"', 'EMBER_TEST_ALLOW_LOOPBACK_SSH: "1"', 'EMBER_SSH_TEST_EXPECT_HELLO: "1"']) expect(suite).toContain(v);
    // WSL1's emulated 4.4 kernel must be refused there, before anything is installed.
    const wsl1 = steps(job("wsl-windows")).find(s => s.includes("ssh-windows.test.ts"));
    expect(wsl1).toContain('EMBER_SSH_TEST_EXPECT_HELLO: "0"');
    const test = fs.readFileSync(path.join(root, "test/integration/ssh-windows.test.ts"), "utf8");
    expect(test).toContain("process.env.EMBER_SSH_TEST_EXPECT_HELLO");
  });
});
