/** Fixed C fixture observations only. Caller must prove root/job/handle Stop before reading any report. */
export const WINDOWS_COMMAND_COPY_REPORT_BYTES = 64;
export const WINDOWS_COMMAND_COPY_REPORT_MAGIC = 0x50434357;
export const WINDOWS_COMMAND_COPY_HEARTBEAT_MAGIC = 0x42484357;
export type WindowsCommandCopyProofMode = "useful" | "writer" | "revoked";
const modes = { useful: 1, writer: 2, revoked: 3 } as const;
const fail = () => new Error("The stopped command-copy fixture report failed its fixed numeric contract.");
/** No path, file content, handle, SID, process ID or native error text is decoded. */
export function parseWindowsCommandCopyReport(bytes: Buffer, expectedMode: WindowsCommandCopyProofMode) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== WINDOWS_COMMAND_COPY_REPORT_BYTES || !Object.hasOwn(modes, expectedMode)) throw fail();
  const w = Array.from({ length: 16 }, (_, index) => bytes.readUInt32LE(index * 4));
  const mode = modes[expectedMode], maximum = mode === 1 ? 0xfff : mode === 2 ? 0xf01 : 0xf07;
  if (w[0] !== WINDOWS_COMMAND_COPY_REPORT_MAGIC || w[1] !== 1 || w[2] !== mode || w[3] !== 1 && w[3] !== 2 || w[4] > 19 || (w[5] & ~maximum) !== 0 || w[15] !== 0) throw fail();
  for (const [bit, offset] of [[0x100, 6], [0x200, 7], [0x400, 8], [0x800, 9]]) if (Boolean(w[5] & bit) !== (w[offset] === 5)) throw fail();
  const protections = w[5] & 0xf00, lower = w[5] & 0xff;
  if (![0, 0x100, 0x300, 0x700, 0xf00].includes(protections)) throw fail();
  if (lower && (w[5] & 0xf00) !== 0xf00) throw fail();
  if (mode === 3) {
    for (const [bit, offset] of [[1, 10], [2, 11], [4, 12]]) if (Boolean(lower & bit) !== (w[offset] === 5)) throw fail();
    if (![0, 1, 3, 7].includes(lower) || w[14] !== 0) throw fail();
  } else if (w.slice(10, 13).some(Boolean) || mode === 1 && (![0, 1, 3, 7, 15, 31, 63, 127, 255].includes(lower) || w[14] !== 0) || mode === 2 && w[14] !== (lower ? 1 : 0)) throw fail();
  if (w[3] === 1) {
    if (w[5] !== maximum || w[4] !== (mode === 2 ? 13 : 19) || w[13] !== 0 || w.slice(6, 10).some(code => code !== 5) || mode === 3 && w.slice(10, 13).some(code => code !== 5)) throw fail();
  } else {
    const allowed = mode === 1 ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : mode === 2 ? [0, 1, 2, 3, 4, 13] : [0, 1, 2, 3, 4, 16, 17, 18];
    if (!allowed.includes(w[4]) || mode === 2 && (lower !== 0 || w[14] !== 0)) throw fail();
    // Every work bit is earned only after its complete operation, including known handle close.
    const completed = mode === 1 ? Math.max(0, Math.min(8, w[4] - 5)) : mode === 3 ? Math.max(0, Math.min(3, w[4] - 16)) : 0;
    if (lower !== (1 << completed) - 1) throw fail();
    if (w[4] <= 4) {
      for (let probe = 1; probe <= 4; probe++) if (probe < w[4] ? w[5 + probe] !== 5 : probe === w[4] ? w[5 + probe] === 5 : w[5 + probe] !== 0) throw fail();
      if (w.slice(10, 13).some(Boolean)) throw fail();
    } else if (protections !== 0xf00) throw fail();
    if (mode === 3 && w[4] >= 16) for (let probe = 16; probe <= 18; probe++) if (probe < w[4] ? w[probe - 6] !== 5 : probe === w[4] ? w[probe - 6] === 5 : w[probe - 6] !== 0) throw fail();
  }
  return Object.freeze({ mode, status: w[3], operation: w[4], features: w[5], sourceReadError: w[6], sourceWriteError: w[7],
    canaryReadError: w[8], canaryWriteError: w[9], workReadError: w[10], workWriteError: w[11], workCreateError: w[12],
    failedOperationError: w[13], initialHeartbeatCounter: w[14] });
}
