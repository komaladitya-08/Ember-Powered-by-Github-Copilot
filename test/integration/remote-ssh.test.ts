// The remote agent over a real ssh link (§10.2 `ssh-linux`, and `ssh-macos` for a Mac's commands-only path): its
// parts installed on the test sshd as the bootstrap leaves them, served by `ssh -T`, and driven with the PC's own mux.
// Commands in a PTY, typing, Stop and the kill switch (acknowledged under 300 ms on loopback), EOF, the dead-man and
// the grace (the test freezes its ssh with SIGSTOP), epoch fencing, gate 2's asks and refusals, the single-instance
// lock (another PC busy, this PC's reconnect taking over), the remote's own policy (with sudo), the audit file's mode
// and uninstall keeping the audit. The bootstrap's own probe and install (both archives, the READY handshake) are SA's
// ssh-transport suite. Skips without EMBER_SSH_TEST (Linux) or EMBER_SSH_TEST_MACOS (macOS); fails when either is "1"
// and ssh or the build is missing.
// Run: EMBER_SSH_TEST=1 node scripts/run-integration.mjs test/integration/remote-ssh.test.ts
//   (a local run may set EMBER_SSH_TEST_HOST/PORT/USER/IDENTITY/KNOWN_HOSTS, and EMBER_SSH_TEST_NODE for the remote's
//   Node; EMBER_SSH_TEST_SUDO=1 adds the remote-policy cases, which need passwordless sudo there)

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { AGENT, command, connectSsh, hello, installParts, PC_ID, remoteTarget, runThrough, sshRun, startThrough, versionsDir, type AgentLink } from "./remote-harness";

const required = process.env.EMBER_SSH_TEST === "1" || process.env.EMBER_SSH_TEST_MACOS === "1";
const enabled = required || !!process.env.EMBER_SSH_TEST || !!process.env.EMBER_SSH_TEST_MACOS;
const sudo = process.env.EMBER_SSH_TEST_SUDO === "1";
/** The Node the remote runs the agent with: the test's own (the sshd is this machine) unless named. */
const NODE = process.env.EMBER_SSH_TEST_NODE ?? process.execPath;
const OTHER_PC = "fedcba9876543210fedcba9876543210";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** A PC policy lowering the command grace (L10). */
const graceOf = (s: number) => ({ commands: { ssh: "on" }, ssh: { commandGraceSeconds: s } });

describe.skipIf(!enabled)("the remote agent over a real ssh link (§5.1.10-§5.3.11)", { timeout: 60_000 }, () => {
  let os: "linux" | "darwin" = "linux";
  let partsId = "";
  let cwd = "";
  let ready = false;
  const links: AgentLink[] = [];
  const open = (o: { pcId?: string } = {}) => {
    const l = connectSsh({ os, partsId, node: NODE, ...o });
    links.push(l);
    return l;
  };
  /** Ends a link and waits for its agent to go (its lock is free for the next case). */
  const close = async (l: AgentLink) => {
    l.end();
    return l.exited;
  };
  /** How many processes on the remote carry a run's marker (a zombie's environ is empty, so it doesn't count). */
  const marked = (runId: string): number => {
    if (!/^[0-9a-f]{16}$/.test(runId)) throw new Error("not a run id");
    const script = os === "linux"
      ? `n=0; for p in /proc/[0-9]*; do grep -qz "^EMBER_RUN_ID=${runId}\\$" "$p/environ" 2>/dev/null && n=$((n+1)); done; echo $n`
      : `ps -E -ww -U "$(id -u)" -o command= | grep -c " EMBER_RUN_I[D]=${runId}" || true`;
    return Number(sshRun(script).stdout.trim() || "0");
  };

  beforeAll(() => {
    const ssh = spawnSync("ssh", ["-V"], { encoding: "utf8" });
    if (ssh.error || !fs.existsSync(AGENT)) {
      if (required) throw new Error("the SSH suite needs ssh, a test sshd (remote.yml's set-up) and npm run build");
      return;
    }
    const t = remoteTarget();
    os = t.os;
    partsId = installParts(t.os, t.target);
    cwd = sshRun("printf %s \"$HOME\"").stdout;
    expect(cwd.startsWith("/")).toBe(true);
    ready = true;
  }, 300_000);

  afterAll(async () => {
    for (const l of links) {
      try { process.kill(l.proc.pid!, "SIGCONT"); } catch { /* gone */ }
      l.end();
    }
    await Promise.all(links.map(l => Promise.race([l.exited, sleep(5000)])));
  });

  it("serves after hello with this computer's facts, and no desktop over a plain SSH login", async ({ skip }) => {
    if (!ready) skip();
    const l = open();
    const w = await l.request("hello", hello({ partsId }));
    expect(w).toMatchObject({ proto: 1, partsId, os, facts: { os }, graceSeconds: 20 });
    expect(w.facts.shells.length).toBeGreaterThan(0);
    expect(w.desktop.access).toBe("none");
    if (os === "darwin") expect(w.desktop.why).toBe("Ember can't use a Mac's screen over SSH yet; it can run commands there.");
    expect(await close(l)).toBe(0);
  });

  it("runs a command in a PTY through gate 2, and passes the user's typing to it", async ({ skip }) => {
    if (!ready) skip();
    const l = open();
    await l.request("hello", hello({ partsId }));
    const r = await runThrough(l, "tty && echo ran-$((6*7))", { cwd });
    expect(r.exit.exit).toMatchObject({ code: 0, ended: "exit" });
    expect(r.output).toMatch(/\/dev\/(pts\/\d+|ttys\d+)/);
    expect(r.output).toContain("ran-42");
    // Typing (answered like a prompt): straight to the PTY, never logged.
    const typed = await startThrough(l, "read -r x && echo got:$x", { cwd });
    await sleep(500);
    await l.request("cmd.input", { runId: typed.a.spec.runId, data: Buffer.from("abc\r").toString("base64") });
    const exit = await l.event("cmd.exit", d => d.runId === typed.a.spec.runId);
    expect((await l.waitBytes(typed.channel, exit.outBytes)).toString("utf8")).toContain("got:abc");
    await close(l);
  });

  it("stops a run with the ladder, and acknowledges the kill switch within 300 ms on loopback, ending every run", async ({ skip }) => {
    if (!ready) skip();
    const l = open();
    await l.request("hello", hello({ partsId }));
    const one = await startThrough(l, "sleep 1000", { cwd });
    await sleep(500);
    const t0 = Date.now();
    await l.request("cmd.stop", { runId: one.a.spec.runId, why: "user" });
    expect((await l.event("cmd.exit", d => d.runId === one.a.spec.runId)).exit.ended).toBe("stopped-user");
    expect(Date.now() - t0).toBeLessThan(2500);
    const two = await startThrough(l, "sleep 1000", { cwd });
    await sleep(500);
    const s0 = Date.now();
    const stop = await l.request("stop", { epoch: 2 });
    const acked = Date.now() - s0;
    expect(stop.ms).toBeLessThan(300);
    expect(acked).toBeLessThan(300);
    expect((await l.event("cmd.exit", d => d.runId === two.a.spec.runId)).exit.ended).toBe("killswitch");
    await sleep(1600);
    expect(marked(two.a.spec.runId)).toBe(0);
    // A command sent with the epoch from before the stop never runs (epoch fencing); the new epoch runs.
    await expect(l.request("cmd.run", command("echo late", { cwd, epoch: 1, yes: true }))).rejects.toMatchObject({ code: "stopped" });
    expect((await runThrough(l, "echo after", { cwd, epoch: 2 })).output).toContain("after");
    await close(l);
  });

  it("asks for what its own check finds beyond the PC's stamp (a class the PC missed)", async ({ skip }) => {
    if (!ready) skip();
    const l = open();
    await l.request("hello", hello({ partsId }));
    const r = await l.request("cmd.run", command("rm -r build", { cwd, verdict: "run" }));
    await close(l);
    expect(r.status).toBe("needs_confirm");
    expect(r.status === "needs_confirm" && r.rules?.length).toBeGreaterThan(0);
  });

  it("refuses a command that would touch Ember's own files on this computer (D4.5)", async ({ skip }) => {
    if (!ready) skip();
    const l = open();
    await l.request("hello", hello({ partsId }));
    const text = os === "darwin" ? "rm -rf \"$HOME/Library/Application Support/Ember Remote\"" : "rm -rf ~/.local/share/ember-remote";
    const r = await l.request("cmd.run", command(text, { cwd, yes: true, rules: ["posix.rm"], classes: ["destroy"], verdict: "ask" }));
    await close(l);
    // The classifier's stand-in (until CL's lands) asks about everything and refuses nothing.
    if (r.status === "needs_confirm" && r.rules?.includes("remote.unchecked")) skip();
    expect(r.status).toBe("deny");
  });

  it("stops a running command when the link ends (EOF), and the agent with it", async ({ skip }) => {
    if (!ready) skip();
    const l = open();
    await l.request("hello", hello({ partsId }));
    const a = await startThrough(l, "sleep 1000", { cwd });
    await sleep(800);
    expect(marked(a.a.spec.runId)).toBeGreaterThan(0);
    expect(await close(l)).toBe(0);
    await sleep(1000);
    expect(marked(a.a.spec.runId)).toBe(0);
  });

  it("keeps a command running through the dead-man and ends it at the grace when the link goes silent (L10)", async ({ skip }) => {
    if (!ready) skip();
    const l = open();
    await l.request("hello", hello({ partsId, admin: graceOf(8) }));
    const a = await startThrough(l, "sleep 1000", { cwd });
    await sleep(500);
    // Frozen: not a byte either way, as when a network drops without a reset.
    process.kill(l.proc.pid!, "SIGSTOP");
    try {
      await sleep(4500);
      expect(marked(a.a.spec.runId)).toBeGreaterThan(0);
      await sleep(7000);
      expect(marked(a.a.spec.runId)).toBe(0);
    } finally {
      process.kill(l.proc.pid!, "SIGCONT");
    }
    await close(l);
  });

  it("writes its audit file 0600, with the PC's name marked unverified", async ({ skip }) => {
    if (!ready) skip();
    const l = open();
    await l.request("hello", hello({ partsId }));
    const { entries } = await l.request("audit.recent", { limit: 5 });
    expect(entries.some(e => e.from === "ci-pc" && e.fromUnverified === true)).toBe(true);
    await close(l);
    const glob = os === "darwin" ? "\"$HOME/Library/Application Support/Ember Remote\"/state/*/audit/audit-*.jsonl" : "$HOME/.local/state/ember-remote/*/audit/audit-*.jsonl";
    const modes = sshRun(os === "darwin" ? `stat -f %Lp ${glob}` : `stat -c %a ${glob}`).stdout.trim().split(/\s+/).filter(Boolean);
    expect(modes.length).toBeGreaterThan(0);
    for (const m of modes) expect(m).toBe("600");
  });

  it("is busy for another PC while an agent runs, and lets this PC's reconnect take its old agent's lock over", async ({ skip }) => {
    if (!ready) skip();
    const first = open();
    await first.request("hello", hello({ partsId, admin: graceOf(3) }));
    const other = open({ pcId: OTHER_PC });
    await expect(other.request("hello", { ...hello({ partsId }), pcId: OTHER_PC })).rejects.toMatchObject({ code: "busy" });
    await close(other);
    // A blip: the first agent hears nothing, as after a dropped connection; the reconnect waits, then takes over.
    process.kill(first.proc.pid!, "SIGSTOP");
    try {
      const again = open();
      const t0 = Date.now();
      const w = await again.request("hello", hello({ partsId, admin: graceOf(3) }), 30_000);
      expect(w.partsId).toBe(partsId);
      expect(Date.now() - t0).toBeLessThan(12_000);
      await close(again);
    } finally {
      process.kill(first.proc.pid!, "SIGCONT");
    }
    await close(first);
  });

  it("refuses a hello from a PC other than the one it was started for", async ({ skip }) => {
    if (!ready) skip();
    const l = open();
    expect(PC_ID).not.toBe(OTHER_PC);
    await expect(l.request("hello", { ...hello({ partsId }), pcId: OTHER_PC })).rejects.toMatchObject({ code: "denied" });
    await close(l);
  });

  it.skipIf(!sudo)("follows this computer's own policy: commands off refuses them, SSH off refuses Ember", async ({ skip }) => {
    if (!ready) skip();
    const write = (json: string) => sshRun(`sudo -n mkdir -p /etc/ember && printf '%s' '${json}' | sudo -n tee /etc/ember/policy.json >/dev/null && sudo -n chmod 644 /etc/ember/policy.json`);
    try {
      expect(write('{"commands":{"ssh":"off"}}').code).toBe(0);
      const l = open();
      const w = await l.request("hello", hello({ partsId }));
      expect(w.remoteAdmin.commands.ssh).toBe("off");
      expect(await l.request("cmd.run", command("ls", { cwd, yes: true }))).toEqual({ status: "deny", reason: "This computer's administrator has turned off commands from Ember." });
      await close(l);
      expect(write('{"features":{"ssh":false}}').code).toBe(0);
      const refused = open();
      await expect(refused.request("hello", hello({ partsId }))).rejects.toMatchObject({ code: "denied", message: "denied: This computer's administrator doesn't allow Ember here." });
      expect(await refused.exited).toBe(0);
    } finally {
      sshRun("sudo -n rm -f /etc/ember/policy.json");
    }
  });

  it("is removed by its uninstall.sh, which keeps the audit", async ({ skip }) => {
    if (!ready) skip();
    await sleep(500);
    const r = sshRun(`sh ${versionsDir(os, partsId)}/uninstall.sh`);
    expect(r.code, r.stderr).toBe(0);
    const versions = os === "darwin" ? "\"$HOME/Library/Application Support/Ember Remote/versions\"" : "$HOME/.local/share/ember-remote/versions";
    const audit = os === "darwin" ? "\"$HOME/Library/Application Support/Ember Remote\"/state/*/audit" : "$HOME/.local/state/ember-remote/*/audit";
    expect(sshRun(`test -e ${versions}; echo $?`).stdout.trim()).toBe("1");
    expect(sshRun(`ls ${audit} | wc -l`).stdout.trim()).not.toBe("0");
    // Installed again for any suite that follows.
    installParts(os, remoteTarget().target);
  });
});
