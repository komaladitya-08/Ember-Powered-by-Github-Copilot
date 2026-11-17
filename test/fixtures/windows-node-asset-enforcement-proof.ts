/** Separate fixed native asset DACL witness. No project coordinator, selector or general program override. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path/win32";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { types } from "node:util";
import type { WindowsHandle } from "../../app/main/agent/experimental-windows-lpac-api";
import type { WindowsCommandRootOnlyStopOwner, WindowsCommandRootOnlyStoppedRef } from "../../app/main/agent/windows-command-stop";
import type { WindowsCommandOutputLaunchRef } from "../../app/main/agent/windows-command-output";
import type { WindowsRootOnlyCommandCopy, WindowsCommandRootOnlyRunRef } from "../../app/main/agent/windows-command-copy";
import type { WindowsCommandCopyProofPin } from "./windows-command-copy-proof-native";

type Bundle = typeof import("../../app/main/agent/windows-command-copy") & typeof import("../../app/main/agent/windows-command-output") &
  typeof import("../../app/main/agent/windows-command-stop") & typeof import("../../app/main/agent/windows-command-creator-profile") &
  typeof import("../../app/main/agent/windows-command-copy-native") & typeof import("../../app/main/agent/windows-node-toolchain-native") &
  typeof import("./windows-command-copy-proof-native") & typeof import("./windows-node-asset-enforcement-native") &
  typeof import("../../app/main/agent/experimental-windows-lpac-api") & typeof import("../../app/main/agent/coding-platform");
type Asset = Readonly<{ executable: string; module: string; program: string }>;
type TargetPins = ReturnType<ReturnType<Bundle["loadWindowsNodeAssetEnforcementNative"]>["pinTargets"]>;
type TokenObservation = ReturnType<TargetPins["observeHeldToken"]>;
export type WindowsNodeAssetEnforcementMode = "natural" | "natural-default" | "overflow" | "cancel" | "precreate" | "preresume" | "sharedcreate";
const MODES: readonly WindowsNodeAssetEnforcementMode[] = ["natural", "natural-default", "overflow", "cancel", "precreate", "preresume", "sharedcreate"];
export const WINDOWS_NODE_ASSET_ENFORCEMENT_EXPORTS = Object.freeze([
  "WindowsRootOnlyCommandCopy", "WindowsRootOnlyCommandCopyCleanupError", "requireWindowsCommandRootOnlyCompleted",
  "createFreshWindowsCommandCreatorProfile", "windowsCommandCreatorProfile", "closeWindowsCommandCreatorProfile", "WindowsCommandCreatorProfileCleanupError",
  "createWindowsCommandOutput", "requireWindowsCommandOutputClosed", "requireWindowsCommandOutputLaunch", "retainWindowsCommandOutput", "WindowsCommandOutputCleanupError",
  "createWindowsCommandRootOnlyStopOwner", "requireWindowsCommandRootOnlyStopped", "requireWindowsCommandRootOnlyCompletion", "WindowsCommandRootOnlyCleanupError", "windowsCommandRootOnlyFailure",
  "createFreshWindowsCommandTree", "WindowsCommandCopyCleanupError", "windowsCommandCopyNativeFailure", "loadWindowsCommandCopyProofNative", "WindowsCommandCopyProofCleanupError", "ScopedCodingFileError",
  "createWindowsNodeToolchainAssets", "WindowsNodeToolchainCleanupError", "loadWindowsNodeAssetEnforcementNative", "WindowsNodeAssetEnforcementNativeCleanupError", "loadExperimentalWindowsLpacApi",
].sort());
export const NODE_ASSET_SEED = "EMBER_NODE_ASSET_SEED\n", NODE_ASSET_CREATED = "EMBER_NODE_ASSET_CREATED\n";
export const NODE_ASSET_READY = "EMBER_NODE_ASSET_READY\n", NODE_ASSET_ERROR_READY = "EMBER_NODE_ASSET_STDERR_READY\n";
const C_OUTPUT = "EMBER_ASSET_ACCESS_V4:524287:8191:19:13:2:1\n", C_ERROR = "EMBER_ASSET_ACCESS_STDERR_V4\n", CONTROL_CREATED = "EMBER_ASSET_CONTROL_CREATED_V4\n";
const retained: unknown[] = [];
const ensure = (value: unknown): void => { if (value !== true) throw new Error("The fixed native asset observation was refused."); };
const quote = (value: string) => `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
const command = (values: readonly string[]) => Buffer.from(values.map(quote).join(" ") + "\0", "utf16le");
const ordinary = (value: unknown): string => {
  if (typeof value !== "string" || value.length < 4 || value.length > 4096 || !/^[A-Za-z]:\\/.test(value) || path.normalize(value) !== value ||
      value.includes("/") || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) || /[:<>"|?*]/.test(value.slice(2)) ||
      value.slice(3).split("\\").some(part => !part || /[:. ]$/.test(part) || part === "." || part === "..")) throw new Error();
  return value;
};
const inside = (base: string, value: string) => base.toLowerCase() === value.toLowerCase() || value.toLowerCase().startsWith(base.toLowerCase() + "\\");
/** Creation-only security for this fixed fixture. No descriptor is applied to an existing borrowed object. */
export function windowsNodeAssetCreationSecurity(owner: string, packageSid: string, mode: WindowsNodeAssetEnforcementMode) {
  ensure(/^S-1-5-(?:\d+-)*\d+$/.test(owner) && owner !== "S-1-5-18" && /^S-1-15-2-(?:\d+-)*\d+$/.test(packageSid) && packageSid !== "S-1-15-2-1" && MODES.includes(mode));
  const descriptor = (directory: boolean, grant: "host" | "read" | "full", label: "LW" | "ME" | "empty" | "absent", control = false) => {
    const flags = directory ? "OICI" : "";
    return `O:${owner}G:${owner}D:P(A;${flags};FA;;;${owner})(A;${flags};FA;;;SY)${grant === "host" ? "" : `(A;${flags};${grant === "read" ? "0x1200a9" : "FA"};;;${packageSid})`}${control ? `(A;${flags};RC;;;OW)` : ""}${label === "absent" ? "" : label === "empty" ? "S:P" : `S:(ML;${flags};NW;;;${label})`}`;
  };
  return Object.freeze({ directory: descriptor(true, "read", mode === "natural-default" ? "empty" : "ME"), tools: descriptor(true, "read", "ME"), treeParent: descriptor(true, "read", "ME"),
    privateParent: descriptor(true, "host", mode === "natural-default" ? "absent" : "ME"), lowOwner: descriptor(true, "host", "LW"),
    lowFullDirectory: descriptor(true, "full", "LW", true), lowFullFile: descriptor(false, "full", "LW", true),
    lowReadDirectory: descriptor(true, "read", "LW", true), lowReadFile: descriptor(false, "read", "LW", true), program: descriptor(false, "read", "ME") });
}
export class WindowsNodeAssetEnforcementObservationError extends Error {
  readonly preludeStage: number; readonly cExit: number; readonly errorClass: number;
  readonly probeObject: number; readonly probeRight: number; readonly probeOutcome: number;
  readonly probeMatrix: readonly number[];
  readonly tokenObserved: number; readonly tokenIntegrity: number; readonly tokenAttributes: number; readonly tokenPolicy: number;
  readonly nodeCheckpoint: number; readonly nodeInnerClass: number;
  readonly captureCheckpoint: number; readonly captureInnerClass: number;
  readonly stopStage: number; readonly stopOperation: number; readonly stopPredicate: number; readonly stopConstraint: number;
  readonly preparationOperation: number; readonly preparationObject: number; readonly preparationInnerClass: number; readonly preparationNativeFailure: number;
  constructor(readonly mode: WindowsNodeAssetEnforcementMode, readonly phase: number, preludeStage = 0, cExit = 0, errorClass = 0, probeObject = 0, probeRight = 0, probeOutcome = 0, probeMatrix: readonly number[] = [], tokenObserved = 0, tokenIntegrity = 0, tokenAttributes = 0, tokenPolicy = 0, nodeCheckpoint = 0, nodeInnerClass = 0, launchObservation?: WindowsNodeAssetLaunchObservation, preparationObservation?: WindowsNodeAssetPreparationObservation) {
    const stage = Number.isInteger(preludeStage) && preludeStage >= 0 && preludeStage <= 14 ? preludeStage : 0;
    const code = Number.isInteger(cExit) && (cExit === 49 || cExit >= 501 && cExit <= 509) ? cExit : 0;
    const kind = Number.isInteger(errorClass) && errorClass >= 0 && errorClass <= 8 ? errorClass : 0;
    const object = Number.isInteger(probeObject) && probeObject >= 1 && probeObject <= 8 ? probeObject : 0;
    const right = Number.isInteger(probeRight) && probeRight >= 1 && (probeRight <= 3 || probeRight === 4 && object >= 5) ? probeRight : 0;
    const outcome = Number.isInteger(probeOutcome) && probeOutcome >= 1 && probeOutcome <= 5 ? probeOutcome : 0;
    const matrix = Array.isArray(probeMatrix) && probeMatrix.length === 28 && probeMatrix.every(value => Number.isInteger(value) && value >= 1 && value <= 5)
      ? Object.freeze([...probeMatrix]) : Object.freeze(Array<number>(28).fill(0));
    const observed = tokenObserved === 1 ? 1 : 0;
    const integrity = observed && Number.isInteger(tokenIntegrity) && tokenIntegrity >= 0 && tokenIntegrity <= 7 ? tokenIntegrity : 0;
    const attributes = observed && Number.isInteger(tokenAttributes) && tokenAttributes >= 0 && tokenAttributes <= 2 ? tokenAttributes : 0;
    const policy = observed && Number.isInteger(tokenPolicy) && tokenPolicy >= 0 && tokenPolicy <= 4 ? tokenPolicy : 0;
    const node = Number.isInteger(nodeCheckpoint) && nodeCheckpoint >= 0 && nodeCheckpoint <= 7 ? nodeCheckpoint : 0;
    const inner = Number.isInteger(nodeInnerClass) && nodeInnerClass >= 0 && nodeInnerClass <= 8 ? nodeInnerClass : 0;
    const launch = boundedWindowsNodeAssetLaunchObservation(launchObservation);
    const preparation = boundedWindowsNodeAssetPreparationObservation(preparationObservation);
    super(`The fixed native Node asset witness was refused in ${mode} at phase ${phase} (prelude ${stage}, C exit ${code}, error class ${kind}, probe ${object}/${right}/${outcome}, matrix ${matrix.join("")}, C token ${observed}/${integrity}/${attributes}/${policy}, Node checkpoint ${node}/${inner}, capture ${launch.captureCheckpoint}/${launch.captureInnerClass}, Stop ${launch.stopStage}/${launch.stopOperation}/${launch.stopPredicate}/${launch.stopConstraint}, preparation ${preparation.operation}/${preparation.object}/${preparation.innerClass}/${preparation.nativeFailure}).`);
    this.preludeStage = stage; this.cExit = code; this.errorClass = kind;
    this.probeObject = object; this.probeRight = right; this.probeOutcome = outcome;
    this.probeMatrix = matrix;
    this.tokenObserved = observed; this.tokenIntegrity = integrity; this.tokenAttributes = attributes; this.tokenPolicy = policy;
    this.nodeCheckpoint = node; this.nodeInnerClass = inner;
    this.captureCheckpoint = launch.captureCheckpoint; this.captureInnerClass = launch.captureInnerClass;
    this.stopStage = launch.stopStage; this.stopOperation = launch.stopOperation; this.stopPredicate = launch.stopPredicate; this.stopConstraint = launch.stopConstraint;
    this.preparationOperation = preparation.operation; this.preparationObject = preparation.object; this.preparationInnerClass = preparation.innerClass; this.preparationNativeFailure = preparation.nativeFailure;
    this.name = "WindowsNodeAssetEnforcementObservationError"; this.stack = `${this.name}: ${this.message}`;
  }
}

export interface WindowsNodeAssetPreparationObservation { operation: number; object: number; innerClass: number; nativeFailure: number }
function boundedWindowsNodeAssetPreparationObservation(source: WindowsNodeAssetPreparationObservation | undefined): WindowsNodeAssetPreparationObservation {
  const result = { operation: 0, object: 0, innerClass: 0, nativeFailure: 0 };
  try {
    for (const [key, maximum] of [["operation", 13], ["object", 10], ["innerClass", 8], ["nativeFailure", 4]] as const) {
      const property = source && Object.getOwnPropertyDescriptor(source, key), value = property && "value" in property ? property.value : 0;
      result[key] = Number.isInteger(value) && value >= 0 && value <= maximum ? value : 0;
    }
    return result;
  } catch { return { operation: 0, object: 0, innerClass: 0, nativeFailure: 0 }; }
}

export interface WindowsNodeAssetLaunchObservation {
  captureCheckpoint: number; captureInnerClass: number;
  stopStage: number; stopOperation: number; stopPredicate: number; stopConstraint: number;
}
export function windowsNodeAssetLaunchObservation(): WindowsNodeAssetLaunchObservation {
  return { captureCheckpoint: 0, captureInnerClass: 0, stopStage: 0, stopOperation: 0, stopPredicate: 0, stopConstraint: 0 };
}
function boundedWindowsNodeAssetLaunchObservation(source: WindowsNodeAssetLaunchObservation | undefined): WindowsNodeAssetLaunchObservation {
  const result = windowsNodeAssetLaunchObservation();
  try {
    for (const [key, maximum] of [["captureCheckpoint", 2], ["captureInnerClass", 8], ["stopStage", 14], ["stopOperation", 7], ["stopPredicate", 11], ["stopConstraint", 21]] as const) {
      const property = source && Object.getOwnPropertyDescriptor(source, key), value = property && "value" in property ? property.value : 0;
      result[key] = Number.isInteger(value) && value >= 0 && value <= maximum ? value : 0;
    }
    return result;
  } catch { return windowsNodeAssetLaunchObservation(); }
}

/** V4 admits the same observed held C token before the trusted attester can return to Resume. */
export function requireWindowsNodeAssetHeldToken(loaded: Pick<Bundle, "requireWindowsCommandOutputLaunch">,
  pins: Pick<TargetPins, "requireTokenObservation">, observation: TokenObservation, launch: WindowsCommandOutputLaunchRef): void {
  loaded.requireWindowsCommandOutputLaunch(launch);
  const facts = pins.requireTokenObservation(observation, launch);
  ensure(facts.integrity === 2 && facts.attributes === 2 && facts.policy === 1);
}

/** Read-only token diagnostics require the same genuine completed/closed run before touching the private observation. */
export function requireWindowsNodeAssetTokenFacts(loaded: Pick<Bundle, "requireWindowsCommandRootOnlyCompleted" | "requireWindowsCommandOutputClosed">,
  input: { completed: unknown; closed: unknown; run: WindowsCommandRootOnlyRunRef; launch: WindowsCommandOutputLaunchRef;
    observedRun: WindowsCommandRootOnlyRunRef; observedLaunch: WindowsCommandOutputLaunchRef; observation: TokenObservation; pins: Pick<TargetPins, "requireTokenObservation"> }) {
  loaded.requireWindowsCommandRootOnlyCompleted(input.completed, input.run); loaded.requireWindowsCommandOutputClosed(input.closed, input.launch, input.run);
  ensure(input.observedRun === input.run && input.observedLaunch === input.launch);
  return input.pins.requireTokenObservation(input.observation, input.launch);
}

/** Diagnostic only. An authentic exact-run completion does not certify output closure or permit disposal. */
export function windowsNodeAssetPreludeExit(loaded: Pick<Bundle, "requireWindowsCommandRootOnlyCompleted">, completed: unknown, run: WindowsCommandRootOnlyRunRef): number {
  const value = loaded.requireWindowsCommandRootOnlyCompleted(completed, run), code = value.exitCode;
  return value.outcome === "natural-exit" && typeof code === "number" && Number.isInteger(code) && (code === 49 || code >= 501 && code <= 509) ? code : 0;
}
/** Fixed failure tuple only, authenticated after genuine completion and output closure. Never a success or disposal receipt. */
export function windowsNodeAssetPreludeProbe(loaded: Pick<Bundle, "requireWindowsCommandRootOnlyCompleted" | "requireWindowsCommandOutputClosed">,
  input: { completed: unknown; closed: unknown; run: WindowsCommandRootOnlyRunRef; launch: WindowsCommandOutputLaunchRef; stderr: Buffer }) {
  const completed = loaded.requireWindowsCommandRootOnlyCompleted(input.completed, input.run), closed = loaded.requireWindowsCommandOutputClosed(input.closed, input.launch, input.run);
  const unknown = () => Object.freeze({ object: 0, right: 0, outcome: 0, matrix: Object.freeze(Array<number>(28).fill(0)) });
  if (completed.outcome !== "natural-exit" || completed.exitCode !== 505 || !closed.complete || closed.reason !== "none" || closed.stdoutBytes !== 0) return unknown();
  const frame = input.stderr, prefix = Buffer.from("EMBER_ASSET_PROBE_V4:"), offset = prefix.length, matrixPrefix = Buffer.from("EMBER_ASSET_MATRIX_V4:"),
    matrixStart = offset + 6, matrixOffset = matrixStart + matrixPrefix.length;
  if (closed.stderrBytes !== frame.length || frame.length !== matrixOffset + 29 || !frame.subarray(0, offset).equals(prefix) ||
      frame[offset + 1] !== 58 || frame[offset + 3] !== 58 || frame[offset + 5] !== 10) return unknown();
  const object = frame[offset] - 48, right = frame[offset + 2] - 48, outcome = frame[offset + 4] - 48;
  if (object < 1 || object > 8 || right < 1 || right > 4 || right === 4 && object < 5 || outcome < 1 || outcome > 5) return unknown();
  if (!frame.subarray(matrixStart, matrixOffset).equals(matrixPrefix) || frame[matrixOffset + 28] !== 10) return unknown();
  const matrix = [...frame.subarray(matrixOffset, matrixOffset + 28)].map(value => value - 48);
  if (matrix.some(value => value < 1 || value > 5)) return unknown();
  return Object.freeze({ object, right, outcome, matrix: Object.freeze(matrix) });
}
type DiagnosticClasses = Pick<Bundle, "WindowsRootOnlyCommandCopyCleanupError" | "WindowsCommandCopyCleanupError" | "WindowsCommandRootOnlyCleanupError" |
  "WindowsCommandOutputCleanupError" | "WindowsCommandCreatorProfileCleanupError" | "WindowsCommandCopyProofCleanupError" |
  "WindowsNodeAssetEnforcementNativeCleanupError" | "WindowsNodeToolchainCleanupError">;
/** The exact emitted constructors identify a bounded class; names/messages/causes never enter the projection. */
export const windowsNodeAssetErrorClass = (loaded: DiagnosticClasses | undefined, error: unknown): number => {
  if (!loaded) return 0;
  try {
    const classes = [loaded.WindowsRootOnlyCommandCopyCleanupError, loaded.WindowsCommandCopyCleanupError, loaded.WindowsCommandRootOnlyCleanupError,
      loaded.WindowsCommandOutputCleanupError, loaded.WindowsCommandCreatorProfileCleanupError, loaded.WindowsCommandCopyProofCleanupError,
      loaded.WindowsNodeAssetEnforcementNativeCleanupError, loaded.WindowsNodeToolchainCleanupError];
    const index = classes.findIndex(type => error instanceof type); return index < 0 ? 0 : index + 1;
  } catch { return 0; }
};

/** Only fixed source-generated message shapes become an enum; neither text nor native status leaves this helper. */
export function windowsNodeAssetPreparationNativeFailure(error: unknown): number {
  try {
    if (!types.isNativeError(error)) return 0;
    const property = Object.getOwnPropertyDescriptor(error, "message"), message = property && "value" in property ? property.value : undefined;
    if (typeof message !== "string") return 0;
    if (message === "CreateDirectoryW failed (Windows error 1314).") return 1;
    if (message === "CreateDirectoryW failed (Windows error 5).") return 2;
    const match = /^(ConvertStringSecurityDescriptorToSecurityDescriptorW|CreateDirectoryW) failed \(Windows error (0|[1-9][0-9]{0,9})\)\.$/.exec(message);
    if (!match || Number(match[2]) > 0xffffffff) return 0;
    return match[1] === "ConvertStringSecurityDescriptorToSecurityDescriptorW" ? 3 : 4;
  } catch { return 0; }
}

/** Runs inside the existing proof guard so the original exception is observed before that guard wraps it. */
export function observeWindowsNodeAssetPreparation<T>(loaded: DiagnosticClasses | undefined, state: WindowsNodeAssetPreparationObservation,
  operation: number, object: number, action: () => T): T {
  try { state.operation = operation; state.object = object; state.innerClass = 0; state.nativeFailure = 0; } catch { /* Diagnostic storage cannot prevent the original operation. */ }
  try { return action(); }
  catch (error) {
    let kind = 0; try { kind = windowsNodeAssetErrorClass(loaded, error); } catch { /* Unknown classification stays zero. */ }
    try { state.innerClass = kind; state.nativeFailure = windowsNodeAssetPreparationNativeFailure(error); } catch { /* Preserve the original exception for the existing guard. */ }
    throw error;
  }
}

/** Synchronous observation only: the original result or identical thrown value remains authoritative. */
export function observeWindowsNodeAssetNodeCall<T>(loaded: DiagnosticClasses | undefined, state: { checkpoint: number; innerClass: number },
  entered: number, returned: number, operation: () => T): T {
  try { state.checkpoint = entered; } catch { /* Diagnostic storage cannot prevent the original call. */ }
  try {
    const result = operation();
    try { state.checkpoint = returned; } catch { /* Observation grants no execution or disposal authority. */ }
    return result;
  } catch (error) {
    let kind = 0; try { kind = windowsNodeAssetErrorClass(loaded, error); } catch { /* Unknown classification stays zero. */ }
    try { state.innerClass = kind; } catch { /* Preserve the identical original error even if observation fails. */ }
    throw error;
  }
}

/** This wrapper observes the real promise and authenticates its real opaque return before signalling. */
export function observeWindowsNodeAssetStop(owner: WindowsCommandRootOnlyStopOwner, binding: object,
  authenticate: Bundle["requireWindowsCommandRootOnlyStopped"], observed: (ref: WindowsCommandRootOnlyStoppedRef, binding: object) => void,
  readers?: DiagnosticClasses & Pick<Bundle, "windowsCommandRootOnlyFailure">, state?: WindowsNodeAssetLaunchObservation): WindowsCommandRootOnlyStopOwner {
  const launch = readers && state ? { launch(...args: Parameters<WindowsCommandRootOnlyStopOwner["launch"]>) {
    const capture = args[3], forwarded: Parameters<WindowsCommandRootOnlyStopOwner["launch"]> = [...args];
    const observeFailure = (error: unknown): void => {
      try {
        const facts = readers.windowsCommandRootOnlyFailure(error); if (!facts) return;
        const values = [facts.stage, facts.operation, facts.predicate, facts.constraint], maxima = [14, 7, 11, 21];
        if (values.some((value, index) => !Number.isInteger(value) || value < 0 || value > maxima[index])) return;
        state.stopStage = values[0]; state.stopOperation = values[1]; state.stopPredicate = values[2]; state.stopConstraint = values[3];
      } catch { /* A passive projection cannot replace the real launch result or error. */ }
    };
    const wrapped = typeof capture !== "function" ? capture : (witness: Parameters<NonNullable<typeof capture>>[0]) => {
      try { state.captureCheckpoint = 1; } catch { /* Observation cannot prevent the original callback. */ }
      try {
        const result = capture(witness);
        try { state.captureCheckpoint = 2; } catch { /* Preserve even an invalid non-undefined return for Stop's original guard. */ }
        return result;
      } catch (error) {
        let kind = 0; try { kind = windowsNodeAssetErrorClass(readers, error); } catch { /* Unknown classification stays zero. */ }
        try { state.captureInnerClass = kind; } catch { /* Preserve the identical original exception. */ }
        throw error;
      }
    };
    if (typeof capture === "function") forwarded[3] = wrapped;
    let pending: ReturnType<WindowsCommandRootOnlyStopOwner["launch"]>;
    try { pending = owner.launch(...forwarded); }
    catch (error) { observeFailure(error); throw error; }
    try { void pending.then(undefined, error => { observeFailure(error); }); }
    catch { /* Even observer attachment failure leaves the original promise untouched. */ }
    return pending;
  } } : {};
  return Object.freeze({ ...owner, ...launch, stop(...args: Parameters<WindowsCommandRootOnlyStopOwner["stop"]>) {
    const pending = owner.stop(...args);
    void pending.then(ref => { authenticate(ref, binding); observed(ref, binding); }).catch(() => undefined);
    return pending;
  } });
}

/** Bytes never leave the private fixture. Genuine exact-run completion/closure must authenticate every fact. */
export function requireWindowsNodeAssetOutputFacts(loaded: Pick<Bundle, "requireWindowsCommandRootOnlyCompleted" | "requireWindowsCommandOutputClosed">,
  input: { mode: Exclude<WindowsNodeAssetEnforcementMode, "precreate" | "natural-default"> | "prelude"; completed: unknown; closed: unknown; run: WindowsCommandRootOnlyRunRef;
    launch: WindowsCommandOutputLaunchRef; stdout: Buffer; stderr: Buffer }) {
  ensure(["prelude", "natural", "overflow", "cancel", "preresume", "sharedcreate"].includes(input.mode));
  const completed = loaded.requireWindowsCommandRootOnlyCompleted(input.completed, input.run), output = loaded.requireWindowsCommandOutputClosed(input.closed, input.launch, input.run);
  ensure(input.stdout.length + input.stderr.length <= 256 * 1024 && output.stdoutBytes === input.stdout.length && output.stderrBytes === input.stderr.length);
  if (input.mode === "prelude") {
    ensure(completed.outcome === "natural-exit" && completed.exitCode === 49 && output.complete && output.reason === "none" &&
      input.stdout.equals(Buffer.from(C_OUTPUT)) && input.stderr.equals(Buffer.from(C_ERROR)));
  } else if (input.mode === "preresume" || input.mode === "sharedcreate") {
    ensure(completed.outcome === "cancelled" && completed.exitCode === null && !output.complete && output.reason === "cancelled" && input.stdout.length === 0 && input.stderr.length === 0);
  } else {
    ensure(input.stdout.subarray(0, Buffer.byteLength(NODE_ASSET_READY)).equals(Buffer.from(NODE_ASSET_READY)) &&
      input.stderr.subarray(0, Buffer.byteLength(NODE_ASSET_ERROR_READY)).equals(Buffer.from(NODE_ASSET_ERROR_READY)));
    if (input.mode === "natural") {
      const out = Buffer.concat([Buffer.from(NODE_ASSET_READY), Buffer.alloc(73728, 79), Buffer.from("\nEMBER_NODE_ASSET_DONE\n")]);
      const err = Buffer.concat([Buffer.from(NODE_ASSET_ERROR_READY), Buffer.alloc(67584, 69), Buffer.from("\nEMBER_NODE_ASSET_STDERR_DONE\n")]);
      try { ensure(completed.outcome === "natural-exit" && completed.exitCode === 17 && output.complete && output.reason === "none" && input.stdout.equals(out) && input.stderr.equals(err)); }
      finally { out.fill(0); err.fill(0); }
    } else {
      ensure(completed.outcome === "cancelled" && completed.exitCode === null && !output.complete && output.reason === (input.mode === "overflow" ? "overflow" : "cancelled"));
      ensure(input.stderr.equals(Buffer.from(NODE_ASSET_ERROR_READY)));
      if (input.mode === "cancel") ensure(input.stdout.equals(Buffer.from(NODE_ASSET_READY)));
      else { const body = input.stdout.subarray(Buffer.byteLength(NODE_ASSET_READY)); ensure(body.length > 0 && body.every(byte => byte === 88)); }
    }
  }
  return Object.freeze({ exitCode: completed.exitCode, reason: output.reason, complete: output.complete, stdoutBytes: output.stdoutBytes, stderrBytes: output.stderrBytes });
}

export interface WindowsNodeAssetEnforcementDependencies {
  load(file: string): Bundle;
  files?: Pick<typeof fs, "lstatSync" | "realpathSync" | "readdirSync" | "readFileSync" | "unlinkSync" | "rmdirSync" | "existsSync">;
  managedTemporary?(): string; id?(): string; now?(): number; pause?(): Promise<void>;
}
/** Portable observation seam only. The exported production observer below supplies the actual emitted graph. */
export function bindWindowsNodeAssetEnforcement(dependencies: WindowsNodeAssetEnforcementDependencies) {
  const files = dependencies.files ?? fs, now = dependencies.now ?? (() => performance.now()), pause = dependencies.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 5)));
  let terminal: WindowsNodeAssetEnforcementObservationError | undefined, busy = false;
  return async (asset: Asset, verifyBuild: () => void, resources: string, scratchParent: string, mode: WindowsNodeAssetEnforcementMode) => {
    if (terminal) throw terminal;
    if (busy || !MODES.includes(mode)) { terminal = new WindowsNodeAssetEnforcementObservationError(MODES.includes(mode) ? mode : "natural", 1); throw terminal; }
    busy = true;
    const nodeObservation = { checkpoint: 0, innerClass: 0 }; let launchObservation = windowsNodeAssetLaunchObservation();
    let preparationObservation: WindowsNodeAssetPreparationObservation = { operation: 0, object: 0, innerClass: 0, nativeFailure: 0 };
    let phase = 1, preludeStage = 0, cExit = 0, probe: Readonly<{ object: number; right: number; outcome: number; matrix: readonly number[] }> = { object: 0, right: 0, outcome: 0, matrix: Object.freeze(Array<number>(28).fill(0)) },
      tokenObserved = 0, tokenFacts: Readonly<{ integrity: number; attributes: number; policy: number }> = { integrity: 0, attributes: 0, policy: 0 },
      heldToken: Readonly<{ ref: TokenObservation; launch: WindowsCommandOutputLaunchRef }> | undefined,
      loaded: Bundle | undefined, proof: ReturnType<Bundle["loadWindowsCommandCopyProofNative"]> | undefined,
      security: ReturnType<Bundle["loadWindowsNodeAssetEnforcementNative"]> | undefined,
      targetPins: ReturnType<ReturnType<Bundle["loadWindowsNodeAssetEnforcementNative"]>["pinTargets"]> | undefined,
      api: ReturnType<Bundle["loadExperimentalWindowsLpacApi"]> | undefined, profile: ReturnType<Bundle["createFreshWindowsCommandCreatorProfile"]> | undefined,
      node: Awaited<ReturnType<Bundle["createWindowsNodeToolchainAssets"]>> | undefined, copy: WindowsRootOnlyCommandCopy | undefined,
      io: ReturnType<Bundle["createWindowsCommandOutput"]> | undefined, launch: WindowsCommandOutputLaunchRef | undefined,
      script: Buffer | undefined, directory = "", live = true, assetCurrent = true, profileClosed = false;
    const pins: WindowsCommandCopyProofPin[] = [], directories: WindowsHandle[] = [], owners: WindowsCommandRootOnlyStopOwner[] = [], launches: WindowsCommandOutputLaunchRef[] = [];
    const output: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] }, totals = { stdout: 0, stderr: 0 }, abort = new AbortController(), assetAbort = new AbortController(), sharedAbort = new AbortController();
    let stopped: { ref: WindowsCommandRootOnlyStoppedRef; binding: object } | undefined;
    const controlReaders: WindowsCommandCopyProofPin[] = [];
    const graph = { asset, verifyBuild, resources, mode, pins, controlReaders, directories, owners, launches, output, abort, assetAbort, sharedAbort,
      get loaded() { return loaded; }, get proof() { return proof; }, get security() { return security; }, get targetPins() { return targetPins; }, get api() { return api; },
      get profile() { return profile; }, get node() { return node; }, get copy() { return copy; }, get io() { return io; }, get script() { return script; }, get directory() { return directory; },
      get heldToken() { return heldToken; } };
    const current = () => live && !terminal && proof?.unsafe !== true && security?.unsafe !== true && !profileClosed;
    const workCurrent = () => current() && !sharedAbort.signal.aborted;
    const guarded = <T>(fn: () => T): T => { ensure(current()); const result = fn(); ensure(current()); return result; };
    const native = <T>(fn: () => T): T => guarded(() => proof!.guard(fn));
    const preparation = <T>(operation: number, object: number, fn: () => T): T => native(() => observeWindowsNodeAssetPreparation(loaded, preparationObservation, operation, object, fn));
    const checkPins = () => { for (const pin of pins) guarded(() => pin.unchanged()); };
    const verified = () => { ensure(guarded(verifyBuild) === undefined); checkPins(); };
    const wait = async (condition: () => boolean, budget: number) => {
      let previous = guarded(now); ensure(Number.isFinite(previous) && previous >= 0); const deadline = previous + budget;
      for (;;) { const tick = guarded(now); ensure(Number.isFinite(tick) && tick >= previous && tick <= deadline); previous = tick;
        if (guarded(condition)) return; ensure(tick < deadline); await pause(); }
    };
    const collect = (bytes: Uint8Array, stream: "stdout" | "stderr") => { ensure(current() && bytes.byteLength > 0 && totals.stdout + totals.stderr + bytes.byteLength <= 256 * 1024); totals[stream] += bytes.byteLength; output[stream].push(Buffer.from(bytes)); };
    const clearOutput = () => { for (const stream of ["stdout", "stderr"] as const) { for (const bytes of output[stream]) bytes.fill(0); output[stream] = []; totals[stream] = 0; } };
    const facts = (kind: Exclude<WindowsNodeAssetEnforcementMode, "precreate" | "natural-default"> | "prelude", completed: unknown, closed: unknown, run: WindowsCommandRootOnlyRunRef) => {
      const stdout = Buffer.concat(output.stdout), stderr = Buffer.concat(output.stderr);
      try { ensure(launch !== undefined); return requireWindowsNodeAssetOutputFacts(loaded!, { mode: kind, completed, closed, run, launch: launch!, stdout, stderr }); }
      finally { stdout.fill(0); stderr.fill(0); clearOutput(); }
    };
    try {
      for (const value of [asset.executable, asset.module, asset.program, resources, scratchParent]) ordinary(value);
      for (const file of [asset.executable, asset.module, asset.program, resources]) ensure(!inside(scratchParent, file) && !inside(file, scratchParent));
      const ancestry = (file: string) => { for (let here = file;;) { const value = guarded(() => files.lstatSync(here)); ensure(value.isDirectory() && !value.isSymbolicLink()); const next = path.dirname(here); if (next === here) break; here = next; } };
      ancestry(scratchParent); ensure(guarded(() => files.realpathSync.native(scratchParent)).toLowerCase() === scratchParent.toLowerCase());
      const managed = ordinary(guarded(dependencies.managedTemporary ?? (() => os.tmpdir()))); ancestry(managed); ensure(!inside(scratchParent, managed) && !inside(managed, scratchParent));
      verified(); loaded = guarded(() => dependencies.load(asset.module));
      ensure(Object.keys(loaded).sort().join("|") === WINDOWS_NODE_ASSET_ENFORCEMENT_EXPORTS.join("|") && Object.values(loaded).every(value => typeof value === "function"));
      proof = guarded(() => loaded!.loadWindowsCommandCopyProofNative()); security = native(() => loaded!.loadWindowsNodeAssetEnforcementNative());
      for (const file of [asset.module, asset.executable, asset.program]) pins.push(native(() => proof!.pin(file, 16 * 1024 * 1024))); verified();
      phase = 2; api = preparation(1, 0, () => loaded!.loadExperimentalWindowsLpacApi()); profile = preparation(2, 0, () => loaded!.createFreshWindowsCommandCreatorProfile());
      const selected = preparation(3, 0, () => loaded!.windowsCommandCreatorProfile(profile!)), owner = preparation(4, 0, () => api!.ownerSid());
      const id = guarded(dependencies.id ?? randomUUID); ensure(typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)); directory = path.join(scratchParent, `ember-node-asset-${id}`);
      const tools = path.join(directory, "tools"), treeParent = path.join(directory, "trees"), privateParent = path.join(directory, "assets"),
        lowOwner = path.join(directory, "low-owner"), lowFullDirectory = path.join(directory, "low-full"), lowFullFile = path.join(lowFullDirectory, "full-file.txt"),
        lowReadDirectory = path.join(directory, "low-read"), lowReadFile = path.join(lowReadDirectory, "full-file.txt"), program = path.join(tools, "access-proof.exe");
      const creation = windowsNodeAssetCreationSecurity(owner, selected.sidText, mode);
      for (const [index, [folder, descriptor]] of ([[directory, creation.directory], [tools, creation.tools], [treeParent, creation.treeParent], [privateParent, creation.privateParent],
        [lowOwner, creation.lowOwner], [lowFullDirectory, creation.lowFullDirectory], [lowReadDirectory, creation.lowReadDirectory]] as const).entries()) {
        preparation(5, index + 1, () => api!.createDirectory(folder, descriptor)); directories.push(preparation(6, index + 1, () => api!.pinDirectory(folder)));
      }
      preparation(7, 8, () => api!.writeNewFile(lowFullFile, Buffer.from("EMBER_ASSET_CONTROL\n"), creation.lowFullFile));
      preparation(7, 9, () => api!.writeNewFile(lowReadFile, Buffer.from("EMBER_ASSET_CONTROL\n"), creation.lowReadFile));
      const bytes = preparation(8, 0, () => pins[1].read()); try { preparation(9, 10, () => api!.writeNewFile(program, bytes, creation.program)); } finally { bytes.fill(0); }
      pins.push(preparation(10, 10, () => proof!.pin(program, 16 * 1024 * 1024))); const copied = preparation(11, 10, () => pins[3].read()), original = preparation(12, 0, () => pins[1].read());
      try { ensure(copied.equals(original)); } finally { copied.fill(0); original.fill(0); }
      script = preparation(13, 0, () => pins[2].read());
      preparationObservation = { operation: 0, object: 0, innerClass: 0, nativeFailure: 0 };
      phase = 3; node = await loaded.createWindowsNodeToolchainAssets({ resourcesPath: resources, privateParent, profile,
        signal: AbortSignal.any([assetAbort.signal, sharedAbort.signal]), current: () => workCurrent() && assetCurrent });
      verified(); const roots = guarded(() => files.readdirSync(privateParent)); ensure(roots.length === 1 && /^ember-node-[0-9a-f-]{36}$/.test(String(roots[0])));
      const root = ordinary(path.join(privateParent, String(roots[0]))), image = ordinary(path.join(root, "node.exe")); ensure(guarded(() => files.readdirSync(root)).join("|") === "node.exe");
      targetPins = native(() => security!.pinTargets({ parent: privateParent, root, image, lowOwner, lowFullDirectory, lowFullFile, lowReadDirectory, lowReadFile, ownerSid: owner, packageSid: selected.sidText,
        parentLabel: mode === "natural-default" ? "default" : "explicit" }));
      const checkControlBytes = () => {
        native(() => targetPins!.recheck());
        for (const file of [lowFullFile, lowReadFile]) {
          const pin = native(() => proof!.pin(file, 20)); controlReaders.push(pin);
          const bytes = native(() => pin.read());
          try { ensure(bytes.equals(Buffer.from("EMBER_ASSET_CONTROL\n"))); } finally { bytes.fill(0); }
          native(() => pin.close()); controlReaders.pop();
        }
        native(() => targetPins!.recheck());
      };
      copy = await loaded.WindowsRootOnlyCommandCopy.create({ parent: treeParent, protectedPaths: [tools, privateParent, lowOwner, lowFullDirectory, lowReadDirectory, resources, path.dirname(asset.module)],
        entries: [{ path: "seed.txt", kind: "file", bytes: Buffer.from(NODE_ASSET_SEED), executable: false }, { path: "proof.cjs", kind: "file", bytes: script, executable: false }],
        creatorProfile: profile, packageSid: selected.sidText, current: workCurrent, packageCurrent: workCurrent, reviewCurrent: current }, { api,
        createStopOwner(binding) { const observation = windowsNodeAssetLaunchObservation(); launchObservation = observation;
          const actual = native(() => loaded!.createWindowsCommandRootOnlyStopOwner(binding, api!)); owners.push(actual);
          return observeWindowsNodeAssetStop(actual, binding, loaded!.requireWindowsCommandRootOnlyStopped, (ref, exact) => { stopped = { ref, binding: exact }; }, loaded!, observation); } });
      const authenticateStop = (present: 0 | 1) => { ensure(stopped !== undefined); loaded!.requireWindowsCommandRootOnlyStopped(stopped!.ref, stopped!.binding);
        ensure(loaded!.requireWindowsCommandRootOnlyCompletion(stopped!.ref, stopped!.binding).rootPresent === present); };
      let prelude = 0;
      if (mode === "natural" || mode === "natural-default") {
        checkControlBytes();
        phase = 4; preludeStage = 1; io = native(() => loaded!.createWindowsCommandOutput(profile!, { signal: abort.signal, timeoutMs: 8_000, output: collect }));
        const line = command([program, privateParent, root, image, lowOwner, lowFullDirectory, lowFullFile, lowReadDirectory, lowReadFile]);
        let run: WindowsCommandRootOnlyRunRef;
        preludeStage = 2;
        try { run = await copy.launchRootOnlyWithOutput(context => { preludeStage = 3; launch = io!.createSuspended(context, program, line); launches.push(launch); return launch; }, held => {
          preludeStage = 4; native(() => api!.verifyToken(selected, held.process));
          ensure(launch !== undefined && heldToken === undefined); const exact = loaded!.requireWindowsCommandOutputLaunch(launch!);
          ensure(exact.root.process === held.process && exact.root.thread === held.thread && exact.root.pid === held.pid &&
            exact.heldPiHandles.length === 2 && exact.heldPiHandles[0] === held.process && exact.heldPiHandles[1] === held.thread);
          heldToken = Object.freeze({ ref: native(() => targetPins!.observeHeldToken(held.process, held.thread, held.pid, launch!)), launch: launch! });
          native(() => requireWindowsNodeAssetHeldToken(loaded!, targetPins!, heldToken!.ref, launch!));
          preludeStage = 5; native(() => proof!.image(held.process, held.pid, program)); preludeStage = 6; checkPins(); }); }
        finally { line.fill(0); }
        ensure(heldToken !== undefined && heldToken.launch === launch);
        const tokenBinding = Object.freeze({ ...heldToken!, run });
        preludeStage = 7; const done = await copy.completeRootOnly(run, io.signal);
        preludeStage = 8; cExit = windowsNodeAssetPreludeExit(loaded, done, run);
        preludeStage = 9; const closed = await io.closeOutputAfterStopped(done, run);
        preludeStage = 10; authenticateStop(1);
        tokenFacts = native(() => requireWindowsNodeAssetTokenFacts(loaded!, { completed: done, closed, run, launch: launch!, observedRun: tokenBinding.run,
          observedLaunch: tokenBinding.launch, observation: tokenBinding.ref, pins: targetPins! })); tokenObserved = 1;
        const failureBytes = Buffer.concat(output.stderr);
        try { probe = windowsNodeAssetPreludeProbe(loaded, { completed: done, closed, run, launch: launch!, stderr: failureBytes }); }
        finally { failureBytes.fill(0); }
        preludeStage = 11; facts("prelude", done, closed, run);
        preludeStage = 12; checkControlBytes(); preludeStage = 13; const created = guarded(() => files.readFileSync(path.join(lowFullDirectory, "access-create.txt")));
        try { ensure(created.equals(Buffer.from(CONTROL_CREATED))); } finally { created.fill(0); }
        preludeStage = 14; prelude = 1; stopped = undefined; launch = undefined; io = undefined;
      }
      launchObservation = windowsNodeAssetLaunchObservation();
      phase = 5; verified(); native(() => targetPins!.recheck());
      nodeObservation.checkpoint = 1;
      let result: Readonly<{ exitCode: number | null; reason: string; complete: boolean; stdoutBytes: number; stderrBytes: number }>;
      if (mode === "precreate") {
        let rejected = false;
        try { await copy.launchRootOnlyWithOutput(context => { assetCurrent = false; return observeWindowsNodeAssetNodeCall(loaded, nodeObservation, 2, 3,
          () => node!.createSuspended(context, ["--preserve-symlinks", "--preserve-symlinks-main", "proof.cjs", "cancel"], { signal: abort.signal, timeoutMs: 8_000, output: collect })); }, () => undefined); }
        catch (error) { ensure(error instanceof loaded.ScopedCodingFileError && error.code === "cancelled"); rejected = true; }
        ensure(rejected && launch === undefined); authenticateStop(0); result = Object.freeze({ exitCode: null, reason: "cancelled", complete: false, stdoutBytes: 0, stderrBytes: 0 });
      } else {
        const payloadMode = mode === "preresume" || mode === "sharedcreate" ? "cancel" : mode === "natural-default" ? "natural" : mode;
        const run = await copy.launchRootOnlyWithOutput(context => { launch = observeWindowsNodeAssetNodeCall(loaded, nodeObservation, 2, 3,
          () => node!.createSuspended(context, ["--preserve-symlinks", "--preserve-symlinks-main", "proof.cjs", payloadMode], { signal: abort.signal, timeoutMs: 8_000, output: collect }));
          launches.push(launch); if (mode === "sharedcreate") sharedAbort.abort(); return launch; }, held => {
          observeWindowsNodeAssetNodeCall(loaded, nodeObservation, 4, 5, () => native(() => proof!.image(held.process, held.pid, image)));
          observeWindowsNodeAssetNodeCall(loaded, nodeObservation, 5, 6, checkPins); if (mode === "preresume") assetCurrent = false; });
        nodeObservation.checkpoint = 7;
        if (mode === "preresume" || mode === "sharedcreate") authenticateStop(1);
        if (mode === "cancel") { await wait(() => totals.stdout >= Buffer.byteLength(NODE_ASSET_READY) && totals.stderr >= Buffer.byteLength(NODE_ASSET_ERROR_READY), 5_000);
          const out = Buffer.concat(output.stdout), err = Buffer.concat(output.stderr); try { ensure(out.equals(Buffer.from(NODE_ASSET_READY)) && err.equals(Buffer.from(NODE_ASSET_ERROR_READY))); } finally { out.fill(0); err.fill(0); }
          abort.abort(); }
        if (mode === "overflow" || mode === "cancel") await wait(() => stopped !== undefined, 15_000);
        // Overflow/cancellation cannot call completeRootOnly as a rescue for a missing real automatic Stop.
        phase = 6; const done = await copy.completeRootOnly(run, mode === "sharedcreate" ? sharedAbort.signal : abort.signal), closed = await node.finishOutput(done, run, launch!); authenticateStop(1); result = facts(mode === "natural-default" ? "natural" : mode, done, closed, run);
      }
      native(() => targetPins!.recheck()); verified(); phase = 7;
      const snapshot = async (entries: readonly import("../../app/main/agent/coding-result-export").CodingExportEntry[]) => {
        ensure(entries.length === (mode === "natural" || mode === "natural-default" ? 3 : 2));
        for (const entry of entries) { ensure(entry.kind === "file" && !entry.executable && ["seed.txt", "proof.cjs", ...(mode === "natural" || mode === "natural-default" ? ["created.txt"] : [])].includes(entry.path));
          if (entry.kind === "file") ensure(entry.bytes.equals(entry.path === "proof.cjs" ? script! : Buffer.from(entry.path === "seed.txt" ? NODE_ASSET_SEED : NODE_ASSET_CREATED))); }
      };
      if (mode === "natural" || mode === "natural-default") await copy.files(snapshot); else await copy.review(snapshot);
      await copy.close(); ensure(guarded(() => files.readdirSync(treeParent)).length === 0);
      native(() => targetPins!.close()); targetPins = undefined; await node.close(); node = undefined; ensure(guarded(() => files.readdirSync(privateParent)).length === 0); verified();
      phase = 8; for (const pin of pins.slice().reverse()) native(() => pin.close());
      for (const handle of directories.slice().reverse()) native(() => api!.close(handle));
      native(() => loaded!.closeWindowsCommandCreatorProfile(profile!)); profileClosed = true;
      ensure(files.readdirSync(tools).join("|") === "access-proof.exe"); files.unlinkSync(program);
      const fullFiles = files.readdirSync(lowFullDirectory).sort(); ensure(fullFiles.join("|") === (prelude ? "access-create.txt|full-file.txt" : "full-file.txt"));
      if (prelude) files.unlinkSync(path.join(lowFullDirectory, "access-create.txt")); files.unlinkSync(lowFullFile);
      ensure(files.readdirSync(lowReadDirectory).join("|") === "full-file.txt"); files.unlinkSync(lowReadFile);
      for (const folder of [tools, treeParent, privateParent, lowOwner, lowFullDirectory, lowReadDirectory]) { ensure(files.readdirSync(folder).length === 0); files.rmdirSync(folder); }
      ensure(files.readdirSync(directory).length === 0); files.rmdirSync(directory); ensure(!files.existsSync(directory)); script.fill(0); script = undefined; live = false;
      return Object.freeze({ schema: 4 as const, scope: 4 as const, mode, ...result, prelude, parentDefault: mode === "natural-default" ? 1 : 0, deniedAccess: prelude ? 524287 : 0, positiveAccess: prelude ? 8191 : 0, deniedChecks: prelude ? 19 : 0, positiveChecks: prelude ? 13 : 0, daclPairs: prelude ? 2 : 0,
        rootPresent: mode === "precreate" ? 0 : 1, outputClosed: mode === "precreate" ? 0 : 1,
        actualNode: mode === "precreate" || mode === "preresume" || mode === "sharedcreate" ? 0 : 1,
        stdinEof: mode === "precreate" || mode === "preresume" || mode === "sharedcreate" ? 0 : 1, rootOnlyStop: 1, snapshot: 1, seedUnchanged: 1,
        assetCleanup: 1, privateCleanup: 1, profileCleanup: 1, emittedCjs: 1 });
    } catch (error) {
      live = false; terminal ??= new WindowsNodeAssetEnforcementObservationError(mode, phase, preludeStage, cExit, windowsNodeAssetErrorClass(loaded, error), probe.object, probe.right, probe.outcome, probe.matrix,
        tokenObserved, tokenFacts.integrity, tokenFacts.attributes, tokenFacts.policy, nodeObservation.checkpoint, nodeObservation.innerClass, launchObservation, preparationObservation); retained.push(graph);
      for (const value of launches) try { loaded!.retainWindowsCommandOutput(value); } catch { /* Same-graph quarantine supplies no disposal receipt. */ }
      for (const owner of owners) try { owner.retainStop(); } catch { /* Request exact Stop only; never retry cleanup or certify disposal. */ }
      throw terminal;
    } finally { busy = false; }
  };
}
const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
const observe = bindWindowsNodeAssetEnforcement({ load: file => require(file) as Bundle });
export const observeWindowsNodeAssetEnforcement = (asset: Asset, verifyBuild: () => void, resources: string, scratchParent: string, mode: WindowsNodeAssetEnforcementMode) => observe(asset, verifyBuild, resources, scratchParent, mode);
