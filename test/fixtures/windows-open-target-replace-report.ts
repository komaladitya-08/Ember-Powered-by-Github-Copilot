/** Fixed stopped host-control facts. No SID, path, bytes, handle or process identifier leaves this decoder. */
export const WINDOWS_OPEN_TARGET_REPLACE_REPORT_BYTES = 64;
export const WINDOWS_OPEN_TARGET_REPLACE_REPORT_MAGIC = 0x52544f57;
const fail = (): never => { throw new Error("The stopped open-target comparison failed its fixed numeric contract."); };

/** A report is valid only after A succeeds and both complete preparations and native attempts finish. */
export function parseWindowsOpenTargetReplaceReport(bytes: Buffer) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== WINDOWS_OPEN_TARGET_REPLACE_REPORT_BYTES) return fail();
  const w = Array.from({ length: 16 }, (_, index) => bytes.readUInt32LE(index * 4));
  if (w[0] !== WINDOWS_OPEN_TARGET_REPLACE_REPORT_MAGIC || w[1] !== 1 || w[2] !== 1 ||
      w.slice(3, 8).some(mask => mask !== 3) || w[8] !== 1 && w[8] !== 3 || w[9] !== 0 ||
      w[8] === 3 && w[10] !== 0 || w.slice(11).some(Boolean)) return fail();
  return Object.freeze({ schema: 1 as const, status: 1 as const,
    preparation: Object.freeze({ createdMask: 3 as const, writtenMask: 3 as const, flushedMask: 3 as const, closedMask: 3 as const }),
    attemptedMask: 3 as const, successMask: w[8] as 1 | 3,
    a: Object.freeze({ success: 1 as const, error: 0 as const }),
    b: Object.freeze({ success: (w[8] === 3 ? 1 : 0) as 0 | 1, error: w[10] }) });
}
