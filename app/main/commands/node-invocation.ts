/** Literal, local Node requests. The host owns the executable; these bytes never become shell source. */
import { createHash } from "node:crypto";
import type { TargetId } from "../../shared/targets";
import type { RunSpec } from "./types";

export interface RunNodeArgs { argv: string[]; cwd?: string; timeoutSeconds?: number; why: string }
export type NodeRunSpec = Omit<RunSpec, "shell" | "command"> & { kind: "node"; argv: readonly string[] };
export const NODE_ARGV_LIMITS = Object.freeze({ count: 256, bytes: 8000 });

/** Capture before waiting: preserve empty arguments, order and exact UTF-8, including literal shell punctuation. */
export function copyNodeArgv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > NODE_ARGV_LIMITS.count) throw new Error("The Node arguments are invalid.");
  let bytes = 0;
  const argv: string[] = [];
  for (const arg of value) {
    if (typeof arg !== "string" || arg.includes("\0") || Buffer.from(arg, "utf8").toString("utf8") !== arg) throw new Error("The Node arguments are invalid.");
    bytes += Buffer.byteLength(arg, "utf8") + 1;
    if (bytes > NODE_ARGV_LIMITS.bytes) throw new Error("The Node arguments are too large.");
    argv.push(arg);
  }
  return argv;
}

/** A fixed array encoding separates every argument, and separates this authority from all shell approvals. */
export function nodeInvocationSha256(target: TargetId, cwd: string, argv: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(["ember.direct-node.v1", target, cwd, argv]), "utf8").digest("hex");
}

/** Display only. The card and runner independently hash the structured arguments, never this text. */
export function nodeInvocationDisplay(argv: readonly string[]): string { return `Node arguments: ${JSON.stringify(argv)}`; }
