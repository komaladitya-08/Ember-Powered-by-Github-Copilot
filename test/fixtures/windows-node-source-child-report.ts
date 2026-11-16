/** Closed fixed-source child report/TAP receipt. Raw child streams and paths never leave these decoders. */
export type WindowsSourceNodeChildMode = "spawn" | "test";
export function parseWindowsNodeSourceChildReport(bytes: Buffer, role: 0 | 1, mode: WindowsSourceNodeChildMode) {
  const fail = () => new Error("The fixed source Node child report is incomplete or malformed.");
  if (!Buffer.isBuffer(bytes) || bytes.length !== 64 || role !== 0 && role !== 1 || mode !== "spawn" && mode !== "test") throw fail();
  const words = Array.from({ length: 16 }, (_, i) => bytes.readUInt32LE(i * 4));
  const expectedMode = mode === "spawn" ? 1 : 2;
  if (words[0] !== 0x43534e45 || words[1] !== 1 || words[2] !== role || words[3] !== expectedMode || words[4] !== 4 || words[5] !== 1 ||
      words[6] !== 31 || words[7] !== (mode === "spawn" ? 12 : 0) || words[8] !== (mode === "spawn" ? 14 : 0) || words[9] !== 0 ||
      words[10] !== 1 || words[11] !== 1 || words[12] !== 1 || words[13] < 1 || words[13] > 500 || words[14] !== 22023005 || words[15] !== 0) throw fail();
  return Object.freeze({ role, mode, complete: true, features: 31, stdinBytes: words[7], stdoutBytes: words[8], stderrBytes: 0,
    spawned: 1, exited: 1, closed: 1, grantPolls: words[13] });
}
export function inspectWindowsNodeSourceTestOutput(bytes: Buffer) {
  const refused = () => Object.freeze({ accepted: false, tests: 0, passed: 0 });
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 4096 || bytes.some(value => value > 127 || value < 32 && value !== 10 && value !== 13)) return refused();
  const text = bytes.toString("ascii").replace(/\r\n/g, "\n");
  if (text.includes("\r")) return refused();
  const lines = text.split("\n"); if (lines.pop() !== "") return refused();
  const expected = ["TAP version 13", "# Subtest: fixed source Node local test", "ok 1 - fixed source Node local test", "  ---",
    /^ {2}duration_ms: \d+(?:\.\d+)?$/, "  type: 'test'", "  ...", "1..1", "# tests 1", "# suites 0", "# pass 1", "# fail 0", "# cancelled 0", "# skipped 0", "# todo 0", /^# duration_ms \d+(?:\.\d+)?$/];
  if (lines.length !== expected.length || lines.some((line, index) => typeof expected[index] === "string" ? line !== expected[index] : !(expected[index] as RegExp).test(line))) return refused();
  return Object.freeze({ accepted: true, tests: 1, passed: 1 });
}
