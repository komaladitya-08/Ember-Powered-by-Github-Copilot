/** Fixed DLL boundary for the real output/lifecycle owners. No Windows API or child process is used. */
import { vi } from "vitest";
import { setup, OWNER } from "./windows-command-creator-native-fake";
import { bindWindowsCommandCreatorProfileNative, windowsCommandCreatorProfile } from "../../app/main/agent/windows-command-creator-profile";
import { bindWindowsCommandOutputNative, type WindowsCommandOutputFence, type WindowsCommandOutputLaunchRef } from "../../app/main/agent/windows-command-output";
import { WindowsRootOnlyCommandCopy, type WindowsRootOnlyCommandCopyFence } from "../../app/main/agent/windows-command-copy";
import { createWindowsCommandRootOnlyStopOwner, type WindowsCommandRootOnlyStopFence } from "../../app/main/agent/windows-command-stop";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";

function freshProfile(text: string) {
  const parts = text.split("-").slice(3).map(Number), bytes = Buffer.alloc(8 + 4 * parts.length);
  bytes[0] = 1; bytes[1] = parts.length; bytes[7] = 15; parts.forEach((part, index) => bytes.writeUInt32LE(part, 8 + 4 * index));
  return bindWindowsCommandCreatorProfileNative({ sizeof: () => 8, decode: () => Buffer.from(bytes) } as unknown as Parameters<typeof bindWindowsCommandCreatorProfileNative>[0], () => ({
    func(prototype) { const name = /\b(\w+)\s*\(/.exec(prototype)![1]; return (...args: unknown[]) => {
      if (name === "CreateAppContainerProfile") { (args[5] as unknown[])[0] = 0x900000n; return 0; }
      if (name === "IsValidSid") return 1; if (name === "GetLengthSid") return bytes.length;
      if (name === "DeleteAppContainerProfile") return 0; if (name === "FreeSid") return null; throw Error("Unexpected fixed profile function.");
    }; },
  }), { retained: [] }).create();
}
interface Pipe { name: string; server: bigint; writer?: bigint; connected: boolean; chunks: Buffer[]; pending?: { bytes: Buffer; ov: Buffer }; cancelled: boolean }
export function outputFake() {
  const source = setup(), profile = freshProfile(source.control.tokenPackage), events: string[] = [], trace: string[] = [], calls: { name: string; args: unknown[]; traceIndex: number; result?: unknown }[] = [];
  const handles = new Map<bigint, { kind: "pipe" | "null" | "event"; flags: number; creationFlags: number; closed: boolean }>(), pipes: Pipe[] = [];
  const allocations = new Map<unknown, { bytes: Buffer; address: bigint; freed: boolean }>();
  const attributes = new Map<number, Buffer>(), addresses = new Map<bigint, Buffer>(), reverseAddresses = new WeakMap<Buffer, bigint>(), output: { stream: string; bytes: Buffer }[] = [];
  const state = { ended: false, holdEOF: false, assigned: false, code: 0, now: 100, fault: "", faultMode: "throw", abi: "", timeout: 30000,
    error: 0, creates: 0, memoryFault: "", synchronousWrite: false, onNative: undefined as ((name: string, args: unknown[]) => void) | undefined,
    afterNative: undefined as ((name: string, args: unknown[], result: unknown) => unknown) | undefined,
    onOutput: undefined as (() => void) | undefined, deliveryReturn: undefined as unknown, deliveryFactory: undefined as (() => unknown) | undefined,
    inherited: [] as bigint[], environment: "", flags: 0,
    profilePointer: 0x20000000n as unknown, profileResult: 0 as unknown, profileFrees: 0, profileDecodes: 0, handleBase: 0n,
    profileText: `C:\\Users\\synthetic\\AppData\\Local\\Packages\\${windowsCommandCreatorProfile(profile).name}\\AC` as unknown,
    onString: undefined as (() => void) | undefined,
    returnedProcess: 50001n, returnedThread: 50002n, returnedPid: 50003 };
  let next = 100n;
  const own = (kind: "pipe" | "null" | "event", creationFlags = 0) => { const value = state.handleBase + next++; handles.set(value, { kind, flags: 0, creationFlags, closed: false }); return value; };
  const memory = (value: unknown): Buffer => { if (Buffer.isBuffer(value)) return value;
    const allocation = allocations.get(value); if (!allocation || allocation.freed) throw Error("Invalid stable memory"); return allocation.bytes;
  };
  const failure = () => { state.error = 5; if (state.faultMode === "throw") throw Error("PRIVATE native failure"); return state.faultMode === "bad" ? "bad" : 0; };
  const fn = (name: string, ...args: unknown[]): unknown => {
    calls.push({ name, args, traceIndex: trace.length }); trace.push(name); state.onNative?.(name, args); if (state.fault === name) return failure();
    if (name === "GetLastError") return state.error;
    if (name === "ConvertStringSecurityDescriptorToSecurityDescriptorW") { (args[2] as Buffer).writeBigUInt64LE(900n); return 1; }
    if (name === "LocalFree") return null;
    if (name === "GetAppContainerFolderPath") { (args[1] as unknown[])[0] = state.profilePointer; return state.profileResult; }
    if (name === "CoTaskMemFree") { if (args[0] !== state.profilePointer || state.profileFrees) throw Error("Invalid COM release"); state.profileFrees++; events.push("profile-free"); return undefined; }
    if (name === "CreateNamedPipeW") { const server = own("pipe", args[1] as number); pipes.push({ name: args[0] as string, server, connected: false, chunks: [], cancelled: false }); return server; }
    if (name === "CreateEventW") return own("event");
    if (name === "ResetEvent") return 1;
    if (name === "CreateFileW") {
      if (args[0] === "\\\\?\\GLOBALROOT\\Device\\Null") return own("null", args[5] as number);
      const pipe = pipes.find(value => value.name === args[0])!; pipe.writer = own("pipe", args[5] as number); pipe.connected = true; return pipe.writer;
    }
    if (name === "GetFileType") return handles.get(args[0] as bigint)?.kind === "null" ? 2 : 3;
    if (name === "GetHandleInformation") { (args[1] as Buffer).writeUInt32LE(handles.get(args[0] as bigint)!.flags); return 1; }
    if (name === "SetHandleInformation") { handles.get(args[0] as bigint)!.flags = args[2] as number; return 1; }
    if (name === "CloseHandle") { const handle = handles.get(args[0] as bigint)!; if (handle.closed) throw Error("Double close"); handle.closed = true; events.push("io-close"); return 1; }
    if (name === "ConnectNamedPipe") { state.error = 997; return 0; }
    if (name === "ReadFile") {
      if (handles.get(args[0] as bigint)?.kind === "null") { (args[3] as Buffer).writeUInt32LE(0); return 1; }
      const pipe = pipes.find(value => value.server === args[0])!;
      if (state.ended && !state.holdEOF && !pipe.chunks.length) { state.error = 109; return 0; }
      pipe.pending = { bytes: memory(args[1]), ov: memory(args[4]) }; state.error = 997; return 0;
    }
    if (name === "GetOverlappedResult") {
      const pipe = pipes.find(value => value.server === args[0])!;
      if (!pipe.pending) { (args[2] as Buffer).writeUInt32LE(0); return 1; } // Native connection completion.
      if (pipe.cancelled) { pipe.cancelled = false; pipe.pending = undefined; state.error = 995; return 0; }
      if (pipe.chunks.length) { const bytes = pipe.chunks.shift()!; bytes.copy(pipe.pending.bytes); (args[2] as Buffer).writeUInt32LE(bytes.length); pipe.pending = undefined; return 1; }
      if (state.ended && !state.holdEOF) { pipe.pending = undefined; state.error = 109; return 0; }
      state.error = 996; return 0;
    }
    if (name === "CancelIoEx") { pipes.find(value => value.server === args[0])!.cancelled = true; return 1; }
    if (name === "GetWindowsDirectoryW") { const bytes = Buffer.from("C:\\Windows\0", "utf16le"); bytes.copy(args[0] as Buffer); return 10; }
    if (name === "NtQueryObject") {
      const buffer = args[2] as Buffer, text = Buffer.from("\\Device\\Null\0", "utf16le"), address = native.address(buffer);
      buffer.writeUInt16LE(text.length - 2); buffer.writeUInt16LE(text.length, 2); buffer.writeBigUInt64LE(address + 16n, 8); text.copy(buffer, 16);
      (args[4] as Buffer).writeUInt32LE(16 + text.length); return 0;
    }
    if (name === "InitializeProcThreadAttributeList") { (args[3] as Buffer).writeBigUInt64LE(64n); if (args[0] === null) { state.error = 122; return 0; } return 1; }
    if (name === "UpdateProcThreadAttribute") { attributes.set(args[2] as number, memory(args[3])); return 1; }
    if (name === "DeleteProcThreadAttributeList") { events.push("attributes-delete"); return undefined; }
    if (name === "CreateProcessW") {
      state.creates++; state.flags = args[5] as number; state.environment = (args[6] as Buffer).toString("utf16le");
      const inherited = attributes.get(0x20002)!; state.inherited = [0, 8, 16].map(offset => inherited.readBigUInt64LE(offset));
      if (state.inherited.some(handle => handles.get(handle)!.flags !== 1)) throw Error("Missing owned inheritance");
      const information = args[9] as Buffer; information.writeBigUInt64LE(state.returnedProcess); information.writeBigUInt64LE(state.returnedThread, 8); information.writeUInt32LE(state.returnedPid, 16);
      events.push("native-create"); return 1;
    }
    if (name === "TerminateProcess") { state.ended = true; events.push("producer-terminate"); return 1; }
    throw Error("Unexpected fixed output prototype");
  };
  const native = { sizeof: (name: string) => state.abi === name ? 2 : name === "void *" || name === "size_t" ? 8 : 4,
    alloc: (_type: string, size: number) => { trace.push("alloc"); if (state.memoryFault === "alloc") throw Error("PRIVATE alloc failure");
      const ref = Object.freeze({ allocation: allocations.size }); allocations.set(ref, { bytes: Buffer.alloc(size), address: BigInt(0xb000000 + allocations.size * 0x100000), freed: false }); events.push("alloc"); return ref;
    },
    free: (ref: unknown) => { trace.push("free"); if (state.memoryFault === "free") throw Error("PRIVATE free failure"); const value = allocations.get(ref)!;
      if (value.freed) throw Error("Duplicate stable free"); value.freed = true; events.push("free");
    },
    encode: (ref: unknown, _type: string, bytes: Buffer, size: number) => { trace.push("encode"); if (state.memoryFault === "encode") throw Error("PRIVATE encode failure");
      if (size !== bytes.length || size !== memory(ref).length) throw Error("Invalid stable encode"); bytes.copy(memory(ref));
    },
    decode: Object.assign((ref: unknown, _type: string, size: number) => { trace.push("decode"); if (state.memoryFault === "decode") throw Error("PRIVATE decode failure"); return Uint8Array.from(memory(ref).subarray(0, size)); }, {
      string16: (ref: unknown) => { trace.push("decode.string16"); state.profileDecodes++; state.onString?.();
        if (state.memoryFault === "string16" || ref !== state.profilePointer) throw Error("PRIVATE profile decode failure"); return state.profileText; },
    }),
    address: (buffer: unknown) => { if (allocations.has(buffer)) return allocations.get(buffer)!.address;
      if (!Buffer.isBuffer(buffer)) throw Error("Invalid address"); const existing = reverseAddresses.get(buffer); if (existing) return existing;
      const value = BigInt(0xa00000 + addresses.size * 0x10000); addresses.set(value, buffer); reverseAddresses.set(buffer, value); return value; } };
  const loader = vi.fn((_library: string) => ({ func(prototype: string) { const name = /\b(\w+)\s*\(/.exec(prototype)![1]; return (...args: unknown[]) => {
    const index = calls.length, result = fn(name, ...args), returned = state.afterNative ? state.afterNative(name, args, result) : result;
    calls[index].result = returned; return returned;
  }; } }));
  const abort = new AbortController(), fence: WindowsCommandOutputFence = { retained: [] };
  const options = { signal: abort.signal, timeoutMs: state.timeout, output(bytes: Uint8Array, stream: "stdout" | "stderr") { output.push({ stream, bytes: Buffer.from(bytes) }); state.onOutput?.(); return state.deliveryFactory ? state.deliveryFactory() : state.deliveryReturn; } };
  const owner = () => bindWindowsCommandOutputNative(native as unknown as Parameters<typeof bindWindowsCommandOutputNative>[0], loader, profile, { ownerSid: OWNER }, { ...options, timeoutMs: state.timeout }, fence, () => state.now);
  const stopFence: WindowsCommandRootOnlyStopFence = { retained: [] }, copyFence: WindowsRootOnlyCommandCopyFence = { retained: [] };
  const api = { createJob: () => 50000n, assign() { state.assigned = true; events.push("assign"); }, resume() { events.push("resume");
    if (state.synchronousWrite) for (const pipe of pipes) { if (handles.get(pipe.writer!)!.creationFlags & 0x40000000) { state.code = 9; state.ended = true; }
      else pipe.chunks.push(Buffer.from("CRT synchronous write")); }
  },
    terminateProcess() { state.ended = true; events.push("stop-root"); }, terminateJob() { state.ended = true; events.push("stop-job"); } } as unknown as WindowsLpacApi;
  const stopNative = {
    configure() {}, assertLimits() {}, state: () => ({ total: state.assigned ? 1 : 0, active: state.assigned && !state.ended ? 1 : 0, pids: state.assigned && !state.ended ? [state.returnedPid] : [] }),
    processId: () => state.returnedPid, threadProcessId: () => state.returnedPid, member: () => state.assigned,
    wait: (): 0 | 258 => state.ended ? 0 : 258, close() { events.push("root-close"); },
  };
  const prepare = () => WindowsRootOnlyCommandCopy.create({ ...source.input(), creatorProfile: profile,
    packageSid: windowsCommandCreatorProfile(profile).sidText, packageCurrent: () => true, reviewCurrent: () => true }, {
    api, fence: copyFence, createTree: input => source.binding.createFreshWindowsCommandTree(input),
    createStopOwner: binding => createWindowsCommandRootOnlyStopOwner(binding, api, stopNative, () => 100, stopFence, () => ({ exitCode: () => state.code })),
  });
  const command = Buffer.from('"C:\\trusted\\node.exe" fixed.js\0', "utf16le");
  const launch = async () => {
    const copy = await prepare(), io = owner(); let ref: WindowsCommandOutputLaunchRef | undefined;
    const run = await copy.launchRootOnlyWithOutput(context => ref = io.createSuspended(context, "C:\\trusted\\node.exe", command), () => { events.push("attest"); });
    return { copy, io, run, ref: ref! };
  };
  return { source, profile, events, trace, state, calls, pipes, handles, allocations, output, native, loader, abort, fence, options, owner, prepare, stopFence, copyFence, command, launch,
    enqueue(index: number, bytes: Buffer) { pipes[index].chunks.push(bytes); } };
}
