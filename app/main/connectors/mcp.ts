/**
 * A minimal Model Context Protocol client over stdio, Ember's own (no SDK): it starts one MCP server the user added
 * (a program on this computer, never a shell line), initialises it, lists its tools and calls them, as newline-delimited
 * JSON-RPC 2.0 on its stdin and stdout. Only what connectors need (the Jarvis research's J6: briefings from the user's
 * mail, calendar or chat), with hard limits: each request times out, each message and result is capped, and the server
 * runs with the same allow-listed environment as an app Ember opens (appEnv: no tokens, keys or Ember's own variables).
 *
 * Plain Node, no Electron: main takes it by injection and the tests drive it with a fake server.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";

/** The protocol version Ember asks for (servers answer with the one they speak). */
export const MCP_PROTOCOL = "2025-06-18";
/** A request with no answer by then has failed. */
export const MCP_TIMEOUT_MS = 20_000;
/** The longest line a server may send (a larger one ends the connection). */
export const MCP_MAX_LINE = 1 << 20;

/** One tool a server offers, as tools/list gives it. `readOnly`: its annotations say it changes nothing. */
export interface McpTool { name: string; description: string; readOnly: boolean; inputSchema: unknown }

/** Where a server runs: its program and arguments, never a shell line. */
export interface McpLaunch { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd?: string }

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private next = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private closed = false;
  /** The server's own name and version, once initialised. */
  server: { name: string; version: string } | null = null;

  constructor(private launch: McpLaunch, private o: { timeoutMs?: number; onExit?: (code: number | null) => void } = {}) {}

  /** Starts the server and initialises it. Throws when it doesn't start or answer. */
  async start(): Promise<void> {
    const p = spawn(this.launch.command, [...this.launch.args], { cwd: this.launch.cwd ?? os.homedir(), env: this.launch.env, stdio: "pipe", shell: false, windowsHide: true });
    this.proc = p;
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d: string) => this.read(d));
    // Its own messages to stderr are dropped: they may hold anything it read.
    p.stderr.on("data", () => undefined);
    p.on("error", err => this.fail(new Error(`the connector didn't start: ${err.message}`)));
    p.on("exit", code => { this.fail(new Error("the connector stopped")); this.o.onExit?.(code); });
    const init = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "Ember", version: "1" },
    }) as { serverInfo?: { name?: unknown; version?: unknown } };
    this.server = { name: String(init?.serverInfo?.name ?? "").slice(0, 80), version: String(init?.serverInfo?.version ?? "").slice(0, 40) };
    this.notify("notifications/initialized");
  }

  /** The server's tools (at most 200, each description cut to 500 characters). */
  async tools(): Promise<McpTool[]> {
    const r = await this.request("tools/list", {}) as { tools?: unknown };
    const list = Array.isArray(r?.tools) ? r.tools.slice(0, 200) : [];
    return list.flatMap((t: unknown): McpTool[] => {
      const x = t as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } };
      if (typeof x?.name !== "string" || !/^[\w.-]{1,64}$/.test(x.name)) return [];
      return [{ name: x.name, description: typeof x.description === "string" ? x.description.slice(0, 500) : "", readOnly: x.annotations?.readOnlyHint === true, inputSchema: x.inputSchema ?? {} }];
    });
  }

  /** Calls a tool; its text content, joined (other content kinds are named, not passed on). */
  async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const r = await this.request("tools/call", { name, arguments: args }) as { content?: unknown; isError?: unknown };
    const parts = Array.isArray(r?.content) ? r.content : [];
    const text = parts.map((c: unknown) => {
      const x = c as { type?: unknown; text?: unknown };
      return x?.type === "text" && typeof x.text === "string" ? x.text : `[${String(x?.type ?? "content").slice(0, 20)} not shown]`;
    }).join("\n");
    return { text, isError: r?.isError === true };
  }

  /** Stops the server (at once: it is killed, and every request still waiting fails). */
  stop(): void {
    this.fail(new Error("the connector was stopped"));
    try { this.proc?.kill("SIGKILL"); } catch { /* already gone */ }
    this.proc = null;
  }

  get running(): boolean {
    return !!this.proc && !this.closed;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed || !this.proc) return Promise.reject(new Error("the connector isn't running"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`the connector didn't answer ${method} in time`)); }, this.o.timeoutMs ?? MCP_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string): void {
    this.send({ jsonrpc: "2.0", method });
  }

  private send(msg: unknown): void {
    try { this.proc?.stdin.write(`${JSON.stringify(msg)}\n`); } catch (err) { this.fail(err instanceof Error ? err : new Error(String(err))); }
  }

  private read(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > MCP_MAX_LINE && !this.buf.includes("\n")) { this.stop(); return; }
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: { id?: unknown; result?: unknown; error?: { message?: unknown }; method?: unknown };
      try { msg = JSON.parse(line); } catch { continue; }
      // A request from the server (sampling, roots, elicitation): Ember offers none of them.
      if (typeof msg.method === "string" && msg.id !== undefined) { this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Ember doesn't offer this" } }); continue; }
      if (typeof msg.id !== "number") continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(String(msg.error.message ?? "the connector refused").slice(0, 200)));
      else p.resolve(msg.result);
    }
  }

  private fail(err: Error): void {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
}
