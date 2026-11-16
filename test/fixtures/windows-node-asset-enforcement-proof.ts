/** Separate fixed native asset/MIC witness. No project coordinator, selector or general program override. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path/win32";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
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
const C_OUTPUT = "EMBER_ASSET_ACCESS_V1:255:511:1\n", C_ERROR = "EMBER_ASSET_ACCESS_STDERR\n", CONTROL_CREATED = "EMBER_ASSET_CONTROL_CREATED\n";
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
  const descriptor = (directory: boolean, grant: "host" | "read" | "full", label: "LW" | "ME" | "empty" | "absent") => {
    const flags = directory ? "OICI" : "";
    return `O:${owner}G:${owner}D:P(A;${flags};FA;;;${owner})(A;${flags};FA;;;SY)${grant === "host" ? "" : `(A;${flags};${grant === "read" ? "0x1200a9" : "FA"};;;${packageSid})`}${label === "absent" ? "" : label === "empty" ? "S:P" : `S:(ML;${flags};NW;;;${label})`}`;
  };
  return Object.freeze({ directory: descriptor(true, "read", mode === "natural-default" ? "empty" : "ME"), tools: descriptor(true, "read", "ME"), treeParent: descriptor(true, "read", "ME"),
    privateParent: descriptor(true, "host", mode === "natural-default" ? "absent" : "ME"), lowOwner: descriptor(true, "host", "LW"),
    lowFullDirectory: descriptor(true, "full", "LW"), lowFullFile: descriptor(false, "full", "LW"), program: descriptor(false, "read", "ME") });
}
export class WindowsNodeAssetEnforcementObservationError extends Error {
  constructor(readonly mode: WindowsNodeAssetEnforcementMode, readonly phase: number) {
    super(`The fixed native Node asset witness was refused in ${mode} at phase ${phase}.`);
    this.name = "WindowsNodeAssetEnforcementObservationError"; this.stack = `${this.name}: ${this.message}`;
  }
}

/** This wrapper observes the real promise and authenticates its real opaque return before signalling. */
export function observeWindowsNodeAssetStop(owner: WindowsCommandRootOnlyStopOwner, binding: object,
  authenticate: Bundle["requireWindowsCommandRootOnlyStopped"], observed: (ref: WindowsCommandRootOnlyStoppedRef, binding: object) => void): WindowsCommandRootOnlyStopOwner {
  return Object.freeze({ ...owner, stop(...args: Parameters<WindowsCommandRootOnlyStopOwner["stop"]>) {
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
    ensure(completed.outcome === "natural-exit" && completed.exitCode === 19 && output.complete && output.reason === "none" &&
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
    let phase = 1, loaded: Bundle | undefined, proof: ReturnType<Bundle["loadWindowsCommandCopyProofNative"]> | undefined,
      security: ReturnType<Bundle["loadWindowsNodeAssetEnforcementNative"]> | undefined,
      targetPins: ReturnType<ReturnType<Bundle["loadWindowsNodeAssetEnforcementNative"]>["pinTargets"]> | undefined,
      api: ReturnType<Bundle["loadExperimentalWindowsLpacApi"]> | undefined, profile: ReturnType<Bundle["createFreshWindowsCommandCreatorProfile"]> | undefined,
      node: Awaited<ReturnType<Bundle["createWindowsNodeToolchainAssets"]>> | undefined, copy: WindowsRootOnlyCommandCopy | undefined,
      io: ReturnType<Bundle["createWindowsCommandOutput"]> | undefined, launch: WindowsCommandOutputLaunchRef | undefined,
      script: Buffer | undefined, directory = "", live = true, assetCurrent = true, profileClosed = false;
    const pins: WindowsCommandCopyProofPin[] = [], directories: WindowsHandle[] = [], owners: WindowsCommandRootOnlyStopOwner[] = [], launches: WindowsCommandOutputLaunchRef[] = [];
    const output: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] }, totals = { stdout: 0, stderr: 0 }, abort = new AbortController(), assetAbort = new AbortController(), sharedAbort = new AbortController();
    let stopped: { ref: WindowsCommandRootOnlyStoppedRef; binding: object } | undefined;
    const graph = { asset, verifyBuild, resources, mode, pins, directories, owners, launches, output, abort, assetAbort, sharedAbort,
      get loaded() { return loaded; }, get proof() { return proof; }, get security() { return security; }, get targetPins() { return targetPins; }, get api() { return api; },
      get profile() { return profile; }, get node() { return node; }, get copy() { return copy; }, get io() { return io; }, get script() { return script; }, get directory() { return directory; } };
    const current = () => live && !terminal && proof?.unsafe !== true && security?.unsafe !== true && !profileClosed;
    const workCurrent = () => current() && !sharedAbort.signal.aborted;
    const guarded = <T>(fn: () => T): T => { ensure(current()); const result = fn(); ensure(current()); return result; };
    const native = <T>(fn: () => T): T => guarded(() => proof!.guard(fn));
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
      phase = 2; api = native(() => loaded!.loadExperimentalWindowsLpacApi()); profile = native(() => loaded!.createFreshWindowsCommandCreatorProfile());
      const selected = native(() => loaded!.windowsCommandCreatorProfile(profile!)), owner = native(() => api!.ownerSid());
      const id = guarded(dependencies.id ?? randomUUID); ensure(typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)); directory = path.join(scratchParent, `ember-node-asset-${id}`);
      const tools = path.join(directory, "tools"), treeParent = path.join(directory, "trees"), privateParent = path.join(directory, "assets"),
        lowOwner = path.join(directory, "low-owner"), lowFullDirectory = path.join(directory, "low-full"), lowFullFile = path.join(lowFullDirectory, "full-file.txt"), program = path.join(tools, "access-proof.exe");
      const creation = windowsNodeAssetCreationSecurity(owner, selected.sidText, mode);
      for (const [folder, descriptor] of [[directory, creation.directory], [tools, creation.tools], [treeParent, creation.treeParent], [privateParent, creation.privateParent],
        [lowOwner, creation.lowOwner], [lowFullDirectory, creation.lowFullDirectory]] as const) {
        native(() => api!.createDirectory(folder, descriptor)); directories.push(native(() => api!.pinDirectory(folder)));
      }
      native(() => api!.writeNewFile(lowFullFile, Buffer.from("EMBER_ASSET_CONTROL\n"), creation.lowFullFile));
      const bytes = native(() => pins[1].read()); try { native(() => api!.writeNewFile(program, bytes, creation.program)); } finally { bytes.fill(0); }
      pins.push(native(() => proof!.pin(program, 16 * 1024 * 1024))); const copied = native(() => pins[3].read()), original = native(() => pins[1].read());
      try { ensure(copied.equals(original)); } finally { copied.fill(0); original.fill(0); }
      script = native(() => pins[2].read());
      phase = 3; node = await loaded.createWindowsNodeToolchainAssets({ resourcesPath: resources, privateParent, profile,
        signal: AbortSignal.any([assetAbort.signal, sharedAbort.signal]), current: () => workCurrent() && assetCurrent });
      verified(); const roots = guarded(() => files.readdirSync(privateParent)); ensure(roots.length === 1 && /^ember-node-[0-9a-f-]{36}$/.test(String(roots[0])));
      const root = ordinary(path.join(privateParent, String(roots[0]))), image = ordinary(path.join(root, "node.exe")); ensure(guarded(() => files.readdirSync(root)).join("|") === "node.exe");
      targetPins = native(() => security!.pinTargets({ parent: privateParent, root, image, lowOwner, lowFullDirectory, lowFullFile, ownerSid: owner, packageSid: selected.sidText,
        parentLabel: mode === "natural-default" ? "default" : "explicit" }));
      copy = await loaded.WindowsRootOnlyCommandCopy.create({ parent: treeParent, protectedPaths: [tools, privateParent, lowOwner, lowFullDirectory, resources, path.dirname(asset.module)],
        entries: [{ path: "seed.txt", kind: "file", bytes: Buffer.from(NODE_ASSET_SEED), executable: false }, { path: "proof.cjs", kind: "file", bytes: script, executable: false }],
        creatorProfile: profile, packageSid: selected.sidText, current: workCurrent, packageCurrent: workCurrent, reviewCurrent: current }, { api,
        createStopOwner(binding) { const actual = native(() => loaded!.createWindowsCommandRootOnlyStopOwner(binding, api!)); owners.push(actual);
          return observeWindowsNodeAssetStop(actual, binding, loaded!.requireWindowsCommandRootOnlyStopped, (ref, exact) => { stopped = { ref, binding: exact }; }); } });
      const authenticateStop = (present: 0 | 1) => { ensure(stopped !== undefined); loaded!.requireWindowsCommandRootOnlyStopped(stopped!.ref, stopped!.binding);
        ensure(loaded!.requireWindowsCommandRootOnlyCompletion(stopped!.ref, stopped!.binding).rootPresent === present); };
      let prelude = 0;
      if (mode === "natural" || mode === "natural-default") {
        phase = 4; io = native(() => loaded!.createWindowsCommandOutput(profile!, { signal: abort.signal, timeoutMs: 8_000, output: collect }));
        const line = command([program, privateParent, root, image, lowOwner, lowFullDirectory, lowFullFile]);
        let run: WindowsCommandRootOnlyRunRef;
        try { run = await copy.launchRootOnlyWithOutput(context => { launch = io!.createSuspended(context, program, line); launches.push(launch); return launch; }, held => {
          native(() => api!.verifyToken(selected, held.process)); native(() => proof!.image(held.process, held.pid, program)); checkPins(); }); }
        finally { line.fill(0); }
        const done = await copy.completeRootOnly(run, io.signal), closed = await io.closeOutputAfterStopped(done, run); authenticateStop(1); facts("prelude", done, closed, run);
        native(() => targetPins!.recheck()); const created = guarded(() => files.readFileSync(path.join(lowFullDirectory, "access-create.txt")));
        try { ensure(created.equals(Buffer.from(CONTROL_CREATED))); } finally { created.fill(0); }
        prelude = 1; stopped = undefined; launch = undefined; io = undefined;
      }
      phase = 5; verified(); native(() => targetPins!.recheck());
      let result: Readonly<{ exitCode: number | null; reason: string; complete: boolean; stdoutBytes: number; stderrBytes: number }>;
      if (mode === "precreate") {
        let rejected = false;
        try { await copy.launchRootOnlyWithOutput(context => { assetCurrent = false; return node!.createSuspended(context, ["--preserve-symlinks", "--preserve-symlinks-main", "proof.cjs", "cancel"], { signal: abort.signal, timeoutMs: 8_000, output: collect }); }, () => undefined); }
        catch (error) { ensure(error instanceof loaded.ScopedCodingFileError && error.code === "cancelled"); rejected = true; }
        ensure(rejected && launch === undefined); authenticateStop(0); result = Object.freeze({ exitCode: null, reason: "cancelled", complete: false, stdoutBytes: 0, stderrBytes: 0 });
      } else {
        const payloadMode = mode === "preresume" || mode === "sharedcreate" ? "cancel" : mode === "natural-default" ? "natural" : mode;
        const run = await copy.launchRootOnlyWithOutput(context => { launch = node!.createSuspended(context, ["--preserve-symlinks", "--preserve-symlinks-main", "proof.cjs", payloadMode], { signal: abort.signal, timeoutMs: 8_000, output: collect });
          launches.push(launch); if (mode === "sharedcreate") sharedAbort.abort(); return launch; }, held => {
          native(() => proof!.image(held.process, held.pid, image)); checkPins(); if (mode === "preresume") assetCurrent = false; });
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
      for (const folder of [tools, treeParent, privateParent, lowOwner, lowFullDirectory]) { ensure(files.readdirSync(folder).length === 0); files.rmdirSync(folder); }
      ensure(files.readdirSync(directory).length === 0); files.rmdirSync(directory); ensure(!files.existsSync(directory)); script.fill(0); script = undefined; live = false;
      return Object.freeze({ schema: 1 as const, scope: 1 as const, mode, ...result, prelude, parentDefault: mode === "natural-default" ? 1 : 0, deniedAccess: prelude ? 255 : 0, positiveAccess: prelude ? 511 : 0,
        rootPresent: mode === "precreate" ? 0 : 1, outputClosed: mode === "precreate" ? 0 : 1,
        actualNode: mode === "precreate" || mode === "preresume" || mode === "sharedcreate" ? 0 : 1,
        stdinEof: mode === "precreate" || mode === "preresume" || mode === "sharedcreate" ? 0 : 1, rootOnlyStop: 1, snapshot: 1, seedUnchanged: 1,
        assetCleanup: 1, privateCleanup: 1, profileCleanup: 1, emittedCjs: 1 });
    } catch {
      live = false; terminal ??= new WindowsNodeAssetEnforcementObservationError(mode, phase); retained.push(graph);
      for (const value of launches) try { loaded!.retainWindowsCommandOutput(value); } catch { /* Same-graph quarantine supplies no disposal receipt. */ }
      for (const owner of owners) try { owner.retainStop(); } catch { /* Request exact Stop only; never retry cleanup or certify disposal. */ }
      throw terminal;
    } finally { busy = false; }
  };
}
const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
const observe = bindWindowsNodeAssetEnforcement({ load: file => require(file) as Bundle });
export const observeWindowsNodeAssetEnforcement = (asset: Asset, verifyBuild: () => void, resources: string, scratchParent: string, mode: WindowsNodeAssetEnforcementMode) => observe(asset, verifyBuild, resources, scratchParent, mode);
