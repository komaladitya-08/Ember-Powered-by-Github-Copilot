/**
 * A remote's commands as the command flow runs them (§5.5, §3.16): a CommandRunner over the agent's `cmd.*` ops. A run
 * starts with `cmd.run` carrying the PC's stamp (what it decided, and the user's yes with its age); the remote's gate 2
 * checks it again and either starts it on a bulk channel or refuses (`deny`) or wants the user's yes (`needs_confirm`,
 * with its own card lines and rules: the run then ends `refused-remote` so the flow can ask once, §3.8.3 step 13).
 * Output arrives on the run's channel as raw bytes, for the command window and for shaping on the PC; secret prompts
 * are tracked here from those bytes (§3.11 step 2); the user's typing goes out with `cmd.input` and is kept only in
 * memory for `typedLines()`, never logged. A run ends with the agent's `cmd.exit` once its last bytes are in, or "lost"
 * when the link goes. Nothing a remote says ends up as an approval: `needsConfirm` and the remote's lines come only
 * from its answer to the PC's own `cmd.run`, never from an event. Plain Node.
 */

import crypto from "node:crypto";
import posix from "node:path/posix";
import win32 from "node:path/win32";
import { EV_SCHEMAS, OP_SCHEMAS, type EvMap, type OpResult } from "./protocol";
import { askRemote, cleanRemote, RemoteError, RemoteStepError, remoteWords, unchecked } from "./remote-sidecar";
import type { OS } from "../../shared/shortcuts";
import type { TargetId } from "../../shared/targets";
import type { CommandRunner, GitFacts, PathFact, RunExit, RunnerFacts, RunningCommand, RunSpec } from "../commands/types";
import type { Logger } from "../logger";
import type { RemoteLink } from "./types";
import { trackSecretPrompts, type SecretTracker } from "../commands/prompts";
import { stalledText } from "../../renderer/command/copy";

/**
 * A remote's refusal as the run's `error` (review #215): only its own words, one plain line, because the flow's result
 * for the model and the command tab's status line each say "build-01 refused it" themselves. A sentence the remote's
 * gate says of itself ("This computer's administrator has turned off commands from Ember.") names the computer, as the
 * user's PC sees it.
 */
function refusalOf(reason: string, label: string): string {
  return cleanRemote(reason, 500).replace(/^This computer\b/, () => label);
}

/** A refusal the link reported in its own sentence ("build-01 refused it: \"…\""): the words quoted in it (refusalOf). */
function refusalIn(message: string, label: string): string {
  const prefix = `${label} refused it`;
  let rest = message.startsWith(prefix) ? message.slice(prefix.length).replace(/^[:.]\s*/, "") : message;
  if (rest.startsWith("\"")) {
    try {
      const v: unknown = JSON.parse(rest);
      if (typeof v === "string") rest = v;
    } catch {
      // not one quoted string: kept as it is
    }
  }
  return refusalOf(rest, label);
}

/** CL's secret-prompt tracker (§3.11 step 2; commands/prompts.ts). */
export type { SecretTracker };

/** A run's end as the flow reads it, with the extra rule ids a remote's `needs_confirm` carried (the flow resends with them). */
export type RemoteRunExit = RunExit & { rules?: string[] };

/** A remote run: a RunningCommand whose secret spans (positions in everything it printed, decoded as UTF-8) are kept here. */
export interface RemoteRunningCommand extends RunningCommand {
  readonly done: Promise<RemoteRunExit>;
  secretSpans(): { from: number; to: number }[];
}

/** The remote's runner, with what the targets runtime does when the link's parts go. */
export interface RemoteRunner extends CommandRunner {
  start(spec: RunSpec): RemoteRunningCommand;
  /** Tells the agent to stop every run still going, ends each as "lost" here, and stops listening to the link. */
  dispose(): void;
  /**
   * The line a running command's tab shows in place of "Running…" (§8.5), as the flow's followStatus reads a runner's
   * status: while the link is stalled, "<host> isn't answering. This command stops in N seconds unless it answers again.",
   * counting down each second to the grace; null otherwise.
   */
  status(): string | null;
  onStatus(fn: (text: string | null) => void): () => void;
}

/** What createRemoteRunner needs. */
export interface RemoteRunnerOptions {
  target: TargetId;
  label: string;
  /** The remote's OS (its facts must say the same; its paths follow its rules). */
  os: OS;
  log: Logger;
  /** The remote's facts as last known (welcome.facts at first): whether a run there gets a PTY before the agent says. */
  facts: RunnerFacts;
  /** The secret tracker per run (default CL's trackSecretPrompts; tests may pass their own). */
  trackSecrets?: (o: { interactive: boolean }) => SecretTracker;
  now?: () => number;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

/** cmd.input's limit per message: 4 KiB decoded (§5.4). */
const INPUT_CHUNK = 4096;
/** Typing held while the run is starting, at most. */
const QUEUE_MAX = 64 * 1024;
/**
 * After cmd.exit, how long the run's last bytes may take to arrive (bulk travels behind ctl), plus the round trip:
 * counted again from each chunk that still comes (a slow link drains the agent's queue of a fast printer's output,
 * up to about 1 MiB), and never more than TAIL_MAX_MS in all.
 */
const TAIL_MS = 2000;
const TAIL_MAX_MS = 120_000;
/** After a Stop, how long the agent has to say the run ended before the PC ends it itself, plus the round trip. */
const STOP_WAIT_MS = 10_000;
/** A run the agent hasn't ended this long after its own time limit is stopped from here (an agent that never says). */
const OVERDUE_MS = 10_000;
/** A lone UTF-16 surrogate: text whose UTF-8 bytes would differ from what the card showed (it becomes U+FFFD there). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Lines of the user's typing kept at most, and the longest one (in memory only). */
const MAX_TYPED_LINES = 1000;
const MAX_TYPED_LINE = 4096;
/** The remote's own card lines passed on with a needs_confirm, at most (the flow shows ten). */
const SAYS_MAX = 10;
/** The silence after which a link is stalled (§5.1.11): the grace counts from the last frame, this much earlier. */
const STALL_S = 5;

type StopWhy = "user" | "task" | "killswitch" | "timeout";
/** How a run the PC stopped ended, by who stopped it. */
const ENDED_BY: Readonly<Record<StopWhy, RunExit["ended"]>> = { user: "stopped-user", task: "stopped-task", killswitch: "killswitch", timeout: "timeout" };
/** What cmd.stop says (the kill switch is the user's own Stop: the agent's ladder is the same). */
const WIRE_WHY: Readonly<Record<StopWhy, "user" | "task" | "timeout">> = { user: "user", task: "task", killswitch: "user", timeout: "timeout" };
const STOP_ENDINGS: ReadonlySet<RunExit["ended"]> = new Set(["stopped-user", "stopped-task", "killswitch", "timeout"]);

/** sha256Hex(`${target}\0${shell}\0${cwd}\0${command}`): what the stamp binds a command to (§3.1). */
export const commandHash = (target: TargetId, spec: Pick<RunSpec, "shell" | "cwd" | "command">) =>
  crypto.createHash("sha256").update(`${target}\0${spec.shell}\0${spec.cwd}\0${spec.command}`, "utf8").digest("hex");

/** What a run needs of its runner. */
interface RunContext {
  link: RemoteLink;
  o: RemoteRunnerOptions;
  now: () => number;
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  pty: () => boolean;
  /** Another live run already reads this channel. */
  channelTaken(channel: number, run: RemoteRun): boolean;
  ended(run: RemoteRun): void;
}

/** One run on the remote, from cmd.run to its end. */
class RemoteRun implements RemoteRunningCommand {
  readonly done: Promise<RemoteRunExit>;
  private resolveDone!: (e: RemoteRunExit) => void;
  private state: "starting" | "running" | "ended" = "starting";
  /** As the agent answered (null: not yet). */
  private answeredInteractive: boolean | null = null;
  private readonly predicted: boolean;
  channel: number | null = null;
  private listeners = new Set<(chunk: Uint8Array) => void>();
  private offBytes: (() => void) | null = null;
  private decoder = new TextDecoder("utf-8");
  private tracker: SecretTracker | null = null;
  private received = 0;
  private exitEvent: EvMap["cmd.exit"] | null = null;
  /** When the agent's cmd.exit was taken up here (the tail's own limit counts from it). */
  private exitAt = 0;
  private stopWhy: StopWhy | null = null;
  private stopSent = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Stops a run the agent lets go past its own time limit. */
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private queued: Uint8Array[] = [];
  private queuedBytes = 0;
  private readonly startedAt: number;
  // The user's typing, as a terminal edits a line (L2): in memory only.
  private typed: string[] = [];
  private line = "";
  private esc: "" | "esc" | "csi" | "ss3" | "osc" | "osc-esc" = "";
  private lastWasCr = false;
  private inputDecoder = new TextDecoder("utf-8");

  constructor(readonly spec: RunSpec, private ctx: RunContext) {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.startedAt = ctx.now();
    this.predicted = ctx.pty();
  }

  get runId(): string { return this.spec.runId; }
  get interactive(): boolean { return this.answeredInteractive ?? this.predicted; }
  get ended(): boolean { return this.state === "ended"; }

  /** Sends cmd.run (never throws: whatever goes wrong ends `done`). */
  begin(): void {
    const { link, o } = this.ctx;
    const spec = this.spec;
    if (spec.stamp.sha256 !== commandHash(o.target, spec) || spec.stamp.taskId !== spec.taskId) {
      return this.end(this.failed("Ember lost track of this command, so it wasn't sent"));
    }
    // Text that isn't whole Unicode reaches the remote as other bytes than the card showed (and than the hash covered).
    if (LONE_SURROGATE.test(spec.command) || LONE_SURROGATE.test(spec.cwd)) return this.end(this.failed(`The command can't be sent to ${o.label} exactly as shown`));
    if (link.state === "lost" || link.state === "closed") return this.lose();
    const args = { epoch: link.epoch, spec };
    if (!OP_SCHEMAS["cmd.run"].args.safeParse(args).success) return this.end(this.failed(`The command can't be sent to ${o.label} as it is`));
    askRemote(link, "cmd.run", args, { label: o.label }).then(a => this.answered(a), (err: unknown) => this.notStarted(err));
  }

  private answered(a: OpResult<"cmd.run">): void {
    const { link, o } = this.ctx;
    if (this.state !== "starting") {
      // Ended here (the link went, or the parts were dropped) while the agent started it: tell it to stop.
      if (a.status === "started") void askRemote(link, "cmd.stop", { runId: this.runId, why: "task" }, { label: o.label, whileStalled: true }).catch(() => undefined);
      return;
    }
    if (a.status !== "started") {
      const said = remoteWords(a.reason, 500);
      if (a.status === "deny") {
        const words = refusalOf(typeof a.reason === "string" ? a.reason : "", o.label);
        return this.end({ ...this.base("refused-remote"), ...(words ? { error: words } : {}) });
      }
      // Gate 2 found more than the PC did (critique security-3): the flow asks once, with the remote's own lines.
      const extra = (a.rules ?? []).filter(r => !this.spec.stamp.rules.includes(r));
      const says = (a.says ?? []).map(s => cleanRemote(s, 500)).filter(Boolean).slice(0, SAYS_MAX);
      return this.end({ ...this.base("refused-remote"), error: `${o.label}'s own check wants the user's yes first${said ? `: ${said}` : ""}`, needsConfirm: true, remoteSays: says, rules: extra });
    }
    if (this.ctx.channelTaken(a.channel, this)) {
      // Two runs on one channel would mix their output: this one is stopped there and ends here.
      void askRemote(link, "cmd.stop", { runId: this.runId, why: "task" }, { label: o.label, whileStalled: true }).catch(() => undefined);
      return this.end(this.failed(unchecked(o.label).replace(/\.$/, "")));
    }
    this.state = "running";
    this.channel = a.channel;
    this.answeredInteractive = a.interactive;
    this.tracker = this.trackerFor(a.interactive);
    const off = link.onBytes(a.channel, b => this.bytes(b));
    if (this.state !== "running") {
      // The bytes the link held for the channel ended the run while subscribing (its exit had come first): unsubscribe.
      try { off(); } catch { /* gone with the link */ }
      return;
    }
    this.offBytes = off;
    // The agent ends a run at its time limit (§3.13); one it lets run on is stopped from here.
    if (Number.isFinite(this.spec.timeoutMs) && this.spec.timeoutMs > 0) {
      this.deadline = this.later(() => {
        this.deadline = null;
        if (this.state !== "running") return;
        o.log.warn("remote.cmd_overdue", { runId: this.runId });
        this.stop("timeout");
      }, this.spec.timeoutMs + OVERDUE_MS);
    }
    if (this.stopWhy) this.sendStop();
    const queued = this.queued;
    this.queued = [];
    this.queuedBytes = 0;
    if (a.interactive) for (const q of queued) this.send(q);
    if (this.exitEvent) this.exited(this.exitEvent);
  }

  private notStarted(err: unknown): void {
    if (this.state !== "starting") return;
    const { link, o } = this.ctx;
    if (link.state === "lost" || link.state === "closed") return this.lose();
    // Unless the agent's own answer said it didn't start the run (refused, wanted a yes, was stopped), it may have
    // started it, or may yet (gate 2 still checking when the PC stopped waiting; the answer then goes nowhere): it is
    // told to stop that run, which it then never starts, so nothing runs there without a tab and a Stop.
    const agentSaidNo = err instanceof RemoteStepError && (err.code === "deny" || err.code === "needs_confirm" || err.code === "stopped");
    if (!agentSaidNo && !this.stopSent) {
      this.stopSent = true;
      askRemote(link, "cmd.stop", { runId: this.runId, why: "task" }, { label: o.label, whileStalled: true }).catch(() => undefined);
    }
    if (err instanceof RemoteStepError) {
      switch (err.code) {
        // linkFailure's sentence, with the remote's own words quoted in it.
        case "deny": {
          const words = refusalIn(err.message, o.label);
          return this.end({ ...this.base("refused-remote"), ...(words ? { error: words } : {}) });
        }
        case "needs_confirm": return this.end({ ...this.base("refused-remote"), error: `${o.label}'s own check wants the user's yes first`, needsConfirm: true, remoteSays: [], rules: [] });
        case "stopped": return this.end(this.failed("It was stopped before it started"));
        default: return this.end(this.failed(`${o.label} didn't answer in time, so the command wasn't started`));
      }
    }
    if (err instanceof RemoteError && err.remoteCode === "link") return this.end(this.failed(`${o.label} didn't answer in time, so the command wasn't started`));
    if (err instanceof RemoteError && err.remoteCode === "unchecked") return this.end(this.failed(unchecked(o.label).replace(/\.$/, "")));
    // linkFailure's sentences already quote the remote's words; anything else is quoted here.
    const said = err instanceof RemoteError ? cleanRemote(err.message, 600) : err instanceof Error ? remoteWords(err.message, 300) : "";
    this.end(this.failed(said ? `${o.label} couldn't start it: ${said}` : `${o.label} couldn't start it`));
  }

  private trackerFor(interactive: boolean): SecretTracker {
    try {
      return (this.ctx.o.trackSecrets ?? trackSecretPrompts)({ interactive });
    } catch {
      // A tracker that can't be made: CL's own keeps prompts out all the same.
      return trackSecretPrompts({ interactive });
    }
  }

  private bytes(b: Uint8Array): void {
    if (this.state !== "running") return;
    this.received += b.length;
    const text = this.decoder.decode(b, { stream: true });
    if (text) this.track(text);
    for (const fn of [...this.listeners]) {
      try {
        fn(b);
      } catch (err) {
        this.ctx.o.log.warn("remote.cmd_output_listener_failed", { runId: this.runId, err: err instanceof Error ? err.name : "error" });
      }
    }
    if (!this.exitEvent) return;
    if (this.received >= this.exitEvent.outBytes) return this.finishExit();
    // Still coming: the wait for the rest starts again from this chunk, within the tail's own limit.
    if (this.ctx.now() - this.exitAt < TAIL_MAX_MS) {
      this.clearTimer();
      this.timer = this.later(() => this.finishExit(), TAIL_MS);
    }
  }

  private track(text: string): void {
    try {
      this.tracker?.output(text);
    } catch {
      // the tracker's failure leaves its spans as they are
    }
  }

  /** The agent's word that the run ended: once its last bytes are in (or a moment later), the run ends here too. */
  exited(d: EvMap["cmd.exit"]): void {
    if (this.state === "ended") return;
    this.exitEvent = d;
    if (this.state === "starting") return; // ended before its answer came: taken up when it does
    this.exitAt = this.ctx.now();
    if (this.received >= d.outBytes) return this.finishExit();
    this.clearTimer();
    this.timer = this.later(() => this.finishExit(), TAIL_MS);
  }

  private finishExit(): void {
    const d = this.exitEvent;
    if (!d || this.state === "ended") return;
    const e = d.exit;
    const { label } = this.ctx.o;
    // An event never carries a refusal or a question (those come only from the answer to cmd.run).
    let ended: RunExit["ended"] = e.ended === "refused-remote" ? "failed-to-start" : e.ended;
    // The kill switch's Stop goes out as the user's: the run ended as the kill switch ended it.
    if (this.stopWhy && STOP_ENDINGS.has(ended)) ended = ENDED_BY[this.stopWhy];
    const said = e.error ? remoteWords(e.error, 300) : "";
    const error = ended === "failed-to-start" ? (said ? `${label} said ${said}` : `${label} couldn't start it`) : said ? `${label} said ${said}` : undefined;
    this.end({ code: e.code, signal: e.signal, ended, ms: this.elapsed(), ...(error ? { error } : {}) });
  }

  /** Ends the run before anything was sent, saying why. */
  refuse(error: string): void {
    if (this.state === "starting") this.end(this.failed(error));
  }

  /** The parts that own this run are going: the agent is told to stop it (if it can still hear), and it ends here as lost. */
  abandon(): void {
    if (this.state === "running" && !this.stopSent) {
      const { link, o } = this.ctx;
      this.stopSent = true;
      askRemote(link, "cmd.stop", { runId: this.runId, why: "task" }, { label: o.label, whileStalled: true }).catch(() => undefined);
    }
    this.lose();
  }

  /** The link went: the run is lost here (the remote ends it within its grace, L10). */
  lose(): void {
    this.end(this.base("lost"));
  }

  private end(exit: RemoteRunExit): void {
    if (this.state === "ended") return;
    const wasRunning = this.state === "running";
    this.state = "ended";
    this.clearTimer();
    if (this.deadline) this.ctx.timers.clearTimeout(this.deadline);
    this.deadline = null;
    if (wasRunning) {
      const rest = this.decoder.decode();
      if (rest) this.track(rest);
    }
    try {
      this.offBytes?.();
    } catch {
      // already gone with the link
    }
    this.offBytes = null;
    this.queued = [];
    this.queuedBytes = 0;
    this.listeners.clear();
    this.ctx.ended(this);
    this.resolveDone(exit);
  }

  onOutput(fn: (chunk: Uint8Array) => void): () => void {
    if (this.state === "ended") return () => undefined;
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  input(bytes: Uint8Array): void {
    if (this.state === "ended" || !bytes.length || !this.interactive) return;
    if (this.state === "starting") {
      if (this.queuedBytes + bytes.length > QUEUE_MAX) return;
      this.queued.push(bytes.slice());
      this.queuedBytes += bytes.length;
    } else {
      this.send(bytes);
    }
    this.noteTyping(this.inputDecoder.decode(bytes, { stream: true }));
  }

  /** The user's bytes to the run, 4 KiB a message, in order (the link keeps its requests in order). Never logged. */
  private send(bytes: Uint8Array): void {
    const { link, o } = this.ctx;
    for (let at = 0; at < bytes.length; at += INPUT_CHUNK) {
      const data = Buffer.from(bytes.subarray(at, at + INPUT_CHUNK)).toString("base64");
      askRemote(link, "cmd.input", { runId: this.runId, data }, { label: o.label }).catch((err: unknown) => {
        o.log.warn("remote.cmd_input_failed", { runId: this.runId, err: err instanceof Error ? err.name : "error" });
      });
    }
  }

  /** Line editing as a terminal does it, enough to know the lines typed (L2); terminal sequences aren't text. */
  private noteTyping(text: string): void {
    for (const ch of text) {
      if (this.esc) {
        if (this.esc === "esc") this.esc = ch === "[" ? "csi" : ch === "]" ? "osc" : ch === "O" ? "ss3" : "";
        else if (this.esc === "csi") { if (ch >= "@" && ch <= "~") this.esc = ""; }
        else if (this.esc === "ss3") this.esc = "";
        else if (this.esc === "osc") { if (ch === "\x07") this.esc = ""; else if (ch === "\x1b") this.esc = "osc-esc"; }
        else this.esc = "";
        continue;
      }
      const cr = this.lastWasCr;
      this.lastWasCr = ch === "\r";
      if (ch === "\x1b") this.esc = "esc";
      else if (ch === "\r" || ch === "\n") {
        if (ch === "\n" && cr) continue; // \r\n is one Enter
        if (this.line !== "") {
          this.typed.push(this.line);
          if (this.typed.length > MAX_TYPED_LINES) this.typed.shift();
        }
        this.line = "";
        try {
          this.tracker?.enter();
        } catch {
          // the tracker's failure leaves its spans as they are
        }
      } else if (ch === "\x7f" || ch === "\b") this.line = [...this.line].slice(0, -1).join("");
      else if (ch === "\x15" || ch === "\x03") this.line = "";
      else if (ch >= " " && this.line.length < MAX_TYPED_LINE) this.line += ch;
    }
  }

  typedLines(): string[] {
    return this.line !== "" ? [...this.typed, this.line] : [...this.typed];
  }

  forgetTyped(): void {
    this.typed = [];
    this.line = "";
  }

  secretSpans(): { from: number; to: number }[] {
    try {
      return this.tracker?.spans() ?? [];
    } catch {
      return []; // the tracker failed: nothing it marked can be named
    }
  }

  stop(why: StopWhy): void {
    if (this.state === "ended") return;
    this.stopWhy ??= why;
    // A run still starting is stopped as soon as the agent says it started (answered()).
    if (this.state === "running") this.sendStop();
  }

  private sendStop(): void {
    if (this.stopSent || !this.stopWhy) return;
    this.stopSent = true;
    const { link, o } = this.ctx;
    const why = this.stopWhy;
    askRemote(link, "cmd.stop", { runId: this.runId, why: WIRE_WHY[why] }, { label: o.label, whileStalled: true }).catch((err: unknown) => {
      o.log.warn("remote.cmd_stop_failed", { runId: this.runId, err: err instanceof Error ? err.name : "error" });
    });
    // The agent says when it ended (its ladder takes 1.5 s); one that never does doesn't hold the run open here.
    if (!this.timer) {
      this.timer = this.later(() => {
        this.timer = null;
        if (this.state === "ended") return;
        o.log.warn("remote.cmd_stop_unconfirmed", { runId: this.runId });
        if (link.state !== "ready") return this.lose();
        this.end({ ...this.base(ENDED_BY[why]), error: `${o.label} didn't say the command stopped` });
      }, STOP_WAIT_MS);
    }
  }

  private later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const rtt = Number.isFinite(this.ctx.link.rttMs) && this.ctx.link.rttMs > 0 ? Math.min(this.ctx.link.rttMs, 60_000) : 0;
    const t = this.ctx.timers.setTimeout(fn, ms + rtt);
    (t as { unref?: () => void }).unref?.();
    return t;
  }

  private clearTimer(): void {
    if (this.timer) this.ctx.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private elapsed(): number {
    return Math.max(0, Math.round(this.ctx.now() - this.startedAt));
  }

  private base(ended: RunExit["ended"]): RemoteRunExit {
    return { code: null, signal: null, ended, ms: this.elapsed() };
  }

  private failed(error: string): RemoteRunExit {
    return { ...this.base("failed-to-start"), error };
  }
}

/** A remote's commands as a CommandRunner (§5.5). */
export function createRemoteRunner(link: RemoteLink, o: RemoteRunnerOptions): RemoteRunner {
  const now = o.now ?? (() => performance.now());
  const timers = o.timers ?? { setTimeout, clearTimeout };
  const runs = new Map<string, RemoteRun>();
  let facts = o.facts;
  const pathOf = o.os === "win32" ? win32 : posix;
  const absolute = (p: string) => pathOf.isAbsolute(p);

  const ctx: RunContext = {
    link, o, now, timers,
    // A PTY where the remote has `script` (§3.3): runs there take typing, until the agent says otherwise.
    pty: () => facts.pty && facts.os !== "win32",
    channelTaken: (channel, run) => [...runs.values()].some(r => r !== run && r.channel === channel),
    ended: run => { if (runs.get(run.runId) === run) runs.delete(run.runId); },
  };

  const offExit = link.on("cmd.exit", d => {
    const checked = EV_SCHEMAS["cmd.exit"].safeParse(d);
    if (!checked.success) return o.log.warn("remote.cmd_exit_unchecked", {});
    runs.get(checked.data.runId)?.exited(checked.data);
  });
  // The stalled link's countdown on every running command's tab (§8.5): the agent ends its commands at the grace.
  let statusText: string | null = null;
  const statusFns = new Set<(text: string | null) => void>();
  let countdown: ReturnType<typeof setTimeout> | null = null;
  const setStatus = (text: string | null) => {
    if (text === statusText) return;
    statusText = text;
    for (const fn of [...statusFns]) {
      try { fn(text); } catch { /* a listener's failure leaves the others told */ }
    }
  };
  const stopCountdown = () => {
    if (countdown) timers.clearTimeout(countdown);
    countdown = null;
    setStatus(null);
  };
  const startCountdown = () => {
    if (countdown) return;
    const grace = Number.isFinite(link.welcome?.graceSeconds) ? link.welcome.graceSeconds : 20;
    const ends = now() + Math.max(0, grace - STALL_S) * 1000;
    const step = () => {
      const left = Math.max(0, (ends - now()) / 1000);
      setStatus(stalledText(o.label, left));
      countdown = left > 0 ? timers.setTimeout(step, Math.min(1000, Math.ceil(left * 1000))) : null;
      (countdown as { unref?: () => void } | null)?.unref?.();
    };
    step();
  };
  const offState = link.onState(s => {
    if (s === "stalled") startCountdown();
    else stopCountdown();
    if (s === "lost" || s === "closed") for (const r of [...runs.values()]) r.lose();
  });

  return {
    target: o.target,

    async facts(): Promise<RunnerFacts> {
      const f = await askRemote(link, "cmd.facts", {}, { label: o.label });
      if (f.os !== o.os || !absolute(f.home)) throw new RemoteError("unchecked", unchecked(o.label));
      facts = f;
      return f;
    },

    async inspect(paths: string[], cwd: string): Promise<PathFact[]> {
      const none = (): PathFact[] => paths.map(() => ({ exists: null, real: null }));
      if (!paths.length) return [];
      if (paths.length > 64) return none();
      try {
        const r = await askRemote(link, "cmd.inspect", { paths, cwd }, { label: o.label });
        if (r.paths.length !== paths.length) return none();
        // A real path that isn't absolute on the remote can't be told: as unknown.
        return r.paths.map(p => (p.real !== null && !absolute(p.real) ? { exists: p.exists, real: null } : p));
      } catch {
        return none();
      }
    },

    async gitFacts(cwd: string): Promise<GitFacts | null> {
      try {
        return (await askRemote(link, "cmd.git", { cwd }, { label: o.label })).git;
      } catch {
        return null;
      }
    },

    start(spec: RunSpec): RemoteRunningCommand {
      const run = new RemoteRun(spec, ctx);
      const live = runs.get(spec.runId);
      if (live && !live.ended) {
        // One id, one run: a second start of it is never sent.
        run.refuse("A command with this run id is already running");
        return run;
      }
      runs.set(spec.runId, run);
      run.begin();
      return run;
    },

    async stopAll(why: "killswitch" | "quit"): Promise<void> {
      for (const r of [...runs.values()]) r.stop(why === "killswitch" ? "killswitch" : "task");
    },

    get running(): number {
      return runs.size;
    },

    dispose(): void {
      offExit();
      offState();
      stopCountdown();
      for (const r of [...runs.values()]) r.abandon();
    },

    status: () => statusText,

    onStatus(fn) {
      statusFns.add(fn);
      return () => { statusFns.delete(fn); };
    },
  };
}
