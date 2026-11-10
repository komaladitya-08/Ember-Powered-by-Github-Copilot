/**
 * Asks an extension's MCP server which tools it offers (MCP `initialize`, then `tools/list`), so Ember can show them
 * on the consent card, pin them (pin.ts) and check them again at each load. A stdio server is started exactly as the
 * launcher starts it (the same allowlisted environment, no shell) and stopped straight after; a remote one is asked
 * over streamable HTTP. Bounded: one timeout for the whole exchange, at most 5 pages and 200 tools, 4 MB of output.
 * Plain Node.
 */

import { spawn } from "node:child_process";
import type { ServedTool, ToolHints } from "./pin";
import { MCP_TOOL_NAME } from "./tool-name";

/** What a probe found: the tools, or that the server needs the user to sign in, or why it failed. */
export type ProbeResult = { ok: true; tools: ServedTool[] } | { ok: false; needsAuth?: boolean; why: string };

const PROTOCOL = "2025-06-18";
const MAX_TOOLS = 200;
const MAX_BYTES = 4 * 1024 * 1024;

type Rpc = (method: string, params?: unknown) => Promise<unknown>;

/** The tools a server's tools/list pages hold, cleaned to what Ember keeps. */
export function servedTools(pages: unknown[]): ServedTool[] {
  const out: ServedTool[] = [];
  for (const page of pages) {
    const tools = (page as { tools?: unknown })?.tools;
    if (!Array.isArray(tools)) continue;
    for (const t of tools) {
      const o = t as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: unknown };
      if (typeof o.name !== "string" || !MCP_TOOL_NAME.test(o.name)) continue;
      const a = (o.annotations && typeof o.annotations === "object" ? o.annotations : {}) as Record<string, unknown>;
      const hints: ToolHints = {};
      for (const k of ["readOnlyHint", "destructiveHint", "openWorldHint", "idempotentHint"] as const) if (typeof a[k] === "boolean") hints[k] = a[k] as boolean;
      out.push({ name: o.name, description: typeof o.description === "string" ? o.description : "", inputSchema: o.inputSchema ?? { type: "object" }, annotations: hints });
      if (out.length >= MAX_TOOLS) return out;
    }
  }
  return out;
}

/** initialize, initialized, then every tools/list page. */
async function listTools(rpc: Rpc, notify: (method: string) => Promise<void>): Promise<ServedTool[]> {
  await rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "ember", version: "1" } });
  await notify("notifications/initialized");
  const pages: unknown[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const page = await rpc("tools/list", cursor ? { cursor } : {});
    pages.push(page);
    const next = (page as { nextCursor?: unknown })?.nextCursor;
    if (typeof next !== "string" || !next) break;
    cursor = next;
  }
  return servedTools(pages);
}

/** Probes a stdio server: `command` started with exactly `env`, in `cwd`, no shell; stopped afterwards. */
export function probeStdio(o: { command: string; args: string[]; env: Record<string, string>; cwd: string; timeoutMs?: number; signal?: AbortSignal; group?: boolean }): Promise<ProbeResult> {
  if (o.signal?.aborted) return Promise.resolve({ ok: false, why: "It was stopped." });
  return new Promise(resolve => {
    let done = false, buf = "", bytes = 0, id = 0;
    const waiting = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();
    let child: ReturnType<typeof spawn>;
    try {
      // Its own process group (Linux and macOS), as the launcher runs servers: everything it starts ends with it.
      child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true, detached: o.group === true });
    } catch {
      resolve({ ok: false, why: "It didn't start." });
      return;
    }
    const finish = (r: ProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // The kill switch's signal lives until the next stop: a probe that ended lets go of it (and of this child).
      o.signal?.removeEventListener("abort", stopped);
      for (const w of waiting.values()) w.no(new Error("ended"));
      try {
        if (child.exitCode === null && child.signalCode === null) {
          if (o.group && child.pid) process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        }
      } catch {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, why: "It didn't answer in time." }), o.timeoutMs ?? 20_000);
    // The kill switch ends a probe too.
    const stopped = () => finish({ ok: false, why: "It was stopped." });
    if (o.signal?.aborted) { stopped(); return; }
    o.signal?.addEventListener("abort", stopped, { once: true });
    child.on("error", () => finish({ ok: false, why: "It didn't start." }));
    child.on("exit", () => finish({ ok: false, why: "It stopped before saying what it offers." }));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) { finish({ ok: false, why: "It said too much." }); return; }
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m: { id?: unknown; result?: unknown; error?: { message?: unknown } };
        try { m = JSON.parse(line); } catch { continue; }
        const w = typeof m.id === "number" ? waiting.get(m.id) : undefined;
        if (!w) continue;
        waiting.delete(m.id as number);
        if (m.error) w.no(new Error(String(m.error.message ?? "error")));
        else w.ok(m.result);
      }
    });
    child.stdin!.on("error", () => { /* the exit handler reports it */ });
    const write = (msg: object) => child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    const rpc: Rpc = (method, params) => new Promise((ok, no) => { const n = ++id; waiting.set(n, { ok, no }); write({ id: n, method, params: params ?? {} }); });
    listTools(rpc, async method => { write({ method }); })
      .then(tools => finish({ ok: true, tools }))
      .catch(() => finish({ ok: false, why: "It didn't say what it offers." }));
  });
}

/** The JSON-RPC response with `id` in an HTTP answer (plain JSON, or an event stream's data lines). */
export function rpcAnswer(contentType: string, body: string, id: number): { result?: unknown; error?: unknown } | null {
  const pick = (v: unknown) => {
    for (const m of Array.isArray(v) ? v : [v]) if (m && typeof m === "object" && (m as { id?: unknown }).id === id) return m as { result?: unknown; error?: unknown };
    return null;
  };
  if (/text\/event-stream/i.test(contentType)) {
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try { const hit = pick(JSON.parse(line.slice(5).trim())); if (hit) return hit; } catch { /* not JSON */ }
    }
    return null;
  }
  try { return pick(JSON.parse(body)); } catch { return null; }
}

/** A response's text, read only up to MAX_BYTES (a server can't make Ember hold an endless body). */
async function capped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const room = MAX_BYTES - n;
    parts.push(value.length > room ? value.subarray(0, room) : value);
    n += Math.min(value.length, room);
    if (n >= MAX_BYTES) { try { await reader.cancel(); } catch { /* already closed */ } break; }
  }
  return Buffer.concat(parts).toString("utf8");
}

/** Probes a streamable-HTTP server at `url` with `headers`. A 401 or 403 means it needs the user to sign in. */
export async function probeHttp(o: { url: string; headers: Record<string, string>; fetch: typeof fetch; timeoutMs?: number; signal?: AbortSignal }): Promise<ProbeResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 20_000);
  if (o.signal?.aborted) ac.abort();
  const stopped = () => ac.abort();
  o.signal?.addEventListener("abort", stopped, { once: true });
  let session: string | null = null, id = 0;
  class NeedsAuth extends Error {}
  const post = async (msg: object, wantId?: number): Promise<unknown> => {
    ac.signal.throwIfAborted();
    const headers: Record<string, string> = { ...o.headers, "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (session) headers["mcp-session-id"] = session;
    const res = await o.fetch(o.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...msg }), signal: ac.signal, redirect: "error" });
    ac.signal.throwIfAborted();
    if (res.status === 401 || res.status === 403) throw new NeedsAuth();
    if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}`);
    session = res.headers.get("mcp-session-id") ?? session;
    const body = await capped(res);
    ac.signal.throwIfAborted();
    if (wantId === undefined) return undefined;
    const a = rpcAnswer(res.headers.get("content-type") ?? "", body, wantId);
    if (!a || a.error) throw new Error("no answer");
    return a.result;
  };
  try {
    const rpc: Rpc = (method, params) => { const n = ++id; return post({ id: n, method, params: params ?? {} }, n); };
    const tools = await listTools(rpc, async method => { await post({ method }); });
    return { ok: true, tools };
  } catch (err) {
    if (err instanceof NeedsAuth) return { ok: false, needsAuth: true, why: "It needs you to sign in to it, which Ember can't do yet." };
    return { ok: false, why: ac.signal.aborted ? "It didn't answer in time." : "It didn't say what it offers." };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", stopped);
  }
}
