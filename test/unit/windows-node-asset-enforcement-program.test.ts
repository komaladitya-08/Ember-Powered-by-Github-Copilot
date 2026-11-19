import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const program = fs.readFileSync(new URL("../fixtures/windows-node-asset-enforcement-program.cjs", import.meta.url), "utf8");
function probe(mode: string, eof = true) {
  const outputs = new Map<number, Buffer[]>(), paths: unknown[][] = []; let timer = 0, closed = 0;
  const process = { argv: ["fixed-node.exe", "proof.cjs", mode], exitCode: undefined as number | undefined,
    exit(code: number): never { const error = new Error("Fixed payload exit."); Object.assign(error, { code }); throw error; } };
  const native = { readSync: () => eof ? 0 : 1, readFileSync(name: string, encoding: string) { paths.push(["read", name, encoding]); return "EMBER_NODE_ASSET_SEED\n"; },
    openSync(name: string, flags: string) { paths.push(["open", name, flags]); return 7; }, fsyncSync: (fd: number) => paths.push(["flush", fd]), closeSync: (fd: number) => { paths.push(["close", fd]); closed++; },
    writeSync(fd: number, bytes: Buffer, offset: number, count: number) { const size = Math.min(37, count); const chunks = outputs.get(fd) ?? []; chunks.push(Buffer.from(bytes.subarray(offset, offset + size))); outputs.set(fd, chunks); return size; } };
  runInNewContext(program, { require(name: string) { expect(name).toBe("node:fs"); return native; }, process, Buffer, setInterval() { timer++; } });
  return { process, paths, timer, closed, output: (fd: number) => Buffer.concat(outputs.get(fd) ?? []) };
}
it("literal Node workload preserves EOF, partial synchronous writes, exact output and a fresh-only created file", () => {
  const value = probe("natural"); expect(value.process.exitCode).toBe(17); expect(value.timer).toBe(0); expect(value.closed).toBe(1);
  expect(value.paths).toEqual([["read", "seed.txt", "utf8"], ["open", "created.txt", "wx"], ["flush", 7], ["close", 7]]);
  expect(value.output(7).toString()).toBe("EMBER_NODE_ASSET_CREATED\n");
  expect(value.output(1)).toEqual(Buffer.concat([Buffer.from("EMBER_NODE_ASSET_READY\n"), Buffer.alloc(73728, 79), Buffer.from("\nEMBER_NODE_ASSET_DONE\n")]));
  expect(value.output(2)).toEqual(Buffer.concat([Buffer.from("EMBER_NODE_ASSET_STDERR_READY\n"), Buffer.alloc(67584, 69), Buffer.from("\nEMBER_NODE_ASSET_STDERR_DONE\n")]));
});
it.each(["cancel", "overflow"])("literal %s workload leaves an alive root after fixed READY bytes without changing files", mode => {
  const value = probe(mode); expect(value.timer).toBe(1); expect(value.process.exitCode).toBeUndefined(); expect(value.closed).toBe(0);
  expect(value.paths).toEqual([["read", "seed.txt", "utf8"]]); expect(value.output(2).toString()).toBe("EMBER_NODE_ASSET_STDERR_READY\n");
  const out = value.output(1), ready = Buffer.from("EMBER_NODE_ASSET_READY\n"); expect(out.subarray(0, ready.length)).toEqual(ready);
  if (mode === "cancel") expect(out).toEqual(ready); else { expect(out.length).toBe(ready.length + 32 * 16384); expect(out.subarray(ready.length).every(byte => byte === 88)).toBe(true); }
});
it("literal payload refuses a foreign mode or non-EOF stdin before emitting proof output", () => {
  expect(() => probe("foreign")).toThrow("Fixed payload exit."); expect(() => probe("natural", false)).toThrow("Fixed payload exit.");
});
