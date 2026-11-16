/** Only fixed numeric C-probe facts may leave its stopped private job. */
export const WINDOWS_LIBUV_PROBE_BYTES = 96;
export const WINDOWS_LIBUV_PROBE_PAYLOAD_BYTES = 24;
export type WindowsLibuvProbeReport = Readonly<{
  build: number; token: number; stage: number; status: number; errorDomain: number; errorCode: number; features: number;
  syncBytes: number; asyncBytes: number; fsCallbacks: number; timerCallbacks: number; timerClosed: number; workCallbacks: number;
  afterWork: number; threadCallbacks: number; threadJoined: number; loopInit: number; loopRun: number; loopClose: number;
  cleanup: number; checkpoints: number;
}>;

export function parseWindowsLibuvProbeReport(bytes: Buffer, expected: { build: 0 | 1; token: 0 | 1 }): WindowsLibuvProbeReport {
  const fail = (): never => { throw new Error("The stopped fixed libuv report failed its bounded numeric contract."); };
  if (!Buffer.isBuffer(bytes) || bytes.length !== WINDOWS_LIBUV_PROBE_BYTES) return fail();
  const words = Array.from({ length: 24 }, (_, index) => bytes.readUInt32LE(index * 4));
  if (words[0] !== 0x50565545 || words[1] !== 1 || words[2] !== expected.build || words[3] !== expected.token || words[23] !== 0) return fail();
  const report = { build: words[2], token: words[3], stage: words[4], status: words[5], errorDomain: words[6], errorCode: words[7], features: words[8],
    syncBytes: words[9], asyncBytes: words[10], fsCallbacks: words[11], timerCallbacks: words[12], timerClosed: words[13], workCallbacks: words[14],
    afterWork: words[15], threadCallbacks: words[16], threadJoined: words[17], loopInit: words[18], loopRun: words[19], loopClose: words[20],
    cleanup: words[21], checkpoints: words[22] };
  if (report.stage > 10 || report.status > 2 || report.errorDomain > 4 || (report.features & ~63) !== 0 || (report.cleanup & ~15) !== 0 ||
    report.syncBytes > WINDOWS_LIBUV_PROBE_PAYLOAD_BYTES || report.asyncBytes > WINDOWS_LIBUV_PROBE_PAYLOAD_BYTES || report.checkpoints < 1 || report.checkpoints > 32 ||
    [report.fsCallbacks, report.timerCallbacks, report.timerClosed, report.workCallbacks, report.afterWork, report.threadCallbacks, report.threadJoined].some(value => value > 1)) return fail();
  if (report.status !== 2 && (report.errorDomain !== 0 || report.errorCode !== 0) || report.status === 2 && (report.errorDomain === 0 || report.errorCode === 0)) return fail();
  if (report.status === 1 && (report.stage !== 10 || report.features !== 63 || report.cleanup !== 15 || report.syncBytes !== WINDOWS_LIBUV_PROBE_PAYLOAD_BYTES ||
    report.asyncBytes !== WINDOWS_LIBUV_PROBE_PAYLOAD_BYTES || [report.fsCallbacks, report.timerCallbacks, report.timerClosed, report.workCallbacks, report.afterWork,
      report.threadCallbacks, report.threadJoined].some(value => value !== 1) || report.loopInit !== 0 || report.loopRun !== 0 || report.loopClose !== 0)) return fail();
  if (report.status !== 1 && report.stage === 10) return fail();
  return Object.freeze(report);
}
