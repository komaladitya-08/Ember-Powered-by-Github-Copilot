/** Interpret the emitted classic BPF, including full 64-bit socket-family arguments. */
import { expect, it } from "vitest";
import { wslCodingSeccomp } from "../../app/main/agent/wsl-coding-seccomp";
import { isolatedCommandSeccomp } from "../../app/main/agent/isolated-command-seccomp";

function verdict(program: Buffer, syscall: number, family = 0n, arch = 0xc000003e): number {
  const data = Buffer.alloc(64); data.writeUInt32LE(syscall >>> 0, 0); data.writeUInt32LE(arch, 4); data.writeBigUInt64LE(family, 16);
  let a = 0;
  for (let at = 0, n = 0; at < program.length && n++ < 1000; at += 8) {
    const op = program.readUInt16LE(at), yes = program[at + 2], no = program[at + 3], value = program.readUInt32LE(at + 4);
    if (op === 0x20) a = data.readUInt32LE(value);
    else if (op === 0x15) at += (a === value ? yes : no) * 8;
    else if (op === 0x45) at += ((a & value) !== 0 ? yes : no) * 8;
    else if (op === 0x06) return value;
    else throw new Error("Unknown BPF instruction");
  }
  throw new Error("BPF failed to terminate");
}
it("retains every existing Linux denial and permits ordinary process, file and child execution syscalls", () => {
  const original = isolatedCommandSeccomp(), next = wslCodingSeccomp();
  for (let n = 0; n < 450; n++) if (![41, 53].includes(n)) expect(verdict(next, n)).toBe(verdict(original, n));
  for (const n of [56, 57, 58, 59, 61, 322]) expect(verdict(next, n)).toBe(0x7fff0000);
});
it.each([41, 53])("allows only canonical AF_UNIX for syscall%i, refusing Hyper-V and network/socket families", syscall => {
  const program = wslCodingSeccomp(); expect(verdict(program, syscall, 1n)).toBe(0x7fff0000);
  for (let family = 0; family <= 64; family++) if (family !== 1) expect(verdict(program, syscall, BigInt(family))).toBe(0x00050001);
  for (const family of [0x100000001n, 0xffffffff00000001n]) expect(verdict(program, syscall, family)).toBe(0x00050001);
});
it("kills foreign-architecture and x32 ABI attempts", () => {
  expect(verdict(wslCodingSeccomp(), 1, 0n, 0x40000003)).toBe(0x80000000);
  expect(verdict(wslCodingSeccomp(), 0x40000029, 1n)).toBe(0x80000000);
});
