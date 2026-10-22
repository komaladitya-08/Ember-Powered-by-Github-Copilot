/**
 * Fakes for the PC's side of a remote target (package SC's tests): a RemoteLink that answers each op from a handler
 * and lets a test send events, bulk bytes and state changes as the link would, holding a channel's bytes until someone
 * subscribes to it (the behaviour remote-capture.ts expects of the link); a welcome; a settings store and the local
 * administrator's policy. OS-neutral: nothing here touches the machine.
 */

import { AdminPolicySchema, adminSummary, type LoadedAdminPolicy } from "../../app/main/admin";
import { emberNamesRegExp, type EvMap, type EvName, type Op, type OpArgs, type OpResult, type Welcome } from "../../app/main/remote/protocol";
import { DEFAULT_SETTINGS, type Settings, type SettingsStore } from "../../app/main/settings";
import type { RunnerFacts } from "../../app/main/commands/types";
import type { Logger } from "../../app/main/logger";
import type { RemoteLink } from "../../app/main/remote/types";

/** A logger that keeps every line (to check what is never logged). */
export function recordingLog(): Logger & { lines: { level: string; msg: string; fields?: unknown }[] } {
  const lines: { level: string; msg: string; fields?: unknown }[] = [];
  const log = {
    lines,
    file: "",
    debug: (msg: string, fields?: unknown) => { lines.push({ level: "debug", msg, fields }); },
    info: (msg: string, fields?: unknown) => { lines.push({ level: "info", msg, fields }); },
    warn: (msg: string, fields?: unknown) => { lines.push({ level: "warn", msg, fields }); },
    error: (msg: string, fields?: unknown) => { lines.push({ level: "error", msg, fields }); },
    child: () => log,
  };
  return log;
}

export const LINUX_FACTS: RunnerFacts = {
  os: "linux", shells: ["bash", "sh"], shellPaths: { bash: "/usr/bin/bash", sh: "/bin/sh" }, script: { path: "/usr/bin/script", kind: "util-linux" },
  home: "/home/deploy", user: "deploy", privileged: false, pty: true,
  ember: { paths: ["/home/deploy/.local/share/ember-remote"], pids: [4242], names: emberNamesRegExp(["ember-remote"]) },
  extraPath: [],
};

/** No administrator's policy at all. */
export const NO_POLICY: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };
/** A policy file with these keys. */
export const policyOf = (raw: unknown, source = "/etc/ember/policy.json"): LoadedAdminPolicy => ({ policy: AdminPolicySchema.parse(raw), source });

/** A Linux remote with an X11 desktop of the SSH login's user, and no administrator's policy. */
export function welcomeOf(patch: Partial<Welcome> = {}): Welcome {
  return {
    proto: 1, partsId: "0.1.0-0123456789ab", os: "linux", arch: "x64", machineIdHash: "b".repeat(64), isWsl: false, uid: 1000, user: "deploy",
    home: "/home/deploy", facts: LINUX_FACTS,
    desktop: { access: "screen", session: { type: "x11", locked: false, active: true }, notice: "shown" },
    remoteAdmin: adminSummary(NO_POLICY), pid: 4242, graceSeconds: 20,
    ...patch,
  };
}

type Handler<O extends Op> = (args: OpArgs<O>, o?: { timeoutMs?: number }) => OpResult<O> | Promise<OpResult<O>>;

/** An error as the link is assumed to reject a `res` with ok: false: an Error carrying the agent's code. */
export const agentError = (code: string, m = "") => Object.assign(new Error(m), { code });

/** A RemoteLink whose answers, events, bytes and state the test drives. */
export interface FakeLink extends RemoteLink {
  state: "ready" | "stalled" | "lost" | "closed";
  epoch: number;
  rttMs: number;
  /** Every request, in order. */
  sent: { op: Op; args: unknown; timeoutMs?: number }[];
  /** Answers `op` with `fn` from now on (no handler: the request rejects as a link with no answer would). */
  answer<O extends Op>(op: O, fn: Handler<O>): void;
  /** The agent sends an event (its payload is what the link would hand over). */
  emit<E extends EvName>(ev: E, d: EvMap[E]): void;
  /** Bytes arrive on a bulk channel (held until someone subscribes, as the link holds them). */
  bytes(channel: number, b: Uint8Array): void;
  /** The link's state changes. */
  setState(s: "ready" | "stalled" | "lost" | "closed"): void;
  /** Listeners still subscribed: events, channels and state. */
  listening(): number;
  /** The requests of `op`. */
  of<O extends Op>(op: O): OpArgs<O>[];
}

export function fakeLink(o: { welcome?: Welcome; hostId?: string } = {}): FakeLink {
  const handlers = new Map<Op, Handler<Op>>();
  const events = new Map<string, Set<(d: unknown) => void>>();
  const channels = new Map<number, Set<(b: Uint8Array) => void>>();
  const held = new Map<number, Uint8Array[]>();
  const states = new Set<(s: "ready" | "stalled" | "lost" | "closed", why?: string) => void>();
  const link: FakeLink = {
    id: "link-1",
    hostId: o.hostId ?? "build-01",
    welcome: o.welcome ?? welcomeOf(),
    state: "ready",
    epoch: 1,
    rttMs: 40,
    sent: [],
    request<O extends Op>(op: O, args: OpArgs<O>, opts?: { timeoutMs?: number }): Promise<OpResult<O>> {
      link.sent.push({ op, args, timeoutMs: opts?.timeoutMs });
      const h = handlers.get(op) as Handler<O> | undefined;
      if (!h) return Promise.reject(new Error(`no answer to ${op}`));
      try {
        return Promise.resolve(h(structuredClone(args), opts));
      } catch (err) {
        return Promise.reject(err);
      }
    },
    on<E extends EvName>(ev: E, fn: (d: EvMap[E]) => void): () => void {
      const set = events.get(ev) ?? new Set();
      events.set(ev, set);
      const f = fn as (d: unknown) => void;
      set.add(f);
      return () => { set.delete(f); };
    },
    onBytes(channel: number, fn: (b: Uint8Array) => void): () => void {
      const set = channels.get(channel) ?? new Set();
      channels.set(channel, set);
      set.add(fn);
      const waiting = held.get(channel);
      if (waiting) {
        held.delete(channel);
        for (const b of waiting) fn(b);
      }
      return () => { set.delete(fn); };
    },
    async stop() { link.epoch++; return { ms: 1, escalated: false }; },
    onState(fn) {
      states.add(fn);
      return () => { states.delete(fn); };
    },
    async close() { link.setState("closed"); },
    answer(op, fn) { handlers.set(op, fn as unknown as Handler<Op>); },
    emit(ev, d) { for (const fn of [...events.get(ev) ?? []]) fn(structuredClone(d)); },
    bytes(channel, b) {
      const set = channels.get(channel);
      if (set?.size) for (const fn of [...set]) fn(b);
      else held.set(channel, [...held.get(channel) ?? [], b]);
    },
    setState(s) {
      link.state = s;
      for (const fn of [...states]) fn(s);
    },
    listening() {
      return [...events.values(), ...channels.values()].reduce((n, s) => n + s.size, 0) + states.size;
    },
    of<O extends Op>(op: O): OpArgs<O>[] {
      return link.sent.filter(s => s.op === op).map(s => s.args as OpArgs<O>);
    },
  };
  return link;
}

/** A settings store holding `patch` over the defaults, whose changes the test makes (update is never expected). */
export function fakeSettings(patch: Partial<Settings> = {}): SettingsStore & { set(p: Partial<Settings>): void; updates: number } {
  let s: Settings = { ...DEFAULT_SETTINGS, ...patch };
  const listeners = new Set<(s: Settings) => void>();
  const store = {
    updates: 0,
    get: () => s,
    own: () => s,
    update: () => { store.updates++; throw new Error("a remote target never changes settings"); },
    onChange: (fn: (s: Settings) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    set(p: Partial<Settings>) {
      s = { ...s, ...p };
      for (const fn of [...listeners]) fn(s);
    },
  };
  return store as unknown as SettingsStore & { set(p: Partial<Settings>): void; updates: number };
}

/** Lets pending promise callbacks run. */
export const settle = async (n = 5) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
