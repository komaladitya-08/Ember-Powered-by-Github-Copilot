/**
 * The PC ⇄ remote agent protocol: messages inside the framed SSH stdio (mux.ts). Every message is validated with the
 * strict zod schema of its op or event, on both ends; anything else resets the link. The PC sends requests; the agent
 * answers them and sends events. The agent never sends a request, so nothing it says can make the PC do anything
 * but display data, stop, or mark the link lost.
 */

import { z } from "zod";
import type { OS } from "../../shared/shortcuts";
import type { AdminSummary } from "../admin";
import type { Seen, WindowTarget } from "../perception";
import type { ActionResult, AxWindow, Bounds, CanDo, ElementInfo, PointElement } from "../perception/sidecar";
import type { ActStamp } from "../perception/ports";
import type { ActionKind, TextMode } from "../policy/policy";
import type { DangerClass, GitFacts, PathFact, RunExit, RunnerFacts, RunSpec, ShellId } from "../commands/types";
import type { DesktopAccess } from "../targets/types";

export const PROTO = 1;

export type Msg =
  | { t: "req"; id: number; op: Op; a: unknown }
  | { t: "res"; id: number; ok: true; v: unknown }
  | { t: "res"; id: number; ok: false; e: { code: ErrCode; m: string } }
  | { t: "ev"; ev: EvName; d: unknown };

export type ErrCode = "bad_request" | "unknown_op" | "not_ready" | "denied" | "needs_confirm" | "changed" | "stale"
  | "stopped" | "busy" | "gone" | "too_large" | "internal";

export type Op =
  | "hello" | "policy.sync" | "desktop.state"
  | "perceive.read" | "perceive.focused" | "perceive.perceive" | "perceive.atPoint" | "perceive.windows"
  | "perceive.openWindows" | "perceive.systemDialog"
  | "ax.readElement" | "ax.canDo" | "ax.listOptions"
  | "act" | "apps.list" | "apps.launch"
  | "cmd.facts" | "cmd.inspect" | "cmd.git" | "cmd.run" | "cmd.input" | "cmd.stop"
  | "stop" | "audit.recent" | "bye";

export type EvName = "desktop.changed" | "cmd.exit" | "console.stop" | "policy.changed" | "notice" | "log";

export interface Hello {
  proto: 1;
  partsId: string;
  /** The PC's name as the remote's audit records it (os.hostname(), ≤ 64 chars; unverified there). */
  local: { name: string; os: OS };
  /** This Ember install's id (§5.1.13): 32 hex digits; the agent checks it equals the one on its argv. */
  pcId: string;
  /** The per-host consent the user gave on the PC. */
  consent: { version: number; at: string };
  /** The never-look list in force on the PC (the user's and the PC admin's); the agent adds its own admin's. */
  neverLook: string[];
  localAdmin: AdminSummary;
  epoch: number;
}

export interface Welcome {
  proto: 1;
  partsId: string;
  os: "linux" | "darwin" | "win32";
  arch: "x64" | "arm64";
  machineIdHash: string;
  isWsl: boolean;
  uid: number;
  user: string;
  home: string;
  facts: RunnerFacts;
  desktop: DesktopState;
  remoteAdmin: AdminSummary;
  pid: number;
  /** The macOS "full disk access for remote users" check failed (protected folders unreadable to commands, L6). */
  tccLimited?: boolean;
  /** The command grace this agent applies (s): the smaller of both machines' ssh.commandGraceSeconds (L10). */
  graceSeconds: number;
}

export interface DesktopState {
  access: DesktopAccess;
  why?: string;
  session?: { type: "x11" | "wayland"; locked: boolean; active: boolean };
  notice: "shown" | "failed" | "off";
}

/** Seen (perception/index.ts) as plain data: every field as there, validated with CAPS. */
export type SeenWire = Seen;

/** A screenshot's bytes travel on a bulk channel before its answer; the answer says where and what. */
export interface ImageRef { channel: number; bytes: number; sha256: string; width: number; height: number; rect: Bounds; scale: number; mime: "image/png" }

/** A remote app as the PC judges it: argv and Terminal= come from its .desktop file, so gate 1 follows wrappers like gate 2 (critique integration-7). */
export interface RemoteApp { id: string; name: string; keywords?: string[]; categories?: string[]; argv?: string[]; terminal?: boolean }

export type ActOp =
  | { op: "do_action"; id: number; action: string }
  | { op: "set_text"; id: number; text: string; mode: TextMode }
  | { op: "set_value"; id: number; value: number }
  | { op: "select_option"; id: number; option: string };

export type GateAnswer =
  | { status: "ok" }
  | { status: "deny" | "needs_confirm"; reason: string }
  | { status: "changed" | "stale" | "stopped" };

/** Each op's arguments and result. */
export interface OpMap {
  "hello": [Hello, Welcome];
  "policy.sync": [{ neverLook: string[]; localAdmin: AdminSummary }, Record<string, never>];
  "desktop.state": [Record<string, never>, DesktopState];
  "perceive.read": [{ target: WindowTarget; keep?: boolean; cells?: string[] }, SeenWire];
  "perceive.focused": [Record<string, never>, SeenWire];
  "perceive.perceive": [{ image: boolean; scope: "window" | "screen"; target?: WindowTarget }, { seen: SeenWire; image: ImageRef | null; noShot?: string }];
  "perceive.atPoint": [{ target: WindowTarget; x: number; y: number; k: number }, { chain: PointElement[] | null }];
  "perceive.windows": [Record<string, never>, { windows: AxWindow[] }];
  "perceive.openWindows": [Record<string, never>, { lines: { app: string; title: string; active: boolean; busy?: boolean }[] }];
  "perceive.systemDialog": [Record<string, never>, { open: boolean }];
  "ax.readElement": [{ id: number; shown?: boolean; formula?: boolean }, ElementInfo];
  "ax.canDo": [{ id: number; kind: "click" | "toggle" | "text" | "value"; caret: boolean }, CanDo];
  "ax.listOptions": [{ id: number }, { options: string[]; left?: number }];
  "act": [{ opId: string; epoch: number; stamp: ActStamp } & ActOp, GateAnswer & { result?: ActionResult }];
  "apps.list": [Record<string, never>, { apps: RemoteApp[] }];
  "apps.launch": [{ epoch: number; appId: string; stamp: ActStamp }, GateAnswer & { pid?: number }];
  "cmd.facts": [Record<string, never>, RunnerFacts];
  "cmd.inspect": [{ paths: string[]; cwd: string }, { paths: PathFact[] }];
  "cmd.git": [{ cwd: string }, { git: GitFacts | null }];
  "cmd.run": [{ epoch: number; spec: RunSpec }, { status: "started"; channel: number; interactive: boolean } | { status: "deny" | "needs_confirm"; reason: string; says?: string[]; rules?: string[] }];
  "cmd.input": [{ runId: string; data: string /* base64, ≤ 4 KiB decoded; never logged */ }, Record<string, never>];
  "cmd.stop": [{ runId: string; why: "user" | "task" | "timeout" }, Record<string, never>];
  "stop": [{ epoch: number }, { ms: number; late: string[] }];
  "audit.recent": [{ limit: number }, { entries: Record<string, unknown>[] }];
  "bye": [Record<string, never>, Record<string, never>];
}

export interface EvMap {
  "desktop.changed": DesktopState;
  "cmd.exit": { runId: string; exit: RunExit; outBytes: number };
  "console.stop": { at: string };
  "policy.changed": AdminSummary;
  "notice": { state: "shown" | "failed" | "off" };
  "log": { level: "debug" | "info" | "warn" | "error"; event: string };
}

export type OpArgs<O extends Op> = OpMap[O][0];
export type OpResult<O extends Op> = OpMap[O][1];

export const CAPS = {
  ctlBytes: 64 * 1024, dataMessageBytes: 4 * 1024 * 1024, frameBytes: 1024 * 1024, chunkBytes: 32 * 1024,
  str: { app: 200, title: 1000, name: 1000, role: 64, state: 32, text: 4000, reason: 500, path: 4096, command: 8000 },
  nodes: 2000, states: 40, windows: 200, chain: 50, options: 500, lines: 200, paths: 64, neverLook: 300,
  image: { bytes: 8 * 1024 * 1024, side: 4096 }, coord: 100_000, auditEntries: 200,
} as const;

/** Every error code a `res` may carry (ErrCode as data, for the mux's envelope check). */
export const ERR_CODES = ["bad_request", "unknown_op", "not_ready", "denied", "needs_confirm", "changed", "stale", "stopped", "busy", "gone", "too_large", "internal"] as const satisfies readonly ErrCode[];

// ---------------------------------------------------------------------------------------------------------------------
// The building blocks. Every string has a cap, every number is finite (zod rejects Infinity and NaN), every object is
// strict (an unknown key is a protocol error), and every list has a length cap.

/** A string of at most `max` characters. */
const str = (max: number) => z.string().max(max);
/** No control characters (names and paths shown to the user or passed to a program). */
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/; // eslint-disable-line no-control-regex -- control characters are exactly what's refused here
/** A string of at most `max` characters with no control characters. */
const plain = (max: number) => z.string().max(max).regex(NO_CONTROL);
/** A whole number from `min` to `max` (safe integers only). */
const int = (min = 0, max = Number.MAX_SAFE_INTEGER) => z.number().int().min(min).max(max);
/** A position or size on a screen (any unit), inside ±CAPS.coord. */
const coord = z.number().min(-CAPS.coord).max(CAPS.coord);
/** Milliseconds measured somewhere (never negative). */
const ms = z.number().min(0).max(Number.MAX_SAFE_INTEGER);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
/** A run's id: 16 lower-case hex digits (RunSpec.runId). */
const runId = z.string().regex(/^[0-9a-f]{16}$/);
/** A task's id as the PC's TaskManager makes it ("3-1a2b3c4d"). */
const taskId = plain(100);
const path = plain(CAPS.str.path);
/** What the parts are: Ember's version and a hash of the parts' manifests ("0.1.0-0123456789ab"). */
const partsId = z.string().regex(/^[A-Za-z0-9._+-]{1,80}$/);
/** A request or stop epoch (§5.1.11). */
const epoch = int();
/** An element id the remote's reader gave out. */
const elementId = int();
/** The empty object: no key at all. */
const EMPTY = z.record(z.string(), z.never());
/** The text the worker may type in one set_text step (its tool's own limit, worker.ts). */
const TYPED_TEXT_MAX = 5000;
/** How many apps a remote may list (a desktop's .desktop files; the element cap is the nearest bound). */
const APPS_MAX = CAPS.nodes;

/** A z.enum over every member of a string union, checked exhaustive by `satisfies Record<T, true>` at each use. */
const members = <T extends string>(all: Record<T, true>) => z.enum(Object.keys(all) as [T, ...T[]]);

const OS_ENUM = members<OS>({ linux: true, win32: true, darwin: true });
const SHELL = members<ShellId>({ bash: true, zsh: true, sh: true, powershell: true, cmd: true });
const DANGER = members<DangerClass>({ destroy: true, publish: true, "remote-delete": true, secret: true, system: true, escape: true, unclear: true });
const ACTION_KIND = members<ActionKind>({
  read: true, click: true, toggle: true, text: true, select: true, value: true, setting: true, open_app: true,
  cursor_click: true, cursor_text: true, keys: true, scroll: true,
});
const TEXT_MODE = members<TextMode>({ replace: true, insert: true, append: true });
const DESKTOP_ACCESS = members<DesktopAccess>({ screen: true, text: true, none: true });
const ENDED = members<RunExit["ended"]>({
  exit: true, "stopped-user": true, "stopped-task": true, killswitch: true, timeout: true, lost: true, "failed-to-start": true, "refused-remote": true,
});
const MODE = members<AdminSummary["commands"]["local"]>({ on: true, ask: true, off: true });

const BoundsSchema = z.object({ x: coord, y: coord, width: coord, height: coord }).strict();

const AxNodeSchema = z.object({
  id: elementId,
  parent: elementId.nullable(),
  depth: int(0, 10_000),
  role: str(CAPS.str.role),
  name: str(CAPS.str.name),
  states: z.array(str(CAPS.str.state)).max(CAPS.states),
  bounds: BoundsSchema.nullable(),
  actions: z.array(str(CAPS.str.app)).max(CAPS.states).optional(),
  text: str(CAPS.str.text).optional(),
  selection: str(CAPS.str.text).optional(),
  selected: str(CAPS.str.name).optional(),
  value: z.number().optional(),
  editable: z.boolean().optional(),
  secret: z.boolean().optional(),
  withheld: z.boolean().optional(),
  shown: BoundsSchema.optional(),
  grid: z.boolean().optional(),
  size: z.object({ rows: int(0, 2 ** 31), columns: int(0, 2 ** 31) }).strict().optional(),
}).strict();

const AxWindowSchema = z.object({
  app: str(CAPS.str.app),
  pid: int().nullable(),
  path: str(CAPS.str.path).optional(),
  name: str(CAPS.str.title),
  role: str(CAPS.str.role),
  active: z.boolean(),
  bounds: BoundsSchema.nullable(),
  busy: z.boolean().optional(),
}).strict();

const X11WindowSchema = z.object({
  id: int(),
  pid: int().nullable(),
  title: str(CAPS.str.title),
  x: coord, y: coord, width: coord, height: coord,
  wmClass: str(CAPS.str.app).optional(),
}).strict();

const OtherWindowSchema = z.object({ name: str(CAPS.str.title), role: str(CAPS.str.role), active: z.boolean(), modal: z.boolean() }).strict();

const SeenSchema = z.object({
  window: AxWindowSchema.nullable(),
  x11Window: X11WindowSchema.nullable(),
  nodes: z.array(AxNodeSchema).max(CAPS.nodes),
  blocked: z.boolean(),
  busy: z.boolean(),
  truncated: z.enum(["nodes", "time", "depth"]).nullable(),
  others: z.array(OtherWindowSchema).max(CAPS.windows),
  ms,
  axScale: z.number().gt(0).max(16),
  ember: z.boolean().optional(),
}).strict();

const WindowTargetSchema = z.object({ pid: int().optional(), title: str(CAPS.str.title).optional(), path: str(CAPS.str.path).optional() }).strict();

const PointElementSchema = z.object({
  role: str(CAPS.str.role), name: str(CAPS.str.name), bounds: BoundsSchema.nullable(), secret: z.boolean().optional(), empty: z.boolean().optional(),
}).strict();

const ElementInfoSchema = z.object({
  role: str(CAPS.str.role),
  name: str(CAPS.str.name),
  states: z.array(str(CAPS.str.state)).max(CAPS.states),
  bounds: BoundsSchema.nullable(),
  text: str(CAPS.str.text).optional(),
  value: z.number().optional(),
  selected: str(CAPS.str.name).optional(),
  secret: z.boolean().optional(),
  withheld: z.boolean().optional(),
  shown: BoundsSchema.optional(),
  open: z.boolean().optional(),
  offscreen: z.boolean().optional(),
  formula: str(CAPS.str.text).optional(),
}).strict();

const CanDoSchema = z.object({
  tier1: z.boolean(),
  why: str(CAPS.str.reason).optional(),
  focused: z.boolean().optional(),
  windowActive: z.boolean().optional(),
  action: str(CAPS.str.app).optional(),
  handler: z.object({ role: str(CAPS.str.role), name: str(CAPS.str.name) }).strict().optional(),
  handlerUnknown: z.boolean().optional(),
}).strict();

const ActionResultSchema = z.object({
  ok: z.boolean(),
  action: str(CAPS.str.app).optional(),
  option: str(CAPS.str.name).optional(),
  before: ElementInfoSchema.optional(),
  after: ElementInfoSchema.nullable(),
  gone: z.boolean().optional(),
  busy: z.boolean().optional(),
  unchecked: int().optional(),
}).strict();

const ActStampSchema = z.object({
  taskId,
  kind: ACTION_KIND,
  app: str(CAPS.str.app),
  window: str(CAPS.str.title),
  element: z.object({ role: str(CAPS.str.role), name: str(CAPS.str.name) }).strict().nullable(),
  valueSha256: sha256Hex.optional(),
  verdict: z.enum(["allow", "confirm"]),
  approval: z.object({ given: z.literal(true) }).strict().nullable(),
  ageMs: ms,
}).strict();

const AdminSummarySchema = z.object({
  source: path.nullable(),
  error: str(CAPS.str.text).optional(),
  features: z.object({
    actions: z.boolean().optional(), cursor: z.boolean().optional(), desk: z.boolean().optional(), screenImages: z.boolean().optional(),
    wsl: z.boolean().optional(), ssh: z.boolean().optional(), voice: z.boolean().optional(), speak: z.boolean().optional(),
  }).strict(),
  neverLook: z.array(str(CAPS.str.app)).max(CAPS.neverLook),
  confirmEveryAction: z.boolean(),
  allowGrants: z.boolean(),
  maxActionsPerMinute: int(1, 40).optional(),
  commands: z.object({ local: MODE, wsl: MODE, ssh: MODE }).strict(),
  ssh: z.object({
    desktop: z.boolean().optional(),
    requireConsoleConsent: z.boolean().optional(),
    allowedHosts: z.array(plain(255)).max(200).optional(),
    commandGraceSeconds: int(3, 120).optional(),
  }).strict(),
  models: z.object({ allowed: z.array(plain(100)).max(200).optional() }).strict(),
  provider: z.boolean(),
}).strict();

const DesktopStateSchema = z.object({
  access: DESKTOP_ACCESS,
  why: str(CAPS.str.reason).optional(),
  session: z.object({ type: z.enum(["x11", "wayland"]), locked: z.boolean(), active: z.boolean() }).strict().optional(),
  notice: z.enum(["shown", "failed", "off"]),
}).strict();

// RunnerFacts.ember.names is a RegExp, which JSON can't carry, and a regular expression from a remote must never be
// compiled on the PC (one that backtracks for ever would hang Ember). So it crosses the link as a list of literal
// process names and is rebuilt from them, escaped, on arrival. The sender's RegExp must be one emberNamesRegExp made.

/** A process name Ember's own helpers go by on a target ("ember-remote", "ember_atspi.py"). */
const EMBER_NAME = /^[A-Za-z0-9._+ -]{1,64}$/;
const EMBER_NAMES_MAX = 32;
/** The source emberNamesRegExp writes: ^(?:a|b)$ of escaped literals, or (?!) for none. */
const NAMES_SOURCE = /^\^\(\?:((?:[A-Za-z0-9_ -]|\\[.+])+(?:\|(?:[A-Za-z0-9_ -]|\\[.+])+)*)\)\$$/;

/**
 * A RegExp matching exactly these process names, case-insensitively, that serialises to JSON as `{ names }` (so
 * RunnerFacts.ember.names crosses the link as data, never as a pattern). Throws on a name outside EMBER_NAME.
 */
export function emberNamesRegExp(names: readonly string[]): RegExp {
  if (names.length > EMBER_NAMES_MAX) throw new Error(`too many process names (${names.length})`);
  for (const n of names) if (typeof n !== "string" || !EMBER_NAME.test(n)) throw new Error(`not a process name: ${JSON.stringify(n)}`);
  const re = names.length ? new RegExp(`^(?:${names.map(n => n.replace(/[.+]/g, "\\$&")).join("|")})$`, "i") : /(?!)/i;
  const list = [...names];
  Object.defineProperty(re, "toJSON", { value: () => ({ names: list }), enumerable: false });
  return re;
}

/** The names an emberNamesRegExp matches (null for any other RegExp: it can't cross the link). */
function namesOf(re: RegExp): string[] | null {
  if (re.flags !== "i") return null;
  if (re.source === "(?!)") return [];
  const m = NAMES_SOURCE.exec(re.source);
  return m ? m[1].split("|").map(n => n.replace(/\\([.+])/g, "$1")) : null;
}

const EmberNamesSchema = z.union([
  // In this process (a sender checking its own message, or after a worker thread's structured clone).
  z.instanceof(RegExp).transform((re, ctx) => {
    const names = namesOf(re);
    if (!names || names.length > EMBER_NAMES_MAX || !names.every(n => EMBER_NAME.test(n))) {
      ctx.issues.push({ code: "custom", message: "ember.names must be made by emberNamesRegExp", input: re });
      return z.NEVER;
    }
    return emberNamesRegExp(names);
  }),
  // From the wire.
  z.object({ names: z.array(z.string().regex(EMBER_NAME)).max(EMBER_NAMES_MAX) }).strict().transform(o => emberNamesRegExp(o.names)),
]);

const WindowsContextSchema = z.object({
  home: path, localAppData: path, appData: path, temp: path, systemRoot: path,
  emberPaths: z.array(path).max(CAPS.paths),
}).strict();

const RunnerFactsSchema = z.object({
  os: OS_ENUM,
  shells: z.array(SHELL).max(5),
  shellPaths: z.partialRecord(SHELL, path),
  script: z.object({ path, kind: z.enum(["util-linux", "bsd"]) }).strict().nullable(),
  home: path,
  user: plain(255),
  privileged: z.boolean(),
  pty: z.boolean(),
  ember: z.object({ paths: z.array(path).max(CAPS.paths), pids: z.array(int()).max(1000), names: EmberNamesSchema }).strict(),
  extraPath: z.array(path).max(CAPS.paths),
  wsl: z.object({ mountRoot: path, interop: z.boolean(), windows: WindowsContextSchema.nullable() }).strict().optional(),
}).strict();

const CommandStampSchema = z.object({
  taskId,
  sha256: sha256Hex,
  verdict: z.enum(["run", "announce", "ask"]),
  classes: z.array(DANGER).max(7),
  rules: z.array(plain(CAPS.str.app)).max(CAPS.paths),
  approval: z.object({ ageMs: ms }).strict().nullable(),
}).strict();

const RunSpecSchema = z.object({
  runId,
  taskId,
  shell: SHELL,
  command: str(CAPS.str.command),
  cwd: path,
  timeoutMs: int(1, 24 * 3_600_000),
  cols: int(1, 1000),
  rows: int(1, 1000),
  stamp: CommandStampSchema,
}).strict();

const RunExitSchema = z.object({
  code: z.number().int().nullable(),
  signal: plain(32).nullable(),
  ended: ENDED,
  ms,
  error: str(CAPS.str.reason).optional(),
  needsConfirm: z.boolean().optional(),
  remoteSays: z.array(str(CAPS.str.reason)).max(CAPS.paths).optional(),
}).strict();

const PathFactSchema = z.object({ exists: z.boolean().nullable(), real: path.nullable() }).strict();
const GitFactsSchema = z.object({ branch: plain(CAPS.str.name).nullable(), pushDefault: plain(64).nullable(), upstream: plain(CAPS.str.name).nullable() }).strict();

const HelloSchema = z.object({
  proto: z.literal(1),
  partsId,
  local: z.object({ name: plain(64), os: OS_ENUM }).strict(),
  pcId: z.string().regex(/^[0-9a-f]{32}$/),
  consent: z.object({ version: int(), at: plain(64) }).strict(),
  neverLook: z.array(str(CAPS.str.app)).max(CAPS.neverLook),
  localAdmin: AdminSummarySchema,
  epoch,
}).strict();

const WelcomeSchema = z.object({
  proto: z.literal(1),
  partsId,
  os: z.enum(["linux", "darwin", "win32"]),
  arch: z.enum(["x64", "arm64"]),
  machineIdHash: sha256Hex,
  isWsl: z.boolean(),
  uid: int(),
  user: plain(255),
  home: path,
  facts: RunnerFactsSchema,
  desktop: DesktopStateSchema,
  remoteAdmin: AdminSummarySchema,
  pid: int(1),
  tccLimited: z.boolean().optional(),
  graceSeconds: int(3, 120),
}).strict();

const ImageRefSchema = z.object({
  channel: int(),
  bytes: int(1, CAPS.image.bytes),
  sha256: sha256Hex,
  width: int(1, CAPS.image.side),
  height: int(1, CAPS.image.side),
  rect: BoundsSchema,
  scale: z.number().gt(0).max(16),
  mime: z.literal("image/png"),
}).strict();

const RemoteAppSchema = z.object({
  id: plain(CAPS.str.path),
  name: str(CAPS.str.app),
  keywords: z.array(str(CAPS.str.app)).max(CAPS.states).optional(),
  categories: z.array(str(CAPS.str.role)).max(CAPS.states).optional(),
  argv: z.array(str(CAPS.str.path)).max(CAPS.paths).optional(),
  terminal: z.boolean().optional(),
}).strict();

/** `act`'s arguments: the step's id, its epoch and gate 1's stamp, with one of the four accessibility operations. */
const actArgs = <T extends z.ZodRawShape>(op: T) => z.object({ opId: plain(100), epoch, stamp: ActStampSchema, ...op }).strict();
const ActArgsSchema = z.discriminatedUnion("op", [
  actArgs({ op: z.literal("do_action"), id: elementId, action: str(CAPS.str.app) }),
  actArgs({ op: z.literal("set_text"), id: elementId, text: str(TYPED_TEXT_MAX), mode: TEXT_MODE }),
  actArgs({ op: z.literal("set_value"), id: elementId, value: z.number() }),
  actArgs({ op: z.literal("select_option"), id: elementId, option: str(CAPS.str.name) }),
]);

/** Gate 2's answer (GateAnswer) with what else the op returns (`extra`). */
const gateAnswer = <T extends z.ZodRawShape>(extra: T) => z.union([
  z.object({ status: z.literal("ok"), ...extra }).strict(),
  z.object({ status: z.enum(["deny", "needs_confirm"]), reason: str(CAPS.str.reason), ...extra }).strict(),
  z.object({ status: z.enum(["changed", "stale", "stopped"]), ...extra }).strict(),
]);

/** One value of a remote audit entry: plain JSON, bounded in length and depth. */
const auditValue = (depth: number): z.ZodType<unknown> => {
  const leaf = z.union([str(CAPS.str.text), z.number(), z.boolean(), z.null()]);
  if (depth <= 0) return leaf;
  return z.union([
    leaf,
    z.array(auditValue(depth - 1)).max(64),
    z.record(str(64), auditValue(depth - 1)).refine(o => Object.keys(o).length <= 64, "too many keys"),
  ]);
};
const AuditEntrySchema = z.record(str(64), auditValue(2)).refine(o => Object.keys(o).length <= 64, "too many keys");

/** `cmd.input`'s data: base64 of at most 4 KiB. */
const INPUT_BYTES_MAX = 4096;
const INPUT_B64_MAX = Math.ceil(INPUT_BYTES_MAX / 3) * 4;
/** The bytes a padded base64 text decodes to (its length is a multiple of 4: the pattern below checks that first). */
const base64Bytes = (s: string) => (s.length / 4) * 3 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
/** `cmd.input`'s data: padded base64 that decodes to at most INPUT_BYTES_MAX bytes (the longest text allows 4098). */
const InputData = z.string().max(INPUT_B64_MAX)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine(s => base64Bytes(s) <= INPUT_BYTES_MAX, "more than 4 KiB of input");

/** zod schemas, one per op's args and result and per event, `.strict()`, with CAPS. */
export const OP_SCHEMAS: { readonly [O in Op]: { args: z.ZodType<OpArgs<O>>; result: z.ZodType<OpResult<O>> } } = {
  "hello": { args: HelloSchema, result: WelcomeSchema },
  "policy.sync": { args: z.object({ neverLook: z.array(str(CAPS.str.app)).max(CAPS.neverLook), localAdmin: AdminSummarySchema }).strict(), result: EMPTY },
  "desktop.state": { args: EMPTY, result: DesktopStateSchema },
  "perceive.read": {
    args: z.object({ target: WindowTargetSchema, keep: z.boolean().optional(), cells: z.array(plain(16)).max(64).optional() }).strict(),
    result: SeenSchema,
  },
  "perceive.focused": { args: EMPTY, result: SeenSchema },
  "perceive.perceive": {
    args: z.object({ image: z.boolean(), scope: z.enum(["window", "screen"]), target: WindowTargetSchema.optional() }).strict(),
    result: z.object({ seen: SeenSchema, image: ImageRefSchema.nullable(), noShot: str(CAPS.str.reason).optional() }).strict(),
  },
  "perceive.atPoint": {
    args: z.object({ target: WindowTargetSchema, x: coord, y: coord, k: z.number().gt(0).max(16) }).strict(),
    result: z.object({ chain: z.array(PointElementSchema).max(CAPS.chain).nullable() }).strict(),
  },
  "perceive.windows": { args: EMPTY, result: z.object({ windows: z.array(AxWindowSchema).max(CAPS.windows) }).strict() },
  "perceive.openWindows": {
    args: EMPTY,
    result: z.object({
      lines: z.array(z.object({ app: str(CAPS.str.app), title: str(CAPS.str.title), active: z.boolean(), busy: z.boolean().optional() }).strict()).max(CAPS.lines),
    }).strict(),
  },
  "perceive.systemDialog": { args: EMPTY, result: z.object({ open: z.boolean() }).strict() },
  "ax.readElement": { args: z.object({ id: elementId, shown: z.boolean().optional(), formula: z.boolean().optional() }).strict(), result: ElementInfoSchema },
  "ax.canDo": { args: z.object({ id: elementId, kind: z.enum(["click", "toggle", "text", "value"]), caret: z.boolean() }).strict(), result: CanDoSchema },
  "ax.listOptions": {
    args: z.object({ id: elementId }).strict(),
    result: z.object({ options: z.array(str(CAPS.str.name)).max(CAPS.options), left: int().optional() }).strict(),
  },
  "act": { args: ActArgsSchema, result: gateAnswer({ result: ActionResultSchema.optional() }) },
  "apps.list": { args: EMPTY, result: z.object({ apps: z.array(RemoteAppSchema).max(APPS_MAX) }).strict() },
  "apps.launch": {
    args: z.object({ epoch, appId: plain(CAPS.str.path), stamp: ActStampSchema }).strict(),
    result: gateAnswer({ pid: int(1).optional() }),
  },
  "cmd.facts": { args: EMPTY, result: RunnerFactsSchema },
  "cmd.inspect": {
    args: z.object({ paths: z.array(path).max(CAPS.paths), cwd: path }).strict(),
    result: z.object({ paths: z.array(PathFactSchema).max(CAPS.paths) }).strict(),
  },
  "cmd.git": { args: z.object({ cwd: path }).strict(), result: z.object({ git: GitFactsSchema.nullable() }).strict() },
  "cmd.run": {
    args: z.object({ epoch, spec: RunSpecSchema }).strict(),
    result: z.union([
      z.object({ status: z.literal("started"), channel: int(), interactive: z.boolean() }).strict(),
      z.object({
        status: z.enum(["deny", "needs_confirm"]),
        reason: str(CAPS.str.reason),
        says: z.array(str(CAPS.str.reason)).max(CAPS.paths).optional(),
        rules: z.array(plain(CAPS.str.app)).max(CAPS.paths).optional(),
      }).strict(),
    ]),
  },
  "cmd.input": {
    args: z.object({ runId, data: InputData }).strict(),
    result: EMPTY,
  },
  "cmd.stop": { args: z.object({ runId, why: z.enum(["user", "task", "timeout"]) }).strict(), result: EMPTY },
  "stop": { args: z.object({ epoch }).strict(), result: z.object({ ms, late: z.array(plain(CAPS.str.role)).max(CAPS.lines) }).strict() },
  "audit.recent": {
    args: z.object({ limit: int(1, CAPS.auditEntries) }).strict(),
    result: z.object({ entries: z.array(AuditEntrySchema).max(CAPS.auditEntries) }).strict(),
  },
  "bye": { args: EMPTY, result: EMPTY },
};

export const EV_SCHEMAS: { readonly [E in EvName]: z.ZodType<EvMap[E]> } = {
  "desktop.changed": DesktopStateSchema,
  "cmd.exit": z.object({ runId, exit: RunExitSchema, outBytes: int() }).strict(),
  "console.stop": z.object({ at: plain(64) }).strict(),
  "policy.changed": AdminSummarySchema,
  "notice": z.object({ state: z.enum(["shown", "failed", "off"]) }).strict(),
  "log": z.object({ level: z.enum(["debug", "info", "warn", "error"]), event: plain(CAPS.str.app) }).strict(),
};
