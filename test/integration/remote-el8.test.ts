// The remote agent on RHEL 8 (§10.2 `ssh-el8`): a rockylinux:8 container reached over ssh, with glibc 2.28, bash as
// sh, platform-python 3.6 and util-linux 2.32 (whose `script` ends its session at stdin's EOF, so the agent keeps the
// run's stdin open). The pinned Node runtime (remote-runtime.json, from nodejs.org, checked) and the parts are installed
// as the bootstrap leaves them; then serve, commands in a PTY with typing, Stop and EOF, the headless desktop "none",
// the sidecars compiling under Python 3.6, and the per-machine state folder. When SA's bootstrap.sh is in the tree, a
// second install racing the first is checked against its `mkdir` lock (§5.1.9 step 1, critique remote-5).
// Skips without EMBER_SSH_TEST; fails when it is "1" and ssh, the remote or the build is missing.
// Run: EMBER_SSH_TEST=1 EMBER_SSH_TEST_HOST=<container> EMBER_SSH_TEST_PORT=2222 EMBER_SSH_TEST_USER=deploy \
//   node scripts/run-integration.mjs test/integration/remote-el8.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AGENT, connectSsh, hello, installParts, installRuntime, partsBuilt, PC_ID, remoteTarget, ROOT, runThrough, runtimeArchive, sshArgs, sshRun, startThrough, versionsDir, type AgentLink } from "./remote-harness";

const required = process.env.EMBER_SSH_TEST === "1";
const enabled = !!process.env.EMBER_SSH_TEST;
/** SA's bootstrap (§5.1.9), when it has landed. */
const BOOTSTRAP = path.join(ROOT, "app/main/remote/scripts/bootstrap.sh");

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The remote is RHEL 8's family (the suite's own check that it runs where it means to). */
function isEl8(): boolean {
  return /^(rhel|rocky|almalinux|centos|ol) 8(\.|$)/.test(sshRun(". /etc/os-release; echo \"$ID $VERSION_ID\"").stdout.trim());
}

describe.skipIf(!enabled)("the remote agent on RHEL 8 (glibc 2.28, util-linux 2.32, platform-python 3.6)", { timeout: 60_000 }, () => {
  let partsId = "";
  let home = "";
  let node = "";
  let ready = false;
  const links: AgentLink[] = [];
  const open = () => {
    const l = connectSsh({ os: "linux", partsId, node });
    links.push(l);
    return l;
  };
  const close = async (l: AgentLink) => {
    l.end();
    return l.exited;
  };

  beforeAll(async () => {
    if (spawnSync("ssh", ["-V"]).error || !fs.existsSync(AGENT)) {
      if (required) throw new Error("the el8 suite needs ssh, the rockylinux:8 remote (remote.yml's set-up) and npm run build");
      return;
    }
    const t = remoteTarget();
    if (t.os !== "linux") throw new Error("the el8 suite's remote isn't Linux");
    if (required && !isEl8()) throw new Error("the el8 suite's remote isn't RHEL 8 or a rebuild of it");
    home = sshRun("printf %s \"$HOME\"").stdout;
    node = await installRuntime("linux", t.target, home);
    partsId = installParts("linux", t.target);
    ready = true;
  }, 600_000);

  afterAll(async () => {
    for (const l of links) l.end();
    await Promise.all(links.map(l => Promise.race([l.exited, sleep(5000)])));
  });

  it("runs on glibc 2.28 under the pinned runtime, with no desktop on a headless machine", async ({ skip }) => {
    if (!ready) skip();
    const v = sshRun(`"${node}" -p 'process.versions.node'; getconf GNU_LIBC_VERSION`).stdout.trim().split("\n");
    expect(v[0]).toBe(JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/package/remote-runtime.json"), "utf8")).pinned);
    if (required) expect(v[1]).toBe("glibc 2.28");
    const l = open();
    const w = await l.request("hello", hello({ partsId }));
    expect(w).toMatchObject({ proto: 1, partsId, os: "linux", isWsl: false, home });
    expect(w.desktop.access).toBe("none");
    expect(w.desktop.why).toMatch(/ has no desktop: Ember will run commands only\.$/);
    expect(w.facts.shells).toContain("bash");
    expect(await close(l)).toBe(0);
  });

  it("runs commands in a PTY through util-linux 2.32's script, with typing, Stop and EOF", async ({ skip }) => {
    if (!ready) skip();
    const l = open();
    await l.request("hello", hello({ partsId }));
    const r = await runThrough(l, "tty; script --version; echo ok-$((6*7))", { cwd: home });
    expect(r.exit.exit).toMatchObject({ code: 0, ended: "exit" });
    expect(r.output).toMatch(/\/dev\/pts\/\d+/);
    if (required) expect(r.output).toContain("util-linux 2.32");
    expect(r.output).toContain("ok-42");
    // A failing command's status comes through script(1).
    expect((await runThrough(l, "exit 7", { cwd: home })).exit.exit.code).toBe(7);
    const typed = await startThrough(l, "read -r x && echo got:$x", { cwd: home });
    await sleep(500);
    await l.request("cmd.input", { runId: typed.a.spec.runId, data: Buffer.from("el8\r").toString("base64") });
    const exit = await l.event("cmd.exit", d => d.runId === typed.a.spec.runId);
    expect((await l.waitBytes(typed.channel, exit.outBytes)).toString("utf8")).toContain("got:el8");
    // A run that reads nothing keeps going (script 2.32 would end it at stdin's EOF), until Stop.
    const long = await startThrough(l, "sleep 1000", { cwd: home });
    await sleep(1500);
    await l.request("cmd.stop", { runId: long.a.spec.runId, why: "user" });
    expect((await l.event("cmd.exit", d => d.runId === long.a.spec.runId)).exit.ended).toBe("stopped-user");
    const left = await startThrough(l, "sleep 1000", { cwd: home });
    await sleep(800);
    expect(await close(l)).toBe(0);
    await sleep(1000);
    const marker = `EMBER_RUN_ID=${left.a.spec.runId}`;
    expect(sshRun(`n=0; for p in /proc/[0-9]*; do grep -qz "^${marker}\\$" "$p/environ" 2>/dev/null && n=$((n+1)); done; echo $n`).stdout.trim()).toBe("0");
  });

  it("starts its sidecars' Python as platform-python 3.6 can read it", async ({ skip }) => {
    if (!ready) skip();
    const py = sshRun("command -v /usr/libexec/platform-python || command -v python3").stdout.trim();
    expect(py).not.toBe("");
    const d = versionsDir("linux", partsId);
    // Compiled in memory: nothing is written into the verified parts folder.
    const check = `for f in sidecar/atspi/ember_atspi.py sidecar/notice/ember_notice.py; do "${py}" -c 'import sys; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")' ${d}/$f || exit 1; done; "${py}" -c 'import sys; print(sys.version_info[:2])'`;
    const r = sshRun(check);
    expect(r.code, r.stderr).toBe(0);
    if (required) expect(r.stdout.trim()).toBe("(3, 6)");
  });

  it("keeps its state per machine, outside the shared home's common folders", async ({ skip }) => {
    if (!ready) skip();
    const l = open();
    await l.request("hello", hello({ partsId }));
    await runThrough(l, "true", { cwd: home });
    await close(l);
    const r = sshRun("cd \"$HOME/.local/state/ember-remote\" && ls -d */ && stat -c %a */audit/audit-*.jsonl");
    expect(r.code, r.stderr).toBe(0);
    const [folder, ...modes] = r.stdout.trim().split(/\s+/);
    expect(folder).toMatch(/^[0-9a-f]{16}\/$/);
    for (const m of modes) expect(m).toBe("600");
    // Nothing per machine in the data folder, which an NFS home shares between machines.
    expect(sshRun("ls \"$HOME/.local/share/ember-remote\"").stdout.trim().split(/\s+/).sort()).toEqual(["runtime", "versions"]);
  });
});

/** One bootstrap over ssh (§5.1.9): its lines as they come, and the archives written only after their READY lines. */
function bootstrap(script: string) {
  const p = spawn("ssh", sshArgs("sh -s"), { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  const lines: { line: string; at: number }[] = [];
  p.stdout!.on("data", (b: Buffer) => {
    out += b.toString("latin1");
    let i;
    while ((i = out.indexOf("\n")) >= 0) {
      lines.push({ line: out.slice(0, i).replace(/^\0/, ""), at: Date.now() });
      out = out.slice(i + 1);
    }
  });
  p.stdin!.on("error", () => { /* it ended first */ });
  p.stdin!.write(script);
  const exited = new Promise<number | null>(r => p.on("exit", c => r(c)));
  const until = async (re: RegExp, ms: number) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = lines.find(l => re.test(l.line));
      if (hit) return hit;
      if (Date.now() > end) return null;
      await sleep(50);
    }
  };
  return { p, lines, until, exited };
}

describe.skipIf(!enabled || !fs.existsSync(BOOTSTRAP))("the real bootstrap on RHEL 8: a second install racing the first", { timeout: 300_000 }, () => {
  it("waits for the first install's lock, so two never unpack into the same folder at once", async () => {
    const t = remoteTarget();
    const parts = partsBuilt();
    const partsFile = fs.readFileSync(path.join(ROOT, "dist/remote-parts", parts.targets[t.target].file));
    const rt = await runtimeArchive(t.target);
    const script = fs.readFileSync(BOOTSTRAP, "utf8");
    // From nothing installed, so both installs want both archives.
    sshRun("rm -rf \"$HOME/.local/share/ember-remote\"");
    const line = `INSTALL ${PC_ID} ${rt.id} ${rt.bytes.length} ${rt.sha256} xz ${parts.partsId} ${partsFile.length} ${parts.targets[t.target].sha256}\n`;
    const first = bootstrap(script);
    const second = bootstrap(script);
    for (const b of [first, second]) expect(await b.until(/^EMBER-PROBE-END$/, 60_000)).not.toBeNull();
    first.p.stdin!.write(line);
    expect(await first.until(/^EMBER-READY runtime$/, 30_000)).not.toBeNull();
    second.p.stdin!.write(line);
    // The first holds the lock: the second asks for nothing while it does.
    await sleep(3000);
    expect(second.lines.some(l => /^EMBER-(READY|ERROR)/.test(l.line))).toBe(false);
    first.p.stdin!.write(rt.bytes);
    expect(await first.until(/^EMBER-READY parts$/, 120_000)).not.toBeNull();
    first.p.stdin!.write(partsFile);
    const done = Date.now();
    // Once the first has installed (and released the lock), the second goes on.
    const next = await second.until(/^EMBER-(READY|ERROR)/, 90_000);
    expect(next).not.toBeNull();
    expect(next!.at).toBeGreaterThanOrEqual(done);
    expect(sshRun(`test -f ${versionsDir("linux", parts.partsId)}/.verified && echo yes`).stdout.trim()).toBe("yes");
    for (const b of [first, second]) {
      b.p.stdin!.end();
      await Promise.race([b.exited, sleep(10_000)]);
    }
    // Neither left a lock or a staging folder behind.
    expect(sshRun("ls -a \"$HOME/.local/share/ember-remote\" | grep -c -e '^install.lock$' -e '^staging-' || true").stdout.trim()).toBe("0");
  });
});
