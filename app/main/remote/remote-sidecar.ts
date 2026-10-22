/**
 * A remote's accessibility reader as a worker uses it (§5.5): reads go to the agent's `ax.*` ops, and each mutation
 * (doAction, setText, setValue, selectOption) goes out as one `act` that carries gate 1's stamp for exactly that step.
 * The stamp is handed over by the worker through `onAuthorized` immediately before the step runs (critique
 * integration-6); it must fit the step's kind, value and element (the element as this link last read it), be under 10 s
 * old by the PC's own monotonic clock, and is consumed by the step. Gate 2's answers come back as errors the worker
 * turns into tool results; in v1 a desktop `needs_confirm` is refused (every remote step already carries the user's yes,
 * L4; critique integration-24).
 *
 * Also the small helpers every PC-side remote object shares: asking the link with the per-op timeouts of §5.4 and
 * re-checking each answer against OP_SCHEMAS (§7.2), mapping the link's failures to plain words, and the books of the
 * elements this link read and the stamps waiting for their step. Nothing a remote sends is ever turned into an approval,
 * an action, a setting or an instruction here: its strings only come back as quoted data in Ember's own sentences. Plain Node.
 */

import crypto from "node:crypto";
import { inferLabels, quoteUntrusted } from "../perception/elements";
import { ERR_CODES, OP_SCHEMAS, type ErrCode, type GateAnswer, type Op, type OpArgs, type OpResult } from "./protocol";
import type { Logger } from "../logger";
import type { ActionResult, AxNode, CanDo, ElementInfo } from "../perception/sidecar";
import type { ActStamp, SidecarPort } from "../perception/ports";
import type { ActionKind, TextMode } from "../policy/policy";
import type { RemoteLink } from "./types";

// ---------------------------------------------------------------------------------------------------------------------
// Errors.

/** Gate 2's answers to a step that the worker maps by `code` (worker.ts remoteRefusal): its words are the remote's, quoted there. */
export type StepCode = "deny" | "needs_confirm" | "changed" | "stale" | "stopped";

/** A remote's gate 2 (or its link) didn't let a step happen: `code` says how, `message` in words the worker quotes. */
export class RemoteStepError extends Error {
  constructor(readonly code: StepCode, message: string) {
    super(message);
    this.name = "RemoteStepError";
  }
}

/** Any other failure of a request to a remote (`remoteCode`: the agent's ErrCode, or "link" when it never answered). */
export class RemoteError extends Error {
  constructor(readonly remoteCode: ErrCode | "link" | "unchecked", message: string) {
    super(message);
    this.name = "RemoteError";
  }
}

/** Ember refused a step itself before anything was sent: its stamp is missing, stale, used or for another step. */
export class StampError extends Error {
  constructor(message = LOST_TRACK) {
    super(message);
    this.name = "StampError";
  }
}

/** §5.5's words when a step comes without the stamp that fits it. */
export const LOST_TRACK = "Not allowed: Ember lost track of this step; perceive again.";

/** The words for a remote that answered something its schema or the PC's own checks refuse (§7.2 item 6). */
export const unchecked = (label: string) => `${label} answered in a way Ember can't check.`;

// ---------------------------------------------------------------------------------------------------------------------
// Remote text.

/** C0 and C1 controls (a remote's text is one plain line wherever Ember puts it). */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]+/g; // eslint-disable-line no-control-regex -- control characters are what's removed
/** Bidirectional overrides and isolates, which can make a line read otherwise than it is. */
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;

/** A remote's string as one plain line of at most `max` characters (controls become spaces, bidi overrides go). */
export function cleanRemote(s: string, max = 500): string {
  const one = s.replace(CONTROLS, " ").replace(BIDI, "").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * A remote's own words as Ember passes them on (§7.2 item 4): one plain line of at most `max` characters, quoted as
 * screen text is (`<` escaped), so a refusal's reason reaches the model as data inside Ember's sentence, never as
 * words of Ember's own. "" for nothing said.
 */
export function remoteWords(s: string, max = 300): string {
  const one = cleanRemote(s, max);
  return one ? quoteUntrusted(one, max + 1) : "";
}

/** SHA-256 of a text as lower-case hex (the stamp's valueSha256). */
export const sha256Hex = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------------------------------------------------------------
// Asking the link.

/**
 * How long each op may take before the PC gives up on it, without the round trip (§5.4's timeouts). desktop.state may
 * start the remote's desktop helper, which has 30 s to verify the desktop and show its notice (app/remote/desktop.ts),
 * so it gets a little more (and the console's two minutes more where the remote's administrator asks for that).
 */
const OP_MS: Partial<Record<Op, number>> = {
  "perceive.read": 10_000, "perceive.focused": 10_000, "perceive.perceive": 10_000, "perceive.atPoint": 10_000,
  "perceive.windows": 10_000, "perceive.openWindows": 10_000, "perceive.systemDialog": 10_000, "desktop.state": 35_000,
  "ax.readElement": 10_000, "ax.canDo": 10_000, "ax.listOptions": 10_000, "act": 10_000, "apps.launch": 10_000,
  "cmd.facts": 5000, "cmd.inspect": 5000, "cmd.git": 5000, "cmd.run": 5000, "cmd.input": 5000, "cmd.stop": 5000, "policy.sync": 5000,
};
/** apps.list has no round trip added (§5.4). */
const NO_RTT: ReadonlySet<Op> = new Set(["apps.list"]);

/** The time limit for one request of `op` on `link` (ms): §5.4's, plus the link's round trip where it says so. */
export function opTimeout(link: Pick<RemoteLink, "rttMs">, op: Op, extraMs = 0): number {
  const rtt = Number.isFinite(link.rttMs) && link.rttMs > 0 ? Math.min(link.rttMs, 60_000) : 0;
  return (op === "apps.list" ? 10_000 : OP_MS[op] ?? 10_000) + (NO_RTT.has(op) ? 0 : rtt) + extraMs;
}

/** What askRemote needs to say who answered and how long to wait. */
export interface AskOptions {
  /** The computer's name as the user knows it (local data: the host record's label). */
  label: string;
  /** Added to §5.4's limit (an image's transfer). */
  extraMs?: number;
  /** Sent while the link is stalled too (a Stop for one run): everything else waits for a link that answers. */
  whileStalled?: boolean;
}

const ERR_SET: ReadonlySet<string> = new Set(ERR_CODES);

/**
 * Asks `link` for `op` and checks the answer again against OP_SCHEMAS (§7.2: the link validated it already; this side
 * never relies on that). The request is sent synchronously, before the first await, so a stamp's age measured just
 * before the call is its age when it leaves. Refuses at once while the link isn't ready (a stalled link takes nothing new,
 * §5.1.11). Throws RemoteStepError for gate 2's refusals and a link that can't take the step, RemoteError otherwise.
 */
export function askRemote<O extends Op>(link: RemoteLink, op: O, args: OpArgs<O>, o: AskOptions): Promise<OpResult<O>> {
  const state = link.state;
  if (state !== "ready" && !(o.whileStalled && state === "stalled")) {
    return Promise.reject(state === "stalled" ? new RemoteStepError("stale", `${o.label} isn't answering right now, so nothing was sent.`)
      : new RemoteError("link", `The connection to ${o.label} is closed.`));
  }
  let sent: Promise<OpResult<O>>;
  try {
    sent = link.request(op, args, { timeoutMs: opTimeout(link, op, o.extraMs) });
  } catch (err) {
    return Promise.reject(linkFailure(err, link, o.label));
  }
  return sent.then(answer => {
    const checked = OP_SCHEMAS[op].result.safeParse(answer);
    if (!checked.success) throw new RemoteError("unchecked", unchecked(o.label));
    return checked.data as OpResult<O>;
  }, (err: unknown) => {
    throw linkFailure(err, link, o.label);
  });
}

/**
 * A failed request in Ember's words: the agent's own error codes (from a `res` with ok: false, which the link is assumed
 * to reject with an Error carrying `code`), or the link's (a timeout, a closed connection). The agent's message is kept
 * only as data, one plain line, for the worker to quote.
 */
export function linkFailure(err: unknown, link: Pick<RemoteLink, "state">, label: string): Error {
  if (err instanceof RemoteStepError || err instanceof RemoteError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const said = remoteWords(err instanceof Error ? err.message : typeof err === "string" ? err : "", 300);
  if (typeof code === "string" && ERR_SET.has(code)) {
    switch (code as ErrCode) {
      case "denied": return new RemoteStepError("deny", said ? `${label} refused it: ${said}` : `${label} refused it.`);
      case "needs_confirm": return new RemoteStepError("needs_confirm", needsConfirmWords(label));
      case "changed": return new RemoteStepError("changed", "It changed: perceive again.");
      case "stale": return new RemoteStepError("stale", `${label} didn't answer in time, so this step wasn't done.`);
      case "stopped": return new RemoteStepError("stopped", "Stopped.");
      case "busy": return new RemoteError("busy", `${label} is busy${said ? `: ${said}` : ""}`);
      case "gone": return new RemoteError("gone", `It is gone on ${label}${said ? `: ${said}` : ""}`);
      case "not_ready": return new RemoteError("not_ready", `${label}'s desktop isn't ready${said ? `: ${said}` : ""}`);
      default: return new RemoteError(code as ErrCode, said ? `${label} couldn't do it: ${said}` : `${label} couldn't do it (${code}).`);
    }
  }
  if (link.state === "lost" || link.state === "closed") return new RemoteError("link", `The connection to ${label} dropped.`);
  if (link.state === "stalled") return new RemoteStepError("stale", `${label} isn't answering right now, so this step wasn't done.`);
  // The worker reads "did not answer" as a step whose outcome is unknown (worker.ts), which is what a timeout is.
  return new RemoteError("link", `${label} did not answer in time`);
}

/** The worker's words for a desktop step a remote wanted confirmed (§5.3.7: refused in v1). */
export const needsConfirmWords = (label: string) => `${label} refused this step (it wanted a confirmation Ember couldn't give). Don't try another way.`;

/** Gate 2's answer to a step as an error to throw, or null for "ok" (§5.3.7). */
export function gateRefusal(a: GateAnswer, label: string): RemoteStepError | null {
  switch (a.status) {
    case "ok": return null;
    case "deny": {
      const said = remoteWords(a.reason, 500);
      return new RemoteStepError("deny", said ? `${label} refused it: ${said}` : `${label} refused it.`);
    }
    case "needs_confirm": return new RemoteStepError("needs_confirm", needsConfirmWords(label));
    case "changed": return new RemoteStepError("changed", "It changed: perceive again.");
    case "stale": return new RemoteStepError("stale", `${label} didn't answer in time, so this step wasn't done.`);
    case "stopped": return new RemoteStepError("stopped", "Stopped.");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The elements this link read.

interface Known {
  role: string;
  /** The names a step on it may carry: the read's name and the label beside it (the worker's nameOf). */
  names: string[];
  /** As readElement (or a step's result) last told it. */
  live?: { role: string; name: string };
  /** The control around it a click goes to (canDo's handler). */
  handler?: { role: string; name: string };
  secret: boolean;
}

/**
 * The elements this link's kept reads gave out, by id (§7.2: steps and element reads name only these), with what a step's
 * stamp may call each one. Bounded: the ids of the latest reads (a read holds at most CAPS.nodes elements).
 */
export class ElementBook {
  private known = new Map<number, Known>();

  constructor(private readonly max = 16_000) {}

  /** A kept read's elements (a quick look's ids are never acted on, so they aren't noted). */
  noteRead(nodes: AxNode[]): void {
    const labels = inferLabels(nodes);
    for (const n of nodes) {
      const label = labels.get(n.id);
      this.set(n.id, {
        role: n.role,
        names: [...new Set([n.name, ...(label ? [label] : [])])],
        secret: !!n.secret || n.role === "password text",
      });
    }
  }

  /** What a read of one element (readElement, or a step's result after it) says it is now. */
  noteLive(id: number, info: Pick<ElementInfo, "role" | "name" | "secret">): void {
    const k = this.known.get(id);
    if (!k) return;
    k.live = { role: info.role, name: info.name };
    if (info.secret) k.secret = true;
  }

  /** The control a click on `id` goes to, as canDo said it (null: none). */
  noteHandler(id: number, handler: { role: string; name: string } | null): void {
    const k = this.known.get(id);
    if (!k) return;
    if (handler) k.handler = { role: handler.role, name: handler.name };
    else delete k.handler;
  }

  has(id: number): boolean {
    return this.known.has(id);
  }

  /** Read as a secret field (or told so since): nothing is typed, chosen or set there. */
  isSecret(id: number): boolean {
    return this.known.get(id)?.secret ?? false;
  }

  /**
   * Does a stamp's element name `id` as this link last read it? Its role, with its name, the label beside it or its name
   * as last read alone (the worker's request names it so), or the control a click on it goes to (worker clickJudged).
   */
  fits(id: number, el: { role: string; name: string } | null): boolean {
    const k = this.known.get(id);
    if (!k || !el) return false;
    const names = new Set([...k.names, ...(k.live ? [k.live.name] : [])]);
    if (el.role === k.role && names.has(el.name)) return true;
    const h = k.handler;
    return !!h && el.role === h.role && (el.name === h.name || (!h.name && names.has(el.name)));
  }

  /** Forgets everything (the link went). */
  clear(): void {
    this.known.clear();
  }

  private set(id: number, k: Known): void {
    this.known.delete(id);
    this.known.set(id, k);
    while (this.known.size > this.max) this.known.delete(this.known.keys().next().value!);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The stamps waiting for their step.

/** A stamp is good for this long on the PC's monotonic clock, its age when handed over included (gate 2 refuses ≥ 10 s). */
export const STAMP_MAX_MS = 10_000;
/** Stamps kept waiting at most (steps of several tasks on one remote can't interleave more than this). */
const STAMPS_MAX = 16;

/**
 * Gate 1's stamps handed over by the worker (onAuthorized), each waiting for the one step it was given for. A step takes
 * the newest stamp that fits it, with its age as it leaves (critique integration-6); a stamp is used once. A Stop (the
 * link's epoch moving on, §5.1.11) voids every stamp handed over before it: a yes given before Stop never acts after it.
 */
export class StampBook {
  private waiting: { stamp: ActStamp; at: number; epoch: number }[] = [];

  constructor(private readonly now: () => number = () => performance.now(), private readonly epoch: () => number = () => 0) {}

  /** The worker's policy said yes to a step that runs now (TargetHands.onAuthorized). */
  add(stamp: ActStamp): void {
    const at = this.now();
    this.waiting = this.fresh(at);
    this.waiting.push({ stamp: { ...stamp, element: stamp.element && { ...stamp.element }, approval: stamp.approval && { given: true } }, at, epoch: this.epoch() });
    if (this.waiting.length > STAMPS_MAX) this.waiting.shift();
  }

  /**
   * The newest waiting stamp of one of `kinds` that `fits`, taken out of the book, its `ageMs` grown by the time it
   * waited here. Throws StampError when none fits, or when the one that does has no yes from the user (every remote step
   * is confirmed, L4) or is too old.
   */
  take(kinds: readonly ActionKind[], fits: (s: ActStamp) => boolean, label: string): ActStamp {
    const now = this.now();
    // Only stamps of the link's current epoch are candidates (one from before a Stop never fits).
    const epoch = this.epoch();
    this.waiting = this.waiting.filter(w => w.epoch === epoch);
    let i = this.waiting.length - 1;
    for (; i >= 0; i--) {
      const s = this.waiting[i].stamp;
      if (kinds.includes(s.kind) && fits(s)) break;
    }
    if (i < 0) {
      this.waiting = this.fresh(now);
      throw new StampError();
    }
    const [{ stamp, at }] = this.waiting.splice(i, 1);
    this.waiting = this.fresh(now);
    const ageMs = Math.max(0, Math.round(stamp.ageMs + (now - at)));
    if (ageMs >= STAMP_MAX_MS || !Number.isFinite(ageMs)) throw new StampError();
    if (stamp.verdict !== "confirm" || !stamp.approval?.given) throw new StampError(`Not allowed: every step on ${label} needs the user's yes first.`);
    return { ...stamp, ageMs };
  }

  /** Forgets every waiting stamp (the link went, or Stop). */
  clear(): void {
    this.waiting = [];
  }

  get size(): number {
    return this.waiting.length;
  }

  /** The stamps still good: under 10 s old, and handed over since the latest Stop. */
  private fresh(now: number): { stamp: ActStamp; at: number; epoch: number }[] {
    const epoch = this.epoch();
    return this.waiting.filter(w => w.epoch === epoch && w.stamp.ageMs + (now - w.at) < STAMP_MAX_MS);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The sidecar port.

/** What createRemoteSidecar needs. */
export interface RemoteSidecarOptions {
  /** The computer's name as the user knows it (local data). */
  label: string;
  log: Logger;
  elements: ElementBook;
  stamps: StampBook;
  /** Why the remote's desktop can't be used now, or null when it can (the binding's desktop isn't "none"). */
  unavailable: () => string | null;
}

/** The step kind a doAction is stamped as (worker.ts act(): a click, or a toggle); any other action has none. */
const actionKind = (action: string): ActionKind | undefined => (action === "click" ? "click" : action === "toggle" ? "toggle" : undefined);

/** A remote's accessibility reader as a worker's SidecarPort (§5.5). */
export function createRemoteSidecar(link: RemoteLink, o: RemoteSidecarOptions): SidecarPort {
  const { label, elements, stamps } = o;
  let steps = 0;
  const opPrefix = crypto.randomBytes(6).toString("hex");

  /** Reads and steps name only elements this link's reads gave out (§7.2). */
  const known = (id: number): void => {
    const why = o.unavailable();
    if (why) throw new RemoteError("not_ready", why);
    if (!Number.isSafeInteger(id) || !elements.has(id)) throw new RemoteError("gone", `Element ${id} isn't in Ember's latest read of ${label}.`);
  };

  /**
   * One step: its stamp taken now (it must fit the kind, the value and the element as last read), its age set as the
   * `act` leaves, gate 2's answer mapped. Everything up to the send is synchronous, so the stamp handed over just before
   * the call is the one this step takes.
   */
  const step = async (id: number, kind: ActionKind | undefined, value: string | null, op: { op: "do_action"; action: string } | { op: "set_text"; text: string; mode: TextMode } | { op: "set_value"; value: number } | { op: "select_option"; option: string }): Promise<ActionResult> => {
    known(id);
    if (!kind) throw new StampError();
    if (value !== null && elements.isSecret(id)) throw new RemoteError("denied", "Not allowed: this looks like a password or payment field.");
    const hash = value === null ? null : sha256Hex(value);
    const stamp = stamps.take([kind], s => elements.fits(id, s.element) && (hash === null || s.valueSha256 === hash), label);
    const args = { opId: `${opPrefix}-${++steps}`, epoch: link.epoch, stamp, id, ...op } as OpArgs<"act">;
    const answer = await askRemote(link, "act", args, { label });
    const refused = gateRefusal(answer, label);
    if (refused) throw refused;
    if (!answer.result) throw new RemoteError("unchecked", unchecked(label));
    if (answer.result.after) elements.noteLive(id, answer.result.after);
    return answer.result;
  };

  return {
    async readElement(id: number, opts: { shown?: boolean; formula?: boolean } = {}): Promise<ElementInfo> {
      known(id);
      const info = await askRemote(link, "ax.readElement", { id, ...(opts.shown ? { shown: true } : {}), ...(opts.formula ? { formula: true } : {}) }, { label });
      elements.noteLive(id, info);
      return info;
    },
    async canDo(id: number, kind: "click" | "toggle" | "text" | "value", caret = false): Promise<CanDo> {
      known(id);
      const r = await askRemote(link, "ax.canDo", { id, kind, caret }, { label });
      if (kind === "click" || kind === "toggle") elements.noteHandler(id, r.handler ?? null);
      return r;
    },
    async listOptions(id: number): Promise<{ options: string[]; left?: number }> {
      known(id);
      return askRemote(link, "ax.listOptions", { id }, { label });
    },
    doAction: (id: number, action = "click") => step(id, actionKind(action), null, { op: "do_action", action }),
    setText: (id: number, text: string, mode: TextMode = "replace") => step(id, "text", text, { op: "set_text", text, mode }),
    setValue: (id: number, value: number) => step(id, "value", String(value), { op: "set_value", value }),
    selectOption: (id: number, option: string) => step(id, "select", option, { op: "select_option", option }),
    // The remote's elements report the remote's own units; the PC never flies to them or scales them (§5.5).
    scaleOf: () => 1,
    // The link's Stop stops the remote's reader; there is no process here to stop.
    stop: () => undefined,
  };
}
