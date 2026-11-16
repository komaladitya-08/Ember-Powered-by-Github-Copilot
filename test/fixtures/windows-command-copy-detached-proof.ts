/** Fixed synthetic root-only NTFS witness. It grants no shell, project, runtime or descendant authority. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { CodingExportEntry } from "../../app/main/agent/coding-result-export";
import type { WindowsLpacApi, WindowsLpacProfile, WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import { loadWindowsRootCopyDetachedApi as loadExperimentalWindowsLpacApi } from "./windows-command-copy-detached-loader";
import { ExperimentalWindowsLpacFixture, experimentalWindowsEnvironment, experimentalWindowsSddl } from "../../app/main/agent/experimental-windows-lpac";
import type { WindowsCommandCopyProofNative, WindowsCommandCopyProofPin } from "./windows-command-copy-proof-native";
import type { FreshWindowsCommandTree, FreshWindowsCommandTreeInput, WindowsCommandCopyNativeFailure } from "../../app/main/agent/windows-command-copy-native";
import type { WindowsCommandRootOnlyFailure, WindowsCommandRootOnlyStopOwner } from "../../app/main/agent/windows-command-stop";
import type { WindowsRootOnlyCommandCopy } from "../../app/main/agent/windows-command-copy";
import type { ScopedCodingFileError } from "../../app/main/agent/coding-platform";
import { parseWindowsCommandCopyReport, WINDOWS_COMMAND_COPY_HEARTBEAT_MAGIC, type WindowsCommandCopyProofMode } from "./windows-command-copy-report";

type Emitted = typeof import("../../app/main/agent/windows-command-copy") & typeof import("../../app/main/agent/windows-command-stop") &
  typeof import("../../app/main/agent/windows-command-copy-native") & typeof import("./windows-command-copy-proof-native") &
  Pick<typeof import("../../app/main/agent/coding-platform"), "ScopedCodingFileError">;
export interface WindowsCommandCopyBuiltAsset { readonly executable: string; readonly module: string }
const retained: unknown[] = [];
const FILE_CODES = Object.freeze({ unavailable: 1, cancelled: 2, path: 3, boundary: 4, unsupported: 5, privacy: 6, binary: 7,
  secret: 8, limit: 9, missing: 10, exists: 11, conflict: 12, ambiguous: 13, "not-empty": 14, io: 15 } as const);
/** Closed diagnostics only: exact emitted constructor plus an own data property; never read error getters or messages. */
export function classifyWindowsCommandCopyFileFailure(error: unknown, constructor: typeof ScopedCodingFileError): number {
  try {
    if (!(error instanceof constructor)) return 0;
    const property = Object.getOwnPropertyDescriptor(error, "code");
    if (!property || !Object.hasOwn(property, "value") || typeof property.value !== "string" || !Object.hasOwn(FILE_CODES, property.value)) return 0;
    return FILE_CODES[property.value as keyof typeof FILE_CODES];
  } catch { return 0; }
}
export interface WindowsCommandCopyExitObservation { readonly phase: 1 | 2; readonly code?: number }
/** Observe only the same returned DWORD; the existing exact-zero acceptance and thrown query remain authoritative. */
export function requireWindowsCommandCopyNaturalExit(query: () => unknown, observed: (code: number) => void): void {
  const value = query();
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
    try { observed(value); } catch { /* Diagnostic failure cannot change the original exact-zero gate. */ }
  }
  ensure(value === 0);
}
export interface WindowsCommandCopyFailedUsefulObservation {
  readonly mode: 1; readonly status: 2; readonly operation: number; readonly features: number; readonly code: number;
}
/** Failed-report bytes carry no authority: positive real Stop/revoke and unchanged pins must precede acquisition.
 * Every path still throws the initial natural-exit refusal; the caller retains the complete graph on uncertainty. */
export async function observeWindowsCommandCopyFailedUsefulExit(error: unknown, exit: WindowsCommandCopyExitObservation | undefined,
  stop: () => Promise<void>, unchanged: () => void, acquire: () => Pick<WindowsCommandCopyProofPin, "read" | "close">,
  observed: (report: WindowsCommandCopyFailedUsefulObservation) => void): Promise<never> {
  try {
    if (exit?.phase === 1 && exit.code === 1) {
      await stop(); unchanged();
      const pin = acquire(), bytes = pin.read();
      let report: WindowsCommandCopyFailedUsefulObservation;
      try {
        const parsed = parseWindowsCommandCopyReport(bytes, "useful"); ensure(parsed.status === 2);
        report = Object.freeze({ mode: 1, status: 2, operation: parsed.operation, features: parsed.features, code: parsed.failedOperationError });
      } finally { bytes.fill(0); pin.close(); }
      observed(report);
    }
  } catch { /* No read/report/cleanup authority follows a diagnostic failure; the original refusal remains first. */ }
  throw error;
}
const notifyFailure = (error: unknown, failed: (error: unknown) => void) => {
  try { failed(error); } catch { /* Diagnostic failure cannot replace the authoritative native error. */ }
};
export type WindowsCommandCopyBoundary = 0 | 1 | 2 | 3 | 4;
type BoundaryObserver = (boundary: WindowsCommandCopyBoundary, error: unknown) => void;
/** Constructor/creator/attester observation never replaces the original synchronous return or error. */
export function observeWindowsCommandCopyBoundary<T>(boundary: 1 | 3 | 4, operation: () => T, failed: BoundaryObserver): T {
  try { return operation(); }
  catch (error) { notifyFailure(error, original => failed(boundary, original)); throw error; }
}
/** Delegates the real Stop owner; only its actual opaque receipt can cross the existing coordinator barrier. */
export function observeWindowsCommandCopyStopOwner(owner: WindowsCommandRootOnlyStopOwner, failed: BoundaryObserver): WindowsCommandRootOnlyStopOwner {
  const observe = <T>(boundary: WindowsCommandCopyBoundary, operation: () => Promise<T>): Promise<T> => {
    try { return operation().catch(error => { notifyFailure(error, original => failed(boundary, original)); throw error; }); }
    catch (error) { notifyFailure(error, original => failed(boundary, original)); throw error; }
  };
  return Object.freeze({ scope: owner.scope,
    launch: (...args: Parameters<WindowsCommandRootOnlyStopOwner["launch"]>) => observe(2, () => owner.launch(...args)),
    stop: (...args: Parameters<WindowsCommandRootOnlyStopOwner["stop"]>) => observe(0, () => owner.stop(...args)),
    retainStop: () => { try { return owner.retainStop(); } catch (error) { notifyFailure(error, original => failed(0, original)); throw error; } },
  });
}
/** Catch-only observation of actual native methods; arguments, result/error identity and native-call counts are preserved. */
export function observeWindowsCommandCopyTree(tree: FreshWindowsCommandTree, failed: (error: unknown) => void): FreshWindowsCommandTree {
  const observe = <T>(operation: () => Promise<T>): Promise<T> => {
    try { return operation().catch(error => { notifyFailure(error, failed); throw error; }); }
    catch (error) { notifyFailure(error, failed); throw error; }
  };
  return Object.freeze({ directory: tree.directory,
    assertPrivate: () => observe(() => tree.assertPrivate()),
    grant: (sid: string, check?: () => void) => observe(() => tree.grant(sid, check)),
    revoke: (sid: string) => observe(() => tree.revoke(sid)),
    snapshot: (check?: () => void) => observe(() => tree.snapshot(check)),
    close: () => observe(() => tree.close()),
  });
}
/** The actual factory's error remains authoritative even when the diagnostic observer fails. */
export async function observeWindowsCommandCopyFactory(input: FreshWindowsCommandTreeInput,
  factory: (input: FreshWindowsCommandTreeInput) => Promise<FreshWindowsCommandTree>, failed: (error: unknown) => void): Promise<FreshWindowsCommandTree> {
  try { return observeWindowsCommandCopyTree(await factory(input), failed); }
  catch (error) { notifyFailure(error, failed); throw error; }
}
/** The first actual copy phase stops at its original failed boundary; later phases cannot overwrite its witness. */
export async function beginWindowsCommandCopyProof<T extends { selected: Pick<WindowsRootOnlyCommandCopy, "files"> }>(
  create: () => Promise<T>, launch: (copy: T) => Promise<unknown>, entered: (subphase: 1 | 2 | 3 | 4) => void,
): Promise<T> {
  entered(1); const copy = await create();
  entered(2); await copy.selected.files(async entries => { ensure(entries.length === 6); });
  entered(3); await launch(copy); entered(4); return copy;
}
/** Native quarantine must not sit in a tree that the test framework recursively removes on exit. */
export function requireWindowsCommandCopyScratchParent(parent: string, managed: string): void {
  const within = (selected: string, base: string) => { const relative = path.win32.relative(base.toLowerCase(), selected.toLowerCase()); return relative === "" || !relative.startsWith("..\\") && relative !== ".." && !path.win32.isAbsolute(relative); };
  if (![parent, managed].every(value => typeof value === "string" && /^[A-Za-z]:\\/.test(value) && path.win32.normalize(value) === value && !/[\p{Cc}\p{Cf}]/u.test(value)) ||
      within(parent, managed) || within(managed, parent)) throw new Error("The native scratch parent overlaps framework teardown or is unavailable.");
}
const fixed = (text: string) => Buffer.from(text, "ascii");
const initial = () => [
  { path: "seed.txt", kind: "file", bytes: fixed("EMBER_COMMAND_SEED\n"), executable: false },
  { path: "move.txt", kind: "file", bytes: fixed("EMBER_COMMAND_MOVE\n"), executable: false },
  { path: "replace.txt", kind: "file", bytes: fixed("EMBER_COMMAND_OLD\n"), executable: false },
  { path: "remove.txt", kind: "file", bytes: fixed("EMBER_COMMAND_REMOVE\n"), executable: false },
  { path: "staged-folder", kind: "directory" },
  { path: "staged-folder/child.txt", kind: "file", bytes: fixed("EMBER_COMMAND_CHILD\n"), executable: false },
] satisfies CodingExportEntry[];
const ensure = (value: unknown): void => { if (value !== true) throw new Error("The fixed root-only observation was refused."); };
const delay = () => new Promise<void>(resolve => setTimeout(resolve, 10));
const quote = (value: string) => `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
const command = (program: string, args: readonly string[]) => {
  const value = [program, ...args].map(quote).join(" ");
  ensure(value.length < 32767 && !value.includes("\0")); return Buffer.from(value + "\0", "utf16le");
};
/** Only phase numbers leave this fixture; all source/data/path/error material stays in its private retained graph. */
export class WindowsCommandCopyObservationError extends Error {
  constructor(readonly phase: number, readonly subphase: number, readonly ownership: number, readonly native?: WindowsCommandCopyNativeFailure,
    readonly boundary: WindowsCommandCopyBoundary = 0, readonly stop?: WindowsCommandRootOnlyFailure, readonly fileCode = 0,
    readonly exit?: WindowsCommandCopyExitObservation, readonly failedReport?: WindowsCommandCopyFailedUsefulObservation) {
    super(`The root-only native observation was refused at phase ${phase}, subphase ${subphase}, ownership ${ownership}, boundary ${boundary}, fileCode ${fileCode}${native ? `, native ${JSON.stringify(native)}` : ""}${stop ? `, stop ${JSON.stringify(stop)}` : ""}${exit ? `, exit ${JSON.stringify(exit)}` : ""}${failedReport ? `, failedReport ${JSON.stringify(failedReport)}` : ""}.`);
    this.name = "WindowsCommandCopyObservationError"; this.stack = `${this.name}: ${this.message}`;
  }
}

/** Uses the actual emitted CJS default Koffi loaders/factories and a separately verified, host-built fixed C image. */
export async function observeWindowsCommandCopyDetached(asset: WindowsCommandCopyBuiltAsset, verifyBuild: () => void, scratchParent: string) {
  let phase = 1, subphase = 0, firstBoundary: WindowsCommandCopyBoundary = 0, stopFailure: WindowsCommandRootOnlyFailure | undefined,
    lastExit: WindowsCommandCopyExitObservation | undefined, failedReport: WindowsCommandCopyFailedUsefulObservation | undefined,
    nativeFailure: WindowsCommandCopyNativeFailure | undefined, emitted: Emitted | undefined, native: WindowsCommandCopyProofNative | undefined, fixture: ExperimentalWindowsLpacFixture | undefined,
    copy: WindowsRootOnlyCommandCopy | undefined, profile: WindowsLpacProfile | undefined, profileDeleted = false, root = "";
  const owners: WindowsCommandRootOnlyStopOwner[] = [], pins: WindowsCommandCopyProofPin[] = [], issued: unknown[] = [];
  try {
    verifyBuild();
    // require receives the exact branded builder path; this is the built CJS, not a TypeScript factory substitution.
    emitted = createRequire(asset.module)(asset.module) as Emitted;
    const loaded = emitted;
    for (const key of ["WindowsRootOnlyCommandCopy", "createWindowsCommandRootOnlyStopOwner", "requireWindowsCommandRootOnlyStopped", "createFreshWindowsCommandTree",
      "loadWindowsCommandCopyProofNative", "WindowsCommandCopyProofCleanupError", "WindowsCommandCopyCleanupError", "WindowsCommandRootOnlyCleanupError", "WindowsRootOnlyCommandCopyCleanupError", "windowsCommandCopyNativeFailure", "windowsCommandRootOnlyFailure", "ScopedCodingFileError"] as const)
      ensure(typeof loaded[key] === "function");
    native = loaded.loadWindowsCommandCopyProofNative();
    const guarded = native;
    const modulePin = native.pin(asset.module, 16 * 1024 * 1024), executablePin = native.pin(asset.executable, 16 * 1024 * 1024);
    pins.push(modulePin, executablePin); verifyBuild(); modulePin.unchanged(); executablePin.unchanged();
    phase = 2;
    const original = loadExperimentalWindowsLpacApi(); issued.push(original);
    // Every acquisition/disposal from the older fixture is terminally guarded here. On failure, no recursive cleanup.
    const api = new Proxy(original, { get(target, key: keyof WindowsLpacApi) {
      if (key === "close") return (handle: bigint) => guarded.close(handle);
      if (key === "deleteProfile") return (selected: WindowsLpacProfile) => { guarded.deleteProfile(selected); profileDeleted = true; };
      if (key === "createProfile") return () => { ensure(profile !== undefined); return profile!; };
      const method = target[key];
      if (key === "terminateJob" || key === "terminateProcess") return method.bind(target);
      return (...args: unknown[]) => guarded.guard(() => Reflect.apply(method, target, args));
    } }) as WindowsLpacApi;
    profile = guarded.guard(() => original.createProfile(`Ember.RootOnly.${randomUUID()}`)); issued.push(profile);
    const owner = guarded.guard(() => original.ownerSid());
    // Vitest's global teardown recursively removes os.tmpdir(). Retained native owners must live outside that tree.
    const managed = fs.realpathSync.native(os.tmpdir()), parent = fs.realpathSync.native(scratchParent);
    requireWindowsCommandCopyScratchParent(parent, managed);
    root = path.win32.join(parent, `ember-root-only-${randomUUID()}`);
    // Only traversal/read is granted on fresh synthetic ancestors. Modify is confined to control scratch and each fresh work tree.
    guarded.guard(() => original.createDirectory(root, experimentalWindowsSddl(owner, profile!.sidText, "read", true)));
    const source = path.win32.join(root, "source.txt"), canary = path.win32.join(root, "canary.txt"), treeParent = path.win32.join(root, "trees");
    const privateFile = `D:P(A;;FA;;;${owner})(A;;FA;;;SY)S:(ML;;NW;;;LW)`;
    guarded.guard(() => original.writeNewFile(source, fixed("EMBER_FIXED_SOURCE\n"), privateFile));
    guarded.guard(() => original.writeNewFile(canary, fixed("EMBER_FIXED_CANARY\n"), privateFile));
    guarded.guard(() => original.createDirectory(treeParent, experimentalWindowsSddl(owner, profile!.sidText, "read", true)));
    const sourcePin = guarded.pin(source, 128), canaryPin = guarded.pin(canary, 128); pins.push(sourcePin, canaryPin);
    fixture = guarded.guard(() => ExperimentalWindowsLpacFixture.prepare(root, executablePin.read(), api)); issued.push(fixture);
    const paths = fixture.paths, environment = guarded.guard(() => experimentalWindowsEnvironment(paths, original.windowsDirectory(), original.profileLocalAppDataBase(profile!)));
    const toolPin = guarded.pin(paths.program, 16 * 1024 * 1024); pins.push(toolPin);
    ensure(toolPin.read().equals(executablePin.read()));
    const recheck = () => { verifyBuild(); for (const pin of pins) pin.unchanged(); };
    const captureStop: BoundaryObserver = (boundary, error) => {
      if (!firstBoundary && boundary) firstBoundary = boundary;
      stopFailure ??= loaded.windowsCommandRootOnlyFailure(error);
    };
    const attest = (selected: Readonly<WindowsSuspendedProcess>) => observeWindowsCommandCopyBoundary(4, () => {
      guarded.guard(() => original.verifyToken(profile!, selected.process)); guarded.image(selected.process, selected.pid, paths.program); recheck();
    }, captureStop);
    const createOwner = (binding: object) => observeWindowsCommandCopyBoundary(1, () => {
      const selected = loaded.createWindowsCommandRootOnlyStopOwner(binding, api); owners.push(selected);
      return observeWindowsCommandCopyStopOwner(selected, captureStop);
    }, captureStop);
    const captureNative = (error: unknown) => { nativeFailure ??= loaded.windowsCommandCopyNativeFailure(error); };
    const makeCopy = async () => {
      subphase = 1;
      let directory = "";
      const selected = await loaded.WindowsRootOnlyCommandCopy.create({ parent: treeParent, protectedPaths: [source, canary, paths.root, path.win32.dirname(asset.module)],
        entries: initial(), packageSid: profile!.sidText, current: () => true, packageCurrent: () => !profileDeleted, reviewCurrent: () => !profileDeleted },
      { api, createStopOwner: createOwner, createTree: async (input: FreshWindowsCommandTreeInput) => {
        const tree = await observeWindowsCommandCopyFactory(input, actual => loaded.createFreshWindowsCommandTree(actual), captureNative);
        directory = tree.directory; return tree;
      } });
      issued.push(selected); ensure(directory.length > 0); return { selected, directory };
    };
    const create = (mode: WindowsCommandCopyProofMode, directory: string, report: string, ready: string) => observeWindowsCommandCopyBoundary(3, () => {
      recheck(); return guarded.guard(() => original.createSuspended(profile!, paths.program,
        command(paths.program, [mode, directory, source, canary, report, ready]), paths.work, environment));
    }, captureStop);
    const waitExited = async (selected: WindowsSuspendedProcess, exitPhase: 1 | 2) => {
      lastExit = Object.freeze({ phase: exitPhase });
      const end = performance.now() + 15_000;
      while (!guarded.guard(() => original.exited(selected.process))) { ensure(performance.now() < end); await delay(); }
      requireWindowsCommandCopyNaturalExit(() => guarded.guard(() => original.exitCode(selected.process)), code => { lastExit = Object.freeze({ phase: exitPhase, code }); });
    };
    const readReport = (report: string, mode: WindowsCommandCopyProofMode) => {
      const pin = guarded.pin(report, 64); pins.push(pin); const bytes = pin.read();
      try { const parsed = parseWindowsCommandCopyReport(bytes, mode); ensure(parsed.status === 1); return parsed; }
      finally { bytes.fill(0); pin.close(); pins.splice(pins.indexOf(pin), 1); }
    };
    phase = 3;
    const usefulReport = path.win32.join(paths.state, "useful.bin"), ready = path.win32.join(paths.state, "ready");
    let process: WindowsSuspendedProcess | undefined;
    let current = await beginWindowsCommandCopyProof(makeCopy, actual => {
      copy = actual.selected; return copy.launchRootOnly(() => process = create("useful", actual.directory, usefulReport, ready), attest);
    }, value => { subphase = value; });
    copy = current.selected;
    ensure(process !== undefined);
    try { await waitExited(process!, 1); }
    catch (error) {
      await observeWindowsCommandCopyFailedUsefulExit(error, lastExit, () => current.selected.stop(), recheck,
        () => { const pin = guarded.pin(usefulReport, 64); pins.push(pin); return pin; }, report => { failedReport = report; });
    }
    phase = 4; subphase = 0;
    await copy.files(async entries => {
      const expected = new Map([["seed.txt", "EMBER_COMMAND_EDITED\n"], ["created.txt", "EMBER_COMMAND_CREATED\n"], ["renamed.txt", "EMBER_COMMAND_MOVE\n"], ["replace.txt", "EMBER_COMMAND_REPLACED\n"]]);
      ensure(entries.length === 4);
      for (const entry of entries) ensure(entry.kind === "file" && entry.executable === false && expected.has(entry.path) && entry.bytes.equals(fixed(expected.get(entry.path)!)));
    });
    // The callback above can run only after exact root Stop/job closure and all package-grant revocations.
    const useful = readReport(usefulReport, "useful"); ensure(useful.features === 0xfff);
    phase = 5; subphase = 0; lastExit = undefined;
    const binding = Object.freeze({}), negative = createOwner(binding), revokedReport = path.win32.join(paths.state, "revoked.bin");
    await negative.launch(() => process = create("revoked", current.directory, revokedReport, ready), attest, () => !profileDeleted);
    await waitExited(process!, 2); loaded.requireWindowsCommandRootOnlyStopped(await negative.stop(15_000), binding);
    const revoked = readReport(revokedReport, "revoked"); ensure(revoked.features === 0xf07);
    const firstDirectory = current.directory; await copy.close(); copy = undefined; ensure(!fs.existsSync(firstDirectory));
    phase = 6; subphase = 0; lastExit = undefined;
    current = await makeCopy(); copy = current.selected;
    const writerReport = path.win32.join(paths.state, "writer.bin"), writerReady = path.win32.join(paths.state, "writer-ready");
    subphase = 3; await copy.launchRootOnly(() => process = create("writer", current.directory, writerReport, writerReady), attest);
    const until = performance.now() + 15_000;
    for (;;) {
      // Metadata-only readiness: never read writer/report contents while the root owns the work grant.
      let marker: fs.Stats | undefined;
      try { marker = fs.lstatSync(writerReady); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (marker) { ensure(marker.isFile() && !marker.isSymbolicLink() && marker.nlink === 1 && marker.size === 0); break; }
      ensure(!guarded.guard(() => original.exited(process!.process)) && performance.now() < until); await delay();
    }
    ensure(!guarded.guard(() => original.exited(process!.process)));
    phase = 7; subphase = 0; await copy.stop();
    const writer = readReport(writerReport, "writer"); ensure(writer.features === 0xf01);
    let heartbeat: Buffer | undefined;
    await copy.review(async entries => {
      const entry = entries.find(value => value.path === "heartbeat.bin");
      ensure(entry?.kind === "file" && entry.bytes.length === 64);
      if (entry?.kind !== "file") throw new Error("The fixed heartbeat was refused.");
      ensure(entry.bytes.readUInt32LE(0) === WINDOWS_COMMAND_COPY_HEARTBEAT_MAGIC && entry.bytes.readUInt32LE(4) === 1 && entry.bytes.readUInt32LE(8) >= 1 && entry.bytes.subarray(12).every(value => value === 0));
      heartbeat = Buffer.from(entry.bytes);
    });
    for (let tick = 0; tick < 5; tick++) await delay();
    await copy.review(async entries => { const entry = entries.find(value => value.path === "heartbeat.bin"); ensure(entry?.kind === "file" && entry.bytes.equals(heartbeat!)); }); heartbeat!.fill(0);
    let invoked = false, refused = false;
    try { await copy.launchRootOnly(() => { invoked = true; throw new Error("A retired root creator was invoked."); }, attest); } catch { refused = true; }
    ensure(refused && !invoked);
    // A later healthy review also proves the rejected admission did not create a hidden run/cleanup uncertainty.
    await copy.review(async entries => { ensure(entries.length === 7); });
    const writerDirectory = current.directory; await copy.close(); copy = undefined; ensure(!fs.existsSync(writerDirectory));
    phase = 8; subphase = 0; recheck();
    ensure(sourcePin.read().equals(fixed("EMBER_FIXED_SOURCE\n")) && canaryPin.read().equals(fixed("EMBER_FIXED_CANARY\n")));
    // Complete known-owner closure precedes removal of the fresh fixture tree and its profile.
    for (const pin of pins.slice().reverse()) pin.close(); pins.length = 0;
    await fixture.close(); ensure(profileDeleted && !guarded.unsafe);
    fs.rmSync(root, { recursive: true, force: false }); ensure(!fs.existsSync(root));
    return Object.freeze({ schema: 1, scope: 1, usefulOperations: 8, protectedDenials: 12, revokedWorkDenials: 3,
      writerStopped: 1, stableSnapshot: 1, retiredAdmissionRefused: 1, sourceUnchanged: 1, treeCleanup: 1, profileCleanup: 1, emittedCjs: 1 });
  } catch (error) {
    // No disposal or readout authority follows an unexpected native/setup/observation failure. Exact known roots only receive Stop.
    for (const owner of owners) try { owner.retainStop(); } catch { /* Every owner remains held below, including failed Stop requests. */ }
    retained.push({ asset, native, fixture, copy, profile, profileDeleted, root, owners, pins, issued });
    // Cross the emitted-module boundary using its actual constructors, never error names or caller-shaped receipts.
    let ownership = 0;
    if (emitted) for (const [index, constructor] of [emitted.WindowsRootOnlyCommandCopyCleanupError, emitted.WindowsCommandRootOnlyCleanupError,
      emitted.WindowsCommandCopyCleanupError, emitted.WindowsCommandCopyProofCleanupError].entries()) {
      if (typeof constructor === "function" && error instanceof constructor) { ownership = index + 1; break; }
    }
    const fileCode = emitted && typeof emitted.ScopedCodingFileError === "function" ? classifyWindowsCommandCopyFileFailure(error, emitted.ScopedCodingFileError) : 0;
    throw new WindowsCommandCopyObservationError(phase, subphase, ownership, nativeFailure, firstBoundary, stopFailure, fileCode, lastExit, failedReport);
  }
}
