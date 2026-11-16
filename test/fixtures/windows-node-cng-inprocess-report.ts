/** Only closed fixed-test facts cross the stopped native read boundary. TAP is never decoded or published. */
// @ts-expect-error -- fixed JavaScript fixture shared with the native test recipe
import { WINDOWS_NODE_CNG_INPROCESS_MAGIC, WINDOWS_NODE_CNG_INPROCESS_REPORT_BYTES, WINDOWS_NODE_CNG_INPROCESS_VERSION } from "./windows-node-cng-inprocess-program.mjs";

export function parseWindowsNodeCngInprocessReport(bytes: Buffer, role: 0 | 1) {
  const refuse = (): never => { throw new Error("The stopped in-process test report failed its fixed numeric contract."); };
  if (!Buffer.isBuffer(bytes) || bytes.length !== WINDOWS_NODE_CNG_INPROCESS_REPORT_BYTES || role !== 0 && role !== 1) refuse();
  const words = Array.from({ length: 16 }, (_, index) => bytes.readUInt32LE(index * 4));
  const [magic, schema, observedRole, stage, status, error, features, tests, moduleValue, readBytes, fsCallbacks, timerCallbacks, runtimeVersion, checkpoints, reservedA, reservedB] = words;
  if (magic !== WINDOWS_NODE_CNG_INPROCESS_MAGIC || schema !== 1 || observedRole !== role || ![1, 2, 4, 5].includes(stage) || status > 2 ||
      error !== (status === 2 ? 1 : 0) || features > 15 || (features & 1) !== 1 || tests > 1 || moduleValue !== 0 && moduleValue !== 42 ||
      readBytes !== 0 && readBytes !== 21 || fsCallbacks > 1 || timerCallbacks > 1 || runtimeVersion !== WINDOWS_NODE_CNG_INPROCESS_VERSION ||
      checkpoints < 1 || checkpoints > 4 || reservedA !== 0 || reservedB !== 0) refuse();
  if (status === 1 && (stage !== 4 || features !== 15 || tests !== 1 || moduleValue !== 42 || readBytes !== 21 || fsCallbacks !== 1 || timerCallbacks !== 1 || checkpoints !== 3)) refuse();
  if (status === 0 && (stage !== 1 && stage !== 2 || tests !== 0) || status === 2 && stage !== 5) refuse();
  return Object.freeze({ role, stage, status, error, features, tests, moduleValue, readBytes, fsCallbacks, timerCallbacks, runtimeVersion, checkpoints });
}
