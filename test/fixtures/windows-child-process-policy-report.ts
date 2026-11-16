/** Fixed numeric observations only. Refusal without a valid same-route control never establishes enforcement. */
export const WINDOWS_CHILD_PROCESS_POLICY_REPORT_BYTES = 320;
export const WINDOWS_CHILD_PROCESS_POLICY_CASES = Object.freeze([
  "omitted-birth", "restricted-birth", "host-override-birth", "self-clear", "self-audit", "self-secure", "self-enforce-audit", "self-enforce-secure",
] as const);
const masks = [0, 0, 0, 0, 2, 4, 3, 5] as const;
const fail = (): never => { throw new Error("The stopped child-policy report failed its exact numeric contract."); };
export function parseWindowsChildProcessPolicyReport(bytes: Buffer, role: 0 | 1, caseId: number) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== WINDOWS_CHILD_PROCESS_POLICY_REPORT_BYTES || role !== 0 && role !== 1 || !Number.isInteger(caseId) || caseId < 0 || caseId > 7) fail();
  const words = Array.from({ length: 80 }, (_, index) => bytes.readUInt32LE(index * 4));
  if (words[0] !== 0x50435045 || words[1] !== 1 || words[2] !== role || words[3] !== caseId || words[4] !== 1 || words[5] !== 6 || words[6] !== 15 ||
      words[7] !== (role ? 5 : 0) || words[8] !== 0 || words[9] !== (role ? 5 : 0) || words[10] !== (role ? 5 : 0) ||
      words[11] !== 1 || words[12] !== 0 || words[13] > 7 || words[21] !== 6 || words[22] !== 0 || words[23] !== 0 || words.slice(72).some(Boolean)) fail();
  if ((caseId === 1 || caseId >= 3) && words[13] !== 1) fail();
  const setAttempted = caseId >= 3 ? 1 : 0;
  if (words[14] !== setAttempted || words[15] !== masks[caseId] || words[16] > 1 || words[18] > 1 || words[20] > 7 ||
      words[16] === 1 && words[17] !== 0 || words[18] === 1 && words[19] !== 0 || words[18] === 0 && words[20] !== 0) fail();
  if (!setAttempted && (words[16] !== 0 || words[17] !== 0 || words[18] !== 1 || words[20] !== words[13])) fail();
  const decode = (route: 0 | 1) => {
    const a = words.slice(24 + route * 24, 48 + route * 24);
    if (a[0] !== route || a[1] !== 1 || a[2] !== route || a[3] > 1 || a[5] > 1 || a[6] > 1 || a[12] > 7 || a[20] > 1 || a[21] !== 0 || a[22] !== 0 || a[23] !== 0) fail();
    if (!route && (a[3] !== 0 || a[4] !== 0 || a[20] !== 0 || a[5] !== 1)) fail();
    if (route && a[3] === 0) {
      if (a.slice(5, 20).some(Boolean)) fail();
    } else {
      if (route && (a[4] !== 0 || a[20] !== 1 || a[5] !== 1)) fail();
      if (a[6] === 0) { if (a.slice(8, 20).some(Boolean)) fail(); }
      else if (a[7] !== 0 || [8, 9, 10, 11, 13, 14, 16, 18, 19].some(index => a[index] !== 1) || a[15] !== 0 || a[17] !== 0) fail();
    }
    return Object.freeze({ route: route ? "override" as const : "plain" as const, attempted: true as const,
      attributeAttempted: a[2], attributeReady: a[3], attributeCode: a[4], createAttempted: a[5], created: a[6], createCode: a[7],
      tokenChecked: a[8], imageChecked: a[9], jobChecked: a[10], childPolicyQueried: a[11], childPolicyFlags: a[12],
      resumeAttempted: a[13], resumed: a[14], resumeCode: a[15], waited: a[16], childExitCode: a[17], threadClosed: a[18], processClosed: a[19],
      attributesDeleted: a[20], knownClosed: true as const });
  };
  return Object.freeze({ role, caseId, case: WINDOWS_CHILD_PROCESS_POLICY_CASES[caseId], status: 1 as const, controls: 15 as const,
    canaryCode: words[7], selfCode: words[8], parentCreateCode: words[9], parentWriteCode: words[10],
    beforeFlags: words[13], setter: Object.freeze({ attempted: words[14], requestedFlags: words[15], succeeded: words[16], code: words[17], validity: "not-established" as const }),
    after: Object.freeze({ queried: words[18], code: words[19], flags: words[20] }), plain: decode(0), override: decode(1),
    policyCausality: "not-established" as const });
}
