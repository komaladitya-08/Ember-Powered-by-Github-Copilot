/** Closed numeric C report, never native text, names, paths, handles or supplied diagnostics. */
export const WINDOWS_PIPE_NAMESPACE_REPORT_BYTES = 160;
const failure = () => new Error("The stopped pipe prerequisite report failed its fixed numeric contract.");
export function parseWindowsPipeNamespaceReport(bytes: Buffer, role: 0 | 1) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== WINDOWS_PIPE_NAMESPACE_REPORT_BYTES || (role !== 0 && role !== 1)) throw failure();
  const words = Array.from({ length: 40 }, (_, index) => bytes.readUInt32LE(index * 4));
  if (words[0] !== 0x504e5045 || words[1] !== 1 || words[2] !== role || words[3] !== 1 && words[3] !== 2 || words[4] !== 5 ||
    words[5] > 31 || words[11] !== 4 || words.slice(12, 16).some(Boolean)) throw failure();
  const pairs = [0, 1].map(index => {
    const p = words.slice(16 + index * 12, 28 + index * 12);
    if (p[0] < 1 || p[0] > 7 || p[2] < 1 || p[2] > 3 || p[3] > 7 || p[4] !== p[3] || p[5] !== 0 || p[6] > 1 || p[7] > 1 || p[8] > 1 ||
      p[8] > p[7] || p[9] !== 0 && p[9] !== 1168 || p[10] !== 0 && p[10] !== 995 || p[11] !== 0 ||
      p[3] !== 0 && p[3] !== 1 && p[3] !== 3 && p[3] !== 7 || (p[2] === 1 && (p[0] !== 7 || p[1] !== 0 || p[3] !== 7 || p[6] !== 1 || p[10] !== 0)) ||
      p[2] !== 1 && (p[1] === 0 || p[6] !== 0) || (p[7] === 0 && (p[8] !== 0 || p[9] !== 0 || p[10] !== 0)) ||
      p[7] === 1 && (p[3] !== 7 || p[0] < 5) || p[8] === 1 && (p[0] !== 6 || p[2] !== 2) || p[8] === 0 && p[9] !== 0 ||
      p[0] === 1 && p[3] !== 0 && p[3] !== 1 || p[0] === 2 && p[3] !== 1 || p[0] === 3 && p[3] !== 3 || p[0] >= 4 && p[3] !== 7 ||
      p[2] === 3 && (p[0] !== 1 && p[0] !== 7 || p[1] !== 13)) throw failure();
    return Object.freeze({ operation: p[0], code: p[1], outcome: p[2], created: p[3], closed: p[4], serverInherit: p[5], clientInherit: p[6],
      pending: p[7], cancelAttempted: p[8], cancelCode: p[9], completionCode: p[10], closeCode: p[11], closeComplete: true as const });
  });
  if ((words[3] === 1) !== (words[5] === 31 && pairs.every(pair => pair.outcome !== 3))) throw failure();
  for (const [bit, position, expected] of [[1, 6, role ? 5 : 0], [2, 7, 0], [4, 8, role ? 5 : 0], [8, 9, role ? 5 : 0], [16, 10, role ? 5 : 0]]) {
    if ((words[5] & bit) && words[position] !== expected) throw failure();
  }
  return Object.freeze({ role, status: words[3], controls: words[5], canaryCode: words[6], selfCode: words[7], parentReadCode: words[8],
    parentDuplicateCode: words[9], parentCreateCode: words[10], current: pairs[0], local: pairs[1] });
}
