/** Only closed numeric observations from the fixed, stopped libuv spawn witness leave this decoder. */
export const WINDOWS_UV_SPAWN_REPORT_BYTES = 256;

export type WindowsUvSpawnApi = Readonly<{ calls: number; successes: number; lastResult: number; lastSequence: number }>;
export type WindowsUvSpawnLedger = Readonly<{
  unknown: number; totalCalls: number; lastOperation: number; lastResult: number;
  translation: Readonly<{ count: number; input: number; result: number; sequence: number }>;
  apis: Readonly<{ namedPipe: WindowsUvSpawnApi; file: WindowsUvSpawnApi; connect: WindowsUvSpawnApi; completionPort: WindowsUvSpawnApi; process: WindowsUvSpawnApi }>;
}>;
export type WindowsUvSpawnReport = Readonly<{
  role: number; status: number; stage: number; controls: number; useful: boolean;
  loopInit: number; pipeInitMask: number; spawnResult: number; spawnReturned: number; childSpawned: number;
  childExitCallbacks: number; childExitStatus: number; childTermSignal: number; processClosed: number; pipeClosedMask: number;
  ackPolls: number; ackSeen: number; stdinBytes: number; stdoutBytes: number; stderrBytes: number; loopClose: number;
  failOperation: number; failCode: number; ledger: WindowsUvSpawnLedger;
  controlsObserved: Readonly<{ canary: Readonly<{ success: number; error: number }>; parentCreate: Readonly<{ success: number; error: number }>; parentVm: Readonly<{ success: number; error: number }> }>;
}>;

export function parseWindowsUvSpawnReport(bytes: Buffer, role: 0 | 1): WindowsUvSpawnReport {
  const fail = (): never => { throw new Error("The stopped fixed libuv spawn report failed its bounded numeric contract."); };
  if (!Buffer.isBuffer(bytes) || bytes.length !== WINDOWS_UV_SPAWN_REPORT_BYTES || role !== 0 && role !== 1) return fail();
  const words = Array.from({ length: 64 }, (_, index) => bytes.readUInt32LE(index * 4));
  const signed = (index: number) => bytes.readInt32LE(index * 4);
  const bit = (value: number) => value === 0 || value === 1;
  if (words[0] !== 0x53565545 || words[1] !== 1 || words[2] !== role || words[3] !== 1 && words[3] !== 2 || words[4] !== 6 ||
      words[5] !== 31 || words.slice(58).some(value => value !== 0)) return fail();
  const [status, controls] = [words[3], words[5]];
  const loopInit = signed(6), spawnResult = signed(8), childExitStatus = signed(12), loopClose = signed(21), failCode = signed(23);
  if (loopInit !== 0 || words[7] !== 7 || spawnResult > 0 || words[9] !== 1 || !bit(words[10]) || !bit(words[11]) || !bit(words[14]) ||
      words[15] !== 7 || words[16] > 500 || !bit(words[17]) || words[18] > 12 || words[19] > 14 || words[20] > 4096 || loopClose !== 0 || words[22] > 8) return fail();
  if (words[10] !== Number(spawnResult === 0) || words[14] !== 1 || words[11] !== words[10] || words[17] > words[10] ||
      words[17] === 1 && words[16] === 0 || words[10] === 0 && (words[11] !== 0 || childExitStatus !== 0 || words[13] !== 0 ||
        words[16] !== 0 || words[17] !== 0 || words[18] !== 0 || words[19] !== 0 || words[20] !== 0)) return fail();
  if (status === 1 ? controls !== 31 || words[22] !== 0 || failCode !== 0 || words[20] !== 0 : words[22] === 0) return fail();

  const [unknown, totalCalls, lastOperation, lastResult, count] = words.slice(24, 29);
  const input = signed(29), translationResult = signed(30), sequence = words[31];
  if (!bit(unknown) || totalCalls > 4096 || lastOperation > 5 || !bit(lastResult) || !bit(count) || sequence > 4096) return fail();
  const records: WindowsUvSpawnApi[] = [];
  const sequences = new Set<number>();
  for (let index = 0; index < 5; index++) {
    const [calls, successes, result, lastSequence] = words.slice(32 + index * 4, 36 + index * 4);
    if (calls > 4096 || successes > calls || !bit(result) || lastSequence > totalCalls ||
        calls === 0 && (successes !== 0 || result !== 0 || lastSequence !== 0) ||
        calls > 0 && (lastSequence === 0 || sequences.has(lastSequence) || result > successes || 1 - result > calls - successes)) return fail();
    if (calls > 0) sequences.add(lastSequence);
    records.push(Object.freeze({ calls, successes, lastResult: result, lastSequence }));
  }
  if (records.reduce((sum, record) => sum + record.calls, 0) !== totalCalls || totalCalls === 0 && (lastOperation !== 0 || lastResult !== 0) ||
      totalCalls > 0 && (lastOperation === 0 || records[lastOperation - 1].lastSequence !== totalCalls || records[lastOperation - 1].lastResult !== lastResult)) return fail();
  let precedingCalls = 0;
  for (const record of records.filter(record => record.calls > 0).sort((a, b) => a.lastSequence - b.lastSequence)) {
    precedingCalls += record.calls;
    if (precedingCalls > record.lastSequence) return fail();
  }
  if (count === 0 ? input !== 0 || translationResult !== 0 || sequence !== 0
    : input <= 0 || translationResult >= 0 || sequence > totalCalls || unknown === 0 && translationResult !== spawnResult ||
      (input === 5 || input === 1314) && translationResult !== -4048) return fail();

  const controlsObserved = Object.freeze({
    canary: Object.freeze({ success: words[52], error: words[53] }),
    parentCreate: Object.freeze({ success: words[54], error: words[55] }),
    parentVm: Object.freeze({ success: words[56], error: words[57] }),
  });
  for (const observation of Object.values(controlsObserved)) {
    if (!bit(observation.success) || observation.success !== 1 - role || observation.error !== (role === 1 ? 5 : 0)) return fail();
  }
  const useful = status === 1 && spawnResult === 0;
  if (useful && (words[11] !== 1 || childExitStatus !== 0 || words[13] !== 0 || words[17] !== 1 || words[16] === 0 ||
      words[18] !== 12 || words[19] !== 14 || unknown !== 0 || count !== 0 || records[0].successes !== 3 || records[1].calls !== 3 || records[1].successes !== 3 ||
      records[2].calls !== 3 || records[3].calls !== 3 || records[3].successes !== 3 || records[4].calls !== 1 || records[4].successes !== 1)) return fail();
  if (status === 1 && spawnResult < 0 && unknown === 0 && records[4].lastResult !== 0) return fail();
  const ledger: WindowsUvSpawnLedger = Object.freeze({ unknown, totalCalls, lastOperation, lastResult,
    translation: Object.freeze({ count, input, result: translationResult, sequence }),
    apis: Object.freeze({ namedPipe: records[0], file: records[1], connect: records[2], completionPort: records[3], process: records[4] }) });
  return Object.freeze({ role, status, stage: words[4], controls, useful, loopInit, pipeInitMask: words[7], spawnResult, spawnReturned: words[9], childSpawned: words[10],
    childExitCallbacks: words[11], childExitStatus, childTermSignal: words[13], processClosed: words[14], pipeClosedMask: words[15], ackPolls: words[16], ackSeen: words[17],
    stdinBytes: words[18], stdoutBytes: words[19], stderrBytes: words[20], loopClose, failOperation: words[22], failCode, ledger, controlsObserved });
}
