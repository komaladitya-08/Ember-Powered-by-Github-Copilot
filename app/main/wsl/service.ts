/**
 * WSL for Ember (§4.1-4.2; package WA): which distros exist and which run, without ever starting one by accident; a
 * command runner per distro (runner.ts); the Windows side's facts for commands that cross back (§3.4.5); the boot ids
 * SA's same-machine rule compares (§5.1.14); the doctor's `wsl` row (§8.8).
 *
 * Nothing here starts a distro except a call made for work the user's task asked for there (a runner's facts, inspect,
 * git facts or a command): listing reads the registry and `wsl.exe --list`, the running set is `--list --running`,
 * the boot ids and default uids are read only from distros that already run. The facts are cached for 60 s and the
 * running set for 2 s (`isRunning`), `runningNow()` reads it now. Windows only: `createWsl` is null elsewhere and when
 * this PC has no wsl.exe. Plain Node; koffi only inside lxss.ts's loader.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import pathWin32 from "node:path/win32";
import type { OS } from "../../shared/shortcuts";
import type { Logger } from "../logger";
import type { JobHostRef, WindowsContext } from "../commands/types";
import type { PlatformDoctorRow } from "../platform/types";
import type { WslFacts, WslService } from "./types";
import { decodeWsl } from "./decode";
import { createWslExec, discoverWsl, envGet, locateWslExe, noWsl, readRunning, type WslChild, type WslSpawn } from "./discover";
import { loadLxssRegistry, type RegistryReader } from "./lxss";
import type { SecretTracker } from "../commands/prompts";
import { BOOT_ID_SCRIPT, createWslRunner, type WslRunner } from "./runner";
import { listProcessImages, runningXServer, wslDoctorRows } from "./doctor";

/** How long discovery's facts are reused (§4.1); a refresh is asked for when something changes. */
export const FACTS_CACHE_MS = 60_000;
/** How old `isRunning`'s answer may be before it is read again in the background (§4.1). */
export const RUNNING_CACHE_MS = 2_000;
/** A distro Ember doesn't know is looked for again (a newly installed one) at most this often. */
const UNKNOWN_RETRY_MS = 5_000;
/** A boot id read from a running distro (§5.1.14). */
const BOOT_ID_TIMEOUT_MS = 5_000;
/** /proc/sys/kernel/random/boot_id: a UUID and a newline. */
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/;

/** What the service takes from the OS (the real ones in createWsl; tests pass fakes). */
export interface WslDeps {
  spawn: WslSpawn;
  /** A file exists (wsl.exe's two places). */
  exists: (path: string) => boolean;
  /** A file's bytes, or null when it can't be read (`.wslconfig`). */
  readFile: (path: string) => Uint8Array | null;
  /** The Lxss registry reader (null: unavailable). */
  registry: () => RegistryReader | null;
  /** The secret tracker per run (default CL's trackSecretPrompts, §3.11 step 2; tests may pass their own). */
  trackSecrets?: (o: { interactive: boolean }) => SecretTracker;
  /** Windows' process image names (the doctor's X-server line); null when they can't be listed. */
  processImages: () => Promise<string[] | null>;
  now: () => number;
}

/** The service's options (createWsl's, exactly). */
export interface WslOptions { log: Logger; env: NodeJS.ProcessEnv; os: OS; ember: { winPaths: string[] }; jobHost: JobHostRef | null }

/** The service as createWsl makes it: its runners are WSL runners (runner.ts's extension of CommandRunner). */
export type WslServiceImpl = Omit<WslService, "runner"> & { runner(distro: string): WslRunner };

/** WSL for Ember: null off Windows, or when this PC has no wsl.exe. */
export function createWsl(o: { log: Logger; env: NodeJS.ProcessEnv; os: OS; ember: { winPaths: string[] }; jobHost: JobHostRef | null }): WslService | null {
  if (o.os !== "win32") return null;
  const spawn: WslSpawn = (command, args, options) => nodeSpawn(command, args, options) as unknown as WslChild;
  return createWslWith(o, {
    spawn,
    exists: p => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false; // not there (or not readable): that wsl.exe isn't used
      }
    },
    readFile: p => {
      try {
        return fs.readFileSync(p);
      } catch {
        return null; // no .wslconfig: WSLg isn't turned off by the user
      }
    },
    registry: loadLxssRegistry,
    processImages: () => listProcessImages(spawn, o.env),
    now: Date.now,
  });
}

/** The Windows side of every distro (§3.1 WindowsContext), from the PC's environment and Ember's own paths. */
export function windowsContextOf(env: NodeJS.ProcessEnv, emberPaths: readonly string[]): WindowsContext {
  const drive = envGet(env, "HOMEDRIVE"), homePath = envGet(env, "HOMEPATH");
  const home = envGet(env, "USERPROFILE") ?? (drive && homePath ? pathWin32.join(drive, homePath) : "");
  const localAppData = envGet(env, "LOCALAPPDATA") ?? (home ? pathWin32.join(home, "AppData", "Local") : "");
  const appData = envGet(env, "APPDATA") ?? (home ? pathWin32.join(home, "AppData", "Roaming") : "");
  const temp = envGet(env, "TEMP") ?? envGet(env, "TMP") ?? (localAppData ? pathWin32.join(localAppData, "Temp") : "");
  const systemRoot = envGet(env, "SystemRoot") ?? envGet(env, "windir") ?? "C:\\Windows";
  return { home, localAppData, appData, temp, systemRoot, emberPaths: [...emberPaths] };
}

/** createWsl with its OS pieces passed in (tests; createWsl passes the real ones). */
export function createWslWith(o: WslOptions, deps: WslDeps): WslServiceImpl | null {
  const locate = () => locateWslExe(o.env, deps.exists);
  let exe = locate();
  if (!exe) return null;
  const log = o.log;
  const now = deps.now;
  const exec = createWslExec({ exe: () => exe, env: o.env, jobHost: o.jobHost, spawn: deps.spawn, log });
  const windows = windowsContextOf(o.env, o.ember.winPaths);
  const uids = new Map<string, number>();
  const runners = new Map<string, WslRunner>();
  const listeners = new Set<(f: WslFacts) => void>();
  let cache: { facts: WslFacts; at: number } | null = null;
  let inflight: Promise<WslFacts> | null = null;
  let running: { set: Set<string>; at: number } = { set: new Set(), at: Number.NEGATIVE_INFINITY };
  let runningInflight: Promise<Set<string>> | null = null;
  let lastUnknownLook = Number.NEGATIVE_INFINITY;
  let published = "";
  let disposed = false;

  const readFile = (p: string): string | null => {
    const bytes = deps.readFile(p);
    return bytes ? decodeWsl(bytes) : null;
  };

  /** Keeps `f` as the facts (and their age, when discovery read them now) and tells listeners when they changed. */
  const publish = (f: WslFacts, fresh: boolean) => {
    cache = { facts: f, at: fresh || !cache ? now() : cache.at };
    const json = JSON.stringify(f);
    if (json === published) return;
    published = json;
    for (const fn of listeners) {
      try {
        fn(f);
      } catch (err) {
        log.warn("wsl.listener_failed", { err });
      }
    }
  };

  /** A running set read now: a distro seen stopped forgets its runner's facts (its default user may change). */
  const applyRunning = (set: Set<string>) => {
    for (const name of running.set) if (!set.has(name)) runners.get(name)?.invalidate();
    running = { set, at: now() };
    if (cache) publish({ ...cache.facts, distros: cache.facts.distros.map(d => ({ ...d, running: set.has(d.name) })) }, false);
  };

  const facts = (opt?: { refresh?: boolean }): Promise<WslFacts> => {
    if (disposed) return Promise.resolve(noWsl());
    if (!opt?.refresh && cache && now() - cache.at < FACTS_CACHE_MS) return Promise.resolve(cache.facts);
    if (!inflight) {
      inflight = (async () => {
        exe = locate();
        const f = await discoverWsl({ exe, exec, registry: deps.registry, readFile, env: o.env, uids, log });
        publish(f, true);
        applyRunning(new Set(f.distros.filter(d => d.running).map(d => d.name)));
        return f;
      })().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };

  const runningNow = async (): Promise<Set<string>> => {
    if (disposed) return new Set();
    if (!cache) {
      // Discovery reads the running set itself: read now, so it isn't read twice.
      const f = await facts();
      return new Set(f.distros.filter(d => d.running).map(d => d.name));
    }
    const f = cache.facts;
    if (!runningInflight) {
      runningInflight = readRunning(exec, f.distros.map(d => d.name))
        .then(set => {
          applyRunning(set);
          return set;
        })
        .finally(() => {
          runningInflight = null;
        });
    }
    return new Set(await runningInflight);
  };

  const isRunning = (distro: string): boolean => {
    if (!disposed && now() - running.at > RUNNING_CACHE_MS && !runningInflight && !inflight) {
      void runningNow().catch(err => log.warn("wsl.running_failed", { err }));
    }
    return running.set.has(distro);
  };

  /**
   * The distro as discovery lists it; looked for once more (not too often) when it isn't in the cached facts or they
   * say its set-up is pending (the user may just have set it up, as Ember's message asked).
   */
  const listed = async (distro: string) => {
    let f = await facts();
    let d = f.distros.find(x => x.name === distro);
    if ((!d || d.needsSetup) && now() - lastUnknownLook > UNKNOWN_RETRY_MS) {
      lastUnknownLook = now();
      f = await facts({ refresh: true });
      d = f.distros.find(x => x.name === distro);
    }
    return d ?? null;
  };

  /** The uid the distro itself reported: authoritative for WslDistro.defaultUid (critique wsl-7). */
  const learnedUid = (distro: string, uid: number) => {
    if (uids.get(distro) === uid) return;
    uids.set(distro, uid);
    if (cache) publish({ ...cache.facts, distros: cache.facts.distros.map(d => (d.name === distro ? { ...d, defaultUid: uid } : d)) }, false);
  };

  const runner = (distro: string): WslRunner => {
    let r = runners.get(distro);
    if (!r) {
      r = createWslRunner({
        log, distro, env: o.env, jobHost: o.jobHost, spawn: deps.spawn, exec, exe: () => exe,
        listed: () => listed(distro), isRunning: () => isRunning(distro), runningNow, windows: () => windows,
        winPaths: o.ember.winPaths, learnedUid: uid => learnedUid(distro, uid), trackSecrets: deps.trackSecrets, now,
      });
      runners.set(distro, r);
    }
    return r;
  };

  return {
    facts,
    isRunning,
    runningNow,
    runner,
    async defaultUid(distro) {
      try {
        if (!(await runningNow()).has(distro)) return null;
        await runner(distro).facts();
        return uids.get(distro) ?? null;
      } catch (err) {
        log.warn("wsl.uid_failed", { distro, err });
        return null;
      }
    },
    windowsContext: () => ({ ...windows, emberPaths: [...windows.emberPaths] }),
    async bootIds() {
      try {
        const f = await facts();
        const live = await runningNow();
        const out = new Set<string>();
        for (const d of f.distros) {
          if (d.version !== 2 || !live.has(d.name) || d.needsSetup) continue;
          // runScript reads the running set again and never starts a stopped distro.
          const r = await runner(d.name).runScript(BOOT_ID_SCRIPT, { timeoutMs: BOOT_ID_TIMEOUT_MS });
          if (r && r.code === 0 && BOOT_ID.test(r.stdout.toString("latin1"))) out.add(createHash("sha256").update(r.stdout).digest("hex"));
        }
        return [...out];
      } catch (err) {
        log.warn("wsl.boot_ids_failed", { err });
        return [];
      }
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async doctorRows(): Promise<PlatformDoctorRow[]> {
      const f = await facts({ refresh: true });
      const images = f.installed ? await deps.processImages() : null;
      return wslDoctorRows(f, { xServer: images ? runningXServer(images) : null });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const r of runners.values()) void r.stopAll("quit");
      listeners.clear();
    },
  };
}
