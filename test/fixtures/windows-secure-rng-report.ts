/** Closed status-only API witness. No entropy, provider identity, paths or arbitrary native strings are decoded. */
export const WINDOWS_SECURE_RNG_REPORT_BYTES = 192;
const failure = () => new Error("The stopped secure RNG API report failed its exact numeric contract.");
export function parseWindowsSecureRngReport(bytes: Buffer, role: 0 | 1) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== WINDOWS_SECURE_RNG_REPORT_BYTES || role !== 0 && role !== 1) throw failure();
  const words = Array.from({ length: 48 }, (_, index) => bytes.readUInt32LE(index * 4));
  if (words[0] !== 0x47525345 || words[1] !== 1 || words[2] !== role || words[3] !== 1 && words[3] !== 2 || words[4] !== 6 || words[5] > 31 ||
    words[11] !== 6 || words[12] !== 1 || words.slice(13, 16).some(Boolean) || (words[3] === 1) !== (words[5] === 31)) throw failure();
  for (const [bit, position, expected] of [[1, 6, role ? 5 : 0], [2, 7, 0], [4, 8, role ? 5 : 0], [8, 9, role ? 5 : 0], [16, 10, role ? 5 : 0]]) {
    if ((words[5] & bit) && words[position] !== expected) throw failure();
  }
  const decodeProvider = (index: number) => {
    const p = words.slice(16 + index * 12, 28 + index * 12);
    if (p[0] > 1 || p[1] > 1 || p[3] > 1 || p[4] > 1 || p[6] > 1 || p[7] > 1 || p[9] > 1 || p[10] !== 0 || p[11] !== 0) throw failure();
    if (p[0] === 0) { if (p.some(Boolean)) throw failure(); }
    else {
      if (p[9] !== 1) throw failure();
      if (p[1] === 0) { if ([p[3], p[4], p[5], p[6], p[7], p[8]].some(Boolean)) throw failure(); }
      else if (p[2] !== 0 || p[3] !== 1 || p[6] !== 1 || p[7] !== 1 || p[8] !== 0 || p[4] === 1 && p[5] !== 0) throw failure();
    }
    return Object.freeze({ attempted: p[0], acquired: p[1], acquireCode: p[2], generateAttempted: p[3], generated: p[4], generateCode: p[5],
      releaseAttempted: p[6], released: p[7], releaseCode: p[8], wiped: p[9], knownClosed: true as const });
  };
  const defaultProvider = decodeProvider(0), conditionalIntel = decodeProvider(1), cng = words.slice(40);
  if (defaultProvider.attempted !== 1 || conditionalIntel.attempted !== (defaultProvider.generated === 1 ? 0 : 1) || cng[0] !== 1 ||
    cng[2] > 1 || cng[2] !== (cng[1] === 0 ? 1 : 0) || cng[3] !== 1 || cng.slice(4).some(Boolean)) throw failure();
  return Object.freeze({ role, status: words[3], controls: words[5], canaryCode: words[6], selfCode: words[7], parentReadCode: words[8], parentDuplicateCode: words[9],
    parentCreateCode: words[10], buffersWiped: true as const, defaultProvider, conditionalIntel,
    cng: Object.freeze({ attempted: cng[0], status: cng[1], generated: cng[2], wiped: cng[3] }) });
}
