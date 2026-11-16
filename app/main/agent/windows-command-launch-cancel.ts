/** Private host cancellation provenance. A claim requests cleanup; it never attests Stop, execution or bytes. */
import { readWindowsNodeToolchainCancellation, registeredWindowsNodeToolchainOutput, probeWindowsNodeToolchainReturnedCancellation } from "./windows-node-toolchain-native";
import { requireWindowsCommandRootOnlyLaunchMetadata } from "./windows-command-copy";
import { requireWindowsCommandRootOnlyCancellationCreating, requireWindowsCommandRootOnlyCancellationWitness,
  requireWindowsCommandRootOnlyCancellationPhase, requireWindowsCommandRootOnlyReturned,
  type WindowsCommandRootOnlyReturnedRef, type WindowsCommandRootOnlyAttestingRef, type WindowsCommandRootOnlyCancellationPhaseRef } from "./windows-command-stop";
import type { WindowsCommandOutputLaunchRef } from "./windows-command-output";

declare const cancellationBrand: unique symbol;
export interface WindowsCommandLaunchCancellationRef { readonly scope: "root-only-known-cancellation"; readonly [cancellationBrand]: true }
type Claim = { key: object; evidence: ReturnType<typeof readWindowsNodeToolchainCancellation>; binding: object;
  phase: "empty" | "held"; point: "creating" | "returned" | "attesting"; launch?: WindowsCommandOutputLaunchRef; consumed: boolean };
const claims = new WeakMap<object, Claim>(), pending = new WeakMap<object, WindowsCommandLaunchCancellationRef>();
const refuse = () => new Error("The Windows command cancellation provenance was refused.");

/** The key is issued only by the actual asset factory; its private state authenticates every fact. */
export function issueWindowsCommandLaunchCancellation(key: object): WindowsCommandLaunchCancellationRef {
  const evidence = readWindowsNodeToolchainCancellation(key), context = requireWindowsCommandRootOnlyLaunchMetadata(evidence.context);
  if (context.profile !== evidence.profile || pending.has(context.binding)) throw refuse();
  if (evidence.phase === "empty") {
    if (!context.live) throw refuse(); requireWindowsCommandRootOnlyCancellationCreating(context.binding);
  } else if (evidence.point === "returned") {
    if (!evidence.witness || !evidence.launch || requireWindowsCommandRootOnlyReturned(evidence.witness as WindowsCommandRootOnlyReturnedRef).binding !== context.binding) throw refuse();
  } else {
    if (!evidence.witness || !evidence.launch) throw refuse();
    requireWindowsCommandRootOnlyCancellationWitness(evidence.witness as WindowsCommandRootOnlyAttestingRef, context.binding, evidence.launch);
  }
  const ref = Object.freeze({ scope: "root-only-known-cancellation" as const }) as WindowsCommandLaunchCancellationRef;
  claims.set(ref, { key, evidence, binding: context.binding, phase: evidence.phase, point: evidence.point, launch: evidence.launch, consumed: false });
  pending.set(context.binding, ref); return ref;
}
/** Only a catch-local genuine Stop phase can consume a claim, once, before any Resume attempt. */
export function consumeWindowsCommandLaunchCancellation(error: unknown, phase: WindowsCommandRootOnlyCancellationPhaseRef): boolean {
  const claim = error && typeof error === "object" ? claims.get(error) : undefined; if (!claim) return false;
  const actual = requireWindowsCommandRootOnlyCancellationPhase(phase);
  if (claim.consumed || pending.get(claim.binding) !== error || claim.binding !== actual.binding || claim.phase !== actual.phase || claim.point !== actual.point ||
      claim.launch !== actual.launch || readWindowsNodeToolchainCancellation(claim.key) !== claim.evidence) throw refuse();
  claim.consumed = true; return true;
}
/** Observation only. The caller must separately obtain genuine completed Stop, grant revoke and output closure. */
export function readConsumedWindowsCommandLaunchCancellation(error: unknown, binding: object): Readonly<{ phase: "empty" | "held"; launch?: WindowsCommandOutputLaunchRef }> | undefined {
  const claim = error && typeof error === "object" ? claims.get(error) : undefined;
  return claim?.consumed && claim.binding === binding && pending.get(binding) === error
    ? Object.freeze({ phase: claim.phase, launch: claim.launch }) : undefined;
}
/** Swallowing an issued claim cannot turn its retired launch into executable work. */
export function requireNoWindowsCommandLaunchCancellation(binding: object): void { if (pending.has(binding)) throw refuse(); }
/** Fixed private factory registry, never a host-provided output/asset claim. */
export const windowsCommandRegisteredNodeOutput = registeredWindowsNodeToolchainOutput;
export const probeReturnedWindowsCommandCancellation = probeWindowsNodeToolchainReturnedCancellation;
/** A genuine claim can request cleanup only for the exact currently held returned-root capability. */
export function pendingReturnedWindowsCommandCancellation(error: unknown, ref: WindowsCommandRootOnlyReturnedRef): WindowsCommandOutputLaunchRef | undefined {
  const claim = error && typeof error === "object" ? claims.get(error) : undefined; if (!claim || claim.point !== "returned") return undefined;
  const actual = requireWindowsCommandRootOnlyReturned(ref);
  if (claim.consumed || pending.get(actual.binding) !== error || claim.binding !== actual.binding || claim.evidence.witness !== ref ||
      readWindowsNodeToolchainCancellation(claim.key) !== claim.evidence || !claim.launch) throw refuse();
  return claim.launch;
}
