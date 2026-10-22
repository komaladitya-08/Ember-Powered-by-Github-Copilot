/**
 * How serve and its desktop child talk (§5.3.1: "internal JSON lines over its stdio; never reachable otherwise"): one
 * JSON object per line each way, requests answered by id, and events. Serve asks the child to read and act; the child
 * asks serve for one thing only, the write-ahead audit of a step (serve owns the audit log and the link's freshness and
 * epoch, so it can still refuse the step at that moment). A malformed line ends the link: the child is Ember's own code,
 * so anything else means it is broken. Plain Node.
 */

import readline from "node:readline";
import { z } from "zod";
import type { Logger } from "../main/logger";
import type { ErrCode } from "../main/remote/protocol";
import { ERR_CODES } from "../main/remote/protocol";
import type { DesktopAccess } from "../main/targets/types";

/** What the child is told about the session and the policies when it starts (and `policy` again on a change). */
/** ChildPolicy as the child checks it. */
export const ChildPolicySchema = z.object({
  neverLook: z.array(z.string().max(200)).max(1000),
  actionsAllowed: z.boolean(),
  confirmEveryAction: z.boolean(),
  maxActionsPerMinute: z.number().int().min(1).max(40).optional(),
  screenImages: z.boolean(),
}).strict();

/** InitArgs as the child checks it. */
export const InitArgsSchema = z.object({
  type: z.enum(["x11", "wayland"]),
  access: z.enum(["screen", "text"]),
  pc: z.string().max(64),
  host: z.string().max(255),
  consent: z.boolean(),
  policy: ChildPolicySchema,
  atspi: z.string().min(1).max(4096),
  notice: z.string().min(1).max(4096),
}).strict();

export interface ChildPolicy {
  /** The PC's never-look list and this computer's administrator's, joined. */
  neverLook: string[];
  /** This computer's administrator: acting in apps at all, a yes for every action, the rate limit, screen images. */
  actionsAllowed: boolean;
  confirmEveryAction: boolean;
  maxActionsPerMinute?: number;
  screenImages: boolean;
}

export interface InitArgs {
  type: "x11" | "wayland";
  access: "screen" | "text";
  /** The PC's name as it reported it (the notice names it) and this computer's (messages). */
  pc: string;
  host: string;
  /** This computer's administrator wants a person at the screen to allow Ember first (§5.3.9). */
  consent: boolean;
  policy: ChildPolicy;
  /** The AT-SPI sidecar and the notice scripts, in the parts folder. */
  atspi: string;
  notice: string;
}

export interface InitResult { access: DesktopAccess; why?: string; notice: "shown" | "failed" | "off" }

/** A failed request's code and words (the protocol's codes, so serve can pass them on as they are). */
export class IpcError extends Error {
  constructor(readonly code: ErrCode, message: string) { super(message); }
}

const ID = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const MessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("req"), id: ID, op: z.string().max(64), a: z.unknown() }).strict(),
  z.object({ t: z.literal("res"), id: ID, ok: z.literal(true), v: z.unknown() }).strict(),
  z.object({ t: z.literal("res"), id: ID, ok: z.literal(false), e: z.object({ code: z.enum(ERR_CODES), m: z.string().max(1000) }).strict() }).strict(),
  z.object({ t: z.literal("ev"), ev: z.string().max(64), d: z.unknown() }).strict(),
]);
type Message = z.infer<typeof MessageSchema>;

/** The longest line either side accepts (a screenshot's PNG in base64 is the largest: 8 MiB → about 11 MiB). */
export const LINE_MAX = 16 * 1024 * 1024;

/** One end of the JSON-lines link. */
export interface LineRpc {
  request(op: string, a: unknown, timeoutMs: number): Promise<unknown>;
  event(ev: string, d: unknown): void;
  /** Ends every request still waiting with `why` (code "gone") and stops reading. */
  close(why: string): void;
  readonly closed: boolean;
}

/**
 * A JSON-lines link over `input`/`output`. `onRequest` answers the other side's requests (throw an IpcError for a
 * coded refusal; anything else is "internal"); `onEvent` gets its events; `onClose` fires once when the input ends or
 * a malformed line arrives.
 */
export function lineRpc(o: {
  input: NodeJS.ReadableStream; output: NodeJS.WritableStream; log: Logger;
  onRequest: (op: string, a: unknown) => Promise<unknown>;
  onEvent: (ev: string, d: unknown) => void;
  onClose: (why: string) => void;
}): LineRpc {
  let next = 1;
  let closed = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const write = (m: Message) => {
    if (closed) return;
    try { o.output.write(`${JSON.stringify(m)}\n`); } catch (err) { o.log.warn("remote.ipc_write_failed", { err }); }
  };
  const close = (why: string) => {
    if (closed) return;
    closed = true;
    rl.close();
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new IpcError("gone", why)); }
    pending.clear();
    o.onClose(why);
  };
  const rl = readline.createInterface({ input: o.input, crlfDelay: Infinity });
  rl.on("line", line => {
    if (closed) return;
    if (line.length > LINE_MAX) { close("a line too long"); return; }
    let m: Message;
    try {
      m = MessageSchema.parse(JSON.parse(line));
    } catch {
      close("a malformed line");
      return;
    }
    if (m.t === "ev") { o.onEvent(m.ev, m.d); return; }
    if (m.t === "res") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.v);
      else p.reject(new IpcError(m.e.code, m.e.m));
      return;
    }
    const id = m.id;
    o.onRequest(m.op, m.a).then(
      v => write({ t: "res", id, ok: true, v: v ?? {} }),
      (err: unknown) => {
        const code: ErrCode = err instanceof IpcError ? err.code : "internal";
        if (!(err instanceof IpcError)) o.log.error("remote.ipc_request_failed", { op: m.op, err });
        write({ t: "res", id, ok: false, e: { code, m: (err instanceof Error ? err.message : String(err)).slice(0, 1000) } });
      },
    );
  });
  rl.on("close", () => close("the other side closed"));
  return {
    request(op, a, timeoutMs) {
      if (closed) return Promise.reject(new IpcError("gone", "the desktop helper isn't running"));
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new IpcError("internal", `the desktop helper didn't answer ${op} in time`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        write({ t: "req", id, op, a });
      });
    },
    event: (ev, d) => write({ t: "ev", ev, d }),
    close,
    get closed() { return closed; },
  };
}
