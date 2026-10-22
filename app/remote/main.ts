/**
 * The remote agent, `ember-remote` (§5.3; package SB): Ember's eyes, hands and command runner on a computer reached
 * over SSH, under that computer's admin policy and audit. Plain Node: built to dist/remote/ember-remote.cjs and run by
 * the Node runtime Ember brings (`node --disable-sigusr1 ember-remote.cjs serve --proto 1 --pc <pcId>`); nothing in its
 * import graph loads Electron, sharp, the Copilot SDK or a network module (remote-agent-build.test.ts).
 *
 * Start-up hygiene (§5.3.3): it refuses to start when Node's or the loader's injection variables are set (the
 * bootstrap unset them; a set one means something put it back), and unless it runs from a verified parts folder
 * (versions/<partsId>/ with .verified) or, for tests, EMBER_REMOTE_DEV=1 outside any parts folder. A packaged agent
 * ignores every EMBER_* variable but EMBER_LOG_LEVEL (a remote .bashrc can't loosen the remote's policy). It sweeps
 * orphaned runs, takes no lock until hello names the PC, and stops on EOF, SIGHUP, SIGTERM and the grace.
 * The same file is the desktop child (`desktop`) and the watchdog thread (workerData.role).
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path/posix";
import { isMainThread, workerData } from "node:worker_threads";
import { z } from "zod";
import { createLogger, type Logger, type LogLevel } from "../main/logger";
import { journalSink } from "../main/policy/audit";
import { createMux } from "../main/remote/mux";
import { emberNamesRegExp } from "../main/remote/protocol";
import { createLocalRunner } from "../main/commands/run/local";
import { loadRemotePolicy, PolicyWatch } from "./admin";
import { createRemoteAudit, type AuditSource } from "./audit";
import { cleanUp, REAL_CLEANUP_IO, runtimeIdOf } from "./cleanup";
import { RemoteRuns } from "./commands";
import { recordConsent } from "./consent";
import { CONTRACTS } from "./contracts";
import { DesktopController } from "./desktop";
import { runDesktopChild } from "./desktop-child";
import { discoverDesktop, type DesktopFound, type NoDesktop } from "./desktop-linux";
import { childOf, extraPath, isWslHost, killSession, machineHash, realDesktopIo, spawnGroup, startOf, sweeper, tccLimited } from "./host-io";
import { acquireLock, fileLockIo } from "./lock";
import { stampFolder, stampText, sweepOrphans } from "./orphans";
import { dataFolder, emberPaths, hashLine, machineKey, placesFor, sessionFolder, type AgentOs, type Places } from "./places";
import { Server } from "./serve";
import { runWatchdogThread, startWatchdog, WatchTable, WATCHDOG_ROLE, type WatchdogData } from "./watchdog";

/** Variables that inject code into Node or the process (§5.3.3, critique remote-16): their presence refuses the start. */
export const REFUSED_ENV = ["NODE_OPTIONS", "NODE_PATH", "NODE_DEBUG", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH"] as const;
/** Ember's own process names on a remote (D4.5: a command may not stop them). */
export const EMBER_NAMES = ["ember-remote", "ember-remote.cjs", "ember_atspi.py", "ember_notice.py", "ember-remote-notice"];

/** The first injection variable set in `env`, or null. */
export function hygieneProblem(env: NodeJS.ProcessEnv): string | null {
  return REFUSED_ENV.find(k => env[k] !== undefined) ?? null;
}

/** `serve --proto 1 --pc <32 hex digits>` as the PC's id, or null when the arguments aren't exactly that. */
export function parseServeArgs(argv: string[]): { pcId: string } | null {
  if (argv.length !== 5 || argv[0] !== "serve" || argv[1] !== "--proto" || argv[2] !== "1" || argv[3] !== "--pc" || !/^[0-9a-f]{32}$/.test(argv[4])) return null;
  return { pcId: argv[4] };
}

/**
 * Where the agent runs from: `packaged` (its folder is `<data>/versions/<partsId>` with `.verified`, the partsId its
 * name) or `dev` (EMBER_REMOTE_DEV=1 and its folder outside any parts folder: the repo's dist/remote); null otherwise.
 */
export function whereFrom(o: { dir: string; os: AgentOs; home: string; env: NodeJS.ProcessEnv; exists: (p: string) => boolean }): { packaged: boolean; partsId: string } | null {
  const versions = path.join(dataFolder(o.os, o.home), "versions");
  const name = path.basename(o.dir);
  if (path.dirname(o.dir) === versions && /^[A-Za-z0-9._+-]{1,80}$/.test(name) && o.exists(path.join(o.dir, ".verified"))) return { packaged: true, partsId: name };
  const insideParts = /\/(ember-remote|Ember Remote)\/versions(\/|$)/.test(o.dir);
  if (o.env.EMBER_REMOTE_DEV === "1" && !insideParts) {
    const id = o.env.EMBER_REMOTE_PARTS_ID;
    return { packaged: false, partsId: id && /^[A-Za-z0-9._+-]{1,80}$/.test(id) ? id : "0.0.0-dev" };
  }
  return null;
}

/** The agent's own environment: a packaged agent drops every EMBER_* but EMBER_LOG_LEVEL. */
export function agentEnv(env: NodeJS.ProcessEnv, packaged: boolean): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (packaged && k.startsWith("EMBER_") && k !== "EMBER_LOG_LEVEL") continue;
    out[k] = v;
  }
  return out;
}

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const levelOf = (env: NodeJS.ProcessEnv): LogLevel => ((LEVELS as readonly string[]).includes(env.EMBER_LOG_LEVEL ?? "") ? env.EMBER_LOG_LEVEL as LogLevel : "info");

/** $HOME as the bootstrap used it (its paths are relative to it), else the account's home folder. */
export function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME && path.isAbsolute(env.HOME) ? env.HOME : os.userInfo().homedir;
}

/** The desktop a development test names (EMBER_REMOTE_TEST_DESKTOP, JSON), in place of logind's (never packaged). */
const TestDesktopSchema = z.object({
  access: z.enum(["screen", "text"]),
  session: z.object({ id: z.string().min(1).max(64), type: z.enum(["x11", "wayland"]) }).strict(),
  env: z.record(z.string(), z.string()),
}).strict();
function testDesktop(json: string): DesktopFound | NoDesktop {
  const parsed = TestDesktopSchema.safeParse((() => { try { return JSON.parse(json); } catch { return null; } })());
  if (!parsed.success) return { access: "none", why: "EMBER_REMOTE_TEST_DESKTOP isn't a desktop." };
  const t = parsed.data;
  return { access: t.access, session: { id: t.session.id, type: t.session.type, locked: false, active: true }, env: t.env };
}

/** Refuses to start, in the bootstrap's error form. */
function refuse(code: string): never {
  process.stderr.write(`EMBER-ERROR ${code}\n`);
  process.exit(2);
}

/** Makes a folder of the agent's (0700), or refuses to start. */
function ensureDir(p: string): void {
  try {
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  } catch {
    refuse("state-folder");
  }
}

/** The folders, after the per-session one is made. */
async function placesNow(agentOs: AgentOs, home: string, uid: number, env: NodeJS.ProcessEnv): Promise<{ places: Places; machineHashHex: string; machine: string }> {
  const machineHashHex = await machineHash(agentOs);
  const machine = machineKey(machineHashHex, hashLine(os.hostname()));
  const session = sessionFolder(agentOs, {
    uid,
    env,
    lstat: p => {
      try {
        const st = fs.lstatSync(p);
        return { dir: st.isDirectory(), symlink: st.isSymbolicLink(), uid: st.uid, mode: st.mode };
      } catch {
        return null;
      }
    },
    mkdir: p => fs.mkdirSync(p, { mode: 0o700 }),
    mkdtemp: prefix => fs.mkdtempSync(prefix),
    darwinTemp: () => {
      // Synchronous, once, before anything is served.
      try {
        return execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 2000 }).trim() || null;
      } catch {
        return null;
      }
    },
  });
  const places = placesFor({ os: agentOs, home, machine, session: session.dir, sessionStable: session.stable });
  for (const p of [places.state, places.audit, places.logs, places.runs]) ensureDir(p);
  return { places, machineHashHex, machine };
}

/** Runs `serve`: the protocol on stdin/stdout until EOF, the grace, bye or a stop signal. */
async function serve(o: { pcId: string; agentOs: AgentOs; arch: "x64" | "arm64"; partsId: string; packaged: boolean; dir: string; env: NodeJS.ProcessEnv }): Promise<void> {
  const user = os.userInfo();
  const uid = process.getuid?.() ?? user.uid;
  const home = homeOf(o.env);
  const host = os.hostname().split(".")[0] || os.hostname();
  const { places, machineHashHex, machine } = await placesNow(o.agentOs, home, uid, o.env);
  const log = createLogger({ dir: places.logs, level: levelOf(o.env), maxBytes: 1024 * 1024, keep: 3 });
  log.info("remote.start", { partsId: o.partsId, packaged: o.packaged, os: o.agentOs, arch: o.arch });
  const self = path.join(o.dir, path.basename(__filename));

  let server: Server | null = null;
  const policy = new PolicyWatch(() => loadRemotePolicy(o.agentOs), () => server?.onRemotePolicy());
  let source: AuditSource = { from: "", pcId: "" };
  const audit = createRemoteAudit({
    dir: places.audit, retentionDays: policy.current.policy.auditRetentionDays ?? 30, source: () => source, log,
    ...(o.agentOs === "linux" ? { sink: journalSink(err => log.warn("remote.journal_failed", { err })) } : {}),
  });
  const started = startOf(o.agentOs);
  const myStart = started(process.pid) ?? String(Date.now());
  const sweep = sweeper(CONTRACTS.sweepScript);
  const stamps = stampFolder(places.runs, { startOf: started, sweep: id => sweep(id, "KILL") });
  const orphans = () => sweepOrphans(stamps);
  const swept = await orphans();
  if (swept.length) audit.write({ event: "stop", source: "orphan", runs: swept });

  const table = new WatchTable();
  const watchdog = startWatchdog({ table, file: self, sweepScript: CONTRACTS.sweepScript, log });
  const mux = createMux({ read: process.stdin, write: process.stdout, role: "agent", partsId: o.partsId, log: log.child("mux") });
  const extra = extraPath(o.agentOs);
  const runs = new RemoteRuns({
    contracts: CONTRACTS, os: o.agentOs, baseEnv: o.env, spawn, kill: (pid, signal) => { process.kill(pid, signal); },
    sweep, killSession, childOf,
    stamps: { write: id => stamps.write(id, stampText(process.pid, myStart)), remove: id => stamps.remove(id) },
    watch: table,
    send: (channel, bytes) => mux.sendBytes(channel, bytes),
    backlog: () => mux.backlog().bulk,
    drop: channel => mux.dropBulk(channel),
    exited: (runId, exit, outBytes) => server?.runExited(runId, exit, outBytes),
    log: log.child("runs"), now: () => Date.now(),
  });
  // Packaged, the scripts sit beside the bundle; in development (dist/remote) they are the repo's.
  const parts = (p: string) => (o.packaged ? path.join(o.dir, p) : path.resolve(o.dir, "../..", p));
  const wsl = o.agentOs === "linux" && isWslHost();
  const desktop = new DesktopController({
    unavailable: o.agentOs === "darwin" ? "Ember can't use a Mac's screen over SSH yet; it can run commands there."
      : wsl ? `${host} is WSL on another PC: its Linux apps show on that PC's screen, so Ember will run commands only.` : null,
    host,
    // Wayland's "text" access waits for its CI job (L5); tests switch it on, and give the desktop logind can't give on
    // CI runners, in development builds only.
    discover: !o.packaged && o.env.EMBER_REMOTE_TEST_DESKTOP
      ? async () => testDesktop(o.env.EMBER_REMOTE_TEST_DESKTOP!)
      : () => discoverDesktop(realDesktopIo({ uid, user: user.username, home, host }), { waylandText: !o.packaged && o.env.EMBER_REMOTE_WAYLAND === "1" }),
    spawnChild: env => spawnGroup(process.execPath, ["--disable-sigusr1", self, "desktop", "--logs", places.logs], { ...env, ...(o.packaged ? {} : { EMBER_REMOTE_DEV: "1" }) }),
    baseEnv: o.env,
    scripts: { atspi: parts("sidecar/atspi/ember_atspi.py"), notice: parts("sidecar/notice/ember_notice.py") },
    audit: (entry, epoch) => (server ? server.auditStep(entry, epoch) : Promise.reject(new Error("not serving"))),
    changed: s => server?.event("desktop.changed", s),
    consoleStop: () => void server?.consoleStop(),
    log: log.child("desktop"), now: () => Date.now(),
  });
  const ownPaths = emberPaths(o.agentOs, places);
  const ember = () => ({
    paths: ownPaths,
    pids: [process.pid, ...(desktop.pid ? [desktop.pid] : [])],
    names: emberNamesRegExp(EMBER_NAMES),
  });
  // RUN's local runner answers inspect and git facts here as on the PC (the agent is "local" on its own machine).
  const local = createLocalRunner({
    log: log.child("local"), os: o.agentOs, env: o.env, ember: { paths: ember().paths, pids: () => ember().pids, names: ember().names },
    home, user: user.username, elevated: () => uid === 0, extraPath: extra, jobHost: null,
  });
  server = new Server({
    mux, log, pcId: o.pcId, partsId: o.partsId, os: o.agentOs, arch: o.arch, machineIdHash: machineHashHex, isWsl: wsl,
    uid, user: user.username, home, host, pid: process.pid, ...(tccLimited(o.agentOs, home) ? { tccLimited: true } : {}),
    policy,
    lock: (pcId, graceMs) => acquireLock({ file: places.lock, me: { pid: process.pid, start: myStart, pcId }, graceMs, io: fileLockIo(started), log }),
    facts: () => CONTRACTS.localFacts({ os: o.agentOs, env: o.env, home, user: user.username, elevated: () => uid === 0, extraPath: extra, ember: ember() }),
    ember,
    runs,
    inspect: (paths, cwd) => local.inspect(paths, cwd),
    git: cwd => local.gitFacts(cwd),
    classify: CONTRACTS.classifyCommand,
    audit,
    setAuditSource: s => { source = s; },
    consent: rec => {
      try { recordConsent(places.consent, rec); } catch (err) { log.warn("remote.consent_write_failed", { err }); }
    },
    desktop,
    orphans,
    // Old versions and runtimes (§5.2.6): a packaged agent only (a development one runs from the repo's dist).
    ...(o.packaged ? {
      cleanup: () => cleanUp({
        data: places.data, machine, partsId: o.partsId, runtimeId: runtimeIdOf(process.execPath, places.data, REAL_CLEANUP_IO),
        now: Date.now(), io: REAL_CLEANUP_IO, log: log.child("cleanup"),
      }),
    } : {}),
    exit: code => {
      watchdog.stop();
      desktop.stop();
      // The child had 50 ms to go on its stdin's end; its group goes now if it hasn't.
      setTimeout(() => { desktop.reap(); process.exit(code); }, 50);
    },
    now: () => Date.now(),
  });
  server.start();
  policy.start();
  process.on("SIGHUP", () => void server?.shutdown("link-lost", false));
  process.on("SIGTERM", () => void server?.shutdown("local", false));
  process.on("uncaughtException", err => {
    log.error("remote.uncaught", { err });
    setTimeout(() => process.exit(1), 3500).unref();
    void server?.shutdown("local", false).finally(() => process.exit(1));
  });
  // The PC can't read stdout any more: the link is gone.
  process.stdout.on("error", () => void server?.shutdown("link-lost", false));
}

/** Runs the agent (serve, or the desktop child). */
export function main(argv: string[] = process.argv.slice(2)): void {
  const env = process.env;
  if (hygieneProblem(env)) refuse("node-env");
  const agentOs: AgentOs = process.platform === "linux" || process.platform === "darwin" ? process.platform : refuse("os");
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : refuse("arch");
  const dir = path.dirname(__filename);
  const where = whereFrom({ dir, os: agentOs, home: homeOf(env), env, exists: fs.existsSync }) ?? refuse("not-packaged");
  const own = agentEnv(env, where.packaged);
  if (argv[0] === "desktop") {
    const i = argv.indexOf("--logs");
    const logs = i > 0 ? argv[i + 1] : undefined;
    if (!logs || !path.isAbsolute(logs)) refuse("bad-arguments");
    const log: Logger = createLogger({ dir: logs, level: levelOf(own), maxBytes: 1024 * 1024, keep: 3 }).child("desktop-child");
    runDesktopChild(log);
    return;
  }
  const args = parseServeArgs(argv) ?? refuse("bad-arguments");
  serve({ pcId: args.pcId, agentOs, arch, partsId: where.partsId, packaged: where.packaged, dir, env: own }).catch(err => {
    process.stderr.write(`EMBER-ERROR start ${err instanceof Error ? err.message.slice(0, 200).replace(/\s+/g, " ") : ""}\n`);
    process.exit(1);
  });
}

// The watchdog thread is this same bundle started with its role; the agent itself runs only as dist/remote's entry,
// never when a test imports the module.
if (!isMainThread && (workerData as WatchdogData | undefined)?.role === WATCHDOG_ROLE) runWatchdogThread(workerData as WatchdogData);
else if (isMainThread && typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) main();
