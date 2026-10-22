/**
 * The PC's end of the remote agent's protocol for the integration suites (remote-ssh, remote-el8, remote-desktop,
 * remote-wayland): the real mux over a process's stdio (an `ssh` to a test sshd, or the built agent run directly),
 * requests answered by id, events and bulk bytes collected. It speaks exactly what SC's RemoteLink will (§5.4), without
 * the PC's own gate, so each suite can send the stamps gate 2 must judge. Test-only.
 */

import { spawn, type ChildProcess } from "node:child_process";
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
 * Runs a command through gate 2 as the PC's flow does (§3.8.3 step 13): sent as decided; a needs_confirm is "asked" (the
 * test says yes) and sent again with its rules added and the yes. Resolves with the run's answer, exit and output.
 */
export async function runThrough(link: AgentLink, text: string, o: { cwd: string; epoch?: number; timeoutMs?: number }): Promise<{ channel: number; exit: EvMap["cmd.exit"]; output: string; asked: boolean }> {
  let a = command(text, o);
  let r = await link.request("cmd.run", a);
  let asked = false;
  if (r.status === "needs_confirm") {
    asked = true;
    a = command(text, { ...o, yes: true, rules: r.rules ?? [] });
    r = await link.request("cmd.run", a);
  }
  if (r.status !== "started") throw new Error(`the command was refused: ${r.status} ${"reason" in r ? r.reason : ""}`);
  const exit = await link.event("cmd.exit", d => d.runId === a.spec.runId, o.timeoutMs ?? 30_000);
  const output = (await link.waitBytes(r.channel, exit.outBytes)).toString("utf8");
  return { channel: r.channel, exit, output, asked };
}

/** A test sshd's settings (remote.yml's jobs export them; defaults for ssh-linux). */
export function sshTarget(): { host: string; port: number; user: string | null } {
  return {
    host: process.env.EMBER_SSH_TEST_HOST ?? "127.0.0.1",
    port: Number(process.env.EMBER_SSH_TEST_PORT ?? "2222"),
    user: process.env.EMBER_SSH_TEST_USER ?? null,
  };
}

/** ssh's argv for a batch connection to the test sshd running `remote` (a fixed command line). */
export function sshArgs(remote: string, extra: string[] = []): string[] {
  const t = sshTarget();
  return ["-T", "-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ServerAliveInterval=15", "-p", String(t.port), ...extra, "--", t.user ? `${t.user}@${t.host}` : t.host, remote];
}
