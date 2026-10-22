/**
 * Fakes for the WSL tests (package WA): a child process that answers like wsl.exe through Ember's job host, a spawn
 * that records every call, a registry, and a logger. Nothing here starts a process or reads the machine: the WSL
 * unit tests run on every OS's CI.
 */

import { EventEmitter } from "node:events";
import type { Logger } from "../../app/main/logger";
import type { WslChild, WslSpawn, WslSpawnOptions } from "../../app/main/wsl/discover";
import type { RegistryReader, RegKeyReader } from "../../app/main/wsl/lxss";

/** A child process the test drives: output, exit, and what Ember wrote to its stdin. */
export class FakeChild extends EventEmitter implements WslChild {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  /** Everything written to stdin, as bytes (latin1 of each byte) and as UTF-8 text. */
  written: Buffer[] = [];
  stdinEnded = false;
  killed = false;
  exited = false;
  /** Called once the stdin text ends with a fixed script's final `exit` line. */
  onScript: ((script: string) => void) | null = null;
  readonly stdin = {
    write: (chunk: Uint8Array | string): boolean => {
      this.written.push(Buffer.from(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk));
      const text = this.stdinText();
      if (this.onScript && text.endsWith("\nexit\n")) {
        const fn = this.onScript;
        this.onScript = null;
        fn(text);
      }
      return true;
    },
    end: (): void => {
      this.stdinEnded = true;
    },
    on: (): unknown => this.stdin,
  };

  stdinText(): string {
    return Buffer.concat(this.written).toString("utf8");
  }

  out(data: string | Buffer): void {
    this.stdout.emit("data", Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
  }

  err(data: string | Buffer): void {
    this.stderr.emit("data", Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
  }

  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  kill(): boolean {
    if (this.exited) return false;
    this.killed = true;
    this.exit(null, "SIGTERM");
    return true;
  }
}

/** One spawn: what Ember asked for. `wsl` is wsl.exe's own arguments (after the job host's `--`). */
export interface SpawnCall {
  command: string;
  args: string[];
  options: WslSpawnOptions;
  child: FakeChild;
  /** wsl.exe's arguments (the job host's `-- <wsl.exe>` removed), or the arguments as given without a job host. */
  wsl: string[];
  /** "--interactive" or "--batch" when the job host ran it, else null. */
  mode: string | null;
}

/** A spawn that records each call and lets `answer` drive its child (synchronously at spawn time). */
export function fakeSpawn(answer: (call: SpawnCall) => void): { spawn: WslSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: WslSpawn = (command, args, options) => {
    const child = new FakeChild();
    const dash = args.indexOf("--");
    const viaHost = dash === 2 && (args[1] === "--interactive" || args[1] === "--batch");
    const call: SpawnCall = { command, args, options, child, wsl: viaHost ? args.slice(dash + 2) : args, mode: viaHost ? args[1] : null };
    calls.push(call);
    answer(call);
    return child;
  };
  return { spawn, calls };
}

/** Answers after the current call stack (never through timers, so fake timers don't hold it). */
export function soon(fn: () => void): void {
  void Promise.resolve().then(fn);
}

/** Lets pending promise callbacks run (a few turns of the microtask queue). */
export async function flush(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** A child that prints `stdout` (and `stderr`) and exits with `code`, soon. */
export function answerWith(call: SpawnCall, o: { stdout?: string | Buffer; stderr?: string | Buffer; code?: number | null }): void {
  soon(() => {
    if (o.stdout !== undefined) call.child.out(o.stdout);
    if (o.stderr !== undefined) call.child.err(o.stderr);
    call.child.exit(o.code ?? 0);
  });
}

/** Text as UTF-16LE (what the inbox wsl.exe prints), with or without a byte-order mark. */
export function utf16(text: string, bom = false): Buffer {
  const body = Buffer.from(text, "utf16le");
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
}

/** A logger that keeps what was logged. */
export function fakeLog(): Logger & { lines: { level: string; msg: string; fields?: Record<string, unknown> }[] } {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const log = {
    lines,
    file: "",
    debug: (msg: string, fields?: Record<string, unknown>) => void lines.push({ level: "debug", msg, fields }),
    info: (msg: string, fields?: Record<string, unknown>) => void lines.push({ level: "info", msg, fields }),
    warn: (msg: string, fields?: Record<string, unknown>) => void lines.push({ level: "warn", msg, fields }),
    error: (msg: string, fields?: Record<string, unknown>) => void lines.push({ level: "error", msg, fields }),
    child: () => log,
  };
  return log;
}

/** An in-memory HKCU: key paths (case-insensitive) → subkeys and values. Records opens and closes. */
export class FakeRegistry implements RegistryReader {
  private keys = new Map<string, { values: Map<string, string | number>; subkeys: string[] }>();
  opened = 0;
  closed = 0;
  failSubkeys = false;

  key(path: string, values: Record<string, string | number> = {}): this {
    const k = this.ensure(path);
    for (const [n, v] of Object.entries(values)) k.values.set(n.toLowerCase(), v);
    return this;
  }

  private ensure(path: string) {
    const lower = path.toLowerCase();
    let k = this.keys.get(lower);
    if (!k) {
      k = { values: new Map(), subkeys: [] };
      this.keys.set(lower, k);
      const cut = path.lastIndexOf("\\");
      if (cut > 0) {
        const parent = this.ensure(path.slice(0, cut));
        const leaf = path.slice(cut + 1);
        if (!parent.subkeys.includes(leaf)) parent.subkeys.push(leaf);
      }
    }
    return k;
  }

  openUser(path: string): RegKeyReader | null {
    const k = this.keys.get(path.toLowerCase());
    if (!k) return null;
    this.opened++;
    return {
      subkeys: () => (this.failSubkeys ? null : [...k.subkeys]),
      string: name => {
        const v = k.values.get(name.toLowerCase());
        return typeof v === "string" ? v : null;
      },
      dword: name => {
        const v = k.values.get(name.toLowerCase());
        return typeof v === "number" ? v : null;
      },
      close: () => void this.closed++,
    };
  }
}
