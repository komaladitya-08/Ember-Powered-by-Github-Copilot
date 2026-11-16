/** A fixed ordinary-host POSIX observation. Legacy retirement false never grants Node or product authority. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path/win32";
import { createRequire } from "node:module";
import type { createWindowsCommandRootOnlyStopOwner, requireWindowsCommandRootOnlyCompletion } from "../../app/main/agent/windows-command-stop";
import type { createFreshWindowsCommandCreatorProfile, closeWindowsCommandCreatorProfile } from "../../app/main/agent/windows-command-creator-profile";
import type { loadWindowsCommandCopyProofNative, WindowsCommandCopyProofPin } from "./windows-command-copy-proof-native";
import type { loadWindowsOpenTargetPosixNative, WindowsOpenTargetPosixFixture } from "./windows-open-target-posix-native";
import { parseWindowsOpenTargetPosixReport } from "./windows-open-target-posix-report";

interface Bundle {
  createWindowsCommandRootOnlyStopOwner: typeof createWindowsCommandRootOnlyStopOwner;
  requireWindowsCommandRootOnlyCompletion: typeof requireWindowsCommandRootOnlyCompletion;
  createFreshWindowsCommandCreatorProfile: typeof createFreshWindowsCommandCreatorProfile;
  closeWindowsCommandCreatorProfile: typeof closeWindowsCommandCreatorProfile;
  loadWindowsCommandCopyProofNative: typeof loadWindowsCommandCopyProofNative;
  loadWindowsOpenTargetPosixNative: typeof loadWindowsOpenTargetPosixNative;
}
interface Asset { executable: string; module: string }
const retained: unknown[] = [];
const EXPECTED_EXPORTS = ["loadWindowsOpenTargetPosixNative", "WindowsOpenTargetPosixCleanupError", "createWindowsCommandRootOnlyStopOwner",
  "requireWindowsCommandRootOnlyPreparing", "requireWindowsCommandRootOnlyCompletion", "WindowsCommandRootOnlyCleanupError", "windowsCommandRootOnlyFailure",
  "createFreshWindowsCommandCreatorProfile", "windowsCommandCreatorProfile", "closeWindowsCommandCreatorProfile", "WindowsCommandCreatorProfileCleanupError",
  "loadWindowsCommandCopyProofNative", "WindowsCommandCopyProofCleanupError"].sort();
export class WindowsOpenTargetPosixObservationError extends Error {
  constructor(readonly phase: number) { super(`The fixed ordinary-host control was refused at phase ${phase}.`); this.name = "WindowsOpenTargetPosixObservationError"; this.stack = `${this.name}: ${this.message}`; }
}
const ordinary = (value: unknown): string => {
  if (typeof value !== "string" || value.length < 4 || value.length > 4096 || !/^[A-Za-z]:\\/.test(value) || path.normalize(value) !== value || /[\p{Cc}\p{Cf}]/u.test(value) || value.slice(3).split("\\").some(p => !p || /[:. ]$/.test(p) || p === "." || p === "..")) throw new Error();
  return value;
};
const inside = (root: string, value: string) => root.toLowerCase() === value.toLowerCase() || value.toLowerCase().startsWith(root.toLowerCase() + "\\");
const quote = (value: string) => `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
const command = (program: string, root: string, report: string) => {
  const value = [program, root, report].map(quote).join(" "); if (value.length >= 32767 || value.includes("\0")) throw new Error(); return Buffer.from(value + "\0", "utf16le");
};
export interface WindowsOpenTargetPosixDependencies {
  load(file: string): Bundle; files?: Pick<typeof fs, "lstatSync" | "realpathSync" | "existsSync">;
  managedTemporary?(): string; windowsDirectory?(): string; now?(): number; pause?(): Promise<void>;
}

/** Portable owner seam. The production wrapper accepts no injected bundle, native API or arbitrary program. */
export function bindWindowsOpenTargetPosixProof(dependencies: WindowsOpenTargetPosixDependencies) {
  const files = dependencies.files ?? fs, now = dependencies.now ?? (() => performance.now()), pause = dependencies.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 10)));
  let terminal: WindowsOpenTargetPosixObservationError | undefined, busy = false;
  return async (asset: Asset, verifyBuild: () => void, scratchParent: string) => {
    if (terminal) throw terminal; if (busy) throw new WindowsOpenTargetPosixObservationError(1); busy = true;
    let phase = 1, loaded: Bundle | undefined, proof: ReturnType<typeof loadWindowsCommandCopyProofNative> | undefined,
      native: ReturnType<typeof loadWindowsOpenTargetPosixNative> | undefined, fixture: WindowsOpenTargetPosixFixture | undefined,
      profile: ReturnType<typeof createFreshWindowsCommandCreatorProfile> | undefined, owner: ReturnType<typeof createWindowsCommandRootOnlyStopOwner> | undefined;
    let heldReport: Buffer | undefined;
    const pins: WindowsCommandCopyProofPin[] = [], graph = { asset, verifyBuild, pins, get loaded() { return loaded; }, get proof() { return proof; }, get native() { return native; }, get fixture() { return fixture; }, get profile() { return profile; }, get owner() { return owner; }, get report() { return heldReport; } };
    let live = true;
    const ensure = (value: unknown) => { if (value !== true) throw new Error(); };
    const current = () => live && !terminal && proof?.unsafe !== true;
    const guard = <T>(operation: () => T) => { ensure(current()); const value = operation(); ensure(current()); return value; };
    const verified = () => { ensure(guard(verifyBuild) === undefined); for (const pin of pins) guard(() => pin.unchanged()); };
    try {
      ordinary(asset.executable); ordinary(asset.module); ordinary(scratchParent); ensure(typeof verifyBuild === "function");
      for (const file of [asset.executable, asset.module]) ensure(!inside(scratchParent, file) && !inside(file, scratchParent));
      const ancestry = (file: string) => { for (let here = file;;) { const value = guard(() => files.lstatSync(here)); ensure(value.isDirectory() && !value.isSymbolicLink()); const next = path.dirname(here); if (next === here) break; here = next; } };
      ancestry(scratchParent); ensure(guard(() => files.realpathSync.native(scratchParent)).toLowerCase() === scratchParent.toLowerCase());
      const managed = ordinary(guard(dependencies.managedTemporary ?? (() => os.tmpdir()))); ancestry(managed);
      ensure(!inside(scratchParent, managed) && !inside(managed, scratchParent));
      verified(); loaded = guard(() => dependencies.load(asset.module));
      ensure(Object.keys(loaded).sort().join("|") === EXPECTED_EXPORTS.join("|") && Object.values(loaded).every(value => typeof value === "function"));
      proof = guard(() => loaded!.loadWindowsCommandCopyProofNative());
      // Issued pins enter the ledger synchronously; failed acquisitions retain this whole graph.
      pins.push(guard(() => proof!.pin(asset.module, 4 * 1024 * 1024))); pins.push(guard(() => proof!.pin(asset.executable, 4 * 1024 * 1024))); verified();
      phase = 2; native = guard(() => loaded!.loadWindowsOpenTargetPosixNative()); guard(() => native!.host.original());
      const binding = Object.freeze({}); owner = guard(() => loaded!.createWindowsCommandRootOnlyStopOwner(binding, native!.host.api));
      profile = guard(() => loaded!.createFreshWindowsCommandCreatorProfile());
      fixture = guard(() => native!.create(scratchParent, profile!, binding, current));
      verified(); const windows = ordinary(guard(dependencies.windowsDirectory ?? (() => process.env.SystemRoot ?? "C:\\Windows")));
      const environment = Buffer.from([`PATH=${path.join(windows, "System32")}`, `SystemRoot=${windows}`, `TEMP=${fixture.directory}`, `TMP=${fixture.directory}`, `WINDIR=${windows}`, "", ""].join("\0"), "utf16le");
      const argv = command(asset.executable, fixture.directory, fixture.report);
      phase = 3; let root: ReturnType<typeof native.host.create> | undefined;
      await owner.launch(() => root = guard(() => native!.host.create(asset.executable, argv, fixture!.directory, environment)),
        selected => { verified(); guard(() => native!.host.verify(selected, asset.executable)); guard(() => proof!.image(selected.process, selected.pid, asset.executable)); }, current);
      ensure(root !== undefined); phase = 4;
      let previous = guard(now); ensure(Number.isFinite(previous) && previous >= 0); const deadline = previous + 15_000;
      const budget = () => { const value = guard(now); ensure(Number.isFinite(value) && value >= previous && value < deadline); previous = value; };
      for (;;) { budget(); const exited = guard(() => native!.host.exited(root!.process)); budget(); if (exited) break; await pause(); budget(); }
      budget(); const exit = guard(() => native!.host.exitCode(root!.process)); budget(); ensure(exit === 0);
      phase = 5; const stopped = await owner.stop(); ensure(loaded.requireWindowsCommandRootOnlyCompletion(stopped, binding).rootPresent === 1);
      verified();
      phase = 6; const bytes = heldReport = guard(() => fixture!.readReport(stopped));
      const result = parseWindowsOpenTargetPosixReport(bytes);
      verified(); phase = 7; const cleanup = guard(() => fixture!.verifyAndClose(stopped, result.b.success, bytes));
      bytes.fill(0); heldReport = undefined; ensure(!guard(() => files.existsSync(fixture!.directory)));
      guard(() => loaded!.closeWindowsCommandCreatorProfile(profile!)); profile = undefined;
      phase = 8; verified(); for (const pin of pins.slice().reverse()) guard(() => pin.close()); pins.length = 0; live = false;
      return Object.freeze({ schema: 2, scope: 1, parameterEquivalent: 1, ordinaryHost: 1, rootOnlyStop: 1, ...cleanup, report: result });
    } catch {
      live = false; terminal ??= new WindowsOpenTargetPosixObservationError(phase); retained.push(graph);
      try { owner?.retainStop(); } catch { /* Unknown ownership retains the graph; no later query, read or disposal is attempted. */ }
      throw terminal;
    } finally { busy = false; }
  };
}

const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
const observe = bindWindowsOpenTargetPosixProof({ load: file => require(file) as Bundle });
export const observeWindowsOpenTargetPosix = (asset: Asset, verifyBuild: () => void, scratchParent: string) => observe(asset, verifyBuild, scratchParent);
