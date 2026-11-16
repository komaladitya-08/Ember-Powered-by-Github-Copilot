import { describe, expect, it } from "vitest";
import { parseWindowsChildProcessPolicyReport, WINDOWS_CHILD_PROCESS_POLICY_CASES, WINDOWS_CHILD_PROCESS_POLICY_REPORT_BYTES } from "../fixtures/windows-child-process-policy-report";

const masks = [0, 0, 0, 0, 2, 4, 3, 5];
const created = (route: number) => [route, 1, route, route, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, route, 0, 0, 0];
const refused = (route: number, code = 5) => [route, 1, route, route, 0, 1, 0, code, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, route, 0, 0, 0];
function report(role: 0 | 1, caseId = 0, allow = role === 0) {
  const before = caseId === 1 || caseId >= 3 ? 1 : 0;
  const header = [0x50435045, 1, role, caseId, 1, 6, 15, role ? 5 : 0, 0, role ? 5 : 0, role ? 5 : 0,
    1, 0, before, caseId >= 3 ? 1 : 0, masks[caseId], 0, caseId >= 3 ? 87 : 0, 1, 0, before, 6, 0, 0];
  const words = [...header, ...(allow ? created(0) : refused(0)), ...(allow ? created(1) : refused(1)), ...Array(8).fill(0)];
  const bytes = Buffer.alloc(320); words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4)); return bytes;
}
const set = (bytes: Buffer, index: number, value: number) => { bytes.writeUInt32LE(value, index * 4); return bytes; };
describe("fixed child-policy numeric observations", () => {
  it("distinguishes a controlled ordinary positive from LPAC denial without inventing enforcement", () => {
    const host = parseWindowsChildProcessPolicyReport(report(0), 0, 0);
    expect(host.plain).toMatchObject({ created: 1, tokenChecked: 1, imageChecked: 1, jobChecked: 1, resumed: 1, waited: 1, childExitCode: 0, knownClosed: true });
    const lpac = parseWindowsChildProcessPolicyReport(report(1), 1, 0);
    expect(lpac.plain).toMatchObject({ created: 0, createCode: 5, tokenChecked: 0, knownClosed: true });
    expect(lpac.policyCausality).toBe("not-established"); expect(Object.isFrozen(lpac.plain)).toBe(true);
  });
  it.each(WINDOWS_CHILD_PROCESS_POLICY_CASES.map((name, caseId) => [name, caseId] as const))("binds the exact fixed case %s", (_name, caseId) => {
    const value = parseWindowsChildProcessPolicyReport(report(1, caseId), 1, caseId);
    expect(value.caseId).toBe(caseId); expect(value.case).toBe(WINDOWS_CHILD_PROCESS_POLICY_CASES[caseId]);
    expect(value.setter.requestedFlags).toBe(masks[caseId]);
    expect(value.setter.validity).toBe("not-established");
  });
  it("preserves unsupported and zero-error setter refusals as observations", () => {
    const input = report(1, 3); set(input, 17, 0);
    expect(parseWindowsChildProcessPolicyReport(input, 1, 3).setter).toEqual({ attempted: 1, requestedFlags: 0, succeeded: 0, code: 0, validity: "not-established" });
  });
  it("retains a successful self-clear and controlled child creation as data, never an enforcement claim", () => {
    const input = report(1, 3, true); set(input, 16, 1); set(input, 17, 0); set(input, 20, 0);
    const value = parseWindowsChildProcessPolicyReport(input, 1, 3);
    expect(value.setter.succeeded).toBe(1); expect(value.after.flags).toBe(0); expect(value.plain.created).toBe(1); expect(value.policyCausality).toBe("not-established");
  });
  it("permits unavailable post-set query without fabricating a flag value", () => {
    const input = report(1, 5); set(input, 18, 0); set(input, 19, 5); set(input, 20, 0);
    expect(parseWindowsChildProcessPolicyReport(input, 1, 5).after).toEqual({ queried: 0, code: 5, flags: 0 });
  });
  it.each([0, 319, 321, 4096])("refuses any nonexact byte frame %i", bytes => expect(() => parseWindowsChildProcessPolicyReport(Buffer.alloc(bytes), 0, 0)).toThrow("numeric contract"));
  it.each([-1, 8, 1.5, NaN])("refuses an unknown expected case %s", caseId => expect(() => parseWindowsChildProcessPolicyReport(report(0), 0, caseId)).toThrow());
  it("refuses foreign role and case even when the record is otherwise valid", () => {
    expect(() => parseWindowsChildProcessPolicyReport(report(0), 1, 0)).toThrow();
    expect(() => parseWindowsChildProcessPolicyReport(report(1, 1), 1, 2)).toThrow();
  });
  it.each([[0, 0], [1, 2], [2, 0], [3, 8], [4, 0], [4, 2], [4, 3], [5, 5], [6, 14], [7, 0], [8, 5], [9, 0], [10, 0],
    [11, 0], [12, 5], [13, 8], [14, 1], [15, 2], [16, 1], [17, 5], [18, 0], [19, 5], [20, 1], [21, 5], [22, 1], [23, 1], [72, 1], [79, 1]])(
    "refuses malformed complete header word%i=%i", (index, value) => expect(() => parseWindowsChildProcessPolicyReport(set(report(1), index, value), 1, 0)).toThrow());
  it.each([1, 3, 4, 5, 6, 7])("requires restricted-birth observation exactly1 for case%i", caseId => {
    expect(() => parseWindowsChildProcessPolicyReport(set(report(1, caseId), 13, 0), 1, caseId)).toThrow();
    expect(() => parseWindowsChildProcessPolicyReport(set(report(1, caseId), 13, 5), 1, caseId)).toThrow();
  });
  it.each([0, 1, 4, 7])("records host-override birth flags%i empirically without assuming the override worked", flags => {
    const input = report(1, 2); set(input, 13, flags); set(input, 20, flags);
    expect(parseWindowsChildProcessPolicyReport(input, 1, 2).beforeFlags).toBe(flags);
  });
  it.each([3, 4, 5, 6, 7])("binds each requested setter mask and success/error relation for case%i", caseId => {
    expect(() => parseWindowsChildProcessPolicyReport(set(report(1, caseId), 15, 7), 1, caseId)).toThrow();
    expect(() => parseWindowsChildProcessPolicyReport(set(report(1, caseId), 16, 1), 1, caseId)).toThrow();
    expect(() => parseWindowsChildProcessPolicyReport(set(report(1, caseId), 14, 0), 1, caseId)).toThrow();
  });
  it.each([0, 1] as const)("requires exact created-child admission/resume/wait/close facts for route%i", route => {
    const start = 24 + route * 24;
    for (const [field, value] of [[0, 2], [1, 0], [5, 0], [6, 2], [7, 5], [8, 0], [9, 0], [10, 0], [11, 0], [12, 8], [13, 0], [14, 0], [15, 5], [16, 0], [17, 1], [18, 0], [19, 0], [21, 6], [22, 1], [22, 2], [23, 1]]) {
      expect(() => parseWindowsChildProcessPolicyReport(set(report(0), start + field, value), 0, 0)).toThrow();
    }
  });
  it.each([0, 1] as const)("does not certify any created/closed or payload fact after denied creation on route%i", route => {
    const start = 24 + route * 24;
    for (const field of [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23]) {
      expect(() => parseWindowsChildProcessPolicyReport(set(report(1), start + field, 1), 1, 0)).toThrow();
    }
    const honestZeroError = set(report(1), start + 7, 0);
    expect(parseWindowsChildProcessPolicyReport(honestZeroError, 1, 0)[route ? "override" : "plain"].createCode).toBe(0);
  });
  it("accepts a known-closed attribute initialization/update refusal without claiming CreateProcess ran", () => {
    for (const deleted of [0, 1]) {
      const input = report(1), start = 48;
      for (let field = 3; field < 24; field++) set(input, start + field, 0);
      set(input, start + 4, 87); set(input, start + 20, deleted);
      expect(parseWindowsChildProcessPolicyReport(input, 1, 0).override).toMatchObject({ attributeReady: 0, attributeCode: 87, createAttempted: 0, attributesDeleted: deleted, knownClosed: true });
      set(input, start + 5, 1); expect(() => parseWindowsChildProcessPolicyReport(input, 1, 0)).toThrow();
    }
  });
  it("requires successful override attributes to be deleted exactly once in a complete observation", () => {
    expect(() => parseWindowsChildProcessPolicyReport(set(report(1), 68, 0), 1, 0)).toThrow();
    expect(() => parseWindowsChildProcessPolicyReport(set(report(1), 52, 5), 1, 0)).toThrow();
    expect(() => parseWindowsChildProcessPolicyReport(set(report(1), 26, 1), 1, 0)).toThrow();
  });
  it("returns detached frozen facts without native strings or identifiers", () => {
    const input = report(1, 4), value = parseWindowsChildProcessPolicyReport(input, 1, 4); input.fill(0);
    expect(value.beforeFlags).toBe(1); expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.setter)).toBe(true); expect(Object.isFrozen(value.after)).toBe(true);
    expect(JSON.stringify(value)).not.toMatch(/SID|pid|handle|\\\\|C:|NtCreate/);
    expect(WINDOWS_CHILD_PROCESS_POLICY_REPORT_BYTES).toBe(320);
  });
});
