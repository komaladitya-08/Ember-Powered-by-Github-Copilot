/** Closed binary facts only, read after native root exit and private-job zero. */
// @ts-expect-error -- shared fixed literal build recipe, outside the application's TypeScript build
import { WINDOWS_NODE_SOURCE_MAGIC, WINDOWS_NODE_SOURCE_REPORT_BYTES, WINDOWS_NODE_SOURCE_VERSION } from "./windows-node-source-program.mjs";

export function parseWindowsNodeSourceReport(bytes: Buffer, role: 0 | 1) {
  const refused = () => { throw new Error("The stopped source-Node report failed its fixed numeric contract."); };
  if (!Buffer.isBuffer(bytes) || bytes.length !== WINDOWS_NODE_SOURCE_REPORT_BYTES || role !== 0 && role !== 1) refused();
  const words = Array.from({ length: 16 }, (_, index) => bytes.readUInt32LE(index * 4));
  const [magic, version, tokenRole, stage, status, error, features, payloadBytes, syncBytes, asyncBytes,
    fsCallbacks, timerCallbacks, fileRemoved, checkpoints, runtimeVersion, reserved] = words;
  if (magic !== WINDOWS_NODE_SOURCE_MAGIC || version !== 1 || tokenRole !== role || ![1, 2, 3, 4, 5, 7].includes(stage) ||
      status > 2 || error > 1 || features > 31 || payloadBytes !== 0 && payloadBytes !== 24 ||
      syncBytes !== 0 && syncBytes !== 24 || asyncBytes !== 0 && asyncBytes !== 24 || fsCallbacks > 1 || timerCallbacks > 1 ||
      fileRemoved > 1 || checkpoints < 1 || checkpoints > 16 || runtimeVersion !== WINDOWS_NODE_SOURCE_VERSION || reserved !== 0) refused();
  if ((features & 1) === 0 || status === 0 && stage === 7) refused();
  if (status !== 2 && (((features & 2) !== 0) !== (syncBytes === 24) ||
      ((features & 4) !== 0) !== (asyncBytes === 24 && fsCallbacks === 1) ||
      ((features & 8) !== 0) !== (timerCallbacks === 1) ||
      ((features & 16) !== 0) !== (fileRemoved === 1))) refused();
  if (status === 1 && (stage !== 7 || error !== 0 || features !== 31 || payloadBytes !== 24 || syncBytes !== 24 ||
      asyncBytes !== 24 || fsCallbacks !== 1 || timerCallbacks !== 1 || fileRemoved !== 1 || checkpoints !== 6)) refused();
  if (status === 0 && error !== 0 || status === 2 && error !== 1) refused();
  return Object.freeze({ role, stage, status, error, features, payloadBytes, syncBytes, asyncBytes, fsCallbacks,
    timerCallbacks, fileRemoved, checkpoints, runtimeVersion });
}
