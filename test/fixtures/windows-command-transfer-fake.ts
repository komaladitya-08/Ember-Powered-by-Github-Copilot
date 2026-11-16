/** Genuine canonical/default Native/Stop/output issuers over fixed DLL models. No Windows execution claim. */
import { vi } from "vitest";
import { setupWindowsCodingSealedCopy } from "./windows-coding-sealed-copy-fake";

export async function setupWindowsCommandTransfer() {
  const dependency: { ffi?: unknown } = {};
  // Only the fixed DLL boundary is replaced. Every public factory, owner and opaque-ref issuer stays real.
  vi.doMock("node:module", async () => ({ ...await vi.importActual<typeof import("node:module")>("node:module"),
    createRequire: () => (name: string) => { if (name !== "koffi" || !dependency.ffi) throw Error("Unexpected fixed native dependency"); return dependency.ffi; } }));
  const canonical = await setupWindowsCodingSealedCopy();
  const { outputFake } = await import("./windows-command-output-fake"), s = outputFake();
  // This composition exercises several real output owners. Each OS folder-path query owns a fresh COM
  // allocation; the shared single-launch model's free-once guard remains strict for each allocation.
  const load = s.loader.getMockImplementation(); if (!load) throw Error("The fixed DLL model is unavailable");
  let profileGeneration = 0n;
  s.loader.mockImplementation(library => {
    const selected = load(library);
    return { func(prototype: string) {
      const target = selected.func(prototype);
      if (!/\bGetAppContainerFolderPath\s*\(/.test(prototype)) return target;
      return (...args: unknown[]) => {
        s.state.profilePointer = 0x20000000n + profileGeneration++ * 0x10000n; s.state.profileFrees = 0;
        return target(...args);
      };
    } };
  });
  const limits = Buffer.alloc(144), nativeCalls: string[] = [];
  const fn = (name: string, args: unknown[]): unknown => {
    nativeCalls.push(name);
    if (name === "CreateJobObjectW") return 50000n;
    if (name === "SetInformationJobObject") { (args[2] as Buffer).copy(limits); return 1; }
    if (name === "QueryInformationJobObject") {
      const bytes = args[2] as Buffer; bytes.fill(0);
      if (args[1] === 9) limits.copy(bytes);
      if (args[1] === 1) { bytes.writeUInt32LE(s.state.assigned ? 1 : 0, 36); bytes.writeUInt32LE(s.state.assigned && !s.state.ended ? 1 : 0, 40); }
      if (args[1] === 3 && s.state.assigned && !s.state.ended) { bytes.writeUInt32LE(1); bytes.writeUInt32LE(1, 4); bytes.writeBigUInt64LE(BigInt(s.state.returnedPid), 8); }
      return 1;
    }
    if (name === "AssignProcessToJobObject") { s.state.assigned = true; s.events.push("assign"); return 1; }
    if (name === "ResumeThread") { s.events.push("resume"); return 1; }
    if (name === "IsProcessInJob") { (args[2] as unknown[])[0] = s.state.assigned ? 1 : 0; return 1; }
    if (name === "GetProcessId" || name === "GetProcessIdOfThread") return s.state.returnedPid;
    if (name === "WaitForSingleObject") return s.state.ended ? 0 : 258;
    if (name === "GetExitCodeProcess") { (args[1] as Buffer).writeUInt32LE(s.state.code); return 1; }
    if (name === "TerminateJobObject" || name === "TerminateProcess") { s.state.ended = true; s.events.push(name); return 1; }
    if (name === "CloseHandle" && (args[0] as bigint) >= 50000n) { s.events.push("root-close"); return 1; }
    const handler = s.source.handlers[name]; if (!handler) throw Error("Unexpected fixed native call"); return handler(...args);
  };
  dependency.ffi = { ...s.source.native, sizeof: (name: string) => name === "void *" ? 8 : 4,
    load: () => ({ func: (prototype: string) => (...args: unknown[]) => fn(/\b(\w+)\s*\(/.exec(prototype)![1], args) }) };
  for (const folder of ["C:\\copies", "C:\\protected"]) s.source.add(folder, "directory");
  const copy = await canonical.create(), broker = await canonical.WindowsScopedCodingFiles.create({ copy, signal: copy.signal });
  s.options.signal = copy.signal;
  const input = await copy.captureCommandInput();
  const producer = await import("../../app/main/agent/windows-command-copy");
  const profiles = await import("../../app/main/agent/windows-command-creator-profile");
  const host = { packageSid: profiles.windowsCommandCreatorProfile(s.profile).sidText, creatorProfile: s.profile, packageCurrent: () => true };
  const create = () => producer.WindowsRootOnlyCommandCopy.createFromInput(input, host);
  const launch = async () => {
    const command = await create(), io = s.owner(); let output: ReturnType<typeof io.createSuspended> | undefined;
    const run = await command.launchRootOnlyWithOutput(context => output = io.createSuspended(context, "C:\\trusted\\node.exe", s.command), () => undefined);
    return { command, io, run, output: output! };
  };
  const finish = async (v: Awaited<ReturnType<typeof launch>>) => {
    s.state.ended = true;
    const done = await v.command.completeRootOnly(v.run, v.io.signal), closed = await v.io.closeOutputAfterStopped(done, v.run);
    return { done, closed };
  };
  const close = async () => { await broker.close(); await copy.close(); profiles.closeWindowsCommandCreatorProfile(s.profile); await canonical.store.close(); };
  return { canonical, s, copy, broker, input, producer, host, create, launch, finish, close, nativeCalls };
}
