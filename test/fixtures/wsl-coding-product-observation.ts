/** Optional fixture observations. Nothing here grants workspace or command authority. */
import { types } from "node:util";
import { WslCodingGuestCleanupError, type WslCodingConnection } from "../../app/main/agent/wsl-coding-connection";
import { CodingArtifactCleanupError } from "../../app/main/agent/coding-artifact-store";
import { CodingPrivacyCleanupError } from "../../app/main/agent/coding-privacy-scanner";
import { WindowsCodingCleanupError } from "../../app/main/agent/windows-coding-native";

function nativeError(error: unknown, prototype?: object): boolean {
  if (!types.isNativeError(error) || types.isProxy(error)) return false;
  if (!prototype) return true;
  for (let value = Object.getPrototypeOf(error); value && !types.isProxy(value); value = Object.getPrototypeOf(value)) {
    if (value === prototype) return true;
  }
  return false;
}

function exactError(error: unknown, message: string): boolean {
  return nativeError(error) && Object.getOwnPropertyDescriptor(error, "message")?.value === message;
}

export function resourceOuterKind(error: unknown): number {
  if (nativeError(error, WindowsCodingCleanupError.prototype) || nativeError(error, CodingArtifactCleanupError.prototype) ||
      nativeError(error, CodingPrivacyCleanupError.prototype)) return 1;
  if (exactError(error, "The private Windows coding copy could not be created under its current project grant.")) return 2;
  return 3;
}

type RpcObservation = Readonly<{ rpc: number; edge: number; refusal: number; reply: number }>;
// RPC edge: 0 absent, 1 entered, 2 resolved, 3 rejected.
const rpcMethod = Object.freeze({ hello: 1, provision: 2, open: 3 });
const replyFields = Object.freeze({
  hello: { protocol: 1, kind: "linux-helper", noNetwork: true, provisioned: false, opened: false, retired: false },
  provision: { typescript: "5.9.3" },
  open: { opened: true },
});

// Reply: 1 fields matched, 2 mismatch, 3 unreadable. An accepted reply can still precede a later refusal.
function resourceReplyKind(method: keyof typeof rpcMethod, value: unknown): number {
  if (!value || typeof value !== "object") return 2;
  if (types.isProxy(value)) return 3;
  const check = (key: string, expected: (value: unknown) => boolean) => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (field && !("value" in field)) return 3;
    return expected(field?.value) ? 1 : 2;
  };
  for (const [key, expected] of Object.entries(replyFields[method])) {
    const kind = check(key, value => value === expected);
    if (kind !== 1) return kind;
  }
  return method === "hello"
    ? check("uid", value => typeof value === "number" && Number.isInteger(value) && value > 0)
    : 1;
}

const originalPromise = Promise;
const promisePrototype = originalPromise.prototype;
const then = promisePrototype.then;
const species = Object.getOwnPropertyDescriptor(originalPromise, Symbol.species)?.get;

function callDescriptor(connection: object): PropertyDescriptor | undefined {
  for (let value: object | null = connection; value && !types.isProxy(value); value = Object.getPrototypeOf(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, "call");
    if (descriptor) return descriptor;
  }
  return undefined;
}

function ordinaryPromise(value: unknown): value is Promise<unknown> {
  if (!types.isPromise(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== promisePrototype ||
      Object.getOwnPropertyDescriptor(value, "constructor")) return false;
  if (Object.getOwnPropertyDescriptor(promisePrototype, "constructor")?.value !== originalPromise) return false;
  const descriptor = Object.getOwnPropertyDescriptor(originalPromise, Symbol.species);
  return !!species && descriptor?.get === species && descriptor.set === undefined;
}

export function observeResourceWorkspaceCalls(connection: Pick<WslCodingConnection, "call">): () => RpcObservation {
  let observation: RpcObservation = { rpc: 0, edge: 0, refusal: 0, reply: 0 };
  const original = callDescriptor(connection)?.value as unknown;
  if (typeof original !== "function" || types.isProxy(original)) throw new Error("WSL fixture connection observation unavailable.");
  const call = (...args: Parameters<WslCodingConnection["call"]>): Promise<unknown> => Reflect.apply(original, connection, args);
  const observe: WslCodingConnection["call"] = (...args) => {
    const method = args[0];
    if (method !== "hello" && method !== "provision" && method !== "open" || observation.edge === 3) return call(...args);
    const rpc = rpcMethod[method];
    const entered = { rpc, edge: 1, refusal: 0, reply: 0 };
    observation = entered;
    const rejected = (error: unknown) => {
      if (observation.edge === 3) return;
      let refusal = 3;
      try {
        if (nativeError(error, WslCodingGuestCleanupError.prototype)) refusal = 2;
        else if (exactError(error, "The isolated WSL coding connection could not be verified.")) refusal = 1;
      } catch { /* Opaque errors are unknown. */ }
      observation = { rpc, edge: 3, refusal, reply: 0 };
    };
    let pending: Promise<unknown>;
    try { pending = call(...args); }
    catch (error) { rejected(error); throw error; }
    // Observe the original promise. Keep the same connection and every argument for stop receipts and cleanup.
    try {
      if (ordinaryPromise(pending)) Reflect.apply(then, pending, [(value: unknown) => {
        if (observation !== entered) return;
        let reply = 3;
        try { reply = resourceReplyKind(method, value); } catch { /* Opaque replies are unreadable. */ }
        observation = { rpc, edge: 2, refusal: 0, reply };
      }, rejected]);
    } catch { /* Optional evidence never changes the call's return or failure. */ }
    return pending;
  };
  Object.defineProperty(connection, "call", { value: observe, configurable: true, writable: true,
    enumerable: Object.getOwnPropertyDescriptor(connection, "call")?.enumerable ?? false });
  return () => ({ ...observation });
}

// These numbers describe an exact observed summary. The text alone does not establish its origin.
const sourceSummary = [
  "A command was refused, stopped or could not be fully observed. The coding task stopped.",
  "The coding task ended, but its review could not be published. The original folder is unchanged.",
  "The coding session could not be verified as closed. Further coding work is blocked.",
  "I couldn't confirm that the coding task stopped.",
  "The coding worker did not report an explicit completed result.",
  "The coding workspace could not be verified as quiescent.",
  "The coding model could not finish the task.",
  "The coding result could not be prepared for review. The original folder is unchanged.",
  "The coding task could not be completed safely.",
  "The fixed WSL fixture could not verify its expected step.",
  "Verified the copied WSL result. Review its private changes before applying them. Some operations failed or were refused; review the recorded results.",
] as const;

export function sourceSummaryKind(summary: unknown): number {
  if (summary === undefined || summary === "") return 0;
  const index = sourceSummary.findIndex(value => value === summary);
  return index < 0 ? 1 : index + 2;
}

const outputFrame = '\n<coding_command_result untrusted="true">';
export function sourceCommandKind(content: unknown): number {
  if (content === undefined) return 0;
  if (typeof content !== "string") return 3;
  if (content.startsWith("Observed command exited successfully." + outputFrame)) return 1;
  if (content.startsWith("Observed command exited unsuccessfully. Fix the copy and rerun this exact check before reporting success." + outputFrame)) return 2;
  return 3;
}
