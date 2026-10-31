/**
 * The SSH feature end to end against real OpenSSH on this machine (INT): Ember's own connections (the real ssh argv,
 * link worker, bootstrap, runtime and parts upload, hello), SC's remote target and TG's command service over the link,
 * and the PC's command flow with CL's real classifier and a stand-in user who says yes on the card. It proves what no
 * unit test can: an ordinary command runs there without the PC asking, a dangerous one asks first and runs on the yes,
 * the kill switch's Stop ends a running command there, a dropped link stops the agent there and Ember reconnects by
 * itself to a fresh agent that serves commands again, and Disconnect leaves nothing running.
 *
 * Same set-up as ssh-transport (remote.yml's `ssh-linux`: sshd on 127.0.0.1:2222 with the runner's own key; npm run
 * build; node scripts/package/remote-parts.mjs). Needs EMBER_SSH_TEST=1 and EMBER_TEST_ALLOW_LOOPBACK_SSH=1: skipped
 * without them, and FAILS with EMBER_SSH_TEST=1 when ssh, the sshd, the build or the parts are missing.
 * Run: EMBER_SSH_TEST=1 EMBER_TEST_ALLOW_LOOPBACK_SSH=1 node scripts/run-integration.mjs test/integration/remote-e2e.test.ts
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminPolicySchema, type LoadedAdminPolicy } from "../../app/main/admin";
import type { Confirmer } from "../../app/main/agent/confirm";
import { Presenter } from "../../app/main/agent/presenter";
import { classifyCommand } from "../../app/main/commands/classify";
import { decideCommand } from "../../app/main/commands/decide";
import { runCommandTool, setCommandJudge, type CommandFlowContext } from "../../app/main/commands/flow";
import { shapeOutput } from "../../app/main/commands/output";
import { resolveTargetPath } from "../../app/main/commands/paths";
import { trackSecretPrompts } from "../../app/main/commands/prompts";
import { redactSecrets } from "../../app/main/commands/redact";
import { outputTaint } from "../../app/main/commands/taint";
import type { CommandCard, CommandWindowPort } from "../../app/main/commands/types";
import type { Logger } from "../../app/main/logger";
import { createConnections } from "../../app/main/remote/connections";
import { remoteTargetParts } from "../../app/main/remote/target";
import type { Connections, HostRecord, RemoteLink } from "../../app/main/remote/types";
import { SettingsStore } from "../../app/main/settings";
import { createRemoteTarget, type RemoteTarget } from "../../app/main/targets/remote-service";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import { sshRun } from "./remote-harness";

const WANTED = process.env.EMBER_SSH_TEST === "1";
const run = WANTED && process.platform === "linux";
const ROOT = path.join(__dirname, "..", "..");
const APP = path.join(ROOT, "dist", "app");
const PORT = 2222;
const HOST_ID = "local-test";

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet, file: "" };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Waits until `f` gives something (at most `ms`). */
async function until<T>(f: () => T | null | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Why the suite can't run here, or null. */
function missing(): string | null {
  if (!fs.existsSync("/usr/bin/ssh")) return "no /usr/bin/ssh";
  if (!fs.existsSync(path.join(APP, "remote-link.cjs"))) return "no build (run npm run build)";
  if (!fs.existsSync(path.join(ROOT, "dist", "remote-parts", "remote-parts.json"))) return "no remote parts (run node scripts/package/remote-parts.mjs)";
  const r = spawnSync("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-p", String(PORT), "127.0.0.1", "true"], { timeout: 15_000 });
  if (r.status !== 0) return `sshd on 127.0.0.1:${PORT} isn't reachable with this user's key (${String(r.stderr).trim().slice(0, 200)})`;
  if (process.env.EMBER_TEST_ALLOW_LOOPBACK_SSH !== "1") return "EMBER_TEST_ALLOW_LOOPBACK_SSH isn't 1";
  return null;
}

/** The ssh children of this process (Ember's link worker runs in it): their pids. */
function sshChildren(): number[] {
  const out: number[] = [];
  for (const d of fs.readdirSync("/proc").filter(n => /^\d+$/.test(n))) {
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      if (Number(rest[1]) === process.pid && comm === "ssh") out.push(Number(d));
    } catch {
      // gone meanwhile
    }
  }
  return out;
}

describe.skipIf(!run)("Ember over SSH, end to end on this machine (INT)", { timeout: 300_000 }, () => {
  const user = (() => { try { return execFileSync("id", ["-un"], { encoding: "utf8" }).trim(); } catch { return "runner"; } })();
  let tmp = "";
  let settings: SettingsStore;
  let conns: Connections;
  const admin: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };
  const asked: { title: string; card: CommandCard | null }[] = [];
  const work = `ember-e2e-${randomBytes(4).toString("hex")}`;
  let home = "";

  const record = (): HostRecord => ({
    id: HOST_ID, dest: "127.0.0.1", port: PORT, resolved: { user, hostname: "127.0.0.1", port: PORT, jump: [] },
    consent: { version: FEATURE_CONSENT_VERSION.ssh, at: new Date().toISOString() },
  });

  /** The command window as the user sees it: it shows every card and run (nothing is clicked there). */
  const window: CommandWindowPort = {
    showCard: () => undefined, hideCard: () => undefined, cardReady: () => true,
    announce: async () => true, cancelAnnounce: () => undefined, attach: () => undefined,
  };
  /** The user: says yes to every question, and it is recorded. */
  const confirmer = {
    ask: async (q: { title: string; panel?: { kind: string; card?: CommandCard } }) => {
      asked.push({ title: q.title, card: q.panel?.kind === "command" ? q.panel.card ?? null : null });
      return "once";
    },
  } as unknown as Confirmer;

  /** The remote target for the link up now (TG's, over SC's parts), as the targets runtime builds it. */
  const targetOf = (link: RemoteLink): RemoteTarget => createRemoteTarget({
    host: settings.get().targets.hosts.find(h => h.id === HOST_ID)!, link, log: quiet, settings, admin: () => admin, window,
    makeParts: (l, o) => remoteTargetParts(l, o),
  });

  /** run_command through the PC's own flow, as a worker on the remote calls it; `words`: the user's own words. */
  const runCommand = (t: RemoteTarget, command: string, o: { words?: string; signal?: AbortSignal; cwd?: string } = {}) => {
    const signal = o.signal ?? new AbortController().signal;
    const ctx: CommandFlowContext = {
      task: {
        id: `1-${randomBytes(3).toString("hex")}`, title: "the end-to-end task", commandWords: () => o.words ?? "", agreed: () => [], tainted: () => false,
        taint: () => undefined, readFrom: () => [],
      },
      service: t.service, confirmer, presenter: new Presenter(() => undefined), audit: () => undefined, log: quiet, signal,
      isOver: () => signal.aborted, state: { cwd: null, downloaded: new Set(), running: false }, size: () => ({ cols: 100, rows: 30 }), emberPids: () => [process.pid],
    };
    return runCommandTool({ target: HOST_ID, command, why: "the end-to-end check", cwd: o.cwd ?? `${home}/${work}` }, ctx);
  };
  /** A question from the remote's own check (its lines added), which the flow asks once more. */
  const remoteAsk = (a: { card: CommandCard | null }) => !!a.card?.says.some(l => l.endsWith("'s own check also found:"));
  /** The questions the PC asked of itself. */
  const pcAsked = () => asked.filter(a => !remoteAsk(a));
  /**
   * The remote's own questions are only its stand-in classifier's (SB's, until CL's runs there: it asks once about every
   * command, saying so); a real finding of its own about an ordinary command would be a seam to look at.
   */
  const onlyStandInAsks = () => asked.filter(remoteAsk).every(a => a.card!.says.some(l => l.includes("can't check commands itself yet")));

  beforeAll(() => {
    const why = missing();
    if (why) throw new Error(`EMBER_SSH_TEST=1 but the SSH test facility is missing: ${why}`);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-e2e-"));
    settings = new SettingsStore(path.join(tmp, "settings.json"));
    settings.load();
    const at = new Date().toISOString();
    settings.update({
      targets: { ...settings.own().targets, hosts: [record()], pcId: randomBytes(16).toString("hex") },
      commands: { [`ssh:${HOST_ID}`]: { on: true, askEvery: false, consent: { version: FEATURE_CONSENT_VERSION.commands, at } } },
    });
    // CL's real functions for the flow (the judge the targets runtime's flow uses).
    setCommandJudge({ classifyCommand, decideCommand, shapeOutput, redactSecrets, trackSecretPrompts, outputTaint, resolveTargetPath });
    conns = createConnections({
      log: quiet, os: "linux", userData: path.join(tmp, "user-data"), appDir: APP, execPath: process.execPath, resourcesPath: path.join(ROOT, "dist"),
      settings, admin: () => admin, prompts: { ask: async c => ({ id: c.id, ok: false }), dismiss: () => undefined },
      fetch: (url, init) => fetch(url, { signal: init?.signal }) as never,
      allowLoopback: true, audit: () => null, pcId: () => settings.get().targets.pcId, wsl: () => null, jobHost: null,
    });
    home = sshRun("printf %s \"$HOME\"").stdout;
    expect(home.startsWith("/")).toBe(true);
    expect(sshRun(`mkdir -p "$HOME/${work}/build" "$HOME/${work}/cache" && touch "$HOME/${work}/build/out.o" "$HOME/${work}/cache/x"`).code).toBe(0);
  }, 60_000);

  afterAll(async () => {
    setCommandJudge(null);
    await conns?.dispose();
    if (home) sshRun(`rm -rf "$HOME/${work}"`);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  let link: RemoteLink;
  let target: RemoteTarget;

  it("connects: probe, the runtime and parts installed when missing, the agent served, hello checked", async () => {
    link = await conns.connect(record(), { interactive: false });
    expect(link.state).toBe("ready");
    expect(link.welcome).toMatchObject({ os: "linux", user, home });
    expect(link.welcome.desktop.access).toBe("none"); // a plain SSH login on a machine with no desktop session
    target = targetOf(link);
    expect(target.service.capability().state).toBe("on");
  });

  it("runs an ordinary command there without the PC asking", async () => {
    const r = await runCommand(target, "echo ember-ok-$((6*7)); uname -s");
    expect(r.resultType).toBe("success");
    expect(r.textResultForLlm).toContain("ember-ok-42");
    expect(r.textResultForLlm).toContain("Linux");
    expect(pcAsked()).toEqual([]);
    expect(onlyStandInAsks()).toBe(true);
  });

  it("asks before a dangerous command, shows it whole, and runs it on the user's yes", async () => {
    asked.length = 0;
    const r = await runCommand(target, "rm -r build");
    expect(pcAsked().map(a => [a.title, a.card?.command])).toEqual([["May I run a command?", "rm -r build"]]);
    expect(r.resultType).toBe("success");
    expect(sshRun(`test -e "$HOME/${work}/build" && echo there || echo gone`).stdout.trim()).toBe("gone");
  });

  it("announces a dangerous command the user's own words asked for, and still asks for a broader one (D4.4)", async () => {
    asked.length = 0;
    const said = await runCommand(target, "rm -r cache", { words: "delete the cache folder" });
    expect(said.resultType).toBe("success");
    expect(pcAsked()).toEqual([]);
    expect(sshRun(`test -e "$HOME/${work}/cache" && echo there || echo gone`).stdout.trim()).toBe("gone");
    // Beyond what the words named: asked (and here refused by the user's stand-in saying no would be the same card).
    asked.length = 0;
    await runCommand(target, "rm -rf ~/ember-e2e-nothing-here", { words: "delete the cache folder" });
    expect(pcAsked().map(a => a.card?.command)).toEqual(["rm -rf ~/ember-e2e-nothing-here"]);
  });

  it("reads a script there in its own check (the PC can't): a deleting script asks once more, and runs on the yes", async () => {
    expect(sshRun(`mkdir -p "$HOME/${work}/b2" && printf 'rm -r b2\\n' > "$HOME/${work}/s.sh"`).code).toBe(0);
    asked.length = 0;
    const r = await runCommand(target, "sh s.sh");
    expect(pcAsked()).toEqual([]);
    const theirs = asked.filter(remoteAsk);
    expect(theirs).toHaveLength(1);
    expect(theirs[0].card!.says.some(l => /In s\.sh: .*b2/.test(l)), theirs[0].card!.says.join(" | ")).toBe(true);
    expect(r.resultType).toBe("success");
    expect(sshRun(`test -e "$HOME/${work}/b2" && echo there || echo gone`).stdout.trim()).toBe("gone");
  });

  it("stops a running command there with the kill switch's Stop", async () => {
    asked.length = 0;
    const stop = new AbortController();
    const running = runCommand(target, "sleep 100; echo not-stopped", { signal: stop.signal });
    await until(() => target.parts.runner.running > 0 && sshRun("pgrep -u \"$(id -u)\" -x sleep >/dev/null && echo yes").stdout.includes("yes"), 20_000, "the sleep to run");
    const t0 = Date.now();
    const r = await link.stop();
    expect(r.escalated).toBe(false);
    stop.abort();
    const res = await running;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(res.textResultForLlm).not.toContain("not-stopped");
    await until(() => sshRun("pgrep -u \"$(id -u)\" -x sleep >/dev/null && echo yes || echo no").stdout.includes("no"), 10_000, "the sleep to end");
    expect(link.state).toBe("ready");
  });

  it("stops the agent there when the link drops, and reconnects by itself to a fresh agent that serves commands", async () => {
    const oldPid = link.welcome.pid;
    const ssh = sshChildren();
    expect(ssh.length).toBeGreaterThan(0);
    for (const pid of ssh) process.kill(pid, "SIGKILL");
    await until(() => link.state === "lost", 10_000, "the link to be lost");
    target.dispose();
    // The old agent saw EOF and stopped (its runs with it): nothing of it is left.
    await until(() => sshRun(`kill -0 ${oldPid} 2>/dev/null && echo alive || echo gone`).stdout.includes("gone"), 15_000, "the old agent to stop");
    const again = await until(() => { const l = conns.link(HOST_ID); return l && l !== link && l.state === "ready" ? l : null; }, 90_000, "Ember to reconnect");
    expect(again.welcome.pid).not.toBe(oldPid);
    link = again;
    target = targetOf(link);
    asked.length = 0;
    const r = await runCommand(target, "echo back-$((40+2))");
    expect(r.textResultForLlm).toContain("back-42");
    expect(pcAsked()).toEqual([]);
    expect(onlyStandInAsks()).toBe(true);
  });

  it("disconnects with nothing of Ember's left running there", async () => {
    const pid = link.welcome.pid;
    await conns.disconnect(HOST_ID);
    expect(link.state).toBe("closed");
    target.dispose();
    await until(() => sshRun(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`).stdout.includes("gone"), 15_000, "the agent to stop");
    // ("[e]" keeps the pattern from matching the shell that runs it.)
    expect(sshRun("pgrep -u \"$(id -u)\" -f '[e]mber-remote.cjs (serve|desktop)' || true").stdout.trim()).toBe("");
  });
});

describe.skipIf(run)("Ember over SSH, end to end (skipped)", () => {
  it("is skipped without EMBER_SSH_TEST=1 on Linux", () => {
    expect(run).toBe(false);
  });
});
