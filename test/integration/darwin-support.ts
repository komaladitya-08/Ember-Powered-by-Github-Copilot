/**
 * What the macOS integration suites share (not a test file: it has no tests of its own): the AppKit bench
 * (test/fixtures/mac_bench.js, run by osascript) started and its JSON-lines log read, an app opened through
 * LaunchServices and waited for, and the report CI prints when an app or a window doesn't show up: what the system's
 * alerts on screen say (read over AX, so a crash report or a privacy prompt names itself), the app's newest crash
 * reports and the end of its log. A runner has nobody to look at its screen; this is how a failure says why.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Rect } from "../../app/main/platform/types";
import { openCoreFoundation, type Ref } from "../../app/main/platform/darwin/cf";
import { openAX } from "../../app/main/platform/darwin/ax";
import { openDesktop } from "../../app/main/platform/darwin/desktop";
import { SECURITY_OWNERS, isAppWindow, type CGWindowEntry } from "../../app/main/platform/darwin/model";

/** The repository's root. */
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const BENCH_SCRIPT = path.join(ROOT, "test", "fixtures", "mac_bench.js");
export const BENCH_TITLE = "Ember Bench (macOS)";
const OSASCRIPT = "/usr/bin/osascript";

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Polls `fn` until it gives something truthy, or fails after `ms` saying what was awaited (and what it found). */
export async function waitFor<T>(what: string | (() => string | Promise<string>), fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms: number): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out after ${ms} ms waiting for ${typeof what === "string" ? what : await what()}`);
    await sleep(100);
  }
}

/** A warning the CI log shows as one (an annotation on GitHub Actions). */
export const warn = (text: string) => console.log(`${process.env.GITHUB_ACTIONS === "true" ? "::warning::" : "warning: "}${text}`);

/** This process and its ancestors (the TCC "responsible process" is one of them), for a grant message. */
export function ancestry(): string {
  const chain = [`${process.pid} ${process.execPath}`];
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const r = spawnSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
    const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout?.trim() ?? "");
    if (!m) break;
    chain.push(`${pid} ${m[2]}`);
    pid = Number(m[1]);
  }
  return chain.join("\n  ");
}

/** The pids of every process called `name` exactly. */
export const pidsOf = (name: string): number[] =>
  (spawnSync("/usr/bin/pgrep", ["-x", name], { encoding: "utf8" }).stdout ?? "").split("\n").map(Number).filter(n => Number.isInteger(n) && n > 0);

/** The window list now, front to back (on screen only, as Ember's window system reads it), uncached. */
export function windowsNow(): CGWindowEntry[] {
  const d = openDesktop({ windowCacheMs: 0 });
  if (!d) return [];
  try {
    return d.windows();
  } finally {
    d.dispose?.();
  }
}

/** The pid of the app the system says is frontmost (AXFocusedApplication), or null when AX can't tell. */
export function frontmostPid(): number | null {
  const d = openDesktop({ windowCacheMs: 0 });
  if (!d) return null;
  try {
    return d.frontmostPid();
  } finally {
    d.dispose?.();
  }
}

/** The texts of an element and its descendants over AX (static texts' values, titles and descriptions), depth first. */
function axTexts(pid: number, max = 40): string[] {
  const cf = openCoreFoundation();
  const ax = cf ? openAX(cf) : null;
  if (!cf || !ax) return ["(AX unavailable)"];
  const out: string[] = [];
  const walk = (el: Ref, depth: number) => {
    if (out.length >= max || depth > 8) return;
    const role = ax.string(el, "AXRole") ?? "";
    for (const attr of ["AXTitle", "AXValue", "AXDescription"]) {
      const s = ax.string(el, attr, 400);
      if (s && s.trim()) out.push(`${role}: ${s.trim()}`);
    }
    ax.withElements(el, "AXChildren", items => items.forEach(c => walk(c, depth + 1)));
  };
  cf.own(ax.application(pid), app => ax.withElements(app, "AXWindows", wins => wins.forEach(w => walk(w, 0))));
  return out;
}

/**
 * What the system's own windows on screen say: every drawn window of a security or consent owner (SECURITY_OWNERS:
 * the TCC prompts and crash reports are UserNotificationCenter's), CoreServicesUIAgent's and any other app's that isn't
 * `except`, with the texts AX reads in it. "" when there is none.
 */
export function alertReport(except: number[] = []): string {
  const shown = windowsNow().filter(e => e.alpha > 0 && e.bounds.width > 1 && e.bounds.height > 1 && !except.includes(e.pid)
    && (SECURITY_OWNERS.has(e.owner) || e.owner === "CoreServicesUIAgent" || e.owner === "Problem Reporter"));
  const pids = [...new Set(shown.map(e => e.pid))];
  return pids.map(pid => {
    const mine = shown.filter(e => e.pid === pid);
    return `${mine[0]!.owner} (pid ${pid}, ${mine.map(e => `${e.bounds.width}x${e.bounds.height} at ${e.bounds.x},${e.bounds.y} layer ${e.layer}`).join("; ")}) says: ${JSON.stringify(axTexts(pid))}`;
  }).join("\n  ");
}

/** The newest crash reports of `app` written since `sinceMs` (its exception, termination and abort reason), or "". */
export function crashReport(app: string, sinceMs: number): string {
  const dirs = [path.join(os.homedir(), "Library", "Logs", "DiagnosticReports"), "/Library/Logs/DiagnosticReports"];
  const found: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // not there, or not readable
    }
    for (const name of names) {
      if (!name.startsWith(app)) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < sinceMs - 1000) continue;
        const text = fs.readFileSync(file, "utf8");
        // An .ips report: a one-line JSON header, then the report as JSON.
        const nl = text.indexOf("\n");
        let summary = text.slice(0, 1500);
        try {
          const body = JSON.parse(text.slice(nl + 1)) as Record<string, unknown>;
          summary = JSON.stringify({ exception: body.exception, termination: body.termination, asi: body.asi, ktriageinfo: body.ktriageinfo }).slice(0, 3000);
        } catch {
          // Not JSON (an older .crash report): its first lines say enough.
        }
        found.push(`${file}: ${summary}`);
      } catch {
        // gone meanwhile
      }
    }
  }
  return found.join("\n  ");
}

/** The end of the unified log for the process `name` over the last minutes (compact), or what went wrong reading it. */
export function processLog(name: string, minutes = 3, lines = 40): string {
  const r = spawnSync("/usr/bin/log", ["show", "--last", `${minutes}m`, "--style", "compact", "--predicate", `process == "${name}"`], { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) return `(log show failed: ${String(r.status)} ${r.stderr?.slice(0, 300) ?? ""})`;
  return r.stdout.trim().split("\n").slice(-lines).join("\n    ");
}

/** Why an app didn't show up, as far as the system can tell: its processes, the system's alerts, crash reports and log. */
export function whyNoWindow(app: string, since: number): string {
  return [
    `every ${app} pid: ${JSON.stringify(pidsOf(app))}`,
    `system alerts on screen: ${alertReport() || "(none)"}`,
    `crash reports since the start: ${crashReport(app, since) || "(none)"}`,
    `on screen now, top first: ${JSON.stringify(windowsNow().slice(0, 15).map(e => ({ id: e.id, pid: e.pid, owner: e.owner, layer: e.layer, ...e.bounds })))}`,
    `${app}'s log:\n    ${processLog(app)}`,
  ].join("\n  ");
}

/** An app's frontmost drawn normal (layer-0) window, or null. */
export const appWindow = (pid: number): CGWindowEntry | null => windowsNow().find(e => e.pid === pid && isAppWindow(e)) ?? null;

/** The bench's ready line. */
export interface BenchReady {
  pid: number;
  /** Its CGWindowID. */
  window: number;
  title: string;
  /** Whether Save's target-action works (JXA's ObjC.registerSubclass). */
  actions: boolean;
  frame: Rect;
  /** Each control's frame (points), by label; Notes and Rows are their scroll views. */
  controls?: Record<string, Rect>;
}

/** A running bench. */
export interface Bench {
  ready: BenchReady;
  log: string;
  events(): Record<string, unknown>[];
  /** The first log line with every field of `match`. */
  logged(match: Record<string, unknown>): Record<string, unknown> | undefined;
  stop(): void;
}

/** The bench's JSON-lines log (a line still being written is skipped until it is whole). */
export function benchEvents(log: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = fs.readFileSync(log, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap(line => {
    try {
      return line.trim() ? [JSON.parse(line) as Record<string, unknown>] : [];
    } catch {
      return []; // a line still being written: the next poll reads it whole
    }
  });
}

/** Starts the bench with its log in `dir` and waits for its ready line (and its window in the window list). */
export async function startBench(dir: string, seconds = 900): Promise<Bench> {
  if (!fs.existsSync(OSASCRIPT)) throw new Error(`no ${OSASCRIPT}`);
  const log = path.join(dir, `bench-${Date.now()}.jsonl`);
  const child: ChildProcess = spawn(OSASCRIPT, ["-l", "JavaScript", BENCH_SCRIPT, log, String(seconds)], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
  const events = () => benchEvents(log);
  const logged = (match: Record<string, unknown>) => events().find(e => Object.entries(match).every(([k, v]) => e[k] === v));
  const since = Date.now();
  const ready = await waitFor("the bench's ready line", () => logged({ event: "ready" }), 60_000).catch(err => {
    throw new Error(`${(err as Error).message}; the bench said: ${JSON.stringify(events())} ${stderr.slice(0, 2000)}\n  ${whyNoWindow("osascript", since)}`);
  }) as unknown as BenchReady;
  await waitFor(`the bench's window ${ready.window} in the window list`, () => windowsNow().some(e => e.id === ready.window), 10_000);
  return {
    ready, log, events, logged,
    stop() {
      if (child.exitCode === null) child.kill();
    },
  };
}
