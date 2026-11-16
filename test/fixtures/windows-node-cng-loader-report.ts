/** Closed final loader observations only. Never an error string, stack, syscall text or filename. */
// @ts-expect-error -- fixed JavaScript runtime literal outside the application build
import { WINDOWS_NODE_CNG_LOADER_MAGIC, WINDOWS_NODE_CNG_LOADER_REPORT_BYTES, WINDOWS_NODE_CNG_LOADER_VERSION } from "./windows-node-cng-loader-program.mjs";

export function parseWindowsNodeCngLoaderReport(bytes: Buffer, role: 0 | 1) {
  const refuse = (): never => { throw new Error("The stopped loader report failed its fixed numeric contract."); };
  if (!Buffer.isBuffer(bytes) || bytes.length !== WINDOWS_NODE_CNG_LOADER_REPORT_BYTES || role !== 0 && role !== 1) refuse();
  const words = Array.from({ length: 24 }, (_, index) => bytes.readUInt32LE(index * 4));
  if (words[0] !== WINDOWS_NODE_CNG_LOADER_MAGIC || words[1] !== 1 || words[2] !== role || words[3] !== 5 || words[4] !== 1 ||
      words[5] > 1 || words[6] !== WINDOWS_NODE_CNG_LOADER_VERSION || words[7] !== 7 || words[8] > 7 || words[9] > 7 ||
      words[19] !== 5 || words.slice(20).some(value => value !== 0)) refuse();
  let successes = 0, failures = 0;
  const operations = [21, 1, 42].map((expected, index) => {
    const offset = 10 + index * 3, status = words[offset], code = words[offset + 1], value = words[offset + 2];
    if (![1, 2, 3].includes(status) || code > 8 || status === 2 && code === 0 || status !== 2 && code !== 0 ||
        value !== (status === 1 ? expected : 0)) refuse();
    if (status === 1) successes |= 1 << index; else failures |= 1 << index;
    return Object.freeze({ operation: index + 1, status, code, value });
  });
  if (successes !== words[8] || failures !== words[9] || words[5] !== (successes === 7 ? 1 : 0)) refuse();
  return Object.freeze({ role, complete: true as const, successful: words[5] === 1, operations: Object.freeze(operations), runtimeVersion: words[6] });
}
