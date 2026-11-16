/** Fixed stopped POSIX host-control facts. No SID, path, bytes, handle or process identifier leaves this decoder. */
export const WINDOWS_OPEN_TARGET_POSIX_REPORT_BYTES = 160;
export const WINDOWS_OPEN_TARGET_POSIX_REPORT_MAGIC = 0x50544f57;
const fail = (): never => { throw new Error("The stopped POSIX comparison failed its fixed numeric contract."); };

/** A report requires valid A, both complete preparations and positive source-handle closes. B remains an observation. */
export function parseWindowsOpenTargetPosixReport(bytes: Buffer) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== WINDOWS_OPEN_TARGET_POSIX_REPORT_BYTES) return fail();
  const w = Array.from({ length: 40 }, (_, index) => bytes.readUInt32LE(index * 4));
  if (w[0] !== WINDOWS_OPEN_TARGET_POSIX_REPORT_MAGIC || w[1] !== 2 || w[2] !== 1 ||
      w.slice(3, 8).some(mask => mask !== 3) || w[8] !== 1 && w[8] !== 3 || w[9] !== 0 ||
      w[8] === 3 && w[10] !== 0 || w[11] !== 3 || w[12] !== 3 || w[13] !== 22 || w[14] !== 3 ||
      w[15] !== 3 || w.slice(16, 24).some(Boolean) || w.slice(29, 32).some(Boolean) || w.slice(37).some(Boolean) ||
      !(w[25] | w[26]) || !(w[33] | w[34]) || w[24] !== w[32] || w[25] === w[33] && w[26] === w[34]) return fail();
  return Object.freeze({ schema: 2 as const, status: 1 as const,
    api: Object.freeze({ informationClass: 22 as const, flags: 3 as const }),
    preparation: Object.freeze({ createdMask: 3 as const, writtenMask: 3 as const, flushedMask: 3 as const, closedMask: 3 as const }),
    source: Object.freeze({ openedMask: 3 as const, closedMask: 3 as const, identityCapturedMask: 3 as const }),
    attemptedMask: 3 as const, successMask: w[8] as 1 | 3,
    a: Object.freeze({ success: 1 as const, error: 0 as const }),
    b: Object.freeze({ success: (w[8] === 3 ? 1 : 0) as 0 | 1, error: w[10] }) });
}
