/**
 * Client for the Python AT-SPI sidecar (sidecar/atspi/ember_atspi.py):
 * newline-delimited JSON-RPC over stdio, one request at a time per id,
 * restarted on demand if it exits.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import type { Logger } from "../logger";

export interface Bounds { x: number; y: number; width: number; height: number }

export interface AxNode {
  id: number;
  parent: number | null;
  depth: number;
  role: string;
  name: string;
  states: string[];
  bounds: Bounds | null;
  actions?: string[];
  text?: string;
  value?: number;
  editable?: boolean;
}

export interface AxWindow {
  app: string;
  pid: number | null;
  name: string;
  role: string;
  active: boolean;
  bounds: Bounds | null;
}

export interface ReadWindowResult {
  window: AxWindow | null;
  nodes: AxNode[];
  truncated?: boolean;
  ms: number;
}

export interface SidecarStatus { version: number; python: string; toolkitAccessibility: boolean | null; apps: number }

/** RHEL's system Python first (it has pyatspi), then python3 on PATH. */
export function pickPython(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
  if (env.EMBER_PYTHON) return env.EMBER_PYTHON;
  if (exists("/usr/libexec/platform-python")) return "/usr/libexec/platform-python";
  return "python3";
}

export class AtspiSidecar {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private script: string, private log: Logger, private python = pickPython()) {}

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    const proc = spawn(this.python, [this.script], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on("line", line => {
      let msg: { id?: number; result?: unknown; error?: { message: string } };
      try { msg = JSON.parse(line); } catch { return; }
      const p = msg.id != null ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id!);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    });
    readline.createInterface({ input: proc.stderr }).on("line", line => {
      if (!/dconf-WARNING|Gtk-WARNING/.test(line)) this.log.debug("sidecar.stderr", { line: line.slice(0, 300) });
    });
    proc.on("exit", (code, signal) => {
      this.log.info("sidecar.exit", { code, signal });
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("accessibility helper stopped")); }
      this.pending.clear();
    });
    proc.on("error", err => this.log.error("sidecar.error", { err }));
    return proc;
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
    const proc = this.ensure();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`accessibility helper did not answer ${method} in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: v => resolve(v as T), reject, timer });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  status(): Promise<SidecarStatus> { return this.request("status"); }
  listWindows(): Promise<{ windows: AxWindow[] }> { return this.request("list_windows"); }
  readWindow(params: { pid?: number; title?: string; maxDepth?: number; maxNodes?: number } = {}): Promise<ReadWindowResult> {
    return this.request("read_window", params);
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
