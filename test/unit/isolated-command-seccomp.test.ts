import { expect, it } from "vitest";
import { isolatedCommandSeccomp } from "../../app/main/agent/isolated-command-seccomp";

const X64 = 0xc000003e, ALLOW = 0x7fff0000, KILL = 0x80000000, EPERM = 0x00050001;

/** Interpret the actual generated classic BPF against seccomp_data, without an ambient kernel/container policy. */
function decision(syscall: number, arch = X64, args: readonly number[] = []): number {
  const data = Buffer.alloc(64), program = isolatedCommandSeccomp();
  data.writeUInt32LE(syscall >>> 0, 0); data.writeUInt32LE(arch >>> 0, 4);
  for (const [index, value] of args.entries()) data.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)), 16 + index * 8);
  let accumulator = 0;
  for (let pc = 0, steps = 0; pc * 8 < program.length && steps++ < program.length / 8; pc++) {
    const op = program.readUInt16LE(pc * 8), yes = program[pc * 8 + 2]!, no = program[pc * 8 + 3]!, value = program.readUInt32LE(pc * 8 + 4);
    if (op === 0x20) { accumulator = data.readUInt32LE(value); continue; }
    if (op === 0x15) { pc += accumulator === value ? yes : no; continue; }
    if (op === 0x45) { pc += (accumulator & value) !== 0 ? yes : no; continue; }
    if (op === 0x06) return value;
    throw new Error("Unknown instruction in the command policy.");
  }
  throw new Error("The command policy did not terminate within its instruction bound.");
}

it("denies inherited-session key lookup, reads, creation and mutation before argument handling", () => {
  // keyctl READ/SEARCH/GET_KEYRING_ID and WRITE/UNLINK/CLEAR all share the forbidden keyctl entry point.
  for (const operation of [0, 2, 6, 7, 9, 10, 11]) expect(decision(250, X64, [operation, -3, 0, 0, 0])).toBe(EPERM);
  expect(decision(248, X64, [0, 0, 0, 0, -3])).toBe(EPERM); // add_key
  expect(decision(249, X64, [0, 0, 0, -3])).toBe(EPERM); // request_key
});

it("keeps ordinary copied Bash/Node execution, files, timers, polling and child cleanup available", () => {
  for (const syscall of [0, 1, 3, 7, 8, 9, 10, 11, 12, 13, 14, 35, 39, 56, 59, 60, 61, 62, 202, 217, 228, 231, 257, 262, 291, 293, 318, 332, 435]) {
    expect(decision(syscall)).toBe(ALLOW);
  }
  // Nearby unrelated syscalls must not be swept into a range denial by an incorrect jump.
  expect(decision(247)).toBe(ALLOW); expect(decision(251)).toBe(ALLOW);
  expect(decision(101)).toBe(EPERM); // Preserve the prior ptrace defence.
});

it("rejects a different ABI and x32 syscall encoding instead of interpreting their numbers as x64", () => {
  expect(decision(0, 0x40000003)).toBe(KILL);
  expect(decision(250 | 0x40000000)).toBe(KILL);
  expect(decision(1 | 0x40000000)).toBe(KILL);
});
