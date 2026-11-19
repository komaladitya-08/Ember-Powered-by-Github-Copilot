/** Real default factories over separate DLL models. Synthetic asset bytes/hashes are not Windows evidence. */
import { vi } from "vitest";
import type * as Crypto from "node:crypto";
import type { WindowsNodeWorkspaceInput } from "../../app/main/agent/windows-node-workspace";
import { setupWindowsCodingSealedCopy } from "./windows-coding-sealed-copy-fake";

export async function setupWindowsNodeWorkspace() {
  const crypto = await vi.importActual<typeof Crypto>("node:crypto");
  const manifest = (await import("../../app/shared/windows-node-toolchain.json")).default;
  const fixed = new Map(manifest.files.filter(member => member.ship).map(member => [member.name === "node.exe" ? 78 : member.name === "LICENSE" ? 76 : 82, member]));
  const assetBuffers = new WeakSet<object>(), hashes: { marker: number; bytes: number; exact: boolean }[] = [];
  const markers = new Map([...fixed.keys()].map(marker => [marker, Buffer.alloc(65536, marker)]));
  // Hash every ordinary byte normally. Only exact Buffer objects filled by the asset DLL model can
  // substitute a complete marker stream's published pin; project/stamp hashes never enter that seam.
  vi.doMock("node:crypto", () => ({ ...crypto, createHash(algorithm: string, options?: Crypto.HashOptions) {
    const normal = crypto.createHash(algorithm, options); if (algorithm !== "sha256") return normal;
    let marker: number | undefined, bytes = 0, synthetic = true, exact = true;
    const result = {
      update(data: Crypto.BinaryLike, encoding?: BufferEncoding) {
        if (typeof data === "string") normal.update(data, encoding ?? "utf8"); else normal.update(data);
        const body = typeof data === "string" ? Buffer.from(data, encoding) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        synthetic &&= typeof data !== "string" && assetBuffers.has(data);
        if (!bytes && body.length && fixed.has(body[0])) marker = body[0];
        exact &&= marker !== undefined && body.length <= 65536 && body.equals(markers.get(marker)!.subarray(0, body.length));
        bytes += body.length; return result;
      },
      digest(encoding?: Crypto.BinaryToTextEncoding) {
        let digest = normal.digest();
        if (synthetic && marker !== undefined) {
          hashes.push({ marker, bytes, exact }); const pin = fixed.get(marker)!;
          if (exact && bytes === pin.bytes) digest = Buffer.from(pin.sha256, "hex");
        }
        return encoding ? digest.toString(encoding) : digest;
      },
    };
    return result as unknown as Crypto.Hash;
  } }));
  const native: Record<string, unknown> = {};
  vi.doMock("node:module", async () => ({ ...await vi.importActual<typeof import("node:module")>("node:module"),
    createRequire: (filename: string | URL) => (name: string) => {
      if (name !== "koffi") throw Error("Unexpected fixed native dependency");
      const file = String(filename).replace(/\\/g, "/");
      const selected = /\/(windows-node-toolchain-native|windows-command-output|windows-command-creator-profile|windows-command-copy-native|windows-command-creator-token|windows-command-stop|windows-command-exit-native|experimental-windows-lpac-api)\.(?:ts|js|cjs|mjs)$/.exec(file)?.[1];
      const key = selected === "windows-node-toolchain-native" ? "assets" : selected === "windows-command-output" ? "output" :
        selected === "windows-command-creator-profile" ? "profile" : selected === "windows-command-copy-native" || selected === "windows-command-creator-token" ? "copy" : selected ? "job" : "";
      if (!key || !native[key]) throw Error("Unexpected fixed native module"); return native[key];
    },
  }));
  const canonical = await setupWindowsCodingSealedCopy();
  const { nodeAssetFake } = await import("./windows-node-toolchain-native-fake"), asset = nodeAssetFake(), io = asset.io;
  const { OWNER } = await import("./windows-command-creator-native-fake");
  Object.defineProperty(canonical.api, "ownerSid", { value: OWNER });
  const profiles = await import("../../app/main/agent/windows-command-creator-profile");
  // nodeAssetFake's explicit helper profile is unused: the workspace must issue its own fresh default ref.
  profiles.closeWindowsCommandCreatorProfile(io.profile); io.state.handleBase = 0x100000n;
  const task = new AbortController();
  const control = { current: true, reviewCurrent: true, autoFinish: true, onResume: undefined as (() => void) | undefined,
    program: "", command: "", cwd: "" };
  const profileState = { created: [] as string[], deleted: [] as string[], freed: [] as bigint[], fault: "",
    onCall: undefined as ((name: string, args: unknown[]) => void) | undefined };
  const sid = io.source.control.tokenPackage.split("-"), parts = sid.slice(3).map(Number), sidBytes = Buffer.alloc(8 + parts.length * 4);
  sidBytes[0] = 1; sidBytes[1] = parts.length; sidBytes[7] = 15; parts.forEach((part, index) => sidBytes.writeUInt32LE(part, 8 + index * 4));
  const allocated = new Map<bigint, string>(), nativeCalls: string[] = [];
  const profileCall = (name: string, args: unknown[]) => {
    nativeCalls.push(name); profileState.onCall?.(name, args);
    if (profileState.fault === name) throw Error("PRIVATE profile uncertainty");
    if (name === "CreateAppContainerProfile") {
      const pointer = 0x900000n + BigInt(profileState.created.length) * 0x1000n, name = args[0] as string;
      profileState.created.push(name); allocated.set(pointer, name); (args[5] as unknown[])[0] = pointer;
      io.state.profileText = `C:\\Users\\synthetic\\AppData\\Local\\Packages\\${name}\\AC`; return 0;
    }
    if (name === "IsValidSid") return allocated.has(args[0] as bigint) ? 1 : 0;
    if (name === "GetLengthSid") return sidBytes.length;
    if (name === "DeleteAppContainerProfile") { profileState.deleted.push(args[0] as string); return 0; }
    if (name === "FreeSid") { const pointer = args[0] as bigint; if (!allocated.delete(pointer)) throw Error("PRIVATE duplicate SID release"); profileState.freed.push(pointer); return null; }
    throw Error("Unexpected fixed profile call");
  };
  const loader = (call: (name: string, args: unknown[]) => unknown) => (_library: string) => ({ func(prototype: string) {
    const name = /\b(\w+)\s*\(/.exec(prototype)![1]; return (...args: unknown[]) => call(name, args);
  } });
  native.profile = { sizeof: () => 8, decode(pointer: bigint, _type: string, size: number) {
    if (!allocated.has(pointer) || size !== sidBytes.length || profileState.fault === "decode") throw Error("PRIVATE SID decode uncertainty"); return Uint8Array.from(sidBytes);
  }, load: loader(profileCall) };
  native.assets = { ...asset.native, load: (library: string) => {
    const selected = asset.load(library);
    return { func(prototype: string) {
      const fn = selected.func(prototype);
      if (!/\bNtReadFile\s*\(/.test(prototype)) return fn;
      return (...args: unknown[]) => { const result = fn(...args); if (Buffer.isBuffer(args[5])) assetBuffers.add(args[5]); return result; };
    } };
  } };
  const outputLoad = io.loader.getMockImplementation(); if (!outputLoad) throw Error("The fixed output DLL model is unavailable");
  let allocation = 0n;
  native.output = { ...io.native, load: (library: string) => {
    const selected = outputLoad(library);
    return { func(prototype: string) {
      const fn = selected.func(prototype);
      if (!/\bGetAppContainerFolderPath\s*\(/.test(prototype)) return fn;
      return (...args: unknown[]) => { io.state.profilePointer = 0x20000000n + allocation++ * 0x10000n; io.state.profileFrees = 0; return fn(...args); };
    } };
  } };
  const copyCall = (name: string, args: unknown[]) => {
    nativeCalls.push(name); const fn = io.source.handlers[name]; if (!fn) throw Error("Unexpected fixed copy call"); return fn(...args);
  };
  native.copy = { ...io.source.native, load: loader(copyCall) };
  const limits = Buffer.alloc(144);
  native.job = { ...io.source.native, sizeof: (name: string) => name === "void *" || name === "size_t" ? 8 : 4,
    load: loader((name, args) => {
      nativeCalls.push(name);
      if (name === "CreateJobObjectW") { io.state.assigned = false; io.state.ended = false; return 50000n; }
      if (name === "SetInformationJobObject") { (args[2] as Buffer).copy(limits); return 1; }
      if (name === "QueryInformationJobObject") {
        const bytes = args[2] as Buffer; bytes.fill(0);
        if (args[1] === 9) limits.copy(bytes);
        if (args[1] === 1) { bytes.writeUInt32LE(io.state.assigned ? 1 : 0, 36); bytes.writeUInt32LE(io.state.assigned && !io.state.ended ? 1 : 0, 40); }
        if (args[1] === 3 && io.state.assigned && !io.state.ended) { bytes.writeUInt32LE(1); bytes.writeUInt32LE(1, 4); bytes.writeBigUInt64LE(BigInt(io.state.returnedPid), 8); }
        return 1;
      }
      if (name === "AssignProcessToJobObject") { io.state.assigned = true; io.events.push("assign"); return 1; }
      if (name === "ResumeThread") { io.events.push("resume"); control.onResume?.(); if (control.autoFinish) io.state.ended = true; return 1; }
      if (name === "IsProcessInJob") { (args[2] as unknown[])[0] = io.state.assigned ? 1 : 0; return 1; }
      if (name === "GetProcessId" || name === "GetProcessIdOfThread") return io.state.returnedPid;
      if (name === "WaitForSingleObject") return io.state.ended ? 0 : 258;
      if (name === "GetExitCodeProcess") { (args[1] as Buffer).writeUInt32LE(io.state.code); return 1; }
      if (name === "TerminateJobObject" || name === "TerminateProcess") { io.state.ended = true; io.events.push(name); return 1; }
      if (name === "CloseHandle" && (args[0] as bigint) >= 50000n) { io.events.push("root-close"); return 1; }
      const fn = io.source.handlers[name]; if (!fn) throw Error("Unexpected fixed job call"); return fn(...args);
    }),
  };
  for (const folder of ["C:\\copies", "C:\\protected"]) io.source.add(folder, "directory");
  io.state.onNative = (name, args) => {
    if (name === "CreateProcessW") { control.program = args[0] as string; asset.state.imagePath = control.program; control.command = (args[1] as Buffer).toString("utf16le").replace(/\0$/, ""); control.cwd = args[7] as string; }
  };
  const { WindowsNodeWorkspace } = await import("../../app/main/agent/windows-node-workspace");
  const input: WindowsNodeWorkspaceInput = { source: "C:\\project", privateBase: "C:\\copies", protectedPaths: ["C:\\protected"],
    signal: task.signal, current: () => control.current, reviewBase: "C:\\exports", resourcesPath: "C:\\Ember\\resources", assetsParent: "C:\\scratch\\tools",
    review: { store: canonical.store, binding: canonical.binding, current: () => control.reviewCurrent } };
  return { canonical, asset, io, profileState, input, nativeCalls, hashes, control, task,
    create: () => WindowsNodeWorkspace.create(input),
    revoke: () => { control.reviewCurrent = false; }, invalidate: () => { control.current = false; task.abort(); },
    finish: (code = 0) => { io.state.code = code; io.state.ended = true; },
    commandRoot: () => [...io.source.objects.values()].find(row => !row.removed && row.kind === "directory" && /\\ember-command-/.test(row.name))!,
  };
}
