/**
 * The PC's end of the remote agent's protocol for the integration suites (remote-ssh, remote-el8, remote-desktop,
 * remote-wayland): the real mux over a process's stdio (an `ssh` to a test sshd, or the built agent run directly),
 * requests answered by id, events and bulk bytes collected. It speaks exactly what SC's RemoteLink will (§5.4), without
 * the PC's own gate, so each suite can send the stamps gate 2 must judge. Test-only.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMux } from "../../app/main/remote/mux";
import type { EvMap, EvName, Hello, Msg, Op, OpArgs, OpResult } from "../../app/main/remote/protocol";
import { AdminPolicySchema, adminSummary } from "../../app/main/admin";
import type { CommandStamp, RunSpec } from "../../app/main/commands/types";
import type { Logger } from "../../app/main/logger";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** The built agent (npm run build). */
export const AGENT = path.join(ROOT, "dist/remote/ember-remote.cjs");
export const PC_ID = "0123456789abcdef0123456789abcdef";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; }, file: "" } as unknown as Logger;

/** A refused request: the protocol's error code and the agent's words. */
export class RemoteError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}

/** One link to an agent. */
export interface AgentLink {
  proc: ChildProcess;
  request<O extends Op>(op: O, a: OpArgs<O>, timeoutMs?: number): Promise<OpResult<O>>;
  /** Waits for an event (`ms` at most). */
  event<E extends EvName>(ev: E, pick?: (d: EvMap[E]) => boolean, ms?: number): Promise<EvMap[E]>;
  /** A bulk channel's bytes so far. */
  bytes(channel: number): Buffer;
  /** Waits until a channel holds `n` bytes. */
  waitBytes(channel: number, n: number, ms?: number): Promise<Buffer>;
  /** Stops pinging (the agent then sees silence: its dead-man, then its grace). */
  silence(): void;
  /** Closes the PC's end of the stdio (EOF at the agent). */
  end(): void;
  exited: Promise<number | null>;
  stderr(): string;
}

/** Starts `command args` and speaks the protocol over its stdio. */
export function connect(command: string, args: string[], o: { env?: NodeJS.ProcessEnv; partsId: string }): AgentLink {
  const proc = spawn(command, args, { env: o.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  proc.stderr!.on("data", d => { err += String(d); });
  const exited = new Promise<number | null>(r => proc.on("exit", c => r(c)));
  const mux = createMux({ read: proc.stdout!, write: proc.stdin!, role: "pc", partsId: o.partsId, log: quiet });
  let id = 0;
  const waiting = new Map<number, (m: Msg) => void>();
  const events: { ev: EvName; d: unknown }[] = [];
  const listeners = new Set<() => void>();
  const chunks = new Map<number, Buffer>();
  mux.onMessage(m => {
    if (m.t === "res") waiting.get(m.id)?.(m);
    else if (m.t === "ev") { events.push({ ev: m.ev, d: m.d }); for (const fn of listeners) fn(); }
  });
  mux.onBytes((ch, b) => { chunks.set(ch, Buffer.concat([chunks.get(ch) ?? Buffer.alloc(0), Buffer.from(b)])); for (const fn of listeners) fn(); });
  const ping = setInterval(() => mux.ping(), 300);
  proc.on("exit", () => clearInterval(ping));
  const until = <T>(find: () => T | undefined, ms: number, what: string) => new Promise<T>((resolve, reject) => {
    const check = () => {
      const v = find();
      if (v === undefined) return;
      listeners.delete(check);
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`timed out waiting for ${what}`)); }, ms);
    listeners.add(check);
    check();
  });
  return {
    proc,
    request(op, a, timeoutMs = 30_000) {
      const n = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(n); reject(new Error(`${op} timed out`)); }, timeoutMs);
        waiting.set(n, m => {
          clearTimeout(timer);
          waiting.delete(n);
          if (m.t === "res" && m.ok) resolve(m.v as never);
          else if (m.t === "res" && !m.ok) reject(new RemoteError(m.e.code, m.e.m));
        });
        mux.send({ t: "req", id: n, op, a });
      });
    },
    event: (ev, pick = () => true, ms = 15_000) => until(() => events.find(e => e.ev === ev && pick(e.d as never))?.d as never, ms, ev),
    bytes: ch => chunks.get(ch) ?? Buffer.alloc(0),
    waitBytes: (ch, n, ms = 15_000) => until(() => ((chunks.get(ch)?.length ?? 0) >= n ? chunks.get(ch) : undefined), ms, `${n} bytes on channel ${ch}`),
    silence: () => clearInterval(ping),
    end: () => { clearInterval(ping); proc.stdin!.end(); },
    exited,
    stderr: () => err,
  };
}

/** The built agent run directly, as a development build (EMBER_REMOTE_DEV=1) with its own HOME. */
export function connectLocal(o: { home: string; env?: NodeJS.ProcessEnv; partsId?: string }): AgentLink {
  const partsId = o.partsId ?? "0.0.0-test";
  if (!fs.existsSync(AGENT)) throw new Error("dist/remote/ember-remote.cjs is missing: run npm run build first");
  return connect(process.execPath, ["--disable-sigusr1", AGENT, "serve", "--proto", "1", "--pc", PC_ID], {
    partsId,
    env: { PATH: process.env.PATH, HOME: o.home, LANG: "C.UTF-8", EMBER_REMOTE_DEV: "1", EMBER_REMOTE_PARTS_ID: partsId, ...o.env },
  });
}

/** A hello from a PC with no admin policy (unless `admin` says otherwise). */
export function hello(o: { partsId?: string; epoch?: number; neverLook?: string[]; admin?: unknown } = {}): Hello {
  const loaded = { policy: AdminPolicySchema.parse(o.admin ?? {}), source: o.admin ? "/etc/ember/policy.json" : null };
  return {
    proto: 1, partsId: o.partsId ?? "0.0.0-test", local: { name: "ci-pc", os: "linux" }, pcId: PC_ID,
    consent: { version: 1, at: "2026-10-22T10:00:00Z" }, neverLook: o.neverLook ?? [], localAdmin: adminSummary(loaded), epoch: o.epoch ?? 1,
  };
}

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let runs = 0;
/** A fresh run id (16 hex digits). */
export const runId = () => (Date.now().toString(16) + (++runs).toString(16).padStart(4, "0")).slice(-16).padStart(16, "0");

/** A cmd.run's arguments with a stamp (`yes`: the user's yes 100 ms ago; `rules`/`classes`: what the PC asked about). */
export function command(text: string, o: { cwd: string; epoch?: number; yes?: boolean; rules?: string[]; classes?: CommandStamp["classes"]; verdict?: CommandStamp["verdict"]; timeoutMs?: number; id?: string }): OpArgs<"cmd.run"> {
  const spec: RunSpec = {
    runId: o.id ?? runId(), taskId: "1-ci", shell: "bash", command: text, cwd: o.cwd, timeoutMs: o.timeoutMs ?? 60_000, cols: 100, rows: 30,
    stamp: {
      taskId: "1-ci", sha256: sha256Hex(text), verdict: o.verdict ?? (o.yes ? "ask" : "run"), classes: o.classes ?? [], rules: o.rules ?? [],
      approval: o.yes ? { ageMs: 100 } : null,
    },
  };
  return { epoch: o.epoch ?? 1, spec };
}

/**
 * Starts a command through gate 2 as the PC's flow does (§3.8.3 step 13): sent as decided; a needs_confirm is "asked"
 * (the test says yes) and sent again with its rules added and the yes. Resolves with the started run's arguments.
 */
export async function startThrough(link: AgentLink, text: string, o: { cwd: string; epoch?: number; timeoutMs?: number }): Promise<{ a: OpArgs<"cmd.run">; channel: number; asked: boolean }> {
  let a = command(text, o);
  let r = await link.request("cmd.run", a);
  let asked = false;
  if (r.status === "needs_confirm") {
    asked = true;
    a = command(text, { ...o, yes: true, rules: r.rules ?? [] });
    r = await link.request("cmd.run", a);
  }
  if (r.status !== "started") throw new Error(`the command was refused: ${r.status} ${"reason" in r ? r.reason : ""}`);
  return { a, channel: r.channel, asked };
}

/** Runs a command through gate 2 (startThrough) to its end: the run's answer, exit and output. */
export async function runThrough(link: AgentLink, text: string, o: { cwd: string; epoch?: number; timeoutMs?: number }): Promise<{ channel: number; exit: EvMap["cmd.exit"]; output: string; asked: boolean }> {
  const { a, channel, asked } = await startThrough(link, text, o);
  const exit = await link.event("cmd.exit", d => d.runId === a.spec.runId, o.timeoutMs ?? 30_000);
  const output = (await link.waitBytes(channel, exit.outBytes)).toString("utf8");
  return { channel, exit, output, asked };
}

/** A test sshd's settings (remote.yml's jobs export them; defaults for ssh-linux). */
export function sshTarget(): { host: string; port: number; user: string | null } {
  return {
    host: process.env.EMBER_SSH_TEST_HOST ?? "127.0.0.1",
    port: Number(process.env.EMBER_SSH_TEST_PORT ?? "2222"),
    user: process.env.EMBER_SSH_TEST_USER ?? null,
  };
}

/**
 * ssh's argv for a batch connection to the test sshd running `remote` (a fixed command line). A local run may name its
 * own key and known-hosts file (EMBER_SSH_TEST_IDENTITY, EMBER_SSH_TEST_KNOWN_HOSTS); CI uses the runner's defaults.
 */
export function sshArgs(remote: string, extra: string[] = []): string[] {
  const t = sshTarget();
  const own = [
    ...(process.env.EMBER_SSH_TEST_IDENTITY ? ["-i", process.env.EMBER_SSH_TEST_IDENTITY, "-o", "IdentitiesOnly=yes"] : []),
    ...(process.env.EMBER_SSH_TEST_KNOWN_HOSTS ? ["-o", `UserKnownHostsFile=${process.env.EMBER_SSH_TEST_KNOWN_HOSTS}`] : []),
  ];
  return ["-T", "-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ServerAliveInterval=15", ...own, "-p", String(t.port), ...extra, "--", t.user ? `${t.user}@${t.host}` : t.host, remote];
}

/** Runs a fixed command on the test sshd (stdin from `input`); its stdout, stderr and exit code. */
export function sshRun(remote: string, input?: Uint8Array, extra: string[] = []): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync("ssh", sshArgs(remote, extra), { input, encoding: "buffer", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout?.toString("utf8") ?? "", stderr: r.stderr?.toString("utf8") ?? "" };
}

/** What the test sshd's machine is: its OS and CPU as the parts name them. */
export function remoteTarget(): { os: "linux" | "darwin"; target: string } {
  const r = sshRun("uname -s; uname -m");
  const [sys, cpu] = r.stdout.trim().split("\n");
  const os = sys === "Darwin" ? "darwin" : sys === "Linux" ? "linux" : null;
  const arch = cpu === "x86_64" ? "x64" : cpu === "aarch64" || cpu === "arm64" ? "arm64" : null;
  if (!os || !arch) throw new Error(`the test sshd's machine isn't one an agent runs on: ${r.stdout} ${r.stderr}`);
  return { os, target: `${os}-${arch}` };
}

/** The remote's parts folder for `partsId`, as a shell word ($HOME expanded there). */
export function versionsDir(os: "linux" | "darwin", partsId: string): string {
  if (!/^[A-Za-z0-9._+-]{1,80}$/.test(partsId)) throw new Error("not a parts id");
  return os === "darwin" ? `"$HOME/Library/Application Support/Ember Remote/versions/${partsId}"` : `"$HOME/.local/share/ember-remote/versions/${partsId}"`;
}

/** The parts built by scripts/package/remote-parts.mjs (built now when missing). */
export function partsBuilt(): { partsId: string; targets: Record<string, { file: string; sha256: string; bytes: number }> } {
  const json = path.join(ROOT, "dist/remote-parts/remote-parts.json");
  if (!fs.existsSync(json)) {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/package/remote-parts.mjs")], { cwd: ROOT, stdio: "inherit", timeout: 300_000 });
    if (r.status !== 0) throw new Error("scripts/package/remote-parts.mjs failed");
  }
  return JSON.parse(fs.readFileSync(json, "utf8"));
}

/**
 * Installs a target's parts on the test sshd as the bootstrap leaves them (§5.1.9 steps 2-5): unpacked into a staging
 * folder, every file checked against manifest.sha256 with the remote's own tool, `.verified`, then renamed into place.
 */
export function installParts(os: "linux" | "darwin", target: string): string {
  const parts = partsBuilt();
  const t = parts.targets[target];
  if (!t) throw new Error(`no parts for ${target}`);
  const archive = fs.readFileSync(path.join(ROOT, "dist/remote-parts", t.file));
  const d = versionsDir(os, parts.partsId);
  const check = os === "darwin" ? "shasum -a 256 -c -s manifest.sha256" : "sha256sum -c --quiet manifest.sha256";
  const r = sshRun(`set -e; umask 077; d=${d}; rm -rf "$d.staging"; mkdir -p "$d.staging"; cd "$d.staging"; tar -xzf -; ${check}; touch .verified; rm -rf "$d"; mv "$d.staging" "$d"`, archive);
  if (r.code !== 0) throw new Error(`installing the parts failed: ${r.stderr}`);
  return parts.partsId;
}

/** Connects to an agent served over ssh from the installed parts, run by `node` (an absolute path on the remote). */
export function connectSsh(o: { os: "linux" | "darwin"; partsId: string; node: string; pcId?: string; extra?: string[] }): AgentLink {
  if (!/^\/[A-Za-z0-9/._+ -]+$/.test(o.node)) throw new Error("the remote node's path must be absolute and plain");
  const pc = o.pcId ?? PC_ID;
  if (!/^[0-9a-f]{32}$/.test(pc)) throw new Error("not a PC id");
  // As the bootstrap does: the loader's and Node's variables unset, then exec (§5.1.9).
  const unset = "unset NODE_OPTIONS NODE_PATH NODE_DEBUG NODE_REPL_EXTERNAL_MODULE BASH_ENV ENV LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH";
  return connect("ssh", sshArgs(`${unset}; exec "${o.node}" --disable-sigusr1 ${versionsDir(o.os, o.partsId)}/ember-remote.cjs serve --proto 1 --pc ${pc}`, o.extra ?? []), { partsId: o.partsId });
}

/** scripts/package/remote-runtime.json: the Node runtime remotes run (pinned), per target. */
interface RemoteRuntime {
  pinned: string;
  targets: Record<string, Record<"xz" | "gz", { file: string; sha256: string; bytes: number }>>;
}

/** The pinned runtime's archive for a target (xz), downloaded once from nodejs.org into .cache and checked. */
export async function runtimeArchive(target: string): Promise<{ id: string; bytes: Buffer; sha256: string }> {
  const rt = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/package/remote-runtime.json"), "utf8")) as RemoteRuntime;
  const want = rt.targets[target]?.xz;
  if (!want) throw new Error(`no pinned runtime for ${target}`);
  const cached = path.join(ROOT, ".cache/remote-runtime", want.file);
  if (!fs.existsSync(cached)) {
    const res = await fetch(`https://nodejs.org/dist/v${rt.pinned}/${want.file}`);
    if (!res.ok) throw new Error(`downloading ${want.file} failed: HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(`${cached}.part`, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(`${cached}.part`, cached);
  }
  const bytes = fs.readFileSync(cached);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== want.bytes || sha256 !== want.sha256) {
    fs.rmSync(cached, { force: true });
    throw new Error(`${want.file} doesn't match remote-runtime.json`);
  }
  return { id: `${rt.pinned}-${target}`, bytes, sha256 };
}

/**
 * Installs the pinned runtime on the test sshd as the bootstrap leaves it (§5.1.9 steps 3-5): checked with the remote's
 * own sha256 tool, unpacked into staging, the exec check (`node --version`), renamed, `.verified`. Resolves with the
 * remote node's absolute path (`home` is the remote's $HOME).
 */
export async function installRuntime(os: "linux" | "darwin", target: string, home: string): Promise<string> {
  if (!/^\/[A-Za-z0-9/._+-]+$/.test(home)) throw new Error("the remote's home must be a plain absolute path");
  const a = await runtimeArchive(target);
  const data = os === "darwin" ? `"$HOME/Library/Application Support/Ember Remote"` : `"$HOME/.local/share/ember-remote"`;
  const check = os === "darwin" ? "shasum -a 256 -c -s" : "sha256sum -c --status";
  const r = sshRun(
    `set -e; umask 077; d=${data}/runtime/${a.id}; [ -f "$d/.verified" ] && exit 0; s="$d.staging"; rm -rf "$s"; mkdir -p "$s/runtime";` +
    ` cat > "$s/archive"; echo "${a.sha256}  $s/archive" | ${check};` +
    ` tar -xJf "$s/archive" -C "$s/runtime" --strip-components=1; rm -f "$s/archive"; "$s/runtime/bin/node" --version >/dev/null;` +
    ` rm -rf "$d"; mv "$s/runtime" "$d"; rm -rf "$s"; touch "$d/.verified"`,
    a.bytes,
  );
  if (r.code !== 0) throw new Error(`installing the runtime failed: ${r.stderr}`);
  const base = os === "darwin" ? `${home}/Library/Application Support/Ember Remote` : `${home}/.local/share/ember-remote`;
  return `${base}/runtime/${a.id}/bin/node`;
}
