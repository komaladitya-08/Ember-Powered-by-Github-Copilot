/**
 * The PC's decision after the bootstrap's probe (§5.1.9): refuse (with §8.7's message), SERVE what is already there, or
 * INSTALL what is missing, checked in a fixed order: the same machine (§5.1.14), then OS, CPU, kernel, glibc and macOS
 * version, then the remote's own admin policy (parsed here with AdminPolicySchema before anything is uploaded, G21),
 * then noexec and free space, then what's missing. Nothing is uploaded before every check passed (R10). The probe is
 * remote text: every value is read by name, bounded and validated; anything Ember can't read refuses. Pure.
 */

import type { OS } from "../../shared/shortcuts";
import { adminSummary, combineAdmin, lockedDown, parseAdminPolicy, type AdminSummary, type LoadedAdminPolicy } from "../admin";
import { MESSAGES } from "./ssh-errors";
import { sameMachine, type SelfIdentity } from "./same-machine";

/** The remotes Ember ships a runtime and parts for (§5.2.2). */
export type RemoteTarget = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64";

/** An archive Ember can send, already checked against its pinned SHA-256 (§5.2.4 step 1). */
export interface Archive { id: string; bytes: number; sha256: string; format: "xz" | "gz" }

/** What the PC knows when it decides. */
export interface PlanLocal {
  /** The host's label, for messages. */
  host: string;
  /** This Ember install's id (32 hex digits, §5.1.13). */
  pcId: string;
  /** This PC's identity for the same-machine rule (§5.1.14). */
  self: SelfIdentity;
  /** The unpackaged-only test switch: lifts the same-machine rules (§5.1.14). */
  allowLoopback: boolean;
  /** The PC's policy (with its source, R5): combined with the remote's to find an empty model intersection. */
  localAdmin: LoadedAdminPolicy;
  /** The model ids the user set on the PC (settings.models), if any: a remote's models.allowed must hold them. */
  models: string[];
  /** The parts this Ember carries, per target (null: missing from this install). */
  parts: { partsId: string; targets: Partial<Record<RemoteTarget, Omit<Archive, "id" | "format">>> } | null;
  /** The Node runtime policy (remote-runtime.json): `minimum`, `pinned`, and each target's archives. */
  runtime: { minimum: string; pinned: string; targets: Partial<Record<RemoteTarget, { xz?: Omit<Archive, "id" | "format">; gz?: Omit<Archive, "id" | "format"> }>> } | null;
}

/** The decision. */
export type Plan =
  | { action: "refuse"; kind: string; message: string; fix?: string; retry?: boolean }
  | { action: "serve"; target: RemoteTarget; runtimeId: string; partsId: string; line: string; remote: RemoteFacts }
  | { action: "install"; target: RemoteTarget; runtime: Archive | null; runtimeId: string; parts: Archive | null; partsId: string; line: string; remote: RemoteFacts };

/** What the probe said about the remote that the rest of the connection keeps (messages, the welcome check). */
export interface RemoteFacts {
  os: "linux" | "darwin";
  arch: "x64" | "arm64";
  uid: number | null;
  user: string;
  machine: string | null;
  wsl: boolean;
  /** The macOS "full disk access for remote users" check failed (L6). */
  tccLimited: boolean;
  /** fapolicyd is active or a confined SELinux user (the exec-denied wording, L24). */
  hardened: boolean;
  /** The remote admin's summary (the PC refuses before upload on its features, provider and models). */
  remoteAdmin: AdminSummary;
}

/** Most bytes Ember needs free in the remote home for an install (§5.1.9): about 400 MB. */
export const MIN_FREE_KB = 400 * 1024;
/** The biggest remote policy the probe sends (larger: Ember can't check it, so it refuses). */
export const POLICY_MAX = 64 * 1024;

/** A probe value, bounded: at most 1 KiB, trimmed. */
function val(probe: Record<string, string>, k: string): string {
  const v = Object.prototype.hasOwnProperty.call(probe, k) ? probe[k] : undefined;
  return typeof v === "string" ? v.slice(0, 1024).trim() : "";
}

/** "4.18.0-305.el8.x86_64" → [4, 18]; null when it isn't a version. */
export function versionPair(s: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)/.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function atLeast(v: [number, number] | null, major: number, minor: number): boolean {
  return v !== null && (v[0] > major || (v[0] === major && v[1] >= minor));
}

/** The glibc version a probe's `libc` line names ("glibc 2.28", "ldd (GNU libc) 2.31"); "musl"; or null. */
export function glibcOf(libc: string): [number, number] | "musl" | null {
  if (/musl/i.test(libc)) return "musl";
  const m = /(?:glibc|GNU libc\)?|GLIBC)\s+(\d+)\.(\d+)/i.exec(libc) ?? /\b(\d+)\.(\d+)\s*$/.exec(libc);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * The remote's admin policy from the probe's policy keys (§5.1.9): null when there is none; a policy that isn't
 * root-owned, is writable by others, is too large to check or doesn't parse locks down (as the agent itself would load
 * it, `requireRootOwned`), and the PC refuses on that.
 */
export function remotePolicy(probe: Record<string, string>, source: string): LoadedAdminPolicy | null {
  const state = val(probe, "policy");
  if (state === "" || state === "none") return null;
  if (state !== "present") return lockedDown(source, `${source} couldn't be checked`);
  const mode = val(probe, "policy_mode");
  const size = Number(val(probe, "policy_size"));
  if (val(probe, "policy_uid") !== "0") return lockedDown(source, `${source} isn't owned by root`);
  if (!/^[0-7]{3,4}$/.test(mode) || (parseInt(mode, 8) & 0o022) !== 0) return lockedDown(source, `${source} is writable by others`);
  if (val(probe, "policy_size") === "" || !Number.isInteger(size) || size < 0 || size > POLICY_MAX) return lockedDown(source, `${source} is too large to check`);
  const chunks: string[] = [];
  for (let i = 0; i < 100 && Object.prototype.hasOwnProperty.call(probe, `policy_b64.${i}`); i++) chunks.push(val(probe, `policy_b64.${i}`));
  const b64 = chunks.join("");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return lockedDown(source, `${source} couldn't be read`);
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== size) return lockedDown(source, `${source} couldn't be read`);
  return parseAdminPolicy(raw.toString("utf8"), source);
}

/** The target for a probe's `os` and `arch`, or null. */
export function targetOf(os: string, arch: string): { os: "linux" | "darwin"; arch: "x64" | "arm64"; target: RemoteTarget } | null {
  const o = os === "Linux" ? "linux" : os === "Darwin" ? "darwin" : null;
  const a = arch === "x86_64" || arch === "amd64" ? "x64" : arch === "aarch64" || arch === "arm64" ? "arm64" : null;
  return o && a ? { os: o, arch: a, target: `${o}-${a}` as RemoteTarget } : null;
}

/** A Node version ("24.11.1") as numbers; null when it isn't one. */
export function nodeVersion(s: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareNode(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** A runtime's id on the remote (its folder under runtime/): `v<version>-<target>`. */
export function runtimeId(version: string, target: RemoteTarget): string {
  return `v${version.replace(/^v/, "")}-${target}`;
}

/**
 * The runtime the remote may keep (critique remote-27): a verified one of `pinned`'s major at or above `minimum` (the
 * newest such), or null when Ember must upload `pinned`.
 */
export function reusableRuntime(present: readonly string[], target: RemoteTarget, minimum: string, pinned: string): string | null {
  const min = nodeVersion(minimum);
  const pin = nodeVersion(pinned);
  if (!min || !pin) return null;
  let best: { id: string; v: [number, number, number] } | null = null;
  for (const id of present) {
    const m = /^v(\d+\.\d+\.\d+)-(.+)$/.exec(id);
    if (!m || m[2] !== target) continue;
    const v = nodeVersion(m[1]);
    if (!v || v[0] !== pin[0] || compareNode(v, min) < 0) continue;
    if (!best || compareNode(v, best.v) > 0) best = { id, v };
  }
  return best?.id ?? null;
}

/** A word list from the probe (`rt`, `parts`, `tools`), each word made of safe characters only. */
function words(probe: Record<string, string>, k: string): string[] {
  return val(probe, k).split(/\s+/).filter(w => /^[A-Za-z0-9._+-]{1,100}$/.test(w));
}

const refuse = (kind: string, message: string, extra: { fix?: string; retry?: boolean } = {}): Plan => ({ action: "refuse", kind, message, ...extra });

/** The decision for one probe (§5.1.9), in the order the design fixes. */
export function planInstall(probe: Record<string, string>, local: PlanLocal): Plan {
  const h = local.host;
  if (!/^[0-9a-f]{32}$/.test(local.pcId)) return refuse("internal", MESSAGES.answeredOddly(h));
  // 1. Never this same computer (R10).
  if (!local.allowLoopback) {
    const same = sameMachine(probe, local.self);
    if (same === "same") return refuse("same-machine", MESSAGES.sameMachine(h));
    if (same === "wsl") return refuse("same-machine", MESSAGES.sameMachineWsl(h));
  }
  // 2. The system.
  const os = val(probe, "os");
  const arch = val(probe, "arch");
  if (/^(MINGW|MSYS|CYGWIN)/i.test(os)) return refuse("not-posix", MESSAGES.notPosix(h));
  const t = targetOf(os, arch);
  if (!t) return refuse("unsupported", MESSAGES.unsupported(os.replace(/[^A-Za-z0-9._ -]/g, "").slice(0, 40) || "these", arch.replace(/[^A-Za-z0-9._ -]/g, "").slice(0, 40) || "unknown"));
  if (t.os === "linux") {
    if (!atLeast(versionPair(val(probe, "kernel")), 4, 18)) return refuse("unsupported", MESSAGES.kernel(h));
    const libc = glibcOf(val(probe, "libc"));
    if (libc === "musl") return refuse("unsupported", MESSAGES.musl(h));
    if (!atLeast(libc, 2, 28)) return refuse("unsupported", MESSAGES.glibc(h));
  } else if (!atLeast(versionPair(val(probe, "macos")), 13, 5)) {
    return refuse("unsupported", MESSAGES.macos(h));
  }
  // 3. The remote's own administrator (before anything is uploaded, G21).
  const source = t.os === "darwin" ? "/Library/Application Support/Ember/policy.json" : "/etc/ember/policy.json";
  const remote = remotePolicy(probe, source);
  if (remote?.error) return refuse("remote-policy", MESSAGES.remotePolicyBroken(h));
  const remoteAdmin = adminSummary(remote ?? { policy: parseAdminPolicy("{}", source).policy, source: null });
  if (remoteAdmin.features.ssh === false) return refuse("remote-policy", MESSAGES.remoteNotAllowed(h));
  if (remoteAdmin.provider) return refuse("remote-policy", MESSAGES.remoteProvider(h));
  const combined = combineAdmin(adminSummary(local.localAdmin), remoteAdmin);
  const allowed = remoteAdmin.models.allowed;
  if ((combined.models.allowed && combined.models.allowed.length === 0) || (allowed && local.models.some(m => !allowed.includes(m)))) {
    return refuse("remote-policy", MESSAGES.remoteModels(h));
  }
  // 4. Room and the right to run programs from the home folder.
  if (val(probe, "noexec") === "1") return refuse("noexec", MESSAGES.noexec(h));
  const uidText = val(probe, "uid");
  const remoteFacts: RemoteFacts = {
    os: t.os, arch: t.arch,
    uid: /^\d{1,10}$/.test(uidText) ? Number(uidText) : null,
    user: val(probe, "user").replace(/[^A-Za-z0-9._@-]/g, "").slice(0, 64),
    machine: /^[0-9a-f]{64}$/.test(val(probe, "machine")) ? val(probe, "machine") : null,
    wsl: val(probe, "wsl") === "1",
    tccLimited: t.os === "darwin" && val(probe, "tcc") !== "" && val(probe, "tcc") !== "0",
    hardened: val(probe, "fapolicyd") === "active" || /^(user_u|staff_u|guest_u|xguest_u):/.test(val(probe, "selinux")),
    remoteAdmin,
  };
  // 5. What's missing.
  if (!local.parts) return refuse("parts-missing", MESSAGES.partsMissing());
  const parts = local.parts.targets[t.target];
  if (!parts) return refuse("unsupported", MESSAGES.unsupported(t.os === "linux" ? "Linux" : "macOS", t.arch));
  const partsId = local.parts.partsId;
  if (!/^[A-Za-z0-9._+-]{1,100}$/.test(partsId)) return refuse("parts-missing", MESSAGES.partsMissing());
  const partsThere = words(probe, "parts").includes(partsId);
  let runtimeHave: string | null = null;
  let runtimeSend: Archive | null = null;
  const tools = new Set(words(probe, "tools"));
  if (local.runtime) runtimeHave = reusableRuntime(words(probe, "rt"), t.target, local.runtime.minimum, local.runtime.pinned);
  if (!runtimeHave) {
    const files = local.runtime?.targets[t.target];
    const format: "xz" | "gz" = tools.has("xz") && files?.xz ? "xz" : "gz";
    const file = files?.[format];
    if (!local.runtime || !file || !nodeVersion(local.runtime.pinned)) return refuse("parts-missing", MESSAGES.partsMissing());
    runtimeSend = { id: runtimeId(local.runtime.pinned, t.target), bytes: file.bytes, sha256: file.sha256, format };
  }
  const rid = runtimeHave ?? (runtimeSend as Archive).id;
  if (partsThere && runtimeHave) {
    return { action: "serve", target: t.target, runtimeId: rid, partsId, line: `SERVE ${local.pcId} ${rid} ${partsId}`, remote: remoteFacts };
  }
  const freeKb = Number(val(probe, "free_kb"));
  if (Number.isFinite(freeKb) && val(probe, "free_kb") !== "" && freeKb < MIN_FREE_KB) return refuse("disk", MESSAGES.disk(h));
  const needs = ["tar", "gzip", "head"].filter(x => !tools.has(x));
  if (!tools.has("sha256sum") && !tools.has("shasum")) needs.push("sha256sum");
  if (needs.length) return refuse("tools", MESSAGES.tools(h, needs));
  const partsSend: Archive | null = partsThere ? null : { id: partsId, bytes: parts.bytes, sha256: parts.sha256, format: "gz" };
  const r = runtimeSend;
  const line = [
    "INSTALL", local.pcId,
    rid, String(r?.bytes ?? 0), r?.sha256 ?? "-", r?.format ?? "-",
    partsId, String(partsSend?.bytes ?? 0), partsSend?.sha256 ?? "-",
  ].join(" ");
  return { action: "install", target: t.target, runtime: runtimeSend, runtimeId: rid, parts: partsSend, partsId, line, remote: remoteFacts };
}

/** The session facts from the probe's `session.*` lines (loginctl Key=Value, read by name; critique remote-2). */
export function probeSession(probe: Record<string, string>): { type: string; active: boolean; remote: boolean; seat: string; locked: boolean } | null {
  const type = val(probe, "session.Type");
  if (!type) return null;
  return {
    type,
    active: val(probe, "session.Active") === "yes",
    remote: val(probe, "session.Remote") === "yes",
    seat: val(probe, "session.Seat"),
    locked: val(probe, "session.LockedHint") === "yes",
  };
}

/** The OS a remote target runs, for welcome checks. */
export function targetOs(t: RemoteTarget): Extract<OS, "linux" | "darwin"> {
  return t.startsWith("darwin") ? "darwin" : "linux";
}
