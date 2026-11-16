/** Separate stopped creator-owner facts; no SID, token owner, path, handle, process ID or private bytes are decoded. */
import { parseWindowsCommandCopyReport, WINDOWS_COMMAND_COPY_REPORT_MAGIC } from "./windows-command-copy-report";

export const WINDOWS_COMMAND_CREATOR_OWNER_REPORT_BYTES = 128;
export const WINDOWS_COMMAND_CREATOR_OWNER_REPORT_MAGIC = 0x4f434357;
export type WindowsCommandCreatorOwnerProofMode = "useful" | "writer" | "revoked" | "acl-host";
const modes = { useful: 1, writer: 2, revoked: 3, "acl-host": 4 } as const;
const prefix = (count: number) => (1 << count) - 1;
const fail = (): never => { throw new Error("The stopped creator-owner report failed its fixed numeric contract."); };

/** The close mask means no remaining owner after each attempted open, including a denial that produced no handle. */
export function parseWindowsCommandCreatorOwnerReport(bytes: Buffer, expectedMode: WindowsCommandCreatorOwnerProofMode) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== WINDOWS_COMMAND_CREATOR_OWNER_REPORT_BYTES ||
      typeof expectedMode !== "string" || !Object.hasOwn(modes, expectedMode)) return fail();
  const w = Array.from({ length: 32 }, (_, index) => bytes.readUInt32LE(index * 4));
  const mode = modes[expectedMode], status = w[3], operation = w[4];
  if (w[0] !== WINDOWS_COMMAND_CREATOR_OWNER_REPORT_MAGIC || w[1] !== 2 || w[2] !== mode ||
      status !== 1 && status !== 2 || w[15] !== 0 || w.slice(26).some(Boolean)) return fail();
  const [createdMask, attemptMask, grantedMask, closedMask] = w.slice(16, 20);
  const errors = w.slice(20, 24), validatedMask = w[24], removedMask = w[25];
  if (![0, 1, 3].includes(createdMask) || attemptMask > 15 || grantedMask > 15 || closedMask > 15 ||
      ![0, 1, 3, 7, 15].includes(attemptMask) || ![0, 1, 3, 7, 15].includes(validatedMask) ||
      ![0, 1, 3].includes(removedMask) || (grantedMask & ~attemptMask) !== 0 || closedMask !== attemptMask ||
      (validatedMask & ~attemptMask) !== 0 || (removedMask & ~createdMask) !== 0) return fail();
  for (let index = 0; index < 4; index++) {
    const bit = 1 << index;
    if (!(attemptMask & bit) && errors[index] !== 0 || (grantedMask & bit) && errors[index] !== 0) return fail();
    if (validatedMask & bit) {
      if (mode === 4 ? !(grantedMask & bit) || errors[index] !== 0 : grantedMask & bit || errors[index] !== 5) return fail();
    }
  }
  const fullAcl = () => createdMask === 3 && attemptMask === 15 && closedMask === 15 && validatedMask === 15 && removedMask === 3 &&
    (mode === 4 ? grantedMask === 15 && errors.every(error => error === 0) : grantedMask === 0 && errors.every(error => error === 5));
  const noAcl = () => w.slice(16, 26).every(value => value === 0);

  let original: { mode: number; status: number; operation: number; features: number; sourceReadError: number; sourceWriteError: number;
    canaryReadError: number; canaryWriteError: number; workReadError: number; workWriteError: number; workCreateError: number;
    failedOperationError: number; initialHeartbeatCounter: number };
  const aclPhase = operation >= 20 && operation <= 27;
  if (mode === 4 || mode === 1 && aclPhase) {
    if (w[5] !== (mode === 4 ? 0 : 0xf00) || w.slice(6, 10).some(error => error !== (mode === 4 ? 0 : 5)) ||
        w.slice(10, 13).some(Boolean) || w[14] !== 0 || status === 1 && (operation !== 19 || w[13] !== 0 || !fullAcl()) ||
        status === 2 && !aclPhase) return fail();
    original = { mode, status, operation, features: w[5], sourceReadError: w[6], sourceWriteError: w[7], canaryReadError: w[8], canaryWriteError: w[9],
      workReadError: w[10], workWriteError: w[11], workCreateError: w[12], failedOperationError: w[13], initialHeartbeatCounter: w[14] };
  } else {
    const legacy = Buffer.from(bytes.subarray(0, 64));
    legacy.writeUInt32LE(WINDOWS_COMMAND_COPY_REPORT_MAGIC, 0); legacy.writeUInt32LE(1, 4);
    try { original = parseWindowsCommandCopyReport(legacy, expectedMode as "useful" | "writer" | "revoked"); }
    catch { return fail(); } finally { legacy.fill(0); }
    if (mode === 2 || mode === 3 || status === 2 && operation <= 4) { if (!noAcl()) return fail(); }
    else if (!fullAcl()) return fail();
  }
  if (aclPhase) {
    if (status !== 2 || mode !== 1 && mode !== 4) return fail();
    if (operation === 20 || operation === 21) {
      if (createdMask !== (operation === 20 ? 0 : 1) || attemptMask !== 0 || grantedMask !== 0 || closedMask !== 0 ||
          errors.some(Boolean) || validatedMask !== 0 || removedMask !== 0) return fail();
    } else if (operation <= 25) {
      const index = operation - 22, bit = 1 << index;
      if (createdMask !== 3 || attemptMask !== prefix(index + 1) || validatedMask !== prefix(index) || removedMask !== 0) return fail();
      if (mode === 4) {
        if (grantedMask !== prefix(index) || w[13] !== errors[index]) return fail();
      } else if (grantedMask & bit) {
        if (grantedMask !== bit || errors[index] !== 0 || w[13] !== 13) return fail();
      } else if (grantedMask !== 0 || errors[index] === 5 || w[13] !== errors[index]) return fail();
    } else {
      if (createdMask !== 3 || attemptMask !== 15 || validatedMask !== 15 || removedMask !== (operation === 26 ? 0 : 1) ||
          (mode === 4 ? grantedMask !== 15 : grantedMask !== 0)) return fail();
    }
  }
  return Object.freeze({ ...original, acl: Object.freeze({ createdMask, attemptMask, grantedMask, closedMask,
    errors: Object.freeze(errors), validatedMask, removedMask }) });
}
