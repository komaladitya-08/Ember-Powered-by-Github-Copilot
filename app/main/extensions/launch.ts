/**
 * Starts an extension's stdio server with only Ember's allowlisted environment, never the runtime's credentials.
 * A private, per-launch lease is checked before spawn and every 25 ms. Removing or disabling an extension, Stop,
 * or Ember's next start revokes it. No process id read from a file is ever signalled: this launcher owns its child.
 * On Windows a kill-on-close job contains the whole tree, including when the runtime kills the launcher itself.
 *
 * The launcher stands between the runtime and the server: what the server writes reaches the runtime line by line
 * through `passedOn()`, which never passes on the server's notice that its tool list changed. The runtime asks a
 * server for its list again only after that notice (measured: never without one, over seven requests and two calls), and
 * what it then gets is what the model is shown, with no word to Ember first. Without the notice the list the runtime
 * holds is the one it took as the session loaded, which Ember checked against the pins (integrations-x9-1).
 *
 * A remote (streamable HTTP) server runs through the launcher too, as a stdio server to the runtime (`bridge()`): the
 * launcher posts each message to the server's own address and refuses a redirect, so the plugin's headers and a
 * call's arguments never reach a host its consent card didn't name (the runtime followed a 307 to another host with
 * both, and gave the model that host's answer: integrations-c9-4). Its answers pass through `passedOn()` as a stdio
 * server's do, so a remote server's notice that its list changed never reaches the runtime either.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadJobApi, type JobApi } from "../commands/run/win32-job";

/** A remote server the launcher reaches for the runtime: its address and the plugin's headers (bridge()). */
export interface RemoteSpec { url: string; headers: Record<string, string> }

/** What the launcher is told (JSON in EMBER_MCP_SPEC). */
export interface LaunchSpec {
  /** The program to start; unused (empty) for a remote server. */
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  runDir: string;
  /** Unique private lease made by Ember for this launch, never recreated after revocation. */
  leaseFile: string;
  /** Linux and macOS use a process group; Windows uses a kill-on-close job. */
  group: boolean;
  /** A remote server: the launcher starts no program and posts the runtime's messages there instead. */
  remote?: RemoteSpec;
}

/** The spec in `raw`, or null when it isn't one (the launcher then starts nothing). */
export function parseLaunchSpec(raw: string | undefined): LaunchSpec | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<LaunchSpec>;
    if (s.remote !== undefined && !remoteSpec(s.remote)) return null;
    if (typeof s.command !== "string" || (!s.command && !s.remote) || !Array.isArray(s.args) || s.args.some(a => typeof a !== "string")) return null;
    if (!s.env || typeof s.env !== "object" || Object.values(s.env).some(v => typeof v !== "string")) return null;
    if (typeof s.cwd !== "string" || typeof s.runDir !== "string" || typeof s.group !== "boolean") return null;
    if (typeof s.leaseFile !== "string" || !path.isAbsolute(s.leaseFile) || path.dirname(s.leaseFile) !== path.resolve(s.runDir) || !/^[a-f0-9-]{36}\.lease$/.test(path.basename(s.leaseFile))) return null;
    return s as LaunchSpec;
  } catch {
    return null;
  }
}

/** An https address (http on loopback only, as manifest.ts admits) with string headers. */
function remoteSpec(r: unknown): r is RemoteSpec {
  const o = r as Partial<RemoteSpec> | null;
  if (!o || typeof o !== "object" || typeof o.url !== "string" || !o.headers || typeof o.headers !== "object") return false;
  if (Object.values(o.headers).some(v => typeof v !== "string")) return false;
  try {
    const u = new URL(o.url);
    return u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

/** A server's own word that its tool list changed (MCP). */
const LIST_CHANGED = "notifications/tools/list_changed";

/** The longest line a server may write (bytes): a longer one is no message, and the launcher ends the server. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * What the launcher passes on of one line a server wrote (newline-delimited JSON-RPC), or null for a line it drops.
 * Dropped: the server's notice that its tool list changed, alone or in a batch (integrations-x9-1), and anything that
 * is no JSON-RPC message at all (not an object or a batch of them; a server's stray print). What is passed on is
 * written out again from what was read, never the server's own bytes, so the runtime can't read a line otherwise
 * than Ember did (an escaped method name, a key given twice).
 */
export function passedOn(line: string): string | null {
  let read: unknown;
  try { read = JSON.parse(line); } catch { return null; }
  const message = (m: unknown): m is Record<string, unknown> => typeof m === "object" && m !== null && !Array.isArray(m);
  const keep = (m: unknown) => message(m) && m.method !== LIST_CHANGED;
  if (Array.isArray(read)) {
    const kept = read.filter(keep);
    return kept.length ? JSON.stringify(kept) : null;
  }
  return keep(read) ? JSON.stringify(read) : null;
}

/**
 * Takes a server's output as it comes, in pieces, and gives `pass` each whole line that passedOn() lets through.
 * `tooLong` is called once a line passes `max` bytes with no end; what was held of it is dropped.
 */
export function lineFilter(pass: (line: string) => void, tooLong: () => void, max = MAX_LINE_BYTES): (chunk: Buffer) => void {
  let held: Buffer[] = [];
  let size = 0;
  return chunk => {
    let from = 0;
    // 0x0A never falls inside a UTF-8 character, so a line can be cut out of the bytes before it is read as text.
    for (let at = chunk.indexOf(10, from); at !== -1; at = chunk.indexOf(10, from)) {
      const line = Buffer.concat([...held, chunk.subarray(from, at)]).toString("utf8");
      held = [];
      size = 0;
      from = at + 1;
      const out = passedOn(line);
      if (out !== null) pass(out);
    }
    if (from >= chunk.length) return;
    held.push(chunk.subarray(from));
    size += chunk.length - from;
    if (size > max) { held = []; size = 0; tooLong(); }
  };
}

/** The streams relay() joins: the launcher's own input and output, and the server's. */
export interface RelayEnds {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  server: { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream & { pause(): unknown; resume(): unknown } };
}

/**
 * Joins the runtime to the server through the launcher: the runtime's requests go to the server as they are, and
 * the server's lines come back through lineFilter(). A runtime that reads slowly holds the server's output back
 * (never the launcher's memory); a line with no end, or a runtime that went away, calls `stop`.
 */
export function relay(ends: RelayEnds, stop: () => void): void {
  ends.input.pipe(ends.server.stdin);
  // A server that closed its input, or a runtime that closed the launcher's output: the exit that follows ends it.
  ends.server.stdin.on("error", () => undefined);
  ends.output.on("error", stop);
  let waiting = false;
  ends.server.stdout.on("data", lineFilter(line => {
    if (ends.output.write(`${line}\n`) || waiting) return;
    waiting = true;
    ends.server.stdout.pause();
    ends.output.once("drain", () => { waiting = false; ends.server.stdout.resume(); });
  }, stop));
}

/** What the runtime is told when a remote server's answer can't be passed on, by why. */
export const BRIDGE_WORDS = {
  redirect: "The extension's server sent Ember to another address. Ember doesn't follow that, so nothing was sent there.",
  auth: "The extension's server needs you to sign in to it, which Ember can't do yet.",
  failed: "The extension's server couldn't be reached.",
} as const;

/** The ids of the requests (not notifications or answers) in one message or batch the runtime wrote. */
function requestIds(m: unknown): (string | number)[] {
  const ids: (string | number)[] = [];
  for (const x of Array.isArray(m) ? m : [m]) {
    const o = x as { id?: unknown; method?: unknown } | null;
    if (o && typeof o === "object" && typeof o.method === "string" && (typeof o.id === "string" || typeof o.id === "number")) ids.push(o.id);
  }
  return ids;
}

/** The ids of the answers in one message or batch a server wrote. */
function answerIds(line: string): (string | number)[] {
  try {
    const m = JSON.parse(line) as unknown;
    return (Array.isArray(m) ? m : [m]).flatMap(x => {
      const o = x as { id?: unknown; method?: unknown } | null;
      return o && typeof o === "object" && o.method === undefined && (typeof o.id === "string" || typeof o.id === "number") ? [o.id] : [];
    });
  } catch {
    return [];
  }
}

/** The protocol version a server answered `initialize` with, if `line` is that answer. */
function protocolOf(line: string): string | null {
  try {
    const v = (JSON.parse(line) as { result?: { protocolVersion?: unknown } })?.result?.protocolVersion;
    return typeof v === "string" && /^[\w.-]{1,40}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Stands between the runtime (newline-delimited JSON-RPC on `input` and `output`) and a remote streamable-HTTP server
 * at `remote.url` (integrations-c9-4). Each message the runtime writes is posted to that address alone, with the
 * plugin's headers and the server's session id; a redirect is never followed (`redirect: "manual"`, and any 3xx is
 * refused), so nothing reaches a host the consent card didn't name. The server's answers (JSON or an event stream)
 * pass through passedOn() line by line. A request whose answer can't come back is answered with an error, so the
 * runtime never waits on it. Resolves when the runtime closes its end or `signal` aborts.
 */
export function bridge(remote: RemoteSpec, ends: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }, o: { fetch: typeof fetch; signal: AbortSignal; max?: number }): Promise<void> {
  const max = o.max ?? MAX_LINE_BYTES;
  let session: string | null = null;
  let protocol: string | null = null;
  const inFlight = new Set<Promise<void>>();
  const write = (line: string) => { if (!o.signal.aborted) ends.output.write(`${line}\n`); };
  const fail = (ids: (string | number)[], message: string) => {
    for (const id of ids) write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
  };
  const pass = (text: string, waiting: Set<string | number>) => {
    const out = passedOn(text);
    if (out === null) return;
    // A batch is written one message a line: the runtime reads a stdio server's lines one message each.
    const parsed = JSON.parse(out) as unknown;
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      const line = JSON.stringify(m);
      for (const id of answerIds(line)) waiting.delete(id);
      protocol = protocolOf(line) ?? protocol;
      write(line);
    }
  };
  const post = async (body: string, ids: (string | number)[]) => {
    const waiting = new Set(ids);
    try {
      const headers: Record<string, string> = { ...remote.headers, "content-type": "application/json", accept: "application/json, text/event-stream" };
      if (session) headers["mcp-session-id"] = session;
      if (protocol) headers["mcp-protocol-version"] = protocol;
      const res = await o.fetch(remote.url, { method: "POST", headers, body, signal: o.signal, redirect: "manual" });
      if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") { fail([...waiting], BRIDGE_WORDS.redirect); return; }
      if (res.status === 401 || res.status === 403) { fail([...waiting], BRIDGE_WORDS.auth); return; }
      if (!res.ok) { fail([...waiting], BRIDGE_WORDS.failed); return; }
      session = res.headers.get("mcp-session-id") ?? session;
      // No body (a 204): nothing answers a call, so it is answered here (r10-integrations-y10-2).
      if (!res.body) { fail([...waiting], BRIDGE_WORDS.failed); return; }
      const sse = /text\/event-stream/i.test(res.headers.get("content-type") ?? "");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let held = "";
      let data: string[] = [];
      // What an event's data lines hold so far: an event is one message, capped as a stdio server's line is
      // (r10-integrations-x10-2: `held` empties line by line, so an endless event grew without bound).
      let dataSize = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        held += decoder.decode(value, { stream: true });
        if (held.length + dataSize > max) { try { await reader.cancel(); } catch { /* already closed */ } held = ""; data = []; break; }
        if (!sse) continue;
        // An event stream: each event's data lines, joined, are one message; a blank line ends the event.
        let nl: number;
        while ((nl = held.indexOf("\n")) >= 0) {
          const line = held.slice(0, nl).replace(/\r$/, "");
          held = held.slice(nl + 1);
          if (line === "") { if (data.length) pass(data.join("\n"), waiting); data = []; dataSize = 0; }
          else if (line.startsWith("data:")) { const d = line.slice(5).replace(/^ /, ""); data.push(d); dataSize += d.length + 1; }
        }
      }
      if (sse) { if (data.length) pass(data.join("\n"), waiting); }
      else if (held.trim()) pass(held, waiting);
      if (waiting.size) fail([...waiting], BRIDGE_WORDS.failed);
    } catch {
      if (!o.signal.aborted) fail([...waiting], BRIDGE_WORDS.failed);
    }
  };
  return new Promise(resolve => {
    let held: Buffer[] = [];
    let size = 0;
    let closed = false;
    const finish = () => { if (closed && !inFlight.size) resolve(); };
    const take = (line: string) => {
      let m: unknown;
      try { m = JSON.parse(line); } catch { return; }
      if (typeof m !== "object" || m === null) return;
      const p = post(JSON.stringify(m), requestIds(m)).finally(() => { inFlight.delete(p); finish(); });
      inFlight.add(p);
    };
    ends.input.on("data", (chunk: Buffer) => {
      let from = 0;
      for (let at = chunk.indexOf(10, from); at !== -1; at = chunk.indexOf(10, from)) {
        take(Buffer.concat([...held, chunk.subarray(from, at)]).toString("utf8"));
        held = [];
        size = 0;
        from = at + 1;
      }
      if (from >= chunk.length) return;
      held.push(chunk.subarray(from));
      size += chunk.length - from;
      if (size > max) { held = []; size = 0; }
    });
    ends.input.on("end", () => { closed = true; finish(); });
    o.signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Never use a direct process-group signal after Node has observed its child ending (its pid may be reused). */
export function childIsLive(child: { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null }): boolean {
  return child.pid !== undefined && child.pid > 1 && child.exitCode === null && child.signalCode === null;
}

/** Windows joins its own job before spawning, so no descendant can escape the kill-on-close lifetime. */
export function launcherJob(api: JobApi | null): () => void {
  if (!api) throw new Error("no job objects");
  const job = api.createKillOnCloseJob();
  api.assignSelf(job);
  return () => { api.terminate(job, 1); };
}

function main(): void {
  const spec = parseLaunchSpec(process.env.EMBER_MCP_SPEC);
  if (!spec || !fs.existsSync(spec.leaseFile)) { process.stderr.write("ember: no server to start\n"); process.exit(2); }
  let stopJob: (() => void) | undefined;
  if (spec.remote) { mainRemote(spec, spec.remote); return; }
  if (!spec.group) {
    try { stopJob = launcherJob(loadJobApi()); } catch { process.stderr.write("ember: the server could not be contained\n"); process.exit(2); }
  }
  let child: ReturnType<typeof spawn>;
  try {
    // Its input and output go through the launcher (relay); its error output is the launcher's own, as before.
    child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "inherit"], shell: false, windowsHide: true, detached: spec.group });
  } catch {
    process.stderr.write("ember: the server didn't start (Ember starts programs only, never scripts through a shell)\n");
    process.exit(127);
  }
  const kill = (signal: NodeJS.Signals) => {
    if (!childIsLive(child)) return;
    if (stopJob) { stopJob(); return; }
    try { process.kill(-child.pid!, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
  };
  const end = (code: number) => {
    clearInterval(watch);
    try { fs.rmSync(spec.leaseFile, { force: true }); } catch { /* already revoked */ }
    process.exit(code);
  };
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    kill("SIGTERM");
    // A non-cooperative live child is killed; a child that ended is never signalled by its old pid.
    setTimeout(() => { kill("SIGKILL"); end(1); }, 200).unref();
  };
  const watch = setInterval(() => { if (!fs.existsSync(spec.leaseFile)) stop(); }, 25);
  watch.unref();
  // Revocation can race the spawn. It is checked again once Node has a child to stop.
  child.on("spawn", () => { if (!fs.existsSync(spec.leaseFile)) stop(); });
  child.on("error", err => { process.stderr.write(`ember: the server didn't start (${(err as NodeJS.ErrnoException).code ?? "error"})\n`); end(127); });
  if (child.stdin && child.stdout) relay({ input: process.stdin, output: process.stdout, server: { stdin: child.stdin, stdout: child.stdout } }, stop);
  // The server's last lines are still in its pipe when it exits: the launcher ends with the server's own code once
  // they are read ("close") and written out (the empty write's callback runs after them; measured with 5 MB and a
  // slow reader). A process the server left behind may hold that pipe open, so its exit alone ends it 500 ms later.
  let finished = false;
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (finished) return;
    finished = true;
    const done = () => end(code ?? (signal ? 1 : 0));
    if (stopping) done(); else process.stdout.write("", done);
  };
  child.on("close", finish);
  child.on("exit", (code, signal) => { setTimeout(() => finish(code, signal), 500); });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, stop);
}

/** The launcher for a remote server: no program, only bridge(), for as long as its lease lasts. */
function mainRemote(spec: LaunchSpec, remote: RemoteSpec): void {
  const ac = new AbortController();
  const end = (code: number) => {
    clearInterval(watch);
    ac.abort();
    try { fs.rmSync(spec.leaseFile, { force: true }); } catch { /* already revoked */ }
    process.exit(code);
  };
  const watch = setInterval(() => { if (!fs.existsSync(spec.leaseFile)) end(1); }, 25);
  watch.unref();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => end(1));
  process.stdout.on("error", () => end(1));
  void bridge(remote, { input: process.stdin, output: process.stdout }, { fetch, signal: ac.signal }).then(() => process.stdout.write("", () => end(0)));
}

if (process.env.EMBER_MCP_SPEC !== undefined && require.main === module) main();
