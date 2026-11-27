/**
 * The SDK's events on their way to a coding window (docs/CODING-APP.md §2 "Pass through, don't translate"): each one
 * as the runtime sent it, redacted (the vault's values and GitHub tokens never reach a window) and bounded (strings cut
 * until the event's data fits CODE_LIMITS.eventData, the event then marked `truncated`), and numbered per session so
 * a window can catch up (`EventLog`: a `seq` that counts up by one, a replay ring of CODE_LIMITS.replay envelopes, and
 * every event's id kept with its seq so history read again from the SDK's log keeps its numbers). Pure: no SDK, no I/O.
 */

import type { CodeEventEnvelope, CodeSdkEvent } from "../../shared/code";
import { CODE_LIMITS } from "../../shared/code";
import { redactGitHubTokens } from "../agent/auth";
import type { ModelRedactor } from "../agent/redacting-client";

/** One string's redaction: the vault's values (once anything was filled) and GitHub tokens. */
export type TextRedact = (text: string) => string;

/** The redaction every event passes: `vault` first (it knows the exact values), then GitHub's token shapes. */
export function eventRedactor(vault?: ModelRedactor): TextRedact {
  return text => {
    let out = text;
    if (vault?.active) out = vault.text(out);
    return out.length >= 20 ? redactGitHubTokens(out) : out;
  };
}

/** Deepest nesting kept; anything deeper becomes a cut marker. */
const MAX_DEPTH = 40;
/** Items of one array kept, and keys of one object. */
const MAX_ITEMS = 20_000;
/** The first cap on one string, quartered each pass until the data fits. */
const FIRST_STRING_CAP = 128 * 1024;
const LAST_STRING_CAP = 256;

/** `data` redacted with every string at most `cap` characters; `cut.any` is set where anything was cut. */
function copy(data: unknown, cap: number, redact: TextRedact, cut: { any: boolean }, depth = 0): unknown {
  if (typeof data === "string") {
    const clean = redact(data);
    if (clean.length <= cap) return clean;
    cut.any = true;
    return `${clean.slice(0, cap)}…`;
  }
  if (data === null || typeof data !== "object") return typeof data === "bigint" || typeof data === "function" || typeof data === "symbol" ? undefined : data;
  if (depth >= MAX_DEPTH) { cut.any = true; return "…"; }
  if (Array.isArray(data)) {
    if (data.length > MAX_ITEMS) cut.any = true;
    return data.slice(0, MAX_ITEMS).map(v => copy(v, cap, redact, cut, depth + 1));
  }
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (++n > MAX_ITEMS) { cut.any = true; break; }
    const value = copy(v, cap, redact, cut, depth + 1);
    if (value !== undefined) out[redact(k)] = value;
  }
  return out;
}

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");

/**
 * `data` redacted and cut to fit `limit` bytes of JSON: strings are cut (and end "…") at a cap that shrinks until it
 * fits; data that still doesn't fit is dropped whole (`{}`). `truncated` says whether anything was cut.
 */
export function boundData(data: unknown, redact: TextRedact, limit: number = CODE_LIMITS.eventData): { data: unknown; truncated: boolean } {
  for (let cap = FIRST_STRING_CAP; cap >= LAST_STRING_CAP; cap = Math.floor(cap / 4)) {
    const cut = { any: false };
    const out = copy(data, cap, redact, cut);
    if (bytes(out) <= limit) return { data: out, truncated: cut.any };
  }
  return { data: {}, truncated: true };
}

/** An SDK event as a window gets it: its envelope fields kept, its data redacted and bounded. */
export function boundEvent(event: { id?: unknown; parentId?: unknown; timestamp?: unknown; type?: unknown; data?: unknown; agentId?: unknown; ephemeral?: unknown }, redact: TextRedact, limit: number = CODE_LIMITS.eventData): CodeSdkEvent {
  const { data, truncated } = boundData(event.data ?? {}, redact, limit);
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  return {
    id: str(event.id, 200),
    ...(typeof event.parentId === "string" ? { parentId: event.parentId.slice(0, 200) } : event.parentId === null ? { parentId: null } : {}),
    timestamp: str(event.timestamp, 64),
    type: str(event.type, 200),
    data,
    ...(typeof event.agentId === "string" && event.agentId ? { agentId: event.agentId.slice(0, 200) } : {}),
    ...(event.ephemeral === true ? { ephemeral: true } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Event ids remembered with their seq, at most (the oldest are let go first). */
const MAX_IDS = 200_000;

/**
 * One session's numbered events for this run. `add` numbers an event the first time its id is seen (an event seen
 * again, from the SDK's log or a resume, keeps its number and is not sent twice), keeps the latest `limit` envelopes
 * for windows that catch up, and `since` returns what followed a window's last seq, or null when this run no longer
 * holds it (the window then gets the whole history: CodeAttached.reset).
 */
export class EventLog {
  private next = 1;
  private readonly ring: CodeEventEnvelope[] = [];
  private readonly ids = new Map<string, number>();

  constructor(readonly sessionId: string, private readonly limit: number = CODE_LIMITS.replay) {}

  /** The last seq given out (0: none yet). */
  get seq(): number { return this.next - 1; }

  /** The seq `id` was given, if it was. */
  seqOf(id: string): number | undefined { return this.ids.get(id); }

  /** Numbers `event` and keeps it; null when its id was numbered before (it isn't sent again). */
  add(event: CodeSdkEvent): CodeEventEnvelope | null {
    if (event.id && this.ids.has(event.id)) return null;
    const envelope: CodeEventEnvelope = { sessionId: this.sessionId, seq: this.next++, event };
    if (event.id) {
      this.ids.set(event.id, envelope.seq);
      if (this.ids.size > MAX_IDS) this.ids.delete(this.ids.keys().next().value as string);
    }
    this.ring.push(envelope);
    if (this.ring.length > this.limit) this.ring.splice(0, this.ring.length - this.limit);
    return envelope;
  }

  /** The envelopes after `sinceSeq`, in order; null when the ring no longer holds them all (or `sinceSeq` is not this run's). */
  since(sinceSeq: number): CodeEventEnvelope[] | null {
    if (!Number.isInteger(sinceSeq) || sinceSeq < 0 || sinceSeq > this.seq) return null;
    if (sinceSeq === this.seq) return [];
    const first = this.ring[0]?.seq ?? this.next;
    if (sinceSeq < first - 1) return null;
    return this.ring.filter(e => e.seq > sinceSeq);
  }

  /** Whether the ring holds everything from the first event on (so the whole history is in memory). */
  get whole(): boolean { return this.seq === 0 || this.ring[0]?.seq === 1; }

  /** Every envelope the ring holds. */
  held(): CodeEventEnvelope[] { return [...this.ring]; }

  /**
   * A history read from the SDK's log, as envelopes in seq order: each event keeps the seq it was given (and one
   * never seen is numbered now, through `fresh`, so it is sent to windows too), with what the ring holds that the log
   * doesn't (ephemeral events: deltas, request events) in their places.
   */
  history(kept: readonly CodeSdkEvent[], fresh: (event: CodeSdkEvent) => void): CodeEventEnvelope[] {
    const out = new Map<number, CodeEventEnvelope>();
    for (const event of kept) {
      let seq = event.id ? this.ids.get(event.id) : undefined;
      if (seq === undefined) {
        const added = this.add(event);
        if (!added) continue;
        fresh(event);
        seq = added.seq;
      }
      out.set(seq, { sessionId: this.sessionId, seq, event });
    }
    for (const e of this.ring) if (!out.has(e.seq)) out.set(e.seq, e);
    return [...out.values()].sort((a, b) => a.seq - b.seq);
  }
}
