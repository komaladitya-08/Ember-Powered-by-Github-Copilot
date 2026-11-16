/** Portable FFI ownership contracts only. No native DLL, tool, driver, download or collector is executed. */
import { describe, expect, it, vi } from "vitest";
import { bindWindowsLpacChildAccessNative, WINDOWS_LPAC_CHILD_ACCESS_NATIVE_FUNCTIONS,
  WindowsLpacChildAccessNativeCleanupError, windowsLpacChildAccessNativeReceipt,
  type WindowsLpacChildAccessNativeFence } from "../fixtures/windows-lpac-child-access-native";

const FILE = "C:\\private\\tool\\Procmon64.exe", CWD = "C:\\private\\work";
const command = Buffer.from(`"${FILE}" /AcceptEula /Quiet\0`, "utf16le"), environment = Buffer.from("SystemRoot=C:\\Windows\0\0", "utf16le");
type Call = { name: string; args: unknown[] };
type Process = { id: number; image: string; alive: boolean; job?: bigint };
function fixture(clock?: () => number) {
  const calls: Call[] = [], closed: bigint[] = [], buffers: Buffer[] = [], overrides = new Map<string, (...args: unknown[]) => unknown>();
  const fence: WindowsLpacChildAccessNativeFence = { retained: [] };
  const files = new Map<bigint, { file: string; bytes: Buffer; position: number; version: number }>();
  const processes = new Map<bigint, Process>(), jobs = new Map<bigint, { limits: Buffer; members: bigint[]; empty: boolean }>();
  const tokens = new Map<bigint, bigint>(), snapshots = new Map<bigint, number>();
  const signalOnWait = new Set<bigint>(); let value = 10n, lastError = 5, ac = 0, elevation = 1, returnedBytes = 4, now = 100;
  let rows: { id: number; name: string }[] | undefined, finalJobActive = false;
  const allocate = () => ++value;
  const writeInfo = (file: bigint, output: Buffer) => {
    const entry = files.get(file)!; output.fill(0); output.writeUInt32LE(0x20); output.writeUInt32LE(1, 4);
    output.writeUInt32LE(entry.version, 20); output.writeUInt32LE(9, 28); output.writeUInt32LE(entry.bytes.length, 36);
    output.writeUInt32LE(1, 40); output.writeUInt32LE(Number(file), 48);
  };
  const fillEntry = (output: Buffer, entry: { id: number; name: string }) => {
    output.fill(0); output.writeUInt32LE(568); output.writeUInt32LE(entry.id, 8); Buffer.from(entry.name, "utf16le").copy(output, 44);
  };
  const processRows = () => rows ?? [{ id: 4, name: "System" }, ...[...processes.values()].filter(p => p.alive).map(p => ({ id: p.id, name: p.image.slice(p.image.lastIndexOf("\\") + 1) }))];
  const invoke = (name: string, args: unknown[]): unknown => {
    calls.push({ name, args });
    const override = overrides.get(name); if (override) return override(...args);
    if (name === "GetLastError") return lastError;
    if (name === "GetCurrentProcess") return 0xffffffffffffffffn;
    if (name === "GetDriveTypeW") return 3;
    if (name === "CreateFileW") { const handle = allocate(); files.set(handle, { file: args[0] as string, bytes: Buffer.from("fixed bytes"), position: 0, version: 1 }); return handle; }
    if (name === "GetFileType") return 1;
    if (name === "GetFileInformationByHandle") { buffers.push(args[1] as Buffer); writeInfo(args[0] as bigint, args[1] as Buffer); return 1; }
    if (name === "GetFinalPathNameByHandleW") {
      const text = `\\\\?\\${files.get(args[0] as bigint)!.file}`; Buffer.from(text, "utf16le").copy(args[1] as Buffer); return text.length;
    }
    if (name === "SetFilePointerEx") { files.get(args[0] as bigint)!.position = Number(args[1]); (args[2] as unknown[])[0] = 0n; return 1; }
    if (name === "ReadFile") {
      const file = files.get(args[0] as bigint)!, output = args[1] as Buffer, count = Math.min(output.length, file.bytes.length - file.position);
      file.bytes.copy(output, 0, file.position, file.position + count); file.position += count; (args[3] as unknown[])[0] = count; return 1;
    }
    if (name === "CreateJobObjectW") { const handle = allocate(); jobs.set(handle, { limits: Buffer.alloc(144), members: [], empty: false }); return handle; }
    if (name === "SetInformationJobObject") { jobs.get(args[0] as bigint)!.limits = Buffer.from(args[2] as Buffer); return 1; }
    if (name === "QueryInformationJobObject") {
      const job = jobs.get(args[0] as bigint)!, output = args[2] as Buffer; buffers.push(output); output.fill(0);
      if (args[1] === 9) { job.limits.copy(output); return 1; } if (args[1] === 4) return 1;
      if (args[1] === 1) { output.writeUInt32LE(finalJobActive || !job.empty ? job.members.length : 0, 40); return 1; }
      const members = job.empty ? [] : job.members;
      output.writeUInt32LE(members.length, 0); output.writeUInt32LE(members.length, 4);
      members.forEach((handle, index) => output.writeBigUInt64LE(BigInt(processes.get(handle)!.id), 8 + index * 8)); return 1;
    }
    if (name === "CreateProcessW") {
      const process = allocate(), thread = allocate(), id = 1000 + Number(process), information = args[9] as Buffer;
      processes.set(process, { id, image: args[0] as string, alive: true });
      information.writeBigUInt64LE(process, 0); information.writeBigUInt64LE(thread, 8); information.writeUInt32LE(id, 16); information.writeUInt32LE(id + 100, 20); return 1;
    }
    if (name === "AssignProcessToJobObject") {
      jobs.get(args[0] as bigint)!.members.push(args[1] as bigint); processes.get(args[1] as bigint)!.job = args[0] as bigint; return 1;
    }
    if (name === "GetProcessId") return processes.get(args[0] as bigint)?.id ?? 0;
    if (name === "QueryFullProcessImageNameW") {
      const image = processes.get(args[0] as bigint)!.image; Buffer.from(image, "utf16le").copy(args[2] as Buffer); (args[3] as unknown[])[0] = image.length; return 1;
    }
    if (name === "IsProcessInJob") { (args[2] as unknown[])[0] = processes.get(args[0] as bigint)!.job === args[1] ? 1 : 0; return 1; }
    if (name === "OpenProcess") { const entry = [...processes.entries()].find(([, p]) => p.id === args[2]); return entry?.[0] ?? null; }
    if (name === "ResumeThread") return 1;
    if (name === "WaitForSingleObject") {
      const process = processes.get(args[0] as bigint); if (!process) return 0xffffffff;
      if ((args[1] as number) > 0 && signalOnWait.has(args[0] as bigint)) process.alive = false;
      return process.alive ? 258 : 0;
    }
    if (name === "GetExitCodeProcess") { (args[1] as unknown[])[0] = 0; return 1; }
    if (name === "TerminateProcess") { processes.get(args[0] as bigint)!.alive = false; return 1; }
    if (name === "TerminateJobObject") {
      const job = jobs.get(args[0] as bigint)!; job.empty = true; for (const member of job.members) processes.get(member)!.alive = false; return 1;
    }
    if (name === "OpenProcessToken") { const token = allocate(); tokens.set(token, args[0] as bigint); (args[2] as unknown[])[0] = token; return 1; }
    if (name === "GetTokenInformation") { const output = args[2] as Buffer; output.writeUInt32LE(args[1] === 20 ? elevation : ac); (args[4] as unknown[])[0] = returnedBytes; return 1; }
    if (name === "CreateToolhelp32Snapshot") { const snapshot = allocate(); snapshots.set(snapshot, -1); return snapshot; }
    if (name === "Process32FirstW" || name === "Process32NextW") {
      const snapshot = args[0] as bigint, index = name === "Process32FirstW" ? 0 : snapshots.get(snapshot)! + 1; snapshots.set(snapshot, index);
      const entry = processRows()[index]; if (!entry) { lastError = 18; return 0; } fillEntry(args[1] as Buffer, entry); return 1;
    }
    if (name === "CloseHandle") { closed.push(args[0] as bigint); return 1; }
    throw new Error("Unexpected mock native operation.");
  };
  const load = vi.fn((_name: string) => ({ func: vi.fn((prototype: string) => {
    const name = /\b(\w+)\s*\(/.exec(prototype)![1]; return (...args: unknown[]) => invoke(name, args);
  }) }));
  const native = bindWindowsLpacChildAccessNative({ sizeof: () => 8 }, load, fence, clock ?? (() => now));
  const pin = () => native.pinFile(FILE, 1024), launch = () => { const asset = pin(); return { asset, tool: native.launchTool({ program: FILE, command, cwd: CWD, environment, pin: asset }) }; };
  const root = () => [...processes.entries()][0];
  return { native, calls, closed, buffers, fence, files, processes, jobs, tokens, load, pin, launch,
    set(name: string, operation: (...args: unknown[]) => unknown) { overrides.set(name, operation); }, clear(name: string) { overrides.delete(name); },
    rows(value: { id: number; name: string }[]) { rows = value; }, ac(value: number) { ac = value; }, elevation(value: number) { elevation = value; }, returned(value: number) { returnedBytes = value; },
    time(value: number) { now = value; }, lastError(value: number) { lastError = value; }, finalActive() { finalJobActive = true; },
    root,
    finish(keepAlive?: bigint) { for (const job of jobs.values()) job.empty = true; for (const [handle, process] of processes) process.alive = handle === keepAlive; },
    addAux() {
      const [rootHandle, parent] = root(), handle = allocate(); processes.set(handle, { id: 2000 + Number(handle), image: "C:\\Windows\\System32\\conhost.exe", alive: true, job: parent.job });
      jobs.get(parent.job!)!.members.push(handle); return { handle, id: processes.get(handle)!.id, rootHandle };
    }, signalOnWait(handle: bigint) { signalOnWait.add(handle); },
  };
}

describe("manual child access native owner", () => {
  it("binds only fixed system DLL functions and refuses unsupported ABI without executing a tool", () => {
    const f = fixture(); expect(f.load.mock.calls.map(call => call[0])).toEqual(["kernel32.dll", "advapi32.dll"]);
    expect(Object.values(WINDOWS_LPAC_CHILD_ACCESS_NATIVE_FUNCTIONS).flat()).toHaveLength(29);
    expect(f.calls).toEqual([]); expect(() => bindWindowsLpacChildAccessNative({ sizeof: () => 4 }, f.load)).toThrow();
  });
  it("requires exact ordinary elevated current token facts and closes its query token without closing the pseudo handle", () => {
    const f = fixture(); f.native.requireAdministrator();
    expect(f.calls.filter(call => call.name === "GetTokenInformation").map(call => call.args[1])).toEqual([29, 20]);
    expect(f.closed).toEqual([...f.tokens.keys()]); expect(f.closed).not.toContain(0xffffffffffffffffn);
  });
  it.each(["appcontainer", "unelevated"])("refuses a known unsupported administrator token while closing the known token (%s)", kind => {
    const f = fixture(); if (kind === "appcontainer") f.ac(1); else f.elevation(0);
    expect(() => f.native.requireAdministrator()).toThrow(); expect(f.closed).toEqual([...f.tokens.keys()]); expect(f.fence.failure).toBeUndefined();
  });
  it("fences malformed token query bytes after closing the acquired query handle", () => {
    const f = fixture(); f.returned(1); expect(() => f.native.requireAdministrator()).toThrow(WindowsLpacChildAccessNativeCleanupError);
    expect(f.closed).toEqual([...f.tokens.keys()]); expect(f.fence.retained).toHaveLength(1);
  });
  it("retains unknown token acquisition output and makes no later native query or close", () => {
    const f = fixture(); f.set("OpenProcessToken", (...args) => { (args[2] as unknown[])[0] = 55n; return 0; });
    expect(() => f.native.requireAdministrator()).toThrow(WindowsLpacChildAccessNativeCleanupError);
    expect(f.calls.at(-1)?.name).toBe("OpenProcessToken"); expect(f.closed).toEqual([]); expect(f.fence.retained).toHaveLength(1);
  });
  it("pins one ordinary local disk file without WRITE or DELETE sharing and reads only that exact handle", () => {
    const f = fixture(), pin = f.pin(); expect(pin.size).toBe(11); expect(pin.read().toString()).toBe("fixed bytes");
    expect(f.calls.find(call => call.name === "CreateFileW")?.args).toEqual([FILE, 0x80000080, 1, null, 3, 0x00200000, null]);
    expect(f.calls.filter(call => call.name === "CreateFileW")).toHaveLength(1);
    const handle = [...f.files.keys()][0]; expect(f.calls.filter(call => call.name === "ReadFile").every(call => call.args[0] === handle)).toBe(true);
    pin.close(); pin.close(); expect(f.closed).toEqual([handle]);
  });
  it.each([0, 0n])("reads the exact pinned file after either documented literal int64 zero representation (%#)", position => {
    const f = fixture(), pin = f.pin();
    f.set("SetFilePointerEx", (...args) => {
      expect(args[1]).toBe(0n); expect(args[3]).toBe(0); expect((args[2] as unknown[])[0]).toBeUndefined();
      f.files.get(args[0] as bigint)!.position = 0; (args[2] as unknown[])[0] = position; return 1;
    });
    const bytes = pin.read(); expect(bytes.toString()).toBe("fixed bytes"); bytes.fill(0);
    expect(f.calls.filter(call => call.name === "CreateFileW")).toHaveLength(1);
    const handle = [...f.files.keys()][0]; expect(f.calls.filter(call => call.name === "ReadFile").every(call => call.args[0] === handle)).toBe(true);
    pin.close(); expect(f.closed).toEqual([handle]);
  });
  it.each([1, -1, 0.5, 1n, -1n, NaN, Infinity, -Infinity, "0", "0n", "", null, undefined, false, true, {}, Object(0n)])("fences nonzero or unknown seek outputs before any content read (%#)", position => {
    const f = fixture(), pin = f.pin();
    f.set("SetFilePointerEx", (...args) => { (args[2] as unknown[])[0] = position; return 1; });
    expect(() => pin.read()).toThrow(WindowsLpacChildAccessNativeCleanupError);
    expect(f.calls.filter(call => call.name === "ReadFile")).toEqual([]); expect(f.calls.at(-1)?.name).toBe("SetFilePointerEx");
    const calls = f.calls.length; f.clear("SetFilePointerEx");
    expect(() => pin.read()).toThrow(WindowsLpacChildAccessNativeCleanupError); expect(() => pin.close()).toThrow(WindowsLpacChildAccessNativeCleanupError);
    expect(f.calls).toHaveLength(calls); expect(f.closed).toEqual([]); expect(f.fence.retained).toHaveLength(1);
  });
  it("requires an observed output and never coerces an object into a zero seek position", () => {
    for (const written of [false, true]) {
      const f = fixture(), pin = f.pin(), coerce = vi.fn(() => 0), position = { valueOf: coerce, toString: coerce };
      f.set("SetFilePointerEx", (...args) => { if (written) (args[2] as unknown[])[0] = position; return 1; });
      expect(() => pin.read()).toThrow(WindowsLpacChildAccessNativeCleanupError); expect(coerce).not.toHaveBeenCalled();
      expect(f.calls.filter(call => call.name === "ReadFile")).toEqual([]); expect(f.closed).toEqual([]);
    }
  });
  it.each([0, false, true, undefined, "1", new Error("private native seek failure")])("keeps failed, thrown or malformed native seek results terminal even with zero output (%#)", result => {
    const f = fixture(), pin = f.pin();
    f.set("SetFilePointerEx", (...args) => { (args[2] as unknown[])[0] = 0; if (result instanceof Error) throw result; return result; });
    expect(() => pin.read()).toThrow(WindowsLpacChildAccessNativeCleanupError);
    expect(f.calls.filter(call => call.name === "ReadFile")).toEqual([]); expect(f.closed).toEqual([]);
    const calls = f.calls.length; expect(() => pin.close()).toThrow(WindowsLpacChildAccessNativeCleanupError); expect(f.calls).toHaveLength(calls);
  });
  it.each(["\\\\server\\share\\trace.csv", "C:\\private\\..\\trace.csv", "C:\\private\\trace.csv:secret", "C:\\private\\bad.\\trace.csv", "C:\\private\ntrace.csv"])("rejects unsupported paths before a native acquisition (%#)", file => {
    const f = fixture(); expect(() => f.native.pinFile(file, 1024)).toThrow(); expect(f.calls).toEqual([]);
  });
  it("refuses a nonlocal drive before opening any artifact", () => {
    const f = fixture(); f.set("GetDriveTypeW", () => 4); expect(() => f.pin()).toThrow(); expect(f.calls.map(call => call.name)).toEqual(["GetDriveTypeW"]);
  });
  it("fences an unavailable writer-excluding pin instead of reading or retrying a still-written trace", () => {
    const f = fixture(); f.set("CreateFileW", () => 0xffffffffffffffffn); f.lastError(32);
    expect(() => f.pin()).toThrow(WindowsLpacChildAccessNativeCleanupError); const count = f.calls.length;
    expect(() => f.pin()).toThrow(WindowsLpacChildAccessNativeCleanupError); expect(f.calls).toHaveLength(count); expect(f.closed).toEqual([]);
  });
  it.each(["directory", "reparse", "links", "size", "type"])("refuses invalid artifact metadata before allocating or reading content (%s)", kind => {
    const f = fixture();
    if (kind === "type") f.set("GetFileType", () => 2);
    else f.set("GetFileInformationByHandle", (...args) => {
      const bytes = args[1] as Buffer; bytes.writeUInt32LE(kind === "directory" ? 0x10 : kind === "reparse" ? 0x400 : 0x20); bytes.writeUInt32LE(kind === "size" ? 999999 : 11, 36); bytes.writeUInt32LE(kind === "links" ? 2 : 1, 40); return 1;
    });
    expect(() => f.pin()).toThrow(); expect(f.calls.filter(call => call.name === "ReadFile")).toEqual([]); expect(f.closed).toHaveLength(1);
  });
  it("retires a pinned artifact when its immutable identity changes", () => {
    const f = fixture(), pin = f.pin(); [...f.files.values()][0].version++;
    expect(() => pin.unchanged()).toThrow(WindowsLpacChildAccessNativeCleanupError); const count = f.calls.length;
    expect(() => pin.read()).toThrow(WindowsLpacChildAccessNativeCleanupError); expect(() => pin.close()).toThrow(WindowsLpacChildAccessNativeCleanupError);
    expect(f.calls).toHaveLength(count); expect(f.closed).toEqual([]);
  });
  it("wipes a refused native read and performs no further query after unknown ABI", () => {
    const f = fixture(), pin = f.pin(); let output: Buffer | undefined;
    f.set("ReadFile", (...args) => { output = args[1] as Buffer; output.fill(42); (args[3] as unknown[])[0] = true; return 1; });
    expect(() => pin.read()).toThrow(WindowsLpacChildAccessNativeCleanupError); expect(output?.every(value => value === 0)).toBe(true);
    expect(f.calls.at(-1)?.name).toBe("ReadFile"); expect(f.closed).toEqual([]);
  });
  it("creates a suspended non-inheriting Unicode host process, assigns/attests its private job and ordinary token before resume", () => {
    const f = fixture(), { tool } = f.launch(), create = f.calls.find(call => call.name === "CreateProcessW")!;
    expect(create.args.slice(2, 6)).toEqual([null, null, 0, 0x08000404]); expect(create.args[6]).toBe(environment);
    const startup = create.args[8] as Buffer; expect(startup.readUInt32LE()).toBe(104); expect(startup.subarray(4).every(value => value === 0)).toBe(true);
    const names = f.calls.map(call => call.name), resume = names.indexOf("ResumeThread");
    for (const name of ["AssignProcessToJobObject", "QueryFullProcessImageNameW", "GetTokenInformation", "IsProcessInJob"]) expect(names.indexOf(name)).toBeLessThan(resume);
    expect(tool.borrowedJob()).toBe([...f.jobs.keys()][0]); expect(tool.pid).toBe(f.root()[1].id); tool.current();
  });
  it("cannot launch from a foreign factory's pin", () => {
    const f = fixture(), g = fixture(), pin = f.pin();
    expect(() => g.native.launchTool({ program: FILE, command, cwd: CWD, environment, pin })).toThrow(); expect(g.calls).toEqual([]);
  });
  it("attests borrowed LPAC root identity/job/liveness without acquiring or closing its process/job", () => {
    const f = fixture(), pin = f.pin(); f.processes.set(900n, { id: 1234, image: FILE, alive: true, job: 901n });
    const input = { process: 900n, pid: 1234, job: 901n, program: FILE, pin };
    f.native.verifyBorrowedRoot(input); f.native.verifyBorrowedRoot(input); pin.close();
    expect(f.calls.filter(call => call.name === "OpenProcess")).toEqual([]); expect(f.closed).not.toContain(900n); expect(f.closed).not.toContain(901n);
  });
  it.each(["pid", "image", "job", "exited", "alien-pin", "owned-alias"])("refuses a borrowed root that does not match its exact native input (%s)", fault => {
    const f = fixture(), pin = f.pin(); f.processes.set(900n, { id: 1234, image: FILE, alive: true, job: 901n });
    const input = { process: 900n, pid: 1234, job: 901n, program: FILE, pin };
    if (fault === "pid") input.pid++; if (fault === "image") f.processes.get(900n)!.image = "C:\\other\\Procmon64.exe";
    if (fault === "job") input.job = 902n; if (fault === "exited") f.processes.get(900n)!.alive = false;
    if (fault === "alien-pin") input.pin = fixture().pin(); if (fault === "owned-alias") input.process = [...f.files.keys()][0];
    const start = f.calls.length; expect(() => f.native.verifyBorrowedRoot(input)).toThrow();
    expect(f.calls.slice(start).filter(call => /CloseHandle|OpenProcess$/.test(call.name))).toEqual([]);
    expect(f.closed).not.toContain(900n); expect(f.closed).not.toContain(901n);
  });
  it("retains borrowed root inputs and suppresses further calls after unknown liveness ABI", () => {
    const f = fixture(), pin = f.pin(); f.processes.set(900n, { id: 1234, image: FILE, alive: true, job: 901n });
    f.set("WaitForSingleObject", () => true);
    expect(() => f.native.verifyBorrowedRoot({ process: 900n, pid: 1234, job: 901n, program: FILE, pin })).toThrow(WindowsLpacChildAccessNativeCleanupError);
    const count = f.calls.length; expect(() => pin.close()).toThrow(WindowsLpacChildAccessNativeCleanupError); expect(f.calls).toHaveLength(count); expect(f.closed).toEqual([]);
  });
  it("closes only the unpopulated job after an explicit CreateProcess FALSE", () => {
    const f = fixture(), pin = f.pin(); f.set("CreateProcessW", () => 0);
    expect(() => f.native.launchTool({ program: FILE, command, cwd: CWD, environment, pin })).toThrow();
    expect(f.closed).toEqual([...f.jobs.keys()]); expect(f.fence.failure).toBeUndefined(); expect(f.calls.filter(call => call.name === "ResumeThread")).toEqual([]);
  });
  it.each(["false-born", "abi-born", "throw-born"])("retains acquisition output and never treats uncertain birth as no child (%s)", fault => {
    const f = fixture(), pin = f.pin(); f.set("CreateProcessW", (...args) => {
      (args[9] as Buffer).writeBigUInt64LE(123n); if (fault === "throw-born") throw new Error("private native failure"); return fault === "abi-born" ? true : 0;
    });
    expect(() => f.native.launchTool({ program: FILE, command, cwd: CWD, environment, pin })).toThrow(WindowsLpacChildAccessNativeCleanupError);
    expect(f.calls.at(-1)?.name).toBe("CreateProcessW"); expect(f.closed).toEqual([]); expect(f.fence.retained).toHaveLength(1);
  });
  it("stops and closes every known suspended creation handle after a known image-attestation refusal", () => {
    const f = fixture(), pin = f.pin(); f.set("QueryFullProcessImageNameW", () => 0);
    expect(() => f.native.launchTool({ program: FILE, command, cwd: CWD, environment, pin })).toThrow();
    expect(f.calls.some(call => call.name === "TerminateProcess")).toBe(true); expect(f.calls.some(call => call.name === "ResumeThread")).toBe(false);
    expect(new Set(f.closed).size).toBe(f.closed.length); expect(f.fence.failure).toBeUndefined();
  });
  it("fences thread-close uncertainty after successful resume and never retries that close", () => {
    const f = fixture(), pin = f.pin(); f.set("CloseHandle", (...args) => f.tokens.has(args[0] as bigint) ? 1 : 0);
    expect(() => f.native.launchTool({ program: FILE, command, cwd: CWD, environment, pin })).toThrow(WindowsLpacChildAccessNativeCleanupError);
    expect(f.calls.some(call => call.name === "ResumeThread")).toBe(true);
    const count = f.calls.length; expect(() => pin.close()).toThrow(WindowsLpacChildAccessNativeCleanupError); expect(f.calls).toHaveLength(count);
  });
  it("retains every observed auxiliary by exact native handle and requires every handle signalled after job zero", () => {
    const f = fixture(), { tool } = f.launch(), aux = f.addAux(); tool.sampleMembers();
    expect(f.calls.find(call => call.name === "OpenProcess")?.args).toEqual([0x101000, 0, aux.id]);
    f.finish(aux.handle); f.signalOnWait(aux.handle); expect(tool.waitExitedBefore(1000)).toBe(0);
    const positive = f.calls.filter(call => call.name === "WaitForSingleObject" && (call.args[1] as number) > 0);
    expect(positive.map(call => call.args[0])).toContain(aux.handle); tool.closeStopped(); const count = f.calls.length; tool.closeStopped(); expect(f.calls).toHaveLength(count);
  });
  it("never treats a known pin-handle alias as a newly acquired auxiliary process", () => {
    const f = fixture(), { tool } = f.launch(); f.addAux(); const file = [...f.files.keys()][0]; f.set("OpenProcess", () => file);
    expect(() => tool.sampleMembers()).toThrow(WindowsLpacChildAccessNativeCleanupError); expect(f.calls.at(-1)?.name).toBe("OpenProcess"); expect(f.closed).not.toContain(file);
  });
  it("refuses partial private-job lists before opening a member by PID", () => {
    const f = fixture(), { tool } = f.launch(); f.set("QueryInformationJobObject", (...args) => {
      if (args[1] === 3) { (args[2] as Buffer).writeUInt32LE(2, 0); (args[2] as Buffer).writeUInt32LE(1, 4); return 1; } return 1;
    });
    expect(() => tool.sampleMembers()).toThrow(WindowsLpacChildAccessNativeCleanupError); expect(f.calls.filter(call => call.name === "OpenProcess")).toEqual([]);
  });
  it("does not infer retained process death from zero job accounting", () => {
    const f = fixture(), { tool } = f.launch(), aux = f.addAux(); tool.sampleMembers(); f.finish(aux.handle);
    expect(() => tool.waitExitedBefore(1000)).toThrow(WindowsLpacChildAccessNativeCleanupError);
    expect(f.fence.retained).toHaveLength(1); expect(f.closed).not.toContain(aux.handle);
  });
  it.each([0xffffffff, true, -1, undefined])("fences failed or unknown native wait results without querying another owner (%#)", result => {
    const f = fixture(), { tool } = f.launch(); f.finish(); f.set("WaitForSingleObject", () => result); const start = f.calls.length;
    expect(() => tool.waitExitedBefore(1000)).toThrow(WindowsLpacChildAccessNativeCleanupError);
    const calls = f.calls.slice(start), failed = calls.findIndex(call => call.name === "WaitForSingleObject");
    expect(calls.slice(failed + 1).map(call => call.name)).toEqual(result === 0xffffffff ? ["GetLastError"] : []);
    const count = f.calls.length; expect(() => tool.closeStopped()).toThrow(WindowsLpacChildAccessNativeCleanupError); expect(f.calls).toHaveLength(count);
  });
  it("accepts an exactly zero remaining deadline only for already-signalled owned processes", () => {
    const f = fixture(), { tool } = f.launch(); f.finish(); expect(tool.waitExitedBefore(100)).toBe(0); tool.closeStopped();
  });
  it.each([99, NaN, Infinity, 15101])("refuses expired, invalid or newly extended deadlines without reopening processes (%s)", deadline => {
    const f = fixture(), { tool } = f.launch(); f.finish(); const start = f.calls.length;
    expect(() => tool.waitExitedBefore(deadline)).toThrow(WindowsLpacChildAccessNativeCleanupError);
    expect(f.calls).toHaveLength(start); expect(f.fence.retained).toHaveLength(1);
  });
  it("consumes one decreasing wait budget across the same root and retained auxiliary", () => {
    const times = [100, 110, 120, 130, 400, 410, 500, 510], f = fixture(() => times.shift() ?? 510), { tool } = f.launch();
    const aux = f.addAux(); tool.sampleMembers(); f.finish(); const start = f.calls.length;
    expect(tool.waitExitedBefore(1000)).toBe(0);
    const waits = f.calls.slice(start).filter(call => call.name === "WaitForSingleObject" && (call.args[1] as number) > 0);
    expect(waits.map(call => call.args)).toEqual([[f.root()[0], 880], [aux.handle, 600]]);
  });
  it.each([NaN, 99, 1001])("rejects an invalid or late successful native wait without querying another owner (%s)", finalTime => {
    const times = [100, 100, 100, finalTime], f = fixture(() => times.shift() ?? finalTime), { tool } = f.launch(); f.finish(); const start = f.calls.length;
    expect(() => tool.waitExitedBefore(1000)).toThrow(WindowsLpacChildAccessNativeCleanupError);
    const calls = f.calls.slice(start), lastWait = calls.findLastIndex(call => call.name === "WaitForSingleObject");
    expect(calls.slice(lastWait + 1)).toEqual([]); expect(f.fence.retained).toHaveLength(1);
  });
  it("keeps the final whole-job predicate after all positive process waits", () => {
    const f = fixture(), { tool } = f.launch(); f.finish(); f.set("WaitForSingleObject", (...args) => {
      if ((args[1] as number) > 0) f.finalActive(); return 0;
    });
    expect(() => tool.waitExitedBefore(1000)).toThrow(WindowsLpacChildAccessNativeCleanupError);
    expect(f.calls.filter(call => call.name === "GetExitCodeProcess")).toEqual([]); expect(f.fence.retained).toHaveLength(1);
  });
  it("never terminates a naturally unfinished collector to manufacture successful capture", () => {
    const times = [100, 100, 1001], f = fixture(() => times.shift() ?? 1001), { tool } = f.launch();
    expect(() => tool.waitExitedBefore(1000)).toThrow(WindowsLpacChildAccessNativeCleanupError);
    expect(f.calls.filter(call => /Terminate/.test(call.name))).toEqual([]); expect(f.fence.retained).toHaveLength(1);
  });
  it("rejects late completion after the final independent proof", () => {
    const times = [100, 100, 100, 100, 100, 1001], f = fixture(() => times.shift() ?? 1001), { tool } = f.launch(); f.finish();
    expect(() => tool.waitExitedBefore(1000)).toThrow(WindowsLpacChildAccessNativeCleanupError); expect(f.fence.retained).toHaveLength(1);
  });
  it("treats native job termination as cleanup only and still requires positive final proof", () => {
    const f = fixture(), { tool } = f.launch(); tool.stopBefore(1000); expect(f.calls.some(call => call.name === "TerminateJobObject")).toBe(true); tool.closeStopped();
  });
  it("refuses any unowned Procmon instance without terminating or opening that PID", () => {
    const f = fixture(); f.rows([{ id: 4242, name: "Procmon64.exe" }]);
    expect(() => f.native.requireExclusiveTools([])).toThrow(WindowsLpacChildAccessNativeCleanupError);
    expect(f.calls.filter(call => /Terminate|OpenProcess$/.test(call.name))).toEqual([]); expect(f.closed).toHaveLength(1);
  });
  it("permits only a current exact owned collector and closes the enumeration handle", () => {
    const f = fixture(), { tool } = f.launch(); f.native.requireExclusiveTools([tool]);
    expect(f.calls.some(call => call.name === "CreateToolhelp32Snapshot")).toBe(true); expect(f.calls.at(-1)?.name).toBe("CloseHandle");
    expect(f.fence.failure).toBeUndefined();
  });
  it("retains a retired auxiliary handle for Stop without authorizing a foreign Procmon that reuses its PID", () => {
    const f = fixture(), { tool } = f.launch(), aux = f.addAux(); tool.sampleMembers();
    f.processes.get(aux.handle)!.alive = false;
    const job = f.jobs.get(tool.borrowedJob())!; job.members = job.members.filter(handle => handle !== aux.handle);
    f.rows([{ id: tool.pid, name: "Procmon64.exe" }, { id: aux.id, name: "Procmon64.exe" }]);
    const start = f.calls.length;
    expect(() => f.native.requireExclusiveTools([tool])).toThrow(WindowsLpacChildAccessNativeCleanupError);
    expect(f.calls.slice(start).filter(call => /Terminate|OpenProcess$/.test(call.name))).toEqual([]);
    expect(f.closed).not.toContain(aux.handle); expect(f.fence.retained).toHaveLength(1);
  });
  it("permits a still-live exact-job-attested auxiliary without granting any new name-based authority", () => {
    const f = fixture(), { tool } = f.launch(), aux = f.addAux();
    f.rows([{ id: tool.pid, name: "Procmon64.exe" }, { id: aux.id, name: "Procmon64.exe" }]);
    f.native.requireExclusiveTools([tool]); expect(f.fence.failure).toBeUndefined();
    const attestations = f.calls.filter(call => call.name === "IsProcessInJob" && call.args[0] === aux.handle);
    expect(attestations.length).toBeGreaterThan(0); expect(f.calls.filter(call => /Terminate/.test(call.name))).toEqual([]);
  });
  it("keeps exported tool/pin methods immutable rather than allowing public method replacement to bypass private ownership checks", () => {
    const f = fixture(), { tool, asset } = f.launch(); expect(Object.isFrozen(tool)).toBe(true); expect(Object.isFrozen(asset)).toBe(true);
    expect(() => Object.assign(tool, { current() { /* Cannot replace the attestation closure. */ } })).toThrow();
  });
  it("preserves the first enumeration error across successful snapshot cleanup", () => {
    const f = fixture(); f.set("Process32FirstW", () => 0); f.lastError(5); let error: unknown;
    try { f.native.requireExclusiveTools([]); } catch (caught) { error = caught; }
    expect(windowsLpacChildAccessNativeReceipt(error)).toMatchObject({ stage: 8, domain: 1, code: 5 }); expect(f.closed).toHaveLength(1);
  });
  it("fences uncertain snapshot closure and never retries any native owner query", () => {
    const f = fixture(); f.set("CloseHandle", () => 0);
    expect(() => f.native.requireExclusiveTools([])).toThrow(WindowsLpacChildAccessNativeCleanupError); const count = f.calls.length;
    expect(() => f.native.requireExclusiveTools([])).toThrow(WindowsLpacChildAccessNativeCleanupError); expect(f.calls).toHaveLength(count);
  });
  it("closes no handle twice after uncertain read-pin disposal", () => {
    const f = fixture(), pin = f.pin(); f.set("CloseHandle", () => { throw new Error("unknown native close completion"); });
    expect(() => pin.close()).toThrow(WindowsLpacChildAccessNativeCleanupError); const count = f.calls.length;
    expect(() => pin.close()).toThrow(WindowsLpacChildAccessNativeCleanupError); expect(f.calls).toHaveLength(count);
  });
  it("fences missing owned collector presence rather than trusting a singleton-forwarded helper", () => {
    const f = fixture(), { tool } = f.launch(); f.rows([{ id: 4, name: "System" }]);
    expect(() => f.native.requireExclusiveTools([tool])).toThrow(WindowsLpacChildAccessNativeCleanupError); expect(f.fence.retained).toHaveLength(1);
  });
  it("keeps outward failures to branded bounded numeric facts even if native errors contain private text", () => {
    const f = fixture(); f.set("GetDriveTypeW", () => { throw new Error("C:\\private\\secret token SID argv"); }); let error: unknown;
    try { f.pin(); } catch (caught) { error = caught; }
    const receipt = windowsLpacChildAccessNativeReceipt(error); expect(receipt).toMatchObject({ stage: 2, domain: 0, code: 0 });
    expect(JSON.stringify(receipt)).not.toMatch(/private|secret|SID|argv/); expect(windowsLpacChildAccessNativeReceipt(new Error("fake"))).toBeUndefined();
    const copy = receipt as { code: number }; copy.code = 999; expect(windowsLpacChildAccessNativeReceipt(error)?.code).toBe(0);
  });
  it("brands only four validated numeric fields and never copies runtime extras, private causes or getters", () => {
    const inspected = vi.fn(() => { throw new Error("private extra getter"); });
    const input = { stage: 2, operation: 4, domain: 1, code: 32, privatePath: "C:\\secret\\trace.csv", cause: { secret: "token" } };
    Object.defineProperty(input, "privateGetter", { enumerable: true, get: inspected });
    const error = new WindowsLpacChildAccessNativeCleanupError(input), receipt = windowsLpacChildAccessNativeReceipt(error);
    expect(receipt).toEqual({ stage: 2, operation: 4, domain: 1, code: 32 }); expect(Object.keys(receipt!)).toEqual(["stage", "operation", "domain", "code"]);
    expect(inspected).not.toHaveBeenCalled(); expect(JSON.stringify(receipt)).not.toMatch(/private|secret|trace|cause|token/);
  });
  it.each([
    [{ stage: NaN, operation: Infinity, domain: 1, code: NaN }, { stage: 0, operation: 0, domain: 0, code: 0 }],
    [{ stage: -1, operation: 30, domain: 2, code: 5 }, { stage: 0, operation: 0, domain: 0, code: 0 }],
    [{ stage: 10, operation: 0x100000000, domain: 1, code: 0x100000000 }, { stage: 0, operation: 0, domain: 0, code: 0 }],
    [{ stage: 1, operation: 2, domain: 0, code: 1234 }, { stage: 1, operation: 2, domain: 0, code: 0 }],
  ])("closes nonfinite and out-of-range runtime receipt values to fixed unknowns (%#)", (input, expected) => {
    expect(windowsLpacChildAccessNativeReceipt(new WindowsLpacChildAccessNativeCleanupError(input))).toEqual(expected);
  });
  it("converts throwing numeric getters to a complete unknown receipt without leaking their exception", () => {
    const input = { stage: 1, operation: 2, domain: 1, code: 5 };
    Object.defineProperty(input, "code", { get() { throw new Error("private SID path cause"); } });
    let error: WindowsLpacChildAccessNativeCleanupError | undefined;
    expect(() => { error = new WindowsLpacChildAccessNativeCleanupError(input); }).not.toThrow();
    expect(windowsLpacChildAccessNativeReceipt(error)).toEqual({ stage: 0, operation: 0, domain: 0, code: 0 });
  });
});
