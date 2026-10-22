/**
 * A minimal client for the Windows UI Automation bridge (sidecar/uia/PROTOCOL.md), used only by the bridge's
 * integration test. It starts the bridge the way the sidecar host does (the absolute Windows PowerShell 5.1 path,
 * hidden, with only the system's PowerShell modules), waits for the ready line, and matches answers to requests by id,
 * because the bridge answers out of order. It also notes when the bridge's exit line arrives, so a slow exit can be
 * told apart from a late end of input.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

/** A bridge error (PROTOCOL.md, "Errors"). */
export interface BridgeFault {
  code: "busy" | "gone" | "denied" | "bad_request" | "failed";
  message: string;
  pid?: number;
}

/** One answer line. */
export interface BridgeAnswer {
  id: number | string | null;
  result?: unknown;
  error?: BridgeFault;
}

/** Bounds in physical pixels. */
export interface UiaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The `patterns` object of a RawNode. */
export interface UiaPatterns {
  invoke?: true;
  toggle?: "On" | "Off" | "Indeterminate";
  value?: { value?: string; readOnly?: boolean; truncated?: true };
  range?: { value?: number; min?: number; max?: number; readOnly?: boolean; smallChange?: number };
  expand?: "Collapsed" | "Expanded" | "PartiallyExpanded" | "LeafNode";
  selectionItem?: { selected?: boolean };
  selection?: { multiple?: boolean; required?: boolean };
  window?: { modal?: boolean; state?: string; interaction?: string };
  grid?: { rows?: number; columns?: number };
  gridItem?: { row?: number; column?: number };
  table?: true;
  text?: true;
  scrollItem?: true;
  legacy?: { role?: number; state?: number; defaultAction?: string };
}

/** One element (PROTOCOL.md, "RawNode"). */
export interface RawNode {
  h: number;
  parent?: number;
  depth?: number;
  controlType?: string;
  localizedControlType?: string;
  name?: string;
  automationId?: string;
  className?: string;
  frameworkId?: string;
  isPassword?: boolean;
  isEnabled?: boolean;
  isOffscreen?: boolean;
  hasKeyboardFocus?: boolean;
  isKeyboardFocusable?: boolean;
  isControlElement?: boolean;
  bounds?: UiaRect | null;
  pid?: number;
  hwnd?: number;
  runtimeId?: string;
  labeledBy?: string;
  patterns: UiaPatterns;
  gone?: true;
}

/** One entry of `topWindows` (a busy or skipped one has no handle). */
export interface UiaWindow extends Omit<RawNode, "h" | "patterns"> {
  h?: number;
  patterns?: UiaPatterns;
  hwnd: number;
  pid: number;
  processName: string;
  /** A console window's client program (its processName is conhost). */
  clientProgram?: string;
  hostedPid?: number;
  owner?: number;
  isModal?: boolean;
  windowState?: string;
  isTopmost: boolean;
  focused: boolean;
  z: number;
  busy?: true;
  /** With busy: why it is listed from Win32 facts. */
  reason?: string;
  /** Its process was in skipPids. */
  skipped?: true;
}

/** How a bridge ended after its stdin closed. */
export interface BridgeExit {
  code: number | null;
  /** From closing stdin to the process's exit. */
  ms: number;
  /** From closing stdin to the bridge's exit line (null: it wrote none). */
  lineMs: number | null;
}

/** Windows PowerShell 5.1, by absolute path (never pwsh, never a PATH lookup). */
export const POWERSHELL = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** The bridge's command line after the executable (PROTOCOL.md, "Starting the bridge"). */
export function bridgeArgs(script: string): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];
}

/**
 * The parent's environment with PSModulePath set to Windows PowerShell's own modules folder only, after removing it in
 * every case (Windows environment names ignore case), as the sidecar host's bridgeEnv does: without it, PowerShell 5.1
 * would rebuild a default that includes the user's own modules folder.
 */
export function bridgeEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  let root = "";
  for (const [key, value] of Object.entries(base)) {
    if (key.toLowerCase() === "systemroot" && value) root = value;
    if (key.toLowerCase() !== "psmodulepath") env[key] = value;
  }
  env.PSModulePath = path.win32.join(root || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules");
  return { ...env, ...extra };
}

/** A running bridge. */
export class UiaBridge {
  readonly child: ChildProcessWithoutNullStreams;
  /** The ready line, or a rejection carrying the fatal line or stderr. */
  readonly ready: Promise<Record<string, unknown>>;
  readonly exited: Promise<{ code: number | null; at: number }>;
  /** Settles once the process has exited and its stdio has closed (every line it wrote has been read). */
  readonly closed: Promise<void>;
  stderr = "";
  /** When the bridge's exit line arrived (Date.now()), if it did. */
  exitLineAt: number | null = null;
  private next = 1;
  private readonly pending = new Map<number, (answer: BridgeAnswer) => void>();
  private readonly noise: string[] = [];

  constructor(script: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(POWERSHELL, bridgeArgs(script), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    this.child.stderr.setEncoding("utf8");
    // Writing to a bridge that has already exited fails with EPIPE; its exit is what the tests look at.
    this.child.stdin.on("error", () => undefined);
    this.child.stderr.on("data", (d: string) => { this.stderr += d; });
    this.exited = new Promise(resolve => this.child.on("exit", code => resolve({ code, at: Date.now() })));
    this.closed = new Promise(resolve => this.child.on("close", () => resolve()));
    this.ready = new Promise((resolve, reject) => {
      let first = true;
      readline.createInterface({ input: this.child.stdout }).on("line", line => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          this.noise.push(line);
          return;
        }
        if (first) {
          first = false;
          if (message.ready === true) resolve(message);
          else reject(new Error(`the bridge did not start: ${line}`));
          return;
        }
        if (!("id" in message) && message.exit !== undefined) {
          this.exitLineAt = Date.now();
          return;
        }
        const answer = message as unknown as BridgeAnswer;
        const done = typeof answer.id === "number" ? this.pending.get(answer.id) : undefined;
        if (!done) return;
        this.pending.delete(answer.id as number);
        done(answer);
      });
      this.child.on("exit", code => {
        if (first) reject(new Error(`the bridge exited (${code}) before it was ready; stdout: ${this.noise.join(" | ").slice(0, 1000)}; stderr: ${this.stderr.slice(0, 2000)}`));
      });
    });
  }

  /** Lines on stdout that weren't JSON (there should be none). */
  get strayLines(): readonly string[] {
    return this.noise;
  }

  /** Sends a request and resolves with its answer line (a result or an error). */
  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<BridgeAnswer> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, answer => {
        clearTimeout(timer);
        resolve(answer);
      });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  /** Sends a request and resolves with its result; an error answer rejects with the bridge's code in the message. */
  async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const answer = await this.request(method, params, timeoutMs);
    if (answer.error) throw new Error(`${method}: ${answer.error.code}: ${answer.error.message}`);
    return answer.result as T;
  }

  /** Closes stdin, which ends the bridge, and resolves with its exit code and how long the exit line and the exit took. */
  async close(): Promise<BridgeExit> {
    const start = Date.now();
    this.child.stdin.end();
    const exit = await this.exited;
    // The exit event can come before the last of stdout has been read.
    await this.closed;
    return { code: exit.code, ms: exit.at - start, lineMs: this.exitLineAt === null ? null : this.exitLineAt - start };
  }

  /** Kills the bridge if it is still running (clean-up after a failed test; close() is the normal way out). */
  kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }
}
