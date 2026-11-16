/** Fixed experimental job limit only; canonical LPAC job construction remains unchanged. */
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import type { WindowsHandle } from "../../app/main/agent/experimental-windows-lpac-api";
import { WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";
type Native = (...args: unknown[]) => unknown;
export function bindWindowsChildPolicyJob(koffi: Pick<typeof Koffi, "sizeof">, load: (name: string) => { func(prototype: string): unknown }) {
  if (koffi.sizeof("void *") !== 8) throw new WindowsNodeHostCleanupError();
  const kernel = load("kernel32.dll"), set = kernel.func("int __stdcall SetInformationJobObject(void *job, int kind, void *information, uint32_t size)") as Native,
    query = kernel.func("int __stdcall QueryInformationJobObject(void *job, int kind, void *information, uint32_t size, void *returned)") as Native;
  let unsafe = false;
  return { setTwo(job: WindowsHandle) {
    if (unsafe) throw new WindowsNodeHostCleanupError();
    try {
      if (typeof job !== "bigint" || job <= 0n || job >= 0x8000000000000000n) throw new Error();
      const before = Buffer.alloc(144), ui = Buffer.alloc(4);
      if (query(job, 9, before, 144, null) !== 1 || query(job, 4, ui, 4, null) !== 1 || before.readUInt32LE(16) !== 0x2000 || before.readUInt32LE(40) !== 0 || ui.readUInt32LE() !== 0) throw new Error();
      const requested = Buffer.from(before); requested.writeUInt32LE(0x2008, 16); requested.writeUInt32LE(2, 40);
      if (set(job, 9, requested, 144) !== 1) throw new Error();
      const after = Buffer.alloc(144); if (query(job, 9, after, 144, null) !== 1 || query(job, 4, ui, 4, null) !== 1 || after.readUInt32LE(16) !== 0x2008 || after.readUInt32LE(40) !== 2 || ui.readUInt32LE() !== 0) throw new Error();
    } catch { unsafe = true; throw new WindowsNodeHostCleanupError(); }
  } };
}
export function loadWindowsChildPolicyJob() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new WindowsNodeHostCleanupError();
  const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi;
  return bindWindowsChildPolicyJob(koffi, name => koffi.load(name));
}
