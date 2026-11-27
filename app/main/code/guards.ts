/**
 * What Ember keeps in coding sessions whatever the SDK allows (docs/CODING-APP.md §3 "Guards"), as pure functions the
 * hub and each session apply: the plain sentences a refusal says (Ember's voice, never the SDK's text), the checks a
 * window's RPC call passes on top of the allow-list (`rpcRefusal`: no call turns the sandbox off or sets a permission
 * mode, which has its own command, and none passes a path that is Ember's own data), and what a tool's arguments
 * reach of Ember's data (`reachesEmberData`), which the pre-tool hook refuses where there is no sandbox (and, as
 * defence in depth, where there is one). A session's own folder (a worktree Ember made lives inside its data folder)
 * and the SDK's own state for that session are the session's, never refused. Each check fails closed: arguments too
 * many or too deep to read whole are refused.
 */

import path from "node:path";
import { CODE_LIMITS, codeRpcAllowed, type CodeRefusal, type CodeRpcCall } from "../../shared/code";
import { emberPathReach, type EmberPlace } from "../policy/ember-paths";

/** The plain sentences a coding refusal says. */
export const CODE_REFUSALS = {
  off: "Coding sessions aren't turned on.",
  consent: "Ember needs your agreement before it starts a coding session.",
  policy: "Your organisation doesn't allow coding sessions here.",
  vault: "Coding sessions are off after a vault fill until Ember restarts.",
  offline: "Connect Ember to Copilot first.",
  unknown: "That session isn't one Ember knows.",
  closed: "That session isn't open. Open it again first.",
  project: "That project isn't one Ember knows.",
  picked: "No folder was chosen.",
  emberData: "That folder holds Ember's own data. Choose another.",
  notGit: "That folder isn't a git repository, so Ember can't make a worktree for it. Work in the folder itself instead.",
  worktree: "Ember couldn't make a worktree for this session.",
  stopped: "This session was stopped.",
  request: "That request isn't waiting any more.",
  audit: "Ember couldn't record what this session did, so it stopped it.",
  badArgs: "Ember couldn't read that request.",
  rpcNotAllowed: "The coding window can't call that.",
  rpcSandbox: "The sandbox can only be changed in Ember's settings.",
  rpcMode: "Change the permission mode with its own control.",
  rpcPath: "That path is Ember's own data, which coding sessions don't reach.",
  rpcTooLarge: "That request is too large.",
  modeRefused: "Your organisation doesn't allow that mode here.",
  name: "Give the session a shorter name.",
  prompt: "Type a message first.",
  tooMany: "That's more attachments than one message takes.",
  attachment: "Ember couldn't attach that.",
  emberToolPath: "That path is Ember's own data, which Copilot's tools don't reach.",
  companionAnswer: "You answer this one yourself, in the coding window.",
} as const;

/** A refusal with its sentence. */
export const refuse = (reason: string, code?: string): CodeRefusal => ({ ok: false, reason, ...(code ? { code } : {}) });

/** Strings read from one call's arguments at most, and how deep. */
const MAX_STRINGS = 5_000;
const MAX_DEPTH = 24;

/** Every string in `value`, keys included; null when it is too many or too deep to read whole. */
export function stringsOf(value: unknown): string[] | null {
  const out: string[] = [];
  let whole = true;
  const walk = (v: unknown, depth: number): void => {
    if (!whole) return;
    if (out.length > MAX_STRINGS || depth > MAX_DEPTH) { whole = false; return; }
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { out.push(k); walk(x, depth + 1); }
  };
  try { walk(value, 0); } catch { whole = false; /* a getter that throws: not read whole */ }
  return whole ? out : null;
}

/** Whether `p` is `root` or inside it (the host's own path rules: main runs on the OS whose paths these are). */
export function isInside(p: string, root: string): boolean {
  if (!path.isAbsolute(p) || !path.isAbsolute(root)) return false;
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Where a session's paths are judged: the place, and the session's own folders (its cwd, its SDK state). */
export interface SessionPlace {
  place: EmberPlace;
  /** The session's working folder: relative paths are relative to it, and it is the session's own. */
  cwd?: string;
  /** Folders that are the session's own even inside Ember's data folder (a worktree, its SDK state). */
  own?: readonly string[];
}

/**
 * Whether any string in `args` names Ember's data or policy folder or something in it, judged as the commands
 * classifier judges a path (emberPathReach), apart from the session's own folders; "unreadable" when the arguments
 * can't be read whole (refused: fail closed).
 */
export function reachesEmberData(args: unknown, where: SessionPlace): boolean | "unreadable" {
  const strings = stringsOf(args);
  if (!strings) return "unreadable";
  const own = [...(where.own ?? []), ...(where.cwd ? [where.cwd] : [])];
  for (const t of strings) {
    if (t.length > 4096 || !/[\\/~]|%[A-Za-z]/.test(t)) continue;
    // A path inside the session's own folders is its own.
    if (own.some(o => isInside(path.normalize(t), o))) continue;
    if (emberPathReach(t, { ...where.place, ...(where.cwd ? { own: where.cwd } : {}) }) === "names") return true;
    // Words around a path (a command line): each word that looks like a path is judged on its own.
    if (/\s/.test(t)) {
      for (const word of t.split(/[\s"'`=;|&<>()]+/)) {
        if (!word || !/[\\/~]/.test(word) || own.some(o => isInside(path.normalize(word), o))) continue;
        if (emberPathReach(word, { ...where.place, ...(where.cwd ? { own: where.cwd } : {}) }) === "names") return true;
      }
    }
  }
  return false;
}

/** The sandbox's methods that only read: the only ones a window may call. */
const SANDBOX_READS = new Set(["sandbox.getHostSupport", "sandbox.getEnforcementStatus", "sandbox.getCredentialSuggestions"]);

/** RPC methods whose params are paths given standing access: a folder above Ember's data is refused there too. */
const GRANTS_PATHS = /^permissions\.(paths|locations|folderTrust)\./;

/**
 * Why a window's RPC call is refused, or null: not on the allow-list (codeRpcAllowed), params too large, a call that
 * would turn the sandbox off or set a permission mode (CODE_RPC leaves both out; this holds whatever it lists), or a
 * path that is Ember's own data (or, for a call that grants a folder, a folder that holds it).
 */
export function rpcRefusal(call: CodeRpcCall, where: SessionPlace): string | null {
  if (!codeRpcAllowed(call.scope, call.method)) return CODE_REFUSALS.rpcNotAllowed;
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(call.params ?? null) ?? "", "utf8"); } catch { return CODE_REFUSALS.badArgs; }
  if (size > CODE_LIMITS.params) return CODE_REFUSALS.rpcTooLarge;
  if (/sandbox|disableForSession/i.test(call.method) && !SANDBOX_READS.has(call.method)) return CODE_REFUSALS.rpcSandbox;
  if (/^permissions\.(setMode|setApproveAll|configure|setRequired|urls\.)/.test(call.method) || /^options\./.test(call.method)) return CODE_REFUSALS.rpcMode;
  const strings = stringsOf(call.params);
  if (!strings) return CODE_REFUSALS.rpcTooLarge;
  // Anything that would switch a sandbox off, whatever the method: a `sandbox`/`sandboxConfig` key set to off.
  if (sandboxOff(call.params)) return CODE_REFUSALS.rpcSandbox;
  const reach = reachesEmberData(call.params, where);
  if (reach !== false) return CODE_REFUSALS.rpcPath;
  if (GRANTS_PATHS.test(call.method)) {
    for (const t of strings) if (/[\\/~]/.test(t) && emberPathReach(t, { ...where.place, ...(where.cwd ? { own: where.cwd } : {}) }) === "holds") return CODE_REFUSALS.rpcPath;
  }
  return null;
}

/** Whether `params` holds a sandbox setting that turns it off (`sandbox*: false`, `enabled: false` under one, `allowBypass: true`). */
function sandboxOff(params: unknown, depth = 0, under = false): boolean {
  if (!params || typeof params !== "object" || depth > MAX_DEPTH) return false;
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    const sandboxKey = /sandbox/i.test(k);
    if (sandboxKey && (v === false || v === "off" || v === "disabled")) return true;
    if ((sandboxKey || under) && ((k === "enabled" && v === false) || (k === "allowBypass" && v === true))) return true;
    if (v && typeof v === "object" && sandboxOff(v, depth + 1, under || sandboxKey)) return true;
  }
  return false;
}
