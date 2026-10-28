/**
 * The SSH connections (§5.1; owned by package SA): Ember's own connection to a host the user chose, with the user's
 * own SSH settings and keys but hardened, so nothing is forwarded, no master is left behind and no prompt appears
 * anywhere but Ember's prompt window. A connect resolves the host with `ssh -G` and refuses before anything runs when a
 * check fails (consent, the PC admin's allowed hosts for the host and every jump hop, settings that throw host keys
 * away, this same computer); tries batch mode first and asks through askpass only when the host key is new or a
 * password, passphrase or code is needed; probes the remote and refuses again before uploading anything; streams and
 * checks the runtime and the parts; says hello; and keeps the link alive in its own worker thread. After a loss it
 * reconnects in batch mode with backoff. Nothing here listens on a network port; no secret is on any argv or in any
 * log, and the GitHub token is absent from every child's environment. Plain Node; koffi only through askpass-pipe.ts.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import dns from "node:dns";
import { createReadStream, readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import nodeOs from "node:os";
import posix from "node:path/posix";
import win32 from "node:path/win32";
import { Worker } from "node:worker_threads";
import type { OS } from "../../shared/shortcuts";
import { FEATURE_CONSENT_VERSION } from "../../shared/consent";
import { DISTRO_NAME, HOST_ID } from "../../shared/targets";
import type { Logger } from "../logger";
import type { SettingsStore } from "../settings";
import { adminSummary, hostAllowed, type LoadedAdminPolicy } from "../admin";
import type { AuditLog } from "../policy/audit";
import type { JobHostRef } from "../commands/types";
import type { TargetsDeps } from "../targets/types";
import type { WslService } from "../wsl/types";
import { CAPS, type Hello, type Welcome } from "./protocol";
import { answerFor, createAskpassServer, promptCard, socketBases, writeAskpassWrapper, type AskpassChannel, type AskpassFs, type AskpassHandler } from "./askpass-server";
import { createAskpassPipe, loadPipeApi, type PipeApi } from "./askpass-pipe";
import { askpassSourceCandidates, ensureAskpassHelper, powershellPath, type AskpassWinDeps } from "./askpass-win";
import { BOOTSTRAP_SCRIPT } from "./bootstrap";
import { hopDest, hostLabel, validDest, validExtra, validPort, type Hop } from "./destination";
import { helloTimeoutMs, RemoteError, runAttempt, WorkerLink, type AttemptResult, type LinkPort, type ToWorker, type WorkerDecision } from "./link";
import { loadShipped, partsArchive, planShipped, shippedCandidates, type Shipped } from "./parts-cache";
import { planInstall, type Plan } from "./plan";
import { ensureRuntime, RuntimeError, type RuntimeFs } from "./runtime-download";
import { ioregPlatformUuid, isThisComputer, sameMachine, selfIdentity, type SelfIdentity } from "./same-machine";
import { childEnv, hopCommand, MAX_HOPS, sshArgv, sshCheckArgv, sshEnv, SshArgvError, sshGArgv, sshGHopArgv, sshVersionArgv, type AskpassEnv } from "./ssh-argv";
import { askpassWorks, knownHostsDiscarded, minimumVersion, parseSshG, parseSshVersion, sshClientPath, SshConfigError, unfixableSessionOption, versionAtLeast, type SshConfig, type SshVersion } from "./ssh-config";
import { bootstrapFailure, classifySshFailure, cleanLine, isLanAddress, MESSAGES, type SshFailure } from "./ssh-errors";
import { ConnectError, type ConnectProgress, type Connections, type HostRecord, type PromptUi, type RemoteLink } from "./types";

/** The 45 s deadline before the probe begins (§5.1.5), and the probe's own. */
export const CONNECT_DEADLINE_MS = 45_000;
export const PROBE_DEADLINE_MS = 60_000;
/** Reconnect backoff after a loss (§5.1.13), and when to give up. */
export const RECONNECT_BACKOFF_S = [1, 2, 4, 8, 16, 30] as const;
export const RECONNECT_GIVE_UP_MS = 10 * 60_000;
/** Failures a reconnect keeps trying through (the network and a dying agent's lock); anything else ends it. */
const RETRYABLE: ReadonlySet<string> = new Set(["network", "timeout", "dns", "busy", "busy-install", "unknown"]);
/** The command grace when no administrator sets `ssh.commandGraceSeconds` (L10; combineAdmin's "absent = 20"). */
const GRACE_DEFAULT_S = 20;
/** The time a quick ssh run (-V, -G, -O check) may take. */
const QUICK_MS = 15_000;

/** A quick process's result (`code` null: it couldn't start, or was killed). */
export interface ExecResult { code: number | null; stdout: string; stderr: string; missing?: boolean }

/** What tests replace; Ember uses the defaults. */
export interface ConnectionsInternals {
  env?: Readonly<Record<string, string | undefined>>;
  exec?: (argv: readonly string[], o: { env: Record<string, string>; timeoutMs: number }) => Promise<ExecResult>;
  newPort?: () => LinkPort;
  askpassFs?: AskpassFs;
  runtimeFs?: RuntimeFs;
  readText?: (p: string) => Promise<string>;
  readFileSync?: (p: string) => Uint8Array | null;
  networkAddresses?: () => string[];
  lookup?: (host: string) => Promise<string[]>;
  hostname?: () => string;
  osRelease?: () => string;
  askpassListen?: Parameters<typeof createAskpassServer>[0]["listen"];
  pipeApi?: () => PipeApi | null;
  windowsHelper?: (d: AskpassWinDeps) => ReturnType<typeof ensureAskpassHelper>;
  /** L22: connecting through a WSL distro's ssh only once `wsl2-windows` proved the stream binary-safe (verify). */
  viaWsl?: boolean;
  /** How long the runtime's download may go without a byte (RUNTIME_STALL_MS unless a test shortens it). */
  runtimeStallMs?: number;
  /** Timers for the reconnect backoff (tests use fake ones). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  now?: () => number;
}

/** The client Ember runs for a host: the system's OpenSSH or a WSL distro's (L22). */
interface Client { ssh: string; version: SshVersion; wsl?: { exe: string; distro: string } }

/** A connection's plan of attack, after every local check passed. */
interface Prepared {
  client: Client;
  cfg: SshConfig;
  hops: Hop[] | null;
  controlPath: string | null;
  names: string[];
  lan: boolean;
}

/** Ember's own refusal after the probe (planInstall's, or the machine-id and download checks). */
type Refusal = Extract<Plan, { action: "refuse" }>;

/** The ssh -G resolution as a host record keeps it. */
type Resolved = HostRecord["resolved"] & { controlPath: string | null };

const refuse = (f: { message: string; kind: string; fix?: string; retry?: boolean }) => new ConnectError(f.message, f.kind, f.fix, f.retry ?? false);

/** The SSH connections (§5.1). */
export function createConnections(o: {
  log: Logger; os: OS; userData: string; appDir: string; execPath: string; resourcesPath: string; settings: SettingsStore;
  admin: () => LoadedAdminPolicy; prompts: PromptUi; fetch: TargetsDeps["fetch"]; allowLoopback: boolean;
  audit: () => AuditLog | null; pcId: () => string; wsl: () => WslService | null; jobHost: JobHostRef | null;
}, internals: ConnectionsInternals = {}): Connections {
  const os: OS = o.os;
  const pc = os === "win32" ? win32 : posix;
  const env = (): Readonly<Record<string, string | undefined>> => internals.env ?? process.env;
  const log: Logger | undefined = o.log?.child?.("remote");
  const exec = internals.exec ?? realExec;
  const sleep = internals.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const unsleep = internals.clearTimeout ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));
  const now = internals.now ?? (() => Date.now());

  const links = new Map<string, WorkerLink>();
  const connecting = new Map<string, { promise: Promise<RemoteLink>; abort: AbortController }>();
  const reconnects = new Map<string, { timer: unknown; abort: AbortController }>();
  const closing = new Set<string>();
  const progressFns = new Set<(hostId: string, p: ConnectProgress) => void>();
  const clients = new Map<string, Promise<Client>>();
  let identity: Promise<SelfIdentity> | null = null;
  let wrapper: Promise<string> | null = null;
  let disposed = false;

  const progress = (hostId: string, p: ConnectProgress) => {
    for (const fn of progressFns) {
      try { fn(hostId, p); } catch (err) { log?.warn("remote.progress_listener_failed", { err }); }
    }
  };
  const audit = (entry: Record<string, unknown>) => {
    try { o.audit()?.write({ event: "remote", ...entry }); } catch (err) { log?.warn("remote.audit_failed", { err }); }
  };

  /** The PC admin's word on SSH at all (R5: a broken policy locks down, which turns SSH off). */
  const sshAllowed = (): LoadedAdminPolicy => {
    const loaded = o.admin();
    if (loaded.policy.features.ssh === false) throw new ConnectError(MESSAGES.sshOff(), "not-allowed");
    return loaded;
  };

  async function client(via: HostRecord["via"]): Promise<Client> {
    const key = via ?? "local";
    let c = clients.get(key);
    if (!c) {
      c = findClient(via);
      clients.set(key, c);
      c.catch(() => clients.delete(key));
    }
    return c;
  }

  async function findClient(via: HostRecord["via"]): Promise<Client> {
    let ssh: string;
    let wsl: Client["wsl"];
    if (via && via !== "local") {
      const distro = via.slice(4);
      if (os !== "win32" || !DISTRO_NAME.test(distro)) throw new ConnectError(MESSAGES.noClient(), "no-client");
      if (!internals.viaWsl) throw new ConnectError(`Ember can't use ${distro}'s SSH yet: connect from Windows' SSH, or add your key to Windows' ssh-agent.`, "via-wsl");
      const facts = await o.wsl()?.facts().catch(() => null);
      if (!facts?.wslExe) throw new ConnectError(MESSAGES.noClient(), "no-client");
      ssh = "/usr/bin/ssh";
      wsl = { exe: facts.wslExe, distro };
    } else {
      ssh = sshClientPath(os, env().SystemRoot ?? env().SYSTEMROOT);
    }
    const r = await exec(sshVersionArgv({ ssh, wsl }), { env: sshEnv(env(), { os, mode: "batch" }), timeoutMs: QUICK_MS });
    const version = parseSshVersion(`${r.stderr}\n${r.stdout}`);
    if (!version) throw new ConnectError(MESSAGES.noClient(), "no-client");
    const min = minimumVersion(wsl ? "linux" : os);
    if (!versionAtLeast(version, min.major, min.minor)) {
      throw new ConnectError(os === "win32" && !wsl ? MESSAGES.tooOldWindows() : MESSAGES.tooOld(), "too-old");
    }
    return { ssh, version, wsl };
  }

  /** `ssh -G` for a destination with its carried options; refuses what can't be read. */
  async function sshG(h: string, argv: string[]): Promise<SshConfig> {
    const r = await exec(argv, { env: sshEnv(env(), { os, mode: "batch" }), timeoutMs: QUICK_MS });
    if (r.code !== 0) {
      const line = cleanLine(r.stderr.split(/\r?\n/).find(l => l.trim()) ?? "") || "(nothing said)";
      throw new ConnectError(MESSAGES.config(h, line), "config");
    }
    try {
      return parseSshG(r.stdout);
    } catch (err) {
      if (err instanceof SshConfigError) throw new ConnectError(MESSAGES.jumpUnusable(h), "config");
      throw err;
    }
  }

  /** Every check that needs no connection (§5.1.3); the plan of attack when they all pass. */
  async function prepare(dest: string, port: number | undefined, extra: HostRecord["extra"], via: HostRecord["via"], h: string): Promise<Prepared> {
    if (!validDest(dest) || (port !== undefined && !validPort(port)) || !validExtra(extra)) throw new ConnectError(MESSAGES.answeredOddly(h), "bad-record");
    const admin = sshAllowed();
    const c = await client(via);
    let argv: string[];
    try {
      argv = sshGArgv({ ssh: c.ssh, dest, port, extra, wsl: c.wsl });
    } catch (err) {
      if (err instanceof SshArgvError) throw new ConnectError(MESSAGES.answeredOddly(h), "bad-record");
      throw err;
    }
    const cfg = await sshG(h, argv);
    if (knownHostsDiscarded(cfg)) throw new ConnectError(MESSAGES.knownHostsDiscarded(h), "known-hosts");
    if (!hostAllowed(admin.policy, cfg)) throw new ConnectError(MESSAGES.notAllowed(h), "not-allowed");
    const session = unfixableSessionOption(cfg, c.version);
    if (session) throw new ConnectError(MESSAGES.config(h, session), "config");
    let hops: Hop[] | null = null;
    if (cfg.proxyJump) {
      hops = cfg.proxyJump;
      if (hops.length > MAX_HOPS) throw new ConnectError(MESSAGES.jumpTooMany(h), "config");
      if (os === "win32" && !c.wsl && hops.length > 1) throw new ConnectError(MESSAGES.jumpWindows(), "config");
      for (const [i, hop] of hops.entries()) {
        const hc = await sshG(h, sshGHopArgv({ ssh: c.ssh, hop, configFile: extra?.configFile, wsl: c.wsl }));
        if (knownHostsDiscarded(hc)) throw new ConnectError(MESSAGES.knownHostsDiscarded(hopDest(hop)), "known-hosts");
        if (!hostAllowed(admin.policy, hc)) throw new ConnectError(MESSAGES.notAllowed(hopDest(hop)), "not-allowed");
        // The first hop's own ProxyJump would run unhardened (later hops get Ember's ProxyCommand, which wins).
        if (i === 0 && hc.proxyJump) throw new ConnectError(MESSAGES.jumpNested(h), "config");
      }
    }
    // Never this same computer: by address before ssh connects (§5.1.14), unless a jump host or a ProxyCommand
    // resolves the name elsewhere (the probe's identity check still runs).
    if (!o.allowLoopback && !hops && !cfg.proxyCommand) {
      const own = (internals.networkAddresses ?? realAddresses)();
      if (await isThisComputer(cfg.hostname, { own, lookup: internals.lookup ?? realLookup })) throw new ConnectError(MESSAGES.sameMachine(h), "same-machine");
    }
    let controlPath: string | null = null;
    if (cfg.controlPath && os !== "win32" && !c.wsl) {
      try {
        const r = await exec(sshCheckArgv({ ssh: c.ssh, controlPath: cfg.controlPath, dest, port }), { env: sshEnv(env(), { os, mode: "batch" }), timeoutMs: 5_000 });
        if (r.code === 0) controlPath = cfg.controlPath;
      } catch {
        // No master to ride: Ember's own connection.
      }
    }
    const names = [h, hostLabel(dest), cfg.hostname, extra?.options?.HostKeyAlias ?? "", cfg.raw.get("hostkeyalias")?.[0] ?? ""].filter(Boolean);
    return { client: c, cfg, hops, controlPath, names, lan: isLanAddress(cfg.hostname) };
  }

  /** Refuses a host whose ssh -G resolution isn't the one the user consented to (§7.4: asked again). */
  function sameResolution(p: Prepared, host: HostRecord, h: string): void {
    const r = resolvedOf(p);
    if (r.user !== host.resolved.user || r.hostname !== host.resolved.hostname || r.port !== host.resolved.port || r.jump.join(",") !== host.resolved.jump.join(",")) {
      throw new ConnectError(MESSAGES.resolutionChanged(h), "resolution-changed");
    }
  }

  function resolvedOf(p: Prepared): Resolved {
    return {
      user: p.cfg.user,
      hostname: p.cfg.hostname,
      port: p.cfg.port,
      jump: (p.hops ?? []).map(h => `${hopDest(h)}${h.port !== undefined ? `:${h.port}` : ""}`),
      controlPath: p.controlPath,
    };
  }

  /** The worker for one attempt. */
  function newPort(): LinkPort {
    if (internals.newPort) return internals.newPort();
    const w = new Worker(pc.join(o.appDir, "remote-link.cjs"), { workerData: { emberLinkWorker: true } });
    return {
      post: m => w.postMessage(m),
      onMessage: fn => { w.on("message", fn); return () => { w.off("message", fn); }; },
      onExit: fn => {
        const onExit = (code: number) => fn(`exit ${code}`);
        const onError = () => fn("error");
        w.on("exit", onExit);
        w.on("error", onError);
        return () => { w.off("exit", onExit); w.off("error", onError); };
      },
      terminate: async () => { await w.terminate(); },
    };
  }

  /** The argv and spawn options of one attempt (§5.1.4): POSIX detached; Windows hidden, under the job host. */
  function startMessage(p: Prepared, host: Pick<HostRecord, "dest" | "port" | "extra">, mode: "batch" | "interactive", acceptNewKey: boolean, runEnv: Record<string, string>): Extract<ToWorker, { t: "start" }> {
    const proxyCommand = p.hops ? hopCommand({ ssh: p.client.ssh, os: p.client.wsl ? "linux" : os, hops: p.hops, mode, configFile: host.extra?.configFile }) : null;
    let argv = sshArgv({
      ssh: p.client.ssh, os: p.client.wsl ? "linux" : os, version: p.client.version, dest: host.dest, port: host.port, mode,
      acceptNewKey, controlPath: p.controlPath, proxyCommand, extra: host.extra, wsl: p.client.wsl,
    });
    let spawnEnv = runEnv;
    if (os === "win32" && o.jobHost) {
      argv = [o.jobHost.execPath, o.jobHost.script, "--interactive", "--", ...argv];
      spawnEnv = { ...runEnv, ELECTRON_RUN_AS_NODE: "1" };
    }
    return {
      t: "start", argv, env: spawnEnv, spawn: { detached: os !== "win32", windowsHide: true }, script: BOOTSTRAP_SCRIPT,
      deadlineMs: CONNECT_DEADLINE_MS, probeMs: PROBE_DEADLINE_MS, stallMs: 5_000, graceMs: (o.admin().policy.ssh?.commandGraceSeconds ?? GRACE_DEFAULT_S) * 1000,
    };
  }

  /** Can this client ask through Ember's prompt here (askpass, §5.1.6; L15)? */
  async function askpassReady(c: Client): Promise<boolean> {
    if (c.wsl || !askpassWorks(os, c.version)) return false;
    if (os !== "win32") return true;
    return (await windowsHelper()) !== null && (internals.pipeApi ?? (() => loadPipeApi(log)))() !== null;
  }

  let helper: Promise<string | null> | null = null;
  function windowsHelper(): Promise<string | null> {
    helper ??= (async () => {
      const candidates = askpassSourceCandidates({ resourcesPath: o.resourcesPath, appDir: o.appDir });
      let source: string | null = null;
      for (const c of candidates) {
        if (await fsp.stat(c).then(() => true, () => false)) { source = c; break; }
      }
      if (!source) return null;
      const r = await (internals.windowsHelper ?? ensureAskpassHelper)({
        userData: o.userData, source, powershell: powershellPath(env().SystemRoot ?? env().SYSTEMROOT), env: childEnv(env(), os),
        run: runWithStdin,
        fs: { readFile: p => fsp.readFile(p), writeFile: (p, d) => fsp.writeFile(p, d), rename: (a, b) => fsp.rename(a, b), rm: p => fsp.rm(p, { force: true }), mkdir: p => fsp.mkdir(p, { recursive: true }) },
        log,
      });
      if ("error" in r) {
        log?.warn("remote.askpass_helper_unavailable", { why: r.error });
        return null;
      }
      return r.exe;
    })();
    return helper;
  }

  /** Opens one interactive run's askpass channel. */
  async function openAskpass(handler: AskpassHandler): Promise<{ channel: AskpassChannel; env: AskpassEnv }> {
    if (os === "win32") {
      const exe = await windowsHelper();
      const api = (internals.pipeApi ?? (() => loadPipeApi(log)))();
      if (!exe || !api) throw new Error("no askpass");
      const channel = await createAskpassPipe({ api, handler, log });
      return { channel, env: { kind: "pipe", program: exe, pipe: channel.address, nonce: channel.nonce } };
    }
    const fs = internals.askpassFs ?? (fsp as unknown as AskpassFs);
    wrapper ??= writeAskpassWrapper({ fs, userData: o.userData, execPath: o.execPath, appDir: o.appDir });
    wrapper.catch(() => { wrapper = null; });
    const program = await wrapper;
    const channel = await createAskpassServer({
      bases: socketBases({ os, userData: o.userData, xdgRuntimeDir: env().XDG_RUNTIME_DIR, darwinTemp: env().TMPDIR }),
      fs, handler, log, listen: internals.askpassListen,
    });
    return { channel, env: { kind: "socket", program, sock: channel.address, nonce: channel.nonce } };
  }

  /** This PC's identity for the same-machine rule (once). */
  function self(): Promise<SelfIdentity> {
    identity ??= selfIdentity({
      os,
      readFile: internals.readFileSync ?? (p => { try { return readFileSync(p); } catch { return null; } }),
      ioregUuid: async () => {
        const r = await exec(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], { env: childEnv(env(), os), timeoutMs: 5_000 });
        return ioregPlatformUuid(r.stdout);
      },
      wslBoots: async () => (await o.wsl()?.bootIds()) ?? [],
    });
    return identity;
  }

  /** The decision after the probe (§5.1.9): Ember's plan, with the download and the parts' checks before any upload. */
  function decider(host: HostRecord, h: string, refusal: { plan: Refusal | null }, signal: AbortSignal) {
    return async (probe: Record<string, string>): Promise<WorkerDecision> => {
      const [me, shipped] = await Promise.all([self(), shippedNow()]);
      const settings = o.settings.get();
      const plan = planInstall(probe, {
        host: h, pcId: o.pcId(), self: me, allowLoopback: o.allowLoopback, localAdmin: o.admin(),
        models: [settings.models.conductor, settings.models.worker].filter((m): m is string => !!m),
        ...planShipped(shipped),
      });
      if (plan.action === "refuse") { refusal.plan = plan; return { kind: "quit" }; }
      // The remote is another computer than the one the user allowed (§7.4): asked again, nothing uploaded.
      const machine = /^[0-9a-f]{64}$/.test(probe.machine ?? "") ? probe.machine : null;
      if (host.machineIdHash && machine && machine !== host.machineIdHash) {
        refusal.plan = { action: "refuse", kind: "machine-changed", message: MESSAGES.machineChanged(h) };
        return { kind: "quit" };
      }
      if (plan.action === "serve") return { kind: "serve", line: plan.line, partsId: plan.partsId };
      const archives: Extract<WorkerDecision, { kind: "install" }>["archives"] = [];
      if (plan.runtime) {
        progress(host.id, { step: "downloading", done: 0, total: plan.runtime.bytes });
        try {
          const rt = await ensureRuntime({
            manifest: shipped.runtime as NonNullable<Shipped["runtime"]>, target: plan.target, format: plan.runtime.format,
            dir: pc.join(o.userData, "remote", "runtime"), file: n => pc.join(o.userData, "remote", "runtime", n),
            fs: runtimeFs(), fetch: o.fetch, mirror: o.admin().policy.ssh?.runtimeMirror, signal,
            progress: (done, total) => progress(host.id, { step: "downloading", done, total }),
            ...(internals.runtimeStallMs !== undefined ? { stallMs: internals.runtimeStallMs } : {}),
          });
          archives.push({ name: "runtime", bytes: rt.bytes, path: rt.path });
        } catch (err) {
          const e = err instanceof RuntimeError ? err : new RuntimeError("download", "it stopped");
          const message = e.kind === "mismatch" ? MESSAGES.downloadMismatch(h) : e.kind === "stalled" ? MESSAGES.downloadStalled(h) : MESSAGES.download(h, e.reason);
          refusal.plan = { action: "refuse", kind: "download", message, retry: true };
          return { kind: "quit" };
        }
      }
      if (plan.parts) {
        const parts = await partsArchive(shipped, plan.target, { fs: runtimeFs(), join: pc.join });
        if (!parts) {
          refusal.plan = { action: "refuse", kind: "parts-missing", message: MESSAGES.partsMissing() };
          return { kind: "quit" };
        }
        archives.push({ name: "parts", bytes: parts.bytes, path: parts.path });
      }
      return { kind: "install", line: plan.line, partsId: plan.partsId, archives };
    };
  }

  let shippedCache: Promise<Shipped> | null = null;
  function shippedNow(): Promise<Shipped> {
    shippedCache ??= loadShipped({
      candidates: shippedCandidates({ resourcesPath: o.resourcesPath, appDir: o.appDir, join: pc.join }),
      readFile: internals.readText ?? (p => fsp.readFile(p, "utf8")),
      join: pc.join,
    });
    return shippedCache;
  }

  function runtimeFs(): RuntimeFs {
    return internals.runtimeFs ?? {
      stat: p => fsp.stat(p),
      open: async p => { const fh = await fsp.open(p, "w", 0o600); return { write: b => fh.write(b), close: () => fh.close() }; },
      createReadStream: p => createReadStream(p),
      rename: (a, b) => fsp.rename(a, b),
      rm: (p, ro) => fsp.rm(p, ro),
      mkdir: (p, mo) => fsp.mkdir(p, mo),
    };
  }

  /** ssh's failure in Ember's words (§5.1.8), with what the attempt knew. */
  function failureOf(r: Extract<AttemptResult, { kind: "failed" }>, p: Prepared, h: string, mode: "batch" | "interactive", cancelledByUser: boolean, promptRefused = false): SshFailure {
    if (r.cancelled || cancelledByUser) return { kind: "cancelled", message: MESSAGES.cancelled(), retry: true };
    if (r.deadline) return { kind: "timeout", message: MESSAGES.timeout(h), retry: true };
    if (r.spawnFailed) return { kind: "no-client", message: MESSAGES.noClient(), retry: false };
    if (r.error) return bootstrapFailure(r.error.code, r.error.detail, h);
    const darwinMajor = os === "darwin" ? Number((internals.osRelease ?? nodeOs.release)().split(".")[0]) : undefined;
    const f = classifySshFailure(r.exit?.stderr ?? "", r.exit?.code ?? null, { probeBegan: r.probeBegan, os, darwinMajor, lan: p.lan, host: h });
    // A jump host's unknown key can't be accepted through Ember (its hop checks strictly): the terminal advice, by name.
    if (f.kind === "unknown-host-key" && p.hops) {
      const named = /host key is known for (\S+?) and/.exec(r.exit?.stderr ?? "")?.[1];
      if (named && !p.names.some(n => n.toLowerCase() === named.toLowerCase())) return { ...f, kind: "unknown-hop-key", message: MESSAGES.unknownKeyNoAskpass(cleanLine(named, 100)), retry: false };
    }
    // A sign-in card the prompt window couldn't show (no window, or a question too long to show): nobody was asked.
    if (mode === "interactive" && f.kind === "auth" && promptRefused) return { ...f, message: MESSAGES.promptRefused(h), retry: true };
    if (mode === "interactive" && f.kind === "auth") return { ...f, message: MESSAGES.signInFailed(h), retry: true };
    return f;
  }

  /** One attempt end to end: the worker, its decision, its result (and the port, kept open when serving). */
  async function attempt(p: Prepared, host: HostRecord, h: string, mode: "batch" | "interactive", acceptNewKey: boolean, signal: AbortSignal, decision: "plan" | "uninstall"): Promise<{ r: AttemptResult; port: LinkPort; refusal: Refusal | null; cancelledByUser: boolean; promptRefused: boolean }> {
    const refusal: { plan: Refusal | null } = { plan: null };
    let cancelledByUser = false, promptRefused = false;
    let channel: AskpassChannel | null = null;
    let control: ReturnType<typeof runAttempt> | null = null;
    let runEnv: Record<string, string>;
    if (mode === "interactive") {
      const handler: AskpassHandler = async (req, sig) => {
        const card = promptCard(req, { id: `ssh-${randomUUID()}`, host: h, names: p.names, client: p.client.version });
        audit({ step: "prompt", host: host.id, kind: card.kind === "secret" ? card.secret : card.kind });
        control?.pause();
        const onAbort = () => o.prompts.dismiss(card.id);
        sig.addEventListener("abort", onAbort, { once: true });
        try {
          const answer = await o.prompts.ask(card);
          // The user's Cancel or Esc, not the prompt window's own refusal of a card it couldn't show (review #193).
          if (!answer.ok && answer.refused) promptRefused = true;
          else if (!answer.ok && card.kind !== "touch") cancelledByUser = true;
          return answerFor(card, answer);
        } finally {
          sig.removeEventListener("abort", onAbort);
          control?.resume();
        }
      };
      const opened = await openAskpass(handler);
      channel = opened.channel;
      runEnv = sshEnv(env(), { os, mode: "interactive", askpass: opened.env });
    } else {
      runEnv = sshEnv(env(), { os, mode: "batch" });
    }
    const port = newPort();
    try {
      const start = startMessage(p, host, mode, acceptNewKey, runEnv);
      control = runAttempt(port, start, {
        decide: decision === "uninstall" ? async () => ({ kind: "uninstall" }) : decider(host, h, refusal, signal),
        progress: x => progress(host.id, x.step === "checking" ? { step: "checking" } : x),
        signal, log,
      });
      progress(host.id, { step: "connecting" });
      const r = await control.result;
      return { r, port, refusal: refusal.plan, cancelledByUser, promptRefused };
    } catch (err) {
      await port.terminate().catch(() => undefined);
      throw err;
    } finally {
      await channel?.close().catch(() => undefined);
    }
  }

  /** The agent says hello; Ember checks what it says (§7.2.6). */
  async function hello(link: WorkerLink, host: HostRecord, h: string, probe: Record<string, string>, partsId: string): Promise<Welcome> {
    const admin = o.admin();
    const settings = o.settings.get();
    const neverLook = [...new Set([...settings.privacy.neverLook, ...admin.policy.neverLook])].map(s => s.slice(0, CAPS.str.app)).slice(0, CAPS.neverLook);
    const args: Hello = {
      proto: 1, partsId,
      local: { name: (internals.hostname ?? nodeOs.hostname)().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64), os }, // eslint-disable-line no-control-regex -- control characters are removed from the PC's name
      pcId: o.pcId(),
      consent: { version: host.consent.version, at: String(host.consent.at).slice(0, 64) },
      neverLook,
      localAdmin: adminSummary(admin),
      epoch: 0,
    };
    let w: Welcome;
    try {
      // Longer than the agent may wait for this PC's previous agent to let go of its lock (a reconnect's takeover).
      w = await link.request("hello", args, { timeoutMs: helloTimeoutMs(admin.policy.ssh?.commandGraceSeconds ?? GRACE_DEFAULT_S) });
    } catch (err) {
      if (err instanceof RemoteError && err.code === "busy") throw new ConnectError(MESSAGES.busy(h), "busy", undefined, true);
      if (err instanceof RemoteError && err.code === "denied") throw new ConnectError(MESSAGES.remoteNotAllowed(h), "remote-policy");
      // No answer in time is the network's or a busy remote's: a reconnect tries again (an odd answer never does).
      if (err instanceof RemoteError && err.code === "timeout") throw new ConnectError(MESSAGES.timeout(h), "timeout", undefined, true);
      throw new ConnectError(MESSAGES.answeredOddly(h), "protocol");
    }
    const me = await self();
    const wantOs = probe.os === "Darwin" ? "darwin" : probe.os === "Linux" ? "linux" : null;
    const wantArch = /^(x86_64|amd64)$/.test(probe.arch ?? "") ? "x64" : /^(aarch64|arm64)$/.test(probe.arch ?? "") ? "arm64" : null;
    // The welcome's machine id is judged by the probe's own rule (§5.1.14): machine and boot id together on Linux, so a
    // clone of this PC's image with its own boot id (critique remote-22) is let through here as it was before upload.
    const sameAsThis = sameMachine({ os: probe.os ?? "", machine: w.machineIdHash, boot: probe.boot ?? "", wsl: probe.wsl ?? "" }, me) !== null;
    const odd = w.partsId !== partsId || w.os !== wantOs || w.arch !== wantArch || !w.home.startsWith("/") || !w.facts.home.startsWith("/") || !Number.isInteger(w.uid)
      || (!o.allowLoopback && sameAsThis);
    if (odd) throw new ConnectError(MESSAGES.answeredOddly(h), "protocol");
    return w;
  }

  /** Remembers the remote's machine id (first connection) and when it was last used. */
  function remember(hostId: string, machine: string | null): void {
    try {
      const own = o.settings.own();
      const hosts = own.targets.hosts;
      if (!hosts.some(x => x.id === hostId)) return;
      const next = hosts.map(x => (x.id === hostId ? { ...x, ...(machine && !x.machineIdHash ? { machineIdHash: machine } : {}), lastUsed: new Date(now()).toISOString() } : x));
      o.settings.update({ targets: { ...own.targets, hosts: next } });
    } catch (err) {
      log?.warn("remote.remember_failed", { err });
    }
  }

  /** Every check, the batch attempt, the interactive one when needed and allowed, then hello (§5.1.5). */
  async function doConnect(host: HostRecord, mode: { interactive: boolean; reconnect: boolean }, signal: AbortSignal): Promise<RemoteLink> {
    const h = hostLabel(host.dest);
    const started = now();
    try {
      if (!HOST_ID.test(host.id)) throw new ConnectError(MESSAGES.answeredOddly(h), "bad-record");
      if (!(host.consent.version >= FEATURE_CONSENT_VERSION.ssh) || !host.consent.at) throw new ConnectError(MESSAGES.noConsent(h), "consent");
      // The targets runtime makes this install's id at first use; without it the remote couldn't tell this PC's lock.
      if (!/^[0-9a-f]{32}$/.test(o.pcId())) throw new ConnectError(MESSAGES.unknown(h), "internal");
      progress(host.id, { step: "resolving" });
      const p = await prepare(host.dest, host.port, host.extra, host.via, h);
      sameResolution(p, host, h);
      audit({ step: "connect", host: host.id, interactive: mode.interactive, reconnect: mode.reconnect });
      let run = await attempt(p, host, h, "batch", false, signal, "plan");
      if (run.r.kind === "failed") {
        await run.port.terminate().catch(() => undefined);
        const f = failureOf(run.r, p, h, "batch", false);
        const needsPrompt = f.kind === "unknown-host-key" || f.kind === "auth";
        if (!needsPrompt || !mode.interactive || mode.reconnect || !(await askpassReady(p.client))) throw refuse(f);
        run = await attempt(p, host, h, "interactive", f.kind === "unknown-host-key", signal, "plan");
        if (run.r.kind === "failed") {
          await run.port.terminate().catch(() => undefined);
          throw refuse(failureOf(run.r, p, h, "interactive", run.cancelledByUser, run.promptRefused));
        }
      }
      if (run.r.kind === "done") {
        await run.port.terminate().catch(() => undefined);
        throw refuse(run.refusal ?? { kind: "remote", message: MESSAGES.remoteStopped(h, "quit") });
      }
      progress(host.id, { step: "starting" });
      const shipped = await shippedNow();
      const link = new WorkerLink(run.port, { id: randomUUID(), hostId: host.id, log });
      let welcome: Welcome;
      try {
        welcome = await hello(link, host, h, run.r.probe, shipped.parts?.manifest.partsId ?? "");
      } catch (err) {
        await link.kill("hello");
        throw err;
      }
      link.setWelcome(welcome);
      // The agent applies the smaller of both machines' grace; the PC's own limit holds whatever the agent says (L10).
      link.setGrace(Math.min(welcome.graceSeconds, o.admin().policy.ssh?.commandGraceSeconds ?? GRACE_DEFAULT_S));
      if (signal.aborted) {
        await link.close("cancelled");
        throw new ConnectError(MESSAGES.cancelled(), "cancelled", undefined, true);
      }
      const old = links.get(host.id);
      links.set(host.id, link);
      // The map holds the new link first, so the old one's end isn't taken for a loss to reconnect from.
      if (old && old !== link) void old.kill("replaced");
      remember(host.id, /^[0-9a-f]{64}$/.test(run.r.probe.machine ?? "") ? run.r.probe.machine : null);
      link.onState((s, why) => {
        const current = links.get(host.id) === link;
        if (current && (s === "lost" || s === "closed")) links.delete(host.id);
        if (s === "lost" && current) void onLost(host.id, link, why);
      });
      audit({ step: "connected", host: host.id, ms: now() - started });
      log?.info("remote.connected", { host: host.id, ms: now() - started, os: welcome.os, desktop: welcome.desktop.access });
      progress(host.id, { step: "ready" });
      return link;
    } catch (err) {
      const e = err instanceof ConnectError ? err : new ConnectError(MESSAGES.unknown(h), "unknown", undefined, true);
      if (!(err instanceof ConnectError)) log?.warn("remote.connect_crashed", { err });
      audit({ step: "failed", host: host.id, kind: e.kind });
      log?.info("remote.connect_failed", { host: host.id, kind: e.kind });
      // A reconnect's failure is told by onLost, which knows whether it tries again.
      if (!mode.reconnect) progress(host.id, { step: "failed", message: e.message, ...(e.fix ? { fix: e.fix } : {}), retry: e.retry, kind: e.kind });
      throw e;
    }
  }

  /**
   * After a loss (not a Disconnect): batch reconnects with backoff, ending at a failure that needs the user (§5.1.13).
   * Each failed try is told as progress `failed` whose `retry` says whether another try follows: false once it gives
   * up, so the runtime stops saying "trying again" (and asks the user to sign in when that is what it needs).
   */
  async function onLost(hostId: string, link: WorkerLink, why: string | undefined): Promise<void> {
    audit({ step: "lost", host: hostId });
    log?.info("remote.lost", { host: hostId, why: why?.slice(0, 60) });
    await link.kill(why ?? "lost").catch(() => undefined);
    if (disposed || closing.has(hostId) || reconnects.has(hostId)) return;
    const since = now();
    const abort = new AbortController();
    const entry: { timer: unknown; abort: AbortController } = { timer: null, abort };
    reconnects.set(hostId, entry);
    let tries = 0;
    const next = () => {
      const delay = RECONNECT_BACKOFF_S[Math.min(tries, RECONNECT_BACKOFF_S.length - 1)] * 1000;
      tries++;
      entry.timer = sleep(() => { void once(); }, delay);
    };
    const end = () => { if (reconnects.get(hostId) === entry) reconnects.delete(hostId); };
    const once = async () => {
      if (abort.signal.aborted || disposed) return end();
      const host = o.settings.get().targets.hosts.find(x => x.id === hostId);
      if (!host) return end();
      try {
        await doConnect(host, { interactive: false, reconnect: true }, abort.signal);
        end();
      } catch (err) {
        if (abort.signal.aborted || disposed) return end();
        const e = err instanceof ConnectError ? err : new ConnectError(MESSAGES.unknown(hostLabel(host.dest)), "unknown", undefined, true);
        const again = RETRYABLE.has(e.kind) && now() - since < RECONNECT_GIVE_UP_MS;
        progress(hostId, { step: "failed", message: e.message, ...(e.fix ? { fix: e.fix } : {}), retry: again, kind: e.kind });
        if (!again) return end();
        next();
      }
    };
    next();
  }

  /** The user's Disconnect: no reconnect, bye and EOF to the agent. */
  async function disconnect(hostId: string): Promise<void> {
    closing.add(hostId);
    stopReconnect(hostId);
    connecting.get(hostId)?.abort.abort();
    const link = links.get(hostId);
    links.delete(hostId);
    if (link) {
      await link.close("disconnect");
      audit({ step: "disconnected", host: hostId });
    }
  }

  function stopReconnect(hostId: string): void {
    const r = reconnects.get(hostId);
    if (!r) return;
    reconnects.delete(hostId);
    r.abort.abort();
    unsleep(r.timer);
  }

  return {
    connect(host, co) {
      const existing = links.get(host.id);
      if (existing && (existing.state === "ready" || existing.state === "stalled")) return Promise.resolve(existing);
      const busy = connecting.get(host.id);
      if (busy) return busy.promise;
      stopReconnect(host.id);
      closing.delete(host.id);
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      co.signal?.addEventListener("abort", onAbort, { once: true });
      if (co.signal?.aborted) abort.abort();
      const promise = doConnect(host, { interactive: co.interactive, reconnect: false }, abort.signal).finally(() => {
        co.signal?.removeEventListener("abort", onAbort);
        connecting.delete(host.id);
      });
      connecting.set(host.id, { promise, abort });
      return promise;
    },

    disconnect,

    link(hostId) {
      const l = links.get(hostId);
      return l && (l.state === "ready" || l.state === "stalled") ? l : null;
    },

    async uninstall(host) {
      const h = hostLabel(host.dest);
      await disconnect(host.id);
      const abort = new AbortController();
      try {
        progress(host.id, { step: "resolving" });
        const p = await prepare(host.dest, host.port, host.extra, host.via, h);
        // Removal goes only to the computer the user allowed, as a connection does.
        sameResolution(p, host, h);
        let run = await attempt(p, host, h, "batch", false, abort.signal, "uninstall");
        if (run.r.kind === "failed") {
          await run.port.terminate().catch(() => undefined);
          const f = failureOf(run.r, p, h, "batch", false);
          if ((f.kind !== "unknown-host-key" && f.kind !== "auth") || !(await askpassReady(p.client))) throw refuse(f);
          run = await attempt(p, host, h, "interactive", f.kind === "unknown-host-key", abort.signal, "uninstall");
        }
        await run.port.terminate().catch(() => undefined);
        if (run.r.kind === "failed") throw refuse(failureOf(run.r, p, h, "interactive", run.cancelledByUser, run.promptRefused));
        if (run.r.kind !== "done" || !run.r.uninstalled) throw refuse({ kind: "remote", message: MESSAGES.remoteStopped(h, "uninstall") });
        audit({ step: "uninstalled", host: host.id });
      } catch (err) {
        const e = err instanceof ConnectError ? err : new ConnectError(MESSAGES.unknown(h), "unknown", undefined, true);
        audit({ step: "failed", host: host.id, kind: e.kind, uninstall: true });
        progress(host.id, { step: "failed", message: e.message, ...(e.fix ? { fix: e.fix } : {}), retry: e.retry, kind: e.kind });
        throw e;
      }
    },

    async resolve(dest, ro = {}) {
      const h = hostLabel(dest);
      try {
        return resolvedOf(await prepare(dest, ro.port, ro.extra, ro.via, h));
      } catch (err) {
        if (err instanceof ConnectError) throw err;
        log?.warn("remote.resolve_crashed", { err });
        throw new ConnectError(MESSAGES.unknown(h), "unknown", undefined, true);
      }
    },

    onProgress(fn) {
      progressFns.add(fn);
      return () => { progressFns.delete(fn); };
    },

    async stopAll() {
      for (const id of [...reconnects.keys()]) stopReconnect(id);
      for (const c of connecting.values()) c.abort.abort();
      await Promise.all([...links.values()].map(l => l.stop().catch(() => undefined)));
    },

    async dispose() {
      disposed = true;
      for (const id of [...reconnects.keys()]) stopReconnect(id);
      for (const c of connecting.values()) c.abort.abort();
      const all = [...links.entries()];
      links.clear();
      await Promise.all(all.map(([id, l]) => { closing.add(id); return l.close("quit").catch(() => undefined); }));
    },
  };
}

/** Runs a quick process (no shell; hidden on Windows; bounded output and time). */
function realExec(argv: readonly string[], o: { env: Record<string, string>; timeoutMs: number }): Promise<ExecResult> {
  return new Promise(resolve => {
    execFile(argv[0], argv.slice(1), { env: o.env, timeout: o.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      if (e && e.code === "ENOENT") return resolve({ code: null, stdout: "", stderr: "", missing: true });
      resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Runs a process with text on its stdin (Windows PowerShell's `-Command -`). */
function runWithStdin(argv: string[], o: { stdin: string; env: Record<string, string>; timeoutMs: number }): Promise<{ code: number | null; stdout: string }> {
  return new Promise(resolve => {
    const child = execFile(argv[0], argv.slice(1), { env: o.env, timeout: o.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, stdout: String(stdout ?? "") });
    });
    child.stdin?.end(o.stdin);
  });
}

/** This PC's interface addresses. */
function realAddresses(): string[] {
  return Object.values(nodeOs.networkInterfaces()).flatMap(list => (list ?? []).map(i => i.address));
}

/** Every address a name resolves to. */
async function realLookup(host: string): Promise<string[]> {
  const r = await dns.promises.lookup(host, { all: true });
  return r.map(a => a.address);
}
