/**
 * Connectors (the Jarvis research's J6; PLAN.md §2 "Connectors"): MCP servers the user adds in Settings, so Ember can
 * read their mail, calendar, chat or tickets when asked ("what's on my calendar?", "anything from Priya?"). Each is a
 * program on this computer (mcp.ts), started on first use and stopped by the kill switch.
 *
 * The limits:
 * - Only the user adds a connector, in Ember's own settings window, and each has its own consent (agreed when added,
 *   FEATURE_CONSENT_VERSION.connectors). The model can only list and read the ones that pass, never add one.
 * - Read only: a tool is offered only when the server marks it read-only (readOnlyHint). Sending, deleting or changing
 *   anything through a connector would need its own policy and questions, and isn't offered.
 * - What comes back is data: wrapped in <connector_result untrusted="true">, "<" escaped, cut to RESULT_MAX. It never
 *   starts a task, steers one, or becomes the user's own words (memory's ownWords, reminders, routines).
 * - The organisation's features.connectors (and LOCKDOWN) turns them all off. Every call is audited (sizes only).
 * - A shell can't be the program: a connector is a program and its arguments, so no shell line runs.
 */

import path from "node:path";
import { McpClient, type McpLaunch, type McpTool } from "./mcp";

/** A connector as settings keep it. */
export interface ConnectorConfig { id: string; name: string; command: string; args: string[]; consent: { version: number; at: string | null } }

/** The most a tool's result passes on to Copilot. */
export const RESULT_MAX = 8000;
/** The largest arguments the model may send a tool (JSON). */
export const ARGS_MAX = 4000;

/** Programs that are shells: a connector runs a program, never a shell line. */
const SHELLS = /^(?:sh|bash|zsh|fish|dash|ksh|csh|tcsh|cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe|wsl|wsl\.exe)$/i;

/** Why a connector's program can't be used, or null when it can. */
export function connectorRefusal(c: Pick<ConnectorConfig, "command" | "args">): string | null {
  const base = path.basename(c.command.trim());
  if (!base) return "A connector needs a program.";
  if (SHELLS.test(base)) return "Add the connector's own program, not a shell.";
  if (/[\n\r\0]/.test(c.command) || c.args.some(a => /[\n\r\0]/.test(a))) return "The program and its arguments can't hold line breaks.";
  return null;
}

/** Text from a connector, made safe to put inside Ember's wrapper. */
const escapeUntrusted = (s: string) => s.replace(/</g, "\\u003c");

export interface ConnectorServiceOptions {
  /** The connectors in settings. */
  list: () => ConnectorConfig[];
  /** The version a connector's consent must have (FEATURE_CONSENT_VERSION.connectors). */
  consentVersion: number;
  /** The organisation allows connectors (features.connectors, not LOCKDOWN). */
  allowed: () => boolean;
  /** The environment a connector's program gets (appEnv: no tokens, keys or Ember's own variables). */
  env: () => NodeJS.ProcessEnv;
  audit?: (e: { event: "connector"; connector: string; tool: string; chars: number; ok: boolean; reason?: string }) => void;
  log?: { info(msg: string, f?: object): void; warn(msg: string, f?: object): void };
  /** Makes a client (tests pass a fake). */
  client?: (launch: McpLaunch) => Pick<McpClient, "start" | "tools" | "call" | "stop" | "running">;
}

export class ConnectorService {
  private live = new Map<string, { client: Pick<McpClient, "start" | "tools" | "call" | "stop" | "running">; ready: Promise<McpTool[]> }>();

  constructor(private o: ConnectorServiceOptions) {}

  /** The connectors Ember may use now: agreed to, a usable program, and allowed. */
  usable(): ConnectorConfig[] {
    if (!this.o.allowed()) return [];
    return this.o.list().filter(c => c.consent.version >= this.o.consentVersion && !connectorRefusal(c));
  }

  private find(name: string): ConnectorConfig | undefined {
    const key = name.trim().toLowerCase();
    return this.usable().find(c => c.name.toLowerCase() === key || c.id === name);
  }

  /** The connector's read-only tools, starting it on first use. */
  private async tools(c: ConnectorConfig): Promise<McpTool[]> {
    let l = this.live.get(c.id);
    if (!l || !l.client.running) {
      const client = (this.o.client ?? (launch => new McpClient(launch)))({ command: c.command, args: c.args, env: this.o.env() });
      const ready = client.start().then(() => client.tools());
      l = { client, ready };
      this.live.set(c.id, l);
      ready.catch(err => { this.o.log?.warn("connectors.start_failed", { connector: c.name, err: err instanceof Error ? err.message : String(err) }); this.live.delete(c.id); client.stop(); });
    }
    return l.ready;
  }

  /** What list_connectors tells the conductor: each usable connector and its read-only tools (their words untrusted). */
  async describe(): Promise<string> {
    const list = this.usable();
    if (!list.length) return "No connectors are set up. The user can add one in Ember's settings (Connectors).";
    const lines: string[] = [];
    for (const c of list) {
      try {
        const tools = await this.tools(c);
        const read = tools.filter(t => t.readOnly);
        lines.push(`${JSON.stringify(c.name)}: ${read.length ? read.map(t => `${t.name} (${escapeUntrusted(t.description.slice(0, 160))}; arguments: ${escapeUntrusted(JSON.stringify(t.inputSchema).slice(0, 300))})`).join("; ") : "no read-only tools"}${tools.length > read.length ? `; ${tools.length - read.length} that change things are not offered` : ""}`);
      } catch (err) {
        lines.push(`${JSON.stringify(c.name)}: couldn't start (${escapeUntrusted(err instanceof Error ? err.message : String(err)).slice(0, 120)})`);
      }
    }
    return `<connectors untrusted="true">\n${lines.join("\n")}\n</connectors>`;
  }

  /** Calls one read-only tool of a connector; its result wrapped as untrusted data, or a sentence saying why not. */
  async read(connector: string, tool: string, args: unknown): Promise<string> {
    const c = this.find(connector);
    if (!c) return `No connector is called ${JSON.stringify(connector.slice(0, 40))}. Use list_connectors.`;
    const a = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
    if (JSON.stringify(a).length > ARGS_MAX) return "Those arguments are too long.";
    const audit = (chars: number, ok: boolean, reason?: string) => this.o.audit?.({ event: "connector", connector: c.name, tool: tool.slice(0, 64), chars, ok, ...(reason ? { reason } : {}) });
    let tools: McpTool[];
    try { tools = await this.tools(c); } catch (err) {
      audit(0, false, "start failed");
      return `The connector ${JSON.stringify(c.name)} couldn't start: ${escapeUntrusted(err instanceof Error ? err.message : String(err)).slice(0, 160)}`;
    }
    const t = tools.find(x => x.name === tool);
    if (!t) { audit(0, false, "no such tool"); return `${JSON.stringify(c.name)} has no tool ${JSON.stringify(tool.slice(0, 64))}. Use list_connectors.`; }
    if (!t.readOnly) { audit(0, false, "changes things"); return `Not used: ${t.name} can change things, and connectors are read only. Tell the user Ember can only read through connectors.`; }
    try {
      const r = await this.live.get(c.id)!.client.call(t.name, a);
      const text = r.text.length > RESULT_MAX ? `${r.text.slice(0, RESULT_MAX)}…` : r.text;
      audit(r.text.length, !r.isError);
      this.o.log?.info("connectors.read", { connector: c.name, tool: t.name, chars: r.text.length, ok: !r.isError });
      return `<connector_result connector=${JSON.stringify(c.name)} tool=${JSON.stringify(t.name)} untrusted="true">\n${escapeUntrusted(text)}\n</connector_result>`;
    } catch (err) {
      audit(0, false, "call failed");
      return `${JSON.stringify(c.name)} didn't answer: ${escapeUntrusted(err instanceof Error ? err.message : String(err)).slice(0, 160)}`;
    }
  }

  /** Stops every connector's program (the kill switch, sign-out, a connector removed). */
  stopAll(): void {
    for (const l of this.live.values()) l.client.stop();
    this.live.clear();
  }

  /** Stops connectors no longer in settings or no longer usable. */
  prune(): void {
    const keep = new Set(this.usable().map(c => c.id));
    for (const [id, l] of this.live) if (!keep.has(id)) { l.client.stop(); this.live.delete(id); }
  }
}
