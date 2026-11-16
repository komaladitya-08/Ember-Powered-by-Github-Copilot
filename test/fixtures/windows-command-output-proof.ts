/** Fixed LPAC C witness for the real disabled output owner. No Node, ordinary-host mode or command admission. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path/win32";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { experimentalWindowsSddl } from "../../app/main/agent/experimental-windows-lpac";
import { loadExperimentalWindowsLpacApi, type WindowsLpacApi, type WindowsHandle } from "../../app/main/agent/experimental-windows-lpac-api";
import type { WindowsCommandRootOnlyStopOwner, WindowsCommandRootOnlyStoppedRef } from "../../app/main/agent/windows-command-stop";
import type { WindowsCommandOutputLaunchRef } from "../../app/main/agent/windows-command-output";
import type { WindowsRootOnlyCommandCopy } from "../../app/main/agent/windows-command-copy";
import type { WindowsCommandCopyProofPin } from "./windows-command-copy-proof-native";

type Bundle = typeof import("../../app/main/agent/windows-command-copy") & typeof import("../../app/main/agent/windows-command-output") &
  typeof import("../../app/main/agent/windows-command-stop") & typeof import("../../app/main/agent/windows-command-creator-profile") &
  typeof import("../../app/main/agent/windows-command-copy-native") & typeof import("./windows-command-copy-proof-native") & typeof import("../../app/main/agent/coding-platform");
type Asset = Readonly<{ executable: string; module: string }>;
export type WindowsCommandOutputProofMode = "natural" | "overflow" | "cancel";
export const WINDOWS_COMMAND_OUTPUT_PROOF_EXPORTS = Object.freeze(["WindowsRootOnlyCommandCopy", "WindowsRootOnlyCommandCopyCleanupError", "requireWindowsCommandRootOnlyCompleted",
  "createFreshWindowsCommandCreatorProfile", "windowsCommandCreatorProfile", "closeWindowsCommandCreatorProfile", "WindowsCommandCreatorProfileCleanupError",
  "createWindowsCommandOutput", "requireWindowsCommandOutputClosed", "requireWindowsCommandOutputLaunch", "retainWindowsCommandOutput", "WindowsCommandOutputCleanupError",
  "createWindowsCommandRootOnlyStopOwner", "requireWindowsCommandRootOnlyStopped", "WindowsCommandRootOnlyCleanupError", "windowsCommandRootOnlyFailure",
  "createFreshWindowsCommandTree", "WindowsCommandCopyCleanupError", "windowsCommandCopyNativeFailure", "loadWindowsCommandCopyProofNative", "WindowsCommandCopyProofCleanupError", "ScopedCodingFileError"].sort());
export const WINDOWS_COMMAND_OUTPUT_SEED = "EMBER_OUTPUT_SEED\n", WINDOWS_COMMAND_OUTPUT_CREATED = "EMBER_OUTPUT_CREATED\n";
export const WINDOWS_COMMAND_OUTPUT_READY = "EMBER_OUTPUT_READY\n", WINDOWS_COMMAND_ERROR_READY = "EMBER_ERROR_READY\n";
const retained: unknown[] = [];
const ensure = (value: unknown): void => { if (value !== true) throw new Error("The fixed output observation was refused."); };
const quote = (value: string) => `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
const command = (program: string, mode: WindowsCommandOutputProofMode) => Buffer.from(`${quote(program)} ${quote(mode)}\0`, "utf16le");
const ordinary = (value: unknown): string => {
  if (typeof value !== "string" || value.length < 4 || value.length > 4096 || !/^[A-Za-z]:\\/.test(value) || path.normalize(value) !== value ||
      value.includes("/") || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) || /[:<>"|?*]/.test(value.slice(2)) ||
      value.slice(3).split("\\").some(part => !part || /[:. ]$/.test(part) || part === "." || part === "..")) throw new Error();
  return value;
};
const inside = (base: string, value: string) => base.toLowerCase() === value.toLowerCase() || value.toLowerCase().startsWith(base.toLowerCase() + "\\");
export class WindowsCommandOutputObservationError extends Error {
  constructor(readonly mode: WindowsCommandOutputProofMode, readonly phase: number) {
    super(`The fixed LPAC output witness was refused in ${mode} at phase ${phase}.`);
    this.name = "WindowsCommandOutputObservationError"; this.stack = `${this.name}: ${this.message}`;
  }
}

/** Observe the ORIGINAL promise and authenticate its ORIGINAL receipt. Observation supplies no Stop authority. */
export function observeWindowsCommandOutputStop(owner: WindowsCommandRootOnlyStopOwner, binding: object,
  authenticate: (ref: unknown, binding: object) => void, observed: (ref: WindowsCommandRootOnlyStoppedRef) => void): WindowsCommandRootOnlyStopOwner {
  return Object.freeze({ ...owner, stop(...args: Parameters<WindowsCommandRootOnlyStopOwner["stop"]>) {
    const pending = owner.stop(...args);
    void pending.then(ref => { authenticate(ref, binding); observed(ref); }).catch(() => undefined);
    return pending;
  } });
}

/** Completed bytes remain private. Only genuine same-run completion and closure can supply outward facts. */
export function requireWindowsCommandOutputProofFacts(loaded: Pick<Bundle, "requireWindowsCommandRootOnlyCompleted" | "requireWindowsCommandOutputClosed">,
  input: { mode: WindowsCommandOutputProofMode; completed: unknown; closed: unknown; run: Parameters<Bundle["requireWindowsCommandRootOnlyCompleted"]>[1];
    launch: Parameters<Bundle["requireWindowsCommandOutputClosed"]>[1]; stdout: Buffer; stderr: Buffer }) {
  ensure(["natural", "overflow", "cancel"].includes(input.mode));
  const completion = loaded.requireWindowsCommandRootOnlyCompleted(input.completed, input.run);
  const output = loaded.requireWindowsCommandOutputClosed(input.closed, input.launch, input.run);
  ensure(input.stdout.length + input.stderr.length <= 256 * 1024 && output.stdoutBytes === input.stdout.length && output.stderrBytes === input.stderr.length);
  ensure(input.stdout.subarray(0, Buffer.byteLength(WINDOWS_COMMAND_OUTPUT_READY)).equals(Buffer.from(WINDOWS_COMMAND_OUTPUT_READY)) &&
    input.stderr.subarray(0, Buffer.byteLength(WINDOWS_COMMAND_ERROR_READY)).equals(Buffer.from(WINDOWS_COMMAND_ERROR_READY)));
  if (input.mode === "natural") {
    const stdout = Buffer.concat([Buffer.from(WINDOWS_COMMAND_OUTPUT_READY), Buffer.alloc(17 * 1024, "O"), Buffer.from("\nEMBER_OUTPUT_DONE\n")]);
    const stderr = Buffer.concat([Buffer.from(WINDOWS_COMMAND_ERROR_READY), Buffer.alloc(13 * 1024, "E"), Buffer.from("\nEMBER_ERROR_DONE\n")]);
    try { ensure(completion.outcome === "natural-exit" && completion.exitCode === 17 && output.complete && output.reason === "none" && input.stdout.equals(stdout) && input.stderr.equals(stderr)); }
    finally { stdout.fill(0); stderr.fill(0); }
  } else {
    ensure(completion.outcome === "cancelled" && completion.exitCode === null && !output.complete && output.reason === (input.mode === "cancel" ? "cancelled" : "overflow"));
    ensure(input.stderr.equals(Buffer.from(WINDOWS_COMMAND_ERROR_READY)));
    if (input.mode === "cancel") ensure(input.stdout.equals(Buffer.from(WINDOWS_COMMAND_OUTPUT_READY)));
    else {
      const body = input.stdout.subarray(Buffer.byteLength(WINDOWS_COMMAND_OUTPUT_READY));
      ensure(body.length > 0 && body.every(byte => byte === 0x58));
    }
  }
  return Object.freeze({ mode: input.mode, exitCode: completion.exitCode, reason: output.reason, stdoutBytes: output.stdoutBytes, stderrBytes: output.stderrBytes,
    complete: output.complete, rootOnlyStop: 1 as const });
}

export interface WindowsCommandOutputProofDependencies {
  load(file: string): Bundle; api(): WindowsLpacApi;
  files?: Pick<typeof fs, "lstatSync" | "realpathSync" | "readdirSync" | "unlinkSync" | "rmdirSync" | "existsSync">;
  managedTemporary?(): string; id?(): string; now?(): number; pause?(): Promise<void>;
}
/** Portable boundary seam only. Production below accepts no substituted loader, native factory, program or mode source. */
export function bindWindowsCommandOutputProof(dependencies: WindowsCommandOutputProofDependencies) {
  const files = dependencies.files ?? fs, now = dependencies.now ?? (() => performance.now()),
    pause = dependencies.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 5)));
  let terminal: WindowsCommandOutputObservationError | undefined, busy = false;
  return async (asset: Asset, verifyBuild: () => void, scratchParent: string, mode: WindowsCommandOutputProofMode) => {
    if (terminal) throw terminal;
    if (busy || !["natural", "overflow", "cancel"].includes(mode)) { terminal = new WindowsCommandOutputObservationError(["natural", "overflow", "cancel"].includes(mode) ? mode : "natural", 1); throw terminal; }
    busy = true;
    let phase = 1, loaded: Bundle | undefined, proof: ReturnType<Bundle["loadWindowsCommandCopyProofNative"]> | undefined, api: WindowsLpacApi | undefined,
      profile: ReturnType<Bundle["createFreshWindowsCommandCreatorProfile"]> | undefined, copy: WindowsRootOnlyCommandCopy | undefined,
      io: ReturnType<Bundle["createWindowsCommandOutput"]> | undefined, launch: WindowsCommandOutputLaunchRef | undefined,
      directory = "", toolBytes: Buffer | undefined, live = true, profileClosed = false, ready = false, alive = false;
    const pins: WindowsCommandCopyProofPin[] = [], directories: WindowsHandle[] = [], owners: WindowsCommandRootOnlyStopOwner[] = [],
      output: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] }, totals = { stdout: 0, stderr: 0 }, abort = new AbortController();
    let stopped: WindowsCommandRootOnlyStoppedRef | undefined;
    const graph = { asset, verifyBuild, mode, pins, directories, owners, output, abort,
      get loaded() { return loaded; }, get proof() { return proof; }, get api() { return api; }, get profile() { return profile; },
      get copy() { return copy; }, get io() { return io; }, get launch() { return launch; }, get directory() { return directory; }, get toolBytes() { return toolBytes; } };
    const current = () => live && !terminal && proof?.unsafe !== true && !profileClosed;
    const guarded = <T>(operation: () => T): T => { ensure(current()); const result = operation(); ensure(current()); return result; };
    const native = <T>(operation: () => T): T => guarded(() => proof!.guard(operation));
    const verified = () => { ensure(guarded(verifyBuild) === undefined); for (const pin of pins) guarded(() => pin.unchanged()); };
    const wait = async (condition: () => boolean, budget: number) => {
      let previous = guarded(now); ensure(Number.isFinite(previous) && previous >= 0); const deadline = previous + budget;
      for (;;) {
        const tick = guarded(now); ensure(Number.isFinite(tick) && tick >= previous && tick <= deadline); previous = tick;
        if (guarded(condition)) return; ensure(tick < deadline); await pause();
      }
    };
    try {
      ordinary(asset.executable); ordinary(asset.module); ordinary(scratchParent); ensure(typeof verifyBuild === "function");
      for (const file of [asset.executable, asset.module]) ensure(!inside(scratchParent, file) && !inside(file, scratchParent));
      const ancestry = (file: string) => { for (let here = file;;) { const value = guarded(() => files.lstatSync(here)); ensure(value.isDirectory() && !value.isSymbolicLink()); const next = path.dirname(here); if (next === here) break; here = next; } };
      ancestry(scratchParent); ensure(guarded(() => files.realpathSync.native(scratchParent)).toLowerCase() === scratchParent.toLowerCase());
      const managed = ordinary(guarded(dependencies.managedTemporary ?? (() => os.tmpdir()))); ancestry(managed);
      ensure(!inside(scratchParent, managed) && !inside(managed, scratchParent));
      verified(); loaded = guarded(() => dependencies.load(asset.module));
      ensure(Object.keys(loaded).sort().join("|") === WINDOWS_COMMAND_OUTPUT_PROOF_EXPORTS.join("|") && Object.values(loaded).every(value => typeof value === "function"));
      proof = guarded(() => loaded!.loadWindowsCommandCopyProofNative());
      pins.push(native(() => proof!.pin(asset.module, 16 * 1024 * 1024))); pins.push(native(() => proof!.pin(asset.executable, 16 * 1024 * 1024))); verified();
      phase = 2; api = native(dependencies.api); profile = native(() => loaded!.createFreshWindowsCommandCreatorProfile());
      const selectedProfile = native(() => loaded!.windowsCommandCreatorProfile(profile!)), owner = native(() => api!.ownerSid());
      const id = guarded(dependencies.id ?? randomUUID); ensure(typeof id === "string" && /^[0-9a-f-]{36}$/.test(id));
      directory = path.join(scratchParent, `ember-output-native-${id}`);
      const tools = path.join(directory, "tools"), treeParent = path.join(directory, "trees"), program = path.join(tools, "output-proof.exe"), security = experimentalWindowsSddl(owner, selectedProfile.sidText, "read", true);
      for (const folder of [directory, tools, treeParent]) { native(() => api!.createDirectory(folder, security)); directories.push(native(() => api!.pinDirectory(folder))); }
      toolBytes = native(() => pins[1].read()); native(() => api!.writeNewFile(program, toolBytes!, experimentalWindowsSddl(owner, selectedProfile.sidText, "read", false)));
      pins.push(native(() => proof!.pin(program, 16 * 1024 * 1024))); const staged = native(() => pins[2].read());
      try { ensure(staged.equals(toolBytes)); } finally { staged.fill(0); toolBytes.fill(0); toolBytes = undefined; }
      phase = 3;
      copy = await loaded.WindowsRootOnlyCommandCopy.create({ parent: treeParent, protectedPaths: [tools, path.dirname(asset.module)],
        entries: [{ path: "seed.txt", kind: "file", bytes: Buffer.from(WINDOWS_COMMAND_OUTPUT_SEED), executable: false }], creatorProfile: profile,
        packageSid: selectedProfile.sidText, current, packageCurrent: current, reviewCurrent: current }, { api,
        createStopOwner(binding) {
          const actual = native(() => loaded!.createWindowsCommandRootOnlyStopOwner(binding, api!)); owners.push(actual);
          return observeWindowsCommandOutputStop(actual, binding, loaded!.requireWindowsCommandRootOnlyStopped, ref => { stopped = ref; });
        } });
      io = native(() => loaded!.createWindowsCommandOutput(profile!, { signal: abort.signal, timeoutMs: 8_000,
        output(bytes, stream) {
          ensure(current() && bytes.byteLength > 0 && totals.stdout + totals.stderr + bytes.byteLength <= 256 * 1024);
          totals[stream] += bytes.byteLength; output[stream].push(Buffer.from(bytes));
          if (!ready && totals.stdout >= Buffer.byteLength(WINDOWS_COMMAND_OUTPUT_READY) && totals.stderr >= Buffer.byteLength(WINDOWS_COMMAND_ERROR_READY)) {
            const out = Buffer.concat(output.stdout), err = Buffer.concat(output.stderr);
            try { ready = out.subarray(0, Buffer.byteLength(WINDOWS_COMMAND_OUTPUT_READY)).equals(Buffer.from(WINDOWS_COMMAND_OUTPUT_READY)) && err.subarray(0, Buffer.byteLength(WINDOWS_COMMAND_ERROR_READY)).equals(Buffer.from(WINDOWS_COMMAND_ERROR_READY)); }
            finally { out.fill(0); err.fill(0); }
            if (ready) { ensure(!io!.signal.aborted && launch !== undefined); const actual = loaded!.requireWindowsCommandOutputLaunch(launch!); alive = native(() => api!.exited(actual.root.process)) === false; ensure(alive); }
          }
        } }));
      verified(); phase = 4;
      const run = await copy.launchRootOnlyWithOutput(context => launch = io!.createSuspended(context, program, command(program, mode)), root => {
        native(() => api!.verifyToken(selectedProfile, root.process)); native(() => proof!.image(root.process, root.pid, program)); verified();
      });
      phase = 5; await wait(() => ready && alive, 5_000);
      if (mode === "cancel") abort.abort();
      if (mode !== "natural") { await wait(() => stopped !== undefined, 15_000); ensure(io.signal.aborted); }
      // Overflow/cancel reach here only after the real owner already returned its authenticated Stop receipt.
      phase = 6; const completed = await copy.completeRootOnly(run, io.signal), closed = await io.closeOutputAfterStopped(completed, run);
      ensure(stopped !== undefined); verified();
      const stdout = Buffer.concat(output.stdout), stderr = Buffer.concat(output.stderr);
      let facts: ReturnType<typeof requireWindowsCommandOutputProofFacts>;
      try { ensure(launch !== undefined); facts = requireWindowsCommandOutputProofFacts(loaded, { mode, completed, closed, run, launch: launch!, stdout, stderr }); }
      finally { stdout.fill(0); stderr.fill(0); for (const chunks of Object.values(output)) for (const chunk of chunks) chunk.fill(0); }
      phase = 7; const snapshot = async (entries: readonly import("../../app/main/agent/coding-result-export").CodingExportEntry[]) => {
        ensure(entries.length === (mode === "natural" ? 2 : 1));
        for (const entry of entries) {
          ensure(entry.kind === "file" && !entry.executable && (entry.path === "seed.txt" || mode === "natural" && entry.path === "created.txt"));
          if (entry.kind === "file") ensure(entry.bytes.equals(Buffer.from(entry.path === "seed.txt" ? WINDOWS_COMMAND_OUTPUT_SEED : WINDOWS_COMMAND_OUTPUT_CREATED)));
        }
        ensure(entries.some(entry => entry.path === "seed.txt") && (mode !== "natural" || entries.some(entry => entry.path === "created.txt")));
      };
      if (mode === "natural") await copy.files(snapshot); else await copy.review(snapshot);
      await copy.close(); ensure(guarded(() => files.readdirSync(treeParent)).length === 0); verified();
      phase = 8; for (const pin of pins.slice().reverse()) native(() => pin.close());
      for (const handle of directories.slice().reverse()) native(() => api!.close(handle));
      native(() => loaded!.closeWindowsCommandCreatorProfile(profile!)); profileClosed = true;
      ensure(files.readdirSync(tools).join("|") === "output-proof.exe"); files.unlinkSync(program); files.rmdirSync(tools); files.rmdirSync(treeParent);
      ensure(files.readdirSync(directory).length === 0); files.rmdirSync(directory); ensure(!files.existsSync(directory)); live = false;
      return Object.freeze({ schema: 1 as const, scope: 1 as const, ...facts, stdinEof: 1 as const, liveOutput: 1 as const, snapshot: 1 as const, seedUnchanged: 1 as const, privateCleanup: 1 as const, profileCleanup: 1 as const, emittedCjs: 1 as const });
    } catch {
      live = false; terminal ??= new WindowsCommandOutputObservationError(mode, phase); retained.push(graph);
      if (launch) try { loaded!.retainWindowsCommandOutput(launch); } catch { /* Same-graph quarantine never certifies disposal. */ }
      for (const owner of owners) try { owner.retainStop(); } catch { /* Quarantine requests no receipt, queries, disposal or retry. */ }
      throw terminal;
    } finally { busy = false; }
  };
}

const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
const observe = bindWindowsCommandOutputProof({ load: file => require(file) as Bundle, api: loadExperimentalWindowsLpacApi });
export const observeWindowsCommandOutput = (asset: Asset, verifyBuild: () => void, scratchParent: string, mode: WindowsCommandOutputProofMode) => observe(asset, verifyBuild, scratchParent, mode);
