/**
 * A minimal client for the Windows UI Automation bridge (sidecar/uia/PROTOCOL.md), used only by the bridge's
 * integration test. It starts the bridge the way the sidecar host does (the absolute Windows PowerShell 5.1 path,
 * hidden, without PSModulePath), waits for the ready line, and matches answers to requests by id, because the bridge
 * answers out of order.
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

/** One entry of `topWindows` (a busy one has no handle). */
export interface UiaWindow extends Omit<RawNode, "h" | "patterns"> {
  h?: number;
  patterns?: UiaPatterns;
  hwnd: number;
  pid: number;
  processName: string;
  hostedPid?: number;
  owner?: number;
  isModal?: boolean;
  windowState?: string;
  isTopmost: boolean;
  focused: boolean;
  z: number;
  busy?: true;
}

/** Windows PowerShell 5.1, by absolute path (never pwsh, never a PATH lookup). */
export const POWERSHELL = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** The bridge's command line after the executable (PROTOCOL.md, "Starting the bridge"). */
export function bridgeArgs(script: string): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];
}

/** The parent's environment without PSModulePath, whatever its case (Windows environment names ignore case). */
export function bridgeEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.toLowerCase() !== "psmodulepath") env[key] = value;
  }
  return { ...env, ...extra };
}

/** A running bridge. */
export class UiaBridge {
  readonly child: ChildProcessWithoutNullStreams;
  /** The ready line, or a rejection carrying the fatal line or stderr. */
  readonly ready: Promise<Record<string, unknown>>;
  readonly exited: Promise<{ code: number | null; at: number }>;
  stderr = "";
  private next = 1;
  private readonly pending = new Map<number, (answer: BridgeAnswer) => void>();
  private readonly noise: string[] = [];

  constructor(script: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(POWERSHELL, bridgeArgs(script), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d: string) => { this.stderr += d; });
    this.exited = new Promise(resolve => this.child.on("exit", code => resolve({ code, at: Date.now() })));
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

  /** Closes stdin, which ends the bridge, and resolves with its exit code and how long it took. */
  async close(): Promise<{ code: number | null; ms: number }> {
    const start = Date.now();
    this.child.stdin.end();
    const exit = await this.exited;
    return { code: exit.code, ms: exit.at - start };
  }

  kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }
}
